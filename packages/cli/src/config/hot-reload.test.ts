/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  ApprovalMode,
  type Config,
  type MCPServerConfig,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings, Settings } from './settings.js';
import type {
  SettingsWatcher,
  SettingsChangeListener,
} from './settingsWatcher.js';
import {
  registerMcpHotReload,
  mcpServersEqual,
  mcpGatingEqual,
} from './hot-reload.js';
import {
  loadMcpApprovals,
  resetMcpApprovalsForTesting,
} from './mcpApprovals.js';
import { appEvents, AppEvent } from '../utils/events.js';

// ── Pure helpers ──────────────────────────────────────────────────────

describe('mcpServersEqual', () => {
  it('treats key-order differences as equal', () => {
    const a = { x: { command: 'a' }, y: { command: 'b' } };
    const b = { y: { command: 'b' }, x: { command: 'a' } };
    expect(mcpServersEqual(a, b)).toBe(true);
  });

  it('treats undefined and {} as equal', () => {
    expect(mcpServersEqual(undefined, {})).toBe(true);
  });

  it('detects a nested config field change', () => {
    expect(
      mcpServersEqual({ x: { command: 'a' } }, { x: { command: 'b' } }),
    ).toBe(false);
  });

  it('detects adding / removing a server', () => {
    expect(mcpServersEqual({ x: { command: 'a' } }, {})).toBe(false);
  });

  it('treats args array reorder as NOT equal (arg order is semantic)', () => {
    expect(
      mcpServersEqual(
        { x: { command: 'c', args: ['--a', '--b'] } },
        { x: { command: 'c', args: ['--b', '--a'] } },
      ),
    ).toBe(false);
  });
});

describe('mcpGatingEqual', () => {
  it('is order-insensitive across the three lists', () => {
    expect(
      mcpGatingEqual({ allowed: ['a', 'b'] }, { allowed: ['b', 'a'] }),
    ).toBe(true);
  });

  it('treats undefined and [] as equal', () => {
    expect(mcpGatingEqual({ excluded: undefined }, { excluded: [] })).toBe(
      true,
    );
  });

  it('detects a member added to any list', () => {
    expect(mcpGatingEqual({ pending: ['a'] }, { pending: ['a', 'b'] })).toBe(
      false,
    );
    expect(mcpGatingEqual({ excluded: [] }, { excluded: ['a'] })).toBe(false);
  });

  it('treats allowed absent (allow-all) and [] (deny-all) as DIFFERENT', () => {
    // For `allowed`, undefined ≠ [] — otherwise editing mcp.allowed to [] would
    // look like a no-op and the deny-all would never reconcile.
    expect(mcpGatingEqual({ allowed: undefined }, { allowed: [] })).toBe(false);
    expect(mcpGatingEqual({ allowed: [] }, { allowed: [] })).toBe(true);
    expect(mcpGatingEqual({ allowed: ['a'] }, { allowed: ['a'] })).toBe(true);
    // excluded keeps undefined ≡ [] (both mean "exclude nothing").
    expect(mcpGatingEqual({ excluded: undefined }, { excluded: [] })).toBe(
      true,
    );
  });
});

// ── Subscriber gate branches ──────────────────────────────────────────

interface FakeConfigState {
  settingsMcp: Record<string, MCPServerConfig> | undefined;
  gating: { excluded?: string[]; allowed?: string[]; pending?: string[] };
  /** Startup `--allowed-mcp-server-names` upper bound (K); default undefined. */
  bootAllowed?: string[];
  approvalMode?: ApprovalMode;
}

