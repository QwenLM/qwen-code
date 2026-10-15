/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The subject is a plan that stopped describing its own diff.
//
// Chunks are line ranges into a diff FILE, and coverage re-reads the plan from
// its path long after the agents ran. Nothing tied the two together: the plan's
// mtime fences the prompt records, and says nothing about the diff. Rewrite the
// diff mid-run and every chunk id still matches while the lines behind it have
// moved — the review certifies chunk 7 and the agent read a different one.

import { describe, it, expect } from 'vitest';
import {
  buildSelectionIdentity,
  selectionDigest,
  selectionDrift,
  SELECTION_SCHEMA_VERSION,
} from './selection.js';
import type { DiffChunk } from './diff-plan.js';

const chunk = (id: number, startLine: number, endLine: number): DiffChunk => ({
  id,
  startLine,
  endLine,
  lines: endLine - startLine + 1,
  chars: 0,
  maxLineChars: 0,
  oversized: false,
  files: [],
});

const CHUNKS = [chunk(1, 1, 100), chunk(2, 101, 200)];
const DIFF = 'diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n+x\n';

describe('selectionDigest', () => {
  it('is this exact digest for this chunk list, under this schema version', () => {
    // Every other test here compares a digest with another digest, so none of
    // them notices the canonical form changing — and a plan an older build
    // wrote would then be reported as "edited after it was written". The
    // form is part of `qwen.review-selection/v1`: change it, and this vector
    // and the schema version change with it.
    expect(SELECTION_SCHEMA_VERSION).toBe('qwen.review-selection/v1');
    expect(selectionDigest(CHUNKS)).toBe(
      '8485afc714264017a7114242b7bd0c185c37ec1dc6015c9a9d74dd66440d5aed',
    );
  });

  it('is stable across the order the chunks were emitted in', () => {
    // The selection is a SET of ranges. A plan that listed the same chunks in
    // another order selected the same scope, and a digest that disagreed would
    // report drift on a plan nothing had touched.
    expect(selectionDigest([...CHUNKS].reverse())).toBe(
      selectionDigest(CHUNKS),
    );
  });

  it('changes when a boundary moves', () => {
    expect(selectionDigest([chunk(1, 1, 100), chunk(2, 101, 201)])).not.toBe(
      selectionDigest(CHUNKS),
    );
  });

  it('changes when an id changes, boundaries held', () => {
    // The id is what a launch prompt, a prompt record and a coverage receipt
    // are all keyed by. Two plans with the same ranges under different ids are
    // not the same selection.
    expect(selectionDigest([chunk(7, 1, 100), chunk(8, 101, 200)])).not.toBe(
      selectionDigest(CHUNKS),
    );
  });

  it('cannot be made to spell two different chunk lists the same way', () => {
    // Hand-joined, `1:1-1` + `12:5-9` and `1:1-11` + `2:5-9` run together
    // into one string once the separator goes…
    expect(selectionDigest([chunk(1, 1, 1), chunk(12, 5, 9)])).not.toBe(
      selectionDigest([chunk(1, 1, 11), chunk(2, 5, 9)]),
    );
    // …and no separator survives a reader's input: it digests a PARSED plan,
    // where nothing has checked that `endLine` is a number, so a string can
    // carry the separator itself and fold two chunks into one.
    const two = [chunk(1, 1, 100), chunk(2, 101, 200)];
    const folded = [
      { id: 1, startLine: 1, endLine: '100\u00002:101-200' },
    ] as unknown as DiffChunk[];
    expect(selectionDigest(folded)).not.toBe(selectionDigest(two));
  });

  it('changes when only a start moves', () => {
    expect(selectionDigest([chunk(1, 1, 100), chunk(2, 101, 200)])).not.toBe(
      selectionDigest([chunk(1, 1, 100), chunk(2, 102, 200)]),
    );
  });

  it('does not throw on a field a template literal cannot print', () => {
    // A parsed plan can hold `{ "toString": 1 }` where a number belongs.
    const odd = [
      { id: 1, startLine: { toString: 1 }, endLine: 100 },
    ] as unknown as DiffChunk[];
    expect(() => selectionDigest(odd)).not.toThrow();
  });

  it('distinguishes one chunk from two that tile the same lines', () => {
    expect(selectionDigest([chunk(1, 1, 200)])).not.toBe(
      selectionDigest(CHUNKS),
    );
  });
});

