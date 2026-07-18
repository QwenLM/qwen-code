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
import { ToolApproval } from './ToolApproval';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const request: PermissionRequest = {
  id: 'req-1',
  content: [],
  options: [
    { id: 'proceed', label: 'Proceed', kind: 'allow_once' },
    { id: 'reject', label: 'Reject', kind: 'reject_once' },
  ],
};

const execRequest: PermissionRequest = {
  id: 'req-exec',
  content: [],
  toolName: 'run_shell_command',
  title: 'run_shell_command',
  options: [
    { id: 'proceed', label: 'Proceed', kind: 'allow_once' },
    { id: 'reject', label: 'Reject', kind: 'reject_once' },
  ],
  rawInput: {
    command: 'rm -rf /tmp/data',
    description: 'Delete temporary data',
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

function rerender(
  keyboardActive?: boolean,
  req: PermissionRequest = request,
): void {
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <ToolApproval
          request={req}
          onConfirm={onConfirm}
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
      '[data-web-shell-permission-option]',
    ),
  );
}

function pressKey(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('ToolApproval accessibility', () => {
  it('exposes an alertdialog of real, focusable buttons', () => {
    render(undefined);
    const panel = container!.querySelector('[data-web-shell-permission-panel]');
    expect(panel?.getAttribute('role')).toBe('alertdialog');

    const opts = optionButtons();
    expect(opts).toHaveLength(2);
    expect(opts.every((o) => o.tagName === 'BUTTON')).toBe(true);
    // Exactly one option is in the tab order (roving tabindex).
    expect(opts.filter((o) => o.tabIndex === 0)).toHaveLength(1);
  });

  it('exposes the options as radios in a radiogroup (single-select)', () => {
    render(undefined);
    const panel = container!.querySelector(
      '[data-web-shell-permission-panel]',
    )!;
    expect(panel.querySelector('[role="radiogroup"]')).not.toBeNull();

    const opts = optionButtons();
    // The safe default (reject, index 0) is the checked radio.
    expect(opts[0]!.getAttribute('role')).toBe('radio');
    expect(opts[0]!.getAttribute('aria-checked')).toBe('true');
    expect(opts[1]!.getAttribute('aria-checked')).toBe('false');
  });

  it('exposes the command and description to assistive tech', () => {
    render(undefined, execRequest);
    const panel = container!.querySelector(
      '[data-web-shell-permission-panel]',
    )!;
    const describedby = panel.getAttribute('aria-describedby');
    expect(describedby).toBeTruthy();

    // SR users must hear WHAT will run, not just the question — the referenced
    // elements include the command and the description.
    const texts = describedby!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '');
    expect(texts.some((t) => t.includes('rm -rf /tmp/data'))).toBe(true);
    expect(texts.some((t) => t.includes('Delete temporary data'))).toBe(true);
  });

  it('focuses the safe-default option when keyboardActive (the default)', () => {
    render(undefined);
    // Reject sorts first and is the safe default.
    const opts = optionButtons();
    expect(opts[0]?.getAttribute('data-option-id')).toBe('reject');
    expect(document.activeElement).toBe(opts[0]);
  });

  it('does not steal focus when keyboardActive is false (split-view panes)', () => {
    render(false);
    expect(optionButtons().some((o) => o === document.activeElement)).toBe(
      false,
    );
  });

  it('confirms the clicked option', () => {
    render(undefined);
    act(() => {
      optionButtons()[1]!.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'proceed');
  });

  it('confirms by digit shortcut, scoped to the panel', () => {
    render(undefined);
    // '2' picks the second ordered option (proceed). Dispatched on a button so
    // it bubbles to the panel's onKeyDown — a window-level keypress would not.
    pressKey(optionButtons()[0]!, '2');
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'proceed');
  });

  it('rejects on Escape', () => {
    render(undefined);
    pressKey(optionButtons()[0]!, 'Escape');
    expect(onConfirm).toHaveBeenCalledWith('req-1', 'reject');
  });

  it('moves focus between options with arrow keys (roving tabindex)', () => {
    render(undefined);
    const opts = optionButtons();
    expect(document.activeElement).toBe(opts[0]);

    pressKey(opts[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(opts[1]);
    expect(opts[1]!.tabIndex).toBe(0);
    expect(opts[0]!.tabIndex).toBe(-1);

    pressKey(opts[1]!, 'ArrowUp');
    expect(document.activeElement).toBe(opts[0]);
    expect(opts[0]!.tabIndex).toBe(0);
  });

  it('jumps to first/last option with Home/End', () => {
    render(undefined);
    const opts = optionButtons();
    expect(document.activeElement).toBe(opts[0]);

    pressKey(opts[0]!, 'End');
    expect(document.activeElement).toBe(opts[1]);
    expect(opts[1]!.tabIndex).toBe(0);

    pressKey(opts[1]!, 'Home');
    expect(document.activeElement).toBe(opts[0]);
    expect(opts[0]!.tabIndex).toBe(0);
  });

  it('restores the selected option when re-activated, not the safe default', () => {
    render(undefined); // keyboardActive=true (topmost)
    const opts = optionButtons();
    // User moves off the default (Reject) to Proceed.
    pressKey(opts[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(opts[1]);

    // A covering panel opens (keyboardActive=false) then closes (true).
    rerender(false);
    rerender(true);

    // Focus returns to the user's selection — it must not snap back to Reject
    // (which would silently change what Enter confirms).
    expect(document.activeElement).toBe(opts[1]);
  });

  it('leaves Enter to native button activation (no double-press guard)', () => {
    render(undefined);
    const opts = optionButtons();
    opts[1]!.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      opts[1]!.dispatchEvent(event);
    });
    // handleKeyDown must not intercept Enter: the focused button activates
    // natively on Enter, so a single press confirms. The old interactedRef
    // double-press guard preventDefault'd the first Enter — assert that no such
    // interception exists. (jsdom doesn't synthesize the native Enter->click, so
    // we assert the handler leaves the event un-cancelled instead.)
    expect(event.defaultPrevented).toBe(false);
  });
});
