/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BOOT_ID,
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  hookPin,
  settleTimeoutMs,
  state,
  store,
  wakeDeps,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import supertest from 'supertest';
import { expect, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { oweHostedTurnCleanup } from './hosted-turn-cleanup.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { HostedHookSession } from './hosted-hook-session.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { hostedRuntimeSessionId } from './hosted-workspace-tool-turn.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedAutomationSession } from './hosted-automation-session.js';
import type { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';

const AUTOMATION_ID = `asch_${'1'.repeat(32)}`;

const AUTOMATION_SLOT = 'schedule:2026-03-08T07:00:00Z';

const automationDefinition = {
  goal: 'Nightly build',
  cron: '0 2 * * *',
  timezone: 'Asia/Shanghai',
  prompt: 'Run the build.',
};

const fireBody = (
  definitionRevision = 1,
  occurrenceKey = AUTOMATION_SLOT,
  trigger = 'scheduled',
) => ({
  kind: 'fire_run',
  scheduleId: AUTOMATION_ID,
  definitionRevision,
  occurrenceKey,
  trigger,
  firedAt: Date.parse('2026-03-08T07:00:05Z'),
});

async function prewriteAutomationSession(
  toolProfile?: string,
  captureBytes?: number,
  cancel = false,
): Promise<string> {
  state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 0 });
  const key = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: SESSION_ID,
  };
  const journalStore = new LocalJsonlManagedSessionJournalStore({
    runtimeBaseDir: state.root,
    sessionId: SESSION_ID,
    transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
  });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: state.root,
    sessionKey: key,
  });
  const managed = await openManagedSession({
    runtimeBaseDir: state.root,
    transcriptPath: '',
    sessionId: SESSION_ID,
    sessionKey: key,
    cwd: state.root,
    version: 'hosted-harness/1',
    workerId: BOOT_ID,
    activationLeaseDurationMs: 60_000,
    journalStore,
    resourceStore: resources,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from(
          JSON.stringify({
            engine: 'managed',
            sessionId: SESSION_ID,
            ...(toolProfile === undefined ? {} : { toolProfile }),
            ...(captureBytes === undefined ? {} : { captureBytes }),
          }),
        ),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from(JSON.stringify({ cwd: state.root })),
      ),
      createdBy: 'hosted-harness',
    },
  });
  try {
    const automations = new HostedAutomationSession(
      {
        authority: managed.authority,
        resources: managed.resources,
        sink: managed.sink,
      },
      key,
    );
    await automations.define({
      scheduleId: AUTOMATION_ID,
      operationId: randomUUID(),
      definition: automationDefinition,
    });
    const fired = await automations.fire({
      scheduleId: AUTOMATION_ID,
      definitionRevision: 1,
      occurrenceKey: AUTOMATION_SLOT,
      trigger: 'scheduled',
      firedAt: Date.parse('2026-03-08T07:00:05Z'),
    });
    if (cancel) await automations.requestCancel(fired.run!.automationRunId);
    return fired.inputId;
  } finally {
    await managed.close().catch(() => undefined);
  }
}

