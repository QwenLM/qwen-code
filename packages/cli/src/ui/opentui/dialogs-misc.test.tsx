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
  ) => {
    if (type === 'scrollbox') {
      // Keep the sizing primitives as an attribute so the windowing tests can
      // read the height the real renderer would receive.
      const captured = JSON.stringify(
        Object.fromEntries(
          Object.entries(props ?? {}).filter(
            ([k, v]) =>
              k !== 'children' &&
              (typeof v === 'string' ||
                typeof v === 'number' ||
                typeof v === 'boolean'),
          ),
        ),
      );
      return React.createElement(
        'div',
        { ...(key === undefined ? {} : { key }), 'data-scrollbox': captured },
        props?.['children'] as React.ReactNode,
      );
    }
    return React.createElement(
      type === 'box'
        ? Box
        : type === 'text'
          ? Text
          : (type as React.ElementType),
      { ...props, key },
      props?.['children'] as React.ReactNode,
    );
  };
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

import {
  readHooksEnabled,
  Shell,
  OpenTuiDiffDialog,
  OpenTuiSubagentListDialog,
} from './dialogs-misc.js';
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

  it('opens flush with the region and stays unshrinkable for the clip', () => {
    // The rule the sibling frames (arena, memory, statusline, stats/skills)
    // already follow, measured on the real renderer: a shrinkable frame lets
    // a short region take the deficit out of the body's only unsized child,
    // dropping text rows from the middle of the body while the keys keep
    // committing them; an unshrinkable frame keeps its rows contiguous and
    // lets the region's clip cut the tail. The clip cuts child text but not
    // the frame's own border strokes, so the sized bodies (/diff, /subagents)
    // window their height from the region budget instead of relying on it.
    const frame = Shell({ title: 'Auth' }) as unknown as {
      props: Record<string, unknown>;
    };
    expect(frame.props['marginTop']).toBeUndefined();
    expect(frame.props['flexShrink']).toBe(0);
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

/** The scrollbox's declared geometry, captured by the jsx mock. */
function scrollboxOf(container: HTMLElement): Record<string, unknown> {
  const node = container.querySelector('[data-scrollbox]');
  expect(node, 'no scrollbox rendered').not.toBeNull();
  return JSON.parse(node!.getAttribute('data-scrollbox') ?? '{}') as Record<
    string,
    unknown
  >;
}

describe('sized bodies window from the region budget', () => {
  // The Shell frame pays six rows above a sized body (border and padding 4,
  // title 1, the body's margin 1), so the body's cap is the region minus six:
  // the unshrinkable frame's natural height then never exceeds the region,
  // and its title row and bottom border both survive at the boundary.
  it('windows the /diff scrollbox so the frame fits a seventeen-row region', () => {
    const config = {
      getShellExecutionSandbox: () => undefined,
    } as unknown as Config;
    const { container } = render(
      <OpenTuiDiffDialog
        config={config}
        settings={settingsWith({})}
        onClose={() => {}}
        availableTerminalHeight={17}
      />,
    );
    expect(scrollboxOf(container)).toMatchObject({ height: 11, marginTop: 1 });
  });

  it('keeps the /diff body at its natural height while the region pays for it', () => {
    const config = {
      getShellExecutionSandbox: () => undefined,
    } as unknown as Config;
    const { container } = render(
      <OpenTuiDiffDialog
        config={config}
        settings={settingsWith({})}
        onClose={() => {}}
        availableTerminalHeight={40}
      />,
    );
    expect(scrollboxOf(container)['height']).toBe(14);
  });

  it('windows the /subagents scrollbox the same way', () => {
    const { container } = render(
      <OpenTuiSubagentListDialog
        settings={settingsWith({})}
        onClose={() => {}}
        availableTerminalHeight={15}
      />,
    );
    expect(scrollboxOf(container)).toMatchObject({ height: 9, marginTop: 1 });
  });
});
