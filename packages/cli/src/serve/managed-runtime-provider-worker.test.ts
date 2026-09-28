/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type {
  ManagedToolCallIdentity,
  ManagedToolInvocationReference,
  ManagedToolPrepareResponse,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ManagedToolFileHistoryState } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history.js';
import type { ManagedToolInvocationStatus } from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import {
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
  type ManagedRuntimeWorkerBoot,
} from './managed-runtime-attestation-worker.js';
import {
  MANAGED_RUNTIME_PROVIDER_PROTOCOL,
  MANAGED_RUNTIME_PROVIDER_ROUTE,
  type ManagedRuntimeProviderSession,
} from './managed-runtime-provider-protocol.js';
import { MANAGED_CONTEXT_PROTOCOL } from './managed-context-envelope.js';
import { computeManagedContextDigest } from './managed-workspace-binding.js';
import {
  WORKSPACE_ACTIVATION_ROUTE,
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
  WORKSPACE_EXECUTION_PROFILE,
} from './managed-workspace-activation.js';

const SESSION: ManagedRuntimeProviderSession = {
  harnessSessionId: '550e8400-e29b-41d4-a716-446655440001',
  runtimeSessionId: '550e8400-e29b-41d4-a716-446655440002',
  turnKind: 'bootstrap',
};
const BOOT: ManagedRuntimeWorkerBoot = {
  type: 'boot',
  version: 1,
  capabilityDigest: `sha256:${'a'.repeat(64)}`,
  epoch: 4,
  isolationClass: 'workspace',
  leaseId: 'lease-01',
  provisionRequestId: 'provision-01',
  runtimeIncarnation: 'incarnation-01',
  runtimeInstanceId: 'runtime-01',
  tenantId: 'tenant-a',
  token: 'fixture-token',
  workspaceCwd: '/tmp',
  workspaceGeneration: '7',
  workspaceId: 'workspace-a',
};
const HEADERS = {
  authorization: 'Bearer fixture-token',
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'x-qwen-managed-lease-id': 'lease-01',
  'x-qwen-managed-lease-epoch': '4',
};

function reference(
  prepared: ManagedToolPrepareResponse,
): ManagedToolInvocationReference {
  const {
    sessionId,
    promptId,
    callId,
    capabilityDigest,
    policyRevision,
    invocationId,
    argsDigest,
  } = prepared;
  return {
    sessionId,
    promptId,
    callId,
    capabilityDigest,
    policyRevision,
    invocationId,
    argsDigest,
  };
}

