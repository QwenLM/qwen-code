/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { type ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import { type HttpToolPublicationOwner } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { LocalJsonlManagedSessionJournalHandle } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { readHostedFileHistory } from './hosted-file-history.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import {
  HOSTED_TOOL_INPUT_ORDER,
  HostedHookSession,
  hostedHookOccurrenceId,
} from './hosted-hook-session.js';
import {
  HOSTED_TEAM_TOOLS,
  HOSTED_TEAM_PLAN_TOOL,
} from './hosted-team-session.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { boundedShellPreview } from './managed-shell-publisher.js';
import {
  HostedWorkspaceBrokerRejection,
  type HostedWorkspaceBroker,
} from './hosted-workspace-broker.js';
import {
  HostedWorkspaceToolTurn,
  HostedToolRecoveryRequiredError,
  HOSTED_WORKSPACE_FILE_TOOLS,
  HOSTED_WORKSPACE_SHELL_TOOLS,
  HOSTED_INPUT_PREVIEW_TOOLS,
  HOSTED_TODO_WRITE_TOOL,
  HOSTED_MEMBER_PLAN_TOOL,
  HOSTED_SEND_MESSAGE_TO_CHILD_TOOL,
  HOSTED_SEND_MESSAGE_TO_PARENT_TOOL,
  HOSTED_AGENT_TOOL,
  HOSTED_WORKFLOW_TOOL,
} from './hosted-workspace-tool-turn.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  hostedActionAllowed,
  resolveHostedAction,
  type HostedApprovalMode,
  type HostedApprovalSettings,
} from './hosted-tool-approval.js';
import * as stdio from '../utils/stdioHelpers.js';
import type { HostedSkillCatalog } from './hosted-skill-catalog.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import {
  RESIDENT_WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CAPABILITY_DIGEST,
} from './managed-workspace-activation.js';

const broker = vi.hoisted(() => ({
  capabilityDigest:
    'sha256:7df3981fa14b397fe09f6ba84ed0c096c71902394da667bf47f3b315866e7f91',
  fileHistory: vi.fn(),
  authorizeLifecycle: vi.fn(),
  workspaceContext: vi.fn(),
  warm: vi.fn(),
  resolveCapabilities: vi.fn(),
  acquire: vi.fn(),
  prepare: vi.fn(),
  prepareV3: vi.fn(),
  execute: vi.fn(),
  executeV3: vi.fn(),
  acknowledgeV3: vi.fn(),
  cancel: vi.fn(),
  release: vi.fn(),
  releaseMount: vi.fn(),
  registerPublisher: vi.fn(),
  acknowledge: vi.fn(),
  backgroundProcessStatus: vi.fn(),
  status: vi.fn(),
  monitorControl: vi.fn(),
}));
// child_run's shell kind and monitor_run are enabled by the H3 enablement
// slice (#13856); a case that needs a gate shut closes it here, per test,
// per the same harness the core suites use.
const enablement = vi.hoisted(() => ({
  childRun: true,
  monitorRun: true,
}));
vi.mock('./hosted-workspace-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hosted-workspace-broker.js')>()),
  HostedWorkspaceBroker: class {
    readonly runtimeSessionId = 'prompt';
    readonly capabilityDigest = broker.capabilityDigest;
    // Like the real client: the claim is recorded before the acquire
    // request leaves, so a lost reply still names it.
    private claim?: string;
    mountClaim = () => this.claim;
    fileHistory = broker.fileHistory;
    authorizeLifecycle = broker.authorizeLifecycle;
    workspaceContext = broker.workspaceContext;
    warm = broker.warm;
    resolveCapabilities = broker.resolveCapabilities;
    acquire = (...args: unknown[]) => {
      this.claim = `claim-${broker.acquire.mock.calls.length + 1}`;
      return broker.acquire(...args);
    };
    prepare = broker.prepare;
    prepareV3 = broker.prepareV3;
    execute = broker.execute;
    executeV3 = broker.executeV3;
    acknowledgeV3 = broker.acknowledgeV3;
    cancel = broker.cancel;
    release = broker.release;
    releaseMount = broker.releaseMount;
    registerPublisher = broker.registerPublisher;
    acknowledge = broker.acknowledge;
    backgroundProcessStatus = broker.backgroundProcessStatus;
    status = broker.status;
    monitorControl = broker.monitorControl;
  },
}));
vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js')
      >();
    return {
      ...actual,
      // #13856: the production gates admit monitor_run and the shell kind;
      // a test that needs either shut closes it per test, never the other
      // way around.
      assertManagedSessionDomainEnabled: (
        domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
      ) => {
        if (domain === 'monitor_run' && !enablement.monitorRun) {
          throw new actual.ManagedSessionRecordError(
            'domain monitor_run is registered but not enabled for submission.',
          );
        }
        actual.assertManagedSessionDomainEnabled(domain);
      },
      // H4b: record commits gate per kind; the admission mock above keeps
      // its plain-domain meaning, this one carries the commit side.
      assertManagedSessionChildRunKindEnabled: (kind: string) => {
        if (kind === 'shell' && !enablement.childRun) {
          throw new actual.ManagedSessionRecordError(
            'domain child_run kind shell is registered but not enabled for submission.',
          );
        }
        actual.assertManagedSessionChildRunKindEnabled(kind);
      },
    };
  },
);
let root: string;
let session: ManagedSession;
let harness: ReturnType<typeof createManagedHarnessHandle>;
let turn: HostedWorkspaceToolTurn;
let commit: ConstructorParameters<typeof HostedWorkspaceToolTurn>[4];
const messageFitsInline = vi.fn<
  ConstructorParameters<typeof HostedWorkspaceToolTurn>[5]
>(() => true);
let waiters: HostedApprovalWaiters;
let expectWritesStopped: boolean;
function createTurn(
  shell = false,
  approval?: {
    mode: HostedApprovalMode;
    timeoutMs?: number;
    readSettings?: () => Promise<HostedApprovalSettings>;
    isBlocked?: () => boolean;
    permissionRules?: HostedApprovalSettings['permissionRules'];
  },
  hooks?: HostedHookSession,
  skills?: HostedSkillCatalog,
  planMode: 'none' | 'public' | 'member' = 'none',
) {
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    shell
      ? { resources: session.resources, assertWritable: async () => undefined }
      : undefined,
    undefined,
    approval && {
      settings: {
        mode: approval.mode,
        timeoutMs: approval.timeoutMs ?? 60_000,
        ...(approval.permissionRules
          ? { permissionRules: approval.permissionRules }
          : {}),
      },
      waiters,
      readSettings: approval.readSettings,
      isBlocked: approval.isBlocked,
    },
    {
      hooks,
      skills,
      publicPlanMode: planMode === 'public',
      memberPlanMode: planMode === 'member',
      ...(planMode === 'public' ? { profile: 'hosted-workspace-files/1' } : {}),
    },
  );
}
const calls = ['read_file', 'edit'].map((name, index) => ({
  name,
  callId: `call-${index}`,
  args: {
    file_path: 'file.txt',
    ...(index ? { old_string: 'a', new_string: 'b' } : {}),
  },
  isClientInitiated: false,
  prompt_id: 'prompt',
}));
const parts: Part[] = calls.map((call) => ({
  functionCall: { id: call.callId, name: call.name, args: call.args },
}));

beforeEach(async () => {
  vi.resetAllMocks();
  broker.capabilityDigest = WORKSPACE_CAPABILITY_DIGEST;
  broker.backgroundProcessStatus.mockResolvedValue({ state: 'unknown' });
  expectWritesStopped = false;
  for (const method of [
    broker.authorizeLifecycle,
    broker.warm,
    broker.resolveCapabilities,
    broker.acquire,
    broker.cancel,
    broker.release,
    broker.releaseMount,
  ])
    method.mockResolvedValue(undefined);
  root = await mkdtemp(path.join(tmpdir(), 'hosted-tool-turn-'));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const definitionRef = await resources.publish(
    'managed-definition',
    Buffer.from('{}'),
  );
  const rootSnapshotRef = await resources.publish(
    'managed-root',
    Buffer.from('{}'),
  );
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
    create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
  });
  broker.fileHistory.mockResolvedValue({
    ownerSessionId: sessionKey.sessionId,
    snapshots: [],
    files: {},
  });
  harness = createManagedHarnessHandle(session);
  await harness.ensureRunnable();
  broker.workspaceContext.mockResolvedValue([]);
  broker.prepare.mockImplementation(async () => randomUUID());
  broker.execute.mockResolvedValue({
    executionStatus: 'success',
    responseParts: [{ text: 'original result' }],
  });
  commit = async (type, messageParts, model, identity) => {
    const uuid = identity?.uuid ?? randomUUID();
    await session.sink.write({
      uuid,
      parentUuid: null,
      sessionId: sessionKey.sessionId,
      timestamp: identity?.timestamp ?? new Date().toISOString(),
      model,
      type,
      cwd: root,
      version: 'test',
      daemonPromptId: 'prompt',
      ...(identity?.clientInitiatedSkills
        ? { clientInitiatedSkills: true }
        : {}),
      message: {
        role: type === 'assistant' ? 'model' : 'user',
        parts: messageParts,
      },
    });
    return uuid;
  };
  messageFitsInline.mockReturnValue(true);
  broker.registerPublisher.mockResolvedValue('1');
  broker.acknowledge.mockResolvedValue(undefined);
  waiters = new HostedApprovalWaiters();
  turn = createTurn();
});
afterEach(async () => {
  // Restores the production default a case closed on purpose.
  enablement.childRun = true;
  enablement.monitorRun = true;
  await turn?.close();
  vi.restoreAllMocks();
  // A Session whose writes stopped cannot record its own close.
  if (expectWritesStopped)
    await expect(session.close()).rejects.toThrow(/writes stopped/);
  else await session?.close();
  await rm(root, { recursive: true, force: true });
});

function contextSlot() {
  return {
    value: undefined as string | undefined,
    read() {
      return this.value;
    },
    write(context: string) {
      this.value = context;
    },
    invalidate() {
      this.value = undefined;
    },
  };
}

it('hands the mount back even when the acquire answer was lost after the grant', async () => {
  broker.acquire.mockRejectedValue(new TypeError('fetch failed'));
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  // The reply loss means no acquired flag — but the Broker may have
  // committed the claim, so the handback still runs under the claim the
  // request carried; the holder-conditioned clear is a no-op when nothing
  // was granted.
  await turn.releaseForRecoveryBlock();
  expect(broker.releaseMount).toHaveBeenCalledOnce();
  expect(broker.releaseMount).toHaveBeenCalledWith('claim-1');
});

it("hands the Hook and MCP lanes' Session-scoped mounts back through their own discipline", async () => {
  const mcpAttempt = vi.fn(async () => undefined);
  const mcpHandback = vi.fn(() => mcpAttempt);
  const mcpTurn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    undefined,
    undefined,
    undefined,
    {
      mcp: {
        broker: { ...broker, runtimeSessionId: 'mcp:session' },
        ensureReady: async () => undefined,
        refresh: async () => undefined,
        tools: () => [],
        toolInput: () => undefined,
        mountHandback: mcpHandback,
      } as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
    },
  );
  await mcpTurn.releaseForRecoveryBlock();
  expect(mcpHandback).toHaveBeenCalledOnce();
  expect(mcpAttempt).toHaveBeenCalledOnce();
  const hookAttempt = vi.fn(async () => undefined);
  const hooksTurn = createTurn(false, undefined, {
    acquire: vi.fn(async () => undefined),
    mountHandback: () => hookAttempt,
  } as unknown as HostedHookSession);
  await hooksTurn.releaseForRecoveryBlock();
  expect(hookAttempt).toHaveBeenCalledOnce();
  // The lanes' Session-scoped mounts never go back through the turn's
  // own per-turn broker.
  expect(broker.releaseMount).not.toHaveBeenCalled();
});

it('keeps an empty Runtime error visible to the model instead of reporting success', async () => {
  broker.execute.mockResolvedValue({
    executionStatus: 'error',
    responseParts: [],
    error: { message: 'file missing' },
  });
  const result = await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(result[0].functionResponse?.response).toMatchObject({
    error: 'file missing',
    executionStatus: 'error',
  });
  expect(result[0].functionResponse?.response).not.toHaveProperty('output');
});

