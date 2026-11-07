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
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { PDF_MAX_PAGES_PER_READ } from '@qwen-code/qwen-code-core/utils/pdf.js';
import { type HttpToolPublicationOwner } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import type { HostedHookSession } from './hosted-hook-session.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { boundedShellPreview } from './managed-shell-publisher.js';
import { HostedWorkspaceBrokerRejection } from './hosted-workspace-broker.js';
import {
  HostedWorkspaceToolTurn,
  HostedToolRecoveryRequiredError,
  HOSTED_WORKSPACE_FILE_TOOLS,
} from './hosted-workspace-tool-turn.js';
import {
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  hostedApprovalAsks,
  resolveHostedAction,
  type HostedApprovalMode,
  type HostedApprovalSettings,
} from './hosted-tool-approval.js';
import * as stdio from '../utils/stdioHelpers.js';
import {
  HOSTED_SKILL_APPROVAL_REFUSAL,
  HOSTED_SKILL_BATCH_REFUSAL,
  HostedSkillCatalog,
} from './hosted-skill-catalog.js';
import { answerResumedTurnCalls } from './hosted-runtime-recovery.js';
import { writeHostedTodos } from './hosted-todo-session.js';
import { HostedCsiToolTurn } from './hosted-csi-tool-turn.js';
import * as hostedPlan from './hosted-plan-mode.js';
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

const publishedSkills = () =>
  new HostedSkillCatalog([
    {
      name: 'review',
      description: 'Review code changes.',
      body: 'Consult scripts/review.js before reviewing.',
      base_directory: '.qwen/skills/review',
    },
  ]);

