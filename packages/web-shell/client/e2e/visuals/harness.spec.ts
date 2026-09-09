/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import { freezeLoopingAnimations } from './harness';

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
