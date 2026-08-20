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

const multiRequest: PermissionRequest = {
  id: 'req-multi',
  content: [],
  options: [
    { id: 'submit', label: 'Submit', kind: 'allow_once' },
    { id: 'cancel', label: 'Cancel', kind: 'reject_once' },
  ],
  rawInput: {
    questions: [
      {
        question: 'Pick options',
        header: 'Options',
        options: [
          { label: 'Option A', description: 'a' },
          { label: 'Option B', description: 'b' },
          { label: 'Option C', description: 'c' },
        ],
        multiSelect: true,
      },
    ],
  },
};

const multipleQuestionsRequest: PermissionRequest = {
  ...request,
  id: 'req-multiple',
  rawInput: {
    questions: [
      ...(request.rawInput?.questions as NonNullable<
        PermissionRequest['rawInput']
      >['questions']),
      {
        question: 'Pick a size',
        header: 'Size',
        options: [
          { label: 'Small', description: 'compact' },
          { label: 'Large', description: 'roomy' },
        ],
      },
    ],
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onConfirm: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onConfirm = vi.fn().mockResolvedValue(true);
  onError = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function rerender(
  keyboardActive?: boolean,
  req: PermissionRequest = request,
): void {
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <AskUserQuestion
          request={req}
          onConfirm={onConfirm}
          onError={onError}
          keyboardActive={keyboardActive}
        />
      </I18nProvider>,
    ),
  );
}

function render(
  keyboardActive?: boolean,
  req: PermissionRequest = request,
): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rerender(keyboardActive, req);
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
      (b) =>
        b.textContent === 'Submit' ||
        b.textContent === 'Submitting...' ||
        b.textContent === '提交' ||
        b.textContent === '提交中...',
    ) ?? null
  );
}

