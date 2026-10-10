/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Burst safety of the two free-text fields in `/permissions`. The renderer
 * hands every key of one stdin read to the handler the last render registered,
 * so a pasted path followed by Enter used to submit the buffer as it stood
 * before the paste — i.e. nothing — and the dialog stayed put.
 */

import { act, render, screen } from '@testing-library/react';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingScope } from '../../config/settings.js';

interface RawKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  super?: boolean;
  shift?: boolean;
  paste?: boolean;
}

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: RawKey) => void>,
    width: 100,
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        // Keep the layout primitives as an attribute so a frame's declared
        // geometry is readable without booting the native renderer.
        const captured = JSON.stringify(
          Object.fromEntries(
            Object.entries(config ?? {}).filter(
              ([k, v]) =>
                k !== 'children' &&
                (typeof v === 'string' ||
                  typeof v === 'number' ||
                  typeof v === 'boolean'),
            ),
          ),
        );
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          {
            ...(key === undefined ? {} : { key }),
            'data-p': captured,
          },
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
    useKeyboard: (handler: (key: RawKey) => void) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      const stable = React.useRef<((key: RawKey) => void) | undefined>(
        undefined,
      );
      if (!stable.current) {
        stable.current = (key: RawKey) => latest.current(key);
        mocks.state.keyboardHandlers.push(stable.current);
      }
    },
    useTerminalDimensions: () => ({ width: mocks.state.width, height: 40 }),
  };
});
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: RawKey) => ({
    name: key.name ?? '',
    ctrl: !!key.ctrl,
    meta: !!(key.meta || key.option || key.super),
    shift: !!key.shift,
    paste: !!key.paste,
    sequence: key.sequence ?? '',
  }),
}));

import { OpenTuiPermissionsDialog } from './dialogs-permissions.js';
import { getCachedStringWidth } from '../utils/textUtils.js';

/** The layout primitives the jsx mock captured on the element. */
function layoutOf(node: Element | null): Record<string, unknown> {
  return JSON.parse(node?.getAttribute('data-p') ?? '{}') as Record<
    string,
    unknown
  >;
}

/** One stdin read: every key hits the same handler closure, no render between. */
function burst(keys: RawKey[]) {
  if (mocks.state.keyboardHandlers.length === 0) {
    throw new Error('no keyboard handler registered');
  }
  act(() => {
    for (const key of keys) {
      for (const handler of [...mocks.state.keyboardHandlers]) {
        handler({ ...key });
      }
    }
  });
}

/** One key per stdin read, which is what a slow typist produces. */
function press(key: RawKey) {
  burst([key]);
}

function text(char: string): RawKey {
  return { name: char, sequence: char };
}

const ENTER: RawKey = { name: 'return', sequence: '\r' };
const TAB: RawKey = { name: 'tab', sequence: '\t' };

function renderDialog() {
  const onAddRule = vi.fn();
  const onAddDirectory = vi.fn();
  render(
    <OpenTuiPermissionsDialog
      rules={[]}
      directories={[]}
      initialDirectories={[]}
      onAddRule={onAddRule}
      onDeleteRule={vi.fn()}
      onAddDirectory={onAddDirectory}
      onRemoveDirectory={vi.fn()}
      onExit={vi.fn()}
    />,
  );
  return { onAddRule, onAddDirectory };
}

/** Open the rule form on the Allow tab: 'Add a new rule…' is the first row. */
function openRuleInput() {
  press(ENTER);
  expect(screen.getByText('Enter permission rule…')).toBeTruthy();
}

/** Open the directory form: Workspace is the fourth tab, its first row adds. */
function openDirInput() {
  press(TAB);
  press(TAB);
  press(TAB);
  press(ENTER);
  expect(screen.getByText('Enter directory path…')).toBeTruthy();
}

beforeEach(() => {
  mocks.state.keyboardHandlers.length = 0;
  mocks.state.width = 100;
  document.body.innerHTML = '';
});

describe('OpenTuiPermissionsDialog region budget', () => {
  it('windows the rule list to the region, so Enter only commits a painted row', () => {
    // Region nineteen pays the rule view's chrome — tab bar 1, description
    // and margin 2, search box and margin 4, spacer 1, footer hint 2 — and
    // leaves the list nine rows, not the constant fifteen whose tail the
    // region's clip took while the keys kept committing the clipped rows.
    const rules = Array.from({ length: 20 }, (_, i) => ({
      raw: `WebFetch(domain-${i}.example.com)`,
      toolName: 'WebFetch',
      type: 'allow' as const,
      scope: 'user',
    }));
    render(
      <OpenTuiPermissionsDialog
        rules={rules}
        directories={[]}
        initialDirectories={[]}
        onAddRule={vi.fn()}
        onDeleteRule={vi.fn()}
        onAddDirectory={vi.fn()}
        onRemoveDirectory={vi.fn()}
        onExit={vi.fn()}
        availableTerminalHeight={19}
      />,
    );

    // The window is the nine rows the region pays for: 'Add a new rule…'
    // plus the first eight rules; the ninth rule does not paint.
    expect(screen.getByText('WebFetch(domain-7.example.com)')).toBeTruthy();
    expect(screen.queryByText('WebFetch(domain-8.example.com)')).toBeNull();

    // Eight downs land on the window's last painted row, and Enter commits
    // exactly that rule's confirmation.
    for (let i = 0; i < 8; i++) press({ name: 'down' });
    press(ENTER);
    expect(screen.getByText('Delete allow rule?')).toBeTruthy();
    expect(
      screen.getAllByText('WebFetch(domain-7.example.com)').length,
    ).toBeGreaterThan(0);
  });
});