it.each(['none', 'public', 'member'] as const)(
  'loads a published static Skill durably without Runtime execution or approval (Plan: %s)',
  async (planMode) => {
    if (planMode === 'public')
      vi.spyOn(hostedPlan, 'hostedPublicPlanActive').mockResolvedValue(true);
    const skills = publishedSkills();
    turn = createTurn(false, { mode: 'default' }, undefined, skills, planMode);
    const call = { ...calls[0], name: 'skill', args: { skill: 'review' } };
    const original: Part[] = [
      { functionCall: { id: call.callId, name: call.name, args: call.args } },
    ];
    expect(
      await turn.declarations(new AbortController().signal),
    ).toContainEqual(skills.declaration());
    if (planMode === 'public')
      expect(await turn.declarations(new AbortController().signal)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'write_file' }),
        ]),
      );
    const responses = await turn.execute(
      [call],
      original,
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['output']).toBe(
      skills.response(call.args),
    );
    const history = await session.sink.project();
    expect(history.map((entry) => entry.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    expect(history[1].message?.parts).toEqual(
      JSON.parse(JSON.stringify(responses)),
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    expect(
      session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .some((event) => event.kind === 'action.changed'),
    ).toBe(false);
    await turn.finish();
    const reloaded = createTurn(false, undefined, undefined, skills);
    await reloaded.resumeCommittedResults(new AbortController().signal);
    expect(broker.acquire).not.toHaveBeenCalled();
  },
);

it('persists the model-facing Skill batch budget so replay cannot restore discarded text', async () => {
  const body = 'FIRST_MARKER' + 'x'.repeat(400 * 1024) + 'LAST_MARKER';
  const skills = new HostedSkillCatalog([
    { name: 'first', description: 'First', body, model_invocable: false },
    { name: 'second', description: 'Second', body, model_invocable: false },
  ]);
  turn = createTurn(false, undefined, undefined, skills);
  turn.setToolOutputBudget(200000);
  const batch = ['first', 'second'].map((name, index) => ({
    ...calls[index]!,
    name: 'skill',
    args: { skill: name },
    isClientInitiated: true,
  }));
  const parts: Part[] = batch.map((call) => ({
    functionCall: { id: call.callId, name: call.name, args: call.args },
  }));
  const result = await turn.execute(
    batch,
    parts,
    'model',
    new AbortController().signal,
  );
  const outputs = result.map((part) =>
    String(part.functionResponse?.response?.['output'] ?? ''),
  );
  expect(
    outputs.reduce((total, text) => total + text.length, 0),
  ).toBeLessThanOrEqual(200000);
  for (const text of outputs) expect(text).toContain('Tool output truncated.');
  const saved = (await session.sink.project())
    .filter((entry) => entry.type === 'tool_result')
    .flatMap((entry) => entry.message?.parts ?? []);
  expect(JSON.parse(JSON.stringify(saved))).toEqual(
    JSON.parse(JSON.stringify(result)),
  );
  expect(skills.response({ skill: 'first' })).toContain(body);
});

it('refuses a mixed Skill and Workspace batch before approval Hooks or tool dispatch', async () => {
  const fire = vi.fn<HostedHookSession['fire']>().mockResolvedValue(undefined);
  turn = createTurn(
    false,
    { mode: 'default' },
    hookSession(fire),
    publishedSkills(),
  );
  const batch = [
    { ...calls[0], name: 'skill', args: { skill: 'review' } },
    {
      ...calls[1],
      name: 'write_file',
      args: { file_path: 'output.txt', content: 'must not write' },
    },
  ];
  const responses = await turn.execute(
    batch,
    batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toBe(
    HOSTED_SKILL_BATCH_REFUSAL,
  );
  expect(responses[1].functionResponse?.response?.['error']).toContain(
    'not executed',
  );
  expect(actionIds()).toEqual([]);
  expect(broker.acquire).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(fire.mock.calls.map(([event]) => event)).toEqual([
    HookEventName.PostToolBatch,
  ]);
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .some((event) => event.kind === 'hosted.batch.planned'),
  ).toBe(false);
});

it.each([{ skill: 'unknown' }, { skill: 'review', args: '--post' }])(
  'persists a correctable Skill refusal without executing anything: %j',
  async (args) => {
    turn = createTurn(false, undefined, undefined, publishedSkills());
    const call = { ...calls[0], name: 'skill', args };
    const responses = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args } }],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toBeTypeOf(
      'string',
    );
    expect((await session.sink.project()).map((entry) => entry.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it.each([0, 1])(
  'recovers a large manual Skill batch after %i results committed within its original budget',
  async (committedResults) => {
    const body = 'BEGIN_SKILL' + 'x'.repeat(400 * 1024) + 'END_SKILL';
    const skills = new HostedSkillCatalog(
      ['first', 'second'].map((name) => ({
        name,
        description: name,
        body,
        model_invocable: false,
      })),
    );
    const originalCommit = commit;
    let resultCount = 0;
    commit = async (...args) => {
      if (args[0] === 'tool_result' && resultCount++ === committedResults)
        throw new Error('Store response lost');
      return originalCommit(...args);
    };
    turn = createTurn(false, undefined, undefined, skills);
    const batch = ['first', 'second'].map((name, index) => ({
      ...calls[index]!,
      name: 'skill',
      args: { skill: name },
      isClientInitiated: true,
    }));
    await expect(
      turn.execute(
        batch,
        batch.map((call) => ({
          functionCall: { id: call.callId, name: call.name, args: call.args },
        })),
        'model',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    const recovery = {
      session,
      sessionId: session.authority.sessionHeader.sessionKey.sessionId,
      cwd: root,
      promptId: 'prompt',
      skills,
    };
    expect(await answerResumedTurnCalls(recovery)).toBe(2 - committedResults);
    expect(await answerResumedTurnCalls(recovery)).toBe(0);
    const saved = (await session.sink.project())
      .filter((entry) => entry.type === 'tool_result')
      .flatMap((entry) => entry.message?.parts ?? []);
    const outputs = saved.map((part) =>
      String(part.functionResponse?.response?.['output'] ?? ''),
    );
    expect(outputs).toHaveLength(2);
    expect(
      outputs.reduce((total, text) => total + text.length, 0),
    ).toBeLessThanOrEqual(200000);
    for (const text of outputs) {
      expect(text).toContain('Tool output truncated.');
      expect(text).toContain('BEGIN_SKILL');
      expect(text).toContain('END_SKILL');
    }
    expect(skills.response({ skill: 'first' })).toContain(body);
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it.each([
  { model_invocable: false, isClientInitiated: false },
  { user_invocable: false, isClientInitiated: true },
])(
  'preserves invocation restrictions and the whole-batch refusal on recovery: %j',
  async (flags) => {
    const { isClientInitiated, ...restrictions } = flags;
    const skills = new HostedSkillCatalog([
      {
        name: 'restricted',
        description: 'Restricted',
        body: 'MUST_NOT_LOAD',
        ...restrictions,
      },
      { name: 'ordinary', description: 'Ordinary', body: 'ALSO_MUST_NOT_LOAD' },
    ]);
    const originalCommit = commit;
    commit = async (...args) => {
      if (args[0] === 'tool_result') throw new Error('Store refusal lost');
      return originalCommit(...args);
    };
    turn = createTurn(false, undefined, undefined, skills);
    const batch = ['restricted', 'ordinary'].map((name, index) => ({
      ...calls[index]!,
      name: 'skill',
      args: { skill: name },
      isClientInitiated,
    }));
    await expect(
      turn.execute(
        batch,
        batch.map((call) => ({
          functionCall: { id: call.callId, name: call.name, args: call.args },
        })),
        'model',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(
      await answerResumedTurnCalls({
        session,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        cwd: root,
        promptId: 'prompt',
        skills,
      }),
    ).toBe(2);
    const results = (await session.sink.project())
      .filter((record) => record.type === 'tool_result')
      .flatMap((record) => record.message?.parts ?? []);
    expect(results).toHaveLength(2);
    for (const part of results)
      expect(part.functionResponse?.response?.['error']).toBeTypeOf('string');
    expect(JSON.stringify(results)).not.toContain('MUST_NOT_LOAD');
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it('recovers the original Skill body after the assistant commits but its result does not', async () => {
  const skills = publishedSkills();
  const originalCommit = commit;
  commit = async (...args) => {
    if (args[0] === 'tool_result') throw new Error('Store response lost');
    return originalCommit(...args);
  };
  turn = createTurn(false, undefined, undefined, skills);
  const call = { ...calls[0], name: 'skill', args: { skill: 'review' } };
  await expect(
    turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect((await session.sink.project()).map((entry) => entry.type)).toEqual([
    'assistant',
  ]);
  const recovery = {
    session,
    sessionId: session.authority.sessionHeader.sessionKey.sessionId,
    cwd: root,
    promptId: 'prompt',
    skills,
  };
  expect(await answerResumedTurnCalls(recovery)).toBe(1);
  expect(await answerResumedTurnCalls(recovery)).toBe(0);
  const history = await session.sink.project();
  expect(history).toHaveLength(2);
  expect(history[1].message?.parts?.[0].functionResponse).toMatchObject({
    id: call.callId,
    name: 'skill',
    response: { output: skills.response(call.args) },
  });
  expect(broker.acquire).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
});

it('preserves a mixed-batch Skill refusal when its result was not committed', async () => {
  const skills = publishedSkills();
  const originalCommit = commit;
  commit = async (...args) => {
    if (args[0] === 'tool_result') throw new Error('Store refusal lost');
    return originalCommit(...args);
  };
  turn = createTurn(false, { mode: 'default' }, undefined, skills);
  const batch = [
    { ...calls[0], name: 'skill', args: { skill: 'review' } },
    calls[1],
  ];
  await expect(
    turn.execute(
      batch,
      batch.map((call) => ({
        functionCall: { id: call.callId, name: call.name, args: call.args },
      })),
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect((await session.sink.project()).map((entry) => entry.type)).toEqual([
    'assistant',
  ]);
  const recovery = {
    session,
    sessionId: session.authority.sessionHeader.sessionKey.sessionId,
    cwd: root,
    promptId: 'prompt',
    skills,
  };
  expect(await answerResumedTurnCalls(recovery)).toBe(1);
  expect(await answerResumedTurnCalls(recovery)).toBe(0);
  const history = await session.sink.project();
  expect(history).toHaveLength(2);
  expect(history[1].message?.parts?.[0].functionResponse).toMatchObject({
    id: batch[0].callId,
    name: 'skill',
    response: { error: HOSTED_SKILL_BATCH_REFUSAL },
  });
  expect(JSON.stringify(history[1])).not.toContain(
    'Consult scripts/review.js before reviewing.',
  );
  expect(actionIds()).toEqual([]);
  expect(broker.acquire).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
});

it.each(['deny', 'ask'] as const)(
  'preserves a PreToolUse %s for a static Skill without creating an Action',
  async (permissionDecision) => {
    const fire = vi.fn<HostedHookSession['fire']>(async (event) =>
      event === HookEventName.PreToolUse
        ? {
            hookSpecificOutput: {
              hookEventName: event,
              permissionDecision,
              permissionDecisionReason: 'Skill policy refused the load.',
            },
          }
        : undefined,
    );
    turn = createTurn(
      false,
      { mode: 'default' },
      hookSession(fire),
      publishedSkills(),
    );
    const call = { ...calls[0], name: 'skill', args: { skill: 'review' } };
    const responses = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toBe(
      permissionDecision === 'ask'
        ? HOSTED_SKILL_APPROVAL_REFUSAL
        : 'Skill policy refused the load.',
    );
    expect(fire.mock.calls.map(([event]) => event)).toEqual([
      HookEventName.PreToolUse,
      HookEventName.PostToolBatch,
    ]);
    expect(actionIds()).toEqual([]);
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it('loads the Skill selected by PreToolUse updatedInput without a new approval', async () => {
  const skills = new HostedSkillCatalog([
    {
      name: 'review',
      description: 'Review code.',
      body: 'Original review body.',
    },
    {
      name: 'testing',
      description: 'Test code.',
      body: 'Replacement test body.',
    },
  ]);
  const fire = vi.fn<HostedHookSession['fire']>(async (event) =>
    event === HookEventName.PreToolUse
      ? {
          hookSpecificOutput: {
            hookEventName: event,
            updatedInput: { skill: 'testing' },
          },
        }
      : undefined,
  );
  turn = createTurn(false, { mode: 'default' }, hookSession(fire), skills);
  const call = { ...calls[0], name: 'skill', args: { skill: 'review' } };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['output']).toBe(
    skills.response({ skill: 'testing' }),
  );
  expect(fire.mock.calls.map(([event]) => event)).toEqual([
    HookEventName.PreToolUse,
    HookEventName.PostToolUse,
    HookEventName.PostToolBatch,
  ]);
  expect(actionIds()).toEqual([]);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
});

it('commits the whole batch before the first dispatch and each receipt before resolving it', async () => {
  const original = harness.resolveAwaitRuntime.bind(harness);
  vi.spyOn(harness, 'resolveAwaitRuntime').mockImplementation(
    async (id, ref) => {
      expect((await session.sink.project()).at(-1)?.type).toBe('tool_result');
      expect(
        JSON.parse((await session.resources.read(ref)).toString())
          .executionCallId,
      ).toBe(id);
      return original(id, ref);
    },
  );
  broker.execute.mockImplementation(async () => {
    const authorization = await session.authority.harnessRunAuthorization();
    expect(authorization.status).toBe('runnable');
    if (authorization.status !== 'runnable') throw new Error('No checkpoint');
    expect(authorization.checkpoint.identity).toMatchObject({
      turnId: 'prompt',
      promptId: 'prompt',
    });
    expect(authorization.checkpoint.continuation.phase).toBe('await_runtime');
    expect(authorization.checkpoint.identity).toMatchObject({
      turnId: 'prompt',
      promptId: 'prompt',
    });
    expect(authorization.checkpoint.tools?.items).toHaveLength(2);
    expect((await session.sink.project())[0]?.message?.parts).toEqual(parts);
    return {
      executionStatus: 'success',
      responseParts: [{ text: 'original result' }],
    };
  });
  const responses = await turn.execute(
    calls,
    parts,
    'model',
    new AbortController().signal,
  );
  expect(responses.map((part) => part.functionResponse?.id)).toEqual(
    calls.map((call) => call.callId),
  );
  await turn.consumeResults();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('settles the turn over a held Runtime and owes it to the close (#13856)', async () => {
  // The broker refuses the routine release with the designed hold: a live
  // background run keeps its Runtime, the turn settles clean, and the
  // Session's close owes the drain.
  broker.release.mockRejectedValueOnce(
    new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
  );
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  await turn.consumeResults();
  await expect(turn.finish()).resolves.toBeUndefined();
  expect(turn.runtimeHeld).toBe(true);
});

it('keeps the honesty contract for a busy refusal (#13856)', async () => {
  // The unproven busy refusal keeps its exact old meaning: the turn cannot
  // prove its outcome, so the Session parks — only the held arm is soft.
  broker.release.mockRejectedValueOnce(
    new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy'),
  );
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  await turn.consumeResults();
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
  expect(turn.runtimeHeld).toBe(false);
});

async function shellReceiptScenario(
  mode:
    | 'normal'
    | 'abandoned'
    | 'mismatched'
    | 'truncated'
    | 'large'
    | 'sentinel'
    | 'lost-admission'
    | 'lost-reserve',
  foregroundOnly = false,
  approval?: { mode: HostedApprovalMode },
) {
  const shellCall = {
    ...calls[0],
    name: 'run_shell_command',
    callId: 'shell-call',
    args: { command: 'printf hi' },
  };
  const shellParts: Part[] = [
    {
      functionCall: {
        id: shellCall.callId,
        name: shellCall.name,
        args: shellCall.args,
      },
    },
  ];
  const manifest = await session.resources.publish(
    'managed-tool-result-manifest',
    Buffer.from('{}'),
  );
  const sentinelOutput =
    'Tool output was too large and has been truncated.\nreal payload\n';
  const envelope = {
    executionStatus: 'success' as const,
    responseParts:
      mode === 'truncated'
        ? boundedShellPreview([{ text: `HEAD\n${'x'.repeat(10_000)}\nTAIL` }])
        : [
            {
              text:
                mode === 'sentinel'
                  ? sentinelOutput
                  : mode === 'large'
                    ? `HEAD\n${'x'.repeat(66_000)}\nExit Code: 2`
                    : 'hi',
            },
          ],
    capture: {
      manifest,
      captureStatus: 'complete' as const,
      captureReason: null,
      previewTruncated: mode === 'truncated' || mode === 'large',
      deliveryStatus: 'pending' as const,
    },
  };
  const order: string[] = [];
  let originalBinding: unknown;
  broker.prepareV3.mockResolvedValue({
    executionCallId: 'shell-execution',
    runtimeBindingId: 'binding-1',
    bindingGeneration: '1',
  });
  broker.executeV3.mockImplementation(async () => {
    order.push('execute');
    expect(session.authority.latestCheckpoint?.boundary).toBe('durable_wait');
    if (
      mode !== 'normal' &&
      mode !== 'truncated' &&
      mode !== 'large' &&
      mode !== 'sentinel' &&
      mode !== 'lost-admission' &&
      mode !== 'lost-reserve'
    )
      throw new HostedWorkspaceBrokerRejection(
        409,
        'runtime_broker_execution_unknown',
      );
    return envelope;
  });
  broker.acknowledgeV3.mockImplementation(async () => {
    order.push('ack');
    expect((await session.sink.project()).at(-1)?.type).toBe('tool_result');
    expect(session.authority.latestCheckpoint?.boundary).toBeNull();
    if (mode === 'abandoned')
      throw new HostedWorkspaceBrokerRejection(
        409,
        'runtime_broker_execution_unknown',
      );
  });
  let admissionRef: ManagedSessionDurableRef | undefined;
  let admissionBody: string | undefined;
  const request = vi.fn(async (route: string, body: unknown) => {
    if (route === '/grants') {
      order.push(
        (body as { operation: string }).operation === 'renew'
          ? 'renew'
          : 'reserve',
      );
      if ((body as { operation: string }).operation === 'reserve')
        originalBinding = (body as { binding: unknown }).binding;
      if (
        mode === 'lost-reserve' &&
        order.filter((step) => step === 'reserve').length === 1
      )
        throw new TypeError('Reservation response lost.');
      return { state: 'OPEN' };
    }
    if (route.endsWith('/finished')) {
      order.push('finished');
      return {
        binding:
          mode === 'mismatched'
            ? { ...(originalBinding as object), captureId: randomUUID() }
            : originalBinding,
        result: envelope,
      };
    }
    if (route.endsWith('/admissions/prepare')) {
      order.push('admission');
      const bytes = JSON.stringify(body);
      if (admissionBody && admissionBody !== bytes)
        throw new Error('Admission changed on replay.');
      admissionBody = bytes;
      admissionRef ??= await session.resources.publish(
        'managed-tool-outcome',
        Buffer.from(bytes),
      );
      if (
        mode === 'lost-admission' &&
        order.filter((step) => step === 'admission').length === 1
      )
        throw new TypeError('Admission response lost.');
      return admissionRef;
    }
    throw new Error('Unexpected publication route ' + route);
  });
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    request,
    rememberAdmission: vi.fn(),
  } as unknown as HttpToolPublicationOwner;
  const originalAppend = session.authority.appendExecutionEvent.bind(
    session.authority,
  );
  vi.spyOn(session.authority, 'appendExecutionEvent').mockImplementation(
    async (...args) => {
      if (args[0].operation === 'recordToolResult') order.push('receipt');
      return originalAppend(...args);
    },
  );
  const shellTurn = new HostedWorkspaceToolTurn(
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
    (_type, messageParts) =>
      mode !== 'large' ||
      Buffer.byteLength(JSON.stringify(messageParts)) <= 64 * 1024,
    { owner, captureBytes: 1024 * 1024 },
    undefined,
    approval
      ? { settings: { mode: approval.mode, timeoutMs: 1000 }, waiters }
      : undefined,
    { foregroundOnly },
  );
  const execution = shellTurn.execute(
    [shellCall],
    shellParts,
    'model',
    new AbortController().signal,
  );
  if (mode === 'mismatched') {
    await expect(execution).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
    expect(broker.executeV3).toHaveBeenCalledOnce();
    expect(
      session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'tool.receipt'),
    ).toHaveLength(0);
    expect(broker.acknowledgeV3).not.toHaveBeenCalled();
    return;
  }
  const result = await execution;
  expect(broker.executeV3).toHaveBeenCalledOnce();
  expect(result[0]?.functionResponse?.response).toMatchObject({
    output:
      mode === 'truncated'
        ? expect.stringContaining('TAIL')
        : mode === 'large'
          ? expect.stringContaining('Exit Code: 2')
          : mode === 'sentinel'
            ? sentinelOutput
            : 'hi',
    manifestRef: manifest,
    captureStatus: 'complete',
    previewTruncated: mode === 'truncated' || mode === 'large',
  });
  if (mode === 'truncated')
    expect(JSON.stringify(result)).toContain('preview truncated');
  expect(order).toEqual([
    'assistant',
    'reserve',
    ...(mode === 'lost-reserve' ? ['reserve'] : []),
    'renew',
    'execute',
    ...(mode === 'abandoned' ? ['finished'] : []),
    'finished',
    'admission',
    ...(mode === 'lost-admission' ? ['admission'] : []),
    'receipt',
    'tool_result',
    'ack',
  ]);
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.receipt'),
  ).toHaveLength(1);
  expect(broker.acknowledgeV3.mock.calls[0]?.[0]).toBe('shell-execution');
  const publicationId = broker.prepareV3.mock.calls[0]?.[3] as string;
  if (mode === 'lost-reserve') {
    const reservations = request.mock.calls.filter(
      ([route, body]) =>
        route === '/grants' &&
        (body as { operation: string }).operation === 'reserve',
    );
    expect(reservations).toHaveLength(2);
    expect(reservations[0]).toEqual(reservations[1]);
  }
  broker.acknowledgeV3.mockRejectedValueOnce(new Error('ACK transport down'));
  const replayed = await (
    shellTurn as unknown as {
      acceptShell: (
        call: typeof shellCall,
        executionCallId: string,
        publicationId: string,
        publicationToken: string,
        result: typeof envelope,
        model: string,
      ) => Promise<Part[]>;
    }
  ).acceptShell(
    shellCall,
    'shell-execution',
    publicationId,
    'unused-token',
    envelope,
    'model',
  );
  expect(JSON.parse(JSON.stringify(replayed))).toEqual(
    JSON.parse(JSON.stringify(result)),
  );
  expect(
    request.mock.calls.filter(([route]) =>
      String(route).endsWith('/admissions/prepare'),
    ),
  ).toHaveLength(mode === 'lost-admission' ? 2 : 1);
  expect(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter((event) => event.kind === 'tool.receipt'),
  ).toHaveLength(1);
}

it.each([false, true])(
  'runs Full Access Shell without ordinary Actions through durable result and replay acceptance (foreground-only: %s)',
  async (foregroundOnly) => {
    await shellReceiptScenario('normal', foregroundOnly, { mode: 'yolo' });
    expect(actionIds()).toEqual([]);
  },
);

it.each([
  'normal',
  'abandoned',
  'mismatched',
  'truncated',
  'large',
  'sentinel',
  'lost-admission',
  'lost-reserve',
] as const)(
  'uses only the original Shell publication after Broker %s',
  (mode) => shellReceiptScenario(mode),
);

it('publishes foreground SSH Shell output through its original capture and ACK', async () => {
  await shellReceiptScenario('normal', true);
});

it('records a durable receipt for a proven unstarted Shell', async () => {
  const call = {
    ...calls[0],
    name: 'run_shell_command',
    callId: 'shell-call',
    args: { command: 'printf hi' },
  };
  const shellParts: Part[] = [
    {
      functionCall: { id: call.callId, name: call.name, args: call.args },
    },
  ];
  const envelope = {
    executionStatus: 'not_started' as const,
    responseParts: [],
    error: { message: 'Blocked: split the command into two calls.' },
    capture: null,
  };
  broker.prepareV3.mockResolvedValue({
    executionCallId: 'shell-execution',
    runtimeBindingId: 'binding-1',
    bindingGeneration: '1',
  });
  broker.executeV3.mockResolvedValue(envelope);
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    request: vi.fn(async (route: string, body: { operation: string }) => {
      expect(route).toBe('/grants');
      return {
        state: body.operation === 'close_not_started' ? 'NOT_STARTED' : 'OPEN',
      };
    }),
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
  const result = await turn.execute(
    [call],
    shellParts,
    'model',
    new AbortController().signal,
  );
  expect(result[0]?.functionResponse?.response).toMatchObject({
    executionStatus: 'not_started',
    error: envelope.error.message,
  });
  expect(
    (await session.sink.project()).at(-1)?.message?.parts?.[0]?.functionResponse
      ?.response?.['error'],
  ).toBe(envelope.error.message);
  const receipts = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'tool.receipt');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.payload['resultRef']).toBeNull();
  const ref = assertManagedSessionDurableRef(
    receipts[0]?.payload['toolOutcomeRef'],
    'unstarted Shell outcome',
  );
  expect(
    JSON.parse((await session.resources.read(ref)).toString()),
  ).toMatchObject({
    schemaVersion: 1,
    decision: 'blocked',
    envelope,
    manifestRef: null,
    history: { model: 'model', parts: result },
  });
  expect(broker.acknowledgeV3).not.toHaveBeenCalled();
});

it('closes proven unstarted reservations after a later batch reservation fails', async () => {
  const shellCalls = [0, 1].map((index) => ({
    ...calls[index],
    name: 'run_shell_command',
    args: { command: `printf ${index}` },
  }));
  const shellParts: Part[] = shellCalls.map((call) => ({
    functionCall: { id: call.callId, name: call.name, args: call.args },
  }));
  broker.prepareV3.mockImplementation(async () => ({
    executionCallId: `shell-execution-${broker.prepareV3.mock.calls.length}`,
    runtimeBindingId: 'binding-1',
    bindingGeneration: '1',
  }));
  const events: string[] = [];
  const request = vi.fn(async (route: string, body: unknown) => {
    expect(route).toBe('/grants');
    const operation = (body as { operation: string }).operation;
    events.push(operation);
    if (
      operation === 'reserve' &&
      events.filter((e) => e === 'reserve').length === 2
    )
      throw new Error('Publication capacity exhausted');
    return {
      state: operation === 'close_not_started' ? 'NOT_STARTED' : 'OPEN',
    };
  });
  broker.cancel.mockImplementation(async () => {
    events.push('cancel');
  });
  const owner = {
    owner: async () => ({ writerId: 'worker', writerGeneration: 1 }),
    request,
  } as unknown as HttpToolPublicationOwner;
  const shellTurn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    async (type, messageParts) => {
      const uuid = randomUUID();
      await session.sink.write({
        uuid,
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: new Date().toISOString(),
        type,
        cwd: root,
        version: 'test',
        daemonPromptId: 'prompt',
        message: { role: 'model', parts: messageParts },
      });
      return uuid;
    },
    () => true,
    { owner, captureBytes: 1024 * 1024 },
  );
  await expect(
    shellTurn.execute(
      shellCalls,
      shellParts,
      'model',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(events).toEqual([
    'reserve',
    'reserve',
    'cancel',
    'cancel',
    'close_not_started',
    'close_not_started',
  ]);
  expect(
    request.mock.calls
      .filter(
        ([, body]) =>
          (body as { operation: string }).operation === 'close_not_started',
      )
      .map(([, body]) => (body as { publicationId: string }).publicationId)
      .sort(),
  ).toEqual(broker.prepareV3.mock.calls.map((call) => call[3]).sort());
  expect(broker.executeV3).not.toHaveBeenCalled();
});

it.each(['input', 'intent', 'wait', 'result'] as const)(
  'blocks without inventing settlement after %s persistence failure',
  async (point) => {
    if (point === 'intent') {
      const append = session.authority.appendExecutionEvent.bind(
        session.authority,
      );
      vi.spyOn(session.authority, 'appendExecutionEvent').mockImplementation(
        async (command, event, actor) => {
          if (command.operation === 'toolIntent') throw new Error('store down');
          return append(command, event, actor);
        },
      );
    } else if (point === 'wait')
      vi.spyOn(harness, 'commitAwaitRuntimeBatch').mockRejectedValue(
        new Error('store down'),
      );
    else {
      const publish = session.resources.publish.bind(session.resources);
      vi.spyOn(session.resources, 'publish').mockImplementation(
        async (kind, bytes) => {
          if (
            kind ===
            (point === 'input' ? 'managed-tool-input' : 'managed-tool-outcome')
          )
            throw new Error('store down');
          return publish(kind, bytes);
        },
      );
    }
    await expect(
      turn.execute(calls, parts, 'model', new AbortController().signal),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(broker.execute).toHaveBeenCalledTimes(point === 'result' ? 1 : 0);
    expect(broker.release).not.toHaveBeenCalled();
    await expect(turn.finish()).rejects.toBeInstanceOf(
      HostedToolRecoveryRequiredError,
    );
  },
);

it('anchors every exact input through an intent before dispatch across multiple batches', async () => {
  const seen: string[] = [];
  broker.execute.mockImplementation(async (id, payloadJson) => {
    const intent = session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'tool.intent' &&
          event.payload['executionCallId'] === id,
      );
    expect(intent).toBeDefined();
    const ref = intent!.payload[
      'argsRef'
    ] as unknown as ManagedSessionDurableRef;
    const input = JSON.parse((await session.resources.read(ref)).toString());
    expect(input.payloadJson).toBe(payloadJson);
    seen.push(id);
    return { executionStatus: 'success', responseParts: [{ text: 'done' }] };
  });
  for (let round = 0; round < 2; round++) {
    const batch = calls.map((call) => ({
      ...call,
      callId: `${call.callId}-${round}`,
    }));
    await turn.execute(
      batch,
      batch.map((call) => ({
        functionCall: { id: call.callId, name: call.name, args: call.args },
      })),
      'model',
      new AbortController().signal,
    );
    await turn.consumeResults();
  }
  await turn.finish();
  expect(seen).toHaveLength(4);
  expect(new Set(seen).size).toBe(4);
});

it('does not consume an unknown outcome or continue a partly executed batch', async () => {
  broker.execute.mockRejectedValueOnce(new Error('unknown'));
  await expect(
    turn.execute(calls, parts, 'model', new AbortController().signal),
  ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
  expect(broker.execute).toHaveBeenCalledOnce();
  expect(broker.cancel).toHaveBeenCalledTimes(2);
  const authorization = await session.authority.harnessRunAuthorization();
  expect(
    authorization.status === 'runnable' &&
      authorization.checkpoint.continuation.phase,
  ).toBe('await_runtime');
  expect(
    (await session.sink.project()).filter(
      (record) => record.type === 'tool_result',
    ),
  ).toHaveLength(0);
});

it('refuses unsupported profile calls before acquiring or reserving work', async () => {
  for (const call of [
    { ...calls[0], name: 'run_shell_command' },
    { ...calls[0], wasOutputTruncated: true },
    // Arguments that arrived unterminated are refused even when the output
    // token limit was not what cut them: this profile writes to a remote
    // Workspace with no undo backup (#12970).
    { ...calls[0], hadIncompleteArguments: true },
  ]) {
    await expect(
      turn.execute([call], parts, 'model', new AbortController().signal),
    ).rejects.toThrow();
  }
  expect(broker.acquire).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
});

it.each(['read_file', 'write_file', 'edit'])(
  'persists correctable file_path errors for %s without dispatch',
  async (name) => {
    const invalidPaths: unknown[] = [
      undefined,
      null,
      '',
      '   ',
      123,
      '/private/secret-host-path',
      ' /private/secret-host-path ',
      '../escape',
      'a\\b',
      'C:/secret-host-path',
      'a\u0000b',
      '\ud800',
    ];
    for (const [index, file] of invalidPaths.entries()) {
      const args = file === undefined ? {} : { file_path: file };
      const call = { ...calls[0], name, callId: `invalid-${index}`, args };
      const original = [
        { functionCall: { id: call.callId, name, args: call.args } },
      ];
      const responses = await turn.execute(
        [call],
        original,
        'model',
        new AbortController().signal,
      );
      const error = responses[0].functionResponse?.response?.['error'];
      expect(responses[0].functionResponse?.id).toBe(call.callId);
      expect(error).toContain('file_path');
      expect(error).toContain('retry');
      expect(error).not.toContain('cwdRelative');
      expect(error).not.toContain('secret-host-path');
      const history = await session.sink.project();
      expect(history.slice(-2).map((record) => record.type)).toEqual([
        'assistant',
        'tool_result',
      ]);
      expect(history.at(-2)?.message?.parts).toEqual(original);
      expect(history.at(-1)?.message?.parts).toEqual(
        JSON.parse(JSON.stringify(responses)),
      );
    }
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await expect(turn.finish()).resolves.toBeUndefined();
  },
);

it('preserves trimmed and normalized valid file paths', async () => {
  const call = { ...calls[0], args: { file_path: ' ./dir//file.txt ' } };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  const payload = JSON.parse(broker.execute.mock.calls[0][1]);
  expect(payload.input.file_path).toBe('dir/file.txt');
  await turn.consumeResults();
  await turn.finish();
});

it.each([
  { url: 'http://example.com', prompt: 'Read' },
  { url: 'https://user:secret@example.com', prompt: 'Read' },
  { url: 'https://example.com', prompt: '' },
  { url: 'https://example.com', prompt: 'Read', format: 'json' },
  { url: 'https://example.com', prompt: 'Read', headers: {} },
])(
  'refuses invalid web_fetch arguments before acquiring a Runtime: %j',
  async (args) => {
    const call = { ...calls[0], name: 'web_fetch', args };
    const result = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args } }],
      'model',
      new AbortController().signal,
    );
    expect(JSON.stringify(result)).toContain('Hosted web_fetch requires');
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it.each(['default', 'auto-edit'] as const)(
  'requires %s web_fetch approval with the actual destination and persists the result',
  async (mode) => {
    turn = createTurn(false, { mode });
    const call = {
      ...calls[0],
      name: 'web_fetch',
      args: {
        url: 'https://github.com/QwenLM/qwen-code/blob/main/README.md',
        prompt: 'Summarize',
      },
    };
    const running = turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    const requestId = await requested();
    const input = JSON.parse(
      (
        await session.resources.read(
          (await checkpoint()).approval!.invocationRef!,
        )
      ).toString(),
    );
    expect(JSON.parse(input.payloadJson).input.url).toBe(
      'https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md',
    );
    expect(broker.prepare).not.toHaveBeenCalled();
    await resolveHostedAction(session, waiters, requestId, answer('allow'));
    const result = await running;
    expect(broker.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toMatchObject({
      url: 'https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md',
      prompt: 'Summarize',
    });
    expect(result[0].functionResponse?.response?.['executionStatus']).toBe(
      'success',
    );
    expect((await session.sink.project()).at(-1)?.message?.parts).toEqual(
      JSON.parse(JSON.stringify(result)),
    );
    await turn.consumeResults();
    await turn.finish();
  },
);

it('does not dispatch a denied web_fetch', async () => {
  turn = createTurn(false, { mode: 'default' });
  const call = {
    ...calls[0],
    name: 'web_fetch',
    args: { url: 'https://example.com/docs', prompt: 'Summarize' },
  };
  const running = turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  await resolveHostedAction(session, waiters, requestId, answer('deny'));
  expect(JSON.stringify(await running)).toContain('denied');
  expect(broker.execute).not.toHaveBeenCalled();
  expect(broker.prepare).not.toHaveBeenCalled();
});

it('declares only resident file tools without waiting for runtime warmup', async () => {
  broker.capabilityDigest = RESIDENT_WORKSPACE_CAPABILITY_DIGEST;
  broker.warm.mockReturnValueOnce(new Promise(() => {}));
  const resident = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
  );
  expect(
    (await resident.declarations(new AbortController().signal)).map(
      (tool) => tool.name,
    ),
  ).toEqual(['read_file', 'write_file', 'edit']);
  expect(broker.resolveCapabilities).toHaveBeenCalledOnce();
  expect(broker.acquire).not.toHaveBeenCalled();
});

it('refuses unresolved capability instead of advertising ordinary tools', async () => {
  broker.resolveCapabilities.mockRejectedValueOnce(
    new Error('scope unavailable'),
  );
  await expect(turn.declarations(new AbortController().signal)).rejects.toThrow(
    'scope unavailable',
  );
  expect(broker.acquire).not.toHaveBeenCalled();
});

it.each([
  'hosted-workspace-shell/1',
  'hosted-workspace-files/2',
  'hosted-workspace-files/3',
  'hosted-workspace-read/1',
  'hosted-workspace-mcp/1',
])(
  'keeps %s declarations independent of capability lookup and warmup',
  async (profile) => {
    broker.warm.mockReturnValueOnce(new Promise(() => {}));
    broker.resolveCapabilities.mockRejectedValue(new Error('must not query'));
    const ordinary = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      undefined,
      undefined,
      undefined,
      { profile },
    );
    expect(
      await ordinary.declarations(new AbortController().signal),
    ).not.toEqual([]);
    expect(broker.resolveCapabilities).not.toHaveBeenCalled();
    expect(broker.acquire).not.toHaveBeenCalled();
  },
);

it.each([WORKSPACE_CAPABILITY_DIGEST, RESIDENT_WORKSPACE_CAPABILITY_DIGEST])(
  'uses the existing warm capability after a legacy route 404 (%s)',
  async (digest) => {
    broker.capabilityDigest = digest;
    broker.warm.mockClear();
    turn = createTurn();
    broker.resolveCapabilities.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(404, 'not_found'),
    );
    const names = (await turn.declarations(new AbortController().signal)).map(
      (tool) => tool.name,
    );
    expect(names).toEqual([
      'read_file',
      'write_file',
      'edit',
      ...(digest === WORKSPACE_CAPABILITY_DIGEST ? ['web_fetch'] : []),
    ]);
    expect(broker.warm).toHaveBeenCalledOnce();
    expect(broker.acquire).not.toHaveBeenCalled();
  },
);

it.each([403, 503])(
  'does not downgrade a capability HTTP %s to completed warm metadata',
  async (status) => {
    const refusal = new HostedWorkspaceBrokerRejection(status, 'unavailable');
    broker.resolveCapabilities.mockRejectedValueOnce(refusal);
    await expect(turn.declarations(new AbortController().signal)).rejects.toBe(
      refusal,
    );
    expect(broker.acquire).not.toHaveBeenCalled();
  },
);

it('preserves resident public Plan approval before restoring file mutations', async () => {
  broker.capabilityDigest = RESIDENT_WORKSPACE_CAPABILITY_DIGEST;
  const active = vi
    .spyOn(hostedPlan, 'hostedPublicPlanActive')
    .mockResolvedValue(true);
  turn = createTurn(
    false,
    { mode: 'auto-edit' },
    undefined,
    undefined,
    'public',
  );
  const signal = new AbortController().signal;
  expect((await turn.declarations(signal)).map((tool) => tool.name)).toEqual([
    'read_file',
    'exit_plan_mode',
  ]);
  expect(
    JSON.stringify(await turn.execute([calls[1]], [parts[1]], 'model', signal)),
  ).toContain('Plan mode is read-only');
  const plan = {
    ...calls[0],
    name: 'exit_plan_mode',
    callId: 'plan',
    args: { plan: 'Read the file, then edit it after approval.' },
  };
  const running = turn.execute(
    [plan],
    [{ functionCall: { id: plan.callId, name: plan.name, args: plan.args } }],
    'model',
    signal,
  );
  const requestId = await requested();
  active.mockResolvedValue(false);
  await resolveHostedAction(session, waiters, requestId, answer('allow'));
  expect(JSON.stringify(await running)).toContain('The user approved the plan');
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
  expect((await turn.declarations(signal)).map((tool) => tool.name)).toEqual([
    'read_file',
    'write_file',
    'edit',
    'exit_plan_mode',
  ]);
  const edit = { ...calls[1], callId: 'approved-edit' };
  await turn.execute(
    [edit],
    [{ functionCall: { id: edit.callId, name: edit.name, args: edit.args } }],
    'model',
    signal,
  );
  expect(broker.execute).toHaveBeenCalledOnce();
});

it.each(['web_fetch', 'run_shell_command', 'glob', 'todo_write', 'skill'])(
  'records a resident %s refusal before acquiring or preparing any work',
  async (name) => {
    broker.capabilityDigest = RESIDENT_WORKSPACE_CAPABILITY_DIGEST;
    const resident = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
    );
    const call = { ...calls[0], name, args: {}, isClientInitiated: true };
    const response = await resident.execute(
      [call],
      [{ functionCall: { id: call.callId, name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    expect(JSON.stringify(response)).toContain(
      'Resident Workspace supports only',
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await resident.consumeResults();
    await resident.finish();
  },
);

it('offers glob under the unified Shell, file-search and read profiles', async () => {
  const signal = new AbortController().signal;
  const advertised = async (profile?: string, shell = false) =>
    (
      await new HostedWorkspaceToolTurn(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        session,
        harness,
        'prompt',
        commit,
        messageFitsInline,
        shell
          ? { resources: session.resources, assertWritable: async () => {} }
          : undefined,
        undefined,
        undefined,
        { profile },
      ).declarations(signal)
    ).map((tool) => tool.name);
  const file = ['read_file', 'write_file', 'edit', 'web_fetch'];
  const shellTools = [...file, 'run_shell_command'];
  await expect(advertised()).resolves.toEqual(file);
  await expect(advertised('hosted-workspace-files/1')).resolves.toEqual([
    ...file,
    'glob',
  ]);
  await expect(advertised('hosted-workspace-shell/1', true)).resolves.toEqual([
    ...shellTools,
    'glob',
    'todo_write',
  ]);
  await expect(advertised('hosted-workspace-files/2')).resolves.toEqual([
    ...file,
    'glob',
  ]);
  await expect(
    advertised('hosted-workspace-team-lead/1', true),
  ).resolves.toEqual(shellTools);
  // #13753 I3: the read profile declares its two read tools, whatever
  // lane the Session has.
  await expect(advertised('hosted-workspace-read/1')).resolves.toEqual([
    'read_file',
    'glob',
  ]);
  await expect(advertised('hosted-workspace-read/1', true)).resolves.toEqual([
    'read_file',
    'glob',
  ]);
});

it.each([
  undefined,
  'hosted-workspace-files/1',
  'hosted-workspace-files/2',
  'hosted-workspace-files/3',
  'hosted-workspace-shell/1',
  'hosted-workspace-team-lead/1',
  'hosted-workspace-read/1',
])('advertises PDF pages on the normal Hosted profile %s', async (profile) => {
  const shell =
    profile?.startsWith('hosted-workspace-shell/') ||
    profile === 'hosted-workspace-team-lead/1';
  turn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    shell
      ? { resources: session.resources, assertWritable: async () => {} }
      : undefined,
    undefined,
    undefined,
    { profile },
  );
  const declarations = await turn.declarations(new AbortController().signal);
  expect(
    declarations.find((tool) => tool.name === 'read_file')
      ?.parametersJsonSchema,
  ).toMatchObject({
    properties: {
      pages: {
        type: ['string', 'null'],
        description: expect.stringContaining(
          `at most ${PDF_MAX_PAGES_PER_READ} pages`,
        ),
      },
    },
    required: ['file_path'],
    additionalProperties: false,
  });
  expect(HOSTED_WORKSPACE_FILE_TOOLS[0]).not.toHaveProperty(
    'parametersJsonSchema.properties.pages',
  );
});

it('keeps PDF pages out of resident and private CSI declarations', async () => {
  broker.capabilityDigest = RESIDENT_WORKSPACE_CAPABILITY_DIGEST;
  turn = createTurn();
  const resident = await turn.declarations(new AbortController().signal);
  const csi = await new HostedCsiToolTurn(
    session,
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    { bindingId: 'binding', generation: '1' },
    'prompt',
    commit,
    harness,
    messageFitsInline,
  ).declarations(new AbortController().signal);
  for (const declarations of [resident, csi]) {
    expect(declarations.map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'edit',
    ]);
    expect(declarations[0]).toEqual(HOSTED_WORKSPACE_FILE_TOOLS[0]);
    expect(declarations[0]).not.toHaveProperty(
      'parametersJsonSchema.properties.pages',
    );
  }
});

it('dispatches PDF pages with the original input and declaration persisted', async () => {
  const call = {
    ...calls[0],
    args: { file_path: 'document.pdf', pages: '2' },
  };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(JSON.parse(broker.execute.mock.calls[0][1])).toEqual({
    toolName: 'read_file',
    input: call.args,
  });
  const intent = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .find((event) => event.kind === 'tool.intent');
  const inputRef = assertManagedSessionDurableRef(
    intent!.payload['argsRef'],
    'PDF input',
  );
  expect(await toolInputOf(inputRef)).toEqual(call.args);
  const definitionRef = assertManagedSessionDurableRef(
    intent!.payload['toolDefinitionRef'],
    'PDF declaration',
  );
  expect(
    JSON.parse((await session.resources.read(definitionRef)).toString()),
  ).toHaveProperty('parametersJsonSchema.properties.pages');
  await turn.consumeResults();
  await turn.finish();
});

it.each([false, true])(
  'requires the current read_file declaration for pending reads (legacy: %s)',
  async (legacy) => {
    const signal = new AbortController().signal;
    const declarations = await turn.declarations(signal);
    const definition = structuredClone(
      legacy
        ? HOSTED_WORKSPACE_FILE_TOOLS[0]
        : declarations.find((tool) => tool.name === 'read_file')!,
    );
    const definitionRef = await session.resources.publish(
      'managed-tool-definition',
      Buffer.from(JSON.stringify(definition)),
    );
    const input = { file_path: 'document.pdf' };
    const call = { ...calls[0], args: input };
    const payloadJson = JSON.stringify({ toolName: call.name, input });
    const bytes = Buffer.from(
      JSON.stringify({
        harnessSessionId: session.authority.sessionHeader.sessionKey.sessionId,
        runtimeSessionId: 'prompt',
        payloadJson,
      }),
    );
    const argsDigest = `sha256:${managedToolDigest(input)}`;
    const requestDigest = `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`;
    const inputRef = await session.resources.publish(
      'managed-tool-input',
      bytes,
    );
    const saved = {
      plan: {
        promptId: 'prompt',
        calls: [
          {
            call,
            definitionRef,
            inputRef,
            argsDigest,
            runtimeCallId: call.callId,
            requestDigest,
          },
        ],
        runtime: {
          runtimeSessionId: 'prompt',
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        },
        round: 1,
        model: 'model',
      },
      inputs: [{ input, bytes, payloadJson }],
      parts: [
        { functionCall: { id: call.callId, name: call.name, args: input } },
      ],
    };
    const receiver = {
      session,
      broker: { ...broker, runtimeSessionId: 'prompt' },
      warmed: Promise.resolve(),
      promptId: 'prompt',
      declarations: vi.fn().mockResolvedValue(declarations),
      executeNative: vi.fn().mockResolvedValue([]),
      context: { read: () => 'context already loaded' },
      residentWorkspace: false,
    };
    const resumed = Reflect.apply(
      HostedWorkspaceToolTurn.prototype.resumeSavedNativeBatch,
      receiver,
      [saved, 0, signal],
    );
    if (legacy) {
      await expect(resumed).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: 'Original native tool definition changed.',
        }),
      });
      expect(receiver.executeNative).not.toHaveBeenCalled();
    } else {
      await expect(resumed).resolves.toEqual([]);
      expect(receiver.executeNative).toHaveBeenCalledWith(
        [call],
        saved.parts,
        'model',
        signal,
        {
          saved,
          requests: [
            expect.objectContaining({
              input,
              inputBytes: bytes,
              payloadJson,
              argsDigest,
              digest: requestDigest,
            }),
          ],
          nextApprovalOrdinal: 0,
        },
      );
    }
    expect(
      JSON.parse((await session.resources.read(definitionRef)).toString()),
    ).toEqual(definition);
    expect(await session.resources.read(inputRef)).toEqual(bytes);
  },
);

// #13753 I3: the read profile's two tools dispatch like any profile's.
it('dispatches read_file and glob on the read profile', async () => {
  turn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    undefined,
    undefined,
    undefined,
    { profile: 'hosted-workspace-read/1' },
  );
  const reads = [
    { ...calls[0], name: 'read_file', args: { file_path: 'a.txt' } },
    {
      ...calls[0],
      callId: 'call-glob',
      name: 'glob',
      args: { pattern: '**/*.ts' },
    },
  ];
  await turn.execute(
    reads,
    reads.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  expect(
    broker.execute.mock.calls.map(
      (args: unknown[]) => JSON.parse(args[1] as string).toolName,
    ),
  ).toEqual(['read_file', 'glob']);
  await turn.consumeResults();
  await turn.finish();
});

// #13753 I3: every tool that writes, and every other tool, is refused on
// the read profile before the Broker is acquired.
it.each([
  ['web_fetch', { url: 'https://example.com/docs', prompt: 'Summarize' }],
  ['write_file', { file_path: 'a.txt', content: 'x' }],
  ['edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }],
  ['run_shell_command', { command: 'touch a.txt' }],
  ['monitor', { command: 'tail -f a.txt' }],
  ['agent', { description: 'd', prompt: 'p' }],
  ['send_message', { to: 'parent', message: 'm' }],
])('refuses %s on the read profile before the Broker', async (name, args) => {
  const reader = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    { resources: session.resources, assertWritable: async () => {} },
    undefined,
    undefined,
    { profile: 'hosted-workspace-read/1' },
  );
  await reader.declarations(new AbortController().signal);
  const call = { ...calls[0], name, args };
  await expect(
    reader.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    ),
  ).rejects.toThrow('Hosted Workspace profile refused a tool call.');
  expect(broker.acquire).not.toHaveBeenCalled();
});

// Native glob follows the Session profile; namespaced MCP tools still ask.
it.each([
  ['hosted-workspace-files/1', 'default'],
  ['hosted-workspace-files/1', 'auto-edit'],
  ['hosted-workspace-read/1', 'default'],
  ['hosted-workspace-shell/1', 'default'],
  ['hosted-workspace-shell/1', 'auto-edit'],
] as const)(
  'pre-approves native glob on %s in %s mode',
  async (profile, mode) => {
    const globCall = {
      ...calls[0],
      callId: 'call-glob',
      name: 'glob',
      args: { pattern: '**/*.ts' },
    };
    const globParts: Part[] = [
      {
        functionCall: {
          id: globCall.callId,
          name: globCall.name,
          args: globCall.args,
        },
      },
    ];
    const native = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      profile === 'hosted-workspace-shell/1'
        ? { resources: session.resources, assertWritable: async () => {} }
        : undefined,
      undefined,
      { settings: { mode, timeoutMs: 60_000 }, waiters },
      { profile },
    );
    const responses = await native.execute(
      [globCall],
      globParts,
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['error']).toBeUndefined();
    expect(actionIds()).toEqual([]);
    expect(
      broker.execute.mock.calls.map(
        (args: unknown[]) => JSON.parse(args[1] as string).toolName,
      ),
    ).toEqual(['glob']);
    await native.consumeResults();
    await native.finish();
  },
);

it('asks before an MCP glob on the ordinary file profile', async () => {
  const name = `mcp_${'a'.repeat(32)}`;
  const mcp = {
    broker,
    ensureReady: async () => undefined,
    refresh: async () => undefined,
    tools: () => [{ name, parametersJsonSchema: { type: 'object' } }],
    toolInput: (tool: string) =>
      tool === name ? { toolName: 'managed_mcp_call', input: {} } : undefined,
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
      profile: 'hosted-workspace-files/1',
      mcp: mcp as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
    },
  );
  const declarations = await turn.declarations(new AbortController().signal);
  expect(declarations.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['glob', name]),
  );
  const call = {
    ...calls[0],
    callId: 'call-glob-mcp',
    name,
    args: { pattern: '**/*.ts' },
  };
  const running = turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  const requestId = await requested();
  expect(actionIds()).toEqual([requestId]);
  expect(broker.execute).not.toHaveBeenCalled();
  await resolveHostedAction(session, waiters, requestId, answer('allow'));
  await running;
  expect(broker.execute).toHaveBeenCalledOnce();
  await turn.consumeResults();
  await turn.finish();
});

function createSearchTurn(profile = 'hosted-workspace-files/1') {
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    undefined,
    undefined,
    undefined,
    { profile },
  );
}

it('refuses a glob call without an admitted search profile', async () => {
  const call = {
    ...calls[0],
    name: 'glob',
    args: { pattern: '**/*.ts' },
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
  ).rejects.toThrow('Hosted Workspace profile refused a tool call.');
  expect(broker.acquire).not.toHaveBeenCalled();
});

function createV3Turn(
  profile = 'hosted-workspace-files/3',
  hooks?: HostedHookSession,
) {
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    undefined,
    undefined,
    undefined,
    { profile, hooks },
  );
}

it('declares todo_write on hosted-workspace-files/3', async () => {
  turn = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
    undefined,
    undefined,
    undefined,
    { profile: 'hosted-workspace-files/3' },
  );
  const declarations = await turn.declarations(new AbortController().signal);
  const names = declarations.map((tool) => tool.name);
  expect(names).toContain('todo_write');
  expect(names).toContain('glob');
  // files/3 keeps everything files/2 declares, including the shipped fetch.
  expect(names).toContain('web_fetch');
  expect(names).not.toContain('run_shell_command');
  // The byte budget is enforced, so the declaration has to expose it too.
  expect(
    JSON.stringify(
      declarations.find((tool) => tool.name === 'todo_write')
        ?.parametersJsonSchema,
    ),
  ).toContain('16,000 bytes');
});

