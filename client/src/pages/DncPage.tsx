import React, { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { PhoneOff, Plus, Trash2, Search, ShieldCheck } from 'lucide-react';

export const DncPage: React.FC = () => {
  const { activeTenant, addNotification } = useAppStore();
  const [dncList, setDncList] = useState([
    { id: 'dnc_1', phone: '+91 93123 45678', reason: 'Customer requested DNC during call', date: '2026-09-24' },
    { id: 'dnc_2', phone: '+91 91122 33445', reason: 'TRAI National NDNC Registry Screen', date: '2026-09-22' },
    { id: 'dnc_3', phone: '+91 98888 77777', reason: 'Opt-out SMS response received', date: '2026-09-20' }
  ]);
  const [newPhone, setNewPhone] = useState('');
  const [newReason, setNewReason] = useState('Manual Operator Blacklist');
  const [showAdd, setShowAdd] = useState(false);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPhone.trim()) return;

    setDncList(prev => [
      { id: `dnc_${Date.now()}`, phone: newPhone.trim(), reason: newReason, date: 'Today' },
      ...prev
    ]);

    addNotification({
      title: 'Number Added to DNC',
      message: `${newPhone} will be strictly blocked across all outbound campaigns.`,
      type: 'warning'
    });

    setNewPhone('');
    setShowAdd(false);
  };

  const handleDelete = (id: string) => {
    setDncList(prev => prev.filter(item => item.id !== id));
  };

  return (
    <div className="lx-page show">
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 18 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <PhoneOff size={24} color="var(--lx-red)" />
            Do Not Call (DNC) Compliance Registry
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Pre-Dial Screening, Compliance Blacklists & Explicit Opt-Outs ({activeTenant.toUpperCase()})
          </span>
        </div>

        <button 
          type="button" 
          className="lx-restored-btn primary"
          onClick={() => setShowAdd(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <Plus size={14} /> Add Blocked Number
        </button>
      </div>

      <div style={{ background: 'var(--lx-card)', border: '1px solid var(--lx-border)', borderRadius: 14, overflow: 'hidden' }}>
        <table className="lx-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--lx-border)' }}>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>Blocked Phone Number</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>Block Reason / Source</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>Date Added</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {dncList.map((row) => (
              <tr key={row.id} style={{ borderBottom: '1px solid var(--lx-border)' }}>
                <td style={{ padding: '12px 18px' }}>
                  <code style={{ fontFamily: 'var(--lx-mono)', color: 'var(--lx-red)', fontWeight: 600 }}>{row.phone}</code>
                </td>
                <td style={{ padding: '12px 18px', color: 'var(--lx-text)' }}>{row.reason}</td>
                <td style={{ padding: '12px 18px', color: 'var(--lx-muted)', fontSize: 12 }}>{row.date}</td>
                <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                  <button 
                    type="button" 
                    className="lx-action-btn lx-action-btn--delete"
                    onClick={() => handleDelete(row.id)}
                    title="Remove from blacklist"
                  >
                    <Trash2 size={12} /> Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div className="lx-restored-modal show" onClick={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}>
          <div className="lx-restored-box" style={{ maxWidth: 420 }}>
            <h3>Add Number to DNC Registry</h3>
            <p className="lx-restored-msg">Prevent any campaign dialer from contacting this phone.</p>
            <form onSubmit={handleAdd}>
              <label>Phone Number (E.164)</label>
              <input 
                type="text" 
                className="lx-input" 
                required 
                placeholder="+91 98765 43210"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
              />

              <label>Reason</label>
              <input 
                type="text" 
                className="lx-input" 
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
              />

              <div className="lx-restored-actions" style={{ marginTop: 20 }}>
                <button type="button" className="lx-restored-btn" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="lx-restored-btn danger">Block Number</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
