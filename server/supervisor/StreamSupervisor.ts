import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  StreamConfig,
  StreamRuntimeState,
  StreamStatus,
  MediaAsset,
  ActionSource,
  DestinationStatus,
  ErrorCategory,
} from '../db/schema';
import { db } from '../db';
import { ProcessManager } from './ProcessManager';
import { HealthMonitor } from './HealthMonitor';
import { RecoveryManager, isNetworkJitterError, classifyStreamError } from './RecoveryManager';
import { ResourceManager } from './ResourceManager';
import { MediaAnalyzer } from './MediaAnalyzer';
import { FfmpegCommandBuilder } from './FfmpegCommandBuilder';
import { PreflightCheckResult, isValidTransition } from './types';
import { ReconciliationManager } from './ReconciliationManager';
import { resolveFfmpegPath } from '../utils/ffmpegPaths';
import { PreflightService } from '../services/PreflightService';

const ROOT_DIR = process.cwd();
const UPLOADS_DIR = path.resolve(ROOT_DIR, 'uploads');

export class StreamSupervisor {
  private static instance: StreamSupervisor;
  private runtimeStates = new Map<string, StreamRuntimeState>();
  private processManager = new ProcessManager();
  private healthMonitor = new HealthMonitor();
  private recoveryManager = new RecoveryManager();
  private telemetrySubscribers = new Set<(event: any) => void>();
  private monitorInterval: NodeJS.Timeout | null = null;
  private activeOperations = new Set<string>();
  private streamLocks = new Map<string, Promise<void>>();
  private isShuttingDown = false;

  public static getInstance(): StreamSupervisor {
    if (!StreamSupervisor.instance) {
      StreamSupervisor.instance = new StreamSupervisor();
    }
    return StreamSupervisor.instance;
  }

  private constructor() {
    this.startHealthCheckLoop();
  }

  // Serialized per-stream lock to prevent race conditions across concurrent operations
  private async acquireStreamLock(streamId: string): Promise<() => void> {
    while (this.streamLocks.has(streamId)) {
      try {
        await this.streamLocks.get(streamId);
      } catch {}
    }

    let releaseLock: () => void = () => {};
    const lockPromise = new Promise<void>(resolve => {
      releaseLock = () => {
        this.streamLocks.delete(streamId);
        resolve();
      };
    });

    this.streamLocks.set(streamId, lockPromise);
    return releaseLock;
  }

  // Starts the background health check ticker (every 1.5s for precise telemetry)
  private startHealthCheckLoop() {
    this.monitorInterval = setInterval(() => {
      for (const [streamId, state] of this.runtimeStates.entries()) {
        if (
          state.status === 'LIVE' ||
          state.status === 'DEGRADED' ||
          state.status === 'CONNECTING' ||
          state.status === 'STARTING' ||
          state.status === 'RECOVERING' ||
          state.status === 'RECONNECTING'
        ) {
          this.healthMonitor.updateUptime(state);

          // Check for stream health, stall, and startup timeout
          const healthStatus = this.healthMonitor.checkStreamHealth(state, {
            startupTimeoutMs: 45000,
            firstProgressTimeoutMs: 30000,
            stallTimeoutMs: 20000,
            degradedTimeoutMs: 10000,
          });

          if (healthStatus === 'STARTUP_TIMEOUT' || healthStatus === 'FIRST_PROGRESS_TIMEOUT') {
            console.warn(
              `[StreamSupervisor] Stream ${streamId} timed out during startup/connection (${healthStatus}). Triggering recovery...`
            );
            this.handleStreamCrash(
              streamId,
              `Process startup or initial media encoding timed out (${healthStatus === 'FIRST_PROGRESS_TIMEOUT' ? 'no initial progress within 30s' : 'no connection within 45s'})`
            );
          } else if (healthStatus === 'STALLED') {
            console.warn(`[StreamSupervisor] Stream ${streamId} stalled. Marking for reconnect...`);
            this.handleStreamCrash(streamId, 'Ingest socket stalled (no progress from FFmpeg)');
          } else if (healthStatus === 'DEGRADED' && state.status === 'LIVE') {
            this.transitionState(streamId, 'DEGRADED', 'Media encoding progress delayed', 'system');
          } else if (healthStatus === 'OK' && state.status === 'DEGRADED') {
            this.transitionState(streamId, 'LIVE', 'Media progress nominal', 'system');
          }

          // Broadcast stats update
          this.broadcastTelemetry({
            type: 'stream.stats',
            streamId,
            data: {
              status: state.status,
              fps: state.fps,
              frameCount: state.frameCount,
              bitrate: state.bitrate,
              speed: state.speed,
              uptimeSeconds: state.uptimeSeconds,
              lastProgressTime: state.lastProgressTime,
              destinationStatus: state.destinationStatus,
              retryAttempt: state.retryAttempt,
              errorCategory: state.errorCategory,
            },
            timestamp: new Date().toISOString(),
          });
        }
      }
    }, 1500);
  }

