/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Routing tests for OpenTuiDialogMount (Batch 5 slice 2). The mount is the
 * exhaustive `request.dialog -> dialog component` switch; every child dialog is
 * stubbed to a text marker that also records the props it received, so the
 * wiring is observable without booting a renderer:
 *
 *  - each of the 25 OpenTuiDialogRequest kinds renders its own dialog marker;
 *  - the callbacks the mount hands a dialog do the real thing — persist through
 *    the data helpers, reach the composer owner, or report a seam this shell
 *    does not wire rather than closing over a no-op;
 *  - the help request routes to HelpOverlay and drives tab/scroll keys through
 *    the mount's own useKeyboard handler;
 *  - an unknown dialog kind hits the never-default and throws.
 *
 * Child-dialog internals (data builders, selection semantics) are covered by
 * their own suites; the fake renderer never boots here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { OpenTuiDialogMount } from './opentui-dialog-mount.js';
import {
  addWorkspaceDirectory,
  applyModelSelection,
  removeWorkspaceDirectory,
} from './dialog-data.js';
import type { OpenTuiDialogRequest } from './commands-registry.js';
import type { OpenTuiAppHost } from './opentui-host.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    dialogProps: {} as Record<string, Record<string, unknown>>,
    /** Line count the stubbed help-content builders report, to pin the scroll bound. */
    helpLineCount: 0,
    /** Terminal height the mocked renderer reports, to pin the help body budget. */
    terminalHeight: 40,
  };
  // Renders the dialog-name marker but keeps the props the mount passed, so
  // wiring (callbacks, data builders) stays observable from these tests.
  function stub(name: string) {
    return (props: Record<string, unknown>) => {
      state.dialogProps[name] = props;
      return name;
    };
  }
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
  return { state, buildJsxRuntime, stub };
});

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    // The real hook keeps one live registration; this runs per render, so drop
    // the previous render's handler instead of replaying keys through it.
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.keyboardHandlers.push(handler);
  },
  useTerminalDimensions: () => ({
    width: 120,
    height: mocks.state.terminalHeight,
  }),
  useRenderer: () => ({
    addInputHandler: () => {},
    removeInputHandler: () => {},
  }),
}));

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

// The real theme/key-map/help-content/dialog-data modules pull the native FFI
// and heavier transitive deps; stub the surface the mount touches.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: { name?: string; shift?: boolean }) => ({
    name: key?.name ?? '',
    shift: !!key?.shift,
  }),
}));
vi.mock('./help-content.js', () => {
  const lines = () =>
    new Array(mocks.state.helpLineCount).fill({ type: 'blank' });
  return {
    computeHelpBodyRows: (height: number) => Math.max(1, height - 6),
    HELP_TABS: [
      { tab: 'general', label: 'general' },
      { tab: 'commands', label: 'commands' },
      { tab: 'custom-commands', label: 'custom-commands' },
    ],
    buildHelpCommandsLines: lines,
    buildHelpCustomCommandLines: lines,
    helpCommandWindowRows: (bodyRows: number) =>
      Math.max(1, Math.min(18, bodyRows - 4)),
    helpScrollMax: (built: readonly unknown[], windowRows: number) =>
      Math.max(0, built.length - windowRows),
  };
});
vi.mock('./dialog-data.js', () => ({
  buildPermissionsData: () => ({
    rules: [],
    directories: [],
    initialDirectories: [],
  }),
  addPermissionRule: vi.fn(),
  deletePermissionRule: vi.fn(),
  addWorkspaceDirectory: vi.fn(),
  removeWorkspaceDirectory: vi.fn(),
  buildMcpServers: () => [],
  enrichMcpOAuthState: async () => [],
  applyMcpServerAction: async () => ({ message: null, changed: false }),
  getMcpServerTools: () => [],
  getMcpServerResources: () => [],
  buildExtensionRows: () => [],
  applyExtensionToggle: async () => {},
  applyExtensionFavorite: () => {},
  applyExtensionUninstall: async () => {},
  applyExtensionScopeChange: async () => {},
  applyExtensionUpdate: async () => {},
  applyExtensionUpdateCheck: async () => null,
  buildModelEntries: () => [],
  computeModelDialogInitialKey: () => undefined,
  applyModelSelection: vi.fn(async () => ({ ok: true as const })),
  applyThemeSelection: () => ({ applied: undefined, error: undefined }),
}));

