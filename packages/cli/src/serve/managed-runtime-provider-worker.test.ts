/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  getSessionModel,
  getSessionModelIdentity,
  getSessionProjectDir,
  registerSessionModel,
  registerSessionProjectDir,
  unregisterSessionModel,
  unregisterSessionProjectDir,
} from '@qwen-code/qwen-code-core/utils/sessionIdContext.js';
import type {
  ManagedToolCallIdentity,
  ManagedToolInvocationReference,
  ManagedToolPrepareResponse,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  ManagedToolFileHistory,
  type ManagedToolFileHistoryState,
} from '@qwen-code/qwen-code-core/tools/managed-tool-file-history.js';
import {
  ManagedToolRuntime,
  type ManagedToolInvocationStatus,
} from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import {
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
  type ManagedRuntimeWorkerBoot,
} from './managed-runtime-attestation-worker.js';
import {
  MANAGED_RUNTIME_PROVIDER_PROTOCOL,
  MANAGED_RUNTIME_PROVIDER_ROUTE,
  managedRuntimeProviderLimit,
  type ManagedRuntimeProviderSession,
} from './managed-runtime-provider-protocol.js';
import { MANAGED_CONTEXT_PROTOCOL } from './managed-context-envelope.js';
import { ManagedContextMount } from './managed-context-worker.js';
import { computeManagedContextDigest } from './managed-workspace-binding.js';
import {
  WORKSPACE_ACTIVATION_ROUTE,
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
  WORKSPACE_EXECUTION_PROFILE,
} from './managed-workspace-activation.js';

const retirementWarning = vi.hoisted(() => vi.fn());

