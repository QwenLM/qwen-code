/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { getUserSettingsDir } from './src/config/settings.js';
import { pinQwenHome, reapStaleQwenHomePins } from './test-setup.js';

// Witness for the QWEN_HOME pin in test-setup.ts: the suite must never
// resolve operator settings from the ambient $HOME/.qwen, where one malformed
// settings.json on a shared runner fails every reader at once. Holds whether
// the pin applied or the environment legitimately selected its own QWEN_HOME.
// This file must never set, stub, or delete QWEN_HOME — it would then observe
// its own mutation instead of the pin.
describe('test-setup QWEN_HOME pin', () => {
  it('keeps the resolved user settings dir off the ambient $HOME/.qwen', () => {
    expect(getUserSettingsDir()).not.toBe(path.join(homedir(), '.qwen'));
  });

  it('pins over an ambient QWEN_HOME, set or empty, so the suite always owns its settings root', () => {
    // The repo's agent gates export QWEN_HOME on steps that allowlist vitest;
    // a conditional pin resolves operator settings from — and writes them
    // into — the agent's live home (measured: a malformed ambient
    // settings.json failed this suite's operator-settings readers and a
    // `.corrupted` copy was written back into the ambient home).
    for (const ambient of ['/operator/live-home', '']) {
      const env = { QWEN_HOME: ambient };
      const pinned = pinQwenHome(env);
      try {
        expect(env['QWEN_HOME']).toBe(pinned);
        expect(pinned).not.toBe(ambient);
        expect(fs.existsSync(pinned)).toBe(true);
      } finally {
        fs.rmSync(pinned, { recursive: true, force: true });
      }
    }
  });
});

describe('reapStaleQwenHomePins', () => {
  it('removes pins older than the live window and spares fresh ones', () => {
    const stale = fs.mkdtempSync(path.join(tmpdir(), 'qwen-cli-test-'));
    const fresh = fs.mkdtempSync(path.join(tmpdir(), 'qwen-cli-test-'));
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
      reapStaleQwenHomePins();
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      // The live pin is seconds old, so reaping must never touch it.
      expect(fs.existsSync(process.env['QWEN_HOME']!)).toBe(true);
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