function pressKey(
  target: Element,
  key: string,
  init: Omit<KeyboardEventInit, 'key' | 'bubbles'> = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AskUserQuestion accessibility', () => {
  it('exposes a non-modal dialog of real buttons and focuses the first option', () => {
    render(undefined);
    const panel = container!.querySelector('[data-web-shell-ask-panel]');
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.hasAttribute('aria-modal')).toBe(false);

    // Two answer options + the "Other" trigger.
    const opts = optionButtons();
    expect(opts).toHaveLength(3);
    expect(opts.every((o) => o.tagName === 'BUTTON')).toBe(true);
    expect(document.activeElement).toBe(opts[0]);
  });

  it('exposes single-select options as radios in a radiogroup', () => {
    render(undefined);
    const panel = container!.querySelector('[data-web-shell-ask-panel]')!;
    expect(panel.querySelector('[role="radiogroup"]')).not.toBeNull();

    const opts = optionButtons();
    // Radios (not toggle buttons) convey mutual exclusivity; the default first
    // option is checked.
    expect(opts[0]!.getAttribute('role')).toBe('radio');
    expect(opts[0]!.getAttribute('aria-checked')).toBe('true');
    expect(opts[1]!.getAttribute('aria-checked')).toBe('false');
    expect(opts[0]!.hasAttribute('aria-pressed')).toBe(false);
  });

  it('arrow keys change the single-select answer, not just the highlight', () => {
    // Radiogroup contract: arrow keys move focus AND selection. aria-checked
    // must follow the option the user moved to, and Submit must send it — not
    // the originally-checked default.
    render(undefined);
    const opts = optionButtons();
    pressKey(opts[0]!, 'ArrowDown'); // Red -> Blue

    expect(opts[1]!.getAttribute('aria-checked')).toBe('true');
    expect(opts[0]!.getAttribute('aria-checked')).toBe('false');

    act(() => {
      submitButton()!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'submit', { '0': 'Blue' });
  });

  it('Home/End change the single-select answer too (radiogroup contract)', () => {
    render(undefined);
    const opts = optionButtons();
    pressKey(opts[0]!, 'ArrowDown'); // -> Blue, answer=Blue
    expect(opts[1]!.getAttribute('aria-checked')).toBe('true');

    // Home jumps to the first option and commits it as the answer.
    pressKey(opts[1]!, 'Home');
    expect(document.activeElement).toBe(opts[0]);
    expect(opts[0]!.getAttribute('aria-checked')).toBe('true');
    expect(opts[1]!.getAttribute('aria-checked')).toBe('false');

    act(() => {
      submitButton()!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'submit', { '0': 'Red' });
  });

  it('moving to "Other" clears the regular single-select answer', () => {
    render(undefined);
    const opts = optionButtons(); // [Red, Blue, "Other" trigger]
    pressKey(opts[0]!, 'ArrowDown'); // -> Blue, checked
    expect(opts[1]!.getAttribute('aria-checked')).toBe('true');

    // Arrow onto "Other": no regular option may stay checked while focus is on
    // "Other" (the custom answer isn't committed until the user types it).
    pressKey(opts[1]!, 'ArrowDown'); // -> Other
    expect(document.activeElement).toBe(opts[2]);
    expect(opts[0]!.getAttribute('aria-checked')).toBe('false');
    expect(opts[1]!.getAttribute('aria-checked')).toBe('false');
  });

  it('clicking the "Other" row padding (not just the trigger) opens the input', () => {
    render(undefined);
    const trigger = optionButtons()[2]; // custom trigger button
    const row = trigger.parentElement!; // the .option wrapper (cursor:pointer)
    // A mouse user clicking the row's padding area must also activate "Other".
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container!.querySelector('input')).not.toBeNull();
  });

  it('keeps the custom input focused when its row padding is clicked', () => {
    render(undefined);
    act(() => optionButtons()[2]!.click());
    const input = container!.querySelector<HTMLInputElement>('input')!;
    const row = input.parentElement!;
    expect(document.activeElement).toBe(input);

    const inputMouseDown = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    act(() => input.dispatchEvent(inputMouseDown));
    expect(inputMouseDown.defaultPrevented).toBe(false);

    const rowMouseDown = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      row.dispatchEvent(rowMouseDown);
    });

    expect(rowMouseDown.defaultPrevented).toBe(true);
    expect(container!.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it('names the expanded dialog with both the tool name and the question', () => {
    render(undefined);
    const panel = container!.querySelector('[data-web-shell-ask-panel]')!;
    const labelledby = panel.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    // aria-labelledby must reference two existing elements (tool name + question)
    // so the tool-name context isn't dropped when the dialog is expanded.
    const referenced = labelledby!
      .split(' ')
      .map((id) => document.getElementById(id));
    expect(referenced).toHaveLength(2);
    expect(referenced.every((el) => el !== null)).toBe(true);
    expect(
      referenced.some((el) => el!.textContent!.includes('Pick a color')),
    ).toBe(true);
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

  it('restores focus to the "Other" trigger when re-activated', () => {
    // Covers the focus effect's customRef branch (idx === options.length): when
    // the "Other" option is current and a covering panel closes, focus must
    // return to its trigger rather than falling back to body/an option.
    render(undefined);
    const opts = optionButtons(); // [Red, Blue, "Other" trigger]
    pressKey(opts[0]!, 'End'); // End → last item = the "Other" trigger
    expect(document.activeElement).toBe(opts[2]);

    rerender(false);
    rerender(true);

    expect(document.activeElement).toBe(opts[2]);
  });

  it('focuses the first option when a new question arrives while active', () => {
    // Symmetric to the ToolApproval guard. The focus effect reads
    // selectedIdxRef.current (written by a separate reset effect), so an
    // effect-ordering refactor could silently break focus on new-question
    // arrival — lock the behavior in.
    render(undefined);
    const opts = optionButtons();
    pressKey(opts[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(opts[1]);

    rerender(true, { ...request, id: 'req-2' });
    expect(document.activeElement).toBe(optionButtons()[0]);
  });

  it('handles a shorter new request while viewing a later question', () => {
    render(undefined, multipleQuestionsRequest);
    pressKey(optionButtons()[0]!, 'Enter');

    expect(() =>
      rerender(undefined, { ...request, id: 'req-shorter' }),
    ).not.toThrow();
    expect(container!.textContent).toContain('Pick a color');
    expect(document.activeElement).toBe(optionButtons()[0]);
  });

  it('focuses the first question when a same-length new request arrives', () => {
    render(undefined, multipleQuestionsRequest);
    pressKey(optionButtons()[0]!, 'Enter');
    expect(container!.textContent).toContain('Pick a size');

    const replacementRequest: PermissionRequest = {
      ...multipleQuestionsRequest,
      id: 'req-replacement',
      rawInput: {
        questions: [
          {
            question: 'Pick a shape',
            header: 'Shape',
            options: [{ label: 'Circle', description: 'round' }],
          },
          {
            question: 'Pick a speed',
            header: 'Speed',
            options: [{ label: 'Fast', description: 'quick' }],
          },
        ],
      },
    };
    rerender(undefined, replacementRequest);

    expect(container!.textContent).toContain('Pick a shape');
    expect(optionButtons()[0]!.textContent).toContain('Circle');
    expect(document.activeElement).toBe(optionButtons()[0]);
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

  it('exits custom-input editing on Escape, then cancels on a second Escape', () => {
    render(undefined);
    act(() => {
      optionButtons()[2]!.click();
    });
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Purple');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Escape');

    expect(onConfirm).not.toHaveBeenCalled();
    expect(container!.querySelector('input')).toBeNull();
    const other = optionButtons()[2]!;
    expect(other.textContent).toContain('Purple');
    expect(document.activeElement).toBe(other);

    pressKey(other, 'Escape');
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'cancel', undefined);
  });

  it('leaves custom-input Escape to an active IME composition', () => {
    render(undefined);
    act(() => {
      optionButtons()[2]!.click();
    });
    const input = container!.querySelector<HTMLInputElement>('input')!;
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'isComposing', { value: true });

    act(() => input.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(container!.querySelector('input')).toBe(input);
    expect(onConfirm).not.toHaveBeenCalled();

    const keyCodeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keyCodeEvent, 'keyCode', { value: 229 });
    act(() => input.dispatchEvent(keyCodeEvent));
    expect(keyCodeEvent.defaultPrevented).toBe(false);
    expect(container!.querySelector('input')).toBe(input);
  });

  it('leaves custom-input Enter to an active IME composition', () => {
    render(undefined);
    act(() => {
      optionButtons()[2]!.click();
    });
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Purple');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const composingEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEvent, 'isComposing', { value: true });
    act(() => input.dispatchEvent(composingEvent));

    expect(composingEvent.defaultPrevented).toBe(false);
    expect(container!.querySelector('input')).toBe(input);
    expect(onConfirm).not.toHaveBeenCalled();

    const keyCodeEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keyCodeEvent, 'keyCode', { value: 229 });
    act(() => input.dispatchEvent(keyCodeEvent));

    expect(keyCodeEvent.defaultPrevented).toBe(false);
    expect(container!.querySelector('input')).toBe(input);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not apply option shortcuts when focus is on an action button', () => {
    render(undefined);
    act(() => {
      optionButtons()[1]!.click();
    });
    const submit = submitButton()!;
    submit.focus();

    pressKey(submit, '1', { cancelable: true });
    act(() => submit.click());
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'submit', { '0': 'Blue' });
  });

  it('cancels on Escape from an action button', () => {
    render(undefined);
    const submit = submitButton()!;
    submit.focus();

    pressKey(submit, 'Escape', { cancelable: true });

    expect(onConfirm).toHaveBeenCalledWith('req-1', 'cancel', undefined);
  });

  it('submits a single question directly with Enter', () => {
    render();
    act(() => optionButtons()[1]!.click());

    pressKey(optionButtons()[1]!, 'Enter');

    expect(onConfirm).toHaveBeenCalledWith('req-1', 'submit', {
      '0': 'Blue',
    });
  });

  it('restores option navigation with arrows from another dialog control', () => {
    render(undefined);
    const submit = submitButton()!;
    submit.focus();

    pressKey(submit, 'ArrowDown');

    expect(document.activeElement).toBe(optionButtons()[0]);
    expect(optionButtons()[0]!.getAttribute('aria-checked')).toBe('true');

    pressKey(optionButtons()[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(optionButtons()[1]);
  });

  it('keeps keyboard navigation scoped after clicking dialog content', () => {
    render(undefined);
    const panel = container!.querySelector<HTMLElement>(
      '[data-web-shell-ask-panel]',
    )!;
    const questionText = Array.from(panel.querySelectorAll('p')).find(
      (element) => element.textContent === 'Pick a color',
    )!;

    act(() => {
      questionText.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(panel);

    pressKey(panel, 'ArrowDown');
    expect(document.activeElement).toBe(optionButtons()[0]);

    pressKey(optionButtons()[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(optionButtons()[1]);
  });

  it('submits a custom answer for a single question with Enter', () => {
    render();
    act(() => optionButtons()[2]!.click());
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Purple');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Enter');

    expect(onConfirm).toHaveBeenCalledWith('req-1', 'submit', {
      '0': 'Purple',
    });
  });

  it('restores focus to the custom answer after Enter submission fails', async () => {
    onConfirm.mockRejectedValueOnce(new Error('network unavailable'));
    render();
    act(() => optionButtons()[2]!.click());
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Purple');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Enter');
    await act(async () => {
      await Promise.resolve();
    });

    const other = optionButtons()[2]!;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'network unavailable' }),
      'Failed to submit answer',
    );
    expect(other.textContent).toContain('Purple');
    expect(document.activeElement).toBe(other);
  });

  it('does not restore custom answer focus after focus moves elsewhere', async () => {
    const pending = deferred<boolean>();
    onConfirm.mockReturnValueOnce(pending.promise);
    const outsideButton = document.createElement('button');
    document.body.appendChild(outsideButton);
    render();
    act(() => optionButtons()[2]!.click());
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Purple');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Enter');
    outsideButton.focus();
    await act(async () => {
      pending.reject(new Error('network unavailable'));
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(outsideButton);
    outsideButton.remove();
  });

  it('reopens a whitespace-only custom answer instead of submitting it', () => {
    render();
    act(() => optionButtons()[2]!.click());
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, '   ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Escape', { cancelable: true });
    const other = optionButtons()[2]!;
    pressKey(other, 'Enter', { cancelable: true });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(container!.querySelector('input')).not.toBeNull();
    expect(document.activeElement).toBe(
      container!.querySelector<HTMLInputElement>('input'),
    );
  });

  it('keeps an accepted submission locked while awaiting resolution', async () => {
    const pending = deferred<boolean>();
    onConfirm.mockReturnValue(pending.promise);
    render(undefined);

    act(() => {
      submitButton()!.click();
      submitButton()!.click();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(submitButton()!.disabled).toBe(true);
    expect(submitButton()!.textContent).toBe('Submitting...');

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });

    expect(submitButton()!.disabled).toBe(true);
  });

  it('reports a rejected submit and allows retrying', async () => {
    onConfirm
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(true);
    render(undefined);

    await act(async () => {
      submitButton()!.click();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'network unavailable' }),
      'Failed to submit answer',
    );
    expect(submitButton()!.disabled).toBe(false);

    act(() => {
      submitButton()!.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('reports an unaccepted submit and allows retrying', async () => {
    onConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(undefined);

    await act(async () => {
      submitButton()!.click();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to submit answer' }),
      'Failed to submit answer',
    );
    expect(submitButton()!.disabled).toBe(false);

    act(() => {
      submitButton()!.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale failure after a new request starts submitting', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    onConfirm
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(undefined);

    act(() => {
      submitButton()!.click();
    });
    rerender(undefined, { ...request, id: 'req-2' });
    act(() => {
      submitButton()!.click();
    });

    await act(async () => {
      first.reject(new Error('stale failure'));
      try {
        await first.promise;
      } catch {
        // Expected: the stale attempt rejects.
      }
    });

    expect(onError).not.toHaveBeenCalled();
    expect(submitButton()!.disabled).toBe(true);
  });

  it('reports a missing submit option without calling onConfirm', () => {
    render(undefined, {
      ...request,
      options: request.options.filter((option) => option.kind !== 'allow_once'),
    });

    act(() => {
      submitButton()!.click();
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Submit option is unavailable' }),
      'Submit option is unavailable',
    );
  });
});

describe('AskUserQuestion multiple questions', () => {
  it('advances with Enter and focuses the destination answer', () => {
    render(undefined, multipleQuestionsRequest);
    const firstQuestionOptions = optionButtons();
    pressKey(firstQuestionOptions[0]!, 'ArrowDown');

    pressKey(firstQuestionOptions[1]!, 'Enter');

    expect(container!.textContent).toContain('Pick a size');
    expect(document.activeElement).toBe(optionButtons()[0]);
  });

  it('restores focus to the checked answer when returning to a question', () => {
    render(undefined, multipleQuestionsRequest);
    pressKey(optionButtons()[0]!, 'ArrowDown');
    const next = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'next')!;
    act(() => next.click());
    const previous = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'previous')!;

    act(() => previous.click());

    const restoredOptions = optionButtons();
    expect(restoredOptions[1]!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(restoredOptions[1]);
  });

  it('moves between questions with horizontal arrows from an option', () => {
    render(undefined, multipleQuestionsRequest);
    pressKey(optionButtons()[0]!, 'Enter');

    expect(container!.textContent).toContain('← previous · ↑↓ select');
    pressKey(optionButtons()[0]!, 'ArrowLeft');

    expect(container!.textContent).toContain('Pick a color');
    expect(container!.textContent).not.toContain('← previous');

    pressKey(optionButtons()[0]!, 'ArrowRight');
    expect(container!.textContent).toContain('Pick a size');
    expect(container!.textContent).not.toContain('→ next');
  });

  it('moves between questions with horizontal arrows from an action button', () => {
    render(undefined, multipleQuestionsRequest);
    const next = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'next')!;
    act(() => next.click());
    const submit = submitButton()!;
    submit.focus();

    pressKey(submit, 'ArrowLeft', { cancelable: true });
    expect(container!.textContent).toContain('Pick a color');

    submit.focus();
    pressKey(submit, 'ArrowRight', { cancelable: true });
    expect(container!.textContent).toContain('Pick a size');
  });

  it('does not restore the default answer when returning to empty Other', () => {
    render(undefined, multipleQuestionsRequest);
    pressKey(optionButtons()[0]!, 'End');
    const next = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'next')!;
    act(() => next.click());
    const previous = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'previous')!;
    act(() => previous.click());

    const restoredOptions = optionButtons();
    expect(document.activeElement).toBe(restoredOptions[2]);
    expect(restoredOptions[0]!.getAttribute('aria-checked')).toBe('false');
    expect(restoredOptions[1]!.getAttribute('aria-checked')).toBe('false');

    pressKey(restoredOptions[2]!, 'Enter', {
      ctrlKey: true,
      cancelable: true,
    });
    expect(onConfirm).toHaveBeenCalledWith('req-multiple', 'submit', {
      '0': '',
      '1': 'Small',
    });
  });

  it('submits directly when Enter is pressed on the last question', () => {
    render(undefined, multipleQuestionsRequest);
    pressKey(optionButtons()[0]!, 'Enter');
    pressKey(optionButtons()[0]!, 'Enter');

    expect(onConfirm).toHaveBeenCalledWith('req-multiple', 'submit', {
      '0': 'Red',
      '1': 'Small',
    });
  });

  it('submits all answers with Command/Ctrl+Enter when complete', () => {
    render(undefined, multipleQuestionsRequest);
    pressKey(optionButtons()[0]!, 'Enter');

    pressKey(optionButtons()[1]!, 'Enter', { ctrlKey: true });

    expect(onConfirm).toHaveBeenCalledWith('req-multiple', 'submit', {
      '0': 'Red',
      '1': 'Small',
    });
  });

  it('submits incomplete answers with Command/Ctrl+Enter', () => {
    render(undefined, multipleQuestionsRequest);

    const event = pressKey(optionButtons()[0]!, 'Enter', {
      metaKey: true,
      cancelable: true,
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onConfirm).toHaveBeenCalledWith('req-multiple', 'submit', {
      '0': 'Red',
      '1': '',
    });
  });

  it.each([
    ['Control', { ctrlKey: true }],
    ['Command', { metaKey: true }],
  ] as const)(
    'submits from an intermediate custom input with %s+Enter',
    (_modifier, modifierInit) => {
      render(undefined, multipleQuestionsRequest);
      act(() => optionButtons()[2]!.click());
      const input = container!.querySelector<HTMLInputElement>('input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(input, 'Purple');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const event = pressKey(input, 'Enter', {
        ...modifierInit,
        cancelable: true,
      });

      expect(event.defaultPrevented).toBe(true);
      expect(onConfirm).toHaveBeenCalledWith('req-multiple', 'submit', {
        '0': 'Purple',
        '1': '',
      });
    },
  );

  it('associates global shortcuts with their action buttons', () => {
    render();

    const ignore = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'Ignore',
    )!;
    expect(ignore.getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(ignore.dataset.shortcut).toBe('Esc');

    const submit = submitButton()!;
    expect(submit.getAttribute('aria-keyshortcuts')).toBe(
      'Control+Enter Meta+Enter',
    );
    expect(submit.dataset.shortcut).toMatch(/^(Ctrl↵|⌘↵)$/);
  });

  it('shows contextual keyboard hints', () => {
    render();
    expect(container!.textContent).toContain('↑↓ select · Enter submit');
    expect(container!.textContent).not.toContain('Esc ignore');
    expect(container!.textContent).not.toContain('⌘/Ctrl+Enter');
    const singleHint = Array.from(container!.querySelectorAll('p')).find(
      (element) => element.textContent?.includes('Enter submit'),
    );
    expect(singleHint?.parentElement).toBe(submitButton()?.parentElement);
    act(() => optionButtons()[2]!.click());
    expect(container!.textContent).toContain(
      'Type an answer · Esc stop editing',
    );
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Purple');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container!.textContent).toContain('Enter submit · Esc stop editing');
    expect(container!.textContent).not.toContain('⌘/Ctrl+Enter');

    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;

    render(undefined, multipleQuestionsRequest);
    expect(container!.textContent).toContain('↑↓ select · Enter next');
    expect(container!.textContent).not.toContain('Esc ignore');
    expect(container!.textContent).not.toContain('⌘/Ctrl+Enter');

    act(() => optionButtons()[2]!.click());
    expect(container!.textContent).toContain(
      'Type an answer · Esc stop editing',
    );
    expect(container!.textContent).not.toContain('⌘/Ctrl+Enter');
  });

  it('describes Enter as editing when the empty custom row is focused', () => {
    render();
    pressKey(optionButtons()[0]!, 'End');

    expect(container!.textContent).toContain('↑↓ select · Enter edit');
    expect(container!.textContent).not.toContain('Esc ignore');
    expect(container!.textContent).not.toContain('Enter submit');

    pressKey(optionButtons()[2]!, 'Enter');
    expect(container!.querySelector('input')).not.toBeNull();
  });

  it('keeps the shortcut footer hidden while the dialog is collapsed', () => {
    render();
    const panel = container!.querySelector('[data-web-shell-ask-panel]')!;
    const collapse = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse"]',
    )!;

    act(() => collapse.click());

    expect(panel.getAttribute('aria-labelledby')).toBeNull();
    expect(container!.textContent).not.toContain('Enter submit');
    const expand = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Expand"]',
    )!;
    act(() => expand.click());
    expect(container!.textContent).toContain('Enter submit');
  });

  it('keeps action shortcuts inert while the dialog is collapsed', () => {
    render(undefined, multipleQuestionsRequest);
    const collapse = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse"]',
    )!;
    act(() => collapse.click());
    const expand = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Expand"]',
    )!;

    const escapeEvent = pressKey(expand, 'Escape', { cancelable: true });
    const submitEvent = pressKey(expand, 'Enter', {
      ctrlKey: true,
      cancelable: true,
    });

    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(submitEvent.defaultPrevented).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container!.querySelector('[aria-label="Expand"]')).not.toBeNull();
  });

  it('does not advertise the global submit shortcut on the last question', () => {
    render(undefined, multipleQuestionsRequest);
    pressKey(optionButtons()[0]!, 'Enter');

    expect(container!.textContent).toContain('↑↓ select · Enter submit');
    expect(container!.textContent).not.toContain('Esc ignore');
    expect(container!.textContent).not.toContain('⌘/Ctrl+Enter');

    act(() => optionButtons()[2]!.click());
    expect(container!.textContent).toContain(
      'Type an answer · Esc stop editing',
    );
    expect(container!.textContent).not.toContain('⌘/Ctrl+Enter');
  });

  it('confirms a custom answer with Enter and advances', () => {
    render(undefined, multipleQuestionsRequest);
    act(() => optionButtons()[2]!.click());
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Purple');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Enter');

    expect(container!.textContent).toContain('Pick a size');
    expect(document.activeElement).toBe(optionButtons()[0]);
  });

  it('restores a custom answer and its focus when returning to a question', () => {
    render(undefined, multipleQuestionsRequest);
    act(() => optionButtons()[2]!.click());
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Purple');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Enter');
    const previous = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'previous')!;
    act(() => previous.click());

    const other = optionButtons()[2]!;
    expect(other.textContent).toBe('Purple');
    expect(other.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(other);
  });

  it('submits a custom answer with Enter on the last question', () => {
    render(undefined, multipleQuestionsRequest);
    pressKey(optionButtons()[0]!, 'Enter');
    act(() => optionButtons()[2]!.click());
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Medium');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Enter');

    expect(onConfirm).toHaveBeenCalledWith('req-multiple', 'submit', {
      '0': 'Red',
      '1': 'Medium',
    });
  });
});

