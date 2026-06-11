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

function makeShellTool(output: string): ACPToolCall {
  return {
    callId: 'call-shell-1',
    toolName: 'Shell',
    status: 'completed',
    rawOutput: { output },
  };
}

function renderShellTool(output: string): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ToolGroup tools={[makeShellTool(output)]} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
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
