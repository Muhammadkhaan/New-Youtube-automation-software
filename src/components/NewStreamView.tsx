import React, { useState, useRef, useEffect } from 'react';
import {
  Upload,
  Radio,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  FileVideo,
  ExternalLink,
  Plus,
  Play,
  RotateCw,
  Link as LinkIcon,
  X,
  Share2,
  Trash2,
} from 'lucide-react';
import { VideoFile, UploadProgressInfo, YouTubeChannelProfile } from '../types';

interface NewStreamViewProps {
  videos: VideoFile[];
  preselectedVideoFilename?: string | null;
  onStartStream: (params: {
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
  }) => Promise<boolean>;
  onStartBatchStreams?: (streams: {
    videoFilename: string;
    rtmpUrl: string;
    streamKey: string;
    title: string;
    loop: boolean;
    mode: 'copy' | 'transcode_1080p' | 'transcode_720p';
    channelTitle?: string;
  }[]) => Promise<boolean>;
  onUploadFile: (file: File) => Promise<string | null>;
  onGenerateTestVideo: () => Promise<string | null>;
  onOpenYouTubeGuide: () => void;
  onPreviewVideo: (video: VideoFile) => void;
  isStarting: boolean;
  uploadProgress: number | null;
  uploadInfo?: UploadProgressInfo | null;
  onCancelUpload?: () => void;
  onImportVideoUrl?: (url: string, filename?: string) => Promise<string | null>;
}

