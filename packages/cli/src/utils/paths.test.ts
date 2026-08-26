/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { safeTarget } from './paths.js';

describe('safeTarget — the length cap', () => {
  it('caps a legal-but-deep path instead of throwing ENAMETOOLONG', () => {
    // Every component here is well under NAME_MAX; only the FLATTENED
    // spelling is long. Uncapped it became a 268-character filename once
    // `tmpFile` wrapped it, so `writeFileSync` threw and the capture died
    // before it wrote the plan — every round, for that target and no other.
    // The class is new to the repo-relative target: a basename never got
    // near the ceiling.
    const deep = `${'d'.repeat(230)}/x.ts`;
    const stem = safeTarget(deep);
    expect(stem.length).toBe(64);
    // The wrapped filename clears NAME_MAX with room to spare.
    expect(`qwen-review-${stem}-cache-candidate.json`.length).toBeLessThan(255);
  });

  it('keeps two deep paths with a shared head apart', () => {
    // Ordinary in a monorepo, and a bare cut would give them one cache, one
    // set of artifacts, and each other's anchor.
    const head = 'a'.repeat(200);
    expect(safeTarget(`${head}/one.ts`)).not.toBe(safeTarget(`${head}/two.ts`));
  });

  it('is deterministic, and leaves a short target byte-identical', () => {
    // The naming is a two-sided contract — the parent polls for a name the
    // child writes — so the cap must not move any slug that was not broken.
    expect(safeTarget('src/foo.ts')).toBe('src_foo.ts');
    const deep = `${'d'.repeat(230)}/x.ts`;
    expect(safeTarget(deep)).toBe(safeTarget(deep));
  });

  it('leaves capped stems mutually prefix-free, for the cleanup sweep', () => {
    // `cleanup` filters `startsWith(tmpPrefix(target))`. Every capped stem is
    // exactly 64 characters, so none can be a strict prefix of another.
    const a = safeTarget('x'.repeat(300));
    const b = safeTarget('y'.repeat(300));
    expect(a.length).toBe(b.length);
    expect(a.startsWith(b)).toBe(false);
    expect(b.startsWith(a)).toBe(false);
  });

  it('keeps capped stems prefix-free against UNCAPPED stems too', () => {
    // R17-6 entrance 2: with `-` as the cap joiner, every exactly-55-char
    // uncapped stem was a strict sweep-prefix of every capped stem sharing
    // its head — `qwen-review-<head55>-` matched the capped twin's whole
    // family and cleanup deleted its live artifacts mid-round. The joiner is
    // `~`, which sits OUTSIDE the token alphabet (the flatten maps a literal
    // `~` in the input to `_`), so no uncapped stem can spell a capped
    // stem's head-plus-joiner.
    const head = 'h'.repeat(55);
    const capped = safeTarget(`${head}${'x'.repeat(300)}`);
    expect(capped.length).toBe(64);
    expect(capped.charAt(55)).toBe('~');
    const uncapped = safeTarget(head);
    expect(uncapped).toBe(head);
    expect(capped.startsWith(`${uncapped}-`)).toBe(false);
    // A literal `~` in the INPUT cannot forge the joiner.
    expect(safeTarget(`${head}~deadbeef`)).toBe(`${head}_deadbeef`);
  });
});

describe('safeTarget', () => {
  it('flattens separators but preserves dotted slugs', () => {
    expect(safeTarget('src/foo.ts')).toBe('src_foo.ts');
    expect(safeTarget('packages/core')).toBe('packages_core');
    expect(safeTarget('archive.tar.gz')).toBe('archive.tar.gz');
  });

  it('keeps dashes — artifact naming is a two-sided contract', () => {
    // Review producers hardcode the dash spelling (bundled-skill templates,
    // composed names, prev-ledger); the lift must not rename any slug.
    expect(safeTarget('pr-6771')).toBe('pr-6771');
    expect(safeTarget('foo-bar')).toBe('foo-bar');
  });

  it('neutralizes traversal tokens', () => {
    expect(safeTarget('../../evil')).toBe('evil');
    expect(safeTarget('..\\..\\evil')).toBe('evil');
    expect(safeTarget('foo..bar')).toBe('foo_bar');
  });

  it('maps odd characters to underscores', () => {
    expect(safeTarget('C:/tmp/x')).toBe('C__tmp_x');
    expect(safeTarget('a b:c')).toBe('a_b_c');
  });

  it('strips leading dots and underscores (byte-identical to the pre-lift behavior)', () => {
    expect(safeTarget('./--verbose')).toBe('--verbose');
    expect(safeTarget('_foo')).toBe('foo');
    expect(safeTarget('...foo')).toBe('foo');
    // Dashes are NOT leading-stripped — matching the pre-lift implementation
    // exactly is the lift's contract.
    expect(safeTarget('-foo')).toBe('-foo');
  });

  it('falls back to "target" when nothing safe remains', () => {
    expect(safeTarget('')).toBe('target');
    expect(safeTarget('.')).toBe('target');
    expect(safeTarget('...')).toBe('target');
    expect(safeTarget('///')).toBe('target');
  });
});
