/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Routing tests for OpenTuiDialogMount (Batch 5 slice 2). The mount is the
 * exhaustive `request.dialog -> dialog component` switch; every child dialog is
 * stubbed to a text marker so these tests assert only the wiring:
 *
 *  - each of the 24 OpenTuiDialogRequest kinds renders its own dialog marker;
 *  - the help request routes to HelpOverlay and drives tab/scroll keys through
 *    the mount's own useKeyboard handler;
 *  - an unknown dialog kind hits the never-default and throws.
 *
 * Child-dialog internals (data builders, callbacks, selection semantics) are
 * covered by their own suites; the fake renderer never boots here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { OpenTuiDialogMount } from './opentui-dialog-mount.js';
import {
  addWorkspaceDirectory,
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
    mocks.state.keyboardHandlers.push(handler);
  },
  useTerminalDimensions: () => ({ width: 120, height: 40 }),
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
  toOriginalKey: (key: { name?: string }) => ({ name: key?.name ?? '' }),
}));
vi.mock('./help-content.js', () => ({
  computeHelpBodyRows: (height: number) => Math.max(1, height - 6),
  HELP_TABS: [
    { tab: 'general', label: 'general' },
    { tab: 'commands', label: 'commands' },
    { tab: 'custom-commands', label: 'custom-commands' },
  ],
}));
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
  applyModelSelection: async () => ({ ok: true as const }),
  applyThemeSelection: () => ({ applied: undefined, error: undefined }),
}));

vi.mock('./help-overlay.js', () => ({ HelpOverlay: () => 'help' }));
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

const CONFIG = {} as unknown as Config;
const SETTINGS = { merged: {} } as unknown as LoadedSettings;
const HOST = { handleResume: async () => {} } as unknown as OpenTuiAppHost;

function mount(
  request: OpenTuiDialogRequest,
  overrides: {
    notify?: (text: string) => void;
    onClose?: () => void;
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
    />,
  );
}

// A callback the mount handed to a stubbed dialog.
function dialogProp(dialog: string, key: string): (...args: unknown[]) => void {
  const value = mocks.state.dialogProps[dialog]?.[key];
  expect(value, `${dialog} received no '${key}' prop`).toBeInstanceOf(Function);
  return value as (...args: unknown[]) => void;
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
    vi.clearAllMocks();
  });

  it('routes every dialog request to its own component', () => {
    expect(REQUESTS).toHaveLength(24);
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

  it('drives help tab cycling and scrolling through its own keyboard handler', () => {
    mount({ dialog: 'help' });
    // HelpOverlay renders the initial tab; the mount owns tab/scroll state.
    expect(mocks.state.keyboardHandlers.length).toBeGreaterThan(0);
    const send = (name: string) => {
      act(() => {
        for (const handler of mocks.state.keyboardHandlers) handler({ name });
      });
    };
    // Should not throw on any of the handled keys.
    expect(() => {
      send('tab');
      send('right');
      send('left');
      send('down');
      send('up');
    }).not.toThrow();
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

  it('throws for an unhandled dialog kind', () => {
    const bad = { dialog: 'nope' } as unknown as OpenTuiDialogRequest;
    expect(() => mount(bad)).toThrow(/Unhandled OpenTUI dialog request/);
  });
});
