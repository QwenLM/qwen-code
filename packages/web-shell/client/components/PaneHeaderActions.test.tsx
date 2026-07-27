// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import { PaneHeaderActions } from './PaneHeaderActions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let portalRoot: HTMLDivElement | null = null;
let resizeCallback: ResizeObserverCallback | null = null;

beforeEach(() => {
  resizeCallback = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  portalRoot?.remove();
  root = null;
  container = null;
  portalRoot = null;
  vi.unstubAllGlobals();
});

function render(ui: ReactNode): void {
  container = document.createElement('div');
  portalRoot = document.createElement('div');
  portalRoot.dataset.webShellPortalRoot = '';
  document.body.appendChild(container);
  document.body.appendChild(portalRoot);
  root = createRoot(container);
  act(() =>
    root!.render(
      <WebShellPortalRootContext.Provider value={portalRoot}>
        <I18nProvider language="en">{ui}</I18nProvider>
      </WebShellPortalRootContext.Provider>,
    ),
  );
}

function stubWidths(opts: {
  header: number;
  hostActions: number;
  trailing?: number;
}): void {
  const header = container!.querySelector('header') as HTMLElement;
  const inline = container!.querySelector(
    '[data-testid="pane-header-actions-inline"]',
  ) as HTMLElement | null;
  Object.defineProperty(header, 'clientWidth', {
    configurable: true,
    value: opts.header,
  });
  if (inline) {
    Object.defineProperty(inline, 'scrollWidth', {
      configurable: true,
      value: opts.hostActions,
    });
  }
  const trailingEl = container!.querySelector(
    '[data-testid="pane-close"]',
  )?.parentElement;
  if (trailingEl) {
    Object.defineProperty(trailingEl, 'offsetWidth', {
      configurable: true,
      value: opts.trailing ?? 26,
    });
  }
}

describe('PaneHeaderActions', () => {
  it('shows host actions inline when they fit', () => {
    render(
      <header>
        <span>Title</span>
        <PaneHeaderActions
          trailing={
            <button type="button" data-testid="pane-close">
              x
            </button>
          }
        >
          <button type="button" data-testid="host-action">
            Share
          </button>
        </PaneHeaderActions>
      </header>,
    );

    stubWidths({ header: 400, hostActions: 80, trailing: 26 });
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(
      container!.querySelector('[data-testid="pane-header-actions-inline"]'),
    ).not.toBeNull();
    expect(
      container!.querySelector('[data-testid="pane-header-overflow"]'),
    ).toBeNull();
    expect(
      container!.querySelector('[data-testid="host-action"]')?.textContent,
    ).toBe('Share');
  });

  it('collapses host actions into an overflow menu with menuitems', async () => {
    render(
      <header>
        <span>Title</span>
        <PaneHeaderActions
          trailing={
            <button type="button" data-testid="pane-close">
              x
            </button>
          }
        >
          <button type="button" data-testid="host-action">
            Share
          </button>
        </PaneHeaderActions>
      </header>,
    );

    // header 200 - titleMin 64 - trailing 26 - gap 8 ≈ 102; host 180 → collapse
    stubWidths({ header: 200, hostActions: 180, trailing: 26 });
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(
      container!.querySelector('[data-testid="pane-header-actions-inline"]'),
    ).toBeNull();
    const overflow = container!.querySelector(
      '[data-testid="pane-header-overflow"]',
    ) as HTMLButtonElement;
    expect(overflow).not.toBeNull();
    expect(
      container!.querySelector('[data-testid="pane-close"]'),
    ).not.toBeNull();

    await act(async () => {
      overflow.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });

    const menu = document.querySelector(
      '[data-testid="pane-header-overflow-menu"]',
    );
    expect(menu).not.toBeNull();
    expect(
      menu!.querySelector('[data-testid="host-action"]')?.textContent,
    ).toBe('Share');
    expect(menu!.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(
      0,
    );
  });

  it('mounts host actions only once', () => {
    let mounts = 0;
    function HostAction() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <button type="button" data-testid="host-action">
          Share
        </button>
      );
    }

    render(
      <header>
        <span>Title</span>
        <PaneHeaderActions
          trailing={
            <button type="button" data-testid="pane-close">
              x
            </button>
          }
        >
          <HostAction />
        </PaneHeaderActions>
      </header>,
    );

    expect(mounts).toBe(1);
    expect(
      container!.querySelectorAll('[data-testid="host-action"]'),
    ).toHaveLength(1);
  });
});
