/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig, devices } from '@playwright/test';

// Separate port default from playwright.config.ts (5174) so a stray base-config
// dev server does not collide when both are run locally back to back.
const port = Number(process.env['PLAYWRIGHT_PORT'] ?? 5175);
const baseURL =
  process.env['PLAYWRIGHT_BASE_URL'] ?? `http://127.0.0.1:${port}`;

// Fixed viewport so captures are stable across runs. Must match VISUAL_VIEWPORT
// in client/e2e/visuals/harness.ts.
const viewport = { width: 1280, height: 800 };

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
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport },
    },
  ],
});
