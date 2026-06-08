/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentAbandon,
  agentAssertCanStartBackground,
  agentCancel,
  agentComplete,
  agentFail,
  agentFinalizeCancelled,
  agentRegister,
  BACKGROUND_AGENT_CONCURRENCY_ENV,
  DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS,
  MAX_CONCURRENT_BACKGROUND_AGENTS,
  MAX_RETAINED_TERMINAL_AGENTS,
  resolveMaxConcurrentBackgroundAgents,
  setAgentBackgroundCapForTest,
  setAgentNotificationCallback,
  type AgentTask,
} from './agent-task.js';
import { TaskRegistry } from './registry.js';

function makeAgentReg(
  agentId: string,
  overrides: { isBackgrounded?: boolean; status?: 'running' | 'paused' } = {},
) {
  return {
    agentId,
    description: `Agent ${agentId}`,
    isBackgrounded: overrides.isBackgrounded ?? true,
    status: overrides.status ?? ('running' as const),
    startTime: Date.now(),
    abortController: new AbortController(),
    outputFile: `/tmp/${agentId}.jsonl`,
  };
}

describe('background-agent concurrency cap', () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
  });

  afterEach(() => {
    setAgentBackgroundCapForTest(undefined);
  });

  describe('resolveMaxConcurrentBackgroundAgents', () => {
    it('returns the default when the env var is unset', () => {
      expect(resolveMaxConcurrentBackgroundAgents({})).toBe(
        DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS,
      );
    });

    it('returns the parsed env value when valid', () => {
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '3',
        }),
      ).toBe(3);
    });

    it('falls back to the default for non-integer env values', () => {
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '2.5',
        }),
      ).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
    });

    it('falls back to the default for values < 1', () => {
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '0',
        }),
      ).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
    });

    it('treats whitespace-only env values as unset', () => {
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '   ',
        }),
      ).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
    });
  });

  describe('agentAssertCanStartBackground', () => {
    it('does not throw when no background agents are running', () => {
      expect(() => agentAssertCanStartBackground(registry)).not.toThrow();
    });

    it('counts only running backgrounded agents toward the cap', () => {
      setAgentBackgroundCapForTest(2);
      // A foreground agent and a paused agent should NOT count.
      agentRegister(
        registry,
        makeAgentReg('fg-1', { isBackgrounded: false, status: 'running' }),
      );
      agentRegister(
        registry,
        makeAgentReg('paused-1', { isBackgrounded: true, status: 'paused' }),
      );
      // One real running background agent.
      agentRegister(registry, makeAgentReg('bg-1'));

      // Cap is 2; only `bg-1` counts. Asserting should still pass.
      expect(() => agentAssertCanStartBackground(registry)).not.toThrow();
    });

    it('throws once the cap is reached', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(registry, makeAgentReg('bg-1'));

      expect(() => agentAssertCanStartBackground(registry)).toThrow(
        /maximum concurrent background agents \(1\)/,
      );
    });

    it('uses the live module-level cap, not a snapshot at import', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(registry, makeAgentReg('bg-1'));
      expect(() => agentAssertCanStartBackground(registry)).toThrow();

      setAgentBackgroundCapForTest(5);
      expect(() => agentAssertCanStartBackground(registry)).not.toThrow();
    });
  });

  describe('agentRegister cap guard', () => {
    it('rejects a fresh background agent that would exceed the cap', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(registry, makeAgentReg('bg-1'));

      expect(() => agentRegister(registry, makeAgentReg('bg-2'))).toThrow(
        /maximum concurrent background agents/,
      );
      // Failed register must NOT have inserted the entry.
      expect(registry.get('bg-2')).toBeUndefined();
    });

    it('does not count foreground agents toward the cap', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(registry, makeAgentReg('fg-1', { isBackgrounded: false }));

      expect(() => agentRegister(registry, makeAgentReg('bg-1'))).not.toThrow();
    });

    it('skips the cap check when re-registering an already-running entry (resume race)', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(registry, makeAgentReg('bg-1'));

      // Resume re-registers under the same id with status: 'running'. Even
      // though the cap is full, the same entry shouldn't double-count
      // against itself.
      expect(() =>
        agentRegister(registry, makeAgentReg('bg-1', { status: 'running' })),
      ).not.toThrow();
    });

    it('does not check the cap when registering a paused entry', () => {
      setAgentBackgroundCapForTest(0); // 0 is invalid, so falls back to default.
      // Paused entries — used by resume restoration — bypass the cap because
      // they don't hold any of the resources the cap is meant to bound.
      expect(() =>
        agentRegister(registry, makeAgentReg('paused-1', { status: 'paused' })),
      ).not.toThrow();
    });
  });

  describe('module-level cap', () => {
    it('exposes the env-derived value at module load', () => {
      // Whatever process.env says at load time, the constant should be ≥1.
      expect(MAX_CONCURRENT_BACKGROUND_AGENTS).toBeGreaterThanOrEqual(1);
    });

    it('setAgentBackgroundCapForTest(undefined) restores the env-derived default', () => {
      setAgentBackgroundCapForTest(3);
      setAgentBackgroundCapForTest(undefined);
      // Re-resolved from process.env — same value the module captured at load.
      expect(MAX_CONCURRENT_BACKGROUND_AGENTS).toBe(
        resolveMaxConcurrentBackgroundAgents(),
      );
    });
  });
});

