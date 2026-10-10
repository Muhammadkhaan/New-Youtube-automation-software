import React, { useState } from 'react';
import {
  Lock,
  User,
  AlertCircle,
  ShieldCheck,
  ArrowRight,
  Loader2,
  KeyRound,
  Mail,
  CheckCircle2,
  ArrowLeft,
  Key,
} from 'lucide-react';

interface LoginModalProps {
  isOpen: boolean;
  onLoginSuccess: (token: string, user: any) => void;
  inviteToken?: string | null;
  onClearInviteToken?: () => void;
}

type AuthViewMode = 'login' | 'forgot_request' | 'forgot_verify' | 'forgot_new_pass' | 'invite_setup';

export const LoginModal: React.FC<LoginModalProps> = ({
  isOpen,
  onLoginSuccess,
  inviteToken,
  onClearInviteToken,
}) => {
  const [viewMode, setViewMode] = useState<AuthViewMode>(inviteToken ? 'invite_setup' : 'login');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Forgot password OTP workflow states
  const [resetEmail, setResetEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Invitation acceptance states
  const [invitePassword, setInvitePassword] = useState('');
  const [inviteConfirmPassword, setInviteConfirmPassword] = useState('');
  const [inviteUserInfo, setInviteUserInfo] = useState<{ name?: string; email?: string; role?: string } | null>(null);

  // If opened with an invite token, check validity
  React.useEffect(() => {
    if (inviteToken) {
      setViewMode('invite_setup');
      setErrorMessage(null);
      fetch(`/api/auth/verify-invitation?token=${encodeURIComponent(inviteToken)}`)
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            setInviteUserInfo(d);
          } else {
            setErrorMessage(d.error || 'Invalid or expired invitation token.');
          }
        })
        .catch(() => setErrorMessage('Failed to verify invitation link.'));
    }
  }, [inviteToken]);

  if (!isOpen) return null;

  // Handle Standard Login
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setErrorMessage('Please enter both username and password.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Authentication failed. Please verify credentials.');
        return;
      }

      if (data.success && data.token && data.user) {
        onLoginSuccess(data.token, data.user);
      } else {
        setErrorMessage('Unexpected login response from server.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Network error while attempting to log in.');
    } finally {
      setIsLoading(false);
    }
  };

  // Step 1: Request OTP
  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail.trim()) {
      setErrorMessage('Please enter your registered email address.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await fetch('/api/auth/forgot-password/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail.trim() }),
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server returned unexpected response (${res.status}). Please try again.`);
      }
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Unable to request verification code.');
        return;
      }

      const returnedCode = data.otpCode || data.simulatedOtp;
      if (returnedCode) {
        setSuccessMessage(`Verification OTP Code: ${returnedCode}`);
        setOtpCode(returnedCode);
      } else {
        setSuccessMessage(data.message || 'If an account matches that email, a 6-digit verification code has been sent.');
      }
      setViewMode('forgot_verify');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to request verification code.');
    } finally {
      setIsLoading(false);
    }
  };

  // Step 2: Verify 6-digit OTP
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpCode.trim() || otpCode.trim().length !== 6) {
      setErrorMessage('Please enter the 6-digit verification code.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/auth/forgot-password/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail.trim(), otp: otpCode.trim() }),
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        throw new Error(`Server returned non-JSON response (${res.status}).`);
      }
      const data = await res.json();
      if (!res.ok || !data.resetToken) {
        setErrorMessage(data.error || 'Invalid or expired verification code.');
        return;
      }

      setResetToken(data.resetToken);
      setSuccessMessage('Code verified! Enter your new password.');
      setViewMode('forgot_new_pass');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to verify OTP.');
    } finally {
      setIsLoading(false);
    }
  };

  // Step 3: Set New Password via Reset Token
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || newPassword.length < 8) {
      setErrorMessage('Password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/auth/forgot-password/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetToken, newPassword }),
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        throw new Error(`Server returned non-JSON response (${res.status}).`);
      }
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to reset password.');
        return;
      }

      setSuccessMessage('Your password has been reset successfully! Please sign in with your new password.');
      setPassword('');
      setViewMode('login');
    } catch (err: any) {
      setErrorMessage(err.message || 'Error updating password.');
    } finally {
      setIsLoading(false);
    }
  };

  // Step 4: Accept Team Invitation
  const handleAcceptInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invitePassword || invitePassword.length < 8) {
      setErrorMessage('Password must be at least 8 characters long.');
      return;
    }
    if (invitePassword !== inviteConfirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/auth/accept-invitation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteToken, password: invitePassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        setErrorMessage(data.error || 'Failed to activate account.');
        return;
      }

      if (onClearInviteToken) onClearInviteToken();
      onLoginSuccess(data.token, data.user);
    } catch (err: any) {
      setErrorMessage(err.message || 'Error activating account.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header Banner */}
        <div className="bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950 p-6 text-white text-center relative">
          <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-blue-600/30 border border-blue-400/40 flex items-center justify-center backdrop-blur-md shadow-lg">
            {viewMode === 'invite_setup' ? (
              <Key className="w-7 h-7 text-emerald-300" />
            ) : viewMode !== 'login' ? (
              <Mail className="w-7 h-7 text-indigo-300" />
            ) : (
              <Lock className="w-7 h-7 text-blue-300" />
            )}
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white">
            {viewMode === 'invite_setup'
              ? 'Accept Team Invitation'
              : viewMode === 'forgot_request'
              ? 'Reset Account Password'
              : viewMode === 'forgot_verify'
              ? 'Enter Verification Code'
              : viewMode === 'forgot_new_pass'
              ? 'Set New Password'
              : 'CloudCast Studio Console'}
          </h2>
          <p className="text-xs text-blue-200/80 mt-1">
            {viewMode === 'invite_setup'
              ? 'Set your password to join the broadcasting team'
              : viewMode !== 'login'
              ? 'Secure single-use OTP verification flow'
              : 'Authorized Team Live Streaming Gateway'}
          </p>
        </div>

        {/* Dynamic Form Content */}
        <div className="p-6">
          {errorMessage && (
            <div className="p-3 mb-4 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-700 animate-in fade-in">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold block">Notice</span>
                <span>{errorMessage}</span>
              </div>
            </div>
          )}

          {successMessage && (
            <div className="p-3 mb-4 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-2.5 text-xs text-emerald-800 animate-in fade-in">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold block">Success</span>
                <span>{successMessage}</span>
              </div>
            </div>
          )}

          {/* VIEW 1: Standard Login Form */}
          {viewMode === 'login' && (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">Username or Email</label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="admin"
                    disabled={isLoading}
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all bg-slate-50/50"
                    autoFocus
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold text-slate-700">Password</label>
                  <button
                    type="button"
                    onClick={() => {
                      setViewMode('forgot_request');
                      setErrorMessage(null);
                      setSuccessMessage(null);
                    }}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-700 cursor-pointer"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    disabled={isLoading}
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all bg-slate-50/50"
                  />
                </div>
              </div>

              <div className="pt-2 space-y-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-sm transition-all disabled:opacity-60 cursor-pointer"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Verifying Credentials...</span>
                    </>
                  ) : (
                    <>
                      <span>Sign In to Broadcast Console</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center gap-2 text-[11px] text-slate-500">
                <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>Protected with secure cryptographic hashing & login rate limiting.</span>
              </div>
            </form>
          )}

          {/* VIEW 2: Forgot Password - Request OTP */}
          {viewMode === 'forgot_request' && (
            <form onSubmit={handleRequestOtp} className="space-y-4">
              <p className="text-xs text-slate-600">
                Enter your registered email address. We will send a secure 6-digit one-time verification code (OTP) to reset your password.
              </p>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">Registered Email Address</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    value={resetEmail}
                    onChange={e => setResetEmail(e.target.value)}
                    placeholder="user@example.com"
                    disabled={isLoading}
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all bg-slate-50/50"
                    autoFocus
                  />
                </div>
              </div>

              <div className="pt-2 space-y-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-sm transition-all disabled:opacity-60 cursor-pointer"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Sending Verification Code...</span>
                    </>
                  ) : (
                    <>
                      <span>Send 6-Digit OTP</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setViewMode('login');
                    setErrorMessage(null);
                  }}
                  className="w-full py-2 px-3 text-slate-600 hover:text-slate-900 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Sign In</span>
                </button>
              </div>
            </form>
          )}

          {/* VIEW 3: Forgot Password - Verify OTP */}
          {viewMode === 'forgot_verify' && (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <p className="text-xs text-slate-600">
                Please enter the 6-digit numeric verification code sent to <strong>{resetEmail}</strong>. Code expires in 10 minutes.
              </p>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">6-Digit Verification Code</label>
                <div className="relative">
                  <input
                    type="text"
                    maxLength={6}
                    value={otpCode}
                    onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="123456"
                    disabled={isLoading}
                    className="w-full py-3 text-center tracking-[8px] font-mono font-bold text-2xl rounded-xl border border-slate-200 text-slate-900 placeholder:text-slate-300 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all bg-slate-50/50"
                    autoFocus
                  />
                </div>
              </div>

              <div className="pt-2 space-y-2">
                <button
                  type="submit"
                  disabled={isLoading || otpCode.length !== 6}
                  className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-sm transition-all disabled:opacity-60 cursor-pointer"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Verifying Code...</span>
                    </>
                  ) : (
                    <>
                      <span>Verify Code & Continue</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => setViewMode('forgot_request')}
                    className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
                  >
                    Change Email
                  </button>
                  <button
                    type="button"
                    onClick={handleRequestOtp}
                    disabled={isLoading}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-700 cursor-pointer"
                  >
                    Resend Code
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* VIEW 4: Forgot Password - New Password */}
          {viewMode === 'forgot_new_pass' && (
            <form onSubmit={handleResetPassword} className="space-y-4">
              <p className="text-xs text-slate-600">
                Code verified. Choose a secure new password (minimum 8 characters).
              </p>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">New Password</label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    disabled={isLoading}
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all bg-slate-50/50"
                    autoFocus
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">Confirm New Password</label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    placeholder="Repeat new password"
                    disabled={isLoading}
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all bg-slate-50/50"
                  />
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-sm transition-all disabled:opacity-60 cursor-pointer"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Updating Password...</span>
                    </>
                  ) : (
                    <>
                      <span>Save New Password & Sign In</span>
                      <CheckCircle2 className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* VIEW 5: Invitation Setup */}
          {viewMode === 'invite_setup' && (
            <form onSubmit={handleAcceptInvitation} className="space-y-4">
              {inviteUserInfo && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-900">
                  <span className="font-semibold block">{inviteUserInfo.name}</span>
                  <span className="text-blue-700">{inviteUserInfo.email} • Assigned Role: <strong className="uppercase">{inviteUserInfo.role}</strong></span>
                </div>
              )}

              <p className="text-xs text-slate-600">
                To complete your setup and join CloudCast Studio, set a private password for your account.
              </p>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">Create Password</label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    value={invitePassword}
                    onChange={e => setInvitePassword(e.target.value)}
                    placeholder="At least 8 characters"
                    disabled={isLoading}
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all bg-slate-50/50"
                    autoFocus
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">Confirm Password</label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    value={inviteConfirmPassword}
                    onChange={e => setInviteConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    disabled={isLoading}
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 transition-all bg-slate-50/50"
                  />
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-sm transition-all disabled:opacity-60 cursor-pointer"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Activating Account...</span>
                    </>
                  ) : (
                    <>
                      <span>Complete Account Setup</span>
                      <CheckCircle2 className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
