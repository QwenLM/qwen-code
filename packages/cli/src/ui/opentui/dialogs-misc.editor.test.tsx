/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Editor dialog geometry (ink EditorSettingsDialog parity): the shared list
 * primitive's number column, the absent chrome title row, and the bottom hint
 * clipped to the left column's own width the way ink's `wrap="truncate"` clips
 * it. The dialog used to hand-roll its rows, drop the numbers, print a title
 * ink does not have, and wrap the hint onto a second row.
 */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    width: 100,
    editors: [
      { name: 'None', type: 'not_set', disabled: false },
      { name: 'Cursor (Not installed)', type: 'cursor', disabled: true },
      { name: 'Vim', type: 'vim', disabled: false },
    ],
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
    useKeyboard: (handler: (key: unknown) => void) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      const stable = React.useRef<((key: unknown) => void) | undefined>(
        undefined,
      );
      if (!stable.current) {
        stable.current = (key: unknown) => latest.current(key);
        mocks.state.keyboardHandlers.push(stable.current);
      }
    },
    useTerminalDimensions: () => ({
      width: mocks.state.width,
      height: 40,
    }),
    useRenderer: () => ({
      addInputHandler: () => undefined,
      removeInputHandler: () => undefined,
    }),
  };
});
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));
// The select handler re-checks the pick against the machine before persisting;
// nothing is detectable in the test runtime, so let every editor through.
vi.mock('@qwen-code/qwen-code-core/utils/editor.js', () => ({
  allowEditorTypeInSandbox: () => true,
  checkHasEditorType: () => true,
  isEditorAvailable: () => true,
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: { name?: string; shift?: boolean }) => ({
    name: key.name ?? '',
    shift: key.shift ?? false,
  }),
}));
// The real manager probes the machine for installed editors at module scope,
// which would make the row set depend on the developer's own shell.
vi.mock('../editors/editorSettingsManager.js', () => ({
  EDITOR_DISPLAY_NAMES: { vim: 'Vim', cursor: 'Cursor' },
  editorSettingsManager: {
    getAvailableEditorDisplays: () => mocks.state.editors,
  },
}));

import { OpenTuiEditorDialog } from './dialogs-misc.js';

function press(name: string, shift = false) {
  if (mocks.state.keyboardHandlers.length === 0) {
    throw new Error('no keyboard handler registered');
  }
  act(() => {
    for (const handler of [...mocks.state.keyboardHandlers]) {
      handler({ name, shift });
    }
  });
}

/** A list row's text: marker, then the number column, then the label. */
function rowText(labelPrefix: string): string {
  // The right pane also renders the resolved editor name, so only accept the
  // span that sits in a marker + number + label row.
  const rows = screen
    .getAllByText((content) => content.startsWith(labelPrefix))
    .map((el) => (el.parentElement?.parentElement?.textContent ?? '').trim())
    .filter((row) => /^›?\d+\./.test(row));
  if (rows.length !== 1) {
    throw new Error(
      `expected one row for "${labelPrefix}", got ${rows.length}`,
    );
  }
  return rows[0];
}

function renderDialog(options: { setValue?: ReturnType<typeof vi.fn> } = {}) {
  const setValue = options.setValue ?? vi.fn();
  const onClose = vi.fn();
  const notify = vi.fn();
  const settings = {
    isTrusted: true,
    merged: { general: {} },
    forScope: () => ({ settings: { general: {} } }),
    setValue,
  } as unknown as LoadedSettings;
  render(
    <OpenTuiEditorDialog
      settings={settings}
      onClose={onClose}
      notify={notify}
    />,
  );
  return { setValue, onClose, notify };
}

beforeEach(() => {
  mocks.state.keyboardHandlers.length = 0;
  mocks.state.width = 100;
});

describe('OpenTuiEditorDialog', () => {
  it('numbers the editor rows and marks the cursor, as ink radio rows do', () => {
    renderDialog();
    expect(rowText('None')).toBe('›1.None');
    expect(rowText('Cursor (Not installed)')).toBe('2.Cursor (Not installed)');
    expect(rowText('Vim')).toBe('3.Vim');
  });

  it('draws no chrome title row of its own', () => {
    renderDialog();
    expect(screen.queryByText('Editor')).toBeNull();
  });

  it('clips the hint to the left column with a single ellipsis', () => {
    renderDialog();
    // 100 columns -> a 92-column content box -> a 41-column left column, two
    // of which are its own padding: the same 39 ink measured on a real frame.
    const hint = screen.getByText(/^\(Use Enter to select/)
      .textContent as string;
    expect(hint).toBe('(Use Enter to select, Tab to configure…');
    expect(hint).toHaveLength(39);
  });

  it('numbers the scope rows too, under the Apply To heading', () => {
    renderDialog();
    press('tab');
    expect(screen.getByText('> Apply To')).toBeTruthy();
    expect(rowText('User Settings')).toBe('›1.User Settings');
    expect(rowText('Workspace Settings')).toBe('2.Workspace Settings');
    const hint = screen.getByText(/^\(Use Enter to apply scope/)
      .textContent as string;
    expect(hint).not.toContain('back)');
    expect(hint.endsWith('…')).toBe(true);
    expect(hint).toHaveLength(39);
  });

  it('persists the highlighted editor into the chosen scope', () => {
    const { setValue, onClose } = renderDialog();
    press('down');
    press('return');
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.preferredEditor',
      'vim',
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('steps over the disabled row instead of landing on it', () => {
    renderDialog();
    press('down');
    expect(rowText('Vim')).toBe('›3.Vim');
    expect(rowText('Cursor (Not installed)')).toBe('2.Cursor (Not installed)');
  });

  it('reports a failed write and keeps the dialog open', () => {
    const setValue = vi.fn(() => {
      throw new Error('read-only file system');
    });
    const { onClose, notify } = renderDialog({ setValue });
    press('down');
    press('return');
    expect(
      screen.getByText(/Failed to set editor preference/).textContent,
    ).toBe('Failed to set editor preference: Error: read-only file system');
    expect(notify).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
