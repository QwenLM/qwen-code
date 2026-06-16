// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import type { ACPToolCall } from '../../adapters/types';

// ToolGroup imports App for CompactModeContext and TodoTimelineContext, and its
// expanded todo list (via TodoFullList) reads TodoDetailContext; loading the
// real App module would pull the whole application graph into this unit test.
vi.mock('../../App', async () => {
  const { createContext } = await import('react');
  return {
    CompactModeContext: createContext(false),
    TodoTimelineContext: createContext(new Map()),
    TodoDetailContext: createContext(new Map()),
  };
});

const { ToolGroup } = await import('./ToolGroup');
const { TodoTimelineContext } = await import('../../App');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function makeShellTool(
  output: string,
  status: ACPToolCall['status'] = 'completed',
): ACPToolCall {
  return {
    callId: 'call-shell-1',
    toolName: 'Shell',
    status,
    rawOutput: { output },
  };
}

function makeEditTool(overrides: Partial<ACPToolCall>): ACPToolCall {
  return {
    callId: 'call-edit-1',
    toolName: 'edit',
    status: 'completed',
    ...overrides,
  };
}

function renderTool(tool: ACPToolCall): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ToolGroup tools={[tool]} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function renderShellTool(output: string): HTMLElement {
  const container = renderTool(makeShellTool(output));
  // Completed tools collapse to a one-line summary by default; open the row so
  // the assertions below can inspect the bash-output view.
  expandTool(container);
  return container;
}

function makeShellCommandTool(command: string): ACPToolCall {
  return {
    callId: 'call-shell-cmd',
    toolName: 'run_shell_command',
    status: 'completed',
    args: { command },
    rawOutput: { output: 'done' },
  };
}

function makeAgentTool(status: ACPToolCall['status']): ACPToolCall {
  return {
    callId: 'agent-1',
    toolName: 'task',
    status,
    args: { description: 'agentDescMarker' },
    subTools: [
      {
        callId: 'agent-1-sub-1',
        toolName: 'Read',
        status: 'completed',
        args: { file_path: '/ws/SubToolMarker.ts' },
      },
    ],
  };
}

function getExpandButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button');
  expect(button).not.toBeNull();
  return button!;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function getToolHeader(container: HTMLElement, name = 'Shell'): HTMLElement {
  const label = [...container.querySelectorAll('span')].find(
    (s) => s.textContent === name,
  );
  expect(label).toBeTruthy();
  return label!.parentElement!;
}

function expandTool(container: HTMLElement, name = 'Shell'): void {
  click(getToolHeader(container, name));
}

