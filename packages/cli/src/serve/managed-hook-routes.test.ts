/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  HookEventName,
  HookType,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import {
  MANAGED_HOOK_ROUTE,
  type ManagedHookControl,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import {
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
} from './managed-runtime-attestation-worker.js';
import type { ManagedContextBoot } from './managed-context-envelope.js';
import {
  computeManagedContextDigest,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';
import {
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
  WORKSPACE_EXECUTION_PROFILE,
} from './managed-workspace-activation.js';
let worker: ManagedRuntimeAttestationWorkerHandle | undefined;
let directory: string | undefined;
afterEach(async () => {
  await worker?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it('authenticates hooks and retains the active workspace until its original command drains', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'qwen-hook-worker-'));
  const key = {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
  };
  const runtimeSessionId = 'hook-session-a';
  const pin = {
    catalogId: 'hooks',
    catalogRevision: 1,
    definitionDigest: 'a'.repeat(64),
  };
  const manifest = path.join(directory, 'hooks.json');
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      catalogs: [
        {
          ...pin,
          tenantId: key.tenantId,
          workspaceId: key.workspaceId,
          hooks: [
            {
              hookId: 'hook',
              eventName: HookEventName.PreToolUse,
              sequential: false,
              failClosed: true,
              async: true,
              onceKey: null,
              config: {
                type: HookType.Command,
                command: 'printf started > started; sleep 30',
                timeout: 60000,
              },
            },
          ],
        },
      ],
    }),
  );
  vi.stubEnv('QWEN_MANAGED_HOOK_CONFIG', manifest);
  const boot: ManagedContextBoot = {
    type: 'boot',
    version: 2,
    managedContext: 'managed-context/1',
    runtimeInstanceId: 'runtime-a',
    runtimeIncarnation: 'boot-a',
    leaseId: 'lease-a',
    provisionRequestId: 'provision-a',
    token: 'test-token',
    epoch: 1,
    capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    isolationClass: 'session',
    tenantId: key.tenantId,
    workspaceId: key.workspaceId,
    workspaceGeneration: '1',
    storageId: 'storage://pvc/workspace-a',
    mountRoot: directory,
  };
  worker = await startManagedRuntimeAttestationWorker(boot);
  const headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-qwen-managed-lease-id': 'lease-a',
    'x-qwen-managed-lease-epoch': '1',
  };
  const post = (route: string, body: unknown, auth = headers) =>
    fetch(`${worker!.ready.url}${route}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    });
  const binding: ManagedContextBinding = {
    tenantId: key.tenantId,
    workspaceId: key.workspaceId,
    workspaceGeneration: '1',
    storageId: boot.storageId,
    cwdRelative: '.',
    contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
    contextRevision: '1',
  };
  const contextDigest = computeManagedContextDigest(binding);
  const context = await post('/internal/managed-runtime/v3/context', {
    protocolVersion: 3,
    managedContext: 'managed-context/1',
    operationId: 'context-a',
    sessionId: runtimeSessionId,
    binding,
    contextDigest,
  });
  expect(context.status).toBe(200);
  const activation = {
    protocolVersion: 1,
    profile: WORKSPACE_EXECUTION_PROFILE,
    sessionId: runtimeSessionId,
    contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
    contextDigest,
    operation: 'activate',
  };
  expect(
    (await post('/internal/managed-runtime/v3/activation', activation)).status,
  ).toBe(200);

  const operation: ManagedHookControl = {
    kind: 'hook-execute',
    pin,
    sessionKey: key,
    operationId: 'execution',
    hookId: 'hook',
    input: {
      session_id: key.sessionId,
      cwd: 'ignored',
      transcript_path: '',
      hook_event_name: HookEventName.PreToolUse,
      timestamp: new Date().toISOString(),
    },
    grant: {
      sessionKey: key,
      operationId: 'execution',
      domain: 'hook_execution',
      operationRevision: 1,
      ownerId: 'harness',
      workspaceGeneration: '1',
      leaseDurationMs: 300000,
      expiresAt: Date.now() + 300000,
      resourceScope: {
        recordRef: {
          resourceId: 'record',
          kind: 'managed-hook_execution',
          schemaVersion: 1,
          byteLength: 1,
          digest: 'b'.repeat(64),
        },
        phases: ['execute'],
      },
    },
  };
  const request = (operation: ManagedHookControl) => ({
    protocolVersion: 1,
    runtimeSessionId,
    operation,
  });
  expect(
    (
      await post(MANAGED_HOOK_ROUTE, request(operation), {
        ...headers,
        authorization: 'Bearer wrong',
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await post(MANAGED_HOOK_ROUTE, request(operation), {
        ...headers,
        'x-qwen-managed-lease-epoch': '2',
      })
    ).status,
  ).toBe(409);
  await expect(readFile(path.join(directory, 'started'))).rejects.toThrow();
  const started = await post(MANAGED_HOOK_ROUTE, request(operation));
  expect(started.status).toBe(200);
  expect(started.headers.get('cache-control')).toBe('no-store');
  const release = () =>
    post('/internal/managed-runtime/v3/activation', {
      ...activation,
      operation: 'release',
    });
  if (
    process.platform !== 'linux' ||
    !process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT']
  ) {
    await vi.waitFor(async () => {
      const response = await post(
        MANAGED_HOOK_ROUTE,
        request({
          kind: 'hook-status',
          sessionKey: key,
          operationId: 'lookup',
          targetOperationId: 'execution',
        }),
      );
      expect(await response.json()).toMatchObject({
        operation: {
          state: 'settled',
          error: { code: 'managed_hook_command_isolation_unavailable' },
        },
      });
    });
    await expect(readFile(path.join(directory, 'started'))).rejects.toThrow();
    expect((await release()).status).toBe(200);
    return;
  }
  await vi.waitFor(async () =>
    expect(await readFile(path.join(directory!, 'started'), 'utf8')).toBe(
      'started',
    ),
  );
  expect((await release()).status).toBe(409);
  await post(
    MANAGED_HOOK_ROUTE,
    request({
      kind: 'hook-cancel',
      sessionKey: key,
      operationId: 'cancel',
      targetOperationId: 'execution',
    }),
  );
  await vi.waitFor(
    async () => {
      const response = await post(
        MANAGED_HOOK_ROUTE,
        request({
          kind: 'hook-status',
          sessionKey: key,
          operationId: 'lookup',
          targetOperationId: 'execution',
        }),
      );
      expect(await response.json()).toMatchObject({
        operation: { state: 'settled', result: { outcome: 'cancelled' } },
      });
    },
    { timeout: 8000 },
  );
  expect((await release()).status).toBe(200);
});
