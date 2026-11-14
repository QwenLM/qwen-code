/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The default settings reader, which the main automation suite never reaches:
// every test there injects `isEnabled`. This file exercises the real default so
// the degrade disclosure is covered where it actually lives — a daemon reading
// the setting on every pass, not a CLI reading it once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWatch,
  type ReviewVerifyWatch,
} from '../commands/review/lib/review-verify-observe.js';
import {
  startReviewVerifyAutomation,
  type ReviewVerifyAutomation,
} from './review-verify-automation.js';

const DEGRADE =
  'NOTE: review settings could not be loaded (Unexpected token); this review ' +
  'uses the defaults — attribution on, no auto-posting, no automatic ' +
  'verification handoff, no effort or round-cap override. Fix the settings ' +
  'file to restore them.';

// Every read degrades, exactly as an unreadable settings file does. The
// discloser is handed the message instead of it going to stderr, which is the
// contract the automation relies on to say it once.
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../commands/review/lib/review-settings.js', () => ({
  operatorReviewSettings: (onDegrade?: (message: string) => void) => {
    reads.count += 1;
    onDegrade?.(DEGRADE);
    return {
      attribution: true,
      comment: false,
      autoVerify: false,
      effort: undefined,
      reverseAuditRounds: undefined,
      approachRounds: undefined,
    };
  },
}));

let home: string;
let root: string;
let automation: ReviewVerifyAutomation | undefined;
let notices: string[];

const watch: ReviewVerifyWatch = {
  platform: 'github',
  host: 'github.com',
  ownerRepo: 'qwenlm/qwen-code',
  number: 15846,
  sessionId: 'sess-1',
  addedAt: '2026-10-31T00:00:00.000Z',
};

beforeEach(() => {
  home = realpathSync(
    mkdtempSync(join(tmpdir(), 'review-verify-settings-home-')),
  );
  root = realpathSync(
    mkdtempSync(join(tmpdir(), 'review-verify-settings-root-')),
  );
  vi.stubEnv('QWEN_HOME', join(home, '.qwen'));
  vi.stubEnv('QWEN_RUNTIME_DIR', '');
  reads.count = 0;
  notices = [];
});

afterEach(() => {
  automation?.stop();
  automation = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('the default settings reader in a long-lived automation', () => {
  it('discloses an unreadable settings file once, not once per pass', async () => {
    // A watch keeps an owner present on every pass, so the setting really is
    // re-read each time — the shape that turned a per-invocation NOTE into a
    // once-a-minute flood for the life of the daemon.
    mkdirSync(root, { recursive: true });
    addWatch(root, watch);
    const launch = vi.fn(async () => ({ sessionId: 'child-1' }));
    automation = startReviewVerifyAutomation({
      boundWorkspace: root,
      launch,
      intervalMs: 600_000,
      observeIntervalMs: 600_000,
      sessionExists: async () => true,
      onNotice: (message) => notices.push(message),
    });

    await automation.tick();
    await automation.tick();
    await automation.tick();

    // The setting was genuinely re-read, so this is not a vacuous pass.
    expect(reads.count).toBeGreaterThanOrEqual(3);
    const degraded = notices.filter((n) => n.includes('could not be loaded'));
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain('review-verify:');
    // Degrading to off means nothing is spawned.
    expect(launch).not.toHaveBeenCalled();
  });
});