describe('shell tool output expand toggle', () => {
  it('shows short output in full without an expand button', () => {
    const container = renderShellTool('one\ntwo\nthree');
    expect(container.querySelector('pre')?.textContent).toBe('one\ntwo\nthree');
    expect(container.querySelector('button')).toBeNull();
  });

  it('clamps long output to a 5-line tail and expands to the full output', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join(
      '\n',
    );
    const container = renderShellTool(output);

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('... first 3 lines hidden ...');
    expect(pre?.textContent).toContain('line4');
    expect(pre?.textContent).not.toContain('line2');

    const button = getExpandButton(container);
    expect(button.textContent).toBe('▼ Show all (8 lines)');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    click(button);
    expect(pre?.textContent).toBe(output);
    expect(button.textContent).toBe('▲ Show less');
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('expands lines truncated by the per-line character limit', () => {
    const wide = 'w'.repeat(200);
    const container = renderShellTool(`${wide}\nshort`);

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain(`${'w'.repeat(150)} …`);
    expect(pre?.textContent).not.toContain('w'.repeat(151));

    const button = getExpandButton(container);
    expect(button.textContent).toBe('▼ Show full lines');

    click(button);
    expect(pre?.textContent).toBe(`${wide}\nshort`);
    expect(pre?.textContent).not.toContain('…');
  });

  it('collapses back to the tail preview on a second click', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join(
      '\n',
    );
    const container = renderShellTool(output);
    const button = getExpandButton(container);

    click(button);
    click(button);

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('... first 3 lines hidden ...');
    expect(pre?.textContent).not.toContain('line2');
    expect(button.textContent).toBe('▼ Show all (8 lines)');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('tool description expand toggle', () => {
  it('relocates the full command from the header into a wrapped block on expand', () => {
    const command = `npm run build && npm run test && npm run lint -- ${'x'.repeat(
      80,
    )}`;
    const container = renderTool(makeShellCommandTool(command));

    // textContent alone can't prove relocation (it concatenates the whole
    // subtree, so the command is present in either state). Assert the DOM move
    // instead: collapsed, the full command lives in the header's single-line
    // arg <span> (CSS-ellipsised); expanded, it is no longer in any leaf <span>
    // but reflowed into the wrapped block below.
    const commandInLeafSpan = () =>
      [...container.querySelectorAll('span')].some(
        (s) => s.textContent === command,
      );

    expect(commandInLeafSpan()).toBe(true);

    expandTool(container);

    expect(commandInLeafSpan()).toBe(false);
    expect(container.textContent).toContain(command); // still present, in the block
  });

  it('shows an expand/collapse tooltip on expandable tool rows', () => {
    const command = `npm run build -- ${'x'.repeat(80)}`;
    const container = renderTool(makeShellCommandTool(command));
    const header = getToolHeader(container);
    expect(header.getAttribute('title')).toBe('Expand');
    expect(header.getAttribute('role')).toBe('button');

    click(header);

    expect(header.getAttribute('title')).toBe('Collapse');
  });

  it('keeps the result summary when expanding a long-description tool with no detail view', () => {
    // glob with a long pattern: descExpandable but no kind-specific renderer.
    const pattern = `**/${'x'.repeat(80)}/*.ts`;
    const container = renderTool({
      callId: 'call-glob',
      toolName: 'glob',
      status: 'completed',
      args: { pattern },
      rawOutput: 'a.ts\nb.ts\nc.ts',
    });

    expect(container.textContent).toContain('matching file'); // summary, collapsed

    expandTool(container, 'Glob');

    // Expanded: the summary must NOT be lost (no detail view replaces it), and
    // the full pattern is reflowed into the block.
    expect(container.textContent).toContain('matching file');
    expect(container.textContent).toContain(pattern);
  });
});

describe('auto-collapse on finish', () => {
  it('collapses a completed tool to its summary by default', () => {
    const container = renderTool(makeShellTool('a\nb\nc\nd'));
    // The expanded bash <pre> is not rendered until the user opens the row.
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).toContain('4 lines of output');
  });

  it('keeps a running tool expanded so streaming output stays visible', () => {
    const container = renderTool(
      makeShellTool('streaming output', 'in_progress'),
    );
    expect(container.querySelector('pre')?.textContent).toContain('streaming');
  });

  it('keeps a failed tool expanded so the error stays visible', () => {
    const container = renderTool(
      makeShellTool('error: boom\n  at step 1', 'failed'),
    );
    expect(container.querySelector('pre')?.textContent).toContain('boom');
  });

  it('auto-collapses a running tool when it transitions to completed', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    const output = 'line1\nline2\nline3\nline4';
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ToolGroup tools={[makeShellTool(output, 'in_progress')]} />
        </I18nProvider>,
      );
    });
    // Running → expanded: the bash output is visible.
    expect(container.querySelector('pre')).not.toBeNull();

    // Same callId, now finished → the row collapses on its own.
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ToolGroup tools={[makeShellTool(output, 'completed')]} />
        </I18nProvider>,
      );
    });
    expect(container.querySelector('pre')).toBeNull();
  });

  it('does not collapse an agent the user expanded when it completes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    const render = (status: ACPToolCall['status']) =>
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ToolGroup tools={[makeAgentTool(status)]} />
          </I18nProvider>,
        );
      });

    render('in_progress');
    // Agents start collapsed: the sub-tool panel is hidden.
    expect(container.textContent).not.toContain('SubToolMarker');

    // Expand by clicking the agent's summary row.
    const summaryLabel = [...container.querySelectorAll('span')].find(
      (s) => s.textContent === 'task:',
    );
    expect(summaryLabel).toBeTruthy();
    click(summaryLabel!.parentElement!);
    expect(container.textContent).toContain('SubToolMarker');

    // Completion must NOT yank the panel shut: the collapse-on-finish effect
    // is scoped to non-agent tools.
    render('completed');
    expect(container.textContent).toContain('SubToolMarker');
  });
});

