import React, { useEffect, useRef, useState } from 'react';
import { Mic, PhoneCall, PhoneOff, Volume2, Loader, Headphones } from 'lucide-react';
import { api } from '../../services/api';
import { CallEndReason, CallLanguage, CallLine, CallStartResult } from '../../types';
import { WavRecorder } from '../../lib/wavRecorder';
import { ErrorNote } from '../ui/Modal';

export type CallOutcome = 'completed' | 'not_ready' | 'ended' | 'error';

interface Props {
  ready: boolean;
  /** Languages this campaign allows (default: all three). */
  languages?: CallLanguage[];
  onStart: () => void;
  onFinished: (outcome: CallOutcome, message?: string) => void;
}

type Phase = 'idle' | 'connecting' | 'waiting' | 'speaking' | 'listening' | 'thinking' | 'saving';

const PHASE_LABEL: Record<Phase, string> = {
  idle: '', connecting: 'Connecting…', waiting: 'Waiting for a free line…', speaking: 'Assistant speaking…', listening: 'Your turn: answer, then pause',
  thinking: 'One moment…', saving: 'Saving your call…'
};

const LANGUAGES: { value: CallLanguage; label: string; hint: string }[] = [
  { value: 'mixed', label: 'English + Hindi', hint: 'Answer in English, Hindi or a mix' },
  { value: 'en', label: 'English', hint: 'The assistant speaks English' },
  { value: 'hi', label: 'हिंदी (Hindi)', hint: 'The assistant speaks Hindi' }
];

// Opus in WebM (Chrome, Edge) or OGG (Firefox); Safari falls back to its default.
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];

function base64ToBuffer(b64: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return bytes.buffer;
}

/** Ended on purpose by the candidate (or by leaving the page): stops the loop without an error. */
class CallEnded extends Error {}

/**
 * Step 3: the screening call. The server keeps the script and the state; this component plays the
 * agent's lines, records each answer as WAV for speech-to-text, and records the whole call (mic + agent,
 * mixed) as WebM for HR. Answer recording starts only after the agent stops speaking, to avoid echo.
 */