it.each(['hosted-workspace-files/1', 'hosted-workspace-files/2'])(
  'never offers todo_write on %s',
  async (profile) => {
    turn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      undefined,
      undefined,
      undefined,
      { profile },
    );
    const names = (await turn.declarations(new AbortController().signal)).map(
      (tool) => tool.name,
    );
    expect(names).not.toContain('todo_write');
  },
);

it('refuses todo_write on a /2 profile before the Broker', async () => {
  turn = createSearchTurn('hosted-workspace-files/2');
  const call = {
    ...calls[0],
    name: 'todo_write',
    args: { todos: [{ id: 'a', content: 'a', status: 'pending' }] },
  };
  await expect(
    turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    ),
  ).rejects.toThrow('Hosted Workspace profile refused a tool call.');
  expect(broker.acquire).not.toHaveBeenCalled();
});

// #15076: a malformed task-list call is refused before the Runtime is
// acquired, so its correction costs no durable work.
it.each([
  {},
  { todos: 'x' },
  { todos: [{}] },
  { todos: [{ id: '', content: 'a', status: 'pending' }] },
  { todos: [{ id: 'a', content: '  ', status: 'pending' }] },
  { todos: [{ id: 'a', content: 'a', status: 'done' }] },
  { todos: [{ id: 'a', content: 'a', status: 'pending', blockedBy: 'b' }] },
  { todos: [{ id: 'a', content: 'a', status: 'pending', extra: 1 }] },
  {
    todos: [{ id: 'a'.repeat(501), content: 'a', status: 'pending' }],
  },
  // The declared and enforced bounds: each trips on its own, so removing a
  // bound turns exactly one case red.
  {
    todos: [{ id: 'a', content: 'x'.repeat(1001), status: 'pending' }],
  },
  {
    todos: Array.from({ length: 65 }, (_, index) => ({
      id: `t${index}`,
      content: 'a',
      status: 'pending',
    })),
  },
  {
    todos: Array.from({ length: 40 }, (_, index) => ({
      id: `t${index}`,
      content: 'x'.repeat(500),
      status: 'pending',
    })),
  },
])(
  'persists a correctable todo_write argument error without dispatch: %j',
  async (args) => {
    turn = createV3Turn();
    const call = { ...calls[0], name: 'todo_write', args };
    const responses = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    const error = responses[0].functionResponse?.response?.['error'];
    expect(responses[0].functionResponse?.id).toBe(call.callId);
    expect(error).toContain('todo_write');
    expect(error).toContain('retry');
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await expect(turn.finish()).resolves.toBeUndefined();
  },
);

