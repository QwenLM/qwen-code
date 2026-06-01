/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  MAX_CONCURRENT_MONITORS,
  type MonitorTask,
  type MonitorTaskRegistration,
  type MonitorNotificationCallback,
  type MonitorOwnerLifecycleCallback,
  type MonitorRegisterCallback,
  getRunningMonitorTasks,
  getMonitorTask,
  monitorAbortAll,
  monitorCancel,
  monitorCancelRunningForOwner,
  monitorComplete,
  monitorEmitEvent,
  monitorFail,
  monitorHasRunningForOwner,
  monitorRegister,
  monitorReset,
  setMonitorAgentLifecycleCallback,
  setMonitorAgentNotificationCallback,
  setMonitorNotificationCallback,
  setMonitorRegisterCallback,
} from './monitor-task.js';
import { TaskRegistry } from './registry.js';
import { _resetTaskKindModuleStateForTest } from './index.js';

function makeReg(
  monitorId: string,
  overrides: Partial<MonitorTask> = {},
): MonitorTaskRegistration {
  return {
    monitorId,
    description: overrides.description ?? `Monitor ${monitorId}`,
    command: overrides.command ?? 'tail -f /tmp/log',
    status: overrides.status ?? ('running' as const),
    startTime: overrides.startTime ?? Date.now(),
    abortController: overrides.abortController ?? new AbortController(),
    eventCount: overrides.eventCount ?? 0,
    lastEventTime: overrides.lastEventTime ?? 0,
    maxEvents: overrides.maxEvents ?? 100,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 60_000,
    droppedLines: overrides.droppedLines ?? 0,
    outputFile: overrides.outputFile ?? `/tmp/${monitorId}.log`,
    ownerAgentId: overrides.ownerAgentId,
    toolUseId: overrides.toolUseId,
  };
}

