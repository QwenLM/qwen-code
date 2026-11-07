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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import { convertToFunctionErrorResponse } from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import {
  createHttpManagedSessionStores,
  ManagedSessionStoreHttpError,
  type HttpToolPublicationOwner,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { readManagedSessionRecords } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-projection.js';
import {
  readHostedFileHistory,
  commitHostedFileHistory,
  type HostedFileHistorySettleBlocker,
} from './hosted-file-history.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import type { HostedExtensionToolConfig } from './hosted-extension-tool-context.js';
import {
  HOSTED_TOOL_INPUT_ORDER,
  HostedHookSession,
  hostedHookOccurrenceId,
} from './hosted-hook-session.js';
import { parseHookExecution } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import {
  HostedWorkspaceBrokerRejection,
  type HostedWorkspaceBroker,
} from './hosted-workspace-broker.js';
import {
  HostedWorkspaceToolTurn,
  HostedToolRecoveryRequiredError,
  type HostedShellTurnOptions,
} from './hosted-workspace-tool-turn.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  resolveHostedAction,
  type HostedApprovalMode,
  type HostedApprovalSettings,
} from './hosted-tool-approval.js';
import * as stdio from '../utils/stdioHelpers.js';
import { monitorUnitNameOf } from '@qwen-code/qwen-code-core/managed-runtime/managed-monitor-protocol.js';
import {
  HOSTED_SKILL_APPROVAL_REFUSAL,
  HostedSkillCatalog,
} from './hosted-skill-catalog.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';

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

const publishedSkills = () =>
  new HostedSkillCatalog([
    {
      name: 'review',
      description: 'Review code changes.',
      body: 'Consult scripts/review.js before reviewing.',
      base_directory: '.qwen/skills/review',
    },
  ]);

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

async function toolResultErrors() {
  return (await session.sink.project())
    .filter((record) => record.type === 'tool_result')
    .flatMap((record) => record.message?.parts ?? [])
    .map((part) => part.functionResponse?.response?.['error']);
}

function hookSession(fire: HostedHookSession['fire']): HostedHookSession {
  return {
    fire,
    broker: { ...broker, runtimeSessionId: 'prompt' },
    acquire: () => broker.acquire(),
  } as unknown as HostedHookSession;
}

it.each(['live arguments', 'persisted error text'] as const)(
  'rejects contradictory Unicode refusal evidence: %s',
  async (mismatch) => {
    const hooks = hookSession(vi.fn());
    const call = {
      ...calls[0],
      name: 'run_shell_command',
      args: { command: '\ud800' },
    };
    turn = createTurn(true, undefined, hooks);
    const assistant = [
      {
        functionCall: {
          id: call.callId,
          name: call.name,
          args:
            mismatch === 'live arguments'
              ? { command: 'different\ud800' }
              : call.args,
        },
      },
    ];
    if (mismatch === 'live arguments') {
      await expect(
        turn.execute([call], assistant, 'model', new AbortController().signal),
      ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    } else {
      const responses = await turn.execute(
        [call],
        assistant,
        'model',
        new AbortController().signal,
      );
      const tampered = structuredClone(responses);
      tampered[0].functionResponse!.response!['error'] = 'different error';
      await expect(
        createTurn(true, undefined, hooks).resumeHookResults(
          tampered,
          'model',
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
      await expect(
        createTurn(true, undefined, hooks).resumeHookResults(
          responses,
          'model',
          new AbortController().signal,
        ),
      ).resolves.toEqual(responses);
    }
    expect((await session.sink.project()).map((entry) => entry.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    expect(broker.execute).not.toHaveBeenCalled();
    expect(hooks.fire).not.toHaveBeenCalled();
  },
);

it('keeps Unicode refusal replay blocked by a real unresolved sibling Hook', async () => {
  const pin = {
    catalogId: 'unresolved',
    catalogRevision: 1,
    definitionDigest: 'a'.repeat(64),
  };
  const hookControl = vi.fn<HostedWorkspaceBroker['hookControl']>(
    async (operation) => ({
      operationId: operation.operationId,
      ...(operation.kind === 'hook-catalog'
        ? {
            state: 'settled' as const,
            catalog: {
              ...pin,
              hooks: [
                {
                  hookId: 'unresolved',
                  eventName: HookEventName.PermissionRequest,
                  sequential: false,
                  async: false,
                  failClosed: true,
                  onceKey: null,
                  config: { type: 'command' as const },
                },
              ],
            },
          }
        : { state: 'outcome_unknown' as const }),
    }),
  );
  const hookBroker = {
    ...broker,
    runtimeSessionId: 'prompt',
    hookControl,
    runtime: {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    },
  } as unknown as HostedWorkspaceBroker;
  const makeHooks = () =>
    new HostedHookSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      pin,
      hookBroker,
    );
  const hooks = makeHooks();
  const malformed = {
    ...calls[0],
    name: 'run_shell_command',
    args: { command: '\ud800' },
  };
  const batch = [malformed, calls[1]];
  turn = createTurn(true, undefined, hooks);
  const responses = await turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: {
        id: call.callId,
        name: call.name,
        args: call.args,
      },
    })),
    'model',
    new AbortController().signal,
  );
  const sibling = batch[1];
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
    ),
  ).rejects.toThrow('Hosted Hook requires reconciliation');
  const child = session.authority
    .extensionRecordsInDomain('hook_execution')
    .map(
      (entry) =>
        entry.record as { hookId: string; run: Record<string, unknown> },
    )
    .find((record) => record.hookId === 'unresolved')!;
  expect(child.run).toMatchObject({
    state: 'recovery_blocked',
    execution: 'outcome_unknown',
  });
  const marker = await hooks.status(
    hostedHookOccurrenceId(
      HookEventName.PermissionRequest,
      `prompt:${sibling.callId}`,
    ),
    true,
  );
  expect(marker.resultRef).toBeNull();
  expect(marker.run.execution).toBe('dispatch_started');
  await expect(
    createTurn(true, undefined, makeHooks()).resumeHookResults(
      responses,
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.execute).not.toHaveBeenCalled();
});

it.each(['assistant-commit', 'second-call'] as const)(
  'settles every tool refusal when cancelled before a new Hook plan (%s)',
  async (window) => {
    const controller = new AbortController();
    const reason = new Error('turn cancelled');
    const pin = {
      catalogId: 'pre-cancel',
      catalogRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    const hookControl = vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled',
            catalog: {
              ...pin,
              hooks: [
                {
                  hookId: 'before',
                  eventName: HookEventName.PreToolUse,
                  sequential: false,
                  async: false,
                  failClosed: true,
                  onceKey: null,
                  config: { type: 'command' },
                },
              ],
            },
          };
        expect(operation.kind).toBe('hook-execute');
        controller.abort(reason);
        return {
          operationId: operation.operationId,
          state: 'settled',
          result: { success: true, outcome: 'success', duration: 0 },
        };
      },
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
    const hooks = new HostedHookSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      pin,
      hookBroker,
    );
    await hooks.ensureReady();
    if (window === 'assistant-commit') {
      const originalCommit = commit;
      commit = async (...args) => {
        const id = await originalCommit(...args);
        if (args[0] === 'assistant') controller.abort(reason);
        return id;
      };
    }
    turn = createTurn(false, { mode: 'yolo' }, hooks);
    await expect(
      turn.execute(calls, parts, 'model', controller.signal),
    ).rejects.toBe(reason);
    await expect(turn.finish()).resolves.toBeUndefined();
    const history = await session.sink.project();
    expect(history.map((record) => record.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    expect(history[1].message?.parts).toEqual(
      calls.map((call) => ({
        functionResponse: {
          id: call.callId,
          name: call.name,
          response: { error: 'Hook execution cancelled.' },
        },
      })),
    );
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    expect(hooks.hasPendingOperations).toBe(false);
    const restored = new HostedHookSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      pin,
      hookBroker,
    );
    for (const call of calls) {
      expect(
        await restored.fire(
          HookEventName.PreToolUse,
          `prompt:${call.callId}`,
          {
            tool_name: call.name,
            tool_input: call.args,
            tool_use_id: call.callId,
            permission_mode: 'yolo',
            prompt_id: 'prompt',
          },
          new AbortController().signal,
          undefined,
          undefined,
          HOSTED_TOOL_INPUT_ORDER,
        ),
      ).toMatchObject({ continue: false, reason: 'Hook execution cancelled.' });
    }
    expect(
      hookControl.mock.calls.filter(
        ([operation]) => operation.kind === 'hook-execute',
      ),
    ).toHaveLength(window === 'assistant-commit' ? 0 : 1);
  },
);

it('recovers committed tool results through the Hook owner acquisition', async () => {
  const hooks = hookSession(vi.fn());
  const acquire = vi.spyOn(hooks, 'acquire');
  const restored = createTurn(false, undefined, hooks);
  await restored.resumeCommittedResults();
  expect(acquire).toHaveBeenCalledOnce();
  expect(broker.acquire).toHaveBeenCalledOnce();
});

it('refuses tool dispatch when fail-closed permission evaluation is combined with an allow', async () => {
  const pin = {
    catalogId: 'permission-test',
    catalogRevision: 1,
    definitionDigest: 'a'.repeat(64),
  };
  const hookBroker = {
    ...broker,
    runtimeSessionId: 'prompt',
    runtime: {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    },
    hookControl: vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => ({
        operationId: operation.operationId,
        state: 'settled' as const,
        ...(operation.kind === 'hook-catalog'
          ? {
              catalog: {
                ...pin,
                hooks: ['fail', 'allow'].map((hookId) => ({
                  hookId,
                  eventName: HookEventName.PermissionRequest,
                  sequential: false,
                  async: false,
                  failClosed: true,
                  onceKey: null,
                  config: { type: 'command' as const },
                })),
              },
            }
          : {
              result:
                operation.kind === 'hook-execute' && operation.hookId === 'fail'
                  ? {
                      success: false,
                      outcome: 'non_blocking_error' as const,
                      duration: 0,
                    }
                  : {
                      success: true,
                      outcome: 'success' as const,
                      duration: 0,
                      output: {
                        hookSpecificOutput: { decision: { behavior: 'allow' } },
                      },
                    },
            }),
      }),
    ),
  };
  const hooks = new HostedHookSession(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    pin,
    hookBroker as unknown as HostedWorkspaceBroker,
  );
  turn = createTurn(false, { mode: 'default' }, hooks);
  const result = await turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  expect(result[0].functionResponse?.response?.['error']).toBeTruthy();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'action.changed'),
  ).toEqual([]);
});

it('asks once, after PreToolUse and PermissionRequest, about the input PreToolUse left', async () => {
  const changed = { ...calls[1].args, file_path: 'changed.txt' };
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) =>
      event === HookEventName.PreToolUse
        ? {
            hookSpecificOutput: { hookEventName: event, updatedInput: changed },
          }
        : undefined,
    );
  turn = createTurn(false, { mode: 'default' }, hookSession(fire));
  const running = turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  const approval = await requested();
  expect(
    fire.mock.calls.map(([event, , fields, , , , order]) => [
      event,
      fields['tool_input'],
      order,
    ]),
  ).toEqual([
    [HookEventName.PreToolUse, calls[1].args, HOSTED_TOOL_INPUT_ORDER],
    [HookEventName.PermissionRequest, changed, HOSTED_TOOL_INPUT_ORDER],
  ]);
  const inputRef = (await checkpoint()).approval!.invocationRef!;
  expect(
    JSON.parse(
      (
        await session.resources.read(
          session.authority.action(approval)!.optionsRef!,
        )
      ).toString(),
    ),
  ).toMatchObject({ v: 2, inputRef });
  expect(
    JSON.parse(
      JSON.parse((await session.resources.read(inputRef)).toString())
        .payloadJson,
    ).input,
  ).toEqual(changed);
  expect(broker.execute).not.toHaveBeenCalled();
  await resolveHostedAction(session, waiters, approval, answer('allow'));
  await running;
  expect(actionIds()).toEqual([approval]);
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual(changed);
  // The Runtime is bound to exactly the input the owner approved.
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .find((event) => event.kind === 'tool.intent')?.payload['argsRef'],
  ).toEqual(inputRef);
  expect(fire.mock.calls.map(([event]) => event)).toEqual([
    HookEventName.PreToolUse,
    HookEventName.PermissionRequest,
    HookEventName.PostToolUse,
    HookEventName.PostToolBatch,
  ]);
});

it.each(['allow', 'deny'] as const)(
  'honors a top-level PreToolUse ask before a preapproved call (%s)',
  async (decision) => {
    const fire = vi
      .fn<HostedHookSession['fire']>()
      .mockImplementation(async (event) =>
        event === HookEventName.PreToolUse
          ? { decision: 'ask', reason: 'Confirm this read.' }
          : undefined,
      );
    turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
    const running = turn.execute(
      [calls[0]],
      [parts[0]],
      'model',
      new AbortController().signal,
    );
    const approval = await requested();
    expect(
      JSON.parse(
        (
          await session.resources.read(
            session.authority.action(approval)!.optionsRef!,
          )
        ).toString(),
      ).requiresHumanDecision,
    ).toBe(true);
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await resolveHostedAction(session, waiters, approval, answer(decision));
    await running;
    expect(broker.execute).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
    expect(
      fire.mock.calls.filter(([event]) => event === HookEventName.PreToolUse),
    ).toHaveLength(1);
  },
);

it.each<{
  decision: 'allow' | 'deny' | 'ask';
  oversized: boolean;
  ordered?: boolean;
}>([
  { decision: 'allow', oversized: false },
  { decision: 'deny', oversized: false },
  { decision: 'ask', oversized: false },
  { decision: 'allow', oversized: true },
  { decision: 'allow', oversized: false, ordered: true },
])(
  'restores PreToolUse context from its durable receipt without duplicate effects ($decision, oversized: $oversized, ordered: $ordered)',
  async ({ decision, oversized, ordered }) => {
    if (oversized) {
      const remote = createHttpManagedSessionStores({
        baseUrl: 'http://127.0.0.1:1',
        sessionKey: session.authority.sessionHeader.sessionKey,
        writerId: 'test',
      });
      const publish = session.resources.publish.bind(session.resources);
      vi.spyOn(session.resources, 'publish').mockImplementation(
        async (kind, bytes) => {
          await remote.resourceStore.publish(kind, bytes);
          return publish(kind, bytes);
        },
      );
      messageFitsInline.mockImplementation(
        (_type, content) =>
          Buffer.byteLength(JSON.stringify(content)) <= 60 * 1024,
      );
    }
    const pin = {
      catalogId: 'pre-context',
      catalogRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    const hookControl = vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => ({
        operationId: operation.operationId,
        state: 'settled',
        ...(operation.kind === 'hook-catalog'
          ? {
              catalog: {
                ...pin,
                hooks: [
                  ...(ordered ? [HookEventName.PermissionRequest] : []),
                  HookEventName.PreToolUse,
                  HookEventName.PostToolUse,
                ].map((eventName) => ({
                  hookId: eventName,
                  eventName,
                  sequential: false,
                  async: false,
                  failClosed: true,
                  onceKey: null,
                  config: { type: 'command' as const },
                })),
              },
            }
          : {
              result: {
                success: true,
                outcome: 'success',
                duration: 0,
                output: {
                  hookSpecificOutput:
                    operation.kind === 'hook-execute' &&
                    operation.hookId === HookEventName.PermissionRequest
                      ? {
                          decision: {
                            behavior: 'allow',
                            updatedInput: {
                              file_path: 'permission.txt',
                              content: 'fixture',
                            },
                          },
                        }
                      : operation.kind === 'hook-execute' &&
                          operation.hookId === HookEventName.PreToolUse
                        ? {
                            permissionDecision: decision,
                            ...(ordered
                              ? {
                                  updatedInput: {
                                    file_path: 'pre.txt',
                                    content: 'fixture',
                                  },
                                }
                              : {}),
                            additionalContext: oversized
                              ? 'x'.repeat(36 * 1024)
                              : 'before <tool>',
                          }
                        : {
                            additionalContext: oversized
                              ? 'y'.repeat(36 * 1024)
                              : 'after tool',
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
    const createHooks = () =>
      new HostedHookSession(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        pin,
        hookBroker,
      );
    const mode = ordered ? 'default' : 'yolo';
    turn = createTurn(false, { mode }, createHooks());
    const call = ordered
      ? {
          ...calls[0],
          name: 'write_file',
          args: { file_path: 'original.txt', content: 'fixture' },
        }
      : calls[0];
    const running = turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    if (decision === 'ask')
      await resolveHostedAction(
        session,
        waiters,
        await requested(),
        answer('deny'),
      );
    const responses = await running;
    if (ordered) {
      expect(
        hookControl.mock.calls.find(
          ([operation]) =>
            operation.kind === 'hook-execute' &&
            operation.hookId === HookEventName.PreToolUse,
        )?.[0],
      ).toMatchObject({
        input: { tool_input: { file_path: 'original.txt' } },
      });
      expect(
        hookControl.mock.calls.find(
          ([operation]) =>
            operation.kind === 'hook-execute' &&
            operation.hookId === HookEventName.PermissionRequest,
        )?.[0],
      ).toMatchObject({ input: { tool_input: { file_path: 'pre.txt' } } });
      expect(
        hookControl.mock.calls
          .filter(([operation]) => operation.kind === 'hook-execute')
          .map(
            ([operation]) =>
              operation.kind === 'hook-execute' && operation.hookId,
          ),
      ).toEqual([
        HookEventName.PreToolUse,
        HookEventName.PermissionRequest,
        HookEventName.PostToolUse,
      ]);
      expect(JSON.parse(broker.execute.mock.calls[0][1])).toMatchObject({
        input: { file_path: 'permission.txt' },
      });
      expect(
        hookControl.mock.calls.find(
          ([operation]) =>
            operation.kind === 'hook-execute' &&
            operation.hookId === HookEventName.PostToolUse,
        )?.[0],
      ).toMatchObject({
        input: { tool_input: { file_path: 'permission.txt' } },
      });
    }
    const contexts = responses.filter((part) => typeof part.text === 'string');
    expect(contexts).toEqual(
      decision === 'ask' || oversized
        ? []
        : [
            { text: 'before &lt;tool&gt;' },
            ...(decision === 'allow' ? [{ text: 'after tool' }] : []),
          ],
    );
    if (oversized) {
      expect(turn.hookStopReason).toContain('context');
      await turn.finish();
      const authorization = await harness.ensureRunnable();
      expect(authorization.continuation.phase).toBe('turn_settled');
      expect(authorization.tools?.items[0]).toMatchObject({
        state: 'settled',
        consumed: false,
      });
    }
    const history = await session.sink.project();
    const controls = hookControl.mock.calls.length;
    const restored = createTurn(false, { mode }, createHooks());
    expect(
      await restored.resumeHookResults(
        responses,
        'model',
        new AbortController().signal,
      ),
    ).toEqual(responses);
    expect(await session.sink.project()).toEqual(history);
    if (oversized) expect(restored.hookStopReason).toBe(turn.hookStopReason);
    expect(hookControl).toHaveBeenCalledTimes(controls);
    expect(broker.execute).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
  },
);

it('validates Hook-modified arguments before dispatch', async () => {
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) =>
      event === HookEventName.PreToolUse
        ? {
            hookSpecificOutput: {
              hookEventName: event,
              updatedInput: { file_path: '../outside' },
            },
          }
        : undefined,
    );
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  const responses = await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'relative',
  );
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(fire.mock.calls.map(([event]) => event)).toEqual([
    HookEventName.PreToolUse,
    HookEventName.PostToolBatch,
  ]);
});

it.each([
  [{ decision: 'block', reason: 'policy' }, 'policy'],
  [
    {
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecision: 'deny',
        permissionDecisionReason: 'policy',
      },
    },
    'policy',
  ],
  [
    {
      continue: false,
      stopReason: 'halt',
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecisionReason: 'needs approval',
      },
    },
    'halt',
  ],
] as const)(
  'does not execute a denied tool or emit a physical post-tool event (%j)',
  async (output, error) => {
    const fire = vi
      .fn<HostedHookSession['fire']>()
      .mockImplementation(async (event) =>
        event === HookEventName.PreToolUse ? output : undefined,
      );
    turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
    const responses = await turn.execute(
      [calls[0]],
      [parts[0]],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toBe(error);
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(fire.mock.calls.map(([event]) => event)).toEqual([
      HookEventName.PreToolUse,
      HookEventName.PostToolBatch,
    ]);
  },
);

it('recovers a failed after Hook from the committed physical receipt without executing the tool again', async () => {
  let fail = true;
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) => {
      if (event === HookEventName.PostToolUse && fail)
        throw new Error('Hook owner disconnected');
      return undefined;
    });
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  await expect(
    turn.execute([calls[0]], [parts[0]], 'model', new AbortController().signal),
  ).rejects.toThrow('Hook owner disconnected');
  const history = await session.sink.project();
  const saved = history.find((entry) => entry.type === 'tool_result')!.message!
    .parts!;
  expect(saved[0].functionResponse?.response?.['executionStatus']).toBe(
    'success',
  );
  fail = false;
  const recovered = await turn.resumeHookResults(
    saved,
    'model',
    new AbortController().signal,
  );
  expect(recovered).toEqual(saved);
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(
    fire.mock.calls.filter(([event]) => event === HookEventName.PostToolUse),
  ).toHaveLength(2);
});

it.each([
  {
    event: HookEventName.PostToolUse,
    output: { continue: false, stopReason: 'policy stop' },
  },
  {
    event: HookEventName.PostToolBatch,
    output: { continue: false, stopReason: 'policy stop' },
  },
  {
    event: HookEventName.PostToolBatch,
    output: { decision: 'deny' as const, reason: 'policy stop' },
  },
])(
  'honors $event orchestration stop while retaining the successful unconsumed receipt',
  async ({ event, output }) => {
    const fire = vi
      .fn<HostedHookSession['fire']>()
      .mockImplementation(async (actual) =>
        actual === event ? output : undefined,
      );
    const hooks = hookSession(fire);
    turn = createTurn(false, { mode: 'yolo' }, hooks);
    const responses = await turn.execute(
      [calls[0]],
      [parts[0]],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toBeUndefined();
    expect(turn.hookStopReason).toBe('policy stop');
    const original = (await checkpoint()).tools!.items;
    expect(original).toEqual([
      expect.objectContaining({ state: 'settled', consumed: false }),
    ]);
    const restored = createTurn(false, { mode: 'yolo' }, hooks);
    await restored.resumeHookResults(
      responses,
      'model',
      new AbortController().signal,
    );
    expect(restored.hookStopReason).toBe('policy stop');
    await turn.finish();
    expect((await checkpoint()).continuation.phase).toBe('turn_settled');
    expect((await checkpoint()).tools!.items).toEqual(original);
    expect(broker.execute).toHaveBeenCalledOnce();
  },
);

it('does not duplicate durable Hook context when resuming committed tool results', async () => {
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) =>
      event === HookEventName.PostToolUse
        ? { hookSpecificOutput: { additionalContext: 'after-tool context' } }
        : undefined,
    );
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  const response = await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  const before = await session.sink.project();
  expect(response.at(-1)).toEqual({ text: 'after-tool context' });
  expect(before.filter((entry) => entry.type === 'tool_result')).toHaveLength(
    2,
  );
  expect(
    await turn.resumeHookResults(
      response,
      'model',
      new AbortController().signal,
    ),
  ).toEqual(response);
  expect(await session.sink.project()).toEqual(before);
  expect(broker.execute).toHaveBeenCalledOnce();
});

it('preserves native success in after and batch Hooks when oversized output is omitted', async () => {
  const fire = vi.fn<HostedHookSession['fire']>().mockResolvedValue(undefined);
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  broker.execute.mockResolvedValue({
    executionStatus: 'success',
    responseParts: [{ text: 'x'.repeat(70 * 1024) }],
  });
  const results = await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(results[0].functionResponse?.response).toMatchObject({
    executionStatus: 'success',
    outputOmitted: true,
    error: expect.any(String),
  });
  expect(fire.mock.calls.map(([event]) => event)).toContain(
    HookEventName.PostToolUse,
  );
  expect(fire.mock.calls.map(([event]) => event)).not.toContain(
    HookEventName.PostToolUseFailure,
  );
  expect(
    fire.mock.calls.find(
      ([event]) => event === HookEventName.PostToolBatch,
    )?.[2],
  ).toMatchObject({ tool_calls: [{ status: 'success' }] });
});

it('preserves a bounded Shell failure without an error field in after and batch Hooks', async () => {
  const fire = vi.fn<HostedHookSession['fire']>().mockResolvedValue(undefined);
  turn = createTurn(false, { mode: 'yolo' }, hookSession(fire));
  await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  fire.mockClear();
  const saved: Part[] = [
    {
      functionResponse: {
        id: calls[0].callId,
        name: calls[0].name,
        response: {
          executionStatus: 'error',
          outputOmitted: true,
          summary: 'The Shell result was saved in its immutable capture.',
        },
      },
    },
  ];
  await turn.resumeHookResults(saved, 'model', new AbortController().signal);
  expect(fire.mock.calls.map(([event]) => event)).toContain(
    HookEventName.PostToolUseFailure,
  );
  expect(
    fire.mock.calls.find(
      ([event]) => event === HookEventName.PostToolBatch,
    )?.[2],
  ).toMatchObject({ tool_calls: [{ status: 'error' }] });
  expect(broker.execute).toHaveBeenCalledOnce();
});

it.each([
  [false, 0],
  [true, 0],
  [true, 8 * 1024 * 1024 + 1],
] as const)(
  'stops oversized Hook data and recovers physical receipts (matching hook: %s, snapshot bytes: %s)',
  async (matchingHook, snapshotBytes) => {
    const remote = createHttpManagedSessionStores({
      baseUrl: 'http://127.0.0.1:1',
      sessionKey: session.authority.sessionHeader.sessionKey,
      writerId: 'test',
    });
    const publish = session.resources.publish.bind(session.resources);
    vi.spyOn(session.resources, 'publish').mockImplementation(
      async (kind, bytes) => {
        await remote.resourceStore.publish(kind, bytes);
        return publish(kind, bytes);
      },
    );
    messageFitsInline.mockImplementation(
      (_type, content) =>
        Buffer.byteLength(JSON.stringify(content)) <= 60 * 1024,
    );
    const pin = {
      catalogId: 'round8',
      catalogRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    const control = vi.fn<HostedWorkspaceBroker['hookControl']>(
      async (operation) => ({
        operationId: operation.operationId,
        state: 'settled',
        ...(operation.kind === 'hook-catalog'
          ? {
              catalog: {
                ...pin,
                hooks: matchingHook
                  ? [
                      {
                        hookId: 'batch',
                        eventName: HookEventName.PostToolBatch,
                        sequential: false,
                        async: false,
                        onceKey: null,
                        failClosed: true,
                        config: {
                          type: snapshotBytes
                            ? ('function' as const)
                            : ('command' as const),
                        },
                      },
                    ]
                  : [],
              },
            }
          : { result: { success: true, outcome: 'success', duration: 0 } }),
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
      hookControl: control,
    } as unknown as HostedWorkspaceBroker;
    const createHooks = () => {
      const hooks = new HostedHookSession(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        pin,
        hookBroker,
      );
      if (snapshotBytes)
        hooks.setMessagesProvider(() => [{ text: 'x'.repeat(snapshotBytes) }]);
      return hooks;
    };
    broker.execute.mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'x'.repeat(snapshotBytes ? 1024 : 36 * 1024) }],
    });
    turn = createTurn(false, { mode: 'yolo' }, createHooks());
    await turn.execute(calls, parts, 'model', new AbortController().signal);
    expect(turn.hookStopReason).toContain('60 KiB');
    const saved = await checkpoint();
    const history = await session.sink.project();
    const responses = history
      .filter((r) => r.type === 'tool_result')
      .flatMap((r) => r.message?.parts ?? []);
    const key = session.authority.sessionHeader.sessionKey;
    await turn.close();
    await session.close();
    session = await openManagedSession({
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: key.sessionId,
      sessionKey: key,
      version: 'test',
      workerId: 'reopened-worker',
      activationLeaseDurationMs: 60000,
    });
    harness = createManagedHarnessHandle(session);
    await harness.ensureRunnable();
    const publishAfter = session.resources.publish.bind(session.resources);
    vi.spyOn(session.resources, 'publish').mockImplementation(
      async (kind, bytes) => {
        await remote.resourceStore.publish(kind, bytes);
        return publishAfter(kind, bytes);
      },
    );
    const restored = createTurn(false, { mode: 'yolo' }, createHooks());
    await restored.resumeCommittedResults();
    turn = restored;
    expect(
      await restored.resumeHookResults(
        responses,
        'model',
        new AbortController().signal,
      ),
    ).toEqual(responses);
    expect(restored.hookStopReason).toContain('60 KiB');
    expect(saved.tools!.items).toEqual([
      expect.objectContaining({ state: 'settled', consumed: false }),
      expect.objectContaining({ state: 'settled', consumed: false }),
    ]);
    await restored.finish();
    expect((await checkpoint()).continuation.phase).toBe('turn_settled');
    expect((await checkpoint()).tools!.items).toEqual(saved.tools!.items);
    expect(await session.sink.project()).toEqual(history);
    expect(broker.execute).toHaveBeenCalledTimes(2);
    expect(control.mock.calls.map(([operation]) => operation.kind)).toEqual([
      'hook-catalog',
    ]);
  },
);

