// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import type { PermissionRequest } from '../../adapters/types';
import { AskUserQuestion } from './AskUserQuestion';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const request: PermissionRequest = {
  id: 'req-1',
  content: [],
  options: [
    { id: 'submit', label: 'Submit', kind: 'allow_once' },
    { id: 'cancel', label: 'Cancel', kind: 'reject_once' },
  ],
  rawInput: {
    questions: [
      {
        question: 'Pick a color',
        header: 'Color',
        options: [
          { label: 'Red', description: 'warm' },
          { label: 'Blue', description: 'cool' },
        ],
      },
    ],
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onConfirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onConfirm = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(keyboardActive?: boolean): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <AskUserQuestion
          request={request}
          onConfirm={onConfirm}
          keyboardActive={keyboardActive}
        />
      </I18nProvider>,
    ),
  );
}

function optionButtons(): HTMLButtonElement[] {
  return Array.from(
    container!.querySelectorAll<HTMLButtonElement>(
      '[data-web-shell-ask-option]',
    ),
  );
}

function submitButton(): HTMLButtonElement | null {
  return (
    Array.from(container!.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Submit' || b.textContent === '提交',
    ) ?? null
  );
}

function pressKey(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('AskUserQuestion accessibility', () => {
  it('exposes an alertdialog of real buttons and focuses the first option', () => {
    render(undefined);
    const panel = container!.querySelector('[data-web-shell-ask-panel]');
    expect(panel?.getAttribute('role')).toBe('alertdialog');

    // Two answer options + the "Other" trigger.
    const opts = optionButtons();
    expect(opts).toHaveLength(3);
    expect(opts.every((o) => o.tagName === 'BUTTON')).toBe(true);
    expect(document.activeElement).toBe(opts[0]);
  });

  it('does not steal focus when keyboardActive is false (split-view panes)', () => {
    render(false);
    expect(optionButtons().some((o) => o === document.activeElement)).toBe(
      false,
    );
  });

  it('moves focus between options with arrow keys', () => {
    render(undefined);
    const opts = optionButtons();
    expect(document.activeElement).toBe(opts[0]);

    pressKey(opts[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(opts[1]);
    expect(opts[1]!.tabIndex).toBe(0);
    expect(opts[0]!.tabIndex).toBe(-1);
  });

  it('selects an option then submits the answer', () => {
    render(undefined);
    act(() => {
      optionButtons()[1]!.click();
    });
    act(() => {
      submitButton()!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'submit', { '0': 'Blue' });
  });

  it('picks by digit shortcut, scoped to the panel', () => {
    render(undefined);
    pressKey(optionButtons()[0]!, '2');
    act(() => {
      submitButton()!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'submit', { '0': 'Blue' });
  });

  it('ignores (cancels) on Escape', () => {
    render(undefined);
    pressKey(optionButtons()[0]!, 'Escape');
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'cancel', undefined);
  });
});
