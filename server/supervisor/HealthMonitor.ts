import { StreamRuntimeState, StreamStatus, DestinationStatus } from '../db/schema';

export interface HealthTimeouts {
  startupTimeoutMs?: number;
  firstProgressTimeoutMs?: number;
  stallTimeoutMs?: number;
  degradedTimeoutMs?: number;
}

export type HealthEvaluationResult =
  | 'OK'
  | 'STARTUP_TIMEOUT'
  | 'FIRST_PROGRESS_TIMEOUT'
  | 'STALLED'
  | 'DEGRADED'
  | 'PROGRESSING_LOCALLY';

export class HealthMonitor {
  private spawnTimestamps = new Map<string, number>();
  private connectionAttemptTimestamps = new Map<string, number>();
  private firstProgressTimestamps = new Map<string, number>();
  private lastProgressTimestamps = new Map<string, number>();
  private lastHealthCheckTimestamps = new Map<string, number>();

  public recordSpawn(streamId: string): void {
    const now = Date.now();
    this.spawnTimestamps.set(streamId, now);
    this.connectionAttemptTimestamps.set(streamId, now);
    this.firstProgressTimestamps.delete(streamId);
    this.lastProgressTimestamps.delete(streamId);
    this.lastHealthCheckTimestamps.set(streamId, now);
  }

  public recordConnectionAttempt(streamId: string): void {
    this.connectionAttemptTimestamps.set(streamId, Date.now());
  }

  public clearStream(streamId: string): void {
    this.spawnTimestamps.delete(streamId);
    this.connectionAttemptTimestamps.delete(streamId);
    this.firstProgressTimestamps.delete(streamId);
    this.lastProgressTimestamps.delete(streamId);
    this.lastHealthCheckTimestamps.delete(streamId);
  }

  public getSpawnTimestamp(streamId: string): number | undefined {
    return this.spawnTimestamps.get(streamId);
  }

  public getFirstProgressTimestamp(streamId: string): number | undefined {
    return this.firstProgressTimestamps.get(streamId);
  }

  public getLastProgressTimestamp(streamId: string): number | undefined {
    return this.lastProgressTimestamps.get(streamId);
  }

  // Parses both structured progress key=value pairs and standard FFmpeg status log lines
  public parseFfmpegProgressLine(
    streamState: StreamRuntimeState,
    line: string
  ): boolean {
    if (!line || typeof line !== 'string') return false;
    let updated = false;
    const now = Date.now();

    // 1. Check for frame count: frame=  142
    const frameMatch = line.match(/(?:^|\s)frame=\s*(\d+)/);
    if (frameMatch) {
      const frames = parseInt(frameMatch[1], 10);
      if (!isNaN(frames)) {
        streamState.frameCount = frames;
        updated = true;
      }
    }

    // 2. Check for fps: fps= 29.97 or fps=30.0
    const fpsMatch = line.match(/(?:^|\s)fps=\s*([\d\.]+)/);
    if (fpsMatch) {
      const fpsVal = parseFloat(fpsMatch[1]);
      if (!isNaN(fpsVal)) {
        streamState.fps = fpsVal;
        updated = true;
      }
    }

    // 3. Check for bitrate: bitrate= 4520.1kbits/s or bitrate=4500k
    const bitrateMatch = line.match(/(?:^|\s)bitrate=\s*([\d\.]+(?:kbits\/s|kbps|k)?)/i);
    if (bitrateMatch && !bitrateMatch[1].startsWith('N/A')) {
      streamState.bitrate = bitrateMatch[1].includes('k') ? bitrateMatch[1] : `${bitrateMatch[1]}kbits/s`;
      updated = true;
    }

    // 4. Check for speed: speed= 1.02x
    const speedMatch = line.match(/(?:^|\s)speed=\s*([\d\.]+x)/);
    if (speedMatch) {
      streamState.speed = speedMatch[1];
      updated = true;
    }

    // 5. Check for time progress: time=00:04:15.22 or out_time=00:04:15.22
    const timeMatch = line.match(/(?:^|\s)(?:time|out_time)=\s*([\d:.]+)/);
    if (timeMatch && !timeMatch[1].startsWith('N/A')) {
      streamState.lastProgressTime = timeMatch[1];
      streamState.hasProducedProgress = true;
      if (!this.firstProgressTimestamps.has(streamState.streamId)) {
        this.firstProgressTimestamps.set(streamState.streamId, now);
      }
      this.lastProgressTimestamps.set(streamState.streamId, now);
      updated = true;

      // When frames and time progress advance stably, mark destination status as UNVERIFIED remote ingest
      if (!streamState.destinationStatus) {
        streamState.destinationStatus = 'UNVERIFIED';
      }
    }

    // 6. Detect successful RTMP / TLS handshake confirmation in verbose logs
    const lower = line.toLowerCase();
    if (
      lower.includes('handshake completed') ||
      lower.includes('stream opened successfully') ||
      lower.includes('rtmps connection established') ||
      lower.includes('connected to')
    ) {
      streamState.destinationStatus = 'CONNECTED';
      streamState.lastConnectedAt = new Date().toISOString();
      updated = true;
    }

    return updated;
  }

  // Evaluates stream health against explicit timeouts
  public checkStreamHealth(
    streamState: StreamRuntimeState,
    timeouts: HealthTimeouts = {}
  ): HealthEvaluationResult {
    const now = Date.now();
    this.lastHealthCheckTimestamps.set(streamState.streamId, now);

    const startupLimit = timeouts.startupTimeoutMs ?? 45000; // 45s max startup time
    const firstProgressLimit = timeouts.firstProgressTimeoutMs ?? 30000; // 30s max wait for first encoded packet
    const stallLimit = timeouts.stallTimeoutMs ?? 20000; // 20s stall limit
    const degradedLimit = timeouts.degradedTimeoutMs ?? 10000; // 10s degraded warning limit

    const spawnTime = this.spawnTimestamps.get(streamState.streamId);
    const firstProgressTime = this.firstProgressTimestamps.get(streamState.streamId);
    const lastProgressTime = this.lastProgressTimestamps.get(streamState.streamId);

    // 1. Detect hung startup in STARTING or CONNECTING
    if (streamState.status === 'STARTING' || streamState.status === 'CONNECTING') {
      if (spawnTime && now - spawnTime > startupLimit) {
        return 'STARTUP_TIMEOUT';
      }
      if (spawnTime && !firstProgressTime && now - spawnTime > firstProgressLimit) {
        return 'FIRST_PROGRESS_TIMEOUT';
      }
      return 'OK';
    }

    // 2. Detect progress stalls during LIVE / DEGRADED / RECOVERING broadcast
    if (streamState.status === 'LIVE' || streamState.status === 'DEGRADED') {
      if (!lastProgressTime) {
        if (spawnTime && now - spawnTime > startupLimit) {
          return 'STARTUP_TIMEOUT';
        }
        return 'OK';
      }

      const elapsedMs = now - lastProgressTime;
      if (elapsedMs > stallLimit) {
        return 'STALLED';
      }
      if (elapsedMs > degradedLimit) {
        return 'DEGRADED';
      }
    }

    return 'OK';
  }

  public updateUptime(streamState: StreamRuntimeState): void {
    if (
      streamState.startedAt &&
      (streamState.status === 'LIVE' ||
        streamState.status === 'CONNECTING' ||
        streamState.status === 'DEGRADED' ||
        streamState.status === 'STARTING')
    ) {
      const startMs = new Date(streamState.startedAt).getTime();
      const nowMs = Date.now();
      streamState.uptimeSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
    }
  }
}
