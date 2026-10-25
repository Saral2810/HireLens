import React, { useEffect, useRef, useState } from 'react';
import { Mic, Play, CheckCircle2 } from 'lucide-react';
import { WavRecorder } from '../../lib/wavRecorder';
import { ErrorNote } from '../ui/Modal';

interface Props {
  onHeard: () => void;
  heard: boolean;
}

/**
 * Step 2a: the candidate says a short sentence and hears it back. Uses the same recorder as the
 * call, so a pass here means the call can record them.
 */
export const MicCheck: React.FC<Props> = ({ onHeard, heard }) => {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'review'>('idle');
  const [level, setLevel] = useState(0);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [quiet, setQuiet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<WavRecorder | null>(null);

  // Release the microphone when the candidate leaves this step.
  useEffect(() => () => recorder.current?.close(), []);
  // Free the previous test clip whenever a new one replaces it (and on leaving).
  useEffect(() => () => { if (clipUrl) URL.revokeObjectURL(clipUrl); }, [clipUrl]);

  const test = async () => {
    setError(null);
    setQuiet(false);
    setClipUrl(null);
    try {
      const rec = recorder.current || new WavRecorder();
      recorder.current = rec;
      await rec.open();
      setPhase('recording');
      const result = await rec.record({ onLevel: setLevel, silenceMs: 1200, maxMs: 8000, noSpeechTimeoutMs: 6000 });
      setLevel(0);
      setClipUrl(URL.createObjectURL(result.wav));
      setQuiet(!result.hadSpeech);
      setPhase('review');
    } catch (err: any) {
      setPhase('idle');
      setError(err?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.'
        : `Could not use the microphone: ${err?.message || err}`);
    }
  };

  return (
    <div>
      <p style={{ color: 'var(--lx-muted)', fontSize: 14, marginTop: 0 }}>
        Use headphones if you can, in a quiet room. Click the button and say: <em>"Hello, mera naam ... hai."</em>
      </p>
      <ErrorNote message={error} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="lx-restored-btn" onClick={test} disabled={phase === 'recording'} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Mic size={14} /> {phase === 'recording' ? 'Listening… speak now' : heard ? 'Test again' : 'Test my microphone'}
        </button>
        {phase === 'recording' && (
          <div aria-label="Microphone level" style={{ width: 160, height: 8, background: 'var(--lx-border)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, level * 600)}%`, height: '100%', background: 'var(--lx-green, #22c55e)' }} />
          </div>
        )}
      </div>

      {phase === 'review' && clipUrl && (
        <div style={{ marginTop: 12 }}>
          {quiet && <p style={{ fontSize: 13, color: '#f59e0b' }}>We could not hear you clearly. Move closer to the mic or check that the right microphone is selected, then test again.</p>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <audio src={clipUrl} controls style={{ height: 32 }} />
            {!heard && !quiet && (
              <button className="lx-restored-btn primary" onClick={onHeard} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Play size={14} /> I can hear myself clearly
              </button>
            )}
          </div>
        </div>
      )}
      {heard && (
        <p style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--lx-green, #22c55e)' }}>
          <CheckCircle2 size={14} /> Microphone works.
        </p>
      )}
    </div>
  );
};
