import { spawn, ChildProcess, exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execPromise = util.promisify(exec);
const REGISTRY_FILE = path.resolve(process.cwd(), 'data', '.process_registry.json');

export interface SpawnProcessOptions {
  streamId: string;
  generationId: number;
  args: string[];
  ffmpegPath?: string;
  onLog: (line: string) => void;
  onError: (err: Error) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

export interface ProcessRegistryEntry {
  pid: number;
  streamId: string;
  generationId: number;
  startedAt: string;
}

export interface ManagedProcessInfo {
  child: ChildProcess;
  streamId: string;
  generationId: number;
  pid: number;
  spawnedAt: string;
  hasDispatchedExit: boolean;
  stopPromise?: Promise<boolean>;
}

export class ProcessManager {
  private activeProcesses = new Map<string, ManagedProcessInfo>();

  private loadRegistry(): Map<number, ProcessRegistryEntry> {
    const map = new Map<number, ProcessRegistryEntry>();
    try {
      if (fs.existsSync(REGISTRY_FILE)) {
        const raw = fs.readFileSync(REGISTRY_FILE, 'utf-8');
        const list: ProcessRegistryEntry[] = JSON.parse(raw);
        for (const item of list) {
          if (item && item.pid) map.set(item.pid, item);
        }
      }
    } catch {}
    return map;
  }

  private saveRegistry(): void {
    try {
      const list: ProcessRegistryEntry[] = [];
      for (const [streamId, info] of this.activeProcesses.entries()) {
        if (info.pid) {
          list.push({
            pid: info.pid,
            streamId,
            generationId: info.generationId,
            startedAt: info.spawnedAt,
          });
        }
      }
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(list, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch {}
  }

  public spawnStream(options: SpawnProcessOptions): ChildProcess {
    const ffmpegCmd = options.ffmpegPath || 'ffmpeg';
    // Tag process environment with cloudcast metadata and generation for clean reconciliation
    const env = {
      ...process.env,
      CLOUDCAST_MANAGED: 'true',
      CLOUDCAST_STREAM_ID: options.streamId,
      CLOUDCAST_GEN_ID: options.generationId.toString(),
    };

    const child = spawn(ffmpegCmd, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    const pid = child.pid || 0;
    const info: ManagedProcessInfo = {
      child,
      streamId: options.streamId,
      generationId: options.generationId,
      pid,
      spawnedAt: new Date().toISOString(),
      hasDispatchedExit: false,
    };

    this.activeProcesses.set(options.streamId, info);
    this.saveRegistry();

    // Unified termination handler: ensures at most ONE recovery or exit notification per process
    const handleTermination = (code: number | null, signal: string | null, error?: Error) => {
      if (info.hasDispatchedExit) return;
      info.hasDispatchedExit = true;
      this.activeProcesses.delete(options.streamId);
      this.saveRegistry();
      if (error) {
        options.onError(error);
      } else {
        options.onExit(code, signal);
      }
    };

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const lines = text.split(/[\r\n]+/).filter(l => l.trim().length > 0);
      for (const line of lines) {
        options.onLog(line);
      }
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        const lines = text.split(/[\r\n]+/).filter(l => l.trim().length > 0);
        for (const line of lines) {
          options.onLog(line);
        }
      });
    }

    child.on('error', err => {
      handleTermination(null, null, err);
    });

    child.on('close', (code, signal) => {
      handleTermination(code, signal);
    });

    return child;
  }

  public getProcess(streamId: string): ChildProcess | undefined {
    return this.activeProcesses.get(streamId)?.child;
  }

  public getProcessInfo(streamId: string): ManagedProcessInfo | undefined {
    return this.activeProcesses.get(streamId);
  }

  public isProcessAlive(streamId: string): boolean {
    const info = this.activeProcesses.get(streamId);
    if (!info || !info.child) return false;
    const child = info.child;
    return !!(child && !child.killed && child.exitCode === null);
  }

  public async stopStream(streamId: string, timeoutMs = 4000): Promise<boolean> {
    const info = this.activeProcesses.get(streamId);
    if (!info) return true;

    // Idempotent stop: if already in progress of stopping, reuse the existing Promise
    if (info.stopPromise) {
      return info.stopPromise;
    }

    info.stopPromise = new Promise(resolve => {
      const child = info.child;
      let finished = false;

      const finish = () => {
        if (!finished) {
          finished = true;
          this.activeProcesses.delete(streamId);
          this.saveRegistry();
          resolve(true);
        }
      };

      if (!child || child.killed || child.exitCode !== null) {
        finish();
        return;
      }

      // 1. Try sending 'q' to stdin for clean RTMP trailer flush
      try {
        if (child.stdin && child.stdin.writable) {
          child.stdin.write('q\n');
          child.stdin.end();
        }
      } catch {}

      // 2. Schedule SIGINT if still running after 1200ms
      const sigintTimer = setTimeout(() => {
        try {
          if (!child.killed && child.exitCode === null) {
            child.kill('SIGINT');
          }
        } catch {}
      }, 1200);

      // 3. Force SIGKILL if still running after timeoutMs
      const sigkillTimer = setTimeout(() => {
        try {
          if (!child.killed && child.exitCode === null) {
            child.kill('SIGKILL');
          }
        } catch {}
        finish();
      }, timeoutMs);

      child.once('close', () => {
        clearTimeout(sigintTimer);
        clearTimeout(sigkillTimer);
        finish();
      });

      // Hard safety timeout in case OS hangs
      setTimeout(() => {
        finish();
      }, timeoutMs + 1000);
    });

    return info.stopPromise;
  }

  public async stopAll(): Promise<void> {
    const ids = Array.from(this.activeProcesses.keys());
    await Promise.all(ids.map(id => this.stopStream(id)));
  }

  public getActiveCount(): number {
    return this.activeProcesses.size;
  }

  // Safely scan system for orphan FFmpeg processes ONLY if proven to belong to CloudCast
  public async reconcileOrphanProcesses(_knownStreamIds: Set<string>): Promise<number> {
    try {
      if (process.platform === 'win32') return 0;

      const registry = this.loadRegistry();
      if (registry.size === 0) return 0;

      let killedCount = 0;

      for (const [pid, entry] of registry.entries()) {
        // If pid is currently tracked in this running instance, do not kill
        const isCurrentlyTracked = Array.from(this.activeProcesses.values()).some(p => p.pid === pid);
        if (isCurrentlyTracked) continue;

        // Check if process is running at all
        let isRunning = false;
        try {
          process.kill(pid, 0);
          isRunning = true;
        } catch {
          isRunning = false;
        }
        if (!isRunning) continue;

        // Verify ownership on Linux via /proc/<pid>/environ
        let isVerifiedCloudCastProcess = false;
        const procEnvironPath = `/proc/${pid}/environ`;
        const procCmdlinePath = `/proc/${pid}/cmdline`;

        try {
          if (fs.existsSync(procEnvironPath)) {
            const rawEnv = fs.readFileSync(procEnvironPath, 'utf-8');
            if (rawEnv.includes('CLOUDCAST_MANAGED=true') && rawEnv.includes(`CLOUDCAST_STREAM_ID=${entry.streamId}`)) {
              isVerifiedCloudCastProcess = true;
            }
          }
        } catch {
          // If permission denied reading /proc, cannot verify ownership safely
          isVerifiedCloudCastProcess = false;
        }

        // Check cmdline to ensure it is actually ffmpeg
        try {
          if (fs.existsSync(procCmdlinePath)) {
            const cmd = fs.readFileSync(procCmdlinePath, 'utf-8');
            if (!cmd.includes('ffmpeg')) {
              isVerifiedCloudCastProcess = false;
            }
          }
        } catch {}

        if (isVerifiedCloudCastProcess) {
          console.log(`[ProcessManager] Terminating verified orphaned CloudCast stream process PID ${pid} (streamId: ${entry.streamId})`);
          try {
            process.kill(pid, 'SIGINT');
            setTimeout(() => {
              try {
                process.kill(pid, 'SIGTERM');
              } catch {}
            }, 1500);
            setTimeout(() => {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {}
            }, 3500);
            killedCount++;
          } catch {}
        } else {
          console.warn(
            `[ProcessManager] Found FFmpeg PID ${pid} in registry but could not positively verify CLOUDCAST_MANAGED environment ownership. Preserving process to prevent terminating external tasks.`
          );
        }
      }

      this.saveRegistry();
      return killedCount;
    } catch (err) {
      console.warn('[ProcessManager] Error reconciling orphan processes:', err);
      return 0;
    }
  }
}
