// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import type { ACPToolCall } from '../../adapters/types';

// ToolGroup imports App only for CompactModeContext; loading the real App
// module would pull the whole application graph into this unit test.
vi.mock('../../App', async () => {
  const { createContext } = await import('react');
  return { CompactModeContext: createContext(false) };
});

const { ToolGroup } = await import('./ToolGroup');

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
  const chevron = [...container.querySelectorAll('span')].find(
    (s) => s.textContent === '▸',
  );
  if (chevron?.parentElement) click(chevron.parentElement);
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

    expect(container.textContent).toContain('▸');
    expect(commandInLeafSpan()).toBe(true);

    const chevron = [...container.querySelectorAll('span')].find(
      (s) => s.textContent === '▸',
    );
    click(chevron!.parentElement!);

    expect(container.textContent).toContain('▾');
    expect(commandInLeafSpan()).toBe(false);
    expect(container.textContent).toContain(command); // still present, in the block
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

    const chevron = [...container.querySelectorAll('span')].find(
      (s) => s.textContent === '▸',
    );
    expect(chevron).toBeTruthy(); // long pattern → expandable
    expect(container.textContent).toContain('matching file'); // summary, collapsed

    click(chevron!.parentElement!);

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
    expect(container.textContent).toContain('▸');
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
    const chevron = () =>
      [...container.querySelectorAll('span')].find(
        (s) => s.textContent === '▾' || s.textContent === '▸',
      );
    // Toggle twice → marks the row user-controlled, ending in the expanded state.
    click(chevron()!.parentElement!);
    click(chevron()!.parentElement!);
    expect(container.textContent).toContain('▾');

    // Completion must NOT override the user's explicit expand.
    renderStatus('completed');
    expect(container.textContent).toContain('▾');
  });
});
