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
import { a2aCancelTask, a2aGetTask, a2aSendMessage } from './a2a-server.js';
import { readThread, updateWorkspaceAgents } from './store.js';
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

  it('answers a malformed task id as not found', async () => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const caller = { callerId: 'share_1', secret };

    await expect(
      a2aGetTask(PROJECT_ROOT, caller, '../workspace'),
    ).resolves.toEqual({ ok: false, kind: 'not_found' });
    await expect(
      a2aCancelTask(PROJECT_ROOT, caller, '../workspace'),
    ).resolves.toEqual({ ok: false, kind: 'not_found' });
  });

  it('cancels queued external work without leaving a live run', async () => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const caller = { callerId: 'share_1', secret };
    const sent = await a2aSendMessage(PROJECT_ROOT, caller, {
      agentId: 'ag_lead',
      messageId: 'msg-1',
      title: 'Cancel me',
      body: 'Wait for cancellation.',
    });
    if (!sent.ok) throw new Error('send refused');

    await expect(
      a2aCancelTask(PROJECT_ROOT, caller, sent.value.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        task: { status: { state: 'TASK_STATE_CANCELED' } },
        runsStillLive: 0,
      },
    });
    await expect(
      readThread(PROJECT_ROOT, sent.value.id),
    ).resolves.toMatchObject({
      status: 'cancelled',
      runs: [{ status: 'cancelled' }],
    });
  });

  it('keeps a retired agent’s tasks readable and cancelable', async () => {
    // Retiring stops new work; it must not hide or strand work a caller with
    // a valid grant already submitted.
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const caller = { callerId: 'share_1', secret };
    const sent = await a2aSendMessage(PROJECT_ROOT, caller, {
      agentId: 'ag_lead',
      messageId: 'msg-1',
      title: 'Explain',
      body: 'Why is the build slow?',
    });
    if (!sent.ok) throw new Error('send refused');
    // Stamped directly: the retire action itself refuses while this task's
    // run is still queued, but a disabled or retired agent reaches here too.
    await updateWorkspaceAgents(PROJECT_ROOT, (agents) =>
      agents.map((agent) => ({ ...agent, retiredAt: 1 })),
    );

    await expect(
      a2aGetTask(PROJECT_ROOT, caller, sent.value.id),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      a2aCancelTask(PROJECT_ROOT, caller, sent.value.id),
    ).resolves.toMatchObject({ ok: true });
    // New work is still refused.
    await expect(
      a2aSendMessage(PROJECT_ROOT, caller, {
        agentId: 'ag_lead',
        messageId: 'msg-2',
        title: 'More',
        body: 'And the tests?',
      }),
    ).resolves.toEqual({ ok: false, kind: 'refused' });
  });
});
