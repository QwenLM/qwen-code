// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { WebShellTranscript } from './WebShellTranscript';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function block(
  value: Omit<
    DaemonTranscriptBlock,
    'clientReceivedAt' | 'createdAt' | 'updatedAt'
  >,
  timestamp = 1,
): DaemonTranscriptBlock {
  return {
    ...value,
    clientReceivedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as DaemonTranscriptBlock;
}

function render(node: ReactNode): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  container.style.height = '640px';
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  const entry = { root, container };
  mounted.push(entry);
  return {
    container,
    unmount() {
      const index = mounted.indexOf(entry);
      if (index >= 0) mounted.splice(index, 1);
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('WebShellTranscript DOM integration', () => {
  it('renders representative transcript blocks without daemon providers', () => {
    const blocks: DaemonTranscriptBlock[] = [
      block({ id: 'u1', kind: 'user', text: 'Inspect the project' }, 1),
      block({ id: 't1', kind: 'thought', text: 'Thinking through it' }, 2),
      block(
        {
          id: 'tool1',
          kind: 'tool',
          toolCallId: 'call1',
          title: 'Read package file',
          toolName: 'read_file',
          status: 'completed',
          preview: { kind: 'file_read', path: 'package.json' },
          rawOutput: 'package contents',
        },
        3,
      ),
      block(
        {
          id: 'agent1',
          kind: 'tool',
          toolCallId: 'agent-call-1',
          title: 'Explore the codebase',
          toolName: 'Task',
          status: 'completed',
          preview: { kind: 'generic' },
          rawInput: { subagent_type: 'Explore', prompt: 'Find the entrypoint' },
          rawOutput: 'Found the entrypoint',
        },
        4,
      ),
      block({ id: 'a1', kind: 'assistant', text: '**Finished** reading.' }, 5),
      block(
        {
          id: 'p1',
          kind: 'status',
          text: `plan: ${JSON.stringify({
            sessionUpdate: 'plan',
            entries: [{ content: 'Verify the design', status: 'in_progress' }],
          })}`,
        },
        6,
      ),
      block({ id: 's1', kind: 'status', text: 'Historical status' }, 7),
      block({ id: 'e1', kind: 'error', text: 'Historical error' }, 8),
      block({ id: 'c1', kind: 'prompt_cancelled' }, 9),
    ];
    const { container } = render(
      <WebShellTranscript
        blocks={blocks}
        collapseCompletedTurns={false}
        language="en"
      />,
    );

    expect(container.textContent).toContain('Inspect the project');
    expect(container.textContent).toContain('Thinking through it');
    expect(container.textContent).toContain('Read package file');
    expect(container.textContent).toContain('Explore the codebase');
    expect(container.textContent).toContain('Finished');
    expect(container.textContent).toContain('Verify the design');
    expect(container.textContent).toContain('Historical status');
    expect(container.textContent).toContain('Historical error');
    expect(container.textContent).toContain('You cancelled this request');
  });

  it('omits pending permissions and AskUserQuestion controls', () => {
    const blocks: DaemonTranscriptBlock[] = [
      block({ id: 'u1', kind: 'user', text: 'Before permission' }),
      block({
        id: 'permission',
        kind: 'permission',
        requestId: 'request-1',
        title: 'Choose a deployment target',
        options: [
          { optionId: 'staging', label: 'Staging', raw: {} },
          { optionId: 'production', label: 'Production', raw: {} },
        ],
        toolCall: { toolCallId: 'ask-1', kind: 'think' },
        preview: {
          kind: 'ask_user_question',
          questions: [
            {
              header: 'Target',
              question: 'Where should this deploy?',
              options: [
                { label: 'Staging', raw: {} },
                { label: 'Production', raw: {} },
              ],
              raw: {},
            },
          ],
        },
      }),
    ];
    const { container } = render(<WebShellTranscript blocks={blocks} />);

    expect(container.textContent).toContain('Before permission');
    expect(container.textContent).not.toContain('Where should this deploy?');
    expect(container.textContent).not.toContain('Production');
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it('renders the historical result when AskUserQuestion has a tool block', () => {
    const blocks: DaemonTranscriptBlock[] = [
      block({
        id: 'permission',
        kind: 'permission',
        requestId: 'request-1',
        title: 'Ask user 1 question',
        options: [{ optionId: 'submit', label: 'Submit', raw: {} }],
        toolCall: {
          toolCallId: 'ask-1',
          kind: 'think',
          rawInput: {
            questions: [
              {
                header: 'Target',
                question: 'Where should this deploy?',
                options: [{ label: 'Staging' }, { label: 'Production' }],
              },
            ],
          },
        },
        preview: { kind: 'generic' },
        resolved: 'selected:submit',
      }),
      block(
        {
          id: 'ask-result',
          kind: 'tool',
          toolCallId: 'ask-1',
          title: 'ask_user_question',
          toolName: 'ask_user_question',
          status: 'completed',
          preview: { kind: 'generic' },
          rawOutput: 'User answer: Staging',
        },
        2,
      ),
    ];
    const { container } = render(
      <WebShellTranscript blocks={blocks} collapseCompletedTurns={false} />,
    );

    expect(container.textContent).toContain('Ask user 1 question');
    expect(container.textContent).toContain('User answer: Staging');
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it('keeps MessageList turn expansion as a local viewing interaction', () => {
    const { container } = render(
      <WebShellTranscript
        blocks={[
          block({ id: 'u1', kind: 'user', text: 'Collapsed turn' }, 1),
          block({ id: 't1', kind: 'thought', text: 'Hidden reasoning' }, 2),
          block({ id: 'a1', kind: 'assistant', text: 'Final answer' }, 3),
        ]}
      />,
    );
    const toggle = container.querySelector('[data-testid="toggle-u1"]');
    const row = toggle?.closest('[role="button"]');
    const reasoning = Array.from(container.querySelectorAll('*')).find(
      (element) => element.textContent === 'Hidden reasoning',
    );
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    expect(reasoning?.closest('[data-collapsed="true"]')).not.toBeNull();

    act(() => {
      row?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(row?.getAttribute('aria-expanded')).toBe('true');
    expect(reasoning?.closest('[data-collapsed="true"]')).toBeNull();
  });

  it('suppresses session and goal events while preserving their text', () => {
    const sessionEvents: unknown[] = [];
    const goalEvents: unknown[] = [];
    const onSession = (event: Event) =>
      sessionEvents.push((event as CustomEvent).detail);
    const onGoal = (event: Event) =>
      goalEvents.push((event as CustomEvent).detail);
    window.addEventListener('qwen:open-session', onSession);
    window.addEventListener('web-shell-goal-status-active', onGoal);
    const { container } = render(
      <WebShellTranscript
        blocks={[
          block({
            id: 'assistant',
            kind: 'assistant',
            text: '[Open child](qwen-session://child-session)',
          }),
          block(
            {
              id: 'goal',
              kind: 'status',
              text: '',
              source: 'goal',
              data: {
                kind: 'set',
                condition: 'All checks pass',
                setAt: 1,
              },
            },
            2,
          ),
        ]}
        collapseCompletedTurns={false}
      />,
    );

    const sessionText = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'Open child',
    );
    expect(sessionText).not.toBeUndefined();
    expect(container.querySelector('a[role="button"]')).toBeNull();
    expect(container.textContent).toContain('All checks pass');
    expect(sessionEvents).toEqual([]);
    expect(goalEvents).toEqual([]);
    window.removeEventListener('qwen:open-session', onSession);
    window.removeEventListener('web-shell-goal-status-active', onGoal);
  });

  it('mounts a themed scoped portal root and removes it on unmount', () => {
    const { container, unmount } = render(
      <WebShellTranscript blocks={[]} theme="light" language="zh-CN" />,
    );
    const root = container.querySelector<HTMLElement>('[data-web-shell-root]');
    const portal = document.body.querySelector<HTMLElement>(
      '[data-web-shell-portal-root]',
    );
    expect(root?.lang).toBe('zh-CN');
    expect(root?.classList.contains('dark')).toBe(false);
    expect(portal?.dataset.webShellShadcn).toBe('');
    expect(portal?.lang).toBe('zh-CN');
    expect(portal?.classList.contains('dark')).toBe(false);

    unmount();
    expect(
      document.body.querySelector('[data-web-shell-portal-root]'),
    ).toBeNull();
  });

  it('falls back to the built-in Markdown renderer when customization throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <WebShellTranscript
        blocks={[
          block({
            id: 'assistant',
            kind: 'assistant',
            text: 'Before\n\n```ts\nconst value = 1;\n```\n\nAfter',
          }),
        ]}
        markdown={{
          renderCodeBlock() {
            throw new Error('custom renderer failed');
          },
        }}
      />,
    );
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('const value = 1;');
    expect(container.textContent).toContain('After');
  });
});
