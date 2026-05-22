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
 * F2 (#4175 commit 6 review fix — wenshao W12 / PR A; PR-A-R2 #2
 * folded the exports to delegate here): precompute lookup `Set`s
 * once per `applyTools` / `applyPrompts` pass so the per-tool
 * predicate is O(1) instead of repeating an array scan for every
 * snapshot entry. Same semantics: `excludeTools` is direct-equality
 * match (parens form not stripped — intentional pre-F2 behavior
 * preserved); `includeTools` strips the first `(...)` suffix so
 * `toolName(args)` matches `toolName`.
 *
 * PR-A-R2 #2: `passesSessionFilter` / `passesSessionPromptFilter`
 * (exported below for unit-testability) now route THROUGH
 * `compiledFilterAccepts(compileNameFilter(...))` so there is a
 * single source of truth for the predicate. Pre-fix the exports
 * called a separate `passesNameFilter` array-based implementation
 * with the same semantics, creating a drift risk where a future
 * change to one impl wouldn't be caught by tests of the other.
 * The Set construction is per-call for these exports (cheap for
 * tests / one-off probes); the bulk paths in
 * `applyTools`/`applyPrompts` still construct ONE filter per pass.
 */
interface CompiledNameFilter {
  excludeSet?: ReadonlySet<string>;
  includeSet?: ReadonlySet<string>;
}

function compileNameFilter(
  includeTools?: readonly string[],
  excludeTools?: readonly string[],
): CompiledNameFilter {
  return {
    excludeSet: excludeTools ? new Set(excludeTools) : undefined,
    includeSet: includeTools
      ? new Set(
          includeTools.map((entry) =>
            entry.includes('(') ? entry.slice(0, entry.indexOf('(')) : entry,
          ),
        )
      : undefined,
  };
}

function compiledFilterAccepts(
  filter: CompiledNameFilter,
  name: string,
): boolean {
  if (filter.excludeSet?.has(name)) return false;
  if (!filter.includeSet) return true;
  return filter.includeSet.has(name);
}

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
 *
 * PR-A-R2 #2: routes through `compiledFilterAccepts(compileNameFilter(...))`
 * so the bulk-path predicate and the exported per-name predicate
 * share one implementation. Set construction is paid per call here
 * (negligible for unit tests / one-off audit-path probes).
 */
export function passesSessionFilter(
  tool: DiscoveredMCPTool,
  includeTools?: readonly string[],
  excludeTools?: readonly string[],
): boolean {
  return compiledFilterAccepts(
    compileNameFilter(includeTools, excludeTools),
    tool.serverToolName,
  );
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
 *
 * PR-A-R2 #2: same delegation to the compiled path as
 * `passesSessionFilter`.
 */
export function passesSessionPromptFilter(
  promptName: string,
  includeTools?: readonly string[],
  excludeTools?: readonly string[],
): boolean {
  return compiledFilterAccepts(
    compileNameFilter(includeTools, excludeTools),
    promptName,
  );
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
    // W12/PR A: precompute filter Sets once per pass so the per-tool
    // predicate is O(1). Pre-fix `passesSessionFilter` re-scanned the
    // includeTools / excludeTools arrays inside every iteration —
    // O(M tools × N filter entries) per pass. Same semantics applied.
    const filter = compileNameFilter(
      this.cfg.includeTools,
      this.cfg.excludeTools,
    );
    let registered = 0;
    for (const tool of snapshot) {
      if (!compiledFilterAccepts(filter, tool.serverToolName)) {
        continue;
      }
      // V21 C7: per-session trust copy. `withTrust` returns the same
      // instance when value unchanged, so the common case (same trust)
      // pays zero allocation.
      const sessionTool = tool.withTrust(this.cfg.trust);
      try {
        this.sessionToolRegistry.registerTool(sessionTool);
        registered += 1;
      } catch (err) {
        debugLogger.error(
          `SessionMcpView[${this.sessionId}/${this.serverName}] failed to register tool ${tool.serverToolName}: ${String(
            err instanceof Error ? err.message : err,
          )}`,
        );
      }
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
    // W12/PR A: same Set precompute as applyTools.
    const filter = compileNameFilter(
      this.cfg.includeTools,
      this.cfg.excludeTools,
    );
    let registered = 0;
    for (const prompt of snapshot) {
      if (!compiledFilterAccepts(filter, prompt.name)) {
        continue;
      }
      try {
        this.sessionPromptRegistry.registerPrompt(prompt);
        registered += 1;
      } catch (err) {
        debugLogger.error(
          `SessionMcpView[${this.sessionId}/${this.serverName}] failed to register prompt ${prompt.name}: ${String(
            err instanceof Error ? err.message : err,
          )}`,
        );
      }
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
