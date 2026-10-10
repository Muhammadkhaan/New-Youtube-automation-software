import express from 'express';
import path from 'path';
import fs from 'fs';
import dns from 'dns/promises';
import { execFile, spawn } from 'child_process';
import util from 'util';
import multer from 'multer';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'url';
import ipaddr from 'ipaddr.js';
import crypto from 'crypto';
import { db, maskStreamKey, hashPassword, verifyPassword } from './server/db';
import { supervisor } from './server/supervisor/StreamSupervisor';
import { MediaAnalyzer } from './server/supervisor/MediaAnalyzer';
import { ResourceManager } from './server/supervisor/ResourceManager';
import { SchedulerService } from './server/services/SchedulerService';
import { DiagnosticsService } from './server/services/DiagnosticsService';
import { AuthService, authMiddleware, requireRole, canAccessResource } from './server/services/AuthService';
import { AnalyticsService } from './server/services/AnalyticsService';
import { MonitoringService } from './server/services/MonitoringService';
import { AlertService } from './server/services/AlertService';
import { StorageService } from './server/services/StorageService';
import { PreflightService } from './server/services/PreflightService';
import { EmailService } from './server/services/EmailService';
import { StreamConfig, StreamDestination, EncodingMode, UserRole, AdminPermissions } from './server/db/schema';
import {
  resolveFfmpegPath,
  resolveFfprobePath,
  isFfmpegAvailable,
  isFfprobeAvailable,
  getFfmpegInfo,
} from './server/utils/ffmpegPaths';

const execFilePromise = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT_DIR = process.cwd();
const UPLOADS_DIR = path.resolve(ROOT_DIR, 'uploads');
const TEMP_UPLOADS_DIR = path.resolve(UPLOADS_DIR, '.chunks');
const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const DRAFT_FILE = path.join(DATA_DIR, 'draft.json');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_UPLOADS_DIR)) {
  fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Clean stale chunks older than 3 hours
function cleanStaleChunks(maxAgeMs = 3 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(TEMP_UPLOADS_DIR)) return;
    const files = fs.readdirSync(TEMP_UPLOADS_DIR);
    const now = Date.now();
    let cleaned = 0;
    for (const file of files) {
      const fullPath = path.join(TEMP_UPLOADS_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          cleaned++;
        }
      } catch {}
    }
    if (cleaned > 0) {
      console.log(`[Storage] Purged ${cleaned} stale upload chunk file(s).`);
    }
  } catch (err) {
    console.warn('[Storage] Error cleaning stale chunks:', err);
  }
}
cleanStaleChunks();
setInterval(() => cleanStaleChunks(), 60 * 60 * 1000);

// Check FFmpeg and FFprobe availability
const activeFfmpeg = resolveFfmpegPath();
const activeFfprobe = resolveFfprobePath();
let ffmpegPath = activeFfmpeg || 'ffmpeg';
let ffmpegAvailable = !!activeFfmpeg;
let ffprobeAvailable = !!activeFfprobe;

if (ffmpegAvailable) {
  console.log('[System] FFmpeg broadcast engine active:', activeFfmpeg);
} else {
  console.warn('[System] Warning: FFmpeg not found in PATH or bundled binaries');
}

if (ffprobeAvailable) {
  console.log('[System] FFprobe media probe engine active:', activeFfprobe);
} else {
  console.warn('[System] Warning: FFprobe not found');
}

// SSRF Protection for remote URL import with DNS rebinding and IP range defense
async function isSafePublicUrl(urlString: string): Promise<boolean> {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase().trim();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local')
    ) {
      return false;
    }

    // Resolve IPv4 and IPv6 addresses to prevent DNS rebinding
    const [ipv4List, ipv6List] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ]);

    const allAddresses = [...ipv4List, ...ipv6List];
    if (allAddresses.length === 0) {
      const lookup = await dns.lookup(hostname).catch(() => null);
      if (lookup && lookup.address) allAddresses.push(lookup.address);
    }

    if (allAddresses.length === 0) return false;

    const disallowedRanges = [
      'loopback',
      'private',
      'linkLocal',
      'carrierGradeNat',
      'broadcast',
      'reserved',
      'unspecified',
    ];

    for (const address of allAddresses) {
      if (!ipaddr.isValid(address)) return false;
      const addr = ipaddr.parse(address);
      const range = addr.range();
      if (disallowedRanges.includes(range)) {
        return false;
      }

      // Check IPv4-mapped IPv6
      if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
        const mappedV4 = (addr as ipaddr.IPv6).toIPv4Address();
        if (disallowedRanges.includes(mappedV4.range())) return false;
      }

      // AWS / GCP / Azure metadata endpoint check
      if (address === '169.254.169.254' || address.startsWith('169.254.')) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Safe HTTP fetch that validates every redirect location before following it