  public async initialize(): Promise<void> {
    await ReconciliationManager.reconcileOnStartup(this, this.processManager);
  }

  // Ensures a runtime state object exists for a stream with stable generation tracking
  private getOrCreateRuntimeState(streamId: string): StreamRuntimeState {
    let state = this.runtimeStates.get(streamId);
    if (!state) {
      const config = db.getStreamById(streamId);
      state = {
        streamId,
        status: 'IDLE',
        desiredState: config?.desiredState || (config?.autoStart ? 'RUNNING' : 'STOPPED'),
        generationId: 1,
        uptimeSeconds: 0,
        restartCount: 0,
        retryAttempt: 0,
        recentLogs: [],
      };
      this.runtimeStates.set(streamId, state);
    }
    return state;
  }

  // State Machine Transition Handler - strictly validates and atomically mutates state
  public transitionState(
    streamId: string,
    toStatus: StreamStatus,
    reason?: string,
    source: ActionSource = 'system'
  ): boolean {
    const state = this.getOrCreateRuntimeState(streamId);
    const fromStatus = state.status;

    if (!isValidTransition(fromStatus, toStatus)) {
      console.warn(
        `[StreamSupervisor] Blocked invalid state transition for ${streamId}: ${fromStatus} -> ${toStatus} (Source: ${source})`
      );
      return false;
    }

    state.status = toStatus;
    state.lastStateChangeAt = new Date().toISOString();
    state.lastStateChangeReason = reason;
    state.lastActionSource = source;

    if (reason) {
      state.lastError = reason;
    }

    if (toStatus === 'LIVE') {
      state.lastConnectedAt = new Date().toISOString();
      state.destinationStatus = 'CONNECTED';
      this.recoveryManager.resetRetryCount(state);
    } else if (toStatus === 'STOPPED') {
      state.pid = undefined;
      state.hasProducedProgress = false;
      state.destinationStatus = undefined;
    }

    this.broadcastTelemetry({
      type: 'stream.state',
      streamId,
      data: {
        from: fromStatus,
        to: toStatus,
        lastError: reason,
        source,
        timestamp: state.lastStateChangeAt,
      },
      timestamp: new Date().toISOString(),
    });

    db.addStreamEvent({
      streamId,
      level:
        toStatus === 'FAILED'
          ? 'CRITICAL'
          : toStatus === 'RECONNECTING' || toStatus === 'RECOVERING' || toStatus === 'DEGRADED'
          ? 'WARNING'
          : 'INFO',
      type: `STREAM_STATUS_${toStatus}`,
      message: `Stream transitioned from ${fromStatus} to ${toStatus}${reason ? `: ${reason}` : ''} (by ${source})`,
      details: {
        from: fromStatus,
        to: toStatus,
        source,
        generationId: state.generationId,
      },
    });

    return true;
  }

