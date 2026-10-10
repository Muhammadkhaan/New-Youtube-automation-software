import { db } from '../db';
import { StreamEvent, AuditLog } from '../db/schema';
import { supervisor } from '../supervisor/StreamSupervisor';

export interface AnalyticsTimeFilter {
  range: '24h' | '7d' | '30d' | 'all';
}

export interface StreamAnalyticsSummary {
  totalStartAttempts: number;
  successfulStarts: number;
  failedStarts: number;
  completedStops: number;
  unexpectedExits: number;
  recoveryAttempts: number;
  recoverySuccesses: number;
  totalUptimeSeconds: number;
  scheduledStarts: number;
  manualStarts: number;
  topFailureReasons: { reason: string; count: number }[];
}

export interface MediaAnalyticsSummary {
  totalAssetsCount: number;
  totalSizeBytes: number;
  totalSizeFormatted: string;
  readyCount: number;
  processingCount: number;
  failedCount: number;
  missingCount: number;
  uploadSuccessCount: number;
  uploadFailureCount: number;
}

export interface SchedulerAnalyticsSummary {
  totalSchedules: number;
  activeScheduled: number;
  completedCount: number;
  failedCount: number;
  executedOccurrences: number;
  skippedConflicts: number;
  missedOccurrences: number;
}

export interface OperationalAnalyticsReport {
  timeRange: '24h' | '7d' | '30d' | 'all';
  filterStartTimestamp?: string;
  generatedAt: string;
  streams: StreamAnalyticsSummary;
  media: MediaAnalyticsSummary;
  scheduler: SchedulerAnalyticsSummary;
}

function getRangeCutoffMs(range: '24h' | '7d' | '30d' | 'all'): number {
  const now = Date.now();
  switch (range) {
    case '24h':
      return now - 24 * 60 * 60 * 1000;
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return now - 30 * 24 * 60 * 60 * 1000;
    case 'all':
    default:
      return 0;
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export class AnalyticsService {
  public static getReport(range: '24h' | '7d' | '30d' | 'all' = '24h'): OperationalAnalyticsReport {
    const cutoffMs = getRangeCutoffMs(range);
    const cutoffDate = cutoffMs > 0 ? new Date(cutoffMs).toISOString() : undefined;

    // Filter events by timestamp
    const allEvents = db.getStreamEvents(undefined, 2000);
    const filteredEvents = allEvents.filter(e => {
      if (cutoffMs === 0) return true;
      const t = new Date(e.timestamp).getTime();
      return !isNaN(t) && t >= cutoffMs;
    });

    const auditLogs = db.getAuditLogs(1000).filter(a => {
      if (cutoffMs === 0) return true;
      const t = new Date(a.timestamp).getTime();
      return !isNaN(t) && t >= cutoffMs;
    });

    // 1. Stream Metrics
    let totalStartAttempts = 0;
    let successfulStarts = 0;
    let failedStarts = 0;
    let completedStops = 0;
    let unexpectedExits = 0;
    let recoveryAttempts = 0;
    let recoverySuccesses = 0;
    let scheduledStarts = 0;
    let manualStarts = 0;

    const failureReasonMap = new Map<string, number>();

    for (const evt of filteredEvents) {
      const type = evt.type || '';
      const details = evt.details || {};

      if (type.includes('STARTING') || type === 'STREAM_START_ATTEMPT') {
        totalStartAttempts++;
        if (details.source === 'scheduler') scheduledStarts++;
        else if (details.source === 'recovery') recoveryAttempts++;
        else manualStarts++;
      } else if (type === 'STREAM_STATUS_LIVE') {
        successfulStarts++;
        if (details.from === 'RECOVERING' || details.from === 'RECONNECTING') {
          recoverySuccesses++;
        }
      } else if (type === 'STREAM_STATUS_FAILED') {
        failedStarts++;
        unexpectedExits++;
        const reason = evt.message.split(': ')[1] || evt.message || 'Unknown failure';
        const cleanReason = reason.slice(0, 80);
        failureReasonMap.set(cleanReason, (failureReasonMap.get(cleanReason) || 0) + 1);
      } else if (type === 'STREAM_STATUS_STOPPED') {
        completedStops++;
      } else if (type.includes('SCHEDULED_BROADCAST_TRIGGERED')) {
        scheduledStarts++;
      }
    }

    const topFailureReasons = Array.from(failureReasonMap.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Active streams uptime calculation
    const currentStreams = supervisor.getAllStreams();
    let totalUptimeSeconds = 0;
    for (const s of currentStreams) {
      if (s.isProcessAlive && s.uptimeSeconds) {
        totalUptimeSeconds += s.uptimeSeconds;
      }
    }

    // 2. Media Metrics
    const mediaAssets = db.getMediaAssets();
    let totalSizeBytes = 0;
    let readyCount = 0;
    let processingCount = 0;
    let failedCount = 0;
    let missingCount = 0;

    for (const m of mediaAssets) {
      totalSizeBytes += m.sizeBytes || 0;
      const status = m.status || (m.isLiveReady !== false ? 'ready' : 'invalid');
      if (status === 'ready') readyCount++;
      else if (status === 'processing' || status === 'uploading') processingCount++;
      else if (status === 'missing') missingCount++;
      else failedCount++;
    }

    const uploadSuccessCount = auditLogs.filter(a => a.action === 'UPLOAD_MEDIA' && a.result === 'SUCCESS').length;
    const uploadFailureCount = auditLogs.filter(a => a.action === 'UPLOAD_MEDIA' && a.result === 'FAILURE').length;

    // 3. Scheduler Metrics
    const schedules = db.getSchedules();
    let scheduledCount = 0;
    let schedCompleted = 0;
    let schedFailed = 0;
    let executedOccurrences = 0;
    let skippedConflicts = 0;
    let missedOccurrences = 0;

    for (const s of schedules) {
      if (s.status === 'scheduled') scheduledCount++;
      else if (s.status === 'completed') schedCompleted++;
      else if (s.status === 'failed') schedFailed++;

      if (s.lastRunAt && (!cutoffMs || new Date(s.lastRunAt).getTime() >= cutoffMs)) {
        executedOccurrences++;
      }

      if (s.lastExecutionResult) {
        if (s.lastExecutionResult.actionTaken === 'skipped_conflict') {
          skippedConflicts++;
        }
      }
    }

    return {
      timeRange: range,
      filterStartTimestamp: cutoffDate,
      generatedAt: new Date().toISOString(),
      streams: {
        totalStartAttempts,
        successfulStarts,
        failedStarts,
        completedStops,
        unexpectedExits,
        recoveryAttempts,
        recoverySuccesses,
        totalUptimeSeconds,
        scheduledStarts,
        manualStarts,
        topFailureReasons,
      },
      media: {
        totalAssetsCount: mediaAssets.length,
        totalSizeBytes,
        totalSizeFormatted: formatBytes(totalSizeBytes),
        readyCount,
        processingCount,
        failedCount,
        missingCount,
        uploadSuccessCount,
        uploadFailureCount,
      },
      scheduler: {
        totalSchedules: schedules.length,
        activeScheduled: scheduledCount,
        completedCount: schedCompleted,
        failedCount: schedFailed,
        executedOccurrences,
        skippedConflicts,
        missedOccurrences,
      },
    };
  }
}
