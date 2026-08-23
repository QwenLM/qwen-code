/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from './protocol.js';

function collect(): {
  frames: unknown[];
  errors: Error[];
  decoder: FrameDecoder;
} {
  const frames: unknown[] = [];
  const errors: Error[] = [];
  const decoder = new FrameDecoder(
    (frame) => frames.push(frame),
    (error) => errors.push(error),
  );
  return { frames, errors, decoder };
}

describe('encodeFrame', () => {
  it('produces a single newline-terminated JSON line', () => {
    const encoded = encodeFrame({ type: 'ready', generation: 1 });
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.indexOf('\n')).toBe(encoded.length - 1);
    expect(JSON.parse(encoded)).toEqual({ type: 'ready', generation: 1 });
  });

  it('rejects frames above MAX_FRAME_BYTES instead of emitting them', () => {
    const big = { type: 'write', text: 'x'.repeat(MAX_FRAME_BYTES) };
    expect(() => encodeFrame(big)).toThrow(/exceeds/);
  });

  it('every frame encodeFrame accepts is decodable (boundary round-trip)', () => {
    // Largest accepted frame: encoded line + '\n' == MAX_FRAME_BYTES exactly.
    const overhead = JSON.stringify({ type: 'write', text: '' }).length;
    const text = 'x'.repeat(MAX_FRAME_BYTES - overhead - 1);
    const encoded = encodeFrame({ type: 'write', text });
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(MAX_FRAME_BYTES);
    const { frames, errors, decoder } = collect();
    decoder.push(encoded);
    expect(errors).toEqual([]);
    expect(frames).toHaveLength(1);
    // One byte more must be rejected at encode time, not at decode time.
    expect(() => encodeFrame({ type: 'write', text: `${text}x` })).toThrow(
      /exceeds/,
    );
  });
});

describe('FrameDecoder', () => {
  it('decodes a complete frame', () => {
    const { frames, errors, decoder } = collect();
    decoder.push('{"type":"ready","generation":3}\n');
    expect(frames).toEqual([{ type: 'ready', generation: 3 }]);
    expect(errors).toHaveLength(0);
  });

  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const { frames, errors, decoder } = collect();
    const line = encodeFrame({ type: 'write', execId: 'e1', text: 'hello' });
    for (const ch of line) decoder.push(ch);
    expect(frames).toEqual([{ type: 'write', execId: 'e1', text: 'hello' }]);
    expect(errors).toHaveLength(0);
  });

  it('decodes multiple frames arriving in one chunk', () => {
    const { frames, decoder } = collect();
    decoder.push(
      encodeFrame({ type: 'a' as string }) + encodeFrame({ type: 'b' }),
    );
    expect(frames).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  it('survives multi-byte UTF-8 characters split across chunks', () => {
    const { frames, errors, decoder } = collect();
    const line = Buffer.from(
      encodeFrame({ type: 'write', text: '你好，世界' }),
      'utf8',
    );
    // Split in the middle of a CJK character (3-byte sequences).
    const splitAt = line.indexOf(Buffer.from('好', 'utf8')[0]!) + 1;
    decoder.push(line.subarray(0, splitAt));
    decoder.push(line.subarray(splitAt));
    expect(errors).toHaveLength(0);
    expect(frames).toEqual([{ type: 'write', text: '你好，世界' }]);
  });

  it('reports undecodable lines as protocol errors and keeps going', () => {
    const { frames, errors, decoder } = collect();
    decoder.push('this is not json\n{"type":"ok"}\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/undecodable/);
    expect(frames).toEqual([{ type: 'ok' }]);
  });

  it('reports frames without a string "type" as protocol errors', () => {
    const { frames, errors, decoder } = collect();
    decoder.push('{"no_type":true}\n[1,2,3]\n"str"\n');
    expect(errors).toHaveLength(3);
    expect(frames).toHaveLength(0);
  });

  it('reports an unterminated oversize stream and clears the buffer', () => {
    const { frames, errors, decoder } = collect();
    const chunk = 'x'.repeat(1024 * 1024);
    for (let pushed = 0; pushed <= MAX_FRAME_BYTES; pushed += chunk.length) {
      decoder.push(chunk);
    }
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.message).toMatch(/exceeded/);
    decoder.push('{"type":"recovered"}\n');
    expect(frames).toEqual([{ type: 'recovered' }]);
  });

  it('ignores blank lines', () => {
    const { frames, errors, decoder } = collect();
    decoder.push('\n  \n{"type":"ok"}\n\n');
    expect(frames).toEqual([{ type: 'ok' }]);
    expect(errors).toHaveLength(0);
  });
});

describe('FrameDecoder frame integrity', () => {
  const frame = (id: string) => `${JSON.stringify({ type: 'x', id })}\n`;

  it('recovers buffered frames after a frame handler throws mid-drain', () => {
    const seen: string[] = [];
    const decoder = new FrameDecoder(
      (f) => {
        const id = (f as { id: string }).id;
        seen.push(id);
        if (id === 'a') throw new Error('handler boom');
      },
      () => {},
    );
    // The throw unwinds push() with b/c/d still buffered.
    expect(() =>
      decoder.push(frame('a') + frame('b') + frame('c') + frame('d')),
    ).toThrow(/handler boom/);
    // The next push must rescan from the start and deliver them, not skip them.
    decoder.push(frame('e'));
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('does not duplicate frames on the normal path', () => {
    const seen: string[] = [];
    const decoder = new FrameDecoder(
      (f) => seen.push((f as { id: string }).id),
      () => {},
    );
    decoder.push(frame('1') + frame('2'));
    decoder.push(frame('3'));
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('keeps working after an unterminated oversize stream resets it', () => {
    const seen: string[] = [];
    const errors: string[] = [];
    const decoder = new FrameDecoder(
      (f) => seen.push((f as { id: string }).id),
      (e) => errors.push(e.message),
    );
    decoder.push('x'.repeat(MAX_FRAME_BYTES + 10));
    expect(errors.some((m) => /without a terminator/.test(m))).toBe(true);
    decoder.push(frame('after-overflow'));
    expect(seen).toEqual(['after-overflow']);
  });
});
