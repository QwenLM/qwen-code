/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWatch,
  readWatches,
  watchKey,
  type ReviewVerifyWatch,
} from './lib/review-verify-observe.js';
import { readPendingReviewEvents } from './lib/review-events.js';
import { runVerifyWatch } from './verify-watch.js';

let home: string;
let root: string;

const watch: ReviewVerifyWatch = {
  platform: 'github',
  host: 'github.com',
  ownerRepo: 'QwenLM/qwen-code',
  number: 15846,
  addedAt: '2026-10-29T00:00:00.000Z',
};

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'verify-watch-home-')));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-watch-root-')));
  vi.stubEnv('QWEN_HOME', join(home, '.qwen'));
  vi.stubEnv('QWEN_RUNTIME_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('runVerifyWatch', () => {
  it('registers a watch with resolved coordinates', async () => {
    const result = await runVerifyWatch({
      pr: 15846,
      repo: 'QwenLM/qwen-code',
      workspaceRoot: root,
    });
    expect(result).toMatchObject({
      action: 'add',
      watch: {
        platform: 'github',
        host: 'github.com',
        ownerRepo: 'QwenLM/qwen-code',
        number: 15846,
      },
    });
    expect(readWatches(root)).toHaveLength(1);
  });

  it('lists and removes', async () => {
    addWatch(root, watch);
    const listed = await runVerifyWatch({ list: true, workspaceRoot: root });
    expect(listed).toMatchObject({ action: 'list' });
    expect(listed.action === 'list' && listed.watches).toHaveLength(1);

    const removed = await runVerifyWatch({
      pr: watch.number,
      repo: watch.ownerRepo,
      remove: true,
      workspaceRoot: root,
    });
    expect(removed).toEqual({
      action: 'remove',
      key: watchKey(watch),
      removed: true,
    });
    expect(readWatches(root)).toEqual([]);
  });

  it('--once runs the same pass the daemon runs', async () => {
    const result = await runVerifyWatch({ once: true, workspaceRoot: root });
    expect(result).toEqual({ action: 'once', outcomes: [] });
    expect(readPendingReviewEvents(root).events).toEqual([]);
  });

  it('records an Aone watch as Aone — the observer declines it later, not the registration', async () => {
    await runVerifyWatch({
      pr: 7,
      repo: 'g/p',
      host: 'code.alibaba-inc.com',
      workspaceRoot: root,
    });
    expect(readWatches(root)[0]).toMatchObject({
      platform: 'aone',
      host: 'code.alibaba-inc.com',
    });
  });

  it.each([
    ['no pr and no mode', {}],
    ['pr without repo', { pr: 1 }],
    ['bad repo', { pr: 1, repo: 'nope' }],
    ['bad pr', { pr: 0, repo: 'a/b' }],
    ['bad host', { pr: 1, repo: 'a/b', host: 'not a host' }],
  ])('refuses %s as a usage error and writes nothing', async (_label, args) => {
    await expect(
      runVerifyWatch({ ...args, workspaceRoot: root }),
    ).rejects.toThrow(TypeError);
    expect(readWatches(root)).toEqual([]);
  });
});
