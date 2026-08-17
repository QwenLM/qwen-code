/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatViewer, type ChatMessageData } from './ChatViewer.js';

const LONG_OUTPUT = `${'x'.repeat(600)}__SHELL_TAIL__`;

const LONG_READ_OUTPUT = `${'y'.repeat(400)}__READ_TAIL__`;

const USER_MESSAGE_WITH_FILE_REFERENCE = [
  'please review this file',
  '--- Content from referenced files ---',
  'Content from @src/example.ts:',
  'FILE-REF-BODY-LINE-1',
  'FILE-REF-BODY-LINE-2',
  '--- End of content ---',
].join('\n');

const createFileAndReadMessages = (): ChatMessageData[] => [
  {
    uuid: 'user-file-1',
    timestamp: '2026-03-22T16:48:30.000Z',
    type: 'user',
    message: {
      role: 'user',
      parts: [{ text: USER_MESSAGE_WITH_FILE_REFERENCE }],
    },
  },
  {
    uuid: 'read-1',
    timestamp: '2026-03-22T16:48:35.000Z',
    type: 'tool_call',
    toolCall: {
      toolCallId: 'read-1-call',
      kind: 'read',
      title: 'Read src/example.ts',
      status: 'completed',
      rawInput: { file_path: 'src/example.ts' },
      locations: [{ path: 'src/example.ts' }],
      content: [
        {
          type: 'content',
          content: { type: 'text', text: LONG_READ_OUTPUT },
        },
      ],
    },
  },
];

const createMessages = (): ChatMessageData[] => [
  {
    uuid: 'user-1',
    timestamp: '2026-03-22T16:48:30.000Z',
    type: 'user',
    message: { role: 'user', parts: [{ text: 'hello' }] },
  },
  {
    uuid: 'thinking-1',
    timestamp: '2026-03-22T16:48:31.000Z',
    type: 'assistant',
    message: {
      role: 'thinking',
      // Avoid `__text__` markers: thinking content renders as Markdown and
      // would strip the double underscores as bold syntax.
      parts: [{ text: 'thinking body THINKING-BODY-MARKER' }],
    },
  },
  {
    uuid: 'shell-1',
    timestamp: '2026-03-22T16:48:35.000Z',
    type: 'tool_call',
    toolCall: {
      toolCallId: 'shell-1-call',
      kind: 'bash',
      title: 'Run command',
      status: 'completed',
      rawInput: { command: 'run-command' },
      content: [
        { type: 'content', content: { type: 'text', text: LONG_OUTPUT } },
      ],
    },
  },
];

