import React, { useState, useEffect } from 'react';
import {
  RotateCw,
  TrendingUp,
  AlertOctagon,
  Clock,
  Film,
  Calendar,
  CheckCircle2,
  HardDrive,
  Activity,
  Layers,
} from 'lucide-react';
import { OperationalAnalyticsReport, SystemHealthReport } from '../types';

interface AnalyticsViewProps {
  fetchWithAuth?: (url: string, init?: RequestInit) => Promise<Response>;
  streams?: any[];
  systemInfo?: any;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({ fetchWithAuth }) => {
  const [range, setRange] = useState<'24h' | '7d' | '30d' | 'all'>('24h');
  const [report, setReport] = useState<OperationalAnalyticsReport | null>(null);
  const [health, setHealth] = useState<SystemHealthReport | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const fetchFn = fetchWithAuth || fetch;
      const [analyticsRes, healthRes] = await Promise.all([
        fetchFn(`/api/analytics?range=${range}`),
        fetchFn('/api/system/health'),
      ]);

      if (analyticsRes.ok) {
        const aData = await analyticsRes.json();
        setReport(aData);
      }
      if (healthRes.ok) {
        const hData = await healthRes.json();
        setHealth(hData);
      }
    } catch (err) {
      console.warn('Error loading analytics:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [range]);

  const streams = report?.streams;
  const media = report?.media;
  const scheduler = report?.scheduler;

  const recoverySuccessRate = streams && streams.recoveryAttempts > 0
    ? Math.round((streams.recoverySuccesses / streams.recoveryAttempts) * 100)
    : 100;

  const uptimeHours = streams ? (streams.totalUptimeSeconds / 3600).toFixed(1) : '0.0';

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header & Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
        <div>
          <h1 className="text-2xl font-bold text-[#0F172A] tracking-tight">Operational Analytics & Telemetry</h1>
          <p className="text-xs text-[#64748B] mt-0.5">
            Real historical metrics derived from broadcast state machines, process exits, and scheduler executions.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          {/* Time range selector */}
          <div className="flex items-center bg-white border border-[#E2E8F0] rounded-xl p-1 shadow-2xs">
            {(['24h', '7d', '30d', 'all'] as const).map(r => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  range === r
                    ? 'bg-[#2563EB] text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                {r === '24h' ? 'Last 24 Hours' : r === '7d' ? '7 Days' : r === '30d' ? '30 Days' : 'All Time'}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={fetchData}
            className="p-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 transition-colors cursor-pointer"
            title="Refresh metrics"
          >
            <RotateCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Primary KPI Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold">Total Broadcast Starts</span>
            <TrendingUp className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-3xl font-extrabold text-[#0F172A] font-mono">
            {streams?.totalStartAttempts ?? 0}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>Successful: <strong className="text-emerald-600">{streams?.successfulStarts ?? 0}</strong></span>
            <span>Failed: <strong className="text-red-600">{streams?.failedStarts ?? 0}</strong></span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold">Automatic Recovery Rate</span>
            <Activity className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-3xl font-extrabold text-emerald-700 font-mono">
            {recoverySuccessRate}%
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>Attempts: {streams?.recoveryAttempts ?? 0}</span>
            <span>Restored: {streams?.recoverySuccesses ?? 0}</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold">Cumulative Uptime</span>
            <Clock className="w-4 h-4 text-purple-600" />
          </div>
          <div className="text-3xl font-extrabold text-[#0F172A] font-mono">
            {uptimeHours} <span className="text-sm font-sans font-normal text-slate-500">hrs</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            Across {health?.broadcast.activeStreamsCount ?? 0} running cloud stream(s)
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs">
          <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-xs font-semibold">Storage Capacity</span>
            <HardDrive className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-3xl font-extrabold text-[#0F172A] font-mono">
            {health?.storage.usedPercent ?? 0}%
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
            <span>{media?.totalSizeFormatted ?? '0 B'} used</span>
            <span>Quota: {health?.storage.totalGb ?? 50} GB</span>
          </div>
        </div>
      </div>

      {/* Subsystem Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 1. Stream Operations & Failures */}
        <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#2563EB]" />
              <h3 className="text-sm font-bold text-[#0F172A]">Broadcast Lifecycle Breakdown</h3>
            </div>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Manual User Starts</span>
              <span className="font-bold font-mono text-slate-900">{streams?.manualStarts ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Scheduled Automated Starts</span>
              <span className="font-bold font-mono text-slate-900">{streams?.scheduledStarts ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Clean Intentional Stops</span>
              <span className="font-bold font-mono text-emerald-700">{streams?.completedStops ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5">
              <span className="text-slate-600">Unexpected Exits / Crashes</span>
              <span className="font-bold font-mono text-red-600">{streams?.unexpectedExits ?? 0}</span>
            </div>
          </div>

          {streams && streams.topFailureReasons.length > 0 && (
            <div className="pt-3 border-t border-slate-100 space-y-2">
              <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                <AlertOctagon className="w-3.5 h-3.5 text-red-500" />
                <span>Top Failure Classifications</span>
              </span>
              <div className="space-y-1.5">
                {streams.topFailureReasons.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center text-xs p-2 rounded-lg bg-red-50 border border-red-100 text-red-900">
                    <span className="truncate pr-2">{item.reason}</span>
                    <span className="font-mono font-bold bg-white px-1.5 py-0.5 rounded text-red-700 border border-red-200">
                      {item.count}x
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 2. Media Library Health */}
        <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs space-y-4">
          <div className="flex items-center gap-2">
            <Film className="w-4 h-4 text-purple-600" />
            <h3 className="text-sm font-bold text-[#0F172A]">Media Library Pipeline</h3>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Managed Video Assets</span>
              <span className="font-bold font-mono text-slate-900">{media?.totalAssetsCount ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Ready for Live Broadcast</span>
              <span className="font-bold font-mono text-emerald-700">{media?.readyCount ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Processing / In-Flight</span>
              <span className="font-bold font-mono text-blue-700">{media?.processingCount ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Missing from Disk Volume</span>
              <span className="font-bold font-mono text-amber-700">{media?.missingCount ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5">
              <span className="text-slate-600">Processing / Format Failures</span>
              <span className="font-bold font-mono text-red-600">{media?.failedCount ?? 0}</span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1.5">
            <div className="flex justify-between text-slate-600">
              <span>Disk Volume Space Used</span>
              <span className="font-bold text-slate-900">{media?.totalSizeFormatted ?? '0 B'}</span>
            </div>
            <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
              <div
                className="bg-blue-600 h-full rounded-full transition-all"
                style={{ width: `${Math.min(100, health?.storage.usedPercent ?? 0)}%` }}
              />
            </div>
          </div>
        </div>

        {/* 3. Scheduler Automations */}
        <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs space-y-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-emerald-600" />
            <h3 className="text-sm font-bold text-[#0F172A]">Schedule Daemon Outcomes</h3>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Configured Schedules</span>
              <span className="font-bold font-mono text-slate-900">{scheduler?.totalSchedules ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Upcoming Active Planned</span>
              <span className="font-bold font-mono text-blue-700">{scheduler?.activeScheduled ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Executed Occurrences</span>
              <span className="font-bold font-mono text-emerald-700">{scheduler?.executedOccurrences ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
              <span className="text-slate-600">Skipped Conflict Events</span>
              <span className="font-bold font-mono text-amber-700">{scheduler?.skippedConflicts ?? 0}</span>
            </div>
            <div className="flex justify-between items-center py-1.5">
              <span className="text-slate-600">Failed Launch Attempts</span>
              <span className="font-bold font-mono text-red-600">{scheduler?.failedCount ?? 0}</span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-emerald-50/60 border border-emerald-100 text-xs text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Autonomous schedule polling daemon active every 15s with occurrence idempotency locks.</span>
          </div>
        </div>
      </div>

      {/* System Health Status Panel */}
      {health && (
        <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-slate-700" />
              <h3 className="text-sm font-bold text-[#0F172A]">Host Machine & Cluster Diagnostics</h3>
            </div>
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-bold font-mono border ${
                health.status === 'HEALTHY'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : health.status === 'RECOVERING'
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}
            >
              {health.status}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <span className="text-slate-500 block text-[11px]">CPU Cores / Usage</span>
              <span className="font-mono font-bold text-slate-900">{health.cpu.cores} cores ({health.cpu.usagePercent}%)</span>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <span className="text-slate-500 block text-[11px]">Memory Usage (RSS)</span>
              <span className="font-mono font-bold text-slate-900">{health.memory.processRssMb} MB / {health.memory.systemTotalMb} MB</span>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <span className="text-slate-500 block text-[11px]">Concurrency Capacity</span>
              <span className="font-mono font-bold text-slate-900">{health.broadcast.activeStreamsCount} / {health.broadcast.maxConcurrentStreams} Max</span>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <span className="text-slate-500 block text-[11px]">Engine Node Uptime</span>
              <span className="font-mono font-bold text-slate-900">{(health.uptimeSeconds / 3600).toFixed(1)} hours</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