vi.mock('./help-overlay.js', () => ({ HelpOverlay: mocks.stub('help') }));
vi.mock('./dialogs-theme.js', () => ({
  OpenTuiThemeDialog: mocks.stub('theme'),
}));
vi.mock('./dialogs-settings.js', () => ({
  OpenTuiSettingsDialog: mocks.stub('settings'),
}));
vi.mock('./dialogs-model.js', () => ({
  OpenTuiModelDialog: mocks.stub('model'),
}));
vi.mock('./dialogs-extensions.js', () => ({
  OpenTuiExtensionsDialog: mocks.stub('extensions_manage'),
}));
vi.mock('./dialogs-mcp.js', () => ({ OpenTuiMcpDialog: mocks.stub('mcp') }));
vi.mock('./dialogs-permissions.js', () => ({
  OpenTuiPermissionsDialog: mocks.stub('permissions'),
}));
vi.mock('./dialogs-auth.js', () => ({
  OpenTuiAuthDialog: mocks.stub('auth'),
}));
vi.mock('./dialogs-arena.js', () => ({
  OpenTuiArenaDialog: mocks.stub('arena'),
}));
vi.mock('./dialogs-memory-status.js', () => ({
  OpenTuiMemoryDialog: mocks.stub('memory'),
  OpenTuiStatusLineDialog: mocks.stub('statusline'),
}));
vi.mock('./dialogs-modes.js', () => ({
  OpenTuiApprovalModeDialog: mocks.stub('approval-mode'),
  OpenTuiEffortDialog: mocks.stub('effort'),
  OpenTuiOutputStyleDialog: mocks.stub('output-style'),
}));
vi.mock('./dialogs-stats-skills.js', () => ({
  OpenTuiStatsDialog: mocks.stub('stats'),
  OpenTuiSkillsDialog: mocks.stub('skills_manage'),
}));
vi.mock('./dialogs-misc.js', () => ({
  OpenTuiDeleteDialog: mocks.stub('delete'),
  OpenTuiDiffDialog: mocks.stub('diff'),
  OpenTuiEditorDialog: mocks.stub('editor'),
  OpenTuiHooksDialog: mocks.stub('hooks'),
  OpenTuiResumeDialog: mocks.stub('resume'),
  OpenTuiRewindDialog: mocks.stub('rewind'),
  OpenTuiSubagentCreateDialog: mocks.stub('subagent_create'),
  OpenTuiSubagentListDialog: mocks.stub('subagent_list'),
  OpenTuiTrustDialog: mocks.stub('trust'),
}));

const CONFIG = { getModel: () => 'fake-model' } as unknown as Config;
const SETTINGS = { merged: {} } as unknown as LoadedSettings;
const addItem = vi.fn();
const HOST = {
  handleResume: async () => {},
  addItem,
} as unknown as OpenTuiAppHost;

function mount(
  request: OpenTuiDialogRequest,
  overrides: {
    notify?: (text: string) => void;
    onClose?: () => void;
    fillInput?: (text: string) => void;
    onSelectSetting?: (name: string, scope: unknown) => void;
  } = {},
) {
  return render(
    <OpenTuiDialogMount
      request={request}
      host={HOST}
      config={CONFIG}
      settings={SETTINGS}
      commands={[]}
      onClose={overrides.onClose ?? (() => {})}
      notify={overrides.notify ?? (() => {})}
      fillInput={overrides.fillInput}
      onSelectSetting={overrides.onSelectSetting}
    />,
  );
}

// A callback the mount handed to a stubbed dialog.
function dialogProp(dialog: string, key: string): (...args: unknown[]) => void {
  const value = mocks.state.dialogProps[dialog]?.[key];
  expect(value, `${dialog} received no '${key}' prop`).toBeInstanceOf(Function);
  return value as (...args: unknown[]) => void;
}

/** What the mount handed the stubbed help overlay on its last render. */
function helpOverlay(): {
  tab: string;
  scroll: number;
  width: number;
  bodyRows: number;
} {
  return mocks.state.dialogProps['help']! as unknown as {
    tab: string;
    scroll: number;
    width: number;
    bodyRows: number;
  };
}

