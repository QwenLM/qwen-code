/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  OwnerEventBus,
  type OwnerEvent,
  type WorkflowEventPayload,
} from '../ownerEvents.js';
import { AUDIT_ACTIONS } from '../auditLog.js';
import { buildPayload, WORKFLOW_EVENT_KINDS } from '../webpush/payload.js';
import { KIND_SCOPE, SNOOZE_BYPASS_KINDS } from '../webpush/notifier.js';
import { SESSION_READ } from '../scopes.js';

describe('workflow OwnerEvent variants', () => {
  it('fans workflow lifecycle + phase frames', () => {
    const bus = new OwnerEventBus();
    const seen: OwnerEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const workflow: WorkflowEventPayload = {
      runId: 'r1',
      name: 'demo',
      scriptHash: 'h',
      status: 'completed',
      agentCount: 3,
      tokensSpent: 42,
    };
    bus.publish({
      type: 'workflow_started',
      workflow: { ...workflow, status: 'running' },
    });
    bus.publish({
      type: 'workflow_phase',
      runId: 'r1',
      phase: 'Verify',
      phaseIndex: 1,
    });
    bus.publish({ type: 'workflow_completed', workflow });
    expect(seen.map((e) => e.type)).toEqual([
      'workflow_started',
      'workflow_phase',
      'workflow_completed',
    ]);
  });
});

describe('workflow audit actions', () => {
  it('registers the two new actions', () => {
    expect(AUDIT_ACTIONS).toContain('workflow_started');
    expect(AUDIT_ACTIONS).toContain('workflow_cancelled');
  });
});

describe('workflow notification kinds', () => {
  it('maps only completed/failed to kinds; metadata only, no script', () => {
    expect(WORKFLOW_EVENT_KINDS).toEqual({
      workflow_completed: 'workflow.completed',
      workflow_failed: 'workflow.failed',
    });
    const p = buildPayload(
      {
        type: 'workflow_completed',
        data: {
          runId: 'r1',
          name: 'demo',
          status: 'completed',
          scriptHash: 'h',
        },
      },
      { sessionId: 'r1', sessionName: 'demo' },
    );
    expect(p?.kind).toBe('workflow.completed');
    expect(JSON.stringify(p)).not.toContain('scriptHash');
    // workflow_started has no kind → no payload.
    expect(
      buildPayload({ type: 'workflow_started', data: {} }, { sessionId: 'r1' }),
    ).toBeNull();
  });

  it('scope-gates both kinds at session:read and does NOT bypass snooze', () => {
    expect(KIND_SCOPE['workflow.completed']).toBe(SESSION_READ);
    expect(KIND_SCOPE['workflow.failed']).toBe(SESSION_READ);
    expect(SNOOZE_BYPASS_KINDS.has('workflow.completed')).toBe(false);
    expect(SNOOZE_BYPASS_KINDS.has('workflow.failed')).toBe(false);
  });
});
