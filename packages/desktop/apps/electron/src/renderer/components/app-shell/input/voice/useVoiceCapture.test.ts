import { describe, expect, it } from 'bun:test';
import { resampleToSampleRate } from './useVoiceCapture';

describe('resampleToSampleRate', () => {
  it('downsamples hardware-rate audio to the voice sample rate', () => {
    const input = Float32Array.from([0, 0.25, 0.5, 0.75, 1, 0.75]);
    const output = resampleToSampleRate(input, 48_000, 16_000);

    expect(Array.from(output)).toEqual([0, 0.75]);
  });

  it('keeps 16 kHz input unchanged', () => {
    const input = Float32Array.from([0.1, 0.2]);

    expect(resampleToSampleRate(input, 16_000, 16_000)).toBe(input);
  });
});
