// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useWebviewTheme } from './useWebviewTheme.js';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.className = '';
  root = undefined;
  container = undefined;
});

function ThemeValue() {
  return <span>{useWebviewTheme()}</span>;
}

describe('useWebviewTheme', () => {
  it('reacts when VS Code changes the body theme class', async () => {
    document.body.className = 'vscode-light';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<ThemeValue />));
    expect(container.textContent).toBe('light');

    await act(async () => {
      document.body.className = 'vscode-dark';
      await Promise.resolve();
    });
    expect(container.textContent).toBe('dark');
  });
});