describe('AskUserQuestion multi-select', () => {
  it('describes moving when the empty custom row is focused', () => {
    render(undefined, multiRequest);
    pressKey(optionButtons()[0]!, 'End');

    expect(container!.textContent).toContain('↑↓ move · Enter edit');
    expect(container!.textContent).not.toContain('↑↓ select · Enter edit');
  });

  it('does not advertise the global submit shortcut on a final multi-select question', () => {
    const requestWithMultiFinal: PermissionRequest = {
      ...multipleQuestionsRequest,
      rawInput: {
        questions: [
          ...(request.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
          ...(multiRequest.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
        ],
      },
    };
    render(undefined, requestWithMultiFinal);
    pressKey(optionButtons()[0]!, 'Enter');

    expect(container!.textContent).toContain(
      '↑↓ move · Space select/deselect · Enter select & submit',
    );
    expect(container!.textContent).not.toContain('⌘/Ctrl+Enter');
  });

  it('submits a single multi-select question with Enter without advertising the global shortcut', () => {
    render(undefined, multiRequest);

    expect(container!.textContent).toContain(
      '↑↓ move · Space select/deselect · Enter select & submit',
    );
    expect(container!.textContent).not.toContain('⌘/Ctrl+Enter');
    pressKey(optionButtons()[0]!, 'Enter');

    expect(onConfirm).toHaveBeenCalledWith('req-multi', 'submit', {
      '0': 'Option A',
    });
  });

  it('uses group + toggle-button semantics, not radiogroup', () => {
    render(undefined, multiRequest);
    const panel = container!.querySelector('[data-web-shell-ask-panel]')!;
    expect(panel.querySelector('[role="group"]')).not.toBeNull();
    expect(panel.querySelector('[role="radiogroup"]')).toBeNull();

    // Multi-select options are toggle buttons (aria-pressed), not radios.
    const opts = optionButtons();
    expect(opts[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(opts[0]!.tabIndex).toBe(0);
    expect(submitButton()!.disabled).toBe(false);
    expect(opts[0]!.hasAttribute('aria-checked')).toBe(false);
    expect(opts[0]!.getAttribute('role')).not.toBe('radio');
  });

  it('does not select the first option when navigating to a multi-select question', () => {
    const requestWithMultiSecond: PermissionRequest = {
      ...multipleQuestionsRequest,
      rawInput: {
        questions: [
          ...(request.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
          ...(multiRequest.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
        ],
      },
    };
    render(undefined, requestWithMultiSecond);

    pressKey(optionButtons()[0]!, 'Enter');

    const opts = optionButtons();
    expect(opts[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(opts[0]!.tabIndex).toBe(0);
    expect(submitButton()!.disabled).toBe(false);
  });

  it('toggles options and submits the joined selection', () => {
    render(undefined, multiRequest);
    const opts = optionButtons();
    expect(opts[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(opts[1]!.getAttribute('aria-pressed')).toBe('false');

    // Toggle Option B on, then Option A on and off.
    act(() => {
      opts[1]!.click();
    });
    expect(opts[1]!.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      opts[0]!.click();
    });
    expect(opts[0]!.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      opts[0]!.click();
    });
    expect(opts[0]!.getAttribute('aria-pressed')).toBe('false');

    // Submit → only Option B remains, joined into the answer.
    act(() => {
      submitButton()!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('req-multi', 'submit', {
      '0': 'Option B',
    });
  });

  it('submits regular and custom multi-select answers together with Enter', () => {
    render(undefined, multiRequest);
    act(() => optionButtons()[1]!.click());
    act(() => optionButtons()[3]!.click());
    const input = container!.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Custom option');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Enter');

    expect(onConfirm).toHaveBeenCalledWith('req-multi', 'submit', {
      '0': 'Option B, Custom option',
    });
  });

  it('cancels a selection when the same option is clicked twice rapidly', () => {
    render(undefined, multiRequest);
    const optionB = optionButtons()[1]!;

    act(() => {
      optionB.click();
      optionB.click();
    });

    expect(optionB.getAttribute('aria-pressed')).toBe('false');
  });

  it('preserves each selection when different options are clicked rapidly', () => {
    render(undefined, multiRequest);
    const options = optionButtons();

    act(() => {
      options[1]!.click();
      options[2]!.click();
    });

    expect(options[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(options[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(options[2]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps mouse focus changes separate from multi-select state', () => {
    render(undefined, multiRequest);
    const options = optionButtons();

    act(() => {
      options[1]!.focus();
      options[1]!.click();
    });
    act(() => {
      options[2]!.focus();
      options[2]!.click();
    });

    expect(options[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(options[2]!.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      options[1]!.focus();
      options[1]!.click();
    });

    expect(options[1]!.getAttribute('aria-pressed')).toBe('false');
    expect(options[2]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('uses Enter to advance without toggling the selected option', () => {
    const requestWithNextQuestion: PermissionRequest = {
      ...multipleQuestionsRequest,
      rawInput: {
        questions: [
          ...(multiRequest.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
          ...(request.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
        ],
      },
    };
    render(undefined, requestWithNextQuestion);
    const first = optionButtons()[0]!;
    expect(first.getAttribute('aria-pressed')).toBe('false');

    act(() => first.click());
    expect(first.getAttribute('aria-pressed')).toBe('true');

    pressKey(first, 'Enter');

    expect(container!.textContent).toContain('Pick a color');
    const previous = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'previous')!;
    act(() => previous.click());
    expect(optionButtons()[0]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('selects an unselected option with Enter before advancing', () => {
    const requestWithNextQuestion: PermissionRequest = {
      ...multipleQuestionsRequest,
      rawInput: {
        questions: [
          ...(multiRequest.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
          ...(request.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
        ],
      },
    };
    render(undefined, requestWithNextQuestion);

    expect(container!.textContent).toContain(
      '↑↓ move · Space select/deselect · Enter select & next',
    );
    expect(container!.textContent).not.toContain('⌘/Ctrl+Enter');
    expect(container!.textContent).not.toContain('Esc ignore');
    expect(optionButtons()[0]!.getAttribute('aria-pressed')).toBe('false');

    pressKey(optionButtons()[0]!, 'Enter');

    expect(container!.textContent).toContain('Pick a color');
    const previous = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'previous')!;
    act(() => previous.click());
    expect(optionButtons()[0]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('submits from the final multi-select question when an earlier answer is missing', () => {
    const requestWithMultiFinal: PermissionRequest = {
      ...multipleQuestionsRequest,
      rawInput: {
        questions: [
          ...(request.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
          ...(multiRequest.rawInput?.questions as NonNullable<
            PermissionRequest['rawInput']
          >['questions']),
        ],
      },
    };
    render(undefined, requestWithMultiFinal);

    pressKey(optionButtons()[0]!, 'End');
    act(() => {
      Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'next')!
        .click();
    });
    pressKey(optionButtons()[0]!, 'Enter');

    expect(optionButtons()[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(onConfirm).toHaveBeenCalledWith('req-multiple', 'submit', {
      '0': '',
      '1': 'Option A',
    });
    expect(submitButton()!.disabled).toBe(true);
  });
});
