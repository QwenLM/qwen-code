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
    // HEAD_MARKER (~810 columns in) sits inside the 16-row budget's 1600
    // visible columns but past the settled 5-row floor's 412: without it an
    // OVER-yielding card (collapsing to the floor) passes vacuously.
    const description =
      '{"content":"' +
      'a'.repeat(800) +
      'HEAD_MARKER' +
      'a'.repeat(989) +
      'MID_MARKER' +
      'b'.repeat(200) +
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
            confirmType: 'info',
            confirmBody,
          }),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('awaiting approval');
    expect(text).toContain('HEAD_MARKER');
    expect(text).toContain('... last');
    expect(text).not.toContain('MID_MARKER');
  });

  it('yields pending rows via the payload proxy for an untyped confirm event (wire fallback)', () => {
    // A confirm event from a server that predates confirmType/confirmBody
    // carries neither: the card falls back to pricing its own folded
    // payload as the dialog body. The ~4k-char payload wraps to ~38 folded
    // rows — past the collapsed window — so the expanded-payload bound
    // shrinks the card to 11 budget rows (1060 visible columns at 110).
    // Two markers bracket the budget: MID_MARKER at 1512 must leave the
    // screen — and it sits inside the collapsed-only 23-row budget's 2356
    // visible columns, so losing the payload proxy (collapsing to that
    // bound) turns this red — while HEAD_MARKER at ~611, inside the 11-row
    // budget's 1060 columns but past the settled 5-row floor's 412, must
    // stay, so an over-yielding card fails too. The payload total stays
    // ~4024 columns so payloadRows keeps the intended budget at 11.
    const description =
      '{"content":"' +
      'a'.repeat(600) +
      'HEAD_MARKER' +
      'a'.repeat(889) +
      'MID_MARKER' +
      'b'.repeat(2500) +
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
    expect(text).toContain('HEAD_MARKER');
    expect(text).toContain('... last');
    expect(text).not.toContain('MID_MARKER');
  });

  it('keeps the pending rows when the mcp dialog cannot expand (R5-9)', () => {
    // Same payload as the wire-fallback case above, but typed mcp: that
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
      'a'.repeat(900) +
      'HEAD_MARKER' +
      'a'.repeat(1589) +
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
    // HEAD_MARKER (~911 columns in) sits inside each card's 17-row budget
    // (1708 visible columns) but past the settled 5-row floor's 412, so an
    // over-yielding card fails too.
    expect(text).toContain('HEAD_MARKER');
    expect(text).not.toContain('MID_MARKER');
  });

  it('keeps eight parked sibling cards inside the shared region (R4-8)', () => {
    // floor((80-26-5)*0.7/8) = 4 rows each — if the settled 5-row floor
    // lifted the divided bound back up, eight cards would paint 8*5/0.7 = 57
    // physical rows against the 80-26-5 = 49-row region and push the one
    // mounted dialog off the alt screen. N8_MARKER at ~351 sits past the
    // 4-row budget's 304 visible columns but inside the 5-row floor's 412,
    // so only the released floor hides it; HEAD_MARKER at ~52 stays either
    // way, so an over-yielding card fails too.
    const description =
      '{"content":"' +
      'h'.repeat(40) +
      'HEAD_MARKER' +
      'a'.repeat(288) +
      'N8_MARKER' +
      'b'.repeat(300) +
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
        items={[
          parked('t1'),
          parked('t2'),
          parked('t3'),
          parked('t4'),
          parked('t5'),
          parked('t6'),
          parked('t7'),
          parked('t8'),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('awaiting approval');
    expect(text).toContain('HEAD_MARKER');
    expect(text).not.toContain('N8_MARKER');
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
    // The spy is module-scoped and never cleared, so the count must be
    // measured against a baseline captured by THIS test — the calls earlier
    // tests accumulated would satisfy an absolute threshold vacuously.
    const callsBefore = mocks.pendingSpy.mock.calls.length;
    const { rerender } = render(view([pending, sibling]));
    const callsAfterFirstRender = mocks.pendingSpy.mock.calls.length;
    expect(callsAfterFirstRender).toBeGreaterThan(callsBefore);
    rerender(view([pending, { ...sibling, output: 'chunk two' }]));
    expect(mocks.pendingSpy.mock.calls.length).toBe(callsAfterFirstRender);
  });

  it('re-prices the pending card when any memo input changes', () => {
    // The memoized cap must invalidate on each dep: a stale memo keeps the
    // old price after the dialog's type or body is replaced, or after a
    // sibling parks. The spy counts every card's measure, so each delta
    // filters to this card's description width — a mounting sibling's own
    // measure must not leak in. Each rerender below changes exactly one
    // memo input.
    const description = '{"content":"' + 'a'.repeat(3000) + '"}';
    const base = toolItem({
      id: 't1',
      tool: 'mcp__fs__write_file',
      description,
      confirm: 'pending',
      confirmType: 'mcp',
    });
    const view = (items: LiveToolItem[], width = 110, height = 80) => (
      <OpenTuiTranscriptView
        availableWidth={width}
        availableTerminalHeight={height}
        items={items}
      />
    );
    let from = mocks.pendingSpy.mock.calls.length;
    const { rerender } = render(view([base]));
    const mainCardCalls = () =>
      mocks.pendingSpy.mock.calls
        .slice(from)
        .filter((call) => (call[1] as number) > 1000);
    expect(mainCardCalls()).not.toHaveLength(0);

    // The dialog type only (mcp -> edit, body absent both times).
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([{ ...base, confirmType: 'edit' }]));
    expect(mainCardCalls()).not.toHaveLength(0);

    // The dialog body only.
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([{ ...base, confirmType: 'edit', confirmBody: 'a\nb' }]));
    expect(mainCardCalls()).not.toHaveLength(0);

    // The sibling count only: a second call parks beside the unchanged card.
    from = mocks.pendingSpy.mock.calls.length;
    rerender(
      view([
        { ...base, confirmType: 'edit', confirmBody: 'a\nb' },
        toolItem({
          id: 't2',
          description: 'sib',
          confirm: 'pending',
          confirmType: 'mcp',
        }),
      ]),
    );
    expect(mainCardCalls()).not.toHaveLength(0);

    // The dialog's outside-window rows only (the urls/warnings block).
    const withExtra = {
      ...base,
      confirmType: 'edit',
      confirmBody: 'a\nb',
      confirmExtra: '⚠ w',
    };
    const sibling = toolItem({
      id: 't2',
      description: 'sib',
      confirm: 'pending',
      confirmType: 'mcp',
    });
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([withExtra, sibling]));
    expect(mainCardCalls()).not.toHaveLength(0);

    // The terminal height only: a resize with the dialog up. toolCardText
    // is width-independent, so nothing but the terminalHeight dep can fire
    // here — removing it from the memo's dep array leaves the stale 80-row
    // cap in place and this assertion fails.
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([withExtra, sibling], 110, 40));
    expect(mainCardCalls()).not.toHaveLength(0);

    // The width only.
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([withExtra, sibling], 100, 40));
    expect(mainCardCalls()).not.toHaveLength(0);
  });

  it('drops the pending budget when the call resolves or completes', () => {
    // A stale memo would keep the pending-priced cap after the call leaves
    // awaiting_approval: the 34-row budget shows the whole ~3k-column
    // payload, while the settled 5-row cap cuts it past column 412. Each
    // rerender parks a fresh sibling in the same batch so the sibling count
    // stays 1 and only the flipped field changes — otherwise the count
    // delta masks a dropped confirm/done dep.
    const description = '{"content":"' + 'a'.repeat(3000) + 'TAIL"}';
    const parked = (id: string) =>
      toolItem({
        id,
        tool: 'mcp__fs__write_file',
        description,
        confirm: 'pending',
        confirmType: 'mcp',
      });
    const sibling = toolItem({
      id: 't2',
      description: 'sib',
      confirm: 'pending',
      confirmType: 'mcp',
    });
    const view = (items: LiveToolItem[]) => (
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={items}
      />
    );

    // pending -> approved flips only the card's own confirm field.
    const resolved = render(view([parked('t1')]));
    expect(resolved.container.textContent).toContain('TAIL');
    resolved.rerender(
      view([{ ...parked('t1'), confirm: 'approved' }, sibling]),
    );
    expect(resolved.container.textContent).not.toContain('TAIL');
    expect(resolved.container.textContent).toContain('... last');
    resolved.unmount();

    // pending -> done flips only the card's own done field.
    const done = render(view([parked('t1')]));
    expect(done.container.textContent).toContain('TAIL');
    done.rerender(view([{ ...parked('t1'), done: true }, sibling]));
    expect(done.container.textContent).not.toContain('TAIL');
    expect(done.container.textContent).toContain('... last');
    done.unmount();
  });

  it('keeps the full pending budget beside a sibling that is not parked', () => {
    // The sibling divisor counts only parked calls: a still-executing
    // sibling (a hook-bounced batch runs one call while another awaits
    // approval) or a settled one must not halve the pending card's budget —
    // halving cuts this ~4k-column args JSON back to 1708 visible columns
    // and hides MID_MARKER, the R5-9 regression.
    const description =
      '{"content":"' +
      'a'.repeat(2500) +
      'MID_MARKER' +
      'b'.repeat(1500) +
      '"}';
    const parked = toolItem({
      id: 't1',
      tool: 'mcp__fs__write_file',
      description,
      confirm: 'pending',
      confirmType: 'mcp',
    });
    for (const sibling of [
      toolItem({ id: 't2', description: 'echo still running' }),
      toolItem({ id: 't2', description: 'echo done', done: true }),
    ]) {
      const { container, unmount } = render(
        <OpenTuiTranscriptView
          availableWidth={110}
          availableTerminalHeight={80}
          items={[parked, sibling]}
        />,
      );
      const text = container.textContent ?? '';
      expect(text).toContain('awaiting approval');
      expect(text).toContain('MID_MARKER');
      unmount();
    }
  });

  it('prices every parked card against the one mounted dialog', () => {
    // Exactly one confirmation dialog is mounted — the shell renders
    // waitingToolCalls[0], whose order is (re-)park time: a
    // resolve-then-re-park appends the call at the waiting list's end while
    // its transcript card keeps its original index, so the mounted call can
    // be a LATER transcript item. Every parked card must budget against the
    // mounted dialog (t2's fixed-lines mcp arm), not the first parked
    // card's — cards pricing themselves against different dialogs
    // over-commit the shared region.
    const hookBody = Array.from({ length: 20 }, () => 'reason').join('\n');
    const callsBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        activeWaitingCallId="t2"
        items={[
          toolItem({
            id: 't1',
            tool: 'mcp__fs__write_file',
            description: '{"a":"b"}',
            confirm: 'pending',
            confirmType: 'info',
            confirmBody: hookBody,
          }),
          toolItem({
            id: 't2',
            tool: 'mcp__fs__write_file',
            description: '{"c":"d"}',
            confirm: 'pending',
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const dialogs = mocks.pendingSpy.mock.calls
      .slice(callsBefore)
      .map((call) => call[3]);
    expect(dialogs.length).toBeGreaterThanOrEqual(2);
    for (const dialog of dialogs) {
      expect(dialog).toEqual({
        type: 'mcp',
        body: undefined,
        extra: undefined,
      });
    }
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