  // Preflight validation checks before starting a stream
  public async preflightCheck(config: StreamConfig): Promise<PreflightCheckResult> {
    const checks: PreflightCheckResult['checks'] = [];
    let allPassed = true;

    // 1. Media or Playlist exists and readable
    let mediaExists = false;
    let isConcatPlaylist = false;
    let targetVideoPath = '';
    if (config.playlistId) {
      const playlist = db.getPlaylistById(config.playlistId);
      if (playlist && playlist.items && playlist.items.length > 0) {
        const missingItems = playlist.items.filter(
          item => !fs.existsSync(path.join(UPLOADS_DIR, path.basename(item.filename)))
        );
        mediaExists = missingItems.length === 0;
        isConcatPlaylist = true;
        targetVideoPath = path.join(UPLOADS_DIR, path.basename(playlist.items[0].filename));
        checks.push({
          name: 'Playlist Asset Verification',
          passed: mediaExists,
          message: mediaExists
            ? `Playlist "${playlist.name}" (${playlist.items.length} clips) verified on disk.`
            : `Playlist has missing clips: ${missingItems.map(i => i.filename).join(', ')}`,
        });
      } else {
        checks.push({
          name: 'Playlist Asset Verification',
          passed: false,
          message: `Playlist "${config.playlistId}" not found or empty.`,
        });
      }
    } else {
      const videoBasename = path.basename(config.videoFilename || '');
      targetVideoPath = path.join(UPLOADS_DIR, videoBasename);
      mediaExists = fs.existsSync(targetVideoPath);
      checks.push({
        name: 'Media Asset Verification',
        passed: mediaExists,
        message: mediaExists
          ? `Media file "${videoBasename}" is verified on disk.`
          : `Media file "${videoBasename}" was not found.`,
      });
    }
    if (!mediaExists) allPassed = false;

    // 2. FFmpeg Binary Verification
    const ffmpegPath = resolveFfmpegPath();
    checks.push({
      name: 'FFmpeg Broadcast Engine',
      passed: !!ffmpegPath,
      message: ffmpegPath
        ? `FFmpeg engine active (${ffmpegPath.includes('node_modules') ? 'Bundled binary' : 'System PATH'}).`
        : 'FFmpeg is not installed or available on this server.',
    });
    if (!ffmpegPath) allPassed = false;

    // 3. Destination and Stream Key verification
    const hasKey = !!(config.streamKey || (config.destinations && config.destinations.length > 0));
    checks.push({
      name: 'Destination & Stream Key',
      passed: hasKey,
      message: hasKey ? 'Destination RTMP URL and Stream Key are configured.' : 'No Stream Key provided.',
    });
    if (!hasKey) allPassed = false;

    // 4. Media Compatibility Check
    let compatibilityRecommendation: 'STREAM_COPY' | 'TRANSCODE_REQUIRED' = 'STREAM_COPY';
    if (mediaExists && targetVideoPath) {
      const comp = await MediaAnalyzer.analyze(targetVideoPath);
      compatibilityRecommendation = comp.recommendation;
      const isCopyMode = config.encodingMode === 'copy';
      if (isCopyMode && !comp.compatibleForCopy) {
        checks.push({
          name: 'Encoding Compatibility',
          passed: true,
          message: `Stream Copy selected, but file requires transcoding: ${comp.reasons.join(', ')}`,
          details: 'We recommend switching to Transcode 1080p or 720p preset for broadcast stability.',
        });
      } else {
        checks.push({
          name: 'Encoding Compatibility',
          passed: true,
          message: isCopyMode ? 'Compatible for direct Stream Copy.' : `Transcode preset "${config.encodingMode}" will be applied.`,
        });
      }
    }

    // 5. Server Resource Capacity & Limit Check
    const activeWorkers = this.processManager.getActiveCount();
    const capacity = ResourceManager.checkCapacity(config.encodingMode, activeWorkers);
    checks.push({
      name: 'Server Resource Capacity',
      passed: capacity.sufficient,
      message: capacity.sufficient
        ? `Server capacity sufficient: CPU ${capacity.currentCpuPercent}%, active streams: ${activeWorkers}/${capacity.maxRecommendedWorkers}`
        : capacity.warningMessage || 'Server resource limit exceeded',
    });
    if (!capacity.sufficient) allPassed = false;

    return {
      passed: allPassed,
      checks,
      recommendation: compatibilityRecommendation,
    };
  }

  // Start a stream with per-stream concurrency lock preventing duplicate starts
  public async startStream(
    streamId: string,
    options: { isAutoStart?: boolean; force?: boolean; source?: ActionSource } = {}
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isShuttingDown) {
      return { success: false, error: 'Server is currently shutting down. New broadcasts rejected.' };
    }

    const releaseLock = await this.acquireStreamLock(streamId);

