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
import type { Config, MCPServerConfig } from '@qwen-code/qwen-code-core';
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
});

// ── Subscriber gate branches ──────────────────────────────────────────

interface FakeConfigState {
  settingsMcp: Record<string, MCPServerConfig> | undefined;
  gating: { excluded?: string[]; allowed?: string[]; pending?: string[] };
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
    getTargetDir: () => cwd,
    getSettingsMcpServers: () => state.settingsMcp,
    // Stand-in for the effective (settings + extensions + runtime) map; the
    // hot-reload listener snapshots its keys before narrowing the admission
    // lists and passes them to reinitializeMcpServers.
    getMcpServers: () => state.settingsMcp,
    getMcpGating: () => state.gating,
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
    expect(fc.reinitializeMcpServers).toHaveBeenCalledWith(
      { a: { command: 'a' }, cliSrv: { command: 'cli' } },
      expect.anything(),
    );
  });

  it('passes the pre-gating effective snapshot to reinitializeMcpServers', async () => {
    // The listener must capture the effective server set BEFORE narrowing the
    // admission lists, so a server that becomes filtered out this reconcile is
    // still recorded as removed (for the tool-not-found message). Here `b` is
    // effective at call time and must appear in the snapshot handed to
    // reinitializeMcpServers (its 2nd arg).
    const fc = makeFakeConfig(cwd, {
      settingsMcp: { a: { command: 'a' }, b: { command: 'b' } },
      gating: { allowed: ['a', 'b'] },
    });
    registerMcpHotReload(watcher, settings, fc.config, undefined);

    merged.mcpServers = { a: { command: 'a' } };
    await listener([]);

    expect(fc.reinitializeMcpServers).toHaveBeenCalledOnce();
    const firstCallArgs = fc.reinitializeMcpServers.mock.calls[0] as unknown[];
    const prevEffective = firstCallArgs[1] as readonly string[] | undefined;
    expect(prevEffective).toContain('b');
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
});
