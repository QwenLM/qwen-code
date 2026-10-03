/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  BACKGROUND_AGENT_CONCURRENCY_ENV,
  BackgroundTaskRegistry,
  DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS,
  MAX_CONCURRENT_BACKGROUND_AGENTS,
  MAX_RETAINED_TERMINAL_AGENTS,
  resolveMaxConcurrentBackgroundAgents,
  type AgentTaskRegistration,
  type BackgroundApproval,
  type BackgroundSlotReservation,
  type BackgroundTaskEntry,
  type BackgroundTaskRegistryOptions,
  type ResidentAgentContinuationResult,
  type ResidentBackgroundAgent,
} from './background-tasks.js';
import {
  getCurrentAgentId,
  getRuntimeContentGenerator,
  runWithAgentContext,
  runWithRuntimeContentGenerator,
} from './runtime/agent-context.js';
import * as transcript from './agent-transcript.js';
import {
  AgentEventEmitter,
  AgentEventType,
  type AgentApprovalRequestEvent,
} from './runtime/agent-events.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import {
  promptIdContext,
  todoWorkChainContext,
} from '../utils/promptIdContext.js';
import { runWithInvocationContext } from '../utils/invocation-context.js';

const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

function makeApproval(
  callId: string,
  respond: BackgroundApproval['respond'] = vi.fn(async () => {}),
): BackgroundApproval {
  return {
    callId,
    name: 'Shell',
    description: `run ${callId}`,
    confirmationDetails: {
      type: 'exec',
    } as BackgroundApproval['confirmationDetails'],
    respond,
    at: Date.now(),
  };
}

function makeRegistration(
  agentId: string,
  overrides: Partial<AgentTaskRegistration> = {},
): AgentTaskRegistration {
  return {
    agentId,
    description: agentId,
    status: 'running',
    startTime: Date.now(),
    abortController: new AbortController(),
    isBackgrounded: true,
    outputFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  };
}

function makeWaitingEvent(
  subagentId: string,
  callId: string,
  respond: BackgroundApproval['respond'] = vi.fn(async () => {}),
): AgentApprovalRequestEvent {
  return {
    subagentId,
    round: 1,
    callId,
    name: 'Shell',
    description: `run ${callId}`,
    args: {},
    confirmationDetails: {
      type: 'exec',
    } as BackgroundApproval['confirmationDetails'],
    respond,
    timestamp: Date.now(),
  };
}

function makeResident(
  overrides: Partial<ResidentBackgroundAgent> = {},
): ResidentBackgroundAgent {
  return {
    continue: vi.fn(() => 'continued' as const),
    dispose: vi.fn(),
    ...overrides,
  };
}

// Fresh per test (beforeEach); `capped()` swaps in a capacity-limited one.
let registry: BackgroundTaskRegistry;

beforeEach(() => {
  registry = new BackgroundTaskRegistry();
});

function capped(
  maxConcurrentBackgroundAgents: number,
  byModel?: BackgroundTaskRegistryOptions['maxConcurrentBackgroundAgentsByModel'],
) {
  registry = new BackgroundTaskRegistry(
    byModel
      ? {
          maxConcurrentBackgroundAgents,
          maxConcurrentBackgroundAgentsByModel: byModel,
        }
      : { maxConcurrentBackgroundAgents },
  );
}

function reg(agentId: string, overrides?: Partial<AgentTaskRegistration>) {
  return registry.register(makeRegistration(agentId, overrides));
}

/** Registers a running background agent writing to `/tmp/test.jsonl`. */
function add(
  agentId: string,
  description: string,
  overrides: Partial<AgentTaskRegistration> = {},
) {
  return reg(agentId, {
    description,
    outputFile: '/tmp/test.jsonl',
    ...overrides,
  });
}

function addResident(
  agentId: string,
  overrides?: Partial<AgentTaskRegistration>,
) {
  reg(agentId, overrides);
  const resident = makeResident();
  registry.registerResidentAgent(agentId, resident);
  return resident;
}

function onNotify() {
  const callback = vi.fn();
  registry.setNotificationCallback(callback);
  return callback;
}

/** Installs a notification spy, registers running `test-1`, cancels it. */
function cancelTest1() {
  const callback = onNotify();
  add('test-1', 'test agent');
  registry.cancel('test-1');
  return callback;
}

function completeTest1(
  overrides: Partial<AgentTaskRegistration> = {},
  result = 'done',
) {
  const callback = onNotify();
  add('test-1', 'test agent', overrides);
  registry.complete('test-1', result);
  return callback;
}

/** The model-facing XML of the i-th notification. */
function xml(callback: Mock, i = 0): string {
  return callback.mock.calls[i]![1];
}

function expectRemaining(
  callback: Mock,
  i: number,
  remaining: number,
  allTerminal?: boolean,
) {
  expect(xml(callback, i)).toContain(`<remaining>${remaining}</remaining>`);
  if (allTerminal !== undefined) {
    expect(xml(callback, i)).toContain(
      `<all-terminal>${allTerminal}</all-terminal>`,
    );
  }
}

const SLOT_CANCELLED =
  'Agent launch cancelled while waiting for a background slot.';

function regSlot(
  agentId: string,
  slotReservation: BackgroundSlotReservation,
  overrides?: Partial<AgentTaskRegistration>,
) {
  return registry.register(makeRegistration(agentId, overrides), {
    slotReservation,
  });
}

function waitSlot(model?: string, ownerId?: string | null) {
  return registry.waitForBackgroundSlot(
    new AbortController().signal,
    model,
    ownerId,
  );
}

function withFakeTimers(fn: () => void) {
  vi.useFakeTimers();
  try {
    fn();
  } finally {
    vi.useRealTimers();
  }
}