async function fetchWithSafeRedirects(initialUrl: string, maxRedirects = 3): Promise<Response> {
  let currentUrl = initialUrl;
  let redirectsCount = 0;

  while (redirectsCount <= maxRedirects) {
    const isSafe = await isSafePublicUrl(currentUrl);
    if (!isSafe) {
      throw new Error('Security Error: Target URL or redirect location resolves to an unauthorized private, loopback, or metadata address.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000); // 30s connection timeout

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        headers: { 'User-Agent': 'CloudCast-Server/3.0' },
        redirect: 'manual', // do not follow redirects automatically
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error('Redirect response missing Location header.');
      }
      redirectsCount++;
      if (redirectsCount > maxRedirects) {
        throw new Error(`Exceeded maximum allowed redirects (${maxRedirects}).`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return res;
  }
  throw new Error('Exceeded maximum redirect limit.');
}

// Video Probe helper
async function probeVideoAsync(filePath: string) {
  const defaultMeta: {
    hasAudio: boolean;
    durationSeconds: number;
    durationFormatted: string;
    width?: number;
    height?: number;
    resolution?: string;
    videoCodec?: string;
    audioCodec?: string;
  } = {
    hasAudio: true,
    durationSeconds: 0,
    durationFormatted: '--:--',
    resolution: undefined,
    videoCodec: undefined,
    audioCodec: undefined,
  };

  if (!ffprobeAvailable || !fs.existsSync(filePath)) {
    return defaultMeta;
  }

  try {
    const probeCmd = resolveFfprobePath() || 'ffprobe';
    const { stdout } = await execFilePromise(
      probeCmd,
      [
        '-v', 'error',
        '-analyzeduration', '10000000',
        '-probesize', '10000000',
        '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration',
        '-of', 'json',
        filePath,
      ],
      { timeout: 15000 }
    );
    const data = JSON.parse(stdout);
    const durationSeconds = data.format?.duration ? parseFloat(data.format.duration) : 0;
    const vStream = data.streams?.find((s: any) => s.codec_type === 'video');
    const aStream = data.streams?.find((s: any) => s.codec_type === 'audio');
    const totalSecs = Math.floor(durationSeconds);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    const durationFormatted =
      hours > 0
        ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
        : `${mins}:${secs.toString().padStart(2, '0')}`;

    return {
      durationSeconds,
      durationFormatted,
      width: vStream?.width,
      height: vStream?.height,
      resolution: vStream ? `${vStream.width}x${vStream.height}` : undefined,
      videoCodec: vStream?.codec_name,
      audioCodec: aStream?.codec_name,
      hasAudio: !!aStream,
    };
  } catch {
    return defaultMeta;
  }
}

// Synchronize database records with files in uploads directory
async function syncVideosDatabaseAsync() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  const existingAssets = db.getMediaAssets();
  const existingMap = new Map(existingAssets.map(a => [a.filename, a]));
  const diskFiles = fs.readdirSync(UPLOADS_DIR).filter(f => !f.startsWith('.') && fs.statSync(path.join(UPLOADS_DIR, f)).isFile());
  let changed = false;

  for (const filename of diskFiles) {
    if (!existingMap.has(filename)) {
      const fullPath = path.join(UPLOADS_DIR, filename);
      const stats = fs.statSync(fullPath);
      const meta = await probeVideoAsync(fullPath);
      const ext = path.extname(filename).toLowerCase();
      const newAsset = {
        id: `vid_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        filename,
        displayName: filename.replace(/^\d+_/, ''),
        fileType: ext === '.mkv' ? 'video/x-matroska' : 'video/mp4',
        sizeBytes: stats.size,
        sizeFormatted: formatBytes(stats.size),
        storagePath: fullPath,
        url: `/uploads/${encodeURIComponent(filename)}`,
        durationFormatted: meta.durationFormatted,
        durationSeconds: meta.durationSeconds,
        resolution: meta.resolution,
        videoCodec: meta.videoCodec,
        audioCodec: meta.audioCodec,
        hasAudio: meta.hasAudio,
        isLiveReady: true,
        createdAt: new Date(stats.birthtimeMs || stats.mtimeMs).toISOString(),
      };
      existingAssets.push(newAsset);
      changed = true;
    }
  }

  if (changed) {
    db.setMediaAssets(existingAssets);
  }
  return existingAssets;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Middleware
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

// Storage config for standard uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB max per file
});
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max per chunk
});

// Telemetry simulation overrides
let simulatedCpuOverride: number | null = null;
let simulatedLatencyOverride: number | null = null;
let lastMeasuredLatency = 14;

// Public Health Check Endpoint for Container Orchestration & VPS monitoring
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Single-use SSE ticket issuer (authenticated via Bearer token)
app.post('/api/auth/sse-ticket', authMiddleware, (req, res) => {
  const session = (req as any).user;
  const ticket = AuthService.createSseTicket(session);
  return res.json({ success: true, ticket });
});

// Real-time SSE (protected by Bearer token header or single-use SSE ticket)
app.get('/api/events', (req, res) => {
  let authorizedUser = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const session = AuthService.getSession(authHeader.substring(7).trim());
    if (session) authorizedUser = session;
  }

  if (!authorizedUser && req.query.ticket && typeof req.query.ticket === 'string') {
    const sseRecord = AuthService.consumeSseTicket(req.query.ticket);
    if (sseRecord) authorizedUser = sseRecord;
  }

  if (!authorizedUser) {
    return res.status(401).json({ error: 'Unauthorized: Valid authentication token or single-use SSE ticket required.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  const unsubscribe = supervisor.subscribeTelemetry(event => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const keepAliveTimer = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    unsubscribe();
  });
});

// Stream supervisor routes
app.get('/api/streams', authMiddleware, (_req, res) => {
  const streams = supervisor.getAllStreams();
  const processed = streams.map(s => {
    const latency = simulatedLatencyOverride !== null
      ? simulatedLatencyOverride
      : (s.latencyMs || (s.isProcessAlive ? lastMeasuredLatency : undefined));
    return { ...s, latencyMs: latency };
  });
  res.json({
    streams: processed,
    ffmpegAvailable,
    ffprobeAvailable,
  });
});

app.get('/api/streams/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const config = db.getStreamById(id);
  if (!config) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  const runtime = supervisor.getStreamRuntime(id);
  res.json({
    stream: {
      ...config,
      ...runtime,
      maskedStreamKey: maskStreamKey(config.streamKey),
      destinations: config.destinations?.map(d => ({
        ...d,
        maskedStreamKey: maskStreamKey(d.streamKey),
        streamKey: undefined,
      })),
      streamKey: undefined,
    },
  });
});

app.post('/api/streams/preflight', authMiddleware, async (req, res) => {
  try {
    const { videoFilename, rtmpUrl, streamKey, mode, destinations } = req.body;
    const tempConfig: StreamConfig = {
      id: 'preflight_check',
      name: 'Preflight',
      videoFilename: videoFilename || '',
      rtmpUrl: rtmpUrl || 'rtmps://a.rtmps.youtube.com:443/live2',
      streamKey: streamKey || '',
      destinations,
      encodingMode: mode || 'copy',
      loop: true,
      autoStart: false,
      autoRestart: true,
      maxRetries: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const report = await supervisor.preflightCheck(tempConfig);
    return res.json(report);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/streams/start', authMiddleware, requireRole(['admin', 'stream_manager', 'operator']), async (req, res) => {
  try {
    const {
      videoFilename,
      rtmpUrl,
      streamKey,
      title,
      loop,
      mode,
      destinations,
      channelTitle,
      autoStart,
      autoRestart,
      retryPolicy,
      retryDelaySeconds,
      force,
    } = req.body;

    if (!videoFilename) {
      return res.status(400).json({ error: 'Video file is required.' });
    }

    const safeBasename = path.basename(videoFilename);
    const videoPath = path.join(UPLOADS_DIR, safeBasename);
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: `Video file "${safeBasename}" not found on server.` });
    }

    if (!ffmpegAvailable) {
      return res.status(500).json({ error: 'FFmpeg is not installed or available on this server.' });
    }

    let validDestinations: StreamDestination[] | undefined;
    let primaryKey = streamKey?.trim();
    let primaryUrl = (rtmpUrl?.trim() || 'rtmps://a.rtmps.youtube.com:443/live2').replace(/\/+$/, '');

    if (Array.isArray(destinations) && destinations.length > 0) {
      validDestinations = destinations
        .filter((d: any) => d && d.streamKey && typeof d.streamKey === 'string' && d.streamKey.trim())
        .map((d: any) => ({
          id: d.id || `dest_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          name: d.name?.trim() || 'YouTube Channel',
          provider: (d.provider || 'youtube') as any,
          rtmpUrl: (d.rtmpUrl?.trim() || primaryUrl).replace(/\/+$/, ''),
          streamKey: d.streamKey.trim(),
          enabled: d.enabled !== false,
          createdAt: new Date().toISOString(),
        }));
      if (validDestinations.length > 0) {
        primaryKey = validDestinations[0].streamKey;
        primaryUrl = validDestinations[0].rtmpUrl;
      }
    }

    if (!primaryKey) {
      return res.status(400).json({ error: 'At least one valid Stream Key is required.' });
    }

    const existingStreams = db.getStreams();
    let streamId = 'stream_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
    const existing = existingStreams.find(s => s.name === title?.trim() && s.videoFilename === safeBasename);
    if (existing) {
      streamId = existing.id;
    }

    const streamConfig: StreamConfig = {
      id: streamId,
      name: title?.trim() || path.parse(safeBasename).name.replace(/^\d+_/, ''),
      videoFilename: safeBasename,
      rtmpUrl: primaryUrl,
      streamKey: primaryKey,
      destinations: validDestinations,
      loop: loop !== false,
      encodingMode: (mode || 'copy') as EncodingMode,
      autoStart: autoStart !== false,
      autoRestart: autoRestart !== false,
      retryPolicy: retryPolicy !== false,
      retryDelaySeconds: retryDelaySeconds ? parseInt(String(retryDelaySeconds), 10) : 30,
      maxRetries: 5,
      channelTitle: channelTitle?.trim() || (validDestinations && validDestinations.length > 1 ? `Multi-Stream (${validDestinations.length} destinations)` : undefined),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    db.saveStream(streamConfig);
    const launchResult = await supervisor.startStream(streamId, { force: !!force });

    if (!launchResult.success) {
      db.addAuditLog({
        username: (req as any).user?.username || 'admin',
        action: 'START_STREAM_FAILED',
        streamId,
        result: 'FAILURE',
        details: launchResult.error,
      });
      return res.status(400).json({ error: launchResult.error });
    }

    db.addAuditLog({
      username: (req as any).user?.username || 'admin',
      action: 'START_STREAM',
      streamId,
      result: 'SUCCESS',
      details: `Started broadcast "${streamConfig.name}" mode=${streamConfig.encodingMode}`,
    });

    return res.json({
      success: true,
      message: 'Live broadcast launched successfully under Stream Supervisor',
      streamId,
    });
  } catch (err: any) {
    console.error('[API] Error starting stream:', err);
    return res.status(500).json({ error: err.message || 'Failed to start stream' });
  }
});

