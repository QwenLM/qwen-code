/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  acquireHostedQuestionRuntime,
  questionWaitDefinitionAdmitted,
  waitForHostedQuestion,
} from './hosted-question-wait.js';
import { HostedApprovalWaiters } from './hosted-tool-approval.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';

type PromiseDelay = (
  ms?: number,
  value?: unknown,
  options?: { signal?: AbortSignal; ref?: boolean },
) => Promise<void>;
const timer = vi.hoisted(() => ({
  override: undefined as PromiseDelay | undefined,
}));
// A plain wrapper rather than vi.fn, whose implementation afterEach would
// clear; the deadline case below overrides the timer explicitly.
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: (ms?: number, value?: unknown, options?: never) =>
      timer.override
        ? timer.override(ms, value, options)
        : (actual.setTimeout as PromiseDelay)(ms, value, options),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const original = {
  runtimeSessionId: 'turn',
  bindingId: 'binding',
  generation: '7',
  workspaceGeneration: '3',
  provisionerKind: 'local-process' as const,
};

function fixture() {
  const brokerOptions = {
    baseUrl: 'http://127.0.0.1:1',
    token: 'test',
    mountHandbacks: new Set<() => void>(),
  };
  const broker = new HostedWorkspaceBroker(
    brokerOptions,
    {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    original.runtimeSessionId,
  );
  broker.runtime = {
    bindingId: original.bindingId,
    generation: original.generation,
    workspaceGeneration: original.workspaceGeneration,
  };
  broker.provisionerKind = original.provisionerKind;
  const claim = vi.spyOn(broker, 'mountClaim').mockReturnValue('claim-a');
  const release = vi.spyOn(broker, 'releaseMount').mockResolvedValue();
  const acquire = vi.spyOn(broker, 'acquire').mockImplementation(async () => {
    claim.mockReturnValue('claim-b');
  });
  const action = { state: 'requested' };
  const session = {
    authority: {
      action: () => action,
      writesStopped: false,
    },
  } as unknown as ManagedSession;
  const waiters = new HostedApprovalWaiters();
  const abort = new AbortController();
  const released = vi.fn();
  const wait = (expiresAt = Date.now() + 60000) =>
    waitForHostedQuestion({
      session,
      broker,
      brokerOptions,
      waiters,
      requestId: 'question',
      expiresAt,
      signal: abort.signal,
      released,
    });
  const answer = () => {
    action.state = 'decided';
    waiters.notify('question');
  };
  return {
    broker,
    brokerOptions,
    release,
    acquire,
    claim,
    action,
    wait,
    answer,
    abort,
    released,
  };
}

describe('question wait ownership', () => {
  it('hands back only the current member and waits for the durable answer', async () => {
    const f = fixture();
    const waiting = f.wait();
    await vi.waitFor(() => expect(f.released).toHaveBeenCalledOnce());
    expect(f.release).toHaveBeenCalledWith('claim-a');
    expect(f.action.state).toBe('requested');
    f.answer();
    await waiting;
    await acquireHostedQuestionRuntime(f.broker, original, f.abort.signal);
    expect(f.acquire).toHaveBeenCalledWith({
      runtimeBindingId: 'binding',
      generation: '7',
    });
    expect(f.brokerOptions.mountHandbacks.size).toBe(0);
  });

  it.each([
    new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy'),
    new Error('lost response'),
  ])(
    'keeps the question answerable and retries the same claim: %s',
    async (cause) => {
      const f = fixture();
      f.release.mockRejectedValueOnce(cause);
      const waiting = f.wait();
      await Promise.resolve();
      expect(f.action.state).toBe('requested');
      expect(f.released).not.toHaveBeenCalled();
      await vi.waitFor(
        () => expect(f.release.mock.calls).toEqual([['claim-a'], ['claim-a']]),
        { timeout: 2000 },
      );
      expect(f.released).toHaveBeenCalledOnce();
      f.answer();
      await waiting;
    },
  );

  it('does not let a delayed handback response clear a newer acquisition', async () => {
    const f = fixture();
    let complete!: () => void;
    f.release.mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    const waiting = f.wait();
    f.answer();
    await waiting;
    await acquireHostedQuestionRuntime(f.broker, original, f.abort.signal);
    complete();
    await Promise.resolve();
    expect(f.broker.mountClaim()).toBe('claim-b');
    expect(f.released).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'expire'] as const)(
    'stops busy retries on %s without acquiring',
    async (terminal) => {
      vi.useFakeTimers();
      const f = fixture();
      f.release.mockRejectedValue(
        new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy'),
      );
      const waiting = f.wait(Date.now() + 100);
      if (terminal === 'cancel') f.abort.abort();
      else await vi.advanceTimersByTimeAsync(100);
      await waiting;
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.acquire).not.toHaveBeenCalled();
    },
  );

  it('blocks unproven writers and does not label the member released', async () => {
    const f = fixture();
    const failure = new HostedWorkspaceBrokerRejection(
      409,
      'workspace_writer_unproven',
    );
    f.release.mockRejectedValue(failure);
    await expect(f.wait()).rejects.toBe(failure);
    expect(f.released).not.toHaveBeenCalled();
    expect(f.action.state).toBe('requested');
  });

  it('stops shutdown work with a recoverable pending question', async () => {
    const f = fixture();
    const waiting = f.wait();
    for (const stop of f.brokerOptions.mountHandbacks) stop();
    await expect(waiting).rejects.toThrow('Runtime still owed');
    expect(f.action.state).toBe('requested');
  });

  it('retries only workspace_busy during expected acquisition', async () => {
    const f = fixture();
    f.acquire.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    );
    const acquiring = acquireHostedQuestionRuntime(
      f.broker,
      original,
      f.abort.signal,
    );
    await acquiring;
    expect(f.acquire).toHaveBeenCalledTimes(2);
    const unavailable = new HostedWorkspaceBrokerRejection(
      409,
      'workspace_unavailable',
    );
    f.acquire.mockRejectedValueOnce(unavailable);
    await expect(
      acquireHostedQuestionRuntime(f.broker, original, f.abort.signal),
    ).rejects.toBe(unavailable);
  });

  it.each(['cancel', 'expire'] as const)(
    'stops definite busy acquisition on %s',
    async (terminal) => {
      const f = fixture();
      f.acquire.mockRejectedValue(
        new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
      );
      const acquiring = acquireHostedQuestionRuntime(
        f.broker,
        original,
        f.abort.signal,
        terminal === 'expire' ? Date.now() + 30 : undefined,
      );
      await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce());
      if (terminal === 'cancel') f.abort.abort();
      await expect(acquiring).resolves.toBe(false);
      expect(f.acquire).toHaveBeenCalledOnce();
    },
  );

  it('does not acquire again when a retry timer fires a millisecond early', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    timer.override = async (ms) => {
      // A real timer may fire up to 1 ms before the requested wall-clock
      // delay, so the loop must not re-check the deadline one millisecond
      // short and issue an acquire past it.
      now += Math.max(1, Number(ms) - 1);
    };
    try {
      const f = fixture();
      f.acquire.mockRejectedValue(
        new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
      );
      await expect(
        acquireHostedQuestionRuntime(
          f.broker,
          original,
          f.abort.signal,
          now + 30,
        ),
      ).resolves.toBe(false);
      expect(f.acquire).toHaveBeenCalledOnce();
    } finally {
      timer.override = undefined;
    }
  });

  it('does not acquire an already cancelled question', async () => {
    const f = fixture();
    f.abort.abort();
    await expect(
      acquireHostedQuestionRuntime(f.broker, original, f.abort.signal),
    ).resolves.toBe(false);
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it('preserves an unknown acquire outcome even when cancellation races its response', async () => {
    const f = fixture();
    const failure = new Error('acquire response lost');
    f.acquire.mockImplementation(async () => {
      f.abort.abort();
      throw failure;
    });
    await expect(
      acquireHostedQuestionRuntime(f.broker, original, f.abort.signal),
    ).rejects.toBe(failure);
  });

  it.each([
    'bindingId',
    'generation',
    'workspaceGeneration',
    'provisionerKind',
  ] as const)('refuses changed %s after expected acquire', async (field) => {
    const f = fixture();
    if (field === 'provisionerKind') f.broker.provisionerKind = undefined;
    else f.broker.runtime![field] = 'changed';
    await expect(
      acquireHostedQuestionRuntime(f.broker, original, f.abort.signal),
    ).rejects.toThrow('identity changed');
  });
});

describe('persisted question admission', () => {
  const child = {
    toolProfile: 'hosted-workspace-shell/1',
    publicChildAgentsVersion: 1,
    lineage: {
      depth: 1,
      parentSessionId: 'root',
      rootSessionId: 'root',
      parentChildRunId: 'run',
    },
  };
  it('admits ordinary roots and proven built-in direct public children', () => {
    expect(
      questionWaitDefinitionAdmitted({
        toolProfile: 'hosted-workspace-files/1',
      }),
    ).toBe(true);
    expect(questionWaitDefinitionAdmitted(child)).toBe(true);
  });
  it.each([
    { ...child, publicChildAgentsVersion: 0 },
    { ...child, publicChildExtensionAgent: {} },
    { ...child, foregroundOnly: true },
    { ...child, mcpServers: [] },
    { ...child, hookCatalog: {} },
    { ...child, toolProfile: 'hosted-workspace-read/1' },
    { ...child, lineage: { ...child.lineage, depth: 2 } },
    { ...child, lineage: { ...child.lineage, rootSessionId: 'another' } },
  ])('refuses unsupported persisted definition %j', (definition) => {
    expect(questionWaitDefinitionAdmitted(definition)).toBe(false);
  });
});
