import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  User,
  UserInvitation,
  PasswordResetOtp,
  StreamConfig,
  StreamDestination,
  MediaAsset,
  Playlist,
  Schedule,
  StreamEvent,
  AuditLog,
  ServerSettings,
} from './schema';

const ROOT_DIR = process.cwd();
const DATA_DIR = path.resolve(ROOT_DIR, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

// Write lock map to serialize writes per file path
const fileWriteLocks = new Map<string, Promise<void>>();

function writeAtomicJson(filePath: string, data: any): void {
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`;
  try {
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, jsonStr, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    throw err;
  }
}

function readJsonFile<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.trim().length === 0) return defaultValue;
      return JSON.parse(content) as T;
    }
  } catch (err) {
    console.error(`[Database] Error reading ${path.basename(filePath)}:`, err);
  }
  return defaultValue;
}

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const generatedSalt = salt || crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, generatedSalt, 64);
  return { hash: derivedKey.toString('hex'), salt: generatedSalt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  try {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const keyBuffer = Buffer.from(hash, 'hex');
    return crypto.timingSafeEqual(derivedKey, keyBuffer);
  } catch {
    return false;
  }
}

export function maskStreamKey(key: string): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length <= 4) return '••••';
  return '••••••••' + trimmed.slice(-4);
}

class Database {
  private usersFile = path.join(DATA_DIR, 'users.json');
  private invitationsFile = path.join(DATA_DIR, 'user_invitations.json');
  private passwordResetOtpsFile = path.join(DATA_DIR, 'password_reset_otps.json');
  private streamsFile = path.join(DATA_DIR, 'streams_config.json');
  private destinationsFile = path.join(DATA_DIR, 'destinations.json');
  private mediaAssetsFile = path.join(DATA_DIR, 'videos.json');
  private playlistsFile = path.join(DATA_DIR, 'playlists.json');
  private schedulesFile = path.join(DATA_DIR, 'schedules.json');
  private streamEventsFile = path.join(DATA_DIR, 'stream_events.json');
  private auditLogsFile = path.join(DATA_DIR, 'audit_logs.json');
  private settingsFile = path.join(DATA_DIR, 'settings.json');

  private users: User[] = [];
  private invitations: UserInvitation[] = [];
  private passwordResetOtps: PasswordResetOtp[] = [];
  private streams: StreamConfig[] = [];
  private destinations: StreamDestination[] = [];
  private mediaAssets: MediaAsset[] = [];
  private playlists: Playlist[] = [];
  private schedules: Schedule[] = [];
  private streamEvents: StreamEvent[] = [];
  private auditLogs: AuditLog[] = [];
  private settings: ServerSettings = {
    serverName: 'CloudCast Production Node',
    maxConcurrentStreams: 8,
    maxCpuUsageThreshold: 85,
    enableOrphanProcessReconciliation: true,
    autoStartStreamsOnBoot: true,
    defaultEncodingPreset: 'copy',
    rtmpConnectTimeoutSeconds: 15,
    sessionTimeoutHours: 48,
    storageQuotaGb: 50,
  };

  constructor() {
    this.init();
  }

  private init() {
    this.loadAll();
    this.ensureDefaultData();
    this.migrateLegacyData();
  }

  private loadAll() {
    this.users = readJsonFile<User[]>(this.usersFile, []);
    this.invitations = readJsonFile<UserInvitation[]>(this.invitationsFile, []);
    this.passwordResetOtps = readJsonFile<PasswordResetOtp[]>(this.passwordResetOtpsFile, []);
    this.streams = readJsonFile<StreamConfig[]>(this.streamsFile, []);
    this.destinations = readJsonFile<StreamDestination[]>(this.destinationsFile, []);
    this.mediaAssets = readJsonFile<MediaAsset[]>(this.mediaAssetsFile, []);
    this.playlists = readJsonFile<Playlist[]>(this.playlistsFile, []);
    this.schedules = readJsonFile<Schedule[]>(this.schedulesFile, []);
    this.streamEvents = readJsonFile<StreamEvent[]>(this.streamEventsFile, []);
    this.auditLogs = readJsonFile<AuditLog[]>(this.auditLogsFile, []);
    this.settings = readJsonFile<ServerSettings>(this.settingsFile, this.settings);
    if (!this.settings.storageQuotaGb) {
      this.settings.storageQuotaGb = 50;
    }

    // Backwards compatibility normalization
    let modifiedAssets = false;
    for (const asset of this.mediaAssets) {
      if (!asset.status) {
        asset.status = asset.isLiveReady !== false ? 'ready' : 'invalid';
        modifiedAssets = true;
      }
    }
    if (modifiedAssets) {
      writeAtomicJson(this.mediaAssetsFile, this.mediaAssets);
    }

    let modifiedUsers = false;
    for (const user of this.users) {
      if (user.role === 'admin') {
        if (!user.adminPermissions) {
          user.adminPermissions = {
            canAddUsers: true,
            canEditUsers: true,
            canResetPasswords: true,
            canDeactivateUsers: true,
            canDeleteUsers: true,
          };
          modifiedUsers = true;
        } else if (user.adminPermissions.canDeleteUsers === undefined || user.adminPermissions.canDeleteUsers === false) {
          user.adminPermissions.canDeleteUsers = true;
          modifiedUsers = true;
        }
      }
    }
    if (modifiedUsers) {
      writeAtomicJson(this.usersFile, this.users);
    }

    let modifiedSchedules = false;
    for (const sched of this.schedules) {
      if (sched.enabled === undefined) {
        sched.enabled = true;
        modifiedSchedules = true;
      }
      if (!sched.conflictPolicy) {
        sched.conflictPolicy = 'skip';
        modifiedSchedules = true;
      }
    }
    if (modifiedSchedules) {
      writeAtomicJson(this.schedulesFile, this.schedules);
    }
  }

  private ensureDefaultData() {
    const isProduction = process.env.NODE_ENV === 'production';
    const envAdminPassword = process.env.ADMIN_PASSWORD?.trim();

    // Insecure known default hash from 'cloudcast2026' with default salt
    const KNOWN_INSECURE_HASH = 'f3ae6be5cfbaa650f295f2cb36e3fb6efb9ba67824ccf8dcb785cedaca58189019a5e245cdbed8d2d986a18e53826f738179e150907da15f07eb08b6a1bc331b';

    if (this.users.length === 0) {
      let initialPassword = envAdminPassword;

      if (isProduction && (!initialPassword || initialPassword.length < 10)) {
        throw new Error(
          '[Security Configuration Error] In production mode, ADMIN_PASSWORD with a minimum of 10 characters must be configured in environment variables to bootstrap the administrator account.'
        );
      }

      if (!initialPassword) {
        // Non-production bootstrap: default to secure preset for local dev/preview
        initialPassword = 'Director@2026!';
        console.log('[Security] Development Administrator initialized: username "admin", password "Director@2026!"');
      } else {
        console.log('[Database] Initialized primary Administrator account using configured ADMIN_PASSWORD.');
      }

      const { hash, salt } = hashPassword(initialPassword);
      const adminUser: User = {
        id: 'usr_admin_' + Date.now().toString(36),
        username: 'admin',
        displayName: 'Broadcast Director',
        role: 'owner',
        isActive: true,
        passwordHash: hash,
        salt,
        sessionVersion: 1,
        createdAt: new Date().toISOString(),
      };
      this.users.push(adminUser);
      writeAtomicJson(this.usersFile, this.users);
    } else {
      // Check if existing admin user still holds the insecure known default password hash
      const insecureAdmin = this.users.find(
        u => u.username === 'admin' && (u.passwordHash === KNOWN_INSECURE_HASH || verifyPassword('cloudcast2026', u.passwordHash, u.salt))
      );
      if (insecureAdmin) {
        let replacementPassword = envAdminPassword;
        if (!replacementPassword) {
          replacementPassword = 'Director@2026!';
          console.log('[Security] Rotated development "admin" credentials to "Director@2026!".');
        } else {
          console.log('[Security] Rotated "admin" credentials using configured ADMIN_PASSWORD.');
        }
        const { hash, salt } = hashPassword(replacementPassword);
        insecureAdmin.passwordHash = hash;
        insecureAdmin.salt = salt;
        writeAtomicJson(this.usersFile, this.users);
      }
    }

    if (!fs.existsSync(this.settingsFile)) {
      writeAtomicJson(this.settingsFile, this.settings);
    }
  }

  private migrateLegacyData() {
    const legacyChannelsFile = path.join(DATA_DIR, 'youtube_channels.json');
    if (this.destinations.length === 0 && fs.existsSync(legacyChannelsFile)) {
      try {
        const legacyChannels = readJsonFile<any[]>(legacyChannelsFile, []);
        for (const chan of legacyChannels) {
          if (chan.streamKey && chan.title) {
            this.destinations.push({
              id: chan.id || `dest_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              name: chan.title,
              provider: 'youtube',
              rtmpUrl: chan.rtmpUrl || 'rtmps://a.rtmps.youtube.com:443/live2',
              streamKey: chan.streamKey,
              enabled: true,
              createdAt: chan.connectedAt || new Date().toISOString(),
            });
          }
        }
        if (this.destinations.length > 0) {
          writeAtomicJson(this.destinationsFile, this.destinations);
          console.log(`[Database] Migrated ${this.destinations.length} legacy channel destinations.`);
        }
      } catch (err) {
        console.warn('[Database] Legacy channels migration warning:', err);
      }
    }

    const legacyStreamsFile = path.join(DATA_DIR, 'streams.json');
    if (this.streams.length === 0 && fs.existsSync(legacyStreamsFile)) {
      try {
        const legacyStreams = readJsonFile<any[]>(legacyStreamsFile, []);
        for (const ls of legacyStreams) {
          if (ls.videoFilename && (ls.streamKey || (ls.destinations && ls.destinations.length > 0))) {
            const firstDestKey = ls.streamKey || (ls.destinations && ls.destinations[0]?.streamKey) || '';
            const firstDestUrl = ls.rtmpUrl || (ls.destinations && ls.destinations[0]?.rtmpUrl) || 'rtmps://a.rtmps.youtube.com:443/live2';
            this.streams.push({
              id: ls.id || `stream_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              name: ls.title || ls.videoFilename,
              videoFilename: ls.videoFilename,
              rtmpUrl: firstDestUrl,
              streamKey: firstDestKey,
              destinations: ls.destinations,
              encodingMode: ls.mode || 'copy',
              loop: ls.loop !== false,
              autoStart: true,
              autoRestart: true,
              maxRetries: 5,
              channelTitle: ls.channelTitle,
              createdAt: ls.startedAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
        }
        if (this.streams.length > 0) {
          writeAtomicJson(this.streamsFile, this.streams);
          console.log(`[Database] Migrated ${this.streams.length} legacy stream configurations.`);
        }
      } catch (err) {
        console.warn('[Database] Legacy streams migration warning:', err);
      }
    }
  }

  public getUsers(): User[] {
    return [...this.users];
  }

  public getUserByUsername(username: string): User | undefined {
    return this.users.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
  }

  public getUserByEmail(email: string): User | undefined {
    if (!email) return undefined;
    return this.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase().trim());
  }

  public getUserById(id: string): User | undefined {
    return this.users.find(u => u.id === id);
  }

  public saveUser(user: User): void {
    const idx = this.users.findIndex(u => u.id === user.id);
    if (idx >= 0) {
      this.users[idx] = user;
    } else {
      this.users.push(user);
    }
    writeAtomicJson(this.usersFile, this.users);
  }

  public deleteUser(id: string): boolean {
    const initialLen = this.users.length;
    this.users = this.users.filter(u => u.id !== id);
    if (this.users.length !== initialLen) {
      writeAtomicJson(this.usersFile, this.users);
      // Clean up related invitations and OTPs
      this.invitations = this.invitations.filter(inv => inv.userId !== id);
      writeAtomicJson(this.invitationsFile, this.invitations);
      this.passwordResetOtps = this.passwordResetOtps.filter(otp => otp.userId !== id);
      writeAtomicJson(this.passwordResetOtpsFile, this.passwordResetOtps);
      return true;
    }
    return false;
  }

  public countActiveOwners(): number {
    return this.users.filter(u => u.role === 'owner' && u.isActive !== false).length;
  }

  // Invitations
  public getInvitations(): UserInvitation[] {
    return [...this.invitations];
  }

  public getInvitationByTokenHash(tokenHash: string): UserInvitation | undefined {
    return this.invitations.find(inv => inv.tokenHash === tokenHash);
  }

  public getActiveInvitationForUser(userId: string): UserInvitation | undefined {
    const now = Date.now();
    return this.invitations.find(inv => inv.userId === userId && !inv.usedAt && inv.expiresAt > now);
  }

  public saveInvitation(inv: UserInvitation): void {
    const idx = this.invitations.findIndex(i => i.id === inv.id);
    if (idx >= 0) {
      this.invitations[idx] = inv;
    } else {
      this.invitations.push(inv);
    }
    writeAtomicJson(this.invitationsFile, this.invitations);
  }

  public invalidateInvitationsForUser(userId: string): void {
    let changed = false;
    for (const inv of this.invitations) {
      if (inv.userId === userId && !inv.usedAt) {
        inv.usedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) {
      writeAtomicJson(this.invitationsFile, this.invitations);
    }
  }

  // Password Reset OTPs
  public getPasswordResetOtps(): PasswordResetOtp[] {
    return [...this.passwordResetOtps];
  }

  public getActiveOtpForUser(userId: string): PasswordResetOtp | undefined {
    const now = Date.now();
    return this.passwordResetOtps.find(o => o.userId === userId && !o.usedAt && o.expiresAt > now);
  }

  public getOtpByResetTokenHash(tokenHash: string): PasswordResetOtp | undefined {
    const now = Date.now();
    return this.passwordResetOtps.find(o => o.resetTokenHash === tokenHash && !o.usedAt && o.expiresAt > now);
  }

  public savePasswordResetOtp(otp: PasswordResetOtp): void {
    const idx = this.passwordResetOtps.findIndex(o => o.id === otp.id);
    if (idx >= 0) {
      this.passwordResetOtps[idx] = otp;
    } else {
      this.passwordResetOtps.push(otp);
    }
    writeAtomicJson(this.passwordResetOtpsFile, this.passwordResetOtps);
  }

  public invalidateOtpsForUser(userId: string): void {
    let changed = false;
    for (const otp of this.passwordResetOtps) {
      if (otp.userId === userId && !otp.usedAt) {
        otp.usedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) {
      writeAtomicJson(this.passwordResetOtpsFile, this.passwordResetOtps);
    }
  }

  public getDestinations(): StreamDestination[] {
    return [...this.destinations];
  }

  public getDestinationById(id: string): StreamDestination | undefined {
    return this.destinations.find(d => d.id === id);
  }

  public saveDestination(destination: StreamDestination): void {
    const idx = this.destinations.findIndex(d => d.id === destination.id);
    if (idx >= 0) {
      this.destinations[idx] = destination;
    } else {
      this.destinations.push(destination);
    }
    writeAtomicJson(this.destinationsFile, this.destinations);
  }

  public deleteDestination(id: string): boolean {
    const initialLen = this.destinations.length;
    this.destinations = this.destinations.filter(d => d.id !== id);
    if (this.destinations.length !== initialLen) {
      writeAtomicJson(this.destinationsFile, this.destinations);
      return true;
    }
    return false;
  }

  public getStreams(): StreamConfig[] {
    return [...this.streams];
  }

  public getStreamById(id: string): StreamConfig | undefined {
    return this.streams.find(s => s.id === id);
  }

  public saveStream(stream: StreamConfig): void {
    const idx = this.streams.findIndex(s => s.id === stream.id);
    stream.updatedAt = new Date().toISOString();
    if (idx >= 0) {
      this.streams[idx] = stream;
    } else {
      this.streams.unshift(stream);
    }
    writeAtomicJson(this.streamsFile, this.streams);
  }

  public deleteStream(id: string): boolean {
    const initialLen = this.streams.length;
    this.streams = this.streams.filter(s => s.id !== id);
    if (this.streams.length !== initialLen) {
      writeAtomicJson(this.streamsFile, this.streams);
      return true;
    }
    return false;
  }

  public getMediaAssets(): MediaAsset[] {
    return [...this.mediaAssets];
  }

  public getMediaAssetById(id: string): MediaAsset | undefined {
    return this.mediaAssets.find(m => m.id === id || m.filename === id);
  }

  public saveMediaAsset(asset: MediaAsset): void {
    const idx = this.mediaAssets.findIndex(m => m.id === asset.id || m.filename === asset.filename);
    if (idx >= 0) {
      this.mediaAssets[idx] = asset;
    } else {
      this.mediaAssets.unshift(asset);
    }
    writeAtomicJson(this.mediaAssetsFile, this.mediaAssets);
  }

  public setMediaAssets(assets: MediaAsset[]): void {
    this.mediaAssets = [...assets];
    writeAtomicJson(this.mediaAssetsFile, this.mediaAssets);
  }

  public deleteMediaAsset(id: string): boolean {
    const initialLen = this.mediaAssets.length;
    this.mediaAssets = this.mediaAssets.filter(m => m.id !== id && m.filename !== id);
    if (this.mediaAssets.length !== initialLen) {
      writeAtomicJson(this.mediaAssetsFile, this.mediaAssets);
      return true;
    }
    return false;
  }

  public getPlaylists(): Playlist[] {
    return [...this.playlists];
  }

  public getPlaylistById(id: string): Playlist | undefined {
    return this.playlists.find(p => p.id === id);
  }

  public savePlaylist(playlist: Playlist): void {
    const idx = this.playlists.findIndex(p => p.id === playlist.id);
    playlist.updatedAt = new Date().toISOString();
    if (idx >= 0) {
      this.playlists[idx] = playlist;
    } else {
      this.playlists.push(playlist);
    }
    writeAtomicJson(this.playlistsFile, this.playlists);
  }

  public deletePlaylist(id: string): boolean {
    const initialLen = this.playlists.length;
    this.playlists = this.playlists.filter(p => p.id !== id);
    if (this.playlists.length !== initialLen) {
      writeAtomicJson(this.playlistsFile, this.playlists);
      return true;
    }
    return false;
  }

  public getSchedules(): Schedule[] {
    return [...this.schedules];
  }

  public getScheduleById(id: string): Schedule | undefined {
    return this.schedules.find(s => s.id === id);
  }

  public saveSchedule(schedule: Schedule): void {
    const idx = this.schedules.findIndex(s => s.id === schedule.id);
    if (idx >= 0) {
      this.schedules[idx] = schedule;
    } else {
      this.schedules.push(schedule);
    }
    writeAtomicJson(this.schedulesFile, this.schedules);
  }

  public deleteSchedule(id: string): boolean {
    const initialLen = this.schedules.length;
    this.schedules = this.schedules.filter(s => s.id !== id);
    if (this.schedules.length !== initialLen) {
      writeAtomicJson(this.schedulesFile, this.schedules);
      return true;
    }
    return false;
  }

  public getStreamEvents(streamId?: string, limit = 100): StreamEvent[] {
    let list = this.streamEvents;
    if (streamId) {
      list = list.filter(e => e.streamId === streamId);
    }
    return list.slice(-limit).reverse();
  }

  public addStreamEvent(event: Omit<StreamEvent, 'id' | 'timestamp'>): StreamEvent {
    const fullEvent: StreamEvent = {
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
    };
    this.streamEvents.push(fullEvent);
    if (this.streamEvents.length > 2000) {
      this.streamEvents = this.streamEvents.slice(-1500);
    }
    writeAtomicJson(this.streamEventsFile, this.streamEvents);
    return fullEvent;
  }

  public getAuditLogs(limit = 200): AuditLog[] {
    return this.auditLogs.slice(-limit).reverse();
  }

  public addAuditLog(log: Omit<AuditLog, 'id' | 'timestamp'>): AuditLog {
    const fullLog: AuditLog = {
      ...log,
      id: `aud_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
    };
    this.auditLogs.push(fullLog);
    if (this.auditLogs.length > 2000) {
      this.auditLogs = this.auditLogs.slice(-1500);
    }
    writeAtomicJson(this.auditLogsFile, this.auditLogs);
    return fullLog;
  }

  public getSettings(): ServerSettings {
    return { ...this.settings };
  }

  public saveSettings(newSettings: Partial<ServerSettings>): ServerSettings {
    this.settings = { ...this.settings, ...newSettings };
    writeAtomicJson(this.settingsFile, this.settings);
    return { ...this.settings };
  }
}

export const db = new Database();