export const NewStreamView: React.FC<NewStreamViewProps> = ({
  videos,
  preselectedVideoFilename,
  onStartStream,
  onUploadFile,
  onGenerateTestVideo,
  onOpenYouTubeGuide,
  onPreviewVideo,
  isStarting,
  uploadProgress,
  uploadInfo,
  onCancelUpload,
  onImportVideoUrl,
}) => {
  const [streamMode, setStreamMode] = useState<'standard' | 'simulcast'>('standard');
  const [selectedVideo, setSelectedVideo] = useState<string>(preselectedVideoFilename || videos[0]?.filename || '');
  const [streamTitle, setStreamTitle] = useState<string>('');
  const [rtmpUrl, setRtmpUrl] = useState<string>('rtmps://a.rtmps.youtube.com:443/live2');
  const [streamKey, setStreamKey] = useState<string>('');
  const [showStreamKey, setShowStreamKey] = useState<boolean>(false);
  const [loopContinuously, setLoopContinuously] = useState<boolean>(true);
  const [encodingMode, setEncodingMode] = useState<'copy' | 'transcode_1080p' | 'transcode_720p'>('copy');
  const [retryPolicy, setRetryPolicy] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isGeneratingTest, setIsGeneratingTest] = useState(false);

  // Multi-destination simulcast list
  const [simulcastDestinations, setSimulcastDestinations] = useState<
    { id: string; name: string; rtmpUrl: string; streamKey: string }[]
  >([
    { id: '1', name: 'Primary YouTube Channel', rtmpUrl: 'rtmps://a.rtmps.youtube.com:443/live2', streamKey: '' },
    { id: '2', name: 'Second Channel / Backup Key', rtmpUrl: 'rtmps://a.rtmps.youtube.com:443/live2', streamKey: '' },
  ]);

  // Saved channels list
  const [savedChannels, setSavedChannels] = useState<YouTubeChannelProfile[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>('');

  // URL Import Modal state
  const [showUrlImport, setShowUrlImport] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importFilename, setImportFilename] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  // Drag and drop state
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDraftLoadedRef = useRef(false);

  // Load saved channels
  const loadChannels = () => {
    fetch('/api/youtube/channels')
      .then(res => res.json())
      .then(data => {
        if (data.channels && Array.isArray(data.channels)) {
          setSavedChannels(data.channels);
          const def = data.channels.find((c: YouTubeChannelProfile) => c.isDefault) || data.channels[0];
          if (def) {
            setSelectedChannelId(def.id);
            if (!streamKey) {
              setStreamKey(def.streamKey || '');
              if (def.rtmpUrl) setRtmpUrl(def.rtmpUrl);
            }
          }
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadChannels();
    // Restore draft
    fetch('/api/draft')
      .then(res => res.json())
      .then(data => {
        isDraftLoadedRef.current = true;
        if (data.draft) {
          if (data.draft.selectedVideo) setSelectedVideo(data.draft.selectedVideo);
          if (data.draft.streamTitle) setStreamTitle(data.draft.streamTitle);
          if (data.draft.rtmpUrl) setRtmpUrl(prev => prev || data.draft.rtmpUrl);
          if (data.draft.streamKey) setStreamKey(prev => prev || data.draft.streamKey);
          if (data.draft.loopContinuously !== undefined) setLoopContinuously(data.draft.loopContinuously);
          if (data.draft.encodingMode) setEncodingMode(data.draft.encodingMode);
          if (data.draft.retryPolicy !== undefined) setRetryPolicy(data.draft.retryPolicy);
          if (data.draft.streamMode) setStreamMode(data.draft.streamMode);
        }
      })
      .catch(() => {
        isDraftLoadedRef.current = true;
      });
  }, []);

  const saveDraft = (overrides: Record<string, any> = {}) => {
    const draft = {
      selectedVideo: overrides.selectedVideo !== undefined ? overrides.selectedVideo : selectedVideo,
      streamTitle: overrides.streamTitle !== undefined ? overrides.streamTitle : streamTitle,
      rtmpUrl: overrides.rtmpUrl !== undefined ? overrides.rtmpUrl : rtmpUrl,
      streamKey: overrides.streamKey !== undefined ? overrides.streamKey : streamKey,
      loopContinuously: overrides.loopContinuously !== undefined ? overrides.loopContinuously : loopContinuously,
      encodingMode: overrides.encodingMode !== undefined ? overrides.encodingMode : encodingMode,
      retryPolicy: overrides.retryPolicy !== undefined ? overrides.retryPolicy : retryPolicy,
      streamMode: overrides.streamMode !== undefined ? overrides.streamMode : streamMode,
    };
    fetch('/api/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }).catch(() => {});
  };

  useEffect(() => {
    if (preselectedVideoFilename) {
      setSelectedVideo(preselectedVideoFilename);
      const found = videos.find(v => v.filename === preselectedVideoFilename);
      if (found) {
        const title = found.displayName.replace(/\.[^/.]+$/, '');
        setStreamTitle(title);
        saveDraft({ selectedVideo: preselectedVideoFilename, streamTitle: title });
      }
    }
  }, [preselectedVideoFilename, videos]);

  useEffect(() => {
    if (!isDraftLoadedRef.current) return;
    if (videos.length === 0) return;
    const currentValid = selectedVideo && videos.some(v => v.filename === selectedVideo);
    if (!currentValid) {
      const topVideo = videos[0];
      setSelectedVideo(topVideo.filename);
      if (!streamTitle || streamTitle === '24/7 Live Stream') {
        const title = topVideo.displayName.replace(/\.[^/.]+$/, '');
        setStreamTitle(title);
        saveDraft({ selectedVideo: topVideo.filename, streamTitle: title });
      }
    }
  }, [videos, selectedVideo, streamTitle]);

  const handleSelectVideo = (filename: string, displayName: string) => {
    setSelectedVideo(filename);
    const newTitle =
      !streamTitle || streamTitle === '24/7 Live Stream'
        ? displayName.replace(/\.[^/.]+$/, '')
        : streamTitle;
    setStreamTitle(newTitle);
    saveDraft({ selectedVideo: filename, streamTitle: newTitle });
  };

  const handleSelectChannelProfile = (channel: YouTubeChannelProfile) => {
    setSelectedChannelId(channel.id);
    if (channel.streamKey) {
      setStreamKey(channel.streamKey);
    }
    if (channel.rtmpUrl) {
      setRtmpUrl(channel.rtmpUrl);
    }
  };

  const processFile = async (file: File) => {
    setErrorMsg(null);
    try {
      const uploadedFilename = await onUploadFile(file);
      if (uploadedFilename) {
        const title = file.name.replace(/\.[^/.]+$/, '');
        setSelectedVideo(uploadedFilename);
        setStreamTitle(title);
        saveDraft({ selectedVideo: uploadedFilename, streamTitle: title });
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'File upload encountered an error');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await processFile(file);
    e.target.value = '';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      await processFile(files[0]);
    }
  };

  const handleGenerateTestPattern = async () => {
    try {
      setIsGeneratingTest(true);
      setErrorMsg(null);
      const filename = await onGenerateTestVideo();
      if (filename) {
        setSelectedVideo(filename);
        setStreamTitle('1080p Broadcast Color Bars Test');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to generate test pattern');
    } finally {
      setIsGeneratingTest(false);
    }
  };

  const handleUrlImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importUrl.trim()) return;
    if (!onImportVideoUrl) {
      setErrorMsg('URL import not supported');
      return;
    }
    setIsImporting(true);
    try {
      const filename = await onImportVideoUrl(importUrl.trim(), importFilename.trim() || undefined);
      if (filename) {
        setSelectedVideo(filename);
        setStreamTitle(importFilename.trim() || 'Imported Cloud Video');
        setShowUrlImport(false);
        setImportUrl('');
        setImportFilename('');
      }
    } finally {
      setIsImporting(false);
    }
  };

  const addSimulcastDestination = () => {
    setSimulcastDestinations(prev => [
      ...prev,
      {
        id: Date.now().toString(),
        name: `Channel Destination ${prev.length + 1}`,
        rtmpUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
        streamKey: '',
      },
    ]);
  };

  const removeSimulcastDestination = (id: string) => {
    if (simulcastDestinations.length <= 1) return;
    setSimulcastDestinations(prev => prev.filter(d => d.id !== id));
  };

  const updateSimulcastDestination = (id: string, field: 'name' | 'rtmpUrl' | 'streamKey', val: string) => {
    setSimulcastDestinations(prev =>
      prev.map(d => (d.id === id ? { ...d, [field]: val } : d))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!selectedVideo) {
      setErrorMsg('Please select a video file from your saved library.');
      return;
    }

    const titleToUse = streamTitle.trim() || '24/7 CloudCast Broadcast';
    const activeChannel = savedChannels.find(c => c.id === selectedChannelId);

    if (streamMode === 'simulcast') {
      const valid = simulcastDestinations.filter(d => d.streamKey.trim());
      if (valid.length === 0) {
        setErrorMsg('Please enter at least one valid stream key for simulcast.');
        return;
      }
      for (const d of valid) {
        if (d.streamKey.trim().startsWith('http') || d.streamKey.trim().startsWith('rtmp')) {
          setErrorMsg(`Destination "${d.name}" has a URL pasted in the Secret Stream Key field. In YouTube Studio, copy the secret Stream Key string, not the Server URL.`);
          return;
        }
      }

      await onStartStream({
        videoFilename: selectedVideo,
        rtmpUrl: valid[0].rtmpUrl,
        streamKey: valid[0].streamKey,
        title: titleToUse,
        loop: loopContinuously,
        mode: encodingMode,
        retryPolicy,
        retryDelaySeconds: 30,
        destinations: valid.map(d => ({ rtmpUrl: d.rtmpUrl, streamKey: d.streamKey, name: d.name })),
        channelTitle: `Simulcast (${valid.length} channels)`,
      });
      return;
    }

    if (!streamKey.trim()) {
      setErrorMsg('YouTube Live Stream Key is required.');
      return;
    }
    if (streamKey.trim().startsWith('http') || streamKey.trim().startsWith('rtmp')) {
      setErrorMsg('You pasted a URL into the Secret Stream Key input. In YouTube Studio, the Stream Key is the secret password string, not the Server URL.');
      return;
    }

    await onStartStream({
      videoFilename: selectedVideo,
      rtmpUrl: rtmpUrl.trim(),
      streamKey: streamKey.trim(),
      title: titleToUse,
      loop: loopContinuously,
      mode: encodingMode,
      retryPolicy,
      retryDelaySeconds: 30,
      channelTitle: activeChannel?.title,
    });
  };

  return (
    <div className="space-y-6">
      {/* View Header with Mode Selector */}
      <div className="pb-4 border-b border-[#E2E8F0] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#0F172A] tracking-tight">Configure Live Broadcast</h1>
          <p className="text-xs text-[#64748B] mt-0.5">
            Pick a stored video asset and start a 24/7 continuous stream to one or multiple destinations simultaneously.
          </p>
        </div>

        {/* Stream Mode Toggle: Single vs Multi-Destination Simulcast */}
        <div className="flex items-center p-1 bg-white border border-[#E2E8F0] rounded-xl text-xs self-start sm:self-center shadow-2xs">
          <button
            type="button"
            onClick={() => {
              setStreamMode('standard');
              saveDraft({ streamMode: 'standard' });
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer ${
              streamMode === 'standard'
                ? 'bg-[#2563EB] text-white font-semibold shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>Single Live Stream</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setStreamMode('simulcast');
              saveDraft({ streamMode: 'simulcast' });
            }}
            className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer ${
              streamMode === 'simulcast'
                ? 'bg-[#2563EB] text-white font-semibold shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>Multi-Channel Simulcast</span>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <div className="flex-1">{errorMsg}</div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Media Asset Selection (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-[#0F172A] tracking-tight">Saved Video Asset</h2>
              <span className="text-[11px] text-[#64748B]">
                Permanently saved on cloud disk • select any file to stream with 0 upload delay.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,.mp4,.mkv,.mov,.avi,.flv,.webm,.ts"
                onClick={e => {
                  (e.currentTarget as HTMLInputElement).value = '';
                }}
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload-input"
              />
              <label
                htmlFor="file-upload-input"
                className="cursor-pointer px-3 py-1.5 rounded-xl bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors border border-[#E2E8F0] shadow-2xs"
                title="Upload video from your computer"
              >
                <Upload className="w-3.5 h-3.5 text-slate-500" />
                <span>Upload PC</span>
              </label>
              <button
                type="button"
                onClick={() => setShowUrlImport(true)}
                className="px-3 py-1.5 rounded-xl bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors border border-[#E2E8F0] shadow-2xs cursor-pointer"
                title="Download directly to server from an external URL"
              >
                <LinkIcon className="w-3.5 h-3.5 text-[#2563EB]" />
                <span>Import URL</span>
              </button>
              <button
                type="button"
                onClick={handleGenerateTestPattern}
                disabled={isGeneratingTest}
                className="px-2.5 py-1.5 rounded-xl bg-white hover:bg-slate-50 text-slate-600 hover:text-slate-900 text-xs font-semibold flex items-center gap-1 transition-colors border border-[#E2E8F0] shadow-2xs cursor-pointer"
                title="Generates a 30-second SMPTE color bars test pattern"
              >
                <Plus className="w-3.5 h-3.5 text-amber-500" />
                <span>{isGeneratingTest ? '...' : 'Test Pattern'}</span>
              </button>
            </div>
          </div>

          {/* Resumable Upload Progress Bar */}
          {uploadProgress !== null && (
            <div className="p-4 bg-white rounded-xl border border-blue-200 text-xs space-y-2.5 shadow-sm">
              <div className="flex items-center justify-between text-slate-800">
                <span className="font-semibold truncate max-w-xs">
                  {uploadInfo?.filename || 'Uploading video...'}
                </span>
                <span className="font-mono text-[#2563EB] font-bold tabular-nums text-sm">
                  {uploadProgress}%
                </span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-[#2563EB] h-2 transition-all duration-150 rounded-full"
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                <span>
                  {uploadInfo?.speedFormatted || 'Streaming chunks'} • {uploadInfo?.etaFormatted || 'Uploading'}
                </span>
                {onCancelUpload && (
                  <button
                    type="button"
                    onClick={onCancelUpload}
                    className="text-red-600 hover:text-red-700 text-xs font-sans font-semibold underline underline-offset-2 cursor-pointer"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Dropzone & Video Asset Gallery */}
          <div
            onDragOver={e => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`transition-all rounded-2xl ${isDragging ? 'ring-2 ring-blue-500 bg-blue-50' : ''}`}
          >
            {videos.length === 0 ? (
              <div className="bg-white border border-dashed border-[#E2E8F0] rounded-2xl p-10 text-center">
                <FileVideo className="w-10 h-10 mx-auto text-slate-400 mb-2" />
                <h3 className="text-sm font-semibold text-[#0F172A]">No Video Files in Storage</h3>
                <p className="text-[#64748B] text-xs max-w-sm mx-auto mt-1 mb-4">
                  Upload your video file (MP4, MKV, MOV) or import from a direct URL. Once saved, it stays on disk for multiple broadcasts.
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-semibold shadow-xs cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Upload Video</span>
                </button>
              </div>
            ) : (
              <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                {videos.map(v => {
                  const isSelected = selectedVideo === v.filename;
                  return (
                    <div
                      key={v.filename}
                      onClick={() => handleSelectVideo(v.filename, v.displayName)}
                      className={`p-3.5 rounded-xl border cursor-pointer transition-all flex items-center justify-between gap-3 ${
                        isSelected
                          ? 'bg-[#EFF6FF] border-[#2563EB] shadow-xs'
                          : 'bg-white border-[#E2E8F0] hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                            isSelected ? 'bg-[#2563EB] text-white' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          <FileVideo className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-xs font-bold text-[#0F172A] truncate" title={v.displayName}>
                              {v.displayName}
                            </p>
                            <span className="text-[10px] text-emerald-700 bg-emerald-50 px-1.5 py-0.2 rounded font-mono shrink-0">
                              Ready
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px] text-[#64748B] font-mono mt-0.5">
                            {v.resolution && <span>{v.resolution}</span>}
                            {v.resolution && <span className="text-slate-300">•</span>}
                            {v.durationFormatted && <span>{v.durationFormatted}</span>}
                            {v.durationFormatted && <span className="text-slate-300">•</span>}
                            <span>{v.sizeFormatted}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            onPreviewVideo(v);
                          }}
                          className="p-1.5 rounded-lg bg-white border border-[#E2E8F0] text-slate-500 hover:text-slate-800 transition-colors"
                          title="Preview video"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                        {isSelected ? (
                          <div className="w-5 h-5 rounded-full bg-[#2563EB] text-white flex items-center justify-center">
                            <Check className="w-3 h-3 stroke-[3]" />
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">
                            Select
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Transmission Settings (5 cols) */}
        <div className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-2xl p-6 space-y-5 shadow-2xs">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-[#0F172A] tracking-tight">
              {streamMode === 'simulcast' ? 'Multi-Channel Simulcast' : 'Live Destination'}
            </h2>
            <button
              type="button"
              onClick={onOpenYouTubeGuide}
              className="text-xs text-slate-500 hover:text-[#2563EB] flex items-center gap-1 transition-colors cursor-pointer"
            >
              <span>How to find Key</span>
              <ExternalLink className="w-3 h-3 text-slate-400" />
            </button>
          </div>

          {/* Quick Saved Channel Selector if available */}
          {savedChannels.length > 0 && streamMode === 'standard' && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Saved Channel Profile
              </label>
              <div className="flex flex-wrap gap-1.5">
                {savedChannels.map(channel => (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() => handleSelectChannelProfile(channel)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors cursor-pointer ${
                      selectedChannelId === channel.id
                        ? 'bg-blue-50 border-blue-300 text-blue-700'
                        : 'bg-white border-[#E2E8F0] text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    <span className="truncate max-w-[140px]">{channel.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Broadcast Title */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Live Broadcast Title
            </label>
            <input
              type="text"
              required
              placeholder="e.g. 24/7 Continuous Live Broadcast"
              value={streamTitle}
              onChange={e => setStreamTitle(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E2E8F0] text-[#0F172A] text-xs focus:outline-none focus:border-[#2563EB] transition-colors"
            />
          </div>

          {/* STREAM MODE: STANDARD SINGLE STREAM */}
          {streamMode === 'standard' && (
            <>
              {/* Stream Key */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-700">
                    YouTube Stream Key
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowStreamKey(!showStreamKey)}
                    className="text-[11px] text-slate-500 hover:text-slate-800 flex items-center gap-1 cursor-pointer"
                  >
                    {showStreamKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3 text-slate-400" />}
                    <span>{showStreamKey ? 'Hide' : 'Show'}</span>
                  </button>
                </div>
                <input
                  type={showStreamKey ? 'text' : 'password'}
                  required
                  placeholder="Paste YouTube Stream Key (e.g. t9q4-twvd-...)"
                  value={streamKey}
                  onChange={e => setStreamKey(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E2E8F0] text-[#0F172A] font-mono text-xs focus:outline-none focus:border-[#2563EB] transition-colors"
                />
              </div>

              {/* RTMP Server URL */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Ingestion Server (RTMPS 443 Recommended)
                </label>
                <input
                  type="text"
                  value={rtmpUrl}
                  onChange={e => setRtmpUrl(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-50 border border-[#E2E8F0] text-slate-600 font-mono text-[11px] focus:outline-none focus:border-[#2563EB]"
                />
              </div>
            </>
          )}

          {/* STREAM MODE: MULTI-CHANNEL SIMULCAST */}
          {streamMode === 'simulcast' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-semibold text-[#0F172A] block">Simulcast Destinations</span>
                  <span className="text-[11px] text-[#64748B]">
                    Streams to multiple YouTube channels/keys at the same time via Tee muxer (zero double-encode penalty).
                  </span>
                </div>
                <button
                  type="button"
                  onClick={addSimulcastDestination}
                  className="px-2 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-[#2563EB] border border-blue-200 text-xs flex items-center gap-1 font-semibold transition-colors cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add Channel</span>
                </button>
              </div>

              <div className="space-y-2.5 max-h-[260px] overflow-y-auto pr-1">
                {simulcastDestinations.map((dest, idx) => (
                  <div
                    key={dest.id}
                    className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-4 h-4 rounded-full bg-[#2563EB] text-white font-mono text-[10px] flex items-center justify-center font-bold">
                          {idx + 1}
                        </span>
                        <input
                          type="text"
                          value={dest.name}
                          onChange={e => updateSimulcastDestination(dest.id, 'name', e.target.value)}
                          placeholder="Channel Name"
                          className="bg-transparent text-[#0F172A] font-semibold text-xs focus:outline-none focus:border-b border-[#2563EB]"
                        />
                      </div>
                      {simulcastDestinations.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeSimulcastDestination(dest.id)}
                          className="text-slate-400 hover:text-red-600 p-1 transition-colors cursor-pointer"
                          title="Remove destination"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <input
                      type="password"
                      value={dest.streamKey}
                      onChange={e => updateSimulcastDestination(dest.id, 'streamKey', e.target.value)}
                      placeholder="Paste YouTube Stream Key for this channel"
                      className="w-full px-3 py-1.5 rounded-lg bg-white border border-[#E2E8F0] text-[#0F172A] font-mono text-xs focus:outline-none focus:border-[#2563EB]"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Transmission Options */}
          <div className="pt-2 border-t border-slate-100 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-[#0F172A] block">Continuous 24/7 Loop</span>
                <span className="text-[11px] text-[#64748B] block">Repeats video seamlessly indefinitely</span>
              </div>
              <input
                type="checkbox"
                checked={loopContinuously}
                onChange={e => setLoopContinuously(e.target.checked)}
                className="w-4 h-4 rounded text-[#2563EB] border-slate-300 focus:ring-0 cursor-pointer"
              />
            </div>

            {/* Retry Policy Toggle */}
            <div className={`p-3.5 rounded-xl border transition-all ${
              retryPolicy ? 'bg-blue-50/60 border-blue-200' : 'bg-slate-50 border-slate-200'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-[#0F172A]">Retry Policy</span>
                  {retryPolicy ? (
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-blue-100 text-[#2563EB] border border-blue-200 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse"></span>
                      <span>30s Auto-Reconnect Delay</span>
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">
                      Disabled
                    </span>
                  )}
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={retryPolicy}
                    onChange={e => {
                      setRetryPolicy(e.target.checked);
                      saveDraft({ retryPolicy: e.target.checked });
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-10 h-5.5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#2563EB]"></div>
                </label>
              </div>
              <p className="text-[11px] text-[#64748B] leading-relaxed mt-1.5">
                {retryPolicy
                  ? 'If this stream enters a "failed" status due to network jitter, RTMP connection drop, or socket timeout, the supervisor automatically triggers a reconnection attempt after a 30-second delay.'
                  : 'Automatic restart is disabled. If the stream encounters network jitter, it will remain in failed status until manually restarted.'}
              </p>
            </div>

            <div>
              <span className="text-xs font-semibold text-[#0F172A] block mb-1.5">Encoding Preset</span>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setEncodingMode('copy')}
                  className={`p-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                    encodingMode === 'copy'
                      ? 'bg-blue-50 border-[#2563EB] text-[#2563EB]'
                      : 'bg-white border-[#E2E8F0] text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span className="font-semibold block text-xs">Stream Copy</span>
                  <span className="text-[10px] text-[#64748B] block">0% CPU, recommended for VPS</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEncodingMode('transcode_1080p')}
                  className={`p-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                    encodingMode === 'transcode_1080p'
                      ? 'bg-blue-50 border-[#2563EB] text-[#2563EB]'
                      : 'bg-white border-[#E2E8F0] text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span className="font-semibold block text-xs">1080p Standard</span>
                  <span className="text-[10px] text-[#64748B] block">Universal compatibility</span>
                </button>
              </div>
            </div>
          </div>

          {/* Submit Button */}
          <div className="pt-3">
            <button
              type="submit"
              disabled={isStarting || !selectedVideo || (streamMode === 'standard' && !streamKey.trim())}
              className={`w-full py-3 px-4 rounded-xl text-white font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-xs transition-colors cursor-pointer disabled:opacity-40 bg-[#2563EB] hover:bg-[#1D4ED8]`}
            >
              {isStarting ? (
                <>
                  <RotateCw className="w-4 h-4 animate-spin" />
                  <span>Launching Cloud Broadcast...</span>
                </>
              ) : streamMode === 'simulcast' ? (
                <>
                  <Share2 className="w-4 h-4" />
                  <span>Launch Simulcast Stream</span>
                </>
              ) : (
                <>
                  <Radio className="w-4 h-4" />
                  <span>Launch 24/7 Broadcast</span>
                </>
              )}
            </button>
          </div>
        </div>
      </form>

      {/* URL Import Modal */}
      {showUrlImport && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-[#E2E8F0] rounded-2xl max-w-md w-full p-6 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <LinkIcon className="w-5 h-5 text-[#2563EB]" />
                <h3 className="text-base font-bold text-[#0F172A] tracking-tight">Direct Cloud URL Import</h3>
              </div>
              <button onClick={() => setShowUrlImport(false)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-[#64748B] mb-4 leading-relaxed">
              Enter a direct HTTP/HTTPS link to any video file. The cloud server will download it directly into storage with built-in SSRF protection and a 4GB quota.
            </p>
            <form onSubmit={handleUrlImportSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Direct Video URL *
                </label>
                <input
                  type="url"
                  required
                  placeholder="https://example.com/video.mp4"
                  value={importUrl}
                  onChange={e => setImportUrl(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E2E8F0] text-[#0F172A] text-xs focus:outline-none focus:border-[#2563EB] font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Save Name (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. stream_video_part1.mp4"
                  value={importFilename}
                  onChange={e => setImportFilename(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#E2E8F0] text-[#0F172A] text-xs focus:outline-none focus:border-[#2563EB]"
                />
              </div>
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowUrlImport(false)}
                  className="px-3.5 py-2 rounded-xl bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium border border-[#E2E8F0] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isImporting || !importUrl.trim()}
                  className="px-4 py-2 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
                >
                  {isImporting ? (
                    <>
                      <RotateCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Downloading to Cloud...</span>
                    </>
                  ) : (
                    <span>Download to Cloud</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
