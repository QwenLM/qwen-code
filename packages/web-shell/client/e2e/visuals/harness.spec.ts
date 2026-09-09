/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { FIXED_CAPTURE_TIME, freezeLoopingAnimations } from './harness';

// `freezeLoopingAnimations` is the load-bearing step that keeps spinner-bearing
// captures deterministic (see its docstring). It runs only implicitly via
// `captureScreenshot`, so pin its contract explicitly here: an infinite
// animation must be paused and rewound to time 0, while a finite one must be
// left alone for Playwright's own `animations: 'disabled'` to settle.
test('freezeLoopingAnimations pins infinite animations to frame 0 and leaves finite ones', async ({
  page,
}) => {
  await page.setContent(`
    <style>
      @keyframes spin { to { transform: rotate(360deg); } }
      #loop { width: 10px; height: 10px; animation: spin 800ms linear infinite; }
      #once { width: 10px; height: 10px; animation: spin 10s linear 1; }
    </style>
    <div id="loop"></div>
    <div id="once"></div>
  `);
  // Advance both animations past frame 0 first, so a freeze that did nothing
  // would leave a non-zero currentTime and fail the assertion below.
  await page.waitForTimeout(100);

  await freezeLoopingAnimations(page);

  const state = await page.evaluate(
    /* global document */
    () => {
      const animOf = (id: string) => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`element #${id} not found`);
        return el.getAnimations()[0];
      };
      const loop = animOf('loop');
      return {
        loopPlayState: loop.playState,
        loopCurrentTime: Number(loop.currentTime),
        oncePlayState: animOf('once').playState,
      };
    },
  );

  // The infinite loop is paused at its first frame…
  expect(state.loopPlayState).toBe('paused');
  expect(state.loopCurrentTime).toBe(0);
  // …while the finite animation is untouched, still running toward completion.
  expect(state.oncePlayState).toBe('running');
});

// Captures render at a frozen clock (`freezeWallClock`), and a fixture dated
// AFTER that instant silently renders as "just now": `formatRelativeTime`
// measures `Date.now() - value`, so a future value yields a negative age and
// falls into the `mins < 1` branch. Not hypothetical -- an earlier constant
// turned the channel editor's 2026-07-28 pairing requests into "just now",
// nothing failed, and it was caught only by reading a preview diff by eye.
test('every hardcoded fixture date precedes the frozen capture clock', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(here).filter(
    // harness.ts is where FIXED_CAPTURE_TIME itself is written; its literal is
    // the boundary, not a fixture, and would always trip the check.
    (file) => file.endsWith('.ts') && file !== 'harness.ts',
  );
  const isoLiteral = /['"](\d{4}-\d{2}-\d{2}T[\d:.]+Z?)['"]/g;

  const offenders: string[] = [];
  for (const file of sources) {
    const source = readFileSync(join(here, file), 'utf8');
    for (const [, literal] of source.matchAll(isoLiteral)) {
      const at = Date.parse(literal);
      if (Number.isNaN(at)) continue;
      if (at >= FIXED_CAPTURE_TIME.getTime()) {
        offenders.push(`${file}: ${literal}`);
      }
    }
  }

  // Fix by dating the fixture earlier, not by moving the clock forward: the
  // clock is what every capture renders at, and pushing it out re-dates every
  // other relative label in the suite.
  expect(offenders).toEqual([]);
});