describe('selectionDrift', () => {
  const identity = buildSelectionIdentity(DIFF, CHUNKS);

  it('reports nothing when the diff and the chunks are unchanged', () => {
    expect(selectionDrift(identity, DIFF, CHUNKS)).toBeNull();
  });

  it('reports nothing for a plan too old to carry an identity', () => {
    // Absence of evidence, not evidence of drift. Every plan written before
    // this field existed is old, not wrong, and narrating a defect at every
    // reader on every pre-existing plan would be a false record.
    expect(selectionDrift(undefined, DIFF, CHUNKS)).toBeNull();
    expect(selectionDrift(null, DIFF, CHUNKS)).toBeNull();
  });

  it('names the diff when its content changed under the plan', () => {
    const drifted = selectionDrift(identity, `${DIFF}+one more line\n`, CHUNKS);
    expect(drifted).toMatch(/diff file has changed/);
    // The repair is an operator's, and the message says which one: nothing an
    // agent does can fix a moved line range.
    expect(drifted).toMatch(/re-capture the diff and re-plan/);
  });

  it('names the boundaries when the plan was edited in place', () => {
    const edited = [chunk(1, 1, 120), chunk(2, 121, 200)];
    const said = selectionDrift(identity, DIFF, edited);
    expect(said).toMatch(/chunk boundaries do not match/);
    // The repair is the plan's, not the diff's: the diff matched.
    expect(said).toMatch(/— re-plan$/);
    expect(said).not.toMatch(/re-capture/);
  });

  it('refuses an identity from a schema it cannot read', () => {
    // A reader that cannot interpret a field must say so, not skip it: silently
    // ignoring a future schema is how a check stops running without anyone
    // noticing it stopped.
    const future = { ...identity, schemaVersion: 'qwen.review-selection/v2' };
    const said = selectionDrift(future, DIFF, CHUNKS);
    expect(said).toMatch(/cannot\s+read/);
    expect(said).toContain(SELECTION_SCHEMA_VERSION);
    // The value found is plan JSON, and this string reaches a terminal and
    // an orchestrator: it is not echoed, whatever it holds.
    expect(said).not.toContain('v2');
    const hostile = { ...identity, schemaVersion: 'x\u202e'.repeat(50_000) };
    expect(selectionDrift(hostile, DIFF, CHUNKS)).toBe(said);
  });

  it('names an identity whose digests are missing as unreadable, not as drift', () => {
    // A hand-edited or half-written identity is not evidence that the diff
    // moved: comparing `undefined` against the actual hash would read as
    // "the diff file has changed" and send the operator to re-capture a diff
    // that never did.
    const { sourceArtifactSha256: _dropped, ...halfWritten } = identity;
    const said = selectionDrift(halfWritten, DIFF, CHUNKS);
    expect(said).toMatch(/missing its digests/);
    expect(said).not.toMatch(/diff file has changed/);
  });

  it('names a changed diff first when the boundaries moved as well', () => {
    // Re-capturing is the repair that also fixes the other; "re-plan" alone
    // would leave the plan over a diff that still moved.
    const edited = [chunk(1, 1, 120), chunk(2, 121, 200)];
    expect(selectionDrift(identity, `${DIFF}+more\n`, edited)).toMatch(
      /diff file has changed/,
    );
  });

  it.each([
    ['empty', ''],
    ['truncated', 'abc123'],
    ['re-cased', 'A'.repeat(64)],
    ['over-long', 'a'.repeat(65)],
    ['prefixed', `x${'a'.repeat(64)}`],
  ])(
    'names a %s digest as unreadable, not as a diff that changed',
    (_shape, bad) => {
      // A string that is not a sha256 compares unequal to the actual hash
      // just as `undefined` does — and would send the operator to re-capture
      // a diff that never moved. Either half, since both are compared.
      for (const field of ['sourceArtifactSha256', 'selectionSha256']) {
        const said = selectionDrift(
          { ...identity, [field]: bad },
          DIFF,
          CHUNKS,
        );
        expect(said).toMatch(/not a sha256/);
        expect(said).not.toMatch(/has changed|do not match/);
      }
    },
  );

  it('names a missing boundary digest as unreadable too', () => {
    const { selectionSha256: _dropped, ...half } = identity;
    expect(selectionDrift(half, DIFF, CHUNKS)).toMatch(/missing its digests/);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['non-finite', Number.POSITIVE_INFINITY],
    ['a string', '100'],
  ])('names a %s line number as that, instead of digesting it', (_n, bad) => {
    // JSON folds a missing boundary, `null` and `Infinity` into one spelling,
    // so digested they would be three different chunk lists under one digest
    // — and `Infinity` is a range every read "covers". Either end of the
    // range, since both are digested.
    for (const field of ['startLine', 'endLine']) {
      const odd = [
        chunk(1, 1, 100),
        { ...chunk(2, 101, 200), [field]: bad },
      ] as unknown as DiffChunk[];
      const said = selectionDrift(identity, DIFF, odd);
      expect(said).toMatch(/not a pair of numbers/);
      expect(said).toMatch(/re-plan$/);
    }
  });

  it('refuses a `selection` that is not an object', () => {
    expect(selectionDrift('nope', DIFF, CHUNKS)).toMatch(/not an object/);
    expect(selectionDrift([identity], DIFF, CHUNKS)).toMatch(/not an object/);
    // Every message names its repair; this one had none.
    expect(selectionDrift('nope', DIFF, CHUNKS)).toMatch(/re-plan$/);
  });
});

describe('buildSelectionIdentity', () => {
  it('records the schema and the two digests, and nothing else', () => {
    // Nothing else, on purpose: a count cannot disagree once the boundary
    // digest matches, and a line count would duplicate the plan's own. A
    // field no reader checks can only ever be wrong.
    const id = buildSelectionIdentity(DIFF, CHUNKS);
    expect(Object.keys(id).sort()).toEqual([
      'schemaVersion',
      'selectionSha256',
      'sourceArtifactSha256',
    ]);
    expect(id.schemaVersion).toBe(SELECTION_SCHEMA_VERSION);
    expect(id.sourceArtifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(id.selectionSha256).toBe(selectionDigest(CHUNKS));
  });

  it('digests the diff TEXT: a different text is a different identity', () => {
    // Against a digest that ignores its input — a constant, the chunk list,
    // a re-encoded form — which a same-text comparison cannot tell apart
    // from the real thing.
    const a = buildSelectionIdentity(DIFF, CHUNKS);
    const moved = buildSelectionIdentity(`${DIFF}+moved\n`, CHUNKS);
    expect(moved.sourceArtifactSha256).not.toBe(a.sourceArtifactSha256);
    // …and the boundary digest does not move with the text.
    expect(moved.selectionSha256).toBe(a.selectionSha256);
  });
});
