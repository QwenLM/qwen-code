// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const tools = [
  { name: 'tool-a', displayName: 'Tool A', enabled: true, description: 'A' },
  { name: 'tool-b', displayName: 'Tool B', enabled: false },
];

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useTools: () => ({
    status: { errors: [] },
    tools,
    loading: false,
    error: undefined,
  }),
}));

const { ToolsDialog } = await import('./ToolsDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <ToolsDialog />
      </I18nProvider>,
    );
  });
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, cancelable: true }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ToolsDialog a11y wiring', () => {
  it('exposes a listbox with option ids, aria-activedescendant and aria-expanded', () => {
    mount();

    const list = container!.querySelector<HTMLElement>('[role="listbox"]');
    expect(list).not.toBeNull();
    expect(list!.getAttribute('aria-activedescendant')).toBe(
      'tools-list-opt-0',
    );

    const options = Array.from(
      container!.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    expect(options).toHaveLength(2);
    expect(options[0]!.id).toBe('tools-list-opt-0');
    expect(options[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(options[1]!.getAttribute('aria-expanded')).toBeNull();

    press('ArrowDown');
    expect(list!.getAttribute('aria-activedescendant')).toBe(
      'tools-list-opt-1',
    );

    // Move back and expand the first tool via Enter.
    press('ArrowUp');
    press('Enter');
    expect(options[0]!.getAttribute('aria-expanded')).toBe('true');
  });
});