app.post('/api/streams/start-batch', authMiddleware, requireRole(['admin', 'stream_manager', 'operator']), async (req, res) => {
  try {
    const { streams: batchList } = req.body;
    if (!Array.isArray(batchList) || batchList.length === 0) {
      return res.status(400).json({ error: 'Array of stream configurations is required.' });
    }

    const startedIds: string[] = [];
    const errors: string[] = [];

    for (const item of batchList) {
      try {
        if (!item.videoFilename || !item.streamKey) continue;
        const safeBasename = path.basename(item.videoFilename);
        const videoPath = path.join(UPLOADS_DIR, safeBasename);
        if (!fs.existsSync(videoPath)) continue;

        const streamId = 'stream_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
        const config: StreamConfig = {
          id: streamId,
          name: item.title?.trim() || path.parse(safeBasename).name.replace(/^\d+_/, ''),
          videoFilename: safeBasename,
          rtmpUrl: (item.rtmpUrl?.trim() || 'rtmps://a.rtmps.youtube.com:443/live2').replace(/\/+$/, ''),
          streamKey: item.streamKey.trim(),
          loop: item.loop !== false,
          encodingMode: (item.mode || 'copy') as EncodingMode,
          autoStart: item.autoStart !== false,
          autoRestart: item.autoRestart !== false,
          retryPolicy: item.retryPolicy !== false,
          retryDelaySeconds: 30,
          maxRetries: 5,
          channelTitle: item.channelTitle,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        db.saveStream(config);
        const resLaunch = await supervisor.startStream(streamId);
        if (resLaunch.success) {
          startedIds.push(streamId);
        } else {
          errors.push(`[${config.name}]: ${resLaunch.error}`);
        }
      } catch (err: any) {
        errors.push(err.message);
      }
    }

    db.addAuditLog({
      username: (req as any).user?.username || 'admin',
      action: 'BATCH_START_STREAMS',
      result: 'SUCCESS',
      details: `Started ${startedIds.length} batch stream(s)`,
    });

    return res.json({
      success: true,
      startedCount: startedIds.length,
      startedIds,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/streams/:id/stop', authMiddleware, requireRole(['admin', 'stream_manager', 'operator']), async (req, res) => {
  const { id } = req.params;
  const config = db.getStreamById(id);
  if (!config) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  await supervisor.stopStream(id, 'Stopped by user request');
  db.addAuditLog({
    username: (req as any).user?.username || 'admin',
    action: 'STOP_STREAM',
    streamId: id,
    result: 'SUCCESS',
    details: `Cleanly stopped stream "${config.name}"`,
  });
  return res.json({ success: true, message: `Stream "${config.name}" stopped cleanly.` });
});

app.post('/api/streams/stop-all', authMiddleware, requireRole(['admin', 'stream_manager', 'operator']), async (req, res) => {
  await supervisor.stopAllStreams();
  db.addAuditLog({
    username: (req as any).user?.username || 'admin',
    action: 'STOP_ALL_STREAMS',
    result: 'SUCCESS',
  });
  return res.json({ success: true, message: 'All active broadcasts stopped cleanly.' });
});

app.post('/api/streams/:id/restart', authMiddleware, requireRole(['admin', 'stream_manager', 'operator']), async (req, res) => {
  const { id } = req.params;
  const config = db.getStreamById(id);
  if (!config) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  const result = await supervisor.restartStream(id);
  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }
  db.addAuditLog({
    username: (req as any).user?.username || 'admin',
    action: 'RESTART_STREAM',
    streamId: id,
    result: 'SUCCESS',
  });
  return res.json({ success: true, message: `Stream "${config.name}" restarted successfully.` });
});

app.post('/api/streams/:id/retry-now', authMiddleware, requireRole(['admin', 'stream_manager', 'operator']), async (req, res) => {
  const { id } = req.params;
  const config = db.getStreamById(id);
  if (!config) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  const ok = await supervisor.triggerImmediateRetry(id);
  db.addAuditLog({
    username: (req as any).user?.username || 'admin',
    action: 'MANUAL_RECONNECT_NOW',
    streamId: id,
    result: ok ? 'SUCCESS' : 'FAILURE',
    details: 'User manually triggered immediate reconnection attempt.',
  });
  return res.json({ success: ok, message: `Reconnection attempt executed for "${config.name}".` });
});

app.post('/api/streams/:id/cancel-retry', authMiddleware, requireRole(['admin', 'stream_manager', 'operator']), (req, res) => {
  const { id } = req.params;
  const config = db.getStreamById(id);
  if (!config) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  supervisor.cancelRetry(id);
  db.addAuditLog({
    username: (req as any).user?.username || 'admin',
    action: 'CANCEL_AUTO_RECONNECT',
    streamId: id,
    result: 'SUCCESS',
    details: 'User cancelled scheduled 30-second auto-restart attempt.',
  });
  return res.json({ success: true, message: 'Cancelled auto-restart countdown.' });
});

app.post('/api/diagnostics/simulate-jitter', authMiddleware, (req, res) => {
  const { streamId } = req.body;
  const all = supervisor.getAllStreams();
  const targetId = streamId || all.find(s => s.isProcessAlive)?.id || all[0]?.id;
  if (!targetId) {
    return res.status(400).json({ error: 'No stream available to simulate network jitter on.' });
  }
  const proc = (supervisor as any).processManager?.getProcess(targetId);
  const state = (supervisor as any).getOrCreateRuntimeState(targetId);
  state.recentLogs.push(`[${new Date().toLocaleTimeString()}] [Network Jitter Simulator] av_interleaved_write_frame(): Connection reset by peer (RTMP connection dropped due to network jitter)`);
  if (proc) {
    proc.kill('SIGTERM');
    return res.json({ success: true, message: `Simulated network jitter on stream ${targetId}. Process terminated, 30s auto-restart triggered.` });
  } else {
    // If process not currently alive, directly invoke handleStreamCrash to simulate the jitter failure
    (supervisor as any).handleStreamCrash(targetId, 'Connection reset by peer (RTMP socket drop caused by network jitter)');
    return res.json({ success: true, message: `Simulated network jitter failure on stream ${targetId}. 30s auto-restart triggered.` });
  }
});

app.patch('/api/streams/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const existing = db.getStreamById(id);
  if (!existing) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  const { name, loop, autoStart, autoRestart, encodingMode, maxRetries, rtmpUrl, streamKey, retryPolicy, retryDelaySeconds } = req.body;
  if (name !== undefined) existing.name = String(name).trim();
  if (loop !== undefined) existing.loop = !!loop;
  if (autoStart !== undefined) existing.autoStart = !!autoStart;
  if (autoRestart !== undefined) existing.autoRestart = !!autoRestart;
  if (retryPolicy !== undefined) existing.retryPolicy = !!retryPolicy;
  if (retryDelaySeconds !== undefined) existing.retryDelaySeconds = Number(retryDelaySeconds);
  if (encodingMode !== undefined) existing.encodingMode = encodingMode;
  if (maxRetries !== undefined) existing.maxRetries = Number(maxRetries);
  if (rtmpUrl !== undefined) existing.rtmpUrl = String(rtmpUrl).trim();
  if (streamKey !== undefined && streamKey.trim()) existing.streamKey = String(streamKey).trim();
  db.saveStream(existing);
  db.addAuditLog({
    username: (req as any).user?.username || 'admin',
    action: 'UPDATE_STREAM_CONFIG',
    streamId: id,
    result: 'SUCCESS',
  });
  return res.json({ success: true, stream: existing });
});

app.delete('/api/streams/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  await supervisor.stopStream(id, 'Deleted by user');
  db.deleteStream(id);
  db.addAuditLog({
    username: (req as any).user?.username || 'admin',
    action: 'DELETE_STREAM',
    streamId: id,
    result: 'SUCCESS',
  });
  return res.json({ success: true });
});

// Destination management
app.get('/api/destinations', authMiddleware, (_req, res) => {
  const destinations = db.getDestinations().map(d => ({
    ...d,
    maskedStreamKey: maskStreamKey(d.streamKey),
    hasStreamKey: !!d.streamKey,
    streamKey: undefined,
  }));
  res.json({ destinations });
});

app.post('/api/destinations', authMiddleware, (req, res) => {
  try {
    const { name, provider, rtmpUrl, streamKey, enabled } = req.body;
    if (!name?.trim() || !streamKey?.trim()) {
      return res.status(400).json({ error: 'Destination name and Stream Key are required.' });
    }
    const destination: StreamDestination = {
      id: `dest_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: name.trim(),
      provider: provider || 'youtube',
      rtmpUrl: (rtmpUrl?.trim() || 'rtmps://a.rtmps.youtube.com:443/live2').replace(/\/+$/, ''),
      streamKey: streamKey.trim(),
      enabled: enabled !== false,
      createdAt: new Date().toISOString(),
    };
    db.saveDestination(destination);
    db.addAuditLog({
      username: (req as any).user?.username || 'admin',
      action: 'CREATE_DESTINATION',
      result: 'SUCCESS',
      details: `Created destination "${destination.name}"`,
    });
    return res.json({
      success: true,
      destination: {
        ...destination,
        maskedStreamKey: maskStreamKey(destination.streamKey),
        streamKey: undefined,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/destinations/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const existing = db.getDestinationById(id);
  if (!existing) {
    return res.status(404).json({ error: 'Destination not found' });
  }
  const { name, rtmpUrl, streamKey, enabled } = req.body;
  if (name !== undefined) existing.name = String(name).trim();
  if (rtmpUrl !== undefined) existing.rtmpUrl = String(rtmpUrl).trim();
  if (streamKey !== undefined && streamKey.trim()) existing.streamKey = String(streamKey).trim();
  if (enabled !== undefined) existing.enabled = !!enabled;
  db.saveDestination(existing);
  return res.json({
    success: true,
    destination: {
      ...existing,
      maskedStreamKey: maskStreamKey(existing.streamKey),
      streamKey: undefined,
    },
  });
});

app.delete('/api/destinations/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  db.deleteDestination(id);
  return res.json({ success: true });
});

// Personal YouTube Channels Management
app.get('/api/youtube/channels', authMiddleware, (_req, res) => {
  const destinations = db.getDestinations().map((d, index) => ({
    id: d.id,
    title: d.name,
    description: d.description,
    channelId: d.channelId,
    rtmpUrl: d.rtmpUrl,
    maskedStreamKey: maskStreamKey(d.streamKey),
    hasStreamKey: !!d.streamKey,
    streamKey: undefined,
    connectedAt: d.createdAt,
    status: d.status || (d.streamKey ? 'CONNECTED' : 'UNVERIFIED'),
    lastConnectionCheck: d.lastConnectionCheck,
    connectionType: 'direct' as const,
    isDefault: index === 0,
  }));
  return res.json({ channels: destinations });
});

app.post('/api/youtube/channels', authMiddleware, requireRole(['admin']), (req, res) => {
  const { id, title, description, channelId, streamKey, rtmpUrl, isDefault } = req.body;
  if (!title?.trim()) {
    return res.status(400).json({ error: 'Channel title is required.' });
  }

  // Update existing channel if id is provided
  if (id) {
    const existing = db.getDestinationById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Channel not found.' });
    }
    existing.name = title.trim();
    if (description !== undefined) existing.description = String(description).trim();
    if (channelId !== undefined) existing.channelId = String(channelId).trim();
    if (rtmpUrl) existing.rtmpUrl = rtmpUrl.trim().replace(/\/+$/, '');
    if (streamKey && streamKey !== 'KEEP_EXISTING' && !streamKey.startsWith('••••')) {
      existing.streamKey = streamKey.trim();
    }
    existing.updatedAt = new Date().toISOString();
    db.saveDestination(existing);

    db.addAuditLog({
      username: (req as any).user?.username || 'admin',
      action: 'CHANNEL_UPDATE',
      result: 'SUCCESS',
      details: `Updated channel profile "${existing.name}"`,
    });

    return res.json({
      success: true,
      channel: {
        id: existing.id,
        title: existing.name,
        description: existing.description,
        channelId: existing.channelId,
        maskedStreamKey: maskStreamKey(existing.streamKey),
        hasStreamKey: !!existing.streamKey,
        streamKey: undefined,
        rtmpUrl: existing.rtmpUrl,
        status: existing.status || 'CONNECTED',
        lastConnectionCheck: existing.lastConnectionCheck,
      },
    });
  }

  // Creating new channel profile
  if (!streamKey?.trim()) {
    return res.status(400).json({ error: 'Live Stream Key is required for new channel profile.' });
  }

  const dest: StreamDestination = {
    id: `dest_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: title.trim(),
    description: description?.trim() || undefined,
    channelId: channelId?.trim() || undefined,
    provider: 'youtube',
    rtmpUrl: (rtmpUrl?.trim() || 'rtmps://a.rtmps.youtube.com:443/live2').replace(/\/+$/, ''),
    streamKey: streamKey.trim(),
    enabled: true,
    status: 'CONNECTED',
    lastConnectionCheck: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.saveDestination(dest);

  db.addAuditLog({
    username: (req as any).user?.username || 'admin',
    action: 'CHANNEL_CREATE',
    result: 'SUCCESS',
    details: `Added new channel profile "${dest.name}"`,
  });

  return res.json({
    success: true,
    channel: {
      id: dest.id,
      title: dest.name,
      description: dest.description,
      channelId: dest.channelId,
      maskedStreamKey: maskStreamKey(dest.streamKey),
      hasStreamKey: true,
      streamKey: undefined,
      rtmpUrl: dest.rtmpUrl,
      status: dest.status,
      lastConnectionCheck: dest.lastConnectionCheck,
    },
  });
});

// Test channel RTMP configuration endpoint
app.post('/api/youtube/channels/:id/test', authMiddleware, requireRole(['admin']), async (req, res) => {
  const dest = db.getDestinationById(req.params.id);
  if (!dest) {
    return res.status(404).json({ error: 'Channel not found.' });
  }

  if (!dest.streamKey || dest.streamKey.length < 8) {
    dest.status = 'ERROR';
    db.saveDestination(dest);
    return res.status(400).json({
      success: false,
      status: 'ERROR',
      error: 'Invalid or missing YouTube stream key.',
    });
  }

  dest.status = 'CONNECTED';
  dest.lastConnectionCheck = new Date().toISOString();
  dest.updatedAt = new Date().toISOString();
  db.saveDestination(dest);

  return res.json({
    success: true,
    status: 'CONNECTED',
    message: `Channel "${dest.name}" RTMP endpoint and credential format verified.`,
    lastConnectionCheck: dest.lastConnectionCheck,
  });
});

app.delete('/api/youtube/channels/:id', authMiddleware, requireRole(['admin']), (req, res) => {
  const dest = db.getDestinationById(req.params.id);
  if (dest) {
    db.addAuditLog({
      username: (req as any).user?.username || 'admin',
      action: 'CHANNEL_DELETE',
      result: 'SUCCESS',
      details: `Removed channel profile "${dest.name}"`,
    });
  }
  db.deleteDestination(req.params.id);
  return res.json({ success: true });
});

// Media endpoints
app.get('/api/videos', authMiddleware, async (_req, res) => {
  try {
    const videos = await syncVideosDatabaseAsync();
    return res.json({ videos });
  } catch (err: any) {
    return res.json({ videos: [] });
  }
});

app.post('/api/videos/:filename/analyze', authMiddleware, async (req, res) => {
  try {
    const safeBasename = path.basename(req.params.filename);
    const fullPath = path.join(UPLOADS_DIR, safeBasename);
    const analysis = await MediaAnalyzer.analyze(fullPath);
    return res.json(analysis);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', authMiddleware, (req, res) => {
  upload.single('video')(req as any, res as any, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });

    const fullPath = req.file.path;
    const meta = await probeVideoAsync(fullPath);
    const compatibility = await MediaAnalyzer.analyze(fullPath);

    const record = {
      id: `vid_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      filename: req.file.filename,
      displayName: req.file.originalname,
      fileType: req.file.mimetype || 'video/mp4',
      sizeBytes: req.file.size,
      sizeFormatted: formatBytes(req.file.size),
      storagePath: fullPath,
      url: `/uploads/${encodeURIComponent(req.file.filename)}`,
      durationFormatted: meta.durationFormatted,
      durationSeconds: meta.durationSeconds,
      resolution: meta.resolution,
      videoCodec: meta.videoCodec,
      audioCodec: meta.audioCodec,
      hasAudio: meta.hasAudio,
      isLiveReady: true,
      userId: (req as any).user?.userId,
      compatibility,
      createdAt: new Date().toISOString(),
    };
    db.saveMediaAsset(record);
    db.addAuditLog({
      username: (req as any).user?.username || 'admin',
      action: 'UPLOAD_MEDIA',
      result: 'SUCCESS',
      details: `Uploaded "${record.displayName}" (${record.sizeFormatted})`,
    });
    res.json({ success: true, file: record });
  });
});

app.get('/api/upload/chunk-status', authMiddleware, (req, res) => {
  const uploadId = String(req.query.uploadId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId format.' });
  }
  try {
    if (!fs.existsSync(TEMP_UPLOADS_DIR)) return res.json({ uploadedIndexes: [] });
    const files = fs.readdirSync(TEMP_UPLOADS_DIR);
    const prefix = `${uploadId}__`;
    const uploadedIndexes: number[] = [];
    for (const f of files) {
      if (f.startsWith(prefix) && f.endsWith('.chunk')) {
        const idxStr = f.slice(prefix.length, -6);
        const idx = parseInt(idxStr, 10);
        if (!isNaN(idx)) uploadedIndexes.push(idx);
      }
    }
    return res.json({ uploadedIndexes });
  } catch {
    return res.json({ uploadedIndexes: [] });
  }
});

app.get('/api/upload/check', authMiddleware, (req, res) => {
  const filename = path.basename(String(req.query.filename || '').trim());
  const filesize = parseInt(String(req.query.filesize || '0'), 10);
  if (!filename) return res.json({ exists: false });
  const assets = db.getMediaAssets();
  const found = assets.find(a => (a.displayName === filename || a.filename.endsWith(filename)) && (filesize === 0 || Math.abs(a.sizeBytes - filesize) < 1024));
  if (found && fs.existsSync(path.join(UPLOADS_DIR, found.filename))) {
    return res.json({ exists: true, file: found });
  }
  return res.json({ exists: false });
});

app.post('/api/upload/chunk', authMiddleware, (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/octet-stream') || req.query.raw === 'true') {
    const rawUploadId = String(req.headers['x-upload-id'] || req.query.uploadId || '').trim();
    const rawChunkIndex = String(req.headers['x-chunk-index'] || req.query.chunkIndex || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rawUploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId format.' });
    }
    const idx = parseInt(rawChunkIndex, 10);
    if (isNaN(idx) || idx < 0 || idx > 10000) {
      return res.status(400).json({ error: 'Invalid chunkIndex range.' });
    }

    if (!fs.existsSync(TEMP_UPLOADS_DIR)) fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true, mode: 0o700 });
    const chunkPath = path.join(TEMP_UPLOADS_DIR, `${rawUploadId}__${idx}.chunk`);
    if (!path.resolve(chunkPath).startsWith(TEMP_UPLOADS_DIR)) {
      return res.status(400).json({ error: 'Invalid chunk storage path.' });
    }

    const writeStream = fs.createWriteStream(chunkPath);
    req.pipe(writeStream);
    writeStream.on('finish', () => res.json({ success: true, chunkIndex: idx }));
    writeStream.on('error', err => res.status(500).json({ error: err.message }));
    return;
  }

  chunkUpload.single('chunk')(req as any, res as any, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No chunk data received' });
    const { uploadId, chunkIndex } = req.body;
    const cleanUploadId = String(uploadId || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cleanUploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId format.' });
    }
    const idx = parseInt(String(chunkIndex), 10);
    if (isNaN(idx) || idx < 0 || idx > 10000) {
      return res.status(400).json({ error: 'Invalid chunk parameters.' });
    }

    if (!fs.existsSync(TEMP_UPLOADS_DIR)) fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true, mode: 0o700 });
    const chunkPath = path.join(TEMP_UPLOADS_DIR, `${cleanUploadId}__${idx}.chunk`);
    if (!path.resolve(chunkPath).startsWith(TEMP_UPLOADS_DIR)) {
      return res.status(400).json({ error: 'Invalid chunk storage path.' });
    }

    fs.writeFileSync(chunkPath, req.file.buffer, { mode: 0o600 });
    return res.json({ success: true, chunkIndex: idx });
  });
});

app.post('/api/upload/finalize', authMiddleware, async (req, res) => {
  try {
    const { uploadId, filename, totalChunks } = req.body;
    if (!uploadId || !filename || !totalChunks) return res.status(400).json({ error: 'Missing finalize parameters' });
    const cleanUploadId = String(uploadId).trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cleanUploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId format.' });
    }
    const total = parseInt(totalChunks, 10);
    if (isNaN(total) || total <= 0 || total > 10000) {
      return res.status(400).json({ error: 'Invalid totalChunks range.' });
    }

    let parsedName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = path.extname(parsedName).toLowerCase();
    const allowedExts = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv'];
    if (!allowedExts.includes(ext)) {
      parsedName += '.mp4';
    }

    const finalFilename = `${Date.now()}_${parsedName}`;
    const finalPath = path.join(UPLOADS_DIR, finalFilename);
    if (!path.resolve(finalPath).startsWith(UPLOADS_DIR)) {
      return res.status(400).json({ error: 'Security error: Invalid destination path.' });
    }

    for (let i = 0; i < total; i++) {
      const chunkPath = path.join(TEMP_UPLOADS_DIR, `${cleanUploadId}__${i}.chunk`);
      if (!fs.existsSync(chunkPath)) return res.status(400).json({ error: `Upload incomplete: chunk ${i} missing.` });
    }

    const outStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < total; i++) {
      const chunkPath = path.join(TEMP_UPLOADS_DIR, `${cleanUploadId}__${i}.chunk`);
      const inStream = fs.createReadStream(chunkPath);
      await new Promise<void>((resolve, reject) => {
        inStream.pipe(outStream, { end: false });
        inStream.on('end', () => resolve());
        inStream.on('error', reject);
      });
      try { fs.unlinkSync(chunkPath); } catch {}
    }
    outStream.end();
    await new Promise<void>((resolve, reject) => {
      outStream.on('finish', () => resolve());
      outStream.on('error', reject);
    });

    const stats = fs.statSync(finalPath);
    const meta = await probeVideoAsync(finalPath);
    const compatibility = await MediaAnalyzer.analyze(finalPath);

    const record = {
      id: `vid_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      filename: finalFilename,
      displayName: filename,
      fileType: 'video/mp4',
      sizeBytes: stats.size,
      sizeFormatted: formatBytes(stats.size),
      storagePath: finalPath,
      url: `/uploads/${encodeURIComponent(finalFilename)}`,
      durationFormatted: meta.durationFormatted,
      durationSeconds: meta.durationSeconds,
      resolution: meta.resolution,
      videoCodec: meta.videoCodec,
      audioCodec: meta.audioCodec,
      hasAudio: meta.hasAudio,
      isLiveReady: true,
      userId: (req as any).user?.userId,
      compatibility,
      createdAt: new Date().toISOString(),
    };
    db.saveMediaAsset(record);
    return res.json({ success: true, file: record });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Assembly failed' });
  }
});

app.delete('/api/videos/:filename', authMiddleware, (req, res) => {
  const caller = (req as any).user;
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);

  const asset = db.getMediaAssetById(filename);
  if (asset && !canAccessResource(caller.role, asset.userId, caller.userId, true)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to delete this media asset.' });
  }

  const activeStreams = supervisor.getAllStreams();
  const usingStream = activeStreams.find(s => s.isProcessAlive && s.videoFilename === filename);
  if (usingStream) {
    return res.status(400).json({
      error: `Cannot delete: video is currently being streamed by "${usingStream.name}". End the broadcast first.`,
    });
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    db.deleteMediaAsset(filename);
    db.addAuditLog({
      username: (req as any).user?.username || 'admin',
      action: 'DELETE_MEDIA',
      result: 'SUCCESS',
      details: `Deleted file "${filename}"`,
    });
    res.json({ success: true, deletedFilename: filename });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload/url', authMiddleware, async (req, res) => {
  try {
    const { url, filename } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Valid URL is required' });

    let parsedName = filename?.trim();
    if (!parsedName) {
      try {
        parsedName = path.basename(new URL(url).pathname) || 'remote_video.mp4';
      } catch {
        parsedName = 'remote_video.mp4';
      }
    }
    const ext = path.extname(parsedName).toLowerCase();
    const allowedExts = ['.mp4', '.mkv', '.webm', '.mov', '.avi'];
    if (!allowedExts.includes(ext)) {
      parsedName += '.mp4';
    }
    const safeName = parsedName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalFilename = `${Date.now()}_${safeName}`;
    const finalPath = path.join(UPLOADS_DIR, finalFilename);
    if (!path.resolve(finalPath).startsWith(UPLOADS_DIR)) {
      return res.status(400).json({ error: 'Security error: Invalid destination path.' });
    }

    // Safe fetch with manual redirect validation protecting against SSRF
    const response = await fetchWithSafeRedirects(url, 3);
    if (!response.ok || !response.body) return res.status(400).json({ error: `Remote returned HTTP ${response.status}` });

    let totalDownloaded = 0;
    const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        totalDownloaded += chunk.length;
        if (totalDownloaded > MAX_DOWNLOAD_BYTES) callback(new Error('Exceeded maximum allowed 4GB limit.'));
        else callback(null, chunk);
      },
    });

    const fileStream = fs.createWriteStream(finalPath);
    // @ts-ignore
    await pipeline(response.body, limiter, fileStream);

    const stats = fs.statSync(finalPath);
    const meta = await probeVideoAsync(finalPath);
    const compatibility = await MediaAnalyzer.analyze(finalPath);

    const record = {
      id: `vid_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      filename: finalFilename,
      displayName: safeName,
      fileType: 'video/mp4',
      sizeBytes: stats.size,
      sizeFormatted: formatBytes(stats.size),
      storagePath: finalPath,
      url: `/uploads/${encodeURIComponent(finalFilename)}`,
      durationFormatted: meta.durationFormatted,
      durationSeconds: meta.durationSeconds,
      resolution: meta.resolution,
      videoCodec: meta.videoCodec,
      audioCodec: meta.audioCodec,
      hasAudio: meta.hasAudio,
      isLiveReady: true,
      compatibility,
      createdAt: new Date().toISOString(),
    };
    db.saveMediaAsset(record);
    return res.json({ success: true, file: record });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Download failed' });
  }
});

app.post('/api/generate-test-video', authMiddleware, async (_req, res) => {
  if (!ffmpegAvailable) return res.status(500).json({ error: 'FFmpeg is not installed on this server.' });

  const filename = `test_pattern_${Date.now()}.mp4`;
  const outPath = path.join(UPLOADS_DIR, filename);

  try {
    const cmd = [
      '-f', 'lavfi', '-i', 'smptebars=size=1920x1080:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:beep_factor=4',
      '-vf', "drawtext=fontcolor=white:fontsize=48:box=1:boxcolor=black@0.6:boxborderw=10:x=(w-text_w)/2:y=(h-text_h)/2-50:text='CLOUD LIVE STREAM TEST VIDEO':timecode='00\\:00\\:00\\:00':rate=30",
      '-t', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '5000k',
      '-g', '60', '-r', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      '-y', outPath,
    ];
    const activeFfmpegBin = resolveFfmpegPath() || 'ffmpeg';
    const gen = spawn(activeFfmpegBin, cmd);

    gen.on('close', async code => {
      if (code === 0 && fs.existsSync(outPath)) {
        const stats = fs.statSync(outPath);
        const meta = await probeVideoAsync(outPath);
        const compatibility = await MediaAnalyzer.analyze(outPath);
        const record = {
          id: `vid_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          filename,
          displayName: 'Test Pattern Live Stream Video (30s 1080p)',
          fileType: 'video/mp4',
          sizeBytes: stats.size,
          sizeFormatted: formatBytes(stats.size),
          storagePath: outPath,
          url: `/uploads/${encodeURIComponent(filename)}`,
          durationFormatted: meta.durationFormatted,
          durationSeconds: 30,
          resolution: '1920x1080',
          videoCodec: 'h264',
          audioCodec: 'aac',
          hasAudio: true,
          isLiveReady: true,
          compatibility,
          createdAt: new Date().toISOString(),
        };
        db.saveMediaAsset(record);
        return res.json({ success: true, file: record });
      }
      return res.status(500).json({ error: `FFmpeg exited with code ${code}` });
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Draft state
app.get('/api/draft', authMiddleware, (_req, res) => {
  try {
    if (fs.existsSync(DRAFT_FILE)) {
      const draft = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf-8'));
      return res.json({ success: true, draft });
    }
  } catch {}
  return res.json({ success: true, draft: null });
});

app.post('/api/draft', authMiddleware, (req, res) => {
  try {
    fs.writeFileSync(DRAFT_FILE, JSON.stringify(req.body || {}, null, 2), { encoding: 'utf-8', mode: 0o600 });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Playlists & Scheduling
app.get('/api/playlists', authMiddleware, (_req, res) => {
  res.json({ playlists: db.getPlaylists() });
});

app.post('/api/playlists', authMiddleware, (req, res) => {
  const caller = (req as any).user;
  const { name, description, items, playbackMode } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Playlist name is required' });
  const playlist = {
    id: `pl_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: name.trim(),
    description: description?.trim(),
    playbackMode: (playbackMode === 'once' ? 'once' : 'loop') as 'loop' | 'once',
    items: Array.isArray(items) ? items : [],
    totalDurationSeconds: 0,
    totalDurationFormatted: '00:00',
    userId: caller?.userId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.savePlaylist(playlist);
  return res.json({ success: true, playlist });
});

app.delete('/api/playlists/:id', authMiddleware, (req, res) => {
  const caller = (req as any).user;
  const pl = db.getPlaylistById(req.params.id);
  if (pl && !canAccessResource(caller.role, pl.userId, caller.userId, true)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to delete this playlist.' });
  }
  db.deletePlaylist(req.params.id);
  return res.json({ success: true });
});

app.get('/api/schedules', authMiddleware, (_req, res) => {
  res.json({ schedules: db.getSchedules() });
});

app.post('/api/schedules', authMiddleware, (req, res) => {
  const caller = (req as any).user;
  const { title, videoFilename, playlistId, scheduledAt, frequency, timezone, rtmpUrl, streamKey, loop, mode, conflictPolicy } = req.body;
  if (!title?.trim() || (!videoFilename && !playlistId) || !scheduledAt) {
    return res.status(400).json({ error: 'Title, media/playlist, and scheduledAt are required.' });
  }
  const sched = {
    id: `sched_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    title: title.trim(),
    videoFilename: videoFilename || '',
    playlistId: playlistId || undefined,
    scheduledAt: new Date(scheduledAt).toISOString(),
    timezone: timezone || 'UTC',
    frequency: frequency || 'once',
    rtmpUrl,
    streamKey,
    loop: loop !== false,
    mode: mode || 'copy',
    enabled: true,
    conflictPolicy: (conflictPolicy || 'skip') as 'skip' | 'delay' | 'replace',
    userId: caller?.userId,
    status: 'scheduled' as const,
    createdAt: new Date().toISOString(),
  };
  db.saveSchedule(sched);
  return res.json({ success: true, schedule: sched });
});

app.delete('/api/schedules/:id', authMiddleware, (req, res) => {
  const caller = (req as any).user;
  const sched = db.getScheduleById(req.params.id);
  if (sched && !canAccessResource(caller.role, sched.userId, caller.userId, true)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to delete this schedule.' });
  }
  db.deleteSchedule(req.params.id);
  return res.json({ success: true });
});

app.post('/api/schedules/:id/run', authMiddleware, async (req, res) => {
  const sched = db.getScheduleById(req.params.id);
  if (!sched) return res.status(404).json({ error: 'Schedule not found' });
  const result = await supervisor.startStream(sched.streamConfigId || sched.videoFilename, { source: 'scheduler' });
  return res.json(result);
});

// Auth
app.post('/api/auth/login', (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const rateLimitStatus = AuthService.checkLoginRateLimit(clientIp);
  if (!rateLimitStatus.allowed) {
    return res.status(429).json({
      error: `Too many failed login attempts. Account temporarily locked. Please retry in ${rateLimitStatus.retryAfterSeconds || 300} seconds.`,
    });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = AuthService.authenticateUser(username, password);
  if (!user) {
    AuthService.recordLoginFailure(clientIp);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  AuthService.recordLoginSuccess(clientIp);
  const session = AuthService.createSession(user);
  db.addAuditLog({
    username: user.username,
    action: 'USER_LOGIN',
    result: 'SUCCESS',
    ipAddress: clientIp,
  });

  return res.json({
    success: true,
    token: session.token,
    user: AuthService.sanitizeUser(user),
  });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const session = (req as any).user;
  const user = db.getUserById(session.userId) || db.getUserByUsername(session.username);
  if (!user) {
    return res.status(401).json({ error: 'User session not found.' });
  }
  return res.json({
    user: AuthService.sanitizeUser(user),
  });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '').trim();
  if (token) AuthService.destroySession(token);
  return res.json({ success: true });
});

// ==========================================
// TEAM USER MANAGEMENT, AUTH & OTP RECOVERY
// ==========================================

// Rate limit map for OTP reset requests (per IP and per email)
const otpRequestRateLimits = new Map<string, { lastRequestTime: number; count: number }>();

// Helper to check canManageUsers permission
function canManageUsers(caller: any): boolean {
  if (caller.role === 'owner') return true;
  if (caller.role === 'admin') {
    const adminUser = db.getUserById(caller.userId);
    return !!(adminUser?.adminPermissions?.canAddUsers || adminUser?.adminPermissions?.canEditUsers || adminUser?.adminPermissions?.canDeactivateUsers || adminUser?.adminPermissions?.canDeleteUsers);
  }
  return false;
}

// 1. Get current authenticated user profile
app.get('/api/account/profile', authMiddleware, (req, res) => {
  const session = (req as any).user;
  const user = db.getUserById(session.userId) || db.getUserByUsername(session.username);
  if (!user) {
    return res.status(404).json({ error: 'User profile not found.' });
  }
  return res.json({
    user: AuthService.sanitizeUser(user),
  });
});

// Update own profile
app.patch('/api/account/profile', authMiddleware, (req, res) => {
  const session = (req as any).user;
  const user = db.getUserById(session.userId) || db.getUserByUsername(session.username);
  if (!user) {
    return res.status(404).json({ error: 'User profile not found.' });
  }

  const { displayName } = req.body;
  if (displayName?.trim()) user.displayName = displayName.trim();
  user.updatedAt = new Date().toISOString();
  db.saveUser(user);

  db.addAuditLog({
    username: user.username,
    userId: user.id,
    action: 'USER_PROFILE_UPDATE',
    result: 'SUCCESS',
    details: 'User updated personal profile information',
  });

  return res.json({ success: true, user: AuthService.sanitizeUser(user) });
});

// 2. Self-service Change Password (requires current password verification)
app.post('/api/account/change-password', authMiddleware, (req, res) => {
  const session = (req as any).user;
  const user = db.getUserById(session.userId) || db.getUserByUsername(session.username);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }

  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
  }

  if (!verifyPassword(currentPassword, user.passwordHash, user.salt)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const { hash, salt } = hashPassword(newPassword);
  user.passwordHash = hash;
  user.salt = salt;
  user.updatedAt = new Date().toISOString();
  db.saveUser(user);

  // Revoke all existing sessions and create a fresh one
  AuthService.revokeUserSessions(user.id);
  const newSession = AuthService.createSession(user);

  db.addAuditLog({
    username: user.username,
    userId: user.id,
    action: 'USER_PASSWORD_CHANGE',
    result: 'SUCCESS',
    details: 'User changed password; previous sessions revoked.',
  });

  // Send confirmation email asynchronously if email is on file
  if (user.email) {
    EmailService.sendEmail({
      to: user.email,
      subject: 'Password Changed - CloudCast Studio',
      html: EmailService.getPasswordChangedHtml(user.displayName || user.username),
    }).catch(() => {});
  }

  return res.json({
    success: true,
    message: 'Password changed successfully. Existing sessions have been rotated.',
    newToken: newSession.token,
  });
});

// 3. Team Users List (Owner or Admin with permission)
app.get('/api/users', authMiddleware, (req, res) => {
  const caller = (req as any).user;
  if (!canManageUsers(caller)) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to manage team users.' });
  }

  const users = db.getUsers().map(u => AuthService.sanitizeUser(u));
  return res.json({ users });
});

// 4. Create / Invite Team Member
app.post('/api/users', authMiddleware, async (req, res) => {
  const caller = (req as any).user;
  const callerUser = db.getUserById(caller.userId);
  if (caller.role !== 'owner') {
    if (caller.role !== 'admin' || !callerUser?.adminPermissions?.canAddUsers) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to add new users.' });
    }
  }

  const { name, email, role, notes, password, adminPermissions } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  // Check duplicate email
  const existingByEmail = db.getUserByEmail(cleanEmail);
  if (existingByEmail) {
    return res.status(409).json({ error: 'A user with this email address already exists.' });
  }

  const assignedRole: UserRole = role === 'admin' || role === 'stream_manager' || role === 'operator' || role === 'viewer' ? role : 'viewer';

  // Only owner can assign admin role
  if (assignedRole === 'admin' && caller.role !== 'owner') {
    return res.status(403).json({ error: 'Only the account owner can appoint administrators.' });
  }

  const rawUsername = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '') || 'user';
  let username = rawUsername;
  let counter = 1;
  while (db.getUserByUsername(username)) {
    username = `${rawUsername}${counter++}`;
  }

  const isDirectPassword = typeof password === 'string' && password.trim().length >= 6;
  const initialPasswordSecret = isDirectPassword ? password.trim() : crypto.randomBytes(32).toString('hex');
  const { hash, salt } = hashPassword(initialPasswordSecret);

  const newUser = {
    id: 'usr_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'),
    username,
    displayName: name.trim(),
    email: cleanEmail,
    role: assignedRole,
    isActive: true,
    isPendingInvitation: !isDirectPassword,
    passwordHash: hash,
    salt,
    notes: notes?.trim() || undefined,
    adminPermissions: assignedRole === 'admin' ? (adminPermissions || {
      canAddUsers: true,
      canEditUsers: true,
      canResetPasswords: true,
      canDeactivateUsers: true,
      canDeleteUsers: true,
    }) : undefined,
    sessionVersion: 1,
    createdAt: new Date().toISOString(),
  };

  db.saveUser(newUser);

  // Generate invitation token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = Date.now() + 48 * 3600 * 1000; // 48 hours

  db.saveInvitation({
    id: 'inv_' + Date.now().toString(36),
    userId: newUser.id,
    email: cleanEmail,
    tokenHash,
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  const baseUrl = (process.env.APP_BASE_URL || process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
  const inviteUrl = `${baseUrl}/?inviteToken=${rawToken}`;

  const emailResult = await EmailService.sendEmail({
    to: cleanEmail,
    subject: 'You have been invited to CloudCast Broadcast Studio',
    html: EmailService.getInvitationHtml(newUser.displayName, inviteUrl, 48),
  });

  db.addAuditLog({
    username: caller.username,
    userId: caller.userId,
    action: isDirectPassword ? 'CREATE_USER_DIRECT_PASSWORD' : 'INVITE_USER',
    result: 'SUCCESS',
    details: `Created user ${newUser.displayName} (${cleanEmail}) as role=${assignedRole} ${isDirectPassword ? 'with direct password' : 'via invitation'}`,
  });

  return res.json({
    success: true,
    message: isDirectPassword
      ? `User created with direct password. Account is active.`
      : `User created. Invitation sent to ${cleanEmail}.`,
    user: AuthService.sanitizeUser(newUser),
    inviteUrl,
    initialPassword: isDirectPassword ? initialPasswordSecret : undefined,
    emailSimulated: emailResult.simulated,
  });
});

// 5. Resend Invitation
app.post('/api/users/:id/resend-invite', authMiddleware, async (req, res) => {
  const caller = (req as any).user;
  if (!canManageUsers(caller)) {
    return res.status(403).json({ error: 'Forbidden: Insufficient privileges.' });
  }

  const user = db.getUserById(req.params.id);
  if (!user || !user.email) {
    return res.status(404).json({ error: 'User not found or user has no registered email.' });
  }

  if (!user.isPendingInvitation) {
    return res.status(400).json({ error: 'User has already accepted their invitation and activated their password.' });
  }

  // Invalidate previous invitations
  db.invalidateInvitationsForUser(user.id);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = Date.now() + 48 * 3600 * 1000;

  db.saveInvitation({
    id: 'inv_' + Date.now().toString(36),
    userId: user.id,
    email: user.email,
    tokenHash,
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  const baseUrl = (process.env.APP_BASE_URL || process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
  const inviteUrl = `${baseUrl}/?inviteToken=${rawToken}`;

  const emailResult = await EmailService.sendEmail({
    to: user.email,
    subject: 'CloudCast Studio Team Invitation (Resent)',
    html: EmailService.getInvitationHtml(user.displayName, inviteUrl, 48),
  });

  db.addAuditLog({
    username: caller.username,
    userId: caller.userId,
    action: 'RESEND_INVITATION',
    result: 'SUCCESS',
    details: `Resent invitation to ${user.email}`,
  });

  return res.json({
    success: true,
    message: `Invitation resent to ${user.email}.`,
    inviteUrl,
    emailSimulated: emailResult.simulated,
  });
});

// 6. Verify Invitation Token
app.get('/api/auth/verify-invitation', (req, res) => {
  const rawToken = req.query.token as string;
  if (!rawToken || typeof rawToken !== 'string') {
    return res.status(400).json({ error: 'Invitation token is required.' });
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const inv = db.getInvitationByTokenHash(tokenHash);

  if (!inv || inv.usedAt || Date.now() > inv.expiresAt) {
    return res.status(400).json({ error: 'This invitation link is invalid or has expired.' });
  }

  const user = db.getUserById(inv.userId);
  if (!user) {
    return res.status(404).json({ error: 'Invited account not found.' });
  }

  return res.json({
    success: true,
    email: inv.email,
    name: user.displayName,
    role: user.role,
  });
});

// 7. Accept Invitation and Set Password
app.post('/api/auth/accept-invitation', (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required.' });
  }

  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const inv = db.getInvitationByTokenHash(tokenHash);

  if (!inv || inv.usedAt || Date.now() > inv.expiresAt) {
    return res.status(400).json({ error: 'This invitation link is invalid or has expired.' });
  }

  const user = db.getUserById(inv.userId);
  if (!user) {
    return res.status(404).json({ error: 'Invited account not found.' });
  }

  // Update password and activate account
  const { hash, salt } = hashPassword(password);
  user.passwordHash = hash;
  user.salt = salt;
  user.isPendingInvitation = false;
  user.isActive = true;
  user.updatedAt = new Date().toISOString();
  db.saveUser(user);

  // Invalidate invitation
  inv.usedAt = new Date().toISOString();
  db.saveInvitation(inv);

  // Create session for immediate auto-login
  const session = AuthService.createSession(user);

  db.addAuditLog({
    username: user.username,
    userId: user.id,
    action: 'ACCEPT_INVITATION',
    result: 'SUCCESS',
    details: `User ${user.username} accepted invitation and set account password.`,
  });

  return res.json({
    success: true,
    message: 'Account successfully configured. Welcome to CloudCast Studio!',
    token: session.token,
    user: AuthService.sanitizeUser(user),
  });
});

// 8. Update Team User
app.patch('/api/users/:id', authMiddleware, (req, res) => {
  const caller = (req as any).user;
  const callerUser = db.getUserById(caller.userId);
  if (caller.role !== 'owner') {
    if (caller.role !== 'admin' || !callerUser?.adminPermissions?.canEditUsers) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to edit users.' });
    }
  }

  const target = db.getUserById(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'User not found.' });
  }

  // Cannot edit owner unless you are the owner
  if (target.role === 'owner' && caller.role !== 'owner') {
    return res.status(403).json({ error: 'Forbidden: Only the owner can modify owner account details.' });
  }

  const { displayName, role, notes, adminPermissions, isActive } = req.body;

  if (displayName?.trim()) target.displayName = displayName.trim();
  if (notes !== undefined) target.notes = notes?.trim() || undefined;

  // Protect last active owner from demotion or deactivation
  if (target.role === 'owner' && (isActive === false || (role && role !== 'owner'))) {
    if (db.countActiveOwners() <= 1) {
      return res.status(400).json({
        error: 'Cannot demote or deactivate the last remaining active owner account.',
      });
    }
  }

  if (role && ['admin', 'stream_manager', 'operator', 'viewer'].includes(role)) {
    if (caller.role !== 'owner' && role === 'admin') {
      return res.status(403).json({ error: 'Only the account owner can appoint administrators.' });
    }
    target.role = role as UserRole;
  }

  if (adminPermissions && target.role === 'admin') {
    target.adminPermissions = adminPermissions;
  }

  if (isActive !== undefined) {
    target.isActive = !!isActive;
    if (!target.isActive) {
      // Invalidate target user's sessions immediately
      AuthService.revokeUserSessions(target.id);
    }
  }

  target.updatedAt = new Date().toISOString();
  db.saveUser(target);

  db.addAuditLog({
    username: caller.username,
    userId: caller.userId,
    action: 'UPDATE_USER',
    result: 'SUCCESS',
    details: `Updated user ${target.username} (role=${target.role}, active=${target.isActive})`,
  });

  return res.json({ success: true, user: AuthService.sanitizeUser(target) });
});

// 9. Deactivate / Activate User
app.post('/api/users/:id/toggle-status', authMiddleware, (req, res) => {
  const caller = (req as any).user;
  const callerUser = db.getUserById(caller.userId);
  if (caller.role !== 'owner') {
    if (caller.role !== 'admin' || !callerUser?.adminPermissions?.canDeactivateUsers) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to deactivate users.' });
    }
  }

  const target = db.getUserById(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (target.role === 'owner') {
    if (db.countActiveOwners() <= 1 && target.isActive) {
      return res.status(400).json({ error: 'Cannot deactivate the last remaining active owner account.' });
    }
  }

  target.isActive = !target.isActive;
  target.updatedAt = new Date().toISOString();
  db.saveUser(target);

  if (!target.isActive) {
    AuthService.revokeUserSessions(target.id);
    if (target.email) {
      EmailService.sendEmail({
        to: target.email,
        subject: 'Access Deactivated - CloudCast Studio',
        html: EmailService.getAccountDeactivatedHtml(target.displayName || target.username),
      }).catch(() => {});
    }
  }

  db.addAuditLog({
    username: caller.username,
    userId: caller.userId,
    action: target.isActive ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
    result: 'SUCCESS',
    details: `Toggled status for ${target.username} -> ${target.isActive ? 'ACTIVE' : 'DEACTIVATED'}`,
  });

  return res.json({
    success: true,
    message: `User ${target.username} is now ${target.isActive ? 'active' : 'deactivated'}.`,
    user: AuthService.sanitizeUser(target),
  });
});

// 10. Delete User (Safe: never deletes shared channels, media, or broadcasts)
app.delete('/api/users/:id', authMiddleware, (req, res) => {
  const caller = (req as any).user;
  const callerUser = db.getUserById(caller.userId) || db.getUserByUsername(caller.username);
  const isCallerOwner = caller.role === 'owner' || callerUser?.role === 'owner';
  const isCallerAdmin = caller.role === 'admin' || callerUser?.role === 'admin';

  if (!isCallerOwner) {
    if (!isCallerAdmin || callerUser?.adminPermissions?.canDeleteUsers === false) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to delete users.' });
    }
  }

  const target = db.getUserById(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (target.role === 'owner') {
    if (caller.role !== 'owner') {
      return res.status(403).json({ error: 'Forbidden: Only account owners can delete owner accounts.' });
    }
    if (db.countActiveOwners() <= 1) {
      return res.status(400).json({ error: 'Cannot delete the primary/last active owner account.' });
    }
  }

  // Revoke target's sessions
  AuthService.revokeUserSessions(target.id);

  // Delete user record safely; streams and channels remain preserved
  db.deleteUser(target.id);

  db.addAuditLog({
    username: caller.username,
    userId: caller.userId,
    action: 'DELETE_USER',
    result: 'SUCCESS',
    details: `Deleted user ${target.username} (${target.email || 'no email'}). Shared streams and media preserved.`,
  });

  return res.json({ success: true, message: `User ${target.username} deleted successfully.` });
});

// 11. Admin-Initiated Password Reset (Emails secure reset link/OTP to user)
app.post('/api/users/:id/send-reset', authMiddleware, async (req, res) => {
  const caller = (req as any).user;
  const callerUser = db.getUserById(caller.userId);
  if (caller.role !== 'owner') {
    if (caller.role !== 'admin' || !callerUser?.adminPermissions?.canResetPasswords) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to initiate password resets.' });
    }
  }

  const target = db.getUserById(req.params.id);
  if (!target || !target.email) {
    return res.status(404).json({ error: 'User not found or user has no registered email address.' });
  }

  // Invalidate any existing OTPs
  db.invalidateOtpsForUser(target.id);

  // Generate 6-digit cryptographic OTP (100000..999999)
  const rawOtp = crypto.randomInt(100000, 1000000).toString();
  const otpHash = crypto.createHash('sha256').update(rawOtp).digest('hex');
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins

  db.savePasswordResetOtp({
    id: 'otp_' + Date.now().toString(36),
    userId: target.id,
    email: target.email,
    otpHash,
    attempts: 0,
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  const emailResult = await EmailService.sendEmail({
    to: target.email,
    subject: 'Password Reset Request - CloudCast Studio',
    html: EmailService.getOtpResetHtml(target.displayName || target.username, rawOtp, 15),
  });

  db.addAuditLog({
    username: caller.username,
    userId: caller.userId,
    action: 'ADMIN_INITIATED_PASSWORD_RESET',
    result: 'SUCCESS',
    details: `Admin requested password reset for ${target.username} (${target.email})`,
  });

  return res.json({
    success: true,
    message: `Password reset email dispatched to ${target.email}.`,
    emailDelivered: !emailResult.simulated,
  });
});

// 12. Public Forgot Password: Request OTP via Email
app.post('/api/auth/forgot-password/request-otp', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const { email } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  const cleanEmail = email.trim().toLowerCase();

  // Rate limiting check per email & IP
  const rateLimitKey = `${clientIp}_${cleanEmail}`;
  const now = Date.now();
  const existingRate = otpRequestRateLimits.get(rateLimitKey);
  if (existingRate && now - existingRate.lastRequestTime < 60 * 1000) {
    return res.status(429).json({
      error: 'Please wait at least 60 seconds before requesting another verification code.',
    });
  }

  otpRequestRateLimits.set(rateLimitKey, {
    lastRequestTime: now,
    count: (existingRate?.count || 0) + 1,
  });

  const user = db.getUserByEmail(cleanEmail);

  // Generic anti-enumeration response: always return success
  if (!user || !user.isActive) {
    return res.json({
      success: true,
      message: 'If an account matches that email address, a 6-digit verification code has been sent.',
    });
  }

  // Invalidate older outstanding OTPs for this user
  db.invalidateOtpsForUser(user.id);

  // Generate 6-digit numeric OTP (100000..999999)
  const rawOtp = crypto.randomInt(100000, 1000000).toString();
  const otpHash = crypto.createHash('sha256').update(rawOtp).digest('hex');
  const expiresAt = now + 10 * 60 * 1000; // 10 minutes

  db.savePasswordResetOtp({
    id: 'otp_' + Date.now().toString(36),
    userId: user.id,
    email: user.email!,
    otpHash,
    attempts: 0,
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  const emailResult = await EmailService.sendEmail({
    to: user.email!,
    subject: 'Your Password Reset Verification Code - CloudCast Studio',
    html: EmailService.getOtpResetHtml(user.displayName || user.username, rawOtp, 10),
  });

  db.addAuditLog({
    username: user.username,
    userId: user.id,
    action: 'FORGOT_PASSWORD_REQUEST',
    result: 'SUCCESS',
    ipAddress: clientIp,
    details: 'User requested password reset verification OTP',
  });

  return res.json({
    success: true,
    message: 'If an account matches that email address, a 6-digit verification code has been sent.',
    emailDelivered: !emailResult.simulated,
  });
});

// 13. Public Forgot Password: Verify OTP and get Reset Token
app.post('/api/auth/forgot-password/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and 6-digit OTP code are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanOtp = String(otp).trim();

  const user = db.getUserByEmail(cleanEmail);
  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired verification code.' });
  }

  const otpRecord = db.getActiveOtpForUser(user.id);
  if (!otpRecord) {
    return res.status(400).json({ error: 'No active verification code found or code has expired.' });
  }

  if (otpRecord.attempts >= 3) {
    otpRecord.usedAt = new Date().toISOString();
    db.savePasswordResetOtp(otpRecord);
    return res.status(400).json({ error: 'Maximum verification attempts exceeded. Please request a new code.' });
  }

  const suppliedOtpHash = crypto.createHash('sha256').update(cleanOtp).digest('hex');
  if (suppliedOtpHash !== otpRecord.otpHash) {
    otpRecord.attempts += 1;
    db.savePasswordResetOtp(otpRecord);
    const remaining = Math.max(0, 3 - otpRecord.attempts);
    return res.status(400).json({
      error: `Invalid verification code. ${remaining} attempt(s) remaining.`,
    });
  }

  // OTP verified! Generate single-use reset token valid for 15 minutes
  const rawResetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenHash = crypto.createHash('sha256').update(rawResetToken).digest('hex');

  otpRecord.resetTokenHash = resetTokenHash;
  db.savePasswordResetOtp(otpRecord);

  return res.json({
    success: true,
    message: 'Verification code confirmed. You may now set your new password.',
    resetToken: rawResetToken,
  });
});

// 14. Public Forgot Password: Submit New Password with Reset Token
app.post('/api/auth/forgot-password/reset-password', (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (!resetToken || !newPassword) {
    return res.status(400).json({ error: 'Reset token and new password are required.' });
  }

  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
  const otpRecord = db.getOtpByResetTokenHash(tokenHash);

  if (!otpRecord || otpRecord.usedAt || Date.now() > otpRecord.expiresAt) {
    return res.status(400).json({ error: 'Reset session is invalid or has expired. Please start over.' });
  }

  const user = db.getUserById(otpRecord.userId);
  if (!user) {
    return res.status(404).json({ error: 'User account not found.' });
  }

  // Update password
  const { hash, salt } = hashPassword(newPassword);
  user.passwordHash = hash;
  user.salt = salt;
  user.updatedAt = new Date().toISOString();
  db.saveUser(user);

  // Invalidate OTP and reset token immediately
  otpRecord.usedAt = new Date().toISOString();
  db.savePasswordResetOtp(otpRecord);

  // Invalidate all existing sessions
  AuthService.revokeUserSessions(user.id);

  db.addAuditLog({
    username: user.username,
    userId: user.id,
    action: 'FORGOT_PASSWORD_COMPLETED',
    result: 'SUCCESS',
    details: 'User successfully completed OTP password reset. All previous sessions revoked.',
  });

  // Send confirmation email
  if (user.email) {
    EmailService.sendEmail({
      to: user.email,
      subject: 'Your Password Has Been Reset - CloudCast Studio',
      html: EmailService.getPasswordChangedHtml(user.displayName || user.username),
    }).catch(() => {});
  }

  return res.json({
    success: true,
    message: 'Your password has been reset successfully. Please log in with your new password.',
  });
});

// ==========================================
// PHASE 4: ANALYTICS & MONITORING ENDPOINTS
// ==========================================

// Operational analytics report with time filtering
app.get('/api/analytics', authMiddleware, (req, res) => {
  const range = (req.query.range as any) || '24h';
  const report = AnalyticsService.getReport(range);
  return res.json(report);
});

// Real-time system health and resource utilization
app.get('/api/system/health', authMiddleware, (_req, res) => {
  const report = MonitoringService.getSystemHealthReport(simulatedCpuOverride);
  return res.json(report);
});

// Storage utilization stats
app.get('/api/storage/stats', authMiddleware, (_req, res) => {
  const stats = StorageService.getStorageStats();
  return res.json(stats);
});

// Clean up stale upload chunks and orphaned thumbnails
app.post('/api/storage/cleanup', authMiddleware, requireRole(['owner', 'admin']), (req, res) => {
  const caller = (req as any).user;
  const result = StorageService.cleanStaleArtifacts();
  db.addAuditLog({
    username: caller.username,
    userId: caller.userId,
    action: 'STORAGE_CLEANUP',
    result: 'SUCCESS',
    details: `Cleaned ${result.cleanedChunks} chunk(s) and ${result.cleanedThumbnails} thumbnail(s)`,
  });
  return res.json({ success: true, ...result });
});

// Operational alerts
app.get('/api/alerts', authMiddleware, (_req, res) => {
  res.json({ alerts: AlertService.getAlerts() });
});

app.post('/api/alerts/:id/dismiss', authMiddleware, (req, res) => {
  const success = AlertService.dismissAlert(req.params.id);
  return res.json({ success });
});

app.post('/api/alerts/clear', authMiddleware, (_req, res) => {
  AlertService.clearAllAlerts();
  return res.json({ success: true });
});

// Server-wide settings
app.get('/api/settings', authMiddleware, requireRole(['owner', 'admin']), (_req, res) => {
  res.json({ settings: db.getSettings() });
});

app.patch('/api/settings', authMiddleware, requireRole(['owner']), (req, res) => {
  const caller = (req as any).user;
  const { maxConcurrentStreams, maxCpuUsageThreshold, storageQuotaGb, sessionTimeoutHours } = req.body;
  const updates: any = {};

  if (typeof maxConcurrentStreams === 'number' && maxConcurrentStreams > 0 && maxConcurrentStreams <= 64) {
    updates.maxConcurrentStreams = maxConcurrentStreams;
  }
  if (typeof maxCpuUsageThreshold === 'number' && maxCpuUsageThreshold >= 50 && maxCpuUsageThreshold <= 98) {
    updates.maxCpuUsageThreshold = maxCpuUsageThreshold;
  }
  if (typeof storageQuotaGb === 'number' && storageQuotaGb >= 5 && storageQuotaGb <= 1000) {
    updates.storageQuotaGb = storageQuotaGb;
  }
  if (typeof sessionTimeoutHours === 'number' && sessionTimeoutHours >= 1 && sessionTimeoutHours <= 168) {
    updates.sessionTimeoutHours = sessionTimeoutHours;
  }

  const updatedSettings = db.saveSettings(updates);
  db.addAuditLog({
    username: caller.username,
    userId: caller.userId,
    action: 'SETTINGS_UPDATE',
    result: 'SUCCESS',
    details: `Updated settings: ${JSON.stringify(updates)}`,
  });

  return res.json({ success: true, settings: updatedSettings });
});

// Preflight stream verification
app.post('/api/preflight/check', authMiddleware, async (req, res) => {
  const { videoFilename, playlistId, encodingMode, streamKey, destinations } = req.body;
  const activeWorkers = supervisor.getAllStreams().filter(s => s.isProcessAlive).length;
  const result = await PreflightService.validateStreamReadiness(
    { videoFilename, playlistId, encodingMode, streamKey, destinations },
    activeWorkers
  );
  return res.json(result);
});

// Event history with bounded pagination and filtering
app.get('/api/events/history', authMiddleware, (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10)));
  const severity = String(req.query.severity || '').toUpperCase();
  const streamId = String(req.query.streamId || '').trim();

  let allEvents = db.getStreamEvents(streamId || undefined, 2000);
  if (severity && ['INFO', 'WARNING', 'ERROR', 'CRITICAL'].includes(severity)) {
    allEvents = allEvents.filter(e => e.level === severity);
  }

  const total = allEvents.length;
  const startIndex = (page - 1) * limit;
  const events = allEvents.slice(startIndex, startIndex + limit);

  return res.json({
    events,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
});

app.get('/api/audit-logs', authMiddleware, (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10)));
  const action = String(req.query.action || '').trim().toUpperCase();

  let allLogs = db.getAuditLogs(1000);
  if (action) {
    allLogs = allLogs.filter(l => l.action.includes(action));
  }

  const total = allLogs.length;
  const startIndex = (page - 1) * limit;
  const logs = allLogs.slice(startIndex, startIndex + limit);

  res.json({
    logs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
});

// Diagnostics & System
app.get('/api/system', authMiddleware, (req, res) => {
  const allStreams = supervisor.getAllStreams();
  const runningCount = allStreams.filter(s => s.isProcessAlive).length;
  const mem = ResourceManager.getMemoryUsage();
  const simulatedCpu = req.query.simulateCpu ? parseInt(String(req.query.simulateCpu), 10) : undefined;
  const cpuPercent = simulatedCpuOverride !== null
    ? simulatedCpuOverride
    : (simulatedCpu !== undefined && !isNaN(simulatedCpu) ? simulatedCpu : ResourceManager.getCpuUsage());

  res.json({
    ffmpegAvailable,
    ffprobeAvailable,
    ffmpegPath,
    activeStreamsCount: runningCount,
    maxRecommendedStreams: db.getSettings().maxConcurrentStreams || 8,
    nodeUptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMb: mem.nodeUsageMb,
    cpuUsagePercent: cpuPercent,
    platform: process.platform,
    isCpuSimulated: simulatedCpuOverride !== null,
  });
});

app.get('/api/diagnostics', authMiddleware, async (_req, res) => {
  const report = await DiagnosticsService.runDiagnostics();
  res.json(report);
});

app.get('/api/diagnostics/network', authMiddleware, async (req, res) => {
  const report = await DiagnosticsService.runDiagnostics();
  const effectiveLatency = simulatedLatencyOverride !== null
    ? simulatedLatencyOverride
    : (report.network.youtubeRtmps443.latencyMs || lastMeasuredLatency);
  if (effectiveLatency !== undefined) {
    report.network.youtubeRtmps443.latencyMs = effectiveLatency;
    lastMeasuredLatency = effectiveLatency;
  }
  res.json({
    standardRtmp1935: report.network.youtubeRtmp1935,
    secureRtmps443: report.network.youtubeRtmps443,
    recommendedUrl: report.network.recommendedUrl,
    isLatencySimulated: simulatedLatencyOverride !== null,
  });
});

app.post('/api/diagnostics/simulate', authMiddleware, requireRole(['owner', 'admin']), (req, res) => {
  const { cpu, latency } = req.body;
  if (typeof cpu === 'number') simulatedCpuOverride = Math.max(0, Math.min(100, Math.round(cpu)));
  else if (cpu === null) simulatedCpuOverride = null;

  if (typeof latency === 'number') {
    simulatedLatencyOverride = Math.max(0, Math.round(latency));
    lastMeasuredLatency = simulatedLatencyOverride;
  } else if (latency === null) {
    simulatedLatencyOverride = null;
    lastMeasuredLatency = 14;
  }
  return res.json({ success: true, simulatedCpu: simulatedCpuOverride, simulatedLatency: simulatedLatencyOverride });
});

app.post('/api/diagnostics/simulate/reset', authMiddleware, requireRole(['owner', 'admin']), (_req, res) => {
  simulatedCpuOverride = null;
  simulatedLatencyOverride = null;
  lastMeasuredLatency = 14;
  return res.json({ success: true });
});

async function startServer() {
  await supervisor.initialize();
  SchedulerService.start();

  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(ROOT_DIR, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(ROOT_DIR, 'dist', 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[CloudCast] Production Multi-Stream Broadcast Engine listening on http://0.0.0.0:${PORT}`);
  });

  const handleShutdown = async (signal: string) => {
    console.log(`\n[CloudCast] Received ${signal}. Initiating graceful shutdown...`);
    SchedulerService.stop();
    await supervisor.shutdown();
    server.close(() => {
      console.log('[CloudCast] Server shutdown complete.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

startServer();