it.each(['hosted-workspace-files/3', 'hosted-workspace-shell/1'])(
  'persists Todo without a Worker and restores it after reopen on %s',
  async (profile) => {
    turn = createV3Turn(profile);
    const first = { todos: [{ id: 'a', content: 'first', status: 'pending' }] };
    const call = { ...calls[0], name: 'todo_write', args: first };
    const responses = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: first } }],
      'model',
      new AbortController().signal,
    );
    expect(responses[0].functionResponse?.response?.['todos']).toEqual(
      first.todos,
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    const latest = {
      todos: [{ id: 'a', content: 'first', status: 'completed' }],
    };
    await writeHostedTodos(session, 'prompt', 'next-call', latest);
    expect(
      await writeHostedTodos(session, 'prompt', call.callId, first),
    ).toEqual(first.todos);
    await expect(
      writeHostedTodos(session, 'prompt', call.callId, latest),
    ).rejects.toThrow();
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
      activationLeaseDurationMs: 60_000,
    });
    harness = createManagedHarnessHandle(session);
    await harness.ensureRunnable();
    turn = createV3Turn(profile);
    expect(await turn.todoInstructions()).toContain(
      JSON.stringify(latest.todos),
    );
  },
);

it.each(['hosted-workspace-files/1', 'hosted-workspace-shell/1'])(
  'keeps public Plan read-only on %s',
  async (profile) => {
    vi.spyOn(hostedPlan, 'hostedPublicPlanActive').mockResolvedValue(true);
    turn = new HostedWorkspaceToolTurn(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      harness,
      'prompt',
      commit,
      messageFitsInline,
      undefined,
      undefined,
      undefined,
      { profile, publicPlanMode: true },
    );
    expect(
      (await turn.declarations(new AbortController().signal)).map(
        (tool) => tool.name,
      ),
    ).toEqual(['read_file', 'glob', 'exit_plan_mode']);
    const call = {
      ...calls[0],
      name:
        profile === 'hosted-workspace-shell/1' ? 'todo_write' : 'write_file',
      args:
        profile === 'hosted-workspace-shell/1'
          ? { todos: [{ id: 'a', content: 'plan', status: 'pending' }] }
          : { file_path: 'plan.txt', content: 'not yet approved' },
    };
    const responses = await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    expect(JSON.stringify(responses)).toContain('Plan mode is read-only');
    expect(session.authority.domainRecord('todo_state')).toBeUndefined();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it.each(['default', 'auto-edit', 'yolo'] as const)(
  'pre-approves todo_write under %s',
  (mode) => {
    expect(hostedApprovalAsks({ mode, timeoutMs: 60_000 }, 'todo_write')).toBe(
      false,
    );
  },
);

it('fires the success hook for journal-only Todo writes', async () => {
  const fire = vi.fn<HostedHookSession['fire']>(async () => undefined);
  turn = createV3Turn('hosted-workspace-files/3', hookSession(fire));
  const args = { todos: [{ id: 'a', content: 'first', status: 'pending' }] };
  const call = { ...calls[0], name: 'todo_write', args };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args } }],
    'model',
    new AbortController().signal,
  );
  const events = fire.mock.calls.map(([event]) => event);
  expect(events).toContain(HookEventName.PostToolUse);
  expect(events).not.toContain(HookEventName.PostToolUseFailure);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
});

