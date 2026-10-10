import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { formatBytes } from './MediaProcessingService';

const ROOT_DIR = process.cwd();
const UPLOADS_DIR = path.resolve(ROOT_DIR, 'uploads');
const TEMP_UPLOADS_DIR = path.resolve(UPLOADS_DIR, '.chunks');
const THUMBNAILS_DIR = path.resolve(UPLOADS_DIR, '.thumbnails');

export interface StorageStatsSummary {
  totalCapacityBytes: number;
  totalCapacityFormatted: string;
  usedBytes: number;
  usedFormatted: string;
  availableBytes: number;
  availableFormatted: string;
  mediaCount: number;
  chunksBytes: number;
  thumbnailsBytes: number;
  percentUsed: number;
  isQuotaExceeded: boolean;
}

export class StorageService {
  // Returns real directory size in bytes (ignoring symlinks for safety)
  private static getDirectorySizeBytes(dirPath: string): number {
    try {
      if (!fs.existsSync(dirPath)) return 0;
      let total = 0;
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        try {
          const lstat = fs.lstatSync(fullPath);
          if (lstat.isFile() && !lstat.isSymbolicLink()) {
            total += lstat.size;
          }
        } catch {}
      }
      return total;
    } catch {
      return 0;
    }
  }

  // Returns comprehensive storage statistics
  public static getStorageStats(): StorageStatsSummary {
    const settings = db.getSettings();
    const quotaGb = settings.storageQuotaGb || 50;
    const totalCapacityBytes = quotaGb * 1024 * 1024 * 1024;

    const mediaBytes = this.getDirectorySizeBytes(UPLOADS_DIR);
    const chunksBytes = this.getDirectorySizeBytes(TEMP_UPLOADS_DIR);
    const thumbnailsBytes = this.getDirectorySizeBytes(THUMBNAILS_DIR);

    const usedBytes = mediaBytes + chunksBytes + thumbnailsBytes;
    const availableBytes = Math.max(0, totalCapacityBytes - usedBytes);
    const percentUsed = Math.min(100, Math.round((usedBytes / totalCapacityBytes) * 100));

    const mediaCount = db.getMediaAssets().length;

    return {
      totalCapacityBytes,
      totalCapacityFormatted: `${quotaGb} GB`,
      usedBytes,
      usedFormatted: formatBytes(usedBytes),
      availableBytes,
      availableFormatted: formatBytes(availableBytes),
      mediaCount,
      chunksBytes,
      thumbnailsBytes,
      percentUsed,
      isQuotaExceeded: usedBytes >= totalCapacityBytes,
    };
  }

  // Enforces that incoming file size does not exceed quota
  public static checkQuotaAvailable(incomingSizeBytes: number): { allowed: boolean; error?: string } {
    const stats = this.getStorageStats();
    if (stats.usedBytes + incomingSizeBytes > stats.totalCapacityBytes) {
      return {
        allowed: false,
        error: `Storage quota exceeded: Incoming upload (${formatBytes(incomingSizeBytes)}) exceeds available server capacity (${stats.availableFormatted} remaining of ${stats.totalCapacityFormatted}).`,
      };
    }
    return { allowed: true };
  }

  // Safe cleanup of stale temporary upload chunks and orphaned thumbnails
  public static cleanStaleArtifacts(maxChunkAgeMs = 2 * 60 * 60 * 1000): { cleanedChunks: number; cleanedThumbnails: number } {
    let cleanedChunks = 0;
    let cleanedThumbnails = 0;
    const now = Date.now();

    // 1. Stale upload chunks
    try {
      if (fs.existsSync(TEMP_UPLOADS_DIR)) {
        const files = fs.readdirSync(TEMP_UPLOADS_DIR);
        for (const file of files) {
          const fullPath = path.join(TEMP_UPLOADS_DIR, file);
          try {
            const stat = fs.statSync(fullPath);
            if (now - stat.mtimeMs > maxChunkAgeMs) {
              fs.unlinkSync(fullPath);
              cleanedChunks++;
            }
          } catch {}
        }
      }
    } catch (err) {
      console.warn('[Storage] Error cleaning stale chunks:', err);
    }

    // 2. Orphaned thumbnails
    try {
      if (fs.existsSync(THUMBNAILS_DIR)) {
        const thumbFiles = fs.readdirSync(THUMBNAILS_DIR);
        const assets = db.getMediaAssets();
        const validAssetIds = new Set(assets.map(a => a.id));

        for (const tf of thumbFiles) {
          if (tf.startsWith('thumb_') && tf.endsWith('.jpg')) {
            const assetId = tf.slice(6, -4);
            if (!validAssetIds.has(assetId)) {
              try {
                fs.unlinkSync(path.join(THUMBNAILS_DIR, tf));
                cleanedThumbnails++;
              } catch {}
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Storage] Error cleaning orphaned thumbnails:', err);
    }

    if (cleanedChunks > 0 || cleanedThumbnails > 0) {
      console.log(`[Storage] Cleaned ${cleanedChunks} stale chunk(s) and ${cleanedThumbnails} orphaned thumbnail(s).`);
    }

    return { cleanedChunks, cleanedThumbnails };
  }

  // Validates if a media file can be safely deleted without breaking active broadcasts, playlists, or schedules
  public static validateAssetDeletionSafety(filename: string): { canDelete: boolean; reason?: string; warnings: string[] } {
    const warnings: string[] = [];

    // Check playlists
    const playlists = db.getPlaylists();
    const referencingPlaylists = playlists.filter(p => p.items.some(i => i.filename === filename));
    if (referencingPlaylists.length > 0) {
      warnings.push(`File is referenced in ${referencingPlaylists.length} playlist(s): ${referencingPlaylists.map(p => `"${p.name}"`).join(', ')}.`);
    }

    // Check schedules
    const schedules = db.getSchedules();
    const referencingSchedules = schedules.filter(s => s.videoFilename === filename && s.status === 'scheduled');
    if (referencingSchedules.length > 0) {
      warnings.push(`File is scheduled for future broadcast in ${referencingSchedules.length} schedule(s): ${referencingSchedules.map(s => `"${s.title}"`).join(', ')}.`);
    }

    return {
      canDelete: true,
      warnings,
    };
  }
}
