/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component wiring tests for the OpenTUI /extensions dialog management keys
 * (audit 01 G-4 / 05 G-12). The native renderer (Bun/FFI) is exercised by
 * the PTY gate; here the OpenTUI hooks/jsx runtime are faked (same harness
 * family as dialogs-auth.test.tsx — with a mount-stable useKeyboard so the
 * dialog's several parallel keyboard consumers can be driven at once) and
 * the tests verify the footer-promised keys end-to-end through the dialog
 * state machine:
 *
 *  - Installed list: ↑↓ navigate, Space toggle, f favorite, Enter details;
 *  - detail view: action list, scope select, y/n uninstall confirm,
 *    mark-update surfacing "Update Now";
 *  - Esc walks back one level (detail → list → close);
 *  - Discover/Sources degrade honestly (no fake keys, no fake loading).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
  };
  // Shared fake jsx runtime (box→div, text→span); built inside hoisted so
  // neither mock factory needs an internal-module import.
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

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
    // Mount-stable registration: the wrapper is registered once per consumer
    // and always invokes the latest handler closure — the real renderer's
    // semantics — so a key event can be broadcast to every mounted consumer.
    useKeyboard: (handler: (key: unknown) => void) => {
      const ref = React.useRef(handler);
      ref.current = handler;
      React.useEffect(() => {
        const fn = (key: unknown) => ref.current(key);
        mocks.state.keyboardHandlers.push(fn);
        return () => {
          const index = mocks.state.keyboardHandlers.indexOf(fn);
          if (index >= 0) mocks.state.keyboardHandlers.splice(index, 1);
        };
      }, []);
    },
    useRenderer: () => ({
      addInputHandler: () => {},
      removeInputHandler: () => {},
    }),
  };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());

vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));

import {
  EXTENSIONS_TAB_ORDER,
  EXTENSIONS_TABS,
  extensionsFooterHint,
  extensionsStatusColor,
  extensionsTabLabel,
  OpenTuiExtensionsDialog,
  type ExtensionRow,
} from './dialogs-extensions.js';
import { C } from './theme.js';

describe('extensions tabs (shell parity)', () => {
  it('keeps the original tab ids and order', () => {
    expect(EXTENSIONS_TABS).toEqual({
      INSTALLED: 'installed',
      DISCOVER: 'discover',
      SOURCES: 'sources',
    });
    expect([...EXTENSIONS_TAB_ORDER]).toEqual([
      'installed',
      'discover',
      'sources',
    ]);
  });

  it('labels tabs like the original TabBar', () => {
    expect(extensionsTabLabel('installed')).toBe('Installed');
    expect(extensionsTabLabel('discover')).toBe('Discover');
    expect(extensionsTabLabel('sources')).toBe('Sources');
  });

  it('keeps the original Installed hint; Discover/Sources get an honest one', () => {
    expect(extensionsFooterHint('installed')).toBe(
      '↑↓ navigate · Space enable/disable · f favorite · Enter details · Esc close',
    );
    // The ink hints promise keys this renderer does not implement; repeating
    // them would be a lie, so the degraded tabs say what they actually do.
    expect(extensionsFooterHint('discover')).toBe(
      'Tab / ←→ to switch · Esc to close',
    );
    expect(extensionsFooterHint('sources')).toBe(
      'Tab / ←→ to switch · Esc to close',
    );
  });

  it('maps status types onto the shared palette', () => {
    expect(extensionsStatusColor({ type: 'error', text: '' })).toBe(C.red);
    expect(extensionsStatusColor({ type: 'warning', text: '' })).toBe(C.yellow);
    expect(extensionsStatusColor({ type: 'success', text: '' })).toBe(C.green);
    expect(extensionsStatusColor({ type: 'info', text: '' })).toBe(C.dim);
  });
});

function baseKeyEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'a',
    sequence: 'a',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    hyper: false,
    eventType: 'press',
    preventDefault: () => {},
    stopPropagation: () => {},
    ...overrides,
  };
}

// The real renderer dispatches one key event synchronously to every
// consumer: each handler sees the state as of the event, not the state the
// previous handler just produced. A single act keeps that semantics —
// flushing between handlers would let a later consumer react to a view
// transition the same event already caused.
async function broadcast(key: Record<string, unknown>): Promise<void> {
  await act(async () => {
    for (const handler of [...mocks.state.keyboardHandlers]) {
      handler(baseKeyEvent(key));
    }
  });
}

async function press(name: string, sequence?: string): Promise<void> {
  await broadcast({ name, sequence: sequence ?? name });
}

const ROWS: ExtensionRow[] = [
  {
    key: 'ext-a',
    label: 'ext-a',
    meta: '/x/a',
    enabled: true,
    favorite: true,
    scope: 'user',
    version: '1.0.0',
    components: '2 MCP',
  },
  {
    key: 'ext-b',
    label: 'ext-b',
    meta: '/x/b',
    enabled: false,
    scope: 'project',
  },
];

function renderDialog(overrides?: {
  rows?: ExtensionRow[];
  busy?: boolean;
  onDetailAction?: ReturnType<typeof vi.fn>;
}) {
  const onClose = vi.fn();
  const onRowAction = vi.fn();
  const onDetailAction = overrides?.onDetailAction ?? vi.fn();
  render(
    <OpenTuiExtensionsDialog
      onClose={onClose}
      rowsByTab={{ [EXTENSIONS_TABS.INSTALLED]: overrides?.rows ?? ROWS }}
      onRowAction={onRowAction}
      onDetailAction={onDetailAction}
      busy={overrides?.busy}
    />,
  );
  return { onClose, onRowAction, onDetailAction };
}