function makeFakeConfig(cwd: string, state: FakeConfigState) {
  const reinitializeMcpServers = vi.fn(async () => {});
  const setExcludedMcpServers = vi.fn((v: string[]) => {
    state.gating.excluded = v;
  });
  const setAllowedMcpServers = vi.fn((v: string[] | undefined) => {
    state.gating.allowed = v;
  });
  const setPendingMcpServers = vi.fn((v: string[] | undefined) => {
    state.gating.pending = v;
  });
  const config = {
    getApprovalMode: () => state.approvalMode ?? ApprovalMode.DEFAULT,
    getTargetDir: () => cwd,
    getSettingsMcpServers: () => state.settingsMcp,
    // Stand-in for the effective (settings + extensions + runtime) map; the
    // hot-reload listener snapshots its keys before narrowing the admission
    // lists and passes them to reinitializeMcpServers.
    getMcpServers: () => state.settingsMcp,
    getMcpGating: () => state.gating,
    // Default: no startup --allowed-mcp-server-names flag (settings fully win).
    // Individual tests override via state.bootAllowed.
    getCliAllowedMcpServerNames: () => state.bootAllowed,
    setExcludedMcpServers,
    setAllowedMcpServers,
    setPendingMcpServers,
    reinitializeMcpServers,
  } as unknown as Config;
  return {
    config,
    reinitializeMcpServers,
    setExcludedMcpServers,
    setAllowedMcpServers,
    setPendingMcpServers,
  };
}