function makeTodoTool(): ACPToolCall {
  return {
    callId: 'call-todo-1',
    toolName: 'todo_write',
    status: 'completed',
    kind: 'think',
    args: {
      todos: [
        { id: '1', content: 'First task', status: 'completed' },
        { id: '2', content: 'Second task', status: 'in_progress' },
        { id: '3', content: 'Third task', status: 'pending' },
      ],
    },
  };
}

function renderTodoTool(
  tool: ACPToolCall,
  timeline?: Map<string, unknown>,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <TodoTimelineContext.Provider value={timeline ?? new Map()}>
          <ToolGroup tools={[tool]} />
        </TodoTimelineContext.Provider>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

describe('todo_write tool rendering', () => {
  it('detects the todo_write wire name and collapses to the current step', () => {
    const container = renderTodoTool(makeTodoTool());
    // Collapsed by default: only the current (in_progress) step and the
    // progress count show; other items stay hidden until expanded.
    expect(container.textContent).toContain('1/3');
    expect(container.textContent).toContain('Second task');
    expect(container.textContent).not.toContain('Third task');
  });

  it('expands to the full list on click', () => {
    const container = renderTodoTool(makeTodoTool());
    expandTool(container, 'TodoWrite');
    expect(container.textContent).toContain('First task');
    expect(container.textContent).toContain('Second task');
    expect(container.textContent).toContain('Third task');
  });

  it('shows the snapshot diff when a timeline is present', () => {
    const timeline = new Map<string, unknown>([
      [
        'call-todo-1',
        {
          events: [
            { kind: 'completed', id: '1', content: 'First task' },
            { kind: 'started', id: '2', content: 'Second task' },
          ],
        },
      ],
    ]);
    const container = renderTodoTool(makeTodoTool(), timeline);
    // The collapsed diff: just-completed item (●), just-started item (◐), and
    // pending items still hidden — same status glyphs as the expanded list.
    expect(container.textContent).toContain('●');
    expect(container.textContent).toContain('First task');
    expect(container.textContent).toContain('◐');
    expect(container.textContent).toContain('Second task');
    expect(container.textContent).not.toContain('Third task');
  });

  it('falls back to the result summary when the todo payload is unparseable', () => {
    // Malformed args (todos is a string) → no list to render; the row must not
    // be blank — it shows the raw result summary instead.
    const container = renderTodoTool({
      callId: 'call-todo-bad',
      toolName: 'todo_write',
      status: 'completed',
      kind: 'think',
      args: { todos: 'oops not an array' },
      rawOutput: { output: 'Todos updated summary line' },
    });
    expect(container.textContent).toContain('Todos updated summary line');
  });
});

describe('user-expanded tool persistence', () => {
  it('keeps a tool the user manually expanded open when it completes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    // Long command → the row is expandable/clickable even while running.
    const command = `echo ${'z'.repeat(80)}`;
    const renderStatus = (status: ACPToolCall['status']) =>
      act(() => {
        root.render(
          <I18nProvider language="en">
            <ToolGroup
              tools={[
                {
                  callId: 'call-usertoggle',
                  toolName: 'run_shell_command',
                  status,
                  args: { command },
                  rawOutput: { output: 'done' },
                },
              ]}
            />
          </I18nProvider>,
        );
      });

    renderStatus('in_progress');
    // Toggle twice → marks the row user-controlled, ending in the expanded state.
    click(getToolHeader(container, 'Shell'));
    click(getToolHeader(container, 'Shell'));
    expect(container.querySelector('pre')).not.toBeNull();

    // Completion must NOT override the user's explicit expand.
    renderStatus('completed');
    expect(container.querySelector('pre')).not.toBeNull();
  });
});

