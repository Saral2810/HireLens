import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '../../services/api';
import { AnswerType, HrQuestion } from '../../types';
import { ErrorNote } from '../ui/Modal';

export const ANSWER_TYPE_LABELS: Record<AnswerType, string> = {
  duration: 'Notice period / duration (→ days)',
  ctc: 'Salary / CTC (→ lakh per annum)',
  yes_no: 'Yes / No',
  number: 'Number',
  text: 'Free answer'
};

interface Props {
  batchId: string;
  questions: HrQuestion[];
  onChange: (questions: HrQuestion[]) => void;
}

/**
 * HR's fixed questions for a batch, asked after the resume questions in this order.
 * The agent speaks them as written, so Hinglish phrasing works best.
 */
export const QuestionEditor: React.FC<Props> = ({ batchId, questions, onChange }) => {
  const [newText, setNewText] = useState('');
  const [newType, setNewType] = useState<AnswerType>('text');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editType, setEditType] = useState<AnswerType>('text');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const q = await api.addQuestion(batchId, { question_text: newText, answer_type: newType });
      onChange([...questions, q]);
      setNewText('');
      setNewType('text');
    });
  };

  const addDefaults = () => run(async () => {
    const { questions: updated } = await api.addDefaultQuestions(batchId);
    onChange(updated);
  });

  const move = (index: number, delta: number) => run(async () => {
    const ids = questions.map(q => q.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    onChange(await api.reorderQuestions(batchId, ids));
  });

  const startEdit = (q: HrQuestion) => {
    setEditingId(q.id);
    setEditText(q.question_text);
    setEditType(q.answer_type);
  };

  const saveEdit = (id: string) => run(async () => {
    const updated = await api.updateQuestion(id, { question_text: editText, answer_type: editType });
    onChange(questions.map(q => (q.id === id ? updated : q)));
    setEditingId(null);
  });

  const remove = (q: HrQuestion) => {
    if (!window.confirm(`Delete the question "${q.question_text}"?`)) return;
    run(async () => {
      await api.deleteQuestion(q.id);
      onChange(questions.filter(x => x.id !== q.id));
    });
  };

  return (
    <div>
      <p style={{ color: 'var(--lx-muted)', fontSize: 13, marginTop: 0 }}>
        Every candidate in this batch is asked these after 3–5 questions about their own resume. The agent speaks them exactly as written.
      </p>
      <ErrorNote message={error} />

      {questions.length === 0 ? (
        <div style={{ padding: 16, border: '1px dashed var(--lx-border)', borderRadius: 8, marginBottom: 14, color: 'var(--lx-muted)', fontSize: 14 }}>
          No HR questions yet.{' '}
          <button className="lx-restored-btn primary" onClick={addDefaults} disabled={busy} style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={14} /> Add default questions
          </button>
          <div style={{ fontSize: 12, marginTop: 8 }}>Notice period, current CTC, expected CTC, location and joining date.</div>
        </div>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 14px' }}>
          {questions.map((q, i) => (
            <li key={q.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', border: '1px solid var(--lx-border)', borderRadius: 8, marginBottom: 8 }}>
              <span style={{ color: 'var(--lx-muted)', fontWeight: 600, minWidth: 18 }}>{i + 1}.</span>
              {editingId === q.id ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input className="lx-input" value={editText} maxLength={300} onChange={e => setEditText(e.target.value)} aria-label="Question text" />
                  <select className="lx-input" value={editType} onChange={e => setEditType(e.target.value as AnswerType)} aria-label="Answer type">
                    {Object.entries(ANSWER_TYPE_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="lx-restored-btn primary" onClick={() => saveEdit(q.id)} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Check size={13} /> Save</button>
                    <button className="lx-restored-btn" onClick={() => setEditingId(null)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><X size={13} /> Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14 }}>{q.question_text}</div>
                  <div style={{ fontSize: 12, color: 'var(--lx-muted)', marginTop: 3 }}>{ANSWER_TYPE_LABELS[q.answer_type]}</div>
                </div>
              )}
              {editingId !== q.id && (
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button className="lx-restored-btn" onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label="Move up" title="Move up"><ArrowUp size={13} /></button>
                  <button className="lx-restored-btn" onClick={() => move(i, 1)} disabled={busy || i === questions.length - 1} aria-label="Move down" title="Move down"><ArrowDown size={13} /></button>
                  <button className="lx-restored-btn" onClick={() => startEdit(q)} disabled={busy} aria-label="Edit" title="Edit"><Pencil size={13} /></button>
                  <button className="lx-restored-btn" onClick={() => remove(q)} disabled={busy} aria-label="Delete" title="Delete"><Trash2 size={13} /></button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={add} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="lx-input" required minLength={3} maxLength={300} value={newText} onChange={e => setNewText(e.target.value)}
          placeholder="e.g. Kya aap hybrid model mein kaam kar sakte hain?" style={{ flex: '2 1 260px' }} aria-label="New question" />
        <select className="lx-input" value={newType} onChange={e => setNewType(e.target.value as AnswerType)} style={{ flex: '1 1 180px' }} aria-label="Answer type">
          {Object.entries(ANSWER_TYPE_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <button type="submit" className="lx-restored-btn primary" disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add question
        </button>
      </form>
      {questions.length > 0 && (
        <button className="lx-restored-btn" onClick={addDefaults} disabled={busy} style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <Sparkles size={13} /> Add any missing default questions
        </button>
      )}
    </div>
  );
};
