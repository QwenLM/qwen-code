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
