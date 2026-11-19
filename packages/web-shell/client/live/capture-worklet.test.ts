/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { floatToPcm16 } from '../voice/capture-utils';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'capture-worklet.js'),
  'utf8',
);

interface Posted {
  pcm: ArrayBuffer;
  level: number;
}

/** Evaluate the worklet file the way the audio thread does: with its globals. */
function loadProcessor(frameSize?: number) {
  const posted: Array<{ message: Posted; transfer: unknown[] }> = [];
  let registered: { name: string; ctor: new (options?: unknown) => unknown };
  class AudioWorkletProcessor {
    port = {
      postMessage: (message: Posted, transfer: unknown[]) =>
        posted.push({ message, transfer }),
    };
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', SOURCE)(
    AudioWorkletProcessor,
    (name: string, ctor: new (options?: unknown) => unknown) => {
      registered = { name, ctor };
    },
  );
  const processor = new registered!.ctor(
    frameSize === undefined ? undefined : { processorOptions: { frameSize } },
  ) as { process: (inputs: Float32Array[][]) => boolean };
  return { name: registered!.name, processor, posted };
}

function quantum(values: number[]): Float32Array[][] {
  return [[Float32Array.from(values)]];
}

describe('Live capture worklet', () => {
  it('is a single import-free file the audio thread can load as is', () => {
    expect(SOURCE).not.toMatch(/^\s*import\s/m);
    expect(SOURCE).not.toMatch(/^\s*export\s/m);
    expect(loadProcessor().name).toBe('qwen-live-capture');
  });

  it('collects 128-sample render quanta into one frame', () => {
    const { processor, posted } = loadProcessor(1024);
    for (let i = 0; i < 7; i++) {
      expect(processor.process(quantum(new Array(128).fill(0.25)))).toBe(true);
    }
    expect(posted).toHaveLength(0);

    processor.process(quantum(new Array(128).fill(0.25)));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message.pcm.byteLength).toBe(1024 * 2);
    // The buffer is handed over, not copied, on every frame.
    expect(posted[0]!.transfer).toEqual([posted[0]!.message.pcm]);
  });

  it('carries samples across a quantum that straddles two frames', () => {
    const { processor, posted } = loadProcessor(4);
    processor.process(quantum([0.1, 0.2, 0.3]));
    processor.process(quantum([0.4, 0.5, 0.6, 0.7, 0.8]));

    expect(posted).toHaveLength(2);
    const first = new Int16Array(posted[0]!.message.pcm);
    const second = new Int16Array(posted[1]!.message.pcm);
    expect([...first]).toEqual([
      ...new Int16Array(
        floatToPcm16(Float32Array.from([0.1, 0.2, 0.3, 0.4])).pcm,
      ),
    ]);
    expect([...second]).toEqual([
      ...new Int16Array(
        floatToPcm16(Float32Array.from([0.5, 0.6, 0.7, 0.8])).pcm,
      ),
    ]);
  });

  it('converts and measures exactly like the main-thread capture path', () => {
    // Out-of-range samples, both signs, silence: the daemon must not be able
    // to tell which capture path produced a frame.
    const samples = [0, 0.5, -0.5, 1, -1, 1.7, -2.3, 0.123456, -0.987654];
    const { processor, posted } = loadProcessor(samples.length);
    processor.process(quantum(samples));

    const expected = floatToPcm16(Float32Array.from(samples));
    expect([...new Int16Array(posted[0]!.message.pcm)]).toEqual([
      ...new Int16Array(expected.pcm),
    ]);
    expect(posted[0]!.message.level).toBeCloseTo(expected.level, 12);
  });

  it('stays alive through a missing input instead of ending the node', () => {
    const { processor, posted } = loadProcessor(4);
    expect(processor.process([])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    expect(posted).toHaveLength(0);
  });

  it('falls back to 1024 samples when given no usable frame size', () => {
    const { processor, posted } = loadProcessor(0);
    processor.process(quantum(new Array(1024).fill(0)));
    expect(posted).toHaveLength(1);
  });
});