// A prewrite whose automation turn ran and ended with the writer's crash:
// the journal carries the committed input, the transcript carries the
// turn attempt, and the hook pin keeps a bare load from refusing the
// crash the way a parked prompt would refuse it without one.
async function prewriteAutomationCrashedTurnSession(
  cancel = false,
): Promise<string> {
  const key = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: SESSION_ID,
  };
  const journalStore = new LocalJsonlManagedSessionJournalStore({
    runtimeBaseDir: state.root,
    sessionId: SESSION_ID,
    transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
  });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: state.root,
    sessionKey: key,
  });
  const managed = await openManagedSession({
    runtimeBaseDir: state.root,
    transcriptPath: '',
    sessionId: SESSION_ID,
    sessionKey: key,
    cwd: state.root,
    version: 'hosted-harness/1',
    workerId: BOOT_ID,
    activationLeaseDurationMs: 60_000,
    journalStore,
    resourceStore: resources,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from(
          JSON.stringify({
            engine: 'managed',
            sessionId: SESSION_ID,
            toolProfile: 'hosted-workspace-shell/1',
            hookCatalog: hookPin,
          }),
        ),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from(JSON.stringify({ cwd: state.root })),
      ),
      createdBy: 'hosted-harness',
    },
  });
  try {
    const automations = new HostedAutomationSession(
      {
        authority: managed.authority,
        resources: managed.resources,
        sink: managed.sink,
      },
      key,
    );
    await automations.define({
      scheduleId: AUTOMATION_ID,
      operationId: randomUUID(),
      definition: automationDefinition,
    });
    const fired = await automations.fire({
      scheduleId: AUTOMATION_ID,
      definitionRevision: 1,
      occurrenceKey: AUTOMATION_SLOT,
      trigger: 'scheduled',
      firedAt: Date.parse('2026-03-08T07:00:05Z'),
    });
    // The attempt the writer itself sealed: the turn ran here and died.
    await managed.sink.write({
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      type: 'user',
      cwd: state.root,
      version: 'hosted-harness/1',
      daemonPromptId: fired.inputId,
      message: { role: 'user', parts: [{ text: 'queued' }] },
    } as never);
    if (cancel) await automations.requestCancel(fired.run!.automationRunId);
    return fired.inputId;
  } finally {
    await managed.close().catch(() => undefined);
  }
}

