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
        if (source['width'] !== undefined) {
          dom['data-width'] = String(source['width']);
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
  return { buildJsxRuntime };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

import { OpenTuiTranscriptView } from './transcript-view.js';
import { C } from './theme.js';
import type {
  LiveAssistantItem,
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