describe('Managed Runtime provider worker', () => {
  let workspace: string;
  let storage: string;
  let worker: ManagedRuntimeAttestationWorkerHandle;
  let identity: ManagedToolCallIdentity;

  beforeEach(async () => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-provider-')),
    );
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-provider-storage-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(storage);
    fs.writeFileSync(path.join(workspace, 'input.txt'), 'original content\n');
    worker = await startManagedRuntimeAttestationWorker({
      ...BOOT,
      workspaceCwd: workspace,
    });
  });
  afterEach(async () => {
    await worker?.close();
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(storage, { recursive: true, force: true });
  });

  function post(operation: unknown, session = SESSION, headers = HEADERS) {
    return fetch(`${worker.ready.url}${MANAGED_RUNTIME_PROVIDER_ROUTE.path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocolVersion: 1,
        providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
        session,
        operation,
      }),
    });
  }
  async function control<T = unknown>(operation: unknown): Promise<T> {
    const response = await post(operation);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({
      protocolVersion: 1,
      providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
      session: SESSION,
    });
    return body.result as T;
  }
  function binding() {
    return {
      ownerSessionId: SESSION.harnessSessionId,
      ownerRuntimeSessionId: SESSION.runtimeSessionId,
      executionCwd: workspace,
      snapshots: [],
    };
  }
  async function acquire() {
    expect(await control({ kind: 'acquire' })).toBe(true);
    const manifest = await control<{
      capabilityDigest: string;
      policyRevision: string;
      tools: Array<{ name: string }>;
    }>({ kind: 'manifest' });
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'edit',
      'run_shell_command',
    ]);
    identity = {
      sessionId: SESSION.runtimeSessionId,
      promptId: 'prompt-1',
      callId: 'call-1',
      capabilityDigest: manifest.capabilityDigest,
      policyRevision: manifest.policyRevision,
    };
  }
  async function begin() {
    await acquire();
    await control({ kind: 'bind-history', binding: binding() });
    await control({ kind: 'begin-turn', identity });
  }
  async function prepare(
    toolName: string,
    input: Record<string, unknown>,
    callId = 'call-1',
  ) {
    return control<ManagedToolPrepareResponse>({
      kind: 'prepare',
      identity: { ...identity, callId },
      toolName,
      input,
    });
  }
  async function execute<T = unknown>(
    ref: ManagedToolInvocationReference,
  ): Promise<T> {
    await control({ kind: 'preflight', reference: ref });
    return control<T>({ kind: 'execute', reference: ref });
  }

  it('reports input errors separately from identity conflicts and permits corrected preparation', async () => {
    await begin();
    for (const [toolName, input, reason] of [
      [
        'write_file',
        { file_path: 'relative.txt', content: 'value' },
        'File path must be absolute',
      ],
      ['missing_tool', {}, 'Managed Runtime tool is unavailable.'],
    ] as const) {
      const response = await post({
        kind: 'prepare',
        identity,
        toolName,
        input,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: 'managed_runtime_tool_invalid',
        error: expect.stringContaining(reason),
      });
    }
    const oversized = await post({
      kind: 'prepare',
      identity,
      toolName: 'write_file',
      input: {
        file_path: path.join(workspace, 'output.txt'),
        content: 'x'.repeat(256 * 1024),
      },
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      code: 'managed_runtime_provider_invalid',
    });
    await prepare('write_file', {
      file_path: path.join(workspace, 'output.txt'),
      content: 'value',
    });
    expect(fs.existsSync(path.join(workspace, 'output.txt'))).toBe(false);
  });

  it('executes the four admitted tools with real approval, preflight and file history', async () => {
    await begin();
    const read = reference(
      await prepare('read_file', {
        file_path: path.join(workspace, 'input.txt'),
      }),
    );
    const readResult = await execute<{ result?: unknown }>(read);
    expect(readResult).toMatchObject({ executionStatus: 'success' });
    expect(JSON.stringify(readResult.result)).toContain('original content');
    const output = path.join(workspace, 'output.txt');
    const prepared = await prepare(
      'write_file',
      { file_path: output, content: 'new contents\n' },
      'write',
    );
    expect(prepared.defaultPermission).toBe('ask');
    const write = reference(prepared);
    expect(fs.existsSync(output)).toBe(false);
    expect(
      await control({ kind: 'confirmation', reference: write }),
    ).toMatchObject({ type: 'edit', newContent: 'new contents\n' });
    const decision = {
      kind: 'confirm',
      reference: write,
      outcome: ToolConfirmationOutcome.ProceedOnce,
    };
    expect(await control(decision)).toBeNull();
    expect(await control(decision)).toBeNull();
    expect(
      (await post({ ...decision, outcome: ToolConfirmationOutcome.Cancel }))
        .status,
    ).toBe(409);
    expect((await post({ kind: 'execute', reference: write })).status).toBe(
      409,
    );
    expect(await execute(write)).toMatchObject({ executionStatus: 'success' });
    expect(fs.readFileSync(output, 'utf8')).toBe('new contents\n');
    const edit = reference(
      await prepare(
        'edit',
        { file_path: output, old_string: 'new', new_string: 'edited' },
        'edit',
      ),
    );
    await control({ kind: 'confirmation', reference: edit });
    await control({
      kind: 'confirm',
      reference: edit,
      outcome: ToolConfirmationOutcome.ProceedOnce,
    });
    expect(await execute(edit)).toMatchObject({ executionStatus: 'success' });
    expect(fs.readFileSync(output, 'utf8')).toBe('edited contents\n');
    const shell = reference(
      await prepare(
        'run_shell_command',
        { command: 'printf provider-shell' },
        'shell',
      ),
    );
    const shellResult = await execute<{ result?: unknown }>(shell);
    expect(shellResult).toMatchObject({ executionStatus: 'success' });
    expect(JSON.stringify(shellResult.result)).toContain('provider-shell');
    const snapshot = await control<ManagedToolFileHistoryState>({
      kind: 'history',
    });
    expect(snapshot.ownerSessionId).toBe(SESSION.harnessSessionId);
    expect(
      snapshot.snapshots[0].trackedFileBackups['output.txt'],
    ).toMatchObject({ backupFileName: null, version: 1 });
    const checkpoint = await control<ManagedToolFileHistoryState>({
      kind: 'checkpoint',
      promptId: 'prompt-2',
    });
    expect(checkpoint.revision).toBeGreaterThan(snapshot.revision);
    expect(checkpoint.snapshots.map((item) => item.promptId)).toEqual([
      'prompt-1',
      'prompt-2',
    ]);
    expect(await control({ kind: 'release' })).toBe(true);
    expect(await control({ kind: 'release' })).toBe(true);
    expect(await control({ kind: 'status', reference: shell })).toMatchObject({
      state: 'settled',
      cancelRequested: false,
    });
    expect(await control({ kind: 'cancel', reference: shell })).toMatchObject({
      state: 'settled',
      cancelRequested: false,
    });
    expect((await post({ kind: 'acquire' })).status).toBe(409);
    expect((await post({ kind: 'manifest' })).status).toBe(409);
  });

  it('fences Session identity, changed prepared input and legacy raw execution', async () => {
    await begin();
    expect(await control({ kind: 'acquire' })).toBe(true);
    expect(
      (
        await post(
          { kind: 'acquire' },
          { ...SESSION, turnKind: 'continuation' },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          { kind: 'acquire' },
          {
            ...SESSION,
            harnessSessionId: '550e8400-e29b-41d4-a716-4466554400ff',
          },
        )
      ).status,
    ).toBe(409);
    const prepared = await prepare('write_file', {
      file_path: path.join(workspace, 'never.txt'),
      content: 'first',
    });
    const ref = reference(prepared);
    expect(
      (
        await post({
          kind: 'prepare',
          identity,
          toolName: 'write_file',
          input: {
            file_path: path.join(workspace, 'never.txt'),
            content: 'second',
          },
        })
      ).status,
    ).toBe(409);
    expect(
      await control({
        kind: 'status',
        reference: { ...ref, invocationId: 'foreign' },
      }),
    ).toEqual({ state: 'unknown' });
    expect(
      (
        await post({
          kind: 'status',
          reference: { ...ref, sessionId: SESSION.harnessSessionId },
        })
      ).status,
    ).toBe(409);
    const legacy = await fetch(
      `${worker.ready.url}/internal/managed-runtime/v2/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          protocolVersion: 2,
          reference: {
            sessionId: ref.sessionId,
            promptId: ref.promptId,
            callId: ref.callId,
            argsDigest: ref.argsDigest,
          },
          toolName: 'write_file',
          input: {
            file_path: path.join(workspace, 'never.txt'),
            content: 'raw',
          },
        }),
      },
    );
    expect(legacy.status).toBe(409);
    expect((await post({ kind: 'release' })).status).toBe(200);
    expect(
      await control<ManagedToolInvocationStatus>({
        kind: 'status',
        reference: ref,
      }),
    ).toMatchObject({
      state: 'settled',
      result: { executionStatus: 'not_started' },
    });
    expect(fs.existsSync(path.join(workspace, 'never.txt'))).toBe(false);
    await control({ kind: 'release' });
    expect(await control({ kind: 'cancel', reference: ref })).toMatchObject({
      state: 'settled',
    });
  });

  it('reports forgotten invocations as unknown without accepting forged references or replaying work', async () => {
    await begin();
    const output = path.join(workspace, 'forgotten.txt');
    const old = reference(
      await prepare('write_file', { file_path: output, content: 'original' }),
    );
    expect(await execute(old)).toMatchObject({ executionStatus: 'success' });
    fs.writeFileSync(output, 'later');
    identity = { ...identity, promptId: 'prompt-2' };
    await control({ kind: 'begin-turn', identity });
    for (const kind of ['status', 'cancel']) {
      expect(await control({ kind, reference: old })).toEqual({
        state: 'unknown',
      });
    }
    expect((await post({ kind: 'execute', reference: old })).status).toBe(409);
    expect(fs.readFileSync(output, 'utf8')).toBe('later');
    const current = reference(
      await prepare('read_file', { file_path: output }),
    );
    for (const kind of ['status', 'cancel']) {
      const forged = await post({
        kind,
        reference: { ...current, argsDigest: '0'.repeat(64) },
      });
      expect(forged.status).toBe(409);
      expect(await forged.json()).toMatchObject({
        code: 'managed_runtime_provider_operation_failed',
      });
    }
    expect(await control({ kind: 'status', reference: current })).toMatchObject(
      {
        state: 'prepared',
        cancelRequested: false,
      },
    );
  });

  it('requires immutable history binding to its real directory before starting a turn', async () => {
    await acquire();
    const earlyBegin = await post({ kind: 'begin-turn', identity });
    expect(earlyBegin.status).toBe(409);
    expect(await earlyBegin.json()).toMatchObject({
      code: 'managed_runtime_provider_operation_failed',
    });
    expect(
      (
        await post({
          kind: 'bind-history',
          binding: { ...binding(), executionCwd: storage },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post({
          kind: 'bind-history',
          binding: {
            ...binding(),
            ownerRuntimeSessionId: SESSION.harnessSessionId,
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post({
          kind: 'bind-history',
          binding: {
            ...binding(),
            executionContext: {
              workspaceDirectories: [storage],
              memoryBaseDir: storage,
              lsToolEnabled: false,
              fileFilteringOptions: {
                respectGitIgnore: true,
                respectQwenIgnore: true,
                customIgnoreFiles: [],
              },
            },
          },
        })
      ).status,
    ).toBe(409);
    const initial = await control({ kind: 'bind-history', binding: binding() });
    expect(await control({ kind: 'bind-history', binding: binding() })).toEqual(
      initial,
    );
    await control({ kind: 'begin-turn', identity });
    expect(
      (
        await post({
          kind: 'bind-history',
          binding: {
            ...binding(),
            snapshots: [
              {
                promptId: 'other',
                timestamp: '2026-09-27T00:00:00.000Z',
                trackedFileBackups: {},
              },
            ],
          },
        })
      ).status,
    ).toBe(409);
    const backgroundShell = await post({
      kind: 'prepare',
      identity,
      toolName: 'run_shell_command',
      input: { command: 'sleep 1', is_background: true },
    });
    expect(backgroundShell.status).toBe(409);
    expect(await backgroundShell.json()).toMatchObject({
      code: 'managed_runtime_provider_operation_failed',
    });
  });

  it('rechecks directories for new work while status, cancellation and release remain available', async () => {
    await begin();
    const ref = reference(
      await prepare('write_file', {
        file_path: path.join(workspace, 'missing.txt'),
        content: 'never',
      }),
    );
    fs.rmSync(workspace, { recursive: true });
    const failed = await post({ kind: 'preflight', reference: ref });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({
      code: 'managed_context_unavailable',
    });
    expect(await control({ kind: 'status', reference: ref })).toMatchObject({
      state: 'prepared',
    });
    await control({ kind: 'cancel', reference: ref });
    await control({ kind: 'release' });
    expect(await control({ kind: 'status', reference: ref })).toMatchObject({
      state: 'settled',
    });
  });

  it('keeps authentication, lease fencing and the closed wire envelope on the new route', async () => {
    expect(
      (
        await post({ kind: 'acquire' }, SESSION, {
          ...HEADERS,
          authorization: 'Bearer wrong',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post({ kind: 'acquire' }, SESSION, {
          ...HEADERS,
          'x-qwen-managed-lease-epoch': '5',
        })
      ).status,
    ).toBe(409);
    expect((await post({ kind: 'acquire', extra: true })).status).toBe(400);
    expect((await post({ kind: 'unsupported' })).status).toBe(501);
    expect((await post({ kind: 'release' })).status).toBe(200);
    expect((await post({ kind: 'acquire' })).status).toBe(409);
  });

  it('refuses release during execution and cancels against the original invocation', async () => {
    await begin();
    const ref = reference(
      await prepare('run_shell_command', {
        command: `"${process.execPath}" -e "setTimeout(String, 30000)"`,
      }),
    );
    await control({ kind: 'preflight', reference: ref });
    const execution = control({ kind: 'execute', reference: ref });
    await vi.waitFor(async () => {
      expect(await control({ kind: 'status', reference: ref })).toMatchObject({
        state: 'executing',
      });
    });
    expect((await post({ kind: 'release' })).status).toBe(409);
    await control({ kind: 'cancel', reference: ref });
    const result = await execution;
    expect(result).toMatchObject({
      executionStatus: 'cancelled',
    });
    await control({ kind: 'release' });
  });

  it('refuses switching a journaled legacy Session to the provider protocol', async () => {
    const response = await fetch(
      `${worker.ready.url}/internal/managed-runtime/v2/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          protocolVersion: 2,
          reference: {
            sessionId: SESSION.runtimeSessionId,
            promptId: 'legacy',
            callId: 'legacy',
            argsDigest: 'legacy',
          },
          toolName: 'read_file',
          input: { file_path: path.join(workspace, 'input.txt') },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result.executionStatus).toBe('success');
    expect((await post({ kind: 'acquire' })).status).toBe(409);
    expect((await post({ kind: 'release' })).status).toBe(200);
    expect((await post({ kind: 'acquire' })).status).toBe(409);
  });

  it('keeps provider work inside an installed and activated Workspace context', async () => {
    await worker.close();
    const { workspaceCwd: _cwd, ...boot } = BOOT;
    worker = await startManagedRuntimeAttestationWorker({
      ...boot,
      version: 2,
      managedContext: MANAGED_CONTEXT_PROTOCOL,
      storageId: 'storage://pvc/workspace-a',
      mountRoot: workspace,
      capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    });
    const directory = path.join(workspace, 'child');
    fs.mkdirSync(directory);
    const context = {
      tenantId: BOOT.tenantId,
      workspaceId: BOOT.workspaceId,
      workspaceGeneration: BOOT.workspaceGeneration,
      storageId: 'storage://pvc/workspace-a',
      cwdRelative: 'child',
      contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
      contextRevision: '1',
    };
    const contextDigest = computeManagedContextDigest(context);
    const contextPost = (route: string, body: unknown) =>
      fetch(`${worker.ready.url}${route}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      });
    const unsupportedSession = {
      ...SESSION,
      runtimeSessionId: '550e8400-e29b-41d4-a716-446655440003',
    };
    const unsupportedBinding = {
      ...context,
      contextConfigRef: 'opaque-config',
    };
    expect(
      (
        await contextPost('/internal/managed-runtime/v3/context', {
          protocolVersion: 3,
          managedContext: MANAGED_CONTEXT_PROTOCOL,
          operationId: 'install-unsupported',
          sessionId: unsupportedSession.runtimeSessionId,
          binding: unsupportedBinding,
          contextDigest: computeManagedContextDigest(unsupportedBinding),
        })
      ).status,
    ).toBe(200);
    const unsupported = await post({ kind: 'acquire' }, unsupportedSession);
    expect(unsupported.status).toBe(501);
    expect(await unsupported.json()).toMatchObject({
      code: 'managed_runtime_provider_unsupported',
      error: 'Managed Runtime provider configuration is unsupported.',
    });
    expect((await post({ kind: 'acquire' })).status).toBe(409);
    expect(
      (
        await post(
          { kind: 'acquire' },
          {
            ...SESSION,
            harnessSessionId: '550e8400-e29b-41d4-a716-4466554400fe',
          },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await contextPost('/internal/managed-runtime/v3/context', {
          protocolVersion: 3,
          managedContext: MANAGED_CONTEXT_PROTOCOL,
          operationId: 'install-provider',
          sessionId: SESSION.runtimeSessionId,
          binding: context,
          contextDigest,
        })
      ).status,
    ).toBe(200);
    expect((await post({ kind: 'acquire' })).status).toBe(409);
    const activation = {
      protocolVersion: 1,
      operation: 'activate',
      sessionId: SESSION.runtimeSessionId,
      contextDigest,
      contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
      profile: WORKSPACE_EXECUTION_PROFILE,
    };
    expect(
      (await contextPost(WORKSPACE_ACTIVATION_ROUTE.path, activation)).status,
    ).toBe(200);
    await acquire();
    await control({
      kind: 'bind-history',
      binding: { ...binding(), executionCwd: directory },
    });
    await control({ kind: 'begin-turn', identity });
    const ref = reference(
      await prepare('write_file', {
        file_path: path.join(directory, 'proof.txt'),
        content: 'scoped',
      }),
    );
    const release = { ...activation, operation: 'release' };
    expect(
      (await contextPost(WORKSPACE_ACTIVATION_ROUTE.path, release)).status,
    ).toBe(409);
    expect(await execute(ref)).toMatchObject({ executionStatus: 'success' });
    expect(fs.readFileSync(path.join(directory, 'proof.txt'), 'utf8')).toBe(
      'scoped',
    );
    expect(fs.existsSync(path.join(workspace, 'proof.txt'))).toBe(false);
    expect(
      (await contextPost(WORKSPACE_ACTIVATION_ROUTE.path, release)).status,
    ).toBe(200);
    expect(
      (
        await post({
          kind: 'prepare',
          identity: { ...identity, callId: 'late' },
          toolName: 'read_file',
          input: { file_path: path.join(directory, 'proof.txt') },
        })
      ).status,
    ).toBe(409);
    expect(await control({ kind: 'status', reference: ref })).toMatchObject({
      state: 'settled',
    });
    await control({ kind: 'release' });
  });

  it.each([false, true])(
    'preserves raw admission after a refused provider acquire (Workspace profile: %s)',
    async (workspaceProfile) => {
      await worker.close();
      const { workspaceCwd: _cwd, ...boot } = BOOT;
      worker = await startManagedRuntimeAttestationWorker({
        ...boot,
        version: 2,
        managedContext: MANAGED_CONTEXT_PROTOCOL,
        storageId: 'storage://pvc/workspace-a',
        mountRoot: workspace,
        ...(workspaceProfile
          ? { capabilityDigest: WORKSPACE_CAPABILITY_DIGEST }
          : {}),
      });
      const refused = await post({ kind: 'acquire' });
      expect(refused.status).toBe(workspaceProfile ? 409 : 501);
      expect(await refused.json()).toMatchObject({
        code: workspaceProfile
          ? 'managed_context_unavailable'
          : 'managed_runtime_provider_unsupported',
      });
      const context = {
        tenantId: BOOT.tenantId,
        workspaceId: BOOT.workspaceId,
        workspaceGeneration: BOOT.workspaceGeneration,
        storageId: 'storage://pvc/workspace-a',
        cwdRelative: '.',
        contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
        contextRevision: '1',
      };
      const contextDigest = computeManagedContextDigest(context);
      const rawPost = (route: string, body: unknown) =>
        fetch(`${worker.ready.url}${route}`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(body),
        });
      expect(
        (
          await rawPost('/internal/managed-runtime/v3/context', {
            protocolVersion: 3,
            managedContext: MANAGED_CONTEXT_PROTOCOL,
            operationId: 'install-raw-fallback',
            sessionId: SESSION.runtimeSessionId,
            binding: context,
            contextDigest,
          })
        ).status,
      ).toBe(200);
      expect((await post({ kind: 'acquire' })).status).toBe(
        workspaceProfile ? 409 : 501,
      );
      if (workspaceProfile) {
        expect(
          (
            await rawPost(WORKSPACE_ACTIVATION_ROUTE.path, {
              protocolVersion: 1,
              operation: 'activate',
              sessionId: SESSION.runtimeSessionId,
              contextDigest,
              contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
              profile: WORKSPACE_EXECUTION_PROFILE,
            })
          ).status,
        ).toBe(200);
      }
      const executeRaw = (callId: string) =>
        rawPost('/internal/managed-runtime/v2/execute', {
          protocolVersion: 2,
          reference: {
            sessionId: SESSION.runtimeSessionId,
            promptId: 'raw',
            callId,
            argsDigest: callId,
          },
          toolName: 'read_file',
          input: { file_path: path.join(workspace, 'input.txt') },
        });
      const raw = await executeRaw('fallback');
      expect(raw.status).toBe(200);
      expect((await raw.json()).result.executionStatus).toBe('success');
      expect((await post({ kind: 'acquire' })).status).toBe(409);
      await control({ kind: 'release' });
      expect((await executeRaw('after-release')).status).toBe(409);
      expect((await post({ kind: 'acquire' })).status).toBe(409);
    },
  );

  it('refuses a checkpoint while work is in flight', async () => {
    await begin();
    const ref = reference(
      await prepare('run_shell_command', {
        command: `"${process.execPath}" -e "setTimeout(String, 30000)"`,
      }),
    );
    await control({ kind: 'preflight', reference: ref });
    const execution = control({ kind: 'execute', reference: ref });
    await vi.waitFor(async () => {
      expect(await control({ kind: 'status', reference: ref })).toMatchObject({
        state: 'executing',
      });
    });
    const busy = await post({ kind: 'checkpoint', promptId: 'prompt-2' });
    expect(busy.status).toBe(409);
    await control({ kind: 'cancel', reference: ref });
    expect(await execution).toMatchObject({ executionStatus: 'cancelled' });
    expect(
      await control<{ revision: number }>({
        kind: 'checkpoint',
        promptId: 'prompt-2',
      }),
    ).toMatchObject({ revision: expect.any(Number) });
  });

  it('keeps an oversized shell result observable instead of failing the wire contract', async () => {
    await begin();
    const ref = reference(
      await prepare(
        'run_shell_command',
        {
          command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(524288))"`,
        },
        'large',
      ),
    );
    await control({ kind: 'preflight', reference: ref });
    const result = await control<{
      executionStatus: string;
      result?: { llmContent?: unknown; returnDisplay?: unknown };
    }>({ kind: 'execute', reference: ref });
    expect(result.executionStatus).toBe('success');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024);
    expect(JSON.stringify(result.result)).toContain(
      'Managed Runtime provider omitted',
    );
    expect(result.result?.returnDisplay).toMatchObject({
      type: 'shell_result',
      truncated: true,
    });
    const status = await control<{ state: string; result?: unknown }>({
      kind: 'status',
      reference: ref,
    });
    expect(status.state).toBe('settled');
    expect(JSON.stringify(status.result)).toContain(
      'Managed Runtime provider omitted',
    );
    await control({ kind: 'cancel', reference: ref });
    expect(await control({ kind: 'release' })).toBe(true);
  });

  it('refuses envelope Session ids that are not lowercase UUIDs', async () => {
    for (const session of [
      { ...SESSION, runtimeSessionId: '../escape' },
      { ...SESSION, runtimeSessionId: SESSION.runtimeSessionId.toUpperCase() },
      { ...SESSION, harnessSessionId: '../../etc' },
    ]) {
      const response = await post({ kind: 'acquire' }, session);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'managed_runtime_provider_invalid',
      });
    }
    expect(await control({ kind: 'acquire' })).toBe(true);
  });

  it('fences legacy Tool v3 execution out of a provider-owned Session', async () => {
    await worker.close();
    const { workspaceCwd: _cwd, ...boot } = BOOT;
    worker = await startManagedRuntimeAttestationWorker(
      {
        ...boot,
        version: 2,
        managedContext: MANAGED_CONTEXT_PROTOCOL,
        storageId: 'storage://pvc/workspace-a',
        mountRoot: workspace,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      },
      // A working capture path: without the legacy-admission fence the Shell
      // below really runs, so its marker file witnesses the refusal.
      {
        prepare: async () => ({
          identity: {},
          sink: {
            identity: {},
            finalize: async (
              executionStatus: string,
              responseParts: unknown[],
              error?: unknown,
            ) => ({ executionStatus, responseParts, error, capture: null }),
          },
        }),
        accept: async () => {
          throw new Error('unexpected receipt');
        },
      } as never,
    );
    const contextPost = (route: string, body: unknown) =>
      fetch(`${worker.ready.url}${route}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      });
    const context = {
      tenantId: BOOT.tenantId,
      workspaceId: BOOT.workspaceId,
      workspaceGeneration: BOOT.workspaceGeneration,
      storageId: 'storage://pvc/workspace-a',
      cwdRelative: '.',
      contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
      contextRevision: '1',
    };
    const contextDigest = computeManagedContextDigest(context);
    expect(
      (
        await contextPost('/internal/managed-runtime/v3/context', {
          protocolVersion: 3,
          managedContext: MANAGED_CONTEXT_PROTOCOL,
          operationId: 'install-provider',
          sessionId: SESSION.runtimeSessionId,
          binding: context,
          contextDigest,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await contextPost(WORKSPACE_ACTIVATION_ROUTE.path, {
          protocolVersion: 1,
          operation: 'activate',
          sessionId: SESSION.runtimeSessionId,
          contextDigest,
          contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
          profile: WORKSPACE_EXECUTION_PROFILE,
        })
      ).status,
    ).toBe(200);
    await control({ kind: 'acquire' });
    const marker = path.join(workspace, 'v3-legacy-marker');
    const input = { command: `touch ${JSON.stringify(marker)}` };
    const response = await fetch(
      `${worker.ready.url}/internal/managed-runtime/v3/execute`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          protocolVersion: 3,
          toolResult: 'managed-tool-result/1',
          reference: {
            sessionId: SESSION.runtimeSessionId,
            promptId: 'turn-a',
            callId: 'call-a',
            argsDigest: managedToolDigest(input),
          },
          toolName: 'run_shell_command',
          input,
          capture: {
            tenantId: BOOT.tenantId,
            sessionId: SESSION.runtimeSessionId,
            turnId: 'turn-a',
            executionCallId: 'execution-a',
            bindingGeneration: '1',
            capturePolicy: 'complete_required',
          },
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(fs.existsSync(marker)).toBe(false);
    await control({ kind: 'release' });
  });
});