it.each([
  {
    label: 'UTF-8 output',
    result: {
      executionStatus: 'success',
      responseParts: [{ text: '中'.repeat(25_000) }],
    },
  },
  {
    label: 'JSON-escaped output',
    result: {
      executionStatus: 'success',
      responseParts: [{ text: '\\'.repeat(35_000) }],
    },
  },
  {
    label: 'Runtime error',
    result: {
      executionStatus: 'error',
      responseParts: [],
      error: { message: '中'.repeat(25_000) },
    },
  },
  {
    label: 'resident text output',
    resident: true,
    result: {
      executionStatus: 'success',
      responseParts: [{ text: '中'.repeat(25_000) }],
    },
  },
  {
    label: 'PDF pages',
    args: { file_path: 'document.pdf', pages: '1-3' },
    result: {
      executionStatus: 'success',
      responseParts: [{ text: '中'.repeat(25_000) }],
    },
  },
])(
  'persists a small receipt for oversized settled $label',
  async ({ result, args, resident }) => {
    if (resident) {
      broker.capabilityDigest = RESIDENT_WORKSPACE_CAPABILITY_DIGEST;
      turn = createTurn();
    }
    broker.execute.mockResolvedValue(result);
    const publish = vi.spyOn(session.resources, 'publish');
    const call = { ...calls[0], args: args ?? calls[0].args };
    const responses = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    const response = responses[0].functionResponse?.response;
    expect(response?.['outputOmitted']).toBe(true);
    expect(response?.['executionStatus']).toBe(result.executionStatus);
    expect(response?.['error']).toContain('durable Session limit');
    if (resident) {
      expect(response?.['error']).toContain('smaller offset/limit range.');
      expect(response?.['error']).not.toContain('pages');
    } else {
      expect(response?.['error']).toContain('offset/limit range for text');
      expect(response?.['error']).toContain('pages range for PDFs');
    }
    expect(response).not.toHaveProperty('output');
    expect(response).not.toHaveProperty('runtimeError');
    const outcome = publish.mock.calls.find(
      ([kind]) => kind === 'managed-tool-outcome',
    )?.[1];
    expect(outcome?.byteLength).toBeLessThanOrEqual(64 * 1024);
    const receipt = (await session.sink.project()).at(-1);
    expect(receipt?.message?.parts).toEqual(
      JSON.parse(JSON.stringify(responses)),
    );
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(
      64 * 1024,
    );
    await turn.consumeResults();
    await turn.finish();
    expect(broker.execute).toHaveBeenCalledOnce();
    expect(broker.release).toHaveBeenCalledOnce();
  },
);

it.each(['workspace_busy', 'workspace_unavailable'])(
  'allows recovery acquisition to retry after a definite %s refusal',
  async (code) => {
    const refusal = new HostedWorkspaceBrokerRejection(409, code);
    broker.acquire.mockRejectedValueOnce(refusal);
    // Both production callers hand recovery the turn's AbortSignal, so the
    // fast classified refusal has to survive a live signal instead of turning
    // into a queue wait.
    await expect(
      turn.resumeCommittedResults(new AbortController().signal),
    ).rejects.toBe(refusal);
    await expect(turn.finish()).resolves.toBeUndefined();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.release).not.toHaveBeenCalled();
    await turn.resumeCommittedResults(new AbortController().signal);
    expect(broker.acquire).toHaveBeenCalledTimes(2);
  },
);

it.each([
  new Error('lost recovery acquire response'),
  new HostedWorkspaceBrokerRejection(503, 'workspace_unavailable'),
  new HostedWorkspaceBrokerRejection(409, 'runtime_session_acquire_failed'),
])('keeps ambiguous recovery acquisition blocked: %s', async (cause) => {
  broker.acquire.mockRejectedValueOnce(cause);
  await expect(turn.resumeCommittedResults()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.release).not.toHaveBeenCalled();
});

it('allows another attempt after a definite workspace_unavailable acquire refusal', async () => {
  const refusal = new HostedWorkspaceBrokerRejection(
    409,
    'workspace_unavailable',
  );
  broker.acquire.mockRejectedValueOnce(refusal);
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBe(refusal);
  await expect(turn.finish()).resolves.toBeUndefined();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.release).not.toHaveBeenCalled();
  expect(await session.sink.project()).toEqual([]);
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  await turn.consumeResults();
  await turn.finish();
  expect(broker.acquire).toHaveBeenCalledTimes(2);
  expect(broker.release).toHaveBeenCalledOnce();
});

it('queues a definite workspace_busy acquire refusal until the mount frees', async () => {
  const log = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  broker.acquire.mockRejectedValueOnce(
    new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
  );
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  await turn.consumeResults();
  await turn.finish();
  expect(broker.acquire).toHaveBeenCalledTimes(2);
  expect(broker.release).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining(
      'waits for the Workspace mount held by another Session.',
    ),
  );
});

it('keeps polling across repeated workspace_busy refusals until the mount frees', async () => {
  const log = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  broker.acquire
    .mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    )
    .mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    );
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  await turn.consumeResults();
  await turn.finish();
  expect(broker.acquire).toHaveBeenCalledTimes(3);
  expect(broker.release).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledTimes(1);
});

it('cancels a queued workspace_busy acquisition with the turn', async () => {
  const controller = new AbortController();
  broker.acquire.mockImplementation(async () => {
    queueMicrotask(() => controller.abort());
    throw new HostedWorkspaceBrokerRejection(409, 'workspace_busy');
  });
  const rejection = await turn
    .execute(calls, parts, 'model', controller.signal)
    .then(
      () => {
        throw new Error('expected the queued acquisition to reject');
      },
      (cause: unknown) => cause,
    );
  expect(rejection).toBe(controller.signal.reason);
  await expect(turn.finish()).resolves.toBeUndefined();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.release).not.toHaveBeenCalled();
});

it('keeps an ambiguous queued-acquire failure recovery-blocking even when the turn is cancelled', async () => {
  const controller = new AbortController();
  broker.acquire
    .mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    )
    .mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('lost acquire response');
    });
  await expect(
    turn.execute(calls, parts, 'model', controller.signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.release).not.toHaveBeenCalled();
});

it.each([
  new Error('lost acquire response'),
  new HostedWorkspaceBrokerRejection(503, 'workspace_unavailable'),
  new HostedWorkspaceBrokerRejection(409, 'runtime_session_acquire_failed'),
])(
  'retains recovery blocking after ambiguous acquisition: %s',
  async (cause) => {
    broker.acquire.mockRejectedValueOnce(cause);
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.release).not.toHaveBeenCalled();
  },
);

it.each(['x'.repeat(70 * 1024), '中'.repeat(23 * 1024), '"'.repeat(17 * 1024)])(
  'checks the exact serialized argument resource before acquisition (%#)',
  async (content) => {
    const call = {
      ...calls[0],
      name: 'write_file',
      args: { file_path: 'file.txt', content },
    };
    await expect(
      turn.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'model',
        new AbortController().signal,
      ),
    ).rejects.toThrow('inline Session Store limit');
    await expect(turn.finish()).resolves.toBeUndefined();
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
  },
);

it.each(['files', 'shell', 'mcp'])(
  'discloses the %s backup contract without changing shared or MCP tools',
  async (profile) => {
    const remote = { name: 'mcp_write', description: 'Remote server tool.' };
    const mcp = {
      broker,
      ensureReady: async () => undefined,
      refresh: async () => undefined,
      tools: () => [remote],
    };
    const original = structuredClone(HOSTED_WORKSPACE_FILE_TOOLS);
    const originalReadSchema = original[0].parametersJsonSchema as {
      properties: Record<string, unknown>;
    };
    const described = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      profile === 'shell'
        ? {
            resources: session.resources,
            assertWritable: async () => undefined,
          }
        : undefined,
      undefined,
      undefined,
      profile === 'mcp'
        ? {
            mcp: mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
          }
        : undefined,
    );
    const declarations = await described.declarations(
      new AbortController().signal,
    );
    for (const name of ['write_file', 'edit']) {
      const description = declarations.find(
        (tool) => tool.name === name,
      )?.description;
      if (profile === 'mcp') {
        expect(description).toContain('no file backups or undo');
        expect(description).not.toContain('preimages are backed up');
      } else {
        expect(description).toContain('preimages are backed up');
        expect(description).toContain('content or permissions');
        expect(description).toContain('same prompt');
        expect(description).toContain('validate a fresh backup');
      }
    }
    if (profile === 'shell')
      expect(
        declarations.find((tool) => tool.name === 'run_shell_command')
          ?.description,
      ).toContain('Shell file mutations are not backed up');
    else
      expect(
        declarations.find((tool) => tool.name === 'run_shell_command'),
      ).toBeUndefined();
    if (profile === 'mcp') {
      expect(declarations.map((tool) => tool.name)).toEqual([
        'read_file',
        'write_file',
        'edit',
        'web_fetch',
        'mcp_write',
      ]);
      expect(declarations.at(-1)).toEqual(remote);
    }
    expect(declarations.find((tool) => tool.name === 'read_file')).toEqual({
      ...original[0],
      parametersJsonSchema: {
        ...originalReadSchema,
        properties: {
          ...originalReadSchema.properties,
          pages: { type: ['string', 'null'], description: expect.any(String) },
        },
      },
    });
    expect(HOSTED_WORKSPACE_FILE_TOOLS).toEqual(original);
    await described.close();
  },
);

it.each(['refresh', 'warmup'] as const)(
  'aborts MCP %s without waiting for the original work to finish',
  async (phase) => {
    const pending = new Promise<void>(() => undefined);
    const refresh = vi.fn(() =>
      phase === 'refresh' ? pending : Promise.resolve(),
    );
    const mcp = {
      broker: { ...broker, runtimeSessionId: 'mcp:session' },
      ensureReady: () => (phase === 'warmup' ? pending : Promise.resolve()),
      refresh,
      tools: () => [],
    };
    const mcpTurn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      undefined,
      undefined,
      undefined,
      {
        mcp: mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
      },
    );
    const abort = new AbortController();
    const reason = new Error('cancelled test turn');
    const work =
      phase === 'refresh'
        ? mcpTurn.declarations(abort.signal)
        : mcpTurn.execute([], [], 'model', abort.signal);
    const observed = work.catch((cause: unknown) => cause);
    abort.abort(reason);
    await expect(observed).resolves.toBe(reason);
    expect(broker.prepare).not.toHaveBeenCalled();
    await expect(mcpTurn.execute([], [], 'model', abort.signal)).rejects.toBe(
      reason,
    );
  },
);

it('keeps native file tools in the MCP profile on their existing shared runtime', async () => {
  // MCP turns are outside the Workspace-context slice: a slot handed to one
  // must never trigger the read.
  const slot = contextSlot();
  const mcp = {
    broker: { ...broker, runtimeSessionId: 'mcp:session' },
    ensureReady: async () => undefined,
    refresh: async () => undefined,
    tools: () => [],
    toolInput: () => undefined,
  };
  const mcpTurn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    undefined,
    undefined,
    undefined,
    {
      mcp: mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
      context: slot,
    },
  );
  await mcpTurn.execute(calls, parts, 'model', new AbortController().signal);
  await mcpTurn.consumeResults();
  await mcpTurn.finish();
  expect(broker.execute).toHaveBeenCalledTimes(2);
  expect(broker.fileHistory).not.toHaveBeenCalled();
  expect(broker.release).not.toHaveBeenCalled();
  expect(broker.workspaceContext).not.toHaveBeenCalled();
  expect(slot.value).toBeUndefined();
});

it('backs up ordinary file tools on the shared Shell and MCP owner without releasing it at Turn completion', async () => {
  const slot = contextSlot();
  const mcp = {
    broker: { ...broker, runtimeSessionId: 'mcp:session' },
    ensureReady: async () => undefined,
    refresh: async () => undefined,
    tools: () => [{ name: 'mcp_echo', description: 'Fixture MCP tool.' }],
    toolInput: () => undefined,
  };
  const combined = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    { resources: session.resources, assertWritable: async () => undefined },
    undefined,
    undefined,
    {
      mcp: mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
      profile: 'hosted-workspace-shell/1',
      context: slot,
    },
  );
  const declarations = await combined.declarations(
    new AbortController().signal,
  );
  expect(declarations.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      'read_file',
      'write_file',
      'edit',
      'run_shell_command',
      'mcp_echo',
    ]),
  );
  expect(
    declarations.find((tool) => tool.name === 'edit')?.description,
  ).toContain('preimages are backed up');
  await combined.execute(calls, parts, 'model', new AbortController().signal);
  await combined.consumeResults();
  await combined.finish();
  expect(
    broker.fileHistory.mock.calls.map(([operation]) => operation.action),
  ).toEqual(['bind', 'prepare', 'snapshot']);
  expect(await readHostedFileHistory(session)).toMatchObject({
    pendingTurn: null,
    pendingUndo: null,
  });
  expect(broker.release).not.toHaveBeenCalled();
  expect(broker.workspaceContext).toHaveBeenCalledOnce();
});

