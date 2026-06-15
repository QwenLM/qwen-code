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
});
