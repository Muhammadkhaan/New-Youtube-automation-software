import {
  StreamStatus,
  StreamConfig,
  StreamRuntimeState,
  DestinationStatus,
  ErrorCategory,
  ActionSource,
} from '../db/schema';

export type { StreamStatus, DestinationStatus, ErrorCategory, ActionSource };

// Valid state machine transitions
export const VALID_TRANSITIONS: Record<StreamStatus, StreamStatus[]> = {
  IDLE: ['STARTING', 'STOPPED'],
  STARTING: ['CONNECTING', 'LIVE', 'STOPPING', 'STOPPED', 'FAILED'],
  CONNECTING: ['LIVE', 'RECONNECTING', 'RECOVERING', 'STOPPING', 'STOPPED', 'FAILED'],
  LIVE: ['DEGRADED', 'RECONNECTING', 'RECOVERING', 'STOPPING', 'STOPPED', 'FAILED'],
  DEGRADED: ['LIVE', 'RECONNECTING', 'RECOVERING', 'STOPPING', 'STOPPED', 'FAILED'],
  RECONNECTING: ['STARTING', 'CONNECTING', 'LIVE', 'STOPPING', 'STOPPED', 'FAILED'],
  RECOVERING: ['STARTING', 'CONNECTING', 'LIVE', 'STOPPING', 'STOPPED', 'FAILED'],
  STOPPING: ['STOPPED', 'FAILED'],
  STOPPED: ['STARTING', 'IDLE'],
  FAILED: ['STARTING', 'RECONNECTING', 'RECOVERING', 'STOPPED', 'IDLE'],
};

export function isValidTransition(from: StreamStatus, to: StreamStatus): boolean {
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export interface PreflightCheckResult {
  passed: boolean;
  checks: {
    name: string;
    passed: boolean;
    message: string;
    details?: string;
  }[];
  recommendation?: 'STREAM_COPY' | 'TRANSCODE_REQUIRED';
}

export interface SupervisorStats {
  streamId: string;
  status: StreamStatus;
  uptimeSeconds: number;
  fps?: number;
  bitrate?: string;
  speed?: string;
  latencyMs?: number;
  cpuPercent?: number;
  memoryMb?: number;
  restartCount: number;
  retryAttempt: number;
  lastProgressTime?: string;
  lastError?: string;
}

export interface StreamTelemetryEvent {
  type: 'stream.state' | 'stream.stats' | 'stream.log' | 'stream.recovered' | 'stream.error';
  streamId: string;
  data: any;
  timestamp: string;
}
