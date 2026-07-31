/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelInfo } from '@agentclientprotocol/sdk';
import { ModelSelector } from './ModelSelector.js';

vi.mock('@qwen-code/webui', () => ({
  PlanCompletedIcon: () => null,
}));

interface RenderHandle {
  container: HTMLDivElement;
  root: Root;
  onSelectModel: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
}

const handles: RenderHandle[] = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

function renderModelSelector(props: {
  models: ModelInfo[];
  currentModelId?: string | null;
  visible?: boolean;
}): RenderHandle {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSelectModel = vi.fn();
  const onClose = vi.fn();

  act(() => {
    root.render(
      <ModelSelector
        visible={props.visible ?? true}
        models={props.models}
        currentModelId={props.currentModelId ?? null}
        onSelectModel={onSelectModel}
        onClose={onClose}
      />,
    );
  });

  const handle: RenderHandle = { container, root, onSelectModel, onClose };
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) {
    const handle = handles.pop()!;
    act(() => {
      handle.root.unmount();
    });
    handle.container.remove();
  }
});

const discontinuedModel: ModelInfo = {
  modelId: 'qwen3-coder-plus(qwen-oauth)',
  name: 'Qwen3 Coder Plus',
  description: 'Original description should be replaced',
};

const runtimeOAuthModel: ModelInfo = {
  modelId: '$runtime|qwen-oauth|qwen3-coder-plus(qwen-oauth)',
  name: 'Qwen3 Coder Plus (Runtime)',
};

const otherProviderModel: ModelInfo = {
  modelId: 'gpt-4(openai)',
  name: 'GPT-4',
  description: 'OpenAI flagship',
};

describe('ModelSelector — discontinued state (Issue #3745)', () => {
  it('renders the (Discontinued) badge for non-runtime Qwen OAuth models', () => {
    const { container } = renderModelSelector({
      models: [discontinuedModel],
    });
    const row = container.querySelector('[data-discontinued="true"]');
    expect(row).not.toBeNull();
    const badge = container.querySelector('[data-testid="discontinued-badge"]');
    expect(badge?.textContent).toBe('(Discontinued)');
    expect(row?.getAttribute('aria-disabled')).toBe('true');
  });

  it('replaces description with the migration hint for discontinued models', () => {
    const { container } = renderModelSelector({
      models: [discontinuedModel],
    });
    expect(container.textContent).toContain(
      'Discontinued — switch to Coding Plan or API Key',
    );
    expect(container.textContent).not.toContain(
      'Original description should be replaced',
    );
  });

  it('does NOT mark a runtime Qwen OAuth snapshot as discontinued', () => {
    const { container } = renderModelSelector({
      models: [runtimeOAuthModel],
    });
    expect(container.querySelector('[data-discontinued="true"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="discontinued-badge"]'),
    ).toBeNull();
  });

  it('blocks click selection on a discontinued model and surfaces an inline error', () => {
    const { container, onSelectModel, onClose } = renderModelSelector({
      models: [discontinuedModel],
    });
    const row = container.querySelector(
      '[data-discontinued="true"]',
    ) as HTMLElement;
    expect(row).not.toBeNull();

    act(() => {
      row.click();
    });

    expect(onSelectModel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const blocked = container.querySelector(
      '[data-testid="model-selector-blocked"]',
    );
    expect(blocked?.textContent).toContain(
      'Qwen OAuth free tier was discontinued on 2026-04-15',
    );
  });

  it('allows clicking a non-discontinued model exactly once', () => {
    const { container, onSelectModel, onClose } = renderModelSelector({
      models: [otherProviderModel],
    });
    const row = container.querySelector('[data-index="0"]') as HTMLElement;
    act(() => {
      row.click();
    });
    expect(onSelectModel).toHaveBeenCalledTimes(1);
    expect(onSelectModel).toHaveBeenCalledWith('gpt-4(openai)');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a runtime Qwen OAuth snapshot selectable', () => {
    const { container, onSelectModel } = renderModelSelector({
      models: [runtimeOAuthModel],
    });
    const row = container.querySelector('[data-index="0"]') as HTMLElement;
    act(() => {
      row.click();
    });
    expect(onSelectModel).toHaveBeenCalledWith(runtimeOAuthModel.modelId);
  });

  it('blocks the keyboard Enter path on a discontinued model', () => {
    const { onSelectModel, onClose } = renderModelSelector({
      models: [discontinuedModel],
    });

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(onSelectModel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears a stale blocked message when hovering another row', () => {
    const { container } = renderModelSelector({
      models: [discontinuedModel, otherProviderModel],
    });
    const discontinuedRow = container.querySelector(
      '[data-discontinued="true"]',
    ) as HTMLElement;
    const otherRow = container.querySelectorAll(
      '[data-index]',
    )[1] as HTMLElement;

    act(() => {
      discontinuedRow.click();
    });
    expect(
      container.querySelector('[data-testid="model-selector-blocked"]'),
    ).not.toBeNull();

    // React 19 synthesizes onMouseEnter from `mouseover` with boundary checks.
    // Dispatching `mouseover` on the target row reliably triggers the React
    // handler in jsdom; raw `mouseenter` does not bubble through the delegated
    // listener.
    act(() => {
      otherRow.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }),
      );
    });
    expect(
      container.querySelector('[data-testid="model-selector-blocked"]'),
    ).toBeNull();
  });

  it('clears a stale blocked message when navigating with ArrowDown / ArrowUp', () => {
    const { container } = renderModelSelector({
      models: [discontinuedModel, otherProviderModel],
    });
    const discontinuedRow = container.querySelector(
      '[data-discontinued="true"]',
    ) as HTMLElement;

    act(() => {
      discontinuedRow.click();
    });
    expect(
      container.querySelector('[data-testid="model-selector-blocked"]'),
    ).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(
      container.querySelector('[data-testid="model-selector-blocked"]'),
    ).toBeNull();

    // Re-trigger the banner, then verify ArrowUp also clears it.
    act(() => {
      discontinuedRow.click();
    });
    expect(
      container.querySelector('[data-testid="model-selector-blocked"]'),
    ).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(
      container.querySelector('[data-testid="model-selector-blocked"]'),
    ).toBeNull();
  });
});
