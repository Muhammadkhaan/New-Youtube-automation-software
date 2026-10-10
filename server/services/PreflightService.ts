import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { StreamConfig, EncodingMode } from '../db/schema';
import { MediaAnalyzer } from '../supervisor/MediaAnalyzer';
import { ResourceManager } from '../supervisor/ResourceManager';
import { resolveFfmpegPath, resolveFfprobePath } from '../utils/ffmpegPaths';

const ROOT_DIR = process.cwd();
const UPLOADS_DIR = path.resolve(ROOT_DIR, 'uploads');

export interface PreflightItemCheck {
  name: string;
  passed: boolean;
  message: string;
  details?: string;
  level?: 'info' | 'warning' | 'error';
}

export interface ComprehensivePreflightResult {
  ready: boolean;
  checks: PreflightItemCheck[];
  blockingErrors: string[];
  warnings: string[];
  recommendations: string[];
  compatibilityMode: 'STREAM_COPY' | 'TRANSCODE_REQUIRED';
}

export class PreflightService {
  public static async validateStreamReadiness(
    streamConfig: Partial<StreamConfig> & { videoFilename?: string; playlistId?: string; encodingMode?: EncodingMode },
    activeStreamWorkersCount: number
  ): Promise<ComprehensivePreflightResult> {
    const checks: PreflightItemCheck[] = [];
    const blockingErrors: string[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];
    let compatibilityRecommendation: 'STREAM_COPY' | 'TRANSCODE_REQUIRED' = 'STREAM_COPY';

    // 1. FFmpeg & FFprobe Binary Verification
    const ffmpegPath = resolveFfmpegPath();
    const ffprobePath = resolveFfprobePath();

    checks.push({
      name: 'Broadcast Engine Binaries',
      passed: !!ffmpegPath,
      message: ffmpegPath ? 'FFmpeg binary verified and ready.' : 'FFmpeg binary not found on host.',
      level: ffmpegPath ? 'info' : 'error',
    });
    if (!ffmpegPath) {
      blockingErrors.push('FFmpeg binary is missing on this server.');
    }

    // 2. Destination and Stream Key verification
    const hasSingleKey = !!(streamConfig.streamKey?.trim());
    const hasDestinations = !!(streamConfig.destinations && streamConfig.destinations.length > 0 && streamConfig.destinations.some(d => d.enabled !== false && d.streamKey?.trim()));

    if (hasSingleKey || hasDestinations) {
      checks.push({
        name: 'Destination Configuration',
        passed: true,
        message: hasDestinations
          ? `Multi-destination broadcast configured (${streamConfig.destinations!.filter(d => d.enabled !== false).length} target(s)).`
          : 'Destination RTMP endpoint and stream key verified.',
        level: 'info',
      });
    } else {
      checks.push({
        name: 'Destination Configuration',
        passed: false,
        message: 'No active broadcast destinations or stream keys configured.',
        level: 'error',
      });
      blockingErrors.push('No broadcast destinations or stream keys provided.');
      recommendations.push('Configure at least one RTMP destination and stream key before going live.');
    }

    // 3. Media or Playlist Asset verification
    if (streamConfig.playlistId) {
      // Validate playlist
      const playlist = db.getPlaylistById(streamConfig.playlistId);
      if (!playlist) {
        checks.push({
          name: 'Playlist Verification',
          passed: false,
          message: `Playlist "${streamConfig.playlistId}" not found in database.`,
          level: 'error',
        });
        blockingErrors.push(`Referenced playlist "${streamConfig.playlistId}" does not exist.`);
      } else if (playlist.items.length === 0) {
        checks.push({
          name: 'Playlist Verification',
          passed: false,
          message: `Playlist "${playlist.name}" contains 0 media clips.`,
          level: 'error',
        });
        blockingErrors.push(`Playlist "${playlist.name}" is empty. Add at least one video.`);
      } else {
        let missingItems = 0;
        let unreadyItems = 0;

        for (const item of playlist.items) {
          const itemPath = path.join(UPLOADS_DIR, path.basename(item.filename));
          const asset = db.getMediaAssetById(item.mediaAssetId) || db.getMediaAssetById(item.filename);

          if (!fs.existsSync(itemPath)) {
            missingItems++;
          } else if (asset && asset.status !== 'ready') {
            unreadyItems++;
          }
        }

        if (missingItems > 0 || unreadyItems > 0) {
          checks.push({
            name: 'Playlist Verification',
            passed: false,
            message: `Playlist "${playlist.name}" has issues: ${missingItems} clip(s) missing on disk, ${unreadyItems} not ready.`,
            level: 'error',
          });
          blockingErrors.push(`Playlist "${playlist.name}" contains missing or unready media assets.`);
        } else {
          checks.push({
            name: 'Playlist Verification',
            passed: true,
            message: `Playlist "${playlist.name}" verified with ${playlist.items.length} clips (${playlist.totalDurationFormatted || 'continuous'}).`,
            level: 'info',
          });
        }
      }
    } else if (streamConfig.videoFilename) {
      // Validate single media file
      const safeBasename = path.basename(streamConfig.videoFilename);
      const filePath = path.join(UPLOADS_DIR, safeBasename);
      const fileExists = fs.existsSync(filePath);

      checks.push({
        name: 'Media Asset On Disk',
        passed: fileExists,
        message: fileExists ? `File "${safeBasename}" is verified on disk.` : `Media file "${safeBasename}" was not found.`,
        level: fileExists ? 'info' : 'error',
      });

      if (!fileExists) {
        blockingErrors.push(`Media file "${safeBasename}" is missing from storage.`);
        recommendations.push('Upload the video file to the Media Library before starting.');
      } else {
        // Find asset in DB
        const asset = db.getMediaAssetById(streamConfig.mediaAssetId || safeBasename);
        const assetStatus = asset?.status || (asset?.isLiveReady !== false ? 'ready' : 'invalid');
        if (asset && assetStatus !== 'ready') {
          checks.push({
            name: 'Asset Lifecycle Status',
            passed: false,
            message: `Media status is "${assetStatus.toUpperCase()}" (must be READY to broadcast).`,
            level: 'error',
          });
          blockingErrors.push(`Media is currently ${assetStatus}: ${asset.validationError || 'not ready for broadcasting'}`);
        }

        // Deep probe analysis
        const comp = await MediaAnalyzer.analyze(filePath);
        compatibilityRecommendation = comp.recommendation;

        const isCopyMode = (streamConfig.encodingMode || 'copy') === 'copy';
        if (isCopyMode && !comp.compatibleForCopy) {
          checks.push({
            name: 'Encoding Compatibility',
            passed: true,
            message: `Stream Copy selected, but file requires transcoding: ${comp.reasons.join(', ')}`,
            level: 'warning',
            details: 'We recommend switching to Transcode 1080p or 720p preset for broadcast stability.',
          });
          warnings.push(`File is not optimal for stream copy (${comp.reasons.join(', ')}).`);
          recommendations.push('Switch to Transcode 1080p or 720p preset to ensure YouTube Live acceptance.');
        } else {
          checks.push({
            name: 'Encoding Compatibility',
            passed: true,
            message: isCopyMode ? 'Compatible for direct Stream Copy.' : `Transcode preset "${streamConfig.encodingMode}" will be applied.`,
            level: 'info',
          });
        }

        if (!comp.audioCodec && !comp.audioChannels) {
          warnings.push('Video has no audio track. CloudCast will automatically synthesize silent stereo audio.');
          checks.push({
            name: 'Audio Presence',
            passed: true,
            message: 'No audio track found in source. Silent stereo audio will be synthesized.',
            level: 'warning',
          });
        }
      }
    } else {
      checks.push({
        name: 'Media Selection',
        passed: false,
        message: 'No video asset or playlist specified.',
        level: 'error',
      });
      blockingErrors.push('No video file or playlist selected for broadcast.');
    }

    // 4. Server Resource Capacity Check
    const settings = db.getSettings();
    const maxStreams = settings.maxConcurrentStreams || 8;
    const capacity = ResourceManager.checkCapacity(streamConfig.encodingMode || 'copy', activeStreamWorkersCount);

    if (activeStreamWorkersCount >= maxStreams) {
      checks.push({
        name: 'Server Broadcast Capacity',
        passed: false,
        message: `Maximum stream limit reached: ${activeStreamWorkersCount}/${maxStreams} active.`,
        level: 'error',
      });
      blockingErrors.push(`Server reached concurrency limit (${activeStreamWorkersCount}/${maxStreams} streams running).`);
      recommendations.push('Stop an existing stream before launching a new broadcast.');
    } else {
      checks.push({
        name: 'Server Broadcast Capacity',
        passed: capacity.sufficient,
        message: capacity.sufficient
          ? `Server capacity sufficient: CPU ${capacity.currentCpuPercent}%, active streams: ${activeStreamWorkersCount}/${maxStreams}`
          : capacity.warningMessage || 'CPU or worker threshold approaching limit.',
        level: capacity.sufficient ? 'info' : 'warning',
      });
      if (!capacity.sufficient && capacity.warningMessage) {
        warnings.push(capacity.warningMessage);
      }
    }

    return {
      ready: blockingErrors.length === 0,
      checks,
      blockingErrors,
      warnings,
      recommendations,
      compatibilityMode: compatibilityRecommendation,
    };
  }
}
