/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../../config/storage.js';
import { issueA2AGrant } from './a2a-grants.js';
import { a2aGetTask, a2aSendMessage } from './a2a-server.js';
import { updateWorkspaceAgents } from './store.js';
import { postMessage } from './thread-actions.js';

const PROJECT_ROOT = '/a2a-server-test';

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-server-test-'));
  Storage.setRuntimeBaseDir(runtimeDir);
  await updateWorkspaceAgents(PROJECT_ROOT, () => [
    { id: 'ag_lead', name: 'lead', createdAt: 1 },
  ]);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

describe('A2A tasks', () => {
  it("returns the agent's latest post as the answer", async () => {
    // Without it a caller could watch the state change and never read the
    // result it asked for.
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
      scope: 'analysis',
    });
    const caller = { callerId: 'share_1', secret };
    const sent = await a2aSendMessage(PROJECT_ROOT, caller, {
      agentId: 'ag_lead',
      messageId: 'msg-1',
      title: '',
      body: 'Why is the build slow?',
    });
    if (!sent.ok) throw new Error('send refused');
    expect(sent.value.answer).toBeUndefined();

    await postMessage(PROJECT_ROOT, sent.value.id, {
      from: 'ag_lead',
      authorKind: 'agent',
      text: 'The cache key misses on every run.',
    });

    const polled = await a2aGetTask(PROJECT_ROOT, caller, sent.value.id);
    expect(polled).toMatchObject({
      ok: true,
      value: { answer: 'The cache key misses on every run.' },
    });
  });
});