    try {
      if (this.activeOperations.has(streamId)) {
        return { success: false, error: 'A broadcast start operation is already in progress for this stream.' };
      }
      this.activeOperations.add(streamId);

      const config = db.getStreamById(streamId);
      if (!config) {
        return { success: false, error: `Stream configuration "${streamId}" not found.` };
      }

      // Check resource limit: prevent unbounded concurrent streams
      const settings = db.getSettings();
      const activeCount = this.processManager.getActiveCount();
      const maxStreams = settings.maxConcurrentStreams || 8;
      if (activeCount >= maxStreams && !this.processManager.isProcessAlive(streamId)) {
        return {
          success: false,
          error: `Capacity limit reached: Server configured for maximum ${maxStreams} concurrent broadcasts (${activeCount} currently active).`,
        };
      }

      // Check destination limits
      const maxDestinations = 5;
      if (config.destinations && config.destinations.length > maxDestinations) {
        return {
          success: false,
          error: `Maximum destination limit exceeded: At most ${maxDestinations} destinations allowed per stream.`,
        };
      }

      const state = this.getOrCreateRuntimeState(streamId);

      // If process is already active and healthy, succeed idempotently
      if (this.processManager.isProcessAlive(streamId)) {
        return { success: true };
      }

      // Preflight checks
      if (!options.force) {
        const preflight = await this.preflightCheck(config);
        if (!preflight.passed && !options.isAutoStart) {
          const failedChecks = preflight.checks.filter(c => !c.passed).map(c => c.message).join('; ');
          return { success: false, error: `Preflight checks failed: ${failedChecks}` };
        }
      }

      // Increment operation generation: invalidates any previous in-flight recovery callbacks
      state.generationId += 1;
      const currentGen = state.generationId;

      // Update desired persistent state
      state.desiredState = 'RUNNING';
      config.desiredState = 'RUNNING';
      db.saveStream(config);

      const actionSource = options.source || (options.isAutoStart ? 'system' : 'user');
      this.transitionState(streamId, 'STARTING', undefined, actionSource);

      let inputPath = '';
      let isConcatList = false;
      let hasAudio = false;

      if (config.playlistId) {
        const playlist = db.getPlaylistById(config.playlistId);
        if (playlist && playlist.items && playlist.items.length > 0) {
          const concatFilename = `.playlist_${config.id}_${playlist.id}.txt`;
          const concatFilePath = path.join(UPLOADS_DIR, concatFilename);
          const lines = playlist.items.map(item => {
            const itemPath = path.join(UPLOADS_DIR, path.basename(item.filename)).replace(/'/g, "'\\''");
            return `file '${itemPath}'`;
          });
          fs.writeFileSync(concatFilePath, lines.join('\n'), { encoding: 'utf-8', mode: 0o600 });
          inputPath = concatFilePath;
          isConcatList = true;

          // Probe first item for audio
          const firstPath = path.join(UPLOADS_DIR, path.basename(playlist.items[0].filename));
          const firstComp = await MediaAnalyzer.analyze(firstPath);
          hasAudio = !!(firstComp.audioCodec || firstComp.audioChannels);
        }
      }

      if (!inputPath) {
        const videoBasename = path.basename(config.videoFilename);
        inputPath = path.join(UPLOADS_DIR, videoBasename);
        const mediaComp = await MediaAnalyzer.analyze(inputPath);
        hasAudio = !!(mediaComp.audioCodec || mediaComp.audioChannels);
      }

      // Format destinations
      const destinations: string[] = [];
      if (config.destinations && config.destinations.length > 0) {
        for (const d of config.destinations) {
          if (d.enabled !== false && d.streamKey) {
            destinations.push(FfmpegCommandBuilder.buildRtmpDestination(d.rtmpUrl, d.streamKey));
          }
        }
      } else {
        destinations.push(FfmpegCommandBuilder.buildRtmpDestination(config.rtmpUrl, config.streamKey));
      }

      if (destinations.length === 0) {
        this.transitionState(streamId, 'FAILED', 'No active broadcast destinations configured', actionSource);
        return { success: false, error: 'No active broadcast destinations configured' };
      }

      // Build safe argument array
      const ffmpegArgs = FfmpegCommandBuilder.build({
        inputPath,
        isConcatList,
        hasAudio,
        loop: config.loop !== false,
        mode: config.encodingMode,
        destinations,
      });

      state.startedAt = new Date().toISOString();
      state.recentLogs.push(
        `[${new Date().toLocaleTimeString()}] Spawning cloud FFmpeg broadcast process (Gen: ${currentGen})...`
      );
      this.healthMonitor.recordSpawn(streamId);

      try {
        const activeFfmpegPath = resolveFfmpegPath() || 'ffmpeg';
        const child = this.processManager.spawnStream({
          streamId,
          generationId: currentGen,
          args: ffmpegArgs,
          ffmpegPath: activeFfmpegPath,
          onLog: (line: string) => {
            // Drop logs if generation has expired
            if (state.generationId !== currentGen) return;

            state.recentLogs.push(line);
            if (state.recentLogs.length > 80) {
              state.recentLogs.shift();
            }

            // Progress parsing
            const updated = this.healthMonitor.parseFfmpegProgressLine(state, line);
            if (updated && (state.status === 'STARTING' || state.status === 'CONNECTING')) {
              this.transitionState(streamId, 'LIVE', undefined, 'system');
            }

            this.broadcastTelemetry({
              type: 'stream.log',
              streamId,
              data: { line },
              timestamp: new Date().toISOString(),
            });
          },
          onError: (err: Error) => {
            if (state.generationId !== currentGen) return;
            console.error(`[StreamSupervisor] FFmpeg error on ${streamId} (Gen: ${currentGen}):`, err);
            this.handleStreamCrash(streamId, err.message);
          },
          onExit: (code: number | null, signal: string | null) => {
            if (state.generationId !== currentGen) {
              console.log(
                `[StreamSupervisor] Ignoring exit from stale FFmpeg process on ${streamId} (Gen: ${currentGen} != Current: ${state.generationId})`
              );
              return;
            }

            console.log(
              `[StreamSupervisor] FFmpeg process on ${streamId} exited with code ${code}, signal ${signal} (Gen: ${currentGen})`
            );
            this.healthMonitor.clearStream(streamId);

            if (state.status === 'STOPPING') {
              this.transitionState(streamId, 'STOPPED', 'Broadcast stopped cleanly.', 'user');
            } else if (code === 0) {
              this.transitionState(streamId, 'STOPPED', 'Broadcast playback completed normally.', 'system');
            } else {
              const lastErrorLine =
                state.recentLogs
                  .slice()
                  .reverse()
                  .find(l => {
                    const low = l.toLowerCase();
                    return (
                      isNetworkJitterError(l) ||
                      low.includes('error') ||
                      low.includes('fail') ||
                      low.includes('refused') ||
                      low.includes('handshake')
                    );
                  }) || `Process exited abnormally (code: ${code ?? 'none'}, signal: ${signal ?? 'none'})`;
              this.handleStreamCrash(streamId, lastErrorLine);
            }
          },
        });

        state.pid = child.pid;
        this.transitionState(streamId, 'CONNECTING', undefined, actionSource);
        return { success: true };
      } catch (err: any) {
        this.healthMonitor.clearStream(streamId);
        this.transitionState(streamId, 'FAILED', err.message, actionSource);
        return { success: false, error: err.message };
      }
    } finally {
      this.activeOperations.delete(streamId);
      releaseLock();
    }
  }