// A real HostedHookSession over this Session's durable records; only the
// Hook Runtime's control channel is scripted, one command Hook per event.
// The `oversized` event's Hook takes the message history, which is too large
// to send, so its plan keeps only the digest of its input.
function durableHooks(
  outputs: Partial<
    Record<HookEventName, (input: Record<string, unknown>) => unknown>
  >,
  oversized?: HookEventName,
) {
  const pin = {
    catalogId: 'recorded-input',
    catalogRevision: 1,
    definitionDigest: 'a'.repeat(64),
  };
  const seen: Array<{ event: string; input: Record<string, unknown> }> = [];
  const hookControl = vi.fn<HostedWorkspaceBroker['hookControl']>(
    async (operation) => {
      if (operation.kind === 'hook-catalog')
        return {
          operationId: operation.operationId,
          state: 'settled',
          catalog: {
            ...pin,
            hooks: Object.keys(outputs).map((eventName) => ({
              hookId: eventName,
              eventName: eventName as HookEventName,
              sequential: false,
              async: false,
              failClosed: true,
              onceKey: null,
              config: {
                type:
                  eventName === oversized
                    ? ('function' as const)
                    : ('command' as const),
              },
            })),
          },
        };
      if (operation.kind !== 'hook-execute')
        throw new Error(`Unexpected ${operation.kind}`);
      const input = operation.input as unknown as Record<string, unknown>;
      seen.push({ event: operation.hookId, input });
      const output = outputs[operation.hookId as HookEventName]?.(input);
      return {
        operationId: operation.operationId,
        state: 'settled',
        result: {
          success: true,
          outcome: 'success',
          duration: 0,
          ...(output === undefined
            ? {}
            : { output: output as Record<string, unknown> }),
        },
      };
    },
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
  const create = () => {
    const hooks = new HostedHookSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      pin,
      hookBroker,
    );
    hooks.setMessagesProvider(() => [
      { text: 'x'.repeat(8 * 1024 * 1024 + 1) },
    ]);
    return hooks;
  };
  return { create, seen };
}

// A saved occurrence as the Session holds it: its marker, plan and result.
async function savedHook(event: HookEventName, occurrenceId: string) {
  const marker = session.authority.extensionRecord(
    'hook_execution',
    hostedHookOccurrenceId(event, occurrenceId),
  )!;
  const record = parseHookExecution(marker.record);
  const read = async (ref: ManagedSessionDurableRef) =>
    JSON.parse((await session.resources.read(ref)).toString()) as Record<
      string,
      unknown
    >;
  return {
    marker,
    plan: await read(record.planRef),
    result: record.resultRef ? await read(record.resultRef) : undefined,
  };
}

const editA = calls[1].args;
const editB = { ...editA, file_path: 'b.txt' };
const editC = { ...editA, file_path: 'c.txt' };
const permitB = () => ({
  hookSpecificOutput: {
    hookEventName: HookEventName.PermissionRequest,
    decision: { behavior: 'allow', updatedInput: editB },
  },
});
const reportedInputs = (hit: { input: Record<string, unknown> } | undefined) =>
  (hit?.input['tool_calls'] as Array<Record<string, unknown>>).map(
    (call) => call['tool_input'],
  );

it.each([
  {
    name: 'deny',
    output: {
      hookSpecificOutput: { permissionDecision: 'deny', updatedInput: editC },
    },
  },
  {
    name: 'block',
    output: {
      decision: 'block',
      hookSpecificOutput: { permissionDecision: 'ask', updatedInput: editC },
    },
  },
  {
    name: 'stop',
    output: { continue: false, hookSpecificOutput: { updatedInput: editC } },
  },
])(
  'refuses a PreToolUse $name with a replacement before PermissionRequest and reports the model input',
  async ({ output }) => {
    const { create, seen } = durableHooks({
      [HookEventName.PermissionRequest]: permitB,
      [HookEventName.PreToolUse]: () => output,
      [HookEventName.PostToolBatch]: () => undefined,
    });
    turn = createTurn(false, { mode: 'default' }, create());
    const signal = new AbortController().signal;
    const responses = await turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toBeTruthy();
    expect(seen.map(({ event }) => event)).toEqual([
      HookEventName.PreToolUse,
      HookEventName.PostToolBatch,
    ]);
    expect(seen[0].input['tool_input']).toEqual(editA);
    expect(reportedInputs(seen[1])).toEqual([editA]);
    expect(actionIds()).toEqual([]);
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    const occurrence = `prompt:${calls[1].callId}`;
    const pre = await savedHook(HookEventName.PreToolUse, occurrence);
    expect(pre.plan['toolInputOrder']).toBe(HOSTED_TOOL_INPUT_ORDER);
    expect(pre.result).toMatchObject({
      output: { hookSpecificOutput: { updatedInput: editC } },
    });
    expect(
      session.authority.extensionRecord(
        'hook_execution',
        hostedHookOccurrenceId(HookEventName.PermissionRequest, occurrence),
      ),
    ).toBeUndefined();
    const history = await session.sink.project();
    await expect(
      createTurn(false, { mode: 'default' }, create()).resumeHookResults(
        responses,
        'model',
        signal,
      ),
    ).resolves.toEqual(responses);
    expect(seen).toHaveLength(2);
    expect(await session.sink.project()).toEqual(history);
    expect(await savedHook(HookEventName.PreToolUse, occurrence)).toEqual(pre);
  },
);

it.each([null, 'text', ['x'], 0, false])(
  'ignores a PreToolUse replacement that is not an object (%j) and runs what PermissionRequest allowed',
  async (updatedInput) => {
    const { create, seen } = durableHooks({
      [HookEventName.PermissionRequest]: permitB,
      [HookEventName.PreToolUse]: () => ({
        hookSpecificOutput: { updatedInput },
      }),
      [HookEventName.PostToolUse]: () => undefined,
      [HookEventName.PostToolBatch]: () => undefined,
    });
    turn = createTurn(false, { mode: 'default' }, create());
    await turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      new AbortController().signal,
    );
    expect(broker.execute).toHaveBeenCalledOnce();
    expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual(editB);
    expect(seen.map(({ event }) => event)).toEqual([
      HookEventName.PreToolUse,
      HookEventName.PermissionRequest,
      HookEventName.PostToolUse,
      HookEventName.PostToolBatch,
    ]);
    expect(seen[1].input['tool_input']).toEqual(editA);
    expect(seen[2].input['tool_input']).toEqual(editB);
    expect(reportedInputs(seen[3])).toEqual([editB]);
    expect(actionIds()).toEqual([]);
  },
);

it('reports each call of a batch with the input its PreToolUse decision left', async () => {
  const replaced = { ...editA, new_string: 'replaced' };
  const { create, seen } = durableHooks({
    [HookEventName.PreToolUse]: (input) => ({
      hookSpecificOutput:
        input['tool_use_id'] === calls[0].callId
          ? {
              permissionDecision: 'deny',
              updatedInput: { file_path: 'denied.txt' },
            }
          : { updatedInput: replaced },
    }),
    [HookEventName.PostToolUse]: () => undefined,
    [HookEventName.PostToolBatch]: () => undefined,
  });
  turn = createTurn(false, { mode: 'yolo' }, create());
  const responses = await turn.execute(
    calls,
    parts,
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toBeTruthy();
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toMatchObject(
    replaced,
  );
  expect(
    seen
      .filter(({ event }) => event === HookEventName.PostToolUse)
      .map(({ input }) => input['tool_input']),
  ).toEqual([replaced]);
  expect(
    reportedInputs(
      seen.find(({ event }) => event === HookEventName.PostToolBatch),
    ),
  ).toEqual([calls[0].args, replaced]);
});

it('reports the Skill a PreToolUse ask left in place, never the replacement it asked about', async () => {
  const { create, seen } = durableHooks({
    [HookEventName.PreToolUse]: () => ({
      hookSpecificOutput: {
        permissionDecision: 'ask',
        updatedInput: { skill: 'testing' },
      },
    }),
    [HookEventName.PostToolBatch]: () => undefined,
  });
  turn = createTurn(false, { mode: 'default' }, create(), publishedSkills());
  const call = { ...calls[0], name: 'skill', args: { skill: 'review' } };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toBe(
    HOSTED_SKILL_APPROVAL_REFUSAL,
  );
  expect(seen.map(({ event }) => event)).toEqual([
    HookEventName.PreToolUse,
    HookEventName.PostToolBatch,
  ]);
  expect(reportedInputs(seen[1])).toEqual([call.args]);
});

it('reads an oversized PreToolUse input the earlier order saved back through its PermissionRequest record', async () => {
  const { create, seen } = durableHooks(
    {
      [HookEventName.PermissionRequest]: permitB,
      [HookEventName.PreToolUse]: () => undefined,
      [HookEventName.PostToolBatch]: () => undefined,
    },
    HookEventName.PreToolUse,
  );
  const hooks = create();
  const signal = new AbortController().signal;
  const occurrence = `prompt:${calls[1].callId}`;
  await commit('assistant', [parts[1]], 'model');
  // The earlier order: PermissionRequest on A, then PreToolUse on its B.
  await hooks.fire(
    HookEventName.PermissionRequest,
    occurrence,
    {
      tool_name: calls[1].name,
      tool_input: editA,
      tool_use_id: calls[1].callId,
      prompt_id: 'prompt',
    },
    signal,
  );
  const refusal = await hooks.fire(
    HookEventName.PreToolUse,
    occurrence,
    {
      tool_name: calls[1].name,
      tool_input: editB,
      tool_use_id: calls[1].callId,
      permission_mode: 'default',
      prompt_id: 'prompt',
    },
    signal,
  );
  const refused = convertToFunctionErrorResponse(
    calls[1].name,
    calls[1].callId,
    [],
    refusal!.reason!,
  );
  await commit('tool_result', refused, 'model');
  const { plan } = await savedHook(HookEventName.PreToolUse, occurrence);
  expect(plan['refusedInputDigest']).toEqual(expect.any(String));
  expect(plan['input']).not.toHaveProperty('tool_input');
  expect(plan).not.toHaveProperty('toolInputOrder');
  expect(
    await createTurn(false, { mode: 'default' }, create()).resumeHookResults(
      refused,
      'model',
      signal,
    ),
  ).toEqual(refused);
  expect(seen.map(({ event }) => event)).toEqual([
    HookEventName.PermissionRequest,
    HookEventName.PostToolBatch,
  ]);
  expect(reportedInputs(seen[1])).toEqual([editB]);
  expect(broker.execute).not.toHaveBeenCalled();
});

it('proves an oversized PreToolUse plan against the model input and refuses before PermissionRequest', async () => {
  const { create, seen } = durableHooks(
    {
      [HookEventName.PermissionRequest]: permitB,
      [HookEventName.PreToolUse]: () => undefined,
      [HookEventName.PostToolBatch]: () => undefined,
    },
    HookEventName.PreToolUse,
  );
  turn = createTurn(false, { mode: 'default' }, create());
  const signal = new AbortController().signal;
  const responses = await turn.execute([calls[1]], [parts[1]], 'model', signal);
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    '60 KiB',
  );
  expect(seen.map(({ event }) => event)).toEqual([HookEventName.PostToolBatch]);
  expect(reportedInputs(seen[0])).toEqual([editA]);
  const occurrence = `prompt:${calls[1].callId}`;
  const { plan } = await savedHook(HookEventName.PreToolUse, occurrence);
  expect(plan).toMatchObject({
    toolInputOrder: HOSTED_TOOL_INPUT_ORDER,
    refusedInputDigest: expect.any(String),
  });
  expect(plan['input']).not.toHaveProperty('tool_input');
  expect(
    session.authority.extensionRecord(
      'hook_execution',
      hostedHookOccurrenceId(HookEventName.PermissionRequest, occurrence),
    ),
  ).toBeUndefined();
  expect(actionIds()).toEqual([]);
  expect(broker.prepare).not.toHaveBeenCalled();
  const history = await session.sink.project();
  expect(
    await createTurn(false, { mode: 'default' }, create()).resumeHookResults(
      responses,
      'model',
      signal,
    ),
  ).toEqual(responses);
  expect(seen).toHaveLength(1);
  expect(await session.sink.project()).toEqual(history);
});

// The tool input a managed-tool-input resource carries.
async function toolInputOf(ref: ManagedSessionDurableRef): Promise<unknown> {
  return JSON.parse(
    JSON.parse((await session.resources.read(ref)).toString()).payloadJson,
  ).input;
}

const replaceWith = (updatedInput: unknown) => () => ({
  hookSpecificOutput: { hookEventName: HookEventName.PreToolUse, updatedInput },
});
const allowWith = (updatedInput?: unknown) => () => ({
  hookSpecificOutput: {
    hookEventName: HookEventName.PermissionRequest,
    decision: {
      behavior: 'allow',
      ...(updatedInput === undefined ? {} : { updatedInput }),
    },
  },
});
// What each Hook ran on, in order; a Batch by its one call's input.
const hookInputs = (
  hits: ReadonlyArray<{ event: string; input: Record<string, unknown> }>,
) =>
  hits.map(({ event, input }) => [
    event,
    event === HookEventName.PostToolBatch
      ? reportedInputs({ input })[0]
      : input['tool_input'],
  ]);