// Every OpenTuiDialogRequest kind the mount must route, with the exact object a
// dispatcher would produce.
const REQUESTS: Array<[string, OpenTuiDialogRequest]> = [
  ['help', { dialog: 'help' }],
  ['theme', { dialog: 'theme' }],
  ['editor', { dialog: 'editor' }],
  ['settings', { dialog: 'settings' }],
  ['statusline', { dialog: 'statusline' }],
  ['memory', { dialog: 'memory' }],
  ['auth', { dialog: 'auth' }],
  ['trust', { dialog: 'trust' }],
  ['permissions', { dialog: 'permissions' }],
  ['approval-mode', { dialog: 'approval-mode' }],
  ['effort', { dialog: 'effort' }],
  ['output-style', { dialog: 'output-style' }],
  ['delete', { dialog: 'delete' }],
  ['resume', { dialog: 'resume' }],
  ['extensions_manage', { dialog: 'extensions_manage' }],
  ['hooks', { dialog: 'hooks' }],
  ['mcp', { dialog: 'mcp' }],
  ['rewind', { dialog: 'rewind' }],
  ['diff', { dialog: 'diff' }],
  ['stats', { dialog: 'stats' }],
  ['arena', { dialog: 'arena', mode: 'start' }],
  ['subagent_create', { dialog: 'subagent_create' }],
  ['subagent_list', { dialog: 'subagent_list' }],
  ['skills_manage', { dialog: 'skills_manage' }],
  ['model', { dialog: 'model', mode: 'primary' }],
];

