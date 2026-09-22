/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { getMCPServerStatus, MCPServerStatus } from '../tools/mcp-status.js';
import { parseRule, toolMatchesRuleToolName } from './rule-parser.js';

/**
 * Post-discovery existence check for `settings.tools.eager` (#12435).
 *
 * `PermissionManager.initialize()` only shape-checks the allowlist: an entry
 * that parses cleanly is kept even when it names no tool, and because the
 * allowlist demotes every non-exempt tool it does not name, one misspelt
 * dynamic entry (`mcp__githb__create_issue`) silently shrinks the whole eager
 * tool surface. The check cannot run in `initialize()` — MCP tools are
 * discovered afterwards, so anything dynamic would look unmatched — so it runs
 * at the end of a discovery pass instead, when the registry is settled.
 *
 * Matching deliberately mirrors `getToolRegistrationStatus`: the same
 * `toolMatchesRuleToolName` against canonical registered names, so an entry
 * that keeps a tool eager is never reported and a meta-category (`Read`,
 * `Bash`) or alias (`ReadFile`) is never mistaken for a typo. Set membership
 * over instantiated tools would false-positive on both, and would also miss
 * built-ins that are still unwarmed lazy factories.
 */

const MCP_PREFIX = 'mcp__';

/**
 * The generated cua-driver surface is not part of the tool registry at the
 * MCP discovery boundary, so there is no reliable candidate set to check
 * these entries against. Reporting them would be a guaranteed false
 * positive; staying quiet costs one undetected typo.
 */
const COMPUTER_USE_PREFIX = 'computer_use__';

/**
 * Per-session warn-once ledger. Keyed by `Config` (one per session) so a
 * re-discovery — `/mcp reconnect`, an MCP hot-reload reconcile, a second
 * startup pass — does not repeat a warning the operator has already seen.
 * A `WeakMap` keeps it off the global scope and lets it die with the session.
 */
const warnedEntriesByConfig = new WeakMap<Config, Set<string>>();

/**
 * The allowlist entries `PermissionManager.initialize()` kept, re-derived with
 * the same shape filter it applies. Entries it dropped are skipped: they are
 * already reported by its own "unusable entries" warning, and reporting them
 * again here would double up on one mistake.
 */
function keptEagerEntries(config: Config): string[] {
  const entries: string[] = [];
  for (const raw of config.getEagerTools() ?? []) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      continue;
    }
    const rule = parseRule(raw);
    if (rule.invalid) {
      continue;
    }
    entries.push(rule.toolName);
  }
  return entries;
}

/**
 * Whether an entry names a tool on a configured MCP server that is not
 * connected (refused by the client budget, failed handshake, disabled, still
 * connecting). That is an infrastructure outcome, not a spelling mistake, so
 * it must not be reported as "no such tool" — the operator would go fix a
 * config that is already correct. An entry whose server is not configured at
 * all is a typo and stays reportable.
 *
 * Suppression is not remembered in the warn-once ledger, so a later pass —
 * once the server is up — still reports the entry if it turns out to be wrong.
 */
function isOnUnconnectedServer(config: Config, entry: string): boolean {
  if (!entry.startsWith(MCP_PREFIX)) {
    return false;
  }
  const serverName = entry.slice(MCP_PREFIX.length).split('__')[0];
  if (serverName === '') {
    return false;
  }
  const servers = config.getMcpServers() ?? {};
  if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
    return false;
  }
  return getMCPServerStatus(serverName) !== MCPServerStatus.CONNECTED;
}

/**
 * Report every active `tools.eager` entry that matches no registered tool,
 * once per entry per session. Called at the end of an MCP discovery pass;
 * never throws, because a diagnostic must not be able to fail discovery.
 */
export function warnOnUnmatchedEagerToolEntries(config: Config): void {
  try {
    if (!config.getPermissionManager()?.isEagerToolAllowListActive()) {
      return;
    }
    const registry = config.getToolRegistry();
    if (!registry) {
      return;
    }
    const entries = keptEagerEntries(config);
    if (entries.length === 0) {
      return;
    }
    // Canonical names, including tools that are still unwarmed factories.
    const registeredNames = registry.getAllToolNames();

    let warned = warnedEntriesByConfig.get(config);
    if (!warned) {
      warned = new Set<string>();
      warnedEntriesByConfig.set(config, warned);
    }

    for (const entry of entries) {
      if (warned.has(entry) || entry.startsWith(COMPUTER_USE_PREFIX)) {
        continue;
      }
      if (isOnUnconnectedServer(config, entry)) {
        continue;
      }
      if (
        registeredNames.some((name) => toolMatchesRuleToolName(entry, name))
      ) {
        continue;
      }
      warned.add(entry);
      // eslint-disable-next-line no-console -- operator-facing breadcrumb; the debug log file is off in default runs, where this reshaping would otherwise be invisible
      console.warn(
        `tools.eager: "${entry}" matches no discovered tool, so it keeps ` +
          `nothing eager and every other non-exempt tool stays deferred to ` +
          `tool_search. Check the spelling or drop the entry.`,
      );
    }
  } catch {
    // Diagnostics only: never let this surface into a discovery failure.
  }
}