  // Handle unexpected process crash or socket stall with exponential backoff recovery
  private async handleStreamCrash(streamId: string, reason: string): Promise<void> {
    const config = db.getStreamById(streamId);
    const state = this.getOrCreateRuntimeState(streamId);

    // Invalidate stale callbacks if user manually stopped in desiredState
    if (state.desiredState === 'STOPPED') {
      console.log(`[StreamSupervisor] Stream ${streamId} crashed but desiredState is STOPPED. Suppressing recovery.`);
      this.transitionState(streamId, 'STOPPED', 'Stopped by user preference', 'user');
      return;
    }

    const currentGen = state.generationId;
    const category = classifyStreamError(reason);
    const isJitter = isNetworkJitterError(reason) || state.recentLogs.slice(-15).some(l => isNetworkJitterError(l));

    state.lastError = reason;
    state.errorCategory = category;
    state.isNetworkJitter = isJitter;
    state.restartCount += 1;
    state.lastRestartTime = new Date().toISOString();

    // Mark stream status as FAILED
    this.transitionState(streamId, 'FAILED', reason, 'system');

    // Permanent errors (missing file, invalid keys) must NOT be retried indefinitely
    if (category === 'PERMANENT') {
      console.warn(
        `[StreamSupervisor] Stream ${streamId} encountered permanent error ("${reason}"). Recovery aborted to avoid crash loops.`
      );
      state.recentLogs.push(`[${new Date().toLocaleTimeString()}] [Permanent Failure] ${reason}. Automatic restart disabled.`);
      return;
    }

    const retryPolicyEnabled = config?.retryPolicy !== false;
    const retryDelay = config?.retryDelaySeconds && config.retryDelaySeconds > 0 ? config.retryDelaySeconds : 30;

    const isGenerationCurrent = () => state.generationId === currentGen && state.desiredState === 'RUNNING';

    // 30-second delay for network jitter
    if (config && retryPolicyEnabled && (isJitter || config.retryPolicy)) {
      console.log(
        `[StreamSupervisor] Stream ${streamId} entered FAILED due to network jitter. Scheduling 30s auto-restart (Gen: ${currentGen})...`
      );
      state.recentLogs.push(
        `[${new Date().toLocaleTimeString()}] [Retry Policy] Network jitter detected ("${reason}"). Reconnecting in ${retryDelay}s...`
      );

      this.recoveryManager.scheduleJitterRecovery(
        config,
        state,
        async () => {
          if (!isGenerationCurrent()) return;
          console.log(`[StreamSupervisor] Jitter delay elapsed. Auto-reconnecting stream ${streamId}...`);
          state.recentLogs.push(`[${new Date().toLocaleTimeString()}] [Retry Policy] Executing reconnection attempt...`);
          const res = await this.startStream(streamId, { isAutoStart: false, force: true, source: 'recovery' });
          if (!res.success && this.recoveryManager.shouldAttemptRecovery(config, state)) {
            this.handleStreamCrash(streamId, res.error || 'Reconnection attempt failed');
          }
        },
        retryDelay,
        () => {
          this.broadcastTelemetry({
            type: 'stream.stats',
            streamId,
            data: {
              status: state.status,
              reconnectCountdown: state.reconnectCountdown,
              nextRetryAt: state.nextRetryAt,
              isNetworkJitter: state.isNetworkJitter,
              lastError: state.lastError,
              retryAttempt: state.retryAttempt,
            },
            timestamp: new Date().toISOString(),
          });
        },
        isGenerationCurrent
      );
    } else if (config && this.recoveryManager.shouldAttemptRecovery(config, state)) {
      console.log(`[StreamSupervisor] Scheduling standard recovery for stream ${streamId} (Reason: ${reason})`);
      this.recoveryManager.scheduleRecovery(
        config,
        state,
        async () => {
          if (!isGenerationCurrent()) return;
          await this.startStream(streamId, { isAutoStart: false, force: true, source: 'recovery' });
        },
        isGenerationCurrent
      );
    } else {
      console.warn(`[StreamSupervisor] Stream ${streamId} marked FAILED without recovery (budget exhausted or autoRestart disabled).`);
    }
  }

