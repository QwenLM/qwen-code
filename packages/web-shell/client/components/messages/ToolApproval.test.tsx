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
    { id: 'proceed', label: 'Proceed', kind: 'proceed_once' },
    { id: 'reject', label: 'Reject', kind: 'reject_once' },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onConfirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  onConfirm = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function render(keyboardActive?: boolean): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <ToolApproval
          request={request}
          onConfirm={onConfirm}
          keyboardActive={keyboardActive}
        />
      </I18nProvider>,
    ),
  );
  // The keydown listener is armed after a 250ms delay.
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

function pressDigitOne(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
  });
}

describe('ToolApproval keyboard gate', () => {
  it('confirms via a global shortcut when keyboardActive (the default)', () => {
    render(undefined);
    pressDigitOne();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('ignores global shortcuts when keyboardActive is false', () => {
    // Split-view panes pass keyboardActive={false} so a keypress can't confirm
    // the wrong (or an off-screen) session's approval.
    render(false);
    pressDigitOne();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
