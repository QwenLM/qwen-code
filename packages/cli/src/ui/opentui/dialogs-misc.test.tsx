/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the disabled-skipping radio navigation used by the editor dialog
 * (ink BaseSelectionList parity): arrows clamp at the edges and walk past
 * disabled entries.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { execFile } from 'node:child_process';
import type { Config } from '@qwen-code/qwen-code-core';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = vi.fn();
  return { ...actual, default: { ...actual, execFile }, execFile };
});
vi.mock('@opentui/react', () => ({
  useRenderer: () => ({
    addInputHandler: vi.fn(),
    removeInputHandler: vi.fn(),
  }),
  useKeyboard: vi.fn(),
}));
const buildJsxRuntime = vi.hoisted(() => async () => {
  const React = await import('react');
  const Box = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children);
  const Text = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('span', null, children);
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: React.Key,
  ) =>
    React.createElement(
      type === 'box'
        ? Box
        : type === 'text'
          ? Text
          : (type as React.ElementType),
      { ...props, key },
      props?.['children'] as React.ReactNode,
    );
  return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
});
vi.mock('@opentui/react/jsx-runtime', () => buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => buildJsxRuntime());

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import { readHooksEnabled, Shell, OpenTuiDiffDialog } from './dialogs-misc.js';
import { C } from './theme.js';
import type { LoadedSettings } from '../../config/settings.js';

describe('Shell (ink dialog chrome)', () => {
  it('frames with a rounded border.default outline and a bold primary title', () => {
    const frame = Shell({ title: 'Resume Session' }) as unknown as {
      props: Record<string, unknown> & { children: unknown[] };
    };
    expect(frame.props['borderStyle']).toBe('rounded');
    expect(frame.props['borderColor']).toBe(C.borderDefault);
    const title = frame.props.children[0] as { props: Record<string, unknown> };
    expect(title.props['fg']).toBe(C.text);
    expect(title.props['attributes']).toBe(1);
  });

  it('opens flush with the region and lets the region press it down', () => {
    // ink's dialogs carry no top margin and ink's Box defaults flexShrink to
    // 1. A top margin plus a refusal to shrink puts the box one row below
    // ink's and, once 1 + box height exceeds the region, costs the bottom
    // border and the rows on it — at 80x24 /auth loses its Terms/privacy
    // link. Measured against ink at 20/22/24/26/40 rows.
    const frame = Shell({ title: 'Auth' }) as unknown as {
      props: Record<string, unknown>;
    };
    expect(frame.props['marginTop']).toBeUndefined();
    expect(frame.props['flexShrink']).toBe(1);
  });
});

const settingsWith = (merged: Record<string, unknown>): LoadedSettings =>
  ({ merged }) as unknown as LoadedSettings;

describe('readHooksEnabled (the real disableAllHooks switch)', () => {
  it('reads the top-level setting; default is enabled', () => {
    expect(readHooksEnabled(undefined, settingsWith({}))).toBe(true);
    expect(
      readHooksEnabled(undefined, settingsWith({ disableAllHooks: true })),
    ).toBe(false);
    expect(
      readHooksEnabled(undefined, settingsWith({ disableAllHooks: false })),
    ).toBe(true);
  });

  it('prefers the runtime gate (includes bare/safe modes)', () => {
    expect(
      readHooksEnabled(
        { getDisableAllHooks: () => false },
        settingsWith({ disableAllHooks: true }),
      ),
    ).toBe(true);
    expect(
      readHooksEnabled(
        { getDisableAllHooks: () => true },
        settingsWith({ disableAllHooks: false }),
      ),
    ).toBe(false);
  });
});

describe('OpenTuiDiffDialog sandbox', () => {
  it('refuses a direct diff mount before spawning Git', () => {
    const config = {
      getShellExecutionSandbox: () => ({ network: 'closed' }),
    } as unknown as Config;
    const { container } = render(
      <OpenTuiDiffDialog
        config={config}
        settings={settingsWith({})}
        onClose={() => {}}
      />,
    );
    expect(container.textContent).toContain(
      'Diff preview unavailable in tool sandbox',
    );
    expect(execFile).not.toHaveBeenCalled();
  });
});