  // Gracefully stop a running stream with strict cancellation of recovery
  public async stopStream(
    streamId: string,
    reason = 'Manually stopped by user',
    source: ActionSource = 'user'
  ): Promise<boolean> {
    const releaseLock = await this.acquireStreamLock(streamId);

    try {
      const state = this.getOrCreateRuntimeState(streamId);

      // Invalidate operation generation so no pending timer or exit callback can revive this stream
      state.generationId += 1;
      this.recoveryManager.cancelAll(streamId);
      this.healthMonitor.clearStream(streamId);

      state.reconnectCountdown = undefined;
      state.nextRetryAt = undefined;
      state.desiredState = 'STOPPED';

      // Persist desiredState = STOPPED so restart reconciliation respects manual stop
      const config = db.getStreamById(streamId);
      if (config) {
        config.desiredState = 'STOPPED';
        db.saveStream(config);
      }

      if (state.status === 'STOPPED' || state.status === 'IDLE') {
        return true;
      }

      this.transitionState(streamId, 'STOPPING', reason, source);
      state.recentLogs.push(`[${new Date().toLocaleTimeString()}] Stopping broadcast cleanly: ${reason}`);

      await this.processManager.stopStream(streamId);
      this.transitionState(streamId, 'STOPPED', reason, source);
      return true;
    } finally {
      releaseLock();
    }
  }

  // Restart an existing stream as an atomic lifecycle operation
  public async restartStream(streamId: string): Promise<{ success: boolean; error?: string }> {
    const releaseLock = await this.acquireStreamLock(streamId);

    try {
      this.recoveryManager.cancelAll(streamId);
      const state = this.getOrCreateRuntimeState(streamId);

      // Stop old process cleanly
      state.generationId += 1;
      this.transitionState(streamId, 'STOPPING', 'Restarting broadcast', 'user');
      await this.processManager.stopStream(streamId);
      this.transitionState(streamId, 'STOPPED', 'Stopped for restart', 'user');

      // Reset recovery counter
      this.recoveryManager.resetRetryCount(state);

      // Start replacement process
      return await this.startStream(streamId, { force: true, source: 'user' });
    } finally {
      releaseLock();
    }
  }