describe('OpenTuiPermissionsDialog charged runs', () => {
  it('lays the search box out as the one content row the chrome charge pays for', () => {
    // The budget charges the search box four rows — margin, two borders, one
    // content row. Stacked, its two texts would paint five rows, and the rule
    // list's last windowed row would be one the region never paid for.
    renderDialog();
    const placeholder = screen.getByText('Search…');
    expect(layoutOf(placeholder.parentElement)).toMatchObject({
      flexDirection: 'row',
      borderStyle: 'rounded',
    });
  });

  it('charges the workspace description the rows it wraps into', () => {
    // The workspace tab's description is 87 columns — two rows at 80 — and
    // the flat one-row charge used to hand the directory list a row the
    // region never paid for: the window is one row smaller now.
    mocks.state.width = 80;
    const dirs = Array.from({ length: 10 }, (_, i) => `/ws/dir-${i}`);
    render(
      <OpenTuiPermissionsDialog
        rules={[]}
        directories={dirs.slice(2)}
        initialDirectories={dirs.slice(0, 2)}
        onAddRule={vi.fn()}
        onDeleteRule={vi.fn()}
        onAddDirectory={vi.fn()}
        onRemoveDirectory={vi.fn()}
        onExit={vi.fn()}
        availableTerminalHeight={15}
      />,
    );
    press(TAB);
    press(TAB);
    press(TAB);

    // 15 - 4 chrome - 2 description rows - 2 initial-directory rows = 7:
    // 'Add directory…' plus six directories paint, the seventh does not.
    expect(screen.getByText('/ws/dir-7')).toBeTruthy();
    expect(screen.queryByText('/ws/dir-8')).toBeNull();
  });

  it('clips a rule row to the width the window charges for it', () => {
    // A rule raw wider than the row wraps into a second physical row the
    // window charged as one; ink truncates the label, and so does the port.
    mocks.state.width = 80;
    const longRule = `WebFetch(domain:${'a'.repeat(70)})`;
    render(
      <OpenTuiPermissionsDialog
        rules={[
          {
            raw: longRule,
            toolName: 'WebFetch',
            type: 'allow' as const,
            scope: 'user',
          },
        ]}
        directories={[]}
        initialDirectories={[]}
        onAddRule={vi.fn()}
        onDeleteRule={vi.fn()}
        onAddDirectory={vi.fn()}
        onRemoveDirectory={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const row = screen.getByText(/^WebFetch\(domain:/);
    // Area width 76, minus the `›` box (2) and the one-digit number box (3).
    expect(getCachedStringWidth(row.textContent ?? '')).toBeLessThanOrEqual(71);
    expect(row.textContent).toMatch(/…$/);
  });
});

describe('OpenTuiPermissionsDialog text-field bursts', () => {
  it('submits the rule a burst typed in, not the empty buffer it started from', () => {
    const { onAddRule } = renderDialog();
    openRuleInput();

    burst([...'WebFetch'.split('').map(text), ENTER]);

    expect(screen.queryByText('Enter permission rule…')).toBeNull();
    expect(screen.getByText('Where should this rule be saved?')).toBeTruthy();
    // The scope step then reports the whole burst as the rule text.
    press(ENTER);
    expect(onAddRule).toHaveBeenCalledWith(
      'WebFetch',
      'allow',
      SettingScope.Workspace,
    );
  });

  it('edits inside a burst: a trailing character and its backspace cancel out', () => {
    const { onAddRule } = renderDialog();
    openRuleInput();

    burst([...'WebFetchx'.split('').map(text), { name: 'backspace' }, ENTER]);

    expect(screen.getByText('Where should this rule be saved?')).toBeTruthy();
    press(ENTER);
    expect(onAddRule).toHaveBeenCalledWith(
      'WebFetch',
      'allow',
      SettingScope.Workspace,
    );
  });

  it('validates the whole pasted path, not the empty buffer', () => {
    const { onAddDirectory } = renderDialog();
    openDirInput();

    burst([text('.'), ENTER]);

    expect(onAddDirectory).toHaveBeenCalledTimes(1);
    expect(onAddDirectory).toHaveBeenCalledWith(
      fs.realpathSync(nodePath.resolve('.')),
    );
    expect(screen.queryByText('Enter directory path…')).toBeNull();
  });
});