// A prewrite whose automation wake turn crashed inside its Runtime call:
// exactly what a Harness kill mid-execution leaves durable — the
// committed input, the turn's user record, the dispatch's tool.intent,
// and an await_runtime checkpoint pinning this turn. 'run_shell_command'
// parks a Shell call instead: the hooks/MCP-defined Session of this
// fixture deterministically declines its Broker identity.
async function prewriteAutomationParkedWakeSession(
  tooling: 'read_file' | 'run_shell_command' = 'read_file',
  withOlderLoopInput = false,
): Promise<string> {
  state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 0 });
  const shellArg = tooling === 'run_shell_command';
  const key = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: SESSION_ID,
  };
  const journalStore = new LocalJsonlManagedSessionJournalStore({
    runtimeBaseDir: state.root,
    sessionId: SESSION_ID,
    transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
  });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: state.root,
    sessionKey: key,
  });
  const managed = await openManagedSession({
    runtimeBaseDir: state.root,
    transcriptPath: '',
    sessionId: SESSION_ID,
    sessionKey: key,
    cwd: state.root,
    version: 'hosted-harness/1',
    workerId: BOOT_ID,
    activationLeaseDurationMs: 60_000,
    journalStore,
    resourceStore: resources,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from(
          JSON.stringify({
            engine: 'managed',
            sessionId: SESSION_ID,
            toolProfile: 'hosted-workspace-shell/1',
            hookCatalog: hookPin,
          }),
        ),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from(JSON.stringify({ cwd: state.root })),
      ),
      createdBy: 'hosted-harness',
    },
  });
  try {
    // The baseline goes down first: with any continuation content but
    // no checkpoint the authority restores blocked (missing_checkpoint),
    // so the turn's before_model lands before the automation records.
    const handle = createManagedHarnessHandle(managed);
    await handle.ensureRunnable();
    if (withOlderLoopInput) {
      // An older, not-yet-due loop wakeup: first by journal order but never
      // attempted. Recovery must target the crashed automation below, not
      // this skipped input.
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: 'loop-older-1',
          sessionKey: key,
          contentDigest: 'b'.repeat(64),
        },
        {
          inputId: 'loop:older-1',
          turnId: 'loop:older-1',
          source: 'loop',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from(JSON.stringify({ text: '/loop tick' }), 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
          notBefore: Date.now() + 3_600_000,
        },
      );
    }
    const automations = new HostedAutomationSession(
      {
        authority: managed.authority,
        resources: managed.resources,
        sink: managed.sink,
      },
      key,
    );
    await automations.define({
      scheduleId: AUTOMATION_ID,
      operationId: randomUUID(),
      definition: automationDefinition,
    });
    const fired = await automations.fire({
      scheduleId: AUTOMATION_ID,
      definitionRevision: 1,
      occurrenceKey: AUTOMATION_SLOT,
      trigger: 'scheduled',
      firedAt: Date.parse('2026-03-08T07:00:05Z'),
    });
    const inputId = fired.inputId;
    // The attempt the owner died inside: prompt, intent, checkpoint —
    // and the assistant's functionCall the checkpoint's item names.
    const userRecord = {
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      type: 'user',
      cwd: state.root,
      version: 'hosted-harness/1',
      daemonPromptId: inputId,
      message: { role: 'user', parts: [{ text: 'queued' }] },
    };
    await managed.sink.write(userRecord as never);
    const callName = shellArg ? 'run_shell_command' : 'read_file';
    await managed.sink.write({
      uuid: 'msg-wake-1',
      parentUuid: userRecord.uuid,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      type: 'assistant',
      cwd: state.root,
      version: 'hosted-harness/1',
      daemonPromptId: inputId,
      message: {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'fc-wake-1', name: callName, args: {} },
          },
        ],
      },
    } as never);
    const argsRef = await resources.publish(
      shellArg ? 'managed-tool-args' : 'managed-tool-input',
      Buffer.from(
        shellArg
          ? JSON.stringify({ command: 'cat a.txt' })
          : JSON.stringify({
              harnessSessionId: SESSION_ID,
              runtimeSessionId: 'rt-wake-1',
            }),
      ),
    );
    const toolDefinitionRef = await resources.publish(
      'managed-tool-definition',
      Buffer.from('{}'),
    );
    await managed.authority.appendExecutionEvent(
      {
        operation: 'recordToolIntent',
        commandId: `intent:${inputId}`,
        sessionKey: key,
        contentDigest: 'b'.repeat(64),
      },
      (sequence) => ({
        v: 1,
        sequence,
        eventId: `intent:${inputId}`,
        sessionKey: key,
        kind: 'tool.intent',
        occurredAt: Date.now(),
        subject: {
          type: 'activation',
          scopeId: managed.activation.activationId,
          ...managed.activation,
        },
        payload: {
          executionCallId: 'ex-wake-1',
          batchId: 'batch-wake-1',
          ordinal: 0,
          toolDefinitionRef,
          argsRef,
          outcomeSource: 'runtime',
        },
      }),
      { class: 'harness', activation: managed.activation },
    );
    await handle.commitAwaitRuntimeBatch(
      [
        {
          functionCallId: 'fc-wake-1',
          toolName: shellArg ? 'run_shell_command' : 'read_file',
          executionCallId: 'ex-wake-1',
          invocationBindingId: 'bind-wake-1',
          capabilityVersion: 'cap-1',
          policyVersion: 'pol-1',
          mediaVersion: null,
          modelMessageId: 'msg-wake-1',
          partIndex: 0,
          ordinal: 0,
          inputDigest: 'c'.repeat(64),
          progressCursor: null,
          attemptId: 'att-wake-1',
          routeRef: await resources.publish(
            'managed-route',
            Buffer.from('{"model":"qwen3-coder-plus"}'),
          ),
        },
      ],
      { turnId: inputId, promptId: inputId },
    );
    return inputId;
  } finally {
    await managed.close().catch(() => undefined);
  }
}

// The Broker answers each status poll once in the order given: TypeError
// entries throw, then {@link mockRepairBroker.unlatch} lets the rest
// play out, so a wedge and its recovery share one fixture run. Statuses
// on the cold surface (`acquire` never called) answer 404 — the old
// tails — while recorded calls keep `acquire`/`status`/`release` order.
function mockRepairBroker() {
  mockBrokerBroker();
  const repair = {
    script: [] as Array<{ state: 'running' } | { state: 'settled' }>,
    latched: true,
    order: [] as string[],
    unlatch: () => {
      repair.latched = false;
    },
  };
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      repair.order.push('acquire');
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    },
  );
  vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(() => {
    repair.order.push('status');
    if (!repair.order.includes('acquire')) {
      return Promise.reject(
        new HostedWorkspaceBrokerRejection(404, 'runtime_session_not_found'),
      );
    }
    if (repair.latched) {
      return Promise.reject(
        new TypeError('Runtime Broker status lost to a 503'),
      );
    }
    const next = repair.script.shift() ?? { state: 'settled' as const };
    return Promise.resolve(next as never);
  });
  vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
    () => {
      repair.order.push('release');
      return Promise.resolve();
    },
  );
  vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
  return repair;
}

