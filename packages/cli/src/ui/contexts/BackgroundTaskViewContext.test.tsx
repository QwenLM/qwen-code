/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Config, WorkflowTask } from '@qwen-code/qwen-code-core';
import {
  BackgroundTaskViewActionsContext,
  BackgroundTaskViewProvider,
  BackgroundTaskViewStateContext,
  useBackgroundTaskViewActions,
  useBackgroundTaskViewState,
} from './BackgroundTaskViewContext.js';

const workflowEntry = (pendingApprovalIds: string[] = []): WorkflowTask =>
  ({
    id: 'wf-1',
    kind: 'workflow',
    runId: 'wf-1',
    description: 'demo',
    meta: null,
    status: 'running',
    startTime: 100,
    pendingApprovals: pendingApprovalIds.map((approvalId) => ({
      approvalId,
      subagentId: 'sub-1',
      callId: `call-${approvalId}`,
      name: 'Shell',
      description: 'run',
      confirmationDetails: { type: 'exec' },
      at: 1_700_000_000_000,
    })),
  }) as unknown as WorkflowTask;

const agentTask = () =>
  ({
    id: 'a1',
    kind: 'agent',
    agentId: 'a1',
    description: 'desc',
    isBackgrounded: true,
    status: 'running',
    startTime: 200,
    abortController: new AbortController(),
    outputFile: '/tmp/a.jsonl',
    outputOffset: 0,
    notified: false,
  }) as unknown as Record<string, unknown>;

function makeConfig(workflows: () => WorkflowTask[]) {
  let approvalRequestCb: (() => void) | undefined;
  let approvalChangeCb: (() => void) | undefined;
  const workflowReg = {
    setStatusChangeCallback: vi.fn(),
    setApprovalChangeCallback: vi.fn((next: (() => void) | undefined) => {
      approvalChangeCb = next;
    }),
    setApprovalRequestCallback: vi.fn((next: (() => void) | undefined) => {
      approvalRequestCb = next;
    }),
    list: workflows,
  };
  const emptyReg = () => ({
    setStatusChangeCallback: vi.fn(),
    setApprovalChangeCallback: vi.fn(),
    getAll: () => [],
  });
  const config = {
    getBackgroundTaskRegistry: () => ({
      ...emptyReg(),
      getAll: () => [agentTask()],
    }),
    getBackgroundShellRegistry: emptyReg,
    getMonitorRegistry: emptyReg,
    getWorkflowRunRegistry: () => workflowReg,
    getMemoryManager: () => ({
      subscribe: vi.fn(() => vi.fn()),
      listTasksByType: () => [],
    }),
    getProjectRoot: () => '/test/project',
  } as unknown as Config;
  return {
    config,
    fireApprovalRequest: () => approvalRequestCb?.(),
    fireApprovalChange: () => approvalChangeCb?.(),
  };
}

describe('BackgroundTaskViewProvider approval surfacing', () => {
  it('surfaces a parked workflow approval in list mode exactly once', () => {
    // A workflow approval can only be answered from the detail view; a
    // footer badge the user has to hunt for leaves the run blocked
    // forever. The provider must promote the parked approval to a
    // selected row — and must not re-open the dialog every time the
    // entry refreshes after the user closed it. Auto-open stays in list
    // mode: detail would arm the tool confirmation, and a stray Enter
    // aimed at the unmounted composer would approve the command
    // (#16432 R1-2).
    let workflows: WorkflowTask[] = [workflowEntry()];
    const { config, fireApprovalRequest, fireApprovalChange } = makeConfig(
      () => workflows,
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <BackgroundTaskViewProvider config={config}>
        {children}
      </BackgroundTaskViewProvider>
    );
    const { result } = renderHook(
      () => ({
        state: useBackgroundTaskViewState(),
        actions: useBackgroundTaskViewActions(),
      }),
      { wrapper },
    );

    expect(result.current.state.dialogMode).toBe('closed');
    // Agent (startTime 200) sorts above the workflow (100).
    expect(result.current.state.entries.map((e) => e.kind)).toEqual([
      'agent',
      'workflow',
    ]);

    workflows = [workflowEntry(['wfap-1'])];
    act(() => fireApprovalRequest());

    expect(result.current.state.dialogMode).toBe('list');
    expect(result.current.state.selectedIndex).toBe(1);
    expect(result.current.state.dialogOpen).toBe(true);

    // Closing must stick: a later refresh that still carries the same
    // parked approval cannot bounce the user back into the dialog.
    act(() => result.current.actions.closeDialog());
    expect(result.current.state.dialogMode).toBe('closed');
    act(() => fireApprovalChange());
    expect(result.current.state.dialogMode).toBe('closed');

    // A genuinely new approval is a new prompt and surfaces again.
    act(() => {
      workflows = [
        {
          ...workflowEntry(['wfap-2']),
        } as unknown as WorkflowTask,
      ];
      fireApprovalRequest();
    });
    expect(result.current.state.dialogMode).toBe('list');
  });

  it('surfaces a later approval parked behind an already-surfaced one', () => {
    // R1-1: a single-id latch keyed on the first pending entry's head
    // masked every later approval while that head stayed parked. Each
    // approvalId must get its own prompt, on its own entry's row.
    const newer = {
      ...workflowEntry(['wfap-new']),
      id: 'wf-new',
      runId: 'wf-new',
      startTime: 300,
    } as unknown as WorkflowTask;
    const older = {
      ...workflowEntry(),
      id: 'wf-old',
      runId: 'wf-old',
      startTime: 50,
    } as unknown as WorkflowTask;
    let workflows: WorkflowTask[] = [newer, older];
    const { config, fireApprovalRequest } = makeConfig(() => workflows);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <BackgroundTaskViewProvider config={config}>
        {children}
      </BackgroundTaskViewProvider>
    );
    const { result } = renderHook(
      () => ({
        state: useBackgroundTaskViewState(),
        actions: useBackgroundTaskViewActions(),
      }),
      { wrapper },
    );

    // Newest-first: newer workflow (300), agent (200), older workflow (50).
    expect(result.current.state.dialogMode).toBe('list');
    expect(result.current.state.selectedIndex).toBe(0);

    // Back out without answering; wfap-new stays parked.
    act(() => result.current.actions.closeDialog());
    expect(result.current.state.dialogMode).toBe('closed');

    // The older run parks its own approval: it must surface on its row,
    // not stay hidden behind the latched head of the newer entry.
    act(() => {
      workflows = [
        newer,
        {
          ...workflowEntry(['wfap-old']),
          id: 'wf-old',
          runId: 'wf-old',
          startTime: 50,
        } as unknown as WorkflowTask,
      ];
      fireApprovalRequest();
    });
    expect(result.current.state.dialogMode).toBe('list');
    expect(result.current.state.selectedIndex).toBe(2);
  });

  it('exposes the state and actions contexts to consumers', () => {
    const { config } = makeConfig(() => []);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <BackgroundTaskViewProvider config={config}>
        {children}
      </BackgroundTaskViewProvider>
    );
    const { result } = renderHook(
      () => ({
        state: useBackgroundTaskViewState(),
        actions: useBackgroundTaskViewActions(),
      }),
      { wrapper },
    );
    expect(result.current.state.entries.map((e) => e.kind)).toEqual(['agent']);
    expect(result.current.actions.openDialog).toBeTypeOf('function');
    expect(BackgroundTaskViewStateContext).toBeDefined();
    expect(BackgroundTaskViewActionsContext).toBeDefined();
  });
});