it('completes and replays durable Hook results after a live pending approval change', async () => {
  let mode: HostedApprovalMode = 'default';
  const { create, seen } = durableHooks({
    [HookEventName.PreToolUse]: replaceWith(editB),
    [HookEventName.PermissionRequest]: () => undefined,
    [HookEventName.PostToolUse]: () => undefined,
    [HookEventName.PostToolBatch]: () => undefined,
  });
  const approval = {
    mode: 'default' as const,
    readSettings: async () => ({ mode, timeoutMs: 60_000 }),
  };
  turn = createTurn(false, approval, create());
  const controller = new AbortController();
  const { signal } = controller;
  const running = turn.execute([calls[1]], [parts[1]], 'model', signal);
  const settled = running.catch(() => undefined);
  try {
    const requestId = await requested();
    mode = 'yolo';
    const responses = await running;
    expect(session.authority.action(requestId)?.state).toBe('decided');
    expect(broker.execute).toHaveBeenCalledOnce();
    expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual(editB);
    expect(
      seen.find(({ event }) => event === HookEventName.PreToolUse)?.input,
    ).toMatchObject({ permission_mode: 'default' });
    expect(
      seen.find(({ event }) => event === HookEventName.PostToolUse)?.input,
    ).toMatchObject({ permission_mode: 'yolo' });
    const history = await session.sink.project();
    await expect(
      createTurn(false, approval, create()).resumeHookResults(
        responses,
        'model',
        signal,
      ),
    ).resolves.toEqual(responses);
    expect(seen).toHaveLength(4);
    expect(await session.sink.project()).toEqual(history);
    expect(broker.execute).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
    await settled;
  }
});

it('preserves each durable Hook mode when the live selection changes within a batch', async () => {
  let mode: HostedApprovalMode = 'default';
  const { create, seen } = durableHooks({
    [HookEventName.PreToolUse]: () => {
      mode = 'auto-edit';
      return undefined;
    },
    [HookEventName.PostToolUse]: () => undefined,
    [HookEventName.PostToolBatch]: () => undefined,
  });
  const approval = {
    mode: 'default' as const,
    readSettings: async () => ({ mode, timeoutMs: 60_000 }),
  };
  turn = createTurn(false, approval, create());
  const signal = new AbortController().signal;
  const responses = await turn.execute(calls, parts, 'model', signal);
  expect(
    seen
      .filter(({ event }) => event === HookEventName.PreToolUse)
      .map(({ input }) => input['permission_mode']),
  ).toEqual(['default', 'auto-edit']);
  expect(broker.execute).toHaveBeenCalledTimes(2);
  const count = seen.length;
  mode = 'yolo';
  await expect(
    createTurn(false, approval, create()).resumeHookResults(
      responses,
      'model',
      signal,
    ),
  ).resolves.toEqual(responses);
  expect(seen).toHaveLength(count);
  expect(broker.execute).toHaveBeenCalledTimes(2);
});

it('proves a digest-only Hook refusal after the live approval mode changes', async () => {
  let mode: HostedApprovalMode = 'default';
  const { create, seen } = durableHooks(
    {
      [HookEventName.PreToolUse]: replaceWith(editB),
      [HookEventName.PostToolBatch]: () => undefined,
    },
    HookEventName.PreToolUse,
  );
  const hooks = create();
  const fire = hooks.fire.bind(hooks);
  vi.spyOn(hooks, 'fire').mockImplementation(async (...args) => {
    const output = await fire(...args);
    if (args[0] === HookEventName.PreToolUse) mode = 'yolo';
    return output;
  });
  const approval = {
    mode: 'default' as const,
    readSettings: async () => ({ mode, timeoutMs: 60_000 }),
  };
  turn = createTurn(false, approval, hooks);
  const signal = new AbortController().signal;
  const responses = await turn.execute([calls[1]], [parts[1]], 'model', signal);
  expect(responses[0].functionResponse?.response?.['error']).toBeTruthy();
  expect(
    (await savedHook(HookEventName.PreToolUse, `prompt:${calls[1].callId}`))
      .plan,
  ).toHaveProperty('refusedInputDigest');
  expect(broker.execute).not.toHaveBeenCalled();
  await expect(
    createTurn(false, approval, create()).resumeHookResults(
      responses,
      'model',
      signal,
    ),
  ).resolves.toEqual(responses);
  expect(seen).toHaveLength(1);
});

it('runs what a PermissionRequest allow replaced on the input PreToolUse left, without asking', async () => {
  const { create, seen } = durableHooks({
    [HookEventName.PreToolUse]: replaceWith(editB),
    [HookEventName.PermissionRequest]: allowWith(editC),
    [HookEventName.PostToolUse]: () => undefined,
    [HookEventName.PostToolBatch]: () => undefined,
  });
  turn = createTurn(false, { mode: 'default' }, create());
  const signal = new AbortController().signal;
  const responses = await turn.execute([calls[1]], [parts[1]], 'model', signal);
  expect(hookInputs(seen)).toEqual([
    [HookEventName.PreToolUse, editA],
    [HookEventName.PermissionRequest, editB],
    [HookEventName.PostToolUse, editC],
    [HookEventName.PostToolBatch, editC],
  ]);
  expect(actionIds()).toEqual([]);
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual(editC);
  const intent = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .find((event) => event.kind === 'tool.intent')!;
  expect(
    await toolInputOf(
      intent.payload['argsRef'] as unknown as ManagedSessionDurableRef,
    ),
  ).toEqual(editC);
  // Each saved plan names the order and proves the input its Hook ran on.
  const occurrence = `prompt:${calls[1].callId}`;
  for (const [event, input] of [
    [HookEventName.PreToolUse, editA],
    [HookEventName.PermissionRequest, editB],
  ] as const)
    expect((await savedHook(event, occurrence)).plan).toMatchObject({
      toolInputOrder: HOSTED_TOOL_INPUT_ORDER,
      input: { tool_input: input },
    });
  const history = await session.sink.project();
  for (const attempt of [1, 2])
    expect(
      await createTurn(false, { mode: 'default' }, create()).resumeHookResults(
        responses,
        'model',
        signal,
      ),
      `attempt ${attempt}`,
    ).toEqual(responses);
  expect(seen).toHaveLength(4);
  expect(await session.sink.project()).toEqual(history);
  expect(broker.execute).toHaveBeenCalledOnce();
});

it.each(['allow', 'deny', 'expire', 'cancel'] as const)(
  'asks once about the final input a PreToolUse ask still owes after a PermissionRequest allow (%s)',
  async (outcome) => {
    const { create, seen } = durableHooks({
      [HookEventName.PreToolUse]: () => ({
        hookSpecificOutput: {
          hookEventName: HookEventName.PreToolUse,
          permissionDecision: 'ask',
          updatedInput: editB,
        },
      }),
      [HookEventName.PermissionRequest]: allowWith(editC),
      [HookEventName.PostToolUse]: () => undefined,
      [HookEventName.PostToolBatch]: () => undefined,
    });
    turn = createTurn(
      false,
      { mode: 'default', timeoutMs: outcome === 'expire' ? 1_000 : 60_000 },
      create(),
    );
    const controller = new AbortController();
    const running = turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      controller.signal,
    );
    if (outcome === 'expire') await running;
    else {
      const approval = await requested();
      expect(broker.prepare).not.toHaveBeenCalled();
      if (outcome === 'cancel') {
        controller.abort(new Error('turn cancelled'));
        await expect(running).rejects.toThrow('turn cancelled');
      } else {
        await resolveHostedAction(session, waiters, approval, answer(outcome));
        await running;
      }
    }
    const [approval, ...others] = actionIds();
    expect(others).toEqual([]);
    expect(session.authority.action(approval)?.state).toBe(
      outcome === 'expire'
        ? 'expired'
        : outcome === 'cancel'
          ? 'cancelled'
          : 'decided',
    );
    const options = JSON.parse(
      (
        await session.resources.read(
          session.authority.action(approval)!.optionsRef!,
        )
      ).toString(),
    );
    expect(await toolInputOf(options.inputRef)).toEqual(editC);
    expect(hookInputs(seen).slice(0, 2)).toEqual([
      [HookEventName.PreToolUse, editA],
      [HookEventName.PermissionRequest, editB],
    ]);
    expect(broker.execute).toHaveBeenCalledTimes(outcome === 'allow' ? 1 : 0);
    if (outcome === 'allow')
      expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual(editC);
    else expect(broker.prepare).not.toHaveBeenCalled();
  },
);

it('replaces the whole input with each Hook replacement, never merging fields back', async () => {
  const preInput = { file_path: 'b.txt', new_string: 'from PreToolUse' };
  const permissionInput = { file_path: 'c.txt', old_string: 'x' };
  const { create, seen } = durableHooks({
    [HookEventName.PreToolUse]: replaceWith(preInput),
    [HookEventName.PermissionRequest]: allowWith(permissionInput),
    [HookEventName.PostToolUse]: () => undefined,
    [HookEventName.PostToolBatch]: () => undefined,
  });
  turn = createTurn(false, { mode: 'default' }, create());
  await turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  expect(seen[1].input['tool_input']).toEqual(preInput);
  expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual(
    permissionInput,
  );
});

it.each([
  {
    name: 'deny with a replacement',
    output: {
      hookSpecificOutput: {
        decision: { behavior: 'deny', updatedInput: editC },
      },
    },
    refusal: 'PermissionRequest Hook denied the call.',
  },
  {
    name: 'stop with an allowed replacement',
    output: {
      continue: false,
      hookSpecificOutput: {
        decision: { behavior: 'allow', updatedInput: editC },
      },
    },
    refusal: 'PermissionRequest Hook denied the call.',
  },
  {
    name: 'block with an allowed replacement',
    output: {
      decision: 'block',
      hookSpecificOutput: {
        decision: { behavior: 'allow', updatedInput: editC },
      },
    },
    refusal: 'PermissionRequest Hook denied the call.',
  },
  ...[null, 'text', ['x'], 0, false].map((updatedInput) => ({
    name: `allow with updatedInput ${JSON.stringify(updatedInput)}`,
    output: allowWith(updatedInput)(),
    refusal:
      'PermissionRequest Hook allowed the call with an updatedInput that is not a JSON object, so the call did not run.',
  })),
])(
  'refuses a PermissionRequest $name and reports the input PreToolUse left',
  async ({ output, refusal }) => {
    const { create, seen } = durableHooks({
      [HookEventName.PreToolUse]: replaceWith(editB),
      [HookEventName.PermissionRequest]: () => output,
      [HookEventName.PostToolBatch]: () => undefined,
    });
    turn = createTurn(false, { mode: 'default' }, create());
    const signal = new AbortController().signal;
    const responses = await turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toBe(refusal);
    expect(hookInputs(seen)).toEqual([
      [HookEventName.PreToolUse, editA],
      [HookEventName.PermissionRequest, editB],
      [HookEventName.PostToolBatch, editB],
    ]);
    expect(actionIds()).toEqual([]);
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    const history = await session.sink.project();
    expect(
      await createTurn(false, { mode: 'default' }, create()).resumeHookResults(
        responses,
        'model',
        signal,
      ),
    ).toEqual(responses);
    expect(seen).toHaveLength(3);
    expect(await session.sink.project()).toEqual(history);
  },
);

it.each([
  {
    name: 'without updatedInput',
    output: allowWith(),
    runs: editB,
    asks: false,
  },
  {
    name: 'with no allow and a lone updatedInput',
    output: () => ({
      hookSpecificOutput: {
        hookEventName: HookEventName.PermissionRequest,
        decision: { updatedInput: editC },
      },
    }),
    runs: editB,
    asks: true,
  },
])(
  'runs the input PreToolUse left after a PermissionRequest $name',
  async ({ output, runs, asks }) => {
    const { create, seen } = durableHooks({
      [HookEventName.PreToolUse]: replaceWith(editB),
      [HookEventName.PermissionRequest]: output,
      [HookEventName.PostToolUse]: () => undefined,
      [HookEventName.PostToolBatch]: () => undefined,
    });
    turn = createTurn(false, { mode: 'default' }, create());
    const running = turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      new AbortController().signal,
    );
    if (asks) {
      const approval = await requested();
      expect(
        await toolInputOf((await checkpoint()).approval!.invocationRef!),
      ).toEqual(runs);
      await resolveHostedAction(session, waiters, approval, answer('allow'));
    }
    await running;
    expect(actionIds()).toHaveLength(asks ? 1 : 0);
    expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual(runs);
    expect(hookInputs(seen).slice(2)).toEqual([
      [HookEventName.PostToolUse, runs],
      [HookEventName.PostToolBatch, runs],
    ]);
  },
);

it.each([
  {
    name: 'PreToolUse',
    pre: replaceWith({ ...editB, file_path: '../outside' }),
    permission: allowWith(editC),
    events: [HookEventName.PreToolUse, HookEventName.PostToolBatch],
    reported: { ...editB, file_path: '../outside' },
  },
  {
    name: 'PermissionRequest',
    pre: replaceWith(editB),
    permission: allowWith({ ...editC, file_path: '../outside' }),
    events: [
      HookEventName.PreToolUse,
      HookEventName.PermissionRequest,
      HookEventName.PostToolBatch,
    ],
    reported: { ...editC, file_path: '../outside' },
  },
])(
  'refuses an object a $name Hook left that fails admission, never running an earlier input',
  async ({ pre, permission, events, reported }) => {
    const { create, seen } = durableHooks({
      [HookEventName.PreToolUse]: pre,
      [HookEventName.PermissionRequest]: permission,
      [HookEventName.PostToolUse]: () => undefined,
      [HookEventName.PostToolBatch]: () => undefined,
    });
    turn = createTurn(false, { mode: 'default' }, create());
    const responses = await turn.execute(
      [calls[1]],
      [parts[1]],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toContain(
      'relative to the saved Session working directory',
    );
    expect(seen.map(({ event }) => event)).toEqual(events);
    expect(reportedInputs(seen.at(-1))).toEqual([reported]);
    expect(actionIds()).toEqual([]);
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it('refuses a Hook replacement whose encoding exceeds the inline Session Store limit', async () => {
  const large = { ...editC, new_string: '"'.repeat(20_000) };
  const { create, seen } = durableHooks({
    [HookEventName.PreToolUse]: replaceWith(editB),
    [HookEventName.PermissionRequest]: allowWith(large),
    [HookEventName.PostToolBatch]: () => undefined,
  });
  turn = createTurn(false, { mode: 'default' }, create());
  const responses = await turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'inline Session Store limit',
  );
  expect(reportedInputs(seen.at(-1))).toEqual([large]);
  expect(broker.prepare).not.toHaveBeenCalled();
  // The refusal settles the call; the Turn itself never needs recovery.
  expect(await toolResultErrors()).toEqual([
    expect.stringContaining('inline Session Store limit'),
  ]);
});

it.each([
  { mode: 'yolo', call: 1, pre: undefined, permission: false, asks: false },
  { mode: 'yolo', call: 1, pre: 'ask', permission: false, asks: true },
  { mode: 'default', call: 0, pre: undefined, permission: false, asks: false },
  { mode: 'default', call: 0, pre: 'allow', permission: false, asks: false },
  { mode: 'default', call: 0, pre: 'ask', permission: false, asks: true },
  { mode: 'default', call: 1, pre: undefined, permission: true, asks: true },
  { mode: 'default', call: 1, pre: 'allow', permission: true, asks: true },
  {
    mode: 'default',
    call: 1,
    pre: undefined,
    permission: true,
    allow: true,
    asks: false,
  },
  {
    mode: 'default',
    call: 1,
    pre: 'ask',
    permission: true,
    allow: true,
    asks: true,
  },
  {
    mode: 'auto-edit',
    call: 1,
    pre: undefined,
    permission: false,
    asks: false,
  },
  { mode: 'auto-edit', call: 1, pre: 'ask', permission: false, asks: true },
] as const)(
  'keeps who is asked in $mode mode for call $call (PreToolUse $pre, PermissionRequest allow $allow)',
  async ({ mode, call, pre, permission, asks, ...rest }) => {
    const allow = 'allow' in rest;
    const { create, seen } = durableHooks({
      [HookEventName.PreToolUse]: () =>
        pre && {
          hookSpecificOutput: {
            hookEventName: HookEventName.PreToolUse,
            permissionDecision: pre,
          },
        },
      [HookEventName.PermissionRequest]: allow ? allowWith() : () => undefined,
      [HookEventName.PostToolUse]: () => undefined,
    });
    turn = createTurn(false, { mode }, create());
    const running = turn.execute(
      [calls[call]],
      [parts[call]],
      'model',
      new AbortController().signal,
    );
    if (asks)
      await resolveHostedAction(
        session,
        waiters,
        await requested(),
        answer('allow'),
      );
    await running;
    expect(
      seen.filter(({ event }) => event === HookEventName.PermissionRequest),
    ).toHaveLength(permission ? 1 : 0);
    expect(actionIds()).toHaveLength(asks ? 1 : 0);
    expect(broker.execute).toHaveBeenCalledOnce();
  },
);

it('refuses a PreToolUse ask when the Session has no approval policy', async () => {
  const { create, seen } = durableHooks({
    [HookEventName.PreToolUse]: () => ({
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecision: 'ask',
      },
    }),
    [HookEventName.PermissionRequest]: allowWith(),
  });
  turn = createTurn(false, undefined, create());
  const responses = await turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toBe(
    'Hook requires approval, but no approval policy is available.',
  );
  expect(seen.map(({ event }) => event)).toEqual([HookEventName.PreToolUse]);
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('refuses the call when the turn is cancelled during its PermissionRequest', async () => {
  const controller = new AbortController();
  const { create, seen } = durableHooks({
    [HookEventName.PreToolUse]: replaceWith(editB),
    [HookEventName.PermissionRequest]: () => {
      controller.abort(new Error('turn cancelled'));
      return allowWith(editC)();
    },
  });
  turn = createTurn(false, { mode: 'default' }, create());
  await expect(
    turn.execute([calls[1]], [parts[1]], 'model', controller.signal),
  ).rejects.toThrow('turn cancelled');
  expect(seen.map(({ event }) => event)).toEqual([
    HookEventName.PreToolUse,
    HookEventName.PermissionRequest,
  ]);
  expect(await toolResultErrors()).toEqual([
    'PermissionRequest Hook denied the call.',
  ]);
  expect(actionIds()).toEqual([]);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
});

it('proves an oversized PermissionRequest plan against the input PreToolUse left', async () => {
  const { create, seen } = durableHooks(
    {
      [HookEventName.PreToolUse]: replaceWith(editB),
      [HookEventName.PermissionRequest]: allowWith(editC),
      [HookEventName.PostToolBatch]: () => undefined,
    },
    HookEventName.PermissionRequest,
  );
  turn = createTurn(false, { mode: 'default' }, create());
  const signal = new AbortController().signal;
  const responses = await turn.execute([calls[1]], [parts[1]], 'model', signal);
  expect(responses[0].functionResponse?.response?.['error']).toBe(
    'PermissionRequest Hook denied the call.',
  );
  expect(hookInputs(seen)).toEqual([
    [HookEventName.PreToolUse, editA],
    [HookEventName.PostToolBatch, editB],
  ]);
  const { plan } = await savedHook(
    HookEventName.PermissionRequest,
    `prompt:${calls[1].callId}`,
  );
  expect(plan).toMatchObject({
    toolInputOrder: HOSTED_TOOL_INPUT_ORDER,
    refusedInputDigest: expect.any(String),
  });
  expect(broker.prepare).not.toHaveBeenCalled();
  const history = await session.sink.project();
  expect(
    await createTurn(false, { mode: 'default' }, create()).resumeHookResults(
      responses,
      'model',
      signal,
    ),
  ).toEqual(responses);
  expect(seen).toHaveLength(2);
  expect(await session.sink.project()).toEqual(history);
});

it('binds an MCP call to the arguments its Hooks left and renews only its grant', async () => {
  let expiresAt = 1;
  const toolInput = vi.fn(
    (_name: string, args: Record<string, unknown>, runtimeCallId: string) => ({
      toolName: 'managed_mcp_call',
      input: {
        server: 'echo',
        arguments: args,
        grant: { expiresAt, runtimeCallId },
      },
    }),
  );
  const mcp = {
    broker,
    ensureReady: async () => undefined,
    refresh: async () => undefined,
    tools: () => [
      { name: 'mcp_echo', parametersJsonSchema: { type: 'object' } },
    ],
    toolInput,
  };
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) => {
      if (event === HookEventName.PreToolUse)
        return replaceWith({ text: 'B' })();
      if (event !== HookEventName.PermissionRequest) return undefined;
      expiresAt = 2;
      return allowWith({ text: 'C' })();
    });
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
      hooks: hookSession(fire),
    },
  );
  const call = { ...calls[0], name: 'mcp_echo', args: { text: 'A' } };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(
    fire.mock.calls
      .slice(0, 2)
      .map(([event, , fields]) => [event, fields['tool_input']]),
  ).toEqual([
    [HookEventName.PreToolUse, { text: 'A' }],
    [HookEventName.PermissionRequest, { text: 'B' }],
  ]);
  expect(actionIds()).toEqual([]);
  expect(broker.execute).toHaveBeenCalledOnce();
  const payload = JSON.parse(broker.execute.mock.calls[0][1]);
  const final = toolInput.mock.calls.at(-1)!;
  expect(final[1]).toEqual({ text: 'C' });
  expect(payload).toEqual({
    toolName: 'managed_mcp_call',
    input: {
      server: 'echo',
      arguments: { text: 'C' },
      grant: { expiresAt: 2, runtimeCallId: final[2] },
    },
  });
});

// Saves one call's earlier-order records: PermissionRequest on the model's
// input, then, unless it refused, PreToolUse on what it left. The call was
// refused, so only the Batch follows on a resume.
async function saveEarlierOrder(
  permission: () => unknown,
  pre?: () => unknown,
) {
  const { create, seen } = durableHooks({
    [HookEventName.PermissionRequest]: permission,
    ...(pre ? { [HookEventName.PreToolUse]: pre } : {}),
    [HookEventName.PostToolBatch]: () => undefined,
  });
  const hooks = create();
  const signal = new AbortController().signal;
  const occurrence = `prompt:${calls[1].callId}`;
  await commit('assistant', [parts[1]], 'model');
  const decided = await hooks.fire(
    HookEventName.PermissionRequest,
    occurrence,
    {
      tool_name: calls[1].name,
      tool_input: editA,
      tool_use_id: calls[1].callId,
      prompt_id: 'prompt',
    },
    signal,
  );
  if (pre)
    await hooks.fire(
      HookEventName.PreToolUse,
      occurrence,
      {
        tool_name: calls[1].name,
        tool_input:
          (
            decided?.hookSpecificOutput?.['decision'] as
              | { updatedInput?: unknown }
              | undefined
          )?.updatedInput ?? editA,
        tool_use_id: calls[1].callId,
        permission_mode: 'default',
        prompt_id: 'prompt',
      },
      signal,
    );
  const refused = convertToFunctionErrorResponse(
    calls[1].name,
    calls[1].callId,
    [],
    'refused',
  );
  await commit('tool_result', refused, 'model');
  return { create, seen, signal, occurrence, refused };
}

