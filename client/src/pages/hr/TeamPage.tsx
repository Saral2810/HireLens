import React, { useEffect, useState } from 'react';
import { Check, Trash2, UserPlus } from 'lucide-react';
import { api } from '../../services/api';
import { StaffMember } from '../../types';
import { ErrorNote, Field, Modal } from '../../components/ui/Modal';

const ROLE_HELP = {
  superadmin: 'Admin: every campaign, analytics for all, manages the team.',
  recruiter: 'Recruiter: creates and runs their own campaigns; sees only those.'
};

type SignIn = 'google' | 'password';

const AddMemberModal: React.FC<{ onClose: () => void; onAdded: (m: StaffMember, signIn: SignIn) => void }> = ({ onClose, onAdded }) => {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'recruiter' as 'recruiter' | 'superadmin', sign_in: 'google' as SignIn });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { password, ...rest } = form;
      onAdded(await api.addTeamMember(form.sign_in === 'password' ? { ...rest, password } : rest), form.sign_in);
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title="Add a team member" onClose={onClose}>
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
        <Field label="Role" hint={ROLE_HELP[form.role]}>
          <select className="select" value={form.role} onChange={e => setForm({ ...form, role: e.target.value as 'recruiter' | 'superadmin' })}>
            <option value="recruiter">Recruiter</option>
            <option value="superadmin">Admin</option>
          </select>
        </Field>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add member'}</button>
        </div>
      </form>
    </Modal>
  );
};

/** Admin only: the HR team (Admins and Recruiters). */
export const TeamPage: React.FC = () => {
  const [team, setTeam] = useState<StaffMember[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.team().then(setTeam).catch(err => setError(err.message));
  useEffect(() => { load(); }, []);

  const act = async (id: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(id);
    setError(null);
    try { await fn(); setNotice(message); await load(); } catch (err: any) { setError(err.message); } finally { setBusy(null); }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <span className="eyebrow">Team</span>
          <h1>HR team</h1>
          <p className="muted">Admins see every campaign; recruiters see only the campaigns they create.</p>
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
                      {m.is_you ? <span className="badge badge-solid">Admin</span> : (
                        <select className="select" style={{ height: 32, width: 130 }} value={m.role} disabled={busy !== null} aria-label={`Role of ${m.name || m.email}`}
                          onChange={e => act(m.id, () => api.setTeamRole(m.id, e.target.value as 'recruiter' | 'superadmin'), `${m.name || m.email} is now ${e.target.value === 'superadmin' ? 'an Admin' : 'a Recruiter'}.`)}>
                          <option value="recruiter">Recruiter</option>
                          <option value="superadmin">Admin</option>
                        </select>
                      )}
                    </td>
                    <td className="num">{m.campaigns}</td>
                    <td className="actions">
                      {!m.is_you && (
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

      {adding && <AddMemberModal onClose={() => setAdding(false)} onAdded={(m, signIn) => {
        setAdding(false);
        const as = m.role === 'superadmin' ? 'an Admin' : 'a Recruiter';
        setNotice(signIn === 'google'
          ? `${m.name} was added as ${as}. They sign in on the HR tab with "Continue with Google", using ${m.email}.`
          : `${m.name} was added as ${as}. Share their email and temporary password with them.`);
        load();
      }} />}
    </div>
  );
};
