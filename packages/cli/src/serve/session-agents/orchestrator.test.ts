/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import type { WorkspaceAgent } from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';
import type {
  AgentAdapterTurnInput,
  AgentAdapterTurnResult,
  SessionAgentPermissionPrompt,
  SessionAgentProgram,
  SessionAgentRunFrame,
  SessionSquad,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import type { ConversationRecordLike } from '@qwen-code/qwen-code-core/agents/session-agents/conversation-delta.js';
import {
  readSessionAgents,
  updateSessionAgents,
} from '@qwen-code/qwen-code-core/agents/session-agents/binding-store.js';
import type { AgentAdapterContext } from './adapters/index.js';
import { SessionNotFoundError } from '../acp-session-bridge.js';
import {
  MAX_EXTERNAL_RECORD_DISPLAY_TEXT_LENGTH,
  MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH,
  MAX_EXTERNAL_RECORD_STEPS,
  MAX_EXTERNAL_RECORD_TEXT_LENGTH,
} from '../../acp-integration/session-external-record-params.js';
import { SessionAgentEventHub } from './events.js';
import {
  RECORD_RECOVERY_WATCH_MAX_MS,
  RECORD_WATCH_MAX_MS,
  SESSION_AGENT_OFFLINE_ERROR,
  SESSION_AGENT_REPLY_NOT_RECORDED_ERROR,
  SESSION_AGENT_RESTARTED_ERROR,
  SESSION_AGENT_STOPPED_ERRORS,
  SessionAgentError,
  SessionAgentOrchestrator,
  UNREPORTED_TURN_TOKENS,
  resolveTurnPersona,
  type SessionAgentBridge,
  type SessionAgentOrchestratorOptions,
  type SessionAgentRecordWriter,
} from './orchestrator.js';

type RecordRequest = Parameters<
  SessionAgentRecordWriter['appendExternalRecord']
>[1];

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const alice: WorkspaceAgent = {
  id: 'ag_alice',
  name: 'alice',
  createdAt: 1,
  execution: { mode: 'local', provider: 'claude' },
};
const bob: WorkspaceAgent = {
  id: 'ag_bob',
  name: 'bob',
  createdAt: 1,
  execution: { mode: 'local', provider: 'claude' },
};
const carol: WorkspaceAgent = {
  id: 'ag_carol',
  name: 'carol',
  createdAt: 1,
  agentType: 'reviewer',
  instructions: 'Be terse.',
  execution: { mode: 'managed-host', hostIds: ['h1'], provider: 'claude' },
};

/**
 * The ACP child's side of `appendExternalRecord`: idempotent on recordKey,
 * and deferring writes while a main-model turn runs (`busy`).
 */
class FakeBridge {
  records: ConversationRecordLike[] = [];
  busy = false;
  private next = 0;
  private readonly keys = new Map<string, string>();
  private held: RecordRequest[] = [];

  appendExternalRecord = vi.fn(
    async (sessionId: string, request: RecordRequest) => {
      const existing = this.keys.get(request.recordKey);
      if (existing) return { sessionId, recordId: existing, created: false };
      if (this.busy) {
        const first = !this.held.some(
          (held) => held.recordKey === request.recordKey,
        );
        if (first) this.held.push(request);
        return { sessionId, recordId: '', created: true, deferred: true };
      }
      return { sessionId, recordId: this.write(request), created: true };
    },
  );

  resumeSession = vi.fn(async () => ({}));

  /** The main-model turn settles: deferred records are written. */
  land(): void {
    this.busy = false;
    for (const request of this.held.splice(0)) this.write(request);
  }

  private write(request: RecordRequest): string {
    const uuid = `rec-${++this.next}`;
    this.records.push({
      uuid,
      type: 'user',
      subtype: request.kind,
      systemPayload: request.payload,
    });
    this.keys.set(request.recordKey, uuid);
    return uuid;
  }
}

interface Turn {
  program: SessionAgentProgram;
  context: AgentAdapterContext;
  input: AgentAdapterTurnInput;
  finish(result?: Partial<AgentAdapterTurnResult>): void;
}

let runtimeDir: string;
let projectRoot: string;
const created: SessionAgentOrchestrator[] = [];

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-orch-'));
  projectRoot = path.join(runtimeDir, 'project');
  Storage.setRuntimeBaseDir(runtimeDir);
  // The `session_send` server's command line names the CLI entry.
  vi.stubEnv('QWEN_CLI_ENTRY', '/opt/qwen/cli.js');
});

