// Copies each block of mic samples to the main thread (loaded by client/src/lib/wavRecorder.ts).
// A real file, not a blob: URL, so the server's script-src 'self' CSP allows it.
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
