import { describe, expect, it } from 'vitest';
import { CAPTURE_PROCESSOR_NAME, captureWorkletSource } from './captureWorklet';

describe('captureWorkletSource', () => {
  it('registers the processor under the name WorkletCapture instantiates', () => {
    expect(captureWorkletSource).toContain(`registerProcessor('${CAPTURE_PROCESSOR_NAME}'`);
  });

  it('extends AudioWorkletProcessor and keeps the audio thread alive', () => {
    expect(captureWorkletSource).toContain('extends AudioWorkletProcessor');
    expect(captureWorkletSource).toContain('return true;');
  });

  it('transfers the copied block instead of serializing it', () => {
    expect(captureWorkletSource).toContain('postMessage(block, [block.buffer])');
  });
});