// #14538: a wake pump pass holds no turn slot while it reads, projects
// and classifies a crashed input, so the reconcile route's repair waits
// the pass out instead of consuming the input under it. The holds below
// find the pass by its stack, never by a line number.
function wakePassStack(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const stack = new Error('wake pass').stack ?? '';
  Error.stackTraceLimit = limit;
  return stack;
}

function holdWakePass(
  at: 'input read' | 'transcript projection',
  when: () => boolean = () => true,
): { held: () => boolean; open: () => void } {
  let held = false;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  if (at === 'input read') {
    const read = LocalManagedSessionResourceStore.prototype.read;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      ref,
    ) {
      if (
        !held &&
        ref.kind === 'managed-input' &&
        when() &&
        wakePassStack().includes('HostedMonitorWakeScheduler.pump')
      ) {
        held = true;
        await opened;
      }
      return read.call(this, ref);
    });
  } else {
    const project = ManagedSessionRecordSink.prototype.project;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'project').mockImplementation(
      async function (this: ManagedSessionRecordSink, through?: number) {
        if (
          !held &&
          when() &&
          wakePassStack().includes('hosted-monitor-wake-turn.ts')
        ) {
          held = true;
          await opened;
        }
        return project.call(this, through);
      },
    );
  }
  return { held: () => held, open };
}

// Resolves 'waiting' unless `answer` lands first: the route cannot
// answer while the pass it waits for is held, so this only ever gives a
// route that skips the wait the time to show it.
const stillWaiting = (answer: Promise<unknown>) =>
  Promise.race([
    answer.then(() => 'answered'),
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
  ]);

const MONITOR_BINDING = { runtimeBindingId: 'binding-1', generation: '1' };

async function prewriteMonitorSession(): Promise<string> {
  const key = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: SESSION_ID,
  };
  const journalStore = new LocalJsonlManagedSessionJournalStore({
    runtimeBaseDir: state.root,
    sessionId: SESSION_ID,
    transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
  });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: state.root,
    sessionKey: key,
  });
  const managed = await openManagedSession({
    runtimeBaseDir: state.root,
    transcriptPath: '',
    sessionId: SESSION_ID,
    sessionKey: key,
    cwd: state.root,
    version: 'hosted-harness/1',
    workerId: BOOT_ID,
    activationLeaseDurationMs: 60_000,
    journalStore,
    resourceStore: resources,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from(
          JSON.stringify({
            engine: 'managed',
            sessionId: SESSION_ID,
            toolProfile: 'hosted-workspace-shell/1',
            hookCatalog: hookPin,
          }),
        ),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from(JSON.stringify({ cwd: state.root })),
      ),
      createdBy: 'hosted-harness',
    },
  });
  const turnId = 'monitor-1:notify:1';
  try {
    // A parked harness prompt keeps the wake pump blocked without asking
    // the close path to care: only DELETE's own settle may speak for an
    // unattempted monitor notification.
    await managed.authority.submitInput(
      {
        operation: 'submitInput',
        commandId: 'prompt-1',
        sessionKey: key,
        contentDigest: 'a'.repeat(64),
      },
      {
        inputId: 'prompt-1',
        turnId: 'prompt-1',
        source: 'hosted-harness',
        contentRef: await managed.resources.publish(
          'managed-input',
          Buffer.from('[{"type":"text","text":"hi"}]', 'utf8'),
        ),
        admissionRef: await managed.resources.publish(
          'managed-admission',
          Buffer.from('{}', 'utf8'),
        ),
        deadline: null,
        wakeReason: 'input',
      },
    );
    const monitors = new HostedMonitorSession(
      { authority: managed.authority, resources: managed.resources },
      key,
    );
    await monitors.admit({
      monitorId: 'monitor-1',
      ownerScopeId: key.sessionId,
      executionCallId: 'call-1',
      args: { command: 'tail -f build.log' },
      maxEvents: 100,
      idleTimeoutMs: 60_000,
      debounceMs: 1_000,
    });
    await monitors.dispatchStarted('monitor-1', MONITOR_BINDING);
    await monitors.attach('monitor-1', MONITOR_BINDING, { watch: 'started' });
    await monitors.observe(
      'monitor-1',
      { lines: ['one'] },
      {
        input: {
          inputId: turnId,
          turnId,
          source: 'monitor',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from('{"text":"<task-notification />"}', 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      },
    );
  } finally {
    await managed.close().catch(() => undefined);
  }
  return turnId;
}

function mockBrokerBroker() {
  vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    },
  );
  vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
    async (operation) => {
      if (operation.kind === 'hook-catalog')
        return {
          operationId: operation.operationId,
          state: 'settled' as const,
          catalog: {
            ...hookPin,
            hooks: [
              HookEventName.Notification,
              HookEventName.SessionEnd,
              HookEventName.SessionDelete,
            ].map((eventName) => ({
              hookId: eventName,
              eventName,
              sequential: false,
              async: false,
              failClosed: true,
              onceKey: null,
              config: { type: 'command' as const },
            })),
            ...operation.pin,
          },
        };
      return {
        operationId: operation.operationId,
        state: 'settled' as const,
        result: {
          success: true,
          outcome: 'success' as const,
          duration: 0,
          output: { hookSpecificOutput: { additionalContext: 'checked' } },
        },
      };
    },
  );
}

