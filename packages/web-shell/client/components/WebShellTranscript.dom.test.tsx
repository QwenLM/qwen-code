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
    expect(container.textContent).not.toContain('Thinking through it');
    const thinkingToggle = container.querySelector<HTMLButtonElement>(
      'button[title="Expand thinking"]',
    );
    expect(thinkingToggle).not.toBeNull();
    act(() => thinkingToggle?.click());
    expect(container.textContent).toContain('Thinking through it');
    expect(container.textContent).toContain('Read package file');
    expect(container.textContent).toContain('Explore the codebase');
    expect(container.textContent).toContain('Finished');
    expect(container.textContent).toContain('Verify the design');
    expect(container.textContent).toContain('Historical status');
    expect(container.textContent).toContain('Historical error');
    expect(container.textContent).toContain('You cancelled this request');
  });

  it('derives task detail from todo_write transcript snapshots', () => {
    const todoSnapshot = (
      id: string,
      status: 'in_progress' | 'completed',
      timestamp: number,
      stats: {
        promptTokens: number;
        cachedTokens: number;
        candidateTokens: number;
        apiTimeMs: number;
      },
    ) =>
      block(
        {
          id,
          kind: 'tool',
          toolCallId: `${id}-call`,
          title: 'Updated Plan',
          toolName: 'todo_write',
          toolKind: 'updated_plan',
          status: 'completed',
          preview: { kind: 'generic' },
          rawOutput: {
            entries: [
              {
                id: 'task-1',
                content: 'Prepare release',
                status,
              },
            ],
            stats,
          },
        },
        timestamp,
      );
    const { container } = render(
      <WebShellTranscript
        blocks={[
          todoSnapshot('todo-start', 'in_progress', 1000, {
            promptTokens: 100,
            cachedTokens: 10,
            candidateTokens: 20,
            apiTimeMs: 500,
          }),
          todoSnapshot('todo-done', 'completed', 5000, {
            promptTokens: 300,
            cachedTokens: 40,
            candidateTokens: 80,
            apiTimeMs: 1500,
          }),
        ]}
        collapseCompletedTurns={false}
        language="en"
      />,
    );

    const summaries = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((button) => button.textContent?.includes('Updated task list'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].textContent).toContain('2 times');
    act(() => {
      summaries[0].click();
    });
    const completedSnapshot = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((row) => row.textContent?.includes('1/1'))?.parentElement;
    expect(completedSnapshot).not.toBeNull();
    act(() => {
      completedSnapshot?.querySelector<HTMLElement>('[role="button"]')?.click();
    });
    const detailButton = completedSnapshot?.querySelector<HTMLButtonElement>(
      'button[title="Show task detail"]',
    );
    expect(detailButton).not.toBeNull();

    act(() => {
      detailButton?.click();
    });
    const detailText = completedSnapshot?.textContent ?? '';
    expect(detailText).toContain('Tokens');
    expect(detailText).toContain('200');
    expect(detailText).toContain('60');
    expect(detailText).toContain('30');
    expect(detailText).toContain('Time spent');
    expect(detailText).toContain('1.0s');
    expect(detailText).toContain('4.0s');
  });

  it('derives the transition introduced by each plan snapshot', () => {
    const planSnapshot = (
      id: string,
      firstStatus: 'in_progress' | 'completed',
      secondStatus: 'pending' | 'in_progress',
      timestamp: number,
    ) =>
      block(
        {
          id,
          kind: 'status',
          text: `plan: ${JSON.stringify({
            sessionUpdate: 'plan',
            entries: [
              {
                id: 'task-1',
                content: 'Prepare release',
                status: firstStatus,
              },
              {
                id: 'task-2',
                content: 'Run verification',
                status: secondStatus,
              },
            ],
          })}`,
        },
        timestamp,
      );
    const { container } = render(
      <WebShellTranscript
        blocks={[
          planSnapshot('plan-start', 'in_progress', 'pending', 1000),
          planSnapshot('plan-next', 'completed', 'in_progress', 5000),
        ]}
        collapseCompletedTurns={false}
        language="en"
      />,
    );

    const planHeaders = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((button) => button.textContent?.includes('Plan'));
    expect(planHeaders).toHaveLength(2);
    const secondSnapshotText = planHeaders[1].parentElement?.textContent ?? '';
    expect(secondSnapshotText).toContain('Prepare release');
    expect(secondSnapshotText).toContain('Run verification');
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

    expect(container.querySelector('[class*="chatBubble"]')).toBeNull();
    const summary = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    )!;
    expect(summary.textContent).toContain('Asked 1 question');
    act(() => summary.click());
    expect(container.textContent).toContain('User answer: Staging');
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it.each(['readonly', 'document'] as const)(
    'keeps question and multiline answers visible in %s mode',
    (renderMode) => {
      const questions = [
        { header: 'Choice', question: 'Which target?', options: [], raw: {} },
        { header: 'Choice', question: 'Which code?', options: [], raw: {} },
      ];
      const answer = '```ts\nconst value = 1;\nconsole.log(value);\n```';
      const text = `User has provided the following answers:\n\n**Choice**: Staging\n**Choice**: ${answer}`;
      const answers = [
        { question: 'Which target?', answer: 'Staging' },
        { question: 'Which code?', answer },
      ];
      const { container } = render(
        <WebShellTranscript
          renderMode={renderMode}
          blocks={[
            block({ id: 'u1', kind: 'user', text: 'Configure the project' }),
            block(
              {
                id: 'read',
                kind: 'tool',
                toolCallId: 'read-1',
                title: 'read_file',
                toolName: 'read_file',
                status: 'completed',
                preview: { kind: 'file_read', path: 'package.json' },
              },
              2,
            ),
            block(
              {
                id: 'ask',
                kind: 'tool',
                toolCallId: 'ask-1',
                title: 'ask_user_question',
                toolName: 'ask_user_question',
                status: 'completed',
                preview: { kind: 'ask_user_question', questions },
                rawInput: { questions },
                rawOutput: { type: 'ask_user_question_answers', text, answers },
                resultPreview: { kind: 'question_answers', text, answers },
              },
              3,
            ),
            block({ id: 'a1', kind: 'assistant', text: 'Configured.' }, 4),
          ]}
        />,
      );
      const bubble = container.querySelector(
        '[data-transcript-tool-call-id="ask-1"]',
      )!;
      expect(bubble).not.toBeNull();
      expect(
        [...bubble.querySelectorAll('dt')].map((el) => el.textContent),
      ).toEqual(['Which target?', 'Which code?']);
      expect(
        [...bubble.querySelectorAll('dd')].map((el) => el.textContent),
      ).toEqual(['Staging', answer]);
      expect(bubble.querySelector('button')).toBeNull();
      if (renderMode === 'readonly') {
        expect(
          container.querySelector('[data-transcript-tool-call-id="read-1"]'),
        ).toBeNull();
      }
    },
  );

  it.each([undefined, '', '   \n'])(
    'omits empty question bubbles: %s',
    (text) => {
      const { container } = render(
        <WebShellTranscript
          blocks={[
            block({
              id: 'ask',
              kind: 'tool',
              toolCallId: 'ask-1',
              toolName: 'ask_user_question',
              title: 'ask_user_question',
              status: 'completed',
              preview: { kind: 'generic' },
              rawOutput: text,
            }),
          ]}
        />,
      );
      expect(
        container.querySelector('[data-transcript-tool-call-id="ask-1"]'),
      ).toBeNull();
    },
  );

  it.each(['readonly', 'document'] as const)(
    'uses structured partial answers without parsing text in %s mode',
    (renderMode) => {
      const text = 'Display wording can change independently.';
      const answer = 'first\n**B**: embedded';
      const answers = [{ question: 'Question A?', answer }];
      const { container } = render(
        <WebShellTranscript
          renderMode={renderMode}
          blocks={[
            block({
              id: 'ask',
              kind: 'tool',
              toolCallId: 'ask-1',
              title: 'ask_user_question',
              toolName: 'ask_user_question',
              status: 'completed',
              preview: { kind: 'generic' },
              rawInput: { questions: [] },
              rawOutput: { type: 'ask_user_question_answers', text, answers },
              resultPreview: { kind: 'question_answers', text, answers },
            }),
          ]}
        />,
      );
      expect(
        [...container.querySelectorAll('dt')].map((el) => el.textContent),
      ).toEqual(['Question A?']);
      expect(
        [...container.querySelectorAll('dd')].map((el) => el.textContent),
      ).toEqual([answer]);
      expect(container.textContent).not.toContain(text);
    },
  );

  it.each([
    'User declined to answer the questions.',
    'User has provided the following answers:\n\nNo valid answers were provided.',
    'User has provided the following answers:\n\n**Target**: answer\n**Example**: literal answer text',
    'User has provided answers to all questions:\n\n**Target**: answer',
  ])('keeps unstructured results in the left tool display: %s', (text) => {
    const { container } = render(
      <WebShellTranscript
        blocks={[
          block({
            id: 'ask',
            kind: 'tool',
            toolCallId: 'ask-1',
            title: 'ask_user_question',
            toolName: 'ask_user_question',
            status: 'completed',
            preview: { kind: 'generic' },
            rawInput: {
              questions: [{ header: 'Target', question: 'Which target?' }],
            },
            rawOutput: text,
          }),
        ]}
      />,
    );
    expect(container.querySelector('[class*="chatBubble"]')).toBeNull();
    expect(container.querySelector('dl')).toBeNull();
    const summary = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    )!;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    act(() => summary.click());
    expect(container.textContent).toContain(text.split('\n')[0]);
  });

  it.each([
    {
      type: 'ask_user_question_answers',
      text: 'Invalid answer data',
      answers: [{ question: 'A?', answer: 1 }],
    },
    { type: 'ask_user_question_answers', text: 'No answers', answers: [] },
  ])('handles empty or invalid structured answers: $text', (result) => {
    const { container } = render(
      <WebShellTranscript
        blocks={[
          block({
            id: 'ask',
            kind: 'tool',
            toolCallId: 'ask-1',
            title: 'ask_user_question',
            toolName: 'ask_user_question',
            status: 'completed',
            preview: { kind: 'generic' },
            rawOutput: result,
          }),
        ]}
      />,
    );
    expect(container.querySelector('dl')).toBeNull();
    if (result.answers.length) {
      expect(container.querySelector('[class*="chatBubble"]')).toBeNull();
    } else {
      expect(
        container.querySelector('[class*="chatBubble"]')?.textContent,
      ).toBe(result.text);
    }
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
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Hidden reasoning');

    act(() => {
      row?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(row?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).not.toContain('Hidden reasoning');
    const thinkingToggle = container.querySelector<HTMLButtonElement>(
      'button[title="Expand thinking"]',
    );
    expect(thinkingToggle).not.toBeNull();
    act(() => thinkingToggle?.click());
    expect(container.textContent).toContain('Hidden reasoning');
  });

  it('suppresses session events while preserving their text', () => {
    const sessionEvents: unknown[] = [];
    const onSession = (event: Event) =>
      sessionEvents.push((event as CustomEvent).detail);
    window.addEventListener('qwen:open-session', onSession);
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
    window.removeEventListener('qwen:open-session', onSession);
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