describe('notification emission and agent context (#7156)', () => {
  it('omits the internal agent type from the notification card label', () => {
    const callback = onNotify();
    reg('bg-1', {
      description: 'Explore: Check Node.js requirements',
      subagentType: 'Explore',
    });

    registry.complete('bg-1', 'done');

    expect(callback.mock.calls[0]![2]).toMatchObject({
      label: 'Check Node.js requirements',
    });
  });

  it('captures the Todo work-chain owner at registration', () => {
    const entry = todoWorkChainContext.run('work-chain-1', () =>
      reg('bg-owner'),
    );

    expect(entry.todoWorkChainId).toBe('work-chain-1');
  });

  it('retains the launching execution when completion runs in another context', () => {
    const callback = onNotify();
    const entry = promptIdContext.run('fallback-turn', () =>
      runWithInvocationContext(
        { version: 1, sessionId: 'parent-session', promptId: 'launch-turn' },
        () => reg('bg-origin'),
      ),
    );

    promptIdContext.run('later-turn', () =>
      registry.complete(entry.id, 'done'),
    );

    expect(entry.sourceTurnId).toBe('launch-turn');
    expect(callback.mock.calls[0]![2]).toMatchObject({
      sourceTurnId: 'launch-turn',
    });
  });

  it('captures an automatic execution without an RPC invocation context', () => {
    const entry = runWithInvocationContext(undefined, () =>
      promptIdContext.run('automatic-turn', () => reg('bg-automatic')),
    );

    expect(entry.sourceTurnId).toBe('automatic-turn');
  });

  it.each([undefined, 'persisted-origin'])(
    'preserves restored execution metadata %s instead of guessing its owner',
    (sourceTurnId) => {
      const entry = promptIdContext.run('restore-turn', () =>
        registry.register(makeRegistration('bg-restored', { sourceTurnId }), {
          preserveNotificationState: true,
        }),
      );

      expect(entry.sourceTurnId).toBe(sourceTurnId);
    },
  );

  // The terminal transition fires inside the agent's own ALS frame, which
  // every async continuation of the callback inherits (React updates, the
  // drain effect, the next turn). With an agent frame, Config.getModel()
  // resolves to the subagent's model and the main history can overflow its
  // smaller context window.
  it('invokes the notification callback outside the agent ALS frame', async () => {
    const seen: Array<{
      agentId: string | null;
      runtimeView: unknown;
    }> = [];
    registry.setNotificationCallback(() => {
      seen.push({
        agentId: getCurrentAgentId(),
        runtimeView: getRuntimeContentGenerator(),
      });
    });

    reg('bg-1', { description: 'bg agent', outputFile: '/tmp/bg.jsonl' });

    const fakeView = {
      contentGenerator: {} as never,
      contentGeneratorConfig: { model: 'subagent-model' } as never,
    };
    await runWithAgentContext('bg-1', () =>
      runWithRuntimeContentGenerator(fakeView, async () => {
        // Sanity: we ARE inside the subagent frame here.
        expect(getCurrentAgentId()).toBe('bg-1');
        expect(getRuntimeContentGenerator()).toBe(fakeView);
        registry.complete('bg-1', 'done');
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.agentId).toBeNull();
    expect(seen[0]!.runtimeView).toBeUndefined();
  });
});

describe('BackgroundTaskRegistry', () => {
  it('registers and retrieves a background agent', () => {
    const entry = makeRegistration('test-1', {
      description: 'test agent',
      outputFile: '/tmp/test.jsonl',
    });

    registry.register(entry);
    expect(registry.get('test-1')).toBe(entry);
  });

  it('resolves parentName from the registered parent at registration time', () => {
    reg('parent-1', {
      description: 'parent agent',
      subagentType: 'researcher',
      outputFile: '/tmp/parent.jsonl',
    });

    const child = reg('child-1', {
      description: 'child agent',
      isBackgrounded: false,
      outputFile: '/tmp/child.jsonl',
      parentAgentId: 'parent-1',
      depth: 1,
    });

    // Captured eagerly so the orphan annotation survives parent eviction.
    expect(child.parentName).toBe('researcher');

    // Unknown parent (restart-resume of an orphaned nested agent): no throw.
    const orphan = reg('orphan-1', {
      description: 'orphan agent',
      outputFile: '/tmp/orphan.jsonl',
      parentAgentId: 'gone',
      depth: 2,
    });
    expect(orphan.parentName).toBeUndefined();
  });

  it('completes a background agent and sends notification', () => {
    const callback = completeTest1({}, 'The result text');

    const entry = registry.get('test-1')!;
    expect(entry.status).toBe('completed');
    expect(entry.result).toBe('The result text');
    expect(entry.endTime).toBeDefined();
    expect(callback).toHaveBeenCalledOnce();
    const [displayText, modelText] = callback.mock.calls[0] as [string, string];
    // Display text: short summary without the full result
    expect(displayText).toContain('completed');
    expect(displayText).toContain('test agent');
    expect(displayText).not.toContain('The result text');
    // Model text: full details including result for the LLM
    expect(modelText).toContain('The result text');
  });

  it('fails a background agent and sends notification', () => {
    const callback = onNotify();
    add('test-1', 'test agent');

    registry.fail('test-1', 'Something went wrong');

    const entry = registry.get('test-1')!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('Something went wrong');
    expect(callback).toHaveBeenCalledOnce();
    const [displayText] = callback.mock.calls[0] as [string, string];
    expect(displayText).toContain('failed');
  });

  describe('resident background agents', () => {
    const stats = () => ({
      totalTokens: 10,
      outputTokens: 4,
      toolUses: 1,
      durationMs: 20,
    });

    it('continues only completed resident agents and supports guarded unregister', async () => {
      const resident = addResident('resident-1');

      expect(registry.continueResidentAgent('resident-1', 'too early')).toBe(
        'not_completed',
      );

      registry.complete('resident-1', 'first result');
      expect(registry.continueResidentAgent('resident-1', 'keep going')).toBe(
        'continued',
      );
      expect(resident.continue).toHaveBeenCalledWith('keep going');

      const staleHandle = makeResident();
      expect(registry.unregisterResidentAgent('resident-1', staleHandle)).toBe(
        false,
      );
      expect(registry.unregisterResidentAgent('resident-1', resident)).toBe(
        true,
      );
      expect(resident.dispose).not.toHaveBeenCalled();
      expect(
        registry.continueResidentAgent('resident-1', 'after unregister'),
      ).toBe('fallback');
    });

    it('disposes a replaced resident without letting its stale handle remove the replacement', () => {
      const first = addResident('resident-1');
      const second = makeResident();
      registry.registerResidentAgent('resident-1', second);

      expect(first.dispose).toHaveBeenCalledOnce();
      expect(registry.disposeResidentAgent('resident-1', first)).toBe(false);
      expect(second.dispose).not.toHaveBeenCalled();
      expect(registry.disposeResidentAgent('resident-1', second)).toBe(true);
      expect(second.dispose).toHaveBeenCalledOnce();
    });

    it('disposes the resident when a cold task registration replaces its entry', () => {
      const resident = addResident('resident-1');
      registry.complete('resident-1', 'done');
      const completed = registry.get('resident-1')!;

      registry.register({
        ...completed,
        status: 'paused',
        abortController: new AbortController(),
      });

      expect(resident.dispose).toHaveBeenCalledOnce();
    });

    it('restarts a completed entry with clean turn state and normal callbacks', () => {
      const onRegister = vi.fn();
      const onStatusChange = vi.fn();
      registry.setRegisterCallback(onRegister);
      registry.setStatusChangeCallback(onStatusChange);
      reg('resident-1', {
        recentActivities: [
          { name: 'Read', description: 'old activity', at: 1 },
        ],
        pendingMessages: ['already queued'],
      });
      registry.complete('resident-1', 'first result', stats());
      const completed = registry.get('resident-1')!;
      completed.error = 'stale error';
      completed.resumeBlockedReason = 'stale block';
      completed.persistedCancellationStatus = 'cancelled';
      const completedAt = completed.endTime;
      const nextController = new AbortController();

      const restarted = registry.restartCompletedAgent(
        'resident-1',
        nextController,
      );

      expect(restarted).toBe(completed);
      expect(restarted).toMatchObject({
        status: 'running',
        abortController: nextController,
        recentActivities: [],
        pendingApprovals: [],
        pendingMessages: ['already queued'],
        notified: false,
        outputOffset: 0,
      });
      expect(restarted?.startTime).toBeGreaterThan(0);
      expect(restarted?.endTime).toBeUndefined();
      expect(restarted?.result).toBeUndefined();
      expect(restarted?.error).toBeUndefined();
      expect(restarted?.resumeBlockedReason).toBeUndefined();
      expect(restarted?.stats).toBeUndefined();
      expect(restarted?.persistedCancellationStatus).toBeUndefined();
      expect(completedAt).toBeDefined();
      expect(onRegister).toHaveBeenCalledTimes(2);
      expect(onStatusChange).toHaveBeenCalledTimes(3);
    });

    it('leaves a completed entry unchanged when restart capacity is full', () => {
      capped(1);
      reg('resident-1');
      registry.complete('resident-1', 'first result', stats());
      const completed = registry.get('resident-1')!;
      const completedController = completed.abortController;
      const completedAt = completed.endTime;
      reg('busy');

      expect(() =>
        registry.restartCompletedAgent('resident-1', new AbortController()),
      ).toThrow('maximum concurrent background agents (1) reached');
      expect(completed).toMatchObject({
        status: 'completed',
        abortController: completedController,
        result: 'first result',
        endTime: completedAt,
        notified: true,
      });
      expect(completed.stats).toEqual(stats());
    });

    it('keeps a successful runtime resident but disposes failed and cancelled runtimes', () => {
      const completedResident = addResident('completed');
      registry.complete('completed', 'done');
      expect(completedResident.dispose).not.toHaveBeenCalled();

      const failedResident = addResident('failed');
      registry.fail('failed', 'boom');
      expect(failedResident.dispose).toHaveBeenCalledOnce();

      const cancelledResident = addResident('cancelled');
      registry.cancel('cancelled');
      expect(cancelledResident.dispose).toHaveBeenCalledOnce();
      registry.finalizeCancelled('cancelled', 'partial');
      expect(cancelledResident.dispose).toHaveBeenCalledOnce();
    });

    it('removes a cancelled resident before publishing a raced completion', () => {
      const resident = addResident('cancelled-completion');
      let continuation: ResidentAgentContinuationResult | undefined;
      registry.setNotificationCallback(() => {
        continuation = registry.continueResidentAgent(
          'cancelled-completion',
          'do not restart the cancelled runtime',
        );
      });

      registry.cancel('cancelled-completion');
      registry.complete('cancelled-completion', 'finished while cancelling');

      expect(continuation).toBe('fallback');
      expect(resident.continue).not.toHaveBeenCalled();
      expect(resident.dispose).toHaveBeenCalledOnce();
    });

    it('disposes all resident runtimes on abortAll and reset', () => {
      const runningResident = addResident('running');
      const completedResident = addResident('completed', {
        status: 'completed',
      });

      registry.abortAll({ notify: false });

      expect(runningResident.dispose).toHaveBeenCalledOnce();
      expect(completedResident.dispose).toHaveBeenCalledOnce();

      const nextResident = addResident('next');
      registry.complete('next', 'done');

      registry.reset();

      expect(nextResident.dispose).toHaveBeenCalledOnce();
    });
  });

  it('cancels a running background agent without emitting a notification', () => {
    // cancel() only aborts and marks the entry; the natural handler (bgBody)
    // notifies with the real partial/final result via complete()/fail().
    const callback = onNotify();
    const abortController = new AbortController();
    add('test-1', 'test agent', { abortController });

    registry.cancel('test-1');

    expect(registry.get('test-1')!.status).toBe('cancelled');
    expect(abortController.signal.aborted).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('persists explicit cancellations as cancelled sidecar state', () => {
    const patchSpy = vi
      .spyOn(transcript, 'patchAgentMeta')
      .mockImplementation(() => undefined);
    try {
      add('test-1', 'test agent', { metaPath: '/tmp/test-1.meta.json' });

      registry.cancel('test-1');

      expect(patchSpy).toHaveBeenCalledWith(
        '/tmp/test-1.meta.json',
        expect.objectContaining({
          status: 'cancelled',
          lastError: undefined,
        }),
      );
    } finally {
      patchSpy.mockRestore();
    }
  });

  it('emits a fallback cancelled notification after the grace period when the natural handler never runs', () => {
    withFakeTimers(() => {
      const callback = cancelTest1();
      expect(callback).not.toHaveBeenCalled();

      // Pathological case: bgBody never emits; the grace-period fallback
      // clears hasUnfinalizedTasks() so the headless wait loop can exit.
      vi.runAllTimers();

      expect(callback).toHaveBeenCalledOnce();
      expect(xml(callback)).toContain('<status>cancelled</status>');
      expect(registry.hasUnfinalizedTasks()).toBe(false);
    });
  });

  it('skips the fallback notification when the natural handler finalizes first', () => {
    withFakeTimers(() => {
      const callback = cancelTest1();
      // Natural handler wins the race with the partial result.
      registry.finalizeCancelled('test-1', 'partial output');
      expect(callback).toHaveBeenCalledOnce();
      callback.mockClear();

      vi.runAllTimers();

      // Fallback lands on a notified entry and no-ops.
      expect(callback).not.toHaveBeenCalled();
    });
  });

  it('finalizeCancellationIfPending emits a fallback cancelled notification', () => {
    const callback = cancelTest1();
    registry.finalizeCancellationIfPending('test-1');

    expect(callback).toHaveBeenCalledOnce();
    expect(xml(callback)).toContain('<status>cancelled</status>');
  });

  it('complete() after the cancellation has already been notified is a no-op', () => {
    // One notification per task_started (SDK contract): a late complete()
    // after finalizeCancelled notified must not double-fire.
    const callback = cancelTest1();
    registry.finalizeCancelled('test-1', 'partial');
    expect(callback).toHaveBeenCalledOnce();
    callback.mockClear();

    registry.complete('test-1', 'late result');

    expect(callback).not.toHaveBeenCalled();
    // Status stays cancelled — the notified terminal state wins.
    expect(registry.get('test-1')!.status).toBe('cancelled');
    expect(registry.get('test-1')!.result).toBe('partial');
  });

  it('does not cancel a non-running agent', () => {
    const abortController = new AbortController();
    add('test-1', 'test agent', { abortController });

    registry.complete('test-1', 'done');
    registry.cancel('test-1'); // should be a no-op

    expect(registry.get('test-1')!.status).toBe('completed');
    expect(abortController.signal.aborted).toBe(false);
  });

  it('abandons a paused agent without emitting a notification', () => {
    const callback = onNotify();
    add('paused-1', 'paused agent', { status: 'paused' });

    registry.abandon('paused-1');

    expect(registry.get('paused-1')!.status).toBe('cancelled');
    expect(registry.get('paused-1')!.notified).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('abandons a paused agent and rejects parked approvals', () => {
    const respond = vi.fn(async () => {});
    add('paused-approval', 'paused agent');
    registry.addPendingApproval('paused-approval', makeApproval('c1', respond));
    registry.get('paused-approval')!.status = 'paused';

    registry.abandon('paused-approval');

    expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    expect(registry.getPendingApprovals('paused-approval')).toEqual([]);
  });

  it('does not treat paused entries as unfinalized work', () => {
    add('paused-1', 'paused agent', { status: 'paused' });

    expect(registry.hasUnfinalizedTasks()).toBe(false);
  });

  it('lists running agents', () => {
    add('a', 'agent a');
    add('b', 'agent b');

    registry.complete('a', 'done');

    const running = registry.getAll().filter((e) => e.status === 'running');
    expect(running).toHaveLength(1);
    expect(running[0].agentId).toBe('b');
  });

  describe('background concurrency limit', () => {
    const resolveEnv = (raw: string) =>
      resolveMaxConcurrentBackgroundAgents({
        [BACKGROUND_AGENT_CONCURRENCY_ENV]: raw,
      });

    it('resolves the default and env override for the background agent cap', () => {
      expect(resolveMaxConcurrentBackgroundAgents({})).toBe(
        DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS,
      );
      expect(resolveEnv('3')).toBe(3);
      expect(resolveEnv('0')).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
      expect(MAX_CONCURRENT_BACKGROUND_AGENTS).toBeGreaterThanOrEqual(1);
    });

    it('rejects hex / scientific / non-decimal-integer overrides and falls back', () => {
      // Number() treats '0x10' (16), '1e2' (100), '1.0' (1) as integers; the
      // cap honors only plain decimal integers, like the rest of the codebase.
      for (const raw of ['0x10', '1e2', '1.0']) {
        expect(resolveEnv(raw)).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
      }
    });

    it('rejects new running background agents once the cap is reached', () => {
      capped(2);
      expect(registry.getMaxConcurrentBackgroundAgents()).toBe(2);

      reg('bg-1');
      reg('bg-2');

      expect(() => reg('bg-3')).toThrow(
        'Cannot start background agent: maximum concurrent background agents ' +
          '(2) reached. Stop an existing agent first.',
      );
      expect(registry.get('bg-3')).toBeUndefined();
    });

    it('allows replacing the same running background agent at the cap', () => {
      capped(1);
      reg('bg-1');

      expect(() =>
        reg('bg-1', { prompt: 'resumed continuation' }),
      ).not.toThrow();
      expect(registry.get('bg-1')?.prompt).toBe('resumed continuation');
    });

    it('does not count foreground agents toward the background cap', () => {
      capped(1);
      reg('fg-1', { isBackgrounded: false });

      reg('bg-1');
      expect(registry.get('bg-1')?.status).toBe('running');
    });

    it('does not count paused or terminal entries toward the cap', () => {
      capped(1);
      reg('paused-1', { status: 'paused' });

      reg('bg-1');
      expect(() => reg('bg-2')).toThrow(
        'maximum concurrent background agents (1) reached',
      );

      registry.complete('bg-1', 'done');
      reg('bg-2');

      expect(registry.get('paused-1')).toBeDefined();
      expect(registry.get('bg-2')?.status).toBe('running');
    });

    it('does not count idle resident runtimes as claimed slots', () => {
      capped(1);
      for (const agentId of ['resident-1', 'resident-2', 'resident-3']) {
        reg(agentId);
        registry.complete(agentId, 'done');
        registry.registerResidentAgent(agentId, makeResident());
      }

      expect(registry.canStartBackgroundAgent()).toBe(true);
      expect(() => reg('next')).not.toThrow();
    });

    it('queues waiters until a background slot is released', async () => {
      capped(1);
      reg('bg-1');

      const reservationPromise = waitSlot();

      expect(registry.getQueuedCount()).toBe(1);

      registry.complete('bg-1', 'done');
      const reservation = await reservationPromise;

      expect(registry.getQueuedCount()).toBe(0);
      regSlot('bg-2', reservation);
      expect(registry.get('bg-2')?.status).toBe('running');
    });

    it('throws immediately when the slot wait signal is already aborted', async () => {
      capped(1);
      reg('bg-1');
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        registry.waitForBackgroundSlot(abortController.signal),
      ).rejects.toThrow(SLOT_CANCELLED);
      expect(registry.getQueuedCount()).toBe(0);
    });

    it('resolves immediately when a background slot is available', async () => {
      capped(2);
      reg('bg-1');

      const reservation = await waitSlot();

      expect(reservation).toBeDefined();
      expect(registry.getQueuedCount()).toBe(0);
    });

    it('releases a reserved slot and drains the wait queue', async () => {
      capped(1);
      const reservation = registry.tryReserveBackgroundSlot();
      expect(reservation).toBeDefined();

      const waiterPromise = waitSlot();
      expect(registry.getQueuedCount()).toBe(1);

      registry.releaseBackgroundSlot(reservation!);
      const nextReservation = await waiterPromise;

      expect(nextReservation).toBeDefined();
      expect(registry.getQueuedCount()).toBe(0);
    });

    it('keeps a cancelled background agent in its slot until it settles', async () => {
      capped(1);
      reg('bg-1');

      const reservationPromise = waitSlot();
      registry.cancel('bg-1');

      await Promise.resolve();
      expect(registry.getQueuedCount()).toBe(1);

      registry.complete('bg-1', 'cancelled agent settled');
      const reservation = await reservationPromise;
      regSlot('bg-2', reservation);
      expect(registry.get('bg-2')?.status).toBe('running');
    });

    it('drains queued waiters after notify:false cancellation frees a slot', async () => {
      capped(1);
      reg('bg-1');

      const reservationPromise = waitSlot();

      registry.cancel('bg-1', { notify: false });
      const reservation = await reservationPromise;

      expect(registry.getQueuedCount()).toBe(0);
      expect(reservation).toBeDefined();
    });

    it('reserves a drained slot until registration consumes it', async () => {
      capped(1);
      reg('bg-1');

      const first = waitSlot();
      const second = waitSlot();
      let secondResolved = false;
      void second.then(() => {
        secondResolved = true;
      });

      registry.complete('bg-1', 'done');
      const firstReservation = await first;
      await Promise.resolve();

      expect(secondResolved).toBe(false);
      expect(registry.getQueuedCount()).toBe(1);
      expect(() => reg('racer')).toThrow(
        'maximum concurrent background agents (1) reached',
      );

      regSlot('bg-2', firstReservation);
      expect(secondResolved).toBe(false);

      registry.complete('bg-2', 'done');
      const secondReservation = await second;
      regSlot('bg-3', secondReservation);
      expect(registry.get('bg-3')?.status).toBe('running');
    });

    it('removes an aborted waiter from the queue', async () => {
      capped(1);
      reg('bg-1');
      const abortController = new AbortController();

      const reservation = registry.waitForBackgroundSlot(
        abortController.signal,
      );
      abortController.abort();

      await expect(reservation).rejects.toThrow(SLOT_CANCELLED);
      expect(registry.getQueuedCount()).toBe(0);
    });

    it('rejects queued waiters on reset', async () => {
      capped(1);
      reg('bg-1');

      const reservation = waitSlot();
      registry.reset();

      await expect(reservation).rejects.toThrow(SLOT_CANCELLED);
      expect(registry.getQueuedCount()).toBe(0);
    });

    it('reports when reset invalidates a drained slot reservation', async () => {
      capped(1);
      reg('bg-1');

      const reservationPromise = waitSlot();
      registry.complete('bg-1', 'done');
      const reservation = await reservationPromise;

      registry.reset();

      expect(() => regSlot('bg-2', reservation)).toThrow(
        'invalidated by session reset',
      );
    });
  });

  describe('per-model background concurrency limit', () => {
    it('caps a single model while leaving room for others', () => {
      capped(10, { 'weak-model': 1 });

      reg('bg-1', { model: 'weak-model' });

      // The capped model is full...
      expect(() => reg('bg-2', { model: 'weak-model' })).toThrow(
        'Cannot start background agent: maximum concurrent background agents ' +
          'for model "weak-model" (1) reached. Stop an existing agent on that ' +
          'model first.',
      );
      expect(registry.get('bg-2')).toBeUndefined();

      // ...but a different model is unaffected.
      reg('bg-3', { model: 'strong-model' });
      expect(registry.get('bg-3')?.status).toBe('running');
    });

    it('lets a model without a per-model cap use the global limit', () => {
      capped(2, { 'weak-model': 1 });

      reg('bg-1', { model: 'uncapped-model' });
      reg('bg-2', { model: 'uncapped-model' });

      // The global cap still bounds uncapped models.
      expect(() => reg('bg-3', { model: 'uncapped-model' })).toThrow(
        'maximum concurrent background agents (2) reached',
      );
    });

    it('enforces the global cap even when the per-model cap has room', () => {
      capped(1, { 'weak-model': 5 });

      reg('bg-1', { model: 'other-model' });

      expect(() => reg('bg-2', { model: 'weak-model' })).toThrow(
        'maximum concurrent background agents (1) reached',
      );
    });

    it('counts reservations against the per-model cap', () => {
      capped(10, { 'weak-model': 1 });

      const reservation = registry.tryReserveBackgroundSlot('weak-model');
      expect(reservation).toBeDefined();
      expect(reservation?.model).toBe('weak-model');

      // A second same-model reservation is refused while the first is held.
      expect(registry.tryReserveBackgroundSlot('weak-model')).toBeUndefined();
      // A reservation for a different model is still granted.
      expect(registry.tryReserveBackgroundSlot('strong-model')).toBeDefined();

      // Releasing frees the per-model slot.
      registry.releaseBackgroundSlot(reservation!);
      expect(registry.tryReserveBackgroundSlot('weak-model')).toBeDefined();
    });

    it('frees the per-model cap when an agent on that model completes', () => {
      capped(10, { 'weak-model': 1 });

      reg('bg-1', { model: 'weak-model' });
      expect(registry.tryReserveBackgroundSlot('weak-model')).toBeUndefined();

      registry.complete('bg-1', 'done');
      reg('bg-2', { model: 'weak-model' });
      expect(registry.get('bg-2')?.status).toBe('running');
    });

    it('drains a different-model waiter while a capped-model waiter stays queued', async () => {
      capped(2, { 'weak-model': 1 });
      // Fill both the weak-model cap (1) and the global cap (2) so neither
      // waiter below can reserve a slot immediately.
      reg('bg-weak', { model: 'weak-model' });
      reg('bg-other', { model: 'other-model' });

      // Both queue because the global cap is full.
      const weakWaiter = waitSlot('weak-model');
      const strongWaiter = waitSlot('strong-model');
      expect(registry.getQueuedCount()).toBe(2);

      // Freeing one global slot (but NOT the weak-model slot) lets the
      // strong-model waiter through while the weak-model waiter stays queued.
      registry.complete('bg-other', 'done');

      const strongReservation = await strongWaiter;
      expect(strongReservation.model).toBe('strong-model');
      expect(registry.getQueuedCount()).toBe(1);

      // The weak-model waiter is released only once a weak-model slot frees.
      registry.complete('bg-weak', 'done');
      const weakReservation = await weakWaiter;
      expect(weakReservation.model).toBe('weak-model');
      expect(registry.getQueuedCount()).toBe(0);
    });

    it('ignores malformed per-model cap values', () => {
      capped(10, {
        'bad-zero': 0,
        'bad-negative': -3,
        'bad-float': 1.5,
        good: 1,
      } as Record<string, number>);

      // Malformed entries are dropped; those models use the global cap.
      reg('bg-zero', { model: 'bad-zero' });
      reg('bg-negative', { model: 'bad-negative' });
      reg('bg-float', { model: 'bad-float' });
      expect(registry.get('bg-zero')?.status).toBe('running');
      expect(registry.get('bg-negative')?.status).toBe('running');
      expect(registry.get('bg-float')?.status).toBe('running');

      // The one valid entry is still enforced.
      reg('bg-good', { model: 'good' });
      expect(() => reg('bg-good-2', { model: 'good' })).toThrow(
        'for model "good" (1) reached',
      );
    });

    it('accepts a ReadonlyMap for the per-model caps', () => {
      capped(10, new Map([['weak-model', 1]]));

      reg('bg-1', { model: 'weak-model' });
      expect(() => reg('bg-2', { model: 'weak-model' })).toThrow(
        'for model "weak-model" (1) reached',
      );
    });
  });

  it('aborts all running agents and emits fallback notifications', () => {
    const callback = onNotify();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    add('a', 'agent a', { abortController: ac1 });
    add('b', 'agent b', { abortController: ac2 });

    registry.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(registry.get('a')!.status).toBe('cancelled');
    expect(registry.get('b')!.status).toBe('cancelled');
    // abortAll is a shutdown path (no natural handler fires), so
    // finalizeCancellationIfPending notifies once per agent (SDK contract).
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('abortAll({ notify: false }) suppresses terminal notifications from old tasks', () => {
    const callback = onNotify();
    add('a', 'agent a');

    registry.abortAll({ notify: false });

    expect(registry.get('a')!.status).toBe('cancelled');
    expect(registry.hasUnfinalizedTasks()).toBe(false);
    expect(callback).not.toHaveBeenCalled();

    registry.complete('a', 'late result');
    registry.finalizeCancelled('a', 'late partial');

    expect(callback).not.toHaveBeenCalled();
    expect(registry.get('a')!.status).toBe('cancelled');
    expect(registry.get('a')!.result).toBeUndefined();
  });

  it('abortAll({ notify: false }) suppresses pending fallback notifications', () => {
    withFakeTimers(() => {
      const callback = onNotify();
      add('a', 'agent a');

      registry.cancel('a');
      registry.abortAll({ notify: false });
      vi.runAllTimers();

      expect(callback).not.toHaveBeenCalled();
      expect(registry.hasUnfinalizedTasks()).toBe(false);
    });
  });

  it('hasUnfinalizedTasks reports cancelled-but-not-notified entries', () => {
    // Headless runs keep the event loop alive after task_stop until the
    // natural handler's terminal notification, or stream-json/SDK consumers
    // can miss it.
    add('test-1', 'test agent');
    expect(registry.hasUnfinalizedTasks()).toBe(true);

    registry.cancel('test-1');
    expect(registry.get('test-1')!.status).toBe('cancelled');
    expect(registry.hasUnfinalizedTasks()).toBe(true);

    registry.finalizeCancelled('test-1', '');
    expect(registry.hasUnfinalizedTasks()).toBe(false);
  });

  it('hasRunningTasks ignores cancelled-but-not-notified entries (#5949)', () => {
    // /clear and /resume gate on hasRunningTasks, so a just-cancelled task
    // (aborted, only its notification outstanding) must not make the switch
    // silently no-op; hasUnfinalizedTasks still reports it for headless.
    add('test-1', 'test agent');
    expect(registry.hasRunningTasks()).toBe(true);

    registry.cancel('test-1');
    expect(registry.get('test-1')!.status).toBe('cancelled');
    expect(registry.hasRunningTasks()).toBe(false);
    expect(registry.hasUnfinalizedTasks()).toBe(true);

    registry.finalizeCancelled('test-1', '');
    expect(registry.hasRunningTasks()).toBe(false);
  });

  it('hasRunningTasks ignores foreground entries', () => {
    add('fg-1', 'foreground agent', { isBackgrounded: false });
    expect(registry.hasRunningTasks()).toBe(false);
  });

  it('hasUnfinalizedTasks clears once every entry has been notified', () => {
    add('a', 'agent a');
    add('b', 'agent b');

    expect(registry.hasUnfinalizedTasks()).toBe(true);
    registry.complete('a', 'done');
    expect(registry.hasUnfinalizedTasks()).toBe(true);
    registry.fail('b', 'boom');
    expect(registry.hasUnfinalizedTasks()).toBe(false);
  });

  it('complete after cancellation surfaces the real result', () => {
    // If cancel races the natural handler and the loop already has a real
    // result, complete() moves cancelled → completed and notifies with it
    // instead of a bare "cancelled" notification discarding it.
    const callback = cancelTest1();
    registry.complete('test-1', 'real result after cancel race');

    expect(registry.get('test-1')!.status).toBe('completed');
    expect(registry.get('test-1')!.result).toBe(
      'real result after cancel race',
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(xml(callback)).toContain('<status>completed</status>');
    expect(xml(callback)).toContain('real result after cancel race');
  });

  it('fail after cancellation surfaces the real error', () => {
    const callback = cancelTest1();
    registry.fail('test-1', 'real error after cancel race');

    expect(registry.get('test-1')!.status).toBe('failed');
    expect(registry.get('test-1')!.error).toBe('real error after cancel race');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(xml(callback)).toContain('<status>failed</status>');
  });

  it('second terminal call does not double-notify', () => {
    // Late fire-and-forget terminal calls must not duplicate the notification.
    const callback = completeTest1({}, 'first');
    registry.fail('test-1', 'late error');

    expect(callback).toHaveBeenCalledTimes(1);
    expect(registry.get('test-1')!.status).toBe('completed');
  });

  it('does not send notification without callback', () => {
    add('test-1', 'test agent');

    // Should not throw
    registry.complete('test-1', 'done');
    expect(registry.get('test-1')!.status).toBe('completed');
  });

  it('propagates toolUseId through XML and notification meta', () => {
    const callback = completeTest1({ toolUseId: 'call-abc-123' });

    expect(callback).toHaveBeenCalledOnce();
    const [, modelText, meta] = callback.mock.calls[0];
    expect(modelText).toContain('<tool-use-id>call-abc-123</tool-use-id>');
    expect(meta.toolUseId).toBe('call-abc-123');
  });

  it('omits tool-use-id XML tag when toolUseId is absent', () => {
    const callback = completeTest1();

    const [, modelText, meta] = callback.mock.calls[0];
    expect(modelText).not.toContain('<tool-use-id>');
    expect(meta.toolUseId).toBeUndefined();
  });

  it('getAll returns every entry regardless of status', () => {
    add('a', 'agent a');
    add('b', 'agent b');
    add('c', 'agent c');

    registry.complete('a', 'done');
    registry.fail('b', 'boom');

    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.status).sort()).toEqual([
      'completed',
      'failed',
      'running',
    ]);
    // Callers that need only running entries filter getAll() themselves.
    expect(
      registry
        .getAll()
        .filter((e) => e.status === 'running')
        .map((e) => e.agentId),
    ).toEqual(['c']);
  });

  it('statusChange callback fires on register and every state transition', () => {
    const seen: Array<{ id: string; status: string }> = [];
    registry.setStatusChangeCallback((entry) => {
      if (entry) {
        seen.push({ id: entry.agentId, status: entry.status });
      }
    });

    add('a', 'agent a');
    add('b', 'agent b');
    registry.complete('a', 'ok');
    registry.fail('b', 'err');

    expect(seen).toEqual([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'running' },
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'failed' },
    ]);
  });

  it('statusChange callback errors do not break registry operations', () => {
    registry.setStatusChangeCallback(() => {
      throw new Error('listener broke');
    });

    // Should not throw even though the callback does.
    expect(() => add('a', 'agent a')).not.toThrow();
    expect(registry.get('a')?.status).toBe('running');
  });

  it('statusChange callback can be cleared with undefined', () => {
    const cb = vi.fn();
    registry.setStatusChangeCallback(cb);
    registry.setStatusChangeCallback(undefined);

    add('a', 'agent a');

    expect(cb).not.toHaveBeenCalled();
  });

  it('appendActivity builds a rolling buffer capped at 10', () => {
    add('a', 'agent a');

    for (let i = 0; i < 12; i++) {
      registry.appendActivity('a', {
        name: `Tool${i}`,
        description: `call ${i}`,
        at: i,
      });
    }

    const activities = registry.get('a')!.recentActivities ?? [];
    // The two oldest (Tool0, Tool1) roll off; Tool2..Tool11 remain.
    expect(activities.map((a) => a.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Tool${i + 2}`),
    );
  });

  it('appendActivity no-ops after the agent terminates', () => {
    add('a', 'agent a');

    registry.complete('a', 'done');
    registry.appendActivity('a', { name: 'Late', description: 'x', at: 99 });

    expect(registry.get('a')!.recentActivities ?? []).toHaveLength(0);
  });

  it('appendActivity fires activityChange, not statusChange', () => {
    const statusCb = vi.fn();
    const activityCb = vi.fn();
    registry.setStatusChangeCallback(statusCb);
    registry.setActivityChangeCallback(activityCb);

    add('a', 'agent a');
    statusCb.mockClear();
    activityCb.mockClear();

    registry.appendActivity('a', { name: 'T', description: 'd', at: 0 });

    expect(statusCb).not.toHaveBeenCalled();
    expect(activityCb).toHaveBeenCalledOnce();
    expect(activityCb.mock.calls[0][0].agentId).toBe('a');
  });

  it('stores prompt verbatim on the entry', () => {
    add('a', 'agent a', { prompt: 'Run sleep 30 and report done.' });
    expect(registry.get('a')!.prompt).toBe('Run sleep 30 and report done.');
  });

  it('escapes XML metacharacters in interpolated fields', () => {
    const callback = completeTest1(
      { description: 'summarize </result> & </task-notification>' },
      'here is <b>bold</b> & </task-notification>',
    );

    const modelText = xml(callback);
    // Escaping keeps the parent envelope a single task-notification element.
    expect(modelText.match(/<\/task-notification>/g)!.length).toBe(1);
    expect(modelText).toContain('&lt;/result&gt;');
    expect(modelText).toContain('&lt;/task-notification&gt;');
    expect(modelText).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(modelText).toContain('&amp;');
  });

  describe('terminal-entry retention cap', () => {
    /** Registers and completes `done-0..n-1` with increasing startTimes. */
    function fillDone(n: number) {
      for (let i = 0; i < n; i++) {
        reg(`done-${i}`, { startTime: 100 + i * 1000 });
        registry.complete(`done-${i}`, 'done');
      }
    }

    it('retains only a bounded number of fully-finalized terminal entries', () => {
      // One past the cap forces a prune; strictly increasing startTimes give a
      // deterministic eviction order via the startTime tiebreaker (endTimes are
      // Date.now() inside complete).
      for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENTS + 2; i++) {
        reg(`a-${i}`, { startTime: i * 1000 });
        registry.complete(`a-${i}`, 'done');
      }
      expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_AGENTS);
      // The two oldest (`a-0`, `a-1`) get pruned; the newest survives.
      expect(registry.get('a-0')).toBeUndefined();
      expect(registry.get('a-1')).toBeUndefined();
      expect(
        registry.get(`a-${MAX_RETAINED_TERMINAL_AGENTS + 1}`),
      ).toBeDefined();
    });

    it('disposes a resident runtime when its terminal entry is evicted', () => {
      const resident = addResident('resident-oldest', { startTime: 0 });
      registry.complete('resident-oldest', 'done');

      for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENTS; i++) {
        reg(`newer-${i}`, { startTime: 1000 + i });
        registry.complete(`newer-${i}`, 'done');
      }

      expect(registry.get('resident-oldest')).toBeUndefined();
      expect(resident.dispose).toHaveBeenCalledOnce();
    });

    it('never evicts running entries even when terminal entries blow past the cap', () => {
      // A running entry's dialog row is the user's only handle on it;
      // pruning it would silently strand work in progress.
      reg('live', { startTime: 1 });
      fillDone(MAX_RETAINED_TERMINAL_AGENTS + 1);
      // Cap-of-32 terminals + 1 running survivor = 33 entries kept.
      expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_AGENTS + 1);
      expect(registry.get('live')?.status).toBe('running');
      // The oldest terminal entry is the one evicted.
      expect(registry.get('done-0')).toBeUndefined();
    });

    it('never evicts paused entries (recoverable, awaiting resume/abandon)', () => {
      // No public "transition to paused" call exists; Config-init resume
      // restoration writes paused entries directly via register().
      reg('paused-1', {
        description: 'paused',
        status: 'paused',
        startTime: 1,
      });
      // Push terminal entries past the cap to force an eviction choice.
      fillDone(MAX_RETAINED_TERMINAL_AGENTS + 1);
      expect(registry.get('paused-1')?.status).toBe('paused');
    });

    it('never evicts cancelled-but-not-yet-notified entries', () => {
      // cancel() defers the terminal notification to the natural handler /
      // grace timer; pruning would break the SDK contract that every register
      // pairs with exactly one terminal task-notification.
      registry.setNotificationCallback(() => {});
      reg('pending-cancel', { startTime: 1 });
      registry.cancel('pending-cancel');
      // Push terminal entries past the cap.
      fillDone(MAX_RETAINED_TERMINAL_AGENTS + 1);
      // notified=false: still owed a terminal notification, so it survives.
      expect(registry.get('pending-cancel')?.status).toBe('cancelled');
      expect(registry.get('pending-cancel')?.notified).toBeFalsy();
    });

    it('prunes an abandoned (paused → cancelled) entry the same as any other terminal', () => {
      // abandon() is the only path setting notified=true on a paused entry;
      // it must count toward the cap, or mass abandons bypass the bound.
      reg('paused-overflow', {
        description: 'paused',
        status: 'paused',
        startTime: 1,
      });
      registry.abandon('paused-overflow');
      fillDone(MAX_RETAINED_TERMINAL_AGENTS);
      // 1 abandoned + 32 completed = 33 > cap; the abandoned entry
      // (startTime=1, earliest endTime) is the one evicted.
      expect(registry.getAll()).toHaveLength(MAX_RETAINED_TERMINAL_AGENTS);
      expect(registry.get('paused-overflow')).toBeUndefined();
    });
  });

  describe('queueMessage', () => {
    it('queues a message for a running agent', () => {
      add('test-1', 'test agent');

      const result = registry.queueMessage('test-1', 'hello');
      expect(result).toBe(true);
      expect(registry.get('test-1')!.pendingMessages).toEqual(['hello']);
    });

    it('returns false for non-existent agent', () => {
      expect(registry.queueMessage('nope', 'hello')).toBe(false);
    });

    it('returns false for non-running agent', () => {
      add('test-1', 'test agent');
      registry.complete('test-1', 'done');

      expect(registry.queueMessage('test-1', 'hello')).toBe(false);
    });
  });

  describe('drainMessages', () => {
    it('drains all messages and clears the queue', () => {
      add('test-1', 'test agent');

      registry.queueMessage('test-1', 'msg-1');
      registry.queueMessage('test-1', 'msg-2');

      const messages = registry.drainMessages('test-1');
      expect(messages).toEqual(['msg-1', 'msg-2']);
      expect(registry.get('test-1')!.pendingMessages).toEqual([]);
    });

    it('returns empty array when no messages queued', () => {
      add('test-1', 'test agent');

      expect(registry.drainMessages('test-1')).toEqual([]);
    });

    it('returns empty array for non-existent agent', () => {
      expect(registry.drainMessages('nope')).toEqual([]);
    });

    it('rejects new messages after finalization begins and releases waiters on completion', async () => {
      add('test-1', 'test agent');

      expect(registry.beginFinishing('test-1')).toBe(true);
      expect(registry.queueMessage('test-1', 'late correction')).toBe(false);

      const settled = registry.waitForFinishing(
        'test-1',
        new AbortController().signal,
      );
      registry.complete('test-1', 'done');

      await expect(settled).resolves.toBe(true);
      expect(registry.get('test-1')!.pendingMessages).toEqual([]);
    });
  });

  describe('waitForMessages', () => {
    const waitTest1 = () =>
      registry.waitForMessages('test-1', new AbortController().signal);

    it('resolves with queued input when a running agent is notified', async () => {
      add('test-1', 'test agent');

      const waitPromise = waitTest1();

      registry.queueExternalInput('test-1', {
        kind: 'notification',
        text: '<task-notification>event</task-notification>',
      });

      await expect(waitPromise).resolves.toEqual([
        {
          kind: 'notification',
          text: '<task-notification>event</task-notification>',
        },
      ]);
      expect(registry.drainMessages('test-1')).toEqual([]);
    });

    it('refuses messages to running one-shot agents', () => {
      reg('one-shot', {
        description: 'Codex task',
        resumeBlockedReason: 'Start a new task.',
      });
      expect(registry.queueExternalInput('one-shot', 'continue')).toBe(false);
      expect(registry.drainMessages('one-shot')).toEqual([]);
    });

    it('resolves empty when the wait signal is aborted', async () => {
      add('test-1', 'test agent');
      const waitAbort = new AbortController();
      const waitPromise = registry.waitForMessages('test-1', waitAbort.signal);

      waitAbort.abort();

      await expect(waitPromise).resolves.toEqual([]);
    });

    it('resolves empty if the signal aborts immediately after listener registration', async () => {
      add('test-1', 'test agent');
      let aborted = false;
      const signal = {
        get aborted() {
          return aborted;
        },
        addEventListener: vi.fn(() => {
          aborted = true;
        }),
        removeEventListener: vi.fn(),
      } as unknown as AbortSignal;

      await expect(registry.waitForMessages('test-1', signal)).resolves.toEqual(
        [],
      );
      expect(signal.removeEventListener).toHaveBeenCalled();
    });

    it('wakes external input waiters without queueing input', async () => {
      add('test-1', 'test agent');

      const waitPromise = waitTest1();

      registry.wakeExternalInputWaiters('test-1');

      await expect(waitPromise).resolves.toEqual([]);
      expect(registry.drainMessages('test-1')).toEqual([]);
    });
  });

  describe('session switch helpers', () => {
    it('reset clears tracked entries without touching persisted sidecars', () => {
      add('test-1', 'test agent');
      add('test-2', 'paused agent', { status: 'paused' });

      registry.reset();

      expect(registry.getAll()).toEqual([]);
    });
  });

  describe('notification XML', () => {
    it.each([
      ['top-a', 'top-b'],
      ['top-b', 'top-a'],
    ])(
      'reports owner-scoped remaining agents when %s finishes before %s',
      (firstAgentId, secondAgentId) => {
        const callback = onNotify();
        reg('top-a');
        reg('top-b');
        reg('nested', { parentAgentId: 'parent-agent' });
        reg('foreground', { isBackgrounded: false });

        registry.complete(firstAgentId, 'done');
        registry.fail('nested', 'boom');
        registry.fail(secondAgentId, 'boom');

        expect(callback).toHaveBeenCalledTimes(3);
        expectRemaining(callback, 0, 1, false);
        expectRemaining(callback, 1, 0, true);
        expectRemaining(callback, 2, 0, true);
      },
    );

    it('groups explicit null and implicit top-level owners together', () => {
      const callback = onNotify();
      reg('restored', { parentAgentId: null });
      reg('spawned');

      registry.complete('spawned', 'done');

      expect(callback).toHaveBeenCalledOnce();
      expectRemaining(callback, 0, 1, false);
      expect(callback.mock.calls[0]![2]).toMatchObject({
        label: 'spawned',
      });
    });

    function expectReservedLaunch(
      reserveArgs: [string?, (string | null)?],
      remaining: number,
      allTerminal: boolean,
      overrides: Partial<AgentTaskRegistration> = { parentAgentId: 'parent-a' },
    ) {
      capped(2);
      const callback = onNotify();
      reg('completed', overrides);
      const reservation = registry.tryReserveBackgroundSlot(...reserveArgs);

      registry.complete('completed', 'done');

      expect(callback).toHaveBeenCalledOnce();
      expectRemaining(callback, 0, remaining, allTerminal);
      registry.releaseBackgroundSlot(reservation!);
    }

    it('counts a top-level reserved background launch as remaining', () =>
      expectReservedLaunch([undefined, null], 1, false, {}));

    it('counts a top-level queued background launch as remaining', async () => {
      capped(2);
      const callback = onNotify();
      reg('completed');
      const blocker = registry.tryReserveBackgroundSlot();
      const reservationPromise = waitSlot(undefined, null);
      expect(registry.getQueuedCount()).toBe(1);

      registry.complete('completed', 'done');

      expect(callback).toHaveBeenCalledOnce();
      expectRemaining(callback, 0, 1, false);
      const reservation = await reservationPromise;
      registry.releaseBackgroundSlot(reservation);
      registry.releaseBackgroundSlot(blocker!);
    });

    it('counts a same-owner reserved background launch as remaining', () =>
      expectReservedLaunch([undefined, 'parent-a'], 1, false));

    it('does not count another owner reserved background launch', () =>
      expectReservedLaunch([undefined, 'parent-b'], 0, true));

    it('does not count a legacy reservation with no owner', () =>
      expectReservedLaunch([], 0, true));

    it('counts one outstanding launch while it moves from queue to reservation to registration', async () => {
      capped(3);
      const callback = onNotify();
      reg('first', { parentAgentId: 'parent-a' });
      reg('second', { parentAgentId: 'parent-a' });
      const blocker = registry.tryReserveBackgroundSlot(undefined, 'parent-b');
      const reservationPromise = waitSlot(undefined, 'parent-a');
      expect(registry.getQueuedCount()).toBe(1);

      registry.complete('first', 'done');

      expectRemaining(callback, 0, 2);
      const reservation = await reservationPromise;
      expect(registry.getQueuedCount()).toBe(0);

      registry.complete('second', 'done');

      expectRemaining(callback, 1, 1);
      regSlot('child', reservation, { parentAgentId: 'parent-a' });
      reg('third', { parentAgentId: 'parent-a' });

      registry.complete('third', 'done');

      expectRemaining(callback, 2, 1);
      registry.complete('child', 'done');
      registry.releaseBackgroundSlot(blocker!);
    });

    it('stops counting an aborted queued background launch', async () => {
      capped(2);
      const callback = onNotify();
      reg('completed', { parentAgentId: 'parent-a' });
      const blocker = registry.tryReserveBackgroundSlot(undefined, 'parent-b');
      const abortController = new AbortController();
      const reservationPromise = registry.waitForBackgroundSlot(
        abortController.signal,
        undefined,
        'parent-a',
      );

      abortController.abort();
      await expect(reservationPromise).rejects.toThrow(SLOT_CANCELLED);
      registry.complete('completed', 'done');

      expectRemaining(callback, 0, 0);
      registry.releaseBackgroundSlot(blocker!);
    });

    it('stops counting a released reserved background launch', () => {
      capped(2);
      const callback = onNotify();
      reg('completed', { parentAgentId: 'parent-a' });
      const reservation = registry.tryReserveBackgroundSlot(
        undefined,
        'parent-a',
      );

      registry.releaseBackgroundSlot(reservation!);
      registry.complete('completed', 'done');

      expectRemaining(callback, 0, 0);
    });

    it('counts a paused same-owner background agent as remaining', () => {
      const callback = onNotify();
      reg('completed');
      reg('paused', { status: 'paused' });

      registry.complete('completed', 'done');

      expect(callback).toHaveBeenCalledOnce();
      expectRemaining(callback, 0, 1, false);
    });

    it('updates remaining counts for cancellations emitted by abortAll', () => {
      const callback = onNotify();
      reg('cancel-a');
      reg('cancel-b');

      registry.abortAll();

      expect(callback).toHaveBeenCalledTimes(2);
      expectRemaining(callback, 0, 1, false);
      expectRemaining(callback, 1, 0, true);
    });

    it('treats a cancelled agent awaiting notification as terminal', () => {
      const callback = onNotify();
      reg('cancelled');
      reg('completed');

      registry.cancel('cancelled');
      registry.complete('completed', 'done');

      expect(callback).toHaveBeenCalledOnce();
      expectRemaining(callback, 0, 0, true);
    });

    it('includes output-file tag when outputFile is set', () => {
      const callback = completeTest1({ outputFile: '/tmp/agents/test-1.txt' });

      expect(xml(callback)).toContain(
        '<output-file>/tmp/agents/test-1.txt</output-file>',
      );
    });

    it('omits output-file tag when outputFile is empty', () => {
      // outputFile is mandatory, but an agent kind opting out of disk
      // persistence may pass ''; the XML must then omit `<output-file>`
      // rather than point parsers at a nonexistent file.
      const callback = completeTest1({ outputFile: '' });

      expect(xml(callback)).not.toContain('<output-file>');
    });
  });

  describe('foreground flavor', () => {
    const addSync = (agentId: string) =>
      add(agentId, 'sync agent', { isBackgrounded: false });

    it('does not emit a task-notification on complete', () => {
      const callback = onNotify();
      addSync('fg-1');

      registry.complete('fg-1', 'result text');

      // Foreground results go through the parent's tool-result channel; the
      // XML envelope too would feed the parent model the payload twice.
      expect(callback).not.toHaveBeenCalled();
      // The status mutation still happens — internal invariants intact.
      expect(registry.get('fg-1')!.status).toBe('completed');
      expect(registry.get('fg-1')!.notified).toBe(true);
    });

    it('does not emit a task-notification on fail', () => {
      const callback = onNotify();
      addSync('fg-2');

      registry.fail('fg-2', 'oops');

      expect(callback).not.toHaveBeenCalled();
    });

    it('is excluded from hasUnfinalizedTasks()', () => {
      addSync('fg-3');

      // A still-running foreground entry must NOT keep the headless
      // event loop alive — the parent's tool-call await already does that.
      expect(registry.hasUnfinalizedTasks()).toBe(false);
    });

    it('cancel does not schedule the grace timer', () => {
      // The grace-timer fallback is for background entries whose natural
      // handler may not fire; foreground ones unregister in agent.ts finally.
      withFakeTimers(() => {
        const callback = onNotify();
        addSync('fg-4');

        registry.cancel('fg-4');

        // Advance well past the 5s grace window — no notification should fire.
        vi.advanceTimersByTime(60_000);
        expect(callback).not.toHaveBeenCalled();
      });
    });

    it('unregisterForeground removes the entry and emits a status change', () => {
      const onStatusChange = vi.fn();
      registry.setStatusChangeCallback(onStatusChange);
      addSync('fg-5');
      onStatusChange.mockClear();

      registry.unregisterForeground('fg-5');

      expect(registry.get('fg-5')).toBeUndefined();
      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });

    it('unregisterForeground throws if asked to remove a background entry', () => {
      // Background entries must end via complete/fail/finalizeCancelled to
      // keep notification + holdback invariants; a no-op would mask bugs.
      add('bg-1', 'async agent');

      expect(() => registry.unregisterForeground('bg-1')).toThrow(
        /non-foreground entry bg-1/,
      );
      expect(registry.get('bg-1')).toBeDefined();
    });

    it('unregisterForeground is a no-op for unknown agent ids', () => {
      // Idempotent: the foreground finally path runs unconditionally, and a
      // parallel cancel may already have cleared the entry.
      expect(() => registry.unregisterForeground('missing')).not.toThrow();
    });

    it('does not invoke the register callback for foreground entries', () => {
      // Non-interactive maps setRegisterCallback to SDK `task_started`;
      // foreground entries never get a terminal task-notification (the
      // emitNotification flavor gate), so firing it would leak orphaned tasks.
      const onRegister = vi.fn();
      registry.setRegisterCallback(onRegister);

      addSync('fg-no-register-cb');

      expect(onRegister).not.toHaveBeenCalled();

      // Background entries still fire it.
      add('bg-fires-register-cb', 'async agent');
      expect(onRegister).toHaveBeenCalledTimes(1);
      expect(onRegister.mock.calls[0]![0].agentId).toBe('bg-fires-register-cb');
    });

    it('can suppress the register callback for background entries', () => {
      const onRegister = vi.fn();
      registry.setRegisterCallback(onRegister);

      const entry = registry.register(makeRegistration('bg-suppressed'), {
        suppressRegisterCallback: true,
      });

      expect(entry.agentId).toBe('bg-suppressed');
      expect(onRegister).not.toHaveBeenCalled();
    });

    it('unregisterForeground emits status change after removing the entry', () => {
      // The entry leaves the Map before the callback fires, so a getAll()
      // snapshot omits it. Otherwise it lingered in React state as running (the
      // bug that kept "1 local agent" shown after the foreground agent ended).
      addSync('fg-unregister-order');

      let observedFromCallback: BackgroundTaskEntry | undefined;
      let snapshotDuringCallback: BackgroundTaskEntry[] = [];
      registry.setStatusChangeCallback((entry) => {
        if (entry?.agentId === 'fg-unregister-order') {
          observedFromCallback = registry.get(entry.agentId);
          snapshotDuringCallback = registry.getAll();
        }
      });

      registry.unregisterForeground('fg-unregister-order');

      // Deleted before the callback: get() is undefined and getAll() omits it.
      expect(observedFromCallback).toBeUndefined();
      expect(snapshotDuringCallback).toEqual([]);
      expect(registry.get('fg-unregister-order')).toBeUndefined();
    });

    it('background entries fire a task-notification on complete', () => {
      // Counterpart to the foreground "does not emit" cases above:
      // background results travel in the XML envelope.
      const callback = onNotify();
      add('bg-notify-1', 'async agent');

      registry.complete('bg-notify-1', 'done');

      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe('permission bubbling (pending approvals)', () => {
    /** Registers `agentId` and parks approval `c1` answered by `respond`. */
    function park(
      agentId: string,
      respond: BackgroundApproval['respond'] = vi.fn(async () => {}),
    ) {
      reg(agentId);
      registry.addPendingApproval(agentId, makeApproval('c1', respond));
      return respond;
    }

    function proceed(agentId: string, callId = 'c1', subagentId?: string) {
      return registry.resolvePendingApproval(
        agentId,
        callId,
        ToolConfirmationOutcome.ProceedOnce,
        undefined,
        subagentId,
      );
    }

    function bridge(agentId: string, nestedSource?: true) {
      const emitter = new AgentEventEmitter();
      registry.bridgeApprovalEvents(
        agentId,
        emitter,
        nestedSource && { nestedSource },
      );
      return emitter;
    }

    function emitWaiting(
      emitter: AgentEventEmitter,
      subagentId: string,
      callId: string,
      respond?: BackgroundApproval['respond'],
    ) {
      emitter.emit(
        AgentEventType.TOOL_WAITING_APPROVAL,
        makeWaitingEvent(subagentId, callId, respond),
      );
    }

    function emitResult(
      emitter: AgentEventEmitter,
      subagentId: string,
      callId: string,
      success: boolean,
    ) {
      emitter.emit(AgentEventType.TOOL_RESULT, {
        subagentId,
        round: 1,
        callId,
        success,
      } as never);
    }

    /** Two nested runtimes park approvals under the same generated callId. */
    function parkNestedCollision(agentId: string) {
      reg(agentId);
      const nestedA = bridge(agentId, true);
      const nestedB = bridge(agentId, true);
      const respondA = vi.fn(async () => {});
      const respondB = vi.fn(async () => {});
      emitWaiting(nestedA, 'search-agent-aaa111', 'call_qwen_1', respondA);
      emitWaiting(nestedB, 'search-agent-bbb222', 'call_qwen_1', respondB);
      return { nestedA, respondA, respondB };
    }

    /** A nested approval parks FIRST, then the entry's own, same callId. */
    function parkOwnCollision(agentId: string) {
      reg(agentId);
      const nested = bridge(agentId, true);
      const ownEmitter = bridge(agentId);
      const respondNested = vi.fn(async () => {});
      const respondOwn = vi.fn(async () => {});
      emitWaiting(nested, 'search-agent-aaa111', 'call_qwen_1', respondNested);
      emitWaiting(ownEmitter, `${agentId}-runtime`, 'call_qwen_1', respondOwn);
      return { ownEmitter, respondNested, respondOwn };
    }

    function expectOnlyParked(agentId: string, subagentId: string) {
      const remaining = registry.getPendingApprovals(agentId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.subagentId).toBe(subagentId);
    }

    it('parks an approval and surfaces it on the entry', () => {
      const onChange = vi.fn();
      registry.setApprovalChangeCallback(onChange);
      reg('bg-appr-1');

      const parked = registry.addPendingApproval(
        'bg-appr-1',
        makeApproval('c1'),
      );

      expect(parked).toBe('parked');
      expect(registry.getPendingApprovals('bg-appr-1')).toHaveLength(1);
      expect(registry.get('bg-appr-1')?.pendingApprovals?.[0].callId).toBe(
        'c1',
      );
      expect(onChange).toHaveBeenCalledOnce();
    });

    it('refuses to park for an unknown or terminal entry', () => {
      reg('bg-appr-2');
      registry.complete('bg-appr-2', 'done');

      expect(registry.addPendingApproval('bg-appr-2', makeApproval('c1'))).toBe(
        'unavailable',
      );
      expect(registry.addPendingApproval('missing', makeApproval('c1'))).toBe(
        'unavailable',
      );
    });

    it('ignores a duplicate callId', () => {
      park('bg-appr-3');

      expect(registry.addPendingApproval('bg-appr-3', makeApproval('c1'))).toBe(
        'duplicate',
      );
      expect(registry.getPendingApprovals('bg-appr-3')).toHaveLength(1);
    });

    it('resolves a parked approval via its respond callback and removes it', async () => {
      const respond = park('bg-appr-4');

      const resolved = await proceed('bg-appr-4');

      expect(resolved).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        undefined,
      );
      expect(registry.getPendingApprovals('bg-appr-4')).toHaveLength(0);
    });

    it.each([
      ToolConfirmationOutcome.ProceedAlways,
      ToolConfirmationOutcome.ProceedAlwaysProject,
      ToolConfirmationOutcome.ProceedAlwaysUser,
      ToolConfirmationOutcome.ProceedAlwaysServer,
      ToolConfirmationOutcome.ProceedAlwaysTool,
    ])('cancels unoffered persistent approval outcome %s', async (outcome) => {
      const respond = park(`bg-appr-${outcome}`);

      const resolved = await registry.resolvePendingApproval(
        `bg-appr-${outcome}`,
        'c1',
        outcome,
      );

      expect(resolved).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
        undefined,
      );
    });

    it('preserves the explicit plan ProceedAlways outcome', async () => {
      const respond = vi.fn(async () => {});
      reg('bg-plan-always');
      registry.addPendingApproval('bg-plan-always', {
        ...makeApproval('c1', respond),
        confirmationDetails: {
          type: 'plan',
        } as BackgroundApproval['confirmationDetails'],
      });

      await registry.resolvePendingApproval(
        'bg-plan-always',
        'c1',
        ToolConfirmationOutcome.ProceedAlways,
      );

      expect(respond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedAlways,
        undefined,
      );
    });

    it('returns false when resolving a non-parked call', async () => {
      reg('bg-appr-5');
      expect(
        await registry.resolvePendingApproval(
          'bg-appr-5',
          'nope',
          ToolConfirmationOutcome.Cancel,
        ),
      ).toBe(false);
    });

    it('clears a parked approval without responding', () => {
      const respond = park('bg-appr-6');

      registry.clearPendingApproval('bg-appr-6', 'c1');

      expect(registry.getPendingApprovals('bg-appr-6')).toHaveLength(0);
      expect(respond).not.toHaveBeenCalled();
    });

    it.each<[string, string, (agentId: string) => void]>([
      [
        'auto-rejects parked approvals when the agent terminates',
        'bg-appr-7',
        (id) => registry.complete(id, 'done'),
      ],
      [
        'auto-rejects parked approvals when the agent fails',
        'bg-appr-fail',
        (id) => registry.fail(id, 'boom'),
      ],
      [
        'auto-rejects parked approvals on finalizeCancelled',
        'bg-appr-fc',
        (id) => registry.finalizeCancelled(id, 'partial'),
      ],
      [
        'auto-rejects parked approvals on cancel',
        'bg-appr-8',
        (id) => registry.cancel(id, { notify: false }),
      ],
    ])('%s', (_title, agentId, terminate) => {
      const respond = park(agentId);

      terminate(agentId);

      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(registry.getPendingApprovals(agentId)).toHaveLength(0);
    });

    it('rejects parked approvals on reset so a session switch never strands a respond()', () => {
      const respond = park('bg-appr-reset');

      registry.reset();

      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(registry.get('bg-appr-reset')).toBeUndefined();
    });

    it('fails the agent before aborting when a parked approval respond() rejects', async () => {
      const respond = vi.fn(async () => {
        throw new Error('frames torn down');
      });
      const onChange = vi.fn();
      const onStatus = vi.fn();
      const onNotify = vi.fn();
      const abortController = new AbortController();
      const order: string[] = [];
      abortController.signal.addEventListener('abort', () => {
        order.push('abort');
      });
      reg('bg-appr-retry', { abortController });
      registry.addPendingApproval('bg-appr-retry', makeApproval('c1', respond));
      registry.setApprovalChangeCallback(onChange);
      registry.setStatusChangeCallback((entry) => {
        if (entry?.agentId === 'bg-appr-retry') {
          order.push(`status:${entry.status}`);
        }
        onStatus(entry);
      });
      registry.setNotificationCallback(onNotify);

      const ok = await proceed('bg-appr-retry');

      expect(ok).toBe(false);
      expect(registry.getPendingApprovals('bg-appr-retry')).toHaveLength(0);
      expect(registry.get('bg-appr-retry')?.status).toBe('failed');
      expect(registry.get('bg-appr-retry')?.error).toBe(
        'Failed to resolve background approval: c1',
      );
      expect(abortController.signal.aborted).toBe(true);
      expect(order).toEqual(['status:failed', 'abort']);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onStatus).toHaveBeenCalledOnce();
      expect(onNotify).toHaveBeenCalledOnce();
    });

    it('names the nested runtime in the resolve fail reason', async () => {
      // Incident analysis reads this reason when a parked call never resumes;
      // with colliding callIds it must name the runtime, like the error log.
      const respond = vi.fn(async () => {
        throw new Error('frames torn down');
      });
      reg('bg-appr-retry-nested');
      registry.addPendingApproval('bg-appr-retry-nested', {
        ...makeApproval('c1', respond),
        subagentId: 'search-agent-aaa111',
      });

      const ok = await proceed(
        'bg-appr-retry-nested',
        'c1',
        'search-agent-aaa111',
      );

      expect(ok).toBe(false);
      expect(registry.get('bg-appr-retry-nested')?.error).toBe(
        'Failed to resolve background approval: c1 (nested search-agent-aaa111)',
      );
    });

    it('names the nested runtime in the auto-reject error log', async () => {
      // The .catch in rejectPendingApprovals is the only trace of a teardown
      // reject; with colliding callIds only the runtime stamp attributes it.
      const respond = vi.fn(async () => {
        throw new Error('frames torn down');
      });
      reg('bg-appr-autorej-nested');
      registry.addPendingApproval('bg-appr-autorej-nested', {
        ...makeApproval('c1', respond),
        subagentId: 'search-agent-aaa111',
      });

      registry.cancel('bg-appr-autorej-nested', { notify: false });
      // respond rejects asynchronously; let the .catch handler run.
      await Promise.resolve();

      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'bg-appr-autorej-nested/c1 (nested search-agent-aaa111)',
        ),
        expect.any(Error),
      );
    });

    it('stamps subagentId on bridged approvals only for a nestedSource bridge', () => {
      // Nested approvals park on the backgrounded ancestor; the UI must name
      // the actual waiter. OWN approvals stay unstamped: runtime and registry
      // ids use different suffixes, so the bridge caller declares nesting.
      reg('bg-appr-nested');

      emitWaiting(bridge('bg-appr-nested'), 'fork-runtime1', 'own-1');
      emitWaiting(
        bridge('bg-appr-nested', true),
        'review-agent-abc123',
        'nested-1',
      );

      const parked = registry.getPendingApprovals('bg-appr-nested');
      expect(parked).toHaveLength(2);
      expect(parked.find((a) => a.callId === 'own-1')?.subagentId).toBe(
        undefined,
      );
      expect(parked.find((a) => a.callId === 'nested-1')?.subagentId).toBe(
        'review-agent-abc123',
      );
    });

    it('cancel() rejects parked approvals before the abort-driven clear (production ordering)', () => {
      // In production abort() synchronously emits a synthetic TOOL_RESULT
      // for the parked call and the bridge's onResult clears the queue, so
      // cancel() must reject BEFORE aborting or respond(Cancel) never fires.
      // The abort listener below reproduces that chain.
      const abortController = new AbortController();
      reg('bg-appr-cancel', { abortController });
      const emitter = bridge('bg-appr-cancel');

      const respond = vi.fn(async () => {});
      emitWaiting(emitter, 'bg-appr-cancel', 'c1', respond);
      abortController.signal.addEventListener('abort', () => {
        emitResult(emitter, 'bg-appr-cancel', 'c1', false);
      });

      registry.cancel('bg-appr-cancel', { notify: false });

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(registry.getPendingApprovals('bg-appr-cancel')).toHaveLength(0);
    });

    it('bridges emitter approval events into the parked queue and clears on result', () => {
      const emitter = new AgentEventEmitter();
      reg('bg-appr-9');
      const cleanup = registry.bridgeApprovalEvents('bg-appr-9', emitter);

      const respond = vi.fn(async () => {});
      emitWaiting(emitter, 'bg-appr-9', 'c1', respond);
      expect(registry.getPendingApprovals('bg-appr-9')).toHaveLength(1);

      // A same-call tool result clears the stale prompt, no double answer.
      emitResult(emitter, 'bg-appr-9', 'c1', true);
      expect(registry.getPendingApprovals('bg-appr-9')).toHaveLength(0);
      expect(respond).not.toHaveBeenCalled();

      cleanup();
    });

    it('drops a re-emitted waiting event for an already-parked call silently', async () => {
      // Scheduler batch re-notifies make agent-core re-emit
      // TOOL_WAITING_APPROVAL for every still-awaiting call (no dedup), so a
      // sibling's transition re-emits the parked call. Drop it silently:
      // auto-rejecting cancels a call whose prompt is still in the dialog, and
      // the runtime's responded set then no-ops the user's real answer.
      reg('bg-appr-reemit');
      const emitter = bridge('bg-appr-reemit');

      const respond = vi.fn(async () => {});
      emitWaiting(emitter, 'bg-appr-reemit', 'c1', respond);
      expect(registry.getPendingApprovals('bg-appr-reemit')).toHaveLength(1);

      // A batch-mate status transition re-emits the parked call's event.
      emitWaiting(emitter, 'bg-appr-reemit', 'c1', respond);

      expect(respond).not.toHaveBeenCalled();
      expect(registry.getPendingApprovals('bg-appr-reemit')).toHaveLength(1);
      // The drop is logged at debug level so a session where "the approval
      // never appeared" can tell a re-emission drop from a lost event.
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('bg-appr-reemit/c1'),
      );
      // The user's dialog answer still reaches the parked call.
      await proceed('bg-appr-reemit');
      expect(respond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        undefined,
      );
    });

    it('drops a re-emitted waiting event on a nested bridge without double-parking', () => {
      // Dedup must compare the incoming subagentId with the parked one: a
      // nested scheduler re-emits on sibling transitions too, so a stamped
      // event can arrive twice. Deduping on `subagentId === undefined` alone
      // would park a copy, double-listing it and inflating the pending count.
      reg('bg-appr-reemit-nested');
      const nested = bridge('bg-appr-reemit-nested', true);

      const respond = vi.fn(async () => {});
      emitWaiting(nested, 'search-agent-aaa111', 'call_qwen_1', respond);
      emitWaiting(nested, 'search-agent-aaa111', 'call_qwen_1', respond);

      expectOnlyParked('bg-appr-reemit-nested', 'search-agent-aaa111');
      expect(respond).not.toHaveBeenCalled();
      // The park and drop log lines name the nested runtime so a collision
      // on a shared generated callId can be attributed in incident analysis.
      expect(mockDebugLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('nested search-agent-aaa111'),
      );
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('(nested search-agent-aaa111)'),
      );
    });

    it('parks own and nested approvals that share a generated callId as separate prompts', () => {
      // Generated callIds are unique only per conversation (`nextGeneratedId`
      // restarts at `call_qwen_1`), so each nested runtime's first id-less
      // call hits the shared ancestor under the SAME callId. Each must park, or
      // the dropped one has no dialog prompt and its respond() never runs.
      reg('bg-collide');
      const ownEmitter = bridge('bg-collide');
      const nestedA = bridge('bg-collide', true);
      const nestedB = bridge('bg-collide', true);

      // The entry's own bridge stamps no subagentId (undefined).
      emitWaiting(ownEmitter, 'bg-collide-runtime', 'call_qwen_1');
      emitWaiting(nestedA, 'search-agent-aaa111', 'call_qwen_1');
      emitWaiting(nestedB, 'search-agent-bbb222', 'call_qwen_1');

      const parked = registry.getPendingApprovals('bg-collide');
      expect(parked).toHaveLength(3);
      expect(parked.map((a) => a.subagentId)).toEqual([
        undefined,
        'search-agent-aaa111',
        'search-agent-bbb222',
      ]);
    });

    it('resolves only the matching runtime when parked callIds collide', async () => {
      const { respondA, respondB } = parkNestedCollision('bg-collide-resolve');

      const ok = await proceed(
        'bg-collide-resolve',
        'call_qwen_1',
        'search-agent-aaa111',
      );

      expect(ok).toBe(true);
      expect(respondA).toHaveBeenCalledTimes(1);
      expect(respondB).not.toHaveBeenCalled();
      expectOnlyParked('bg-collide-resolve', 'search-agent-bbb222');
    });

    it('resolves the second-parked runtime when parked callIds collide', async () => {
      // Pins the subagentId conjunct in resolvePendingApproval's find: a
      // callId-only find resumes the FIRST runtime and strips the second's
      // prompt without invoking its respond, so that call waits forever.
      const { respondA, respondB } = parkNestedCollision(
        'bg-collide-resolve-2',
      );

      const ok = await proceed(
        'bg-collide-resolve-2',
        'call_qwen_1',
        'search-agent-bbb222',
      );

      expect(ok).toBe(true);
      expect(respondB).toHaveBeenCalledTimes(1);
      expect(respondA).not.toHaveBeenCalled();
      expectOnlyParked('bg-collide-resolve-2', 'search-agent-aaa111');
    });

    it('clears only its own runtime prompt when a TOOL_RESULT collides on callId', () => {
      const { nestedA, respondA, respondB } =
        parkNestedCollision('bg-collide-clear');

      // A's call settled elsewhere; B's same-callId prompt must stay parked.
      emitResult(nestedA, 'search-agent-aaa111', 'call_qwen_1', true);

      expectOnlyParked('bg-collide-clear', 'search-agent-bbb222');
      expect(respondA).not.toHaveBeenCalled();
      expect(respondB).not.toHaveBeenCalled();
    });

    it('resolves the unstamped own approval when a stamped callId collides', async () => {
      // The dialog resolves an OWN approval with no subagentId. With a nested
      // approval parked FIRST under the same callId, a find matching any
      // approval then resumes the nested runtime and strips its prompt, leaving
      // the own call waiting forever (the silent hang this PR fixes).
      const { respondNested, respondOwn } = parkOwnCollision('bg-collide-own');

      const ok = await proceed('bg-collide-own', 'call_qwen_1');

      expect(ok).toBe(true);
      expect(respondOwn).toHaveBeenCalledTimes(1);
      expect(respondNested).not.toHaveBeenCalled();
      expectOnlyParked('bg-collide-own', 'search-agent-aaa111');
    });

    it('clears the unstamped own prompt without dropping a stamped collision', () => {
      const { ownEmitter, respondNested, respondOwn } = parkOwnCollision(
        'bg-collide-clear-own',
      );

      // Own call settled elsewhere; the same-callId nested prompt stays parked.
      emitResult(
        ownEmitter,
        'bg-collide-clear-own-runtime',
        'call_qwen_1',
        true,
      );

      expectOnlyParked('bg-collide-clear-own', 'search-agent-aaa111');
      expect(respondNested).not.toHaveBeenCalled();
      expect(respondOwn).not.toHaveBeenCalled();
    });

    it('auto-rejects a bridged approval that arrives after termination', () => {
      reg('bg-appr-10');
      const emitter = bridge('bg-appr-10');
      registry.complete('bg-appr-10', 'done');

      const respond = vi.fn(async () => {});
      emitWaiting(emitter, 'bg-appr-10', 'late', respond);

      // Couldn't park (entry terminal) → rejected so the agent loop unblocks.
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    });
  });
});