it('preserves omitted dependencies and replays the original committed list', async () => {
  const first = {
    todos: [
      { id: 'a', content: 'first', status: 'pending' },
      { id: 'b', content: 'second', status: 'pending', blockedBy: ['a'] },
    ],
  };
  await writeHostedTodos(session, 'prompt', 'first', first);
  const next = {
    todos: [
      { id: 'a', content: 'first', status: 'completed' },
      { id: 'b', content: 'second', status: 'in_progress' },
    ],
  };
  const stored = await writeHostedTodos(session, 'prompt', 'next', next);
  expect(stored[1].blockedBy).toEqual(['a']);
  await writeHostedTodos(session, 'prompt', 'clear', { todos: [] });
  expect(await writeHostedTodos(session, 'prompt', 'next', next)).toEqual(
    stored,
  );
  await expect(
    writeHostedTodos(session, 'prompt', 'cycle', {
      todos: [
        { id: 'a', content: 'a', status: 'pending', blockedBy: ['b'] },
        { id: 'b', content: 'b', status: 'pending', blockedBy: ['a'] },
      ],
    }),
  ).rejects.toThrow('cycle');
});

it('declares the preservation rule for omitted dependencies', async () => {
  turn = createV3Turn();
  const todo = (await turn.declarations(new AbortController().signal)).find(
    (tool) => tool.name === 'todo_write',
  );
  const schema = todo?.parametersJsonSchema as
    | {
        properties?: {
          todos?: {
            items?: { properties?: Record<string, { description?: string }> };
          };
        };
      }
    | undefined;
  const description =
    schema?.properties?.todos?.items?.properties?.['blockedBy']?.description;
  expect(description).toContain('preserved');
  expect(description).toContain('[]');
});