it.each([
  {
    name: 'a PermissionRequest deny with a replacement and no PreToolUse',
    permission: () => ({
      hookSpecificOutput: {
        decision: { behavior: 'deny', updatedInput: editC },
      },
    }),
    reported: editA,
  },
  {
    name: 'a PreToolUse on a PermissionRequest replacement',
    permission: permitB,
    pre: () => undefined,
    reported: editB,
  },
  {
    name: 'an unusable PreToolUse replacement on a PermissionRequest replacement',
    permission: permitB,
    pre: replaceWith('text'),
    reported: editB,
  },
])(
  'reads $name the earlier order saved by its own rules',
  async ({ permission, pre, reported }) => {
    const { create, seen, signal, refused } = await saveEarlierOrder(
      permission,
      pre,
    );
    const dispatched = seen.length;
    for (const attempt of [1, 2])
      expect(
        await createTurn(
          false,
          { mode: 'default' },
          create(),
        ).resumeHookResults(refused, 'model', signal),
        `attempt ${attempt}`,
      ).toEqual(refused);
    expect(seen).toHaveLength(dispatched + 1);
    expect(hookInputs(seen.slice(dispatched))).toEqual([
      [HookEventName.PostToolBatch, reported],
    ]);
  },
);

it.each([
  {
    name: 'an unknown order',
    save: async (fire: SaveHook) => {
      await fire(HookEventName.PreToolUse, editA, 'pre-permission/1');
    },
    cause: 'Tool Hook records do not share a known order.',
  },
  {
    name: 'a new PreToolUse beside an earlier PermissionRequest',
    save: async (fire: SaveHook) => {
      await fire(HookEventName.PermissionRequest, editA);
      await fire(HookEventName.PreToolUse, editA, HOSTED_TOOL_INPUT_ORDER);
    },
    cause: 'Tool Hook records do not share a known order.',
  },
  {
    name: 'a new PermissionRequest beside an earlier PreToolUse',
    save: async (fire: SaveHook) => {
      await fire(HookEventName.PreToolUse, editA);
      await fire(
        HookEventName.PermissionRequest,
        editA,
        HOSTED_TOOL_INPUT_ORDER,
      );
    },
    cause: 'Tool Hook records do not share a known order.',
  },
  {
    name: 'a new PermissionRequest without its PreToolUse',
    save: async (fire: SaveHook) => {
      await fire(
        HookEventName.PermissionRequest,
        editA,
        HOSTED_TOOL_INPUT_ORDER,
      );
    },
    cause: 'PreToolUse record does not match its tool call.',
  },
  {
    name: 'a new PreToolUse on another input',
    save: async (fire: SaveHook) => {
      await fire(HookEventName.PreToolUse, editB, HOSTED_TOOL_INPUT_ORDER);
    },
    cause: 'PreToolUse record does not match its tool call.',
  },
  {
    name: 'a new PermissionRequest on another input than PreToolUse left',
    save: async (fire: SaveHook) => {
      await fire(HookEventName.PreToolUse, editA, HOSTED_TOOL_INPUT_ORDER);
      await fire(
        HookEventName.PermissionRequest,
        editB,
        HOSTED_TOOL_INPUT_ORDER,
      );
    },
    cause: 'PermissionRequest record does not match its PreToolUse result.',
  },
  {
    name: 'a new PermissionRequest after a refusing PreToolUse',
    deny: true,
    save: async (fire: SaveHook) => {
      await fire(HookEventName.PreToolUse, editA, HOSTED_TOOL_INPUT_ORDER);
      await fire(
        HookEventName.PermissionRequest,
        editA,
        HOSTED_TOOL_INPUT_ORDER,
      );
    },
    cause: 'PermissionRequest record does not match its PreToolUse result.',
  },
])(
  'refuses to read $name rather than guess its input',
  async ({ save, cause, ...rest }) => {
    const { create, seen } = durableHooks({
      [HookEventName.PreToolUse]: () =>
        'deny' in rest
          ? {
              hookSpecificOutput: {
                hookEventName: HookEventName.PreToolUse,
                permissionDecision: 'deny',
              },
            }
          : undefined,
      [HookEventName.PermissionRequest]: allowWith(editC),
      [HookEventName.PostToolBatch]: () => undefined,
    });
    const hooks = create();
    const signal = new AbortController().signal;
    await commit('assistant', [parts[1]], 'model');
    await save((event, input, order) =>
      hooks.fire(
        event,
        `prompt:${calls[1].callId}`,
        {
          tool_name: calls[1].name,
          tool_input: input,
          tool_use_id: calls[1].callId,
          ...(event === HookEventName.PreToolUse
            ? { permission_mode: 'default' }
            : {}),
          prompt_id: 'prompt',
        },
        signal,
        undefined,
        undefined,
        order as typeof HOSTED_TOOL_INPUT_ORDER | undefined,
      ),
    );
    const refused = convertToFunctionErrorResponse(
      calls[1].name,
      calls[1].callId,
      [],
      'refused',
    );
    await commit('tool_result', refused, 'model');
    const dispatched = seen.length;
    const history = await session.sink.project();
    await expect(
      createTurn(false, { mode: 'default' }, create()).resumeHookResults(
        refused,
        'model',
        signal,
      ),
    ).rejects.toMatchObject({ cause });
    expect(seen).toHaveLength(dispatched);
    expect(await session.sink.project()).toEqual(history);
    expect(
      session.authority.extensionRecord(
        'hook_execution',
        hostedHookOccurrenceId(
          HookEventName.PostToolBatch,
          `prompt:${calls[1].callId}`,
        ),
      ),
    ).toBeUndefined();
  },
);

type SaveHook = (
  event: HookEventName,
  input: Record<string, unknown>,
  order?: string,
) => Promise<unknown>;

it('refuses to guess an oversized PreToolUse input no saved record reproduces', async () => {
  const { create, seen } = durableHooks(
    {
      [HookEventName.PreToolUse]: () => undefined,
      [HookEventName.PostToolBatch]: () => undefined,
    },
    HookEventName.PreToolUse,
  );
  const signal = new AbortController().signal;
  await commit('assistant', [parts[1]], 'model');
  // PreToolUse ran on a replacement whose PermissionRequest record is gone.
  await create().fire(
    HookEventName.PreToolUse,
    `prompt:${calls[1].callId}`,
    {
      tool_name: calls[1].name,
      tool_input: editB,
      tool_use_id: calls[1].callId,
      permission_mode: 'default',
      prompt_id: 'prompt',
    },
    signal,
  );
  const refused = convertToFunctionErrorResponse(
    calls[1].name,
    calls[1].callId,
    [],
    'Hook data exceeds the 60 KiB resource or 8 MiB control/transaction limit.',
  );
  await commit('tool_result', refused, 'model');
  const history = await session.sink.project();
  await expect(
    createTurn(false, { mode: 'default' }, create()).resumeHookResults(
      refused,
      'model',
      signal,
    ),
  ).rejects.toMatchObject({
    cause: 'PreToolUse record does not match its tool call.',
  });
  expect(seen).toEqual([]);
  expect(await session.sink.project()).toEqual(history);
});

// Saves what an earlier release left of a refused call: PermissionRequest
// replaced A with B, PreToolUse denied B with a replacement C, and the
// refusal was committed. That release then reported C in the Batch.
async function saveRefusedCall(oversized: boolean) {
  const { create, seen } = durableHooks(
    {
      [HookEventName.PermissionRequest]: permitB,
      [HookEventName.PreToolUse]: () => ({
        hookSpecificOutput: { permissionDecision: 'deny', updatedInput: editC },
      }),
      [HookEventName.PostToolBatch]: () => ({
        hookSpecificOutput: { additionalContext: 'batch reviewed' },
      }),
    },
    oversized ? HookEventName.PostToolBatch : undefined,
  );
  const hooks = create();
  const signal = new AbortController().signal;
  const occurrence = `prompt:${calls[1].callId}`;
  await commit('assistant', [parts[1]], 'model');
  await hooks.fire(
    HookEventName.PermissionRequest,
    occurrence,
    {
      tool_name: calls[1].name,
      tool_input: editA,
      tool_use_id: calls[1].callId,
      prompt_id: 'prompt',
    },
    signal,
  );
  await hooks.fire(
    HookEventName.PreToolUse,
    occurrence,
    {
      tool_name: calls[1].name,
      tool_input: editB,
      tool_use_id: calls[1].callId,
      permission_mode: 'default',
      prompt_id: 'prompt',
    },
    signal,
  );
  const refused = convertToFunctionErrorResponse(
    calls[1].name,
    calls[1].callId,
    [],
    'No reason provided',
  );
  await commit('tool_result', refused, 'model');
  const batch = (call: Record<string, unknown>) => ({
    tool_calls: [
      {
        tool_name: calls[1].name,
        tool_input: editC,
        tool_use_id: calls[1].callId,
        status: 'error',
        tool_response: refused[0].functionResponse!.response,
        ...call,
      },
    ],
    permission_mode: 'default',
    prompt_id: 'prompt',
  });
  return { create, seen, hooks, signal, occurrence, refused, batch };
}

async function toolResultParts(): Promise<Part[]> {
  return (await session.sink.project())
    .filter((entry) => entry.type === 'tool_result')
    .flatMap((entry) => entry.message?.parts ?? []);
}

it.each([false, true])(
  'replays a Batch an earlier release saved on a refused replacement (oversized: %s)',
  async (oversized) => {
    const { create, seen, hooks, signal, occurrence, refused, batch } =
      await saveRefusedCall(oversized);
    await hooks.fire(
      HookEventName.PostToolBatch,
      occurrence,
      batch({}),
      signal,
    );
    const saved = await savedHook(HookEventName.PostToolBatch, occurrence);
    if (oversized) {
      expect(saved.plan['refusedInputDigest']).toEqual(expect.any(String));
      expect(saved.plan['input']).not.toHaveProperty('tool_calls');
    } else expect(saved.plan['input']).toMatchObject(batch({}));
    const dispatched = seen.length;
    const before = await session.sink.project();
    for (const attempt of [1, 2]) {
      const restored = createTurn(false, { mode: 'default' }, create());
      expect(
        await restored.resumeHookResults(
          await toolResultParts(),
          'model',
          signal,
        ),
        `attempt ${attempt}`,
      ).toEqual(
        oversized
          ? JSON.parse(JSON.stringify(refused))
          : [
              ...JSON.parse(JSON.stringify(refused)),
              { text: 'batch reviewed' },
            ],
      );
      if (oversized) expect(restored.hookStopReason).toContain('60 KiB');
      expect(seen).toHaveLength(dispatched);
    }
    expect(await savedHook(HookEventName.PostToolBatch, occurrence)).toEqual(
      saved,
    );
    expect(
      (await session.sink.project())
        .filter((entry) => !before.some((record) => record.uuid === entry.uuid))
        .map((entry) => entry.message?.parts),
    ).toEqual(oversized ? [] : [[{ text: 'batch reviewed' }]]);
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it.each([
  { name: 'the model input', call: { tool_input: editA } },
  { name: 'another call id', call: { tool_use_id: 'other-call' } },
  { name: 'another status', call: { status: 'success' } },
  { name: 'another response', call: { tool_response: { output: 'ran' } } },
])(
  'keeps an oversized saved Batch planned for $name in recovery',
  async ({ call }) => {
    const { create, seen, hooks, signal, occurrence, refused, batch } =
      await saveRefusedCall(true);
    await hooks.fire(
      HookEventName.PostToolBatch,
      occurrence,
      batch(call),
      signal,
    );
    const saved = await savedHook(HookEventName.PostToolBatch, occurrence);
    expect(saved.plan['refusedInputDigest']).toEqual(expect.any(String));
    const dispatched = seen.length;
    const history = await session.sink.project();
    await expect(
      createTurn(false, { mode: 'default' }, create()).resumeHookResults(
        refused,
        'model',
        signal,
      ),
    ).rejects.toThrow('Hook occurrence input conflict');
    expect(seen).toHaveLength(dispatched);
    expect(await session.sink.project()).toEqual(history);
    expect(await savedHook(HookEventName.PostToolBatch, occurrence)).toEqual(
      saved,
    );
  },
);

it.each([
  { order: 'earlier', replays: true },
  { order: 'pre-permission', replays: false },
] as const)(
  'replays a PostToolUse an earlier release saved on an unusable replacement only for the earlier order ($order)',
  async ({ order, replays }) => {
    const { create, seen } = durableHooks({
      [HookEventName.PreToolUse]: () => ({
        hookSpecificOutput: { updatedInput: 'text' },
      }),
      [HookEventName.PostToolUse]: () => ({
        hookSpecificOutput: { additionalContext: 'after tool' },
      }),
      [HookEventName.PostToolBatch]: () => undefined,
    });
    const hooks = create();
    const fire = hooks.fire.bind(hooks);
    vi.spyOn(hooks, 'fire').mockImplementation(
      (
        event,
        occurrenceId,
        fields,
        hookSignal,
        prompt,
        earlier,
        toolInputOrder,
      ) =>
        event === HookEventName.PostToolUse
          ? Promise.reject(new Error('Harness lost'))
          : // The earlier release saved its PreToolUse plan without an order.
            fire(
              event,
              occurrenceId,
              fields,
              hookSignal,
              prompt,
              earlier,
              order === 'earlier' ? undefined : toolInputOrder,
            ),
    );
    turn = createTurn(false, { mode: 'yolo' }, hooks);
    const signal = new AbortController().signal;
    await expect(
      turn.execute([calls[0]], [parts[0]], 'model', signal),
    ).rejects.toThrow('Harness lost');
    const saved = await toolResultParts();
    // The earlier release reported the raw replacement as the call's input.
    await create().fire(
      HookEventName.PostToolUse,
      `prompt:${calls[0].callId}`,
      {
        tool_name: calls[0].name,
        tool_input: 'text',
        tool_use_id: calls[0].callId,
        tool_response: saved[0].functionResponse!.response,
        permission_mode: 'yolo',
        prompt_id: 'prompt',
      },
      signal,
    );
    const resumed = createTurn(false, { mode: 'yolo' }, create());
    if (!replays) {
      // A call whose Hooks ran in the new order never had that reading.
      const history = await session.sink.project();
      await expect(
        resumed.resumeHookResults(saved, 'model', signal),
      ).rejects.toThrow('Hook occurrence input conflict');
      expect(await session.sink.project()).toEqual(history);
      expect(seen.map(({ event }) => event)).toEqual([
        HookEventName.PreToolUse,
        HookEventName.PostToolUse,
      ]);
      return;
    }
    expect(await resumed.resumeHookResults(saved, 'model', signal)).toEqual([
      ...saved,
      { text: 'after tool' },
    ]);
    expect(seen.map(({ event }) => event)).toEqual([
      HookEventName.PreToolUse,
      HookEventName.PostToolUse,
      HookEventName.PostToolBatch,
    ]);
    expect(reportedInputs(seen[2])).toEqual([calls[0].args]);
    expect(broker.execute).toHaveBeenCalledOnce();
  },
);

it('persists the prepared history before effects and settled history before continuation', async () => {
  broker.execute.mockImplementation(async () => {
    expect((await readHostedFileHistory(session))?.pendingTurn).toBe('prompt');
    return { executionStatus: 'success', responseParts: [{ text: 'written' }] };
  });
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  expect((await readHostedFileHistory(session))?.pendingTurn).toBeNull();
  const projected = await readManagedSessionRecords({
    runtimeBaseDir: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionKey: session.authority.sessionHeader.sessionKey,
  });
  expect(
    projected.filter((record) => record.subtype === 'file_history_snapshot'),
  ).toHaveLength(2);
  expect(
    broker.fileHistory.mock.calls.map(([operation]) => operation.action),
  ).toEqual(['bind', 'prepare', 'snapshot']);
});

it.each(['pendingTurn', 'pendingUndo'] as const)(
  'refuses a fresh turn with durable %s before binding or dispatching',
  async (pending) => {
    await commit('assistant', [{ text: 'previous turn' }], 'model');
    await commitHostedFileHistory(session, {
      schemaVersion: 1,
      state: {
        ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
        snapshots: [],
        files: {},
      },
      pendingTurn: pending === 'pendingTurn' ? 'previous-prompt' : null,
      pendingUndo:
        pending === 'pendingUndo'
          ? { requestId: randomUUID(), promptId: randomUUID() }
          : null,
    });
    const saved = await readHostedFileHistory(session);
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(broker.acquire).toHaveBeenCalledOnce();
    expect(broker.fileHistory).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.release).not.toHaveBeenCalled();
    expect(await readHostedFileHistory(session)).toEqual(saved);
  },
);

it('persists capacity refusals without dispatch or pending history and releases the runtime', async () => {
  const names = Array.from(
    { length: 160 },
    (_, index) => `${index}-${'x'.repeat(60)}.txt`,
  );
  broker.fileHistory.mockImplementation(async (operation) => ({
    ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
    snapshots:
      operation.action === 'prepare'
        ? [
            {
              promptId: 'prompt',
              timestamp: '2026-09-30T00:00:00.000Z',
              trackedFileBackups: Object.fromEntries(
                names.map((file) => [
                  file,
                  {
                    backupFileName: null,
                    version: 1,
                    backupTime: '2026-09-30T00:00:00.000Z',
                  },
                ]),
              ),
            },
          ]
        : [],
    files:
      operation.action === 'prepare'
        ? Object.fromEntries(names.map((file) => [file, null]))
        : {},
  }));
  const responses = await turn.execute(
    [calls[1]],
    [parts[1]],
    'model',
    new AbortController().signal,
  );
  expect(JSON.stringify(responses)).toContain('capacity is exhausted');
  expect(
    broker.fileHistory.mock.calls.map(([operation]) => operation.action),
  ).toEqual(['bind', 'prepare']);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(await readHostedFileHistory(session)).toBeUndefined();
  expect(
    (await session.sink.project())
      .filter((record) => record.type === 'tool_result')
      .flatMap((record) => record.message?.parts ?? []),
  ).toEqual(JSON.parse(JSON.stringify(responses)));
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it.each(['backup', 'persistence'])(
  'never dispatches when prepared-history %s fails',
  async (failure) => {
    if (failure === 'persistence')
      vi.spyOn(session.authority, 'commitDomainRecord').mockRejectedValueOnce(
        new Error('history persistence unavailable'),
      );
    broker.fileHistory.mockImplementation(async (operation) => {
      if (failure === 'backup' && operation.action === 'prepare')
        throw new Error('backup unavailable');
      return {
        ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
        snapshots: [],
        files: {},
      };
    });
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(broker.execute).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
  },
);

it('keeps a durable pending history when post-execution settlement fails', async () => {
  broker.fileHistory.mockImplementation(async (operation) => {
    if (operation.action === 'snapshot')
      throw new Error('history response lost');
    return {
      ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
      snapshots: [],
      files: {},
    };
  });
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.execute).toHaveBeenCalledTimes(2);
  expect((await readHostedFileHistory(session))?.pendingTurn).toBe('prompt');
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(broker.release).not.toHaveBeenCalled();
});

it.each([false, true])(
  'settles a definite preparation refusal (mixed batch: %s)',
  async (mixed) => {
    broker.fileHistory.mockImplementation(async (operation) => {
      if (operation.action === 'prepare')
        throw new HostedWorkspaceBrokerRejection(
          409,
          'managed_runtime_provider_operation_failed',
          undefined,
          'ordinary files only',
        );
      return {
        ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
        snapshots: [],
        files: {},
      };
    });
    const responses = await turn.execute(
      mixed ? calls : [calls[1]],
      mixed ? parts : [parts[1]],
      'model',
      new AbortController().signal,
    );
    expect(JSON.stringify(responses)).toContain('ordinary files only');
    expect(broker.prepare).toHaveBeenCalledTimes(mixed ? 1 : 0);
    expect(broker.execute).toHaveBeenCalledTimes(mixed ? 1 : 0);
    expect(await readHostedFileHistory(session)).toBeUndefined();
    expect(
      (await session.sink.project())
        .filter((record) => record.type === 'tool_result')
        .flatMap((record) => record.message?.parts ?? []),
    ).toEqual(JSON.parse(JSON.stringify(responses)));
    if (mixed) await turn.consumeResults();
    await turn.finish();
    expect(broker.release).toHaveBeenCalledOnce();
  },
);

it.each([
  [409, 'managed_runtime_provider_operation_failed'],
  [400, 'runtime_control_operation_invalid'],
] as const)(
  'releases a definite bind rejection %s %s without blocking',
  async (status, code) => {
    broker.fileHistory.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(status, code),
    );
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toThrow('Runtime Broker returned HTTP');
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await expect(turn.finish()).resolves.toBeUndefined();
    expect(broker.release).toHaveBeenCalledOnce();
    expect(await session.sink.project()).toEqual([]);
  },
);

it.each(['bind', 'prepare', 'release', 'store'] as const)(
  'keeps uncertain history %s failures blocked',
  async (phase) => {
    if (phase === 'store') {
      vi.spyOn(session.authority, 'commitDomainRecord').mockRejectedValueOnce(
        new ManagedSessionStoreHttpError(
          503,
          'store_unavailable',
          'commit outcome unknown',
        ),
      );
    } else {
      broker.fileHistory.mockImplementation(async (operation) => {
        if (
          operation.action === phase ||
          (phase === 'release' && operation.action === 'bind')
        )
          throw new HostedWorkspaceBrokerRejection(
            phase === 'release' ? 409 : 503,
            'managed_runtime_provider_operation_failed',
          );
        return {
          ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
          snapshots: [],
          files: {},
        };
      });
      if (phase === 'release')
        broker.release.mockRejectedValueOnce(
          new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
        );
    }
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.execute).not.toHaveBeenCalled();
    expect(broker.release).toHaveBeenCalledTimes(phase === 'release' ? 1 : 0);
  },
);

