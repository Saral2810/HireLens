import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlarmClock, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Play, Plus, Save, Trash2, UploadCloud, X } from 'lucide-react';
import { api } from '../../services/api';
import { AnswerType, CallLanguage } from '../../types';
import { ErrorNote, Field } from '../../components/ui/Modal';
import { ANSWER_TYPE_LABELS } from '../../components/hr/QuestionEditor';
import { ALL_CALL_LANGUAGES, CALL_LANGUAGE_LABELS, CallLanguagesField } from '../../components/hr/CallLanguagesField';
import { runNotice } from './CampaignPage';
import { formatWhen, fromLocalInput, nextHourLocal, toLocalInput } from '../../lib/schedule';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CANDIDATES = 100;

// Same as backend/src/services/questionTemplates.js (the defaults HR starts from).
const DEFAULT_QUESTIONS: { question_text: string; answer_type: AnswerType }[] = [
  { question_text: 'Aapka current notice period kitna hai?', answer_type: 'duration' },
  { question_text: 'Aapki current CTC kitni hai?', answer_type: 'ctc' },
  { question_text: 'Aapki expected CTC kitni hai?', answer_type: 'ctc' },
  { question_text: 'Aap abhi kis city mein based hain, aur kya aap relocate kar sakte hain?', answer_type: 'text' },
  { question_text: 'Agar aapka selection hota hai, toh aap sabse jaldi kab join kar sakte hain?', answer_type: 'text' }
];

const STEPS = ['Company & role', 'Questions', 'Candidates', 'Review'];
const today = () => new Date().toISOString().slice(0, 10);

interface Row { name: string; email: string }

function checkRows(rows: Row[]) {
  const seen = new Set<string>();
  return rows.map(r => {
    const email = r.email.trim().toLowerCase();
    let issue: string | null = null;
    if (!r.name.trim()) issue = 'Name missing';
    else if (!EMAIL_RE.test(email)) issue = 'Invalid email';
    else if (seen.has(email)) issue = 'Repeated';
    seen.add(email);
    return { name: r.name.trim(), email, issue };
  });
}

