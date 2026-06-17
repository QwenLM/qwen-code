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
const batch = (
  sessionId: string,
  ...messages: string[]
): MidTurnInjectedBatch => ({
  sessionId,
  messages,
});
const batchFrom = (
  sessionId: string,
  originatorClientId: string,
  ...messages: string[]
): MidTurnInjectedBatch => ({ sessionId, originatorClientId, messages });

describe('removeInjectedFromQueue', () => {
  it('removes the matching text-only entry for a single batch', () => {
    const prompts = [q('keep'), q('also check tests'), q('keep2')];
    const next = removeInjectedFromQueue(
      prompts,
      [batch('s', 'also check tests')],
      's',
    );
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
      removeInjectedFromQueue(prompts, [batch('s', 'dup')], 's')?.map(
        (p) => p.text,
      ),
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
    const next = removeInjectedFromQueue(
      prompts,
      [batch('s', 'with image')],
      's',
    );
    // The text-only one is removed; the image-bearing one stays.
    expect(next).not.toBeNull();
    expect(next).toHaveLength(1);
    expect(next?.[0].images).toEqual([{ data: 'x' }]);
  });

  it('skips batches for a different session', () => {
    const prompts = [q('x')];
    expect(
      removeInjectedFromQueue(prompts, [batch('other', 'x')], 's'),
    ).toBeNull();
  });

  it('returns null (no new array) when nothing matched', () => {
    const prompts = [q('a'), q('b')];
    expect(
      removeInjectedFromQueue(prompts, [batch('s', 'missing')], 's'),
    ).toBeNull();
    expect(removeInjectedFromQueue(prompts, [], 's')).toBeNull();
  });

  it('returns a new array, leaving the input untouched, when changed', () => {
    const prompts = [q('drop'), q('keep')];
    const next = removeInjectedFromQueue(prompts, [batch('s', 'drop')], 's');
    expect(next).not.toBe(prompts);
    expect(prompts).toHaveLength(2); // input not mutated
    expect(next).toHaveLength(1);
  });

  // The daemon stamps each drained frame with the originator's client id and
  // broadcasts it to every client on the session. Only the originator should
  // dedupe its own queue; a peer with a coincidentally-equal entry must keep it.
  describe('originator (clientId) filtering', () => {
    it('dedupes a batch whose originator matches our client id', () => {
      const prompts = [q('mine'), q('keep')];
      const next = removeInjectedFromQueue(
        prompts,
        [batchFrom('s', 'me', 'mine')],
        's',
        'me',
      );
      expect(next?.map((p) => p.text)).toEqual(['keep']);
    });

    it('skips a batch originated by a DIFFERENT client (no spurious dedupe)', () => {
      // A peer pushed 'shared'; our identical queue entry was never injected on
      // our side, so it must survive to be sent as our own next turn.
      const prompts = [q('shared')];
      expect(
        removeInjectedFromQueue(
          prompts,
          [batchFrom('s', 'peer', 'shared')],
          's',
          'me',
        ),
      ).toBeNull();
    });

    it('dedupes an anonymous batch (no originator) regardless of our client id', () => {
      const prompts = [q('anon'), q('keep')];
      const next = removeInjectedFromQueue(
        prompts,
        [batch('s', 'anon')],
        's',
        'me',
      );
      expect(next?.map((p) => p.text)).toEqual(['keep']);
    });

    it('routes a mixed-originator set: ours dedupes, the peer’s is skipped', () => {
      const prompts = [q('mine'), q('theirs'), q('keep')];
      const next = removeInjectedFromQueue(
        prompts,
        [batchFrom('s', 'me', 'mine'), batchFrom('s', 'peer', 'theirs')],
        's',
        'me',
      );
      expect(next?.map((p) => p.text)).toEqual(['theirs', 'keep']);
    });

    it('skips our OWN-tagged batch when no client id is supplied (regression guard)', () => {
      // If the caller forgets to pass its client id, an originator-tagged batch
      // must NOT be force-deduped — but it also won't be reconciled, surfacing
      // the wiring gap rather than silently double-delivering. (The web-shell
      // always passes connection.clientId; this pins the helper's contract.)
      const prompts = [q('mine')];
      expect(
        removeInjectedFromQueue(prompts, [batchFrom('s', 'me', 'mine')], 's'),
      ).toBeNull();
    });
  });
});
