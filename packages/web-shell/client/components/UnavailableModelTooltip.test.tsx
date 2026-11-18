// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import type { WebShellUnavailableModelTooltipMount } from '../unavailableModels';
import { UnavailableModelTooltip } from './UnavailableModelTooltip';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let portalRoot: HTMLDivElement | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root?.unmount());
  container?.remove();
  portalRoot?.remove();
  root = null;
  container = null;
  portalRoot = null;
});

// jsdom reports zero-size rects, so Radix's collision flip places a requested
// 'right' on the left and the side assertions below would pass either way.
function stubLayout(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const anchor = this.hasAttribute('data-testid');
      const left = anchor ? 400 : 0;
      const top = anchor ? 300 : 0;
      const width = anchor ? 120 : 200;
      const height = anchor ? 24 : 80;
      return {
        left,
        top,
        width,
        height,
        x: left,
        y: top,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(768);
}

function renderTooltip({
  tooltip,
  mount,
  language = 'en',
  side,
}: {
  tooltip?: string;
  mount?: WebShellUnavailableModelTooltipMount;
  language?: 'en' | 'ar';
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  container = document.createElement('div');
  portalRoot = document.createElement('div');
  document.body.append(container, portalRoot);
  root = createRoot(container);
  act(() => {
    root!.render(
      <WebShellPortalRootContext.Provider value={portalRoot}>
        <I18nProvider language={language}>
          <UnavailableModelTooltip
            model={{ id: 'qwen-max', label: 'Qwen Max', tooltip }}
            mount={mount}
            side={side}
          >
            <button type="button" data-testid="trigger">
              Qwen Max
            </button>
          </UnavailableModelTooltip>
        </I18nProvider>
      </WebShellPortalRootContext.Provider>,
    );
  });
}

describe('UnavailableModelTooltip', () => {
  it('mounts, updates, and disposes host content', async () => {
    const dispose = vi.fn();
    const update = vi.fn();
    const mount = vi.fn<WebShellUnavailableModelTooltipMount>((host, info) => {
      host.textContent = info.model.id;
      return { update, dispose };
    });
    renderTooltip({ mount });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="trigger"]')
        ?.focus();
    });
    expect(mount).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-web-shell-unavailable-model-title]')
        ?.textContent,
    ).toBe('Qwen Max');
    expect(
      document.querySelector('[data-web-shell-unavailable-model-host]')
        ?.textContent,
    ).toBe('qwen-max');

    act(() => {
      root!.render(
        <WebShellPortalRootContext.Provider value={portalRoot}>
          <I18nProvider language="en">
            <UnavailableModelTooltip
              model={{ id: 'qwen-max', label: 'Renamed' }}
              mount={mount}
            >
              <button type="button" data-testid="trigger">
                Renamed
              </button>
            </UnavailableModelTooltip>
          </I18nProvider>
        </WebShellPortalRootContext.Provider>,
      );
    });
    expect(update).toHaveBeenCalledWith({
      model: { id: 'qwen-max', label: 'Renamed' },
    });

    act(() => root!.unmount());
    expect(dispose).toHaveBeenCalled();
  });

  it('opens to the inline end in Arabic', async () => {
    stubLayout();
    renderTooltip({ tooltip: 'Need Pro', language: 'ar' });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="trigger"]')
        ?.focus();
    });
    expect(
      document
        .querySelector('[data-web-shell-unavailable-model-tooltip]')
        ?.getAttribute('data-side'),
    ).toBe('left');
  });

  it('keeps a caller-pinned vertical side in Arabic', async () => {
    stubLayout();
    renderTooltip({ tooltip: 'Need Pro', language: 'ar', side: 'top' });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="trigger"]')
        ?.focus();
    });
    expect(
      document
        .querySelector('[data-web-shell-unavailable-model-tooltip]')
        ?.getAttribute('data-side'),
    ).toBe('top');
  });

  it('mirrors a caller-pinned horizontal side in Arabic', async () => {
    stubLayout();
    renderTooltip({ tooltip: 'Need Pro', language: 'ar', side: 'left' });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="trigger"]')
        ?.focus();
    });
    expect(
      document
        .querySelector('[data-web-shell-unavailable-model-tooltip]')
        ?.getAttribute('data-side'),
    ).toBe('right');
  });

  it('falls back to the string tooltip when mount declines', async () => {
    renderTooltip({
      tooltip: 'Need Pro',
      mount: () => null,
    });
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-testid="trigger"]')
        ?.focus();
    });
    const hint = document.querySelector(
      '[data-web-shell-unavailable-model-tooltip]',
    );
    expect(
      hint?.querySelector('[data-web-shell-unavailable-model-title]')
        ?.textContent,
    ).toBe('Qwen Max');
    expect(hint?.textContent).toContain('Need Pro');
  });

  it('stays open when focus is re-asserted on the anchor row', async () => {
    // WebKit re-focuses the tapped row after the card mounts. The card hangs
    // off a PopoverAnchor (no PopoverTrigger), so Radix would otherwise read
    // that focusin as focus-outside and dismiss the hint immediately.
    const mount = vi.fn<WebShellUnavailableModelTooltipMount>((host) => {
      host.textContent = 'Authorize';
      return { update: vi.fn(), dispose: vi.fn() };
    });
    renderTooltip({ mount });
    const trigger = container!.querySelector<HTMLButtonElement>(
      '[data-testid="trigger"]',
    )!;
    await act(async () => {
      trigger.focus();
    });
    expect(
      document.querySelector('[data-web-shell-unavailable-model-tooltip]'),
    ).not.toBeNull();

    await act(async () => {
      trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(
      document.querySelector('[data-web-shell-unavailable-model-tooltip]'),
    ).not.toBeNull();
    expect(mount).toHaveBeenCalledTimes(1);
  });
});
