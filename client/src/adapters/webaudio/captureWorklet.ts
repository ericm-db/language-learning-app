// AudioWorklet processors load from a URL, so the processor ships as source
// text and is mounted via a Blob URL. The worklet is deliberately dumb: it
// posts raw Float32 blocks at the context rate, and all downsampling / Int16
// conversion happens on the main thread in pcm.ts -- that keeps the numeric
// code pure and unit-testable, and keeps the audio thread free of work.

export const CAPTURE_PROCESSOR_NAME = 'pcm-capture';

export const captureWorkletSource = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // The engine reuses the block's backing buffer, so copy before transfer.
      const block = new Float32Array(channel.length);
      block.set(channel);
      this.port.postMessage(block, [block.buffer]);
    }
    return true;
  }
}
registerProcessor('${CAPTURE_PROCESSOR_NAME}', PcmCaptureProcessor);
`;

export function createCaptureWorkletUrl(): string {
  return URL.createObjectURL(new Blob([captureWorkletSource], { type: 'application/javascript' }));
}
