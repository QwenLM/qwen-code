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

const twelveServers: McpServerInfo[] = Array.from({ length: 12 }, (_, i) =>
  serverWith({ name: `srv_${i}` }),
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

  it('windows the server list, so Enter only opens a painted server', async () => {
    // Twelve servers in one group paint thirteen rows (the group header plus
    // one per server); the region-12 window pays three of them, and the
    // window follows the cursor.
    render(
      <OpenTuiMcpDialog
        servers={twelveServers}
        availableTerminalHeight={12}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText('srv_11')).toBeNull();
    for (let i = 0; i < 10; i++) await press('down');
    // The cursor's row is painted; the rows scrolled past are not.
    expect(screen.getByText('srv_10')).toBeTruthy();
    expect(screen.queryByText('srv_0')).toBeNull();

    await press('return');
    // Enter opened the painted row's server: the detail header carries its
    // name.
    expect(screen.getByText('srv_10')).toBeTruthy();
  });

  it('refuses the arrows and Enter on a zero-row server window', async () => {
    // Region 8 leaves the window max(0, min(10, 8 - 9)) = 0 rows.
    render(
      <OpenTuiMcpDialog
        servers={twelveServers}
        availableTerminalHeight={8}
        onClose={() => {}}
      />,
    );

    await press('down');
    await press('return');
    // The detail step never opens: the footer still belongs to the server
    // list. (A 'Status:' tell would be blind here — the detail step's own
    // window is zero rows at this region too.)
    expect(screen.getByText(/Esc to close/)).toBeTruthy();
    expect(screen.queryByText(/Esc to go back/)).toBeNull();
  });

  it('settles instead of ping-ponging when the tool window has zero rows', async () => {
    // Region 12 mounts the tool list with a three-row window; shrinking to
    // region 9 leaves zero rows, and the follow-scroll effect must hold the
    // offset rather than alternate between the cursor and the list end
    // forever.
    const { rerender } = render(
      <OpenTuiMcpDialog
        servers={[serverWith({ toolCount: 12 })]}
        getServerTools={() => twelveTools}
        availableTerminalHeight={12}
        onClose={() => {}}
      />,
    );
    await press('return'); // server list → server detail
    await press('return'); // detail → View tools → tool list
    expect(screen.getByText('tool_0')).toBeTruthy();

    rerender(
      <OpenTuiMcpDialog
        servers={[serverWith({ toolCount: 12 })]}
        getServerTools={() => twelveTools}
        availableTerminalHeight={9}
        onClose={() => {}}
      />,
    );
    // The render settles with nothing painted and no update-depth blowup.
    expect(screen.queryByText('tool_0')).toBeNull();
  });

  it('clips the tool row’s trailing invalid-reason run to the columns the name leaves', async () => {
    // The row is charged one physical row: the name column owns 42 columns
    // (40 + the marker's 2), so the server-supplied reason clips at the
    // remaining 50 instead of wrapping onto a row nobody paid for.
    render(
      <OpenTuiMcpDialog
        servers={[serverWith({ toolCount: 1 })]}
        getServerTools={() => [
          { name: 'tool_0', isValid: false, invalidReason: 'x'.repeat(200) },
        ]}
        availableTerminalHeight={20}
        onClose={() => {}}
      />,
    );
    await press('return'); // server list → detail
    await press('return'); // detail → View tools → tool list
    expect(screen.getByText(`invalid: ${'x'.repeat(41)}`)).toBeTruthy();
    expect(screen.queryByText('x'.repeat(42))).toBeNull();
  });

  it('clips both runs of a resource row to the one row it is charged', async () => {
    // The friendly run was painted raw while the URI's budget subtracted its
    // UTF-16 length. A double-width title makes the two disagree: fifty 界
    // are 51 units but 101 columns, so a .length budget leaves the URI 39
    // columns the row does not have; the column measurement leaves it none.
    render(
      <OpenTuiMcpDialog
        servers={[serverWith({ resourceCount: 1 })]}
        getServerResources={() => [
          {
            uri: 'res://' + 'u'.repeat(60),
            title: '界'.repeat(50),
          },
        ]}
        availableTerminalHeight={20}
        onClose={() => {}}
      />,
    );
    await press('return'); // server list → detail
    await press('return'); // detail → View resources → resource list
    const text = document.body.textContent ?? '';
    expect(text.includes('u'.repeat(10))).toBe(false);
    expect(text.includes(' ' + '界'.repeat(44))).toBe(true);
    expect(text.includes('界'.repeat(45))).toBe(false);
  });

  it('refuses the resource list keys at a zero-row window', async () => {
    const { rerender } = render(
      <OpenTuiMcpDialog
        servers={[serverWith({ resourceCount: 12 })]}
        getServerResources={() => twelveResources}
        availableTerminalHeight={12}
        onClose={() => {}}
      />,
    );
    await press('return'); // server list → server detail
    await press('return'); // detail → View resources → resource list

    rerender(
      <OpenTuiMcpDialog
        servers={[serverWith({ resourceCount: 12 })]}
        getServerResources={() => twelveResources}
        availableTerminalHeight={9}
        onClose={() => {}}
      />,
    );
    await press('down');
    await press('return');
    // No resource detail opens: the committed resource's URI would paint in
    // the header, and it never does.
    expect(screen.queryByText('res://resource_0')).toBeNull();
  });

  it('refuses the tool list keys at a zero-row window', async () => {
    const { rerender } = render(
      <OpenTuiMcpDialog
        servers={[serverWith({ toolCount: 12 })]}
        getServerTools={() => twelveTools}
        availableTerminalHeight={12}
        onClose={() => {}}
      />,
    );
    await press('return'); // server list → server detail
    await press('return'); // detail → tool list

    rerender(
      <OpenTuiMcpDialog
        servers={[serverWith({ toolCount: 12 })]}
        getServerTools={() => twelveTools}
        availableTerminalHeight={9}
        onClose={() => {}}
      />,
    );
    await press('down');
    await press('return');
    // No tool detail opens: the tool body ('(no description)') never mounts.
    expect(screen.queryByText('(no description)')).toBeNull();
    expect(screen.queryByText('tool_0')).toBeNull();
  });
});