it.each([
  {},
  { pattern: '' },
  { pattern: '   ' },
  { pattern: 7 },
  { pattern: '/**/*.ts' },
  { pattern: '../**/*' },
  { pattern: '\\.\\./**/*' },
  { pattern: 'src/{x,\\.\\.}/**/*' },
  // The guard must judge the value it dispatches, which is the trimmed one:
  // leading whitespace otherwise masks both shapes past this pre-acquisition
  // refusal and into a durable Runtime round trip.
  { pattern: ' ../**/*' },
  { pattern: '\t/etc/host*' },
  // Brace expansion composes what the literal segment check cannot see,
  // and its cost is bounded before any expansion runs.
  { pattern: '{/etc,/zz-nonexistent}/host*' },
  { pattern: '{.,..}/**/*' },
  { pattern: 'src/{..,x}/**' },
  // Bounded before anything expands it: nesting deep enough to overflow
  // brace-expansion's recursion, a range glob would search 100000 times,
  // and an alternative product that exhausts memory.
  { pattern: '{a,'.repeat(3400) + 'x' + '}'.repeat(3400) },
  { pattern: '{1..100000}/passwd' },
  { pattern: '{9007199254740992..9007199254740992}/*' },
  { pattern: '{a,b}'.repeat(30) },
  { pattern: 'x'.repeat(1025) },
  { pattern: '**/*.ts', path: '/private/secret-host-path' },
  { pattern: '**/*.ts', path: '../escape' },
  { pattern: '**/*.ts', path: 'a\\b' },
  { pattern: '**/*.ts', path: 5 },
])(
  'persists correctable glob argument errors without dispatch: %j',
  async (args) => {
    turn = createSearchTurn();
    const call = { ...calls[0], name: 'glob', args };
    const original = [
      { functionCall: { id: call.callId, name: call.name, args: call.args } },
    ];
    const responses = await turn.execute(
      [call],
      original,
      'model',
      new AbortController().signal,
    );
    const error = responses[0].functionResponse?.response?.['error'];
    expect(responses[0].functionResponse?.id).toBe(call.callId);
    expect(error).toContain('glob');
    expect(error).toContain('retry');
    expect(error).not.toContain('secret-host-path');
    const history = await session.sink.project();
    expect(history.slice(-2).map((record) => record.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    expect(history.at(-2)?.message?.parts).toEqual(original);
    expect(history.at(-1)?.message?.parts).toEqual(
      JSON.parse(JSON.stringify(responses)),
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    await expect(turn.finish()).resolves.toBeUndefined();
  },
);

it('normalizes a glob pattern and path before dispatch', async () => {
  turn = createSearchTurn();
  const call = {
    ...calls[0],
    name: 'glob',
    args: { pattern: ' **/*.ts ', path: ' ./src//nested ' },
  };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  const payload = JSON.parse(broker.execute.mock.calls[0][1]);
  expect(payload).toEqual({
    toolName: 'glob',
    input: { pattern: '**/*.ts', path: 'src/nested' },
  });
  await turn.consumeResults();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it('dispatches an ordinary brace pattern unchanged', async () => {
  // `*.{ts,tsx}` is ordinary input: expansion must not refuse it.
  turn = createSearchTurn();
  const call = {
    ...calls[0],
    name: 'glob',
    args: { pattern: 'src/*.{ts,tsx}' },
  };
  await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  const payload = JSON.parse(broker.execute.mock.calls[0][1]);
  expect(payload).toEqual({
    toolName: 'glob',
    input: { pattern: 'src/*.{ts,tsx}' },
  });
  await turn.consumeResults();
  await turn.finish();
});
it('treats a blank glob path as omitted and still dispatches', async () => {
  // The declaration marks `path` optional; an explicit blank must not read
  // as a traversal refusal (which would also poison every valid sibling
  // call in the batch).
  turn = createSearchTurn();
  const call = {
    ...calls[0],
    name: 'glob',
    args: { pattern: '**/*.ts', path: '' },
  };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response?.['error']).toBeUndefined();
  expect(broker.execute).toHaveBeenCalledOnce();
  const payload = JSON.parse(broker.execute.mock.calls[0][1]);
  expect(payload.input).toEqual({ pattern: '**/*.ts' });
  await turn.consumeResults();
  await turn.finish();
});

it('treats a null glob path as omitted and still dispatches the whole batch', async () => {
  // `null` is one more provider encoding of an unset optional. Argument
  // validation is batch-wide, so refusing it as traversal would also cancel
  // the valid sibling call in the same turn.
  turn = createSearchTurn();
  const nullPath = {
    ...calls[0],
    name: 'glob',
    args: { pattern: '**/*.ts', path: null },
  };
  const sibling = { ...calls[1], name: 'glob', args: { pattern: '*.md' } };
  const responses = await turn.execute(
    [nullPath, sibling],
    [nullPath, sibling].map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    })),
    'model',
    new AbortController().signal,
  );
  for (const response of responses)
    expect(response.functionResponse?.response?.['error']).toBeUndefined();
  expect(broker.execute).toHaveBeenCalledTimes(2);
  expect(JSON.parse(broker.execute.mock.calls[0][1]).input).toEqual({
    pattern: '**/*.ts',
  });
  await turn.consumeResults();
  await turn.finish();
});

it('truncates an oversized glob result to a fitting prefix with a narrowing hint', async () => {
  turn = createSearchTurn();
  messageFitsInline.mockImplementation(
    (type, messageParts) =>
      Buffer.byteLength(
        JSON.stringify({
          uuid: randomUUID(),
          parentUuid: null,
          sessionId: session.authority.sessionHeader.sessionKey.sessionId,
          timestamp: new Date().toISOString(),
          type,
          cwd: root,
          version: 'test',
          daemonPromptId: 'prompt',
          message: {
            role: type === 'assistant' ? 'model' : 'user',
            parts: messageParts,
          },
        }),
      ) <=
      64 * 1024,
  );
  const lines = Array.from(
    { length: 400 },
    (_, index) =>
      `src/file-${String(index).padStart(3, '0')}-${'x'.repeat(150)}.ts`,
  );
  broker.execute.mockResolvedValue({
    executionStatus: 'success',
    responseParts: [
      {
        text: `Found ${lines.length} file(s) matching "**/*.ts" in the workspace directory, sorted by modification time (newest first):\n---\n${lines.join('\n')}`,
      },
    ],
  });
  const publish = vi.spyOn(session.resources, 'publish');
  const call = {
    ...calls[0],
    name: 'glob',
    args: { pattern: '**/*.ts' },
  };
  const responses = await turn.execute(
    [call],
    [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
    'model',
    new AbortController().signal,
  );
  const response = responses[0].functionResponse?.response;
  expect(response?.['executionStatus']).toBe('success');
  expect(response?.['outputTruncated']).toBe(true);
  const output = response?.['output'];
  expect(typeof output).toBe('string');
  expect(output).toContain('file-000');
  expect(output).not.toContain('file-399');
  expect(output).toContain('Narrow the pattern or path.');
  expect(response).not.toHaveProperty('outputOmitted');
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

function turnWithContext(
  slot: ReturnType<typeof contextSlot>,
  prompt = 'prompt',
) {
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness,
    prompt,
    commit,
    messageFitsInline,
    undefined,
    undefined,
    undefined,
    { context: slot },
  );
}

it('assembles two instruction files as two sections, separated and in order', async () => {
  // Both files non-blank is the ordinary Workspace shape, and the only one
  // where the section separator and the prompt order are observable at all:
  // a single section makes `.join()` a no-op.
  const slot = contextSlot();
  broker.workspaceContext.mockResolvedValue([
    { name: 'QWEN.md', text: '# Project Rules\n' },
    { name: 'AGENTS.md', text: 'never touch prod' },
  ]);
  turn = turnWithContext(slot);
  await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(slot.value).toBe(
    '--- Context from: QWEN.md ---\n# Project Rules\n--- End of Context from: QWEN.md ---\n\n--- Context from: AGENTS.md ---\nnever touch prod\n--- End of Context from: AGENTS.md ---',
  );
  await turn.consumeResults();
  await turn.finish();
});

it('reads Workspace instructions once, outside the execution ledger', async () => {
  const slot = contextSlot();
  broker.workspaceContext.mockResolvedValue([
    { name: 'QWEN.md', text: '# Project Rules\nAlways test.\n' },
    { name: 'AGENTS.md', text: '   ' },
  ]);
  turn = turnWithContext(slot);
  await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(slot.value).toBe(
    '--- Context from: QWEN.md ---\n# Project Rules\nAlways test.\n--- End of Context from: QWEN.md ---',
  );
  expect(broker.workspaceContext).toHaveBeenCalledOnce();
  // The context read reserves no execution: only the model's call does.
  expect(broker.prepare).toHaveBeenCalledOnce();
  expect(broker.execute).toHaveBeenCalledOnce();
  await turn.consumeResults();
  await turn.finish();

  const second = turnWithContext(slot, 'prompt-2');
  await second.execute(
    [{ ...calls[0], callId: 'call-next' }],
    [
      {
        functionCall: {
          id: 'call-next',
          name: 'read_file',
          args: { file_path: 'file.txt' },
        },
      },
    ],
    'model',
    new AbortController().signal,
  );
  await second.consumeResults();
  await second.finish();
  // The fetched context is reused: no further context reads.
  expect(broker.workspaceContext).toHaveBeenCalledOnce();
});

it('latches an empty context when the Workspace has no instruction files', async () => {
  const slot = contextSlot();
  turn = turnWithContext(slot);
  await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(slot.read()).toBe('');
  await turn.consumeResults();
  await turn.finish();
});

it('populates the context slot on a recovery acquisition with an empty attachment', async () => {
  // A takeover builds a fresh attachment whose slot is undefined: the
  // recovery acquire must read under the latch alone, or the recovered turn
  // drives the model with no project instructions.
  const slot = contextSlot();
  broker.workspaceContext.mockResolvedValue([
    { name: 'AGENTS.md', text: 'never touch prod' },
  ]);
  turn = turnWithContext(slot);
  await turn.resumeCommittedResults(new AbortController().signal);
  expect(slot.value).toBe(
    '--- Context from: AGENTS.md ---\nnever touch prod\n--- End of Context from: AGENTS.md ---',
  );
  expect(broker.workspaceContext).toHaveBeenCalledOnce();
  await turn.finish();
});

it('does not latch the context slot when the turn is aborted during the read', async () => {
  // Writing `''` after an abort would pin "no Workspace context" for the
  // Session's whole attached life — the retry gate reads `undefined` as
  // "not fetched yet", so the slot must stay undefined.
  const slot = contextSlot();
  const controller = new AbortController();
  broker.workspaceContext.mockImplementation(async () => {
    controller.abort();
    return [];
  });
  turn = turnWithContext(slot);
  await turn
    .execute([calls[0]], [parts[0]], 'model', controller.signal)
    .catch(() => undefined);
  await turn.finish().catch(() => undefined);
  expect(broker.workspaceContext).toHaveBeenCalledOnce();
  expect(slot.read()).toBeUndefined();
});

it('cancels a turn without waiting for a stalled Workspace context read', async () => {
  const slot = contextSlot();
  const write = vi.spyOn(slot, 'write');
  const controller = new AbortController();
  const reason = new Error('cancelled during Workspace context read');
  broker.workspaceContext.mockImplementation(() => new Promise(() => {}));
  turn = turnWithContext(slot);
  const settled = vi.fn();
  const outcome = turn
    .execute([calls[0]], [parts[0]], 'model', controller.signal)
    .catch((cause: unknown) => cause);
  void outcome.then(settled);
  await vi.waitFor(() =>
    expect(broker.workspaceContext).toHaveBeenCalledOnce(),
  );
  controller.abort(reason);
  await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), {
    timeout: 1_000,
  });
  expect(await outcome).toBe(reason);
  expect(broker.prepare).not.toHaveBeenCalled();
  expect(broker.execute).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(slot.read()).toBeUndefined();
  await turn.finish();
  expect(broker.release).toHaveBeenCalledOnce();
});

it.each([
  ['QWEN.md', true],
  ['AGENTS.md', true],
  ['docs/QWEN.md', false],
  ['file.txt', false],
] as const)(
  'an edit of %s invalidates the cached Workspace context: %s',
  async (file, stale) => {
    const slot = contextSlot();
    slot.value = 'cached rules';
    turn = turnWithContext(slot);
    const call = { ...calls[1], args: { ...calls[1].args, file_path: file } };
    await turn.execute(
      [call],
      [{ functionCall: { id: call.callId, name: call.name, args: call.args } }],
      'model',
      new AbortController().signal,
    );
    await turn.consumeResults();
    await turn.finish();
    // Only the Session-root instruction files are read, so only they stale it.
    expect(slot.value).toBe(stale ? undefined : 'cached rules');
    // The slot already held text, so this turn did not read again.
    expect(broker.workspaceContext).not.toHaveBeenCalled();
  },
);

it('never blocks a turn when the Workspace context read fails', async () => {
  const log = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  const slot = contextSlot();
  broker.workspaceContext.mockRejectedValue(new Error('Broker transport down'));
  turn = turnWithContext(slot);
  const responses = await turn.execute(
    [calls[0]],
    [parts[0]],
    'model',
    new AbortController().signal,
  );
  expect(responses[0].functionResponse?.response).toMatchObject({
    output: 'original result',
  });
  expect(slot.value).toBeUndefined();
  // The stderr line is the only signal of Broker/worker skew (design doc,
  // Deployment and rollout).
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('Hosted Workspace context read failed'),
  );
  // Nothing was reserved, so nothing needs cancelling.
  expect(broker.cancel).not.toHaveBeenCalled();
  await turn.consumeResults();
  await turn.finish();
});
it.each([
  ['file-first', false],
  ['file-last-with-shell', true],
] as const)(
  'refuses a mixed %s batch, then executes only the corrected call',
  async (_scenario, shell) => {
    turn = createTurn(shell);
    const invalid = {
      ...calls[0],
      callId: 'invalid-path',
      args: { file_path: '/private/secret-host-path' },
    };
    const sibling = shell
      ? {
          ...calls[0],
          callId: 'valid-shell',
          name: 'run_shell_command',
          args: { command: 'touch should-not-run' },
        }
      : {
          ...calls[0],
          callId: 'valid-write',
          name: 'write_file',
          args: { file_path: 'valid.txt', content: 'one effect' },
        };
    const batch = shell ? [sibling, invalid] : [invalid, sibling];
    const original = batch.map((call) => ({
      functionCall: { id: call.callId, name: call.name, args: call.args },
    }));
    const responses = await turn.execute(
      batch,
      original,
      'model',
      new AbortController().signal,
    );
    expect(responses.map((part) => part.functionResponse?.id)).toEqual(
      batch.map((call) => call.callId),
    );
    expect(
      responses.find((part) => part.functionResponse?.id === invalid.callId)
        ?.functionResponse?.response?.['error'],
    ).toContain('file_path');
    expect(
      responses.find((part) => part.functionResponse?.id === sibling.callId)
        ?.functionResponse?.response?.['error'],
    ).toContain('not executed');
    expect(JSON.stringify(responses)).not.toContain('invalid Shell arguments');
    expect((await session.sink.project()).map((record) => record.type)).toEqual(
      ['assistant', 'tool_result'],
    );
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.prepare).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    expect(broker.registerPublisher).not.toHaveBeenCalled();
    await turn.consumeResults();

    const corrected = {
      ...sibling,
      callId: 'corrected-write',
      name: 'write_file',
      args: { file_path: 'valid.txt', content: 'one effect' },
    };
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
    expect(broker.release).toHaveBeenCalledOnce();
  },
);

