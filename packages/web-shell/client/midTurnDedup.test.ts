/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  removeInjectedFromQueue,
  type MidTurnInjectedBatch,
} from './midTurnDedup';

interface Item {
  id: number;
  text: string;
  images?: unknown[];
}

let nextId = 1;
const q = (text: string, images?: unknown[]): Item => ({
  id: nextId++,
  text,
  ...(images ? { images } : {}),
});
const batch = (sessionId: string, ...messages: string[]): MidTurnInjectedBatch => ({
  sessionId,
  messages,
});

describe('removeInjectedFromQueue', () => {
  it('removes the matching text-only entry for a single batch', () => {
    const prompts = [q('keep'), q('also check tests'), q('keep2')];
    const next = removeInjectedFromQueue(prompts, [batch('s', 'also check tests')], 's');
    expect(next?.map((p) => p.text)).toEqual(['keep', 'keep2']);
  });

  it('reconciles ACROSS multiple accumulated batches (the #439 regression)', () => {
    // A multi-batch turn publishes one frame per batch; both must be removed.
    const prompts = [q('first'), q('second'), q('stay')];
    const next = removeInjectedFromQueue(
      prompts,
      [batch('s', 'first'), batch('s', 'second')],
      's',
    );
    expect(next?.map((p) => p.text)).toEqual(['stay']);
  });

  it('is count-based: removes one queued entry per injected occurrence', () => {
    const prompts = [q('dup'), q('dup'), q('other')];
    // one injection -> one removal
    expect(
      removeInjectedFromQueue(prompts, [batch('s', 'dup')], 's')?.map((p) => p.text),
    ).toEqual(['dup', 'other']);
    // two injections (across batches) -> both removed
    expect(
      removeInjectedFromQueue(
        prompts,
        [batch('s', 'dup'), batch('s', 'dup')],
        's',
      )?.map((p) => p.text),
    ).toEqual(['other']);
  });

  it('never matches an image-bearing entry (images are not pushed mid-turn)', () => {
    const prompts = [q('with image', [{ data: 'x' }]), q('with image')];
    const next = removeInjectedFromQueue(prompts, [batch('s', 'with image')], 's');
    // The text-only one is removed; the image-bearing one stays.
    expect(next).not.toBeNull();
    expect(next).toHaveLength(1);
    expect(next?.[0].images).toEqual([{ data: 'x' }]);
  });

  it('skips batches for a different session', () => {
    const prompts = [q('x')];
    expect(removeInjectedFromQueue(prompts, [batch('other', 'x')], 's')).toBeNull();
  });

  it('returns null (no new array) when nothing matched', () => {
    const prompts = [q('a'), q('b')];
    expect(removeInjectedFromQueue(prompts, [batch('s', 'missing')], 's')).toBeNull();
    expect(removeInjectedFromQueue(prompts, [], 's')).toBeNull();
  });

  it('returns a new array, leaving the input untouched, when changed', () => {
    const prompts = [q('drop'), q('keep')];
    const next = removeInjectedFromQueue(prompts, [batch('s', 'drop')], 's');
    expect(next).not.toBe(prompts);
    expect(prompts).toHaveLength(2); // input not mutated
    expect(next).toHaveLength(1);
  });
});
