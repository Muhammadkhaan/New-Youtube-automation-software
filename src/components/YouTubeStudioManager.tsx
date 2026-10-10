import React, { useState, useEffect, useCallback } from 'react';
import {
  Radio,
  ExternalLink,
  Key,
  RotateCw,
  Plus,
  Trash2,
  Star,
  X,
  Youtube,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Edit2,
  Check,
  Info,
} from 'lucide-react';
import { VideoFile, StreamItem, YouTubeChannelProfile } from '../types';

interface YouTubeStudioManagerProps {
  videos: VideoFile[];
  activeStreams: StreamItem[];
  onStartStream: (config: {
    videoFilename: string;
    rtmpUrl: string;
    streamKey: string;
    title: string;
    loop: boolean;
    mode: 'copy' | 'transcode_1080p' | 'transcode_720p';
    channelTitle?: string;
  }) => Promise<boolean>;
  onStopStream: (id: string) => Promise<boolean | void>;
  showToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  fetchWithAuth?: (url: string, init?: RequestInit) => Promise<Response>;
}

export const YouTubeStudioManager: React.FC<YouTubeStudioManagerProps> = ({
  videos,
  activeStreams,
  onStartStream,
  onStopStream,
  showToast,
  fetchWithAuth,
}) => {
  const [savedChannels, setSavedChannels] = useState<YouTubeChannelProfile[]>([]);
  const [isAddChannelOpen, setIsAddChannelOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<YouTubeChannelProfile | null>(null);

  // Channel form state
  const [channelTitle, setChannelTitle] = useState('');
  const [channelDescription, setChannelDescription] = useState('');
  const [channelHandle, setChannelHandle] = useState('');
  const [channelIdField, setChannelIdField] = useState('');
  const [channelStreamKey, setChannelStreamKey] = useState('');
  const [channelPlatform, setChannelPlatform] = useState<'youtube' | 'facebook' | 'custom'>('youtube');
  const [channelRtmpUrl, setChannelRtmpUrl] = useState('rtmps://a.rtmps.youtube.com:443/live2');
  const [isSavingChannel, setIsSavingChannel] = useState(false);
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);

  // Quick Stream Modal for a specific channel
  const [activeChannelForLaunch, setActiveChannelForLaunch] = useState<YouTubeChannelProfile | null>(null);
  const [launchVideo, setLaunchVideo] = useState(videos[0]?.filename || '');
  const [launchTitle, setLaunchTitle] = useState('');
  const [isLaunchingStream, setIsLaunchingStream] = useState(false);

  const fetchClient = fetchWithAuth || fetch;

  useEffect(() => {
    if (!launchVideo && videos.length > 0) {
      setLaunchVideo(videos[0].filename);
    }
  }, [videos, launchVideo]);

  const loadSavedChannels = useCallback(async () => {
    try {
      const res = await fetchClient('/api/youtube/channels');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.channels)) {
          setSavedChannels(data.channels);
        }
      }
    } catch {}
  }, [fetchClient]);

  useEffect(() => {
    loadSavedChannels();
  }, [loadSavedChannels]);

  const handlePlatformChange = (p: 'youtube' | 'facebook' | 'custom') => {
    setChannelPlatform(p);
    if (p === 'youtube') setChannelRtmpUrl('rtmps://a.rtmps.youtube.com:443/live2');
    else if (p === 'facebook') setChannelRtmpUrl('rtmps://live-api-s.facebook.com:443/rtmp/');
  };

  const handleOpenAddModal = () => {
    setEditingChannel(null);
    setChannelTitle('');
    setChannelDescription('');
    setChannelHandle('');
    setChannelIdField('');
    setChannelStreamKey('');
    setChannelPlatform('youtube');
    setChannelRtmpUrl('rtmps://a.rtmps.youtube.com:443/live2');
    setIsAddChannelOpen(true);
  };

  const handleOpenEditModal = (channel: YouTubeChannelProfile) => {
    setEditingChannel(channel);
    setChannelTitle(channel.title);
    setChannelDescription(channel.description || '');
    setChannelHandle(channel.handle || '');
    setChannelIdField(channel.channelId || '');
    setChannelStreamKey(''); // Keep blank unless updating
    setChannelRtmpUrl(channel.rtmpUrl || 'rtmps://a.rtmps.youtube.com:443/live2');
    setChannelPlatform(channel.rtmpUrl?.includes('facebook') ? 'facebook' : channel.rtmpUrl?.includes('youtube') ? 'youtube' : 'custom');
    setIsAddChannelOpen(true);
  };

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelTitle.trim()) {
      showToast('Please enter your channel name', 'error');
      return;
    }
    if (!editingChannel && !channelStreamKey.trim()) {
      showToast('Please paste your Live Stream Key', 'error');
      return;
    }
    setIsSavingChannel(true);
    try {
      const payload: any = {
        title: channelTitle.trim(),
        description: channelDescription.trim() || undefined,
        handle: channelHandle.trim() || undefined,
        channelId: channelIdField.trim() || undefined,
        rtmpUrl: channelRtmpUrl.trim(),
      };

      if (editingChannel) {
        payload.id = editingChannel.id;
        if (channelStreamKey.trim()) {
          payload.streamKey = channelStreamKey.trim();
        } else {
          payload.streamKey = 'KEEP_EXISTING';
        }
      } else {
        payload.streamKey = channelStreamKey.trim();
        payload.isDefault = savedChannels.length === 0;
      }

      const res = await fetchClient('/api/youtube/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save channel profile');
      }

      await loadSavedChannels();
      setIsAddChannelOpen(false);
      showToast(editingChannel ? `Updated "${channelTitle.trim()}"` : `Added channel: "${channelTitle.trim()}"`, 'success');
    } catch (err: any) {
      showToast(err.message || 'Failed to save channel', 'error');
    } finally {
      setIsSavingChannel(false);
    }
  };

  const handleTestConnection = async (id: string, name: string) => {
    setTestingChannelId(id);
    try {
      const res = await fetchClient(`/api/youtube/channels/${id}/test`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message || `Channel "${name}" credentials verified!`, 'success');
        await loadSavedChannels();
      } else {
        showToast(data.error || `Channel "${name}" verification failed`, 'error');
      }
    } catch {
      showToast('Network error verifying channel credentials', 'error');
    } finally {
      setTestingChannelId(null);
    }
  };

  const handleDeleteChannel = async (id: string, title: string) => {
    if (!confirm(`Are you sure you want to remove channel "${title}"?`)) {
      return;
    }
    try {
      const res = await fetchClient(`/api/youtube/channels/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await loadSavedChannels();
        showToast(`Removed channel "${title}"`, 'info');
      }
    } catch {
      showToast('Failed to delete channel', 'error');
    }
  };

  const handleLaunchForChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeChannelForLaunch || !launchVideo) return;
    setIsLaunchingStream(true);
    try {
      const success = await onStartStream({
        videoFilename: launchVideo,
        rtmpUrl: activeChannelForLaunch.rtmpUrl || 'rtmps://a.rtmps.youtube.com:443/live2',
        streamKey: activeChannelForLaunch.streamKey || '',
        title: launchTitle.trim() || `${activeChannelForLaunch.title} 24/7 Live`,
        loop: true,
        mode: 'copy',
        channelTitle: activeChannelForLaunch.title,
      });
      if (success) {
        setActiveChannelForLaunch(null);
        setLaunchTitle('');
      }
    } finally {
      setIsLaunchingStream(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-[#0F172A] tracking-tight">YouTube Channels Management</h1>
          </div>
          <p className="text-xs text-[#64748B] mt-0.5">
            Manage your personal YouTube channels and RTMP credentials for independent or simultaneous 24/7 live broadcasts.
          </p>
        </div>
        <button
          onClick={handleOpenAddModal}
          className="px-4 py-2.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-semibold flex items-center gap-2 shadow-xs transition-colors self-start sm:self-center cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add YouTube Channel</span>
        </button>
      </div>

      {/* Saved Channels List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider font-mono">
            Configured Channels ({savedChannels.length})
          </h2>
          <span className="text-[11px] text-[#64748B] flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            <span>Private credentials encrypted & masked</span>
          </span>
        </div>

        {savedChannels.length === 0 ? (
          <div className="bg-white border border-dashed border-[#E2E8F0] rounded-2xl p-8 text-center space-y-3">
            <div className="w-10 h-10 mx-auto rounded-xl bg-slate-50 flex items-center justify-center text-slate-400">
              <Key className="w-5 h-5 text-[#2563EB]" />
            </div>
            <h3 className="text-sm font-bold text-[#0F172A]">No YouTube Channels Configured</h3>
            <p className="text-xs text-[#64748B] max-w-sm mx-auto">
              Add your personal YouTube channel stream keys here. You can connect multiple channels to stream different videos simultaneously.
            </p>
            <button
              onClick={handleOpenAddModal}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#2563EB] text-white text-xs font-semibold shadow-xs cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Your First Channel</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {savedChannels.map(channel => {
              const activeForThis = activeStreams.find(
                s => (s.status === 'running' || s.status === 'LIVE') && s.channelTitle === channel.title
              );
              const isYoutube = !channel.rtmpUrl || channel.rtmpUrl.includes('youtube');
              const isTesting = testingChannelId === channel.id;

              return (
                <div
                  key={channel.id}
                  className="bg-white border border-[#E2E8F0] hover:border-slate-300 rounded-2xl p-5 flex flex-col justify-between transition-colors shadow-2xs"
                >
                  <div>
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm shrink-0 ${
                            isYoutube ? 'bg-red-50 text-red-600' : 'bg-[#EFF6FF] text-[#2563EB]'
                          }`}
                        >
                          {isYoutube ? <Youtube className="w-5 h-5" /> : 'RTMP'}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <h3 className="font-bold text-sm text-[#0F172A] truncate">{channel.title}</h3>
                            {channel.isDefault && (
                              <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-mono font-bold">
                                PRIMARY
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-[#64748B] block truncate">
                            {channel.description || channel.handle || (channel.channelId ? `ID: ${channel.channelId}` : 'YouTube Live Destination')}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleTestConnection(channel.id, channel.title)}
                          disabled={isTesting}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer"
                          title="Verify Channel Connection"
                        >
                          <RotateCw className={`w-4 h-4 ${isTesting ? 'animate-spin text-blue-600' : ''}`} />
                        </button>
                        <button
                          onClick={() => handleOpenEditModal(channel)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                          title="Edit Channel Details"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteChannel(channel.id, channel.title)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                          title="Delete Channel"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 space-y-1.5 text-xs font-mono">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 text-[11px]">Stream Key:</span>
                        <span className="font-bold text-[#0F172A]">{channel.maskedStreamKey}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 text-[11px]">Status:</span>
                        <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-600">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{channel.status || 'CONNECTED'}</span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 text-[11px]">Endpoint:</span>
                        <span className="text-slate-600 text-[11px] truncate max-w-[200px]">
                          {channel.rtmpUrl}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                    {activeForThis ? (
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 text-red-600 border border-red-200 text-xs font-mono font-bold">
                          <span className="w-2 h-2 rounded-full bg-red-600 animate-pulse"></span>
                          <span>LIVE BROADCASTING</span>
                        </span>
                        <button
                          onClick={() => onStopStream(activeForThis.id)}
                          className="px-2.5 py-1 rounded-lg bg-red-100 text-red-700 hover:bg-red-200 text-xs font-semibold cursor-pointer"
                        >
                          Stop
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setActiveChannelForLaunch(channel);
                          setLaunchTitle(`${channel.title} 24/7 Live Stream`);
                        }}
                        className="px-3.5 py-1.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-semibold flex items-center gap-1.5 shadow-2xs cursor-pointer"
                      >
                        <Radio className="w-3.5 h-3.5" />
                        <span>Go Live on Channel</span>
                      </button>
                    )}
                    <a
                      href={isYoutube ? 'https://studio.youtube.com/channel/live/livestreaming' : 'https://www.facebook.com/live/producer'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-1.5 rounded-xl border border-[#E2E8F0] text-slate-600 hover:bg-slate-50 text-xs font-medium flex items-center gap-1 transition-colors"
                    >
                      <span>YouTube Studio</span>
                      <ExternalLink className="w-3 h-3 text-slate-400" />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal: Add / Edit Channel */}
      {isAddChannelOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white border border-[#E2E8F0] rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-red-50 text-red-600 flex items-center justify-center font-bold">
                  <Youtube className="w-4 h-4" />
                </div>
                <h3 className="text-base font-bold text-[#0F172A]">
                  {editingChannel ? 'Edit Channel Profile' : 'Add YouTube Channel'}
                </h3>
              </div>
              <button
                onClick={() => setIsAddChannelOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveChannel} className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-[#0F172A] mb-1">
                  Destination Provider
                </label>
                <div className="grid grid-cols-3 gap-2 text-xs font-medium">
                  <button
                    type="button"
                    onClick={() => handlePlatformChange('youtube')}
                    className={`py-1.5 px-2 rounded-xl border text-center transition-colors cursor-pointer ${
                      channelPlatform === 'youtube'
                        ? 'bg-red-50 border-red-300 text-red-700 font-semibold'
                        : 'bg-white border-[#E2E8F0] text-slate-600'
                    }`}
                  >
                    YouTube
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePlatformChange('facebook')}
                    className={`py-1.5 px-2 rounded-xl border text-center transition-colors cursor-pointer ${
                      channelPlatform === 'facebook'
                        ? 'bg-blue-50 border-blue-300 text-blue-700 font-semibold'
                        : 'bg-white border-[#E2E8F0] text-slate-600'
                    }`}
                  >
                    Facebook
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePlatformChange('custom')}
                    className={`py-1.5 px-2 rounded-xl border text-center transition-colors cursor-pointer ${
                      channelPlatform === 'custom'
                        ? 'bg-purple-50 border-purple-300 text-purple-700 font-semibold'
                        : 'bg-white border-[#E2E8F0] text-slate-600'
                    }`}
                  >
                    Custom RTMP
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#0F172A] mb-1">
                  Channel Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Personal Brand Channel, Gaming 24/7"
                  value={channelTitle}
                  onChange={e => setChannelTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white text-xs text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#0F172A] mb-1">Channel Handle</label>
                  <input
                    type="text"
                    placeholder="@mychannel"
                    value={channelHandle}
                    onChange={e => setChannelHandle(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white text-xs text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#0F172A] mb-1">Channel ID (Optional)</label>
                  <input
                    type="text"
                    placeholder="UC..."
                    value={channelIdField}
                    onChange={e => setChannelIdField(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white text-xs text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#0F172A] mb-1">
                  Stream Key {editingChannel ? '(Leave empty to keep existing)' : <span className="text-red-500">*</span>}
                </label>
                <input
                  type="password"
                  required={!editingChannel}
                  placeholder={editingChannel ? '•••••••••••• (Unchanged)' : 'Paste your live stream key'}
                  value={channelStreamKey}
                  onChange={e => setChannelStreamKey(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white text-xs font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[#0F172A] mb-1">
                  RTMP Ingest Server URL
                </label>
                <input
                  type="text"
                  value={channelRtmpUrl}
                  onChange={e => setChannelRtmpUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white text-xs font-mono text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                />
              </div>

              <div className="pt-3 border-t border-[#E2E8F0] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddChannelOpen(false)}
                  className="px-4 py-2 rounded-xl border border-[#E2E8F0] text-xs font-semibold text-slate-700 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingChannel}
                  className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  {isSavingChannel && <RotateCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{editingChannel ? 'Save Changes' : 'Save Channel'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Quick Launch for Specific Channel */}
      {activeChannelForLaunch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white border border-[#E2E8F0] rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
              <div className="flex items-center gap-2">
                <Radio className="w-4 h-4 text-[#2563EB]" />
                <h3 className="text-base font-bold text-[#0F172A]">
                  Go Live on {activeChannelForLaunch.title}
                </h3>
              </div>
              <button
                onClick={() => setActiveChannelForLaunch(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleLaunchForChannel} className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-[#0F172A] mb-1">Select Video Asset</label>
                <select
                  value={launchVideo}
                  onChange={e => setLaunchVideo(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white text-xs text-[#0F172A]"
                >
                  {videos.map(v => (
                    <option key={v.filename} value={v.filename}>
                      {v.displayName} ({v.sizeFormatted})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#0F172A] mb-1">Broadcast Title</label>
                <input
                  type="text"
                  placeholder="e.g. 24/7 Live Stream Session"
                  value={launchTitle}
                  onChange={e => setLaunchTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-[#E2E8F0] bg-white text-xs text-[#0F172A]"
                />
              </div>

              <div className="pt-3 border-t border-[#E2E8F0] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setActiveChannelForLaunch(null)}
                  className="px-4 py-2 rounded-xl border border-[#E2E8F0] text-xs font-semibold text-slate-700 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isLaunchingStream}
                  className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  {isLaunchingStream && <RotateCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>Start Live Broadcast</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
