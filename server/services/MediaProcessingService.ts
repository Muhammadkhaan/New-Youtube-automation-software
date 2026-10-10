import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { db } from '../db';
import { MediaAsset, MediaProcessingStatus } from '../db/schema';
import { MediaAnalyzer } from '../supervisor/MediaAnalyzer';
import { resolveFfmpegPath, resolveFfprobePath } from '../utils/ffmpegPaths';

const ROOT_DIR = process.cwd();
const UPLOADS_DIR = path.resolve(ROOT_DIR, 'uploads');
const THUMBNAILS_DIR = path.resolve(UPLOADS_DIR, '.thumbnails');

if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true, mode: 0o700 });
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0 || isNaN(seconds)) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export class MediaProcessingService {
  private static processingQueue = new Set<string>();

  // Generates video thumbnail safely without blocking valid media
  public static async generateThumbnail(videoPath: string, assetId: string): Promise<string | undefined> {
    try {
      const ffmpegBin = resolveFfmpegPath() || 'ffmpeg';
      const thumbFilename = `thumb_${assetId}.jpg`;
      const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);

      if (!fs.existsSync(videoPath)) return undefined;

      const args = [
        '-ss', '00:00:01',
        '-i', videoPath,
        '-vframes', '1',
        '-q:v', '2',
        '-vf', 'scale=640:-1',
        '-y', thumbPath,
      ];

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegBin, args, { stdio: 'ignore' });
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          resolve(); // don't reject on timeout, thumbnail is optional
        }, 8000);

        proc.on('close', code => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(thumbPath)) {
            resolve();
          } else {
            resolve(); // optional failure
          }
        });

        proc.on('error', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      if (fs.existsSync(thumbPath)) {
        return `/uploads/.thumbnails/${thumbFilename}`;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // Deletes thumbnail file associated with media asset
  public static removeThumbnail(assetId: string): void {
    try {
      const thumbPath = path.join(THUMBNAILS_DIR, `thumb_${assetId}.jpg`);
      if (fs.existsSync(thumbPath)) {
        fs.unlinkSync(thumbPath);
      }
    } catch {}
  }

  // Processes a media file on disk: probe metadata, analyze compatibility, generate thumbnail, and update state to 'ready'
  public static async processMediaAsset(assetId: string, filePath: string): Promise<MediaAsset | null> {
    if (this.processingQueue.has(assetId)) {
      console.log(`[MediaProcessing] Asset ${assetId} already undergoing processing. Skipping duplicate.`);
      return db.getMediaAssetById(assetId) || null;
    }

    this.processingQueue.add(assetId);

    try {
      const existing = db.getMediaAssetById(assetId);
      if (!existing) {
        console.warn(`[MediaProcessing] Asset ${assetId} not found in database.`);
        return null;
      }

      existing.status = 'processing';
      db.saveMediaAsset(existing);

      if (!fs.existsSync(filePath)) {
        existing.status = 'missing';
        existing.isLiveReady = false;
        existing.validationError = 'Target media file does not exist on disk';
        db.saveMediaAsset(existing);
        return existing;
      }

      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        existing.status = 'invalid';
        existing.isLiveReady = false;
        existing.validationError = 'Media file is empty (0 bytes)';
        db.saveMediaAsset(existing);
        return existing;
      }

      // Deep probe metadata via MediaAnalyzer
      const comp = await MediaAnalyzer.analyze(filePath);

      if (!comp.videoCodec && comp.reasons.some(r => r.includes('No video stream') || r.includes('Analysis error'))) {
        existing.status = 'invalid';
        existing.isLiveReady = false;
        existing.validationError = comp.reasons.join('; ');
        db.saveMediaAsset(existing);
        return existing;
      }

      // Generate thumbnail
      let thumbnailUrl = existing.thumbnailUrl;
      if (!thumbnailUrl) {
        thumbnailUrl = await this.generateThumbnail(filePath, assetId);
      }

      const durationSec = comp.durationSeconds || existing.durationSeconds || 0;
      const resStr = comp.width && comp.height ? `${comp.width}x${comp.height}` : existing.resolution || 'Unknown';

      existing.sizeBytes = stat.size;
      existing.sizeFormatted = formatBytes(stat.size);
      existing.durationSeconds = durationSec;
      existing.durationFormatted = formatDuration(durationSec);
      existing.resolution = resStr;
      existing.videoCodec = comp.videoCodec || existing.videoCodec || 'h264';
      existing.audioCodec = comp.audioCodec || existing.audioCodec;
      existing.hasAudio = !!(comp.audioCodec || comp.audioChannels);
      existing.compatibility = comp;
      existing.thumbnailUrl = thumbnailUrl;
      existing.status = 'ready';
      existing.isLiveReady = true;
      existing.validationError = undefined;
      existing.updatedAt = new Date().toISOString();

      db.saveMediaAsset(existing);
      console.log(`[MediaProcessing] Successfully processed and marked READY: "${existing.displayName}" (${existing.id})`);
      return existing;
    } catch (err: any) {
      console.error(`[MediaProcessing] Error processing asset ${assetId}:`, err);
      const existing = db.getMediaAssetById(assetId);
      if (existing) {
        existing.status = 'failed';
        existing.isLiveReady = false;
        existing.validationError = err.message || 'Processing failed';
        db.saveMediaAsset(existing);
      }
      return existing || null;
    } finally {
      this.processingQueue.delete(assetId);
    }
  }

  // Reconciles incomplete or stuck processing assets on server boot
  public static async reconcileOnStartup(): Promise<void> {
    console.log('[MediaProcessing] Reconciling media library assets on startup...');
    const assets = db.getMediaAssets();

    for (const asset of assets) {
      const fullPath = path.join(UPLOADS_DIR, asset.filename);

      if (!fs.existsSync(fullPath)) {
        if (asset.status !== 'missing') {
          asset.status = 'missing';
          asset.isLiveReady = false;
          asset.validationError = 'Media file not found on storage volume';
          db.saveMediaAsset(asset);
        }
        continue;
      }

      if (asset.status === 'processing' || asset.status === 'uploading') {
        console.log(`[MediaProcessing] Reconciling interrupted asset "${asset.displayName}" (${asset.id})...`);
        await this.processMediaAsset(asset.id, fullPath);
      } else if (asset.status === 'ready' && !asset.thumbnailUrl) {
        // Opportunistically generate thumbnail if missing
        this.generateThumbnail(fullPath, asset.id).then(tUrl => {
          if (tUrl) {
            asset.thumbnailUrl = tUrl;
            db.saveMediaAsset(asset);
          }
        }).catch(() => {});
      }
    }
  }
}