export const CallPanel: React.FC<Props> = ({ ready, languages: allowed, onStart, onFinished }) => {
  const options = LANGUAGES.filter(l => !allowed?.length || allowed.includes(l.value));
  const [phase, setPhase] = useState<Phase>('idle');
  const [caption, setCaption] = useState('');
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState<{ position: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<CallLanguage>(() => (allowed?.length && !allowed.includes('mixed') ? allowed[0] : 'mixed'));
  // True while the question itself plays, when the candidate may talk over it.
  const [canInterrupt, setCanInterrupt] = useState(false);

  const recorder = useRef<WavRecorder | null>(null);
  const playing = useRef<AudioBufferSourceNode | null>(null);
  const ended = useRef<CallEndReason | null>(null);
  // True between a successful start and the end of the call (the server has an open call).
  const open = useRef(false);

  const stopEverything = (reason: CallEndReason) => {
    ended.current = reason;
    try { playing.current?.stop(); } catch { /* already stopped */ }
    recorder.current?.stop();
  };

  // Leaving the page mid-call ends it on the server, so saved answers are kept and the call is marked failed.
  useEffect(() => {
    const onLeave = () => {
      if (!open.current) return;
      open.current = false;
      api.endCall('left_page');
      stopEverything('left_page');
    };
    const warn = (e: BeforeUnloadEvent) => {
      if (open.current) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('beforeunload', warn);
      onLeave();
      recorder.current?.close();
    };
  }, []);

  const run = async () => {
    setError(null);
    ended.current = null;
    onStart();
    setPhase('connecting');

    const rec = new WavRecorder();
    recorder.current = rec;
    let mediaRecorder: MediaRecorder | null = null;
    const chunks: Blob[] = [];
    let outcome: CallOutcome = 'error';
    let message: string | undefined;

    try {
      await rec.open();
      const ctx = rec.audioContext!;
      await ctx.resume();

      // Whole-call recording: mic and agent audio mixed into one stream.
      const mix = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(rec.mediaStream!).connect(mix);
      const mimeType = RECORDING_TYPES.find(t => MediaRecorder.isTypeSupported(t));
      mediaRecorder = new MediaRecorder(mix.stream, mimeType ? { mimeType } : undefined);
      mediaRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      mediaRecorder.start(1000);

      /**
       * Plays the agent's lines. With interruptible, the candidate may start answering while the last
       * line (the question) is still playing: the voice stops and their answer is recorded at once.
       * @returns true when the candidate talked over the question (barge-in)
       */
      const play = async (lines: CallLine[], interruptible = false): Promise<boolean> => {
        let bargedIn = false;
        for (const [i, l] of lines.entries()) {
          if (ended.current) throw new CallEnded();
          setPhase('speaking');
          setCaption(l.text);
          const buffer = await ctx.decodeAudioData(base64ToBuffer(l.audio_base64));
          const isQuestion = interruptible && i === lines.length - 1;
          setCanInterrupt(isQuestion);
          await new Promise<void>(resolve => {
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(ctx.destination);
            src.connect(mix);
            let cancelWatch = () => {};
            src.onended = () => { cancelWatch(); resolve(); };
            playing.current = src;
            src.start();
            if (isQuestion) {
              cancelWatch = rec.watchForSpeech({
                onSpeech: () => {
                  bargedIn = true;
                  try { src.stop(); } catch { /* already stopped */ }
                }
              });
            }
          });
          playing.current = null;
        }
        setCanInterrupt(false);
        if (ended.current) throw new CallEnded();
        return bargedIn;
      };

      // All lines busy (429): stay in the queue and try again, without asking the candidate to do anything.
      let start: CallStartResult | null = null;
      while (!start) {
        try {
          start = await api.startCall(language);
        } catch (err: any) {
          if (err?.status !== 429) throw err;
          const wait = Math.max(5, Number(err.body?.retry_after_seconds) || 15) + Math.random() * 5;
          setPhase('waiting');
          setCaption('Many candidates are on a call right now. Please stay on this page: your call starts automatically.');
          await new Promise(r => setTimeout(r, wait * 1000));
          if (ended.current) throw new CallEnded();
          setPhase('connecting');
        }
      }
      open.current = true;
      setProgress({ position: start.position, total: start.total_questions });
      let bargedIn = await play(start.lines, true);

      for (;;) {
        setPhase('listening');
        const answer = await rec.record({ onLevel: setLevel, preroll: bargedIn });
        setLevel(0);
        if (ended.current) throw new CallEnded();

        setPhase('thinking');
        const turnId = crypto.randomUUID();
        const send = () => api.callTurn(answer.hadSpeech ? answer.wav : null, turnId);
        // One retry with the same turn id: the server saves nothing until a turn has fully worked, and
        // if the first try did work (only its reply was lost) the server replays that reply.
        const turn = await send().catch(() => new Promise<void>(r => setTimeout(r, 1000)).then(send));
        if (ended.current) throw new CallEnded();

        setProgress(p => p && { ...p, position: turn.position });
        if (turn.done) open.current = false;
        bargedIn = await play(turn.lines, !turn.done);
        if (turn.done) {
          outcome = turn.outcome === 'not_ready' ? 'not_ready' : turn.outcome === 'completed' ? 'completed' : 'ended';
          break;
        }
      }
    } catch (err: any) {
      if (err instanceof CallEnded || ended.current) {
        outcome = 'ended';
      } else {
        message = err?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow the microphone for this site, then contact HR to try again.'
          : (err?.message || String(err));
        setError(message ?? null);
      }
      if (open.current) {
        open.current = false;
        await api.endCall(ended.current || 'client_error');
      }
    }

    // Upload whatever was recorded (also for a call that ended early), unless the page is closing.
    if (mediaRecorder && mediaRecorder.state !== 'inactive' && ended.current !== 'left_page') {
      setPhase('saving');
      const stopped = new Promise<void>(r => { mediaRecorder!.onstop = () => r(); });
      mediaRecorder.stop();
      await stopped;
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size && outcome !== 'not_ready') {
        await api.uploadRecording(blob).catch(err => console.warn('Recording upload failed:', err));
      }
    }
    rec.close();
    recorder.current = null;
    setPhase('idle');
    onFinished(outcome, message);
  };

  const inCall = phase !== 'idle';

  if (!inCall) {
    return (
      <div className="stack">
        <ErrorNote message={error} />
        {ready ? (
          <div className="alert alert-info" style={{ marginBottom: 0 }}>
            <Headphones size={15} />
            <span>Wear headphones, sit somewhere quiet and keep this tab open. The assistant asks one question at a time: answer, pause for a moment, and it will continue. About 7 minutes.</span>
          </div>
        ) : (
          <p className="muted">Complete steps 1 and 2 to start your call.</p>
        )}
        {ready && options.length > 1 && (
          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="strong small mb-sm">Call language</legend>
            <div className="row-wrap" role="radiogroup" style={{ gap: 8 }}>
              {options.map(l => (
                <button key={l.value} type="button" role="radio" aria-checked={language === l.value} title={l.hint}
                  className={`btn${language === l.value ? ' btn-primary' : ''}`} onClick={() => setLanguage(l.value)}>
                  {l.label}
                </button>
              ))}
            </div>
            <span className="tiny muted">{LANGUAGES.find(l => l.value === language)?.hint}.</span>
          </fieldset>
        )}
        <button className="btn btn-primary btn-lg" disabled={!ready} onClick={run} style={{ alignSelf: 'flex-start' }}>
          <PhoneCall size={17} /> Start call
        </button>
      </div>
    );
  }

  const pct = progress ? Math.round((Math.min(progress.position, progress.total) / progress.total) * 100) : 0;
  return (
    <div className="call" data-phase={phase}>
      {progress && phase !== 'saving' && (
        <div className="row tiny muted mb-sm" style={{ maxWidth: 420, margin: '0 auto 8px' }}>
          <span>Question {Math.min(progress.position + 1, progress.total)} of {progress.total}</span>
          <span className="spacer">{pct}%</span>
        </div>
      )}
      {progress && phase !== 'saving' && <div className="progress" style={{ maxWidth: 420, margin: '0 auto' }}><div style={{ width: `${pct}%` }} /></div>}

      <div className="orb-wrap mt">
        <span className="orb-ring" /><span className="orb-ring" />
        <div className="orb" style={phase === 'listening' ? { transform: `scale(${1 + Math.min(0.18, level * 2)})` } : undefined}>
          {phase === 'listening' ? <Mic size={34} /> : phase === 'speaking' ? <Volume2 size={34} /> : <Loader size={30} />}
        </div>
      </div>
      <div className="call-status" aria-live="polite">{PHASE_LABEL[phase]}</div>
      <p className="caption" aria-live="polite">{caption ? `“${caption}”` : ''}</p>
      {phase === 'speaking' && canInterrupt && <p className="tiny muted" style={{ textAlign: 'center', margin: '0 0 8px' }}>You can start answering any time; the assistant will stop and listen.</p>}

      <div className="meter" aria-label="Microphone level" style={{ opacity: phase === 'listening' ? 1 : 0.3 }}>
        <div style={{ width: `${Math.min(100, level * 600)}%` }} />
      </div>

      <div className="row-wrap" style={{ justifyContent: 'center', gap: 10 }}>
        <button className="btn btn-lg" disabled={phase !== 'listening'} onClick={() => recorder.current?.stop()}>
          <Mic size={16} /> Done answering
        </button>
        <button
          className="btn btn-lg btn-danger"
          disabled={phase === 'saving' || phase === 'connecting'}
          onClick={() => { if (window.confirm('End the call now? Your answers so far are kept, and you can take the call again later from the start.')) stopEverything('ended_by_candidate'); }}
        >
          <PhoneOff size={16} /> End call
        </button>
      </div>
    </div>
  );
};
