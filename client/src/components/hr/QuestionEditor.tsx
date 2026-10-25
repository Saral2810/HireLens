import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Check, ListChecks, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '../../services/api';
import { AnswerType, HrQuestion } from '../../types';
import { EmptyState, ErrorNote } from '../ui/Modal';

export const ANSWER_TYPE_LABELS: Record<AnswerType, string> = {
  duration: 'Notice period / duration (→ days)',
  ctc: 'Salary / CTC (→ lakh per annum)',
  yes_no: 'Yes / No',
  number: 'Number',
  text: 'Free answer'
};

const SHORT_TYPE: Record<AnswerType, string> = {
  duration: 'Saved as days', ctc: 'Saved as LPA', yes_no: 'Yes / No', number: 'Number', text: 'Free answer'
};

interface Props {
  batchId: string;
  questions: HrQuestion[];
  onChange: (questions: HrQuestion[]) => void;
}

const TypeSelect: React.FC<{ value: AnswerType; onChange: (v: AnswerType) => void; style?: React.CSSProperties }> = ({ value, onChange, style }) => (
  <select className="select" value={value} onChange={e => onChange(e.target.value as AnswerType)} aria-label="Answer type" style={style}>
    {Object.entries(ANSWER_TYPE_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
  </select>
);

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
    <div className="stack">
      <div className="alert alert-info" style={{ marginBottom: 0 }}>
        <ListChecks size={15} />
        <span>The call opens with 3–5 questions about each candidate's own resume, then asks these in order. The assistant speaks them exactly as written, so Hinglish works well.</span>
      </div>
      <ErrorNote message={error} />

      <div className="card">
        {questions.length === 0 ? (
          <EmptyState icon={<Sparkles size={20} />} title="No HR questions yet">
            Start with the defaults: notice period, current CTC, expected CTC, location and joining date.
            <div className="mt"><button className="btn btn-primary" onClick={addDefaults} disabled={busy}><Sparkles size={15} /> Add default questions</button></div>
          </EmptyState>
        ) : (
          <ol className="list">
            {questions.map((q, i) => (
              <li key={q.id} className="list-item">
                <span className="list-num">{i + 1}</span>
                {editingId === q.id ? (
                  <div className="grow stack-sm">
                    <input className="input" value={editText} maxLength={300} onChange={e => setEditText(e.target.value)} aria-label="Question text" autoFocus />
                    <TypeSelect value={editType} onChange={setEditType} />
                    <div className="row">
                      <button className="btn btn-primary btn-sm" onClick={() => saveEdit(q.id)} disabled={busy}><Check size={14} /> Save</button>
                      <button className="btn btn-sm" onClick={() => setEditingId(null)}><X size={14} /> Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grow">
                      <div style={{ fontSize: 14.5 }}>{q.question_text}</div>
                      <span className="tag mt-sm" style={{ marginTop: 6 }}>{SHORT_TYPE[q.answer_type]}</span>
                    </div>
                    <div className="btn-group">
                      <button className="btn btn-ghost btn-icon" onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label="Move up" title="Move up"><ArrowUp size={15} /></button>
                      <button className="btn btn-ghost btn-icon" onClick={() => move(i, 1)} disabled={busy || i === questions.length - 1} aria-label="Move down" title="Move down"><ArrowDown size={15} /></button>
                      <button className="btn btn-ghost btn-icon" onClick={() => startEdit(q)} disabled={busy} aria-label="Edit" title="Edit"><Pencil size={15} /></button>
                      <button className="btn btn-ghost btn-icon btn-danger" onClick={() => remove(q)} disabled={busy} aria-label="Delete" title="Delete"><Trash2 size={15} /></button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <form onSubmit={add} className="card card-pad">
        <h4 className="mb-sm">Add a question</h4>
        <div className="row-wrap" style={{ alignItems: 'stretch' }}>
          <input className="input" required minLength={3} maxLength={300} value={newText} onChange={e => setNewText(e.target.value)}
            placeholder="e.g. Kya aap hybrid model mein kaam kar sakte hain?" style={{ flex: '3 1 280px', width: 'auto' }} aria-label="New question" />
          <TypeSelect value={newType} onChange={setNewType} style={{ flex: '1 1 200px', width: 'auto' }} />
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ height: 38 }}><Plus size={15} /> Add</button>
        </div>
        {questions.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm mt-sm" onClick={addDefaults} disabled={busy} style={{ marginLeft: -10 }}>
            <Sparkles size={14} /> Add any missing default questions
          </button>
        )}
      </form>
    </div>
  );
};