it.each([false, true])(
  'settles definite reservation conflicts (mixed: %s)',
  async (mixed) => {
    if (mixed) broker.prepare.mockResolvedValueOnce('read-execution');
    broker.prepare.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(
        409,
        'runtime_execution_conflict',
        undefined,
        'execution identity already in use',
      ),
    );
    const responses = await turn.execute(
      mixed ? calls : [calls[1]],
      mixed ? parts : [parts[1]],
      'model',
      new AbortController().signal,
    );
    expect(JSON.stringify(responses)).toContain('before dispatch');
    expect(broker.execute).toHaveBeenCalledTimes(mixed ? 1 : 0);
    expect((await readHostedFileHistory(session))?.pendingTurn).toBeNull();
    if (mixed) await turn.consumeResults();
    await turn.finish();
    expect(broker.release).toHaveBeenCalledOnce();
  },
);

it('recovers settled file history by observing the original runtime without rebinding or executing', async () => {
  broker.fileHistory.mockImplementation(async (operation) => {
    if (operation.action === 'snapshot') throw new Error('response lost');
    return {
      ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
      snapshots: [],
      files: {},
    };
  });
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  const saved = await readHostedFileHistory(session);
  expect(saved?.pendingMessageId).toEqual(
    (await session.sink.project()).find((item) => item.type === 'assistant')
      ?.uuid,
  );
  broker.fileHistory.mockResolvedValue(saved!.state);
  broker.fileHistory.mockClear();
  broker.execute.mockClear();
  const recovered = createTurn();
  await recovered.resumeCommittedResults();
  expect(
    broker.fileHistory.mock.calls.map(([operation]) => operation.action),
  ).toEqual(['snapshot']);
  expect(broker.execute).not.toHaveBeenCalled();
  expect((await readHostedFileHistory(session))?.pendingTurn).toBeNull();
  expect(
    (await readHostedFileHistory(session))?.pendingMessageId,
  ).toBeUndefined();
  await recovered.consumeResults();
  await recovered.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it.each([
  'previous-batch',
  'missing-message-id',
  'incomplete-results',
  'changed-snapshots',
  'missing-runtime',
  'stranger-turn',
])('does not clear pending history for %s', async (failure) => {
  broker.fileHistory.mockImplementation(async (operation) => {
    if (operation.action === 'snapshot') throw new Error('response lost');
    return {
      ownerSessionId: session.authority.sessionHeader.sessionKey.sessionId,
      snapshots: [],
      files: {},
    };
  });
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  const saved = (await readHostedFileHistory(session))!;
  if (failure === 'previous-batch')
    saved.pendingMessageId = await commit('assistant', parts, 'model');
  if (failure === 'missing-message-id') delete saved.pendingMessageId;
  if (failure === 'stranger-turn') saved.pendingTurn = 'stranger';
  if (failure === 'incomplete-results') {
    const project = session.sink.project.bind(session.sink);
    vi.spyOn(session.sink, 'project').mockImplementation(async (...args) => {
      const records = await project(...args);
      const lastResult = records.findLastIndex(
        (item) => item.type === 'tool_result',
      );
      return records.filter((_, index) => index !== lastResult);
    });
  }
  await commitHostedFileHistory(session, saved);
  broker.fileHistory.mockResolvedValue(
    failure === 'changed-snapshots'
      ? { ...saved.state, snapshots: [{ promptId: 'unexpected' }] }
      : saved.state,
  );
  if (failure === 'missing-runtime')
    broker.fileHistory.mockRejectedValue(
      new HostedWorkspaceBrokerRejection(
        409,
        'managed_runtime_provider_operation_failed',
      ),
    );
  broker.fileHistory.mockClear();
  const recovered = createTurn();
  const rejection: unknown = await recovered
    .resumeCommittedResults()
    .catch((cause: unknown) => cause);
  expect(rejection).toBeInstanceOf(HostedToolRecoveryRequiredError);
  // The settle ground must reach the cause message, or the one site that
  // blocks a live Turn drops the sub-cause it had in hand.
  const grounds: Record<string, HostedFileHistorySettleBlocker> = {
    'previous-batch': 'pending_message_not_ready',
    'missing-message-id': 'no_pending_message',
    'incomplete-results': 'tool_results_mismatch',
    'stranger-turn': 'pending_turn_mismatch',
  };
  const ground = grounds[failure];
  if (ground !== undefined) {
    const cause = (rejection as HostedToolRecoveryRequiredError).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain(
      `Hosted file history requires recovery: ${ground}.`,
    );
  }
  expect((await readHostedFileHistory(session))?.pendingTurn).toBe(
    failure === 'stranger-turn' ? 'stranger' : 'prompt',
  );
  expect(broker.release).not.toHaveBeenCalled();
  if (
    [
      'previous-batch',
      'missing-message-id',
      'incomplete-results',
      'stranger-turn',
    ].includes(failure)
  )
    expect(broker.fileHistory).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// H3 background Shell flow
// ---------------------------------------------------------------------------

function backgroundTurnRig(
  outcome: ToolResultEnvelope,
  options: {
    attached?: boolean;
    lane?: HostedShellTurnOptions;
    notStartedProven?: boolean;
    reserveRefused?: boolean;
    /** The store's answer to one execution's reservation, if it refuses. */
    refuse?: (executionCallId: string | undefined) => Error | undefined;
    fitsInline?: (type: string) => boolean;
    publicationMissing?: boolean;
    foregroundOnly?: boolean;
    extensionConfig?: HostedExtensionToolConfig;
    closeResults?: ReadonlyArray<'NOT_STARTED' | 'MISSING'>;
    executionCallIds?: readonly string[];
    hooks?: HostedHookSession;
    approval?: 'default';
  } = {},
) {
  enablement.childRun = true;
  const order: string[] = [];
  const closed: string[] = [];
  // executionCallId -> publicationId, and the publications the store refused.
  const publications = new Map<string, string>();
  const refused = new Set<string>();
  const orchestrator = {
    calls: [] as Array<readonly [string, unknown]>,
    record(id: string) {
      return options.attached === true
        ? {
            ...({} as Record<string, unknown>),
            startReceiptRef: {
              resourceId: `receipt-${id}`,
              kind: 'managed-runtime-receipt',
              schemaVersion: 1,
              byteLength: 1,
              digest: 'a'.repeat(64),
            },
          }
        : undefined;
    },
    async admit(params: unknown) {
      orchestrator.calls.push(['admit', params]);
    },
    async dispatchStarted(id: string, runtime: unknown) {
      orchestrator.calls.push(['dispatchStarted', { id, runtime }]);
    },
    async attach(id: string, runtime: unknown, receipt: unknown) {
      orchestrator.calls.push(['attach', { id, runtime, receipt }]);
    },
    async settleFailed(id: string, params: unknown) {
      orchestrator.calls.push(['settleFailed', { id, params }]);
    },
  };
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    rememberAdmission: vi.fn(),
    request: vi.fn(async (route: string, body: unknown) => {
      const operation = (body as { operation?: string }).operation;
      if (route === '/grants' && operation === 'reserve') {
        order.push('reserve');
        if (options.reserveRefused === true)
          throw new ManagedSessionStoreHttpError(
            500,
            'store_unavailable',
            'reserve refused',
          );
        const binding = (
          body as {
            binding?: { executionCallId?: string; publicationId?: string };
          }
        ).binding;
        if (binding?.executionCallId && binding.publicationId)
          publications.set(binding.executionCallId, binding.publicationId);
        const refusal = options.refuse?.(binding?.executionCallId);
        if (refusal) {
          if (binding?.publicationId) refused.add(binding.publicationId);
          throw refusal;
        }
        return { state: 'OPEN' };
      }
      if (route === '/grants' && operation === 'renew') {
        order.push('renew');
        return { state: 'OPEN' };
      }
      if (route === '/grants' && operation === 'close_not_started') {
        order.push('close_not_started');
        const publicationId = String(
          (body as { publicationId?: string }).publicationId,
        );
        closed.push(publicationId);
        // The store never wrote a row for a refused reservation.
        if (refused.has(publicationId))
          throw new ManagedSessionStoreHttpError(
            400,
            'invalid_request',
            'The request is invalid.',
          );
        const closeResult =
          options.closeResults?.[
            order.filter((item) => item === 'close_not_started').length - 1
          ];
        if (options.publicationMissing || closeResult === 'MISSING')
          throw new ManagedSessionStoreHttpError(
            404,
            'publication_not_found',
            'Publication does not exist',
          );
        return {
          state:
            closeResult ??
            (options.notStartedProven === false ? 'RUNNING' : 'NOT_STARTED'),
        };
      }
      throw new Error('Unexpected publication route ' + route);
    }),
  } as unknown as HttpToolPublicationOwner;
  broker.prepareV3.mockImplementation(async () => {
    const index = broker.prepareV3.mock.calls.length - 1;
    return {
      executionCallId: options.executionCallIds?.[index] ?? 'shell-execution',
      runtimeBindingId: `binding-${index + 1}`,
      bindingGeneration: '1',
    };
  });
  broker.executeV3.mockImplementation(async () => {
    order.push('execute');
    expect(session.authority.latestCheckpoint?.boundary).toBe('durable_wait');
    return outcome;
  });
  broker.acknowledgeV3.mockImplementation(async () => {
    order.push('ack');
    expect(session.authority.latestCheckpoint?.boundary).toBeNull();
  });
  const turn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    async (type, messageParts, model, identity) => {
      order.push(type);
      const uuid = identity?.uuid ?? randomUUID();
      await session.sink.write({
        uuid,
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        type,
        cwd: root,
        version: 'test',
        daemonPromptId: 'prompt',
        model,
        message: {
          role: type === 'assistant' ? 'model' : 'user',
          parts: messageParts,
        },
      });
      return uuid;
    },
    (type: string) => options.fitsInline?.(type) ?? true,
    { owner, captureBytes: 1024 * 1024 },
    undefined,
    options.approval
      ? { settings: { mode: options.approval, timeoutMs: 100 }, waiters }
      : undefined,
    {
      hooks: options.hooks,
      childRuns: orchestrator as never,
      backgroundLane: options.lane,
      foregroundOnly: options.foregroundOnly,
      extensionConfig: options.extensionConfig,
    },
  );
  return {
    order,
    closed,
    publications,
    orchestrator,
    turn,
    lane: options.lane,
  };
}

function monitorTurnRig(
  outcome: ToolResultEnvelope,
  opts: {
    notStartedProven?: boolean;
    lane?: HostedShellTurnOptions;
    reserveRefused?: boolean;
    capacityRefused?: boolean;
    foregroundOnly?: boolean;
  } = {},
) {
  enablement.childRun = true;
  enablement.monitorRun = true;
  const order: string[] = [];
  const options = {
    resources: {} as never,
    assertWritable: async () => {},
    monitorLoops: undefined as Map<string, unknown> | undefined,
    publisher: undefined as unknown,
  } as unknown as HostedShellTurnOptions;
  const monitors = {
    calls: [] as Array<readonly [string, unknown]>,
    attached: new Map<string, unknown>(),
    record(id: string) {
      return monitors.attached.get(id);
    },
    lastAdmit: undefined as Record<string, unknown> | undefined,
    async admit(params: Record<string, unknown>) {
      monitors.calls.push(['admit', params]);
      monitors.lastAdmit = params;
    },
    async dispatchStarted(id: string, runtime: unknown) {
      monitors.calls.push(['dispatchStarted', { id, runtime }]);
    },
    async attach(id: string, runtime: unknown, receipt: unknown) {
      monitors.calls.push(['attach', { id, runtime, receipt }]);
      const argsRef = await session.resources.publish(
        'managed-tool-args',
        Buffer.from(JSON.stringify(monitors.lastAdmit?.['args'] ?? {}), 'utf8'),
      );
      const bound = runtime as { runtimeBindingId: string; generation: string };
      monitors.attached.set(id, {
        monitorId: id,
        ownerScopeId: session.authority.sessionHeader.sessionKey.sessionId,
        commandRef: argsRef,
        maxEvents: (monitors.lastAdmit?.['maxEvents'] as number) ?? 100,
        idleTimeoutMs:
          (monitors.lastAdmit?.['idleTimeoutMs'] as number) ?? 300_000,
        debounceMs: (monitors.lastAdmit?.['debounceMs'] as number) ?? 1_000,
        startReceiptRef: {
          resourceId: `receipt-${id}`,
          kind: 'managed-runtime-receipt',
          schemaVersion: 1,
          byteLength: 2,
          digest: 'a'.repeat(64),
        },
        observationSequence: 0,
        lastObservationRef: null,
        notifiedThrough: 0,
        stopReason: null,
        outputRef: null,
        run: {
          state: 'running',
          reason: null,
          definition: null,
          executionCallId: id,
          effectId: null,
          dispatchId: null,
          deliveryId: null,
          execution: 'running_attached',
          runtime: bound,
          delivery: null,
        },
      });
    },
    async settleFailed(id: string, params: unknown) {
      monitors.calls.push(['settleFailed', { id, params }]);
    },
  };
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    rememberAdmission: vi.fn(),
    request: vi.fn(async (route: string, body: unknown) => {
      const operation = (body as { operation?: string }).operation;
      if (route === '/grants' && operation === 'reserve') {
        order.push('reserve');
        if (opts.reserveRefused === true)
          throw new ManagedSessionStoreHttpError(
            500,
            'store_unavailable',
            'reserve refused',
          );
        if (opts.capacityRefused === true) throw capacityExhausted();
        return { state: 'OPEN' };
      }
      if (route === '/grants' && operation === 'renew') {
        order.push('renew');
        return { state: 'OPEN' };
      }
      if (route === '/grants' && operation === 'close_not_started') {
        order.push('close_not_started');
        if (opts.capacityRefused === true)
          throw new ManagedSessionStoreHttpError(
            400,
            'invalid_request',
            'The request is invalid.',
          );
        return {
          state: opts.notStartedProven === false ? 'RUNNING' : 'NOT_STARTED',
        };
      }
      throw new Error('Unexpected publication route ' + route);
    }),
  } as unknown as HttpToolPublicationOwner;
  broker.prepareV3.mockResolvedValue({
    executionCallId: 'monitor-execution',
    runtimeBindingId: 'binding-1',
    bindingGeneration: '1',
  });
  broker.executeV3.mockImplementation(async () => {
    order.push('execute');
    expect(session.authority.latestCheckpoint?.boundary).toBe('durable_wait');
    return outcome;
  });
  broker.acknowledgeV3.mockImplementation(async () => {
    order.push('ack');
    expect(session.authority.latestCheckpoint?.boundary).toBeNull();
  });
  const turn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    async (type, messageParts, model, identity) => {
      order.push(type);
      const uuid = identity?.uuid ?? randomUUID();
      await session.sink.write({
        uuid,
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        type,
        cwd: root,
        version: 'test',
        daemonPromptId: 'prompt',
        model,
        message: {
          role: type === 'assistant' ? 'model' : 'user',
          parts: messageParts,
        },
      });
      return uuid;
    },
    () => true,
    { owner, captureBytes: 1024 * 1024 },
    opts.lane !== undefined ? undefined : options,
    undefined,

    {
      childRuns: {
        admit: async () => {},
        dispatchStarted: async () => {},
        attach: async () => {},
        settleFailed: async () => {},
        record: () => undefined,
      } as never,
      monitors: monitors as never,
      backgroundLane: opts.lane,
      foregroundOnly: opts.foregroundOnly,
    },
  );
  return { order, monitors, options: opts.lane ?? options, turn };
}

function monitorCall() {
  const call = {
    ...calls[0],
    name: 'monitor',
    callId: 'monitor-call',
    args: { command: 'tail -f build.log' },
  };
  const parts: Part[] = [
    {
      functionCall: {
        id: call.callId,
        name: call.name,
        args: call.args,
      },
    },
  ];
  return { call, parts };
}