afterEach(async () => {
  for (const orchestrator of created.splice(0)) await orchestrator.dispose();
  // Let cancelled turns finish their (now pointless) writes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  Storage.setRuntimeBaseDir(null);
  vi.unstubAllEnvs();
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

function harness(
  options: {
    roster?: WorkspaceAgent[];
    chainLimit?: number;
    extra?: Partial<SessionAgentOrchestratorOptions>;
  } = {},
) {
  const bridge = new FakeBridge();
  const hub = new SessionAgentEventHub(0);
  const frames: SessionAgentRunFrame[] = [];
  hub.subscribe((frame) => {
    if (frame.type === 'run') frames.push(frame);
  });
  const turns: Turn[] = [];
  const roster = options.roster ?? [alice, bob];
  const orchestrator = new SessionAgentOrchestrator({
    workspaceCwd: projectRoot,
    bridge: bridge as unknown as SessionAgentBridge,
    hub,
    chainLimit: () => options.chainLimit ?? 0,
    readAgents: async () => roster,
    loadRecords: async () => bridge.records,
    getAdapter: (program, context) => ({
      program,
      runTurn: (input) =>
        new Promise<AgentAdapterTurnResult>((resolve) => {
          input.signal.addEventListener(
            'abort',
            () => resolve({ status: 'cancelled', outputText: '' }),
            { once: true },
          );
          turns.push({
            program,
            context,
            input,
            finish: (result = {}) =>
              resolve({ status: 'completed', outputText: '', ...result }),
          });
        }),
    }),
    startTimers: false,
    recordWatchMs: 5,
    ...options.extra,
  });
  created.push(orchestrator);
  /** The newest frame published for `runId`. */
  const lastFrame = (runId: string) =>
    frames.filter((frame) => frame.runId === runId).at(-1);
  return { bridge, frames, lastFrame, turns, orchestrator };
}

async function fileFor(sessionId = SESSION) {
  return readSessionAgents(projectRoot, sessionId);
}

describe('native role tool restrictions', () => {
  it.each(['claude', 'codex'] as const)(
    'refuses restrictive definitions for %s',
    async (program) => {
      for (const policy of [
        { tools: ['read_file'] },
        { tools: [], disallowedTools: ['write_file', 'mcp__private'] },
      ]) {
        await expect(
          resolveTurnPersona(carol, program, async () => ({
            systemPrompt: 'Review only.',
            ...policy,
          })),
        ).rejects.toThrow(
          `restricts tools, which the ${program} runtime cannot enforce`,
        );
      }
    },
  );

  it('preserves unrestricted native personas and Qwen role policies', async () => {
    for (const tools of [undefined, [], ['*']]) {
      await expect(
        resolveTurnPersona(carol, 'codex', async () => ({
          systemPrompt: 'Review only.',
          tools,
        })),
      ).resolves.toEqual({ instructions: 'Review only.\n\nBe terse.' });
    }
    await expect(
      resolveTurnPersona(carol, 'qwen', async () => ({
        systemPrompt: 'Review only.',
        tools: ['read_file'],
        disallowedTools: ['write_file'],
      })),
    ).resolves.toEqual({ instructions: 'Review only.\n\nBe terse.' });
  });
});

describe('SessionAgentOrchestrator', () => {
  it.each(['claude', 'codex'] as const)(
    'records a restricted %s role refusal without invoking its adapter',
    async (provider) => {
      const { orchestrator, turns, lastFrame } = harness({
        roster: [
          {
            ...alice,
            agentType: 'reviewer',
            execution: { mode: 'local', provider },
          },
        ],
        extra: { loadDefinition: async () => ({ tools: ['read_file'] }) },
      });
      const { runs } = await orchestrator.mention(SESSION, {
        text: '@alice please review',
        clientMessageId: 'restricted-role',
      });
      await vi.waitFor(() =>
        expect(lastFrame(runs[0]!.runId)).toMatchObject({
          status: 'failed',
          recorded: true,
          error: expect.stringContaining('restricts tools'),
        }),
      );
      expect(turns).toHaveLength(0);
    },
  );

  it('runs a mentioned agent and records its reply', async () => {
    const { orchestrator, bridge, turns, lastFrame } = harness();
    const result = await orchestrator.mention(SESSION, {
      text: '@alice please look',
      clientMessageId: 'm1',
    });
    expect(result.recordId).toBe('rec-1');
    expect(result.runs).toEqual([
      { runId: expect.any(String), agentId: 'ag_alice', status: 'queued' },
    ]);
    const runId = result.runs[0]!.runId;

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]!.program).toBe('claude');
    expect(turns[0]!.input.prompt).toContain('please look');
    turns[0]!.finish({ outputText: 'Looked. All good.', totalTokens: 12 });

    await vi.waitFor(() =>
      expect(lastFrame(runId)).toMatchObject({
        status: 'completed',
        recorded: true,
        recordId: 'rec-2',
      }),
    );
    expect(bridge.records[1]).toMatchObject({
      subtype: 'agent_message',
      systemPayload: {
        displayText: 'Looked. All good.',
        runId,
        status: 'completed',
        totalTokens: 12,
        author: { agentId: 'ag_alice', name: 'alice', runtimeId: 'local' },
      },
    });
    await vi.waitFor(async () => {
      const file = await fileFor();
      expect(file.runs).toMatchObject([{ id: runId, status: 'completed' }]);
      expect(file.bindings['ag_alice']?.readThroughRecordId).toBe('rec-1');
    });
    expect(await orchestrator.snapshot(SESSION)).toEqual([]);
  });

  it('coalesces mentions that arrive while the agent is busy', async () => {
    const { orchestrator, turns } = harness();
    const first = await orchestrator.mention(SESSION, {
      text: '@alice one',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const second = await orchestrator.mention(SESSION, {
      text: '@alice two',
      clientMessageId: 'm2',
    });
    const third = await orchestrator.mention(SESSION, {
      text: '@alice three',
      clientMessageId: 'm3',
    });
    const queuedId = second.runs[0]!.runId;
    expect(queuedId).not.toBe(first.runs[0]!.runId);
    expect(third.runs[0]!.runId).toBe(queuedId);
    expect(
      (await orchestrator.snapshot(SESSION)).find(
        (frame) => frame.runId === queuedId,
      ),
    ).toMatchObject({ status: 'queued', queuePosition: 1 });

    turns[0]!.finish({ outputText: 'did one' });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]!.input.prompt).toContain('two');
    expect(turns[1]!.input.prompt).toContain('three');
    expect(turns[1]!.input.prompt).not.toContain('@alice one');
    const file = await fileFor();
    expect(file.runs.find((run) => run.id === queuedId)).toMatchObject({
      triggerRecordIds: ['rec-2', 'rec-3'],
      status: 'running',
    });
  });

  it('stops an agent-to-agent chain at the limit', async () => {
    const { orchestrator, bridge, turns } = harness({ chainLimit: 1 });
    await orchestrator.mention(SESSION, {
      text: '@alice start',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.finish({ outputText: '@bob take over' });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]!.context.agentId).toBe('ag_bob');
    turns[1]!.finish({ outputText: '@alice back to you' });

    await vi.waitFor(() =>
      expect(
        bridge.records.find(
          (record) =>
            (record.systemPayload as { author?: { agentId?: string } })?.author
              ?.agentId === 'ag_bob',
        )?.systemPayload,
      ).toMatchObject({
        status: 'completed',
        error: expect.stringContaining('Agent chain limit (1) reached'),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns).toHaveLength(2);
  });

  it('cancels one run, and stops all of a session', async () => {
    const { orchestrator, turns, lastFrame } = harness();
    const both = await orchestrator.mention(SESSION, {
      text: '@alice @bob go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    const queued = await orchestrator.mention(SESSION, {
      text: '@alice more',
      clientMessageId: 'm2',
    });
    const queuedId = queued.runs[0]!.runId;
    const aliceId = both.runs.find((run) => run.agentId === 'ag_alice')!.runId;
    const bobId = both.runs.find((run) => run.agentId === 'ag_bob')!.runId;

    expect(await orchestrator.cancel(SESSION, queuedId)).toBe(true);
    const queuedFrame = lastFrame(queuedId)!;
    expect(queuedFrame.status).toBe('cancelled');
    // Never started: no record will come.
    expect(queuedFrame).not.toHaveProperty('recorded');

    expect(await orchestrator.cancel(SESSION, aliceId)).toBe(true);
    await vi.waitFor(() =>
      expect(lastFrame(aliceId)).toMatchObject({
        status: 'cancelled',
        recorded: true,
      }),
    );

    expect(await orchestrator.stopAll(SESSION)).toEqual([bobId]);
    await vi.waitFor(() =>
      expect(lastFrame(bobId)).toMatchObject({ status: 'cancelled' }),
    );
    expect(await orchestrator.cancel(SESSION, 'sr_unknown')).toBe(false);
    expect(turns).toHaveLength(2);
  });

  it('relays a permission request and the person’s answer', async () => {
    const { orchestrator, turns } = harness();
    const { runs } = await orchestrator.mention(SESSION, {
      text: '@alice ls',
      clientMessageId: 'm1',
    });
    const runId = runs[0]!.runId;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const turn = turns[0]!;
    const prompt: SessionAgentPermissionPrompt = {
      requestId: 'p1',
      title: 'Run ls',
      toolName: 'execute',
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    };
    turn.input.onEvent({ type: 'permission_request', prompt });
    const answer = turn.input.awaitPermission(prompt);
    expect((await orchestrator.snapshot(SESSION))[0]).toMatchObject({
      status: 'awaiting_approval',
      permission: { requestId: 'p1' },
    });

    expect(() =>
      orchestrator.resolvePermission(SESSION, runId, 'p1', 'maybe'),
    ).toThrow(/Unknown optionId/);
    orchestrator.resolvePermission(SESSION, runId, 'p1', 'yes', {
      fromLoopback: true,
    });
    await expect(answer).resolves.toBe('yes');
    expect(turn.context.permissionVoteContext?.('p1')).toEqual({
      fromLoopback: true,
    });

    turn.input.onEvent({ type: 'permission_resolved', requestId: 'p1' });
    expect((await orchestrator.snapshot(SESSION))[0]).toMatchObject({
      status: 'running',
    });
    expect(() =>
      orchestrator.resolvePermission(SESSION, runId, 'p1', 'yes'),
    ).toThrow(/No pending permission/);
  });

  it('ignores what a stopped run still reports and refuses its late permission request', async () => {
    const held: {
      turn?: AgentAdapterTurnInput;
      finish?: (result: AgentAdapterTurnResult) => void;
    } = {};
    const { orchestrator, frames, lastFrame } = harness({
      extra: {
        getAdapter: (program) => ({
          program,
          // Winds down only when told to, like a native turn after a stop.
          runTurn: (input) =>
            new Promise<AgentAdapterTurnResult>((resolve) => {
              held.turn = input;
              held.finish = resolve;
            }),
        }),
      },
    });
    const { runs } = await orchestrator.mention(SESSION, {
      text: '@alice think about it',
      clientMessageId: 'm1',
    });
    const runId = runs[0]!.runId;
    await vi.waitFor(() => expect(held.turn).toBeDefined());
    const turn = held.turn!;
    const prompt = (requestId: string): SessionAgentPermissionPrompt => ({
      requestId,
      title: 'Run marker',
      toolName: 'execute',
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    turn.onEvent({ type: 'permission_request', prompt: prompt('p1') });
    const first = turn.awaitPermission(prompt('p1'));
    expect((await orchestrator.snapshot(SESSION))[0]).toMatchObject({
      status: 'awaiting_approval',
    });

    expect(await orchestrator.cancel(SESSION, runId)).toBe(true);
    const stoppedAt = frames.length;
    expect(turn.signal.aborted).toBe(true);
    await expect(first).rejects.toThrow('cancelled');
    // The card stops asking at once.
    let [frame] = await orchestrator.snapshot(SESSION);
    expect(frame).toMatchObject({ runId, status: 'running' });
    expect(frame).not.toHaveProperty('permission');

    // The native turn, still winding down, asks again and keeps talking.
    turn.onEvent({ type: 'permission_request', prompt: prompt('p2') });
    await expect(turn.awaitPermission(prompt('p2'))).rejects.toThrow(
      'cancelled',
    );
    turn.onEvent({ type: 'text_delta', text: 'still here' });
    [frame] = await orchestrator.snapshot(SESSION);
    expect(frame).toMatchObject({ runId, status: 'running' });
    expect(frame).not.toHaveProperty('permission');
    expect(frame).not.toHaveProperty('outputText');
    expect(() =>
      orchestrator.resolvePermission(SESSION, runId, 'p2', 'yes'),
    ).toThrow(/No pending permission/);

    held.finish!({ status: 'cancelled', outputText: '' });
    await vi.waitFor(() =>
      expect(lastFrame(runId)).toMatchObject({
        status: 'cancelled',
        recorded: true,
      }),
    );
    // Nothing after the stop put a permission back or flipped the status.
    expect(
      frames
        .slice(stoppedAt)
        .some(
          (published) =>
            published.runId === runId &&
            (published.status === 'awaiting_approval' ||
              published.permission !== undefined),
        ),
    ).toBe(false);
    expect(await orchestrator.snapshot(SESSION)).toEqual([]);
  });

  it('fences remote turns by lease and tells the Host about a cancel', async () => {
    const { orchestrator, turns, lastFrame } = harness({
      roster: [carol],
      extra: {
        loadDefinition: async (_cwd, name) =>
          name === 'reviewer' ? { systemPrompt: 'You review code.' } : null,
      },
    });
    const { runs } = await orchestrator.mention(SESSION, {
      text: '@carol check this',
      clientMessageId: 'm1',
    });
    const runId = runs[0]!.runId;
    expect((await orchestrator.snapshot(SESSION))[0]).toMatchObject({
      status: 'queued',
      queuePosition: 1,
    });
    expect(await orchestrator.pickupForHost('h2', ['claude'])).toBeUndefined();

    const assignment = await orchestrator.pickupForHost('h1', ['claude']);
    expect(assignment).toMatchObject({
      sessionId: SESSION,
      runId,
      attempt: 1,
      program: 'claude',
      agent: {
        agentId: 'ag_carol',
        runtimeId: 'h1',
        instructions: 'You review code.\n\nBe terse.',
      },
    });
    expect(assignment!.prompt).toContain('check this');
    // Nothing to resume on this Host yet.
    expect(assignment!.freshPrompt).toBeUndefined();
    expect(turns).toHaveLength(0);
    const lease = {
      sessionId: SESSION,
      runId,
      attempt: 1,
      leaseId: assignment!.leaseId,
    };

    expect(
      orchestrator.acceptHostEvents('h1', {
        ...lease,
        leaseId: 'stale',
        sequence: 1,
        events: [],
      }),
    ).toEqual({ ok: false, reason: 'lease_mismatch' });
    expect(
      orchestrator.acceptHostEvents('h1', {
        ...lease,
        sequence: 1,
        events: [{ type: 'text_delta', text: 'half' }],
      }),
    ).toMatchObject({ ok: true });
    expect(
      orchestrator.acceptHostEvents('h1', {
        ...lease,
        sequence: 1,
        events: [],
      }),
    ).toEqual({ ok: true, duplicate: true });
    expect(
      orchestrator.renewLease('h1', runId, 1, assignment!.leaseId),
    ).toMatchObject({ ok: true });
    // The accepted sequence is persisted by the sweep.
    orchestrator.sweep();
    await vi.waitFor(async () =>
      expect((await fileFor()).runs[0]?.lease?.lastSequence).toBe(1),
    );

    expect(await orchestrator.cancel(SESSION, runId)).toBe(true);
    const cancelled = { ok: false, reason: 'cancelled', cancelled: true };
    expect(
      orchestrator.renewLease('h1', runId, 1, assignment!.leaseId),
    ).toEqual(cancelled);
    expect(
      orchestrator.acceptHostEvents('h1', {
        ...lease,
        sequence: 2,
        events: [],
      }),
    ).toEqual(cancelled);
    expect(
      await orchestrator.completeHostTurn('h1', {
        ...lease,
        result: { status: 'completed', outputText: 'late' },
      }),
    ).toEqual(cancelled);
    await vi.waitFor(() =>
      expect(lastFrame(runId)).toMatchObject({
        status: 'cancelled',
        outputText: 'half',
        recorded: true,
      }),
    );
    // Kept so a restarted daemon still answers `cancelled`.
    await vi.waitFor(async () =>
      expect((await fileFor()).runs[0]).toMatchObject({
        status: 'cancelled',
        lease: { leaseId: assignment!.leaseId },
      }),
    );
  });

  it('replaces a re-answered remote permission and releases a lost pickup', async () => {
    const { orchestrator, frames } = harness({
      roster: [{ ...carol, agentType: undefined }],
    });
    const { runs } = await orchestrator.mention(SESSION, {
      text: '@carol hi',
      clientMessageId: 'm1',
    });
    const runId = runs[0]!.runId;
    const first = await orchestrator.pickupForHost('h1', ['claude']);
    const lease = {
      sessionId: SESSION,
      runId,
      attempt: 1,
      leaseId: first!.leaseId,
    };
    const prompt: SessionAgentPermissionPrompt = {
      requestId: 'p1',
      title: 'Edit',
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    };
    orchestrator.acceptHostEvents('h1', {
      ...lease,
      sequence: 1,
      events: [{ type: 'permission_request', prompt }],
    });
    const before = frames.length;
    orchestrator.resolvePermission(SESSION, runId, 'p1', 'yes');
    orchestrator.resolvePermission(SESSION, runId, 'p1', 'no');
    expect(frames.length).toBeGreaterThan(before);
    const decisions = orchestrator.decisionsForHost('h1');
    expect(decisions).toEqual([
      {
        runId,
        attempt: 1,
        requestId: 'p1',
        optionId: 'no',
        decisionId: expect.any(String),
      },
    ]);

    expect(
      orchestrator.releaseHostAssignment('h1', { ...lease, leaseId: 'x' }),
    ).toEqual({ ok: false, reason: 'lease_mismatch' });
    expect(orchestrator.releaseHostAssignment('h1', lease)).toEqual({
      ok: true,
    });
    expect((await orchestrator.snapshot(SESSION))[0]).toMatchObject({
      status: 'queued',
    });
    const second = await orchestrator.pickupForHost('h1', ['claude']);
    expect(second).toMatchObject({ runId, attempt: 2 });
  });

  it('marks a remote run offline when its lease lapses, and offers it for retry', async () => {
    let now = 1_000;
    const { orchestrator, bridge, lastFrame } = harness({
      roster: [{ ...carol, agentType: undefined }],
      extra: { now: () => now, leaseMs: 100 },
    });
    const { runs } = await orchestrator.mention(SESSION, {
      text: '@carol hi',
      clientMessageId: 'm1',
    });
    const runId = runs[0]!.runId;
    const assignment = await orchestrator.pickupForHost('h1', ['claude']);
    now += 101;
    orchestrator.sweep();
    await vi.waitFor(() =>
      expect(lastFrame(runId)).toMatchObject({
        status: 'offline',
        error: SESSION_AGENT_OFFLINE_ERROR,
        recorded: false,
        retryable: true,
      }),
    );
    // No record: the card, with Retry and Dismiss, is where it is shown.
    expect(
      bridge.records.some((record) => record.subtype === 'agent_message'),
    ).toBe(false);
    expect(await orchestrator.snapshot(SESSION)).toMatchObject([
      { runId, status: 'offline', retryable: true, recorded: false },
    ]);
    await vi.waitFor(async () =>
      expect(
        (await fileFor()).runs.find((run) => run.id === runId),
      ).toMatchObject({ status: 'offline', recorded: false }),
    );
    // The Host coming back late changes nothing.
    expect(
      orchestrator.acceptHostEvents('h1', {
        sessionId: SESSION,
        runId,
        attempt: assignment!.attempt,
        leaseId: assignment!.leaseId,
        sequence: 1,
        events: [{ type: 'text_delta', text: 'late' }],
      }),
    ).toEqual({ ok: false, reason: 'unknown_run' });

    const retried = await orchestrator.retry(SESSION, runId);
    expect(retried).toMatchObject({ agentId: 'ag_carol', status: 'queued' });
    expect(lastFrame(runId)).toMatchObject({ retriedAsRunId: retried.runId });
    expect(lastFrame(runId)).not.toHaveProperty('retryable');
    expect(
      (await orchestrator.snapshot(SESSION)).map((frame) => frame.runId),
    ).toEqual([retried.runId]);
    await expect(
      orchestrator.pickupForHost('h1', ['claude']),
    ).resolves.toMatchObject({ runId: retried.runId });
  });

  it('enforces maxConcurrentRuns across chat sessions', async () => {
    const { orchestrator, turns } = harness();
    await orchestrator.mention(SESSION, {
      text: '@alice a',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const other = await orchestrator.mention(OTHER, {
      text: '@alice b',
      clientMessageId: 'm2',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns).toHaveLength(1);
    expect((await orchestrator.snapshot(OTHER))[0]).toMatchObject({
      runId: other.runs[0]!.runId,
      status: 'queued',
      queuePosition: 1,
    });

    turns[0]!.finish({ outputText: 'done' });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]!.input.prompt).toContain('b');
    expect((await orchestrator.snapshot(OTHER))[0]).toMatchObject({
      status: 'running',
    });
  });

  it('reports a deferred record as recorded once it lands', async () => {
    const { orchestrator, bridge, turns, lastFrame } = harness();
    const { runs } = await orchestrator.mention(SESSION, {
      text: '@alice hi',
      clientMessageId: 'm1',
    });
    const runId = runs[0]!.runId;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    bridge.busy = true;
    turns[0]!.finish({ outputText: 'hello' });

    await vi.waitFor(() =>
      expect(lastFrame(runId)).toMatchObject({
        status: 'completed',
        recorded: false,
      }),
    );
    expect(await orchestrator.snapshot(SESSION)).toMatchObject([
      { runId, status: 'completed', recorded: false },
    ]);

    bridge.land();
    await vi.waitFor(() =>
      expect(lastFrame(runId)).toMatchObject({
        status: 'completed',
        recorded: true,
        recordId: 'rec-2',
      }),
    );
    expect(await orchestrator.snapshot(SESSION)).toEqual([]);
  });

  it('retries a failed record write until it lands', async () => {
    const { orchestrator, bridge, turns, lastFrame, frames } = harness();
    const { runs } = await orchestrator.mention(SESSION, {
      text: '@alice hi',
      clientMessageId: 'm1',
    });
    const runId = runs[0]!.runId;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    bridge.appendExternalRecord.mockRejectedValueOnce(new Error('boom'));
    turns[0]!.finish({ outputText: 'hello' });

    // The retry can land before a poll sees the failed frame, so look at
    // every frame the run published, not only the latest.
    await vi.waitFor(() =>
      expect(lastFrame(runId)).toMatchObject({ recorded: true }),
    );
    expect(
      frames.some(
        (frame) =>
          frame.runId === runId &&
          frame.recorded === false &&
          (frame.error ?? '').includes('Could not record the reply'),
      ),
    ).toBe(true);
    expect(lastFrame(runId)).not.toHaveProperty('error');
    expect(bridge.records[1]).toMatchObject({
      subtype: 'agent_message',
      systemPayload: { runId, displayText: 'hello' },
    });
  });

  it('restores a chat session that is not live through restoreSession', async () => {
    const restoreSession = vi.fn(async (_sessionId: string) => {});
    const { orchestrator, bridge } = harness({ extra: { restoreSession } });
    bridge.appendExternalRecord.mockRejectedValueOnce(
      new SessionNotFoundError(SESSION),
    );
    await orchestrator.mention(SESSION, {
      text: '@alice hi',
      clientMessageId: 'm1',
    });
    expect(restoreSession).toHaveBeenCalledWith(SESSION);
    expect(bridge.resumeSession).not.toHaveBeenCalled();
    expect(bridge.records[0]).toMatchObject({ subtype: 'agent_mention' });
  });

  it('adopts runs after a restart and retries an interrupted one', async () => {
    await updateSessionAgents(projectRoot, SESSION, (file) => {
      file.runs.push(
        {
          id: 'sr_old',
          agentId: 'ag_alice',
          status: 'running',
          triggerRecordIds: ['rec-x'],
          chainDepth: 0,
          createdAt: 1,
          startedAt: 2,
          attempts: 1,
        },
        {
          id: 'sr_gone',
          agentId: 'ag_bob',
          status: 'queued',
          triggerRecordIds: ['rec-y'],
          chainDepth: 0,
          createdAt: 1,
          attempts: 0,
        },
        {
          id: 'sr_remote',
          agentId: 'ag_carol',
          status: 'running',
          triggerRecordIds: ['rec-z'],
          chainDepth: 0,
          createdAt: 1,
          attempts: 1,
          lease: {
            hostId: 'h1',
            leaseId: 'L1',
            attempt: 1,
            expiresAt: 0,
            lastSequence: 4,
          },
        },
      );
    });
    const { orchestrator, turns, lastFrame } = harness({
      roster: [alice, bob, carol],
    });

    // The leased remote run carries on, fenced by its persisted sequence.
    expect(await orchestrator.liveRuns()).toEqual([
      {
        sessionId: SESSION,
        runId: 'sr_remote',
        agentId: 'ag_carol',
        status: 'running',
        hostId: 'h1',
      },
    ]);
    const lease = { sessionId: SESSION, runId: 'sr_remote', attempt: 1 };
    expect(
      orchestrator.acceptHostEvents('h1', {
        ...lease,
        leaseId: 'L1',
        sequence: 4,
        events: [],
      }),
    ).toEqual({ ok: true, duplicate: true });
    expect(
      orchestrator.acceptHostEvents('h1', {
        ...lease,
        leaseId: 'L1',
        sequence: 5,
        events: [],
      }),
    ).toMatchObject({ ok: true });

    // The local ones are failed and offered for retry.
    const snapshot = await orchestrator.snapshot(SESSION);
    expect(snapshot.find((frame) => frame.runId === 'sr_old')).toMatchObject({
      status: 'failed',
      error: SESSION_AGENT_RESTARTED_ERROR,
      retryable: true,
      recorded: false,
      author: { agentId: 'ag_alice', name: 'alice' },
    });
    await vi.waitFor(async () =>
      expect(
        (await fileFor()).runs.find((run) => run.id === 'sr_old'),
      ).toMatchObject({
        status: 'failed',
        error: SESSION_AGENT_RESTARTED_ERROR,
      }),
    );

    // Dismissing one drops its card.
    expect(await orchestrator.cancel(SESSION, 'sr_gone')).toBe(true);
    expect(lastFrame('sr_gone')).not.toHaveProperty('recorded');
    expect(lastFrame('sr_gone')).not.toHaveProperty('retryable');

    const retried = await orchestrator.retry(SESSION, 'sr_old');
    expect(retried.runId).not.toBe('sr_old');
    expect(retried.agentId).toBe('ag_alice');
    expect(lastFrame('sr_old')).toMatchObject({
      retriedAsRunId: retried.runId,
    });
    expect(lastFrame('sr_old')).not.toHaveProperty('recorded');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await vi.waitFor(async () =>
      expect(
        (await fileFor()).runs.find((run) => run.id === retried.runId),
      ).toMatchObject({ retryOf: 'sr_old', triggerRecordIds: ['rec-x'] }),
    );
    expect(
      (await orchestrator.snapshot(SESSION)).some(
        (frame) => frame.runId === 'sr_old',
      ),
    ).toBe(false);

    await expect(orchestrator.retry(SESSION, 'sr_old')).rejects.toMatchObject({
      status: 409,
      code: 'run_already_retried',
    });
    await expect(orchestrator.retry(SESSION, 'sr_nope')).rejects.toMatchObject({
      status: 404,
      code: 'run_not_found',
    });
  });

  it('offers runs whose record a shutdown lost for retry after a restart', async () => {
    const base = {
      chainDepth: 0,
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      attempts: 1,
      recorded: false,
    };
    await updateSessionAgents(projectRoot, SESSION, (file) => {
      file.runs.push(
        {
          ...base,
          // What 6.1 left: the run ended while the bridge was closing.
          id: 'sr_unrecorded',
          agentId: 'ag_alice',
          status: 'failed',
          triggerRecordIds: ['rec-x'],
          error:
            'Could not record the reply: AcpSessionBridge is shutting down',
        },
        {
          ...base,
          id: 'sr_lost',
          agentId: 'ag_bob',
          status: 'completed',
          triggerRecordIds: ['rec-y'],
        },
        {
          ...base,
          id: 'sr_landed',
          agentId: 'ag_bob',
          status: 'completed',
          triggerRecordIds: ['rec-z'],
        },
        {
          ...base,
          id: 'sr_stopped',
          agentId: 'ag_alice',
          status: 'cancelled',
          triggerRecordIds: ['rec-w'],
        },
      );
    });
    const { orchestrator, bridge, turns, lastFrame } = harness();
    // This one's record landed before its state was saved.
    bridge.records.push({
      uuid: 'rec-landed',
      type: 'user',
      subtype: 'agent_message',
      systemPayload: { runId: 'sr_landed' },
    });

    const snapshot = await orchestrator.snapshot(SESSION);
    expect(
      snapshot.find((frame) => frame.runId === 'sr_unrecorded'),
    ).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('shutting down'),
      recorded: false,
      retryable: true,
      author: { agentId: 'ag_alice', name: 'alice' },
    });
    expect(snapshot.find((frame) => frame.runId === 'sr_lost')).toMatchObject({
      status: 'completed',
      error: SESSION_AGENT_REPLY_NOT_RECORDED_ERROR,
      recorded: false,
      retryable: true,
    });
    // A stopped run is let go.
    expect(snapshot.some((frame) => frame.runId === 'sr_stopped')).toBe(false);
    // The record watcher found the landed one in the transcript.
    await vi.waitFor(() =>
      expect(lastFrame('sr_landed')).toMatchObject({
        recorded: true,
        recordId: 'rec-landed',
      }),
    );
    expect(lastFrame('sr_landed')).not.toHaveProperty('retryable');
    await vi.waitFor(async () => {
      const runs = (await fileFor()).runs;
      expect(runs.find((run) => run.id === 'sr_landed')).toMatchObject({
        recorded: true,
      });
      expect(runs.find((run) => run.id === 'sr_stopped')).not.toHaveProperty(
        'recorded',
      );
    });

    // Retry starts a new run for the same trigger.
    const retried = await orchestrator.retry(SESSION, 'sr_unrecorded');
    expect(retried).toMatchObject({ agentId: 'ag_alice' });
    expect(lastFrame('sr_unrecorded')).toMatchObject({
      retriedAsRunId: retried.runId,
    });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]!.context.agentId).toBe('ag_alice');
    // A completed run whose reply was lost can be retried too.
    const again = await orchestrator.retry(SESSION, 'sr_lost');
    expect(again).toMatchObject({ agentId: 'ag_bob' });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    await vi.waitFor(async () => {
      const runs = (await fileFor()).runs;
      expect(runs.find((run) => run.id === retried.runId)).toMatchObject({
        retryOf: 'sr_unrecorded',
        triggerRecordIds: ['rec-x'],
      });
      // Retried: a later restart does not offer it again.
      expect(runs.find((run) => run.id === 'sr_unrecorded')).not.toHaveProperty(
        'recorded',
      );
    });
  });

  it('fails a run the daemon stops with retryably, for the next daemon to offer', async () => {
    const first = harness();
    const { runs } = await first.orchestrator.mention(SESSION, {
      text: '@alice write it',
      clientMessageId: 'm1',
    });
    const runId = runs[0]!.runId;
    await vi.waitFor(() => expect(first.turns).toHaveLength(1));
    const prompt: SessionAgentPermissionPrompt = {
      requestId: 'p1',
      title: 'Write a.txt',
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    };
    // Waiting on a person when the daemon stops.
    first.turns[0]!.input.onEvent({ type: 'permission_request', prompt });
    const answer = first.turns[0]!.input.awaitPermission(prompt);
    await first.orchestrator.dispose();
    await expect(answer).rejects.toThrow();
    await vi.waitFor(async () =>
      expect(
        (await fileFor()).runs.find((run) => run.id === runId),
      ).toMatchObject({
        status: 'failed',
        error: SESSION_AGENT_RESTARTED_ERROR,
        recorded: false,
      }),
    );
    // No record: the bridge goes away with the daemon.
    expect(
      first.bridge.records.some((record) => record.subtype === 'agent_message'),
    ).toBe(false);

    const second = harness();
    expect(await second.orchestrator.snapshot(SESSION)).toMatchObject([
      {
        runId,
        status: 'failed',
        error: SESSION_AGENT_RESTARTED_ERROR,
        recorded: false,
        retryable: true,
      },
    ]);
    const retried = await second.orchestrator.retry(SESSION, runId);
    await vi.waitFor(() => expect(second.turns).toHaveLength(1));
    expect(second.lastFrame(runId)).toMatchObject({
      retriedAsRunId: retried.runId,
    });
  });

  it('fails a run stopped because collaboration was turned off with that reason', async () => {
    const first = harness();
    const { runs } = await first.orchestrator.mention(SESSION, {
      text: '@alice write it',
      clientMessageId: 'm1',
    });
    const runId = runs[0]!.runId;
    await vi.waitFor(() => expect(first.turns).toHaveLength(1));
    await first.orchestrator.dispose('collaboration_disabled');
    const stopped = SESSION_AGENT_STOPPED_ERRORS.collaboration_disabled;
    expect(stopped).toBe('stopped: agent collaboration was turned off');
    await vi.waitFor(async () =>
      expect(
        (await fileFor()).runs.find((run) => run.id === runId),
      ).toMatchObject({ status: 'failed', error: stopped, recorded: false }),
    );
    expect(first.lastFrame(runId)).toMatchObject({
      status: 'failed',
      error: stopped,
      retryable: true,
    });

    // Turned back on: offered for retry with the same reason, and not
    // looked for in the transcript (nothing was written).
    const loadRecords = vi.fn(async () => []);
    const second = harness({ extra: { loadRecords } });
    expect(await second.orchestrator.snapshot(SESSION)).toMatchObject([
      { runId, status: 'failed', error: stopped, retryable: true },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(loadRecords).not.toHaveBeenCalled();
  });

  it('resets the read cursor when a resume was rejected', async () => {
    const { orchestrator, turns } = harness();
    await orchestrator.mention(SESSION, {
      text: '@alice first topic',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    // Nothing to resume: the prompt already is the whole conversation.
    expect(turns[0]!.input.freshPrompt).toBeUndefined();
    turns[0]!.finish({ outputText: 'ok', nativeSessionId: 'n1' });
    await vi.waitFor(async () =>
      expect((await fileFor()).bindings['ag_alice']).toMatchObject({
        nativeSessionId: 'n1',
        readThroughRecordId: 'rec-1',
      }),
    );

    await orchestrator.mention(SESSION, {
      text: '@alice second topic',
      clientMessageId: 'm2',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]!.input.nativeSessionId).toBe('n1');
    expect(turns[1]!.input.prompt).not.toContain('first topic');
    // Resuming: in case the program refuses, the adapter also gets the
    // conversation from the start, the agent's own earlier reply included.
    expect(turns[1]!.input.freshPrompt).toContain('first topic');
    expect(turns[1]!.input.freshPrompt).toContain('second topic');
    expect(turns[1]!.input.freshPrompt).toContain(
      '<message from="You (earlier)">\nok',
    );
    turns[1]!.finish({
      outputText: 'ok again',
      nativeSessionId: 'n2',
      resumeRejected: true,
    });
    await vi.waitFor(async () => {
      const binding = (await fileFor()).bindings['ag_alice'];
      expect(binding?.nativeSessionId).toBe('n2');
      // The refused resume was answered from the fresh prompt, so the new
      // session already holds the conversation: the cursor advances.
      expect(binding?.readThroughRecordId).toBeDefined();
    });

    await orchestrator.mention(SESSION, {
      text: '@alice third topic',
      clientMessageId: 'm3',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(3));
    // A delta again, resuming the new session.
    expect(turns[2]!.input.prompt).not.toContain('first topic');
    expect(turns[2]!.input.nativeSessionId).toBe('n2');
    expect(turns[2]!.input.freshPrompt).toContain('first topic');
  });

  it('accepts session_send with the binding token for the live run only', async () => {
    const url = (sessionId: string, agentId: string) =>
      `http://127.0.0.1:9/workspaces/w/agent/sessions/${sessionId}/agents/${agentId}/send`;
    const { orchestrator, bridge, turns } = harness({
      extra: { sessionSendUrl: url },
    });
    await orchestrator.mention(SESSION, {
      text: '@alice go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const server = turns[0]!.input.sessionSendServer!;
    expect(server.args).toContain(url(SESSION, 'ag_alice'));
    const token = server.env!['QWEN_SESSION_SEND_TOKEN']!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      orchestrator.postFromAgent(SESSION, 'ag_alice', 'f'.repeat(64), 'hi'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      orchestrator.postFromAgent(SESSION, 'ag_bob', token, 'hi'),
    ).rejects.toMatchObject({ status: 401 });

    await orchestrator.postFromAgent(SESSION, 'ag_alice', token, '@bob help');
    expect(bridge.records[1]).toMatchObject({
      subtype: 'agent_mention',
      systemPayload: {
        displayText: '@bob help',
        mentionedAgentIds: ['ag_bob'],
        author: { agentId: 'ag_alice' },
      },
    });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]!.context.agentId).toBe('ag_bob');

    turns[0]!.finish({ outputText: 'done' });
    await vi.waitFor(async () =>
      expect(
        (await orchestrator.liveRuns()).some(
          (run) => run.agentId === 'ag_alice',
        ),
      ).toBe(false),
    );
    await expect(
      orchestrator.postFromAgent(SESSION, 'ag_alice', token, 'late'),
    ).rejects.toMatchObject({ status: 409, code: 'run_not_running' });
  });

  it('rotates a qwen binding token only when its session is (re)created', async () => {
    const qwenAgent: WorkspaceAgent = {
      id: 'ag_q',
      name: 'quinn',
      createdAt: 1,
    };
    const { orchestrator, turns } = harness({
      roster: [qwenAgent],
      extra: {
        sessionSendUrl: () => 'http://127.0.0.1:9/send',
      },
    });
    await orchestrator.mention(SESSION, {
      text: '@quinn go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const { context, input } = turns[0]!;
    expect(turns[0]!.program).toBe('qwen');
    // The hidden session's server comes from the binding, not the turn.
    expect(input.sessionSendServer).toBeUndefined();
    const binding = context.sessionSend!;
    expect(binding.isCurrent()).toBe(false);
    const first = binding.rotate()!.env!['QWEN_SESSION_SEND_TOKEN']!;
    expect(binding.isCurrent()).toBe(true);
    await orchestrator.postFromAgent(SESSION, 'ag_q', first, 'note');
    const second = binding.rotate()!.env!['QWEN_SESSION_SEND_TOKEN']!;
    expect(second).not.toBe(first);
    await expect(
      orchestrator.postFromAgent(SESSION, 'ag_q', first, 'stale'),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('SessionAgentOrchestrator record bounds and token budget', () => {
  it('refuses an over-long session_send post before recording it', async () => {
    const { orchestrator, bridge, turns, frames } = harness();
    const result = await orchestrator.mention(SESSION, {
      text: '@alice go',
      clientMessageId: 'm1',
    });
    const runId = result.runs[0]!.runId;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    // What a Host relays for a remote agent arrives as this event.
    turns[0]!.input.onEvent({
      type: 'session_send',
      text: `@bob ${'x'.repeat(MAX_EXTERNAL_RECORD_TEXT_LENGTH)}`,
    });
    await vi.waitFor(() =>
      expect(
        frames.some(
          (frame) =>
            frame.runId === runId &&
            frame.error?.includes('was not posted') === true,
        ),
      ).toBe(true),
    );
    expect(
      bridge.appendExternalRecord.mock.calls.filter(
        ([, request]) => request.kind === 'agent_mention',
      ),
    ).toHaveLength(1); // The person's mention only.
    // A post within the limit still goes through.
    turns[0]!.input.onEvent({ type: 'session_send', text: '@bob help' });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]!.context.agentId).toBe('ag_bob');
    expect(
      bridge.appendExternalRecord.mock.calls.every(
        ([, request]) =>
          request.payload.displayText.length <= MAX_EXTERNAL_RECORD_TEXT_LENGTH,
      ),
    ).toBe(true);
  });

  it('records a reply within the ACP child limits on text and steps', async () => {
    const { orchestrator, bridge, turns, lastFrame, frames } = harness();
    const result = await orchestrator.mention(SESSION, {
      text: '@alice go',
      clientMessageId: 'm1',
    });
    const runId = result.runs[0]!.runId;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const stepCount = MAX_EXTERNAL_RECORD_STEPS + 6;
    for (let index = 0; index < stepCount; index += 1) {
      turns[0]!.input.onEvent({
        type: 'step',
        step: {
          id: `st_${index}`,
          title: index === stepCount - 1 ? 't'.repeat(5_000) : `step ${index}`,
          status: 'completed',
        },
      });
    }
    // The run keeps only its latest steps: the first one is long gone, so
    // a late update to it comes back as the newest.
    turns[0]!.input.onEvent({
      type: 'step',
      step: { id: 'st_0', title: 'step 0', status: 'failed' },
    });
    await vi.waitFor(() =>
      expect(lastFrame(runId)?.steps?.at(-1)?.id).toBe('st_0'),
    );
    // Every frame shows at most the latest 8, newest last, in order.
    const stepFrames = frames.filter(
      (frame) => frame.runId === runId && frame.steps !== undefined,
    );
    expect(stepFrames.length).toBeGreaterThan(0);
    for (const frame of stepFrames) {
      expect(frame.steps!.length).toBeLessThanOrEqual(8);
    }
    expect(lastFrame(runId)!.steps!.map((step) => step.id)).toEqual([
      ...Array.from({ length: 7 }, (_, index) => `st_${stepCount - 7 + index}`),
      'st_0',
    ]);
    turns[0]!.finish({
      // A surrogate pair straddles the cut.
      outputText:
        'y'.repeat(
          MAX_EXTERNAL_RECORD_DISPLAY_TEXT_LENGTH -
            '\n\n[Reply truncated.]'.length -
            1,
        ) + '\u{1F600}'.repeat(20),
    });
    await vi.waitFor(() =>
      expect(lastFrame(runId)).toMatchObject({
        status: 'completed',
        recorded: true,
      }),
    );
    const request = bridge.appendExternalRecord.mock.calls
      .map(([, call]) => call)
      .find((call) => call.kind === 'agent_message')!;
    expect(request.kind).toBe('agent_message');
    if (request.kind !== 'agent_message') return;
    const { displayText, steps } = request.payload;
    expect(displayText.length).toBeLessThanOrEqual(
      MAX_EXTERNAL_RECORD_DISPLAY_TEXT_LENGTH,
    );
    // The half emoji is dropped, not kept as a lone surrogate.
    expect(displayText.endsWith('y\n\n[Reply truncated.]')).toBe(true);
    expect(steps).toHaveLength(MAX_EXTERNAL_RECORD_STEPS);
    // The latest steps are kept, the re-added one last.
    expect(steps![0]!.id).toBe('st_7');
    expect(steps!.at(-1)).toMatchObject({ id: 'st_0', status: 'failed' });
    expect(
      steps!.find((step) => step.id === `st_${stepCount - 1}`)!.title,
    ).toHaveLength(MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH);
    // Written once: the child accepted it.
    expect(
      bridge.records.filter((record) => record.subtype === 'agent_message'),
    ).toHaveLength(1);
  });

  it('records why an agent post reached no one', async () => {
    const dave: WorkspaceAgent = {
      id: 'ag_dave',
      name: 'dave',
      createdAt: 1,
      enabled: false,
      execution: { mode: 'local', provider: 'claude' },
    };
    const { orchestrator, bridge, turns, frames } = harness({
      roster: [alice, bob, dave],
    });
    const result = await orchestrator.mention(SESSION, {
      text: '@alice go',
      clientMessageId: 'm1',
    });
    const runId = result.runs[0]!.runId;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const posts = () =>
      bridge.records.filter(
        (record) =>
          record.subtype === 'agent_mention' &&
          (record.systemPayload as { author?: { agentId?: string } })?.author
            ?.agentId === 'ag_alice',
      );

    // A plain status post names no one: nothing to report.
    turns[0]!.input.onEvent({ type: 'session_send', text: 'Status: halfway.' });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.systemPayload).not.toHaveProperty('error');

    turns[0]!.input.onEvent({
      type: 'session_send',
      text: '@dave please take this over',
    });
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.systemPayload).toMatchObject({
      mentionedAgentIds: [],
      error:
        'This post reached no agent: @dave cannot run (paused or retired).',
    });
    expect(
      frames.some(
        (frame) =>
          frame.runId === runId &&
          frame.error ===
            'This post reached no agent: @dave cannot run (paused or retired).',
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns).toHaveLength(1);
  });

  it('charges turns that report no tokens, so a mention loop ends at the budget', async () => {
    const { orchestrator, bridge, turns } = harness({
      // The chain limit is off (its default); only the budget stops a loop.
      extra: { tokenBudget: () => 2.5 * UNREPORTED_TURN_TOKENS },
    });
    await orchestrator.mention(SESSION, {
      text: '@alice start',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    // No turn reports a token count (a failed stats read, a silent Host).
    turns[0]!.finish({ outputText: '@bob your turn' });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    turns[1]!.finish({ outputText: '@alice your turn' });
    await vi.waitFor(() => expect(turns).toHaveLength(3));
    turns[2]!.finish({ outputText: '@bob again' });

    const messages = () =>
      bridge.records.filter((record) => record.subtype === 'agent_message');
    await vi.waitFor(() => expect(messages()).toHaveLength(3));
    expect(messages()[2]!.systemPayload).toMatchObject({
      status: 'completed',
      error: expect.stringContaining('Agent token budget'),
    });
    expect(messages()[2]!.systemPayload).not.toHaveProperty('totalTokens');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns).toHaveLength(3);
    await vi.waitFor(async () => {
      const file = await fileFor();
      expect(file.chainTokens).toBe(3 * UNREPORTED_TURN_TOKENS);
      expect(file.runs.every((run) => run.totalTokens === undefined)).toBe(
        true,
      );
    });
  });
});

describe('SessionAgentOrchestrator squads', () => {
  const lead: WorkspaceAgent = {
    id: 'ag_lead',
    name: 'lead',
    createdAt: 1,
    execution: { mode: 'local', provider: 'claude' },
  };
  const squad: SessionSquad = {
    id: 'sq_1',
    name: 'crew',
    instructions: 'Keep it short.',
    leaderAgentId: 'ag_lead',
    members: [
      { agentId: 'ag_alice', role: 'writes code' },
      { agentId: 'ag_bob' },
    ],
    createdAt: 1,
    updatedAt: 1,
  };

  function squadHarness(
    options: {
      squads?: SessionSquad[];
      roster?: WorkspaceAgent[];
      extra?: Partial<SessionAgentOrchestratorOptions>;
    } = {},
  ) {
    const squads = options.squads ?? [squad];
    const h = harness({
      roster: options.roster ?? [lead, alice, bob],
      extra: { readSquads: async () => squads, ...options.extra },
    });
    /** The `nth` turn (0-based) run for `agentId`. */
    const turnOf = (agentId: string, nth = 0) =>
      h.turns.filter((turn) => turn.context.agentId === agentId)[nth];
    const messageOf = (agentId: string, nth = 0) =>
      h.bridge.records.filter(
        (record) =>
          record.subtype === 'agent_message' &&
          (record.systemPayload as { author?: { agentId?: string } })?.author
            ?.agentId === agentId,
      )[nth];
    const engagement = async () => (await fileFor()).squads?.['sq_1'];
    return { ...h, turnOf, messageOf, engagement };
  }

  it('runs the leader, wakes it per member reply, and ends on no_action', async () => {
    const h = squadHarness();
    const result = await h.orchestrator.mention(SESSION, {
      text: '@crew fix the login bug',
      clientMessageId: 'm1',
    });
    expect(result.runs).toEqual([
      { runId: expect.any(String), agentId: 'ag_lead', status: 'queued' },
    ]);
    expect(h.bridge.records[0]!.systemPayload).toMatchObject({
      mentionedAgentIds: [],
      mentionedSquadIds: ['sq_1'],
    });
    const leaderRunId = result.runs[0]!.runId;

    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    const briefing = h.turnOf('ag_lead')!.input.prompt;
    expect(briefing).toContain('<squad_briefing squad="crew">');
    expect(briefing).toContain(
      '- @alice (role: writes code; program: Claude Code; runs on: this computer)',
    );
    expect(briefing).toContain('Keep it short.');
    expect(h.lastFrame(leaderRunId)).toMatchObject({
      squadId: 'sq_1',
      squadName: 'crew',
      author: { agentId: 'ag_lead', squadName: 'crew' },
    });
    expect(await h.engagement()).toMatchObject({
      leaderAgentId: 'ag_lead',
      active: true,
    });

    h.turnOf('ag_lead')!.finish({ outputText: '@alice please fix it' });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    // A delegated member's run belongs to the engagement; bob was not asked.
    const aliceRunId = h.frames.find(
      (frame) => frame.author.agentId === 'ag_alice',
    )!.runId;
    await vi.waitFor(async () =>
      expect((await h.engagement())?.outstandingRunIds).toEqual([aliceRunId]),
    );
    expect(h.lastFrame(aliceRunId)).toMatchObject({
      squadId: 'sq_1',
      squadName: 'crew',
    });
    expect(h.lastFrame(aliceRunId)!.author.squadName).toBeUndefined();
    expect(h.messageOf('ag_lead')!.systemPayload).toMatchObject({
      displayText: '@alice please fix it',
      author: { squadName: 'crew' },
    });
    expect(h.turnOf('ag_bob')).toBeUndefined();

    h.turnOf('ag_alice')!.finish({ outputText: 'Fixed in auth.ts.' });
    await vi.waitFor(() => expect(h.turnOf('ag_lead', 1)).toBeDefined());
    const wake = h.turnOf('ag_lead', 1)!.input.prompt;
    expect(wake).toContain('<squad_briefing squad="crew">');
    expect(wake).toContain('Fixed in auth.ts.');
    const aliceRecord = h.messageOf('ag_alice')!;
    // The member's reply names the squad it answered for, without the
    // leader's mark; its last frame still belongs to the engagement.
    const aliceAuthor = (
      aliceRecord.systemPayload as {
        author: { memberSquadName?: string; squadName?: string };
      }
    ).author;
    expect(aliceAuthor.memberSquadName).toBe('crew');
    expect(aliceAuthor.squadName).toBeUndefined();
    expect(h.lastFrame(aliceRunId)).toMatchObject({
      status: 'completed',
      squadId: 'sq_1',
      squadName: 'crew',
    });
    expect(
      (await fileFor()).runs.find(
        (run) => run.agentId === 'ag_lead' && run.id !== leaderRunId,
      ),
    ).toMatchObject({
      squadId: 'sq_1',
      triggerRecordIds: [aliceRecord.uuid],
      chainDepth: 2,
    });

    // Nothing left to do: an empty reply is recorded as no_action.
    h.turnOf('ag_lead', 1)!.finish({ outputText: '   ' });
    await vi.waitFor(() =>
      expect(h.messageOf('ag_lead', 1)?.systemPayload).toMatchObject({
        displayText: '',
        status: 'completed',
        squadOutcome: 'no_action',
        author: { agentId: 'ag_lead', squadName: 'crew' },
      }),
    );
    await vi.waitFor(async () =>
      expect(await h.engagement()).toMatchObject({
        active: false,
        outstandingRunIds: [],
      }),
    );

    // After the engagement, a member's reply no longer wakes the leader.
    await h.orchestrator.mention(SESSION, {
      text: '@alice one more thing',
      clientMessageId: 'm2',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_alice', 1)).toBeDefined());
    h.turnOf('ag_alice', 1)!.finish({ outputText: 'Done.' });
    await vi.waitFor(() => expect(h.messageOf('ag_alice', 1)).toBeDefined());
    expect(
      (
        h.messageOf('ag_alice', 1)!.systemPayload as {
          author: { memberSquadName?: string };
        }
      ).author.memberSquadName,
    ).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.turnOf('ag_lead', 2)).toBeUndefined();
  });

  it('records a leader reply of only invisible characters as no_action', async () => {
    const h = squadHarness();
    const { runs } = await h.orchestrator.mention(SESSION, {
      text: '@crew anything to do?',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    // What real leaders answered with; `trim()` keeps U+200B.
    h.turnOf('ag_lead')!.finish({ outputText: '\u200B' });
    await vi.waitFor(() =>
      expect(h.messageOf('ag_lead')?.systemPayload).toMatchObject({
        displayText: '',
        status: 'completed',
        squadOutcome: 'no_action',
      }),
    );
    expect(h.lastFrame(runs[0]!.runId)).toMatchObject({
      status: 'completed',
      recorded: true,
    });
    await vi.waitFor(async () =>
      expect(await h.engagement()).toMatchObject({ active: false }),
    );
  });

  it('coalesces member replies that land while the leader is busy into one wake', async () => {
    const h = squadHarness();
    await h.orchestrator.mention(SESSION, {
      text: '@crew split this',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    // The leader delegates mid-turn (session_send) and keeps running.
    h.turnOf('ag_lead')!.input.onEvent({
      type: 'session_send',
      text: '@alice front end, @bob back end',
    });
    await vi.waitFor(() => {
      expect(h.turnOf('ag_alice')).toBeDefined();
      expect(h.turnOf('ag_bob')).toBeDefined();
    });
    await vi.waitFor(async () =>
      expect((await h.engagement())?.outstandingRunIds).toHaveLength(2),
    );
    h.turnOf('ag_alice')!.finish({ outputText: 'front done' });
    h.turnOf('ag_bob')!.finish({ outputText: 'back done' });
    await vi.waitFor(async () =>
      expect(
        (await fileFor()).runs.find(
          (run) => run.agentId === 'ag_lead' && run.status === 'queued',
        )?.triggerRecordIds,
      ).toHaveLength(2),
    );

    h.turnOf('ag_lead')!.finish({ outputText: 'Delegated.' });
    await vi.waitFor(() => expect(h.turnOf('ag_lead', 1)).toBeDefined());
    const wake = h.turnOf('ag_lead', 1)!.input.prompt;
    expect(wake).toContain('front done');
    expect(wake).toContain('back done');
    h.turnOf('ag_lead', 1)!.finish({ outputText: 'Both halves are done.' });
    await vi.waitFor(async () =>
      expect((await h.engagement())?.active).toBe(false),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.turnOf('ag_lead', 2)).toBeUndefined();
  });

  it('runs a directly mentioned leader in squad mode while its engagement is active', async () => {
    const h = squadHarness();
    await h.orchestrator.mention(SESSION, {
      text: '@crew go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    h.turnOf('ag_lead')!.finish({ outputText: '@bob take it' });
    await vi.waitFor(() => expect(h.turnOf('ag_bob')).toBeDefined());
    const direct = await h.orchestrator.mention(SESSION, {
      text: '@lead how is it going?',
      clientMessageId: 'm2',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead', 1)).toBeDefined());
    expect(h.turnOf('ag_lead', 1)!.input.prompt).toContain('<squad_briefing');
    expect(h.lastFrame(direct.runs[0]!.runId)).toMatchObject({
      squadId: 'sq_1',
    });
  });

  it('refuses a squad whose leader is unavailable, and records why beside other targets', async () => {
    const paused: WorkspaceAgent = { ...lead, enabled: false };
    const h = squadHarness({ roster: [paused, alice, bob] });
    const refused = await h.orchestrator
      .mention(SESSION, { text: '@crew do it', clientMessageId: 'm1' })
      .then(
        () => undefined,
        (error: unknown) => error as SessionAgentError,
      );
    expect(refused).toBeInstanceOf(SessionAgentError);
    expect(refused).toMatchObject({ status: 400, code: 'squad_unavailable' });
    expect(refused!.message).toContain('@crew');
    expect(h.bridge.records).toHaveLength(0);

    const mixed = await h.orchestrator.mention(SESSION, {
      text: '@crew and @bob do it',
      clientMessageId: 'm2',
    });
    expect(mixed.squadError).toContain('@crew');
    expect(mixed.runs.map((run) => run.agentId)).toEqual(['ag_bob']);
    expect(h.bridge.records[0]!.systemPayload).toMatchObject({
      mentionedAgentIds: ['ag_bob'],
      error: expect.stringContaining('leader is paused'),
    });
    expect((await fileFor()).squads).toBeUndefined();
  });

  it('stops a squad loop at the token budget and ends the engagement', async () => {
    const h = squadHarness({ extra: { tokenBudget: () => 100 } });
    await h.orchestrator.mention(SESSION, {
      text: '@crew go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    h.turnOf('ag_lead')!.finish({
      outputText: '@alice do it',
      totalTokens: 10,
    });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    h.turnOf('ag_alice')!.finish({ outputText: 'done', totalTokens: 200 });
    await vi.waitFor(() =>
      expect(h.messageOf('ag_alice')?.systemPayload).toMatchObject({
        status: 'completed',
        error: expect.stringContaining('Agent token budget'),
      }),
    );
    await vi.waitFor(async () =>
      expect((await h.engagement())?.active).toBe(false),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.turnOf('ag_lead', 1)).toBeUndefined();
  });

  it('ends the engagement when everything is stopped', async () => {
    const h = squadHarness();
    await h.orchestrator.mention(SESSION, {
      text: '@crew go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    h.turnOf('ag_lead')!.finish({ outputText: '@alice go' });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    await h.orchestrator.stopAll(SESSION);
    await vi.waitFor(async () =>
      expect(await h.engagement()).toMatchObject({
        active: false,
        outstandingRunIds: [],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A stopped member does not wake its leader.
    expect(h.turnOf('ag_lead', 1)).toBeUndefined();
  });

  it("routes an agent's @squad to its leader, but not the leader's own", async () => {
    const h = squadHarness();
    await h.orchestrator.mention(SESSION, {
      text: '@bob look at this',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_bob')).toBeDefined());
    h.turnOf('ag_bob')!.finish({ outputText: '@crew can you take this?' });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    expect(h.turnOf('ag_lead')!.input.prompt).toContain(
      '<squad_briefing squad="crew">',
    );
    const bobRecord = h.messageOf('ag_bob')!;
    expect(
      (await fileFor()).runs.find((run) => run.agentId === 'ag_lead'),
    ).toMatchObject({
      squadId: 'sq_1',
      triggerRecordIds: [bobRecord.uuid],
      chainDepth: 1,
    });
    expect(await h.engagement()).toMatchObject({
      active: true,
      startedByRecordId: bobRecord.uuid,
    });

    // The leader naming its own squad does not wake itself.
    h.turnOf('ag_lead')!.finish({ outputText: 'Noted, @crew is on it.' });
    await vi.waitFor(async () =>
      expect((await h.engagement())?.active).toBe(false),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.turnOf('ag_lead', 1)).toBeUndefined();
  });

  it('starts an engagement from a session_send @squad and records it', async () => {
    const h = squadHarness();
    await h.orchestrator.mention(SESSION, {
      text: '@alice go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    h.turnOf('ag_alice')!.input.onEvent({
      type: 'session_send',
      text: '@crew please help',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    expect(h.bridge.records[1]).toMatchObject({
      subtype: 'agent_mention',
      systemPayload: {
        mentionedAgentIds: [],
        mentionedSquadIds: ['sq_1'],
        author: { agentId: 'ag_alice' },
      },
    });
    expect(
      h.frames.find((frame) => frame.author.agentId === 'ag_lead'),
    ).toMatchObject({ squadId: 'sq_1' });
  });

  it("does not wake the leader for a member's @squad it is not waiting on", async () => {
    const h = squadHarness();
    await h.orchestrator.mention(SESSION, {
      text: '@crew go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    h.turnOf('ag_lead')!.finish({ outputText: '@bob take it' });
    await vi.waitFor(() => expect(h.turnOf('ag_bob')).toBeDefined());
    // A person asks a member directly; its "@crew" is not a new engagement.
    await h.orchestrator.mention(SESSION, {
      text: '@alice what do you think?',
      clientMessageId: 'm2',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    h.turnOf('ag_alice')!.finish({ outputText: '@crew looks fine to me' });
    await vi.waitFor(() => expect(h.messageOf('ag_alice')).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.turnOf('ag_lead', 1)).toBeUndefined();
    expect(await h.engagement()).toMatchObject({ active: true });
  });

  it("refuses an agent's @squad past the token budget", async () => {
    const h = squadHarness({ extra: { tokenBudget: () => 100 } });
    await h.orchestrator.mention(SESSION, {
      text: '@alice go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    h.turnOf('ag_alice')!.finish({
      outputText: '@crew take over',
      totalTokens: 200,
    });
    await vi.waitFor(() =>
      expect(h.messageOf('ag_alice')?.systemPayload).toMatchObject({
        error: expect.stringMatching(/Agent token budget.*@crew/),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.turnOf('ag_lead')).toBeUndefined();
    expect((await fileFor()).squads).toBeUndefined();
  });

  it('wakes the leader once a member reply whose write failed is recorded', async () => {
    const h = squadHarness();
    await h.orchestrator.mention(SESSION, {
      text: '@crew go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    h.turnOf('ag_lead')!.finish({ outputText: '@alice fix it' });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    h.bridge.appendExternalRecord.mockRejectedValueOnce(new Error('boom'));
    h.turnOf('ag_alice')!.finish({ outputText: 'Fixed in auth.ts.' });

    await vi.waitFor(() => expect(h.turnOf('ag_lead', 1)).toBeDefined());
    expect(h.turnOf('ag_lead', 1)!.input.prompt).toContain('Fixed in auth.ts.');
    const aliceRecord = h.messageOf('ag_alice')!;
    expect(
      (await fileFor()).runs.filter((run) => run.agentId === 'ag_lead')[1],
    ).toMatchObject({
      squadId: 'sq_1',
      triggerRecordIds: [aliceRecord.uuid],
    });
  });

  it('wakes the leader with the error when a member reply is never recorded', async () => {
    let clock = 1_000;
    const h = squadHarness({ extra: { now: () => clock } });
    await h.orchestrator.mention(SESSION, {
      text: '@crew go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    h.turnOf('ag_lead')!.finish({ outputText: '@alice fix it' });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    const write = h.bridge.appendExternalRecord.getMockImplementation()!;
    h.bridge.appendExternalRecord.mockImplementation(
      async (sessionId, request) => {
        if (
          request.kind === 'agent_message' &&
          request.payload.author.agentId === 'ag_alice'
        ) {
          throw new Error('disk full');
        }
        return write(sessionId, request);
      },
    );
    h.turnOf('ag_alice')!.finish({ outputText: 'Fixed in auth.ts.' });
    const aliceRunId = h.frames.find(
      (frame) => frame.author.agentId === 'ag_alice',
    )!.runId;
    await vi.waitFor(() =>
      expect(h.lastFrame(aliceRunId)).toMatchObject({ recorded: false }),
    );
    // Still waiting on the record: the engagement stays open.
    expect((await h.engagement())?.active).toBe(true);

    clock += RECORD_WATCH_MAX_MS;
    await vi.waitFor(() => expect(h.turnOf('ag_lead', 1)).toBeDefined());
    const wake = h.turnOf('ag_lead', 1)!.input.prompt;
    expect(wake).toContain('Fixed in auth.ts.');
    expect(wake).toContain('disk full');
    expect(
      (await fileFor()).runs.filter((run) => run.agentId === 'ag_lead')[1],
    ).toMatchObject({
      squadId: 'sq_1',
      triggerRecordIds: [`pending:unrecorded:${aliceRunId}`],
    });
    expect(h.messageOf('ag_alice')).toBeUndefined();
  });

  /**
   * A member reply whose record write keeps failing, so its leader's wake is
   * pending when the daemon stops. Returns the first daemon (disposed), the
   * member's run id and the reply's record request.
   */
  async function stopWithMemberReplyPending() {
    const first = squadHarness();
    await first.orchestrator.mention(SESSION, {
      text: '@crew go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(first.turnOf('ag_lead')).toBeDefined());
    first.turnOf('ag_lead')!.finish({ outputText: '@alice fix it' });
    await vi.waitFor(() => expect(first.turnOf('ag_alice')).toBeDefined());
    const write = first.bridge.appendExternalRecord.getMockImplementation()!;
    first.bridge.appendExternalRecord.mockImplementation(
      async (sessionId, request) => {
        if (
          request.kind === 'agent_message' &&
          request.payload.author.agentId === 'ag_alice'
        ) {
          throw new Error('disk full');
        }
        return write(sessionId, request);
      },
    );
    first.turnOf('ag_alice')!.finish({ outputText: 'Fixed in auth.ts.' });
    const aliceRunId = first.frames.find(
      (frame) => frame.author.agentId === 'ag_alice',
    )!.runId;
    await vi.waitFor(async () =>
      expect(await first.engagement()).toMatchObject({
        active: true,
        pendingWakeRunIds: [aliceRunId],
      }),
    );
    await first.orchestrator.dispose();
    const reply = first.bridge.appendExternalRecord.mock.calls
      .map(([, request]) => request)
      .find(
        (request) =>
          request.kind === 'agent_message' &&
          request.payload.author.agentId === 'ag_alice',
      )!;
    return { first, aliceRunId, reply };
  }

  it('wakes the leader after a restart once a pending member record is found', async () => {
    const { first, aliceRunId, reply } = await stopWithMemberReplyPending();
    const second = squadHarness();
    // The record turned up in the transcript after all.
    second.bridge.records.push(...first.bridge.records, {
      uuid: 'rec-alice',
      type: 'user',
      subtype: 'agent_message',
      systemPayload: reply.payload,
    });

    await vi.waitFor(() => expect(second.turnOf('ag_lead')).toBeDefined());
    expect(second.turnOf('ag_lead')!.input.prompt).toContain(
      'Fixed in auth.ts.',
    );
    await vi.waitFor(() =>
      expect(second.lastFrame(aliceRunId)).toMatchObject({
        recorded: true,
        recordId: 'rec-alice',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Woken once.
    expect(
      second.turns.filter((turn) => turn.context.agentId === 'ag_lead'),
    ).toHaveLength(1);
    const file = await fileFor();
    const leaderRuns = file.runs.filter((run) => run.agentId === 'ag_lead');
    expect(leaderRuns).toHaveLength(2);
    expect(leaderRuns[1]).toMatchObject({
      squadId: 'sq_1',
      triggerRecordIds: ['rec-alice'],
    });
    expect(file.squads?.['sq_1']).not.toHaveProperty('pendingWakeRunIds');
  });

  it('wakes the leader after a restart with the unrecorded reply when its record never turns up', async () => {
    const { first, aliceRunId } = await stopWithMemberReplyPending();
    let clock = Date.now();
    const second = squadHarness({ extra: { now: () => clock } });
    second.bridge.records.push(...first.bridge.records);
    expect(await second.orchestrator.snapshot(SESSION)).toContainEqual(
      expect.objectContaining({ runId: aliceRunId, retryable: true }),
    );
    // Still looking for the record: the engagement stays open.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.turnOf('ag_lead')).toBeUndefined();
    expect((await second.engagement())?.active).toBe(true);

    clock += RECORD_RECOVERY_WATCH_MAX_MS;
    // The watcher backs off; its next check may be a while.
    await vi.waitFor(() => expect(second.turnOf('ag_lead')).toBeDefined(), {
      timeout: 3_000,
    });
    const wake = second.turnOf('ag_lead')!.input.prompt;
    expect(wake).toContain('not in the conversation record');
    expect(wake).toContain('disk full');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      second.turns.filter((turn) => turn.context.agentId === 'ag_lead'),
    ).toHaveLength(1);
    const file = await fileFor();
    expect(
      file.runs.filter((run) =>
        run.triggerRecordIds.includes(`pending:unrecorded:${aliceRunId}`),
      ),
    ).toMatchObject([{ agentId: 'ag_lead', squadId: 'sq_1' }]);
    expect(file.squads?.['sq_1']).not.toHaveProperty('pendingWakeRunIds');
  });

  it('retries a leader a restart cut short as its squad leader', async () => {
    await updateSessionAgents(projectRoot, SESSION, (file) => {
      file.runs.push({
        id: 'sr_lead',
        agentId: 'ag_lead',
        status: 'running',
        triggerRecordIds: ['rec-x'],
        chainDepth: 1,
        createdAt: 1,
        startedAt: 2,
        attempts: 1,
        squadId: 'sq_1',
      });
      file.squads = {
        sq_1: {
          leaderAgentId: 'ag_lead',
          startedByRecordId: 'rec-x',
          outstandingRunIds: [],
          active: true,
        },
      };
    });
    const h = squadHarness();
    expect(await h.orchestrator.snapshot(SESSION)).toContainEqual(
      expect.objectContaining({ runId: 'sr_lead', retryable: true }),
    );
    // Nothing runs for the squad any more: the restart ended it.
    await vi.waitFor(async () =>
      expect((await h.engagement())?.active).toBe(false),
    );

    const retried = await h.orchestrator.retry(SESSION, 'sr_lead');
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    expect(h.turnOf('ag_lead')!.input.prompt).toContain(
      '<squad_briefing squad="crew">',
    );
    const retriedFrames = h.frames.filter(
      (frame) => frame.runId === retried.runId,
    );
    expect(retriedFrames.length).toBeGreaterThan(0);
    for (const frame of retriedFrames) {
      expect(frame).toMatchObject({
        squadId: 'sq_1',
        squadName: 'crew',
        author: { agentId: 'ag_lead', squadName: 'crew' },
      });
    }
    await vi.waitFor(async () => {
      const file = await fileFor();
      expect(file.runs.find((run) => run.id === retried.runId)).toMatchObject({
        squadId: 'sq_1',
        retryOf: 'sr_lead',
        chainDepth: 1,
      });
      expect(file.squads?.['sq_1']).toMatchObject({
        leaderAgentId: 'ag_lead',
        active: true,
      });
    });

    // It leads again: its delegation is tracked and the reply wakes it.
    h.turnOf('ag_lead')!.finish({ outputText: '@alice fix it' });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    h.turnOf('ag_alice')!.finish({ outputText: 'Fixed in auth.ts.' });
    await vi.waitFor(() => expect(h.turnOf('ag_lead', 1)).toBeDefined());
    expect(h.turnOf('ag_lead', 1)!.input.prompt).toContain('Fixed in auth.ts.');
  });

  it('moves the wake a failed member reply owed to its retry', async () => {
    const h = squadHarness();
    await h.orchestrator.mention(SESSION, {
      text: '@crew go',
      clientMessageId: 'm1',
    });
    await vi.waitFor(() => expect(h.turnOf('ag_lead')).toBeDefined());
    h.turnOf('ag_lead')!.finish({ outputText: '@alice fix it' });
    await vi.waitFor(() => expect(h.turnOf('ag_alice')).toBeDefined());
    const aliceRunId = h.frames.find(
      (frame) => frame.author.agentId === 'ag_alice',
    )!.runId;
    // The failed run's own record never lands.
    const write = h.bridge.appendExternalRecord.getMockImplementation()!;
    h.bridge.appendExternalRecord.mockImplementation(
      async (sessionId, request) => {
        if (
          request.kind === 'agent_message' &&
          request.payload.runId === aliceRunId
        ) {
          throw new Error('disk full');
        }
        return write(sessionId, request);
      },
    );
    h.turnOf('ag_alice')!.finish({
      status: 'failed',
      outputText: 'half done',
      error: 'tool crashed',
    });
    await vi.waitFor(async () =>
      expect(await h.engagement()).toMatchObject({
        active: true,
        pendingWakeRunIds: [aliceRunId],
      }),
    );
    expect(h.turnOf('ag_lead', 1)).toBeUndefined();

    const retried = await h.orchestrator.retry(SESSION, aliceRunId);
    expect(h.lastFrame(aliceRunId)).toMatchObject({
      retriedAsRunId: retried.runId,
    });
    await vi.waitFor(async () => {
      const engagement = await h.engagement();
      expect(engagement).toMatchObject({
        active: true,
        outstandingRunIds: [retried.runId],
      });
      expect(engagement).not.toHaveProperty('pendingWakeRunIds');
    });
    // The new run belongs to the engagement from the moment it is tracked.
    expect(
      h.frames.some(
        (frame) => frame.runId === retried.runId && frame.squadId === 'sq_1',
      ),
    ).toBe(true);

    await vi.waitFor(() => expect(h.turnOf('ag_alice', 1)).toBeDefined());
    h.turnOf('ag_alice', 1)!.finish({ outputText: 'Fixed in auth.ts.' });
    await vi.waitFor(() => expect(h.turnOf('ag_lead', 1)).toBeDefined());
    expect(h.turnOf('ag_lead', 1)!.input.prompt).toContain('Fixed in auth.ts.');
    const leaderWake = (await fileFor()).runs.filter(
      (run) => run.agentId === 'ag_lead',
    )[1];
    expect(leaderWake).toMatchObject({ squadId: 'sq_1', chainDepth: 2 });
    // Woken once: the failed run's dropped wake does not fire as well.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      h.turns.filter((turn) => turn.context.agentId === 'ag_lead'),
    ).toHaveLength(2);
  });

  it('moves the wake a member reply owed across a restart to its retry', async () => {
    const { first, aliceRunId } = await stopWithMemberReplyPending();
    const second = squadHarness();
    second.bridge.records.push(...first.bridge.records);
    expect(await second.orchestrator.snapshot(SESSION)).toContainEqual(
      expect.objectContaining({ runId: aliceRunId, retryable: true }),
    );

    const retried = await second.orchestrator.retry(SESSION, aliceRunId);
    await vi.waitFor(async () => {
      const engagement = await second.engagement();
      expect(engagement).toMatchObject({
        active: true,
        outstandingRunIds: [retried.runId],
      });
      expect(engagement).not.toHaveProperty('pendingWakeRunIds');
    });
    await vi.waitFor(() => expect(second.turnOf('ag_alice')).toBeDefined());
    second.turnOf('ag_alice')!.finish({ outputText: 'Fixed again.' });
    await vi.waitFor(() => expect(second.turnOf('ag_lead')).toBeDefined());
    expect(second.turnOf('ag_lead')!.input.prompt).toContain('Fixed again.');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      second.turns.filter((turn) => turn.context.agentId === 'ag_lead'),
    ).toHaveLength(1);
  });
});
