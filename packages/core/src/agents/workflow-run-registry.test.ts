/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  WorkflowRunRegistry,
  MAX_RETAINED_TERMINAL_WORKFLOWS,
  type WorkflowTaskRegistration,
} from './workflow-run-registry.js';

function reg(
  runId: string,
  overrides: Partial<WorkflowTaskRegistration> = {},
): WorkflowTaskRegistration {
  return {
    runId,
    meta: null,
    description: 'wf',
    status: 'running',
    startTime: 1_700_000_000_000,
    outputFile: `/tmp/${runId}.jsonl`,
    abortController: new AbortController(),
    ...overrides,
  } as WorkflowTaskRegistration;
}

describe('WorkflowRunRegistry', () => {
  it('register graduates the registration to a WorkflowTask in place', () => {
    const r = new WorkflowRunRegistry();
    const registration = reg('wf_1');
    const entry = r.register(registration);
    expect(entry).toBe(registration);
    expect(entry.id).toBe('wf_1');
    expect(entry.kind).toBe('workflow');
    expect(entry.currentPhase).toBeNull();
    expect(entry.phases).toEqual([]);
    expect(entry.agentsDispatched).toBe(0);
    expect(entry.agentsCompleted).toBe(0);
    expect(entry.recentLogs).toEqual([]);
    expect(entry.outputOffset).toBe(0);
    expect(entry.notified).toBe(false);
  });

  it('register synthesizes description from meta.name when omitted', () => {
    const r = new WorkflowRunRegistry();
    const entry = r.register(
      reg('wf_named', {
        description: undefined,
        meta: { name: 'capitals', description: 'd' },
      }),
    );
    expect(entry.description).toBe('capitals');
  });

  it('register falls back to runId when meta is null and no description', () => {
    const r = new WorkflowRunRegistry();
    const entry = r.register(reg('wf_anon', { description: undefined }));
    expect(entry.description).toBe('wf_anon');
  });

  it('onPhaseStarted appends + sets currentPhase, dedupes consecutive', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_1'));
    r.onPhaseStarted('wf_1', 'Plan');
    r.onPhaseStarted('wf_1', 'Plan'); // dedup
    r.onPhaseStarted('wf_1', 'Build');
    const e = r.get('wf_1')!;
    expect(e.phases).toEqual(['Plan', 'Build']);
    expect(e.currentPhase).toBe('Build');
  });

  it('onAgentDispatched + onAgentCompleted increment counters', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_1'));
    r.onAgentDispatched('wf_1');
    r.onAgentDispatched('wf_1');
    r.onAgentCompleted('wf_1');
    const e = r.get('wf_1')!;
    expect(e.agentsDispatched).toBe(2);
    expect(e.agentsCompleted).toBe(1);
  });

  it('setRecentLogs caps at 100 entries (keeps the tail)', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_1'));
    const logs = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    r.setRecentLogs('wf_1', logs);
    const e = r.get('wf_1')!;
    expect(e.recentLogs).toHaveLength(100);
    expect(e.recentLogs[0]).toBe('line 150');
    expect(e.recentLogs[99]).toBe('line 249');
  });

  it('complete settles the entry and ignores subsequent transitions', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_1'));
    r.complete('wf_1', { answer: 'Paris' }, 2_000);
    const e = r.get('wf_1')!;
    expect(e.status).toBe('completed');
    expect(e.endTime).toBe(2_000);
    expect(e.result).toEqual({ answer: 'Paris' });
    expect(e.notified).toBe(true);

    r.fail('wf_1', 'too late', 3_000);
    r.cancel('wf_1', 4_000);
    r.onPhaseStarted('wf_1', 'ignored');
    expect(e.status).toBe('completed');
    expect(e.error).toBeUndefined();
    expect(e.endTime).toBe(2_000);
    expect(e.phases).toEqual([]); // onPhaseStarted is gated by status
  });

  it('fail records the message and settles', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_1'));
    r.fail('wf_1', 'boom', 5_000);
    const e = r.get('wf_1')!;
    expect(e.status).toBe('failed');
    expect(e.error).toBe('boom');
    expect(e.endTime).toBe(5_000);
  });

  it('cancel aborts the controller and settles', () => {
    const r = new WorkflowRunRegistry();
    const ac = new AbortController();
    r.register(reg('wf_1', { abortController: ac }));
    expect(ac.signal.aborted).toBe(false);
    r.cancel('wf_1', 6_000);
    expect(ac.signal.aborted).toBe(true);
    const e = r.get('wf_1')!;
    expect(e.status).toBe('cancelled');
  });

  it('terminal entries are evicted once over the retention cap', () => {
    const r = new WorkflowRunRegistry();
    for (let i = 0; i < MAX_RETAINED_TERMINAL_WORKFLOWS + 5; i++) {
      r.register(reg(`wf_${i}`));
      r.complete(`wf_${i}`, null, 1_000 + i);
    }
    const all = r.list();
    expect(all).toHaveLength(MAX_RETAINED_TERMINAL_WORKFLOWS);
    // Oldest-by-endTime are evicted first; the surviving subset must be
    // the most recently-completed ones.
    const ids = all.map((e) => e.runId);
    expect(ids).toContain(`wf_${MAX_RETAINED_TERMINAL_WORKFLOWS + 4}`);
    expect(ids).not.toContain('wf_0');
  });

  it('running entries are never evicted', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('runner')); // stays running
    for (let i = 0; i < MAX_RETAINED_TERMINAL_WORKFLOWS + 3; i++) {
      r.register(reg(`done_${i}`));
      r.complete(`done_${i}`, null, 2_000 + i);
    }
    expect(r.get('runner')).toBeDefined();
    expect(r.get('runner')!.status).toBe('running');
  });

  it('register callback fires synchronously inside register()', () => {
    const r = new WorkflowRunRegistry();
    const cb = vi.fn();
    r.setRegisterCallback(cb);
    const e = r.register(reg('wf_cb'));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(e);
  });

  it('statusChange fires on register + every transition', () => {
    const r = new WorkflowRunRegistry();
    const cb = vi.fn();
    r.setStatusChangeCallback(cb);
    r.register(reg('wf_sc'));
    r.onPhaseStarted('wf_sc', 'Plan');
    r.onAgentDispatched('wf_sc');
    r.complete('wf_sc', 'ok', 7_000);
    // 1 (register) + 1 (phase) + 1 (dispatched) + 1 (complete) = 4
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it('errors thrown by status-change callback do not break the call site', () => {
    const r = new WorkflowRunRegistry();
    r.setStatusChangeCallback(() => {
      throw new Error('subscriber blew up');
    });
    r.register(reg('wf_throw'));
    // Must not throw.
    expect(() => r.complete('wf_throw', null, 1)).not.toThrow();
  });

  // P-notif: terminal-completion notification callback.
  it('notification callback fires on complete and fail, not on cancel', () => {
    const r = new WorkflowRunRegistry();
    const cb = vi.fn();
    r.setNotificationCallback(cb);

    r.register(reg('wf_done'));
    r.complete('wf_done', 'ok', 1_000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].status).toBe('completed');

    r.register(reg('wf_bad'));
    r.fail('wf_bad', 'boom', 2_000);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0].status).toBe('failed');

    // A user-initiated cancel is intentionally NOT notified.
    r.register(reg('wf_cancelled'));
    r.cancel('wf_cancelled', 3_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('errors thrown by the notification callback do not break the call site', () => {
    const r = new WorkflowRunRegistry();
    r.setNotificationCallback(() => {
      throw new Error('notifier blew up');
    });
    r.register(reg('wf_n'));
    expect(() => r.complete('wf_n', null, 1)).not.toThrow();
    expect(r.get('wf_n')!.status).toBe('completed');
  });

  // P4 Round 7 (wenshao): dialog-initiated cancel marks status='cancelled'
  // synchronously, then the abort propagates to the tool's catch arm which
  // calls setRecentLogs(runId, logs). The previous guard rejected this
  // because status !== 'running', so cancelled workflows showed an empty
  // Logs section in the dialog. The fix allows setRecentLogs after the
  // 'cancelled' transition — Ctrl+C (signal.aborted at execute()'s top
  // before the dialog touches the registry) is unchanged, and the
  // unchanged guard still rejects logs arriving after 'completed' or
  // 'failed' (those terminal states are final).
  it('setRecentLogs after a cancel transition still writes (dialog-initiated)', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_late_logs'));
    r.cancel('wf_late_logs', 5_000);
    r.setRecentLogs('wf_late_logs', ['line1', 'line2']);
    const e = r.get('wf_late_logs')!;
    expect(e.recentLogs).toEqual(['line1', 'line2']);
    expect(e.status).toBe('cancelled');
  });

  it('setRecentLogs after complete/fail is rejected (terminal states are final)', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_done'));
    r.complete('wf_done', null, 1_000);
    r.setRecentLogs('wf_done', ['too late']);
    expect(r.get('wf_done')!.recentLogs).toEqual([]);

    r.register(reg('wf_fail'));
    r.fail('wf_fail', 'boom', 2_000);
    r.setRecentLogs('wf_fail', ['too late']);
    expect(r.get('wf_fail')!.recentLogs).toEqual([]);
  });

  // P4 Round 7 (wenshao): WorkflowRunRegistry must expose reset() and
  // abortAll() to match its three sibling registries (agent, shell,
  // monitor). Without these, /clear and session-resume leak prior-
  // session workflow state into the next session — pill / dialog /
  // /workflows listing all show stale rows, and in-flight workflows
  // keep executing after the user cleared the session.
  it('reset() drops every entry without aborting controllers', () => {
    const r = new WorkflowRunRegistry();
    const ac1 = new AbortController();
    r.register(reg('wf_1', { abortController: ac1 }));
    r.register(reg('wf_2'));
    r.complete('wf_2', null, 1_000);
    expect(r.list()).toHaveLength(2);
    r.reset();
    expect(r.list()).toEqual([]);
    // Sibling shell registry's reset() does NOT touch processes — same
    // contract here: reset just drops in-memory entries; abortAll() is
    // the controller-aborting path.
    expect(ac1.signal.aborted).toBe(false);
  });

  it('abortAll() aborts every running entry and marks them cancelled', () => {
    const r = new WorkflowRunRegistry();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const acDone = new AbortController();
    r.register(reg('wf_run1', { abortController: ac1 }));
    r.register(reg('wf_run2', { abortController: ac2 }));
    r.register(reg('wf_done', { abortController: acDone }));
    r.complete('wf_done', null, 1_000);
    r.abortAll();
    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    // Already-terminal entry's controller is NOT re-aborted (no-op for
    // settled entries).
    expect(acDone.signal.aborted).toBe(false);
    expect(r.get('wf_run1')!.status).toBe('cancelled');
    expect(r.get('wf_run2')!.status).toBe('cancelled');
    expect(r.get('wf_done')!.status).toBe('completed');
  });

  it('hasRunningEntries() reflects the running subset', () => {
    const r = new WorkflowRunRegistry();
    expect(r.hasRunningEntries()).toBe(false);
    r.register(reg('wf_1'));
    expect(r.hasRunningEntries()).toBe(true);
    r.complete('wf_1', null, 1_000);
    expect(r.hasRunningEntries()).toBe(false);
  });

  // ── P5: budget + warning latch ─────────────────────────────────────

  it('P5: register initializes tokensSpent=0, tokenBudgetTotal=null, perPhaseTokens=Map', () => {
    const r = new WorkflowRunRegistry();
    const entry = r.register(reg('wf_1'));
    expect(entry.tokensSpent).toBe(0);
    expect(entry.tokenBudgetTotal).toBeNull();
    expect(entry.perPhaseTokens).toBeInstanceOf(Map);
    expect(entry.perPhaseTokens.size).toBe(0);
  });

  it('P5: register seeds tokenBudgetTotal from the caller-supplied cap', () => {
    const r = new WorkflowRunRegistry();
    const entry = r.register(reg('wf_capped', { tokenBudgetTotal: 50_000 }));
    expect(entry.tokenBudgetTotal).toBe(50_000);
  });

  it('P5: onBudgetUpdated mutates tokensSpent + tokenBudgetTotal', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_1'));
    r.onBudgetUpdated('wf_1', 1500, 10_000);
    const e = r.get('wf_1')!;
    expect(e.tokensSpent).toBe(1500);
    expect(e.tokenBudgetTotal).toBe(10_000);
  });

  it('P5: onBudgetUpdated attributes delta to the entry currentPhase', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_1'));
    r.onPhaseStarted('wf_1', 'Find');
    r.onBudgetUpdated('wf_1', 200, 1000); // +200 → Find
    r.onBudgetUpdated('wf_1', 350, 1000); // +150 → Find
    r.onPhaseStarted('wf_1', 'Verify');
    r.onBudgetUpdated('wf_1', 500, 1000); // +150 → Verify
    const e = r.get('wf_1')!;
    expect(e.tokensSpent).toBe(500);
    expect(e.perPhaseTokens.get('Find')).toBe(350);
    expect(e.perPhaseTokens.get('Verify')).toBe(150);
  });

  it('P5: onBudgetUpdated attributes to the null sentinel before first phase()', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_1'));
    r.onBudgetUpdated('wf_1', 100, null); // no phase yet
    const e = r.get('wf_1')!;
    expect(e.perPhaseTokens.get(null)).toBe(100);
  });

  it('P5: onBudgetUpdated is a no-op on missing / terminal entries', () => {
    const r = new WorkflowRunRegistry();
    // Missing entry — no throw.
    r.onBudgetUpdated('wf_unknown', 100, 1000);

    r.register(reg('wf_1'));
    r.complete('wf_1', null, 1_000);
    r.onBudgetUpdated('wf_1', 999, 1000); // terminal → ignored
    const e = r.get('wf_1')!;
    expect(e.tokensSpent).toBe(0);
    expect(e.tokenBudgetTotal).toBeNull();
  });

  it('P5: onBudgetUpdated is a no-op on backwards / zero deltas (R1 #8: monotonic spent)', () => {
    // R1 #8 contract: the orchestrator fires `budgetUpdated` after every
    // dispatch, but `WorkflowBudgetImpl.recordSpent` only accumulates
    // positive integer deltas — so `budget.spent()` is monotonically
    // increasing in production. A backwards / zero call here can only
    // come from a buggy caller, and we treat it as a defensive no-op
    // (skip the emit + the field mutation) rather than overwriting the
    // tracker with a stale value.
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_1'));
    r.onPhaseStarted('wf_1', 'A');
    r.onBudgetUpdated('wf_1', 100, 1000);
    r.onBudgetUpdated('wf_1', 100, 1000); // same total → delta 0 → no-op
    r.onBudgetUpdated('wf_1', 50, 1000); // backwards → no-op
    const e = r.get('wf_1')!;
    expect(e.tokensSpent).toBe(100);
    expect(e.perPhaseTokens.get('A')).toBe(100);
  });

  it('P5 R1 #8: onBudgetUpdated does NOT emit statusChange on no-op deltas', () => {
    const r = new WorkflowRunRegistry();
    const cb = vi.fn();
    r.setStatusChangeCallback(cb);
    r.register(reg('wf_1'));
    r.onBudgetUpdated('wf_1', 100, 1000); // first delta → emits
    cb.mockClear();
    r.onBudgetUpdated('wf_1', 100, 1000); // delta = 0, total unchanged → skip
    r.onBudgetUpdated('wf_1', 100, 1000); // same again → still skip
    expect(cb).not.toHaveBeenCalled();
    // But a cap change (rare; defensive) still emits even at no spend delta.
    r.onBudgetUpdated('wf_1', 100, 2000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('P5: onBudgetUpdated fires the statusChange callback', () => {
    const r = new WorkflowRunRegistry();
    const cb = vi.fn();
    r.setStatusChangeCallback(cb);
    r.register(reg('wf_1'));
    cb.mockClear();
    r.onBudgetUpdated('wf_1', 100, 1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('P5: shouldShowUsageWarning fires once per registry instance', () => {
    const r = new WorkflowRunRegistry();
    expect(r.shouldShowUsageWarning()).toBe(true);
    expect(r.shouldShowUsageWarning()).toBe(false);
    expect(r.shouldShowUsageWarning()).toBe(false);
  });

  it('P5: shouldShowUsageWarning latch survives reset() (per-session, not per-clear)', () => {
    const r = new WorkflowRunRegistry();
    r.shouldShowUsageWarning(); // flips to true
    r.register(reg('wf_1'));
    r.reset();
    expect(r.shouldShowUsageWarning()).toBe(false);
  });
});
