import React, { useState, useEffect } from 'react';
import {
  Users,
  UserPlus,
  Search,
  Shield,
  ShieldAlert,
  Mail,
  MoreVertical,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  Trash2,
  UserX,
  UserCheck,
  Send,
  Loader2,
  Lock,
  Clock,
  Calendar,
  X,
  Filter,
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react';
import { UserProfile, UserRole, AdminPermissions } from '../types';

interface UsersManagementViewProps {
  fetchWithAuth: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  currentUser: { id: string; username: string; displayName: string; role: string; adminPermissions?: AdminPermissions } | null;
}

interface CredentialInfoModal {
  title: string;
  username?: string;
  email?: string;
  role?: string;
  password?: string;
  inviteUrl?: string;
  otpCode?: string;
  message?: string;
}

export const UsersManagementView: React.FC<UsersManagementViewProps> = ({
  fetchWithAuth,
  showToast,
  currentUser,
}) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Modal States
  const [isAddUserOpen, setIsAddUserOpen] = useState(false);
  const [isEditUserOpen, setIsEditUserOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
  const [userToDelete, setUserToDelete] = useState<UserProfile | null>(null);
  const [userToReset, setUserToReset] = useState<UserProfile | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [infoModal, setInfoModal] = useState<CredentialInfoModal | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Form States for Add/Edit
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formRole, setFormRole] = useState<UserRole>('stream_manager');
  const [formPassword, setFormPassword] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formAdminPerms, setFormAdminPerms] = useState<AdminPermissions>({
    canAddUsers: true,
    canEditUsers: true,
    canResetPasswords: true,
    canDeactivateUsers: true,
    canDeleteUsers: true,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionUserId, setActionUserId] = useState<string | null>(null);

  // Safe JSON Response parser to prevent HTML unexpected token errors
  const safeParseResponse = async (res: Response) => {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      throw new Error(`Server returned non-JSON response (${res.status}). Please check API connection.`);
    }
    return await res.json();
  };

  // Copy to Clipboard
  const handleCopy = (text: string, fieldId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(fieldId);
    showToast('Copied to clipboard!', 'info');
    setTimeout(() => setCopiedField(null), 2500);
  };

  // Fetch users
  const loadUsers = async () => {
    try {
      setLoading(true);
      const res = await fetchWithAuth('/api/users');
      const data = await safeParseResponse(res);
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load team users.');
      }
      setUsers(data.users || []);
    } catch (err: any) {
      showToast(err.message || 'Error loading users', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const canAdd = currentUser?.role === 'owner' || (currentUser?.role === 'admin' && currentUser?.adminPermissions?.canAddUsers);
  const canEdit = currentUser?.role === 'owner' || (currentUser?.role === 'admin' && currentUser?.adminPermissions?.canEditUsers);
  const canDeactivate = currentUser?.role === 'owner' || (currentUser?.role === 'admin' && currentUser?.adminPermissions?.canDeactivateUsers);
  const canDelete = currentUser?.role === 'owner' || currentUser?.role === 'admin' || (currentUser?.adminPermissions?.canDeleteUsers !== false);
  const canReset = currentUser?.role === 'owner' || currentUser?.role === 'admin' || (currentUser?.adminPermissions?.canResetPasswords !== false);

  // Handle Add User
  const handleAddUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formEmail.trim() || !formPassword.trim()) {
      showToast('Full name, email address, and initial password are required.', 'error');
      return;
    }

    if (formPassword.trim().length < 6) {
      showToast('Password must be at least 6 characters long.', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          email: formEmail.trim(),
          role: formRole,
          password: formPassword.trim(),
          notes: formNotes.trim(),
          adminPermissions: formRole === 'admin' ? formAdminPerms : undefined,
        }),
      });
      const data = await safeParseResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to create user');

      showToast(data.message || 'Team member created successfully!', 'success');
      setIsAddUserOpen(false);

      // Open credentials summary modal so admin can view/copy password or invite link directly
      setInfoModal({
        title: data.initialPassword ? 'User Created with Direct Password' : 'User Invitation Generated',
        username: data.user?.username,
        email: data.user?.email,
        role: data.user?.role,
        password: data.initialPassword,
        inviteUrl: data.inviteUrl,
        message: data.message,
      });

      setFormName('');
      setFormEmail('');
      setFormPassword('');
      setFormNotes('');
      setFormRole('stream_manager');
      loadUsers();
    } catch (err: any) {
      showToast(err.message || 'Error creating user', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Edit User
  const handleEditUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;

    setIsSubmitting(true);
    try {
      const res = await fetchWithAuth(`/api/users/${selectedUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: formName.trim(),
          role: formRole,
          notes: formNotes.trim(),
          adminPermissions: formRole === 'admin' ? formAdminPerms : undefined,
        }),
      });
      const data = await safeParseResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to update user');

      showToast('User updated successfully.', 'success');
      setIsEditUserOpen(false);
      setSelectedUser(null);
      loadUsers();
    } catch (err: any) {
      showToast(err.message || 'Error updating user', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Toggle Activate / Deactivate
  const handleToggleStatus = async (user: UserProfile) => {
    const action = user.isActive ? 'deactivate' : 'activate';
    if (!window.confirm(`Are you sure you want to ${action} user "${user.displayName || user.username}"?`)) {
      return;
    }

    setActionUserId(user.id);
    try {
      const res = await fetchWithAuth(`/api/users/${user.id}/toggle-status`, { method: 'POST' });
      const data = await safeParseResponse(res);
      if (!res.ok) throw new Error(data.error || `Failed to ${action} user`);

      showToast(data.message, 'success');
      loadUsers();
    } catch (err: any) {
      showToast(err.message || `Error toggling user status`, 'error');
    } finally {
      setActionUserId(null);
    }
  };

  // Open Password Reset Modal
  const handleSendReset = (user: UserProfile) => {
    if (!user.email) {
      showToast('User has no registered email address.', 'error');
      return;
    }
    setUserToReset(user);
  };

  // Confirm and Send Password Reset Email
  const confirmSendReset = async () => {
    if (!userToReset) return;
    setIsSendingReset(true);
    setActionUserId(userToReset.id);
    try {
      const res = await fetchWithAuth(`/api/users/${userToReset.id}/send-reset`, { method: 'POST' });
      const data = await safeParseResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to generate password reset');

      showToast(data.message || `Password reset verification code dispatched to ${userToReset.email}`, 'success');

      const targetUser = userToReset;
      setUserToReset(null);

      setInfoModal({
        title: 'Password Reset Verification Code Dispatched',
        username: targetUser.username,
        email: targetUser.email,
        otpCode: data.otpCode || data.simulatedOtp,
        message: data.message || `A single-use 6-digit verification code was emailed to ${targetUser.email}. Valid for 15 minutes.`,
      });
    } catch (err: any) {
      showToast(err.message || 'Error sending password reset email', 'error');
    } finally {
      setIsSendingReset(false);
      setActionUserId(null);
    }
  };

  // Resend Invite
  const handleResendInvite = async (user: UserProfile) => {
    setActionUserId(user.id);
    try {
      const res = await fetchWithAuth(`/api/users/${user.id}/resend-invite`, { method: 'POST' });
      const data = await safeParseResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to resend invitation');

      showToast(data.message || `Invitation link regenerated for ${user.email}`, 'success');

      setInfoModal({
        title: 'Team Invitation Link Regenerated',
        username: user.username,
        email: user.email,
        inviteUrl: data.inviteUrl,
        message: data.message,
      });
    } catch (err: any) {
      showToast(err.message || 'Error resending invitation', 'error');
    } finally {
      setActionUserId(null);
    }
  };

  // Open Delete Confirmation Modal
  const handleDeleteUser = (user: UserProfile) => {
    setUserToDelete(user);
  };

  // Confirm Delete User
  const confirmDeleteUser = async () => {
    if (!userToDelete) return;
    setIsDeleting(true);
    setActionUserId(userToDelete.id);
    try {
      const res = await fetchWithAuth(`/api/users/${userToDelete.id}`, { method: 'DELETE' });
      const data = await safeParseResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to delete user');

      showToast(data.message || 'User deleted successfully', 'success');
      setUserToDelete(null);
      setIsEditUserOpen(false);
      setSelectedUser(null);
      loadUsers();
    } catch (err: any) {
      showToast(err.message || 'Error deleting user', 'error');
    } finally {
      setIsDeleting(false);
      setActionUserId(null);
    }
  };

  // Filter users
  const filteredUsers = users.filter(u => {
    const matchesSearch =
      u.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (u.email && u.email.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesRole = roleFilter === 'all' || u.role === roleFilter;

    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' && u.isActive && !u.isPendingInvitation) ||
      (statusFilter === 'pending' && u.isPendingInvitation) ||
      (statusFilter === 'deactivated' && !u.isActive);

    return matchesSearch && matchesRole && matchesStatus;
  });

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[#E2E8F0]">
        <div>
          <h1 className="text-xl font-bold text-[#0F172A] tracking-tight flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-600" />
            <span>Team & Access Management</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Manage authorized operators, stream managers, and viewers. Protected with strict role-based authorization.
          </p>
        </div>

        {canAdd && (
          <button
            type="button"
            onClick={() => {
              setFormName('');
              setFormEmail('');
              setFormPassword('');
              setFormNotes('');
              setFormRole('stream_manager');
              setIsAddUserOpen(true);
            }}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-2 shadow-xs transition-colors cursor-pointer"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add Team Member</span>
          </button>
        )}
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by name, username, or email..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 bg-white text-xs text-slate-900 focus:outline-none focus:border-blue-600"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white text-xs text-slate-600">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>Role:</span>
            <select
              value={roleFilter}
              onChange={e => setRoleFilter(e.target.value)}
              className="bg-transparent font-medium text-slate-800 focus:outline-none cursor-pointer"
            >
              <option value="all">All Roles</option>
              <option value="owner">Owner</option>
              <option value="admin">Admin</option>
              <option value="stream_manager">Stream Manager</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white text-xs text-slate-600">
            <span>Status:</span>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="bg-transparent font-medium text-slate-800 focus:outline-none cursor-pointer"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active</option>
              <option value="pending">Pending Invite</option>
              <option value="deactivated">Deactivated</option>
            </select>
          </div>
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400 flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            <span className="text-xs font-medium">Loading team accounts...</span>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            <Users className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-800">No matching team members found</p>
            <p className="text-xs text-slate-400 mt-1">Try adjusting search query or role filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-100 text-slate-500 font-semibold uppercase tracking-wider">
                  <th className="py-3 px-4">User</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Last Login</th>
                  <th className="py-3 px-4">Created</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium">
                {filteredUsers.map(user => {
                  const isOwner = user.role === 'owner';
                  const isCurrent = currentUser?.id === user.id;

                  return (
                    <tr key={user.id} className="hover:bg-slate-50/60 transition-colors">
                      {/* Name & Email */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs uppercase shadow-xs ${
                            isOwner
                              ? 'bg-amber-100 text-amber-700 border border-amber-200'
                              : user.role === 'admin'
                              ? 'bg-purple-100 text-purple-700 border border-purple-200'
                              : 'bg-blue-100 text-blue-700 border border-blue-200'
                          }`}>
                            {user.displayName ? user.displayName.charAt(0) : user.username.charAt(0)}
                          </div>
                          <div>
                            <div className="font-bold text-slate-900 flex items-center gap-1.5">
                              <span>{user.displayName || user.username}</span>
                              {isCurrent && (
                                <span className="px-1.5 py-0.2 rounded-md bg-blue-50 text-blue-600 text-[10px] font-bold">
                                  You
                                </span>
                              )}
                            </div>
                            <div className="text-slate-400 font-mono text-[11px] flex items-center gap-1 mt-0.5">
                              <Mail className="w-3 h-3 text-slate-300" />
                              <span>{user.email || 'No email registered'}</span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Role Badge */}
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider ${
                          isOwner
                            ? 'bg-amber-50 text-amber-700 border border-amber-200'
                            : user.role === 'admin'
                            ? 'bg-purple-50 text-purple-700 border border-purple-200'
                            : user.role === 'stream_manager'
                            ? 'bg-blue-50 text-blue-700 border border-blue-200'
                            : 'bg-slate-100 text-slate-600 border border-slate-200'
                        }`}>
                          {isOwner && <ShieldAlert className="w-3 h-3 text-amber-600" />}
                          {user.role === 'admin' && <Shield className="w-3 h-3 text-purple-600" />}
                          <span>{user.role.replace('_', ' ')}</span>
                        </span>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4">
                        {!user.isActive ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 text-[11px] font-bold">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                            Deactivated
                          </span>
                        ) : user.isPendingInvitation ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 text-[11px] font-bold">
                            <Clock className="w-3 h-3 text-amber-500" />
                            Pending Invite
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-[11px] font-bold">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                            Active
                          </span>
                        )}
                      </td>

                      {/* Last Login */}
                      <td className="py-3 px-4 text-slate-500 font-mono text-[11px]">
                        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}
                      </td>

                      {/* Created */}
                      <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                        {new Date(user.createdAt).toLocaleDateString()}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {user.isPendingInvitation && (
                            <button
                              type="button"
                              onClick={() => handleResendInvite(user)}
                              disabled={actionUserId === user.id}
                              className="px-2 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                              title="Resend Invitation Link"
                            >
                              <Send className="w-3 h-3" />
                              <span>Resend</span>
                            </button>
                          )}

                          {canReset && user.email && !user.isPendingInvitation && (
                            <button
                              type="button"
                              onClick={() => handleSendReset(user)}
                              disabled={actionUserId === user.id}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors cursor-pointer"
                              title="Send Password Reset Email"
                            >
                              <KeyRound className="w-4 h-4" />
                            </button>
                          )}

                          {canEdit && (!isOwner || currentUser?.role === 'owner') && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedUser(user);
                                setFormName(user.displayName || user.username);
                                setFormRole(user.role);
                                setFormNotes(user.notes || '');
                                setFormAdminPerms(user.adminPermissions || {
                                  canAddUsers: true,
                                  canEditUsers: true,
                                  canResetPasswords: true,
                                  canDeactivateUsers: true,
                                  canDeleteUsers: true,
                                });
                                setIsEditUserOpen(true);
                              }}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                              title="Edit User"
                            >
                              <MoreVertical className="w-4 h-4" />
                            </button>
                          )}

                          {canDeactivate && (!isOwner || currentUser?.role === 'owner') && (
                            <button
                              type="button"
                              onClick={() => handleToggleStatus(user)}
                              disabled={actionUserId === user.id}
                              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                                user.isActive
                                  ? 'text-slate-400 hover:text-amber-600 hover:bg-amber-50'
                                  : 'text-emerald-600 hover:bg-emerald-50'
                              }`}
                              title={user.isActive ? 'Deactivate User' : 'Activate User'}
                            >
                              {user.isActive ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                            </button>
                          )}

                          {canDelete && (!isOwner || currentUser?.role === 'owner') && (
                            <button
                              type="button"
                              onClick={() => handleDeleteUser(user)}
                              disabled={actionUserId === user.id}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                              title="Delete Account"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* MODAL 1: Add / Invite New User */}
      {isAddUserOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden animate-in fade-in">
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm text-slate-900">Add or Invite Team Member</h3>
                <p className="text-xs text-slate-500 mt-0.5">Set a password directly OR leave blank to send an email invitation.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsAddUserOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddUserSubmit} className="p-5 space-y-4">
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">Full Name</label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g. Alex Morgan"
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">Email Address</label>
                <input
                  type="email"
                  required
                  value={formEmail}
                  onChange={e => setFormEmail(e.target.value)}
                  placeholder="alex@team.com"
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
                />
              </div>

              {/* REQUIRED PASSWORD FIELD */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-blue-600" />
                    <span>Password</span>
                  </span>
                  <span className="text-rose-500 text-[11px] font-medium">*Required (min 6 chars)</span>
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={formPassword}
                  onChange={e => setFormPassword(e.target.value)}
                  placeholder="Enter initial password for new account..."
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono text-slate-900 focus:outline-none focus:border-blue-600"
                />
                <p className="text-[11px] text-slate-500 leading-normal">
                  Required password for initial account setup and sign in.
                </p>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">Assigned Role</label>
                <select
                  value={formRole}
                  onChange={e => setFormRole(e.target.value as UserRole)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-blue-600 bg-white cursor-pointer"
                >
                  <option value="stream_manager">Stream Manager (Control streams, media, schedules)</option>
                  <option value="viewer">Viewer (Read-only status inspection)</option>
                  {currentUser?.role === 'owner' && (
                    <option value="admin">Administrator (Permissions delegated by Owner)</option>
                  )}
                </select>
              </div>

              {formRole === 'admin' && currentUser?.role === 'owner' && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <span className="block text-xs font-bold text-slate-800">Administrator Delegated Permissions:</span>
                  <div className="grid grid-cols-2 gap-2 text-xs text-slate-700">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canAddUsers}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canAddUsers: e.target.checked })}
                      />
                      <span>Can Add Users</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canEditUsers}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canEditUsers: e.target.checked })}
                      />
                      <span>Can Edit Users</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canResetPasswords}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canResetPasswords: e.target.checked })}
                      />
                      <span>Can Reset Passwords</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canDeactivateUsers}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canDeactivateUsers: e.target.checked })}
                      />
                      <span>Can Deactivate Users</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canDeleteUsers}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canDeleteUsers: e.target.checked })}
                      />
                      <span>Can Delete Users</span>
                    </label>
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">Account Notes (Optional)</label>
                <textarea
                  rows={2}
                  value={formNotes}
                  onChange={e => setFormNotes(e.target.value)}
                  placeholder="e.g. Broadcast shift operator"
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-blue-600 resize-none"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddUserOpen(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-2 shadow-xs cursor-pointer disabled:opacity-60"
                >
                  {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  <span>Create User</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Edit User */}
      {isEditUserOpen && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden animate-in fade-in">
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm text-slate-900">Edit User: {selectedUser.username}</h3>
                <p className="text-xs text-slate-500 mt-0.5">Modify role assignment and operational permissions.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsEditUserOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleEditUserSubmit} className="p-5 space-y-4">
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">Display Name</label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">Assigned Role</label>
                <select
                  value={formRole}
                  onChange={e => setFormRole(e.target.value as UserRole)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-blue-600 bg-white cursor-pointer"
                >
                  <option value="stream_manager">Stream Manager (Control streams, media, schedules)</option>
                  <option value="viewer">Viewer (Read-only status inspection)</option>
                  {currentUser?.role === 'owner' && (
                    <option value="admin">Administrator (Permissions delegated by Owner)</option>
                  )}
                </select>
              </div>

              {formRole === 'admin' && currentUser?.role === 'owner' && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <span className="block text-xs font-bold text-slate-800">Administrator Delegated Permissions:</span>
                  <div className="grid grid-cols-2 gap-2 text-xs text-slate-700">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canAddUsers}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canAddUsers: e.target.checked })}
                      />
                      <span>Can Add Users</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canEditUsers}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canEditUsers: e.target.checked })}
                      />
                      <span>Can Edit Users</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canResetPasswords}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canResetPasswords: e.target.checked })}
                      />
                      <span>Can Reset Passwords</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canDeactivateUsers}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canDeactivateUsers: e.target.checked })}
                      />
                      <span>Can Deactivate Users</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formAdminPerms.canDeleteUsers}
                        onChange={e => setFormAdminPerms({ ...formAdminPerms, canDeleteUsers: e.target.checked })}
                      />
                      <span>Can Delete Users</span>
                    </label>
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">Notes</label>
                <textarea
                  rows={2}
                  value={formNotes}
                  onChange={e => setFormNotes(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-blue-600 resize-none"
                />
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {canReset && selectedUser.email && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditUserOpen(false);
                        handleSendReset(selectedUser);
                      }}
                      className="px-3 py-2 rounded-xl border border-blue-200 text-blue-600 hover:bg-blue-50 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>Send Password Reset</span>
                    </button>
                  )}
                  {canDelete && (!selectedUser.role || selectedUser.role !== 'owner' || currentUser?.role === 'owner') && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditUserOpen(false);
                        handleDeleteUser(selectedUser);
                      }}
                      className="px-3 py-2 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete Account</span>
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsEditUserOpen(false)}
                    className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs cursor-pointer disabled:opacity-60"
                  >
                    {isSubmitting ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: Credentials / Link / OTP Summary Modal */}
      {infoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden animate-in fade-in space-y-4 p-6">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-slate-900">{infoModal.title}</h3>
                  <p className="text-xs text-slate-500">{infoModal.message || 'Action completed successfully.'}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInfoModal(null)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-3 text-xs text-slate-800">
              {infoModal.username && (
                <div className="flex justify-between items-center py-1 border-b border-slate-200/60">
                  <span className="text-slate-500 font-medium">Username:</span>
                  <span className="font-mono font-bold text-slate-900">{infoModal.username}</span>
                </div>
              )}

              {infoModal.email && (
                <div className="flex justify-between items-center py-1 border-b border-slate-200/60">
                  <span className="text-slate-500 font-medium">Registered Email:</span>
                  <span className="font-mono font-bold text-slate-900">{infoModal.email}</span>
                </div>
              )}

              {infoModal.password && (
                <div className="space-y-1 pt-1">
                  <span className="text-slate-500 font-medium block">Direct Account Password:</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={infoModal.password}
                      className="flex-1 px-3 py-2 rounded-lg bg-white border border-slate-300 font-mono font-bold text-emerald-700 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => handleCopy(infoModal.password!, 'pass')}
                      className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold flex items-center gap-1 cursor-pointer"
                    >
                      {copiedField === 'pass' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>Copy</span>
                    </button>
                  </div>
                </div>
              )}

              {infoModal.otpCode && (
                <div className="space-y-1 pt-1">
                  <span className="text-slate-500 font-medium block">Password Reset OTP Code (6 Digits):</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={infoModal.otpCode}
                      className="flex-1 px-3 py-2 rounded-lg bg-white border border-slate-300 font-mono font-bold text-blue-700 text-sm tracking-widest text-center"
                    />
                    <button
                      type="button"
                      onClick={() => handleCopy(infoModal.otpCode!, 'otp')}
                      className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold flex items-center gap-1 cursor-pointer"
                    >
                      {copiedField === 'otp' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>Copy Code</span>
                    </button>
                  </div>
                </div>
              )}

              {infoModal.inviteUrl && (
                <div className="space-y-1 pt-1">
                  <span className="text-slate-500 font-medium block">Expiring Invitation Link:</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={infoModal.inviteUrl}
                      className="flex-1 px-3 py-2 rounded-lg bg-white border border-slate-300 font-mono text-[11px] text-slate-800 truncate"
                    />
                    <button
                      type="button"
                      onClick={() => handleCopy(infoModal.inviteUrl!, 'url')}
                      className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white font-bold flex items-center gap-1 cursor-pointer whitespace-nowrap"
                    >
                      {copiedField === 'url' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>Copy Link</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setInfoModal(null)}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: Delete Account Confirmation Modal */}
      {userToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-rose-100 overflow-hidden animate-in fade-in p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-base text-slate-900">Delete User Account?</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  This action is permanent and cannot be undone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setUserToDelete(null)}
                disabled={isDeleting}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3.5 bg-rose-50/70 border border-rose-200/80 rounded-xl text-xs space-y-2 text-rose-950">
              <p>
                Are you sure you want to delete <strong className="font-bold text-rose-900">{userToDelete.displayName || userToDelete.username}</strong> ({userToDelete.email || 'No email'})?
              </p>
              <ul className="list-disc list-inside text-[11px] text-rose-800/90 space-y-1 pt-1 border-t border-rose-200/60">
                <li>Active login sessions for this account will be immediately revoked.</li>
                <li>Live streams, YouTube destinations, and video assets created by this user will remain safely preserved.</li>
              </ul>
              {currentUser?.id === userToDelete.id && (
                <div className="p-2 bg-red-100 border border-red-300 rounded-lg font-bold text-red-900 text-[11px] mt-2">
                  ⚠️ WARNING: You are deleting your own active account. You will be logged out immediately upon deletion.
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setUserToDelete(null)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteUser}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{isDeleting ? 'Deleting...' : 'Permanently Delete'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 5: Password Reset Confirmation Modal */}
      {userToReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-blue-100 overflow-hidden animate-in fade-in p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
                <KeyRound className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-base text-slate-900">Send Password Reset Email?</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Dispatches a secure recovery verification code to the user.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setUserToReset(null)}
                disabled={isSendingReset}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3.5 bg-blue-50/70 border border-blue-200/80 rounded-xl text-xs space-y-2 text-blue-950">
              <p>
                Trigger password recovery for <strong className="font-bold text-blue-900">{userToReset.displayName || userToReset.username}</strong>?
              </p>
              <div className="flex items-center gap-2 p-2 bg-white rounded-lg border border-blue-100 font-mono text-xs text-slate-800">
                <Mail className="w-4 h-4 text-blue-600 shrink-0" />
                <span className="truncate">{userToReset.email}</span>
              </div>
              <ul className="list-disc list-inside text-[11px] text-blue-800/90 space-y-1 pt-1 border-t border-blue-200/60">
                <li>A single-use 6-digit verification OTP code will be sent to this email address.</li>
                <li>The code will remain active for 15 minutes.</li>
                <li>Any existing unverified password reset codes for this account will be invalidated immediately.</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setUserToReset(null)}
                disabled={isSendingReset}
                className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSendReset}
                disabled={isSendingReset}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isSendingReset ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Dispatching...</span>
                  </>
                ) : (
                  <>
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>Send Password Reset</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