describe('hosted Monitor admission arm', () => {
  const DETACHED: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Monitor watch started under unit qwen-mon-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };

  it('admits, dispatches and attaches through the monitor funnel', async () => {
    const { call, parts } = monitorCall();
    const rig = monitorTurnRig(DETACHED);
    turn = rig.turn;
    const result = await rig.turn.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );

    expect(result[0]?.functionResponse?.response).toMatchObject({
      executionStatus: 'success',
    });
    expect(rig.monitors.calls.map(([name]) => name)).toEqual([
      'admit',
      'dispatchStarted',
      'attach',
    ]);
    const [admit] = rig.monitors.calls;
    expect(admit?.[1]).toMatchObject({
      monitorId: 'monitor-execution',
      ownerScopeId: session.authority.sessionHeader.sessionKey.sessionId,
      executionCallId: 'monitor-execution',
      maxEvents: 1_000,
      idleTimeoutMs: 300_000,
      debounceMs: 1_000,
    });
    const [, , attach] = rig.monitors.calls;
    expect(attach?.[1]).toMatchObject({
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    const receipt = (attach?.[1] as { receipt: Record<string, unknown> })
      .receipt;
    expect(receipt['executionCallId']).toBe('monitor-execution');
    expect(receipt['bindingGeneration']).toBe('1');
    expect(receipt['unitName']).toMatch(/^qwen-mon-/);
    expect(broker.acknowledgeV3).toHaveBeenCalledWith('monitor-execution', {
      executionCallId: 'monitor-execution',
      manifest: null,
      deliveryStatus: 'blocked',
      historyRevision: null,
    });
    const receipts = session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.payload).toMatchObject({
      executionCallId: 'monitor-execution',
      resultRef: null,
      resources: [],
    });
    // A fresh accept starts exactly one observation lifecycle on the Session.
    expect(rig.options.monitorLoops?.has('monitor-execution')).toBe(true);
  });

  it("stops the watch through its own Runtime call on the turn's broker (#13896)", async () => {
    const { call, parts } = monitorCall();
    const rig = monitorTurnRig(DETACHED);
    turn = rig.turn;
    await rig.turn.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );
    const runtimeCallId = broker.prepareV3.mock.calls.at(-1)![0];
    broker.monitorControl.mockResolvedValue({
      operationId: runtimeCallId,
      state: 'unknown',
    });
    Object.assign(rig.monitors, { blockedRuntimeLost: vi.fn(async () => {}) });
    // The worker derived the watch's unit from the Runtime call, not from
    // the execution id: the stop must name that call to reach the watch.
    await rig.options
      .monitorLoops!.get('monitor-execution')!
      .stop('runtime_lost');
    expect(broker.monitorControl).toHaveBeenCalledExactlyOnceWith({
      kind: 'monitor-stop',
      sessionKey: session.authority.sessionHeader.sessionKey,
      operationId: 'monitor-execution',
      targetOperationId: runtimeCallId,
    });
    expect(runtimeCallId).not.toBe('monitor-execution');
    // ...the very unit the start receipt recorded.
    const attach = rig.monitors.calls.find(([name]) => name === 'attach')!;
    expect(
      (attach[1] as { receipt: Record<string, unknown> }).receipt['unitName'],
    ).toBe(monitorUnitNameOf(runtimeCallId));
  });

  it('drives a Monitor through the publication lane exactly where production admits it', async () => {
    const { call, parts } = monitorCall();
    const descriptor = { url: 'http://127.0.0.1:9/lane-mon', token: 'tok' };
    const lane: HostedShellTurnOptions = {
      resources: {} as never,
      assertWritable: async () => undefined,
      monitorLoops: undefined as Map<string, unknown> | undefined,
      publisher: {
        start: async () => descriptor,
        register: vi.fn(),
        setMonitorObserver: vi.fn(),
        settleAttached: async () => undefined,
        close: async () => undefined,
      } as never,
    } as unknown as HostedShellTurnOptions;
    const rig = monitorTurnRig(DETACHED, { lane });
    turn = rig.turn;
    const result = await turn.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );
    expect(result[0]?.functionResponse?.response).toMatchObject({
      executionStatus: 'success',
    });
    // The lane carries the Session publisher for the detached family:
    // installed once, fed with the monitoring capture, and its attach
    // drives the observation loop to resume through the same lane.
    expect(broker.registerPublisher).toHaveBeenCalledTimes(1);
    expect(broker.prepareV3).toHaveBeenCalledTimes(1);
    expect(broker.executeV3).toHaveBeenCalledTimes(1);
    expect(rig.monitors.calls.map(([name]) => name)).toEqual([
      'admit',
      'dispatchStarted',
      'attach',
    ]);
    const register = lane.publisher!.register as ReturnType<typeof vi.fn>;
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toMatchObject({
      capture: {
        executionCallId: 'monitor-execution',
        background: true,
        monitoring: true,
      },
    });
    // Same identity rule as the background Shell: the registered reference
    // is the v3 dispatch reference the worker replays at prepare (#13532 A4).
    expect(
      (register.mock.calls[0]![0] as { reference: { argsDigest: string } })
        .reference.argsDigest,
    ).toBe(broker.prepareV3.mock.calls[0]![1]);
    expect(rig.options.monitorLoops?.has('monitor-execution')).toBe(true);
  });

  it('settles a proven-unstarted monitor as start_failed', async () => {
    const { call, parts } = monitorCall();
    const rejectedStart: ToolResultEnvelope = {
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: {
        message:
          'Monitor watch requires a delegated Linux cgroup v2 root on this Runtime.',
      },
    };
    const rig = monitorTurnRig(rejectedStart);
    turn = rig.turn;
    await rig.turn.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );
    expect(rig.monitors.calls.map(([name]) => name)).toEqual([
      'admit',
      'dispatchStarted',
      'settleFailed',
    ]);
    expect(rig.monitors.calls.at(-1)?.[1]).toEqual({
      id: 'monitor-execution',
      params: { stopReason: 'start_failed', started: false },
    });
    expect(rig.order).toEqual([
      'assistant',
      'reserve',
      'renew',
      'execute',
      'close_not_started',
      'tool_result',
    ]);
  });

  it('rejects an unproven not_started refuse before settling the watch record', async () => {
    const { call, parts } = monitorCall();
    const rejectedStart: ToolResultEnvelope = {
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: {
        message:
          'Monitor watch requires a delegated Linux cgroup v2 root on this Runtime.',
      },
    };
    const rig = monitorTurnRig(rejectedStart, { notStartedProven: false });
    turn = rig.turn;
    await expect(
      rig.turn.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    // The authoritative proof failed: the record stays un-settled rather
    // than claiming a failure that never happened.
    expect(rig.monitors.calls.some(([name]) => name === 'settleFailed')).toBe(
      false,
    );
  });

  it('never borrows the Shell process ledger to settle an unproven watch record', async () => {
    // The absence fallback is scoped to `request?.background`. A monitor_run
    // record has a separate lifecycle owner, so an unproven grant close must
    // not be rescued by the background process ledger — not even when that
    // ledger reports no process at all.
    const { call, parts } = monitorCall();
    const rejectedStart: ToolResultEnvelope = {
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: {
        message:
          'Monitor watch requires a delegated Linux cgroup v2 root on this Runtime.',
      },
    };
    const rig = monitorTurnRig(rejectedStart, { notStartedProven: false });
    turn = rig.turn;
    // Even a ledger answer that *would* prove absence for a background Shell
    // must never be read on the Monitor path.
    broker.backgroundProcessStatus.mockResolvedValue(undefined);
    await expect(
      rig.turn.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

    expect(broker.backgroundProcessStatus).not.toHaveBeenCalled();
    expect(rig.monitors.calls.some(([name]) => name === 'settleFailed')).toBe(
      false,
    );
  });

  it('does not override a grant owner that reports the Shell started', async () => {
    const { call, parts } = backgroundCall();
    const rejectedStart: ToolResultEnvelope = {
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: {
        message:
          'Background Shell requires a delegated Linux cgroup v2 directory on this Runtime.',
      },
    };
    const rig = backgroundTurnRig(rejectedStart, { notStartedProven: false });
    turn = rig.turn;
    broker.backgroundProcessStatus.mockResolvedValue(undefined);
    await expect(
      rig.turn.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(broker.backgroundProcessStatus).not.toHaveBeenCalled();
    expect(
      rig.orchestrator.calls.some(([name]) => name === 'settleFailed'),
    ).toBe(false);
  });

  it('resumes a live watch on an accept replay whose loop was lost', async () => {
    const { call, parts } = monitorCall();
    const rig = monitorTurnRig(DETACHED);
    turn = rig.turn;
    await rig.turn.execute(
      [call],
      parts,
      'model',
      new AbortController().signal,
    );
    expect(rig.options.monitorLoops?.has('monitor-execution')).toBe(true);
    // The process that owned the observation loop is gone; the journal
    // keeps the record running and its receipt, so the next accept for it
    // must resume the loop or the run never settles again.
    rig.options.monitorLoops = new Map();
    const accept = (
      rig.turn as unknown as {
        acceptMonitor(
          request: {
            call: ToolCallRequestInfo;
            input: Record<string, unknown>;
          },
          executionCallId: string,
          saved: Record<string, string>,
          result: ToolResultEnvelope,
          model: string,
        ): Promise<Part[]>;
      }
    ).acceptMonitor.bind(rig.turn);
    const retried = await accept(
      { call, input: call.args as Record<string, unknown> },
      'monitor-execution',
      {
        publicationId: 'publication-1',
        publicationToken: 'token-1',
        runtimeBindingId: 'binding-1',
        bindingGeneration: '1',
        runtimeCallId: 'rt',
      },
      DETACHED,
      'model',
    );
    expect(retried[0]?.functionResponse?.response).toMatchObject({
      executionStatus: 'success',
    });
    expect(rig.options.monitorLoops?.has('monitor-execution')).toBe(true);
    expect(
      rig.monitors.calls.filter(([name]) => name === 'attach'),
    ).toHaveLength(1);
  });

  it('refuses a background request on a Session whose flow has no publication lane', async () => {
    enablement.childRun = true;
    const { call: shellCall, parts } = backgroundCall();
    const bare = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      {
        resources: {} as never,
        assertWritable: async () => undefined,
      } as never,
      undefined,
      undefined,

      {
        childRuns: {
          admit: async () => undefined,
          dispatchStarted: async () => undefined,
          attach: async () => undefined,
          settleFailed: async () => undefined,
          record: () => undefined,
          settleExited: async () => undefined,
        } as never,
      },
    );
    const result = await bare.execute(
      [shellCall],
      parts,
      'model',
      new AbortController().signal,
    );
    // shell-mode has no publication lane for the detached family, so the
    // request refuses at admission instead of travelling v2 and failing 409.
    expect(result[0]?.functionResponse?.response).toMatchObject({
      error:
        'Hosted Shell requires a foreground command in the saved directory. Background jobs and Monitor are unavailable; correct the arguments before retrying.',
    });
  });

  it('does not let one failed resume poison every later one', async () => {
    const publisher = {
      setMonitorObserver: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('observer bridge gone');
        })
        .mockImplementation(() => undefined),
    };
    const commandRef = await session.resources.publish(
      'managed-tool-args',
      Buffer.from(JSON.stringify({ command: 'true' }), 'utf8'),
    );
    const record = {
      monitorId: 'monitor-x',
      commandRef,
      maxEvents: 100,
      idleTimeoutMs: 60_000,
      debounceMs: 1_000,
      startReceiptRef: {
        resourceId: 'receipt-monitor-x',
        kind: 'managed-runtime-receipt',
        schemaVersion: 1,
        byteLength: 2,
        digest: 'a'.repeat(64),
      },
      stopReason: null,
      run: { runtime: { runtimeBindingId: 'binding-1', generation: '1' } },
    };
    const monitors = {
      record: (id: string) => (id === 'monitor-x' ? record : undefined),
    } as never;
    const shell: {
      monitorLoops: Map<string, unknown>;
      monitorWakeKick: () => void;
    } = {
      monitorLoops: new Map<string, unknown>(),
      monitorWakeKick: () => undefined,
    };
    const bare = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      {
        resources: {} as never,
        assertWritable: async () => undefined,
        ...shell,
      } as never,
      undefined,
      undefined,
      { monitors },
    );
    (bare as unknown as { publisher: unknown }).publisher = publisher;
    const resume = (
      bare as unknown as {
        resumeMonitorWatch: (
          executionCallId: string,
          runtimeCallId: string,
        ) => Promise<void>;
      }
    ).resumeMonitorWatch.bind(bare);
    await expect(resume('monitor-x', 'runtime-call-x')).rejects.toThrow(
      'observer bridge gone',
    );
    // The failed start leaves no dead loop behind to short-circuit the
    // retry that comes from a fresh accept.
    expect(shell.monitorLoops.has('monitor-x')).toBe(false);
    await expect(
      resume('monitor-x', 'runtime-call-x'),
    ).resolves.toBeUndefined();
    expect(shell.monitorLoops.has('monitor-x')).toBe(true);
  });

  it('records a monitor refusal without any funnel call on an empty session', async () => {
    const { call, parts } = monitorCall();
    const bare = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      {
        resources: {} as never,
        assertWritable: async () => {},
      } as never,
      undefined,
      undefined,
    );
    await expect(
      bare.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toThrow('Hosted Workspace profile refused a tool call.');
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepareV3).not.toHaveBeenCalled();
  });

  it('refuses a Monitor on a Session that owns monitors but no v3 lane', async () => {
    enablement.monitorRun = true;
    const { call, parts } = monitorCall();
    const bare = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      async () => randomUUID(),
      () => true,
      {
        resources: {} as never,
        assertWritable: async () => undefined,
      } as never,
      undefined,
      undefined,
      { monitors: { record: () => undefined } as never },
    );
    await expect(
      bare.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toThrow('Hosted Workspace profile refused a tool call.');
    // Owning monitors without a v3 lane must never send the Monitor
    // travelling v2 to the Runtime: it refuses at admission, accurately.
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepareV3).not.toHaveBeenCalled();
  });
});

function backgroundCall() {
  const call = {
    ...calls[0],
    name: 'run_shell_command',
    callId: 'background-call',
    args: { command: 'echo hi', is_background: true as const },
  };
  const parts: Part[] = [
    {
      functionCall: {
        id: call.callId,
        name: call.name,
        args: call.args,
      },
    },
  ];
  return { call, parts };
}

it('only advertises foreground Shell on a Session without publication', async () => {
  turn = createTurn(true);
  const declarations = await turn.declarations(new AbortController().signal);
  expect(declarations.map((tool) => tool.name)).not.toContain('monitor');
  const shell = declarations.find((tool) => tool.name === 'run_shell_command');
  expect(shell?.parametersJsonSchema).not.toHaveProperty(
    'properties.is_background',
  );
  expect(shell?.description).not.toContain('detached');
  expect(shell?.description).toContain(
    'Shell file mutations are not backed up',
  );
});

it.each([true, false])(
  'advertises background Shell only while its kind is enabled (%s)',
  async (enabled) => {
    const rig = backgroundTurnRig({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
    });
    turn = rig.turn;
    enablement.childRun = enabled;
    const declarations = await turn.declarations(new AbortController().signal);
    const shell = declarations.find(
      (tool) => tool.name === 'run_shell_command',
    );
    if (enabled)
      expect(shell?.parametersJsonSchema).toHaveProperty(
        'properties.is_background',
      );
    else
      expect(shell?.parametersJsonSchema).not.toHaveProperty(
        'properties.is_background',
      );
    expect(declarations.map((tool) => tool.name)).not.toContain('monitor');
  },
);

it.each([
  { enabled: true, isBackground: false },
  { enabled: false, isBackground: false },
  { enabled: true, isBackground: 'FaLsE' },
  { enabled: false, isBackground: 'FaLsE' },
])(
  'matches its advertised explicit foreground Shell contract (background enabled: $enabled, input: $isBackground)',
  async ({ enabled, isBackground }) => {
    const rig = backgroundTurnRig({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
    });
    turn = rig.turn;
    enablement.childRun = enabled;
    const declarations = await turn.declarations(new AbortController().signal);
    const shell = declarations.find(
      (tool) => tool.name === 'run_shell_command',
    );
    const args = { command: 'echo hi', is_background: isBackground };
    const call = { ...calls[0], name: 'run_shell_command', args };
    const results = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args } }],
      'model',
      new AbortController().signal,
    );
    if (enabled) {
      expect(shell?.parametersJsonSchema).toHaveProperty(
        'properties.is_background',
      );
      expect(broker.prepareV3).toHaveBeenCalledOnce();
      expect(broker.executeV3).toHaveBeenCalledOnce();
      expect(JSON.parse(broker.executeV3.mock.calls[0]![1])).toMatchObject({
        toolName: 'run_shell_command',
        input: { command: 'echo hi', is_background: false },
      });
      expect(
        JSON.parse(broker.executeV3.mock.calls[0]![1]).input.is_background,
      ).toBe(false);
    } else {
      expect(shell?.parametersJsonSchema).not.toHaveProperty(
        'properties.is_background',
      );
      expect(results[0]?.functionResponse?.response?.['error']).toContain(
        'foreground command',
      );
      expect(broker.prepareV3).not.toHaveBeenCalled();
      expect(broker.executeV3).not.toHaveBeenCalled();
    }
    expect(rig.orchestrator.calls).toEqual([]);
  },
);

it('reports a malformed background flag without hiding admitted capabilities', async () => {
  const rig = backgroundTurnRig({
    executionStatus: 'not_started',
    responseParts: [],
    capture: null,
  });
  turn = rig.turn;
  const args = { command: 'echo hi', is_background: 'yes' };
  const call = { ...calls[0], name: 'run_shell_command', args };
  const results = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args } }],
    'model',
    new AbortController().signal,
  );
  const error = results[0]?.functionResponse?.response?.['error'];
  expect(error).toContain('is_background');
  expect(error).not.toContain('unavailable');
  expect(broker.prepareV3).not.toHaveBeenCalled();
  expect(broker.executeV3).not.toHaveBeenCalled();
  expect(rig.orchestrator.calls).toEqual([]);
});

it.each([true, false])(
  'preserves extension Shell pins with background admission enabled (%s)',
  async (enabled) => {
    const pin = {
      extensionId: 'ext_11111111-1111-4111-8111-111111111111',
      packageRevision: 1,
      packageDigest: 'a'.repeat(64),
    };
    const rig = backgroundTurnRig(
      { executionStatus: 'not_started', responseParts: [], capture: null },
      {
        extensionConfig: {
          revision: 1,
          packages: [{ pin, assetRoot: path.join(root, 'extension-assets') }],
        },
      },
    );
    turn = rig.turn;
    enablement.childRun = enabled;
    const declarations = await turn.declarations(new AbortController().signal);
    const shell = declarations.find(
      (tool) => tool.name === 'run_shell_command',
    );
    expect(shell?.parametersJsonSchema).toHaveProperty(
      'properties.extension_context.oneOf',
      [
        {
          properties: Object.fromEntries(
            Object.entries(pin).map(([key, value]) => [key, { const: value }]),
          ),
        },
      ],
    );
    expect(shell?.description).toContain('$QWEN_EXTENSION_ROOT');
    expect(shell?.description).toContain(
      'cwd stays the Session working directory',
    );
    if (enabled)
      expect(shell?.parametersJsonSchema).toHaveProperty(
        'properties.is_background',
      );
    else {
      expect(shell?.parametersJsonSchema).not.toHaveProperty(
        'properties.is_background',
      );
      expect(shell?.description).toContain(
        'Shell file mutations are not backed up',
      );
    }
    expect(declarations.map((tool) => tool.name)).not.toContain('monitor');
  },
);

it.each([true, false])(
  'advertises Monitor only while its domain is enabled (%s)',
  async (enabled) => {
    const rig = monitorTurnRig({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
    });
    turn = rig.turn;
    enablement.monitorRun = enabled;
    const declarations = await turn.declarations(new AbortController().signal);
    expect(declarations.some((tool) => tool.name === 'monitor')).toBe(enabled);
  },
);

it('keeps the SSH foreground-only declaration and admission free of detached tools', async () => {
  const outcome: ToolResultEnvelope = {
    executionStatus: 'not_started',
    responseParts: [],
    capture: null,
  };
  const rig = backgroundTurnRig(outcome, { foregroundOnly: true });
  turn = rig.turn;
  const declarations = await turn.declarations(new AbortController().signal);
  expect(declarations.map((tool) => tool.name)).toEqual([
    'read_file',
    'write_file',
    'edit',
    'web_fetch',
    'run_shell_command',
  ]);
  const shell = declarations.find((tool) => tool.name === 'run_shell_command');
  expect(shell?.parametersJsonSchema).not.toHaveProperty(
    'properties.is_background',
  );
  expect(shell?.description).not.toContain('detached');
  const background = backgroundCall();
  const result = await turn.execute(
    [background.call],
    background.parts,
    'model',
    new AbortController().signal,
  );
  expect(result[0]?.functionResponse?.response).toHaveProperty('error');
  expect(rig.orchestrator.calls).toEqual([]);
  expect(broker.prepareV3).not.toHaveBeenCalled();
  expect(broker.executeV3).not.toHaveBeenCalled();
});

it('refuses SSH foreground-only Monitor before any Runtime or publication admission', async () => {
  const rig = monitorTurnRig(
    { executionStatus: 'not_started', responseParts: [], capture: null },
    { foregroundOnly: true },
  );
  turn = rig.turn;
  const monitor = monitorCall();
  await expect(
    turn.execute(
      [monitor.call],
      monitor.parts,
      'model',
      new AbortController().signal,
    ),
  ).rejects.toThrow('Hosted Workspace profile refused a tool call.');
  expect(rig.monitors.calls).toEqual([]);
  expect(rig.order).toEqual([]);
  expect(broker.prepareV3).not.toHaveBeenCalled();
  expect(broker.executeV3).not.toHaveBeenCalled();
});

it('admits a background Shell through its child_run orchestrator and lands the detached receipt family', async () => {
  const { call, parts } = backgroundCall();
  const detached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Background shell started under unit qwen-bg-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(detached);
  turn = rig.turn;
  const result = await turn.execute(
    [call],
    parts,
    'model',
    new AbortController().signal,
  );

  expect(result[0]?.functionResponse?.response).toMatchObject({
    executionStatus: 'success',
  });
  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'attach',
  ]);
  const [admit] = rig.orchestrator.calls;
  expect(admit?.[1]).toMatchObject({
    shellId: 'shell-execution',
    executionCallId: 'shell-execution',
    args: { command: 'echo hi', is_background: true },
  });
  const [, dispatch] = rig.orchestrator.calls;
  expect(dispatch).toMatchObject([
    'dispatchStarted',
    {
      id: 'shell-execution',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    },
  ]);
  const [, , attach] = rig.orchestrator.calls;
  expect(attach?.[1]).toMatchObject({
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  const receipt = (attach?.[1] as { receipt: Record<string, unknown> }).receipt;
  expect(receipt['executionCallId']).toBe('shell-execution');
  expect(receipt['bindingGeneration']).toBe('1');
  expect(receipt['unitName']).toMatch(/^qwen-bg-/);
  expect(broker.acknowledgeV3).toHaveBeenCalledWith('shell-execution', {
    executionCallId: 'shell-execution',
    manifest: null,
    deliveryStatus: 'blocked',
    historyRevision: null,
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'renew',
    'execute',
    'tool_result',
    'ack',
  ]);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.payload).toMatchObject({
    executionCallId: 'shell-execution',
    resultRef: null,
    resources: [],
  });
  const outcomeRef = assertManagedSessionDurableRef(
    receipts[0]!.payload['toolOutcomeRef'],
    'background outcome',
  );
  const savedOutcome = JSON.parse(
    (await session.resources.read(outcomeRef)).toString('utf8'),
  ) as Record<string, unknown>;
  expect(savedOutcome).toMatchObject({
    schemaVersion: 1,
    decision: 'blocked',
    manifestRef: null,
  });
  expect(savedOutcome['envelope']).toEqual(detached);
});

it('registers the Session capture lane for a background turn in publication mode', async () => {
  const { call, parts } = backgroundCall();
  const detached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Background shell started under unit qwen-bg-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const descriptor = { url: 'http://127.0.0.1:9/lane', token: 'lane-token' };
  const order2: string[] = [];
  const lane: HostedShellTurnOptions = {
    resources: {} as never,
    assertWritable: async () => undefined,
    publisher: {
      start: async () => descriptor,
      register: vi.fn(),
      settleAttached: async (id: string) => {
        order2.push(`settleAttached:${id}`);
      },
      close: async () => undefined,
    } as never,
  };
  const rig = backgroundTurnRig(detached, { lane });
  turn = rig.turn;
  const result = await turn.execute(
    [call],
    parts,
    'model',
    new AbortController().signal,
  );
  expect(result[0]?.functionResponse?.response).toMatchObject({
    executionStatus: 'success',
  });
  // The production lane owns the detached family's funnel from admission:
  // installed on the Runtime, fed this call's register, and its
  // settleAttached is the hook the attach arm drives — it fires right
  // after the attach, without any client retry anywhere in the turn.
  expect(broker.registerPublisher).toHaveBeenCalledWith(descriptor);
  expect(broker.registerPublisher).toHaveBeenCalledTimes(1);
  const register = lane.publisher!.register as ReturnType<typeof vi.fn>;
  expect(register).toHaveBeenCalledTimes(1);
  expect(register.mock.calls[0]![0]).toMatchObject({
    capture: {
      executionCallId: 'shell-execution',
      background: true,
    },
  });
  // The registered reference must be exactly the v3 dispatch reference the
  // worker replays at prepare — the prefixed argsDigest handed to
  // prepareV3, never the bare inputDigest of the legacy prepare (#13532 A4).
  expect(
    (register.mock.calls[0]![0] as { reference: { argsDigest: string } })
      .reference.argsDigest,
  ).toBe(broker.prepareV3.mock.calls[0]![1]);
  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'attach',
  ]);
  expect(order2).toEqual(['settleAttached:shell-execution']);
});

it('picks the background lane from the input a PreToolUse Hook left, not the model input', async () => {
  const detached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [{ text: 'Background shell started.' }],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const descriptor = { url: 'http://127.0.0.1:9/lane', token: 'lane-token' };
  const register = vi.fn();
  const lane: HostedShellTurnOptions = {
    resources: {} as never,
    assertWritable: async () => undefined,
    publisher: {
      start: async () => descriptor,
      register,
      settleAttached: async () => undefined,
      close: async () => undefined,
    } as never,
  };
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) =>
      event === HookEventName.PreToolUse
        ? replaceWith({ command: 'echo hi', is_background: true })()
        : undefined,
    );
  const rig = backgroundTurnRig(detached, { lane, hooks: hookSession(fire) });
  turn = rig.turn;
  const { call } = backgroundCall();
  const foreground = { ...call, args: { command: 'echo hi' } };
  const result = await turn.execute(
    [foreground],
    [
      {
        functionCall: {
          id: foreground.callId,
          name: foreground.name,
          args: foreground.args,
        },
      },
    ],
    'model',
    new AbortController().signal,
  );
  expect(result[0]?.functionResponse?.response).toMatchObject({
    executionStatus: 'success',
  });
  expect(broker.registerPublisher).toHaveBeenCalledWith(descriptor);
  expect(register).toHaveBeenCalledOnce();
  expect(register.mock.calls[0]![0]).toMatchObject({
    capture: { background: true },
  });
  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'attach',
  ]);
});

