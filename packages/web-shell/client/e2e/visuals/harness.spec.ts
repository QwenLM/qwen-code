/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  FIXED_CAPTURE_TIME,
  freezeLoopingAnimations,
  freezeWallClock,
} from './harness';

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

// `freezeWallClock` is the other half of capture determinism: the base and head
// passes photograph the same view minutes apart, so a live clock made every
// timestamped view read as "changed". It runs from `gotoSession` /
// `gotoNewSession`, so pin its contract here -- the clock must be frozen at the
// fixed instant AND must not drift while the page keeps running.
test('freezeWallClock pins the page clock without stopping timers', async ({
  page,
}) => {
  await freezeWallClock(page);
  await page.setContent('<div id="probe"></div>');

  const first = await page.evaluate(() => Date.now());
  // A timer still has to fire for the harness to be able to settle replay and
  // animations; only the clock reading is faked.
  const timerFired = page.evaluate(
    () => new Promise((resolve) => setTimeout(() => resolve(true), 50)),
  );
  await page.waitForTimeout(300);
  const second = await page.evaluate(() => Date.now());

  expect(first).toBe(FIXED_CAPTURE_TIME.getTime());
  expect(second).toBe(first);
  expect(await timerFired).toBe(true);
});
