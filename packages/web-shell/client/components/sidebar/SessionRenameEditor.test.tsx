// @vitest-environment jsdom

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { SessionRenameEditor } from './SessionRenameEditor';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function renderEditor(
  overrides: {
    label?: string;
    onCommit?: (name: string) => void;
    onCancel?: () => void;
  } = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCommit = overrides.onCommit ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  act(() => {
    root.render(
      <I18nProvider language="en">
        <SessionRenameEditor
          label={overrides.label ?? 'Original name'}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </I18nProvider>,
    );
  });
  const input = container.querySelector('input');
  expect(input).not.toBeNull();
  return {
    container,
    input: input!,
    onCommit,
    onCancel,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SessionRenameEditor', () => {
  it('keeps the draft local and commits it on submit', () => {
    const { container, input, onCommit, unmount } = renderEditor();

    expect(input.value).toBe('Original name');
    act(() => type(input, 'Renamed session'));
    expect(input.value).toBe('Renamed session');
    // Typing only touches this component; the parent is not notified until
    // the draft is committed.
    expect(onCommit).not.toHaveBeenCalled();

    act(() =>
      container
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(onCommit).toHaveBeenCalledWith('Renamed session');
    unmount();
  });

  it('cancels on Escape without committing', () => {
    const { input, onCancel, onCommit, unmount } = renderEditor();

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    unmount();
  });

  it('cancels when the input loses focus', () => {
    const { input, onCancel, unmount } = renderEditor();

    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });
});
