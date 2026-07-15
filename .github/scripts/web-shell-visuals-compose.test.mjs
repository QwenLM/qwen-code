/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANGED_PCT_THRESHOLD,
  isChanged,
  parseShot,
  planWork,
} from './web-shell-visuals-compose.mjs';

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
