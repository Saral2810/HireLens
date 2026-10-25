import React, { useRef, useState } from 'react';
import { Mic, Play, Square, Volume2, Loader } from 'lucide-react';
import { api, SpikeTurnResult } from '../services/api';
import { WavRecorder } from '../lib/wavRecorder';

// TEMPORARY call-loop spike (roadmap B.5). Replaced by the candidate CallPage in Phase G.

type AnswerType = 'yes_no' | 'duration' | 'ctc' | 'text';
interface SpikeQuestion { text: string; type: AnswerType }

const QUESTIONS: SpikeQuestion[] = [
  { text: 'Namaste! Main HR screening assistant hoon. Kya aap abhi paanch minute baat kar sakte hain?', type: 'yes_no' },
  { text: 'Aapka current notice period kitna hai?', type: 'duration' },
  { text: 'Aapki current CTC kitni hai?', type: 'ctc' },
  { text: 'Aapki expected CTC kitni hai?', type: 'ctc' },
  { text: 'Aap abhi kis city mein based hain?', type: 'text' }
];

type Phase = 'idle' | 'speaking' | 'listening' | 'thinking' | 'done' | 'error';

interface LogRow {
  question: string;
  attempt: number;
  transcript: string;
  action: string;
  extracted: string;
  source: string;
  stt: number;
  brain: number;
  tts: number;
  gap: number;
}

function playAudio(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not play the agent audio.')); };
    audio.play().catch(reject);
  });
}

function base64ToBlob(b64: string, type: string): Blob {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Blob([bytes], { type });
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

export const CallSpikePage: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [caption, setCaption] = useState('');
  const [rows, setRows] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<WavRecorder | null>(null);
  const stopped = useRef(false);

  const run = async () => {
    setRows([]);
    setError(null);
    stopped.current = false;
    const rec = new WavRecorder();
    recorder.current = rec;
    try {
      await rec.open();

      setPhase('speaking');
      setCaption(QUESTIONS[0].text);
      const first = await api.spikeSpeak(QUESTIONS[0].text);
      await playAudio(first.audio);

      let index = 0;
      let attempt = 1;
      while (index < QUESTIONS.length && !stopped.current) {
        const q = QUESTIONS[index];
        setPhase('listening');
        const answer = await rec.record({ onLevel: setLevel });
        setLevel(0);
        if (stopped.current) break;
        const answerEnded = performance.now();

        setPhase('thinking');
        const form = new FormData();
        form.append('audio', answer.wav, 'answer.wav');
        form.append('question', q.text);
        form.append('answer_type', q.type);
        form.append('attempt', String(attempt));
        form.append('next_question', QUESTIONS[index + 1]?.text || '');
        const turn: SpikeTurnResult = await api.spikeTurn(form);

        const reply = base64ToBlob(turn.audio_base64, turn.audio_type);
        setPhase('speaking');
        setCaption(turn.say_text);
        const playback = playAudio(reply);
        const gap = Math.round(performance.now() - answerEnded);

        setRows(prev => [...prev, {
          question: q.text, attempt, transcript: turn.transcript || '(nothing heard)',
          action: turn.decision.action, extracted: turn.decision.extracted ? JSON.stringify(turn.decision.extracted) : '—',
          source: turn.decision.source, stt: turn.timings.stt_ms, brain: turn.timings.brain_ms, tts: turn.timings.tts_ms, gap
        }]);

        if (turn.decision.action === 'repeat') {
          attempt += 1;
        } else {
          index += 1;
          attempt = 1;
        }
        await playback;
      }
      setPhase(stopped.current ? 'idle' : 'done');
    } catch (err: any) {
      setError(err?.message || String(err));
      setPhase('error');
    } finally {
      rec.close();
      recorder.current = null;
    }
  };

  const stop = () => {
    stopped.current = true;
    recorder.current?.stop();
  };

  const busy = phase === 'speaking' || phase === 'listening' || phase === 'thinking';
  const phaseLabel: Record<Phase, string> = {
    idle: 'Ready', speaking: 'Agent speaking…', listening: 'Listening — answer, then pause', thinking: 'Thinking…', done: 'Call finished', error: 'Stopped with an error'
  };

  return (
    <div style={{ maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>Call-loop test (temporary)</h2>
      <p style={{ color: 'var(--lx-muted)', marginTop: 0 }}>
        Plays 5 sample questions with Timbre, records each answer, sends it to Prisma and the brain, then speaks the next line.
        Use headphones, answer in Hindi, English or Hinglish, and pause ~1.5 s when you finish. Use only your own voice.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0', flexWrap: 'wrap' }}>
        <button className="lx-restored-btn primary" onClick={run} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Play size={14} /> Start test call
        </button>
        <button className="lx-restored-btn" onClick={() => recorder.current?.stop()} disabled={phase !== 'listening'} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Mic size={14} /> Done answering
        </button>
        <button className="lx-restored-btn" onClick={stop} disabled={!busy} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Square size={14} /> Stop
        </button>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--lx-muted)', fontSize: 13 }}>
          {phase === 'speaking' && <Volume2 size={14} />}
          {phase === 'thinking' && <Loader size={14} />}
          {phase === 'listening' && <Mic size={14} />}
          {phaseLabel[phase]}
        </span>
        {phase === 'listening' && (
          <div aria-label="Mic level" style={{ width: 160, height: 8, background: 'var(--lx-border)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, level * 600)}%`, height: '100%', background: 'var(--lx-green, #22c55e)' }} />
          </div>
        )}
      </div>

      {caption && <p style={{ fontSize: 16, margin: '8px 0 16px' }}>“{caption}”</p>}
      {error && <p style={{ color: '#fca5a5' }}>{error}</p>}

      {rows.length > 0 && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--lx-muted)' }}>
                  {['Question', 'Try', 'Heard (Prisma)', 'Decision', 'Extracted', 'Prisma ms', 'Brain ms', 'Timbre ms', 'Gap you hear ms'].map(h => (
                    <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--lx-border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ padding: '6px 8px' }}>{r.question}</td>
                    <td style={{ padding: '6px 8px' }}>{r.attempt}</td>
                    <td style={{ padding: '6px 8px' }}>{r.transcript}</td>
                    <td style={{ padding: '6px 8px' }}>{r.action} ({r.source})</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{r.extracted}</td>
                    <td style={{ padding: '6px 8px' }}>{r.stt}</td>
                    <td style={{ padding: '6px 8px' }}>{r.brain}</td>
                    <td style={{ padding: '6px 8px' }}>{r.tts}</td>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.gap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: 'var(--lx-muted)', fontSize: 13 }}>
            Average: Prisma {avg(rows.map(r => r.stt))} ms · brain {avg(rows.map(r => r.brain))} ms · Timbre {avg(rows.map(r => r.tts))} ms · gap you hear {avg(rows.map(r => r.gap))} ms
          </p>
        </>
      )}
    </div>
  );
};
