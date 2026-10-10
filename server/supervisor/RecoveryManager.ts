import { StreamConfig, StreamRuntimeState, ErrorCategory } from '../db/schema';
import { db } from '../db';

export function isNetworkJitterError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  const jitterKeywords = [
    'broken pipe',
    'connection reset',
    'connection refused',
    'timed out',
    'timeout',
    'network',
    'socket',
    'handshake',
    'tls',
    'ssl',
    'failed to write',
    'server returned',
    'server closed',
    'av_interleaved_write_frame',
    'end of file',
    'econnreset',
    'etimedout',
    'enetunreach',
    'econnrefused',
    'rtmp',
    'io error',
    'i/o error',
    'stall',
    'pipe closed',
    'stalled',
    'jitter',
    'peer',
    'connection dropped',
    'rtmp drop',
  ];
  return jitterKeywords.some(kw => lower.includes(kw));
}

// Classify errors into TRANSIENT, PERMANENT, or UNKNOWN
export function classifyStreamError(errorMessage?: string): ErrorCategory {
  if (!errorMessage) return 'UNKNOWN';
  const lower = errorMessage.toLowerCase();

  const permanentKeywords = [
    'no such file',
    'file not found',
    'does not exist',
    'invalid argument',
    'unknown format',
    'invalid data found',
    'permission denied',
    '403 forbidden',
    'unauthorized',
    'stream key invalid',
    'authentication failed',
    'moov atom not found',
    'no active broadcast destinations',
    'unsupported codec',
  ];
  if (permanentKeywords.some(kw => lower.includes(kw))) {
    return 'PERMANENT';
  }

  if (isNetworkJitterError(errorMessage)) {
    return 'TRANSIENT';
  }

  return 'UNKNOWN';
}

interface ActiveJitterRetry {
  timer: NodeJS.Timeout;
  interval: NodeJS.Timeout;
  restartFn: () => Promise<void>;
  targetTimeMs: number;
  generationId: number;
}

export class RecoveryManager {
  private activeTimers = new Map<string, { timer: NodeJS.Timeout; generationId: number }>();
  private activeJitterRetries = new Map<string, ActiveJitterRetry>();

  // Exponential backoff base delays (ms)
  private readonly backoffDelaysMs = [1000, 3000, 8000, 15000, 30000];

  public getBackoffDelay(attempt: number, withJitter = true): number {
    const idx = Math.min(attempt - 1, this.backoffDelaysMs.length - 1);
    const base = this.backoffDelaysMs[Math.max(0, idx)];
    if (!withJitter) return base;
    // Bounded jitter up to +1500ms to desynchronize concurrent restarts
    const jitter = Math.floor(Math.random() * 1500);
    return base + jitter;
  }

  public shouldAttemptRecovery(config: StreamConfig, state: StreamRuntimeState): boolean {
    if (!config.autoRestart && !config.retryPolicy) {
      return false;
    }

    // Do not endlessly retry permanent errors like missing files or invalid keys
    if (state.errorCategory === 'PERMANENT') {
      return false;
    }

    const maxRetries = config.maxRetries || 5;
    return state.retryAttempt < maxRetries;
  }

  // Standard backoff recovery with generation check
  public scheduleRecovery(
    config: StreamConfig,
    state: StreamRuntimeState,
    executeRestart: () => Promise<void>,
    isGenerationCurrent: () => boolean
  ): number {
    this.cancelScheduledRecovery(config.id);

    state.retryAttempt += 1;
    state.status = 'RECOVERING';

    const delayMs = this.getBackoffDelay(state.retryAttempt, true);
    const scheduledGen = state.generationId;

    db.addStreamEvent({
      streamId: config.id,
      level: 'WARNING',
      type: 'STREAM_AUTO_RECOVERY_SCHEDULED',
      message: `Automatic crash recovery scheduled for "${config.name}". Attempt ${state.retryAttempt}/${config.maxRetries || 5} in ${(delayMs / 1000).toFixed(1)}s (Gen: ${scheduledGen}).`,
      details: {
        attempt: state.retryAttempt,
        delayMs,
        lastError: state.lastError,
        errorCategory: state.errorCategory,
      },
    });

    const timer = setTimeout(async () => {
      this.activeTimers.delete(config.id);
      // Verify generation before executing: discard if superseded or manually stopped
      if (!isGenerationCurrent()) {
        console.log(`[RecoveryManager] Discarding stale recovery attempt for stream ${config.id} (generation expired).`);
        return;
      }

      try {
        console.log(`[RecoveryManager] Executing recovery attempt ${state.retryAttempt} for stream ${config.id}...`);
        await executeRestart();
      } catch (err: any) {
        console.error(`[RecoveryManager] Recovery attempt failed for stream ${config.id}:`, err);
      }
    }, delayMs);

    this.activeTimers.set(config.id, { timer, generationId: scheduledGen });
    return delayMs;
  }

