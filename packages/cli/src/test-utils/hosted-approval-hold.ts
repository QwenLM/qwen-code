/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import { afterEach, expect, vi } from 'vitest';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { HostedWorkspaceToolTurn } from '../serve/hosted-workspace-tool-turn.js';
import { HostedWorkspaceBroker } from '../serve/hosted-workspace-broker.js';
import * as approval from '../serve/hosted-tool-approval.js';
import { WORKSPACE_CAPABILITY_DIGEST } from '../serve/managed-workspace-activation.js';
import * as stdio from '../utils/stdioHelpers.js';

const heldSessionId = 'approval-hold-session';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Each importing test file gets a fresh module-scoped env read and latch.
export function approvalHoldFixtures() {
  vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'resolveCapabilities',
  ).mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
    ownerSessionId: heldSessionId,
    snapshots: [],
    files: {},
  });
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'capabilityDigest',
    'get',
  ).mockReturnValue(WORKSPACE_CAPABILITY_DIGEST);
  const prepare = vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare');
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  const holds = () =>
    stderr.mock.calls.filter(([line]) =>
      line.includes('E2E holding pending sibling approval'),
    ).length;

  return async (sessionId = heldSessionId) => {
    const root = await mkdtemp(path.join(tmpdir(), 'hosted-approval-hold-'));
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId,
    };
    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: root,
      sessionKey,
    });
    const session = await openManagedSession({
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId,
      sessionKey,
      version: 'test',
      workerId: 'worker',
      activationLeaseDurationMs: 60_000,
      create: {
        definitionRef: await store.publish(
          'managed-definition',
          Buffer.from('{}'),
        ),
        rootSnapshotRef: await store.publish('managed-root', Buffer.from('{}')),
        createdBy: 'test',
      },
    });
    const controller = new AbortController();
    cleanups.push(async () => {
      controller.abort(new Error('test cleanup'));
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    const harness = createManagedHarnessHandle(session);
    await harness.ensureRunnable();
    const waiters = new approval.HostedApprovalWaiters();
    const wait = vi.spyOn(waiters, 'wait');
    const turn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async (type, parts, model, identity) => {
        const uuid = identity?.uuid ?? randomUUID();
        await session.sink.write({
          uuid,
          parentUuid: null,
          sessionId,
          timestamp: identity?.timestamp ?? new Date().toISOString(),
          type,
          model,
          cwd: root,
          version: 'test',
          daemonPromptId: 'prompt',
          message: { role: type === 'assistant' ? 'model' : 'user', parts },
        });
        return uuid;
      },
      () => true,
      undefined,
      undefined,
      { settings: { mode: 'default', timeoutMs: 60_000 }, waiters },
    );
    function run(count = 1) {
      const calls = Array.from({ length: count }, (_, index) => ({
        name: 'write_file',
        callId: `call-${index}`,
        args: { file_path: `file-${index}.txt`, content: 'test' },
        isClientInitiated: false,
        prompt_id: 'prompt',
      }));
      const outcome: { settled: boolean; parts?: Part[]; error?: unknown } = {
        settled: false,
      };
      void turn
        .execute(
          calls,
          calls.map((call) => ({
            functionCall: { id: call.callId, name: call.name, args: call.args },
          })),
          'model',
          controller.signal,
        )
        .then(
          (parts) => Object.assign(outcome, { settled: true, parts }),
          (error: unknown) => Object.assign(outcome, { settled: true, error }),
        );
      return outcome;
    }
    async function deny(count = 1) {
      for (let index = 0; index < count; index++) {
        await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(index + 1), {
          timeout: 10_000,
        });
        const requestId = wait.mock.calls[index][0];
        expect(
          await approval.resolveHostedAction(session, waiters, requestId, {
            optionId: 'deny',
            policyRevision: approval.HOSTED_TOOL_APPROVAL_POLICY,
            inputRevision: 1,
          }),
        ).toMatchObject({ status: 200 });
      }
    }
    return { harness, controller, wait, prepare, holds, run, deny };
  };
}
