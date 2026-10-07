/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render-side tests for the OpenTUI /mcp dialog (dialogs-mcp.test.ts holds
 * the pure helpers). The native renderer is faked the same way as
 * dialogs-hooks.test.tsx — box/text render as div/span, keyboard handlers are
 * captured and driven directly — with the rows' mouse handlers carried onto
 * the DOM elements so hover and click can be fired.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
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
        const { onMouseOver, onMouseUp } = (config ?? {}) as Record<
          string,
          unknown
        >;
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          {
            ...(key === undefined ? null : { key }),
            ...(onMouseOver ? { onMouseOver } : null),
            ...(onMouseUp ? { onMouseUp } : null),
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
    useRenderer: () => ({
      addInputHandler: () => {},
      removeInputHandler: () => {},
    }),
    useTerminalDimensions: () => ({ width: 100, height: 40 }),
  };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));

import { MCPServerStatus } from '@qwen-code/qwen-code-core/tools/mcp-status.js';
import {
  OpenTuiMcpDialog,
  type McpResourceInfo,
  type McpServerInfo,
  type McpToolInfo,
} from './dialogs-mcp.js';

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

async function press(name: string): Promise<void> {
  await act(async () => {
    for (const handler of [...mocks.state.keyboardHandlers]) {
      handler(baseKeyEvent({ name, sequence: name }));
    }
  });
}

function serverWith(overrides: Partial<McpServerInfo>): McpServerInfo {
  return {
    name: 'srv',
    status: MCPServerStatus.CONNECTED,
    source: 'user',
    toolCount: 0,
    invalidToolCount: 0,
    promptCount: 0,
    resourceCount: 0,
    isDisabled: false,
    hasOAuthTokens: false,
    requiresAuth: false,
    ...overrides,
  };
}

const twelveTools: McpToolInfo[] = Array.from({ length: 12 }, (_, i) => ({
  name: `tool_${i}`,
  isValid: true,
}));

const twelveResources: McpResourceInfo[] = Array.from(
  { length: 12 },
  (_, i) => ({ uri: `res://resource_${i}` }),
);

describe('OpenTuiMcpDialog list windows', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
  });

  it('keeps the tool window put on hover, so a click opens the row under the pointer', async () => {
    // A twelve-tool server in a three-row window (region 12 minus the frame,
    // header, margin and footer). Hovering a painted row sets the cursor to
    // it; a window re-derived from the cursor on every render would pin the
    // cursor to the window's bottom edge and slide the window under the
    // pointer, so the row a click opens stops being the row it landed on.
    render(
      <OpenTuiMcpDialog
        servers={[serverWith({ toolCount: 12 })]}
        getServerTools={() => twelveTools}
        availableTerminalHeight={12}
        onClose={() => {}}
      />,
    );

    await press('return'); // server list → server detail
    await press('return'); // detail → View tools → tool list

    // Walk the cursor to tool_5: the window follows to paint tool_3..tool_5.
    for (let i = 0; i < 5; i++) await press('down');
    expect(screen.queryByText('tool_2')).toBeNull();
    expect(screen.getByText('tool_5')).toBeTruthy();

    // Hovering the window's first painted row must not move the window.
    await act(async () => {
      fireEvent.mouseOver(screen.getByText('tool_3'));
    });
    expect(screen.queryByText('tool_2')).toBeNull();
    expect(screen.getByText('tool_4')).toBeTruthy();
    expect(screen.getByText('tool_5')).toBeTruthy();

    // And the click opens the row the pointer is on.
    await act(async () => {
      fireEvent.mouseUp(screen.getByText('tool_3'), { button: 0 });
    });
    expect(screen.getByText('(no description)')).toBeTruthy();
    expect(screen.getByText('tool_3')).toBeTruthy();
  });

  it('keeps the resource window put on hover', async () => {
    render(
      <OpenTuiMcpDialog
        servers={[serverWith({ resourceCount: 12 })]}
        getServerResources={() => twelveResources}
        availableTerminalHeight={12}
        onClose={() => {}}
      />,
    );

    await press('return'); // server list → server detail
    await press('return'); // detail → View resources → resource list

    for (let i = 0; i < 5; i++) await press('down');
    expect(screen.queryByText('res://resource_2')).toBeNull();
    expect(screen.getByText('res://resource_5')).toBeTruthy();

    await act(async () => {
      fireEvent.mouseOver(screen.getByText('res://resource_3'));
    });
    expect(screen.queryByText('res://resource_2')).toBeNull();
    expect(screen.getByText('res://resource_4')).toBeTruthy();
    expect(screen.getByText('res://resource_5')).toBeTruthy();

    await act(async () => {
      fireEvent.mouseUp(screen.getByText('res://resource_3'), { button: 0 });
    });
    // The resource detail body repeats the URI as its own row.
    expect(
      screen.getAllByText('res://resource_3').length,
    ).toBeGreaterThanOrEqual(1);
  });
});
