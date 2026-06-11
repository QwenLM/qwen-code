/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isValidSessionId } from './chatsPath.js';
import type { ForkRecord } from './forkTranscript.js';
import {
  parentOf,
  walkLineage,
  MAX_LINEAGE_DEPTH,
  type WalkLineageOpts,
} from './lineage.js';

// Valid 32-hex session ids.
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const D = 'd'.repeat(32);
const BAD = 'not-a-valid-session-id';

/** A transcript record that declares `parent` as its fork source. */
function child(parent: string): ForkRecord {
  return { forkedFrom: { sessionId: parent, messageUuid: 'm0' }, type: 'user' };
}
/** A root (non-forked) transcript record. */
function root(): ForkRecord {
  return { type: 'user', message: { role: 'user' } };
}

/** A reader over an in-memory file map; an absent key reads as null (missing). */
function reader(
  files: Record<string, ForkRecord[] | null>,
): WalkLineageOpts['readRecords'] {
  return async (id: string) => (id in files ? files[id] : null);
}

function opts(files: Record<string, ForkRecord[] | null>, maxDepth?: number) {
  return { readRecords: reader(files), isValidId: isValidSessionId, maxDepth };
}

describe('parentOf', () => {
  it('returns null for a root (no forkedFrom)', () => {
    expect(parentOf([root()])).toBeNull();
  });
  it('returns the first record forkedFrom.sessionId', () => {
    expect(parentOf([child(B), child(B)])).toBe(B);
  });
  it('returns null for null / empty records', () => {
    expect(parentOf(null)).toBeNull();
    expect(parentOf([])).toBeNull();
  });
  it('returns null when forkedFrom.sessionId is not a string', () => {
    expect(parentOf([{ forkedFrom: { sessionId: 123 } }])).toBeNull();
    expect(parentOf([{ forkedFrom: {} }])).toBeNull();
    expect(parentOf([{ forkedFrom: 'nope' }])).toBeNull();
  });
  it('reads ONLY the first record (a later forkedFrom does not count)', () => {
    expect(parentOf([root(), child(B)])).toBeNull();
  });
});

describe('walkLineage', () => {
  it('a root session yields a single-node, non-truncated chain', async () => {
    const r = await walkLineage(A, opts({ [A]: [root()] }));
    expect(r).toEqual({
      sessionId: A,
      chain: [{ sessionId: A }],
      truncated: false,
    });
  });

  it('a one-deep fork yields [self, parent]', async () => {
    const r = await walkLineage(A, opts({ [A]: [child(B)], [B]: [root()] }));
    expect(r).toEqual({
      sessionId: A,
      chain: [{ sessionId: A }, { sessionId: B }],
      truncated: false,
    });
  });

  it('an N-deep fork walks to root in order', async () => {
    const r = await walkLineage(
      A,
      opts({ [A]: [child(B)], [B]: [child(C)], [C]: [root()] }),
    );
    expect(r?.chain.map((n) => n.sessionId)).toEqual([A, B, C]);
    expect(r?.truncated).toBe(false);
  });

  it('returns null when the start transcript is missing', async () => {
    expect(await walkLineage(A, opts({}))).toBeNull();
  });

  it('truncates (without fabricating) when a mid-chain parent is gone', async () => {
    // A -> B, but B's transcript was deleted.
    const r = await walkLineage(A, opts({ [A]: [child(B)] }));
    expect(r).toEqual({
      sessionId: A,
      chain: [{ sessionId: A }],
      truncated: true,
    });
  });

  it('truncates on a cycle (defense-in-depth)', async () => {
    const r = await walkLineage(A, opts({ [A]: [child(B)], [B]: [child(A)] }));
    expect(r?.chain.map((n) => n.sessionId)).toEqual([A, B]);
    expect(r?.truncated).toBe(true);
  });

  it('truncates on a self-referential forkedFrom', async () => {
    const r = await walkLineage(A, opts({ [A]: [child(A)] }));
    expect(r).toEqual({
      sessionId: A,
      chain: [{ sessionId: A }],
      truncated: true,
    });
  });

  it('truncates at the depth cap, keeping the first maxDepth nodes', async () => {
    const files = {
      [A]: [child(B)],
      [B]: [child(C)],
      [C]: [child(D)],
      [D]: [root()],
    };
    const r = await walkLineage(A, opts(files, 2));
    expect(r?.chain.map((n) => n.sessionId)).toEqual([A, B]);
    expect(r?.truncated).toBe(true);
  });

  it('truncates on an invalid forkedFrom id without reading it', async () => {
    const r = await walkLineage(A, opts({ [A]: [child(BAD)] }));
    expect(r).toEqual({
      sessionId: A,
      chain: [{ sessionId: A }],
      truncated: true,
    });
  });

  it('treats a non-string forkedFrom as a root (not truncated)', async () => {
    const r = await walkLineage(
      A,
      opts({ [A]: [{ forkedFrom: { sessionId: 999 } }] }),
    );
    expect(r).toEqual({
      sessionId: A,
      chain: [{ sessionId: A }],
      truncated: false,
    });
  });

  it('defaults the cap to MAX_LINEAGE_DEPTH', () => {
    expect(MAX_LINEAGE_DEPTH).toBe(100);
  });
});
