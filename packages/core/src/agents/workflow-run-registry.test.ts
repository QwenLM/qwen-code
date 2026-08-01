/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { todoWorkChainContext } from '../utils/promptIdContext.js';
import {
  AgentEventEmitter,
  AgentEventType,
  type AgentApprovalRequestEvent,
} from './runtime/agent-events.js';
import type { WorkflowRunHandle } from './runtime/workflow-runner.js';
import {
  WorkflowRunRegistry,
  MAX_PENDING_WORKFLOW_APPROVALS,
  MAX_WORKFLOW_APPROVAL_DISPLAY_CHARS,
  MAX_RETAINED_TERMINAL_WORKFLOWS,
  type WorkflowApprovalRequestCallback,
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

function approvalEvent(
  overrides: Partial<AgentApprovalRequestEvent> = {},
): AgentApprovalRequestEvent {
  return {
    subagentId: 'workflow-agent-a',
    round: 1,
    callId: 'call-1',
    name: 'Shell',
    description: 'Run a command',
    args: { command: 'git status' },
    confirmationDetails: {
      type: 'exec',
      title: 'Run command?',
      command: 'git status',
      rootCommand: 'git status',
    },
    respond: vi.fn(async () => {}),
    timestamp: 1_700_000_000_100,
    ...overrides,
  };
}

describe('WorkflowRunRegistry', () => {
  it('parks a workflow-agent approval and resolves it exactly once', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_approval'));
    const onApprovalChange = vi.fn();
    r.setApprovalChangeCallback(onApprovalChange);
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    const cleanup = r.bridgeApprovalEvents('wf_approval', emitter);

    emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
      subagentId: 'workflow-agent-a',
      round: 1,
      callId: 'call-1',
      name: 'Shell',
      description: 'Run a command',
      args: { command: 'git status' },
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
      },
      respond,
      timestamp: 1_700_000_000_100,
    });

    expect(r.get('wf_approval')?.pendingApprovals).toMatchObject([
      {
        subagentId: 'workflow-agent-a',
        callId: 'call-1',
        name: 'Shell',
      },
    ]);
    const approval = r.get('wf_approval')?.pendingApprovals[0];
    expect(approval).toBeDefined();
    expect(approval).not.toHaveProperty('args');
    expect(approval).not.toHaveProperty('respond');
    expect(onApprovalChange).toHaveBeenCalledTimes(1);

    await expect(
      r.resolvePendingApproval(
        'wf_approval',
        approval!.approvalId,
        ToolConfirmationOutcome.ProceedOnce,
      ),
    ).resolves.toBe(true);
    await expect(
      r.resolvePendingApproval(
        'wf_approval',
        approval!.approvalId,
        ToolConfirmationOutcome.ProceedOnce,
      ),
    ).resolves.toBe(false);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
    cleanup();
  });

  it('rejects pending approvals exactly once when a run is cancelled', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_cancel_approval'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    const cleanup = r.bridgeApprovalEvents('wf_cancel_approval', emitter);
    emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
      subagentId: 'workflow-agent-a',
      round: 1,
      callId: 'call-1',
      name: 'Shell',
      description: 'Run a command',
      args: { command: 'git status' },
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
      },
      respond,
      timestamp: 1_700_000_000_100,
    });
    const approvalId =
      r.get('wf_cancel_approval')!.pendingApprovals[0].approvalId;

    r.cancel('wf_cancel_approval', 2_000);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    });
    expect(r.get('wf_cancel_approval')?.pendingApprovals).toEqual([]);
    await expect(
      r.resolvePendingApproval(
        'wf_cancel_approval',
        approvalId,
        ToolConfirmationOutcome.ProceedOnce,
      ),
    ).resolves.toBe(false);
    cleanup();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('drains pending approvals before a run completes', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_complete_approval'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_complete_approval', emitter);
    emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
      subagentId: 'workflow-agent-a',
      round: 1,
      callId: 'call-1',
      name: 'Shell',
      description: 'Run a command',
      args: { command: 'git status' },
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        command: 'git status',
        rootCommand: 'git status',
      },
      respond,
      timestamp: 1_700_000_000_100,
    });

    r.complete('wf_complete_approval', 'done', 2_000);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    });
    expect(r.get('wf_complete_approval')?.pendingApprovals).toEqual([]);
  });

  it('drains pending approvals on failure and session-wide abort', async () => {
    const r = new WorkflowRunRegistry();
    r.setApprovalChangeCallback(() => {});
    const failedEmitter = new AgentEventEmitter();
    const abortedEmitter = new AgentEventEmitter();
    const failedRespond = vi.fn(async () => {});
    const abortedRespond = vi.fn(async () => {});
    r.register(reg('wf_failed_approval'));
    r.register(reg('wf_aborted_approval'));
    r.bridgeApprovalEvents('wf_failed_approval', failedEmitter);
    r.bridgeApprovalEvents('wf_aborted_approval', abortedEmitter);
    const emitApproval = (
      emitter: AgentEventEmitter,
      subagentId: string,
      callId: string,
      respond: typeof failedRespond,
    ) =>
      emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
        subagentId,
        round: 1,
        callId,
        name: 'Shell',
        description: 'Run a command',
        args: { command: 'git status' },
        confirmationDetails: {
          type: 'exec',
          title: 'Run command?',
          command: 'git status',
          rootCommand: 'git status',
        },
        respond,
        timestamp: 1_700_000_000_100,
      });
    emitApproval(failedEmitter, 'agent-failed', 'call-failed', failedRespond);
    emitApproval(
      abortedEmitter,
      'agent-aborted',
      'call-aborted',
      abortedRespond,
    );

    r.fail('wf_failed_approval', 'boom', 2_000);
    r.abortAll();
    await vi.waitFor(() => {
      expect(failedRespond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
      );
      expect(abortedRespond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
      );
    });
    expect(r.get('wf_failed_approval')?.pendingApprovals).toEqual([]);
    expect(r.get('wf_aborted_approval')?.pendingApprovals).toEqual([]);
  });

  it('fails closed immediately when no host approval channel exists', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_no_channel'));
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_no_channel', emitter);

    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({ respond }),
    );

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    });
    expect(r.get('wf_no_channel')?.pendingApprovals).toEqual([]);
  });

  it('isolates approvals from two agents that share a provider callId', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_shared_call_id'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const firstRespond = vi.fn(async () => {});
    const secondRespond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_shared_call_id', emitter);

    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({ subagentId: 'agent-a', respond: firstRespond }),
    );
    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({ subagentId: 'agent-b', respond: secondRespond }),
    );
    const [first, second] = r.get('wf_shared_call_id')!.pendingApprovals;

    expect(first.approvalId).not.toBe(second.approvalId);
    await r.resolvePendingApproval(
      'wf_shared_call_id',
      second.approvalId,
      ToolConfirmationOutcome.ProceedOnce,
    );
    await r.resolvePendingApproval(
      'wf_shared_call_id',
      first.approvalId,
      ToolConfirmationOutcome.Cancel,
    );
    expect(firstRespond).toHaveBeenCalledOnce();
    expect(firstRespond).toHaveBeenCalledWith(
      ToolConfirmationOutcome.Cancel,
      undefined,
    );
    expect(secondRespond).toHaveBeenCalledOnce();
    expect(secondRespond).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
  });

  it('deduplicates the same agent tool request without rejecting it', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_duplicate_approval'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const event = approvalEvent();
    r.bridgeApprovalEvents('wf_duplicate_approval', emitter);

    emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, event);
    emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, event);

    expect(r.get('wf_duplicate_approval')?.pendingApprovals).toHaveLength(1);
    expect(event.respond).not.toHaveBeenCalled();
  });

  it('does not re-park a duplicate event after it was resolved', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_late_duplicate'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const event = approvalEvent();
    r.bridgeApprovalEvents('wf_late_duplicate', emitter);
    emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, event);
    const approvalId =
      r.get('wf_late_duplicate')!.pendingApprovals[0].approvalId;
    await r.resolvePendingApproval(
      'wf_late_duplicate',
      approvalId,
      ToolConfirmationOutcome.ProceedOnce,
    );

    emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, event);

    expect(r.get('wf_late_duplicate')?.pendingApprovals).toEqual([]);
    expect(event.respond).toHaveBeenCalledOnce();
  });

  it('normalizes persistent approval outcomes to cancel', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_once_only'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_once_only', emitter);
    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({ respond }),
    );
    const approvalId = r.get('wf_once_only')!.pendingApprovals[0].approvalId;

    await r.resolvePendingApproval(
      'wf_once_only',
      approvalId,
      ToolConfirmationOutcome.ProceedAlways,
      { permissionRules: ['ShellTool(git status)'] },
    );

    expect(respond).toHaveBeenCalledWith(
      ToolConfirmationOutcome.Cancel,
      undefined,
    );
  });

  it('drops raw arguments and edit contents from the public approval DTO', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_sensitive_approval'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    r.bridgeApprovalEvents('wf_sensitive_approval', emitter);
    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({
        name: 'Edit',
        args: { secret: 'RAW_ARGS_SENTINEL' },
        confirmationDetails: {
          type: 'edit',
          title: 'Edit file?',
          fileName: 'example.ts',
          filePath: '/tmp/example.ts',
          fileDiff: '@@ safe display diff @@',
          originalContent: 'ORIGINAL_CONTENT_SENTINEL',
          newContent: 'NEW_CONTENT_SENTINEL',
        },
      }),
    );

    const serialized = JSON.stringify(
      r.get('wf_sensitive_approval')!.pendingApprovals[0],
    );
    expect(serialized).not.toContain('RAW_ARGS_SENTINEL');
    expect(serialized).not.toContain('ORIGINAL_CONTENT_SENTINEL');
    expect(serialized).not.toContain('NEW_CONTENT_SENTINEL');
    expect(r.get('wf_sensitive_approval')!.pendingApprovals[0]).toMatchObject({
      confirmationDetails: {
        type: 'edit',
        hideAlwaysAllow: true,
        hideModify: true,
        skipIdeDiff: true,
      },
    });
  });

  it('rejects unsupported and oversized approval details', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_restricted_approval'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const askRespond = vi.fn(async () => {});
    const oversizedRespond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_restricted_approval', emitter);

    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({
        name: 'AskUserQuestion',
        respond: askRespond,
        confirmationDetails: {
          type: 'ask_user_question',
          title: 'Ask?',
          questions: [],
        },
      }),
    );
    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({
        subagentId: 'agent-b',
        callId: 'call-2',
        description: 'x'.repeat(MAX_WORKFLOW_APPROVAL_DISPLAY_CHARS + 1),
        respond: oversizedRespond,
      }),
    );

    await vi.waitFor(() => {
      expect(askRespond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      expect(oversizedRespond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
      );
    });
    expect(r.get('wf_restricted_approval')?.pendingApprovals).toEqual([]);
  });

  it('cancels and clears an approval when an async host channel fails', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_failed_channel'));
    r.setApprovalRequestCallback(async () => {
      throw new Error('host disconnected');
    });
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_failed_channel', emitter);

    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({ respond }),
    );

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
        undefined,
      );
    });
    expect(r.get('wf_failed_channel')?.pendingApprovals).toEqual([]);
  });

  it('rejects and clears an approval when the host channel throws synchronously', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_sync_failed_channel'));
    r.setApprovalRequestCallback((): void => {
      throw new Error('sync failure');
    });
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_sync_failed_channel', emitter);

    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({ respond }),
    );

    // The sync-throw arm cleans up inside parkPendingApproval and the
    // bridge rejects the responder directly, so the approval is cancelled
    // without going through resolvePendingApproval.
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    });
    expect(r.get('wf_sync_failed_channel')?.pendingApprovals).toEqual([]);
  });

  it('fails the run and drains siblings when resolving respond throws', async () => {
    const abortController = new AbortController();
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_resolve_throws', { abortController }));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const failingRespond = vi.fn(async () => {
      throw new Error('boom');
    });
    const siblingRespond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_resolve_throws', emitter);

    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({
        subagentId: 'agent-a',
        callId: 'call-a',
        respond: failingRespond,
      }),
    );
    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({
        subagentId: 'agent-b',
        callId: 'call-b',
        respond: siblingRespond,
      }),
    );

    const target = r.get('wf_resolve_throws')!.pendingApprovals[0];
    const resolved = await r.resolvePendingApproval(
      'wf_resolve_throws',
      target.approvalId,
      ToolConfirmationOutcome.ProceedOnce,
    );

    expect(resolved).toBe(false);
    const entry = r.get('wf_resolve_throws')!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toContain(target.approvalId);
    // fail() drains the still-pending sibling approval.
    expect(entry.pendingApprovals).toEqual([]);
    await vi.waitFor(() => {
      expect(siblingRespond).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
      );
    });
    // The run's controller is aborted via the handle fallback.
    expect(abortController.signal.aborted).toBe(true);
  });

  it('bounds pending approvals per workflow run', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_bounded_approvals'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const responders = Array.from(
      { length: MAX_PENDING_WORKFLOW_APPROVALS + 1 },
      () => vi.fn(async () => {}),
    );
    r.bridgeApprovalEvents('wf_bounded_approvals', emitter);

    responders.forEach((respond, index) => {
      emitter.emit(
        AgentEventType.TOOL_WAITING_APPROVAL,
        approvalEvent({
          subagentId: `agent-${index}`,
          callId: `call-${index}`,
          respond,
        }),
      );
    });

    expect(r.get('wf_bounded_approvals')?.pendingApprovals).toHaveLength(
      MAX_PENDING_WORKFLOW_APPROVALS,
    );
    await vi.waitFor(() => {
      expect(responders.at(-1)).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
      );
    });
    expect(
      responders.slice(0, -1).every((respond) => !respond.mock.calls.length),
    ).toBe(true);
  });

  it('clears a completed tool approval without responding again', () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_tool_result'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_tool_result', emitter);
    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({ respond }),
    );

    emitter.emit(AgentEventType.TOOL_RESULT, {
      subagentId: 'workflow-agent-a',
      round: 1,
      callId: 'call-1',
      name: 'Shell',
      success: true,
      timestamp: 1_700_000_000_200,
    });

    expect(r.get('wf_tool_result')?.pendingApprovals).toEqual([]);
    expect(respond).not.toHaveBeenCalled();
  });

  it('aborts the host request signal when an attempt cleans up', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_host_request_cleanup'));
    let hostSignal: AbortSignal | undefined;
    const requestCallback = vi.fn(
      (
        _entry: unknown,
        _approval: unknown,
        _args: unknown,
        signal: AbortSignal,
      ) => {
        hostSignal = signal;
      },
    ) as unknown as WorkflowApprovalRequestCallback;
    r.setApprovalRequestCallback(requestCallback);
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    const cleanup = r.bridgeApprovalEvents('wf_host_request_cleanup', emitter);
    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({ respond }),
    );
    expect(hostSignal?.aborted).toBe(false);

    cleanup();

    expect(hostSignal?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    });
  });

  it('drains approvals if a registry reset races with session switching', async () => {
    const r = new WorkflowRunRegistry();
    r.register(reg('wf_reset_approval'));
    r.setApprovalChangeCallback(() => {});
    const emitter = new AgentEventEmitter();
    const respond = vi.fn(async () => {});
    r.bridgeApprovalEvents('wf_reset_approval', emitter);
    emitter.emit(
      AgentEventType.TOOL_WAITING_APPROVAL,
      approvalEvent({ respond }),
    );

    r.reset();

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    });
    expect(r.list()).toEqual([]);
  });

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

  it('rejects a duplicate run id until its owner handle is released', () => {
    const r = new WorkflowRunRegistry();
    const runId = 'wf_collision';
    r.register(reg(runId));

    expect(() => r.register(reg(runId))).toThrow(/already active/);

    const handle = {
      runId,
      abort: vi.fn(),
    } as unknown as WorkflowRunHandle;
    r.attachHandle(handle);
    r.cancel(runId, 2_000);
    expect(() => r.register(reg(runId))).toThrow(/already active/);

    r.releaseHandle(runId, handle);
    expect(r.register(reg(runId)).status).toBe('running');
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

  it('keeps terminal bell and background model completion channels independent', () => {
    const r = new WorkflowRunRegistry();
    const bell = vi.fn();
    const completion = vi.fn();
    r.setNotificationCallback(bell);
    r.setCompletionCallback(completion);
    expect(r.hasCompletionCallback()).toBe(true);

    const result = 'safe <value> & </task-notification>';
    const entry = r.register(
      reg('wf_background', {
        isBackgrounded: true,
        script: 'secret script',
        description: '\u001b[31mwf\u001b[0m',
      }),
    );
    r.complete(entry.runId, result, 1_000);
    r.complete(entry.runId, 'duplicate', 1_001);
    r.fail(entry.runId, 'duplicate failure', 1_002);

    expect(bell).toHaveBeenCalledOnce();
    expect(bell).toHaveBeenCalledWith(entry);
    expect(completion).toHaveBeenCalledOnce();
    const [displayText, modelText, meta] = completion.mock.calls[0];
    expect(displayText).toBe('Background workflow "wf" completed.');
    expect(modelText).toContain('<kind>workflow</kind>');
    expect(modelText).toContain('<task-id>wf_background</task-id>');
    expect(modelText).toContain('<status>completed</status>');
    expect(modelText).toContain(
      'safe &lt;value&gt; &amp; &lt;/task-notification&gt;',
    );
    expect(modelText.match(/<\/task-notification>/g)).toHaveLength(1);
    expect(modelText).not.toContain('secret script');
    expect(modelText).not.toContain('\u001b');
    expect(meta).toEqual({
      runId: 'wf_background',
      status: 'completed',
      todoWorkChainId: undefined,
    });

    r.register(reg('wf_foreground'));
    r.complete('wf_foreground', 'foreground', 2_000);
    expect(bell).toHaveBeenCalledTimes(2);
    expect(completion).toHaveBeenCalledOnce();

    r.register(reg('wf_cancelled', { isBackgrounded: true }));
    r.cancel('wf_cancelled', 3_000);
    expect(bell).toHaveBeenCalledTimes(2);
    expect(completion).toHaveBeenCalledOnce();

    r.register(reg('wf_shutdown', { isBackgrounded: true }));
    r.abortAll();
    expect(bell).toHaveBeenCalledTimes(2);
    expect(completion).toHaveBeenCalledOnce();

    r.setCompletionCallback(undefined);
    expect(r.hasCompletionCallback()).toBe(false);
  });

  it('emits one safe background failure completion and isolates callback errors', () => {
    const r = new WorkflowRunRegistry();
    r.setNotificationCallback(() => {
      throw new Error('bell subscriber failed');
    });
    const completion = vi.fn((_displayText: string, _modelText: string) => {
      throw new Error('completion subscriber failed');
    });
    r.setCompletionCallback(completion);
    r.register(reg('wf_bad_background', { isBackgrounded: true }));

    expect(() =>
      r.fail('wf_bad_background', 'boom <unsafe>', 1_000),
    ).not.toThrow();
    expect(completion).toHaveBeenCalledOnce();
    expect(completion.mock.calls[0][1]).toContain(
      '<result>Error: boom &lt;unsafe&gt;</result>',
    );
  });

  it('degrades non-JSON background results without breaking settlement', () => {
    const r = new WorkflowRunRegistry();
    const completion = vi.fn();
    r.setCompletionCallback(completion);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    r.register(reg('wf_circular', { isBackgrounded: true }));

    expect(() => r.complete('wf_circular', circular, 1_000)).not.toThrow();
    expect(completion).toHaveBeenCalledOnce();
    expect(completion.mock.calls[0][1]).toContain(
      'workflow returned a non-JSON-serializable value of type object',
    );
  });

  it('captures the owning todo work chain for completion routing', () => {
    const r = new WorkflowRunRegistry();
    const completion = vi.fn();
    r.setCompletionCallback(completion);
    const entry = todoWorkChainContext.run('workflow-chain', () =>
      r.register(reg('wf_chain', { isBackgrounded: true })),
    );
    r.complete(entry.runId, 'done', 1_000);

    expect(entry.todoWorkChainId).toBe('workflow-chain');
    expect(completion.mock.calls[0][2].todoWorkChainId).toBe('workflow-chain');
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