it('executes against the declarations actually advertised before a catalog replacement', async () => {
  let name = 'mcp_old';
  const input = { toolName: 'managed_mcp_call', input: { pinned: 'original' } };
  const mcp = {
    broker: { ...broker, runtimeSessionId: 'mcp:session' },
    ensureReady: async () => undefined,
    refresh: async () => undefined,
    tools: () => [{ name, parametersJsonSchema: { type: 'object' } }],
    toolInput: vi.fn(() => input),
  };
  const mcpTurn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    async () => randomUUID(),
    () => true,
    undefined,
    undefined,
    undefined,
    {
      mcp: mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
    },
  );
  expect(
    (await mcpTurn.declarations(new AbortController().signal)).at(-1)?.name,
  ).toBe('mcp_old');
  name = 'mcp_new';
  const call = { ...calls[0], name: 'mcp_old', args: { text: 'hello' } };
  await mcpTurn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(broker.execute).toHaveBeenCalledWith(
    expect.any(String),
    JSON.stringify(input),
    expect.any(AbortSignal),
    630_000,
    true,
  );
  expect(broker.prepare).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringMatching(/^sha256:/u),
    undefined,
    'prompt',
  );
  expect(mcp.toolInput).toHaveBeenCalledWith(
    call.name,
    call.args,
    broker.prepare.mock.calls[0][0],
  );
  const intent = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .find((event) => event.kind === 'tool.intent');
  const saved = await session.resources.read(
    intent!.payload['toolDefinitionRef'] as unknown as ManagedSessionDurableRef,
  );
  expect(JSON.parse(saved.toString()).name).toBe('mcp_old');
  expect(
    (await mcpTurn.declarations(new AbortController().signal)).at(-1)?.name,
  ).toBe('mcp_new');
});
it('returns durable errors for a refused Shell batch and permits a corrected call', async () => {
  turn = createTurn(true);
  const shell = {
    ...calls[0],
    callId: 'background',
    name: 'run_shell_command',
    args: { command: 'sleep 2', is_background: true },
  };
  const batch = [calls[0], shell];
  const responses = await turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  expect(responses.map((part) => part.functionResponse?.id)).toEqual([
    calls[0].callId,
    shell.callId,
  ]);
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'not executed',
  );
  expect(responses[1].functionResponse?.response?.['error']).toContain(
    'foreground',
  );
  expect((await session.sink.project()).map((record) => record.type)).toEqual([
    'assistant',
    'tool_result',
  ]);
  expect((await session.sink.project()).at(-1)?.message?.parts).toEqual(
    JSON.parse(JSON.stringify(responses)),
  );
  expect(broker.acquire).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(broker.registerPublisher).not.toHaveBeenCalled();
  await turn.consumeResults();
  const corrected = { ...shell, args: { command: 'printf hello' } };
  broker.execute.mockResolvedValue({
    executionStatus: 'not_started',
    responseParts: [],
    error: { message: 'command validation failed' },
    capture: null,
  });
  await turn.execute(
    [corrected],
    [
      {
        functionCall: {
          id: corrected.callId,
          name: corrected.name,
          args: corrected.args,
        },
      },
    ],
    'model',
    new AbortController().signal,
  );
  await turn.consumeResults();
  await turn.finish();
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual({
    command: 'printf hello',
    is_background: false,
  });
  expect(broker.release).toHaveBeenCalledOnce();
});

it.each([
  [{ command: '' }, 'nonempty command'],
  [{ command: 'pwd', extra: true }, 'unsupported argument "extra"'],
  [{ command: 'pwd', description: 7 }, 'description must be a string'],
  [{ command: 'pwd', timeout: 0 }, 'timeout must be an integer'],
])('reports the invalid Shell argument %j', async (args, message) => {
  turn = createTurn(true);
  const call = { ...calls[0], name: 'run_shell_command', args };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args } }],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toContain(message);
  expect(broker.acquire).not.toHaveBeenCalled();
});

it.each([
  [{ command: 'pwd', timeout: 0 }, 'timeout must be an integer'],
  [{ command: 'pwd', is_background: false }, 'foreground command'],
])(
  'returns a durable O2 refusal for invalid Shell arguments %j',
  async (args, message) => {
    const owner = {
      owner: vi.fn(),
      request: vi.fn(),
      rememberAdmission: vi.fn(),
    } as unknown as HttpToolPublicationOwner;
    turn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      { owner, captureBytes: 1024 * 1024 },
    );
    const call = { ...calls[0], name: 'run_shell_command', args };
    const responses = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args } }],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toContain(
      message,
    );
    expect((await session.sink.project()).map((record) => record.type)).toEqual(
      ['assistant', 'tool_result'],
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepareV3).not.toHaveBeenCalled();
    expect(owner.request).not.toHaveBeenCalled();
  },
);

it('accepts the runtime foreground spelling is_background false', async () => {
  turn = createTurn(true);
  broker.execute.mockResolvedValue({
    executionStatus: 'not_started',
    responseParts: [],
    error: { message: 'command validation failed' },
    capture: null,
  });
  const args = { command: 'pwd', is_background: 'FaLsE' };
  const call = { ...calls[0], name: 'run_shell_command', args };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args } }],
    'model',
    new AbortController().signal,
  );
  expect(broker.prepare).toHaveBeenCalledOnce();
  expect(JSON.parse(broker.execute.mock.calls[0][1])).toEqual({
    toolName: 'run_shell_command',
    input: { command: 'pwd', is_background: false },
  });
});

it('registers a foreground shell capture under the mapped Runtime identity', async () => {
  // The wake-turn shape: the logical prompt id carries a colon, and the
  // Broker reports a different Runtime identity (this double reports
  // 'prompt'). The publisher's foreground guard compares the reference
  // identity; a raw-id third register argument would throw here.
  turn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'arun_x:input',
    commit,
    messageFitsInline,
    { resources: session.resources, assertWritable: async () => undefined },
  );
  broker.prepare.mockResolvedValue('execution-shell');
  const manifest = await session.resources.publish(
    'managed-tool-result-manifest',
    Buffer.from('{}'),
  );
  const capture = {
    captureStatus: 'complete' as const,
    captureReason: null,
    manifest,
    previewTruncated: false,
    deliveryStatus: 'committed' as const,
  };
  broker.execute.mockResolvedValue({
    executionStatus: 'success',
    responseParts: [{ text: 'hi' }],
    capture,
  });
  const outcomeRef = await session.resources.publish(
    'managed-tool-outcome',
    Buffer.from('{}'),
  );
  vi.spyOn(HostedShellPublisher.prototype, 'receipt').mockResolvedValue({
    executionCallId: 'execution-shell',
    manifest,
    deliveryStatus: 'committed',
    historyRevision: 1,
    outcomeRef,
  });
  const register = vi.spyOn(HostedShellPublisher.prototype, 'register');
  const args = { command: 'pwd', is_background: false };
  const call = { ...calls[0], name: 'run_shell_command', args };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args } }],
    'model',
    new AbortController().signal,
  );
  expect(register).toHaveBeenCalledOnce();
  // One pair, two axes: the mapped Runtime Session against the execution,
  // the logical prompt id against the checkpoint's identity. A mapped
  // promptId here is refused by the store, and the wake Shell's execution
  // goes unknown.
  expect(register.mock.calls[0]?.[0]).toMatchObject({
    reference: { sessionId: 'prompt', promptId: 'arun_x:input' },
  });
  expect(responses[0]?.functionResponse?.response?.['error']).toBeUndefined();
});

it('blocks recovery if the durable refusal cannot be committed', async () => {
  const original = commit;
  commit = async (...args) => {
    if (args[0] === 'tool_result') throw new Error('history write failed');
    return original(...args);
  };
  turn = createTurn(true);
  const call = {
    ...calls[0],
    name: 'run_shell_command',
    args: { command: 'x', is_background: true },
  };
  await expect(
    turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.acquire).not.toHaveBeenCalled();
});