/** New campaign, step by step: company, role and company intro → questions → candidates → review, then save or run. */
export const NewCampaignPage: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [details, setDetails] = useState({ name: '', job_role: '', company_name: '', company_intro: '', batch_date: today(), job_description: '' });
  const [languages, setLanguages] = useState<CallLanguage[]>(ALL_CALL_LANGUAGES);
  // The campaign name defaults to "Role – Company" until HR types their own.
  const campaignName = details.name.trim() || [details.job_role.trim(), details.company_name.trim()].filter(Boolean).join(' – ');
  const [questions, setQuestions] = useState(DEFAULT_QUESTIONS);
  const [newQ, setNewQ] = useState<{ question_text: string; answer_type: AnswerType }>({ question_text: '', answer_type: 'text' });
  const [rows, setRows] = useState<Row[]>([]);
  const [manual, setManual] = useState<Row>({ name: '', email: '' });
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState<'draft' | 'run' | 'schedule' | null>(null);
  // Start now, or schedule: the campaign then starts (and emails invites) by itself on that day.
  const [startLater, setStartLater] = useState(false);
  const [startAt, setStartAt] = useState(nextHourLocal());
  const [closeAt, setCloseAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const checked = useMemo(() => checkRows(rows), [rows]);
  const problems = checked.filter(r => r.issue).length;

  const stepValid = [
    details.company_name.trim().length > 0 && details.job_role.trim().length > 0 && campaignName.length > 0,
    questions.every(q => q.question_text.trim().length >= 3),
    rows.length > 0 && problems === 0 && rows.length <= MAX_CANDIDATES,
    true
  ];

  const loadFile = async (file?: File) => {
    if (!file) return;
    setParsing(true);
    setError(null);
    try {
      const { rows: parsed } = await api.parseCandidatesFile(file);
      setRows(prev => [...prev, ...parsed]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setParsing(false);
    }
  };

  const addManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manual.name.trim() || !manual.email.trim()) return;
    setRows(prev => [...prev, { name: manual.name.trim(), email: manual.email.trim().toLowerCase() }]);
    setManual({ name: '', email: '' });
  };

  // A question typed in the box but not added with "Add" is kept when HR moves on, instead of being lost.
  const addTypedQuestion = () => {
    const text = newQ.question_text.trim();
    if (text.length < 3) return;
    setQuestions(qs => [...qs, { ...newQ, question_text: text }]);
    setNewQ({ question_text: '', answer_type: 'text' });
  };

  const move = (i: number, d: number) => setQuestions(qs => {
    const next = [...qs];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    return next;
  });

  const finish = async (mode: 'draft' | 'run' | 'schedule') => {
    const run = mode === 'run';
    setSaving(mode);
    setError(null);
    let batchId: string | null = null;
    try {
      const batch = await api.createBatch({
        name: campaignName, job_role: details.job_role, batch_date: details.batch_date,
        company_name: details.company_name || undefined, company_intro: details.company_intro || undefined,
        job_description: details.job_description || undefined, call_languages: languages
      });
      batchId = batch.id;
      for (const q of questions) await api.addQuestion(batch.id, q);
      await api.addCandidates(batch.id, checked.map(({ name, email }) => ({ name, email })));
      const started = run ? await api.runCampaign(batch.id) : null;
      const scheduled = mode === 'schedule'
        ? await api.scheduleCampaign(batch.id, { start_at: fromLocalInput(startAt), close_at: fromLocalInput(closeAt) })
        : null;
      const notice = started ? runNotice(started.emails)
        : scheduled ? `Scheduled. The campaign starts on ${formatWhen(scheduled.scheduled_at)} and every candidate is emailed their invite then.` : undefined;
      navigate(`/hr/campaigns/${batch.id}`, { replace: true, state: notice ? { notice } : undefined });
    } catch (err: any) {
      // A half-made campaign stays as a draft the user can finish on its own page.
      if (batchId) navigate(`/hr/campaigns/${batchId}`, { replace: true, state: { notice: `Saved as a draft, but: ${err.message}` } });
      else { setError(err.message); setSaving(null); }
    }
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <Link to="/hr/campaigns" className="back-link"><ArrowLeft size={14} /> Campaigns</Link>
      <div className="page-head"><div><span className="eyebrow">New campaign</span><h1>{campaignName || 'Create a campaign'}</h1></div></div>

      <ol className="wizard-steps" style={{ listStyle: 'none', padding: 0 }}>
        {STEPS.map((s, i) => (
          <li key={s} className={`wizard-step${i === step ? ' current' : ''}${i < step ? ' done' : ''}`} aria-current={i === step ? 'step' : undefined}>
            <span className="n">{i < step ? <Check size={12} /> : i + 1}</span>{s}
          </li>
        ))}
      </ol>
      <ErrorNote message={error} />

      <div className="card card-pad">
        {step === 0 && (
          <div>
            <h3 className="mb">Company and role</h3>
            <Field label="Company name">
              <input className="input" maxLength={120} value={details.company_name} onChange={e => setDetails({ ...details, company_name: e.target.value })} placeholder="Made-up company for the demo" autoFocus />
            </Field>
            <Field label="Job role" hint="The agent says this, and resume questions are written for it.">
              <input className="input" maxLength={120} value={details.job_role} onChange={e => setDetails({ ...details, job_role: e.target.value })} placeholder="Backend Engineer" />
            </Field>
            <Field label="About the company" hint="2–4 sentences candidates should hear: what the company does, who it works with, the team they would join. The assistant turns this into a short spoken briefing at the start of each call.">
              <textarea className="textarea" rows={4} maxLength={1500} value={details.company_intro} onChange={e => setDetails({ ...details, company_intro: e.target.value })}
                placeholder="We build payment software for small shops across India. Our backend team of 12 runs the systems that process 2 lakh orders a day." />
            </Field>
            <CallLanguagesField value={languages} onChange={setLanguages} />
            <div className="grid-2" style={{ gap: '0 14px' }}>
              <Field label="Campaign name" hint="Only HR sees this.">
                <input className="input" maxLength={120} value={details.name} onChange={e => setDetails({ ...details, name: e.target.value })} placeholder={campaignName || 'Backend Engineers – November'} />
              </Field>
              <Field label="Date"><input className="input" type="date" value={details.batch_date} onChange={e => setDetails({ ...details, batch_date: e.target.value })} /></Field>
            </div>
            <Field label="Job description (optional)" hint="Helps the fit score at the end of each call.">
              <textarea className="textarea" rows={4} maxLength={4000} value={details.job_description} onChange={e => setDetails({ ...details, job_description: e.target.value })} />
            </Field>
          </div>
        )}

        {step === 1 && (
          <div>
            <h3>HR questions</h3>
            <p className="muted small mt-sm mb">Asked after 3–5 questions about each candidate's own resume, in this order. Write them in Hinglish: candidates who pick English or Hindi hear a translation. Freshers are not asked notice period or current CTC.</p>
            <ol className="list card" style={{ boxShadow: 'none' }}>
              {questions.map((q, i) => (
                <li key={i} className="list-item">
                  <span className="list-num">{i + 1}</span>
                  <div className="grow stack-sm">
                    <input className="input" value={q.question_text} maxLength={300} aria-label={`Question ${i + 1}`}
                      onChange={e => setQuestions(qs => qs.map((x, j) => (j === i ? { ...x, question_text: e.target.value } : x)))} />
                    <select className="select" value={q.answer_type} aria-label={`Answer type ${i + 1}`}
                      onChange={e => setQuestions(qs => qs.map((x, j) => (j === i ? { ...x, answer_type: e.target.value as AnswerType } : x)))}>
                      {Object.entries(ANSWER_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div className="btn-group" style={{ flexDirection: 'column' }}>
                    <button type="button" className="btn btn-ghost btn-icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp size={15} /></button>
                    <button type="button" className="btn btn-ghost btn-icon" onClick={() => move(i, 1)} disabled={i === questions.length - 1} aria-label="Move down"><ArrowDown size={15} /></button>
                    <button type="button" className="btn btn-ghost btn-icon" onClick={() => setQuestions(qs => qs.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={15} /></button>
                  </div>
                </li>
              ))}
              {questions.length === 0 && <li className="list-item muted small">No HR questions. The call will ask only about the resume.</li>}
            </ol>
            <form className="row-wrap mt" style={{ alignItems: 'stretch' }} onSubmit={e => { e.preventDefault(); addTypedQuestion(); }}>
              <input className="input" style={{ flex: '3 1 260px', width: 'auto' }} value={newQ.question_text} maxLength={300} onChange={e => setNewQ({ ...newQ, question_text: e.target.value })} placeholder="Add a question, e.g. Kya aap hybrid model mein kaam kar sakte hain?" aria-label="New question" />
              <select className="select" style={{ flex: '1 1 180px', width: 'auto' }} value={newQ.answer_type} onChange={e => setNewQ({ ...newQ, answer_type: e.target.value as AnswerType })} aria-label="New question answer type">
                {Object.entries(ANSWER_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <button type="submit" className="btn" style={{ height: 40 }}><Plus size={15} /> Add</button>
            </form>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3>Candidates</h3>
            <p className="muted small mt-sm mb">Upload an Excel or CSV file with Name and Email columns, or add people one by one. Up to {MAX_CANDIDATES}. Use made-up candidates for the demo.</p>
            <label className="file-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); loadFile(e.dataTransfer.files?.[0]); }}>
              <UploadCloud size={24} />
              <span className="strong">{parsing ? 'Reading the file…' : 'Upload Excel (.xlsx) or CSV'}</span>
              <span className="tiny muted">or drop it here</span>
              <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={e => { loadFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <div className="divider">or add manually</div>
            <form className="row-wrap" style={{ alignItems: 'stretch' }} onSubmit={addManual}>
              <input className="input" style={{ flex: '1 1 180px', width: 'auto' }} value={manual.name} onChange={e => setManual({ ...manual, name: e.target.value })} placeholder="Full name" aria-label="Candidate name" />
              <input className="input" style={{ flex: '1 1 220px', width: 'auto' }} type="email" value={manual.email} onChange={e => setManual({ ...manual, email: e.target.value })} placeholder="email@example.com" aria-label="Candidate email" />
              <button type="submit" className="btn" style={{ height: 40 }}><Plus size={15} /> Add</button>
            </form>

            {rows.length > 0 && (
              <div className="card mt" style={{ boxShadow: 'none' }}>
                <div className="card-head">
                  <h4>{rows.length} candidate{rows.length === 1 ? '' : 's'}{problems > 0 && <span className="muted" style={{ fontWeight: 400 }}> · {problems} to fix</span>}</h4>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows([])}>Clear all</button>
                </div>
                <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <table className="table">
                    <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Check</th><th className="actions"><span className="sr-only">Remove</span></th></tr></thead>
                    <tbody>
                      {checked.map((r, i) => (
                        <tr key={i}>
                          <td className="num" style={{ textAlign: 'left' }}>{i + 1}</td>
                          <td>{r.name || '—'}</td>
                          <td className="muted">{r.email || '—'}</td>
                          <td className={r.issue ? 'strong' : 'muted'}>{r.issue || 'OK'}</td>
                          <td className="actions"><button type="button" className="btn btn-ghost btn-icon" onClick={() => setRows(prev => prev.filter((_, j) => j !== i))} aria-label={`Remove ${r.name}`}><X size={14} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {rows.length > MAX_CANDIDATES && <ErrorNote message={`A campaign holds at most ${MAX_CANDIDATES} candidates.`} />}
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 className="mb">Review</h3>
            <div className="stat-row">
              <div className="stat"><div className="stat-label">Company</div><div className="strong mt-sm">{details.company_name}</div></div>
              <div className="stat"><div className="stat-label">Job role</div><div className="strong mt-sm">{details.job_role}</div></div>
              <div className="stat"><div className="stat-label">HR questions</div><div className="stat-value">{questions.length}</div></div>
              <div className="stat"><div className="stat-label">Candidates</div><div className="stat-value">{rows.length}</div></div>
            </div>
            <div className="mb small">
              <strong>Call languages:</strong> {languages.map(l => CALL_LANGUAGE_LABELS[l]).join(', ')}
              {details.company_intro.trim()
                ? <p className="muted mt-sm" style={{ marginBottom: 0 }}>The assistant opens each call with a short briefing from your company intro.</p>
                : <p className="muted mt-sm" style={{ marginBottom: 0 }}>No company intro: calls go straight to the questions.</p>}
            </div>
            {questions.length > 0 && (
              <div className="mb">
                <h4 className="mb-sm">HR questions, in the order they are asked</h4>
                <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
                  {questions.map((q, i) => <li key={i}>{q.question_text} <span className="muted">· {ANSWER_TYPE_LABELS[q.answer_type]}</span></li>)}
                </ol>
              </div>
            )}
            <div className="card card-pad mb" style={{ boxShadow: 'none' }}>
              <h4 className="mb-sm">When should it start?</h4>
              <div className="row-wrap" role="radiogroup" style={{ gap: 8 }}>
                <button type="button" role="radio" aria-checked={!startLater} className={`btn${!startLater ? ' btn-primary' : ''}`} onClick={() => setStartLater(false)}>Start now</button>
                <button type="button" role="radio" aria-checked={startLater} className={`btn${startLater ? ' btn-primary' : ''}`} onClick={() => setStartLater(true)}>Schedule for a later day</button>
              </div>
              {startLater && (
                <div className="grid-2 mt" style={{ gap: '0 14px' }}>
                  <Field label="Start on" hint="Invite emails go out at this time.">
                    <input className="input" type="datetime-local" value={startAt} min={toLocalInput(new Date().toISOString())} onChange={e => setStartAt(e.target.value)} />
                  </Field>
                  <Field label="End on (optional)">
                    <input className="input" type="datetime-local" value={closeAt} min={startAt} onChange={e => setCloseAt(e.target.value)} />
                  </Field>
                </div>
              )}
            </div>
            <div className="alert">
              <Play size={15} />
              <span>{startLater
                ? <><strong>Schedule campaign</strong> keeps it hidden until the start time; then it goes live and each candidate is emailed a personal link.</>
                : <><strong>Run campaign</strong> opens it for calls and emails each candidate a personal link that takes them straight to their screening.</>}
                {' '}<strong>Save as draft</strong> keeps it hidden from candidates until you run or schedule it.</span>
            </div>
          </div>
        )}
      </div>

      <div className="wizard-foot">
        <button className="btn" onClick={() => (step === 0 ? navigate('/hr/campaigns') : setStep(step - 1))} disabled={saving !== null}>
          <ArrowLeft size={15} /> {step === 0 ? 'Cancel' : 'Back'}
        </button>
        {step < 3 ? (
          <button className="btn btn-primary" onClick={() => { if (step === 1) addTypedQuestion(); setStep(step + 1); }} disabled={!stepValid[step]}>
            Continue <ArrowRight size={15} />
          </button>
        ) : (
          <div className="btn-group">
            <button className="btn" onClick={() => finish('draft')} disabled={saving !== null}><Save size={15} /> {saving === 'draft' ? 'Saving…' : 'Save as draft'}</button>
            {startLater
              ? <button className="btn btn-primary" onClick={() => finish('schedule')} disabled={saving !== null || !fromLocalInput(startAt)}><AlarmClock size={15} /> {saving === 'schedule' ? 'Scheduling…' : 'Schedule campaign'}</button>
              : <button className="btn btn-primary" onClick={() => finish('run')} disabled={saving !== null}><Play size={15} /> {saving === 'run' ? 'Starting…' : 'Run campaign'}</button>}
          </div>
        )}
      </div>
    </div>
  );
};
