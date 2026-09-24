/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFakeConfig } from '../test-utils/config.js';
import type { Config } from '../config/config.js';
import { PermissionManager } from './permission-manager.js';
import { ToolRegistry, type ToolFactory } from '../tools/tool-registry.js';
import {
  MCPServerStatus,
  removeMCPServerStatus,
  updateMCPServerStatus,
} from '../tools/mcp-status.js';

/**
 * The coverage check only reads names, so a factory that is ever invoked
 * means the check started warming tools it has no business warming.
 */
const neverCalledFactory: ToolFactory = async () => {
  throw new Error('tool factory must not be invoked by the eager check');
};

/**
 * A real `Config` + real `PermissionManager` + real `ToolRegistry`, wired the
 * way `Config.initialize()` wires them (permission manager first, then the
 * registry), without running the rest of `initialize()` (skills, memory,
 * telemetry) which is irrelevant here. `promptRegistry` / `resourceRegistry`
 * are created by `initializeInternal`, so tests drive the MCP discovery pass
 * through the client manager directly instead of `discoverAllTools()`.
 */
function makeSession(opts: {
  eagerTools: string[];
  registered?: string[];
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}): {
  config: Config;
  permissionManager: PermissionManager;
  registry: ToolRegistry;
} {
  const config = makeFakeConfig({
    eagerTools: opts.eagerTools,
    trustedFolder: true,
    ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
  });
  const permissionManager = new PermissionManager(config);
  permissionManager.initialize();
  const registry = new ToolRegistry(config);
  for (const name of opts.registered ?? []) {
    registry.registerFactory(name, neverCalledFactory);
  }
  // Same two assignments `Config.initialize()` / `createToolRegistry()` make.
  Object.assign(config, { permissionManager, toolRegistry: registry });
  return { config, permissionManager, registry };
}

/** Runs a real MCP discovery pass to its COMPLETED boundary. */
async function runDiscoveryPass(
  registry: ToolRegistry,
  config: Config,
  mode: 'incremental' | 'bulk' = 'incremental',
): Promise<void> {
  const manager = registry.getMcpClientManager();
  if (mode === 'incremental') {
    // The default startup path: `Config.startMcpDiscoveryInBackground()`.
    await manager.discoverAllMcpToolsIncremental(config);
  } else {
    // The legacy blocking path behind `ToolRegistry.discoverAllTools()`.
    await manager.discoverAllMcpTools(config);
  }
}