it.each(['assistant', 'tool_result'] as const)(
  'blocks recovery when a file_path refusal %s commit fails',
  async (failedType) => {
    const original = commit;
    commit = async (...args) => {
      if (args[0] === failedType) throw new Error('history write failed');
      return original(...args);
    };
    turn = createTurn();
    const invalid = {
      ...calls[0],
      args: { file_path: '/private/secret-host-path' },
    };
    await expect(
      turn.execute(
        [invalid],
        [
          {
            functionCall: {
              id: invalid.callId,
              name: invalid.name,
              args: invalid.args,
            },
          },
        ],
        'model',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it('keeps an acquired Workspace held when a later file_path refusal cannot commit', async () => {
  const original = commit;
  let toolResultCommits = 0;
  commit = async (...args) => {
    if (args[0] === 'tool_result' && ++toolResultCommits === 2)
      throw new Error('history write failed');
    return original(...args);
  };
  turn = createTurn();
  await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  await turn.consumeResults();
  const invalid = {
    ...calls[0],
    args: { file_path: '/private/secret-host-path' },
  };
  await expect(
    turn.execute(
      [invalid],
      [
        {
          functionCall: {
            id: invalid.callId,
            name: invalid.name,
            args: invalid.args,
          },
        },
      ],
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.acquire).toHaveBeenCalledOnce();
  expect(broker.release).not.toHaveBeenCalled();
});

it.each([false, true])(
  'preserves the admitted Shell outcome when history rejects it: %s',
  async (rejectHistory) => {
    turn = createTurn(true);
    broker.prepare.mockResolvedValue('execution-shell');
    const manifest = await session.resources.publish(
      'managed-tool-result-manifest',
      Buffer.from('{}'),
    );
    const envelope = {
      executionStatus: 'error',
      responseParts: boundedShellPreview([
        { text: '\u0001'.repeat(70_000) + '\nBUILD FAILED\nExit Code: 3' },
      ]),
      error: { message: 'exit 3' },
      capture: {
        captureStatus: 'complete',
        captureReason: null,
        manifest,
        previewTruncated: true,
        deliveryStatus: 'committed',
      },
    };
    const outcomeRef = await session.resources.publish(
      'managed-tool-outcome',
      Buffer.from(JSON.stringify({ envelope })),
    );
    const receipt = {
      executionCallId: 'execution-shell',
      manifest,
      deliveryStatus: 'committed' as const,
      historyRevision: 1,
      outcomeRef,
    };
    vi.spyOn(HostedShellPublisher.prototype, 'receipt').mockResolvedValue(
      receipt,
    );
    broker.execute.mockResolvedValue(envelope);
    const resolve = vi.spyOn(harness, 'resolveAwaitRuntime');
    const publish = vi.spyOn(session.resources, 'publish');
    messageFitsInline.mockImplementation(
      (type, content) =>
        type !== 'tool_result' ||
        !rejectHistory ||
        !content.some((part) => part.functionResponse?.response?.['capture']),
    );
    const call = {
      ...calls[0],
      name: 'run_shell_command',
      args: { command: 'sh build.sh' },
    };
    const result = turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    if (rejectHistory) {
      await expect(result).rejects.toMatchObject({
        cause: {
          message:
            'Admitted Shell result exceeds the inline Session Store limit.',
        },
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(broker.acknowledge).not.toHaveBeenCalled();
      expect(
        (await session.sink.project()).filter(
          (record) => record.type === 'tool_result',
        ),
      ).toEqual([]);
      await expect(turn.finish()).rejects.toBeInstanceOf(
        HostedToolRecoveryRequiredError,
      );
    } else {
      const responses = await result;
      expect(JSON.stringify(responses)).toContain('BUILD FAILED');
      expect(JSON.stringify(responses)).toContain('Exit Code: 3');
      expect(responses[0].functionResponse?.response?.['capture']).toEqual(
        envelope.capture,
      );
      expect(responses[0].functionResponse?.response).not.toHaveProperty(
        'outputOmitted',
      );
      expect(
        Buffer.byteLength(
          JSON.stringify((await session.sink.project()).at(-1)),
        ),
      ).toBeLessThan(64 * 1024);
      expect(resolve).toHaveBeenCalledWith('execution-shell', outcomeRef);
      expect(broker.acknowledge).toHaveBeenCalledWith(
        'execution-shell',
        receipt,
      );
      await turn.consumeResults();
      await turn.finish();
    }
    expect(
      publish.mock.calls.some(([kind]) => kind === 'managed-tool-outcome'),
    ).toBe(false);
  },
);

const answer = (optionId: string, extra: Record<string, unknown> = {}) => ({
  optionId,
  inputRevision: 1,
  policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
  ...extra,
});

function actionIds(): string[] {
  return [
    ...new Set(
      session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'action.changed')
        .map((event) => event.payload['requestId'] as string),
    ),
  ];
}

// requested() polls the Turn's sequential fsynced durable writes (options
// publish, action request, durable-wait checkpoint). A fixed budget for that
// chain flaked on the shared pool (#13397, #15093), so budget it through the
// slow-host policy. The budget is per wait, so the two tests that call
// requested() twice need 2 x 20 s < 60 s on the ecs-qwen pool; the other
// slow-host arm keeps 3 s of headroom under its 15 s ceiling so a hang still
// fails on the assertion rather than as a bare runner timeout. The autofix
// verification gate strips RUNNER_NAME and passes --testTimeout=60000, so
// this lands at 12 s there; closing that needs a gate sentinel, not a local
// change.
function requestedWaitBudgetMs(
  slowHost: boolean,
  runnerName: string | undefined,
): number {
  if (!slowHost) return 10_000;
  const ceiling = runnerName?.startsWith('ecs-qwen-') ? 60_000 : 15_000;
  return Math.min(20_000, ceiling - 3_000);
}

const SLOW_HOST = isSlowTestHost();
const BUDGET_RUNNER_NAME = process.env['RUNNER_NAME'];
const REQUESTED_TIMEOUT_MS = requestedWaitBudgetMs(
  SLOW_HOST,
  BUDGET_RUNNER_NAME,
);

it('keeps the requested() wait budget under the per-test ceiling', () => {
  expect(requestedWaitBudgetMs(true, 'ecs-qwen-64c-01')).toBe(20_000);
  expect(requestedWaitBudgetMs(true, 'ubuntu-latest')).toBe(12_000);
  expect(requestedWaitBudgetMs(true, undefined)).toBe(12_000);
  expect(requestedWaitBudgetMs(false, undefined)).toBe(10_000);
  expect(requestedWaitBudgetMs(true, 'ecs-qwen-64c-01') * 2).toBeLessThan(
    60_000,
  );
});

it('passes REQUESTED_TIMEOUT_MS to the requested() wait', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const waitFor = vi.spyOn(vi, 'waitFor');
  try {
    const requestId = await requested();
    expect(waitFor.mock.calls.at(-1)?.[1]).toEqual({
      timeout: requestedWaitBudgetMs(SLOW_HOST, BUDGET_RUNNER_NAME),
    });
    await resolveHostedAction(session, waiters, requestId, answer('deny'));
  } finally {
    waitFor.mockRestore();
  }
  await running;
});

async function requested(count = 1): Promise<string> {
  let requestId = '';
  // The Action request commits first and its await_action checkpoint after
  // it, each behind fsynced durable writes.
  await vi.waitFor(
    async () => {
      const ids = actionIds();
      expect(ids).toHaveLength(count);
      requestId = ids.at(-1)!;
      expect(session.authority.action(requestId)?.state).toBe('requested');
      expect((await checkpoint()).continuation.phase).toBe('await_action');
    },
    { timeout: REQUESTED_TIMEOUT_MS },
  );
  return requestId;
}

async function checkpoint() {
  const authorization = await session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') throw new Error('No checkpoint');
  return authorization.checkpoint;
}

async function toolResults() {
  return (await session.sink.project())
    .filter((record) => record.type === 'tool_result')
    .map((record) =>
      record.message?.parts?.map((part) => part.functionResponse?.id),
    );
}

async function toolResultErrors() {
  return (await session.sink.project())
    .filter((record) => record.type === 'tool_result')
    .flatMap((record) => record.message?.parts ?? [])
    .map((part) => part.functionResponse?.response?.['error']);
}

it('evaluates the actual rewritten WebFetch destination before Full Access dispatch', async () => {
  turn = createTurn(false, {
    mode: 'yolo',
    permissionRules: {
      allow: [],
      ask: [],
      deny: ['WebFetch(domain:raw.githubusercontent.com)'],
    },
  });
  const call = {
    ...calls[0],
    name: 'web_fetch',
    args: {
      url: 'https://github.com/QwenLM/qwen-code/blob/main/README.md',
      prompt: 'Read',
    },
  };
  const result = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(JSON.stringify(result)).toContain('permission rules denied');
  expect(broker.execute).not.toHaveBeenCalled();
});

it.each(['default', 'auto-edit', 'auto', 'yolo'] as const)(
  'honors an explicit deny before mode %s and does not run the classifier',
  async (mode) => {
    turn = createTurn(false, {
      mode,
      permissionRules: { allow: ['Edit'], ask: ['Edit'], deny: ['Edit'] },
    });
    const classify = vi.fn();
    turn.setPermissionClassifier(classify);
    const result = await turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      new AbortController().signal,
    );
    expect(JSON.stringify(result)).toContain('permission rules denied');
    expect(broker.execute).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(actionIds()).toEqual([]);
  },
);

it('does not dispatch when cancellation arrives during auto classification', async () => {
  turn = createTurn(false, { mode: 'auto' });
  const abort = new AbortController();
  turn.setPermissionClassifier(async () => {
    abort.abort();
    return {
      shouldBlock: false,
      reason: '',
      model: 'classifier',
      stage: 'fast',
      durationMs: 1,
    };
  });
  await expect(
    turn.execute([calls[1]], [parts[1]], 'model', abort.signal),
  ).rejects.toThrow();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('keeps an explicit ask human-only when live mode changes to Full Access', async () => {
  let mode: HostedApprovalMode = 'auto';
  const permissionRules = { allow: ['Edit'], ask: ['Edit'], deny: [] };
  turn = createTurn(false, {
    mode,
    permissionRules,
    readSettings: async () => ({ mode, timeoutMs: 60_000, permissionRules }),
  });
  const classify = vi.fn();
  turn.setPermissionClassifier(classify);
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const options = JSON.parse(
    (
      await session.resources.read(
        session.authority.action(requestId)!.optionsRef!,
      )
    ).toString(),
  );
  expect(options.requiresHumanDecision).toBe(true);
  mode = 'yolo';
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(session.authority.action(requestId)?.state).toBe('requested');
  expect(broker.execute).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  await running;
});

it.each(['allow', 'block', 'unavailable', 'absent'] as const)(
  'handles auto classifier %s through native execution or durable approval',
  async (outcome) => {
    turn = createTurn(false, { mode: 'auto' });
    const classify = vi.fn().mockResolvedValue({
      shouldBlock: outcome !== 'allow',
      reason: 'policy refusal',
      model: 'classifier',
      stage: 'fast',
      durationMs: 1,
      ...(outcome === 'unavailable' ? { unavailable: true } : {}),
    });
    if (outcome !== 'absent') turn.setPermissionClassifier(classify);
    const running = turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      new AbortController().signal,
    );
    if (outcome === 'unavailable' || outcome === 'absent') {
      const requestId = await requested();
      expect(broker.execute).not.toHaveBeenCalled();
      await resolveHostedAction(session, waiters, requestId, answer('allow'));
    }
    const result = await running;
    expect(broker.execute).toHaveBeenCalledTimes(outcome === 'block' ? 0 : 1);
    if (outcome === 'block')
      expect(JSON.stringify(result)).toContain('Auto approval blocked');
    expect(classify).toHaveBeenCalledTimes(outcome === 'absent' ? 0 : 1);
  },
);

it.each(['auto-edit', 'yolo'] as const)(
  'durably allows a pending ordinary edit after changing to %s in the current Turn',
  async (mode) => {
    let selected: HostedApprovalMode = 'default';
    const readSettings = vi.fn(async () => ({
      mode: selected,
      timeoutMs: 60_000,
    }));
    turn = createTurn(false, { mode: 'default', readSettings });
    const running = turn.execute(
      calls,
      parts,
      'model',
      new AbortController().signal,
    );
    const requestId = await requested();
    expect(broker.execute).not.toHaveBeenCalled();
    selected = mode;
    const result = await running;
    expect(
      result.map((part) => part.functionResponse?.response?.['error']),
    ).toEqual([undefined, undefined]);
    expect(
      hostedActionAllowed(
        session.authority.action(requestId)!,
        HOSTED_TOOL_APPROVAL_POLICY,
      ),
    ).toBe(true);
    expect(broker.execute).toHaveBeenCalledTimes(2);
    expect(actionIds()).toEqual([requestId]);
  },
);

it('applies a live downgrade before a subsequent tool in the same Turn', async () => {
  let selected: HostedApprovalMode = 'yolo';
  turn = createTurn(false, {
    mode: 'yolo',
    readSettings: async () => ({ mode: selected, timeoutMs: 60_000 }),
  });
  await turn.execute(
    [calls[0]!],
    [parts[0]!],
    'model',
    new AbortController().signal,
  );
  selected = 'default';
  const running = turn.execute(
    [calls[1]!],
    [parts[1]!],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  expect(broker.execute).toHaveBeenCalledTimes(1);
  await resolveHostedAction(session, waiters, requestId, answer('allow'));
  await running;
  expect(broker.execute).toHaveBeenCalledTimes(2);
});

it('stops new tool admission when a live policy read fails even from Full Access', async () => {
  turn = createTurn(false, {
    mode: 'yolo',
    readSettings: async () => {
      throw new Error('writer fenced');
    },
  });
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
});

it('stops a pending approval when the live policy can no longer be read', async () => {
  let unavailable = false;
  turn = createTurn(false, {
    mode: 'default',
    readSettings: async () => {
      if (unavailable) throw new Error('writer fenced');
      return { mode: 'default', timeoutMs: 60_000 };
    },
  });
  const running = turn.execute(
    calls,
    parts,
    'model',
    new AbortController().signal,
  );
  await requested();
  unavailable = true;
  await expect(running).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
});

it('keeps a denial that wins while a live policy poll is in flight', async () => {
  let poll = false;
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  turn = createTurn(false, {
    mode: 'default',
    readSettings: async () => {
      if (poll) {
        entered = true;
        await gate;
      }
      return { mode: poll ? 'yolo' : 'default', timeoutMs: 60_000 };
    },
  });
  const running = turn.execute(
    [calls[1]!],
    [parts[1]!],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  poll = true;
  await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5_000 });
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  release();
  const result = await running;
  expect(JSON.stringify(result)).toContain('denied');
  expect(
    hostedActionAllowed(
      session.authority.action(requestId)!,
      HOSTED_TOOL_APPROVAL_POLICY,
    ),
  ).toBe(false);
  expect(broker.execute).not.toHaveBeenCalled();
});

it('does not resolve a pending Action when recovery blocks during the policy read', async () => {
  let poll = false;
  let entered = false;
  let blocked = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  turn = createTurn(false, {
    mode: 'default',
    isBlocked: () => blocked,
    readSettings: async () => {
      if (poll) {
        entered = true;
        await gate;
      }
      return { mode: poll ? 'yolo' : 'default', timeoutMs: 60_000 };
    },
  });
  const running = turn.execute(
    [calls[1]!],
    [parts[1]!],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  poll = true;
  await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5_000 });
  blocked = true;
  release();
  await expect(running).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(session.authority.action(requestId)?.state).toBe('requested');
  expect(broker.execute).not.toHaveBeenCalled();
});

it('keeps an explicit Hook ask pending under a live Full Access selection', async () => {
  const controller = new AbortController();
  const fire = vi.fn<HostedHookSession['fire']>(async (event) =>
    event === HookEventName.PreToolUse
      ? {
          hookSpecificOutput: {
            hookEventName: event,
            permissionDecision: 'ask',
          },
        }
      : undefined,
  );
  turn = createTurn(
    false,
    {
      mode: 'default',
      readSettings: async () => ({ mode: 'yolo', timeoutMs: 60_000 }),
    },
    hookSession(fire),
  );
  const running = turn.execute(
    [calls[1]!],
    [parts[1]!],
    'model',
    controller.signal,
  );
  const requestId = await requested();
  expect(
    fire.mock.calls.find(([event]) => event === HookEventName.PreToolUse)?.[2],
  ).toMatchObject({ permission_mode: 'yolo' });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(session.authority.action(requestId)?.state).toBe('requested');
  expect(broker.execute).not.toHaveBeenCalled();
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  const result = await running;
  expect(JSON.stringify(result)).toContain('denied');
  expect(broker.execute).not.toHaveBeenCalled();
});

it('asks before an edit in default mode and runs the batch once the owner allows', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const started = Date.now();
  const running = turn.execute(
    calls,
    parts,
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  expect(requestId).toMatch(/^tool_approval_[0-9a-f]{32}$/u);
  expect((await checkpoint()).identity).toMatchObject({
    turnId: 'prompt',
    promptId: 'prompt',
  });
  expect(broker.prepare).not.toHaveBeenCalled();
  expect((await session.sink.project()).map((record) => record.type)).toEqual([
    'assistant',
  ]);
  const action = session.authority.action(requestId)!;
  expect(action).toMatchObject({
    kind: 'permission',
    source: 'tool_call',
    inputRevision: 1,
  });
  const options = JSON.parse(
    (await session.resources.read(action.optionsRef!)).toString(),
  );
  expect(options).toEqual({
    v: 2,
    inputRef: (await checkpoint()).approval!.invocationRef,
    requestId,
    turnId: 'prompt',
    functionCallId: 'call-1',
    toolName: 'edit',
    policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
    inputRevision: 1,
    createdAt: expect.any(Number),
    expiresAt: expect.any(Number),
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ],
  });
  expect(options.createdAt).toBeGreaterThanOrEqual(started);
  expect(options.expiresAt - options.createdAt).toBe(60_000);
  const invocationRef = (await checkpoint()).approval?.invocationRef;

  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  });
  const responses = await running;
  expect(
    responses.map((part) => part.functionResponse?.response?.['error']),
  ).toEqual([undefined, undefined]);
  expect(broker.execute).toHaveBeenCalledTimes(2);
  expect(actionIds()).toEqual([requestId]);
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.intent')
      .map((event) => event.payload['argsRef']),
  ).toContainEqual(invocationRef);
  expect((await checkpoint()).continuation.phase).toBe('results_ready');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  });
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('deny')),
  ).resolves.toEqual({ status: 409, code: 'action_already_resolved' });
  await turn.consumeResults();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('refuses a denied call in the model order and still runs the rest', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1], calls[0]],
    [parts[1], parts[0]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('deny')),
  ).resolves.toMatchObject({ status: 200 });
  const responses = await running;
  expect(broker.prepare).toHaveBeenCalledOnce();
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(responses.map((part) => part.functionResponse?.id)).toEqual([
    'call-1',
    'call-0',
  ]);
  expect(responses[0].functionResponse?.response).toEqual({
    error: 'The Session owner denied this tool call, so it was not run.',
  });
  expect(responses[1].functionResponse?.response?.['executionStatus']).toBe(
    'success',
  );
  expect(await toolResults()).toEqual([['call-1'], ['call-0']]);
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('deny')),
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'deny' },
  });
  expect(
    (await checkpoint()).tools?.items.map((item) => item.functionCallId),
  ).toEqual(['call-0']);
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.intent'),
  ).toHaveLength(1);
});

