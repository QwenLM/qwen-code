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

function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <ThemeProvider value="dark">{node}</ThemeProvider>
      </I18nProvider>,
    );
  });
}

function press(key: string, options: KeyboardEventInit = {}) {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key, cancelable: true, ...options }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('DialogShell', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn();
    mount(
      <DialogShell title="Test" onClose={onClose}>
        <button type="button">inner</button>
      </DialogShell>,
    );

    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked but not when the panel is clicked', () => {
    const onClose = vi.fn();
    mount(
      <DialogShell title="Test" onClose={onClose}>
        <button type="button">inner</button>
      </DialogShell>,
    );

    const backdrop = document.querySelector<HTMLElement>(
      '[data-keyboard-scope]',
    );
    const panel = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(backdrop).toBeTruthy();

    act(() => {
      panel!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      backdrop!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the dialog on open', () => {
    mount(
      <DialogShell title="Test" onClose={vi.fn()}>
        <button type="button" data-testid="first">
          first
        </button>
        <button type="button">second</button>
      </DialogShell>,
    );

    const first = document.querySelector<HTMLElement>('[data-testid="first"]');
    expect(document.activeElement).toBe(first);
  });

  it('restores focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    mount(
      <DialogShell title="Test" onClose={vi.fn()}>
        <button type="button">inner</button>
      </DialogShell>,
    );
    // Focus moved into the dialog.
    expect(document.activeElement).not.toBe(opener);

    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('traps Tab within the dialog, wrapping at both ends', () => {
    mount(
      <DialogShell title="Test" onClose={vi.fn()}>
        <button type="button" data-testid="last">
          inner
        </button>
      </DialogShell>,
    );

    // Focusables in DOM order: [close button, inner button].
    const close = document.querySelector<HTMLElement>('[data-dialog-close]')!;
    const last = document.querySelector<HTMLElement>('[data-testid="last"]')!;

    // Tab from the last focusable wraps to the first (the close button).
    last.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(close);

    // Shift+Tab from the first focusable wraps to the last.
    close.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(document.activeElement).toBe(last);
  });
});
