// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { PaneHeaderActions } from './PaneHeaderActions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
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
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function render(ui: ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<I18nProvider language="en">{ui}</I18nProvider>));
}

function stubWidths(opts: {
  header: number;
  measure: number;
  trailing?: number;
}): void {
  const header = container!.querySelector('header') as HTMLElement;
  const measure = container!.querySelector(
    '[data-testid="pane-header-actions-measure"]',
  ) as HTMLElement;
  Object.defineProperty(header, 'clientWidth', {
    configurable: true,
    value: opts.header,
  });
  Object.defineProperty(measure, 'scrollWidth', {
    configurable: true,
    value: opts.measure,
  });
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

    stubWidths({ header: 400, measure: 80, trailing: 26 });
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

  it('collapses host actions into an overflow trigger when they do not fit', () => {
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

    // header 200 - titleMin 64 - trailing 26 - gap 8 ≈ 102; measure 180 → collapse
    stubWidths({ header: 200, measure: 180, trailing: 26 });
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(
      container!.querySelector('[data-testid="pane-header-actions-inline"]'),
    ).toBeNull();
    expect(
      container!.querySelector('[data-testid="pane-header-overflow"]'),
    ).not.toBeNull();
    // Close stays outside the overflow menu.
    expect(
      container!.querySelector('[data-testid="pane-close"]'),
    ).not.toBeNull();
  });
});