describe('tools.eager entries that match no discovered tool (#12435)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const touchedServers: string[] = [];

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    while (touchedServers.length > 0) {
      removeMCPServerStatus(touchedServers.pop() as string);
    }
    vi.restoreAllMocks();
  });

  function eagerWarnings(): string[] {
    return warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('tools.eager'));
  }

  function setStatus(server: string, status: MCPServerStatus): void {
    touchedServers.push(server);
    updateMCPServerStatus(server, status);
  }

  it('keeps a shape-valid dynamic typo silent about existence: the allowlist activates and defers built-ins', async () => {
    // The bug being reported: `mcp__githb__create_issue` parses fine (no
    // unbalanced parenthesis), so `initialize()` keeps it and does NOT count
    // it among the dropped entries it already warns about. Nothing else looks
    // at whether it names a real tool.
    const { config, permissionManager, registry } = makeSession({
      eagerTools: ['mcp__githb__create_issue'],
      registered: ['read_file', 'run_shell_command'],
    });

    expect(permissionManager.isEagerToolAllowListActive()).toBe(true);
    await expect(
      permissionManager.getToolRegistrationStatus('read_file'),
    ).resolves.toBe('deferred');
    // MCP tools stay exempt, so the typo'd entry buys nothing at all.
    await expect(
      permissionManager.getToolRegistrationStatus('mcp__github__create_issue'),
    ).resolves.toBe('registered');

    await runDiscoveryPass(registry, config);

    // It was not dropped (that path has its own warning) ...
    expect(
      warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('unusable entr')),
    ).toEqual([]);
    // ... and discovery completion adds the existence warning.
    expect(eagerWarnings()).toHaveLength(1);
    expect(eagerWarnings()[0]).toContain('mcp__githb__create_issue');
  });

  it('warns once when a dynamic entry matches no discovered tool', async () => {
    const { config, registry } = makeSession({
      eagerTools: ['mcp__githb__create_issue'],
      registered: ['read_file'],
    });

    await runDiscoveryPass(registry, config);

    expect(eagerWarnings()).toHaveLength(1);
    expect(eagerWarnings()[0]).toContain('mcp__githb__create_issue');
  });

  it('warns on the legacy blocking discovery pass too', async () => {
    const { config, registry } = makeSession({
      eagerTools: ['mcp__githb__create_issue'],
      registered: ['read_file'],
    });

    await runDiscoveryPass(registry, config, 'bulk');

    expect(eagerWarnings()).toHaveLength(1);
  });

  it('warns about a misspelt built-in entry as well', async () => {
    // Same registry-aware check, no `mcp__`-specific branch: a built-in typo
    // is silent on main for the same reason.
    const { config, registry } = makeSession({
      eagerTools: ['read_flie'],
      registered: ['read_file', 'run_shell_command'],
    });

    await runDiscoveryPass(registry, config);

    expect(eagerWarnings()).toHaveLength(1);
    expect(eagerWarnings()[0]).toContain('read_flie');
  });

  it('stays quiet when every entry names a registered tool', async () => {
    const { config, registry } = makeSession({
      eagerTools: ['ReadFile', 'mcp__github__create_issue'],
      registered: ['read_file', 'mcp__github__create_issue'],
    });
    setStatus('github', MCPServerStatus.CONNECTED);

    await runDiscoveryPass(registry, config);

    expect(eagerWarnings()).toEqual([]);
  });

  it('stays quiet for meta-category and alias entries', async () => {
    // `Read` / `Bash` normalise to `read_file` / `run_shell_command` in
    // `initialize()`, and `toolMatchesRuleToolName` expands them over their
    // whole family — `Read` covers `grep_search` even when `read_file` itself
    // is not registered, and `Bash` covers `monitor`. Matching on name
    // equality (a Set of registered names) would report all three as typos.
    const { config, registry } = makeSession({
      eagerTools: ['Read', 'Bash', 'ListFiles'],
      registered: ['grep_search', 'monitor', 'list_directory'],
    });

    await runDiscoveryPass(registry, config);

    expect(eagerWarnings()).toEqual([]);
  });

  it('matches a tool that is only a lazy factory (not warmed yet)', async () => {
    // Built-ins are registered as factories and warmed on first use, so the
    // candidate set has to come from names, not from instantiated tools —
    // otherwise every built-in entry warns before anything is warmed.
    const { config, registry } = makeSession({
      eagerTools: ['ReadFile'],
      registered: ['read_file'],
    });
    // The factory is still unwarmed, so `read_file` exists by name only.
    expect(registry.getAllToolNames()).toContain('read_file');

    await runDiscoveryPass(registry, config);

    expect(eagerWarnings()).toEqual([]);
  });

  it('warns each unmatched entry only once across re-discovery', async () => {
    const { config, registry } = makeSession({
      eagerTools: ['mcp__githb__create_issue', 'read_flie'],
      registered: ['read_file'],
    });

    await runDiscoveryPass(registry, config);
    await runDiscoveryPass(registry, config);
    await runDiscoveryPass(registry, config, 'bulk');

    const messages = eagerWarnings();
    expect(
      messages.filter((m) => m.includes('mcp__githb__create_issue')),
    ).toHaveLength(1);
    expect(messages.filter((m) => m.includes('read_flie'))).toHaveLength(1);
  });

  it('does not re-report entries initialize() already dropped', async () => {
    const { config, registry } = makeSession({
      eagerTools: ['Bash(unbalanced', ''],
      registered: ['read_file'],
    });

    await runDiscoveryPass(registry, config);

    // The dropped-entry warning is the only `tools.eager` output.
    expect(eagerWarnings()).toHaveLength(1);
    expect(eagerWarnings()[0]).toContain('unusable entr');
  });

  it('says nothing when no eager allowlist is active', async () => {
    const { config, registry } = makeSession({
      eagerTools: [],
      registered: ['read_file'],
    });
    // An explicitly empty list IS active and names nothing, but every entry
    // list is empty so there is nothing to be unmatched.
    await runDiscoveryPass(registry, config);
    expect(eagerWarnings()).toEqual([]);
  });

  describe('entries whose MCP server never connected', () => {
    /** Direct calls, so the server-status branch is exercised without spawning a server. */
    async function check(
      session: ReturnType<typeof makeSession>,
    ): Promise<string[]> {
      const { warnOnUnmatchedEagerToolEntries } = await import(
        './eager-allowlist-coverage.js'
      );
      warnOnUnmatchedEagerToolEntries(session.config);
      return warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('tools.eager'));
    }

    it('does not blame the operator for a correctly spelled tool on an unconnected server', async () => {
      const session = makeSession({
        eagerTools: ['mcp__github__create_issue'],
        registered: ['read_file'],
        mcpServers: { github: { command: 'node', args: ['stub-server.js'] } },
      });
      setStatus('github', MCPServerStatus.CONNECTING);

      expect(await check(session)).toEqual([]);
    });

    it('does not blame the operator for a server the client budget refused', async () => {
      const session = makeSession({
        eagerTools: ['mcp__github__create_issue'],
        registered: ['read_file'],
        mcpServers: { github: { command: 'node', args: ['stub-server.js'] } },
      });
      setStatus('github', MCPServerStatus.DISCONNECTED);

      expect(await check(session)).toEqual([]);
    });

    it('still warns when the connected server simply has no such tool', async () => {
      const session = makeSession({
        eagerTools: ['mcp__github__create_isue'],
        registered: ['read_file', 'mcp__github__create_issue'],
        mcpServers: { github: { command: 'node', args: ['stub-server.js'] } },
      });
      setStatus('github', MCPServerStatus.CONNECTED);

      const messages = await check(session);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('mcp__github__create_isue');
    });

    it('warns for an unknown server name — that is a typo, not an outage', async () => {
      const session = makeSession({
        eagerTools: ['mcp__githb__create_issue'],
        registered: ['read_file', 'mcp__github__create_issue'],
        mcpServers: { github: { command: 'node', args: ['stub-server.js'] } },
      });
      setStatus('github', MCPServerStatus.CONNECTED);

      const messages = await check(session);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('mcp__githb__create_issue');
    });

    it('re-checks a suppressed entry on a later pass instead of remembering it as warned', async () => {
      const session = makeSession({
        eagerTools: ['mcp__github__create_isue'],
        registered: ['read_file', 'mcp__github__create_issue'],
        mcpServers: { github: { command: 'node', args: ['stub-server.js'] } },
      });
      setStatus('github', MCPServerStatus.DISCONNECTED);
      expect(await check(session)).toEqual([]);

      // Server comes up on a later pass: the entry is still wrong, so it is
      // reported then — exactly once.
      setStatus('github', MCPServerStatus.CONNECTED);
      expect(await check(session)).toHaveLength(1);
      expect(await check(session)).toHaveLength(1);
    });
  });

  describe('computer_use__* entries', () => {
    it('are left alone: their registration does not share the MCP discovery boundary', async () => {
      const { warnOnUnmatchedEagerToolEntries } = await import(
        './eager-allowlist-coverage.js'
      );
      const session = makeSession({
        eagerTools: ['computer_use__screenshot'],
        registered: ['read_file'],
      });

      warnOnUnmatchedEagerToolEntries(session.config);

      expect(
        warnSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((message) => message.includes('tools.eager')),
      ).toEqual([]);
    });
  });
});
