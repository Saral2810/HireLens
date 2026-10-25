// Records one spoken answer from the mic as 16 kHz mono 16-bit WAV (Prisma does not accept
// Chrome's default WebM). Stops on its own after a pause in speech, or when stop() is called.

export interface RecordOptions {
  /** Silence after speech that ends the answer. */
  silenceMs?: number;
  /** Hard cap; Prisma REST accepts clips up to 60 s. */
  maxMs?: number;
  /** Give up if no speech starts within this time. */
  noSpeechTimeoutMs?: number;
  /** Called ~40×/s with the input level (0–1, RMS). */
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
}

export interface RecordResult {
  wav: Blob;
  durationMs: number;
  hadSpeech: boolean;
}

const TARGET_RATE = 16000;
const CALIBRATION_MS = 300;
const MIN_THRESHOLD = 0.015;

// Copies each block of mic samples to the main thread.
const TAP_WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

export class WavRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private tap: AudioWorkletNode | null = null;
  private onChunk: ((chunk: Float32Array) => void) | null = null;
  private stopNow: (() => void) | null = null;

  /** Asks for mic permission and starts the audio graph. Call once before record(). */
  async open(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.ctx = new AudioContext();
    const moduleUrl = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.tap = new AudioWorkletNode(this.ctx, 'pcm-tap');
    this.tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.onChunk?.(e.data);
    // Keep the tap in a graph the browser renders, without playing the mic back.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(this.tap).connect(mute).connect(this.ctx.destination);
  }

  /** Records one answer. Resolves when the speaker pauses, time runs out, or stop() is called. */
  record(opts: RecordOptions = {}): Promise<RecordResult> {
    const { silenceMs = 1500, maxMs = 60000, noSpeechTimeoutMs = 10000, onLevel, onSpeechStart } = opts;
    if (!this.ctx) return Promise.reject(new Error('Call open() first.'));
    const ctx = this.ctx;

    return new Promise((resolve) => {
      const chunks: Float32Array[] = [];
      const started = performance.now();
      let noiseFloor = 0;
      let calibrationBlocks = 0;
      let speechStarted = false;
      let lastLoud = started;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        this.onChunk = null;
        this.stopNow = null;
        const samples = downsample(concat(chunks), ctx.sampleRate, TARGET_RATE);
        resolve({ wav: encodeWav(samples, TARGET_RATE), durationMs: Math.round(performance.now() - started), hadSpeech: speechStarted });
      };
      this.stopNow = finish;

      this.onChunk = (chunk) => {
        chunks.push(chunk);
        const level = rms(chunk);
        onLevel?.(level);
        const now = performance.now();

        if (now - started < CALIBRATION_MS) {
          noiseFloor = (noiseFloor * calibrationBlocks + level) / (calibrationBlocks + 1);
          calibrationBlocks += 1;
          return;
        }
        const threshold = Math.max(MIN_THRESHOLD, noiseFloor * 3);
        if (level > threshold) {
          lastLoud = now;
          if (!speechStarted) {
            speechStarted = true;
            onSpeechStart?.();
          }
        }
        if (speechStarted && now - lastLoud > silenceMs) finish();
        else if (!speechStarted && now - started > noSpeechTimeoutMs) finish();
        else if (now - started > maxMs) finish();
      };
    });
  }

  /** The audio graph and mic stream, so a call can also record and play through them. Null before open(). */
  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  /** Ends the current recording early (e.g. a "Done answering" button). */
  stop(): void {
    this.stopNow?.();
  }

  close(): void {
    this.stopNow?.();
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.tap = null;
  }
}

function rms(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
  return Math.sqrt(sum / (block.length || 1));
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Averages input samples into each output sample (simple low-pass + decimate). */
export function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/** 16-bit PCM WAV with a standard 44-byte header. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