describe('agent lifecycle', () => {
  let registry: TaskRegistry;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new TaskRegistry();
    notify = vi.fn();
    setAgentNotificationCallback(notify);
    // The lifecycle paths aren't exercising the concurrency guard; keep the
    // cap generous so registering many short-lived entries never trips it.
    setAgentBackgroundCapForTest(1000);
  });

  afterEach(() => {
    setAgentNotificationCallback(undefined);
    setAgentBackgroundCapForTest(undefined);
    vi.useRealTimers();
  });

  describe('terminal transitions', () => {
    it('agentComplete moves running → completed and emits exactly one notification', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentComplete(registry, 'bg-1', 'done');

      const entry = registry.get('bg-1') as AgentTask;
      expect(entry.status).toBe('completed');
      expect(entry.result).toBe('done');
      expect(entry.notified).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
      const [, modelText, meta] = notify.mock.calls[0];
      expect(modelText).toContain('<status>completed</status>');
      expect(meta.agentId).toBe('bg-1');
    });

    it('agentFail moves running → failed and surfaces the error in the notification', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentFail(registry, 'bg-1', 'boom');

      const entry = registry.get('bg-1') as AgentTask;
      expect(entry.status).toBe('failed');
      expect(entry.error).toBe('boom');
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][1]).toContain('Error: boom');
    });

    it('a second terminal call after a notified completion is a no-op', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentComplete(registry, 'bg-1', 'done');
      // A late fail() racing the same entry must not double-notify or
      // clobber the already-surfaced terminal status.
      agentFail(registry, 'bg-1', 'late failure');

      const entry = registry.get('bg-1') as AgentTask;
      expect(entry.status).toBe('completed');
      expect(entry.error).toBeUndefined();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('ignores terminal calls for unknown ids', () => {
      agentComplete(registry, 'missing', 'x');
      agentFail(registry, 'missing', 'x');
      expect(notify).not.toHaveBeenCalled();
    });

    it('does not emit XML notifications for foreground entries', () => {
      agentRegister(registry, makeAgentReg('fg-1', { isBackgrounded: false }));
      agentComplete(registry, 'fg-1', 'done');

      const entry = registry.get('fg-1') as AgentTask;
      expect(entry.status).toBe('completed');
      expect(entry.notified).toBe(true);
      // Foreground results flow through the parent's tool-result channel.
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('cancellation', () => {
    it('agentCancel aborts the signal and marks cancelled but defers the notification', () => {
      const reg = makeAgentReg('bg-1');
      agentRegister(registry, reg);
      agentCancel(registry, 'bg-1');

      const entry = registry.get('bg-1') as AgentTask;
      expect(entry.status).toBe('cancelled');
      expect(reg.abortController.signal.aborted).toBe(true);
      // The natural handler still owes the terminal notification.
      expect(entry.notified).toBe(false);
      expect(notify).not.toHaveBeenCalled();
    });

    it('cancel then a racing natural complete surfaces the real result via one notification', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentCancel(registry, 'bg-1');
      // The reasoning loop produced a real result before the abort landed.
      agentComplete(registry, 'bg-1', 'final result');

      const entry = registry.get('bg-1') as AgentTask;
      expect(entry.status).toBe('completed');
      expect(entry.result).toBe('final result');
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('agentFinalizeCancelled emits the cancelled notification with the partial result', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentCancel(registry, 'bg-1');
      agentFinalizeCancelled(registry, 'bg-1', 'partial work');

      const entry = registry.get('bg-1') as AgentTask;
      expect(entry.status).toBe('cancelled');
      expect(entry.result).toBe('partial work');
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][1]).toContain('<status>cancelled</status>');
    });

    it('agentCancel with notify:false suppresses the terminal notification entirely', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentCancel(registry, 'bg-1', { notify: false });

      const entry = registry.get('bg-1') as AgentTask;
      expect(entry.status).toBe('cancelled');
      // Marked notified so the grace timer (and abortAll) treat it as done.
      expect(entry.notified).toBe(true);
      // Even after the grace window, nothing is emitted.
      vi.advanceTimersByTime(10_000);
      expect(notify).not.toHaveBeenCalled();
    });

    it('ignores cancel for an already-terminal entry', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentComplete(registry, 'bg-1', 'done');
      notify.mockClear();

      agentCancel(registry, 'bg-1');
      expect(registry.get('bg-1')?.status).toBe('completed');
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('cancel grace timer', () => {
    it('finalizes a stuck cancelled entry after the grace window when no handler fires', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentCancel(registry, 'bg-1');
      expect(notify).not.toHaveBeenCalled();

      // Tool ignored the AbortSignal; the natural handler never settled, so
      // the deferred fallback must guarantee the terminal notification.
      vi.advanceTimersByTime(5000);

      const entry = registry.get('bg-1') as AgentTask;
      expect(entry.status).toBe('cancelled');
      expect(entry.notified).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the natural handler already finalized before it fires', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentCancel(registry, 'bg-1');
      agentFinalizeCancelled(registry, 'bg-1', 'partial');
      expect(notify).toHaveBeenCalledTimes(1);

      // The grace timer still fires, but the entry is already notified.
      vi.advanceTimersByTime(5000);
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe('agentAbandon', () => {
    it('cancels a paused entry without emitting a notification', () => {
      agentRegister(registry, makeAgentReg('paused-1', { status: 'paused' }));
      agentAbandon(registry, 'paused-1');

      const entry = registry.get('paused-1') as AgentTask;
      expect(entry.status).toBe('cancelled');
      expect(entry.notified).toBe(true);
      expect(notify).not.toHaveBeenCalled();
    });

    it('ignores a running entry (only paused entries can be abandoned)', () => {
      agentRegister(registry, makeAgentReg('bg-1'));
      agentAbandon(registry, 'bg-1');
      expect(registry.get('bg-1')?.status).toBe('running');
    });
  });

  describe('terminal retention cap', () => {
    it('evicts the oldest notified terminal entries beyond MAX_RETAINED_TERMINAL_AGENTS', () => {
      const total = MAX_RETAINED_TERMINAL_AGENTS + 5;
      for (let i = 0; i < total; i++) {
        agentRegister(registry, makeAgentReg(`bg-${i}`));
        agentComplete(registry, `bg-${i}`, 'done');
        // Strictly increasing endTime so eviction order is deterministic.
        vi.advanceTimersByTime(1);
      }

      const remaining = registry.getByKind('agent');
      expect(remaining).toHaveLength(MAX_RETAINED_TERMINAL_AGENTS);
      const ids = new Set(remaining.map((e) => e.agentId));
      // The five oldest were evicted; the newest survive.
      expect(ids.has('bg-0')).toBe(false);
      expect(ids.has('bg-4')).toBe(false);
      expect(ids.has(`bg-${total - 1}`)).toBe(true);
    });

    it('never evicts running or not-yet-notified cancelled entries', () => {
      for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENTS; i++) {
        agentRegister(registry, makeAgentReg(`done-${i}`));
        agentComplete(registry, `done-${i}`, 'done');
        vi.advanceTimersByTime(1);
      }

      // A live running agent and a cancelled-but-unnotified agent.
      agentRegister(registry, makeAgentReg('live'));
      agentRegister(registry, makeAgentReg('cancelling'));
      agentCancel(registry, 'cancelling'); // cancelled, notified === false

      // Push the notified-terminal count past the cap to force a prune.
      agentRegister(registry, makeAgentReg('extra'));
      agentComplete(registry, 'extra', 'done');

      expect(registry.get('live')?.status).toBe('running');
      const cancelling = registry.get('cancelling') as AgentTask;
      expect(cancelling).toBeDefined();
      expect(cancelling.status).toBe('cancelled');
      expect(cancelling.notified).toBe(false);
    });
  });
});
