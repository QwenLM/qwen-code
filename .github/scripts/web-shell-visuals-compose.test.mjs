/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANGED_PCT_THRESHOLD,
  countDenoisedChanges,
  isChanged,
  parseShot,
  planWork,
  unpackBitMask,
} from './web-shell-visuals-compose.mjs';

/** Build a row-major 0/1 mask from a predicate. */
function mask(width, height, isSet) {
  const m = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      m[y * width + x] = isSet(x, y) ? 1 : 0;
    }
  }
  return m;
}

test('parseShot extracts view + theme, is case-insensitive, and strips dirs', () => {
  assert.deepEqual(parseShot('mermaid-diagram-light.png'), {
    view: 'mermaid-diagram',
    theme: 'light',
  });
  assert.deepEqual(parseShot('permission-panel-DARK.png'), {
    view: 'permission-panel',
    theme: 'dark',
  });
  // A view name may itself contain a dash — only the final -light/-dark splits.
  assert.deepEqual(parseShot('a/b/session-transcript-dark.png'), {
    view: 'session-transcript',
    theme: 'dark',
  });
});

test('parseShot rejects non-screenshot names (gifs, manifest, themeless)', () => {
  assert.equal(parseShot('model-switch.gif'), null);
  assert.equal(parseShot('manifest.json'), null);
  assert.equal(parseShot('mermaid-diagram.png'), null); // no -light/-dark
  assert.equal(parseShot('random.png'), null);
});

test('isChanged: a view with no baseline (PR-added) always counts as changed', () => {
  assert.equal(isChanged({ hasBefore: false, changedPct: 0 }), true);
});

test('isChanged: with a baseline, only meets threshold counts as changed', () => {
  assert.equal(isChanged({ hasBefore: true, changedPct: 0 }), false);
  // Below the threshold (relative, so it survives a threshold retune).
  assert.equal(
    isChanged({ hasBefore: true, changedPct: CHANGED_PCT_THRESHOLD / 2 }),
    false,
  );
  assert.equal(
    isChanged({ hasBefore: true, changedPct: CHANGED_PCT_THRESHOLD }),
    true,
  );
  assert.equal(isChanged({ hasBefore: true, changedPct: 6.5 }), true);
});

test('planWork pairs after-shots with baseline presence, sorted, ignoring non-shots', () => {
  const plan = planWork(
    [
      'mermaid-diagram-light.png',
      'mermaid-diagram-dark.png',
      'session-transcript-light.png',
      'model-switch.gif', // ignored (not a shot)
      'manifest.json', // ignored
    ],
    ['session-transcript-light.png', 'session-transcript-dark.png'],
  );
  assert.deepEqual(plan, [
    { name: 'mermaid-diagram-dark.png', hasBefore: false }, // PR-added → NEW
    { name: 'mermaid-diagram-light.png', hasBefore: false },
    { name: 'session-transcript-light.png', hasBefore: true }, // has baseline
  ]);
});

test('planWork is robust to a missing before set (first-ever PR → all NEW)', () => {
  const plan = planWork(['home-light.png', 'home-dark.png'], []);
  assert.deepEqual(
    plan.map((p) => p.hasBefore),
    [false, false],
  );
});

test('planWork tolerates null/undefined args (exercises the ?? [] guards)', () => {
  assert.deepEqual(planWork(null, null), []);
  assert.deepEqual(planWork(undefined, undefined), []);
  // after present, before nullish → every shot is NEW.
  assert.deepEqual(planWork(['a-light.png'], null), [
    { name: 'a-light.png', hasBefore: false },
  ]);
});

test('countDenoisedChanges: isolated scatter (cross-job AA) erodes to zero', () => {
  // Isolated single pixels, none adjacent — the shape of font-AA jitter.
  const [w, h] = [20, 20];
  const m = mask(w, h, (x, y) => x % 4 === 0 && y % 4 === 0);
  // Every set pixel has 0 set neighbours → none survive the density cutoff.
  assert.equal(countDenoisedChanges(m, w, h), 0);
});

test('countDenoisedChanges: a 1px-wide line (glyph edge) erodes to zero', () => {
  const [w, h] = [20, 20];
  const m = mask(w, h, (_x, y) => y === 5); // one horizontal line
  // Interior line pixels have exactly 2 set neighbours (< 4) → none survive.
  assert.equal(countDenoisedChanges(m, w, h), 0);
});

test('countDenoisedChanges: minNeighbors controls erosion strength on a solid block', () => {
  const [w, h] = [3, 3];
  const m = mask(w, h, () => true); // full 3×3
  // Centre keeps all 8 neighbours; the 4 edges keep 5; the 4 corners keep 3.
  assert.equal(countDenoisedChanges(m, w, h, 8), 1); // centre only
  assert.equal(countDenoisedChanges(m, w, h, 4), 5); // centre + 4 edges
  assert.equal(countDenoisedChanges(m, w, h, 3), 9); // corners survive too
});

test('countDenoisedChanges: a badge-shaped solid block mostly survives', () => {
  const [w, h] = [40, 40];
  // 15×12 solid block = 180 px.
  const m = mask(w, h, (x, y) => x >= 10 && x < 25 && y >= 10 && y < 22);
  const survivors = countDenoisedChanges(m, w, h);
  // Only the 4 corners (3 neighbours) erode; the rest of the 180-px block keeps.
  assert.ok(
    survivors >= 170,
    `expected most of the 180-px block to survive, got ${survivors}`,
  );
});

test('at 1280×800: AA scatter erodes below the threshold, a real badge clears it', () => {
  const [W, H] = [1280, 800];
  const N = W * H;
  // ~0.25% of pixels as an isolated scatter — well over the raw 0.02% line.
  const aa = mask(W, H, (x, y) => x % 20 === 0 && y % 20 === 0);
  const aaPct = (countDenoisedChanges(aa, W, H) / N) * 100;
  assert.ok(
    aaPct < CHANGED_PCT_THRESHOLD,
    `AA scatter should denoise below ${CHANGED_PCT_THRESHOLD}%, got ${aaPct}`,
  );

  // A 55×18 badge-sized solid block (~0.075% of the frame).
  const badge = mask(
    W,
    H,
    (x, y) => x >= 100 && x < 155 && y >= 100 && y < 118,
  );
  const badgePct = (countDenoisedChanges(badge, W, H) / N) * 100;
  assert.ok(
    badgePct >= CHANGED_PCT_THRESHOLD,
    `a real badge-sized change should stay above ${CHANGED_PCT_THRESHOLD}%, got ${badgePct}`,
  );
});

test('unpackBitMask round-trips a packed mask (LSB-first)', () => {
  // Pixels 0..9, set {0, 3, 8}: byte0 = 0b0000_1001, byte1 = 0b0000_0001.
  const b64 = Buffer.from([0b00001001, 0b00000001]).toString('base64');
  assert.deepEqual(
    Array.from(unpackBitMask(b64, 10)),
    [1, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  );
});
