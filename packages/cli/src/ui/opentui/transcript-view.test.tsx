/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Mount coverage for the transcript view's review-round behaviors: an
 * awaiting-approval card keeps its (capped) description — the confirmation
 * dialog does not carry the payload for every type, so an MCP call stays
 * approvable with its arguments on screen — and the `!` shell row carries
 * ink's `$ ` prefix.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { AgentStatus } from '@qwen-code/qwen-code-core';
import { setLanguageAsync } from '../../i18n/index.js';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

const mocks = vi.hoisted(() => {
  // The components carry the @opentui/react JSX import source; map its
  // primitive elements to DOM nodes so @testing-library/react can mount them.
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: {
        children?: unknown;
        key?: React.Key;
        onMouseUp?: React.MouseEventHandler;
        paddingLeft?: number;
      } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          {
            key,
            onMouseUp: props?.onMouseUp,
            'data-padding-left': props?.paddingLeft,
          },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { buildJsxRuntime };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

import { OpenTuiTranscriptView } from './transcript-view.js';
import { STATUS_INDICATOR_WIDTH } from './messages.js';
import { formatInlineImageOverflow } from '../utils/inline-image-parts.js';
import type { LiveThinkingItem, LiveToolItem } from './live-session-model.js';

const toolItem = (overrides: Partial<LiveToolItem> = {}): LiveToolItem => ({
  kind: 'tool',
  id: 't1',
  tool: 'run_shell_command',
  title: 'run_shell_command',
  output: '',
  done: false,
  ...overrides,
});

describe('OpenTuiTranscriptView', () => {
  it('localizes the Focus memory counter in Portuguese', async () => {
    await setLanguageAsync('pt');
    try {
      const view = render(
        <OpenTuiTranscriptView
          focusMode
          availableWidth={160}
          items={[toolItem({ done: true, success: true, isMemoryOp: 'write' })]}
        />,
      );
      expect(view.container.textContent).toContain(
        'Memória: 0 leituras, 1 gravações',
      );
      view.unmount();
    } finally {
      await setLanguageAsync('en');
    }
  });
  it('omits the whole memory suffix when the compact row is narrow', () => {
    const items = [
      toolItem({ done: true, success: true, isMemoryOp: 'write' }),
    ];
    const view = render(
      <OpenTuiTranscriptView focusMode availableWidth={30} items={items} />,
    );
    expect(view.container.textContent).not.toContain(' · ');
    expect(view.container.textContent).not.toContain('Memory');
    view.rerender(
      <OpenTuiTranscriptView focusMode availableWidth={100} items={items} />,
    );
    expect(view.container.textContent).toContain('Memory: 0 read, 1 written');
  });
  it('does not parse focus-only arguments while focus is off', () => {
    const args = '{"file_path":"src/main.ts","content":"BODY"}';
    const spy = vi.spyOn(JSON, 'parse');
    try {
      render(
        <OpenTuiTranscriptView
          items={[toolItem({ args, description: 'src/main.ts' })]}
        />,
      );
      expect(spy).not.toHaveBeenCalledWith(args);
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves manual thought expansion through full detail clicks', () => {
    const items = [
      {
        kind: 'thinking' as const,
        id: 'thought',
        text: 'PRIVATE_REASONING',
        done: true,
      },
    ];
    const view = render(<OpenTuiTranscriptView items={items} />);
    expect(view.container.textContent).not.toContain('PRIVATE_REASONING');
    fireEvent.mouseUp(view.getByText(/Thinking/));
    expect(view.container.textContent).toContain('PRIVATE_REASONING');
    view.rerender(<OpenTuiTranscriptView items={items} fullDetail />);
    fireEvent.mouseUp(view.getByText(/Thinking/));
    view.rerender(<OpenTuiTranscriptView items={items} />);
    expect(view.container.textContent).toContain('PRIVATE_REASONING');
  });

  it('indents image and vision disclosure rows with tool output', () => {
    const view = render(
      <OpenTuiTranscriptView
        items={[
          toolItem({
            imageMimeTypes: ['image/png'],
            omittedImageCount: 2,
            visionBridgeNotice: 'VISION_NOTICE',
          }),
        ]}
      />,
    );
    for (const text of [
      '[inline image: image/png]',
      'VISION_NOTICE',
      formatInlineImageOverflow(2),
    ]) {
      expect(
        view
          .getByText(text)
          .closest('[data-padding-left]')
          ?.getAttribute('data-padding-left'),
      ).toBe(String(STATUS_INDICATOR_WIDTH));
    }
  });

  it('keeps ANSI grid columns truncated in full detail', () => {
    const view = render(
      <OpenTuiTranscriptView
        fullDetail
        availableWidth={40}
        items={[
          toolItem({
            ansi: {
              grid: [
                [
                  {
                    text: 'A'.repeat(40) + 'OVERFLOW_MARKER',
                    bold: false,
                    italic: false,
                    underline: false,
                    dim: false,
                    inverse: false,
                    fg: '',
                    bg: '',
                  },
                ],
              ],
              totalLines: 1,
              totalBytes: 55,
            },
          }),
        ]}
      />,
    );
    expect(view.container.textContent).not.toContain('OVERFLOW_MARKER');
  });
  it('retroactively summarizes completed tools and hides reasoning without losing history', () => {
    const items = [
      {
        kind: 'thinking' as const,
        id: 'thought',
        text: 'PRIVATE_REASONING',
        done: true,
      },
      toolItem({
        tool: 'read_file',
        args: '{"file_path":"src/main.ts"}',
        output: 'FULL_RESULT',
        done: true,
        success: true,
      }),
    ];
    const view = render(<OpenTuiTranscriptView items={items} />);
    expect(view.container.textContent).toContain('FULL_RESULT');
    view.rerender(<OpenTuiTranscriptView items={items} focusMode />);
    expect(view.container.textContent).toContain('Read');
    expect(view.container.textContent).toContain('main.ts');
    expect(view.container.textContent).not.toContain('FULL_RESULT');
    expect(view.container.textContent).not.toContain('Thinking');
    expect(view.container.textContent).not.toContain('PRIVATE_REASONING');
    view.rerender(<OpenTuiTranscriptView items={items} focusMode fullDetail />);
    expect(view.container.textContent).toContain('FULL_RESULT');
    expect(view.container.textContent).toContain('PRIVATE_REASONING');
    view.rerender(<OpenTuiTranscriptView items={items} focusMode />);
    expect(view.container.textContent).not.toContain('FULL_RESULT');
    expect(items[1]).toMatchObject({ output: 'FULL_RESULT' });
  });

  it.each(['error', 'cancelled', 'interrupted'])(
    'summarizes %s tools without dumping raw commands or output',
    (summary) => {
      const view = render(
        <OpenTuiTranscriptView
          focusMode
          items={[
            toolItem({
              done: true,
              success: false,
              summary,
              description: 'RAW_COMMAND',
              output: 'LONG_ERROR_OUTPUT',
            }),
          ]}
        />,
      );
      expect(view.container.textContent).toContain('Shell');
      expect(view.container.textContent).not.toContain('RAW_COMMAND');
      expect(view.container.textContent).not.toContain('LONG_ERROR_OUTPUT');
      expect(view.container.textContent).toContain(
        summary === 'error' ? 'failed' : 'cancelled',
      );
    },
  );

  it.each([
    { done: false },
    { done: false, confirm: 'pending' as const },
    { isUserInitiated: true },
    { isSubagent: true },
    { imageMimeTypes: ['image/png'] },
    { omittedImageCount: 2 },
    { visionBridgeNotice: 'VISION_NOTICE' },
  ])('keeps exceptional tools visible: %j', (override) => {
    const view = render(
      <OpenTuiTranscriptView
        focusMode
        items={[
          toolItem({
            done: true,
            success: true,
            output: 'EXCEPTION_OUTPUT',
            ...override,
          }),
        ]}
      />,
    );
    expect(view.container.textContent).toContain('EXCEPTION_OUTPUT');
  });

  it('full details lift output character and row caps', () => {
    const output = `FIRST_RESULT_LINE\n${'x\n'.repeat(150)}${'y'.repeat(35000)}LAST_RESULT_MARKER`;
    const items = [toolItem({ done: true, success: true, output })];
    const view = render(<OpenTuiTranscriptView items={items} fullDetail />);
    expect(view.container.textContent).toContain('FIRST_RESULT_LINE');
    expect(view.container.textContent).toContain('LAST_RESULT_MARKER');
  });

  it('shows the saved result body only when full details are enabled', () => {
    const items = [
      toolItem({
        tool: 'read_file',
        done: true,
        success: true,
        output: 'SUMMARY_ONLY',
        detailedDisplay: 'FULL_BODY_ONLY',
      }),
    ];
    const view = render(<OpenTuiTranscriptView items={items} />);
    expect(view.container.textContent).toContain('SUMMARY_ONLY');
    expect(view.container.textContent).not.toContain('FULL_BODY_ONLY');
    view.rerender(<OpenTuiTranscriptView items={items} focusMode />);
    expect(view.container.textContent).not.toContain('SUMMARY_ONLY');
    view.rerender(<OpenTuiTranscriptView items={items} focusMode fullDetail />);
    expect(view.container.textContent).toContain('FULL_BODY_ONLY');
    expect(view.container.textContent).not.toContain('SUMMARY_ONLY');
    view.rerender(<OpenTuiTranscriptView items={items} />);
    expect(view.container.textContent).toContain('SUMMARY_ONLY');
    expect(view.container.textContent).not.toContain('FULL_BODY_ONLY');
  });

  it('keeps a pending MCP-shaped card description visible (R1-10)', () => {
    // An MCP confirmation dialog shows only the server and tool names — no
    // args — so the card is the only surface that carries the arguments.
    const { container } = render(
      <OpenTuiTranscriptView
        items={[
          toolItem({
            tool: 'mcp__fs__write_file',
            description: '{"path":"/x","content":"SECRET_PAYLOAD"}',
            confirm: 'pending',
          }),
        ]}
      />,
    );
    expect(container.textContent).toContain('SECRET_PAYLOAD');
    expect(container.textContent).toContain('awaiting approval');
  });

  it('keeps a long pending payload approvable and caps it once settled (R5-9)', () => {
    // The settled 5-row cap would hide exactly the tail of the payload the
    // user is being asked to approve, so a pending card budgets its own
    // (bounded) rows; the cap applies again once the call settles. Two
    // separate renders: siblings in one render would share the container and
    // defeat the absent assertion. Rendered at an 80-row viewport — the
    // pending budget shrinks with the terminal, and at the 24-row default it
    // degenerates to the settled cap.
    const description =
      '{"path":"/x","content":"' + 'x'.repeat(600) + 'TAIL_MARKER"}';
    const pending = render(
      <OpenTuiTranscriptView
        availableTerminalHeight={80}
        items={[
          toolItem({
            tool: 'mcp__fs__write_file',
            description,
            confirm: 'pending',
          }),
        ]}
      />,
    );
    expect(pending.container.textContent).toContain('TAIL_MARKER');
    expect(pending.container.textContent).toContain('awaiting approval');
    pending.unmount();

    const settled = render(
      <OpenTuiTranscriptView
        availableTerminalHeight={80}
        items={[
          toolItem({
            tool: 'mcp__fs__write_file',
            description,
            confirm: 'approved',
          }),
        ]}
      />,
    );
    expect(settled.container.textContent).not.toContain('TAIL_MARKER');
    expect(settled.container.textContent).toContain('... last');
  });

  it('caps a huge pending payload so the dialog below fits the viewport', () => {
    // The confirmation dialog renders in flow beneath the transcript on a
    // fixed alt-screen viewport: a pending card left at the ink-parity
    // history cap (320 rows at h=80) pushed the dialog's hidden-lines label
    // and ctrl-s hint off screen (mem0 e2e regression). The pending budget
    // must engage and summarize the payload's tail.
    const description =
      '{"path":"/x","content":"' + 'y'.repeat(4000) + 'PAYLOAD_TAIL"}';
    const { container } = render(
      <OpenTuiTranscriptView
        availableTerminalHeight={80}
        items={[
          toolItem({
            tool: 'mcp__fs__write_file',
            description,
            confirm: 'pending',
          }),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('... last');
    expect(text).not.toContain('PAYLOAD_TAIL');
    expect(text).toContain('awaiting approval');
  });

  it('yields pending rows a hook-confirmation dialog needs when expanded (mem0 e2e)', () => {
    // The mem0 confirmation duplicates the card's description inside its
    // dialog body: once ctrl-s expands it, the whole payload plus dialog
    // chrome must fit the viewport, so a ~4k-char payload must shrink the
    // card BELOW the collapsed-dialog bound (34 rows ≈ 3523 visible chars
    // at 110 columns). A marker placed past the yielded budget pins the
    // shrink — that bound alone would still show it and the e2e expansion
    // stage would stay red.
    const description =
      '{"content":"' +
      'a'.repeat(2500) +
      'MID_MARKER' +
      'b'.repeat(1500) +
      '"}';
    const { container } = render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[
          toolItem({
            tool: 'mcp__fs__write_file',
            description,
            confirm: 'pending',
          }),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('awaiting approval');
    expect(text).toContain('... last');
    expect(text).not.toContain('MID_MARKER');
  });

  it('folds newlines in a live description before the cap measures it (R6-2)', () => {
    // A live shell command can carry embedded newlines: each renders a
    // physical row while costing zero columns in capToolCardDescription's
    // math, so a many-line command slipped under the 5-row budget and the
    // card flooded the column. The cap must measure the same folded text
    // the render prints.
    const multiLine = Array.from(
      { length: 10 },
      (_, i) => `cmd-${i}-aaaaaaaaaaaaaaaa`,
    ).join('\n');
    const { container } = render(
      <OpenTuiTranscriptView
        items={[toolItem({ description: multiLine, confirm: 'approved' })]}
      />,
    );
    expect(container.textContent).not.toContain('\n');
    expect(container.textContent).toContain('cmd-0-aaaaaaaaaaaaaaaa');
  });

  it('shows the description once approval resolves or the call is done', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={[
          toolItem({ description: 'echo visible now', confirm: 'approved' }),
          toolItem({
            description: 'done shows too',
            confirm: 'pending',
            done: true,
          }),
        ]}
      />,
    );
    expect(container.textContent).toContain('echo visible now');
    expect(container.textContent).toContain('done shows too');
  });

  it('renders the ! shell row with the ink $ prefix', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={[{ kind: 'user-shell', id: 's1', text: 'git status' }]}
      />,
    );
    expect(container.textContent).toContain('$ git status');
  });

  it('renders an error on one row with ink’s inline parenthesised hint', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={[
          {
            kind: 'error',
            id: 'e1',
            text: 'Model not found',
            hint: 'try /model',
          },
        ]}
      />,
    );
    expect(container.textContent).toContain('✕ Model not found (try /model)');
  });

  it('strips bidi overrides from arena file lists and group labels (R1-26)', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={[
          {
            kind: 'arena-session',
            id: 'a1',
            sessionStatus: 'completed',
            task: 'do it',
            totalDurationMs: 2000,
            agents: [
              {
                label: 'a\u202eX',
                status: AgentStatus.COMPLETED,
                durationMs: 1200,
                totalTokens: 10,
                inputTokens: 4,
                outputTokens: 6,
                toolCalls: 2,
                successfulToolCalls: 2,
                failedToolCalls: 0,
                rounds: 1,
                modifiedFiles: ['a\u202eb.ts'],
              },
            ],
          },
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain('\u202e');
    expect(text).toContain('b.ts');
  });

  it('names a committed thought’s duration and opens it on the global toggle', () => {
    const items: LiveThinkingItem[] = [
      {
        kind: 'thinking',
        id: 'th1',
        text: 'INSPECTING_THE_REPOSITORY',
        done: true,
        durationMs: 12_000,
      },
    ];
    const collapsed = render(<OpenTuiTranscriptView items={items} />);
    expect(collapsed.container.textContent).toContain('Thought for 12s');
    expect(collapsed.container.textContent).not.toContain(
      'INSPECTING_THE_REPOSITORY',
    );
    collapsed.unmount();

    const expanded = render(
      <OpenTuiTranscriptView items={items} thoughtsExpanded />,
    );
    expect(expanded.container.textContent).toContain(
      'INSPECTING_THE_REPOSITORY',
    );
    expect(expanded.container.textContent).toContain('ctrl+o to collapse');
  });
});