describe('edit raw diff rendering', () => {
  it('ignores truncated session rawOutput diffs', () => {
    const fullDiff = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new';

    const normal = renderTool(
      makeEditTool({
        rawOutput: {
          fileDiff: fullDiff,
        },
      }),
    );
    expandTool(normal, 'Edit');
    expect(normal.textContent).toContain('old');
    expect(normal.textContent).toContain('new');

    const truncated = renderTool(
      makeEditTool({
        rawOutput: {
          fileName: '/test/file.ts',
          newContent: 'preview only',
          fileDiff: fullDiff,
          truncatedForSession: true,
        },
      }),
    );
    expect(truncated.textContent).not.toContain('old');
    expect(truncated.textContent).not.toContain('new');
  });

  it('shows preview and suppresses truncated rawOutput diffs', () => {
    const fullDiff = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new';
    const preview =
      'Full diff omitted from saved session history for /test/file.ts.';
    const container = renderTool(
      makeEditTool({
        content: [
          {
            type: 'content',
            content: { type: 'text', text: preview },
          },
        ],
        rawOutput: {
          fileName: '/test/file.ts',
          newContent: 'preview only',
          fileDiff: fullDiff,
          truncatedForSession: true,
        },
      }),
    );

    expandTool(container, 'Edit');
    expect(container.textContent).toContain(preview);
    expect(container.textContent).not.toContain('old');
    expect(container.textContent).not.toContain('new');
  });

  it('renders truncated session preview text when no diff is available', () => {
    const preview =
      'Full diff omitted from saved session history for /test/file.ts.';
    const container = renderTool(
      makeEditTool({
        content: [
          {
            type: 'content',
            content: { type: 'text', text: preview },
          },
        ],
      }),
    );

    expandTool(container, 'Edit');
    expect(container.textContent).toContain(preview);
  });

  it('expands write preview text when no diff is available', () => {
    const preview =
      'Full diff omitted from saved session history for /test/file.ts.';
    const container = renderTool(
      makeEditTool({
        toolName: 'write',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: preview },
          },
        ],
      }),
    );

    expect(container.querySelector('pre')).toBeNull();

    const writeLabel = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === 'WriteFile',
    );
    expect(writeLabel).toBeDefined();
    click(writeLabel!);

    expect(container.querySelector('pre')?.textContent).toBe(preview);
  });
});

describe('keyboard accessibility', () => {
  function pressKey(el: Element, key: string): void {
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  }

  it('expands an expandable tool row on Enter', () => {
    const command = `echo ${'z'.repeat(80)}`;
    const container = renderTool(makeShellCommandTool(command));
    const header = getToolHeader(container);

    expect(container.querySelector('pre')).toBeNull();

    pressKey(header, 'Enter');
    expect(container.querySelector('pre')).not.toBeNull();
  });

  it('expands an expandable tool row on Space', () => {
    const command = `echo ${'z'.repeat(80)}`;
    const container = renderTool(makeShellCommandTool(command));
    const header = getToolHeader(container);

    expect(container.querySelector('pre')).toBeNull();

    pressKey(header, ' ');
    expect(container.querySelector('pre')).not.toBeNull();
  });

  it('does not toggle on other keys', () => {
    const command = `echo ${'z'.repeat(80)}`;
    const container = renderTool(makeShellCommandTool(command));
    const header = getToolHeader(container);

    pressKey(header, 'a');
    expect(container.querySelector('pre')).toBeNull();
  });
});
