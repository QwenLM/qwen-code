// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebShellPortalRootContext } from '../portalRoot';
import type { WebShellUnavailableModelTooltipMount } from '../unavailableModels';
import { UnavailableModelTooltip } from './UnavailableModelTooltip';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let portalRoot: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  portalRoot?.remove();
  root = null;
  container = null;
  portalRoot = null;
});

function renderTooltip({
  tooltip,
  mount,
}: {
  tooltip?: string;
  mount?: WebShellUnavailableModelTooltipMount;
}) {
  container = document.createElement('div');
  portalRoot = document.createElement('div');
  document.body.append(container, portalRoot);
  root = createRoot(container);
  act(() => {
    root!.render(
      <WebShellPortalRootContext.Provider value={portalRoot}>
        <UnavailableModelTooltip
          model={{ id: 'qwen-max', label: 'Qwen Max', tooltip }}
          mount={mount}
        >
          <button type="button" data-testid="trigger">
            Qwen Max
          </button>
        </UnavailableModelTooltip>
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
          <UnavailableModelTooltip
            model={{ id: 'qwen-max', label: 'Renamed' }}
            mount={mount}
          >
            <button type="button" data-testid="trigger">
              Renamed
            </button>
          </UnavailableModelTooltip>
        </WebShellPortalRootContext.Provider>,
      );
    });
    expect(update).toHaveBeenCalledWith({
      model: { id: 'qwen-max', label: 'Renamed' },
    });

    act(() => root!.unmount());
    expect(dispose).toHaveBeenCalled();
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
});