describe('OpenTuiDialogMount routing', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.dialogProps = {};
    mocks.state.helpLineCount = 0;
    mocks.state.terminalHeight = 40;
    vi.clearAllMocks();
  });

  it('routes every dialog request to its own component', () => {
    expect(REQUESTS).toHaveLength(25);
    for (const [expected, request] of REQUESTS) {
      const { unmount } = mount(request);
      expect(screen.getByText(expected)).toBeTruthy();
      unmount();
    }
  });

  it('persists working-directory changes made in the permissions dialog', () => {
    mount({ dialog: 'permissions' });
    // The dialog clears its input and returns to the list right after these
    // run, so an unwired callback would look like a completed change.
    dialogProp('permissions', 'onAddDirectory')('/abs/extra');
    expect(addWorkspaceDirectory).toHaveBeenCalledWith(
      CONFIG,
      SETTINGS,
      '/abs/extra',
    );
    dialogProp('permissions', 'onRemoveDirectory')('/abs/extra');
    expect(removeWorkspaceDirectory).toHaveBeenCalledWith(
      CONFIG,
      SETTINGS,
      '/abs/extra',
    );
  });

  it('reports a settings row whose sub-dialog the shell does not mount', () => {
    const notices: string[] = [];
    mount({ dialog: 'settings' }, { notify: (text) => notices.push(text) });
    dialogProp('settings', 'onSelect')('ui.theme', undefined);
    expect(notices).toEqual([
      "'ui.theme' opens a dialog this shell does not mount.",
    ]);
  });

  it('hands a settings sub-dialog row to the owner without closing (U-9)', () => {
    // The owner replaces the dialog request; a close here would clobber it.
    const onSelectSetting = vi.fn();
    const onClose = vi.fn();
    mount({ dialog: 'settings' }, { onSelectSetting, onClose });
    dialogProp('settings', 'onSelect')('ui.theme', 'user');
    expect(onSelectSetting).toHaveBeenCalledWith('ui.theme', 'user');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sends the arena start command through the composer owner', () => {
    const fillInput = vi.fn();
    mount({ dialog: 'arena', mode: 'start' }, { fillInput });
    dialogProp('arena', 'onFillInput')('/arena start --models a:b ');
    expect(fillInput).toHaveBeenCalledWith('/arena start --models a:b ');
  });

  it('reports an arena start when no composer owner is wired', () => {
    const notices: string[] = [];
    // The picker closes right after this callback, so without a report the
    // user's model selection would vanish with it.
    mount(
      { dialog: 'arena', mode: 'start' },
      { notify: (t) => notices.push(t) },
    );
    dialogProp('arena', 'onFillInput')('/arena start --models a:b ');
    expect(notices).toEqual([
      'The composer is not wired, so the arena command is lost.',
    ]);
  });

  it('drives help tab cycling and scrolling through its own keyboard handler', () => {
    // 23 lines over the 18-row window leave five offsets that actually move it.
    mocks.state.helpLineCount = 23;
    mount({ dialog: 'help' });
    expect(mocks.state.keyboardHandlers.length).toBeGreaterThan(0);
    const send = (name: string, shift = false) => {
      act(() => {
        for (const handler of mocks.state.keyboardHandlers)
          handler({ name, shift });
      });
    };
    const overlay = helpOverlay;

    // The overlay gets the popup area, not the raw terminal: the 120 columns
    // this renderer reports cap at 100, the width ink hands its Help dialog.
    expect(overlay().width).toBe(100);
    expect(overlay().bodyRows).toBe(34);
    expect(overlay().tab).toBe('general');
    // The general tab has no scrollable window, so the arrow keys are inert.
    send('down');
    expect(overlay().scroll).toBe(0);

    send('tab');
    expect(overlay().tab).toBe('commands');
    send('down');
    expect(overlay().scroll).toBe(1);
    // Paging clamps to the offsets that still move the window — an unclamped
    // offset leaves the opposite key inert until it climbs back down to one.
    send('pagedown');
    expect(overlay().scroll).toBe(5);
    send('pageup');
    expect(overlay().scroll).toBe(0);

    // The hint under the body promises Shift+Tab goes back.
    send('tab', true);
    expect(overlay().tab).toBe('general');
    send('tab', true);
    expect(overlay().tab).toBe('custom-commands');
  });

  it('pages the help command list by the window a short terminal leaves', () => {
    // The same 23 lines, but a 24-row terminal budgets 18 body rows and the tab
    // chrome claims four of them: the window narrows to 14, so a page covers 14
    // lines and stops at nine rather than the five offsets a roomy terminal has.
    mocks.state.helpLineCount = 23;
    mocks.state.terminalHeight = 24;
    mount({ dialog: 'help' });
    const send = (name: string) => {
      act(() => {
        for (const handler of mocks.state.keyboardHandlers)
          handler({ name, shift: false });
      });
    };

    expect(helpOverlay().bodyRows).toBe(18);
    send('tab');
    expect(helpOverlay().tab).toBe('commands');
    send('pagedown');
    expect(helpOverlay().scroll).toBe(9);
    send('pageup');
    expect(helpOverlay().scroll).toBe(0);
  });

  it('closes the help overlay on escape', () => {
    const onClose = vi.fn();
    render(
      <OpenTuiDialogMount
        request={{ dialog: 'help' }}
        host={HOST}
        config={CONFIG}
        settings={SETTINGS}
        commands={[]}
        onClose={onClose}
        notify={() => {}}
      />,
    );
    act(() => {
      for (const handler of mocks.state.keyboardHandlers)
        handler({ name: 'escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('writes the kept-model row once when Escape arrives twice', () => {
    const onClose = vi.fn();
    mount({ dialog: 'model', mode: 'primary' }, { onClose });
    const close = dialogProp('model', 'onClose');
    close();
    close();
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem.mock.calls[0]![0]).toMatchObject({
      text: expect.stringContaining('Kept model as'),
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('holds the kept-model row while a pick is still being applied', async () => {
    let settle!: (outcome: { ok: true; message?: string }) => void;
    vi.mocked(applyModelSelection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const onClose = vi.fn();
    mount({ dialog: 'model', mode: 'primary' }, { onClose });
    dialogProp('model', 'onSelect')('fake-model');
    dialogProp('model', 'onClose')();
    expect(addItem).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      settle({ ok: true, message: 'Model set to fake-model' });
    });
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a repeat pick while one is applying and after it lands', async () => {
    let settle!: (outcome: { ok: true; message?: string }) => void;
    vi.mocked(applyModelSelection).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    // A spy never unmounts the dialog, so the post-commit pick below is the one
    // route that reaches the committed half of the guard.
    const onClose = vi.fn();
    mount({ dialog: 'model', mode: 'primary' }, { onClose });
    const select = dialogProp('model', 'onSelect');
    select('fake-model');
    select('fake-model');
    expect(applyModelSelection).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle({ ok: true, message: 'Model set to fake-model' });
    });
    select('fake-model');
    expect(applyModelSelection).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('throws for an unhandled dialog kind', () => {
    const bad = { dialog: 'nope' } as unknown as OpenTuiDialogRequest;
    expect(() => mount(bad)).toThrow(/Unhandled OpenTUI dialog request/);
  });
});
