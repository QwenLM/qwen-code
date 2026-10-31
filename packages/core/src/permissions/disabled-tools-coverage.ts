/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { resolveToolName, toolMatchesRuleToolName } from './rule-parser.js';

/**
 * Post-discovery existence check for `settings.tools.disabled` (#15752).
 *
 * The setting removes tools by exact-name membership at registration, so one
 * misspelt entry (`run_shel_command`) leaves the real tool registered and
 * callable while the operator believes it is gone. Nothing reports that: the
 * name is accepted at boot, `/tools` lists only what exists, and the debug log
 * that might have said something is off in default runs.
 *
 * The check runs at the end of a discovery pass — MCP tools and the runtime
 * surface are settled by then, the same boundary and for the same reason
 * `tools.eager` is checked (#12435).
 */

/**
 * Per-session warn-once ledger, keyed by `Config` so a re-discovery
 * (`/mcp reconnect`, a hot-reload reconcile, a second startup pass) does not
 * repeat a warning the operator has already seen. A `WeakMap` keeps it off the
 * global scope and lets it die with the session.
 */
const warnedEntriesByConfig = new WeakMap<Config, Set<string>>();

/**
 * The generated cua-driver surface is not part of the tool registry at the MCP
 * discovery boundary, so there is no reliable candidate set to check these
 * entries against. Reporting them would be a guaranteed false positive; the
 * same suppression `tools.eager` applies.
 */
const COMPUTER_USE_PREFIX = 'computer_use__';

const MCP_PREFIX = 'mcp__';

/**
 * Whether an entry names a tool on an MCP server the operator configured.
 *
 * A disabled MCP tool never registers either — registration refuses it — so
 * the registry cannot confirm that such an entry exists. Only an entry whose
 * server is not configured at all is a definite mistake; anything on a
 * configured server stays quiet, because a typo there is indistinguishable
 * from a name that was removed from the server's tool list.
 */
function namesConfiguredMcpServer(config: Config, entry: string): boolean {
  if (!entry.startsWith(MCP_PREFIX)) {
    return false;
  }
  const serverName = entry.slice(MCP_PREFIX.length).split('__')[0];
  if (!serverName) {
    return false;
  }
  const servers = config.getMcpServers() ?? {};
  return Object.prototype.hasOwnProperty.call(servers, serverName);
}

/**
 * Report every `tools.disabled` entry that names no tool the build knows
 * about, once per entry per session. Never throws: a diagnostic must not be
 * able to fail discovery.
 */
export function warnOnUnmatchedDisabledToolEntries(config: Config): void {
  try {
    const disabled = config.getDisabledTools();
    if (disabled.size === 0) {
      return;
    }
    // A disabled tool never reaches the registry, so the canonical name
    // catalog is the only source that still knows the built-ins exist.
    const knownNames = new Set<string>(Object.values(ToolNames));

    let warned = warnedEntriesByConfig.get(config);
    if (!warned) {
      warned = new Set<string>();
      warnedEntriesByConfig.set(config, warned);
    }

    for (const entry of disabled) {
      if (warned.has(entry) || entry.startsWith(COMPUTER_USE_PREFIX)) {
        continue;
      }
      if (namesConfiguredMcpServer(config, entry)) {
        continue;
      }
      // `Bash`, `Read`, `Write` and the rest of the alias set are legitimate
      // entries the registry accepts, so they resolve before the comparison.
      if (knownNames.has(resolveToolName(entry))) {
        continue;
      }
      if (
        Array.from(knownNames).some((name) =>
          toolMatchesRuleToolName(entry, name),
        )
      ) {
        continue;
      }
      warned.add(entry);
      // eslint-disable-next-line no-console -- operator-facing breadcrumb; the debug log file is off in default runs, where a dropped tool name would otherwise be invisible
      console.warn(
        `tools.disabled: "${entry}" matches no known tool, so it disables ` +
          `nothing and the tool it was meant to remove is still available. ` +
          `Check the spelling or drop the entry.`,
      );
    }
  } catch {
    // A diagnostic must never be able to fail discovery.
  }
}
