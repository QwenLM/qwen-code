/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SESSION_ID,
  settleTimeoutMs,
  state,
} from './hosted-harness-session.test-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

function useToolApprovals() {
  beforeEach(async () => {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'workspaceContext',
    ).mockResolvedValue([]);
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockImplementation(
      async () => randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, {
      recursive: true,
      force: true,
      // A wake pump's final writes can still be in flight at teardown.
      maxRetries: 5,
      retryDelay: 100,
    });
  });
}

// Turns commit and sync several records, which can take over a second
// on a busy host.
const waitFor = <T>(check: () => T | Promise<T>) =>
  vi.waitFor(check, { timeout: settleTimeoutMs() });

const files = 'hosted-workspace-files/1';

export { files, waitFor, useToolApprovals };
