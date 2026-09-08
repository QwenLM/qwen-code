// @vitest-environment jsdom

import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { EnvironmentPanel } from './EnvironmentPanel';
import type { SourcesState } from './SourcesSection';

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

const uploadedFiles = [
  {
    type: 'resource' as const,
    attachmentId: 'notes.txt',
    mimeType: 'text/plain',
    size: 5,
  },
  {
    type: 'resource' as const,
    attachmentId: 'historical.html',
    mimeType: 'text/html',
    size: 12,
  },
];

function sourceState(): SourcesState {
  return {
    supported: true,
    sources: [
      {
        id: 'registered',
        title: 'Reference notes',
        kind: 'file',
        locator: { type: 'attachment', attachmentId: 'notes.txt' },
        createdAt: '2026-09-07T00:00:00Z',
        updatedAt: '2026-09-07T00:00:00Z',
      },
      {
        id: 'link',
        title: 'Website',
        kind: 'link',
        locator: { type: 'url', url: 'https://example.com' },
        createdAt: '2026-09-07T00:00:00Z',
        updatedAt: '2026-09-07T00:00:00Z',
      },
    ],
    owner: { isCurrent: () => true },
    revision: 2,
    hydrated: true,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
  };
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

  it('opens the agent workflow from the subagent section', () => {
    const onOpenAgentWorkflow = vi.fn();
    const view = mount({
      tasks: [
        {
          kind: 'agent',
          id: 'agent-1',
          label: 'Reviewer',
          description: 'Review code',
          status: 'completed',
          startTime: 1,
          runtimeMs: 1,
          isBackgrounded: true,
        },
      ],
      onOpenAgentWorkflow,
    });

    const button = view.querySelector<HTMLButtonElement>(
      'button[aria-label="Open agent workflow"]',
    );
    act(() => button?.click());
    expect(onOpenAgentWorkflow).toHaveBeenCalledOnce();
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

  it('lists uploaded images and files under Sources without source support', async () => {
    const onImagePreview = vi.fn();
    const onAttachmentPreview = vi.fn();
    const onReadImage = vi.fn(async () => 'data:image/png;base64,AQID');
    const view = mount({
      attachments: [
        {
          type: 'image',
          attachmentId: 'photo.png',
          mimeType: 'image/png',
          size: 3,
        },
        {
          type: 'resource',
          attachmentId: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
        },
      ],
      onReadImage,
      onImagePreview,
      onAttachmentPreview,
    });

    const section = view.querySelector('[data-testid="sources-section"]');
    expect(section?.textContent).toContain('Sources');
    expect(section?.textContent).not.toContain('Attachments');
    expect(section?.querySelector('[aria-label="Add source"]')).toBeNull();
    expect(view.textContent).toContain('notes.txt');
    expect(view.querySelector('img')).toBeNull();
    expect(onReadImage).not.toHaveBeenCalled();

    const imageRow = Array.from(view.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('photo.png'),
    );
    await act(async () => imageRow?.click());
    expect(onReadImage).toHaveBeenCalledWith('photo.png');
    expect(onImagePreview).toHaveBeenCalledWith(
      'data:image/png;base64,AQID',
      'photo.png',
      { kind: 'attachment', attachmentId: 'photo.png' },
    );

    const fileRow = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('notes.txt'),
    );
    act(() => fileRow?.click());
    expect(onAttachmentPreview).toHaveBeenCalledWith({
      name: 'notes.txt',
      mimeType: 'text/plain',
      attachmentId: 'notes.txt',
    });
  });

  it('hides the attachments section when the session has none', () => {
    const view = mount();

    expect(view.textContent).not.toContain('Attachments');
    expect(view.textContent).toContain('Artifacts');
  });

  it('does not read an image until its name is clicked', async () => {
    const error = new Error('attachment gone');
    const onReadImage = vi.fn(async () => {
      throw error;
    });
    const onAttachmentPreviewError = vi.fn();
    const view = mount({
      attachments: [
        {
          type: 'image',
          attachmentId: 'photo.png',
          mimeType: 'image/png',
          size: 3,
        },
      ],
      onReadImage,
      onAttachmentPreviewError,
    });

    expect(onReadImage).not.toHaveBeenCalled();
    expect(view.querySelector('img')).toBeNull();

    const imageRow = Array.from(view.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('photo.png'),
    );
    await act(async () => imageRow?.click());
    expect(onAttachmentPreviewError).toHaveBeenCalledWith(error);
  });

  it.each([
    { items: ['sources'] as const },
    { items: ['sources', 'attachments'] as const },
  ])('merges registered and historical files once with $items', ({ items }) => {
    const sources = sourceState();
    const onOpenSource = vi.fn();
    const view = mount({
      sources,
      items,
      attachments: uploadedFiles,
      onOpenSource,
    });
    const section = view.querySelector('[data-testid="sources-section"]');
    expect(
      view.querySelectorAll('[data-testid="sources-section"]'),
    ).toHaveLength(1);
    expect(section?.querySelector('h3')?.textContent).toBe('Sources 3');
    expect(section?.querySelectorAll('li')).toHaveLength(3);
    expect(section?.textContent).toContain('Reference notes');
    expect(section?.textContent).toContain('historical.html');
    const row = section?.querySelector<HTMLButtonElement>(
      '[aria-label="Open source Reference notes"]',
    );
    act(() => row?.click());
    expect(onOpenSource).toHaveBeenCalledWith(sources.sources[0]);
    expect(sources.upsert).not.toHaveBeenCalled();
    expect(section?.querySelector('[aria-label^="Remove"]')).toBeNull();
  });

  it('does not repeat the filename when the registered title matches its location', () => {
    const state = sourceState();
    const view = mount({
      sources: {
        ...state,
        sources: [{ ...state.sources[0]!, title: 'notes.txt' }],
      },
      attachments: uploadedFiles,
    });
    expect(
      view.querySelector('[aria-label="Open source notes.txt"]')?.textContent,
    ).toBe('notes.txt');
  });

  it.each([1, 2, 3])(
    'shows all %i unique sources without an expand or collapse button',
    (count) => {
      const state = sourceState();
      const view = mount({
        sources: { ...state, sources: state.sources.slice(0, count) },
        attachments: count === 3 ? [...uploadedFiles, uploadedFiles[1]!] : [],
      });
      const section = view.querySelector('[data-testid="sources-section"]');

      expect(section?.querySelector('h3')?.textContent).toBe(
        `Sources ${count}`,
      );
      expect(section?.querySelectorAll('li')).toHaveLength(count);
      expect(section?.textContent).not.toContain('View all');
      expect(section?.textContent).not.toContain('Collapse');
    },
  );

  it('expands four unique sources and collapses them back to the first three', () => {
    const view = mount({
      sources: sourceState(),
      attachments: [
        ...uploadedFiles,
        uploadedFiles[1]!,
        {
          type: 'resource',
          attachmentId: 'fourth.txt',
          mimeType: 'text/plain',
          size: 4,
        },
      ],
    });
    const section = view.querySelector('[data-testid="sources-section"]')!;
    const rows = () =>
      Array.from(section.querySelectorAll('li'), (row) => row.textContent);
    const toggle = Array.from(section.querySelectorAll('button')).find(
      (button) => button.textContent === 'View all',
    )!;

    expect(section.querySelector('h3')?.textContent).toBe('Sources 4');
    expect(rows()).toEqual(['Reference notes', 'Website', 'historical.html']);
    expect(toggle).toBeDefined();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    act(() => toggle.click());

    expect(rows()).toEqual([
      'Reference notes',
      'Website',
      'historical.html',
      'fourth.txt',
    ]);
    expect(toggle.textContent).toBe('Collapse');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    act(() => toggle.click());

    expect(rows()).toEqual(['Reference notes', 'Website', 'historical.html']);
    expect(toggle.textContent).toBe('View all');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('bounds the default source title without shortening its location', async () => {
    const state = sourceState();
    const view = mount({ sources: state });
    await act(async () =>
      view
        .querySelector<HTMLButtonElement>('[aria-label="Add source"]')
        ?.click(),
    );
    const location = document.querySelector<HTMLInputElement>(
      'input[placeholder="docs/requirements.md"]',
    )!;
    const path = 'a'.repeat(250);
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(location, path);
      location.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(state.upsert).toHaveBeenCalledWith({
      title: 'a'.repeat(200),
      locator: { type: 'workspace_file', workspacePath: path },
    });
  });

  it('releases a floating panel after source capability disappears while adding', async () => {
    const state = sourceState();
    const onDismiss = vi.fn();
    const view = mount({ sources: state, floating: true, onDismiss });
    await act(async () =>
      view
        .querySelector<HTMLButtonElement>('[aria-label="Add source"]')
        ?.click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      Array.from(document.querySelectorAll('option')).map(
        (option) => option.value,
      ),
    ).toEqual(['workspace_file', 'url']);
    act(() =>
      root?.render(
        <I18nProvider language="en">
          <EnvironmentPanel
            tasks={[]}
            onOpenTask={vi.fn()}
            sources={{ ...state, supported: false }}
            attachments={uploadedFiles}
            floating
            onDismiss={onDismiss}
          />
        </I18nProvider>,
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() =>
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('keeps the legacy attachments option limited to uploaded files', () => {
    const view = mount({
      sources: sourceState(),
      items: ['attachments'],
      attachments: uploadedFiles,
    });
    const section = view.querySelector('[data-testid="sources-section"]');
    expect(section?.querySelector('h3')?.textContent).toBe('Sources 2');
    expect(section?.textContent).toContain('notes.txt');
    expect(section?.textContent).not.toContain('Reference notes');
    expect(section?.textContent).not.toContain('Website');
    expect(section?.querySelector('[aria-label="Add source"]')).toBeNull();
  });

  it('retains uploaded files after registration is removed without registering them again', () => {
    const sources = sourceState();
    const onAttachmentPreview = vi.fn();
    const view = mount({ sources, attachments: uploadedFiles });
    act(() =>
      root?.render(
        <I18nProvider language="en">
          <EnvironmentPanel
            tasks={[]}
            onOpenTask={vi.fn()}
            sources={{ ...sources, sources: [] }}
            attachments={uploadedFiles}
            onAttachmentPreview={onAttachmentPreview}
          />
        </I18nProvider>,
      ),
    );
    expect(view.textContent).not.toContain('Reference notes');
    expect(view.textContent).toContain('notes.txt');
    const row = view.querySelector<HTMLButtonElement>('[title="notes.txt"]');
    act(() => row?.click());
    expect(onAttachmentPreview).toHaveBeenCalledWith({
      name: 'notes.txt',
      mimeType: 'text/plain',
      attachmentId: 'notes.txt',
    });
    expect(sources.upsert).not.toHaveBeenCalled();
  });

  it('keeps either material list visible during partial loading and errors', () => {
    const sources = sourceState();
    const onRetryAttachments = vi.fn();
    const view = mount({
      sources: {
        ...sources,
        loading: true,
        error: 'Source listing unavailable',
      },
      attachments: uploadedFiles,
      attachmentsLoading: true,
      attachmentsError: 'Upload listing unavailable',
      onRetryAttachments,
    });
    expect(view.textContent).toContain('Reference notes');
    expect(view.textContent).toContain('historical.html');
    expect(view.textContent).toContain('Source listing unavailable');
    expect(view.textContent).toContain('Upload listing unavailable');
    expect(view.querySelector('[role="status"]')).toBeNull();
    const alerts = view.querySelectorAll('[role="alert"]');
    act(() => alerts[1]?.querySelector<HTMLButtonElement>('button')?.click());
    expect(onRetryAttachments).toHaveBeenCalledOnce();
  });

  it('lists artifacts in a separate expanded section', () => {
    const onOpenArtifact = vi.fn();
    const view = mount({
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'document',
          storage: 'workspace',
          source: 'tool',
          status: 'available',
          title: 'report.md',
          workspacePath: 'reports/report.md',
          retention: 'restorable',
          clientRetained: false,
          createdAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      onOpenArtifact,
    });

    expect(view.textContent).toContain('Artifacts');
    expect(view.textContent).toContain('report.md');
    const row = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('report.md'),
    );
    act(() => row?.click());
    expect(onOpenArtifact).toHaveBeenCalledWith('artifact-1');
  });

  it('describes the empty artifacts section', () => {
    const view = mount({ artifacts: [] });

    expect(view.textContent).toContain(
      'Artifacts generated in this session will appear here.',
    );
  });

  it('shows placeholders while attachments and artifacts load', () => {
    const view = mount({
      attachmentsLoading: true,
      artifactsLoading: true,
    });

    expect(view.textContent).toContain('Sources');
    expect(view.textContent).toContain('Artifacts');
    expect(
      view.querySelectorAll('[data-testid="environment-file-list-skeleton"]'),
    ).toHaveLength(2);
  });
});