it('registers a foreground Shell capture with the legacy lane’s bare input digest', async () => {
  turn = createTurn(true);
  broker.prepare.mockResolvedValue('execution-shell');
  const manifest = await session.resources.publish(
    'managed-tool-result-manifest',
    Buffer.from('{}'),
  );
  const envelope = {
    executionStatus: 'success' as const,
    responseParts: [{ text: 'ok' }],
    capture: {
      captureStatus: 'complete' as const,
      captureReason: null,
      manifest,
      previewTruncated: false,
      deliveryStatus: 'committed' as const,
    },
  };
  const outcomeRef = await session.resources.publish(
    'managed-tool-outcome',
    Buffer.from(JSON.stringify({ envelope })),
  );
  vi.spyOn(HostedShellPublisher.prototype, 'receipt').mockResolvedValue({
    executionCallId: 'execution-shell',
    manifest,
    deliveryStatus: 'committed',
    historyRevision: 1,
    outcomeRef,
  });
  const register = vi.spyOn(HostedShellPublisher.prototype, 'register');
  broker.execute.mockResolvedValue(envelope);
  const call = {
    ...calls[0],
    name: 'run_shell_command',
    args: { command: 'echo ok' },
  };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['executionStatus']).toBe(
    'success',
  );
  // This rig has no publication lane, so the shell takes the legacy
  // prepare; the worker replays that lane's bare input digest at capture
  // prepare, and the registration must carry exactly that value — the
  // prefixed v3 argsDigest would never match it (#13532 A4).
  expect(broker.prepareV3).not.toHaveBeenCalled();
  expect(broker.prepare).toHaveBeenCalledOnce();
  expect(register).toHaveBeenCalledOnce();
  const registered = register.mock.calls[0]![0] as {
    reference: { argsDigest: string };
  };
  expect(registered.reference.argsDigest).toBe(
    broker.prepare.mock.calls[0]![2],
  );
  expect(registered.reference.argsDigest).not.toContain('sha256:');
});

it('answers a retried accept from the journal without minting a rerun', async () => {
  const { call, parts } = backgroundCall();
  const detached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Background shell started under unit qwen-bg-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(detached);
  turn = rig.turn;
  await turn.execute([call], parts, 'model', new AbortController().signal);

  const accept = (
    rig.turn as unknown as {
      acceptBackgroundShell(
        request: { call: ToolCallRequestInfo; input: Record<string, unknown> },
        executionCallId: string,
        saved: Record<string, string>,
        result: ToolResultEnvelope,
        model: string,
      ): Promise<Part[]>;
    }
  ).acceptBackgroundShell.bind(rig.turn);
  const retried = await accept(
    { call, input: call.args as Record<string, unknown> },
    'shell-execution',
    {
      publicationId: 'publication-1',
      publicationToken: 'token-1',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
      runtimeCallId: 'rt',
    },
    detached,
    'model',
  );
  expect(retried[0]?.functionResponse?.response).toMatchObject({
    executionStatus: 'success',
  });
  expect(
    rig.orchestrator.calls.filter(([name]) => name === 'attach'),
  ).toHaveLength(1);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
});

it('tolerates a crash between attach and journal instead of a rerun', async () => {
  const { call, parts } = backgroundCall();
  const detached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [
      {
        text: 'Background shell started under unit qwen-bg-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
      },
    ],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(detached, { attached: true });
  turn = rig.turn;
  await turn.execute([call], parts, 'model', new AbortController().signal);
  expect(
    rig.orchestrator.calls.filter(([name]) => name === 'attach'),
  ).toHaveLength(0);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
  expect(broker.acknowledgeV3).toHaveBeenCalledWith('shell-execution', {
    executionCallId: 'shell-execution',
    manifest: null,
    deliveryStatus: 'blocked',
    historyRevision: null,
  });
});

it('records a proven-unstarted background refuse as start_failed and lands the unstarted family', async () => {
  const { call, parts } = backgroundCall();
  const rejectedStart: ToolResultEnvelope = {
    executionStatus: 'not_started',
    responseParts: [],
    capture: null,
    error: {
      message:
        'Background Shell requires a delegated Linux cgroup v2 directory on this Runtime.',
    },
  };
  const rig = backgroundTurnRig(rejectedStart);
  turn = rig.turn;
  await turn.execute([call], parts, 'model', new AbortController().signal);

  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.orchestrator.calls.at(-1)?.[1]).toEqual({
    id: 'shell-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'renew',
    'execute',
    'close_not_started',
    'tool_result',
  ]);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.payload).toMatchObject({
    resultRef: null,
    resources: [],
  });
  expect(broker.acknowledgeV3).not.toHaveBeenCalled();
});

it('settles the admitted child run when grant reservation exhausts its retries', async () => {
  // R3-23: the checkpoint committed, dispatch_started is durable, and the
  // /grants reserve then refuses three times — the recovery catch closes
  // the grant as NOT_STARTED, which is also the proof under which the
  // admitted run record must settle instead of staying dispatch_started
  // forever.
  const { call, parts } = backgroundCall();
  const unreached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [{ text: 'unreached' }],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(unreached, { reserveRefused: true });
  turn = rig.turn;
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.orchestrator.calls.at(-1)?.[1]).toEqual({
    id: 'shell-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'reserve',
    'reserve',
    'close_not_started',
  ]);
});

it('settles an in-turn dispatch with no publication and no durable process row', async () => {
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  const { call, parts } = backgroundCall();
  const rig = backgroundTurnRig(
    { executionStatus: 'success', responseParts: [], capture: null },
    { reserveRefused: true, publicationMissing: true },
  );
  turn = rig.turn;
  broker.backgroundProcessStatus.mockResolvedValue(undefined);
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

  expect(broker.executeV3).not.toHaveBeenCalled();
  expect(rig.order).toContain('close_not_started');
  expect(rig.orchestrator.calls.at(-1)).toEqual([
    'settleFailed',
    {
      id: 'shell-execution',
      params: { stopReason: 'start_failed', started: false },
    },
  ]);
  expect(broker.backgroundProcessStatus).toHaveBeenCalledWith(
    'shell-execution',
  );
  expect(stderr).toHaveBeenCalledWith(
    'qwen serve: Settled never-started background child run shell-execution from durable process-ledger absence.',
  );
  stderr.mockRestore();
});

// #14434: a limit refusal reaches the batch before any call ran. Every
// execution reads `prepared` until its cancel lands, then settles: a Shell
// or Monitor (`shell-…`, `monitor-…`, v3) with the Broker's not-started
// result, any other call with `cancelled`, as the Broker answers.
function capacityExhausted() {
  return new ManagedSessionStoreHttpError(
    429,
    'managed_tool_publication_capacity_exhausted',
    'Tool publication reservation refused at the active_captures limit',
  );
}

function retentionExhausted() {
  return new ManagedSessionStoreHttpError(
    409,
    'managed_tool_publication_retention_exhausted',
    'Tool publication reservation refused at the session_bytes limit',
  );
}

const CAPACITY_ANSWER =
  'This call was not started: Tool publication reservation refused at the active_captures limit. Retry after the running tools finish.';
// #14518: a call that reserves nothing is told it can go without the rest.
const BYSTANDER_ANSWER =
  'This call was not started: another call in its batch was refused before any call ran (Tool publication reservation refused at the active_captures limit). This call needs no tool output capacity, so it can be retried in a batch without the refused calls.';

function brokerStatusThroughCancel(
  override?: (id: string, cancelled: boolean) => unknown,
) {
  broker.status.mockImplementation(async (id: string) => {
    const cancelled = broker.cancel.mock.calls.some(
      ([cancelledId]) => cancelledId === id,
    );
    if (override) {
      const state = override(id, cancelled);
      if (state !== null) return state;
    }
    if (!cancelled) return { state: 'prepared' };
    return {
      state: 'settled',
      executionStatus: /^(shell|monitor)-/.test(id)
        ? 'not_started'
        : 'cancelled',
    };
  });
}

function answerText(responses: Part[]): string[] {
  return responses.map((part) =>
    String(
      (
        part.functionResponse?.response as Record<string, unknown> | undefined
      )?.['error'],
    ),
  );
}

async function runtimeItemStates(): Promise<string[]> {
  const authorization = await session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') return [authorization.status];
  return (authorization.checkpoint.tools?.items ?? []).map(
    (item) => item.state,
  );
}

async function toolResultCount(): Promise<number> {
  return (await session.sink.project()).filter(
    (record) => record.type === 'tool_result',
  ).length;
}

const foregroundShell = {
  ...calls[0],
  name: 'run_shell_command',
  callId: 'foreground-call',
  args: { command: 'echo hi' },
};
const foregroundParts: Part[] = [
  {
    functionCall: {
      id: foregroundShell.callId,
      name: foregroundShell.name,
      args: foregroundShell.args,
    },
  },
];
const unreachedOutcome: ToolResultEnvelope = {
  executionStatus: 'success',
  responseParts: [{ text: 'unreached' }],
  capture: null,
};

it('answers a capacity-refused foreground Shell as not started and lets the turn go on', async () => {
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: capacityExhausted,
  });
  turn = rig.turn;
  brokerStatusThroughCancel();
  const resolve = harness.resolveAwaitRuntime.bind(harness);
  vi.spyOn(harness, 'resolveAwaitRuntime').mockImplementation(
    async (...args) => {
      rig.order.push('resolve');
      return resolve(...args);
    },
  );
  const responses = await turn.execute(
    [foregroundShell],
    foregroundParts,
    'model',
    new AbortController().signal,
  );

  expect(broker.executeV3).not.toHaveBeenCalled();
  expect(broker.cancel).toHaveBeenCalledWith('shell-execution');
  expect(responses.map((part) => part.functionResponse?.id)).toEqual([
    'foreground-call',
  ]);
  expect(answerText(responses)).toEqual([CAPACITY_ANSWER]);
  expect(
    (responses[0]?.functionResponse?.response as Record<string, unknown>)[
      'executionStatus'
    ],
  ).toBe('not_started');
  // The 429 is retried, the close finds no row, and the answer journals
  // before its await_runtime item resolves.
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'reserve',
    'reserve',
    'close_not_started',
    'tool_result',
    'resolve',
  ]);
  expect(await runtimeItemStates()).toEqual(['settled']);
  expect(session.authority.latestCheckpoint?.boundary).toBeNull();
  await expect(turn.finish()).resolves.toBeUndefined();
});

it('answers a retention-refused Shell at once and says a retry will not help', async () => {
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: retentionExhausted,
  });
  turn = rig.turn;
  brokerStatusThroughCancel();
  const responses = await turn.execute(
    [foregroundShell],
    foregroundParts,
    'model',
    new AbortController().signal,
  );

  expect(answerText(responses)).toEqual([
    'This call was not started: Tool publication reservation refused at the session_bytes limit. Tool output already retained fills that limit and stays charged until the Session that produced it is deleted, so retrying now will not succeed.',
  ]);
  expect(rig.order.filter((item) => item === 'reserve')).toHaveLength(1);
  expect(await runtimeItemStates()).toEqual(['settled']);
});

it.each([
  [
    'a 429 that is not a limit refusal',
    () =>
      new ManagedSessionStoreHttpError(
        429,
        'managed_tool_publication_busy',
        'Tool publication entry capacity is exhausted',
      ),
  ],
  [
    'a limit code under another status',
    () =>
      new ManagedSessionStoreHttpError(
        400,
        'managed_tool_publication_capacity_exhausted',
        'Tool publication reservation refused at the active_captures limit',
      ),
  ],
  [
    'the retention code under another status',
    () =>
      new ManagedSessionStoreHttpError(
        429,
        'managed_tool_publication_retention_exhausted',
        'Tool publication reservation refused at the session_bytes limit',
      ),
  ],
  [
    'a 409 that is not a limit refusal',
    () =>
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_writer_conflict',
        'The Session writer changed',
      ),
  ],
])('keeps a batch recovery-blocked for %s', async (_label, refusal) => {
  const rig = backgroundTurnRig(unreachedOutcome, { refuse: refusal });
  turn = rig.turn;
  brokerStatusThroughCancel();
  await expect(
    turn.execute(
      [foregroundShell],
      foregroundParts,
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(await runtimeItemStates()).toEqual(['in_progress']);
  expect(await toolResultCount()).toBe(0);
});

it('answers a capacity-refused background Shell once its process ledger proves it never started', async () => {
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  const { call, parts } = backgroundCall();
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: capacityExhausted,
  });
  turn = rig.turn;
  brokerStatusThroughCancel();
  broker.backgroundProcessStatus.mockResolvedValue(undefined);
  const responses = await turn.execute(
    [call],
    parts,
    'model',
    new AbortController().signal,
  );

  expect(answerText(responses)).toEqual([CAPACITY_ANSWER]);
  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.orchestrator.calls.at(-1)?.[1]).toEqual({
    id: 'shell-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(await runtimeItemStates()).toEqual(['settled']);
  stderr.mockRestore();
});

it('keeps a capacity-refused background Shell recovery-blocked while its process proof is ambiguous', async () => {
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  const { call, parts } = backgroundCall();
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: capacityExhausted,
  });
  turn = rig.turn;
  brokerStatusThroughCancel();
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
  ]);
  expect(await runtimeItemStates()).toEqual(['in_progress']);
  stderr.mockRestore();
});

it('keeps a capacity-refused background Shell recovery-blocked when its record does not settle', async () => {
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  const { call, parts } = backgroundCall();
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: capacityExhausted,
  });
  turn = rig.turn;
  rig.orchestrator.settleFailed = async () => {
    throw new Error('record write refused');
  };
  brokerStatusThroughCancel();
  broker.backgroundProcessStatus.mockResolvedValue(undefined);
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(await runtimeItemStates()).toEqual(['in_progress']);
  stderr.mockRestore();
});

it('answers a capacity-refused Monitor on the Broker record that it never started', async () => {
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  const { call, parts } = monitorCall();
  const rig = monitorTurnRig(unreachedOutcome, { capacityRefused: true });
  turn = rig.turn;
  brokerStatusThroughCancel();
  const responses = await turn.execute(
    [call],
    parts,
    'model',
    new AbortController().signal,
  );

  expect(answerText(responses)).toEqual([CAPACITY_ANSWER]);
  expect(rig.monitors.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.monitors.calls.at(-1)?.[1]).toEqual({
    id: 'monitor-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(await runtimeItemStates()).toEqual(['settled']);
  stderr.mockRestore();
});

it.each([
  [
    'an execution already past prepared',
    (_id: string, cancelled: boolean) =>
      cancelled ? null : { state: 'executing' },
    1,
  ],
  [
    'an unreadable execution',
    (_id: string, cancelled: boolean) => {
      if (!cancelled) throw new Error('status unavailable');
      return null;
    },
    1,
  ],
  [
    'a cancelled execution that cannot be read',
    (_id: string, cancelled: boolean) => {
      if (cancelled) throw new Error('status unavailable');
      return null;
    },
    2,
  ],
  [
    'a cancelled execution the Broker no longer knows',
    (_id: string, cancelled: boolean) => (cancelled ? undefined : null),
    2,
  ],
  [
    'a cancelled execution whose outcome is unknown',
    (_id: string, cancelled: boolean) =>
      cancelled ? { state: 'unknown' } : null,
    2,
  ],
  [
    'a cancelled execution the Broker abandoned',
    (_id: string, cancelled: boolean) =>
      cancelled ? { state: 'abandoned' } : null,
    2,
  ],
  [
    'a Shell execution that settled with a result other than not started',
    (_id: string, cancelled: boolean) =>
      cancelled ? { state: 'settled', executionStatus: 'cancelled' } : null,
    2,
  ],
])(
  'keeps a capacity-refused batch recovery-blocked for %s',
  async (_label, override, statusReads) => {
    const rig = backgroundTurnRig(unreachedOutcome, {
      refuse: capacityExhausted,
    });
    turn = rig.turn;
    brokerStatusThroughCancel(override);
    await expect(
      turn.execute(
        [foregroundShell],
        foregroundParts,
        'model',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    // Each verdict is final: nothing waits out the window on it.
    expect(broker.status).toHaveBeenCalledTimes(statusReads);
    expect(await runtimeItemStates()).toEqual(['in_progress']);
    expect(await toolResultCount()).toBe(0);
  },
);

it('waits for each cancelled execution to settle before answering', async () => {
  const batch = [foregroundShell, calls[0]];
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: capacityExhausted,
  });
  turn = rig.turn;
  // Each execution's first read after its cancel is still pending.
  const pending = new Set<string>();
  brokerStatusThroughCancel((id, cancelled) => {
    if (!cancelled || pending.has(id)) return null;
    pending.add(id);
    return { state: 'cancel_requested' };
  });
  const responses = await turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  expect(answerText(responses)).toEqual([CAPACITY_ANSWER, BYSTANDER_ANSWER]);
  // Two reads before the cancels, then two after each.
  expect(broker.status).toHaveBeenCalledTimes(6);
});

it('keeps the batch recovery-blocked when a later execution does not settle', async () => {
  const shells = ['shell-a', 'shell-b'].map((id) => ({
    ...foregroundShell,
    callId: `${id}-call`,
  }));
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: (id) => (id === 'shell-b' ? capacityExhausted() : undefined),
    executionCallIds: ['shell-a', 'shell-b'],
  });
  turn = rig.turn;
  brokerStatusThroughCancel((id, cancelled) =>
    id === 'shell-b' && cancelled ? { state: 'unknown' } : null,
  );
  await expect(
    turn.execute(
      shells,
      shells.map((call) => ({
        functionCall: { id: call.callId, name: call.name, args: call.args },
      })),
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.status).toHaveBeenCalledTimes(4);
  expect(await toolResultCount()).toBe(0);
});

it('keeps a capacity-refused Monitor recovery-blocked when its record does not settle', async () => {
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  const { call, parts } = monitorCall();
  const rig = monitorTurnRig(unreachedOutcome, { capacityRefused: true });
  turn = rig.turn;
  rig.monitors.settleFailed = async () => {
    throw new Error('record write refused');
  };
  brokerStatusThroughCancel();
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(await runtimeItemStates()).toEqual(['in_progress']);
  stderr.mockRestore();
});

it('gives up at once when an execution could not be cancelled', async () => {
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: capacityExhausted,
  });
  turn = rig.turn;
  brokerStatusThroughCancel();
  broker.cancel.mockRejectedValue(new Error('cancel lost'));
  await expect(
    turn.execute(
      [foregroundShell],
      foregroundParts,
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  // Only the read before the cancel: nothing waits on a cancel that failed.
  expect(broker.status).toHaveBeenCalledTimes(1);
});

it.each(['cancel_requested', 'prepared'])(
  'gives up when a cancelled execution stays %s past its window',
  async (state) => {
    const rig = backgroundTurnRig(unreachedOutcome, {
      refuse: capacityExhausted,
    });
    turn = rig.turn;
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const now = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + skew);
    brokerStatusThroughCancel((_id, cancelled) => {
      if (!cancelled) return null;
      skew += 31_000;
      return { state };
    });
    try {
      await expect(
        turn.execute(
          [foregroundShell],
          foregroundParts,
          'model',
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
      expect(broker.status).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  },
);

it('keeps the batch recovery-blocked when a later execution lacks its proof', async () => {
  const shells = ['shell-a', 'shell-b'].map((id) => ({
    ...foregroundShell,
    callId: `${id}-call`,
  }));
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: (id) => (id === 'shell-b' ? capacityExhausted() : undefined),
    executionCallIds: ['shell-a', 'shell-b'],
  });
  turn = rig.turn;
  brokerStatusThroughCancel((id, cancelled) =>
    id === 'shell-b' && !cancelled ? { state: 'executing' } : null,
  );
  await expect(
    turn.execute(
      shells,
      shells.map((call) => ({
        functionCall: { id: call.callId, name: call.name, args: call.args },
      })),
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(await runtimeItemStates()).toEqual(['in_progress', 'in_progress']);
  expect(await toolResultCount()).toBe(0);
});

it('keeps a limit refusal raised after the batch started running recovery-blocked', async () => {
  // Only a reservation answers this code in production; one arriving once
  // calls may run proves nothing about which of them started.
  const rig = backgroundTurnRig(unreachedOutcome, {});
  turn = rig.turn;
  brokerStatusThroughCancel();
  broker.executeV3.mockRejectedValue(capacityExhausted());
  await expect(
    turn.execute(
      [foregroundShell],
      foregroundParts,
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.status).not.toHaveBeenCalled();
  expect(await toolResultCount()).toBe(0);
});

it('wraps a failed answer in the recovery error', async () => {
  // Only the answer, written after the refusal, cannot be stored inline.
  let refused = false;
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: () => {
      refused = true;
      return capacityExhausted();
    },
    fitsInline: (type) => !(refused && type === 'tool_result'),
  });
  turn = rig.turn;
  brokerStatusThroughCancel();
  await expect(
    turn.execute(
      [foregroundShell],
      foregroundParts,
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(await runtimeItemStates()).toEqual(['in_progress']);
  expect(await toolResultCount()).toBe(0);
});

it('answers every call of a mixed batch and closes every reservation', async () => {
  const shells = ['shell-a', 'shell-b'].map((id) => ({
    ...foregroundShell,
    callId: `${id}-call`,
  }));
  const batch = [shells[0]!, calls[0], calls[1], shells[1]!];
  const batchParts: Part[] = batch.map((call) => ({
    functionCall: { id: call.callId, name: call.name, args: call.args },
  }));
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: (id) => (id === 'shell-b' ? capacityExhausted() : undefined),
    executionCallIds: ['shell-a', 'shell-b'],
  });
  turn = rig.turn;
  brokerStatusThroughCancel();
  // The read_file is refused before dispatch and keeps that answer.
  broker.prepare.mockRejectedValueOnce(
    new HostedWorkspaceBrokerRejection(
      409,
      'runtime_execution_conflict',
      undefined,
      'conflicting execution',
    ),
  );
  const responses = await turn.execute(
    batch,
    batchParts,
    'model',
    new AbortController().signal,
  );

  expect(broker.executeV3).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(responses.map((part) => part.functionResponse?.id)).toEqual([
    'shell-a-call',
    'call-0',
    'call-1',
    'shell-b-call',
  ]);
  const answers = answerText(responses);
  expect(answers[1]).toContain(
    'Runtime refused this execution reservation before dispatch',
  );
  // Both Shells reserve, so fewer of them may fit; the Edit reserves
  // nothing and can go without them.
  const shellAnswer =
    'This call was not started: Tool publication reservation refused at the active_captures limit. Retry after the running tools finish, or send fewer run_shell_command calls in one batch.';
  expect([answers[0], answers[2], answers[3]]).toEqual([
    shellAnswer,
    BYSTANDER_ANSWER,
    shellAnswer,
  ]);
  expect(rig.closed).toEqual([
    rig.publications.get('shell-a'),
    rig.publications.get('shell-b'),
  ]);
  // The Edit's prepared file history is settled like a finished batch's.
  expect(broker.fileHistory).toHaveBeenLastCalledWith({
    kind: 'raw-file-history',
    action: 'snapshot',
  });
  expect((await readHostedFileHistory(session))?.pendingTurn).toBeNull();
  expect(await runtimeItemStates()).toEqual(['settled', 'settled', 'settled']);
});

// #14518: the store says how many reservations of this size the Session
// could ever hold at once, so a batch needing more is told to send fewer
// calls instead of to wait.
function limitRefusal(
  limit: string,
  admits: number | string,
  status: 429 | 409 = 429,
) {
  return new ManagedSessionStoreHttpError(
    status,
    status === 429
      ? 'managed_tool_publication_capacity_exhausted'
      : 'managed_tool_publication_retention_exhausted',
    `Tool publication reservation refused at the ${limit} limit`,
    undefined,
    { request_id: 'request-1', limit, admits },
  );
}

function shellBatch(count: number) {
  const shells = Array.from({ length: count }, (_, index) => ({
    ...foregroundShell,
    callId: `shell-${index}-call`,
  }));
  return {
    shells,
    parts: shells.map(
      (call): Part => ({
        functionCall: { id: call.callId, name: call.name, args: call.args },
      }),
    ),
    ids: shells.map((_, index) => `shell-${index}`),
  };
}

it.each(['active_captures', 'tenant_bytes', 'session_bytes'])(
  'tells a batch of more Shells than its Session could ever hold at the %s limit to send fewer, without retrying',
  async (limit) => {
    const batch = shellBatch(3);
    const cause = limitRefusal(limit, 2);
    // The last of the three reservations is the one the limit refuses.
    const rig = backgroundTurnRig(unreachedOutcome, {
      refuse: (id) => (id === 'shell-2' ? cause : undefined),
      executionCallIds: batch.ids,
    });
    turn = rig.turn;
    brokerStatusThroughCancel();
    const responses = await turn.execute(
      batch.shells,
      batch.parts,
      'model',
      new AbortController().signal,
    );

    expect(answerText(responses)).toEqual(
      Array(3).fill(
        `This call was not started: Tool publication reservation refused at the ${limit} limit. This batch has 3 run_shell_command calls, but this Session can run at most 2 of them at a time, so retrying the same batch will not succeed. Send at most 2 of them in one batch.`,
      ),
    );
    // Waiting cannot make the batch fit, so its refusal is not retried.
    expect(rig.order.filter((item) => item === 'reserve')).toHaveLength(3);
    expect(rig.closed).toEqual(batch.ids.map((id) => rig.publications.get(id)));
    expect(await runtimeItemStates()).toEqual([
      'settled',
      'settled',
      'settled',
    ]);
  },
);

it('does not retry the first reservation of a batch its Session could never hold', async () => {
  const batch = shellBatch(3);
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: (id) =>
      id === 'shell-0' ? limitRefusal('session_bytes', 2) : undefined,
    executionCallIds: batch.ids,
  });
  turn = rig.turn;
  brokerStatusThroughCancel();
  const responses = await turn.execute(
    batch.shells,
    batch.parts,
    'model',
    new AbortController().signal,
  );

  expect(answerText(responses)).toEqual(
    Array(3).fill(
      'This call was not started: Tool publication reservation refused at the session_bytes limit. This batch has 3 run_shell_command calls, but this Session can run at most 2 of them at a time, so retrying the same batch will not succeed. Send at most 2 of them in one batch.',
    ),
  );
  expect(rig.order.filter((item) => item === 'reserve')).toHaveLength(1);
});

