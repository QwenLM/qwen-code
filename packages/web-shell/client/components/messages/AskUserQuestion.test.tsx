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

function rerender(keyboardActive?: boolean): void {
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

function render(keyboardActive?: boolean): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rerender(keyboardActive);
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

  it('jumps to first/last with Home/End', () => {
    render(undefined);
    const opts = optionButtons(); // [Red, Blue, "Other" trigger]
    expect(document.activeElement).toBe(opts[0]);

    pressKey(opts[0]!, 'End');
    expect(document.activeElement).toBe(opts[2]);
    expect(opts[2]!.tabIndex).toBe(0);

    pressKey(opts[2]!, 'Home');
    expect(document.activeElement).toBe(opts[0]);
    expect(opts[0]!.tabIndex).toBe(0);
  });

  it('restores the selected option when re-activated, not the safe default', () => {
    // Mirrors the ToolApproval guard: a covering panel flips keyboardActive
    // false then true; focus must return to the option the user had selected,
    // not snap back to the default (which would silently change what Enter
    // submits).
    render(undefined); // keyboardActive=true (topmost)
    const opts = optionButtons(); // [Red, Blue, "Other" trigger]
    pressKey(opts[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(opts[1]);

    rerender(false); // a covering panel opens
    rerender(true); // it closes

    expect(document.activeElement).toBe(opts[1]);
  });

  it('advances on rapid repeated ArrowDown without a re-render in between', () => {
    // Regression: moveSelection must write selectedIdxRef synchronously, else a
    // held key (repeating faster than React re-renders) reads a stale ref and
    // the cursor sticks. Two keydowns in one act() run before any re-render.
    render(undefined);
    const opts = optionButtons();
    expect(document.activeElement).toBe(opts[0]);

    act(() => {
      opts[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
      opts[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(opts[2]);
  });

  it('does not treat digits as shortcuts while typing in the custom input', () => {
    render(undefined);
    // Reveal the "Other" input.
    act(() => {
      optionButtons()[2]!.click();
    });
    const input = container!.querySelector('input');
    expect(input).not.toBeNull();

    const event = new KeyboardEvent('keydown', {
      key: '1',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input!.dispatchEvent(event);
    });
    // isEditableTarget exempts the input: the digit is typed, not a shortcut
    // (an unguarded handler would have called preventDefault).
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores option shortcuts when focus is on an action button, not an option', () => {
    render(undefined);
    // Click Blue so it is the committed single-select answer (arrow keys only
    // move the highlight; they don't change the answer).
    act(() => {
      optionButtons()[1]!.click();
    });
    const submit = submitButton()!;
    submit.focus();

    // Escape on Submit must not cancel the question...
    act(() =>
      submit.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onConfirm).not.toHaveBeenCalled();

    // ...and a digit must not silently overwrite the selected answer.
    act(() =>
      submit.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '1',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    act(() => submit.click());
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'submit', { '0': 'Blue' });
  });
});
