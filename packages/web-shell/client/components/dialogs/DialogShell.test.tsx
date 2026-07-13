// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { ThemeProvider } from '../../themeContext';
import { DialogShell } from './DialogShell';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(showBottom: boolean) {
  root!.render(
    <I18nProvider language="en">
      <ThemeProvider value="dark">
        {showBottom && (
          <DialogShell title="Bottom" onClose={vi.fn()}>
            <button type="button">bottom</button>
          </DialogShell>
        )}
        <DialogShell title="Top" onClose={vi.fn()}>
          <button type="button" data-testid="top-focus">
            top
          </button>
        </DialogShell>
      </ThemeProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('DialogShell', () => {
  it('restores focus to the remaining top shell when a lower shell unmounts', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => render(true));
    const topButton = document.querySelector<HTMLElement>(
      '[data-testid="top-focus"]',
    )!;
    document.querySelector<HTMLElement>('button:not([data-testid])')!.focus();

    act(() => render(false));

    expect(document.activeElement).toBe(topButton);
  });
});
