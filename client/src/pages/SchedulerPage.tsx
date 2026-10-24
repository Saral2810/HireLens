import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { api } from '../services/api';
import { ScheduledJob } from '../types';
import { CalendarClock, Play, Clock, CheckCircle2, RefreshCw } from 'lucide-react';

export const SchedulerPage: React.FC = () => {
  const { activeTenant, addNotification } = useAppStore();
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(false);

  const loadJobs = async () => {
    setLoading(true);
    try {
      const list = await api.getScheduledJobs();
      setJobs(list);
    } catch {
      // fallback
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
  }, [activeTenant]);

  const handleTrigger = async (job: ScheduledJob) => {
    try {
      await api.triggerJobNow(job.id);
      addNotification({
        title: 'Job Triggered Manually',
        message: `Execution dispatched for "${job.name}".`,
        type: 'success'
      });
    } catch (e: any) {
      alert(e.message || 'Trigger failed');
    }
  };

  return (
    <div className="lx-page show">
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 18 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <CalendarClock size={24} color="var(--lx-accent)" />
            Persistent Job Scheduler & BullMQ Queues
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Automated Calling Windows, Follow-up Cron Triggers & Queue Retries ({activeTenant.toUpperCase()})
          </span>
        </div>
      </div>

      <div style={{ background: 'var(--lx-card)', border: '1px solid var(--lx-border)', borderRadius: 14, overflow: 'hidden' }}>
        <table className="lx-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--lx-border)' }}>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>Job Name</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>Cron Schedule</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>Status</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)' }}>Next Trigger Window</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', color: 'var(--lx-muted)', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} style={{ borderBottom: '1px solid var(--lx-border)' }}>
                <td style={{ padding: '12px 18px' }}>
                  <div style={{ fontWeight: 600, color: 'var(--lx-text)' }}>{job.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--lx-muted)', fontFamily: 'var(--lx-mono)' }}>ID: {job.id}</div>
                </td>

                <td style={{ padding: '12px 18px' }}>
                  <code style={{ background: 'rgba(255,255,255,0.05)', padding: '3px 7px', borderRadius: 4, color: 'var(--lx-accent)' }}>
                    {job.schedule_cron}
                  </code>
                </td>

                <td style={{ padding: '12px 18px' }}>
                  <span className="lx-badge badge-green">
                    ● {job.status.toUpperCase()}
                  </span>
                </td>

                <td style={{ padding: '12px 18px', color: 'var(--lx-muted)', fontSize: 12 }}>
                  {job.next_run || '10:00 AM IST'}
                </td>

                <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                  <button 
                    type="button" 
                    className="lx-action-btn lx-action-btn--copy"
                    onClick={() => handleTrigger(job)}
                  >
                    <Play size={12} /> Trigger Now
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
