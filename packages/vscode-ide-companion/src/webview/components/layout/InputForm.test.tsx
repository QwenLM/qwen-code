/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { act, createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelInfo } from '@agentclientprotocol/sdk';
import { ApprovalMode } from '../../../types/acpTypes.js';
import type { CompletionItem } from '../../../types/completionItemTypes.js';
import { InputForm } from './InputForm.js';

vi.mock('@qwen-code/webui', async () => {
  const actual = await vi.importActual(
    '../../../../../webui/src/components/layout/InputForm.tsx',
  );

  return {
    InputForm: actual.InputForm,
    getEditModeIcon: actual.getEditModeIcon,
    PlanCompletedIcon: () => null,
  };
});

const completionItem: CompletionItem = {
  id: 'create-issue',
  label: '/create-issue',
  type: 'command',
  value: 'create-issue',
};

function renderInputForm(props?: {
  onCompletionSelect?: (item: CompletionItem) => void;
  onCompletionFill?: (item: CompletionItem) => void;
  showModelSelector?: boolean;
  availableModels?: ModelInfo[];
  currentModelId?: string | null;
  onSelectModel?: (modelId: string) => void;
  onCloseModelSelector?: () => void;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const root = createRoot(container);
  const inputFieldRef =
    createRef<HTMLDivElement>() as unknown as React.RefObject<HTMLDivElement>;
  const onCompletionSelect = props?.onCompletionSelect ?? vi.fn();
  const onCompletionFill = props?.onCompletionFill ?? vi.fn();
  const onSelectModel = props?.onSelectModel ?? vi.fn();
  const onCloseModelSelector = props?.onCloseModelSelector ?? vi.fn();

  act(() => {
    root.render(
      <InputForm
        inputText=""
        inputFieldRef={inputFieldRef}
        isStreaming={false}
        isWaitingForResponse={false}
        isComposing={false}
        editMode={ApprovalMode.DEFAULT}
        thinkingEnabled={false}
        activeFileName={null}
        activeSelection={null}
        skipAutoActiveContext={false}
        contextUsage={null}
        onInputChange={vi.fn()}
        onCompositionStart={vi.fn()}
        onCompositionEnd={vi.fn()}
        onKeyDown={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onToggleEditMode={vi.fn()}
        onToggleThinking={vi.fn()}
        onToggleSkipAutoActiveContext={vi.fn()}
        onShowCommandMenu={vi.fn()}
        onAttachContext={vi.fn()}
        completionIsOpen={true}
        completionItems={[completionItem]}
        onCompletionSelect={onCompletionSelect}
        onCompletionFill={onCompletionFill}
        onCompletionClose={vi.fn()}
        showModelSelector={props?.showModelSelector}
        availableModels={props?.availableModels}
        currentModelId={props?.currentModelId}
        onSelectModel={onSelectModel}
        onCloseModelSelector={onCloseModelSelector}
      />,
    );
  });

  return {
    container,
    root,
    onCompletionSelect,
    onCompletionFill,
    onSelectModel,
    onCloseModelSelector,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

describe('InputForm completion keyboard handling', () => {
  it('uses onCompletionFill for Tab without triggering onCompletionSelect', () => {
    const rendered = renderInputForm();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(rendered.onCompletionFill).toHaveBeenCalledWith(completionItem);
    expect(rendered.onCompletionSelect).not.toHaveBeenCalled();
  });

  it('keeps Enter mapped to onCompletionSelect', () => {
    const rendered = renderInputForm();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(rendered.onCompletionSelect).toHaveBeenCalledWith(completionItem);
    expect(rendered.onCompletionFill).not.toHaveBeenCalled();
  });
});

describe('InputForm model selector positioning (issue #8617)', () => {
  const models: ModelInfo[] = [
    { modelId: 'model-a', name: 'Model A' },
    { modelId: 'model-b', name: 'Model B' },
  ];

  function collectAncestors(el: HTMLElement): HTMLElement[] {
    const ancestors: HTMLElement[] = [];
    let current = el.parentElement;
    while (current && current !== document.body) {
      ancestors.push(current);
      current = current.parentElement;
    }
    return ancestors;
  }

  it('anchors the dropdown to the input form instead of the viewport', () => {
    const rendered = renderInputForm({
      showModelSelector: true,
      availableModels: models,
      currentModelId: null,
    });
    root = rendered.root;
    container = rendered.container;

    const menu = container.querySelector(
      '.model-selector',
    ) as HTMLElement | null;
    expect(menu).not.toBeNull();

    const ancestors = collectAncestors(menu as HTMLElement);

    // The dropdown must not float above the message list via a
    // viewport-fixed wrapper (the #8617 occlusion).
    const fixedWrapper = ancestors.find((el) =>
      /(^|\s)fixed(\s|$)/.test(el.className),
    );
    expect(fixedWrapper).toBeUndefined();

    // The dropdown's positioning wrapper must grow upward from its anchor
    // (same layout as webui CompletionMenu: absolute bottom-full).
    const positionedWrapper = ancestors.find((el) =>
      /(^|\s)(absolute|fixed)(\s|$)/.test(el.className),
    );
    expect(positionedWrapper).toBeDefined();
    expect(positionedWrapper?.className).toMatch(/(^|\s)bottom-full(\s|$)/);

    // The selector must live inside the input form's own stacking context:
    // a shared relative wrapper that also contains the composer form.
    const sharedWrapper = ancestors.find((el) =>
      /(^|\s)relative(\s|$)/.test(el.className),
    );
    expect(sharedWrapper).toBeDefined();
    expect(sharedWrapper?.querySelector('form.composer-form')).not.toBeNull();
  });

  it('sizes the positioning context to the form height so the dropdown clears the form', () => {
    // jsdom performs no layout, so emulate the browser measurement the
    // adapter relies on: capture the ResizeObserver, give the observed
    // element a real height, and fire the observer callback.
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Element[];
    }> = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class {
        readonly targets: Element[] = [];
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, targets: this.targets });
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
      },
    });

    try {
      const rendered = renderInputForm({
        showModelSelector: true,
        availableModels: models,
        currentModelId: null,
      });
      root = rendered.root;
      container = rendered.container;

      const menu = container.querySelector(
        '.model-selector',
      ) as HTMLElement | null;
      expect(menu).not.toBeNull();
      const sharedWrapper = collectAncestors(menu as HTMLElement).find((el) =>
        /(^|\s)relative(\s|$)/.test(el.className),
      );
      expect(sharedWrapper).toBeDefined();

      // The adapter must measure the wrapper child that carries the base
      // form, so the positioning context gets the form's real height
      // instead of collapsing to zero (which anchors the dropdown at the
      // viewport bottom, behind the opaque form).
      const observed = observers.flatMap((entry) => entry.targets);
      const formCarrier = observed.find((target) =>
        target.querySelector('form.composer-form'),
      );
      expect(formCarrier).toBeDefined();
      expect(formCarrier?.parentElement).toBe(sharedWrapper);

      Object.defineProperty(formCarrier, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          height: 120,
          width: 400,
          top: 680,
          bottom: 800,
          left: 0,
          right: 400,
          x: 0,
          y: 680,
          toJSON: () => ({}),
        }),
      });

      act(() => {
        for (const entry of observers) {
          entry.callback([], {} as ResizeObserver);
        }
      });

      expect((sharedWrapper as HTMLElement).style.height).toBe('120px');
    } finally {
      // jsdom ships without ResizeObserver; restore the original value
      // (undefined there), keeping the property writable for other stubs.
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: originalResizeObserver,
      });
    }
  });

  it('marks the positioning context flex-shrink-0 so short webviews cannot shrink it behind the form', () => {
    const rendered = renderInputForm({
      showModelSelector: true,
      availableModels: models,
      currentModelId: null,
    });
    root = rendered.root;
    container = rendered.container;

    const menu = container.querySelector(
      '.model-selector',
    ) as HTMLElement | null;
    expect(menu).not.toBeNull();

    const sharedWrapper = collectAncestors(menu as HTMLElement).find((el) =>
      /(^|\s)relative(\s|$)/.test(el.className),
    );
    expect(sharedWrapper).toBeDefined();
    // An explicit height alone does not stop the flex parent from shrinking
    // this wrapper below the measured form height; a shrunken wrapper would
    // slide the bottom-full anchor back into the form's footprint
    // (#8617-style occlusion at low viewport heights).
    expect(sharedWrapper?.className).toMatch(/(^|\s)flex-shrink-0(\s|$)/);
  });

  it('does not render the selector when showModelSelector is false', () => {
    const rendered = renderInputForm({
      showModelSelector: false,
      availableModels: models,
      currentModelId: null,
    });
    root = rendered.root;
    container = rendered.container;

    expect(container.querySelector('.model-selector')).toBeNull();
  });

  it('still selects a model on click and closes the selector', () => {
    const rendered = renderInputForm({
      showModelSelector: true,
      availableModels: models,
      currentModelId: null,
    });
    root = rendered.root;
    container = rendered.container;

    const row = container.querySelector(
      '[data-index="1"]',
    ) as HTMLElement | null;
    expect(row).not.toBeNull();

    act(() => {
      (row as HTMLElement).click();
    });

    expect(rendered.onSelectModel).toHaveBeenCalledWith('model-b');
    expect(rendered.onCloseModelSelector).toHaveBeenCalledTimes(1);
  });

  it('still closes the selector on Escape', () => {
    const rendered = renderInputForm({
      showModelSelector: true,
      availableModels: models,
      currentModelId: null,
    });
    root = rendered.root;
    container = rendered.container;

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(rendered.onCloseModelSelector).toHaveBeenCalledTimes(1);
    expect(rendered.onSelectModel).not.toHaveBeenCalled();
  });
});