  // 30-Second Network Jitter Auto-Restart Mechanism with generation check
  public scheduleJitterRecovery(
    config: StreamConfig,
    state: StreamRuntimeState,
    executeRestart: () => Promise<void>,
    delaySeconds = 30,
    onTick?: () => void,
    isGenerationCurrent?: () => boolean
  ): number {
    this.cancelScheduledRecovery(config.id);
    this.cancelJitterRecovery(config.id);

    const targetTimeMs = Date.now() + delaySeconds * 1000;
    state.isNetworkJitter = true;
    state.reconnectCountdown = delaySeconds;
    state.nextRetryAt = new Date(targetTimeMs).toISOString();
    const scheduledGen = state.generationId;

    db.addStreamEvent({
      streamId: config.id,
      level: 'WARNING',
      type: 'STREAM_JITTER_RETRY_SCHEDULED',
      message: `Network jitter detected on "${config.name}". Retry Policy triggered automatic reconnection in ${delaySeconds} seconds.`,
      details: {
        delaySeconds,
        targetTime: state.nextRetryAt,
        lastError: state.lastError,
        retryAttempt: state.retryAttempt,
      },
    });

    if (onTick) {
      onTick();
    }

    const interval = setInterval(() => {
      const remainingSecs = Math.max(0, Math.ceil((targetTimeMs - Date.now()) / 1000));
      state.reconnectCountdown = remainingSecs;
      if (onTick) {
        onTick();
      }
      if (remainingSecs <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    const timer = setTimeout(async () => {
      this.activeJitterRetries.delete(config.id);
      clearInterval(interval);
      state.reconnectCountdown = undefined;
      state.nextRetryAt = undefined;
      state.retryAttempt += 1;

      if (isGenerationCurrent && !isGenerationCurrent()) {
        console.log(`[RecoveryManager] Discarding stale jitter recovery for stream ${config.id} (generation expired).`);
        return;
      }

      db.addStreamEvent({
        streamId: config.id,
        level: 'INFO',
        type: 'STREAM_JITTER_RETRY_EXECUTING',
        message: `Executing 30-second automatic reconnection attempt for "${config.name}" following network jitter.`,
        details: {
          attempt: state.retryAttempt,
        },
      });

      try {
        console.log(`[RecoveryManager] 30s jitter delay elapsed. Auto-restarting stream ${config.id}...`);
        await executeRestart();
      } catch (err: any) {
        console.error(`[RecoveryManager] Auto-restart attempt failed for stream ${config.id}:`, err);
      }
    }, delaySeconds * 1000);

    this.activeJitterRetries.set(config.id, {
      timer,
      interval,
      restartFn: executeRestart,
      targetTimeMs,
      generationId: scheduledGen,
    });

    return delaySeconds;
  }

  public async triggerImmediateRetry(streamId: string): Promise<boolean> {
    const jitterRetry = this.activeJitterRetries.get(streamId);
    if (jitterRetry) {
      clearTimeout(jitterRetry.timer);
      clearInterval(jitterRetry.interval);
      this.activeJitterRetries.delete(streamId);
      try {
        await jitterRetry.restartFn();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  public cancelScheduledRecovery(streamId: string): void {
    const item = this.activeTimers.get(streamId);
    if (item) {
      clearTimeout(item.timer);
      this.activeTimers.delete(streamId);
    }
  }

  public cancelJitterRecovery(streamId: string): void {
    const item = this.activeJitterRetries.get(streamId);
    if (item) {
      clearTimeout(item.timer);
      clearInterval(item.interval);
      this.activeJitterRetries.delete(streamId);
    }
  }

  public cancelAll(streamId: string): void {
    this.cancelScheduledRecovery(streamId);
    this.cancelJitterRecovery(streamId);
  }

  public hasPendingJitterRetry(streamId: string): boolean {
    return this.activeJitterRetries.has(streamId);
  }

  public resetRetryCount(state: StreamRuntimeState): void {
    state.retryAttempt = 0;
    state.reconnectCountdown = undefined;
    state.nextRetryAt = undefined;
    state.isNetworkJitter = false;
    state.errorCategory = undefined;
  }
}
