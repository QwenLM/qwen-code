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
import type {
  LiveHistoryItem,
  LiveThinkingItem,
  LiveToolItem,
} from './live-session-model.js';

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
    // region halves each budget after charging the sibling's chrome rows
    // (16 rows ≈ 1600 columns), so the marker past that cut leaves the
    // screen.
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
    // floor((80-26-5-14)*0.7/8) = 3 rows each — the region also spends each
    // sibling's hidden-tail and awaiting rows (2 per card past the first)
    // before dividing. If the settled 5-row floor lifted the divided bound
    // back up, eight cards would paint 8*5/0.7 + 14 ≈ 71 physical rows
    // against the 80-26-5 = 49-row region and push the one mounted dialog
    // off the alt screen. N8_MARKER at ~351 sits past the 3-row budget's
    // 196 visible columns but inside the lifted floor's 412, so only the
    // released floor shows it; HEAD_MARKER at ~150 sits inside the 196 but
    // past the 1-row floor's 88, so an over-yielding card fails too. (An
    // under-yield to exactly 4 rows — 304 columns — hides N8_MARKER as
    // well; the arithmetic pins in messages.test.tsx discriminate that.)
    const description =
      '{"content":"' +
      'h'.repeat(138) +
      'HEAD_MARKER' +
      'a'.repeat(190) +
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

  it('keeps an args sliver when the sibling floor drops the budget to one row (R7-2)', () => {
    // Two parked mcp calls whose raw display name is wider than the row:
    // the sibling division floors the budget at 1, where
    // descRows * cols - nameCols = 34 - 42 <= 0 — a zero-column slice
    // DELETES the description node, and the card is the only surface
    // carrying the call's arguments (the mcp dialog shows just the server
    // and tool names). Terminal height is not part of the binding condition
    // (nameCols >= cols is what zeroes the slice), so the 24-row viewport
    // is incidental. The one-row floor keeps a full row of description
    // columns: the marker survives, and the label still counts 7 hidden
    // rows — a lifted sibling floor (5 rows) would read '... last 4'.
    const description = 'ARGS_MARKER ' + 'x'.repeat(200);
    const parked = (id: string) =>
      toolItem({
        id,
        tool: 'mcp__github_enterprise__create_repository',
        description,
        confirm: 'pending',
        confirmType: 'mcp',
      });
    const { container } = render(
      <OpenTuiTranscriptView
        availableWidth={36}
        availableTerminalHeight={24}
        items={[parked('t1'), parked('t2')]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('ARGS_MARKER');
    expect(text).toContain('... last 7 lines hidden ...');
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

    // The card's own description only (the `text` dep).
    const desc2 = '{"content":"' + 'a'.repeat(3200) + '"}';
    const renamed = {
      ...withExtra,
      description: desc2,
      tool: 'mcp__other__write_a_much_longer_tool_name',
    };
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([{ ...withExtra, description: desc2 }, sibling]));
    expect(mainCardCalls()).not.toHaveLength(0);

    // The card's display name only (the `name` dep).
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([renamed, sibling]));
    expect(mainCardCalls()).not.toHaveLength(0);

    // The terminal height only: a resize with the dialog up. toolCardText
    // is width-independent, so nothing but the terminalHeight dep can fire
    // here — removing it from the memo's dep array leaves the stale 80-row
    // cap in place and this assertion fails.
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([renamed, sibling], 110, 40));
    expect(mainCardCalls()).not.toHaveLength(0);

    // The width only.
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([renamed, sibling], 100, 40));
    expect(mainCardCalls()).not.toHaveLength(0);

    // The dialog's candidate blocks only (the pendingDialogExtras dep): an
    // ask_user_question dialog prices by the painted-tallest candidate, so
    // replacing them must re-price even with type/body/extra unchanged —
    // and the candidates must reach the budget as the dialog's extras.
    const withExtras = {
      ...renamed,
      confirmExtras: ['\nA (1/2)\none?\n\nx', '\nB (2/2)\ntwo?\n\ny\nz'],
    };
    from = mocks.pendingSpy.mock.calls.length;
    rerender(view([withExtras, sibling], 100, 40));
    const extrasCalls = mainCardCalls();
    expect(extrasCalls).not.toHaveLength(0);
    const lastDialog = extrasCalls.at(-1)?.[3] as
      | { extras?: string[] }
      | undefined;
    expect(lastDialog?.extras).toEqual(withExtras.confirmExtras);
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
    // mounted dialog (t2's exec arm, with its outside-window warning row),
    // not the first parked card's — cards pricing themselves against
    // different dialogs over-commit the shared region.
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
            tool: 'run_shell_command',
            description: '{"c":"d"}',
            confirm: 'pending',
            confirmType: 'exec',
            confirmBody: 'echo $(date)',
            confirmExtra: '⚠ Command substitution detected',
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
        type: 'exec',
        body: 'echo $(date)',
        extra: '⚠ Command substitution detected',
      });
    }

    // While the gated-MCP approval dialog owns the shell's popup slot no
    // tool confirmation is mounted: the same parked cards must price the
    // body-less payload proxy, not a dialog that is not painting.
    const preemptedBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        activeWaitingCallId="t2"
        pendingDialogMounted={false}
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
            tool: 'run_shell_command',
            description: '{"c":"d"}',
            confirm: 'pending',
            confirmType: 'exec',
            confirmBody: 'echo $(date)',
            confirmExtra: '⚠ Command substitution detected',
          }),
        ]}
      />,
    );
    const preemptedDialogs = mocks.pendingSpy.mock.calls
      .slice(preemptedBefore)
      .map((call) => call[3]);
    expect(preemptedDialogs.length).toBeGreaterThanOrEqual(2);
    for (const dialog of preemptedDialogs) {
      expect(dialog?.type).toBeUndefined();
      expect(dialog?.body).toBeUndefined();
      expect(dialog?.extra).toBeUndefined();
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

  it('shrinks the pending budget as the transcript above the card grows (R2-2)', () => {
    // Control: on a fresh session the lone mcp card prices
    // (80-26-5)*0.7 = 34 budget rows (~3544 visible description columns at
    // 110), so MID_MARKER at ~2512 stays. Five user/assistant exchanges
    // above the card paint 30 rows, and the same card prices
    // (80-26-5-25)*0.7 = 16 rows (1600 visible columns): MID_MARKER leaves
    // the screen while HEAD_MARKER (~612) stays — only the grown
    // transcript's height can move the budget between the two renders.
    const description =
      '{"content":"' +
      'a'.repeat(600) +
      'HEAD_MARKER' +
      'a'.repeat(1889) +
      'MID_MARKER' +
      'b'.repeat(1200) +
      '"}';
    const parked = toolItem({
      id: 't1',
      tool: 'mcp__fs__write_file',
      description,
      confirm: 'pending',
      confirmType: 'mcp',
    });
    const fresh = render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[parked]}
      />,
    );
    expect(fresh.container.textContent).toContain('MID_MARKER');
    fresh.unmount();

    // Five user turns (margin + one row each) and five three-line
    // assistant replies (margin + three rows each): 30 painted rows.
    const history: LiveHistoryItem[] = [];
    for (let i = 0; i < 5; i++) {
      history.push({ kind: 'user', id: `u${i}`, text: `question ${i}` });
      history.push({
        kind: 'assistant',
        id: `a${i}`,
        text: 'line one\nline two\nline three',
        streaming: false,
      });
    }
    const grown = render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[...history, parked]}
      />,
    );
    const text = grown.container.textContent ?? '';
    expect(text).toContain('awaiting approval');
    expect(text).toContain('HEAD_MARKER');
    expect(text).not.toContain('MID_MARKER');
  });

  it('keeps the mcp args surface readable past transcript saturation (R12-1)', () => {
    // Fifteen exchanges (60 painted rows) above one parked mcp card: the
    // transcript overage alone prices the card's region negative, and the
    // settled-cap floor would cut the args JSON to the 5-row budget's 412
    // visible columns — hiding the payload the approval is for. The mcp
    // dialog shows only the server and tool names and is off the alt screen
    // at this transcript height whatever the card yields, so the card — the
    // only surface still carrying the arguments — keeps the args-surface
    // floor: 11 budget rows = 1061 visible columns at 110. GROWN_MARKER
    // sits past the 412-column cut but inside the floor's budget.
    const history: LiveHistoryItem[] = [];
    for (let i = 0; i < 15; i++) {
      history.push({ kind: 'user', id: `u${i}`, text: `question ${i}` });
      history.push({
        kind: 'assistant',
        id: `a${i}`,
        text: `answer ${i}`,
        streaming: false,
      });
    }
    const description =
      '{"content":"' +
      'a'.repeat(600) +
      'GROWN_MARKER' +
      'b'.repeat(1500) +
      '"}';
    const { container } = render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[
          ...history,
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
    expect(text).toContain('GROWN_MARKER');
    expect(text).toContain('... last');
  });

  it('hands the painted transcript height to the pending budget (R2-2)', () => {
    // Two exchanges (a user row with its margin and a one-row assistant
    // reply: 2 + 2) above a parked card: the budget must see rowsAbove = 4,
    // and the pending card itself stays out of the count.
    const callsBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[
          { kind: 'user', id: 'u1', text: 'one' },
          { kind: 'assistant', id: 'a1', text: 'two', streaming: false },
          toolItem({
            id: 't1',
            description: 'x',
            confirm: 'pending',
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const rowsAboveArgs = mocks.pendingSpy.mock.calls
      .slice(callsBefore)
      .map((call) => call[6]);
    expect(rowsAboveArgs.length).toBeGreaterThan(0);
    for (const rowsAbove of rowsAboveArgs) {
      expect(rowsAbove).toBe(4);
    }
  });

  it('charges the painted rows of a settled card’s capped description (R10-1)', () => {
    // The card's flex row spends the 41-column mcp name before the
    // description wraps, so the description paints in the name-aware share
    // of the row — the budget's own wrap ratio — not the raw full-width
    // basis: a 3000-column args JSON capped to 390 visible columns paints
    // ceil(390 / 66) = 6 rows plus the hidden-tail label, not the 4+1 the
    // raw-cols measure charged.
    const callsBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[
          toolItem({
            id: 's1',
            tool: 'mcp__github_enterprise__create_repository',
            description: 'x'.repeat(3000),
            done: true,
            success: true,
            summary: 'ok',
          }),
          toolItem({
            id: 't1',
            description: 'y',
            confirm: 'pending',
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const rowsAboveArgs = mocks.pendingSpy.mock.calls
      .slice(callsBefore)
      .map((call) => call[6]);
    expect(rowsAboveArgs.length).toBeGreaterThan(0);
    for (const rowsAbove of rowsAboveArgs) {
      expect(rowsAbove).toBe(7);
    }

    // The same conversion prices a description UNDER the cap: 300 columns
    // fit the 5-row budget uncapped, but paint 4 rows in the name-aware
    // share (ceil(300 / 75)), not the 3 the raw-cols measure charged.
    const uncappedBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[
          toolItem({
            id: 's2',
            tool: 'read_file',
            description: 'x'.repeat(300),
            done: true,
            success: true,
            summary: 'ok',
          }),
          toolItem({
            id: 't1',
            description: 'y',
            confirm: 'pending',
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const uncappedArgs = mocks.pendingSpy.mock.calls
      .slice(uncappedBefore)
      .map((call) => call[6]);
    expect(uncappedArgs.length).toBeGreaterThan(0);
    for (const rowsAbove of uncappedArgs) {
      expect(rowsAbove).toBe(4);
    }
  });

  it('charges three painted rows per settled arena-agent card (R10-1)', () => {
    // ArenaAgentRow paints three unconditional rows — status, Tokens, Tool
    // Calls — plus the item margin; the row model charged one flat row for
    // the Tokens/Tool Calls pair, pricing every card one row low.
    const agent = (label: string) => ({
      label,
      status: AgentStatus.COMPLETED,
      durationMs: 1200,
      totalTokens: 10,
      inputTokens: 4,
      outputTokens: 6,
      toolCalls: 2,
      successfulToolCalls: 2,
      failedToolCalls: 0,
      rounds: 1,
    });
    const callsBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[
          { kind: 'arena-agent', id: 'a1', agent: agent('A1') },
          { kind: 'arena-agent', id: 'a2', agent: agent('A2') },
          { kind: 'arena-agent', id: 'a3', agent: agent('A3') },
          // The fourth card also paints the error row: 1 margin + 4 rows.
          {
            kind: 'arena-agent',
            id: 'a4',
            agent: { ...agent('A4'), error: 'boom' },
          },
          toolItem({
            id: 't1',
            description: 'y',
            confirm: 'pending',
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const rowsAboveArgs = mocks.pendingSpy.mock.calls
      .slice(callsBefore)
      .map((call) => call[6]);
    expect(rowsAboveArgs.length).toBeGreaterThan(0);
    for (const rowsAbove of rowsAboveArgs) {
      // 3 cards x (1 margin + 3 painted rows) + 1 x (1 margin + 4 rows).
      expect(rowsAbove).toBe(17);
    }

    // The failure suffix is part of the composed Tool Calls line: at a
    // 20-column width '  Tool Calls: 3 (✓ 2 ✕ 1)' (25 columns) wraps to 2
    // rows where the suffix-less 15 columns would not — and the 26-column
    // Tokens line wraps too (status stays 1 row).
    const failedBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={20}
        availableTerminalHeight={80}
        items={[
          {
            kind: 'arena-agent',
            id: 'a5',
            agent: {
              ...agent('A5'),
              toolCalls: 3,
              successfulToolCalls: 2,
              failedToolCalls: 1,
            },
          },
          toolItem({
            id: 't1',
            description: 'y',
            confirm: 'pending',
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const failedArgs = mocks.pendingSpy.mock.calls
      .slice(failedBefore)
      .map((call) => call[6]);
    expect(failedArgs.length).toBeGreaterThan(0);
    for (const rowsAbove of failedArgs) {
      // 1 margin + 1 status + 2 Tokens + 2 Tool Calls.
      expect(rowsAbove).toBe(6);
    }
  });

  it('composes every arena-session line the way the card paints it (R10-1)', () => {
    // The flat per-line charge dropped the approach lines' diff-stat suffix
    // (~33 columns) and never wrapped the status/file/token lines. Here
    // each 69-column approach summary wraps to 2 painted rows at width 110
    // once its suffix rides along — the model must follow.
    const agent = (label: string) => ({
      label,
      status: AgentStatus.COMPLETED,
      durationMs: 1000,
      totalTokens: 10,
      inputTokens: 4,
      outputTokens: 6,
      toolCalls: 2,
      successfulToolCalls: 2,
      failedToolCalls: 0,
      rounds: 1,
      approachSummary: 'x'.repeat(69),
    });
    const callsBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={110}
        availableTerminalHeight={80}
        items={[
          {
            kind: 'arena-session',
            id: 'as1',
            sessionStatus: 'completed',
            task: 'do it',
            totalDurationMs: 2000,
            agents: [agent('A'), agent('B')],
          },
          toolItem({
            id: 't1',
            description: 'y',
            confirm: 'pending',
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const rowsAboveArgs = mocks.pendingSpy.mock.calls
      .slice(callsBefore)
      .map((call) => call[6]);
    expect(rowsAboveArgs.length).toBeGreaterThan(0);
    for (const rowsAbove of rowsAboveArgs) {
      // 1 margin + title, the Status/Files/Approach/Token headers (4), 2
      // status lines, 1 (empty) common-files group, 2 approach lines at 2
      // rows each, 2 token lines, and the Run hint.
      expect(rowsAbove).toBe(16);
    }
  });

  it('prices the thinking header and retry countdown as wrapping rows (R10-1)', () => {
    // Both are unpadded wrapping texts the model charged a flat row for: at
    // a 30-column width the duration-labelled thought header (36 columns)
    // paints 2 rows and the two-digit retry countdown (35 columns) paints
    // 2 — the flat charge reads 4 where the render paints 6.
    const callsBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={30}
        availableTerminalHeight={80}
        items={[
          {
            kind: 'thinking',
            id: 'th1',
            text: 'body',
            done: true,
            durationMs: 12_000,
          },
          {
            kind: 'retry',
            id: 'r1',
            attempt: 2,
            maxRetries: 3,
            delayMs: 15_000,
            startedAt: Date.now(),
          },
          toolItem({
            id: 't1',
            description: 'y',
            confirm: 'pending',
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const rowsAboveArgs = mocks.pendingSpy.mock.calls
      .slice(callsBefore)
      .map((call) => call[6]);
    expect(rowsAboveArgs.length).toBeGreaterThan(0);
    for (const rowsAbove of rowsAboveArgs) {
      // thinking: 1 margin + 2 header rows; retry: 1 message + 2 countdown.
      expect(rowsAbove).toBe(6);
    }
  });

  it('counts TAB at its painted two columns in the transcript row model (R11-2)', () => {
    // A settled card's tool output keeps its TABs (sanitizeTerminalText
    // preserves them deliberately) and the renderer advances each exactly 2
    // columns: 10 lines of TAB + 105 columns paint 107 columns — 2 rows
    // each at the card's 106-column basis — while the raw string width
    // (TAB = 0 columns) measures 1.
    const callsBefore = mocks.pendingSpy.mock.calls.length;
    render(
      <OpenTuiTranscriptView
        availableWidth={108}
        availableTerminalHeight={80}
        items={[
          toolItem({
            id: 's1',
            tool: 'read_file',
            done: true,
            success: true,
            summary: 'ok',
            output: Array.from(
              { length: 10 },
              () => '\t' + 'x'.repeat(105),
            ).join('\n'),
          }),
          toolItem({
            id: 't1',
            description: 'y',
            confirm: 'pending',
            confirmType: 'mcp',
          }),
        ]}
      />,
    );
    const rowsAboveArgs = mocks.pendingSpy.mock.calls
      .slice(callsBefore)
      .map((call) => call[6]);
    expect(rowsAboveArgs.length).toBeGreaterThan(0);
    for (const rowsAbove of rowsAboveArgs) {
      // 1 header row + 10 tabbed output rows at 2 painted rows each.
      expect(rowsAbove).toBe(21);
    }
  });
});