describe('registerMcpHotReload', () => {
  let cwd: string;
  let listener: SettingsChangeListener;
  let watcher: SettingsWatcher;
  let unsubscribe: Mock;
  let settings: LoadedSettings;
  let merged: Settings;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hotreload-'));
    // No .mcp.json in cwd → assembleMcpServers yields only settings + topTier.
    process.env['QWEN_CODE_MCP_APPROVALS_PATH'] = path.join(
      cwd,
      'mcpApprovals.json',
    );
    resetMcpApprovalsForTesting();

    unsubscribe = vi.fn();
    watcher = {
      addChangeListener: vi.fn((l: SettingsChangeListener) => {
        listener = l;
        return unsubscribe;
      }),
    } as unknown as SettingsWatcher;

    merged = { mcpServers: {}, mcp: {} } as Settings;
    settings = { merged } as LoadedSettings;
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
    resetMcpApprovalsForTesting();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('returns the watcher unsubscribe fn', () => {
    const fc = makeFakeConfig(cwd, { settingsMcp: {}, gating: {} });
    const dispose = registerMcpHotReload(
      watcher,
      settings,
      fc.config,
      undefined,
    );
    expect(watcher.addChangeListener).toHaveBeenCalledOnce();
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('reconciles with the assembled map (incl. top-tier) on an mcpServers change', async () => {
    const fc = makeFakeConfig(cwd, { settingsMcp: {}, gating: {} });
    const topTier = { cliSrv: { command: 'cli' } };
    registerMcpHotReload(watcher, settings, fc.config, topTier);

    merged.mcpServers = { a: { command: 'a' } };
    await listener([]);

    expect(fc.reinitializeMcpServers).toHaveBeenCalledOnce();
    expect(fc.reinitializeMcpServers).toHaveBeenCalledWith({
      a: { command: 'a' },
      cliSrv: { command: 'cli' },
    });
  });

  it('reconciles on an admission-list-only change (mcp.excluded), servers unchanged', async () => {
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { a: { command: 'a' } },
      gating: {},
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    // Same servers, but a newly-excluded one.
    merged.mcpServers = { a: { command: 'a' } };
    merged.mcp = { excluded: ['a'] };
    await listener([]);

    expect(fc.setExcludedMcpServers).toHaveBeenCalledWith(['a']);
    expect(fc.reinitializeMcpServers).toHaveBeenCalledOnce();
    // Admission lists are pushed BEFORE reconcile.
    expect(fc.setExcludedMcpServers.mock.invocationCallOrder[0]).toBeLessThan(
      fc.reinitializeMcpServers.mock.invocationCallOrder[0],
    );
  });

  // ── H: mcp.allowed [] semantics ──────────────────────────────────────
  it('H: an explicit mcp.allowed [] is preserved as deny-all (not collapsed to undefined)', async () => {
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { a: { command: 'a' } },
      gating: {}, // allow-all before
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    merged.mcpServers = { a: { command: 'a' } };
    merged.mcp = { allowed: [] }; // deny all
    await listener([]);

    // Reconcile fires (absent → [] is a real change) and [] is pushed through.
    expect(fc.reinitializeMcpServers).toHaveBeenCalledOnce();
    expect(fc.setAllowedMcpServers).toHaveBeenCalledWith([]);
  });

  // ── K: startup --allowed-mcp-server-names as an upper bound ───────────
  it('K: with the startup flag and no settings allow-list, applies the flag in full', async () => {
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { a: { command: 'a' } },
      gating: {},
      bootAllowed: ['a', 'b'],
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    merged.mcpServers = { a: { command: 'a' } };
    merged.mcp = {}; // no settings allow-list
    await listener([]);

    expect(fc.setAllowedMcpServers).toHaveBeenCalledWith(['a', 'b']);
  });

  it('K: a settings allow-list is capped to the startup flag (cannot widen beyond it)', async () => {
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { a: { command: 'a' } },
      gating: {},
      bootAllowed: ['a', 'b'],
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    merged.mcpServers = {
      a: { command: 'a' },
      b: { command: 'b' },
      c: { command: 'c' },
    };
    merged.mcp = { allowed: ['a', 'b', 'c'] }; // tries to widen to c
    await listener([]);

    // `c` is outside the launch bound → dropped.
    expect(fc.setAllowedMcpServers).toHaveBeenCalledWith(['a', 'b']);
  });

  it('K: a settings allow-list may narrow within the startup flag', async () => {
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { a: { command: 'a' } },
      gating: {},
      bootAllowed: ['a', 'b'],
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    merged.mcpServers = { a: { command: 'a' }, b: { command: 'b' } };
    merged.mcp = { allowed: ['a'] };
    await listener([]);

    expect(fc.setAllowedMcpServers).toHaveBeenCalledWith(['a']);
  });

  it('K: without the startup flag, the settings allow-list wins unbounded', async () => {
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { a: { command: 'a' } },
      gating: {},
      // no bootAllowed
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    merged.mcpServers = { a: { command: 'a' }, x: { command: 'x' } };
    merged.mcp = { allowed: ['x'] };
    await listener([]);

    expect(fc.setAllowedMcpServers).toHaveBeenCalledWith(['x']);
  });

  it('does NOT reconcile when neither servers nor admission lists changed', async () => {
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { a: { command: 'a' } },
      gating: {},
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    merged.mcpServers = { a: { command: 'a' } };
    merged.mcp = {};
    await listener([]);

    expect(fc.reinitializeMcpServers).not.toHaveBeenCalled();
    expect(fc.setExcludedMcpServers).not.toHaveBeenCalled();
  });

  it('recomputes admission lists from current settings, not the startup CLI allowlist', async () => {
    // Pre-image gating mimics a session started with --allowed-mcp-server-names=a.
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { a: { command: 'a' } },
      gating: { allowed: ['a'] },
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    // Runtime settings widen the allow-list to include b.
    merged.mcpServers = { a: { command: 'a' }, b: { command: 'b' } };
    merged.mcp = { allowed: ['a', 'b'] };
    await listener([]);

    // Settings win: b is now allowed (not pinned to the boot allowlist).
    expect(fc.setAllowedMcpServers).toHaveBeenCalledWith(['a', 'b']);
    expect(fc.reinitializeMcpServers).toHaveBeenCalledOnce();
  });

  it('emits McpPendingApprovalChanged when a gated server becomes newly pending', async () => {
    const fc = makeFakeConfig(cwd, { settingsMcp: {}, gating: {} });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    const spy = vi.fn();
    appEvents.on(AppEvent.McpPendingApprovalChanged, spy);
    try {
      // A workspace-scoped (gated) server with no stored approval → pending.
      merged.mcpServers = { ws: { command: 'ws', scope: 'workspace' } };
      await listener([]);

      expect(fc.setPendingMcpServers).toHaveBeenCalledWith(['ws']);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      appEvents.off(AppEvent.McpPendingApprovalChanged, spy);
    }
  });

  it('does NOT emit McpPendingApprovalChanged for a non-gated server change', async () => {
    const fc = makeFakeConfig(cwd, { settingsMcp: {}, gating: {} });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    const spy = vi.fn();
    appEvents.on(AppEvent.McpPendingApprovalChanged, spy);
    try {
      // User-scoped (scope unset) server is never gated → never pending.
      merged.mcpServers = { a: { command: 'a' } };
      await listener([]);

      expect(fc.reinitializeMcpServers).toHaveBeenCalledOnce();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      appEvents.off(AppEvent.McpPendingApprovalChanged, spy);
    }
  });

  it('surfaces a user-visible LogError when reconcile throws', async () => {
    const fc = makeFakeConfig(cwd, { settingsMcp: {}, gating: {} });
    fc.reinitializeMcpServers.mockRejectedValueOnce(
      new Error('reconcile boom'),
    );
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    const spy = vi.fn();
    appEvents.on(AppEvent.LogError, spy);
    try {
      merged.mcpServers = { a: { command: 'a' } };
      // The listener swallows the reconcile error (one bad reload must not crash
      // the watcher) but must NOT do so silently.
      await listener([]);

      expect(fc.reinitializeMcpServers).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledOnce();
      // Concise, user-facing message — not a raw stack.
      expect(String(spy.mock.calls[0][0])).toMatch(
        /Failed to reload MCP server settings/,
      );
    } finally {
      appEvents.off(AppEvent.LogError, spy);
    }
  });

  // Regression for review issue #6: a previously *rejected* gated server is
  // still listed in `pending` (rejected ⇒ `!== 'approved'`), so a name-diff of
  // the pending set would treat a subsequent config edit as "not newly pending"
  // and fail to re-prompt. The strict-`pending` promptable check must re-emit.
  it('re-emits when an edit invalidates a previously rejected gated server', async () => {
    // Prior reconcile listed ws in pending (because it was rejected).
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { ws: { command: 'ws', scope: 'workspace' } },
      gating: { pending: ['ws'] },
    });
    // The rejection is bound to ws's OLD config hash.
    await loadMcpApprovals().setState(
      cwd,
      'ws',
      { command: 'ws', scope: 'workspace' },
      'rejected',
    );
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    const spy = vi.fn();
    appEvents.on(AppEvent.McpPendingApprovalChanged, spy);
    try {
      // Edit changes the config → hash no longer matches the rejection →
      // strictly `pending` again → must re-prompt.
      merged.mcpServers = { ws: { command: 'ws-v2', scope: 'workspace' } };
      await listener([]);

      expect(spy).toHaveBeenCalledOnce();
    } finally {
      appEvents.off(AppEvent.McpPendingApprovalChanged, spy);
    }
  });

  it('does NOT re-emit for an unrelated edit while a server stays rejected', async () => {
    const ws: MCPServerConfig = { command: 'ws', scope: 'workspace' };
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { ws },
      gating: { pending: ['ws'] },
    });
    // ws rejected at its CURRENT config hash → stays rejected, not promptable.
    await loadMcpApprovals().setState(cwd, 'ws', ws, 'rejected');
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    const spy = vi.fn();
    appEvents.on(AppEvent.McpPendingApprovalChanged, spy);
    try {
      // Unrelated admission-list change; ws config itself is unchanged.
      merged.mcpServers = { ws };
      merged.mcp = { excluded: ['other'] };
      await listener([]);

      expect(fc.reinitializeMcpServers).toHaveBeenCalledOnce();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      appEvents.off(AppEvent.McpPendingApprovalChanged, spy);
    }
  });

  it('YOLO: does not compute pending or emit McpPendingApprovalChanged for gated servers', async () => {
    const fc = makeFakeConfig(cwd, {
      settingsMcp: {},
      gating: {},
      approvalMode: ApprovalMode.YOLO,
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    const spy = vi.fn();
    appEvents.on(AppEvent.McpPendingApprovalChanged, spy);
    try {
      // A workspace-scoped (gated) server with no stored approval would
      // normally be pending — but YOLO skips gating entirely.
      merged.mcpServers = { ws: { command: 'ws', scope: 'workspace' } };
      await listener([]);

      expect(fc.setPendingMcpServers).toHaveBeenCalledWith(undefined);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      appEvents.off(AppEvent.McpPendingApprovalChanged, spy);
    }
  });
});