describe('ChatViewer global expand control', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  const clickButton = (label: string) => {
    const button = container?.querySelector(
      `button[aria-label="${label}"]`,
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const getOutputToggle = () =>
    container?.querySelector(
      'button[aria-label="Expand output"], button[aria-label="Collapse output"]',
    ) as HTMLButtonElement;

  const getOutputContent = () =>
    container?.querySelector(
      '.toolcall-collapsible-output-content',
    ) as HTMLDivElement;

  const isThinkingExpanded = () =>
    container?.querySelector('.thinking-content') != null;

  it('does not render the toolbar by default', () => {
    act(() => {
      root?.render(
        <ChatViewer messages={createMessages()} autoScroll={false} />,
      );
    });

    expect(container?.querySelector('.chat-viewer-expand-control')).toBeNull();
  });

  it('expands thinking blocks and long tool outputs via Expand all', () => {
    act(() => {
      root?.render(
        <ChatViewer
          messages={createMessages()}
          autoScroll={false}
          showExpandControl
        />,
      );
    });

    // Baseline: both sections start collapsed. ShellToolCall renders its
    // output with collapsedHeight=60 (not the CollapsibleOutput default).
    expect(isThinkingExpanded()).toBe(false);
    expect(getOutputToggle().getAttribute('aria-expanded')).toBe('false');
    expect(getOutputContent().style.maxHeight).toBe('60px');

    clickButton('Expand all sections');

    expect(isThinkingExpanded()).toBe(true);
    expect(container?.textContent).toContain('THINKING-BODY-MARKER');
    expect(getOutputToggle().getAttribute('aria-expanded')).toBe('true');
    expect(getOutputContent().style.maxHeight).toBe('');
  });

  it('collapses previously expanded sections via Collapse all', () => {
    act(() => {
      root?.render(
        <ChatViewer
          messages={createMessages()}
          autoScroll={false}
          showExpandControl
        />,
      );
    });

    clickButton('Expand all sections');
    expect(isThinkingExpanded()).toBe(true);

    clickButton('Collapse all sections');

    expect(isThinkingExpanded()).toBe(false);
    expect(getOutputToggle().getAttribute('aria-expanded')).toBe('false');
    expect(getOutputContent().style.maxHeight).toBe('60px');
  });

  it('keeps individual toggles working after a global command', () => {
    act(() => {
      root?.render(
        <ChatViewer
          messages={createMessages()}
          autoScroll={false}
          showExpandControl
        />,
      );
    });

    clickButton('Expand all sections');
    expect(isThinkingExpanded()).toBe(true);

    // Manually collapse the thinking block again.
    const thinkingToggle = container?.querySelector(
      'button[aria-label="Collapse thinking"]',
    ) as HTMLButtonElement;
    expect(thinkingToggle).not.toBeNull();
    act(() => {
      thinkingToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(isThinkingExpanded()).toBe(false);

    // The shell output stays expanded: the manual toggle only affects its
    // own section.
    expect(getOutputToggle().getAttribute('aria-expanded')).toBe('true');

    // A later global command reaches every section again.
    clickButton('Collapse all sections');
    expect(getOutputToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('does not render the toolbar for an empty message list', () => {
    act(() => {
      root?.render(
        <ChatViewer messages={[]} autoScroll={false} showExpandControl />,
      );
    });

    expect(container?.querySelector('.chat-viewer-expand-control')).toBeNull();
  });

  it('expands file references and read outputs via the global buttons', () => {
    act(() => {
      root?.render(
        <ChatViewer
          messages={createFileAndReadMessages()}
          autoScroll={false}
          showExpandControl
        />,
      );
    });

    const getFileRefToggle = () =>
      container?.querySelector(
        '.user-message-container button[aria-expanded]',
      ) as HTMLButtonElement;
    const getReadToggle = () =>
      Array.from(
        container?.querySelectorAll('.read-tool-call-success button') ?? [],
      ).find((button) => button.textContent?.includes('Show more')) ??
      Array.from(
        container?.querySelectorAll('.read-tool-call-success button') ?? [],
      ).find((button) => button.textContent?.includes('Collapse'));

    // Baseline: both sections start collapsed. The collapsed file-reference
    // body is not rendered at all.
    expect(getFileRefToggle().getAttribute('aria-expanded')).toBe('false');
    expect(container?.textContent).not.toContain('FILE-REF-BODY-LINE-1');
    expect(getReadToggle()?.textContent).toContain('Show more');

    clickButton('Expand all sections');

    expect(getFileRefToggle().getAttribute('aria-expanded')).toBe('true');
    expect(container?.textContent).toContain('FILE-REF-BODY-LINE-1');
    expect(getReadToggle()?.textContent).toContain('Collapse');

    clickButton('Collapse all sections');

    expect(getFileRefToggle().getAttribute('aria-expanded')).toBe('false');
    expect(container?.textContent).not.toContain('FILE-REF-BODY-LINE-1');
    expect(getReadToggle()?.textContent).toContain('Show more');
  });

  it('mounts sections added after a global command in the target state', () => {
    act(() => {
      root?.render(
        <ChatViewer
          messages={createMessages()}
          autoScroll={false}
          showExpandControl
        />,
      );
    });

    clickButton('Expand all sections');
    expect(container?.querySelectorAll('.thinking-content').length).toBe(1);

    // A new thinking message arrives after the global command (streaming).
    const lateThinking: ChatMessageData = {
      uuid: 'thinking-late',
      timestamp: '2026-03-22T16:49:00.000Z',
      type: 'assistant',
      message: {
        role: 'thinking',
        parts: [{ text: 'late body LATE-THINKING-MARKER' }],
      },
    };
    act(() => {
      root?.render(
        <ChatViewer
          messages={[...createMessages(), lateThinking]}
          autoScroll={false}
          showExpandControl
        />,
      );
    });

    // The late section inherits the latest global target (expanded)
    // without another toolbar click.
    expect(container?.querySelectorAll('.thinking-content').length).toBe(2);
    expect(container?.textContent).toContain('LATE-THINKING-MARKER');
  });
});
