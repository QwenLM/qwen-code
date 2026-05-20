/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '../config/config.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { DiscoveredMCPPrompt } from './mcp-client.js';
import type { DiscoveredMCPTool } from './mcp-tool.js';
import type { ToolRegistry } from './tool-registry.js';

const debugLogger = createDebugLogger('McpPool:View');

/**
 * Decide whether a tool from a snapshot passes a session's
 * include/exclude filter. Exported for unit-testability and so the
 * future pool/F3 audit path can replay the same predicate.
 *
 * Matches the existing `isEnabled` semantics in `mcp-client.ts` but
 * works against `DiscoveredMCPTool` instead of `FunctionDeclaration`.
 * `excludeTools` wins over `includeTools` when both list the same
 * tool (pre-F2 behavior preserved).
 *
 * `serverToolName` is the bare name as advertised by the MCP server.
 * `includeTools` entries may use either the bare name or a
 * `<name>(<args>)` parenthesized form — the parens form is stripped
 * before comparing (matches `mcp-client.ts:isEnabled` history).
 * `excludeTools` is checked via direct equality — no parens-form
 * support, intentionally matching the existing pre-F2 behavior so
 * operators don't see semantic divergence between the two filter
 * lists when migrating sessions through pool mode.
 */
export function passesSessionFilter(
  tool: DiscoveredMCPTool,
  includeTools?: readonly string[],
  excludeTools?: readonly string[],
): boolean {
  const bareName = tool.serverToolName;
  if (excludeTools?.includes(bareName)) return false;
  if (!includeTools) return true;
  return includeTools.some((entry) => {
    const stripped = entry.includes('(')
      ? entry.slice(0, entry.indexOf('('))
      : entry;
    return stripped === bareName;
  });
}

/**
 * F2 (#4175 commit 6 review fix — wenshao W66): prompt-side analog
 * of `passesSessionFilter`. Same `excludeTools` / `includeTools`
 * semantics applied to the prompt's `name` field. Reuses the
 * `excludeTools` / `includeTools` config keys rather than inventing
 * separate `excludePrompts` / `includePrompts` keys — most operators
 * intuitively want a single filter knob per server, and prompt names
 * rarely collide with tool names. If a future server advertises
 * a prompt + tool with the SAME name and the operator wants to
 * exclude only the tool (not the prompt), they can switch to the
 * parens form `excludeTools: ['toolName(args)']` which only matches
 * tools (the parens-stripping in `passesSessionFilter` matches
 * `toolName` in the include list, not the exclude list).
 */
export function passesSessionPromptFilter(
  promptName: string,
  includeTools?: readonly string[],
  excludeTools?: readonly string[],
): boolean {
  if (excludeTools?.includes(promptName)) return false;
  if (!includeTools) return true;
  return includeTools.some((entry) => {
    const stripped = entry.includes('(')
      ? entry.slice(0, entry.indexOf('('))
      : entry;
    return stripped === promptName;
  });
}

/**
 * Per-session, per-server projection of a pool entry's tool/prompt
 * snapshots into a session's own `ToolRegistry` + `PromptRegistry`.
 *
 * F2 (#4175) commit 2: one shared `McpClient` in the pool produces
 * canonical `toolsSnapshot` / `promptsSnapshot`; N `SessionMcpView`
 * instances each subscribe and call `applyTools` / `applyPrompts`
 * on `toolsChanged` / `promptsChanged` events.
 *
 * Each view:
 *   - Filters by per-session `includeTools` / `excludeTools` (cfg)
 *   - Decorates tools with per-session `trust` via `tool.withTrust(...)`
 *     so two sessions on the same pool entry can have different
 *     trust values without cross-contamination (see §7.1 / V21 C7)
 *   - Registers into the session's own registries (does NOT touch
 *     the pool's snapshot)
 *   - `teardown()` removes all this view's registrations, used on
 *     `/mcp disable`, session close, or `disconnected` event from pool
 */
export class SessionMcpView {
  /**
   * @param sessionToolRegistry The session-owned ToolRegistry; receives
   *   filtered + trust-decorated `DiscoveredMCPTool` instances.
   * @param sessionPromptRegistry The session-owned PromptRegistry;
   *   receives the unfiltered prompt snapshot (prompts have no
   *   per-session filter today — pool fans out the full set).
   * @param sessionId Stamped onto debug logs for cross-session
   *   correlation; not used for routing (pool's reverse index handles that).
   * @param serverName Server name as advertised in the per-session
   *   merged mcpServers map; used as the key into the registries'
   *   `removeMcpToolsByServer` / `removePromptsByServer` cleanup paths.
   * @param cfg The session's view of this server's config, source of
   *   `includeTools` / `excludeTools` / `trust`.
   */
  constructor(
    private readonly sessionToolRegistry: ToolRegistry,
    private readonly sessionPromptRegistry: PromptRegistry,
    readonly sessionId: string,
    readonly serverName: string,
    private cfg: MCPServerConfig,
  ) {}

