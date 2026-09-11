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
import { render } from '@testing-library/react';
import { AgentStatus } from '@qwen-code/qwen-code-core';

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
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
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
  return {
    buildJsxRuntime,
    pendingSpy: undefined as unknown as import('vitest').Mock,
  };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

// Spy on the pending-card budget so the memoization test can count the
// dialog-body measure across re-renders; every other export passes through.
vi.mock('./messages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./messages.js')>();
  mocks.pendingSpy = vi.fn(actual.pendingCardMaxRows);
  return { ...actual, pendingCardMaxRows: mocks.pendingSpy };
});

import { OpenTuiTranscriptView } from './transcript-view.js';
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
    // The production mem0 shape: a PreToolUse 'ask' bounce builds an info
    // confirmation whose prompt is the hook reason, and the card carries
    // the call's args JSON alongside it. A 30-row body engages the
    // expanded-dialog bound ((80-26-30)*0.7 = 16 rows ≈ 1600 visible
    // columns at 110), so a marker past that cut must leave the screen —
    // while the description stays short enough (19 folded rows) that the
    // payload proxy stays off: only the wired-through confirmBody can make
    // this pass.
    const confirmBody = Array.from({ length: 30 }, () => 'reason line').join(
      '\n',
    );
    const description =
      '{"content":"' + 'a'.repeat(1800) + 'MID_MARKER' + 'b'.repeat(200) + '"}';
    const { container } = render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[
          toolItem({
            tool: 'mcp__fs__write_file',
            description,
            confirm: 'pending',
            confirmType: 'info',
            confirmBody,
          }),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('awaiting approval');
    expect(text).toContain('... last');
    expect(text).not.toContain('MID_MARKER');
  });

  it('yields pending rows via the payload proxy for an untyped confirm event (wire fallback)', () => {
    // A confirm event from a server that predates confirmType/confirmBody
    // carries neither: the card falls back to pricing its own folded
    // payload as the dialog body. The ~4k-char payload wraps to ~37 folded
    // rows — past the collapsed window — so the expanded-payload bound
    // shrinks the card below the collapsed-dialog bound (23 rows ≈ 2356
    // visible chars at 110 columns). A marker placed past the yielded
    // budget pins the shrink — that bound alone would still show it and
    // the e2e expansion stage would stay red.
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

  it('keeps the pending rows when the mcp dialog cannot expand (R5-9)', () => {
    // Same payload as the hook-confirmation case above, but typed mcp: that
    // dialog renders two fixed lines and has no ctrl-s expansion, so the
    // card — the only surface carrying the arguments — keeps the
    // collapsed-footprint budget and MID_MARKER stays on screen.
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
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('awaiting approval');
    expect(text).toContain('MID_MARKER');
  });

  it('splits the pending budget between sibling cards awaiting approval', () => {
    // Two parked mcp calls: without the sibling count each card budgets
    // against the whole viewport (34 rows ≈ 3544 visible columns), and two
    // ~45-row cards push the first call's confirmation dialog — the only
    // actionable surface — off an 80-row alt screen. Sharing the transcript
    // region halves each budget (17 rows ≈ 1708 columns), so the marker
    // past that cut leaves the screen.
    const description =
      '{"content":"' +
      'a'.repeat(2500) +
      'MID_MARKER' +
      'b'.repeat(1500) +
      '"}';
    const parked = (id: string) =>
      toolItem({
        id,
        tool: 'mcp__fs__write_file',
        description,
        confirm: 'pending',
        confirmType: 'mcp',
      });
    const { container } = render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[parked('t1'), parked('t2')]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('awaiting approval');
    expect(text).not.toContain('MID_MARKER');
  });

  it('memoizes the pending-card measure across sibling re-renders', () => {
    // A sibling call's stream events re-render the whole transcript, and the
    // pending card's dialog-body measure scans the whole confirmation body —
    // it must re-run only when its own inputs change.
    const pending = toolItem({
      id: 't1',
      tool: 'exit_plan_mode',
      description: 'plan ready',
      confirm: 'pending',
      confirmType: 'plan',
      confirmBody: Array.from({ length: 30 }, () => 'step').join('\n'),
    });
    const sibling = toolItem({ id: 't2', output: 'chunk one' });
    const view = (items: LiveToolItem[]) => (
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={items}
      />
    );
    const { rerender } = render(view([pending, sibling]));
    const callsAfterFirstRender = mocks.pendingSpy.mock.calls.length;
    expect(callsAfterFirstRender).toBeGreaterThan(0);
    rerender(view([pending, { ...sibling, output: 'chunk two' }]));
    expect(mocks.pendingSpy.mock.calls.length).toBe(callsAfterFirstRender);
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
