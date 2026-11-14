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
    cancel: vi.fn(),
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
    act(() => result.current.actions.acknowledgeAutoOpen());
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
    act(() => result.current.actions.acknowledgeAutoOpen());
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

  it('latches only the displayable queue head, not approvals parked behind it', () => {
    // The detail view renders pendingApprovals[0] only. Latching a later
    // approval marks it surfaced without ever displaying it: once the
    // head drains unanswered, the "already surfaced" tail never
    // auto-prompts — the exact hang this surfacing exists to remove.
    let workflows: WorkflowTask[] = [workflowEntry(['wfap-a'])];
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

    // a parks → auto-open; the user backs out without answering.
    expect(result.current.state.dialogMode).toBe('list');
    act(() => result.current.actions.acknowledgeAutoOpen());
    act(() => result.current.actions.closeDialog());
    expect(result.current.state.dialogMode).toBe('closed');

    // b parks behind the still-parked head a: nothing new is displayable,
    // so the dialog must stay closed and b must not be latched.
    act(() => {
      workflows = [workflowEntry(['wfap-a', 'wfap-b'])];
      fireApprovalRequest();
    });
    expect(result.current.state.dialogMode).toBe('closed');

    // a leaves the queue unanswered; b becomes the displayable head and
    // must get its own auto-prompt.
    act(() => {
      workflows = [workflowEntry(['wfap-b'])];
      fireApprovalChange();
    });
    expect(result.current.state.dialogMode).toBe('list');
    expect(result.current.state.selectedIndex).toBe(1);
  });

  it.each(['insert newer run', 'complete newer run'])(
    'keeps the surfaced workflow selected when registry updates %s',
    (scenario) => {
      const target = workflowEntry(['approval-target']);
      const newer = {
        ...workflowEntry(),
        id: 'wf-newer',
        runId: 'wf-newer',
        startTime: 300,
      } as WorkflowTask;
      let workflows =
        scenario === 'complete newer run' ? [newer, target] : [target];
      const { config, fireApprovalChange } = makeConfig(() => workflows);
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

      act(() => {
        workflows = [
          scenario === 'complete newer run'
            ? { ...newer, status: 'completed', endTime: 400 }
            : newer,
          target,
        ];
        fireApprovalChange();
      });

      const { entries, selectedIndex } = result.current.state;
      expect(entries[selectedIndex]).toMatchObject({ runId: 'wf-1' });
      expect(result.current.state.autoOpened).toBe(true);
      act(() => result.current.actions.acknowledgeAutoOpen());
      act(() => result.current.actions.cancelSelected());
      expect(config.getWorkflowRunRegistry().cancel).toHaveBeenCalledWith(
        'wf-1',
        expect.any(Number),
      );
    },
  );

  it('keeps the task selected when opening from the footer before a reorder', () => {
    let workflows: WorkflowTask[] = [];
    const { config, fireApprovalChange } = makeConfig(() => workflows);
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

    act(() => result.current.actions.openDialog());
    expect(result.current.state.selectedIndex).toBe(0);
    expect(result.current.state.entries[0]).toMatchObject({ agentId: 'a1' });

    act(() => {
      workflows = [{ ...workflowEntry(), startTime: 300 }];
      fireApprovalChange();
    });

    expect(result.current.state.selectedIndex).toBe(1);
    expect(
      result.current.state.entries[result.current.state.selectedIndex],
    ).toMatchObject({ agentId: 'a1' });
  });

  it('falls back near the last displayed row after a reordered task is removed', () => {
    let workflows = [workflowEntry(['approval-target'])];
    const { config, fireApprovalChange } = makeConfig(() => workflows);
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
    expect(result.current.state.selectedIndex).toBe(1);

    act(() => {
      workflows = [
        ...workflows,
        ...[300, 400, 500].map((startTime) => ({
          ...workflowEntry(),
          id: `wf-${startTime}`,
          runId: `wf-${startTime}`,
          startTime,
        })),
      ];
      fireApprovalChange();
    });
    expect(result.current.state.selectedIndex).toBe(4);
    expect(result.current.state.entries[4]).toMatchObject({ runId: 'wf-1' });

    act(() => {
      workflows = workflows.filter((entry) => entry.runId !== 'wf-1');
      fireApprovalChange();
    });

    expect(result.current.state.selectedIndex).toBe(3);
    expect(result.current.state.entries[3]).toMatchObject({ agentId: 'a1' });
  });

  it('updates the selected identity through keyboard and explicit navigation', () => {
    let workflows = [workflowEntry(['approval-target'])];
    const { config, fireApprovalChange } = makeConfig(() => workflows);
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
    const selected = () =>
      result.current.state.entries[result.current.state.selectedIndex];

    act(() => result.current.actions.acknowledgeAutoOpen());
    act(() => result.current.actions.moveSelectionUp());
    expect(selected()).toMatchObject({ agentId: 'a1' });

    act(() => {
      workflows = [
        ...workflows,
        {
          ...workflowEntry(),
          id: 'wf-newer',
          runId: 'wf-newer',
          startTime: 300,
        },
      ];
      fireApprovalChange();
    });
    expect(selected()).toMatchObject({ agentId: 'a1' });
    act(() => result.current.actions.moveSelectionDown());
    expect(selected()).toMatchObject({ runId: 'wf-1' });
    act(() => result.current.actions.setSelectedIndex(0));
    expect(selected()).toMatchObject({ runId: 'wf-newer' });

    // Removing the chosen task retains the existing in-range fallback.
    act(() => {
      workflows = [workflowEntry(['approval-target'])];
      fireApprovalChange();
    });
    expect(result.current.state.selectedIndex).toBe(0);
    expect(selected()).toMatchObject({ agentId: 'a1' });
  });

  it('unfocuses the pill when an approval auto-opens the dialog', () => {
    // The pill subscribes on `pillFocused` alone: leaving it focused let its
    // Enter run openDialog() and clear the disarm the auto-open installed
    // (#16432 R3-2).
    let workflows: WorkflowTask[] = [];
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

    act(() => result.current.actions.setPillFocused(true));
    act(() => {
      workflows = [workflowEntry(['wfap-pill'])];
      fireApprovalRequest();
    });

    expect(result.current.state.dialogMode).toBe('list');
    expect(result.current.state.autoOpened).toBe(true);
    expect(result.current.state.pillFocused).toBe(false);
  });

  it('stays closed after an acknowledged close while another workflow is parked', () => {
    // `dialogMode` is an effect dependency, so the close itself re-ran the
    // surfacing effect and re-opened on the next parked head in the same
    // frame — with two parked workflows Escape looked broken (#16432 R3-5).
    let workflows: WorkflowTask[] = [];
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

    act(() => {
      workflows = [
        {
          ...workflowEntry(['wfap-a']),
          id: 'wf-a',
          runId: 'wf-a',
          startTime: 300,
        } as unknown as WorkflowTask,
        {
          ...workflowEntry(['wfap-b']),
          id: 'wf-b',
          runId: 'wf-b',
          startTime: 200,
        } as unknown as WorkflowTask,
      ];
      fireApprovalRequest();
    });
    expect(result.current.state.dialogMode).toBe('list');

    act(() => result.current.actions.acknowledgeAutoOpen());
    act(() => result.current.actions.closeDialog());
    expect(result.current.state.dialogMode).toBe('closed');

    // A refresh that still carries the same two parked heads must not
    // bounce the user back into the dialog.
    act(() => fireApprovalChange());
    expect(result.current.state.dialogMode).toBe('closed');
  });

  it('leaves an open detail view alone when a new approval parks', () => {
    // R2-3: pin the `dialogMode !== 'closed'` guard. Without it, any
    // registry refresh while the user is reading the dialog yanks them
    // back to the list and moves the selection out from under their next
    // keypress. Deleting the guard must turn this case red.
    let workflows: WorkflowTask[] = [];
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

    // The user opens the dialog themselves and reads the agent's detail.
    act(() => result.current.actions.openDialog());
    act(() => result.current.actions.enterDetail());
    expect(result.current.state.dialogMode).toBe('detail');
    expect(result.current.state.selectedIndex).toBe(0);

    // A workflow parks an approval mid-read: the refresh must not steal
    // the view or the selection.
    act(() => {
      workflows = [workflowEntry(['wfap-open'])];
      fireApprovalRequest();
    });
    expect(result.current.state.dialogMode).toBe('detail');
    expect(result.current.state.selectedIndex).toBe(0);
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
