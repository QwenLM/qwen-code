import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StreamingOutputResampler } from '../../preload/audio-output-resampler.ts';

function join(parts: Float32Array[]): Float32Array {
  const output = new Float32Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function tone(frequency: number, length = 24_001): Float32Array {
  return Float32Array.from(
    { length },
    (_, index) =>
      0.4 * Math.sin((2 * Math.PI * frequency * index) / 24_000 + 0.4),
  );
}

function convert(
  input: Float32Array,
  outputRate: number,
  partition: number,
): Float32Array {
  const resampler = new StreamingOutputResampler(24_000, outputRate);
  const parts: Float32Array[] = [];
  for (let offset = 0; offset < input.length; offset += partition) {
    parts.push(resampler.push(input.subarray(offset, offset + partition)));
  }
  parts.push(resampler.finish());
  assert.equal(resampler.finish().length, 0);
  assert.equal(resampler.push(input).length, 0);
  return join(parts);
}

describe('Live Host streaming output resampler', () => {
  for (const rate of [8_000, 16_000, 24_000, 44_100, 48_000, 96_000]) {
    it(`preserves the entire waveform across arbitrary chunks at ${rate} Hz`, () => {
      const input = tone(431);
      const expected = convert(input, rate, input.length);
      assert.equal(expected.length, Math.round((input.length * rate) / 24_000));
      for (const size of [1, 7, 480, 512, 1024, 2400, 3072]) {
        assert.deepEqual(convert(input, rate, size), expected);
      }
      assert.ok(expected.every(Number.isFinite));
    });
  }

  it('passes native-rate PCM through without filtering', () => {
    const input = Float32Array.of(-1, 0.25, 0.9999, 0, -0.125);
    assert.deepEqual(convert(input, 24_000, 1), input);
  });

  it('keeps tiny chunks until the end marker without losing their tail', () => {
    const resampler = new StreamingOutputResampler(24_000, 44_100);
    assert.equal(resampler.push(Float32Array.of(0.4)).length, 0);
    assert.equal(resampler.push(Float32Array.of(0.4)).length, 0);
    const tail = resampler.finish();
    assert.equal(tail.length, 4);
    for (const sample of tail) assert.ok(Math.abs(sample - 0.4) < 0.000001);
  });

  it('does not add gain or discontinuities to a constant stream', () => {
    const input = new Float32Array(1201).fill(0.4);
    for (const rate of [16_000, 44_100, 48_000]) {
      for (const sample of convert(input, rate, 17)) {
        assert.ok(Math.abs(sample - 0.4) < 0.000001);
      }
    }
  });

  it('filters above-Nyquist energy when the output device runs at 16 kHz', () => {
    const rms = (samples: Float32Array) => {
      const middle = samples.subarray(200, samples.length - 200);
      return Math.sqrt(
        middle.reduce((sum, value) => sum + value * value, 0) / middle.length,
      );
    };
    const audible = rms(convert(tone(1000), 16_000, 512));
    const alias = rms(convert(tone(10_000), 16_000, 512));
    assert.ok(audible > 0.28 && audible < 0.285);
    assert.ok(alias / audible < 0.001);
  });

  it('does not leak the previous output into a new resampler', () => {
    convert(new Float32Array(19).fill(1), 44_100, 7);
    assert.ok(
      convert(new Float32Array(19), 44_100, 7).every((value) => value === 0),
    );
    assert.equal(
      new StreamingOutputResampler(24_000, 44_100).finish().length,
      0,
    );
  });
});