it('commits only refusals when every asked call is denied', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  const responses = await running;
  expect(responses).toHaveLength(1);
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'denied',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(await toolResults()).toEqual([['call-1']]);
  expect((await checkpoint()).continuation.phase).toBe(
    'model_output_committed',
  );
  await turn.consumeResults();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it.each(['allow', 'deny'])(
  'honors %s approval for an MCP call while retaining its shared owner',
  async (optionId) => {
    const input = {
      toolName: 'managed_mcp_call',
      input: { pinned: 'original' },
    };
    let expiresAt = 1;
    const mcp = {
      broker,
      ensureReady: async () => undefined,
      refresh: async () => undefined,
      tools: () => [
        { name: 'mcp_echo', parametersJsonSchema: { type: 'object' } },
      ],
      toolInput: () => ({
        ...input,
        input: { ...input.input, grant: { expiresAt } },
      }),
    };
    turn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      undefined,
      undefined,
      { settings: { mode: 'default', timeoutMs: 60_000 }, waiters },
      {
        mcp: mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
      },
    );
    const call = { ...calls[0], name: 'mcp_echo', args: { text: 'hello' } };
    const running = turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    const requestId = await requested();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    const options = JSON.parse(
      (
        await session.resources.read(
          session.authority.action(requestId)!.optionsRef!,
        )
      ).toString(),
    );
    expect(options.v).toBe(1);
    expect(options).not.toHaveProperty('inputRef');
    const approvedRef = (await checkpoint()).approval!.invocationRef!;
    const approved = (await session.resources.read(approvedRef)).toString();
    expiresAt = 2;
    await resolveHostedAction(session, waiters, requestId, answer(optionId));
    const result = await running;
    expect(broker.prepare).toHaveBeenCalledTimes(optionId === 'allow' ? 1 : 0);
    expect(broker.execute).toHaveBeenCalledTimes(optionId === 'allow' ? 1 : 0);
    if (optionId === 'allow') {
      const payload = broker.execute.mock.calls[0][1];
      expect(JSON.parse(payload)).toEqual({
        ...input,
        input: { ...input.input, grant: { expiresAt: 2 } },
      });
      expect(broker.prepare.mock.calls[0][1]).toBe(
        `sha256:${createHash('sha256').update(payload).digest('hex')}`,
      );
      const intent = session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .find((event) => event.kind === 'tool.intent')!;
      const routed = JSON.parse(
        (
          await session.resources.read(
            intent.payload['argsRef'] as unknown as ManagedSessionDurableRef,
          )
        ).toString(),
      );
      expect(routed.payloadJson).toBe(payload);
      expect((await session.resources.read(approvedRef)).toString()).toBe(
        approved,
      );
    } else
      expect(result[0].functionResponse?.response?.['error']).toContain(
        'denied',
      );
    await turn.consumeResults();
    await turn.finish();
    expect(broker.release).not.toHaveBeenCalled();
  },
);

it('binds successive approvals for the same tool to their own inputs', async () => {
  const batch = [
    {
      ...calls[1],
      name: 'write_file',
      callId: 'call-0',
      args: { file_path: 'new.txt', content: 'new' },
    },
    {
      ...calls[1],
      name: 'write_file',
      args: { file_path: 'second.txt', content: 'second' },
    },
  ];
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  const first = await requested(1);
  expect(actionIds()).toEqual([first]);
  const firstOptions = JSON.parse(
    (
      await session.resources.read(session.authority.action(first)!.optionsRef!)
    ).toString(),
  );
  expect(firstOptions.inputRef).toEqual(
    (await checkpoint()).approval!.invocationRef,
  );
  await resolveHostedAction(session, waiters, first, answer('allow'));
  const second = await requested(2);
  const options = JSON.parse(
    (
      await session.resources.read(
        session.authority.action(second)!.optionsRef!,
      )
    ).toString(),
  );
  expect(options).toMatchObject({
    v: 2,
    functionCallId: 'call-1',
    toolName: 'write_file',
    inputRef: (await checkpoint()).approval!.invocationRef,
  });
  expect(options.inputRef).not.toEqual(firstOptions.inputRef);
  for (const [ref, input] of [
    [firstOptions.inputRef, batch[0].args],
    [options.inputRef, batch[1].args],
  ] as const) {
    const captured = JSON.parse((await session.resources.read(ref)).toString());
    expect(JSON.parse(captured.payloadJson)).toEqual({
      toolName: 'write_file',
      input,
    });
  }
  await resolveHostedAction(session, waiters, second, answer('deny'));
  const responses = await running;
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(
    responses.map((part) => !!part.functionResponse?.response?.['error']),
  ).toEqual([false, true]);
});

it.each(['yolo', 'auto-edit'] as const)(
  'does not ask before file calls in %s mode',
  async (mode) => {
    turn = createTurn(false, { mode });
    await turn.execute(calls, parts, 'model', new AbortController().signal);
    expect(actionIds()).toEqual([]);
    expect(broker.execute).toHaveBeenCalledTimes(2);
  },
);

it('refuses a call whose approval expires unanswered', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 1_000 });
  const responses = await turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const [requestId] = actionIds();
  expect(session.authority.action(requestId)?.state).toBe('expired');
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'expired',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
  const publish = vi.spyOn(session.resources, 'publish');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'action_expired' });
  expect(publish).not.toHaveBeenCalled();
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => true,
    ),
  ).resolves.toEqual({ status: 409, code: 'action_expired' });
});

it('expires an approval that is answered after its expiry', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const late = Date.now() + 60_000;
  const now = vi.spyOn(Date, 'now').mockReturnValue(late);
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'action_expired' });
  now.mockRestore();
  const responses = await running;
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'expired',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('cancels a waiting approval and refuses every call when the turn aborts', async () => {
  turn = createTurn(false, { mode: 'default' });
  const controller = new AbortController();
  const running = turn.execute(calls, parts, 'model', controller.signal);
  const requestId = await requested();
  controller.abort(new Error('turn cancelled'));
  await expect(running).rejects.toThrow('turn cancelled');
  expect(session.authority.action(requestId)?.state).toBe('cancelled');
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(await toolResults()).toEqual([['call-0', 'call-1']]);
  expect((await checkpoint()).continuation.phase).toBe(
    'model_output_committed',
  );
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'action_cancelled' });
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => true,
    ),
  ).resolves.toEqual({ status: 409, code: 'action_cancelled' });
});

it('refuses an Action response that does not match the request', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  for (const id of ['tool_approval_' + '0'.repeat(32), 'call-1'])
    await expect(
      resolveHostedAction(session, waiters, id, answer('allow')),
    ).resolves.toEqual({ status: 404, code: 'action_not_found' });
  for (const body of [
    answer('maybe'),
    answer('allow', { inputRevision: 2 }),
    answer('allow', { policyRevision: 'preapproved-workspace-tools/1' }),
    answer('allow', { note: 'extra' }),
    { optionId: 'allow' },
    null,
    ['allow'],
  ])
    await expect(
      resolveHostedAction(session, waiters, requestId, body),
    ).resolves.toEqual({ status: 400, code: 'invalid_action_response' });
  expect(session.authority.action(requestId)?.state).toBe('requested');
  await resolveHostedAction(session, waiters, requestId, answer('allow'));
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('keeps an answer retryable when it fails before any write', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  vi.spyOn(session.resources, 'read').mockRejectedValueOnce(
    new Error('store unavailable'),
  );
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).rejects.toThrow('store unavailable');
  now.mockRestore();
  expect(session.authority.writesStopped).toBe(false);
  expect(session.authority.action(requestId)?.state).toBe('requested');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toMatchObject({ status: 200 });
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('stops the Turn when a late answer cannot record the expiry', async () => {
  expectWritesStopped = true;
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  vi.spyOn(
    LocalJsonlManagedSessionJournalHandle.prototype,
    'appendTransaction',
  ).mockRejectedValueOnce(new Error('journal down'));
  const notify = vi.spyOn(waiters, 'notify');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({
    status: 409,
    code: 'hosted_turn_recovery_required',
    reason: 'writes_stopped',
  });
  expect(notify).toHaveBeenCalledWith(requestId);
  expect(session.authority.writesStopped).toBe(true);
  await expect(running).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.prepare).not.toHaveBeenCalled();
  // Still late and still requested: the answer must not try to write.
  expect(session.authority.action(requestId)?.state).toBe('requested');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({
    status: 409,
    code: 'hosted_turn_recovery_required',
    reason: 'writes_stopped',
  });
  now.mockRestore();
});

