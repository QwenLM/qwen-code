/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_OUTPUT_SAMPLE_RATE,
  PcmPlayer,
  type PcmPlayerContext,
} from './pcm-player';

function createContext() {
  const nodes: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
    buffer: { duration: number; samples: Float32Array } | null;
  }> = [];
  const context = {
    currentTime: 0,
    destination: {},
    createBuffer: (_channels: number, length: number, rate: number) => {
      const samples = new Float32Array(length);
      return {
        duration: length / rate,
        samples,
        getChannelData: () => samples,
      };
    },
    createBufferSource: () => {
      const node = {
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null,
        buffer: null,
      };
      nodes.push(node);
      return node;
    },
  };
  return { context, nodes };
}

/** `seconds` of PCM16 at the Live output rate. */
function frame(seconds: number, value = 0): ArrayBuffer {
  const samples = Math.round(seconds * LIVE_OUTPUT_SAMPLE_RATE);
  const pcm = new Int16Array(samples).fill(value);
  return pcm.buffer;
}

function player(context: unknown): PcmPlayer {
  return new PcmPlayer(context as PcmPlayerContext);
}

describe('PcmPlayer', () => {
  it('schedules frames back to back on the audio clock', () => {
    const { context, nodes } = createContext();
    const value = player(context);

    value.enqueue(1, frame(0.5));
    value.enqueue(1, frame(0.25));
    value.enqueue(1, frame(0.25));

    const starts = nodes.map((node) => node.start.mock.calls[0]![0] as number);
    expect(starts[1]! - starts[0]!).toBeCloseTo(0.5);
    expect(starts[2]! - starts[1]!).toBeCloseTo(0.25);
    expect(value.pending).toBe(3);
  });

  it('decodes little-endian PCM16 into the [-1, 1) range', () => {
    const { context, nodes } = createContext();
    const pcm = new Int16Array([0, 0x4000, -0x8000]);
    player(context).enqueue(1, pcm.buffer);

    expect([...nodes[0]!.buffer!.samples]).toEqual([0, 0.5, -1]);
  });

  it('restarts from now after an underrun instead of piling up latency', () => {
    const { context, nodes } = createContext();
    const value = player(context);
    value.enqueue(1, frame(0.1));
    nodes[0]!.onended?.();

    // The network stalled: the clock ran far past the end of the last frame.
    context.currentTime = 10;
    value.enqueue(1, frame(0.1));

    const resumed = nodes[1]!.start.mock.calls[0]![0] as number;
    expect(resumed).toBeGreaterThanOrEqual(10);
    expect(resumed).toBeLessThan(10.1);
  });

  it('drops only the interrupted call when the user barges in', () => {
    const { context, nodes } = createContext();
    const value = player(context);
    value.enqueue(1, frame(0.2));
    value.enqueue(1, frame(0.2));
    value.enqueue(2, frame(0.2));

    value.clear(1);

    expect(nodes[0]!.stop).toHaveBeenCalledOnce();
    expect(nodes[1]!.stop).toHaveBeenCalledOnce();
    expect(nodes[2]!.stop).not.toHaveBeenCalled();
    expect(value.pending).toBe(1);
  });

  it('starts the next answer promptly once everything was cleared', () => {
    const { context, nodes } = createContext();
    const value = player(context);
    value.enqueue(1, frame(5));
    value.clear(1);

    context.currentTime = 1;
    value.enqueue(1, frame(0.1));

    // Not after the 5 s that were dropped.
    expect(nodes[1]!.start.mock.calls[0]![0] as number).toBeLessThan(1.1);
  });

  it('plays nothing while output is muted and cuts what was playing', () => {
    const { context, nodes } = createContext();
    const value = player(context);
    value.enqueue(1, frame(0.2));

    value.setMuted(true);
    value.enqueue(1, frame(0.2));

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.stop).toHaveBeenCalledOnce();

    value.setMuted(false);
    value.enqueue(1, frame(0.2));
    expect(nodes).toHaveLength(2);
  });

  it('ignores an empty or odd trailing byte frame', () => {
    const { context, nodes } = createContext();
    const value = player(context);
    value.enqueue(1, new ArrayBuffer(0));
    value.enqueue(1, new ArrayBuffer(1));
    expect(nodes).toHaveLength(0);
  });
});