it('keeps release failures recovery blocked', async () => {
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  broker.release.mockRejectedValue(new Error('lost release'));
  await expect(turn.finish()).rejects.toBeInstanceOf(
    HostedToolRecoveryRequiredError,
  );
});

it('hands back only the Workspace mount on the recovery-block path', async () => {
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  expect(broker.acquire).toHaveBeenCalledOnce();
  await turn.releaseForRecoveryBlock();
  // #13800: the mount lease goes back so later Sessions on the same
  // storage are never wedged by this turn's block; the Runtime Session
  // itself never sees the RELEASED-forever full release, and the handback
  // names the claim of the acquire that owes it.
  expect(broker.releaseMount).toHaveBeenCalledOnce();
  expect(broker.releaseMount).toHaveBeenCalledWith('claim-1');
  expect(broker.release).not.toHaveBeenCalled();
  // A repeated block-side handback is a no-op.
  await turn.releaseForRecoveryBlock();
  expect(broker.releaseMount).toHaveBeenCalledOnce();
});

it('keeps the block verdict deliverable when the mount handback fails, and keeps the handback owed until it lands', async () => {
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  broker.releaseMount.mockRejectedValue(
    new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy'),
  );
  const log = vi
    .spyOn(stdio, 'writeStderrLineSafe')
    .mockImplementation(() => {});
  vi.useFakeTimers();
  try {
    // The failure is logged, never thrown: the recovery-block verdict must
    // still reach the Session.
    await expect(turn.releaseForRecoveryBlock()).resolves.toBeUndefined();
    expect(broker.releaseMount).toHaveBeenCalledOnce();
    // Owed until it lands: the cadence keeps asking on a widening backoff
    // and then a steady one-minute tail instead of dropping the debt after
    // two gaps — the freeze stays honest while the turn's work is unproven.
    for (const [gap, calls] of [
      [1000, 2],
      [3000, 3],
      [5000, 4],
      [10000, 5],
      [30000, 6],
      [60000, 7],
      [60000, 8],
    ] as const) {
      await vi.advanceTimersByTimeAsync(gap);
      expect(broker.releaseMount).toHaveBeenCalledTimes(calls);
    }
    // One line for the repeated refusal, not one per minute.
    expect(log).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('hands the mount back once a busy refusal settles', async () => {
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  broker.releaseMount
    .mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy'),
    )
    .mockResolvedValue(undefined);
  await turn.releaseForRecoveryBlock();
  expect(broker.releaseMount).toHaveBeenCalledOnce();
  await turn.blockMountRetry;
  expect(broker.releaseMount).toHaveBeenCalledTimes(2);
});

it.each([
  [503, 'runtime_reconciliation_required'],
  [409, 'runtime_session_conflict'],
  [409, 'runtime_admission_closed'],
  [409, 'workspace_writer_unproven'],
])(
  'makes one attempt for a final %s %s refusal without retrying',
  async (status, code) => {
    await turn.execute(calls, parts, 'model', new AbortController().signal);
    // A Session the Broker no longer holds, a claim a re-drive superseded,
    // a lifecycle drain that frees the mount itself, or a writer that never
    // proved it stopped: waiting settles none of them.
    broker.releaseMount.mockRejectedValue(
      new HostedWorkspaceBrokerRejection(status, code),
    );
    await turn.releaseForRecoveryBlock();
    expect(broker.releaseMount).toHaveBeenCalledOnce();
    await turn.blockMountRetry;
    expect(broker.releaseMount).toHaveBeenCalledOnce();
  },
);

it.each([
  ['a lost reply', () => new TypeError('fetch failed')],
  [
    "the Broker's internal error",
    () =>
      new HostedWorkspaceBrokerRejection(500, 'runtime_broker_internal_error'),
  ],
])('re-sends the handback after %s', async (_label, failure) => {
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  broker.releaseMount
    .mockRejectedValueOnce(failure())
    .mockResolvedValue(undefined);
  await turn.releaseForRecoveryBlock();
  expect(broker.releaseMount).toHaveBeenCalledOnce();
  // Neither decided anything, and the holder-conditioned clear is
  // idempotent, so the chain re-sends on the cadence until it lands.
  await turn.blockMountRetry;
  expect(broker.releaseMount).toHaveBeenCalledTimes(2);
});

it('delivers the block verdict without waiting out a hung handback', async () => {
  await turn.execute(calls, parts, 'model', new AbortController().signal);
  let rejectFirst!: (cause: unknown) => void;
  broker.releaseMount
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirst = reject;
        }),
    )
    .mockResolvedValue(undefined);
  vi.useFakeTimers();
  try {
    const verdict = turn.releaseForRecoveryBlock();
    await vi.advanceTimersByTimeAsync(2000);
    // The verdict proceeded on its own short bound, not on the Broker's
    // 30s fetch timeout; the attempt itself is still alive in the chain.
    await expect(verdict).resolves.toBeUndefined();
    expect(broker.releaseMount).toHaveBeenCalledOnce();
    rejectFirst(new TypeError('fetch failed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(broker.releaseMount).toHaveBeenCalledTimes(2);
    await turn.blockMountRetry;
  } finally {
    vi.useRealTimers();
  }
});

it('hands nothing back when the turn never sent an acquire', async () => {
  // Only an acquire's claim can name a mount: a turn blocked before its
  // first acquire holds nothing.
  await turn.releaseForRecoveryBlock();
  expect(broker.releaseMount).not.toHaveBeenCalled();
  expect(turn.blockMountRetry).toBeUndefined();
});

it('stops the owed handback when the daemon shuts down', async () => {
  const mountHandbacks = new Set<() => void>();
  const owned = new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test', mountHandbacks },
    session,
    harness,
    'prompt',
    commit,
    messageFitsInline,
  );
  await owned.execute(calls, parts, 'model', new AbortController().signal);
  broker.releaseMount.mockRejectedValue(
    new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy'),
  );
  vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
  await owned.releaseForRecoveryBlock();
  expect(mountHandbacks.size).toBe(1);
  for (const stop of mountHandbacks) stop();
  await owned.blockMountRetry;
  expect(mountHandbacks.size).toBe(0);
  expect(broker.releaseMount).toHaveBeenCalledOnce();
});

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

function hookSession(fire: HostedHookSession['fire']): HostedHookSession {
  return {
    fire,
    broker: { ...broker, runtimeSessionId: 'prompt' },
    acquire: () => broker.acquire(),
  } as unknown as HostedHookSession;
}

// The tool input a managed-tool-input resource carries.
async function toolInputOf(ref: ManagedSessionDurableRef): Promise<unknown> {
  return JSON.parse(
    JSON.parse((await session.resources.read(ref)).toString()).payloadJson,
  ).input;
}
