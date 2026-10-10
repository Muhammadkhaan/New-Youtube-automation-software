import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar, NavTabId } from './components/Sidebar';
import { TopNav } from './components/TopNav';
import { DashboardView } from './components/DashboardView';
import { ActiveStreams } from './components/ActiveStreams';
import { NewStreamView } from './components/NewStreamView';
import { VideoLibrary } from './components/VideoLibrary';
import { ScheduledBroadcastsView } from './components/ScheduledBroadcastsView';
import { AnalyticsView } from './components/AnalyticsView';
import { SettingsView } from './components/SettingsView';
import { PlaylistsView } from './components/PlaylistsView';
import { AuditLogsView } from './components/AuditLogsView';
import { ServerDiagnosticsModal } from './components/ServerDiagnosticsModal';
import { LiveLogsModal } from './components/LiveLogsModal';
import { YouTubeHelpModal } from './components/YouTubeHelpModal';
import { VideoPreviewModal } from './components/VideoPreviewModal';
import { YouTubeStudioManager } from './components/YouTubeStudioManager';
import { UsersManagementView } from './components/UsersManagementView';
import { LoginModal } from './components/LoginModal';
import {
  StreamItem,
  VideoFile,
  SystemInfo,
  UploadProgressInfo,
  YouTubeChannelProfile,
  ScheduledBroadcast,
  StreamAlert,
  NetworkDiagnostic,
} from './types';
import { Radio, AlertCircle, CheckCircle2, Crown, X, Check } from 'lucide-react';

