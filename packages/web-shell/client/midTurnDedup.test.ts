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
  files?: unknown[];
  midTurnState?: 'submitting' | 'queued';
  midTurnMessageId?: string;
}

let nextId = 1;
const q = (text: string, images?: unknown[]): Item => {
  const id = nextId++;
  return {
    id,
    text,
    midTurnState: 'queued',
    midTurnMessageId: `mid-${id}`,
    ...(images ? { images } : {}),
  };
};
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

const batchWithIds = (
  sessionId: string,
  messages: string[],
  messageIds: string[],
): MidTurnInjectedBatch => ({ sessionId, messages, messageIds });

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

  it('never matches an image-bearing entry on the TEXT fallback', () => {
    const prompts = [q('with image', [{ data: 'x' }]), q('with image')];
    const next = removeInjectedFromQueue(
      prompts,
      [batch('s', 'with image')],
      's',
    );
    // The text-only one is removed; the image-bearing one stays — a text
    // comparison can't verify its attachments.
    expect(next).not.toBeNull();
    expect(next).toHaveLength(1);
    expect(next?.[0].images).toEqual([{ data: 'x' }]);
  });

  it('removes an image-bearing entry on a strict id match', () => {
    const imageRow = q('with image', [{ data: 'x' }]);
    const prompts = [q('keep'), imageRow];
    const next = removeInjectedFromQueue(
      prompts,
      [batchWithIds('s', ['with image'], [imageRow.midTurnMessageId!])],
      's',
    );
    expect(next?.map((p) => p.text)).toEqual(['keep']);
  });

  it('removes an in-flight explicit insert on a strict id match', () => {
    // An explicitly inserted row carries no `midTurnState` until its admission
    // response lands, so the strict-id pass must reach it through
    // `isInserting` — otherwise the injection echo leaves it queued twice.
    const inserting = {
      ...q('explicit insert', [{ data: 'x' }]),
      midTurnState: undefined,
      isInserting: true,
    };
    const next = removeInjectedFromQueue(
      [inserting, q('keep')],
      [batchWithIds('s', ['explicit insert'], [inserting.midTurnMessageId!])],
      's',
    );
    expect(next?.map((p) => p.text)).toEqual(['keep']);
  });

  it('never matches a file-bearing entry (files are not pushed mid-turn)', () => {
    const withFile = { ...q('with file'), files: [{ name: 'app.log' }] };
    const prompts = [withFile, q('with file')];
    const next = removeInjectedFromQueue(
      prompts,
      [batch('s', 'with file')],
      's',
    );
    // The text-only one is removed; the file-bearing one stays.
    expect(next).not.toBeNull();
    expect(next).toHaveLength(1);
    expect(next?.[0]).toBe(withFile);
  });

  it('does not remove an ordinary queued prompt with the same text', () => {
    const ordinary = { ...q('same'), midTurnState: undefined };
    const inserted = q('same');
    const next = removeInjectedFromQueue(
      [ordinary, inserted],
      [batch('s', 'same')],
      's',
    );
    expect(next).toEqual([ordinary]);
  });

  it('uses message ids instead of text when the daemon provides them', () => {
    const first = q('same');
    const second = q('same');
    const next = removeInjectedFromQueue(
      [first, second],
      [batchWithIds('s', ['same'], [second.midTurnMessageId!])],
      's',
    );
    expect(next).toEqual([first]);
  });

  it('matches a submitting prompt before its admission response provides the id', () => {
    const submitting = {
      ...q('early injection'),
      midTurnState: 'submitting' as const,
      midTurnMessageId: undefined,
    };
    const next = removeInjectedFromQueue(
      [submitting],
      [batchWithIds('s', ['early injection'], ['mid-early'])],
      's',
    );
    expect(next).toEqual([]);
  });

  it('matches an explicit insert before its admission response arrives', () => {
    const inserting = {
      text: 'early explicit insert',
      isInserting: true,
    };
    const next = removeInjectedFromQueue(
      [inserting],
      [batch('s', 'early explicit insert')],
      's',
    );
    expect(next).toEqual([]);
  });

  it('removes the id-matched row, not an earlier same-text row still submitting', () => {
    // Two same-text sends: the first is still awaiting its admission id, the
    // second was admitted and queued with an id. The injection frame names the
    // second's id, so it must be removed — an array-position text match on the
    // earlier row would silently drop it and leave the queued one to be resent
    // at idle (double delivery).
    const submitting = {
      ...q('x'),
      midTurnState: 'submitting' as const,
      midTurnMessageId: undefined,
    };
    const queued = q('x');
    const next = removeInjectedFromQueue(
      [submitting, queued],
      [batchWithIds('s', ['x'], [queued.midTurnMessageId!])],
      's',
    );
    expect(next).toEqual([submitting]);
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

    it('matches a stable id even when another client receives the echo', () => {
      const prompt = q('adopted');
      const next = removeInjectedFromQueue(
        [prompt],
        [
          {
            ...batchFrom('s', 'original-client', 'adopted'),
            messageIds: [prompt.midTurnMessageId!],
          },
        ],
        's',
        'new-client',
        true,
      );
      expect(next).toEqual([]);
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