it('stops a waiting Turn soon after another write stops the Session', async () => {
  expectWritesStopped = true;
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  await requested();
  vi.spyOn(
    LocalJsonlManagedSessionJournalHandle.prototype,
    'appendTransaction',
  ).mockRejectedValueOnce(new Error('journal down'));
  await expect(
    commit('assistant', [{ text: 'title' }], 'model'),
  ).rejects.toThrow('journal down');
  const started = Date.now();
  await expect(running).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('answers what a blocked Session already recorded but writes nothing', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const batch = [
    {
      ...calls[1],
      name: 'write_file',
      callId: 'call-0',
      args: { file_path: 'new.txt', content: 'new' },
    },
    calls[1],
  ];
  const running = turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  const decided = await requested(1);
  await resolveHostedAction(session, waiters, decided, answer('allow'));
  const waiting = await requested(2);
  await expect(
    resolveHostedAction(session, waiters, decided, answer('allow'), () => true),
  ).resolves.toMatchObject({ status: 200 });
  await expect(
    resolveHostedAction(session, waiters, decided, answer('deny'), () => true),
  ).resolves.toEqual({ status: 409, code: 'action_already_resolved' });
  const publish = vi.spyOn(session.resources, 'publish');
  await expect(
    resolveHostedAction(session, waiters, waiting, answer('allow'), () => true),
  ).resolves.toEqual({
    status: 409,
    code: 'hosted_turn_recovery_required',
    reason: 'turn_blocked',
  });
  expect(publish).not.toHaveBeenCalled();
  expect(session.authority.action(waiting)?.state).toBe('requested');
  await resolveHostedAction(session, waiters, waiting, answer('deny'));
  await running;
});

it('stops asking once an approval in the Turn has expired', async () => {
  const batch = [
    {
      ...calls[1],
      name: 'write_file',
      callId: 'call-0',
      args: { file_path: 'new.txt', content: 'new' },
    },
    calls[1],
  ];
  const batchParts = batch.map((call) => ({
    functionCall: { id: call.callId, name: call.name, args: call.args },
  }));
  turn = createTurn(false, { mode: 'default', timeoutMs: 1_000 });
  const responses = await turn.execute(
    batch,
    batchParts,
    'model',
    new AbortController().signal,
  );
  expect(actionIds()).toHaveLength(1);
  expect(
    responses.map((part) => part.functionResponse?.response?.['error']),
  ).toEqual([
    'Nobody answered the approval request before it expired, so this tool call was not run.',
    'An earlier approval request in this turn expired unanswered, so this tool call was not asked about or run.',
  ]);
  const next = await turn.execute(
    [calls[0], calls[1]],
    [parts[0], parts[1]],
    'model',
    new AbortController().signal,
  );
  expect(actionIds()).toHaveLength(1);
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(next[1].functionResponse?.response?.['error']).toContain(
    'expired unanswered',
  );
});

it('keeps a decision that lands just before the waiter ends the Action', async () => {
  turn = createTurn(false, { mode: 'default' });
  const controller = new AbortController();
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    controller.signal,
  );
  const requestId = await requested();
  const original = session.authority.resolveAction.bind(session.authority);
  vi.spyOn(session.authority, 'resolveAction').mockImplementationOnce(
    async (command, request) => {
      // The owner's answer is recorded between the waiter's check and its
      // own attempt to end the Action.
      await resolveHostedAction(session, waiters, requestId, answer('allow'));
      return original(command, request);
    },
  );
  controller.abort(new Error('turn cancelled'));
  await expect(running).rejects.toThrow('turn cancelled');
  expect(session.authority.action(requestId)?.state).toBe('decided');
  expect(broker.prepare).not.toHaveBeenCalled();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('reports an answer that loses the race to the expiry as expired', async () => {
  turn = createTurn(false, { mode: 'default', timeoutMs: 60_000 });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const original = session.authority.resolveAction.bind(session.authority);
  vi.spyOn(session.authority, 'resolveAction').mockImplementationOnce(
    async (command, request) => {
      await original(
        { ...command, commandId: `${command.commandId}:race` },
        { requestId, state: 'expired', decisionRef: null },
      );
      return original(command, request);
    },
  );
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({ status: 409, code: 'action_expired' });
  waiters.notify(requestId);
  const responses = await running;
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'expired',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('blocks recovery when a refusal record write fails', async () => {
  turn = createTurn(false, { mode: 'default' });
  const write = session.sink.write.bind(session.sink);
  vi.spyOn(session.sink, 'write').mockImplementation(async (record) => {
    if (record.type === 'tool_result') throw new Error('resource unavailable');
    return write(record);
  });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  await resolveHostedAction(
    session,
    waiters,
    await requested(),
    answer('deny'),
  );
  await expect(running).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(await toolResults()).toEqual([]);
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
});

it('does not ask about later calls once the turn is cancelled', async () => {
  const batch = [
    {
      ...calls[1],
      name: 'write_file',
      callId: 'call-0',
      args: { file_path: 'new.txt', content: 'new' },
    },
    calls[1],
  ];
  turn = createTurn(false, { mode: 'default' });
  const controller = new AbortController();
  const publish = vi.spyOn(session.resources, 'publish');
  const running = turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    controller.signal,
  );
  const first = await requested();
  controller.abort(new Error('turn cancelled'));
  await expect(running).rejects.toThrow('turn cancelled');
  expect(actionIds()).toEqual([first]);
  expect(
    publish.mock.calls.filter(([kind]) => kind === 'managed-action-options'),
  ).toHaveLength(1);
  expect(session.authority.action(first)?.state).toBe('cancelled');
  expect(await toolResults()).toEqual([['call-0', 'call-1']]);
  expect(await toolResultErrors()).toEqual([
    'The turn was cancelled before this tool call ran.',
    'The turn was cancelled before this tool call ran.',
  ]);
});

it('opens no Action when the turn is cancelled while one is prepared', async () => {
  turn = createTurn(false, { mode: 'default' });
  const controller = new AbortController();
  const publish = session.resources.publish.bind(session.resources);
  vi.spyOn(session.resources, 'publish').mockImplementation(
    async (kind, bytes) => {
      if (kind === 'managed-action-options')
        controller.abort(new Error('turn cancelled'));
      return publish(kind, bytes);
    },
  );
  await expect(
    turn.execute(calls, parts, 'model', controller.signal),
  ).rejects.toThrow('turn cancelled');
  expect(actionIds()).toEqual([]);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(await toolResults()).toEqual([['call-0', 'call-1']]);
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('asks before Shell in auto-edit mode and runs the edit when Shell is denied', async () => {
  turn = createTurn(true, { mode: 'auto-edit' });
  const register = vi.spyOn(HostedShellPublisher.prototype, 'register');
  const shell = {
    ...calls[0],
    name: 'run_shell_command',
    callId: 'call-1',
    args: { command: 'rm -rf build' },
  };
  const batch = [calls[1], shell].map((call, index) => ({
    ...call,
    callId: `call-${index}`,
  }));
  const running = turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const action = session.authority.action(requestId)!;
  const options = JSON.parse(
    (await session.resources.read(action.optionsRef!)).toString(),
  );
  expect(options).toMatchObject({
    v: 2,
    functionCallId: 'call-1',
    toolName: 'run_shell_command',
  });
  expect(
    JSON.parse(
      JSON.parse((await session.resources.read(options.inputRef)).toString())
        .payloadJson,
    ).input,
  ).toMatchObject({ command: 'rm -rf build' });
  expect(broker.registerPublisher).toHaveBeenCalledOnce();
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  const responses = await running;
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(register).not.toHaveBeenCalled();
  expect(
    responses.map((part) => part.functionResponse?.response?.['error']),
  ).toEqual([
    undefined,
    'The Session owner denied this tool call, so it was not run.',
  ]);
});

it('admits exactly the declared native tools to the version 3 input preview', () => {
  // The Java reader admits a closed set. A name missing on either side degrades
  // to "Tool arguments are unavailable for this approval." with no error, so the
  // set is pinned here and each name must still be a declared native tool —
  // the child launch declares through HOSTED_AGENT_TOOL, a session message
  // through its two send_message declarations and the team board through
  // HOSTED_TEAM_TOOLS, not the shell set. `todo_write` is appended for `files/3`
  // and `shell/1`, but is absent from HOSTED_WORKSPACE_SHELL_TOOLS itself.
  expect(HOSTED_INPUT_PREVIEW_TOOLS).toEqual([
    'web_fetch',
    'read_file',
    'write_file',
    'edit',
    'run_shell_command',
    'todo_write',
    'agent',
    'send_message',
    'team_create',
    'task_create',
    'task_update',
    'workflow',
    'request_shutdown',
    'exit_plan_mode',
    'team_plan_approval',
  ]);
  const declared = [
    ...HOSTED_WORKSPACE_SHELL_TOOLS.map((tool) => tool.name),
    HOSTED_TODO_WRITE_TOOL.name,
    HOSTED_AGENT_TOOL.name,
    HOSTED_SEND_MESSAGE_TO_CHILD_TOOL.name,
    HOSTED_SEND_MESSAGE_TO_PARENT_TOOL.name,
    ...HOSTED_TEAM_TOOLS.map((tool) => tool.name),
    HOSTED_MEMBER_PLAN_TOOL.name,
    HOSTED_TEAM_PLAN_TOOL.name,
    HOSTED_WORKFLOW_TOOL.name,
  ];
  for (const name of HOSTED_INPUT_PREVIEW_TOOLS)
    expect(declared).toContain(name);
});

it('writes nothing once the Turn blocks during an answer', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  let blocked = false;
  const read = session.resources.read.bind(session.resources);
  vi.spyOn(session.resources, 'read').mockImplementationOnce(async (ref) => {
    blocked = true;
    return read(ref);
  });
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => blocked,
    ),
  ).resolves.toEqual({
    status: 409,
    code: 'hosted_turn_recovery_required',
    reason: 'turn_blocked',
  });
  expect(session.authority.action(requestId)?.state).toBe('requested');
  await resolveHostedAction(session, waiters, requestId, answer('allow'));
  await running;
});

it('replays a decision recorded while the answer was being read', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const read = session.resources.read.bind(session.resources);
  vi.spyOn(session.resources, 'read').mockImplementationOnce(async (ref) => {
    const bytes = await read(ref);
    await resolveHostedAction(session, waiters, requestId, answer('allow'));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    return bytes;
  });
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => true,
    ),
  ).resolves.toMatchObject({ status: 200 });
  vi.mocked(Date.now).mockRestore();
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('answers two identical concurrent decisions alike', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const decided = {
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  };
  await expect(
    Promise.all([
      resolveHostedAction(session, waiters, requestId, answer('allow')),
      resolveHostedAction(session, waiters, requestId, answer('allow')),
    ]),
  ).resolves.toEqual([decided, decided]);
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('answers the same decision that won a race while it was being written', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const original = session.authority.resolveAction.bind(session.authority);
  vi.spyOn(session.authority, 'resolveAction').mockImplementationOnce(
    async (command, request) => {
      // The same decision is recorded first, and this write then conflicts.
      await original(command, request);
      throw new ManagedSessionConflictError('action already decided.');
    },
  );
  const notify = vi.spyOn(waiters, 'notify');
  await expect(
    resolveHostedAction(session, waiters, requestId, answer('allow')),
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  });
  expect(notify).toHaveBeenCalledWith(requestId);
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('answers the loser of two different concurrent decisions with a conflict', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  const results = await Promise.all([
    resolveHostedAction(session, waiters, requestId, answer('allow')),
    resolveHostedAction(session, waiters, requestId, answer('deny')),
  ]);
  const recorded = hostedActionAllowed(
    session.authority.action(requestId)!,
    HOSTED_TOOL_APPROVAL_POLICY,
  )
    ? 'allow'
    : 'deny';
  expect(results).toContainEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: recorded },
  });
  expect(results).toContainEqual({
    status: 409,
    code: 'action_already_resolved',
  });
  await running;
  expect(broker.execute).toHaveBeenCalledTimes(recorded === 'allow' ? 1 : 0);
});

it('writes nothing once the Turn blocks while the decision is published', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  let blocked = false;
  const publish = session.resources.publish.bind(session.resources);
  vi.spyOn(session.resources, 'publish').mockImplementationOnce(
    async (kind, bytes) => {
      blocked = true;
      return publish(kind, bytes);
    },
  );
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => blocked,
    ),
  ).resolves.toEqual({
    status: 409,
    code: 'hosted_turn_recovery_required',
    reason: 'turn_blocked',
  });
  expect(session.authority.action(requestId)?.state).toBe('requested');
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  await running;
  expect(broker.execute).not.toHaveBeenCalled();
});

it('answers what landed while the decision was published, even once blocked', async () => {
  turn = createTurn(false, { mode: 'default' });
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  let blocked = false;
  const publish = session.resources.publish.bind(session.resources);
  vi.spyOn(session.resources, 'publish').mockImplementationOnce(
    async (kind, bytes) => {
      // Another answer records allow, then the Session blocks.
      await resolveHostedAction(session, waiters, requestId, answer('allow'));
      blocked = true;
      return publish(kind, bytes);
    },
  );
  await expect(
    resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => blocked,
    ),
  ).resolves.toEqual({
    status: 200,
    body: { requestId, state: 'decided', optionId: 'allow' },
  });
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
});

