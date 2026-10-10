import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { db, verifyPassword, hashPassword } from '../db';
import { User, UserRole } from '../db/schema';

export interface Session {
  token: string;
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  sessionVersion: number;
  expiresAt: number;
}

export interface SseTicket {
  ticket: string;
  userId: string;
  username: string;
  role: UserRole;
  expiresAt: number;
}

// Rate limiting state for failed logins (per IP address)
interface LoginAttemptRecord {
  attempts: number;
  lockedUntil: number;
}

const loginAttempts = new Map<string, LoginAttemptRecord>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

export class AuthService {
  private static sessions = new Map<string, Session>();
  private static sseTickets = new Map<string, SseTicket>();

  public static createSession(user: User): Session {
    const token = 'ccs_' + crypto.randomBytes(32).toString('hex');
    const settings = db.getSettings();
    const timeoutHours = settings.sessionTimeoutHours || 48;
    const expiresAt = Date.now() + timeoutHours * 3600 * 1000;
    const session: Session = {
      token,
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      sessionVersion: user.sessionVersion || 1,
      expiresAt,
    };
    this.sessions.set(token, session);
    return session;
  }

  public static getSession(token: string): Session | undefined {
    if (!token || typeof token !== 'string') return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return undefined;
    }
    // Verify user is still active and session has not been revoked
    const user = db.getUserById(session.userId);
    if (!user || user.isActive === false) {
      this.sessions.delete(token);
      return undefined;
    }
    if (user.sessionVersion && session.sessionVersion !== user.sessionVersion) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  public static revokeUserSessions(userId: string): void {
    const user = db.getUserById(userId);
    if (user) {
      user.sessionVersion = (user.sessionVersion || 1) + 1;
      db.saveUser(user);
    }
    for (const [token, session] of this.sessions.entries()) {
      if (session.userId === userId) {
        this.sessions.delete(token);
      }
    }
  }

  public static sanitizeUser(user: User): Omit<User, 'passwordHash' | 'salt'> {
    const { passwordHash, salt, ...safeUser } = user;
    return safeUser;
  }

  public static destroySession(token: string): void {
    if (token) this.sessions.delete(token);
  }

  // Create a short-lived single-use ticket for SSE EventSource connections (valid 30s)
  public static createSseTicket(session: Session): string {
    const ticket = 'sset_' + crypto.randomBytes(24).toString('hex');
    this.sseTickets.set(ticket, {
      ticket,
      userId: session.userId,
      username: session.username,
      role: session.role,
      expiresAt: Date.now() + 30 * 1000,
    });
    return ticket;
  }

  // Consume and immediately invalidate a single-use SSE ticket
  public static consumeSseTicket(ticket: string): SseTicket | undefined {
    if (!ticket || typeof ticket !== 'string') return undefined;
    const record = this.sseTickets.get(ticket);
    if (!record) return undefined;
    // Always delete to guarantee single-use
    this.sseTickets.delete(ticket);
    if (Date.now() > record.expiresAt) {
      return undefined;
    }
    return record;
  }

  public static cleanExpiredSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(token);
      }
    }
    for (const [ticket, record] of this.sseTickets.entries()) {
      if (now > record.expiresAt) {
        this.sseTickets.delete(ticket);
      }
    }
  }

  // Check login rate limiting per IP address
  public static checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSeconds?: number } {
    const cleanIp = ip || 'unknown';
    const record = loginAttempts.get(cleanIp);
    const now = Date.now();
    if (!record) return { allowed: true };

    if (record.lockedUntil > now) {
      const remainingSecs = Math.ceil((record.lockedUntil - now) / 1000);
      return { allowed: false, retryAfterSeconds: remainingSecs };
    }

    if (now - record.lockedUntil > LOCKOUT_MS) {
      // Lockout expired, reset attempts
      loginAttempts.delete(cleanIp);
      return { allowed: true };
    }

    return { allowed: true };
  }

  public static recordLoginFailure(ip: string): void {
    const cleanIp = ip || 'unknown';
    const now = Date.now();
    const record = loginAttempts.get(cleanIp) || { attempts: 0, lockedUntil: 0 };
    record.attempts += 1;
    if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
      record.lockedUntil = now + LOCKOUT_MS;
      console.warn(`[AuthService] IP ${cleanIp} temporarily locked out for ${LOCKOUT_MS / 1000}s due to ${record.attempts} failed login attempts.`);
    }
    loginAttempts.set(cleanIp, record);
  }

  public static recordLoginSuccess(ip: string): void {
    const cleanIp = ip || 'unknown';
    loginAttempts.delete(cleanIp);
  }

  public static authenticateUser(username: string, password: string): User | null {
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return null;
    }
    const user = db.getUserByUsername(username.trim());
    if (!user || user.isActive === false) return null;
    const isValid = verifyPassword(password, user.passwordHash, user.salt);
    if (!isValid) return null;
    user.lastLoginAt = new Date().toISOString();
    db.saveUser(user);
    return user;
  }
}

// Session cleaner loop every 15 minutes
setInterval(() => {
  AuthService.cleanExpiredSessions();
}, 15 * 60 * 1000);

export function hasPermission(
  role: UserRole,
  action:
    | 'manage_users'
    | 'manage_settings'
    | 'control_streams'
    | 'manage_channels'
    | 'manage_media'
    | 'manage_schedules'
    | 'view_streams'
    | 'view_audit_logs'
): boolean {
  if (role === 'owner') return true;

  switch (action) {
    case 'manage_users':
    case 'manage_settings':
      return false; // Handled per-user or owner-only

    case 'manage_channels':
      return role === 'admin';

    case 'control_streams':
    case 'manage_media':
    case 'manage_schedules':
      return role === 'admin' || role === 'stream_manager' || role === 'operator';

    case 'view_streams':
      return true; // All authenticated roles can view

    case 'view_audit_logs':
      return role === 'admin';

    default:
      return false;
  }
}

export function canAccessResource(
  userRole?: UserRole,
  _resourceUserId?: string,
  _currentUserId?: string,
  isWrite = false
): boolean {
  if (!userRole) return false;
  if (userRole === 'owner' || userRole === 'admin') return true;
  if (userRole === 'stream_manager' || userRole === 'operator') return true;
  if (userRole === 'viewer') return !isWrite;
  return false;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  if (token) {
    const session = AuthService.getSession(token);
    if (session) {
      (req as any).user = session;
      return next();
    }
  }

  // Reject all unauthenticated requests with HTTP 401
  return res.status(401).json({
    error: 'Unauthorized: Valid authentication token required.',
  });
}

export function requireRole(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as Session | undefined;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
    }
    // Owner always has access
    if (user.role === 'owner') {
      return next();
    }
    if (allowedRoles.includes(user.role)) {
      return next();
    }
    return res.status(403).json({
      error: `Forbidden: Insufficient privileges. Required role: [${allowedRoles.join(', ')}], current role: ${user.role}.`,
    });
  };
}