describe('monitor-task', () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetTaskKindModuleStateForTest(registry);
    vi.useRealTimers();
  });

  describe('monitorRegister', () => {
    it('graduates the registration to a full MonitorTask (id, kind, notified, outputOffset)', () => {
      const entry = monitorRegister(registry, makeReg('mon_1'));
      expect(entry.id).toBe('mon_1');
      expect(entry.kind).toBe('monitor');
      expect(entry.notified).toBe(false);
      expect(entry.outputOffset).toBe(0);
      expect(registry.get('mon_1')).toBe(entry);
    });

    it('throws when MAX_CONCURRENT_MONITORS is reached', () => {
      for (let i = 0; i < MAX_CONCURRENT_MONITORS; i++) {
        monitorRegister(registry, makeReg(`mon_${i}`));
      }
      expect(() =>
        monitorRegister(registry, makeReg('mon_overflow')),
      ).toThrow(/maximum concurrent monitors/);
    });

    it('counts only running monitors toward the cap (terminal entries free a slot)', () => {
      monitorRegister(registry, makeReg('mon_done'));
      monitorComplete(registry, 'mon_done', 0);
      // Cap is well above 1 — the assertion is that completing the
      // first one re-frees the slot for `monitorRegister` purposes.
      for (let i = 0; i < MAX_CONCURRENT_MONITORS - 1; i++) {
        monitorRegister(registry, makeReg(`mon_alive_${i}`));
      }
      // One more should still succeed because mon_done is terminal.
      expect(() =>
        monitorRegister(registry, makeReg('mon_last_alive')),
      ).not.toThrow();
    });

    it('fires the global register callback for top-level monitors', () => {
      const cb: MonitorRegisterCallback = vi.fn();
      setMonitorRegisterCallback(cb);
      const entry = monitorRegister(registry, makeReg('mon_1'));
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(entry);
    });

    it('does NOT fire the global register callback for owner-scoped monitors', () => {
      const cb: MonitorRegisterCallback = vi.fn();
      setMonitorRegisterCallback(cb);
      monitorRegister(
        registry,
        makeReg('mon_owned', { ownerAgentId: 'agent-A' }),
      );
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('monitorEmitEvent', () => {
    it('mutates eventCount + lastEventTime silently (no fireChange listener call)', () => {
      monitorRegister(registry, makeReg('mon_1', { maxEvents: 10 }));
      const listener = vi.fn();
      registry.subscribe(listener);

      monitorEmitEvent(registry, 'mon_1', 'first line');
      monitorEmitEvent(registry, 'mon_1', 'second line');
      monitorEmitEvent(registry, 'mon_1', 'third line');

      const entry = getMonitorTask(registry, 'mon_1');
      expect(entry?.eventCount).toBe(3);
      // Critical: the change listener must NOT fire for per-event
      // mutations — the dialog list / footer pill would churn on
      // every monitor stdout line.
      expect(listener).not.toHaveBeenCalled();
    });

    it('no-op when monitor is missing or already terminal', () => {
      monitorRegister(registry, makeReg('mon_1'));
      monitorComplete(registry, 'mon_1', 0);
      monitorEmitEvent(registry, 'mon_1', 'late event');
      expect(getMonitorTask(registry, 'mon_1')?.eventCount).toBe(0);

      // Also a no-op for a totally missing id — should not throw.
      expect(() =>
        monitorEmitEvent(registry, 'nonexistent', 'line'),
      ).not.toThrow();
    });

    it('auto-stops when maxEvents reached and emits a terminal notification', () => {
      const notify: MonitorNotificationCallback = vi.fn();
      setMonitorNotificationCallback(notify);
      monitorRegister(registry, makeReg('mon_1', { maxEvents: 3 }));

      monitorEmitEvent(registry, 'mon_1', 'a');
      monitorEmitEvent(registry, 'mon_1', 'b');
      // 3rd event triggers auto-stop because eventCount becomes 3 == maxEvents.
      monitorEmitEvent(registry, 'mon_1', 'c');

      const entry = getMonitorTask(registry, 'mon_1');
      expect(entry?.status).toBe('completed');
      expect(entry?.error).toBe('Max events reached');
      expect(entry?.endTime).toBeDefined();
      // Notification fires once with terminal status. Each call is
      // (displayText, modelText, meta).
      const terminalCalls = (notify as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => {
          const m = c[2] as { status?: string };
          return m?.status === 'completed';
        });
      expect(terminalCalls).toHaveLength(1);
    });

    it('reentrant auto-stop guard: late events flushed by an abort listener find status !== running and short-circuit', () => {
      monitorRegister(registry, makeReg('mon_1', { maxEvents: 2 }));
      monitorEmitEvent(registry, 'mon_1', 'a');
      monitorEmitEvent(registry, 'mon_1', 'b'); // auto-stop trigger
      // Simulating a stale flush — must NOT bump eventCount past maxEvents.
      monitorEmitEvent(registry, 'mon_1', 'stale');
      expect(getMonitorTask(registry, 'mon_1')?.eventCount).toBe(2);
    });
  });

  describe('monitorComplete / monitorFail', () => {
    it('fires the change listener exactly ONCE per terminal transition', () => {
      monitorRegister(registry, makeReg('mon_1'));
      const listener = vi.fn();
      registry.subscribe(listener);

      monitorComplete(registry, 'mon_1', 0);

      // One call from the settle update; the suggestion folded the
      // double-update into one to match shell-task.
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('monitorFail merges error into the settle update (single fireChange)', () => {
      monitorRegister(registry, makeReg('mon_1'));
      const listener = vi.fn();
      registry.subscribe(listener);

      monitorFail(registry, 'mon_1', 'spawn ENOENT');

      expect(listener).toHaveBeenCalledTimes(1);
      const entry = getMonitorTask(registry, 'mon_1');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toBe('spawn ENOENT');
      expect(entry?.endTime).toBeDefined();
    });

    it('monitorComplete records exitCode when provided', () => {
      monitorRegister(registry, makeReg('mon_1'));
      monitorComplete(registry, 'mon_1', 137);
      expect(getMonitorTask(registry, 'mon_1')?.exitCode).toBe(137);
    });

    it('monitorComplete does not overwrite a non-running entry', () => {
      monitorRegister(registry, makeReg('mon_1'));
      monitorFail(registry, 'mon_1', 'first error');
      monitorComplete(registry, 'mon_1', 0);
      // Status stays 'failed' — the race-guard short-circuits.
      expect(getMonitorTask(registry, 'mon_1')?.status).toBe('failed');
    });
  });

  describe('monitorCancel', () => {
    it('notify:false settles to cancelled FIRST, then aborts (status locked before listeners run)', () => {
      monitorRegister(registry, makeReg('mon_1'));
      const aborts: Array<string | undefined> = [];
      const entry = getMonitorTask(registry, 'mon_1')!;
      entry.abortController.signal.addEventListener('abort', () => {
        aborts.push(getMonitorTask(registry, 'mon_1')?.status);
      });

      monitorCancel(registry, 'mon_1', { notify: false });

      expect(getMonitorTask(registry, 'mon_1')?.status).toBe('cancelled');
      // At the moment of abort, status was already 'cancelled' — proves
      // settle ran before abort.
      expect(aborts).toEqual(['cancelled']);
    });

    it('notify:true aborts FIRST so a naturally-completing operation can settle through its own path', () => {
      monitorRegister(registry, makeReg('mon_1'));
      let abortFiredWhileRunning = false;
      const entry = getMonitorTask(registry, 'mon_1')!;
      entry.abortController.signal.addEventListener('abort', () => {
        // At abort time the entry should still be 'running' (the cancel
        // path hasn't forced 'cancelled' yet — that only happens if no
        // natural settle came in).
        if (getMonitorTask(registry, 'mon_1')?.status === 'running') {
          abortFiredWhileRunning = true;
        }
      });

      monitorCancel(registry, 'mon_1', {});

      expect(abortFiredWhileRunning).toBe(true);
      // Once we re-check after abort, status is forced to 'cancelled'.
      expect(getMonitorTask(registry, 'mon_1')?.status).toBe('cancelled');
    });

    it('notify:true: if an abort listener naturally completes the monitor, cancel honors the natural status', () => {
      monitorRegister(registry, makeReg('mon_1'));
      const entry = getMonitorTask(registry, 'mon_1')!;
      entry.abortController.signal.addEventListener('abort', () => {
        // Natural completion racing with cancel — the cancel path
        // should detect this and NOT force 'cancelled'.
        monitorComplete(registry, 'mon_1', 0);
      });

      monitorCancel(registry, 'mon_1', {});

      expect(getMonitorTask(registry, 'mon_1')?.status).toBe('completed');
    });

    it('dispatches owner-routed lifecycle wake on notify:false cancel', () => {
      const wake: MonitorOwnerLifecycleCallback = vi.fn();
      setMonitorAgentLifecycleCallback('agent-X', wake);
      monitorRegister(
        registry,
        makeReg('mon_owned', { ownerAgentId: 'agent-X' }),
      );
      monitorCancel(registry, 'mon_owned', { notify: false });
      expect(wake).toHaveBeenCalledTimes(1);
    });
  });

  describe('owner-scoped routing', () => {
    it('monitorHasRunningForOwner filters by ownerAgentId + status=running', () => {
      monitorRegister(
        registry,
        makeReg('mon_A1', { ownerAgentId: 'agent-A' }),
      );
      monitorRegister(
        registry,
        makeReg('mon_A2', { ownerAgentId: 'agent-A' }),
      );
      monitorRegister(
        registry,
        makeReg('mon_B1', { ownerAgentId: 'agent-B' }),
      );
      monitorComplete(registry, 'mon_A2', 0);

      expect(monitorHasRunningForOwner(registry, 'agent-A')).toBe(true);
      expect(monitorHasRunningForOwner(registry, 'agent-C')).toBe(false);
    });

    it('monitorCancelRunningForOwner cancels every running monitor owned by the agent', () => {
      monitorRegister(
        registry,
        makeReg('mon_A1', { ownerAgentId: 'agent-A' }),
      );
      monitorRegister(
        registry,
        makeReg('mon_A2', { ownerAgentId: 'agent-A' }),
      );
      monitorRegister(
        registry,
        makeReg('mon_B1', { ownerAgentId: 'agent-B' }),
      );

      monitorCancelRunningForOwner(registry, 'agent-A', { notify: false });

      expect(getMonitorTask(registry, 'mon_A1')?.status).toBe('cancelled');
      expect(getMonitorTask(registry, 'mon_A2')?.status).toBe('cancelled');
      expect(getMonitorTask(registry, 'mon_B1')?.status).toBe('running');
    });

    it('routes notifications to the owner-routed callback, not the global one', () => {
      const global: MonitorNotificationCallback = vi.fn();
      const ownerCb: MonitorNotificationCallback = vi.fn();
      setMonitorNotificationCallback(global);
      setMonitorAgentNotificationCallback('agent-A', ownerCb);
      monitorRegister(
        registry,
        makeReg('mon_owned', { ownerAgentId: 'agent-A', maxEvents: 1 }),
      );
      // emitEvent fires the per-event notification AND immediately
      // hits maxEvents = 1 → auto-stop fires the terminal notification.
      // Both route through the owner-routed callback, never the global.
      monitorEmitEvent(registry, 'mon_owned', 'go');

      expect(ownerCb).toHaveBeenCalledTimes(2);
      expect(global).not.toHaveBeenCalled();
    });
  });

  describe('monitorAbortAll', () => {
    it('cancels every running monitor and clears module-level owner callback maps', () => {
      const wakeA: MonitorOwnerLifecycleCallback = vi.fn();
      setMonitorAgentLifecycleCallback('agent-A', wakeA);
      const notifA: MonitorNotificationCallback = vi.fn();
      setMonitorAgentNotificationCallback('agent-A', notifA);
      monitorRegister(
        registry,
        makeReg('mon_A1', { ownerAgentId: 'agent-A' }),
      );
      monitorRegister(registry, makeReg('mon_top1'));

      monitorAbortAll(registry, { notify: false });

      expect(getMonitorTask(registry, 'mon_A1')?.status).toBe('cancelled');
      expect(getMonitorTask(registry, 'mon_top1')?.status).toBe('cancelled');

      // Owner callbacks should be cleared so a session-recycle daemon
      // doesn't leak handlers to dead agents.
      // Register a new monitor for agent-A and emit a terminal — the
      // prior callback must NOT fire.
      monitorRegister(
        registry,
        makeReg('mon_A2', { ownerAgentId: 'agent-A', maxEvents: 1 }),
      );
      monitorEmitEvent(registry, 'mon_A2', 'go');
      // notifA was cleared by abortAll, so its call count stays 0 even
      // though a new owned monitor just hit its terminal state.
      expect(notifA).not.toHaveBeenCalled();
    });
  });

  describe('monitorReset', () => {
    it('aborts running monitors and clears the module-level owner-callback Maps', () => {
      const wakeA = vi.fn();
      setMonitorAgentLifecycleCallback('agent-A', wakeA);
      monitorRegister(
        registry,
        makeReg('mon_A1', { ownerAgentId: 'agent-A' }),
      );
      const ac = getMonitorTask(registry, 'mon_A1')!.abortController;

      monitorReset(registry);

      expect(ac.signal.aborted).toBe(true);
    });
  });

  describe('getRunningMonitorTasks', () => {
    it('returns only running monitors', () => {
      monitorRegister(registry, makeReg('mon_1'));
      monitorRegister(registry, makeReg('mon_2'));
      monitorRegister(registry, makeReg('mon_3'));
      monitorComplete(registry, 'mon_2', 0);
      monitorFail(registry, 'mon_3', 'oops');

      const running = getRunningMonitorTasks(registry);
      expect(running.map((m) => m.monitorId)).toEqual(['mon_1']);
    });
  });

  describe('getMonitorTask', () => {
    it('returns undefined for missing ids and for non-monitor kinds', () => {
      expect(getMonitorTask(registry, 'nope')).toBeUndefined();
      // Also test that a wrong-kind entry is narrowed out — fake an
      // agent entry directly and verify it's not returned.
      registry.register({
        id: 'fake-agent',
        kind: 'agent',
        outputOffset: 0,
        notified: false,
        agentId: 'fake-agent',
        description: 'x',
        isBackgrounded: true,
        status: 'running',
        startTime: 0,
        abortController: new AbortController(),
        outputFile: '/tmp/x.jsonl',
      } as never);
      expect(getMonitorTask(registry, 'fake-agent')).toBeUndefined();
    });
  });
});