it.each(['decision', 'expiry'])(
  'writes nothing when the Session blocks while the %s waits in the queue',
  async (resolution) => {
    turn = createTurn(false, { mode: 'default' });
    const running = turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      new AbortController().signal,
    );
    const requestId = await requested();
    // Hold another write inside the authority's queue.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inQueue = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const append =
      LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockImplementationOnce(async function (
      this: LocalJsonlManagedSessionJournalHandle,
      records,
    ) {
      entered();
      await gate;
      return append.call(this, records);
    });
    const held = commit('assistant', [{ text: 'held' }], 'model');
    await inQueue;
    const queued = vi.spyOn(session.authority, 'resolveAction');
    const now =
      resolution === 'expiry'
        ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
        : undefined;
    // Observe only the answer's write; the Turn settles its own Action later.
    const notify = vi.spyOn(waiters, 'notify').mockImplementation(() => {});
    let blocked = false;
    const answering = resolveHostedAction(
      session,
      waiters,
      requestId,
      answer('allow'),
      () => blocked,
    );
    try {
      await vi.waitFor(() => expect(queued).toHaveBeenCalled());
      blocked = true;
    } finally {
      release();
    }
    await held;
    await expect(answering).resolves.toEqual({
      status: 409,
      code: 'hosted_turn_recovery_required',
      reason: 'turn_blocked',
    });
    expect(session.authority.action(requestId)?.state).toBe('requested');
    expect(session.authority.writesStopped).toBe(false);
    expect(notify).toHaveBeenCalledWith(requestId);
    now?.mockRestore();
    notify.mockRestore();
    await resolveHostedAction(session, waiters, requestId, answer('deny'));
    await running;
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

function hookSession(fire: HostedHookSession['fire']): HostedHookSession {
  return {
    fire,
    broker: { ...broker, runtimeSessionId: 'prompt' },
    acquire: () => broker.acquire(),
  } as unknown as HostedHookSession;
}

it('executes corrected Unicode after a refused batch with exact command bytes', async () => {
  turn = createTurn(true);
  const invalid = {
    ...calls[0],
    name: 'run_shell_command',
    args: { command: '\ud800' },
  };
  const run = (call: ToolCallRequestInfo) =>
    turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
  await run(invalid);
  await turn.consumeResults();
  broker.execute.mockResolvedValue({
    executionStatus: 'not_started',
    responseParts: [],
    error: { message: 'fixture stop' },
    capture: null,
  });
  const args = {
    command: ' printf 中文😀é\\ud800\x1b\x01\x7f\u2028\u2029 ',
    description: '中文😀',
  };
  await run({ ...invalid, callId: 'corrected-unicode', args });
  const input = JSON.parse(broker.execute.mock.calls[0][1]).input;
  expect(input).toEqual({ ...args, is_background: false });
  expect(broker.execute).toHaveBeenCalledOnce();
  await turn.consumeResults();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('refuses an oversized assistant record on the early Unicode refusal path', async () => {
  turn = createTurn(true);
  const call = {
    ...calls[0],
    name: 'run_shell_command',
    args: { command: '\ud800' },
  };
  messageFitsInline.mockImplementation((type) => type !== 'assistant');
  await expect(
    turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    ),
  ).rejects.toThrow(
    'Hosted assistant record exceeds the inline Session Store limit.',
  );
  expect(await session.sink.project()).toEqual([]);
});

it('refuses an oversized tool refusal on the early Unicode refusal path', async () => {
  turn = createTurn(true);
  const call = {
    ...calls[0],
    name: 'run_shell_command',
    args: { command: '\ud800' },
  };
  messageFitsInline.mockImplementation((type) => type !== 'tool_result');
  await expect(
    turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    ),
  ).rejects.toThrow(
    'Hosted tool refusal exceeds the inline Session Store limit.',
  );
  expect(await session.sink.project()).toEqual([]);
});

it.each([false, true])(
  'preserves an acquired owner for a later Unicode refusal (commit failure: %s)',
  async (failCommit) => {
    const original = commit;
    let resultCommits = 0;
    commit = async (...args) => {
      if (args[0] === 'tool_result' && ++resultCommits === 2 && failCommit)
        throw new Error('refusal commit failed');
      return original(...args);
    };
    turn = createTurn(true);
    await turn.execute(
      [calls[0]],
      [parts[0]],
      'model',
      new AbortController().signal,
    );
    await turn.consumeResults();
    const call = {
      ...calls[0],
      callId: 'later-invalid',
      name: 'run_shell_command',
      args: { command: '\ud800' },
    };
    const execution = turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    if (failCommit)
      await expect(execution).rejects.toBeInstanceOf(
        HostedToolRecoveryRequiredError,
      );
    else {
      const response = await execution;
      expect(response[0].functionResponse?.response?.['error']).toContain(
        'unpaired UTF-16 surrogate',
      );
      await turn.consumeResults();
    }
    expect(broker.acquire).toHaveBeenCalledOnce();
    expect(broker.execute).toHaveBeenCalledOnce();
    expect(broker.release).not.toHaveBeenCalled();
    if (failCommit)
      await expect(turn.finish()).rejects.toBeInstanceOf(
        HostedToolRecoveryRequiredError,
      );
    else await turn.finish();
    expect(broker.release).toHaveBeenCalledTimes(failCommit ? 0 : 1);
  },
);

it.each(
  [false, true].flatMap((publication) =>
    [1, 2].flatMap((version) =>
      ['command', 'description'].flatMap((field) =>
        ['\ud800', '\udc00', '😀\ud800', '\udc00\ud800'].flatMap((value) =>
          [false, true].map((invalidLast) => ({
            publication,
            version,
            field,
            value,
            invalidLast,
          })),
        ),
      ),
    ),
  ),
)(
  'durably refuses malformed Shell Unicode before Hooks and acquisition: %j',
  async ({ publication, version, field, value, invalidLast }) => {
    const owner = {
      owner: vi.fn(),
      request: vi.fn(),
      rememberAdmission: vi.fn(),
    } as unknown as HttpToolPublicationOwner;
    const fire = vi.fn<HostedHookSession['fire']>();
    const makeTurn = () =>
      new HostedWorkspaceToolTurn(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        harness,
        'prompt',
        commit,
        messageFitsInline,
        publication
          ? { owner, captureBytes: 1024 }
          : {
              resources: session.resources,
              assertWritable: async () => undefined,
            },
        undefined,
        { settings: { mode: 'default', timeoutMs: 100 }, waiters },
        {
          hooks: hookSession(fire),
          profile: 'hosted-workspace-shell/' + version,
        },
      );
    turn = makeTurn();
    const invalid = {
      ...calls[0],
      name: 'run_shell_command',
      args: { command: 'printf valid', [field]: value },
    };
    const siblingShell = {
      ...invalid,
      callId: 'valid-shell',
      args: { command: 'pwd' },
    };
    const siblingWrite = {
      ...calls[1],
      name: 'write_file',
      args: { file_path: 'sibling.txt', content: 'unexecuted' },
    };
    const batch = invalidLast
      ? [siblingShell, siblingWrite, invalid]
      : [invalid, siblingShell, siblingWrite];
    const invalidIndex = invalidLast ? 2 : 0;
    const input = batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    }));
    const responses = await turn.execute(
      batch,
      input,
      'model',
      new AbortController().signal,
    );
    expect(responses.map((part) => part.functionResponse?.id)).toEqual(
      batch.map((call) => call.callId),
    );
    expect(responses[invalidIndex].functionResponse?.response?.['error']).toBe(
      'Hosted Shell ' +
        field +
        ' contains an unpaired UTF-16 surrogate. Provide valid Unicode and retry.',
    );
    for (const [index, response] of responses.entries())
      if (index !== invalidIndex)
        expect(response.functionResponse?.response?.['error']).toContain(
          'not executed',
        );
    expect(fire).not.toHaveBeenCalled();
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.registerPublisher).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.prepareV3).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    expect(owner.request).not.toHaveBeenCalled();
    const history = await session.sink.project();
    expect(history.map((entry) => entry.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    expect(history[0].message?.parts).toEqual(input);
    expect(history[1].message?.parts).toEqual(
      JSON.parse(JSON.stringify(responses)),
    );
    const restored = makeTurn();
    expect(
      await restored.resumeHookResults(
        responses,
        'model',
        new AbortController().signal,
      ),
    ).toEqual(responses);
    expect(await session.sink.project()).toEqual(history);
    await expect(
      restored.resumeHookResults(
        responses.slice(0, 1),
        'model',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(fire).not.toHaveBeenCalled();
    await turn.finish();
    await restored.close();
  },
);

it.each([
  {
    name: 'run_shell_command',
    args: { command: 'pwd', timeout: 0 },
    error: 'Hosted Shell timeout must be an integer from 1 to 600000 ms.',
  },
  {
    name: 'run_shell_command',
    args: { command: 'pwd', description: 7 },
    error: 'Hosted Shell description must be a string.',
  },
])(
  'preserves the $name validation error beside malformed Unicode',
  async ({ name, args, error }) => {
    turn = createTurn(true);
    const batch = [
      { ...calls[0], name, args },
      { ...calls[1], name: 'run_shell_command', args: { command: '\ud800' } },
    ];
    const responses = await turn.execute(
      batch,
      batch.map((call) => ({
        functionCall: { id: call.callId, name: call.name, args: call.args },
      })),
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toContain(error);
    expect(responses[1].functionResponse?.response?.['error']).toContain(
      'unpaired UTF-16 surrogate',
    );
    expect((await session.sink.project())[1].message?.parts).toEqual(
      JSON.parse(JSON.stringify(responses)),
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'replays a Unicode refusal with optional sibling args (omitted: %s)',
  async (omitted) => {
    const fire = vi.fn<HostedHookSession['fire']>();
    const makeTurn = () =>
      createTurn(true, { mode: 'default' }, hookSession(fire));
    turn = makeTurn();
    const batch = [
      { ...calls[0], name: 'run_shell_command', args: { command: '\ud800' } },
      { ...calls[1], name: 'read_file', args: {} },
    ];
    const input = batch.map((call, index) => ({
      functionCall: {
        id: call.callId,
        name: call.name,
        ...(omitted && index === 1 ? {} : { args: call.args }),
      },
    }));
    const responses = await turn.execute(
      batch,
      input,
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toContain(
      'unpaired UTF-16 surrogate',
    );
    expect(responses[1].functionResponse?.response?.['error']).toContain(
      'require file_path',
    );
    const restored = makeTurn();
    expect(
      await restored.resumeHookResults(
        responses,
        'model',
        new AbortController().signal,
      ),
    ).toEqual(responses);
    expect((await session.sink.project())[0].message?.parts).toEqual(input);
    expect(fire).not.toHaveBeenCalled();
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await turn.finish();
    await restored.close();
  },
);

it.each([false, true])(
  'checks malformed Shell before permission Hooks on an MCP turn (declared: %s)',
  async (declared) => {
    const fire = vi.fn<HostedHookSession['fire']>();
    const mcp = {
      broker: { ...broker, runtimeSessionId: 'prompt' },
      ensureReady: async () => undefined,
      refresh: vi.fn(async () => undefined),
      tools: () => [],
      toolInput: () => undefined,
    };
    turn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      declared
        ? {
            resources: session.resources,
            assertWritable: async () => undefined,
          }
        : undefined,
      undefined,
      { settings: { mode: 'default', timeoutMs: 100 }, waiters },
      {
        profile: declared
          ? 'hosted-workspace-shell/1'
          : 'hosted-workspace-files/1',
        hooks: hookSession(fire),
        mcp: mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
      },
    );
    const call = {
      ...calls[0],
      name: 'run_shell_command',
      args: { command: '\ud800' },
    };
    const batch = declared ? [call, calls[1]] : [call];
    const execution = turn.execute(
      batch,
      batch.map((item) => ({
        functionCall: { id: item.callId, name: item.name, args: item.args },
      })),
      'model',
      new AbortController().signal,
    );
    if (declared) {
      const responses = await execution;
      expect(responses[0].functionResponse?.response?.['error']).toContain(
        'unpaired UTF-16 surrogate',
      );
      expect(responses[1].functionResponse?.response?.['error']).toContain(
        'not executed',
      );
      expect((await session.sink.project()).map((entry) => entry.type)).toEqual(
        ['assistant', 'tool_result'],
      );
      await turn.finish();
    } else {
      await expect(execution).rejects.toThrow(
        'Hosted Workspace profile refused a tool call.',
      );
      expect(await session.sink.project()).toEqual([]);
    }
    expect(mcp.refresh).toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    expect(broker.release).not.toHaveBeenCalled();
  },
);

it.each(
  ['assistant', 'tool_result'].flatMap((failedType) =>
    [false, true].map((lostReply) => ({ failedType, lostReply })),
  ),
)(
  'keeps malformed Shell Unicode recovery blocked after $failedType commit failure (lost reply: $lostReply)',
  async ({ failedType, lostReply }) => {
    const original = commit;
    commit = async (...args) => {
      if (args[0] === failedType) {
        if (lostReply) await original(...args);
        throw new Error('lost Unicode refusal commit');
      }
      return original(...args);
    };
    turn = createTurn(true);
    const call = {
      ...calls[0],
      name: 'run_shell_command',
      args: { command: '\ud800' },
    };
    await expect(
      turn.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'model',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    const history = await session.sink.project();
    expect(history.map((entry) => entry.type)).toEqual(
      failedType === 'assistant'
        ? lostReply
          ? ['assistant']
          : []
        : lostReply
          ? ['assistant', 'tool_result']
          : ['assistant'],
    );
  },
);

it.each<{
  event: HookEventName;
  deny: boolean;
  denySibling?: HookEventName;
  failResult?: boolean;
  bothEvents?: boolean;
  unstartedSibling?: boolean;
  cancelledSizePlan?: 'not_started_proven' | 'settled';
  bounded?: boolean;
}>([
  { event: HookEventName.PermissionRequest, deny: false },
  {
    event: HookEventName.PermissionRequest,
    deny: false,
    unstartedSibling: true,
  },
  { event: HookEventName.PreToolUse, deny: false, bounded: true },
  { event: HookEventName.PermissionRequest, deny: false, bounded: true },
  ...(['not_started_proven', 'settled'] as const).map((cancelledSizePlan) => ({
    event: HookEventName.PermissionRequest,
    deny: false,
    cancelledSizePlan,
  })),
  { event: HookEventName.PreToolUse, deny: false },
  { event: HookEventName.PreToolUse, deny: true },
  {
    event: HookEventName.PreToolUse,
    deny: false,
    denySibling: HookEventName.PermissionRequest,
  },
  {
    event: HookEventName.PreToolUse,
    deny: false,
    denySibling: HookEventName.PreToolUse,
  },
  { event: HookEventName.PreToolUse, deny: false, failResult: true },
  { event: HookEventName.PermissionRequest, deny: false, bothEvents: true },
])(
  'refuses a durable malformed $event rewrite for the entire batch (deny: $deny, sibling: $denySibling, fault: $failResult, concurrent marker reads: $bothEvents, unstarted sibling: $unstartedSibling, cancelled size plan: $cancelledSizePlan, bounded: $bounded) across reconstruction',
  async ({
    event,
    deny,
    denySibling,
    failResult,
    bothEvents,
    unstartedSibling,
    cancelledSizePlan,
    bounded,
  }) => {
    const pin = {
      catalogId: 'unicode',
      catalogRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    const malformed = { command: 'echo \ud800' };
    const hookControl = vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => ({
        operationId: operation.operationId,
        state: 'settled',
        ...(operation.kind === 'hook-catalog'
          ? {
              catalog: {
                ...pin,
                hooks: [
                  ...new Set([
                    event,
                    ...(denySibling ? [denySibling] : []),
                    ...(bothEvents
                      ? [
                          HookEventName.PreToolUse,
                          HookEventName.PermissionRequest,
                        ]
                      : []),
                    HookEventName.PostToolBatch,
                  ]),
                ].flatMap((eventName) => {
                  const hook = {
                    hookId: eventName,
                    eventName,
                    matcher:
                      bothEvents || unstartedSibling || cancelledSizePlan
                        ? undefined
                        : 'run_shell_command',
                    sequential: bounded ?? false,
                    async: false,
                    failClosed: true,
                    onceKey: null,
                    config: { type: 'command' as const },
                  };
                  return bounded && event === HookEventName.PermissionRequest
                    ? [{ ...hook, hookId: `${eventName}:metadata` }, hook]
                    : [hook];
                }),
              },
            }
          : {
              result: {
                success: true,
                outcome: 'success',
                duration: 0,
                output:
                  bounded && event === HookEventName.PermissionRequest
                    ? {
                        hookSpecificOutput:
                          operation.kind === 'hook-execute' &&
                          operation.hookId.endsWith(':metadata')
                            ? {
                                decision: {
                                  behavior: 'allow',
                                  message: 'x'.repeat(40 * 1024),
                                },
                              }
                            : {
                                updatedInput: {
                                  command: 'x'.repeat(40 * 1024),
                                  description: '\ud800',
                                },
                              },
                      }
                    : bounded
                      ? {
                          hookSpecificOutput: {
                            tool_input: { description: '\ud800' },
                            padding: 'x'.repeat(40 * 1024),
                          },
                        }
                      : {
                          hookSpecificOutput:
                            operation.kind === 'hook-execute' &&
                            operation.hookId === HookEventName.PermissionRequest
                              ? {
                                  decision: {
                                    behavior:
                                      denySibling &&
                                      operation.kind === 'hook-execute' &&
                                      'tool_use_id' in operation.input &&
                                      operation.input.tool_use_id ===
                                        'denied-sibling'
                                        ? 'deny'
                                        : 'allow',
                                    ...(event ===
                                      HookEventName.PermissionRequest &&
                                    'tool_name' in operation.input &&
                                    operation.input.tool_name ===
                                      'run_shell_command'
                                      ? { updatedInput: malformed }
                                      : {}),
                                  },
                                }
                              : {
                                  ...(denySibling &&
                                  operation.kind === 'hook-execute' &&
                                  'tool_use_id' in operation.input &&
                                  operation.input.tool_use_id ===
                                    'denied-sibling'
                                    ? denySibling === HookEventName.PreToolUse
                                      ? {
                                          permissionDecision: 'deny',
                                          permissionDecisionReason:
                                            'recorded policy denial',
                                        }
                                      : {}
                                    : event === HookEventName.PreToolUse
                                      ? {
                                          updatedInput: malformed,
                                          ...(deny
                                            ? { permissionDecision: 'deny' }
                                            : {}),
                                        }
                                      : {}),
                                },
                        },
              },
            }),
      }),
    );
    const hookBroker = {
      ...broker,
      runtimeSessionId: 'prompt',
      runtime: {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      },
      hookControl,
    } as unknown as HostedWorkspaceBroker;
    const makeHooks = () =>
      new HostedHookSession(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        pin,
        hookBroker,
      );
    const approval = {
      mode:
        event === HookEventName.PermissionRequest ||
        denySibling === HookEventName.PermissionRequest ||
        bothEvents
          ? ('default' as const)
          : ('yolo' as const),
    };
    const hooks = makeHooks();
    turn = createTurn(true, approval, hooks);
    const shellCall = {
      ...calls[0],
      name: 'run_shell_command',
      args: { command: bounded ? 'x'.repeat(40 * 1024) : 'echo valid' },
    };
    const batch = denySibling
      ? [{ ...shellCall, callId: 'denied-sibling' }, shellCall]
      : [
          shellCall,
          cancelledSizePlan
            ? {
                ...calls[1],
                args: { ...calls[1].args, new_string: 'x'.repeat(60 * 1024) },
              }
            : calls[1],
        ];
    if (unstartedSibling || cancelledSizePlan) {
      await hooks.ensureReady();
      const sibling = batch[1];
      const occurrenceId = hostedHookOccurrenceId(
        HookEventName.PermissionRequest,
        `prompt:${sibling.callId}`,
      );
      const original = session.authority.commitExtensionRecord.bind(
        session.authority,
      );
      const crash = vi
        .spyOn(session.authority, 'commitExtensionRecord')
        .mockImplementation(async (...args) => {
          const result = await original(...args);
          const record = args[1].record as {
            hookExecutionId?: string;
            hookId?: string;
            run: { execution: string };
          };
          if (
            record.hookId === '__plan__' &&
            record.hookExecutionId === occurrenceId &&
            record.run.execution ===
              (cancelledSizePlan === 'settled' ? 'dispatch_started' : 'intent')
          )
            throw new Error('crash after plan commit');
          return result;
        });
      try {
        await expect(
          hooks.fire(
            HookEventName.PermissionRequest,
            `prompt:${sibling.callId}`,
            {
              tool_name: sibling.name,
              tool_input: sibling.args,
              tool_use_id: sibling.callId,
              prompt_id: 'prompt',
            },
            new AbortController().signal,
            undefined,
            undefined,
            HOSTED_TOOL_INPUT_ORDER,
          ),
        ).rejects.toThrow('crash after plan');
      } finally {
        crash.mockRestore();
      }
      const marker = await hooks.status(occurrenceId, true);
      if (cancelledSizePlan === 'settled')
        expect(marker.resultRef).not.toBeNull();
      else expect(marker.resultRef).toBeNull();
      expect(marker.run).toMatchObject({
        state: 'cancelled',
        execution: cancelledSizePlan ?? 'not_started_proven',
      });
      if (cancelledSizePlan) {
        const plan = JSON.parse(
          (await session.resources.read(marker.planRef)).toString(),
        );
        expect(plan).toMatchObject({
          refusedInputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          hooks: [],
        });
        expect(plan.input.tool_use_id).toBeUndefined();
      }
    }
    const publish = bounded
      ? vi.spyOn(session.resources, 'publish')
      : undefined;
    const originalCommit = commit;
    if (failResult)
      commit = async (...args) => {
        if (args[0] === 'tool_result')
          throw new Error('store unavailable while refusing rewrite');
        return originalCommit(...args);
      };
    if (failResult) turn = createTurn(true, approval, hooks);
    const settle = vi.spyOn(harness, 'settleConsumedRuntimeContinuation');
    const execution = turn.execute(
      batch,
      batch.map((call) => ({
        functionCall: { id: call.callId, name: call.name, args: call.args },
      })),
      'model',
      new AbortController().signal,
    );
    if (failResult) {
      const error = await execution.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(HostedToolRecoveryRequiredError);
      expect((error as HostedToolRecoveryRequiredError).cause).toEqual(
        new Error('store unavailable while refusing rewrite'),
      );
      await expect(turn.finish()).rejects.toBeInstanceOf(
        HostedToolRecoveryRequiredError,
      );
      expect(settle).not.toHaveBeenCalled();
      expect(hooks.mountHeld).toBe(true);
      expect((await session.sink.project()).map((entry) => entry.type)).toEqual(
        ['assistant'],
      );
      expect(broker.execute).not.toHaveBeenCalled();
      return;
    }
    const responses = await execution;
    expect(
      responses[denySibling ? 1 : 0].functionResponse?.response?.['error'],
    ).toContain('unpaired UTF-16 surrogate');
    if (denySibling)
      expect(responses[0].functionResponse?.response?.['error']).toBe(
        denySibling === HookEventName.PermissionRequest
          ? 'PermissionRequest Hook denied the call.'
          : 'recorded policy denial',
      );
    else
      expect(responses[1].functionResponse?.response?.['error']).toContain(
        cancelledSizePlan
          ? 'Hook data exceeds the 60 KiB'
          : unstartedSibling
            ? 'PermissionRequest Hook denied the call.'
            : 'not executed',
      );
    if (bounded) {
      for (const [kind, bytes] of publish!.mock.calls)
        if (kind === 'managed-hook-result')
          expect(bytes.length).toBeLessThanOrEqual(60 * 1024);
      const marker = session.authority.extensionRecord(
        'hook_execution',
        hostedHookOccurrenceId(event, `prompt:${shellCall.callId}`),
      )!.record as { resultRef: ManagedSessionDurableRef };
      const saved = JSON.parse(
        (await session.resources.read(marker.resultRef)).toString(),
      );
      expect(saved.output).toMatchObject({
        reason: expect.stringContaining('60 KiB'),
        stopReason:
          'Hosted Shell description contains an unpaired UTF-16 surrogate. Provide valid Unicode and retry.',
      });
      if (event === HookEventName.PermissionRequest) {
        expect(saved.output.hookSpecificOutput).toEqual({
          decision: { behavior: 'deny', interrupt: true },
        });
        expect(broker.acquire).toHaveBeenCalledOnce();
      } else expect(saved.output.hookSpecificOutput).toBeUndefined();
    }
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    const history = await session.sink.project();
    expect(history.map((entry) => entry.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    const executed = hookControl.mock.calls.filter(
      ([operation]) => operation.kind === 'hook-execute',
    );
    expect(
      executed.map(
        ([operation]) => operation.kind === 'hook-execute' && operation.hookId,
      ),
    ).toEqual(
      denySibling === HookEventName.PermissionRequest
        ? [
            HookEventName.PreToolUse,
            HookEventName.PreToolUse,
            HookEventName.PermissionRequest,
          ]
        : denySibling
          ? [event, event]
          : bothEvents
            ? [
                HookEventName.PreToolUse,
                HookEventName.PreToolUse,
                HookEventName.PermissionRequest,
                HookEventName.PermissionRequest,
              ]
            : bounded && event === HookEventName.PermissionRequest
              ? [`${event}:metadata`, event]
              : [event],
    );
    const restored = createTurn(true, approval, makeHooks());
    const count = hookControl.mock.calls.length;
    const markerRefs = bothEvents
      ? new Set(
          [HookEventName.PermissionRequest, HookEventName.PreToolUse].flatMap(
            (eventName) => {
              const record = session.authority.extensionRecord(
                'hook_execution',
                hostedHookOccurrenceId(eventName, `prompt:${shellCall.callId}`),
              )!.record as {
                inputRef: ManagedSessionDurableRef;
                resultRef: ManagedSessionDurableRef;
              };
              return [record.inputRef, record.resultRef].map(
                (ref) => ref.resourceId,
              );
            },
          ),
        )
      : undefined;
    const read = session.resources.read.bind(session.resources);
    let unblock = () => {};
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const reads: string[] = [];
    const spy = bothEvents
      ? vi.spyOn(session.resources, 'read').mockImplementation(async (ref) => {
          if (markerRefs!.has(ref.resourceId)) {
            reads.push(ref.resourceId);
            await gate;
          }
          return read(ref);
        })
      : undefined;
    const resuming = restored.resumeHookResults(
      responses,
      'model',
      new AbortController().signal,
    );
    const drained = Promise.allSettled([resuming]);
    try {
      if (bothEvents)
        await vi.waitFor(() => expect(reads).toHaveLength(4), {
          timeout: 10_000,
        });
    } finally {
      unblock();
      await drained;
      spy?.mockRestore();
    }
    expect(await resuming).toEqual(responses);
    expect(
      await restored.resumeHookResults(
        responses,
        'model',
        new AbortController().signal,
      ),
    ).toEqual(responses);
    expect(hookControl).toHaveBeenCalledTimes(count);
    expect(await session.sink.project()).toEqual(history);
    await turn.finish();
    if (event === HookEventName.PreToolUse) {
      expect(settle).toHaveBeenCalledOnce();
      expect((await harness.ensureRunnable()).continuation.phase).toBe(
        'before_model',
      );
      expect(hooks.mountHeld).toBe(true);
    }
    if (unstartedSibling) {
      const originalView = session.authority.extensionRecord.bind(
        session.authority,
      );
      const blocked = vi
        .spyOn(session.authority, 'extensionRecord')
        .mockImplementation((domain, id) => {
          const entry = originalView(domain, id);
          if (
            entry &&
            domain === 'hook_execution' &&
            id ===
              hostedHookOccurrenceId(
                HookEventName.PermissionRequest,
                `prompt:${batch[1].callId}`,
              )
          ) {
            const record = entry.record as { run: Record<string, unknown> };
            return {
              ...entry,
              record: {
                ...record,
                run: {
                  ...record.run,
                  state: 'recovery_blocked',
                  reason: 'handler_unavailable',
                },
              },
            };
          }
          return entry;
        });
      try {
        await expect(
          createTurn(true, approval, makeHooks()).resumeHookResults(
            responses,
            'model',
            new AbortController().signal,
          ),
        ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
      } finally {
        blocked.mockRestore();
      }
    }
    await restored.close();
  },
);