export default function App() {
  const [authToken, setAuthToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem('cloudcast_auth_token') || null;
    } catch {
      return null;
    }
  });

  const [currentUser, setCurrentUser] = useState<{
    id: string;
    username: string;
    displayName: string;
    role: string;
  } | null>(() => {
    try {
      const saved = localStorage.getItem('cloudcast_auth_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [isLoginModalOpen, setIsLoginModalOpen] = useState<boolean>(() => {
    try {
      return !localStorage.getItem('cloudcast_auth_token');
    } catch {
      return true;
    }
  });

  // Check URL query for invite token
  const [inviteToken, setInviteToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('inviteToken');
    }
    return null;
  });

  const [currentTab, setCurrentTab] = useState<NavTabId | 'create'>(() => {
    try {
      const saved = localStorage.getItem('cloudcast_active_tab');
      if (
        saved &&
        ['dashboard', 'streams', 'scheduled', 'videos', 'playlists', 'channels', 'users', 'analytics', 'audit', 'settings', 'create'].includes(
          saved
        )
      ) {
        return saved as any;
      }
    } catch {}
    return 'dashboard';
  });

  const handleTabChange = (tab: NavTabId | 'create') => {
    setCurrentTab(tab);
    try {
      localStorage.setItem('cloudcast_active_tab', tab);
    } catch {}
  };

  const [streams, setStreams] = useState<StreamItem[]>([]);
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [savedChannels, setSavedChannels] = useState<YouTubeChannelProfile[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [diagnostic, setDiagnostic] = useState<NetworkDiagnostic | null>(null);
  const [alerts, setAlerts] = useState<StreamAlert[]>([]);
  const [simulatedCpu, setSimulatedCpu] = useState<number | null>(null);
  const [simulatedLatency, setSimulatedLatency] = useState<number | null>(null);

  const prevAlertStateRef = useRef<{ hadHighCpu: boolean; hadHighLatency: boolean }>({
    hadHighCpu: false,
    hadHighLatency: false,
  });

  const [scheduledList, setScheduledList] = useState<ScheduledBroadcast[]>(() => {
    try {
      const saved = localStorage.getItem('cloudcast_scheduled_streams');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isActionLoading, setIsActionLoading] = useState<string | null>(null);
  const [isStartingStream, setIsStartingStream] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadInfo, setUploadInfo] = useState<UploadProgressInfo | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const currentUploadIdRef = useRef<string | null>(null);
  const [activeLogStream, setActiveLogStream] = useState<StreamItem | null>(null);
  const [isYouTubeHelpOpen, setIsYouTubeHelpOpen] = useState<boolean>(false);
  const [previewVideo, setPreviewVideo] = useState<VideoFile | null>(null);
  const [preselectedVideo, setPreselectedVideo] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4500);
  };

  const saveScheduledList = (newList: ScheduledBroadcast[]) => {
    setScheduledList(newList);
    try {
      localStorage.setItem('cloudcast_scheduled_streams', JSON.stringify(newList));
    } catch {}
  };

  const fetchWithAuth = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const token = authToken || (typeof localStorage !== 'undefined' ? localStorage.getItem('cloudcast_auth_token') : null);
      const headers = new Headers(init?.headers || {});
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      const response = await fetch(input, { ...init, headers });
      if (response.status === 401) {
        setAuthToken(null);
        setCurrentUser(null);
        try {
          localStorage.removeItem('cloudcast_auth_token');
          localStorage.removeItem('cloudcast_auth_user');
        } catch {}
        setIsLoginModalOpen(true);
      }
      return response;
    },
    [authToken]
  );

  const handleLoginSuccess = (token: string, user: any) => {
    setAuthToken(token);
    setCurrentUser(user);
    try {
      localStorage.setItem('cloudcast_auth_token', token);
      localStorage.setItem('cloudcast_auth_user', JSON.stringify(user));
    } catch {}
    setIsLoginModalOpen(false);
    showToast(`Authenticated as ${user.displayName || user.username} (${user.role})`, 'success');
  };

  const handleLogout = async () => {
    try {
      if (authToken) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        });
      }
    } catch {}
    setAuthToken(null);
    setCurrentUser(null);
    try {
      localStorage.removeItem('cloudcast_auth_token');
      localStorage.removeItem('cloudcast_auth_user');
    } catch {}
    setIsLoginModalOpen(true);
    showToast('Signed out of console.', 'info');
  };

  const fetchStreamsAndSystem = useCallback(async (quiet: boolean = false) => {
    if (!quiet) setIsLoading(true);
    try {
      const [streamsData, systemData, diagData] = await Promise.all([
        fetchWithAuth('/api/streams')
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null),
        fetchWithAuth('/api/system')
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null),
        fetchWithAuth('/api/diagnostics/network')
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

      if (streamsData && Array.isArray(streamsData.streams)) {
        setStreams(streamsData.streams);
        setActiveLogStream((current: StreamItem | null) => {
          if (!current) return null;
          const found = streamsData.streams.find((s: StreamItem) => s.id === current.id);
          return found || current;
        });
      }
      if (systemData) {
        setSystemInfo(systemData);
      }
      if (diagData) {
        setDiagnostic(diagData);
      }
    } catch {
      // Graceful silence
    } finally {
      if (!quiet) setIsLoading(false);
    }
  }, [fetchWithAuth]);

  const fetchVideos = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/videos');
      if (res.ok) {
        const data = await res.json();
        setVideos(data.videos || []);
      }
    } catch {}
  }, [fetchWithAuth]);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/youtube/channels');
      if (res.ok) {
        const data = await res.json();
        setSavedChannels(data.channels || []);
      }
    } catch {}
  }, [fetchWithAuth]);

  useEffect(() => {
    if (authToken) {
      fetchStreamsAndSystem(false);
      fetchVideos();
      fetchChannels();
    }
  }, [authToken, fetchStreamsAndSystem, fetchVideos, fetchChannels]);

  useEffect(() => {
    if (!authToken) return;
    const interval = setInterval(() => {
      fetchStreamsAndSystem(true);
    }, 3500);
    return () => clearInterval(interval);
  }, [authToken, fetchStreamsAndSystem]);

  useEffect(() => {
    if (!authToken) return;
    let eventSource: EventSource | null = null;
    let cancelled = false;

    const setupSse = async () => {
      try {
        const ticketRes = await fetch('/api/auth/sse-ticket', {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!ticketRes.ok) return;
        const ticketData = await ticketRes.json();
        if (cancelled || !ticketData.ticket) return;

        eventSource = new EventSource(`/api/events?ticket=${encodeURIComponent(ticketData.ticket)}`);
        eventSource.onmessage = (e) => {
          try {
            const payload = JSON.parse(e.data);
            if (payload.type === 'stream.stats') {
              setStreams(prev =>
                prev.map(s => (s.id === payload.streamId ? { ...s, ...payload.data } : s))
              );
            } else if (payload.type === 'stream.state') {
              setStreams(prev =>
                prev.map(s =>
                  s.id === payload.streamId
                    ? { ...s, status: payload.data.to, lastError: payload.data.lastError }
                    : s
                )
              );
            } else if (payload.type === 'stream.log') {
              setActiveLogStream((current: StreamItem | null) => {
                if (!current || current.id !== payload.streamId) return current;
                return {
                  ...current,
                  recentLogs: [...(current.recentLogs || []).slice(-79), payload.data.line],
                };
              });
            }
          } catch {}
        };
      } catch {}
    };

    setupSse();

    return () => {
      cancelled = true;
      if (eventSource) eventSource.close();
    };
  }, [authToken]);

  // Alert evaluation effect for CPU > 85% or Latency > 500ms
  useEffect(() => {
    const currentCpu = simulatedCpu ?? (systemInfo?.cpuUsagePercent ?? 0);
    const runningStreamWithHighLatency = streams.find(
      s => (s.status === 'running' || s.status === 'LIVE' || s.status === 'starting') && s.latencyMs && s.latencyMs > 500
    );
    const currentLatency =
      simulatedLatency ??
      (runningStreamWithHighLatency?.latencyMs ?? (diagnostic?.secureRtmps443?.latencyMs ?? 14));

    const isLatencySpike = currentLatency > 500;
    const isCpuSpike = currentCpu > 85;

    if (isCpuSpike) {
      if (!prevAlertStateRef.current.hadHighCpu) {
        prevAlertStateRef.current.hadHighCpu = true;
        const newAlert: StreamAlert = {
          id: 'cpu-' + Date.now(),
          type: 'cpu',
          severity: 'critical',
          title: `Server CPU Load Spike: ${currentCpu}%`,
          message: `Server CPU usage has surged to ${currentCpu}%, exceeding the 85% safety threshold. Encoding performance may drop frames or stutter.`,
          value: currentCpu,
          threshold: 85,
          timestamp: new Date().toISOString(),
        };
        setAlerts(prev => [newAlert, ...prev.filter(a => a.type !== 'cpu')]);
        showToast(`High Server CPU Alert: ${currentCpu}% exceeds 85% threshold!`, 'error');
      } else {
        setAlerts(prev =>
          prev.map(a =>
            a.type === 'cpu'
              ? {
                  ...a,
                  value: currentCpu,
                  title: `Server CPU Load Spike: ${currentCpu}%`,
                  message: `Server CPU usage has surged to ${currentCpu}%, exceeding the 85% safety threshold. Encoding performance may drop frames or stutter.`,
                }
              : a
          )
        );
      }
    } else if (prevAlertStateRef.current.hadHighCpu) {
      prevAlertStateRef.current.hadHighCpu = false;
      setAlerts(prev => prev.filter(a => a.type !== 'cpu'));
      showToast(`Server CPU load recovered to nominal levels (${currentCpu}%).`, 'success');
    }

    if (isLatencySpike) {
      if (!prevAlertStateRef.current.hadHighLatency) {
        prevAlertStateRef.current.hadHighLatency = true;
        const newAlert: StreamAlert = {
          id: 'latency-' + Date.now(),
          type: 'latency',
          severity: currentLatency > 750 ? 'critical' : 'warning',
          title: `Live Stream Latency Alert: ${currentLatency}ms`,
          message: `Broadcast latency to RTMP ingest socket reached ${currentLatency}ms, exceeding the 500ms real-time limit. Viewer buffering or audio/video desync may occur.`,
          value: currentLatency,
          threshold: 500,
          timestamp: new Date().toISOString(),
          streamId: runningStreamWithHighLatency?.id,
          streamTitle: runningStreamWithHighLatency?.title || runningStreamWithHighLatency?.name,
        };
        setAlerts(prev => [newAlert, ...prev.filter(a => a.type !== 'latency')]);
        showToast(`High Latency Alert: ${currentLatency}ms exceeds 500ms threshold!`, 'error');
      } else {
        setAlerts(prev =>
          prev.map(a =>
            a.type === 'latency'
              ? {
                  ...a,
                  value: currentLatency,
                  title: `Live Stream Latency Alert: ${currentLatency}ms`,
                  message: `Broadcast latency to RTMP ingest socket reached ${currentLatency}ms, exceeding the 500ms real-time limit. Viewer buffering or audio/video desync may occur.`,
                }
              : a
          )
        );
      }
    } else if (prevAlertStateRef.current.hadHighLatency) {
      prevAlertStateRef.current.hadHighLatency = false;
      setAlerts(prev => prev.filter(a => a.type !== 'latency'));
      showToast(`Live stream latency stabilized to nominal ${currentLatency}ms.`, 'success');
    }
  }, [systemInfo, streams, diagnostic, simulatedCpu, simulatedLatency]);

  const handleDismissAlert = (id: string) => {
    setAlerts(prev => prev.map(a => (a.id === id ? { ...a, dismissed: true } : a)));
  };

  const handleClearAlerts = () => {
    setAlerts([]);
  };

  const handleSimulateThreshold = async (type: 'latency' | 'cpu' | 'reset') => {
    try {
      if (type === 'latency') {
        const targetLatency = 620;
        setSimulatedLatency(targetLatency);
        await fetchWithAuth('/api/diagnostics/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latency: targetLatency }),
        });
        showToast('Simulated live stream latency spike to 620ms (>500ms)', 'error');
      } else if (type === 'cpu') {
        const targetCpu = 92;
        setSimulatedCpu(targetCpu);
        await fetchWithAuth('/api/diagnostics/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cpu: targetCpu }),
        });
        showToast('Simulated server CPU load spike to 92% (>85%)', 'error');
      } else {
        setSimulatedLatency(null);
        setSimulatedCpu(null);
        await fetchWithAuth('/api/diagnostics/simulate/reset', { method: 'POST' });
        showToast('Telemetry simulation reset to nominal levels.', 'success');
      }
      await fetchStreamsAndSystem(true);
    } catch (err: any) {
      showToast(err.message || 'Simulation error', 'error');
    }
  };

  const handleStartStream = async (params: {
    videoFilename: string;
    rtmpUrl: string;
    streamKey: string;
    title: string;
    loop: boolean;
    mode: 'copy' | 'transcode_1080p' | 'transcode_720p';
    destinations?: { rtmpUrl: string; streamKey: string; name?: string }[];
    channelTitle?: string;
    retryPolicy?: boolean;
    retryDelaySeconds?: number;
  }): Promise<boolean> => {
    setIsStartingStream(true);
    try {
      const res = await fetchWithAuth('/api/streams/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to start live stream');
      }
      showToast(`Live broadcast "${params.title}" started successfully!`, 'success');
      await fetchStreamsAndSystem(true);
      setCurrentTab('dashboard');
      return true;
    } catch (err: any) {
      showToast(err.message || 'Error starting broadcast', 'error');
      return false;
    } finally {
      setIsStartingStream(false);
    }
  };

  const handleStartBatchStreams = async (
    batchList: {
      videoFilename: string;
      rtmpUrl: string;
      streamKey: string;
      title: string;
      loop: boolean;
      mode: 'copy' | 'transcode_1080p' | 'transcode_720p';
      channelTitle?: string;
    }[]
  ): Promise<boolean> => {
    setIsStartingStream(true);
    try {
      const res = await fetchWithAuth('/api/streams/start-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streams: batchList }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to start batch broadcasts');
      }
      showToast(`Launched ${data.startedCount} live broadcasts simultaneously!`, 'success');
      await fetchStreamsAndSystem(true);
      setCurrentTab('dashboard');
      return true;
    } catch (err: any) {
      showToast(err.message || 'Error starting batch broadcasts', 'error');
      return false;
    } finally {
      setIsStartingStream(false);
    }
  };

  const handleStopStream = async (id: string): Promise<boolean> => {
    setIsActionLoading(id);
    setStreams(prev =>
      prev.map(s => (s.id === id ? { ...s, status: 'stopped', isProcessAlive: false } : s))
    );
    try {
      const res = await fetchWithAuth(`/api/streams/${id}/stop`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to stop stream');
      showToast(data.message || 'Live broadcast ended cleanly.', 'info');
      await fetchStreamsAndSystem(true);
      return true;
    } catch (err: any) {
      showToast(err.message || 'Error ending stream', 'error');
      await fetchStreamsAndSystem(true);
      return false;
    } finally {
      setIsActionLoading(null);
    }
  };

  const handleStopAllStreams = async (): Promise<void> => {
    try {
      const res = await fetchWithAuth('/api/streams/stop-all', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to stop all streams');
      showToast(data.message || 'All running streams have been stopped.', 'info');
      await fetchStreamsAndSystem(true);
    } catch (err: any) {
      showToast(err.message || 'Error stopping all streams', 'error');
    }
  };

  const handleRestartStream = async (id: string) => {
    setIsActionLoading(id);
    try {
      const res = await fetchWithAuth(`/api/streams/${id}/restart`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restart stream');
      showToast('Live stream restarted!', 'success');
      await fetchStreamsAndSystem(true);
    } catch (err: any) {
      showToast(err.message || 'Error restarting stream', 'error');
    } finally {
      setIsActionLoading(null);
    }
  };

  const handleRetryNow = async (id: string) => {
    setIsActionLoading(id);
    try {
      const res = await fetchWithAuth(`/api/streams/${id}/retry-now`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to reconnect');
      showToast('Immediate reconnection attempt triggered!', 'info');
      await fetchStreamsAndSystem(true);
    } catch (err: any) {
      showToast(err.message || 'Error retrying stream', 'error');
    } finally {
      setIsActionLoading(null);
    }
  };

  const handleCancelRetry = async (id: string) => {
    try {
      await fetchWithAuth(`/api/streams/${id}/cancel-retry`, { method: 'POST' });
      showToast('Cancelled 30s auto-restart countdown.', 'info');
      await fetchStreamsAndSystem(true);
    } catch {}
  };

  const handleSimulateJitter = async (streamId: string) => {
    try {
      const res = await fetchWithAuth('/api/diagnostics/simulate-jitter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to simulate jitter');
      showToast(data.message || 'Network jitter simulated: stream failed, 30s auto-restart triggered!', 'info');
      await fetchStreamsAndSystem(true);
    } catch (err: any) {
      showToast(err.message || 'Simulation error', 'error');
    }
  };

  const handleDeleteStreamRecord = async (id: string) => {
    setIsActionLoading(id);
    try {
      const res = await fetchWithAuth(`/api/streams/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete stream record');
      showToast('Stream record removed.', 'info');
      await fetchStreamsAndSystem(true);
    } catch (err: any) {
      showToast(err.message || 'Error deleting stream record', 'error');
    } finally {
      setIsActionLoading(null);
    }
  };

  const handleAddChannel = async (channel: {
    title: string;
    handle?: string;
    streamKey: string;
    rtmpUrl?: string;
    isDefault?: boolean;
  }): Promise<boolean> => {
    try {
      const res = await fetchWithAuth('/api/youtube/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(channel),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save channel profile');
      showToast(`Channel "${channel.title}" saved!`, 'success');
      await fetchChannels();
      return true;
    } catch (err: any) {
      showToast(err.message || 'Error saving channel', 'error');
      return false;
    }
  };

  const handleDeleteChannel = async (id: string, title?: string): Promise<boolean> => {
    try {
      const res = await fetchWithAuth(`/api/youtube/channels/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete channel');
      showToast(`Removed channel ${title ? `"${title}"` : ''}`, 'info');
      await fetchChannels();
      return true;
    } catch (err: any) {
      showToast(err.message || 'Error deleting channel', 'error');
      return false;
    }
  };

  const handleScheduleBroadcast = (broadcast: Omit<ScheduledBroadcast, 'id' | 'status'>) => {
    const newEntry: ScheduledBroadcast = {
      ...broadcast,
      id: `sched_${Date.now()}`,
      status: 'scheduled',
    };
    saveScheduledList([...scheduledList, newEntry]);
  };

  const handleDeleteSchedule = (id: string) => {
    saveScheduledList(scheduledList.filter(s => s.id !== id));
    showToast('Scheduled stream cancelled', 'info');
  };

  const handleImportVideoUrl = async (url: string, filename?: string): Promise<string | null> => {
    try {
      showToast('Downloading video directly to cloud storage...', 'info');
      const res = await fetchWithAuth('/api/upload/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), filename: filename?.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to download video from URL');
      }
      await fetchVideos();
      showToast(`Imported "${data.file.displayName}" (${data.file.sizeFormatted})!`, 'success');
      return data.file.filename;
    } catch (err: any) {
      showToast(err.message || 'Remote URL download failed', 'error');
      return null;
    }
  };

  const handleUploadFile = async (file: File): Promise<string | null> => {
    try {
      const checkRes = await fetchWithAuth(
        `/api/upload/check?filename=${encodeURIComponent(file.name)}&filesize=${file.size}`
      );
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.exists && checkData.file) {
          showToast(
            `"${file.name}" (${checkData.file.sizeFormatted}) already exists on server!`,
            'success'
          );
          await fetchVideos();
          return checkData.file.filename;
        }
      }
    } catch {}

    const CHUNK_SIZE = 768 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const safeBase = file.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    const uploadId = `up_${safeBase}_${file.size}_768k`;
    currentUploadIdRef.current = uploadId;
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    let existingChunks: Set<number> = new Set();

    try {
      const statusRes = await fetchWithAuth(`/api/upload/chunk-status?uploadId=${uploadId}`);
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (Array.isArray(statusData.uploadedIndexes)) {
          existingChunks = new Set(statusData.uploadedIndexes);
        }
      }
    } catch {}

    const startTime = Date.now();
    let uploadedBytesTotal = existingChunks.size * CHUNK_SIZE;
    const initialPercent = Math.min(Math.round((uploadedBytesTotal / file.size) * 100), 100);
    setUploadProgress(initialPercent);
    setUploadInfo({
      percent: initialPercent,
      uploadedBytes: uploadedBytesTotal,
      totalBytes: file.size,
      speedFormatted: existingChunks.size > 0 ? `Resuming (${existingChunks.size}/${totalChunks})` : 'Starting...',
      etaFormatted: 'Calculating...',
      filename: file.name,
    });

    try {
      const chunksToUpload: number[] = [];
      for (let i = 0; i < totalChunks; i++) {
        if (!existingChunks.has(i)) {
          chunksToUpload.push(i);
        }
      }

      const CONCURRENCY = 2;
      let nextQueueIndex = 0;
      let uploadWorkerError: Error | null = null;

      const runWorker = async () => {
        while (nextQueueIndex < chunksToUpload.length && !controller.signal.aborted && !uploadWorkerError) {
          const chunkIdx = chunksToUpload[nextQueueIndex++];
          if (chunkIdx === undefined) break;
          const start = chunkIdx * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunkLength = end - start;
          const chunkBlob = file.slice(start, end);
          let attempts = 0;
          let success = false;
          let lastError = 'Upload failed';

          while (attempts < 5 && !success && !controller.signal.aborted) {
            try {
              attempts++;
              const chunkHeaders: Record<string, string> = {
                'Content-Type': 'application/octet-stream',
                'x-upload-id': uploadId,
                'x-chunk-index': chunkIdx.toString(),
              };
              if (authToken) {
                chunkHeaders['Authorization'] = `Bearer ${authToken}`;
              }
              const res = await fetch(
                `/api/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&chunkIndex=${chunkIdx}&raw=true`,
                {
                  method: 'POST',
                  headers: chunkHeaders,
                  body: chunkBlob,
                  signal: controller.signal,
                }
              );
              if (!res.ok) {
                const errJson = await res.json().catch(() => ({}));
                throw new Error(errJson.error || `HTTP ${res.status}`);
              }
              success = true;
              uploadedBytesTotal += chunkLength;
              const elapsedSec = Math.max((Date.now() - startTime) / 1000, 0.1);
              const transferredInSession = uploadedBytesTotal - existingChunks.size * CHUNK_SIZE;
              const speedBytes = Math.max(transferredInSession / elapsedSec, 0);
              const remainingBytes = Math.max(file.size - uploadedBytesTotal, 0);
              const etaSec = speedBytes > 0 ? Math.ceil(remainingBytes / speedBytes) : 0;
              const percent = Math.min(Math.round((uploadedBytesTotal / file.size) * 100), 100);
              const speedFormatted = (speedBytes / (1024 * 1024)).toFixed(1) + ' MB/s';
              const etaFormatted =
                etaSec > 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s remaining` : `${etaSec}s remaining`;

              setUploadProgress(percent);
              setUploadInfo({
                percent,
                uploadedBytes: uploadedBytesTotal,
                totalBytes: file.size,
                speedFormatted,
                etaFormatted,
                filename: file.name,
              });
            } catch (chunkErr: any) {
              if (chunkErr.name === 'AbortError' || controller.signal.aborted) return;
              lastError = chunkErr.message || 'Chunk upload failed';
              if (attempts < 5) {
                await new Promise(r => setTimeout(r, 400 * attempts));
              }
            }
          }
          if (!success && !controller.signal.aborted) {
            uploadWorkerError = new Error(`Chunk ${chunkIdx + 1}/${totalChunks} failed: ${lastError}`);
            break;
          }
        }
      };

      const workerCount = Math.min(CONCURRENCY, Math.max(chunksToUpload.length, 1));
      const workers = Array.from({ length: workerCount }, () => runWorker());
      await Promise.all(workers);

      if (uploadWorkerError) throw uploadWorkerError;
      if (controller.signal.aborted) throw new Error('Upload cancelled');

      const finalizeRes = await fetchWithAuth('/api/upload/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId, filename: file.name, totalChunks }),
      });
      const finalizeData = await finalizeRes.json();
      if (!finalizeRes.ok || !finalizeData.success) {
        throw new Error(finalizeData.error || 'Server failed to assemble chunks');
      }
      setUploadProgress(null);
      setUploadInfo(null);
      uploadAbortRef.current = null;
      currentUploadIdRef.current = null;
      await fetchVideos();
      showToast(`"${file.name}" saved to server storage!`, 'success');
      return finalizeData.file?.filename || null;
    } catch (err: any) {
      setUploadProgress(null);
      setUploadInfo(null);
      uploadAbortRef.current = null;
      currentUploadIdRef.current = null;
      if (err.message !== 'Upload cancelled') {
        showToast(err.message || 'Video upload failed', 'error');
      }
      return null;
    }
  };

  const handleDeleteVideo = async (filename: string): Promise<boolean> => {
    try {
      const res = await fetchWithAuth(`/api/videos/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete video');
      }
      await fetchVideos();
      showToast(`Deleted video "${filename}"`, 'info');
      return true;
    } catch (err: any) {
      showToast(err.message || 'Failed to delete video', 'error');
      return false;
    }
  };

  const handleGenerateTestVideo = async (): Promise<string | null> => {
    try {
      const res = await fetchWithAuth('/api/generate-test-video', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate test video');
      }
      await fetchVideos();
      showToast('Generated 30-second SMPTE color bars test video!', 'success');
      return data.file.filename;
    } catch (err: any) {
      showToast(err.message || 'Failed to generate test video', 'error');
      throw err;
    }
  };

  const handleStartWithVideo = (filename: string) => {
    setPreselectedVideo(filename);
    setCurrentTab('create');
  };

  const activeCount = streams.filter(s => s.status === 'running' || s.status === 'LIVE' || s.status === 'CONNECTING' || s.status === 'starting').length;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex font-sans selection:bg-[#2563EB] selection:text-white">
      {/* 1. Left Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab as NavTabId}
        setCurrentTab={handleTabChange}
        activeStreamsCount={activeCount}
        scheduledCount={scheduledList.length}
        videosCount={videos.length}
        channelsCount={savedChannels.length}
        currentUser={currentUser}
        onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
        isOpenMobile={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
      />

      {/* 2. Main Content Wrapper */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0 min-h-screen">
        {/* Top Navigation Bar */}
        <TopNav
          onToggleMobileMenu={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          onRefresh={() => {
            fetchStreamsAndSystem(false);
            fetchVideos();
            fetchChannels();
          }}
          isLoading={isLoading}
          alerts={alerts}
          onClearAlerts={handleClearAlerts}
          onTriggerTestAlert={handleSimulateThreshold}
          currentUser={currentUser}
          onLogout={handleLogout}
          onOpenLogin={() => setIsLoginModalOpen(true)}
        />

        {/* Toast Alert */}
        {toast && (
          <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-3 duration-150">
            <div
              className={`px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2.5 text-xs font-semibold border ${
                toast.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : toast.type === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-white border-[#E2E8F0] text-[#0F172A]'
              }`}
            >
              {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
              {toast.type === 'error' && <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />}
              {toast.type === 'info' && <Radio className="w-4 h-4 text-[#2563EB] shrink-0" />}
              <span>{toast.message}</span>
            </div>
          </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-7">
          {currentTab === 'dashboard' && (
            <DashboardView
              streams={streams}
              videos={videos}
              systemInfo={systemInfo}
              savedChannels={savedChannels}
              scheduledBroadcasts={scheduledList}
              alerts={alerts}
              onDismissAlert={handleDismissAlert}
              onSimulateThresholdAlert={handleSimulateThreshold}
              simulatedCpu={simulatedCpu}
              simulatedLatency={simulatedLatency}
              onStartStream={handleStartStream}
              onStartBatchStreams={handleStartBatchStreams}
              onStopStream={handleStopStream}
              onStopAllStreams={handleStopAllStreams}
              onRestartStream={handleRestartStream}
              onRetryNow={handleRetryNow}
              onCancelRetry={handleCancelRetry}
              onSimulateJitter={handleSimulateJitter}
              onDeleteStreamRecord={handleDeleteStreamRecord}
              onOpenLogs={s => setActiveLogStream(s)}
              onPreviewVideo={v => setPreviewVideo(v)}
              onStartWithVideo={handleStartWithVideo}
              onNavigateTab={handleTabChange}
              onOpenYouTubeGuide={() => setIsYouTubeHelpOpen(true)}
              onGenerateTestVideo={handleGenerateTestVideo}
              onUploadFile={handleUploadFile}
              onImportVideoUrl={handleImportVideoUrl}
              onDeleteVideo={handleDeleteVideo}
              onAddChannel={handleAddChannel}
              onDeleteChannel={handleDeleteChannel}
              onScheduleBroadcast={handleScheduleBroadcast}
              uploadProgress={uploadProgress}
              uploadInfo={uploadInfo}
              onCancelUpload={() => {
                if (uploadAbortRef.current) uploadAbortRef.current.abort();
                setUploadProgress(null);
                setUploadInfo(null);
              }}
              isActionLoading={isActionLoading}
              showToast={showToast}
            />
          )}

          {currentTab === 'streams' && (
            <ActiveStreams
              streams={streams}
              onStopStream={handleStopStream}
              onStopAllStreams={handleStopAllStreams}
              onRestartStream={handleRestartStream}
              onRetryNow={handleRetryNow}
              onCancelRetry={handleCancelRetry}
              onSimulateJitter={handleSimulateJitter}
              onDeleteStreamRecord={handleDeleteStreamRecord}
              onOpenLogs={s => setActiveLogStream(s)}
              onGoToCreate={() => handleTabChange('create')}
              onStartStream={s => handleStartWithVideo(s.videoFilename)}
              isActionLoading={isActionLoading}
            />
          )}

          {currentTab === 'scheduled' && (
            <ScheduledBroadcastsView
              scheduledList={scheduledList}
              onOpenScheduleModal={() => setCurrentTab('dashboard')}
              onGoLiveEarly={sched => {
                setPreselectedVideo(sched.videoFilename);
                setCurrentTab('create');
              }}
              onDeleteSchedule={handleDeleteSchedule}
            />
          )}

          {currentTab === 'videos' && (
            <VideoLibrary
              videos={videos}
              onUploadFile={handleUploadFile}
              onDeleteVideo={handleDeleteVideo}
              onGenerateTestVideo={handleGenerateTestVideo}
              onStartWithVideo={handleStartWithVideo}
              onPreviewVideo={v => setPreviewVideo(v)}
              uploadProgress={uploadProgress}
              uploadInfo={uploadInfo}
              onCancelUpload={() => {
                if (uploadAbortRef.current) uploadAbortRef.current.abort();
                setUploadProgress(null);
                setUploadInfo(null);
              }}
              onImportVideoUrl={handleImportVideoUrl}
            />
          )}

          {currentTab === 'playlists' && (
            <PlaylistsView
              videos={videos}
              onStartWithPlaylist={(pl) => {
                if (pl.items && pl.items.length > 0) {
                  setPreselectedVideo(pl.items[0].filename);
                  setCurrentTab('create');
                  showToast(`Selected clip from playlist "${pl.name}" for broadcast setup.`, 'info');
                } else {
                  showToast('Playlist contains no media clips.', 'error');
                }
              }}
            />
          )}

          {currentTab === 'channels' && (
            <YouTubeStudioManager
              videos={videos}
              activeStreams={streams}
              onStartStream={handleStartStream}
              onStopStream={handleStopStream}
              showToast={showToast}
              fetchWithAuth={fetchWithAuth}
            />
          )}

          {currentTab === 'users' && (
            <UsersManagementView
              fetchWithAuth={fetchWithAuth}
              showToast={showToast}
              currentUser={currentUser}
            />
          )}

          {currentTab === 'analytics' && (
            <AnalyticsView streams={streams} systemInfo={systemInfo} fetchWithAuth={fetchWithAuth} />
          )}

          {currentTab === 'audit' && (
            <AuditLogsView fetchWithAuth={fetchWithAuth} />
          )}

          {currentTab === 'settings' && (
            <SettingsView fetchWithAuth={fetchWithAuth} showToast={showToast} />
          )}

          {currentTab === 'create' && (
            <NewStreamView
              videos={videos}
              preselectedVideoFilename={preselectedVideo}
              onStartStream={handleStartStream}
              onStartBatchStreams={handleStartBatchStreams}
              onUploadFile={handleUploadFile}
              onGenerateTestVideo={handleGenerateTestVideo}
              onOpenYouTubeGuide={() => setIsYouTubeHelpOpen(true)}
              onPreviewVideo={v => setPreviewVideo(v)}
              isStarting={isStartingStream}
              uploadProgress={uploadProgress}
              uploadInfo={uploadInfo}
              onCancelUpload={() => {
                if (uploadAbortRef.current) uploadAbortRef.current.abort();
                setUploadProgress(null);
                setUploadInfo(null);
              }}
              onImportVideoUrl={handleImportVideoUrl}
            />
          )}
        </main>
      </div>

      {/* Video Preview Player Modal */}
      <VideoPreviewModal
        video={previewVideo}
        onClose={() => setPreviewVideo(null)}
        onStreamThisVideo={handleStartWithVideo}
      />

      {/* Real-time Logs Terminal Modal */}
      <LiveLogsModal stream={activeLogStream} onClose={() => setActiveLogStream(null)} />

      {/* Cloud VPS Diagnostics Modal */}
      <ServerDiagnosticsModal isOpen={isDiagnosticsOpen} onClose={() => setIsDiagnosticsOpen(false)} />

      {/* Help Modal */}
      <YouTubeHelpModal isOpen={isYouTubeHelpOpen} onClose={() => setIsYouTubeHelpOpen(false)} />

      {/* 8. Authentication Gateway Modal */}
      <LoginModal
        isOpen={isLoginModalOpen || !authToken || !!inviteToken}
        onLoginSuccess={handleLoginSuccess}
        inviteToken={inviteToken}
        onClearInviteToken={() => {
          setInviteToken(null);
          if (typeof window !== 'undefined') {
            window.history.replaceState({}, document.title, window.location.pathname);
          }
        }}
      />
    </div>
  );
}
