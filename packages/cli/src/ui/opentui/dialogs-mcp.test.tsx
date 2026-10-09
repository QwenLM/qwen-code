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
    useTerminalDimensions: () => ({ width: mocks.state.width, height: 40 }),
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
  resolveFollowScrollOffset,
  type McpResourceInfo,
  type McpServerInfo,
  type McpToolInfo,
} from './dialogs-mcp.js';
import { wrappedRows } from './dialogs-core.js';

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
    mocks.state.width = 100;
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
    // list, and the detail step's own footer never appears. (A 'Status:'
    // tell would be blind here — the detail step's window is zero rows at
    // this region too.)
    expect(screen.getByText(/Esc to close/)).toBeTruthy();
    expect(screen.queryByText(/Esc to back/)).toBeNull();
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
    // The painted span reads 'invalid: ' + the reason, so a bare
    // queryByText('x'.repeat(42)) can never match anything; read the raw
    // text content for the absence side.
    expect((document.body.textContent ?? '').includes('x'.repeat(42))).toBe(
      false,
    );
  });

  it('clips both runs of a resource row to the one row it is charged', async () => {
    // The friendly run was painted raw while the URI's budget subtracted its
    // UTF-16 length. A double-width title makes the two disagree: fifty 界
    // are 51 units but 101 columns, so a .length budget leaves the URI 39
    // columns the row does not have; the column measurement leaves it the
    // thirty-column floor instead — the URI is the row's identity.
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
    // The URI keeps its floor: thirty columns is 'res://' plus twenty-three
    // u's plus the truncation ellipsis, and the rest clips.
    expect(text.includes('res://' + 'u'.repeat(23) + '…')).toBe(true);
    expect(text.includes('u'.repeat(24))).toBe(false);
    // The title gets what the URI leaves: 92 - 2 - 30 = 60 columns, which
    // is the leading space plus twenty-nine double-width glyphs.
    expect(text.includes(' ' + '界'.repeat(29))).toBe(true);
    expect(text.includes('界'.repeat(30))).toBe(false);
  });

  it('clips the server row’s status run to the one row it is charged', () => {
    // The server row is charged one physical row, but the status run painted
    // raw: a rejected server's text runs past what the marker, the name
    // column and the separator leave, and at width 60 the wrap painted a
    // second row the window never paid for. The run clips at the seventeen
    // columns the row leaves it (52 - 2 - 30 - 3).
    mocks.state.width = 60;
    render(
      <OpenTuiMcpDialog
        servers={[serverWith({ approvalState: 'rejected' })]}
        onClose={() => {}}
      />,
    );
    const text = document.body.textContent ?? '';
    expect(text.includes('rejected — ed')).toBe(true);
    expect(text.includes('re-approve')).toBe(false);
  });

  it('caps an info value taller than the window, so the error and its actions paint together', async () => {
    // A bad handshake can fill the Error row with a parse dump taller than
    // the whole window; the whole-entry paint predicate is then
    // unsatisfiable and the error never paints, though Enter still commits
    // the action rows below it. The entry charges the window minus the rows
    // the entries below it pay, and the paint clips to the same rows.
    const error = `Failed to parse: ${'e'.repeat(560)}`;
    render(
      <OpenTuiMcpDialog
        servers={[serverWith({ error })]}
        availableTerminalHeight={15}
        onClose={() => {}}
      />,
    );
    await press('return'); // server list → server detail

    // The error's leading rows paint, clipped to the three rows it is
    // charged (the six-row window less the spacer and the two action rows).
    expect(screen.getByText(/Failed to parse:/)).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text.includes('e'.repeat(500))).toBe(false);
    // The action row below the error still paints.
    expect(screen.getByText('Disable')).toBeTruthy();
    // The clip pays rows, not columns: a bare column clip lets greedy word
    // wrap leave the row the long token starts partly empty, so the painted
    // value wraps into one more row than the three it is charged.
    const painted = screen.getByText(/Failed to parse:/).textContent ?? '';
    expect(wrappedRows(painted, 72)).toBeLessThanOrEqual(3);
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
    // No resource detail opens: had the keys moved and committed, the cursor
    // would carry resource_1, whose URI the detail paints in both the header
    // and the body. (Asserting resource_0's absence would be vacuous — that
    // row cannot paint in either world at a zero-row window.)
    expect(screen.queryAllByText('res://resource_1')).toHaveLength(0);
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

  it('re-anchors the window to the cursor in the committed frame when the list changes identity', () => {
    // The state offset holds the previous list's window for a render after
    // the cursor resets (another server's tools, a re-entered step): the
    // committed frame must re-derive the window around the cursor, or Enter
    // would commit a row nothing painted.
    expect(resolveFollowScrollOffset(3, 0, 12, 3)).toBe(0);
    // A cursor inside the window leaves the offset alone (the hover rule).
    expect(resolveFollowScrollOffset(3, 5, 12, 3)).toBe(3);
    // A cursor past the window's bottom edge scrolls the window to it.
    expect(resolveFollowScrollOffset(3, 6, 12, 3)).toBe(4);
    // A zero-row window has no anchor; the offset only clamps into range.
    expect(resolveFollowScrollOffset(5, 0, 3, 0)).toBe(3);
  });

  it('paints every server the region can pay for, beyond the ten-row list cap', () => {
    // ink caps the tool and resource lists at ten rows but leaves the server
    // list unwindowed; the region budget — not the cap — bounds it. Region
    // 35 leaves the window 26 rows, and thirteen server rows paint.
    render(
      <OpenTuiMcpDialog
        servers={twelveServers}
        availableTerminalHeight={35}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('srv_0')).toBeTruthy();
    expect(screen.getByText('srv_11')).toBeTruthy();
  });

  it('paints the server error in full, charged the rows it wraps into', async () => {
    // A 201-column error wraps to four rows at the value's 72-column width.
    // The region-15 window pays six rows and follows the action cursor, so
    // the whole error paints with the cursor's action while the info rows
    // above the window stay off — including Prompts:, which would paint if
    // the wrap's rows were not charged into the window's row count.
    const error = `Failed to connect: ${'x'.repeat(140)} retry with --debug for the transport log`;
    render(
      <OpenTuiMcpDialog
        servers={[serverWith({ error })]}
        availableTerminalHeight={15}
        onClose={() => {}}
      />,
    );
    await press('return'); // server list → server detail
    expect(screen.getByText(/transport log$/)).toBeTruthy();
    expect(screen.queryByText('Status:')).toBeNull();
    expect(screen.queryByText('Prompts:')).toBeNull();
    expect(screen.getByText('Disable')).toBeTruthy();
  });

  it('windows the server detail column, so Enter only commits a painted action', async () => {
    // Seven info rows (the command wraps to two), the spacer and three
    // actions make twelve rows; the region-12 window pays three, and it
    // follows the action cursor in physical rows.
    const onServerAction = vi.fn();
    render(
      <OpenTuiMcpDialog
        servers={[
          serverWith({ toolCount: 12, command: 'x'.repeat(80), error: 'boom' }),
        ]}
        availableTerminalHeight={12}
        onClose={() => {}}
        onServerAction={onServerAction}
      />,
    );
    await press('return'); // server list → server detail
    expect(screen.getByText('View tools')).toBeTruthy();
    expect(screen.queryByText('Status:')).toBeNull();

    await press('down');
    await press('down');
    expect(screen.getByText('Authenticate')).toBeTruthy();
    await press('return');
    expect(onServerAction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'srv' }),
      'authenticate',
    );
  });

  it('pins the --debug hint below the windowed server list when a server is disconnected', async () => {
    // Twelve servers, one disconnected: the hint rows used to ride the
    // scroll window at the list's tail, where a cursor that can only sit on
    // a server row never scrolls them into view — the one diagnostic the
    // long-list case exists for never painted. The hint is pinned below the
    // window now, paid two rows out of the region budget, so it survives the
    // overflow.
    const servers = [
      serverWith({ name: 'srv_0', status: MCPServerStatus.DISCONNECTED }),
      ...Array.from({ length: 11 }, (_, i) =>
        serverWith({ name: `srv_${i + 1}` }),
      ),
    ];
    render(
      <OpenTuiMcpDialog
        servers={servers}
        availableTerminalHeight={12}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/Run qwen --debug to see error logs/)).toBeTruthy();
    for (let i = 0; i < 11; i++) await press('down');
    // The window followed the cursor to the last server; the hint stayed.
    expect(screen.getByText('srv_11')).toBeTruthy();
    expect(screen.getByText(/Run qwen --debug to see error logs/)).toBeTruthy();
  });

  it('lets the --debug hint yield when the region leaves the list two rows', async () => {
    // Region 11 (a 16-row terminal, a short window or a tmux split) leaves
    // bodyWindowRows = 2. The hint used to take both at >= 2, so the list
    // painted zero of twelve servers while the step header still counted
    // them, and the zero-row refusal killed the arrows and Enter with it —
    // one row *less* of region painted a server. The hint only spends rows
    // the list can spare.
    const servers = [
      serverWith({ name: 'srv_0', status: MCPServerStatus.DISCONNECTED }),
      ...Array.from({ length: 11 }, (_, i) =>
        serverWith({ name: `srv_${i + 1}` }),
      ),
    ];
    render(
      <OpenTuiMcpDialog
        servers={servers}
        availableTerminalHeight={11}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('srv_0')).toBeTruthy();
    expect(screen.queryByText(/Run qwen --debug to see error logs/)).toBeNull();

    await press('return');
    expect(screen.getByText(/Esc to back/)).toBeTruthy();
  });
});
