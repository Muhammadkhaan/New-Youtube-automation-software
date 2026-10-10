export type StreamStatus =
  | 'IDLE'
  | 'STARTING'
  | 'CONNECTING'
  | 'LIVE'
  | 'DEGRADED'
  | 'RECONNECTING'
  | 'RECOVERING'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED';

export type DestinationStatus = 'UNVERIFIED' | 'CONNECTED' | 'FAILED';
export type ErrorCategory = 'TRANSIENT' | 'PERMANENT' | 'UNKNOWN';
export type ActionSource = 'user' | 'recovery' | 'scheduler' | 'system';

export type UserRole = 'owner' | 'admin' | 'stream_manager' | 'operator' | 'viewer';

export interface AdminPermissions {
  canAddUsers?: boolean;
  canEditUsers?: boolean;
  canResetPasswords?: boolean;
  canDeactivateUsers?: boolean;
  canDeleteUsers?: boolean;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  role: UserRole;
  isActive: boolean;
  passwordHash: string;
  salt: string;
  adminPermissions?: AdminPermissions;
  notes?: string;
  isPendingInvitation?: boolean;
  sessionVersion?: number;
  createdAt: string;
  updatedAt?: string;
  lastLoginAt?: string;
}

export interface UserInvitation {
  id: string;
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: number;
  usedAt?: string;
  createdAt: string;
}

export interface PasswordResetOtp {
  id: string;
  userId: string;
  email: string;
  otpHash: string;
  resetTokenHash?: string;
  expiresAt: number;
  attempts: number;
  usedAt?: string;
  createdAt: string;
}

export interface StreamDestination {
  id: string;
  name: string;
  description?: string;
  channelId?: string;
  provider: 'youtube' | 'custom_rtmp' | 'facebook';
  rtmpUrl: string;
  streamKey: string; // Plaintext in secure DB file, masked when served to frontend
  enabled: boolean;
  status?: 'CONNECTED' | 'DISCONNECTED' | 'UNVERIFIED' | 'ERROR';
  lastConnectionCheck?: string;
  userId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface MediaAssetCompatibility {
  compatibleForCopy: boolean;
  recommendation: 'STREAM_COPY' | 'TRANSCODE_REQUIRED';
  reasons: string[];
  videoCodec?: string;
  profile?: string;
  pixelFormat?: string;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  durationSeconds?: number;
}

export type MediaProcessingStatus =
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'invalid'
  | 'failed'
  | 'missing'
  | 'deleting';

export interface MediaAsset {
  id: string;
  filename: string;
  displayName: string;
  originalFilename?: string;
  fileType: string;
  mimeType?: string;
  containerFormat?: string;
  sizeBytes: number;
  sizeFormatted: string;
  storagePath: string;
  url: string;
  thumbnailUrl?: string;
  durationFormatted: string;
  durationSeconds: number;
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  status?: MediaProcessingStatus;
  isLiveReady: boolean;
  userId?: string;
  validationError?: string;
  tags?: string[];
  category?: string;
  compatibility?: MediaAssetCompatibility;
  createdAt: string;
  updatedAt?: string;
}

export interface PlaylistItem {
  id: string;
  mediaAssetId: string;
  filename: string;
  displayName: string;
  durationSeconds: number;
  order: number;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  playbackMode?: 'loop' | 'once';
  items: PlaylistItem[];
  totalDurationSeconds: number;
  totalDurationFormatted: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

export type EncodingMode =
  | 'copy'
  | 'transcode_1080p_high'
  | 'transcode_1080p'
  | 'transcode_720p'
  | 'transcode_480p';

export interface StreamConfig {
  id: string;
  name: string;
  userId?: string;
  mediaAssetId?: string;
  videoFilename: string; // Basename in uploads/
  playlistId?: string; // If playlist broadcast
  destinationId?: string; // Linked destination
  destinations?: StreamDestination[]; // Multi-destination simulcast
  rtmpUrl: string;
  streamKey: string;
  encodingMode: EncodingMode;
  loop: boolean;
  autoStart: boolean; // Auto-start on server reboot / node restart
  autoRestart: boolean; // Auto-restart on crash with backoff
  desiredState?: 'RUNNING' | 'STOPPED'; // Desired persistent operational state across reboots
  retryPolicy?: boolean; // Auto-restart on network jitter with 30s delay
  retryDelaySeconds?: number; // Delay in seconds before reconnecting (default: 30)
  maxRetries: number; // Max restart attempts before marking FAILED (default: 5)
  channelTitle?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StreamRuntimeState {
  streamId: string;
  status: StreamStatus;
  desiredState?: 'RUNNING' | 'STOPPED';
  generationId: number; // Monotonically increasing epoch ID to prevent stale callbacks
  pid?: number;
  startedAt?: string;
  uptimeSeconds: number;
  fps?: number;
  frameCount?: number;
  bitrate?: string;
  speed?: string;
  latencyMs?: number;
  lastProgressTime?: string;
  hasProducedProgress?: boolean;
  destinationStatus?: DestinationStatus;
  cpuPercent?: number;
  memoryMb?: number;
  restartCount: number;
  lastRestartTime?: string;
  retryAttempt: number;
  reconnectCountdown?: number;
  nextRetryAt?: string;
  isNetworkJitter?: boolean;
  errorCategory?: ErrorCategory;
  lastError?: string;
  lastStateChangeAt?: string;
  lastStateChangeReason?: string;
  lastActionSource?: ActionSource;
  recentLogs: string[];
  lastConnectedAt?: string;
}

export type ScheduleConflictPolicy = 'skip' | 'delay' | 'replace';

export interface ScheduleExecutionResult {
  occurrenceId: string;
  startedAt: string;
  success: boolean;
  streamId?: string;
  error?: string;
  actionTaken?: 'started' | 'skipped_conflict' | 'delayed_conflict' | 'replaced_conflict' | 'failed';
}

export interface Schedule {
  id: string;
  title: string;
  streamConfigId?: string;
  videoFilename: string;
  playlistId?: string;
  destinationId?: string;
  rtmpUrl?: string;
  streamKey?: string;
  mode: EncodingMode;
  loop: boolean;
  scheduledAt: string; // ISO date string
  timezone?: string; // e.g. 'UTC', 'America/New_York', etc.
  frequency: 'once' | 'daily' | 'weekly';
  daysOfWeek?: number[]; // [0..6] for Sunday..Saturday
  enabled?: boolean; // whether schedule is active
  conflictPolicy?: ScheduleConflictPolicy; // 'skip' | 'delay' | 'replace'
  userId?: string;
  status: 'scheduled' | 'running' | 'completed' | 'cancelled' | 'failed';
  lastRunAt?: string;
  lastExecutionResult?: ScheduleExecutionResult;
  createdAt: string;
  updatedAt?: string;
}

export interface StreamEvent {
  id: string;
  streamId: string;
  timestamp: string;
  level: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  type: string;
  message: string;
  userId?: string;
  details?: Record<string, any>;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  username: string;
  userId?: string;
  action: string;
  streamId?: string;
  result: 'SUCCESS' | 'FAILURE';
  details?: string;
  ipAddress?: string;
}

export interface ServerSettings {
  serverName: string;
  maxConcurrentStreams: number;
  maxCpuUsageThreshold: number;
  enableOrphanProcessReconciliation: boolean;
  autoStartStreamsOnBoot: boolean;
  defaultEncodingPreset: EncodingMode;
  rtmpConnectTimeoutSeconds: number;
  sessionTimeoutHours: number;
  storageQuotaGb: number;
}
