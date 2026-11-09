import React, { useEffect, useState } from 'react';
import { Check, Trash2, UserPlus } from 'lucide-react';
import { api } from '../../services/api';
import { StaffMember, WorkspaceSummary } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { ROLE_LABELS } from '../../components/layout/AppHeader';
import { ErrorNote, Field, Modal } from '../../components/ui/Modal';

const ROLE_HELP = {
  superadmin: 'Admin: every campaign in this workspace, analytics for all, manages the team.',
  recruiter: 'Recruiter (HR member): creates and runs their own campaigns; sees only those.'
};

type SignIn = 'google' | 'password';
type AddRole = 'recruiter' | 'superadmin';

/** canAddAdmins: only an Admin may add Admins; an HR lead adds HR members (recruiters) only. */
const AddMemberModal: React.FC<{ canAddAdmins: boolean; onClose: () => void; onAdded: (m: StaffMember, signIn: SignIn) => void }> = ({ canAddAdmins, onClose, onAdded }) => {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'recruiter' as AddRole, sign_in: 'google' as SignIn });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { password, ...rest } = form;
      const fields = { ...rest, role: canAddAdmins ? rest.role : 'recruiter' as AddRole };
      onAdded(await api.addTeamMember(form.sign_in === 'password' ? { ...fields, password } : fields), form.sign_in);
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={canAddAdmins ? 'Add a team member' : 'Add an HR member'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorNote message={error} />
        <Field label="Name"><input className="input" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="Work email" hint={form.sign_in === 'google' ? 'Use the email of the Google account they will sign in with.' : undefined}>
          <input className="input" type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="How they sign in">
          <div className="segmented" role="group" aria-label="How they sign in">
            <button type="button" aria-pressed={form.sign_in === 'google'} onClick={() => setForm({ ...form, sign_in: 'google' })}>Google</button>
            <button type="button" aria-pressed={form.sign_in === 'password'} onClick={() => setForm({ ...form, sign_in: 'password' })}>Password</button>
          </div>
        </Field>
        {form.sign_in === 'password' && (
          <Field label="Temporary password" hint="At least 8 characters. Share it with them privately; they sign in on the HR tab.">
            <input className="input" type="text" required minLength={8} autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          </Field>
        )}
        {canAddAdmins ? (
          <Field label="Role" hint={ROLE_HELP[form.role]}>
            <select className="select" value={form.role} onChange={e => setForm({ ...form, role: e.target.value as AddRole })}>
              <option value="recruiter">Recruiter</option>
              <option value="superadmin">Admin</option>
            </select>
          </Field>
        ) : (
          <p className="small muted">{ROLE_HELP.recruiter}</p>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add member'}</button>
        </div>
      </form>
    </Modal>
  );
};

/** Demo workspaces: how much of each limit is used. */
const LimitsNote: React.FC<{ workspace: WorkspaceSummary }> = ({ workspace }) => {
  const { limits, usage } = workspace;
  if (!limits || !usage) return null;
  const parts = [
    limits.max_campaigns !== null && `${usage.campaigns} of ${limits.max_campaigns} campaigns`,
    limits.max_members !== null && `${usage.members} of ${limits.max_members} team members`,
    limits.max_completed_calls !== null && `${usage.completed_calls} of ${limits.max_completed_calls} calls`,
    limits.max_emails_per_day !== null && `${usage.emails_last_24h} of ${limits.max_emails_per_day} invite emails today`,
    limits.max_candidates_per_campaign !== null && `up to ${limits.max_candidates_per_campaign} candidates per campaign`
  ].filter(Boolean);
  return <p className="small muted mt-sm">Demo workspace: {parts.join(' · ')}.</p>;
};

/** Admins and HR leads: the HR team of their own workspace. */
export const TeamPage: React.FC = () => {
  const { currentUser } = useAppStore();
  const isAdmin = currentUser?.role === 'superadmin';
  const [team, setTeam] = useState<StaffMember[] | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => Promise.all([
    api.team().then(setTeam),
    api.workspace().then(setWorkspace)
  ]).catch(err => setError(err.message));
  useEffect(() => { load(); }, []);

  const act = async (id: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(id);
    setError(null);
    try { await fn(); setNotice(message); await load(); } catch (err: any) { setError(err.message); } finally { setBusy(null); }
  };

  /** An HR lead may remove HR members (recruiters) only; an Admin anyone but themselves. */
  const canRemove = (m: StaffMember) => !m.is_you && (isAdmin || m.role === 'recruiter');

  return (
    <div>
      <div className="page-head">
        <div>
          <span className="eyebrow">Team{workspace ? ` · ${workspace.name}` : ''}</span>
          <h1>HR team</h1>
          <p className="muted">{isAdmin
            ? 'Admins see every campaign in this workspace; recruiters see only the campaigns they create.'
            : 'You see every campaign in your workspace; HR members see only the campaigns they create.'}</p>
          {workspace && <LimitsNote workspace={workspace} />}
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><UserPlus size={16} /> Add member</button>
      </div>
      <ErrorNote message={error} />
      {notice && <div className="alert" role="status"><Check size={15} /><span>{notice}</span></div>}
      {!team && !error && <p className="muted">Loading…</p>}

      {team && (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th className="num">Campaigns</th><th className="actions"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {team.map(m => (
                  <tr key={m.id}>
                    <td className="strong">{m.name || '—'}{m.is_you && <span className="tag" style={{ marginLeft: 8 }}>you</span>}</td>
                    <td className="muted">{m.email}</td>
                    <td>
                      {isAdmin && !m.is_you && m.role !== 'hr_lead' ? (
                        <select className="select" style={{ height: 32, width: 130 }} value={m.role} disabled={busy !== null} aria-label={`Role of ${m.name || m.email}`}
                          onChange={e => act(m.id, () => api.setTeamRole(m.id, e.target.value as AddRole), `${m.name || m.email} is now ${e.target.value === 'superadmin' ? 'an Admin' : 'a Recruiter'}.`)}>
                          <option value="recruiter">Recruiter</option>
                          <option value="superadmin">Admin</option>
                        </select>
                      ) : (
                        <span className={m.is_you ? 'badge badge-solid' : 'badge'}>{ROLE_LABELS[m.role]}</span>
                      )}
                    </td>
                    <td className="num">{m.campaigns}</td>
                    <td className="actions">
                      {canRemove(m) && (
                        <button className="btn btn-ghost btn-icon" disabled={busy !== null} aria-label={`Remove ${m.name || m.email}`} title="Remove"
                          onClick={() => window.confirm(`Remove ${m.name || m.email}? Their ${m.campaigns} campaign(s) move to you.`) && act(m.id, () => api.removeTeamMember(m.id), `${m.name || m.email} was removed.`)}>
                          <Trash2 size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adding && <AddMemberModal canAddAdmins={isAdmin} onClose={() => setAdding(false)} onAdded={(m, signIn) => {
        setAdding(false);
        const as = m.role === 'superadmin' ? 'an Admin' : 'an HR member (Recruiter)';
        setNotice(signIn === 'google'
          ? `${m.name} was added as ${as}. They sign in on the HR tab with "Continue with Google", using ${m.email}.`
          : `${m.name} was added as ${as}. Share their email and temporary password with them.`);
        load();
      }} />}
    </div>
  );
};
