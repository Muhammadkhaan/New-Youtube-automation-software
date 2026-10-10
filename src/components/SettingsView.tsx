import React, { useState, useEffect } from 'react';
import {
  Shield,
  Server,
  Save,
  Check,
  KeyRound,
  Cpu,
  HardDrive,
  Radio,
  Lock,
  AlertCircle,
  Clock,
} from 'lucide-react';

interface SettingsViewProps {
  fetchWithAuth?: (url: string, init?: RequestInit) => Promise<Response>;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ fetchWithAuth, showToast }) => {
  const [rtmpEndpoint, setRtmpEndpoint] = useState('rtmps://a.rtmps.youtube.com:443/live2');
  const [defaultResolution, setDefaultResolution] = useState('copy');
  const [autoLoop, setAutoLoop] = useState(true);
  const [maxConcurrentStreams, setMaxConcurrentStreams] = useState(8);
  const [maxCpuUsageThreshold, setMaxCpuUsageThreshold] = useState(85);
  const [storageQuotaGb, setStorageQuotaGb] = useState(50);
  const [sessionTimeoutHours, setSessionTimeoutHours] = useState(48);

  // Security password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const [savedSuccess, setSavedSuccess] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchClient = fetchWithAuth || fetch;

  useEffect(() => {
    fetchClient('/api/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings) {
          const s = data.settings;
          if (s.maxConcurrentStreams) setMaxConcurrentStreams(s.maxConcurrentStreams);
          if (s.maxCpuUsageThreshold) setMaxCpuUsageThreshold(s.maxCpuUsageThreshold);
          if (s.storageQuotaGb) setStorageQuotaGb(s.storageQuotaGb);
          if (s.sessionTimeoutHours) setSessionTimeoutHours(s.sessionTimeoutHours);
          if (s.defaultEncodingPreset) setDefaultResolution(s.defaultEncodingPreset);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetchClient('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxConcurrentStreams: Number(maxConcurrentStreams),
          maxCpuUsageThreshold: Number(maxCpuUsageThreshold),
          storageQuotaGb: Number(storageQuotaGb),
          sessionTimeoutHours: Number(sessionTimeoutHours),
        }),
      });

      if (res.ok) {
        setSavedSuccess(true);
        if (showToast) showToast('Platform settings saved successfully!', 'success');
        setTimeout(() => setSavedSuccess(false), 2500);
      } else {
        const err = await res.json();
        if (showToast) showToast(err.error || 'Failed to update settings', 'error');
      }
    } catch {
      if (showToast) showToast('Network error while saving settings', 'error');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg(null);

    if (!currentPassword) {
      setPasswordMsg({ text: 'Please enter your current password.', isError: true });
      return;
    }
    if (!newPassword || newPassword.length < 8) {
      setPasswordMsg({ text: 'New password must be at least 8 characters long.', isError: true });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ text: 'New passwords do not match.', isError: true });
      return;
    }

    setIsChangingPassword(true);
    try {
      const res = await fetchClient('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setPasswordMsg({ text: data.error || 'Password update failed.', isError: true });
      } else {
        setPasswordMsg({ text: 'Owner password changed successfully!', isError: false });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        if (data.newToken && typeof localStorage !== 'undefined') {
          localStorage.setItem('cloudcast_auth_token', data.newToken);
        }
        if (showToast) showToast('Password changed successfully!', 'success');
      }
    } catch {
      setPasswordMsg({ text: 'Network error updating password.', isError: true });
    } finally {
      setIsChangingPassword(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="pb-4 border-b border-[#E2E8F0]">
        <h1 className="text-2xl font-bold text-[#0F172A] tracking-tight">Platform & Streaming Settings</h1>
        <p className="text-xs text-[#64748B] mt-1">
          Configure personal broadcast capacity, VPS resource bounds, default ingest parameters, and account security.
        </p>
      </div>

      {/* Resource & Operational Capacity Limits */}
      <form onSubmit={handleSaveSettings} className="space-y-6">
        <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs space-y-4">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-[#2563EB]" />
            <h3 className="text-sm font-bold text-[#0F172A]">Concurrent Broadcast & VPS Resource Bounds</h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block font-bold text-[#0F172A] mb-1">
                Max Concurrent Live Broadcasts
              </label>
              <input
                type="number"
                min={1}
                max={32}
                value={maxConcurrentStreams}
                onChange={e => setMaxConcurrentStreams(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              />
              <p className="text-[11px] text-[#64748B] mt-1">
                Hard ceiling for simultaneous active FFmpeg encoders (prevents VPS overload).
              </p>
            </div>

            <div>
              <label className="block font-bold text-[#0F172A] mb-1">
                CPU Utilization Alert Threshold (%)
              </label>
              <input
                type="number"
                min={50}
                max={98}
                value={maxCpuUsageThreshold}
                onChange={e => setMaxCpuUsageThreshold(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              />
              <p className="text-[11px] text-[#64748B] mt-1">
                Flags system health as Degraded when host/container CPU exceeds this point.
              </p>
            </div>

            <div>
              <label className="block font-bold text-[#0F172A] mb-1">
                Media Storage Quota (GB)
              </label>
              <input
                type="number"
                min={5}
                max={1000}
                value={storageQuotaGb}
                onChange={e => setStorageQuotaGb(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              />
              <p className="text-[11px] text-[#64748B] mt-1">
                Safe storage limit for uploaded broadcast videos and generated playlists.
              </p>
            </div>

            <div>
              <label className="block font-bold text-[#0F172A] mb-1">
                Session Expiration (Hours)
              </label>
              <input
                type="number"
                min={1}
                max={168}
                value={sessionTimeoutHours}
                onChange={e => setSessionTimeoutHours(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              />
              <p className="text-[11px] text-[#64748B] mt-1">
                Idle session lifetime before requiring re-authentication (1 - 168 hours).
              </p>
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-semibold flex items-center gap-2 shadow-xs transition-colors cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Save Resource Limits</span>
            </button>
          </div>
        </div>
      </form>

      {/* Ingest Server Defaults */}
      <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs space-y-4">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-[#2563EB]" />
          <h3 className="text-sm font-bold text-[#0F172A]">Default Ingestion Endpoint & Encoding Preset</h3>
        </div>

        <div className="space-y-3 text-xs">
          <div>
            <label className="block font-bold text-[#0F172A] mb-1">Default YouTube Ingestion URL</label>
            <input
              type="text"
              value={rtmpEndpoint}
              onChange={e => setRtmpEndpoint(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
            />
            <p className="text-[11px] text-[#64748B] mt-1">
              Standard secure YouTube Live transmission endpoint over TLS port 443 (RTMPS).
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-bold text-[#0F172A] mb-1">Default Encoding Mode</label>
              <select
                value={defaultResolution}
                onChange={e => setDefaultResolution(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white text-[#0F172A]"
              >
                <option value="copy">Direct Stream Copy (0% CPU - Recommended for MP4)</option>
                <option value="transcode_1080p">Transcode 1080p (Standard)</option>
                <option value="transcode_720p">Transcode 720p (Low Bitrate)</option>
              </select>
            </div>

            <div>
              <label className="block font-bold text-[#0F172A] mb-1">Continuous Streaming Default</label>
              <div className="flex items-center gap-2 h-10">
                <input
                  type="checkbox"
                  id="autoLoop"
                  checked={autoLoop}
                  onChange={e => setAutoLoop(e.target.checked)}
                  className="rounded text-[#2563EB] cursor-pointer"
                />
                <label htmlFor="autoLoop" className="text-slate-700 cursor-pointer font-medium">
                  Enable 24/7 infinite loop by default
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Owner Account Security & Password Change */}
      <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-emerald-600" />
          <h3 className="text-sm font-bold text-[#0F172A]">Single-Owner Account Security & Password</h3>
        </div>
        <p className="text-xs text-[#64748B]">
          Update the master director password for this CloudCast instance. Changing your password immediately invalidates all other active login tokens and SSE connections.
        </p>

        {passwordMsg && (
          <div
            className={`p-3 rounded-xl border flex items-center gap-2 text-xs font-medium ${
              passwordMsg.isError
                ? 'bg-red-50 border-red-200 text-red-700'
                : 'bg-emerald-50 border-emerald-200 text-emerald-700'
            }`}
          >
            {passwordMsg.isError ? (
              <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
            ) : (
              <Check className="w-4 h-4 shrink-0 text-emerald-600" />
            )}
            <span>{passwordMsg.text}</span>
          </div>
        )}

        <form onSubmit={handleChangePassword} className="space-y-3 text-xs max-w-md">
          <div>
            <label className="block font-bold text-[#0F172A] mb-1">Current Password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <div>
            <label className="block font-bold text-[#0F172A] mb-1">New Password (min 8 chars)</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <div>
            <label className="block font-bold text-[#0F172A] mb-1">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={isChangingPassword}
              className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-2 shadow-xs transition-colors cursor-pointer disabled:opacity-60"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>{isChangingPassword ? 'Updating Password...' : 'Change Owner Password'}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Stream Key Security & Masking Note */}
      <div className="p-5 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xs space-y-2">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-[#16A34A]" />
          <h3 className="text-sm font-bold text-[#0F172A]">Private Credential Protection</h3>
        </div>
        <p className="text-xs text-[#64748B]">
          All YouTube and custom RTMP stream keys are stored on the server file system and masked before transmission to the browser (only the last 4 characters are ever revealed). Keys are never committed to Git or output in operational telemetry logs.
        </p>
      </div>
    </div>
  );
};
