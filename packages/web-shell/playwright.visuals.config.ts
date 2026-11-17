/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig, devices } from '@playwright/test';
import { VISUAL_VIEWPORT } from './client/e2e/visuals/constants';

// Separate port default from playwright.config.ts (5174) so a stray base-config
// dev server does not collide when both are run locally back to back.
const port = Number(process.env['PLAYWRIGHT_PORT'] ?? 5175);
const baseURL =
  process.env['PLAYWRIGHT_BASE_URL'] ?? `http://127.0.0.1:${port}`;

// Single source of truth for the capture viewport (shared with the harness).
const viewport = { ...VISUAL_VIEWPORT };

export default defineConfig({
  testDir: './client/e2e/visuals',
  outputDir: './client/e2e/visuals/.playwright',
  // Retry in CI so one transient flake doesn't sink the whole preview (the job
  // is all-or-nothing). Output filenames are deterministic, so a retry just
  // overwrites the same PNG/webm. No auto-screenshots/traces we don't collect.
  retries: process.env['CI'] ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env['CI'],
  reporter: [['line']],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
  use: {
    baseURL,
    viewport,
    trace: 'off',
    // Screenshots are captured explicitly; flows record video via their own
    // browser context (client/e2e/visuals/harness.ts) for stable filenames.
    screenshot: 'off',
    video: 'off',
    // Render every capture under `prefers-reduced-motion: reduce` so the
    // opt-out blocks the CSS already ships actually apply. Playwright's default
    // is `no-preference`, which leaves time-driven animations live during
    // captures: `captureScreenshot`'s `animations: 'disabled'` only settles
    // what is already running when the screenshot starts, so an animation whose
    // window straddles the shutter is a coin flip. The artifact dock's open
    // slide is one — it sweeps the cockpit's divider the full panel width
    // (measured at the mutation that mounts it: `width: 0` at `x: 1276`,
    // settling 200ms later at `width: 504px` / `x: 772`) and no assertion in
    // any screenshot spec gates on the dock, so whether a capture lands inside
    // those 200ms depends only on how long the pre-capture waits happened to
    // take. That is the shape #11465 reports: a full-height divider a few px
    // off, 1.31% on one render of a tree and 0% on a re-run of the same commit.
    //
    // It has to go through `contextOptions`. `reducedMotion` is a
    // `browser.newContext()` option, not one of the runner's own `use` options,
    // so writing it as a sibling of `viewport` above is silently dropped:
    // measured on @playwright/test 1.61.1, `project.use.reducedMotion` reads
    // back as `'reduce'` while the page still reports
    // `matchMedia('(prefers-reduced-motion: reduce)').matches === false`.
    // `visual-capture-contracts.test.ts` pins this setting, in this form,
    // together with the dock's CSS opt-out block.
    contextOptions: {
      reducedMotion: 'reduce',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport },
    },
  ],
});
