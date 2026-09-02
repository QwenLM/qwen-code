// @vitest-environment jsdom

import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { EnvironmentPanel } from './EnvironmentPanel';

vi.mock('../BranchPickerPopover', async () => {
  const { createElement } = await import('react');
  return {
    BranchPickerPopover: ({
      children,
      open,
      onOpenChange,
      side,
      status,
    }: {
      children: ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
      side?: string;
      status?: { branch: string | null; operation?: string };
    }) =>
      createElement(
        'div',
        {
          'data-testid': 'branch-picker',
          'data-open': open,
          'data-side': side,
          'data-status-branch': status?.branch ?? undefined,
          'data-status-operation': status?.operation ?? undefined,
          onClick: () => onOpenChange(true),
        },
        children,
      ),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function mount(
  props: Partial<Parameters<typeof EnvironmentPanel>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <EnvironmentPanel
          workspaceCwd="/work/qwen-code"
          branch="feat/context-panels"
          gitStatus={{
            v: 2,
            workspaceCwd: '/work/qwen-code',
            branch: 'feat/context-panels',
            staged: 1,
            unstaged: 2,
            ahead: 1,
          }}
          tasks={[]}
          onOpenGitDiff={vi.fn()}
          onOpenAgent={vi.fn()}
          onOpenTask={vi.fn()}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return container;
}

function toggleSection(view: HTMLElement, label: string): void {
  const button = Array.from(
    view.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
  ).find((candidate) => candidate.textContent?.includes(label));
  act(() => button?.click());
}

describe('EnvironmentPanel', () => {
  it('shows supported workspace and Git context', () => {
    const view = mount();

    expect(view.textContent).toContain('qwen-code');
    expect(view.textContent).toContain('feat/context-panels');
    expect(view.textContent).toContain('1 staged');
    expect(view.textContent).toContain('2 modified');
    expect(view.textContent).toContain('1 ahead');

    toggleSection(view, 'Environment');
    expect(view.textContent).not.toContain('qwen-code');
  });

  it('keeps environment context visible when the working tree has no changes', () => {
    const view = mount({
      gitStatus: {
        v: 2,
        workspaceCwd: '/work/qwen-code',
        branch: 'feat/context-panels',
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
      },
    });

    expect(view.textContent).toContain('Environment');
    expect(view.textContent).toContain('Clean');
    expect(view.textContent).toContain('qwen-code');
    expect(view.textContent).toContain('feat/context-panels');
  });

  it('reports unavailable rather than clean when no Git snapshot exists', () => {
    const view = mount({ gitStatus: undefined });

    expect(view.textContent).toContain('Environment');
    expect(view.textContent).toContain('Unavailable');
    expect(view.textContent).not.toContain('Clean');
  });

  it('hands its git status to the branch picker for the action hints', () => {
    const view = mount({
      gitWorkspaceCwd: '/work/qwen-code',
      gitCwd: '/work/qwen-code',
      gitStatus: {
        v: 2,
        workspaceCwd: '/work/qwen-code',
        branch: 'feat/context-panels',
        operation: 'rebase',
        computedAt: 1,
      },
    });

    const picker = view.querySelector('[data-testid="branch-picker"]');
    expect(picker?.getAttribute('data-status-branch')).toBe(
      'feat/context-panels',
    );
    expect(picker?.getAttribute('data-status-operation')).toBe('rebase');
  });

  it('opens the branch actions without dismissing a floating panel', () => {
    const onDismiss = vi.fn();
    const view = mount({
      floating: true,
      gitWorkspaceCwd: '/work/qwen-code',
      gitCwd: '/work/qwen-code',
      onOpenGitCommit: vi.fn(),
      onDismiss,
    });
    const picker = view.querySelector('[data-testid="branch-picker"]');
    const branchButton = Array.from(view.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('feat/context-panels'),
    );

    expect(picker?.getAttribute('data-open')).toBe('false');
    expect(picker?.getAttribute('data-side')).toBe('left');
    act(() => branchButton?.click());
    expect(picker?.getAttribute('data-open')).toBe('true');

    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onDismiss).not.toHaveBeenCalled();

    toggleSection(view, 'Environment');
    toggleSection(view, 'Environment');
    expect(
      view
        .querySelector('[data-testid="branch-picker"]')
        ?.getAttribute('data-open'),
    ).toBe('false');
  });

  it('filters sections through environment-panel items', () => {
    const view = mount({
      items: ['subagents'],
      tasks: [
        {
          kind: 'agent',
          id: 'agent-1',
          label: 'Explore code',
          description: 'Inspect the repository',
          status: 'running',
          startTime: 1,
          runtimeMs: 10,
          isBackgrounded: true,
        },
        {
          kind: 'shell',
          id: 'shell-1',
          label: 'Build',
          description: 'Run build',
          status: 'running',
          startTime: 1,
          runtimeMs: 10,
          command: 'npm run build',
          cwd: '/work/qwen-code',
        },
      ],
    });

    expect(view.textContent).toContain('Subagents');
    expect(view.textContent).not.toContain('Environment');
    expect(view.textContent).not.toContain('Background tasks');
  });

  it('dismisses a floating panel when clicking outside', () => {
    const onDismiss = vi.fn();
    const view = mount({ floating: true, onDismiss });

    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledOnce();

    act(() => {
      view
        .querySelector<HTMLButtonElement>('button[aria-expanded]')
        ?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('lets the header toggle close a floating panel without dismissing first', () => {
    const onDismiss = vi.fn();
    mount({ floating: true, onDismiss });
    const toggle = document.createElement('button');
    toggle.dataset.webShellEnvironmentToggle = '';
    document.body.appendChild(toggle);

    act(() => {
      toggle.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(onDismiss).not.toHaveBeenCalled();
    toggle.remove();
  });

  it('shows agent, shell, and monitor task activity', () => {
    const tasks: DaemonSessionTaskStatus[] = [
      {
        kind: 'agent',
        id: 'agent-1',
        label: 'Explore code',
        description: 'Inspect the repository',
        status: 'completed',
        startTime: 1,
        runtimeMs: 10,
        isBackgrounded: true,
        toolUseId: 'tool-agent-1',
      },
      {
        kind: 'shell',
        id: 'shell-1',
        label: 'Build',
        description: 'Run build',
        status: 'failed',
        startTime: 1,
        runtimeMs: 10,
        command: 'npm run build',
        cwd: '/work/qwen-code',
      },
      {
        kind: 'monitor',
        id: 'monitor-1',
        label: 'Watch server',
        description: 'Development server',
        status: 'running',
        startTime: 1,
        runtimeMs: 10,
        command: 'npm run dev',
        eventCount: 0,
        lastEventTime: 1,
        droppedLines: 0,
      },
      {
        kind: 'shell',
        id: 'shell-2',
        label: 'Sleep',
        description: 'Wait',
        status: 'cancelled',
        startTime: 1,
        runtimeMs: 10,
        command: 'sleep 300',
        cwd: '/work/qwen-code',
      },
    ];
    const view = mount({ tasks });

    expect(view.querySelectorAll('button[aria-expanded="false"]')).toHaveLength(
      2,
    );
    expect(view.textContent).not.toContain('Explore code');

    toggleSection(view, 'Subagents');
    toggleSection(view, 'Background tasks');

    expect(
      view.querySelectorAll('button[aria-expanded="true"] svg'),
    ).toHaveLength(0);
    expect(view.textContent).toContain('Explore code');
    expect(view.textContent).toContain('npm run build');
    expect(view.textContent).toContain('Development server');
    const agentItem = Array.from(view.querySelectorAll('ul button')).find(
      (button) => button.textContent?.includes('Explore code'),
    );
    expect(agentItem?.firstElementChild?.querySelector('svg')).toBeNull();
    expect(
      agentItem?.querySelector(
        '[data-status="completed"] svg.lucide-circle-check',
      ),
    ).not.toBeNull();
    const completedItem = Array.from(view.querySelectorAll('ul button')).find(
      (button) => button.textContent?.includes('npm run build'),
    );
    expect(
      completedItem?.querySelector('svg.lucide-square-terminal'),
    ).not.toBeNull();
    expect(
      completedItem?.querySelector('[title="npm run build"]'),
    ).not.toBeNull();
    expect(
      completedItem?.querySelector(
        '[data-status="failed"] svg.lucide-circle-x',
      ),
    ).not.toBeNull();
    const monitorItem = Array.from(view.querySelectorAll('ul button')).find(
      (button) => button.textContent?.includes('Development server'),
    );
    expect(
      monitorItem?.querySelector('svg.lucide-square-activity'),
    ).not.toBeNull();
    expect(
      monitorItem?.querySelector(
        '[data-status="running"] svg.lucide-loader-circle',
      ),
    ).not.toBeNull();
    const cancelledItem = Array.from(view.querySelectorAll('ul button')).find(
      (button) => button.textContent?.includes('sleep 300'),
    );
    expect(
      cancelledItem?.querySelector(
        '[data-status="cancelled"] svg.lucide-circle-stop',
      ),
    ).not.toBeNull();
  });

  it('opens an out-of-band fork without a tool call id', () => {
    const onOpenAgent = vi.fn();
    const task = {
      kind: 'agent' as const,
      id: 'fork-agent-1',
      label: 'fork: Review current changes',
      description: 'Review current changes',
      subagentType: 'fork',
      color: 'purple',
      status: 'running' as const,
      startTime: 1,
      runtimeMs: 10,
      isBackgrounded: true,
    };
    const view = mount({ tasks: [task], onOpenAgent });

    toggleSection(view, 'Subagents');
    const item = Array.from(
      view.querySelectorAll<HTMLButtonElement>('ul button'),
    ).find((button) => button.textContent?.includes('Review current changes'));

    expect(item?.disabled).toBe(false);
    expect(item?.textContent).not.toContain('fork:');
    expect(item?.querySelector('span')?.textContent).toContain('fork');
    expect(item?.querySelector('[data-agent-color]')).toBeNull();
    act(() => item?.click());
    expect(onOpenAgent).toHaveBeenCalledWith(task);
  });

  it('shows the configured subagent color as a leading dot', () => {
    const view = mount({
      agentTasks: [
        {
          kind: 'agent',
          id: 'agent-1',
          label: 'Review code',
          description: 'Review code',
          color: 'purple',
          status: 'completed',
          startTime: 1,
          runtimeMs: 10,
          isBackgrounded: false,
        },
      ],
    });

    toggleSection(view, 'Subagents');

    const color = view.querySelector<HTMLElement>(
      '[data-agent-color="purple"]',
    );
    expect(color).not.toBeNull();
    expect(color?.style.backgroundColor).not.toBe('');
    expect(view.textContent).toContain('Review code');
  });

  it('shows a gray dot when the subagent has no configured color', () => {
    const view = mount({
      agentTasks: [
        {
          kind: 'agent',
          id: 'agent-1',
          label: 'Review code',
          description: 'Review code',
          status: 'completed',
          startTime: 1,
          runtimeMs: 10,
          isBackgrounded: false,
        },
      ],
    });

    toggleSection(view, 'Subagents');

    const color = view.querySelector<HTMLElement>(
      '[data-agent-color="default"]',
    );
    expect(color).not.toBeNull();
    expect(color?.style.backgroundColor).toBe('var(--muted-foreground)');
  });

  it('shows transcript agents when the live tasks snapshot is empty', () => {
    const agentTasks: DaemonSessionTaskStatus[] = [
      {
        kind: 'agent',
        id: 'tool-agent-1',
        label: 'Explore code',
        description: 'Inspect the repository',
        status: 'completed',
        startTime: 1,
        endTime: 2,
        runtimeMs: 1,
        isBackgrounded: false,
        toolUseId: 'tool-agent-1',
      },
    ];
    const view = mount({
      tasks: [],
      agentTasks: agentTasks.filter((task) => task.kind === 'agent'),
    });

    toggleSection(view, 'Subagents');

    expect(view.textContent).toContain('Explore code');
    expect(view.textContent).toContain('Completed');
  });

  it('numbers agents that have no usable name', () => {
    const agentTasks: DaemonSessionTaskStatus[] = [
      {
        kind: 'agent',
        id: 'agent-1',
        label: 'Agent',
        description: '',
        status: 'running',
        startTime: 1,
        runtimeMs: 10,
        isBackgrounded: true,
        toolUseId: 'tool-agent-1',
      },
      {
        kind: 'agent',
        id: 'agent-2',
        label: '',
        description: '',
        status: 'running',
        startTime: 1,
        runtimeMs: 10,
        isBackgrounded: true,
        toolUseId: 'tool-agent-2',
      },
    ];
    const view = mount({
      tasks: [],
      agentTasks: agentTasks.filter((task) => task.kind === 'agent'),
    });

    toggleSection(view, 'Subagents');

    expect(view.textContent).toContain('Agent (1)');
    expect(view.textContent).toContain('Agent (2)');
  });

  it('opens the existing environment actions', () => {
    const onOpenGitDiff = vi.fn();
    const onOpenAgent = vi.fn();
    const onOpenTask = vi.fn();
    const tasks: DaemonSessionTaskStatus[] = [
      {
        kind: 'agent',
        id: 'agent-1',
        label: 'Explore code',
        description: 'Inspect the repository',
        status: 'running',
        startTime: 1,
        runtimeMs: 10,
        isBackgrounded: true,
        toolUseId: 'tool-agent-1',
      },
      {
        kind: 'shell',
        id: 'shell-1',
        label: 'Build',
        description: 'Run build',
        status: 'running',
        startTime: 1,
        runtimeMs: 10,
        command: 'npm run build',
        cwd: '/work/qwen-code',
      },
    ];
    const view = mount({
      tasks,
      onOpenGitDiff,
      onOpenAgent,
      onOpenTask,
    });

    act(() => {
      for (const button of view.querySelectorAll<HTMLButtonElement>(
        'button[aria-expanded="false"]',
      )) {
        button.click();
      }
    });
    act(() => {
      for (const button of view.querySelectorAll<HTMLButtonElement>(
        'ul button',
      )) {
        button.click();
      }
    });

    expect(onOpenAgent).toHaveBeenCalledOnce();
    expect(onOpenTask).toHaveBeenCalledOnce();
  });
});
