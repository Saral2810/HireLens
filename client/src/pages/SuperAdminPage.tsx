import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { api } from '../services/api';
import { Tenant, TenantUser } from '../types';
import { 
  ShieldCheck, 
  Users, 
  Plus, 
  Key, 
  Copy, 
  Check, 
  RefreshCw, 
  Trash2, 
  Building2,
  Lock
} from 'lucide-react';

export const SuperAdminPage: React.FC = () => {
  const { isSuperAdmin, activeTenant, addNotification } = useAppStore();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string>(activeTenant);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // New User Form State
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState<'admin' | 'member' | 'owner'>('admin');
  const [newUserPassword, setNewUserPassword] = useState('');

  // New Tenant Form State
  const [showAddTenant, setShowAddTenant] = useState(false);
  const [newTenantId, setNewTenantId] = useState('');
  const [newTenantName, setNewTenantName] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const [tList, uList] = await Promise.all([
        api.getTenants(),
        api.getTenantUsers(selectedTenant)
      ]);
      setTenants(tList);
      setUsers(uList);
    } catch {
      setTenants([]);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [selectedTenant]);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createTenantUser(selectedTenant, {
        email: newUserEmail,
        role: newUserRole,
        password: newUserPassword || undefined
      });
      addNotification({
        title: 'User Provisioned',
        message: `Account created for ${newUserEmail} in ${selectedTenant}.`,
        type: 'success'
      });
      setShowAddUser(false);
      setNewUserEmail('');
      setNewUserPassword('');
      loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to create user');
    }
  };

  const handleCreateTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createTenant({
        id: newTenantId.trim().toLowerCase(),
        name: newTenantName.trim()
      });
      addNotification({
        title: 'Workspace Created',
        message: `New workspace "${newTenantName}" provisioned.`,
        type: 'success'
      });
      setShowAddTenant(false);
      setNewTenantId('');
      setNewTenantName('');
      loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to create workspace');
    }
  };

  const handleResetPassword = async (user: TenantUser) => {
    try {
      const res = await api.resetTenantUserPassword(selectedTenant, user.id);
      addNotification({
        title: 'Password Reset',
        message: `New credentials generated for ${user.email}.`,
        type: 'success'
      });
      if (res.new_password) {
        alert(`New Password for ${user.email}:\n\n${res.new_password}`);
      }
      loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to reset password');
    }
  };

  const handleDeleteUser = async (user: TenantUser) => {
    if (!confirm(`Are you sure you want to delete ${user.email}?`)) return;
    try {
      await api.deleteTenantUser(selectedTenant, user.id);
      addNotification({
        title: 'User Removed',
        message: `${user.email} removed from ${selectedTenant}.`,
        type: 'info'
      });
      loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to delete user');
    }
  };

  return (
    <div className="lx-page show">
      {/* Title */}
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 18 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <ShieldCheck size={24} color="var(--lx-accent)" />
            {isSuperAdmin ? 'Super-Admin Control Plane' : 'Workspace Client Settings'}
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Manage Client Workspaces, RBAC Permissions & Shareable Credentials
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          {isSuperAdmin && (
            <button 
              type="button" 
              className="lx-btn"
              onClick={() => setShowAddTenant(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <Building2 size={14} /> New Workspace
            </button>
          )}
          <button 
            type="button" 
            className="lx-restored-btn primary"
            onClick={() => setShowAddUser(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <Plus size={14} /> Provision User
          </button>
        </div>
      </div>

      {/* Workspace Switcher Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, borderBottom: '1px solid var(--lx-border)', paddingBottom: 6 }}>
        {tenants.map(t => (
          <button
            key={t.id}
            type="button"
            className={`lx-restored-btn ${selectedTenant === t.id ? 'active' : ''}`}
            onClick={() => setSelectedTenant(t.id)}
            style={{ 
              background: selectedTenant === t.id ? 'rgba(99,102,241,0.15)' : 'transparent',
              color: selectedTenant === t.id ? 'var(--lx-accent)' : 'var(--lx-muted)',
              border: 'none',
              fontWeight: 600,
              fontSize: 13
            }}
          >
            {t.name} <code style={{ fontSize: 10, opacity: 0.7 }}>({t.id})</code>
          </button>
        ))}
      </div>

      {/* Users & Credentials Table */}
      <div style={{ background: 'var(--lx-card)', border: '1px solid var(--lx-border)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--lx-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
              Client Operator Credentials ({selectedTenant.toUpperCase()})
            </h3>
            <span style={{ fontSize: 11.5, color: 'var(--lx-muted)' }}>
              Accounts with direct operational access to this workspace
            </span>
          </div>
          <button type="button" className="lx-btn lx-btn-small" onClick={loadData}>
            <RefreshCw size={13} />
          </button>
        </div>

        <table className="lx-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--lx-border)' }}>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>User Email</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>Role</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>Credential Token / Password</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: 32, color: 'var(--lx-muted)' }}>
                  No users provisioned for this workspace yet.
                </td>
              </tr>
            ) : (
              users.map(u => (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--lx-border)' }}>
                  <td style={{ padding: '12px 18px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--lx-text)' }}>{u.email}</div>
                    <div style={{ fontSize: 11, color: 'var(--lx-muted)', fontFamily: 'var(--lx-mono)' }}>ID: {u.id}</div>
                  </td>

                  <td style={{ padding: '12px 18px' }}>
                    <span className={`lx-badge ${u.role === 'admin' ? 'badge-blue' : 'badge-gray'}`}>
                      {u.role.toUpperCase()}
                    </span>
                  </td>

                  <td style={{ padding: '12px 18px' }}>
                    <div className="lx-pwd-capsule">
                      <code>{u.plain_password || '••••••••••••'}</code>
                      <button 
                        type="button" 
                        className="lx-pwd-icon-btn"
                        onClick={() => handleCopy(u.plain_password || '', u.id)}
                        title="Copy password to clipboard"
                      >
                        {copiedId === u.id ? <Check size={12} color="var(--lx-green)" /> : <Copy size={12} />}
                      </button>
                    </div>
                  </td>

                  <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button 
                        type="button" 
                        className="lx-action-btn lx-action-btn--reset"
                        onClick={() => handleResetPassword(u)}
                        title="Regenerate password"
                      >
                        <RefreshCw size={12} /> Reset
                      </button>
                      <button 
                        type="button" 
                        className="lx-action-btn lx-action-btn--delete"
                        onClick={() => handleDeleteUser(u)}
                        title="Revoke access"
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Provision User Modal */}
      {showAddUser && (
        <div className="lx-restored-modal show" onClick={(e) => { if (e.target === e.currentTarget) setShowAddUser(false); }}>
          <div className="lx-restored-box" style={{ maxWidth: 440 }}>
            <h3>Provision Workspace User</h3>
            <p className="lx-restored-msg">Target Workspace: <strong style={{ color: 'var(--lx-accent)' }}>{selectedTenant}</strong></p>
            <form onSubmit={handleCreateUser}>
              <label>User Email</label>
              <input 
                type="email" 
                className="lx-input" 
                required 
                placeholder="operator@client.com"
                value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)}
              />

              <label>Role</label>
              <select 
                className="lx-input" 
                value={newUserRole}
                onChange={(e) => setNewUserRole(e.target.value as any)}
              >
                <option value="admin">Admin (Full Access & Configuration)</option>
                <option value="member">Member (Operator / Viewer)</option>
                <option value="owner">Owner (Full Workspace Ownership)</option>
              </select>

              <label>Password (Leave blank to auto-generate)</label>
              <input 
                type="text" 
                className="lx-input" 
                placeholder="Auto-generates secure password"
                value={newUserPassword}
                onChange={(e) => setNewUserPassword(e.target.value)}
              />

              <div className="lx-restored-actions" style={{ marginTop: 20 }}>
                <button type="button" className="lx-restored-btn" onClick={() => setShowAddUser(false)}>Cancel</button>
                <button type="submit" className="lx-restored-btn primary">Provision User</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Tenant Modal */}
      {showAddTenant && (
        <div className="lx-restored-modal show" onClick={(e) => { if (e.target === e.currentTarget) setShowAddTenant(false); }}>
          <div className="lx-restored-box" style={{ maxWidth: 440 }}>
            <h3>Provision New Client Workspace</h3>
            <p className="lx-restored-msg">Create an isolated multi-tenant organization</p>
            <form onSubmit={handleCreateTenant}>
              <label>Tenant ID (Slug)</label>
              <input 
                type="text" 
                className="lx-input" 
                required 
                placeholder="e.g. acme-finance"
                value={newTenantId}
                onChange={(e) => setNewTenantId(e.target.value)}
              />

              <label>Organization Name</label>
              <input 
                type="text" 
                className="lx-input" 
                required 
                placeholder="e.g. Acme Auto Finance"
                value={newTenantName}
                onChange={(e) => setNewTenantName(e.target.value)}
              />

              <div className="lx-restored-actions" style={{ marginTop: 20 }}>
                <button type="button" className="lx-restored-btn" onClick={() => setShowAddTenant(false)}>Cancel</button>
                <button type="submit" className="lx-restored-btn primary">Create Workspace</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
