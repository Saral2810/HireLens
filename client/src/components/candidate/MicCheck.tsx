import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Mic } from 'lucide-react';
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
    <div className="stack">
      <p className="muted">
        Use headphones if you can, in a quiet room. Click the button and say: <em>"Hello, mera naam … hai."</em> Then play it back.
      </p>
      <ErrorNote message={error} />
      <div className="row-wrap" style={{ gap: 12 }}>
        <button className={`btn${heard ? '' : ' btn-primary'}`} onClick={test} disabled={phase === 'recording'}>
          <Mic size={15} /> {phase === 'recording' ? 'Listening… speak now' : heard ? 'Test again' : 'Test my microphone'}
        </button>
        {phase === 'recording' && (
          <div className="meter grow" aria-label="Microphone level" style={{ maxWidth: 220 }}>
            <div style={{ width: `${Math.min(100, level * 600)}%` }} />
          </div>
        )}
      </div>

      {phase === 'review' && clipUrl && (
        <div className="stack-sm">
          {quiet && (
            <div className="alert alert-warn" style={{ marginBottom: 0 }}>
              <AlertTriangle size={15} /><span>We could not hear you clearly. Move closer to the mic or check that the right microphone is selected, then test again.</span>
            </div>
          )}
          <audio src={clipUrl} controls />
          {!heard && !quiet && (
            <button className="btn btn-primary" onClick={onHeard} style={{ alignSelf: 'flex-start' }}>
              <CheckCircle2 size={15} /> I can hear myself clearly
            </button>
          )}
        </div>
      )}
      {heard && (
        <div className="alert alert-success" style={{ marginBottom: 0 }}><CheckCircle2 size={15} /><span>Microphone works.</span></div>
      )}
    </div>
  );
};