  /**
   * Replace this session's registered tools for `serverName` with a
   * filtered+decorated copy of `snapshot`. Idempotent: re-apply on
   * `toolsChanged` first removes any prior registration then registers
   * the new set, so a server that hot-removes a tool propagates correctly.
   */
  applyTools(snapshot: readonly DiscoveredMCPTool[]): void {
    this.sessionToolRegistry.removeMcpToolsByServer(this.serverName);
    let registered = 0;
    for (const tool of snapshot) {
      if (
        !passesSessionFilter(tool, this.cfg.includeTools, this.cfg.excludeTools)
      ) {
        continue;
      }
      // V21 C7: per-session trust copy. `withTrust` returns the same
      // instance when value unchanged, so the common case (same trust)
      // pays zero allocation.
      const sessionTool = tool.withTrust(this.cfg.trust);
      this.sessionToolRegistry.registerTool(sessionTool);
      registered += 1;
    }
    // wenshao S3: pre-fix this string contained literal "N" instead
    // of an interpolation; operators saw a meaningless placeholder.
    debugLogger.debug(
      `SessionMcpView[${this.sessionId}/${this.serverName}] applied ${snapshot.length} tools (filtered to ${registered} registered)`,
    );
  }

  /**
   * Replace this session's registered prompts for `serverName` with
   * `snapshot`. Apply the same `excludeTools` / `includeTools`
   * filter the tool path uses (W66 fold-in). Pre-fix prompts were
   * registered unconditionally — a session restricting tools to a
   * subset still received every prompt the server advertised, AND
   * each prompt's bound `invoke` closure over the pool's shared
   * `Client` reached the same server state/credentials as the
   * more-trusted sibling. Now the filter rejects prompts the
   * session has explicitly excluded; un-listed prompts pass when
   * `includeTools` is unset (matching the tool path's lenient default).
   *
   * Note: prompts carry a bound `invoke` closure over the pool's
   * shared `Client`. When the pool reconnects (new client instance),
   * the snapshot is re-emitted via `promptsChanged`, and this method
   * re-registers with the new bound invokes — stale invokes from a
   * prior generation are dropped via `removePromptsByServer`.
   */
  applyPrompts(snapshot: readonly DiscoveredMCPPrompt[]): void {
    this.sessionPromptRegistry.removePromptsByServer(this.serverName);
    let registered = 0;
    for (const prompt of snapshot) {
      if (
        !passesSessionPromptFilter(
          prompt.name,
          this.cfg.includeTools,
          this.cfg.excludeTools,
        )
      ) {
        continue;
      }
      this.sessionPromptRegistry.registerPrompt(prompt);
      registered += 1;
    }
    debugLogger.debug(
      `SessionMcpView[${this.sessionId}/${this.serverName}] applied ${snapshot.length} prompts (filtered to ${registered} registered)`,
    );
  }

  /**
   * Update the session's view of this server's config (e.g. when
   * `/mcp` tweaks `includeTools` at runtime). Re-apply uses the new
   * filter against the most recent snapshot.
   *
   * The caller (typically the `PoolEntry.attach` path or
   * `pool.notifyConfigChanged`) is responsible for invoking
   * `applyTools` / `applyPrompts` with the current snapshot after
   * this update — `SessionMcpView` doesn't cache snapshots itself
   * (single-source-of-truth is the pool entry).
   */
  updateConfig(cfg: MCPServerConfig): void {
    this.cfg = cfg;
  }

  /**
   * Tear down this view's registrations. Called on:
   *   - Session close (full teardown via pool's `releaseSession`)
   *   - `/mcp disable <serverName>` for this session (V21-6 / §10.4)
   *   - Permanent pool entry failure (subscribers should drop the
   *     server from their UI rather than show stale tools)
   *
   * Safe to call multiple times (delegates to idempotent
   * `removeMcpToolsByServer` / `removePromptsByServer`).
   */
  teardown(): void {
    this.sessionToolRegistry.removeMcpToolsByServer(this.serverName);
    this.sessionPromptRegistry.removePromptsByServer(this.serverName);
    debugLogger.debug(
      `SessionMcpView[${this.sessionId}/${this.serverName}] torn down`,
    );
  }
}