it.each([
  ['admits the whole batch at once', limitRefusal('active_captures', 2)],
  ['does not say', capacityExhausted()],
  ['says it as text', limitRefusal('active_captures', '1')],
  ['says a fraction', limitRefusal('tenant_bytes', 1.5)],
  // A 429 always admits one; a smaller count is not acted on.
  ['admits none', limitRefusal('session_bytes', 0)],
])(
  'retries a batch whose refusal %s and says fewer calls may fit sooner',
  async (_label, cause) => {
    const batch = shellBatch(2);
    const rig = backgroundTurnRig(unreachedOutcome, {
      refuse: (id) => (id === 'shell-1' ? cause : undefined),
      executionCallIds: batch.ids,
    });
    turn = rig.turn;
    brokerStatusThroughCancel();
    const responses = await turn.execute(
      batch.shells,
      batch.parts,
      'model',
      new AbortController().signal,
    );

    expect(answerText(responses)).toEqual(
      Array(2).fill(
        `This call was not started: ${cause.message}. Retry after the running tools finish, or send fewer run_shell_command calls in one batch.`,
      ),
    );
    // One grant, then the refused reservation's three attempts.
    expect(rig.order.filter((item) => item === 'reserve')).toHaveLength(4);
  },
);

it('keeps the retention answer for a batch its Session could never hold, and frees the call that reserves nothing', async () => {
  const batch = shellBatch(3);
  const all = [...batch.shells, calls[0]];
  // Another Session's used bytes fill the tenant: the Session could hold
  // two later, but none fits now, so the retention answer wins.
  const rig = backgroundTurnRig(unreachedOutcome, {
    refuse: () => limitRefusal('tenant_bytes', 2, 409),
    executionCallIds: batch.ids,
  });
  turn = rig.turn;
  brokerStatusThroughCancel();
  const responses = await turn.execute(
    all,
    all.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );

  expect(answerText(responses)).toEqual([
    ...Array(3).fill(
      'This call was not started: Tool publication reservation refused at the tenant_bytes limit. Tool output already retained fills that limit and stays charged until the Session that produced it is deleted, so retrying now will not succeed.',
    ),
    'This call was not started: another call in its batch was refused before any call ran (Tool publication reservation refused at the tenant_bytes limit). This call needs no tool output capacity, so it can be retried in a batch without the refused calls.',
  ]);
  expect(rig.order.filter((item) => item === 'reserve')).toHaveLength(1);
});

it('probes every inconclusive background binding within one timeout window', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  vi.useFakeTimers();
  let guard: ReturnType<typeof realSetTimeout> | undefined;
  try {
    const template = backgroundCall().call;
    const backgroundCalls = [1, 2].map((index) => ({
      ...template,
      callId: `background-call-${index}`,
    }));
    const backgroundParts: Part[] = backgroundCalls.map((call) => ({
      functionCall: {
        id: call.callId,
        name: call.name,
        args: call.args,
      },
    }));
    const rig = backgroundTurnRig(
      { executionStatus: 'success', responseParts: [], capture: null },
      {
        publicationMissing: true,
        executionCallIds: ['shell-execution-1', 'shell-execution-2'],
      },
    );
    turn = rig.turn;
    broker.executeV3.mockRejectedValue(new Error('trigger recovery'));
    let resolveBothProbes!: () => void;
    const bothProbesStarted = new Promise<void>((resolve) => {
      resolveBothProbes = resolve;
    });
    broker.backgroundProcessStatus.mockImplementation(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          if (broker.backgroundProcessStatus.mock.calls.length === 2)
            resolveBothProbes();
          setTimeout(
            () => reject(new DOMException('timed out', 'TimeoutError')),
            30_000,
          );
        }),
    );
    let completed = false;
    const outcome = turn
      .execute(
        backgroundCalls,
        backgroundParts,
        'model',
        new AbortController().signal,
      )
      .then(
        () => ({ rejection: undefined }),
        (rejection: unknown) => ({ rejection }),
      )
      .finally(() => {
        completed = true;
      });
    // A deadlock guard, not a latency assertion: the probes are mock calls
    // that only need to be in flight together, and a shared runner under load
    // can spend more than a second scheduling them (release run 39192115354
    // failed this guard on all three attempts while every other test passed).
    const guardedStart = new Promise<never>((_resolve, reject) => {
      guard = realSetTimeout(
        () => reject(new Error('both probes did not start concurrently')),
        10_000,
      );
    });

    await Promise.race([bothProbesStarted, guardedStart]);
    if (guard !== undefined) realClearTimeout(guard);
    guard = undefined;
    expect(broker.backgroundProcessStatus).toHaveBeenCalledTimes(2);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const { rejection } = await outcome;
    expect(completed).toBe(true);
    expect(rejection).toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(
      rig.order.filter((item) => item === 'close_not_started'),
    ).toHaveLength(2);
    expect(
      rig.orchestrator.calls.filter(([name]) => name === 'settleFailed'),
    ).toHaveLength(0);
  } finally {
    if (guard !== undefined) realClearTimeout(guard);
    vi.useRealTimers();
    turn = createTurn();
  }
});

it('settles grant-proven bindings before waiting for process probes', async () => {
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  vi.useFakeTimers();
  let guard: ReturnType<typeof realSetTimeout> | undefined;
  try {
    const template = backgroundCall().call;
    const backgroundCalls = [1, 2].map((index) => ({
      ...template,
      callId: `background-call-${index}`,
    }));
    const backgroundParts: Part[] = backgroundCalls.map((call) => ({
      functionCall: {
        id: call.callId,
        name: call.name,
        args: call.args,
      },
    }));
    const rig = backgroundTurnRig(
      { executionStatus: 'success', responseParts: [], capture: null },
      {
        closeResults: ['NOT_STARTED', 'MISSING'],
        executionCallIds: ['shell-execution-1', 'shell-execution-2'],
      },
    );
    turn = rig.turn;
    broker.executeV3.mockRejectedValue(new Error('trigger recovery'));
    let resolveProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      resolveProbeStarted = resolve;
    });
    broker.backgroundProcessStatus.mockImplementation(() => {
      resolveProbeStarted();
      return new Promise<undefined>((_resolve, reject) => {
        setTimeout(
          () => reject(new DOMException('timed out', 'TimeoutError')),
          30_000,
        );
      });
    });
    const outcome = turn
      .execute(
        backgroundCalls,
        backgroundParts,
        'model',
        new AbortController().signal,
      )
      .then(
        () => ({ rejection: undefined }),
        (rejection: unknown) => ({ rejection }),
      );
    const guardedStart = new Promise<never>((_resolve, reject) => {
      guard = realSetTimeout(
        () => reject(new Error('process probe did not start')),
        10_000,
      );
    });

    await Promise.race([probeStarted, guardedStart]);
    if (guard !== undefined) realClearTimeout(guard);
    guard = undefined;
    expect(broker.backgroundProcessStatus).toHaveBeenCalledOnce();
    expect(rig.orchestrator.calls.at(-1)).toEqual([
      'settleFailed',
      {
        id: 'shell-execution-1',
        params: { stopReason: 'start_failed', started: false },
      },
    ]);
    // Grant-owner proof is not process-ledger proof.
    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining('from durable process-ledger absence'),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const { rejection } = await outcome;
    expect(rejection).toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(
      rig.orchestrator.calls.filter(([name]) => name === 'settleFailed'),
    ).toHaveLength(1);
  } finally {
    if (guard !== undefined) realClearTimeout(guard);
    vi.useRealTimers();
    turn = createTurn();
  }
});

it('settles only the binding whose own probe proves absence in a mixed fan-out', async () => {
  const stderr = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  try {
    const template = backgroundCall().call;
    const backgroundCalls = [1, 2].map((index) => ({
      ...template,
      callId: `background-call-${index}`,
    }));
    const backgroundParts: Part[] = backgroundCalls.map((call) => ({
      functionCall: {
        id: call.callId,
        name: call.name,
        args: call.args,
      },
    }));
    const rig = backgroundTurnRig(
      { executionStatus: 'success', responseParts: [], capture: null },
      {
        publicationMissing: true,
        executionCallIds: ['shell-execution-1', 'shell-execution-2'],
      },
    );
    turn = rig.turn;
    broker.executeV3.mockRejectedValue(new Error('trigger recovery'));
    broker.backgroundProcessStatus.mockImplementation(async () =>
      broker.backgroundProcessStatus.mock.calls.length === 1
        ? { state: 'executing' }
        : undefined,
    );
    const outcome = turn
      .execute(
        backgroundCalls,
        backgroundParts,
        'model',
        new AbortController().signal,
      )
      .then(
        () => ({ rejection: undefined }),
        (rejection: unknown) => ({ rejection }),
      );

    const { rejection } = await outcome;
    expect(rejection).toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(broker.backgroundProcessStatus).toHaveBeenCalledTimes(2);
    expect(
      rig.orchestrator.calls.filter(([name]) => name === 'settleFailed'),
    ).toEqual([
      [
        'settleFailed',
        {
          id: 'shell-execution-2',
          params: { stopReason: 'start_failed', started: false },
        },
      ],
    ]);
    expect(stderr).toHaveBeenCalledWith(
      'qwen serve: Background process absence could not be confirmed for shell-execution-1 (ambiguous_state (executing)).',
    );
    expect(stderr).toHaveBeenCalledWith(
      'qwen serve: Settled never-started background child run shell-execution-2 from durable process-ledger absence.',
    );
  } finally {
    stderr.mockRestore();
  }
});

it('keeps an in-flight dispatch blocked when cancellation fails before process admission', async () => {
  const { call, parts } = backgroundCall();
  const rig = backgroundTurnRig(
    { executionStatus: 'success', responseParts: [], capture: null },
    { publicationMissing: true },
  );
  turn = rig.turn;
  broker.executeV3.mockRejectedValueOnce(
    new HostedWorkspaceBrokerRejection(503, 'store_unavailable'),
  );
  broker.cancel.mockRejectedValueOnce(
    new HostedWorkspaceBrokerRejection(503, 'store_unavailable'),
  );
  broker.backgroundProcessStatus.mockResolvedValue(undefined);

  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

  expect(broker.backgroundProcessStatus).not.toHaveBeenCalled();
  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
  ]);
});

it.each(['present', 'unavailable'] as const)(
  'keeps an in-turn dispatch blocked when its process proof is %s',
  async (proof) => {
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { call, parts } = backgroundCall();
    const rig = backgroundTurnRig(
      { executionStatus: 'success', responseParts: [], capture: null },
      { reserveRefused: true, publicationMissing: true },
    );
    turn = rig.turn;
    if (proof === 'present')
      broker.backgroundProcessStatus.mockResolvedValue({ state: 'executing' });
    else
      broker.backgroundProcessStatus.mockRejectedValue(
        new HostedWorkspaceBrokerRejection(503, 'store_unavailable'),
      );
    await expect(
      turn.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

    expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
      'admit',
      'dispatchStarted',
    ]);
    expect(stderr).toHaveBeenCalledWith(
      proof === 'present'
        ? 'qwen serve: Background process absence could not be confirmed for shell-execution (ambiguous_state (executing)).'
        : 'qwen serve: Background process absence could not be confirmed for shell-execution (probe_rejected (status 503, code store_unavailable)).',
    );
    stderr.mockRestore();
  },
);

it('settles the admitted child run when executeV3 fails without the proven 409', async () => {
  // R3-24: dispatch_started is durable and the v3 start then fails with
  // anything but the execution-unknown 409 — the turn refuses recovery,
  // and the admitted record settles under the same close_not_started
  // proof instead of reporting running forever.
  const { call, parts } = backgroundCall();
  const unreached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [{ text: 'unreached' }],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(unreached);
  turn = rig.turn;
  broker.executeV3.mockRejectedValueOnce(
    new HostedWorkspaceBrokerRejection(500, 'runtime_internal_error'),
  );
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

  expect(rig.orchestrator.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.orchestrator.calls.at(-1)?.[1]).toEqual({
    id: 'shell-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'renew',
    'close_not_started',
  ]);
});

it('settles the admitted monitor run on the same unstarted recovery proof', async () => {
  // R3-23 monitor half: the monitor_run record admitted at dispatch time
  // faces the same refusal windows and must settle under the same proof.
  const { call, parts } = monitorCall();
  const unreached: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [{ text: 'unreached' }],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = monitorTurnRig(unreached, { reserveRefused: true });
  turn = rig.turn;
  await expect(
    turn.execute([call], parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);

  expect(rig.monitors.calls.map(([name]) => name)).toEqual([
    'admit',
    'dispatchStarted',
    'settleFailed',
  ]);
  expect(rig.monitors.calls.at(-1)?.[1]).toEqual({
    id: 'monitor-execution',
    params: { stopReason: 'start_failed', started: false },
  });
  expect(rig.order).toEqual([
    'assistant',
    'reserve',
    'reserve',
    'reserve',
    'close_not_started',
  ]);
});

it('keeps the deliberate refusal while child_run stays disabled', async () => {
  const stillAdmitted: ToolResultEnvelope = {
    executionStatus: 'success',
    responseParts: [{ text: 'unreached' }],
    capture: {
      captureStatus: 'detached',
      captureReason: null,
      manifest: null,
      previewTruncated: false,
      deliveryStatus: 'pending',
    },
  };
  const rig = backgroundTurnRig(stillAdmitted);
  turn = rig.turn;
  enablement.childRun = false;
  enablement.monitorRun = false;
  const { call, parts } = backgroundCall();
  const result = await turn.execute(
    [call],
    parts,
    'model',
    new AbortController().signal,
  );
  expect(result[0]?.functionResponse?.response).toMatchObject({
    error: 'Hosted Shell requires one foreground command.',
  });
  expect(rig.orchestrator.calls).toHaveLength(0);
  expect(broker.executeV3).not.toHaveBeenCalled();
  expect(broker.prepareV3).not.toHaveBeenCalled();
});

it('refuses a malformed permission rewrite on an admitted background Shell', async () => {
  const fire = vi
    .fn<HostedHookSession['fire']>()
    .mockImplementation(async (event) =>
      event === HookEventName.PermissionRequest
        ? {
            hookSpecificOutput: {
              decision: {
                behavior: 'allow',
                updatedInput: { command: '\ud800', is_background: true },
              },
            },
          }
        : undefined,
    );
  const rig = backgroundTurnRig(
    { executionStatus: 'success', responseParts: [], capture: null },
    { hooks: hookSession(fire), approval: 'default' },
  );
  turn = rig.turn;
  const { call, parts: input } = backgroundCall();
  const responses = await turn.execute(
    [call],
    input,
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toContain(
    'unpaired UTF-16 surrogate',
  );
  expect(rig.orchestrator.calls).toHaveLength(0);
  expect(broker.prepareV3).not.toHaveBeenCalled();
  expect(broker.executeV3).not.toHaveBeenCalled();
  expect(broker.acquire).toHaveBeenCalledOnce();
});

it.each(['auto', 'yolo'] as const)(
  'enforces Session deny rules on extension command steps in %s mode',
  async (mode) => {
    turn = createTurn(true, {
      mode,
      permissionRules: { allow: [], ask: [], deny: ['Bash'] },
    });
    const signal = new AbortController().signal;
    await turn.declarations(signal);
    const permission = await (
      turn as unknown as {
        commandPermission(
          id: string,
          toolName: 'shell',
          input: Record<string, unknown>,
          signal: AbortSignal,
          outerCallId: string,
        ): Promise<{ allowed: boolean; approvalMode: string }>;
      }
    ).commandPermission(
      'command-step',
      'shell',
      { command: 'printf denied' },
      signal,
      'outer-command',
    );
    expect(permission).toMatchObject({ allowed: false, approvalMode: mode });
    expect(actionIds()).toEqual([]);
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it('honors an explicit Session allow rule for an extension command step', async () => {
  turn = createTurn(true, {
    mode: 'default',
    permissionRules: { allow: ['Bash'], ask: [], deny: [] },
  });
  const signal = new AbortController().signal;
  await turn.declarations(signal);
  const permission = await (
    turn as unknown as {
      commandPermission(
        id: string,
        toolName: 'shell',
        input: Record<string, unknown>,
        signal: AbortSignal,
        outerCallId: string,
      ): Promise<{ allowed: boolean }>;
    }
  ).commandPermission(
    'command-step',
    'shell',
    { command: 'printf allowed' },
    signal,
    'outer-command',
  );
  expect(permission.allowed).toBe(true);
  expect(actionIds()).toEqual([]);
});