function capturedWakeSession() {
  return (
    wakeDeps.last as {
      session: {
        managed: Awaited<ReturnType<typeof openManagedSession>>;
        admissions: Map<string, { digest: string; lastEventId: number }>;
        runtimeLeaseHeld?: { promptId: string; runtimeSessionId: string };
        runtimeLeaseOwedByTerminalRoute?: boolean;
        blocked: boolean;
        cleanupBlocked?: boolean;
        hooks?: HostedHookSession;
        cleanupRetry?: Promise<void>;
        heldRuntimeTurns: Set<string>;
        shell?: {
          monitorLoops?: Map<
            string,
            {
              prepareLifecycle: () => void;
              stop: (
                settle?: 'stop_requested' | 'runtime_lost',
              ) => Promise<void>;
            }
          >;
        };
        hooksBusy?: boolean;
        recoveredTurn?: string;
        mcpClosing?: boolean;
        monitorWake?: HostedMonitorWakeScheduler;
      };
    }
  ).session;
}

async function recoveryFileSession(toolProfile = 'hosted-workspace-files/1') {
  mockBrokerBroker();
  const server = await app(true);
  const created = await headers(supertest(server).post('/session'))
    .send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile,
      approvalMode: 'yolo',
    })
    .expect(200);
  const authorize = (request: supertest.Test) =>
    headers(request).set('X-Qwen-Client-Id', created.body.clientId);
  const prompt = [{ type: 'text', text: 'original' }];
  const submit = (deadlineMs?: number) =>
    authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        ...(deadlineMs ? { deadlineMs } : {}),
      })
      .expect(202);
  const status = () =>
    authorize(supertest(server).get(`/session/${SESSION_ID}/status`)).expect(
      200,
    );
  const idle = () =>
    vi.waitFor(
      async () => expect((await status()).body.hasActivePrompt).toBe(false),
      { timeout: settleTimeoutMs() },
    );
  const resident = capturedWakeSession();
  const owe = async (promptId = PROMPT_ID) => {
    const broker = new HostedWorkspaceBroker(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      resident.managed.authority.sessionHeader.sessionKey,
      hostedRuntimeSessionId(promptId),
    );
    broker.runtime = {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    };
    await oweHostedTurnCleanup(resident.managed, promptId, broker);
  };
  return { server, authorize, submit, status, idle, resident, owe };
}

export {
  AUTOMATION_ID,
  AUTOMATION_SLOT,
  automationDefinition,
  capturedWakeSession,
  fireBody,
  holdWakePass,
  mockBrokerBroker,
  mockRepairBroker,
  prewriteAutomationCrashedTurnSession,
  prewriteAutomationParkedWakeSession,
  prewriteAutomationSession,
  prewriteMonitorSession,
  recoveryFileSession,
  stillWaiting,
};
