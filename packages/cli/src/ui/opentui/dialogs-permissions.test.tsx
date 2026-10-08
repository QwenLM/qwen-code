/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI /permissions dialog: the rule rows are config-supplied, so every
 * run a window charges as one physical row is sanitized and clipped to it.
 * The native renderer is faked the same way as dialogs-arena.test.tsx:
 * box/text render as div/span.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    width: 100,
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

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
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
    useTerminalDimensions: () => ({ width: mocks.state.width, height: 40 }),
  };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

import { act } from 'react';
import { OpenTuiPermissionsDialog } from './dialogs-permissions.js';
import type { PermissionRuleEntry } from './dialogs-permissions.js';
import { getCachedStringWidth } from '../utils/textUtils.js';

function press(name: string) {
  act(() => {
    for (const handler of [...mocks.state.keyboardHandlers]) {
      handler({ name, sequence: name });
    }
  });
}

function renderPermissions(
  rules: PermissionRuleEntry[],
  availableTerminalHeight?: number,
) {
  return render(
    <OpenTuiPermissionsDialog
      rules={rules}
      directories={[]}
      initialDirectories={[]}
      onAddRule={vi.fn()}
      onDeleteRule={vi.fn()}
      onAddDirectory={vi.fn()}
      onRemoveDirectory={vi.fn()}
      onExit={vi.fn()}
      availableTerminalHeight={availableTerminalHeight}
    />,
  );
}

describe('OpenTuiPermissionsDialog rule rows', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.width = 100;
  });

  it('clips the add-rule scope row to the framed width, so it cannot wrap', () => {
    // The scope step paints inside the DialogFrame — border and padding take
    // four columns of the area width first — but the label clip was budgeted
    // from the bare-region width: at 62 columns the 52-column scope label
    // fit the stale budget, wrapped onto a second physical row the window
    // charged as one, and the frame grew past the region.
    mocks.state.width = 62;
    renderPermissions([], 22);
    press('return'); // rule list → add-rule-input ('Add a new rule…' on top)
    for (const ch of ['B', 'a', 's', 'h']) press(ch);
    press('return'); // → add-rule-scope

    const row = screen.getByText(/Project settings/);
    // 58 area columns, less the frame (4), the marker box (2) and the number
    // box (3), leave the label 49; the clip cuts without an ellipsis.
    expect(getCachedStringWidth(row.textContent ?? '')).toBeLessThanOrEqual(49);
    expect(row.textContent ?? '').not.toContain('.json');
    expect(screen.getByText(/Enter to confirm/)).toBeTruthy();
  });

  it('flattens a newline inside a rule row into the one row it is charged', () => {
    // Rule text is settings-file content: a surviving newline measures zero
    // columns in the clip budget but paints a second physical row the window
    // never paid for. Read the raw text content — testing-library's default
    // normalizer collapses the newline to a space either way.
    const { container } = renderPermissions([
      {
        raw: 'Bash(evil\n> spoof)',
        toolName: 'Bash',
        type: 'allow',
        scope: 'project',
      },
    ]);
    const painted = container.textContent ?? '';
    expect(painted.includes('evil\n>')).toBe(false);
    expect(painted.includes('evil > spoof')).toBe(true);
  });

  it('flattens a newline inside a workspace directory row', () => {
    const { container } = render(
      <OpenTuiPermissionsDialog
        rules={[]}
        directories={[]}
        initialDirectories={['/repo\n> spoofed']}
        onAddRule={vi.fn()}
        onDeleteRule={vi.fn()}
        onAddDirectory={vi.fn()}
        onRemoveDirectory={vi.fn()}
        onExit={vi.fn()}
      />,
    );
    // The workspace tab is the fourth: three Tabs cycle to it.
    press('tab');
    press('tab');
    press('tab');
    expect(screen.getByText('Workspace')).toBeTruthy();
    const painted = container.textContent ?? '';
    expect(painted.includes('repo\n')).toBe(false);
    expect(painted.includes('/repo > spoofed')).toBe(true);
  });
});