vi.mock(
  '@qwen-code/qwen-code-core/utils/debugLogger.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/utils/debugLogger.js')
      >();
    return {
      ...actual,
      createDebugLogger: (tag?: string) => {
        const logger = actual.createDebugLogger(tag);
        return tag === 'MANAGED_RUNTIME_PROVIDER'
          ? { ...logger, warn: retirementWarning }
          : logger;
      },
    };
  },
);

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
  /** Releases of held calls, opened before the worker closes. */
  const holds: Array<() => void> = [];

  beforeEach(async () => {
    retirementWarning.mockClear();
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
    // A test that failed while holding a call must not hold up the close.
    for (const release of holds.splice(0)) release();
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
  async function control<T = unknown>(
    operation: unknown,
    session = SESSION,
  ): Promise<T> {
    const response = await post(operation, session);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({
      protocolVersion: 1,
      providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
      session,
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

  it('keeps shell calls inside the Session workspace', async () => {
    await begin();
    // The kernel follows a link before the `..` after it.
    fs.mkdirSync(path.join(storage, 'inner'));
    fs.symlinkSync(path.join(storage, 'inner'), path.join(workspace, 'link'));
    // Core's shell tool would ask here, and a preapproved Session never asks.
    for (const directory of [
      storage,
      `${path.join(workspace, 'link')}${path.sep}..`,
      // An unresolved path fails the containment check closed, before execution.
      path.join(workspace, 'missing-directory'),
    ]) {
      const outside = await post({
        kind: 'prepare',
        identity,
        toolName: 'run_shell_command',
        input: { command: 'pwd', directory },
      });
      expect(outside.status).toBe(400);
      expect(await outside.json()).toEqual({
        code: 'managed_runtime_tool_invalid',
        error: `Directory '${directory}' is not within any of the registered workspace directories.`,
      });
    }
    // Nothing was journaled: the same call prepares once corrected.
    expect(
      await prepare('run_shell_command', {
        command: 'pwd',
        directory: workspace,
      }),
    ).toMatchObject({ callId: 'call-1' });
    // An empty directory is the Session's own, as core reads it.
    expect(
      await prepare(
        'run_shell_command',
        { command: 'pwd', directory: '' },
        'call-2',
      ),
    ).toMatchObject({ callId: 'call-2' });
  });

  it('refuses a shell call whose directory leaves the workspace before it runs', async () => {
    await begin();
    const sub = path.join(workspace, 'sub');
    fs.mkdirSync(sub);
    const ref = reference(
      await prepare('run_shell_command', { command: 'pwd', directory: sub }),
    );
    await control({ kind: 'preflight', reference: ref });
    // Retargeted between the checks: the call must not run outside.
    fs.rmdirSync(sub);
    fs.symlinkSync(storage, sub);
    expect(await control({ kind: 'execute', reference: ref })).toMatchObject({
      executionStatus: 'error',
      error: {
        message: `Directory '${sub}' is not within any of the registered workspace directories.`,
      },
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

  it('returns only progress after a nonzero status cursor', async () => {
    await begin();
    const gate = path.join(workspace, 'second-output');
    const script = path.join(workspace, 'progress.cjs');
    fs.writeFileSync(
      script,
      `const fs = require('node:fs');
process.stdout.write('first');
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(gate)})) {
    clearInterval(timer);
    process.stdout.write('second');
  }
}, 20);`,
    );
    const ref = reference(
      await prepare('run_shell_command', {
        command: `"${process.execPath}" "${script}"`,
      }),
    );
    const executing = execute(ref);
    try {
      await vi.waitFor(
        async () => {
          const status = await control<ManagedToolInvocationStatus>({
            kind: 'status',
            reference: ref,
          });
          expect(status.progress.length).toBeGreaterThan(0);
        },
        { timeout: 5000 },
      );
    } finally {
      fs.writeFileSync(gate, '');
      await executing;
    }
    const full = await control<ManagedToolInvocationStatus>({
      kind: 'status',
      reference: ref,
    });
    expect(full.progress.length).toBeGreaterThan(1);
    const cursor = full.progress[0].seq;
    expect(cursor).toBeGreaterThan(0);
    const after = await control<ManagedToolInvocationStatus>({
      kind: 'status',
      reference: ref,
      afterSequence: cursor,
    });
    expect(after.lastSeq).toBe(full.lastSeq);
    expect(after.progress).toEqual(
      full.progress.filter((event) => event.seq > cursor),
    );
  });

  it('accepts a manifest whose full envelope exactly fits the wire limit', async () => {
    await acquire();
    const manifest = await control<ReturnType<ManagedToolRuntime['manifest']>>({
      kind: 'manifest',
    });
    const limit = managedRuntimeProviderLimit('manifest');
    const envelope = {
      protocolVersion: 1,
      providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
      session: SESSION,
      result: 0,
    };
    const overhead = Buffer.byteLength(JSON.stringify(envelope)) - 1;
    manifest.tools[0] = { ...manifest.tools[0], description: '' };
    const padding =
      limit - overhead - Buffer.byteLength(JSON.stringify(manifest));
    manifest.tools[0] = {
      ...manifest.tools[0],
      description: 'x'.repeat(padding),
    };
    manifest.capabilityDigest = managedToolDigest(manifest.tools, limit);
    vi.spyOn(ManagedToolRuntime.prototype, 'manifest').mockReturnValue(
      manifest,
    );
    const response = await post({ kind: 'manifest' });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBe(limit);
    expect(JSON.parse(body)).toEqual({ ...envelope, result: manifest });
  });

  it('fits a status whose envelope is one byte over the wire limit', async () => {
    await begin();
    const ref = reference(
      await prepare('read_file', {
        file_path: path.join(workspace, 'input.txt'),
      }),
    );
    await execute(ref);
    const status = await control<ManagedToolInvocationStatus>({
      kind: 'status',
      reference: ref,
    });
    const result = { llmContent: '', returnDisplay: '' };
    status.result = { executionStatus: 'success', result };
    const limit = managedRuntimeProviderLimit('status');
    const overhead =
      Buffer.byteLength(
        JSON.stringify({
          protocolVersion: 1,
          providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
          session: SESSION,
          result: 0,
        }),
      ) - 1;
    result.llmContent = 'x'.repeat(
      limit - overhead + 1 - Buffer.byteLength(JSON.stringify(status)),
    );
    expect(Buffer.byteLength(JSON.stringify(status)) + overhead).toBe(
      limit + 1,
    );
    vi.spyOn(ManagedToolRuntime.prototype, 'status').mockReturnValue(status);
    const response = await post({ kind: 'status', reference: ref });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(limit);
    expect(JSON.parse(body).result).toMatchObject({
      state: 'settled',
      result: { executionStatus: 'success' },
    });
    expect(body).toContain('Managed Runtime provider omitted');
  });

  it('refuses an unfitted manifest whose envelope exceeds the wire limit', async () => {
    await acquire();
    const manifest = await control<ReturnType<ManagedToolRuntime['manifest']>>({
      kind: 'manifest',
    });
    const limit = managedRuntimeProviderLimit('manifest');
    manifest.tools[0] = { ...manifest.tools[0], description: '' };
    const padding = limit - Buffer.byteLength(JSON.stringify(manifest));
    manifest.tools[0] = {
      ...manifest.tools[0],
      description: 'x'.repeat(padding),
    };
    manifest.capabilityDigest = managedToolDigest(manifest.tools, limit);
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBe(limit);
    vi.spyOn(ManagedToolRuntime.prototype, 'manifest').mockReturnValue(
      manifest,
    );
    const response = await post({ kind: 'manifest' });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: 'managed_runtime_provider_too_large',
      error: 'Managed Runtime provider response exceeds its body size limit.',
    });
  });

  it('preserves a prepared invocation when release is refused over a pending history read', async () => {
    await begin();
    const ref = reference(
      await prepare('read_file', {
        file_path: path.join(workspace, 'input.txt'),
      }),
    );
    const drain = hold(ManagedToolFileHistory.prototype, 'drain');
    const observed = control({ kind: 'history' });
    await drain.entered();
    const refused = await post({ kind: 'release' });
    expect(refused.status).toBe(409);
    expect(await control({ kind: 'status', reference: ref })).toMatchObject({
      state: 'prepared',
    });
    expect(await refused.json()).toEqual({
      code: 'managed_runtime_provider_operation_failed',
      error: 'Managed Runtime Session still owns unfinished work.',
    });
    drain.release();
    await observed;
    expect(await execute(ref)).toMatchObject({ executionStatus: 'success' });
  });

  it('rechecks pending controls that arrive while release preparation is waiting', async () => {
    await begin();
    const ref = reference(
      await prepare('read_file', {
        file_path: path.join(workspace, 'input.txt'),
      }),
    );
    const preparedRelease = hold(
      ManagedToolRuntime.prototype,
      'releasePrepared',
    );
    const releasing = post({ kind: 'release' });
    await preparedRelease.entered();
    const drain = hold(ManagedToolFileHistory.prototype, 'drain');
    const observed = control({ kind: 'history' });
    await drain.entered();
    preparedRelease.release();
    const refused = await releasing;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      code: 'managed_runtime_identity_conflict',
      error: 'Managed Runtime Session still owns unfinished work.',
    });
    // Preparation already cancelled pending work before this late refusal.
    expect(await control({ kind: 'status', reference: ref })).toMatchObject({
      state: 'settled',
      cancelRequested: true,
      result: { executionStatus: 'not_started' },
    });
    drain.release();
    await observed;
    expect(await control({ kind: 'manifest' })).toMatchObject({
      tools: expect.any(Array),
    });
    expect(await control({ kind: 'release' })).toBe(true);
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

  it('drops the registry entries core keyed on a Runtime Session when it ends', async () => {
    const other = { ...SESSION, runtimeSessionId: 'runtime-session-other' };
    // The Harness Session's own entries, as its live Config registers them.
    registerSessionProjectDir(SESSION.harnessSessionId, '/harness/project');
    registerSessionModel(SESSION.harnessSessionId, 'harness-model');
    onTestFinished(() => {
      unregisterSessionProjectDir(SESSION.harnessSessionId);
      unregisterSessionModel(SESSION.harnessSessionId);
    });
    await acquire();
    expect(await control({ kind: 'acquire' }, other)).toBe(true);
    for (const id of [SESSION.runtimeSessionId, other.runtimeSessionId]) {
      expect(getSessionProjectDir(id)).toEqual(expect.any(String));
      expect(getSessionModel(id)).toBe('managed-runtime-worker');
    }

    expect(await control({ kind: 'release' })).toBe(true);
    expect(getSessionProjectDir(SESSION.runtimeSessionId)).toBeUndefined();
    expect(getSessionModel(SESSION.runtimeSessionId)).toBeUndefined();
    expect(getSessionModelIdentity(SESSION.runtimeSessionId)).toBeUndefined();
    // Only the ended Session's entries go, never another Runtime Session's
    // or the Harness Session's.
    expect(getSessionModel(other.runtimeSessionId)).toBe(
      'managed-runtime-worker',
    );
    expect(getSessionProjectDir(SESSION.harnessSessionId)).toBe(
      '/harness/project',
    );
    expect(getSessionModel(SESSION.harnessSessionId)).toBe('harness-model');

    await worker.close();
    expect(getSessionProjectDir(other.runtimeSessionId)).toBeUndefined();
    expect(getSessionModel(other.runtimeSessionId)).toBeUndefined();
  });

  it('retires released Sessions beyond the most recent few', async () => {
    const shutdown = vi.spyOn(Config.prototype, 'shutdown');
    const dispose = vi.spyOn(ManagedToolRuntime.prototype, 'dispose');
    const drain = vi.spyOn(ManagedToolFileHistory.prototype, 'drain');
    await begin();
    const read = reference(
      await prepare('read_file', {
        file_path: path.join(workspace, 'input.txt'),
      }),
    );
    await execute(read);
    expect(await control({ kind: 'release' })).toBe(true);
    const status = () =>
      control({ kind: 'status', reference: read, afterSequence: 0 });
    // Just released, the Session still answers for its calls.
    expect(await status()).toMatchObject({ state: 'settled' });
    expect(await control({ kind: 'history' })).toMatchObject({
      revision: expect.any(Number),
    });
    const others = Array.from({ length: 8 }, (_, index) => ({
      ...SESSION,
      runtimeSessionId: `runtime-released-${index}`,
    }));
    let disposed = 0;
    let drained = 0;
    for (const [index, other] of others.entries()) {
      if (index === 7) {
        // Seven later releases still leave it observable.
        expect(await status()).toMatchObject({ state: 'settled' });
        disposed = dispose.mock.calls.length;
        drained = drain.mock.calls.length;
      }
      expect(await control({ kind: 'acquire' }, other)).toBe(true);
      expect(await control({ kind: 'release' }, other)).toBe(true);
    }
    // The eighth retires it to a tombstone.
    expect(dispose).toHaveBeenCalledTimes(disposed + 1);
    expect(drain).toHaveBeenCalledTimes(drained + 1);
    const own = (config: unknown) =>
      (config as Config).getSessionId() === SESSION.runtimeSessionId;
    expect(shutdown.mock.contexts.filter(own).length).toBe(1);
    expect(shutdown).toHaveBeenCalledWith({
      shutdownTelemetry: false,
      skipSessionWriter: true,
    });
    expect(await status()).toEqual({ state: 'unknown' });
    expect(await control({ kind: 'cancel', reference: read })).toEqual({
      state: 'unknown',
    });
    expect((await post({ kind: 'history' })).status).toBe(409);
    expect(await control({ kind: 'release' })).toBe(true);
    expect((await post({ kind: 'acquire' })).status).toBe(409);
    // Nothing keeps the retired Session's Config reachable any more.
    const retired = new WeakRef(shutdown.mock.contexts.find(own) as object);
    for (const spy of [shutdown, dispose, drain]) {
      spy.mockClear();
      spy.mockRestore();
    }
    v8.setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;
    // deref() keeps its target alive until the current job ends, so collect
    // in a job that has not dereferenced it.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    let collected = false;
    for (let attempt = 0; attempt < 10 && !collected; attempt++) {
      await tick();
      gc();
      await tick();
      collected = retired.deref() === undefined;
    }
    expect(collected).toBe(true);
    // Worker shutdown retires the Sessions still held.
    const closing = vi.spyOn(Config.prototype, 'shutdown');
    await worker.close();
    expect(
      closing.mock.contexts
        .map((config) => (config as Config).getSessionId())
        .sort(),
    ).toEqual(others.map((other) => other.runtimeSessionId).sort());
    expect(retirementWarning).not.toHaveBeenCalled();
  });

  /**
   * Holds the first `count` calls of a prototype method until the returned
   * release; `entered(n)` resolves once n of them are held.
   */
  function hold<T extends object>(
    target: T,
    method: keyof T & string,
    count = 1,
  ) {
    const original = target[method] as unknown as (
      this: unknown,
      ...args: unknown[]
    ) => unknown;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    holds.push(release);
    let held = 0;
    const waiters: Array<[number, () => void]> = [];
    vi.spyOn(target, method as never).mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (held === count) return original.apply(this, args);
      held++;
      for (const [n, resolve] of waiters) if (n <= held) resolve();
      return gate.then(() => original.apply(this, args));
    } as never);
    const entered = (n = 1) =>
      new Promise<void>((resolve) => {
        if (held >= n) resolve();
        else waiters.push([n, resolve]);
      });
    return { entered, release };
  }

  function releasedSessions(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      ...SESSION,
      runtimeSessionId: `runtime-retiring-${index}`,
    }));
  }

  it('keeps answering for a live Session while the worker shuts it down', async () => {
    const dispose = hold(ManagedToolRuntime.prototype, 'dispose');
    await begin();
    const read = reference(
      await prepare('read_file', {
        file_path: path.join(workspace, 'input.txt'),
      }),
    );
    await execute(read);
    const closing = worker.close();
    await dispose.entered();
    expect(
      await control({ kind: 'status', reference: read, afterSequence: 0 }),
    ).toMatchObject({ state: 'settled' });
    dispose.release();
    await closing;
  });

  it('answers a release after the retirement it triggers, and a retry at once', async () => {
    const sessions = releasedSessions(9);
    for (const session of sessions.slice(0, 8)) {
      expect(await control({ kind: 'acquire' }, session)).toBe(true);
      expect(await control({ kind: 'release' }, session)).toBe(true);
    }
    expect(await control({ kind: 'acquire' }, sessions[8])).toBe(true);
    const dispose = hold(ManagedToolRuntime.prototype, 'dispose');
    // The ninth release retires the first Session, whose disposal is held.
    let released = false;
    const ninth = control({ kind: 'release' }, sessions[8]).then((result) => {
      released = true;
      return result;
    });
    await dispose.entered();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(released).toBe(false);
    // A retry, as after a Broker timeout, answers without waiting.
    expect(await control({ kind: 'release' }, sessions[8])).toBe(true);
    expect(released).toBe(false);
    dispose.release();
    expect(await ninth).toBe(true);
    expect(retirementWarning).not.toHaveBeenCalled();
  });

  it('waits in close() for a retirement in flight and shuts each Config down once', async () => {
    const shutdown = vi.spyOn(Config.prototype, 'shutdown');
    const sessions = releasedSessions(9);
    for (const session of sessions.slice(0, 8)) {
      expect(await control({ kind: 'acquire' }, session)).toBe(true);
      expect(await control({ kind: 'release' }, session)).toBe(true);
    }
    expect(await control({ kind: 'acquire' }, sessions[8])).toBe(true);
    const dispose = hold(ManagedToolRuntime.prototype, 'dispose');
    // The worker closes under the ninth release, which may cut its answer.
    const ninth = post({ kind: 'release' }, sessions[8]).catch(() => undefined);
    await dispose.entered();
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    dispose.release();
    await closing;
    await ninth;
    expect(
      shutdown.mock.contexts
        .map((config) => (config as Config).getSessionId())
        .sort(),
    ).toEqual(sessions.map((session) => session.runtimeSessionId).sort());
    expect(retirementWarning).not.toHaveBeenCalled();
  });

  it('waits in close() for an acquire in flight and shuts its Config down', async () => {
    const shutdown = vi.spyOn(Config.prototype, 'shutdown');
    const resolve = hold(ManagedContextMount.prototype, 'resolve');
    // The worker closes under the acquire, which may cut its answer.
    const acquiring = post({ kind: 'acquire' }).catch(() => undefined);
    await resolve.entered();
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    resolve.release();
    await closing;
    await acquiring;
    expect(
      shutdown.mock.contexts.map((config) => (config as Config).getSessionId()),
    ).toEqual([SESSION.runtimeSessionId]);
  });

  it('finishes a retirement whose first step fails without failing the release', async () => {
    vi.spyOn(ManagedToolRuntime.prototype, 'dispose').mockRejectedValueOnce(
      new Error('dispose failed'),
    );
    const shutdown = vi.spyOn(Config.prototype, 'shutdown');
    const sessions = releasedSessions(9);
    for (const session of sessions) {
      expect(await control({ kind: 'acquire' }, session)).toBe(true);
      expect(await control({ kind: 'release' }, session)).toBe(true);
    }
    expect(retirementWarning).toHaveBeenCalledExactlyOnceWith(
      'Retiring a released Session failed:',
      expect.objectContaining({
        errors: [expect.objectContaining({ message: 'dispose failed' })],
      }),
    );
    // The later steps still ran, and the Session is a tombstone.
    expect(
      shutdown.mock.contexts.map((config) => (config as Config).getSessionId()),
    ).toEqual([sessions[0].runtimeSessionId]);
    const history = await post({ kind: 'history' }, sessions[0]);
    expect(history.status).toBe(409);
    expect(await history.json()).toMatchObject({
      error: 'Managed Runtime Session is closed.',
    });
  });

  it('retires the oldest released Session that is not being observed', async () => {
    await begin();
    expect(await control({ kind: 'release' })).toBe(true);
    const sessions = releasedSessions(8);
    for (const session of sessions.slice(0, 7)) {
      expect(await control({ kind: 'acquire' }, session)).toBe(true);
      expect(await control({ kind: 'release' }, session)).toBe(true);
    }
    // A history read of the oldest Session is still in flight.
    const drain = hold(ManagedToolFileHistory.prototype, 'drain');
    const observed = control({ kind: 'history' });
    await drain.entered();
    const shutdown = vi.spyOn(Config.prototype, 'shutdown');
    expect(await control({ kind: 'acquire' }, sessions[7])).toBe(true);
    expect(await control({ kind: 'release' }, sessions[7])).toBe(true);
    expect(
      shutdown.mock.contexts.map((config) => (config as Config).getSessionId()),
    ).toEqual([sessions[0].runtimeSessionId]);
    drain.release();
    expect(await observed).toMatchObject({ revision: expect.any(Number) });
    expect(retirementWarning).not.toHaveBeenCalled();
  });

  it('retires the Session just released when every retained one is being observed', async () => {
    const sessions = Array.from({ length: 9 }, (_, index) => ({
      ...SESSION,
      runtimeSessionId: `550e8400-e29b-41d4-a716-4466554401${String(index).padStart(2, '0')}`,
    }));
    for (const session of sessions.slice(0, 8)) {
      expect(await control({ kind: 'acquire' }, session)).toBe(true);
      await control(
        {
          kind: 'bind-history',
          binding: {
            ...binding(),
            ownerRuntimeSessionId: session.runtimeSessionId,
          },
        },
        session,
      );
      expect(await control({ kind: 'release' }, session)).toBe(true);
    }
    // A history read holds each of the eight retained Sessions.
    const drain = hold(ManagedToolFileHistory.prototype, 'drain', 8);
    const observed = sessions
      .slice(0, 8)
      .map((session) => control({ kind: 'history' }, session));
    await drain.entered(8);
    const shutdown = vi.spyOn(Config.prototype, 'shutdown');
    expect(await control({ kind: 'acquire' }, sessions[8])).toBe(true);
    expect(await control({ kind: 'release' }, sessions[8])).toBe(true);
    // The Session just released is the one idle: the bound of eight holds.
    expect(
      shutdown.mock.contexts.map((config) => (config as Config).getSessionId()),
    ).toEqual([sessions[8].runtimeSessionId]);
    drain.release();
    for (const history of await Promise.all(observed))
      expect(history).toMatchObject({ revision: expect.any(Number) });
    expect(retirementWarning).not.toHaveBeenCalled();
  });

  it('answers a release that came before any acquire with a forgetful tombstone', async () => {
    await acquire();
    const fresh = {
      ...SESSION,
      runtimeSessionId: '550e8400-e29b-41d4-a716-446655440099',
    };
    expect(await control({ kind: 'release' }, fresh)).toBe(true);
    const unknown = {
      sessionId: fresh.runtimeSessionId,
      promptId: 'prompt-1',
      callId: 'call-1',
      capabilityDigest: identity.capabilityDigest,
      policyRevision: identity.policyRevision,
      invocationId: '550e8400-e29b-41d4-a716-446655440098',
      argsDigest: managedToolDigest({}),
    };
    expect(
      await control(
        { kind: 'status', reference: unknown, afterSequence: 0 },
        fresh,
      ),
    ).toEqual({ state: 'unknown' });
    expect(
      await control({ kind: 'cancel', reference: unknown }, fresh),
    ).toEqual({ state: 'unknown' });
    expect((await post({ kind: 'acquire' }, fresh)).status).toBe(409);
  });

  it('refuses content modification on this profile and routes media context to read_file only', async () => {
    await begin();
    const source = reference(
      await prepare(
        'edit',
        {
          file_path: path.join(workspace, 'input.txt'),
          old_string: 'original',
          new_string: 'edited',
        },
        'edit-source',
      ),
    );
    const edited = {
      file_path: path.join(workspace, 'input.txt'),
      old_string: 'original',
      new_string: 'modified',
    };
    const modified = await post({
      kind: 'prepare',
      identity: { ...identity, callId: 'edit-modified' },
      toolName: 'edit',
      input: edited,
      modification: { source, newContent: 'modified content\n' },
    });
    expect(modified.status).toBe(400);
    expect(await modified.json()).toEqual({
      code: 'managed_runtime_tool_invalid',
      error:
        'Managed Runtime provider profile does not admit content modification.',
    });
    // Refused before core journaled anything: the call is still free for
    // other input.
    await prepare(
      'edit',
      { ...edited, new_string: 'rewritten' },
      'edit-modified',
    );

    const media = { inputModalities: { image: true } };
    const read = await post({
      kind: 'prepare',
      identity: { ...identity, callId: 'media-read' },
      toolName: 'read_file',
      input: { file_path: path.join(workspace, 'input.txt') },
      mediaContext: media,
    });
    expect(read.status).toBe(200);
    // The media-bound tool still reads through the Session's file service.
    const mediaRead = await execute<{ result?: unknown }>(
      reference(await read.json().then((body) => body.result)),
    );
    expect(mediaRead).toMatchObject({ executionStatus: 'success' });
    expect(JSON.stringify(mediaRead.result)).toContain('original content');
    const write = await post({
      kind: 'prepare',
      identity: { ...identity, callId: 'media-write' },
      toolName: 'write_file',
      input: { file_path: path.join(workspace, 'output.txt'), content: 'x' },
      mediaContext: media,
    });
    expect(write.status).toBe(409);
    expect(await write.json()).toEqual({
      code: 'managed_runtime_provider_operation_failed',
      error: 'Managed Runtime tool does not support media context.',
    });
    expect(fs.readFileSync(path.join(workspace, 'input.txt'), 'utf8')).toBe(
      'original content\n',
    );
  });

  it('refuses envelope Session ids outside the path-safe ASCII allow-list', async () => {
    for (const session of [
      { ...SESSION, runtimeSessionId: '../escape' },
      { ...SESSION, runtimeSessionId: 'a/b\nc' },
      { ...SESSION, harnessSessionId: '../../etc' },
      { ...SESSION, runtimeSessionId: 'has\\backslash' },
      { ...SESSION, runtimeSessionId: 'has space' },
      { ...SESSION, runtimeSessionId: 'emoji-\u{1F600}' },
    ]) {
      const response = await post({ kind: 'acquire' }, session);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'managed_runtime_provider_invalid',
      });
    }
    // The wire contract does not require the UUID form: an opaque but
    // path-safe id still acquires, exactly as the Broker's fault gates drive.
    expect(
      await control(
        { kind: 'acquire' },
        { ...SESSION, runtimeSessionId: 'sess-opaque-01' },
      ),
    ).toBe(true);
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
