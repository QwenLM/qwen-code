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
 * approvable with its arguments on screen — the `!` shell row carries ink's
 * `$ ` prefix, and `ui.showToolCallArgs` adds ink's inline arguments row
 * under the card header.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { AgentStatus } from '@qwen-code/qwen-code-core';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

const mocks = vi.hoisted(() => {
  /** How many opentui elements the JSX runtime has been asked for. A frame that
   *  measures nothing new must leave this alone — a re-render is the observable
   *  cost of a spurious one. */
  let rendered = 0;
  // The components carry the @opentui/react JSX import source; map its
  // primitive elements to DOM nodes so @testing-library/react can mount them.
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      rendered++;
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text' || type === 'span') {
        // jsdom drops unknown props, so the colour-bearing opentui attributes
        // are surfaced as data-* for assertions to pin.
        const dom: Record<string, unknown> = key === undefined ? {} : { key };
        const source = (config ?? {}) as Record<string, unknown>;
        for (const name of ['fg', 'bg', 'borderColor', 'attributes']) {
          if (source[name] !== undefined) dom[`data-${name}`] = source[name];
        }
        if (source['flexDirection'] !== undefined) {
          dom['data-direction'] = source['flexDirection'];
        }
        for (const name of ['width', 'height']) {
          if (source[name] !== undefined) {
            dom[`data-${name}`] = String(source[name]);
          }
        }
        if (source['ref'] !== undefined) {
          // The transcript's windowing hangs off the root element it is handed
          // here, so the ref has to survive the mapping to a DOM node.
          dom['ref'] = source['ref'];
        }
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          dom,
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

  /** Stand-in for the OpenTUI renderer: a bare event target, so a test can fire
   *  the `frame` event the windowing measures and samples on. */
  function createFakeRenderer() {
    const handlers = new Map<string, Set<() => void>>();
    const listeners = (event: string): Set<() => void> => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      return set;
    };
    return {
      on: (event: string, fn: () => void) => void listeners(event).add(fn),
      off: (event: string, fn: () => void) => void listeners(event).delete(fn),
      emit: (event: string) => {
        for (const fn of [...listeners(event)]) fn();
      },
      count: (event: string) => listeners(event).size,
    };
  }

  const renderer = createFakeRenderer();
  return {
    buildJsxRuntime,
    renderer,
    renders: () => rendered,
    countRender: () => void rendered++,
    resetRenders: () => void (rendered = 0),
  };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
// Without a scroll host the transcript falls back to a bottom-anchored window
// sized from `availableTerminalHeight`, which is what the mount tests assert on.
// `OpenTuiTranscriptView scroll host` below installs one.
vi.mock('@opentui/react', () => ({ useRenderer: () => mocks.renderer }));

import { OpenTuiTranscriptView } from './transcript-view.js';
import { C } from './theme.js';
import type {
  LiveAssistantItem,
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
        awaitingCallId="t1"
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
    expect(container.textContent).toContain('←');
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
        awaitingCallId="t1"
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
    expect(pending.container.textContent).toContain('←');
    pending.unmount();

    const settled = render(
      <OpenTuiTranscriptView
        availableTerminalHeight={80}
        awaitingCallId="t1"
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
    expect(settled.container.textContent).not.toContain('←');
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
        awaitingCallId="t1"
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
    expect(text).toContain('←');
  });

  it('yields pending rows a hook-confirmation dialog needs when expanded (mem0 e2e)', () => {
    // The mem0 confirmation duplicates the card's description inside its own
    // body: once ctrl-s expands it, the whole payload plus the confirmation's
    // chrome must fit the viewport, so a ~4k-char payload must shrink the card
    // BELOW the collapsed bound (37 rows at h=80). A marker placed past the
    // yielded budget pins the shrink — that bound alone would still show it
    // and the e2e expansion stage would stay red.
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
        awaitingCallId="t1"
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
    expect(text).toContain('←');
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

  describe("ink's inline arguments row (ui.showToolCallArgs)", () => {
    const argsItem = (overrides: Partial<LiveToolItem> = {}) =>
      toolItem({
        tool: 'write_file',
        title: 'write_file',
        args: '{"file_path":"/x","content":"ARGS_ROW_MARKER"}',
        confirm: 'approved',
        done: true,
        ...overrides,
      });

    it('stays off unless the setting is enabled', () => {
      const { container } = render(
        <OpenTuiTranscriptView items={[argsItem()]} />,
      );
      // ink reads the same setting; off is the schema default, so the header
      // alone carries the call (the file path is ink's description).
      expect(container.textContent).not.toContain('ARGS_ROW_MARKER');
    });

    it('draws the raw JSON on its own line under the header', () => {
      const { container } = render(
        <OpenTuiTranscriptView
          items={[argsItem({ description: 'HEADER_ROW_MARKER' })]}
          showToolCallArgs
        />,
      );
      const text = container.textContent ?? '';
      expect(text).toContain('{"file_path":"/x","content":"ARGS_ROW_MARKER"}');
      // The row follows the header it belongs to, not the card body. The header
      // is named by its own marker: the tool name this fixture passes is mapped
      // to a display name before it is drawn, so ordering against it would
      // compare two absent strings.
      expect(text.indexOf('ARGS_ROW_MARKER')).toBeGreaterThan(
        text.indexOf('HEADER_ROW_MARKER'),
      );
    });

    it('skips the row when the header already prints the args (MCP dedup)', () => {
      const json = '{"path":"/x","content":"SECRET_PAYLOAD"}';
      const payloadRows = (text: string) =>
        text.match(/SECRET_PAYLOAD/g)?.length ?? 0;
      const deduped = render(
        <OpenTuiTranscriptView
          items={[
            argsItem({
              tool: 'mcp__fs__write_file',
              description: json,
              args: json,
            }),
          ]}
          showToolCallArgs
        />,
      );
      // MCP tools describe themselves as their own arguments, so both surfaces
      // would print the same payload.
      expect(payloadRows(deduped.container.textContent ?? '')).toBe(1);
      deduped.unmount();

      // Positive control: a header that carries the payload without *being* it
      // keeps both lines, so the one above is the dedup dropping the row — not
      // the row failing to render at all.
      const other = render(
        <OpenTuiTranscriptView
          items={[
            argsItem({
              tool: 'mcp__fs__write_file',
              description: `write_file ${json}`,
              args: json,
            }),
          ]}
          showToolCallArgs
        />,
      );
      expect(payloadRows(other.container.textContent ?? '')).toBe(2);
    });

    it('caps the row at two wrapped rows and names ctrl+o as the valve', () => {
      // ink bounds the row against the header's inner width (80 columns minus
      // the status glyph), so a WriteFile `content` arg cannot bury the
      // conversation; the marker advertises what ctrl+O reveals.
      const json = '{"file_path":"/x","content":"' + 'z'.repeat(400) + 'TAIL"}';
      const { container } = render(
        <OpenTuiTranscriptView
          items={[argsItem({ args: json })]}
          showToolCallArgs
        />,
      );
      const text = container.textContent ?? '';
      expect(text).toContain('… +');
      expect(text).toContain('chars (ctrl+o)');
      expect(text).not.toContain('TAIL');
    });

    it("uncaps the row on ink's ctrl+O full-detail flag", () => {
      const json = '{"file_path":"/x","content":"' + 'z'.repeat(400) + 'TAIL"}';
      const { container } = render(
        <OpenTuiTranscriptView
          items={[argsItem({ args: json })]}
          showToolCallArgs
          thoughtsExpanded
        />,
      );
      const text = container.textContent ?? '';
      expect(text).toContain('TAIL');
      expect(text).not.toContain('ctrl+o)');
    });
  });

  it("marks only the first awaiting call with ink's ← indicator", () => {
    // ink's TrailingIndicator sits on `toolAwaitingApproval`, the first call in
    // confirming status — opentui renders only that card's dialog, so arrows on
    // every pending row would point at calls with nothing on screen to answer.
    const { container } = render(
      <OpenTuiTranscriptView
        awaitingCallId="t1"
        items={[
          toolItem({ description: 'echo one', confirm: 'pending' }),
          toolItem({
            id: 't2',
            description: 'echo two',
            confirm: 'pending',
          }),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text.split('←')).toHaveLength(2);
    expect(text.indexOf('←')).toBeLessThan(text.indexOf('echo two'));
  });

  it('marks the awaiting call the queue names, not the first pending row', () => {
    // A PreToolUse `ask` hook re-arms a call that already left the queue: it is
    // appended behind the call still waiting, while its own card goes back to
    // pending where it sits in the transcript. The dialog on screen is the
    // queue's head, so that is the card carrying the arrow.
    const { container } = render(
      <OpenTuiTranscriptView
        awaitingCallId="t2"
        items={[
          toolItem({ description: 'echo one', confirm: 'pending' }),
          toolItem({
            id: 't2',
            description: 'echo two',
            confirm: 'pending',
          }),
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text.split('←')).toHaveLength(2);
    expect(text.indexOf('←')).toBeGreaterThan(text.indexOf('echo two'));
  });

  it('draws no arrow on a card whose call has finished', () => {
    // The marker needs the card to be a pending, unfinished tool row, not only
    // the one the queue names: a call that has already run draws no arrow even
    // while its card still reads pending. Every other case here leaves `done`
    // at the helper's false, so this is that term's only witness.
    const { container } = render(
      <OpenTuiTranscriptView
        awaitingCallId="t1"
        items={[
          toolItem({
            description: 'echo done',
            confirm: 'pending',
            done: true,
          }),
        ]}
      />,
    );
    expect(container.textContent).not.toContain('←');
    expect(container.textContent).toContain('echo done');
  });

  it('bolds only the tool name, leaving the status glyph at ink’s weight', () => {
    const { container } = render(
      <OpenTuiTranscriptView items={[toolItem({ tool: 'custom-tool' })]} />,
    );
    const name = [...container.querySelectorAll('span')]
      .filter((row) => (row.textContent ?? '').includes('custom-tool'))
      .pop();
    expect(name).toBeDefined();
    const glyph = name
      ?.closest('div[data-direction="row"]')
      ?.querySelector('div > span');
    expect(glyph?.textContent?.trim()).not.toBe('');
    expect(glyph?.getAttribute('data-attributes')).toBe('0');
    expect(name?.getAttribute('data-attributes')).toBe('1');
  });

  it('paints the subagent summary as ink’s three runs', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={[
          toolItem({
            output: '',
            subagentSummary: {
              glyph: '✔',
              tone: 'success',
              prefix: 'reviewer: ',
              rest: 'check imports · 5 tools',
            },
          }),
        ]}
      />,
    );
    const spans = [...container.querySelectorAll('span')];
    const glyph = spans.find((row) => (row.textContent ?? '').trim() === '✔');
    expect(glyph?.getAttribute('data-fg')).toBe(C.green);
    expect(glyph?.getAttribute('data-attributes')).toBeNull();
    const prefix = spans.find((row) =>
      (row.textContent ?? '').includes('reviewer:'),
    );
    expect(prefix?.getAttribute('data-fg')).toBe(C.text);
    expect(prefix?.getAttribute('data-attributes')).toBe('1');
    const rest = spans.find((row) =>
      (row.textContent ?? '').includes('check imports'),
    );
    expect(rest?.getAttribute('data-fg')).toBe(C.dim);
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
    expect(collapsed.container.querySelector('markdown')).toBeNull();
    collapsed.unmount();

    const expanded = render(
      <OpenTuiTranscriptView items={items} thoughtsExpanded />,
    );
    expect(
      expanded.container.querySelector('markdown')?.getAttribute('content'),
    ).toContain('INSPECTING_THE_REPOSITORY');
    expect(expanded.container.textContent).toContain('ctrl+o to collapse');
  });

  it('drops the click affordance from both hints when ui.mouseTracking is off (#172)', () => {
    const thought: LiveThinkingItem[] = [
      {
        kind: 'thinking',
        id: 'th1',
        text: 'BODY',
        done: true,
        durationMs: 12_000,
      },
    ];
    const tool = [toolItem({ description: 'echo HI', done: true })];

    const clickable = render(<OpenTuiTranscriptView items={thought} />);
    expect(clickable.container.textContent).toContain('click or ctrl+o');
    clickable.unmount();
    const toolClickable = render(
      <OpenTuiTranscriptView items={tool} showToolCallDetails={false} />,
    );
    expect(toolClickable.container.textContent).toContain('click to expand');
    toolClickable.unmount();

    // The renderer takes no pointer events in this configuration, so a hint
    // offering a click would advertise a dead affordance.
    const noMouse = render(
      <OpenTuiTranscriptView items={thought} mouseTracking={false} />,
    );
    expect(noMouse.container.textContent).toContain('(ctrl+o to expand)');
    expect(noMouse.container.textContent).not.toContain('click');
    noMouse.unmount();
    const toolNoMouse = render(
      <OpenTuiTranscriptView
        items={tool}
        showToolCallDetails={false}
        mouseTracking={false}
      />,
    );
    expect(toolNoMouse.container.textContent).toContain('ctrl+o to expand');
    expect(toolNoMouse.container.textContent).not.toContain('click');
  });

  it('stamps the assistant row only when output.showTimestamps is on (#76)', () => {
    const items: LiveAssistantItem[] = [
      {
        kind: 'assistant',
        id: 'a1',
        text: 'ANSWER_BODY',
        streaming: false,
        timestamp: Date.UTC(2026, 8, 18, 7, 5, 9),
      },
    ];
    const stamped = render(
      <OpenTuiTranscriptView items={items} showTimestamps />,
    );
    expect(stamped.container.textContent).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    stamped.unmount();

    const plain = render(<OpenTuiTranscriptView items={items} />);
    expect(plain.container.textContent).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  it('remounts the assistant row when the stamp setting flips (#170)', () => {
    // `output.showTimestamps` is dialog-settable and needs no restart, so an
    // already-mounted row switches shape mid-session. The two shapes differ,
    // and this renderer never clears a prop a re-render drops, so they have to
    // remount rather than reuse: the stamped branch's second child would
    // otherwise keep the flexGrow the unstamped one gave it.
    const items: LiveAssistantItem[] = [
      {
        kind: 'assistant',
        id: 'a1',
        text: 'ANSWER_BODY',
        streaming: false,
        timestamp: Date.UTC(2026, 8, 18, 7, 5, 9),
      },
    ];
    const { container, rerender } = render(
      <OpenTuiTranscriptView items={items} />,
    );
    const bare = container.querySelector('[data-direction="row"]');
    expect(bare?.querySelector('markdown')?.getAttribute('content')).toContain(
      'ANSWER_BODY',
    );

    rerender(<OpenTuiTranscriptView items={items} showTimestamps />);
    expect(bare?.isConnected).toBe(false);
    expect(container.textContent).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    expect(
      container.querySelector('markdown')?.getAttribute('content'),
    ).toContain('ANSWER_BODY');
  });

  it('gives the row glyph a structural gap, not a trailing space (#188)', () => {
    // A space inside the glyph's own text node is squeezed out as soon as the
    // sibling needs the full width, so a long wrapped answer printed as
    // `◆︎Answer`. Only a fixed-width box keeps the column.
    const rows = render(
      <OpenTuiTranscriptView
        items={[
          { kind: 'user', id: 'u1', text: 'QUESTION_BODY' },
          {
            kind: 'assistant',
            id: 'a1',
            text: 'ANSWER_BODY',
            streaming: false,
          },
        ]}
      />,
    );
    const glyphBoxes = rows.container.querySelectorAll('[data-width="2"]');
    expect(glyphBoxes).toHaveLength(2);
    for (const box of glyphBoxes) {
      const glyph = box.firstElementChild;
      expect(glyph?.textContent).toMatch(/^\S{1,2}$/u);
      expect(glyph?.parentElement).toBe(box);
    }
    expect(rows.container.textContent).toContain('QUESTION_BODY');
    expect(
      rows.container.querySelector('markdown')?.getAttribute('content'),
    ).toContain('ANSWER_BODY');
  });

  it('collapses a settled tool card when ui.showToolCallDetails is false (#85)', () => {
    const items = [
      toolItem({
        tool: 'mcp__fs__write_file',
        description: '{"path":"/x","content":"SECRET_PAYLOAD"}',
        done: true,
      }),
    ];
    const collapsed = render(
      <OpenTuiTranscriptView items={items} showToolCallDetails={false} />,
    );
    expect(collapsed.container.textContent).not.toContain('SECRET_PAYLOAD');
    expect(collapsed.container.textContent).toContain('click to expand');
    collapsed.unmount();

    const detailed = render(<OpenTuiTranscriptView items={items} />);
    expect(detailed.container.textContent).toContain('SECRET_PAYLOAD');
    expect(detailed.container.textContent).not.toContain('click to expand');
  });

  it('keeps the header row element when ctrl+O opens a collapsed card (#167)', () => {
    // @opentui/react never clears a prop a re-render drops, so a collapsed
    // branch of its own shape reconciled its glyph box onto the expanded
    // header row and left width=2 stuck on it: the terminal drew `✓ S` and
    // lost the description. One tree shape for both states is the fix, and
    // element identity across the toggle is what pins it.
    const items = [toolItem({ description: 'echo ACCEPT_MARKER', done: true })];
    const { container, rerender } = render(
      <OpenTuiTranscriptView
        items={items}
        showToolCallDetails={false}
        thoughtsExpanded={false}
      />,
    );
    const headerOf = (label: string) => {
      const span = [...container.querySelectorAll('span')].find((el) =>
        (el.textContent ?? '').includes(label),
      );
      let node = span?.parentElement ?? null;
      while (node && node.dataset['direction'] !== 'row') {
        node = node.parentElement;
      }
      return node;
    };
    const collapsedHeader = headerOf('Shell');
    expect(collapsedHeader?.dataset['direction']).toBe('row');
    expect(collapsedHeader?.dataset['width']).toBeUndefined();
    expect(collapsedHeader?.textContent).toContain('click to expand');

    rerender(
      <OpenTuiTranscriptView
        items={items}
        showToolCallDetails={false}
        thoughtsExpanded
      />,
    );
    const expandedHeader = headerOf('Shell');
    expect(expandedHeader).toBe(collapsedHeader);
    expect(expandedHeader?.dataset['width']).toBeUndefined();
    expect(expandedHeader?.textContent).toContain('echo ACCEPT_MARKER');
    expect(expandedHeader?.textContent).not.toContain('click to expand');
    // The glyph box is the only child that ever carries a width.
    expect(expandedHeader?.querySelectorAll('[data-width]')).toHaveLength(1);
  });

  it('keeps a card that still needs an answer open with details off (#85)', () => {
    // ink's CollapsibleToolGroupMessage never collapses a call while it is
    // waiting: the card is the only surface carrying the payload being approved.
    const { container } = render(
      <OpenTuiTranscriptView
        awaitingCallId="t1"
        showToolCallDetails={false}
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
    expect(container.textContent).not.toContain('click to expand');
  });
});

/**
 * Windowing regression guard for the blank-screen bug: a session long enough to
 * exhaust the process's native TextBuffer allocations must not mount every item.
 * Without a scroll host (jsdom has none) the window is bottom-anchored and sized
 * from `availableTerminalHeight`, so the tail is what shows.
 */
describe('OpenTuiTranscriptView windowing', () => {
  const longSession = Array.from({ length: 2000 }, (_, index) => ({
    kind: 'user' as const,
    id: `u${index}`,
    text: `TURN_${String(index).padStart(4, '0')}`,
  }));

  it('mounts only the tail of a long session', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={longSession}
        availableTerminalHeight={24}
      />,
    );
    expect(container.textContent).toContain('TURN_1999');
    expect(container.textContent).not.toContain('TURN_0000');
    expect(container.querySelectorAll('div').length).toBeLessThan(400);
  });

  it('mounts the head of a top-anchored pane', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={longSession}
        availableTerminalHeight={24}
        initialAnchor="top"
      />,
    );
    expect(container.textContent).toContain('TURN_0000');
    expect(container.textContent).not.toContain('TURN_1999');
    expect(container.querySelectorAll('div').length).toBeLessThan(400);
  });

  it('re-seeds a host-less pane when the terminal height changes', () => {
    // The session preview has no scroll host to report a viewport, so the height
    // prop is the only source — and seeding it once at mount left the window
    // sized for the old terminal after a resize.
    const mountedCount = (container: HTMLElement) =>
      [...(container.textContent ?? '').matchAll(/TURN_\d+/g)].length;
    const view = render(
      <OpenTuiTranscriptView
        items={longSession}
        availableTerminalHeight={24}
        initialAnchor="top"
      />,
    );
    const at24 = mountedCount(view.container);
    view.rerender(
      <OpenTuiTranscriptView
        items={longSession}
        availableTerminalHeight={60}
        initialAnchor="top"
      />,
    );
    expect(mountedCount(view.container)).toBeGreaterThan(at24);
  });

  it('measures real heights in a host-less pane', () => {
    // The session preview mounts outside the shell's scrollbox, so there is no
    // host to sync a window from — but the turns it does mount are laid out,
    // and a frame that skipped measuring them would leave the pane sized from
    // estimates for its whole life.
    const view = render(
      <OpenTuiTranscriptView
        items={longSession}
        availableTerminalHeight={24}
        initialAnchor="top"
      />,
    );
    const mountedCount = () =>
      [...(view.container.textContent ?? '').matchAll(/TURN_\d+/g)].length;
    const atEstimate = mountedCount();
    act(() => {
      const root = view.container.firstElementChild as Element;
      for (const el of root.children) {
        // A one-row turn: Yoga computes the margin row alone, and the reported
        // height is clamped to 1 whether or not anything was laid out.
        Object.defineProperty(el, 'height', { value: 1, configurable: true });
        Object.defineProperty(el, 'yogaNode', {
          value: { getComputedHeight: () => 0 },
          configurable: true,
        });
      }
      mocks.renderer.emit('frame');
    });
    expect(mountedCount()).toBeGreaterThan(atEstimate);
  });
});

/**
 * The frame-driven half of the windowing, against a stand-in scroll host.
 *
 * jsdom has no renderables, so the host the view walks up to (`scrollTop`,
 * `content`, `viewport`, `verticalScrollBar`) and the laid-out tree it reads
 * back (`parent`, `getChildren()`, `height`) are installed on the DOM nodes the
 * JSX mock produces. A re-render replaces the item nodes, so the tree is
 * re-installed before every frame — which is also what makes the heights below
 * live: `rows[index]` is read at measure time, not at mount time.
 */
describe('OpenTuiTranscriptView scroll host', () => {
  const session = Array.from({ length: 2000 }, (_, index) => ({
    kind: 'user' as const,
    id: `u${index}`,
    text: `TURN_${String(index).padStart(4, '0')}`,
  }));

  function mountHosted(opts: {
    /** Rows each turn's box is laid out at. `0` means laid out empty: Yoga
     *  computes 0 while the reported height is clamped to 1. */
    rows: number[];
    items?: readonly LiveHistoryItem[];
    viewportRows?: number;
    /** The height prop, deliberately separate from the host's own viewport. */
    propRows?: number;
    width?: number;
  }) {
    let width = opts.width ?? 100;
    const rows = opts.rows;
    let items = opts.items ?? session;
    const viewportRows = opts.viewportRows ?? 24;
    const propRows = opts.propRows ?? viewportRows;
    const view = render(
      <OpenTuiTranscriptView
        items={items}
        availableWidth={width}
        availableTerminalHeight={propRows}
      />,
    );

    const changed = new Set<() => void>();
    /** The transcript sits two rows into a scroll content whose absolute `y`
     *  carries the scroll translation, so neither operand of the offset the
     *  view subtracts is zero and neither is the other. */
    const CONTENT_BASE = 5;
    const TRANSCRIPT_OFFSET = 2;
    /** The rows a direct child of the transcript root paints: a spacer reports
     *  its `height` prop, an item box reports what Yoga laid out plus a margin
     *  row. The margin is modelled as one row for every turn; a `tool` or
     *  `task` card carries none, so `scrollHeight` over-counts those by one.
     *  Only the sticky guard reads it, and only against the tail. */
    const paintedRows = (el: Element) => {
      if (el.hasAttribute('data-height')) {
        return Number(el.getAttribute('data-height'));
      }
      const turn = /TURN_(\d+)/.exec(el.textContent ?? '');
      return turn ? (rows[Number(turn[1])] ?? 0) + 1 : 0;
    };
    const host = {
      scrollTop: 0,
      get content() {
        return { y: CONTENT_BASE - host.scrollTop };
      },
      get scrollHeight() {
        const root = view.container.firstElementChild as Element;
        if (!root) return 0;
        let total = TRANSCRIPT_OFFSET;
        for (const el of root.children) total += paintedRows(el);
        return total;
      },
      viewport: { height: viewportRows },
      verticalScrollBar: {
        on: (_event: string, fn: () => void) => void changed.add(fn),
        off: (_event: string, fn: () => void) => void changed.delete(fn),
      },
    };

    const install = () => {
      const root = view.container.firstElementChild as Element;
      /** The turn an item box stands for, or -1 for chrome the view does not
       *  measure: the root carries every turn, a spacer carries none. */
      const turnOf = (el: Element) => {
        if (el === root || el.parentElement !== root) return -1;
        const turn = /TURN_(\d+)/.exec(el.textContent ?? '');
        return turn ? Number(turn[1]) : -1;
      };
      const walk = (el: Element, parent: unknown) => {
        Object.defineProperty(el, 'parent', {
          value: parent,
          configurable: true,
        });
        Object.defineProperty(el, 'y', {
          get: () =>
            el === root ? CONTENT_BASE - host.scrollTop + TRANSCRIPT_OFFSET : 0,
          configurable: true,
        });
        const turn = turnOf(el);
        const laidOut = turn < 0 ? 0 : (rows[turn] ?? 0);
        // `Renderable.height` is clamped to at least one row, so a box laid out
        // empty still reports 1 while Yoga's own computed height stays 0.
        Object.defineProperty(el, 'height', {
          get: () => (turn < 0 ? 0 : Math.max(laidOut, 1)),
          configurable: true,
        });
        Object.defineProperty(el, 'yogaNode', {
          value: { getComputedHeight: () => laidOut },
          configurable: true,
        });
        for (const child of el.children) walk(child, el);
      };
      walk(root, host);
    };
    install();

    const paint = () =>
      act(() => {
        view.rerender(
          <OpenTuiTranscriptView
            items={items}
            availableWidth={width}
            availableTerminalHeight={propRows}
          />,
        );
        install();
      });

    /** The ids the view has mounted, in transcript order. */
    const mounted = () =>
      [...(view.container.textContent ?? '').matchAll(/TURN_(\d+)/g)].map(
        (match) => match[1],
      );

    return {
      container: view.container,
      host,
      /** How many scroll-bar `change` subscriptions the view has installed. */
      scrollListeners: () => changed.size,
      /** One renderer frame: layout is done, so heights can be measured. */
      frame: () =>
        act(() => {
          install();
          mocks.renderer.emit('frame');
        }),
      /** An absolute jump — a track click or a thumb drag. Fires the scroll bar
       *  without a frame, which is the only way to tell a pre-paint window
       *  update from one that waits to be sampled. */
      jump: (top: number) =>
        act(() => {
          host.scrollTop = top;
          for (const fn of [...changed]) fn();
        }),
      setWidth: (next: number) => {
        width = next;
        paint();
      },
      /** A new item list — what a `task-end` splice does to the transcript. */
      setItems: (next: readonly LiveHistoryItem[]) => {
        items = next;
        paint();
      },
      mounted,
      /** The top and bottom spacer heights the window is padding with. */
      spacers: () => {
        const root = view.container.firstElementChild as Element;
        const kids = [...root.children];
        const at = (el: Element | undefined) =>
          el ? Number(el.getAttribute('data-height') ?? -1) : -1;
        return { top: at(kids[0]), bottom: at(kids.at(-1)) };
      },
      unmount: () => act(() => view.unmount()),
    };
  }

  it('records real heights without moving the scroll position', () => {
    const rows = Array.from({ length: 2000 }, () => 3);
    const view = mountHosted({ rows });
    view.host.scrollTop = 3000;
    // Two frames: the first mounts the window the new position asks for, the
    // second measures it. Without the second there is no recorded height for
    // the turns below to contradict, and the frame under test measures them for
    // the first time instead of revising them.
    view.frame();
    view.frame();
    const settled = view.host.scrollTop;
    expect(settled).toBe(3000);

    // Every mounted turn turns out taller than measured. The correction this
    // used to write through the sticky-aware `scrollTop` setter is not owed:
    // the items are already painted at these heights, and both spacers are
    // derived from offsets a change inside the window leaves alone. Writing it
    // moved the reading position and, at the tail, latched the shell's bottom
    // pin off for the rest of the session.
    rows.fill(10);
    view.frame();
    expect(view.host.scrollTop).toBe(3000);
  });

  it('answers a scrollbar jump without waiting for a frame', () => {
    const rows = Array.from({ length: 2000 }, () => 3);
    const view = mountHosted({ rows });
    view.frame();

    // An absolute jump the fixed overscan cannot cover: the window has to be
    // recomputed from the scroll bar's own `change` event, because the frame
    // that would sample it is the frame that paints the gap.
    view.jump(4000);
    expect(view.container.textContent).not.toContain('TURN_0000');
    expect(view.mounted().length).toBeGreaterThan(0);

    view.jump(0);
    expect(view.mounted()[0]).toBe('0000');
    expect(view.scrollListeners()).toBe(1);
  });

  it('keeps the reading position across a resize', () => {
    const rows = Array.from({ length: 2000 }, () => 8);
    const view = mountHosted({ rows, width: 100 });
    // Read 120 rows down and let the turns there be measured, so the height
    // table disagrees with the estimates for rows above the reading position —
    // the state a real resize finds the transcript in.
    view.frame();
    view.jump(120);
    view.frame();
    const before = view.mounted();
    expect(before[0]).not.toBe('0000');

    // Wrapping changes, so the mounted items are re-measured — but the height
    // table is not thrown away. Clearing it renumbered every offset underneath
    // a scroll position counted in rows and moved the visible turn by more than
    // a hundred.
    view.setWidth(60);
    expect(view.mounted()).toEqual(before);
  });

  it('travels the whole distance over turns shorter than the estimate', () => {
    const rows = Array.from({ length: 2000 }, () => 1);
    const view = mountHosted({ rows });
    view.frame();
    view.jump(3000);
    view.frame();
    view.frame();
    const before = Number(view.mounted()[0]);

    // Six rows up over turns that cost two rows each, so three more come into
    // view. The turns the move pulls in above the viewport were sized from the
    // estimate, so the frame that measures them shrinks the table under the
    // reader; without settling that into the scroll position the window lands
    // back down and the tick travels less than it was told to.
    view.jump(view.host.scrollTop - 6);
    view.frame();
    view.frame();
    expect(before - Number(view.mounted()[0])).toBe(3);
  });

  it('settles a turn whose recorded height went stale while it was off-window', () => {
    const rows = Array.from({ length: 2000 }, () => 8);
    const view = mountHosted({ rows });
    view.frame();
    view.jump(900);
    view.frame();
    const read = Number(view.mounted()[0]);

    // A screen down evicts the top of that band, and the height table keeps the
    // nine rows it recorded rather than dropping them.
    view.jump(view.host.scrollTop + 24);
    view.frame();
    expect(Number(view.mounted()[0])).toBeGreaterThan(read);

    // ctrl+O collapses every card at once, so what the evicted turn paints
    // changes with nothing mounted to re-measure it — the disagreement a resize
    // leaves behind in exactly the same way.
    rows[read] = 2;

    // Wheeling back up pulls it in above the viewport, where the render body
    // charges it the nine rows the table still records while it paints three.
    // The table under the reader shrinks by the difference, so the reading
    // position has to move with it or the tick travels less than it was told.
    const before = view.host.scrollTop - 24;
    view.jump(before);
    expect(view.mounted()[0]).toBe(String(read).padStart(4, '0'));
    view.frame();
    expect(view.host.scrollTop).toBe(before - 6);
  });

  it('spends a charge on the measurement that answers it, not on a later one', () => {
    const rows = Array.from({ length: 2000 }, () => 8);
    const view = mountHosted({ rows });
    view.frame();
    view.jump(900);
    view.frame();
    const read = Number(view.mounted()[0]);
    view.jump(view.host.scrollTop + 24);
    view.frame();
    view.jump(view.host.scrollTop - 24);
    view.frame();
    const settled = view.host.scrollTop;
    expect(view.mounted()[0]).toBe(String(read).padStart(4, '0'));

    // The turn came back at exactly the height the table recorded, so its
    // charge is spent and nothing is owed. Growing it now that it is mounted
    // owes nothing either: a charge kept past the measurement that answered it
    // would settle here from a provenance that was never a pull-in, walking the
    // reader twelve rows downhill with no scroll input at all.
    rows[read] = 20;
    view.frame();
    expect(view.host.scrollTop).toBe(settled);
  });

  it('never charges a turn the previous commit already had mounted', () => {
    const rows = Array.from({ length: 2000 }, () => 8);
    const view = mountHosted({ rows });
    view.frame();
    view.jump(900);
    view.frame();
    view.jump(view.host.scrollTop + 24);
    view.frame();
    const painted = view.mounted();
    const before = view.host.scrollTop;

    // `task-end` splices a card out by index, so the render body walks the new
    // index space against the previous window's bound and the range it charges
    // can name a turn that never left the screen. Which turn that is depends on
    // how far the splice shifts the offsets, so it is read off the mount rather
    // than assumed — and asserted to have been painted beforehand, which is the
    // whole condition under test.
    view.setItems(
      session.filter((_item, index) => index !== 10 && index !== 11),
    );
    const still = Number(view.mounted()[0]);
    expect(painted).toContain(String(still).padStart(4, '0'));

    // Growing it owes nothing: it is painted at the height the frame reads, and
    // charging it would settle twelve rows onto a reader who never scrolled.
    rows[still] = 20;
    view.frame();
    expect(view.host.scrollTop).toBe(before);
  });

  it('keeps a separate height slot for two live items sharing one id', () => {
    // One subagent call mints a tool card and a task card from the same call
    // id, and the model tells them apart only by kind.
    const shared = 'call1';
    const items: LiveHistoryItem[] = [
      toolItem({ id: shared, tool: 'task', description: 'TURN_0000' }),
      {
        kind: 'task',
        id: shared,
        name: 'TURN_0001',
        description: '',
        progress: [],
      },
      ...Array.from({ length: 1998 }, (_, index) => ({
        kind: 'user' as const,
        id: `u${index + 2}`,
        text: `TURN_${String(index + 2).padStart(4, '0')}`,
      })),
    ];
    const rows = Array.from({ length: 2000 }, () => 3);
    rows[0] = 2;
    rows[1] = 4;
    const view = mountHosted({ items, rows });
    view.frame();
    view.frame();

    // One shared slot would see the other card's height every frame, so the
    // table would never settle and every frame would re-render the transcript.
    mocks.resetRenders();
    view.frame();
    expect(mocks.renders()).toBe(0);

    // Scrolled just past both, the spacer above the window is their two heights
    // and nothing else: 2 + 4, not the task card's 4 charged twice.
    view.jump(32);
    view.frame();
    expect(view.mounted()[0]).toBe('0002');
    expect(view.spacers().top).toBe(6);
  });

  it('reaches the tail past turns that paint no rows of their own', () => {
    const rows = Array.from({ length: 2000 }, () => 3);
    // `renderNothing` and a hidden goal card both leave a childless box: Yoga
    // computes 0 rows while `Renderable.height` reports a clamped 1.
    for (let index = 1970; index < 2000; index++) rows[index] = 0;
    const view = mountHosted({ rows });
    view.frame();
    for (let pass = 0; pass < 6; pass++) {
      view.jump(view.host.scrollHeight - 24);
      view.frame();
    }
    expect(view.mounted().at(-1)).toBe('1999');
    expect(view.spacers().bottom).toBe(0);
  });

  it('sizes the window from the host viewport, not the height prop', () => {
    const rows = Array.from({ length: 2000 }, () => 3);
    const view = mountHosted({ rows, viewportRows: 12, propRows: 24 });
    view.frame();
    view.jump(4000);
    view.frame();
    // Twelve rows of viewport plus the overscan on each side, at four rows a
    // turn — not the twenty-four the prop would have bought, which reaches
    // three turns further.
    expect(view.mounted()[0]).toBe('1322');
    expect(view.mounted().at(-1)).toBe('1337');
  });

  it("sizes the top spacer from each turn's own height", () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      kind: 'user' as const,
      id: `u${index}`,
      text: `TURN_${String(index).padStart(4, '0')}`,
    }));
    const rows = Array.from({ length: 40 }, (_, index) =>
      index === 20 ? 50 : 5,
    );
    const view = mountHosted({ items, rows });
    view.frame();

    // Walk down in steps short enough that every turn is measured on the way,
    // then hold the spacer to the sum of the turns' own heights.
    for (let top = 0; top <= 240; top += 12) {
      view.jump(top);
      view.frame();
    }
    const start = Number(view.mounted()[0]);
    expect(start).toBeGreaterThan(20);
    const expected = rows
      .slice(0, start)
      .reduce((sum, laidOut) => sum + laidOut + 1, 0);
    expect(view.spacers().top).toBe(expected);
  });

  it('paints nothing for a turn that throws and keeps the rest', () => {
    const items: LiveHistoryItem[] = Array.from({ length: 40 }, (_, index) =>
      index === 7
        ? ({
            kind: 'task',
            id: 'boom',
            name: 'TURN_0007',
            description: '',
            progress: undefined,
          } as unknown as LiveHistoryItem)
        : {
            kind: 'user' as const,
            id: `u${index}`,
            text: `TURN_${String(index).padStart(4, '0')}`,
          },
    );
    const rows = Array.from({ length: 40 }, () => 5);
    rows[7] = 0;
    const view = mountHosted({ items, rows });
    view.frame();
    expect(view.mounted()).toContain('0006');
    expect(view.mounted()).toContain('0008');
    expect(view.mounted()).not.toContain('0007');
    // The boundary's own fallback draws two `text` elements, which is two more
    // native buffers in the transcript that ran out of them. `renderNothing`
    // is what keeps a failed turn at zero.
    expect(view.container.textContent).not.toContain(
      'Something went wrong while rendering',
    );
  });

  it('drops the frame and scroll-bar subscriptions on unmount', () => {
    const rows = Array.from({ length: 2000 }, () => 3);
    const view = mountHosted({ rows });
    view.frame();
    expect(view.scrollListeners()).toBe(1);
    expect(mocks.renderer.count('frame')).toBe(1);
    view.unmount();
    expect(mocks.renderer.count('frame')).toBe(0);
    expect(view.scrollListeners()).toBe(0);
  });
});
