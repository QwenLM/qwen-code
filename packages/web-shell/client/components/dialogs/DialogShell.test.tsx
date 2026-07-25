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

function render(showBottom: boolean, onTopClose = vi.fn()) {
  root!.render(
    <I18nProvider language="en">
      <ThemeProvider value="dark">
        {showBottom && (
          <DialogShell title="Bottom" onClose={vi.fn()}>
            <button type="button">bottom</button>
          </DialogShell>
        )}
        <DialogShell title="Top" onClose={onTopClose}>
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

  it('leaves an IME Escape event unhandled', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onClose = vi.fn();

    act(() => render(false, onClose));
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: 'Escape',
    });
    const target = document.querySelector<HTMLElement>(
      '[data-testid="top-focus"]',
    )!;
    act(() => target.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(event.key).toBe('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes once when the backdrop is clicked', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onClose = vi.fn();

    act(() => render(false, onClose));
    const backdrop = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    )!;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when a drag starts in the panel and ends on the backdrop', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onClose = vi.fn();

    act(() => render(false, onClose));
    const backdrop = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    )!;
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    act(() => {
      panel.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores backdrop clicks and Escape when not dismissible', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onClose = vi.fn();

    act(() => {
      root!.render(
        <I18nProvider language="en">
          <ThemeProvider value="dark">
            <DialogShell title="Locked" onClose={onClose} dismissible={false}>
              <button type="button" data-testid="locked-focus">
                locked
              </button>
            </DialogShell>
          </ThemeProvider>
        </I18nProvider>,
      );
    });

    const backdrop = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    )!;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    const target = document.querySelector<HTMLElement>(
      '[data-testid="locked-focus"]',
    )!;
    act(() =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Escape',
        }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
