import os from 'os';
import { db } from '../db';
import { supervisor } from '../supervisor/StreamSupervisor';
import { StorageService } from './StorageService';

export type SystemHealthStatus = 'HEALTHY' | 'DEGRADED' | 'RECOVERING' | 'CRITICAL';

export interface SystemHealthReport {
  status: SystemHealthStatus;
  statusReasons: string[];
  timestamp: string;
  uptimeSeconds: number;
  cpu: {
    cores: number;
    usagePercent: number;
    isSimulated: boolean;
  };
  memory: {
    systemTotalMb: number;
    systemFreeMb: number;
    systemUsedPercent: number;
    processRssMb: number;
    processHeapUsedMb: number;
  };
  storage: {
    totalGb: number;
    usedMb: number;
    usedPercent: number;
    isQuotaExceeded: boolean;
  };
  broadcast: {
    activeStreamsCount: number;
    maxConcurrentStreams: number;
    streamsInRecoveryCount: number;
    failedStreamsCount: number;
    managedProcessesCount: number;
  };
  scheduler: {
    status: 'ACTIVE' | 'IDLE' | 'ERROR';
    upcomingScheduledCount: number;
  };
}

export class MonitoringService {
  private static lastCpuSample = { idle: 0, total: 0 };

  private static getRealCpuUsagePercent(): number {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return 0;

    let idle = 0;
    let total = 0;

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        total += (cpu.times as any)[type];
      }
      idle += cpu.times.idle;
    }

    const prev = this.lastCpuSample;
    const diffIdle = idle - prev.idle;
    const diffTotal = total - prev.total;

    this.lastCpuSample = { idle, total };

    if (diffTotal <= 0) return 0;
    const usage = Math.round((1 - diffIdle / diffTotal) * 100);
    return Math.max(0, Math.min(100, usage));
  }

  public static getSystemHealthReport(simulatedCpuOverride: number | null = null): SystemHealthReport {
    const settings = db.getSettings();
    const streams = supervisor.getAllStreams();
    const storageStats = StorageService.getStorageStats();

    // CPU calculation
    const isSimulated = simulatedCpuOverride !== null;
    const cpuUsagePercent = isSimulated ? simulatedCpuOverride! : this.getRealCpuUsagePercent();

    // Memory calculation
    const totalMem = Math.round(os.totalmem() / (1024 * 1024));
    const freeMem = Math.round(os.freemem() / (1024 * 1024));
    const memPercent = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;
    const procMem = process.memoryUsage();
    const procRssMb = Math.round(procMem.rss / (1024 * 1024));
    const procHeapMb = Math.round(procMem.heapUsed / (1024 * 1024));

    // Streams stats
    const activeStreamsCount = streams.filter(s => s.isProcessAlive).length;
    const streamsInRecovery = streams.filter(s => s.status === 'RECOVERING' || s.status === 'RECONNECTING').length;
    const failedStreams = streams.filter(s => s.status === 'FAILED').length;

    // Scheduler stats
    const schedules = db.getSchedules();
    const upcomingSchedules = schedules.filter(s => s.status === 'scheduled').length;

    // Status evaluation
    const reasons: string[] = [];
    let status: SystemHealthStatus = 'HEALTHY';

    if (streamsInRecovery > 0) {
      status = 'RECOVERING';
      reasons.push(`${streamsInRecovery} stream(s) currently reconnecting after transient signal drop`);
    }

    if (cpuUsagePercent >= (settings.maxCpuUsageThreshold || 85)) {
      if (status === 'HEALTHY') status = 'DEGRADED';
      reasons.push(`CPU utilization (${cpuUsagePercent}%) exceeds threshold (${settings.maxCpuUsageThreshold}%)`);
    }

    if (storageStats.percentUsed >= 90) {
      if (status === 'HEALTHY' || status === 'DEGRADED') status = 'DEGRADED';
      reasons.push(`Storage capacity critical: ${storageStats.percentUsed}% of ${storageStats.totalCapacityFormatted} utilized`);
    }

    if (failedStreams > 0 && activeStreamsCount === 0) {
      if (status !== 'RECOVERING') {
        status = 'DEGRADED';
        reasons.push(`${failedStreams} stream(s) encountered unrecoverable broadcast errors`);
      }
    }

    if (reasons.length === 0) {
      reasons.push('All broadcast pipelines, process monitors, and schedule daemons nominal');
    }

    return {
      status,
      statusReasons: reasons,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      cpu: {
        cores: os.cpus()?.length || 1,
        usagePercent: cpuUsagePercent,
        isSimulated,
      },
      memory: {
        systemTotalMb: totalMem,
        systemFreeMb: freeMem,
        systemUsedPercent: memPercent,
        processRssMb: procRssMb,
        processHeapUsedMb: procHeapMb,
      },
      storage: {
        totalGb: settings.storageQuotaGb || 50,
        usedMb: Math.round(storageStats.usedBytes / (1024 * 1024)),
        usedPercent: storageStats.percentUsed,
        isQuotaExceeded: storageStats.isQuotaExceeded,
      },
      broadcast: {
        activeStreamsCount,
        maxConcurrentStreams: settings.maxConcurrentStreams || 8,
        streamsInRecoveryCount: streamsInRecovery,
        failedStreamsCount: failedStreams,
        managedProcessesCount: activeStreamsCount,
      },
      scheduler: {
        status: 'ACTIVE',
        upcomingScheduledCount: upcomingSchedules,
      },
    };
  }
}