  // Immediate retry triggering
  public async triggerImmediateRetry(streamId: string): Promise<boolean> {
    const success = await this.recoveryManager.triggerImmediateRetry(streamId);
    if (!success) {
      const res = await this.restartStream(streamId);
      return res.success;
    }
    return success;
  }

  // Cancel scheduled jitter retry
  public cancelRetry(streamId: string): void {
    const state = this.getOrCreateRuntimeState(streamId);
    state.generationId += 1;
    this.recoveryManager.cancelAll(streamId);

    state.reconnectCountdown = undefined;
    state.nextRetryAt = undefined;
    this.broadcastTelemetry({
      type: 'stream.stats',
      streamId,
      data: {
        status: state.status,
        reconnectCountdown: undefined,
        nextRetryAt: undefined,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // Stop all active streams cleanly
  public async stopAllStreams(): Promise<void> {
    const ids = Array.from(this.runtimeStates.keys());
    await Promise.all(ids.map(id => this.stopStream(id, 'Global stop called', 'system')));
  }

  // Get stream runtime state
  public getStreamRuntime(streamId: string): StreamRuntimeState {
    return this.getOrCreateRuntimeState(streamId);
  }

  // Get all stream statuses combined with persistent configurations
  public getAllStreams(): any[] {
    const configs = db.getStreams();
    return configs.map(cfg => {
      const state = this.getOrCreateRuntimeState(cfg.id);
      const isAlive = this.processManager.isProcessAlive(cfg.id);

      return {
        ...cfg,
        status:
          isAlive && state.status !== 'STOPPED' && state.status !== 'FAILED'
            ? state.status
            : state.status === 'STARTING' ||
              state.status === 'CONNECTING' ||
              state.status === 'FAILED' ||
              state.status === 'RECONNECTING' ||
              state.status === 'RECOVERING'
            ? state.status
            : 'STOPPED',
        isProcessAlive: isAlive,
        pid: state.pid,
        startedAt: state.startedAt || cfg.createdAt,
        uptimeSeconds: state.uptimeSeconds,
        fps: state.fps,
        frameCount: state.frameCount,
        bitrate: state.bitrate,
        speed: state.speed,
        latencyMs: state.latencyMs,
        lastProgressTime: state.lastProgressTime,
        destinationStatus: state.destinationStatus || (isAlive ? 'UNVERIFIED' : undefined),
        lastError: state.lastError,
        errorCategory: state.errorCategory,
        restartCount: state.restartCount,
        retryAttempt: state.retryAttempt,
        recentLogs: state.recentLogs,
        reconnectCountdown: state.reconnectCountdown,
        nextRetryAt: state.nextRetryAt,
        isNetworkJitter: state.isNetworkJitter,
        retryPolicy: cfg.retryPolicy !== false,
        retryDelaySeconds: cfg.retryDelaySeconds || 30,
        generationId: state.generationId,
        desiredState: state.desiredState || cfg.desiredState,
        maskedStreamKey: cfg.streamKey ? '••••••••' + cfg.streamKey.slice(-4) : '',
        destinations: cfg.destinations
          ? cfg.destinations.map(d => ({
              ...d,
              maskedStreamKey: d.streamKey ? '••••••••' + d.streamKey.slice(-4) : '',
              streamKey: undefined,
            }))
          : undefined,
        streamKey: undefined, // Never expose raw stream key
      };
    });
  }

  // Real-time telemetry SSE subscription
  public subscribeTelemetry(callback: (event: any) => void): () => void {
    this.telemetrySubscribers.add(callback);
    return () => {
      this.telemetrySubscribers.delete(callback);
    };
  }

  private broadcastTelemetry(event: any) {
    for (const sub of this.telemetrySubscribers) {
      try {
        sub(event);
      } catch {}
    }
  }

  // Graceful shutdown on SIGINT/SIGTERM
  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    console.log('[StreamSupervisor] Graceful shutdown requested. Halting all FFmpeg broadcast processes...');
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    await this.stopAllStreams();
    console.log('[StreamSupervisor] All FFmpeg workers stopped cleanly.');
  }
}

export const supervisor = StreamSupervisor.getInstance();