describe('OpenTuiExtensionsDialog management keys (#44)', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
  });

  it('renders the installed rows with their status', () => {
    renderDialog();
    expect(screen.getByText('ext-a')).toBeTruthy();
    expect(screen.getByText('ext-b')).toBeTruthy();
    expect(screen.getByText(/active/)).toBeTruthy();
    expect(screen.getByText(/disabled/)).toBeTruthy();
  });

  it('Space toggles the highlighted row and f favorites it', async () => {
    const { onRowAction } = renderDialog();
    await press('space', ' ');
    expect(onRowAction).toHaveBeenCalledWith(ROWS[0], 'toggle');
    await press('f', 'f');
    expect(onRowAction).toHaveBeenCalledWith(ROWS[0], 'favorite');
  });

  it('ignores Space/f while a mutation is in flight', async () => {
    const { onRowAction } = renderDialog({ busy: true });
    await press('space', ' ');
    await press('f', 'f');
    expect(onRowAction).not.toHaveBeenCalled();
  });

  it('↑↓ moves the highlight and Space acts on the new row', async () => {
    const { onRowAction } = renderDialog();
    await press('down');
    await press('space', ' ');
    expect(onRowAction).toHaveBeenCalledWith(ROWS[1], 'toggle');
    await press('up');
    await press('space', ' ');
    expect(onRowAction).toHaveBeenLastCalledWith(ROWS[0], 'toggle');
  });

  it('Enter opens the detail view with the info panel and actions', async () => {
    renderDialog();
    await press('return');
    expect(screen.getByText('ext-a')).toBeTruthy();
    expect(screen.getByText('1.0.0')).toBeTruthy();
    expect(screen.getByText('Disable')).toBeTruthy();
    // ext-a is a favorite already, so the action reads "Remove".
    expect(screen.getByText('Remove from Favorites')).toBeTruthy();
    expect(screen.getByText('Change scope')).toBeTruthy();
    expect(screen.getByText('Mark for Update')).toBeTruthy();
    expect(screen.getByText('Uninstall')).toBeTruthy();
  });

  it('detail Enter runs the highlighted action; Esc walks back to list then closes', async () => {
    const { onDetailAction, onClose } = renderDialog();
    await press('return'); // list → detail
    await press('return'); // detail: Disable (highlighted)
    expect(onDetailAction).toHaveBeenCalledWith(ROWS[0], 'toggle');
    await press('escape'); // detail → list
    await press('escape'); // list → close
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('scope select runs change-scope with the chosen scope', async () => {
    const { onDetailAction } = renderDialog();
    await press('return'); // → detail
    await press('down'); // favorite
    await press('down'); // change-scope
    await press('return'); // → scope-select
    expect(screen.getByText('Global (User Scope)')).toBeTruthy();
    expect(screen.getByText('Project (Workspace)')).toBeTruthy();
    await press('return'); // select user (highlighted)
    expect(onDetailAction).toHaveBeenCalledWith(
      ROWS[0],
      'change-scope',
      'user',
    );
  });

  it('uninstall confirm: y executes, n backs out to the detail', async () => {
    const { onDetailAction } = renderDialog();
    await press('return'); // → detail
    await press('down'); // favorite
    await press('down'); // change-scope
    await press('down'); // mark-update
    await press('down'); // uninstall
    await press('return'); // → uninstall-confirm
    expect(screen.getByText(/Are you sure you want to uninstall/)).toBeTruthy();
    await press('n', 'n'); // back to detail (cursor re-syncs to 0 via resyncKey)
    // Backing out must not uninstall.
    expect(onDetailAction).not.toHaveBeenCalledWith(ROWS[0], 'uninstall');
    // Re-navigate to uninstall (cursor reset by resyncKey on view change).
    await press('down'); // favorite
    await press('down'); // change-scope
    await press('down'); // mark-update
    await press('down'); // uninstall
    await press('return'); // re-enter confirm
    await press('y', 'y'); // confirm
    expect(onDetailAction).toHaveBeenCalledWith(ROWS[0], 'uninstall');
  });

  it('mark-update surfaces Update Now when an update is available', async () => {
    const onDetailAction = vi.fn().mockResolvedValue('update-available');
    renderDialog({ onDetailAction });
    await press('return'); // → detail
    await press('down'); // favorite
    await press('down'); // change-scope
    await press('down'); // mark-update
    await press('return'); // run check
    expect(onDetailAction).toHaveBeenCalledWith(ROWS[0], 'mark-update');
    // The async state lands after the promise resolves; flush it.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Update Now')).toBeTruthy();
  });

  it('falls back to the list when the open row disappears after a reload', async () => {
    const { rerender } = render(<div />);
    const onClose = vi.fn();
    const onRowAction = vi.fn();
    rerender(
      <OpenTuiExtensionsDialog
        onClose={onClose}
        rowsByTab={{ [EXTENSIONS_TABS.INSTALLED]: ROWS }}
        onRowAction={onRowAction}
      />,
    );
    await press('return'); // → detail on ext-a
    // Reload removes every row (e.g. uninstall): the view falls back.
    rerender(
      <OpenTuiExtensionsDialog
        onClose={onClose}
        rowsByTab={{ [EXTENSIONS_TABS.INSTALLED]: [] }}
        onRowAction={onRowAction}
      />,
    );
    expect(screen.getByText('No extensions installed.')).toBeTruthy();
  });

  it('Discover/Sources degrade honestly (no fake footer hints)', async () => {
    renderDialog();
    await press('tab');
    expect(
      screen.getByText(
        'Discover is not yet available in the OpenTUI renderer.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Tab \/ ←→ to switch · Esc to close/)).toBeTruthy();
    await press('tab');
    expect(
      screen.getByText(
        'Marketplace sources are not yet available in the OpenTUI renderer.',
      ),
    ).toBeTruthy();
  });
});
