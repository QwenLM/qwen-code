/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The session's opening rule set, assembled from everything that can grant or
 * refuse before the user has said anything: CLI flags, settings files, and the
 * MCP servers' own allowlists.
 *
 * Four inputs, and the interesting one is `coreTools`. It reads as a positive
 * list — "these are the tools I want" — but the module has no such concept: a rule
 * set says what is allowed and what is refused, and a tool with no rule is simply
 * judged on its merits. So a core list has to be turned inside out into a deny for
 * every built-in it leaves out. That inversion is why an empty `coreTools` refuses
 * every built-in tool rather than restricting nothing, and why it has to happen
 * here rather than being checked at call time against a list.
 */

import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
  type PermissionRule,
  type PermissionRules,
} from '../manager/decision/index.js';
import {
  ALL_BUILTIN_TOOL_NAMES,
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  TOOL_PRESETS,
} from '../../tools/tool-names.js';
import { parseToolListFromCLI } from '../../utils/frontmatterParsers.js';
import { isMcpToolName, normalizeMcpRuleName } from '../../mcp/tools/mcp-names.js';
import { buildMcpToolName } from '../../mcp/tools/mcp-tool.js';
import {
  normalizePermissionRuleValue,
  rulesToPermissionRules,
} from './permissionsLoader.js';

export interface StartupRulesOptions {
  /** `--allowed-tools`. Allowed outright, attributed to the flag that said so. */
  allowedTools?: string[];
  /** `--disallowed-tools`. */
  disallowedTools?: string[];
  /**
   * `--tools` / `settings.tools.core`. Only `undefined` means unset — an empty
   * list is a real answer and refuses every built-in tool.
   */
  coreTools?: string[];
  /** Per-server `alwaysAllow` lists from the MCP server configs. */
  mcpServerAlwaysAllow?: Record<string, string[]>;
  /** Rules already read from the settings files, with their own sources. */
  rulesFromSettings?: PermissionRule[];
}

export function permissionRulesFromStartup(
  options: StartupRulesOptions,
): PermissionRules {
  const rules = rulesToPermissionRules(options.rulesFromSettings ?? []);

  const allow = normalize(options.allowedTools);
  const deny = normalize(options.disallowedTools);

  if (options.coreTools !== undefined) {
    const core = normalize(options.coreTools);
    const isPreset = core.some((tool) =>
      (TOOL_PRESETS as readonly string[]).includes(tool.toLowerCase()),
    );
    // A preset names the whole built-in set, so it restricts nothing.
    if (!isPreset) {
      const kept = new Set(core);
      // CodeMode's asynchronous results require its companion. Expand only
      // the implicit allowlist; explicit disallowedTools still take precedence.
      if (kept.has(CODE_MODE_TOOL_NAME)) {
        kept.add(CODE_MODE_WAIT_TOOL_NAME);
      }
      deny.push(
        ...ALL_BUILTIN_TOOL_NAMES.filter((tool) => !kept.has(tool)),
      );
    }
  }

  if (allow.length > 0) {
    rules.allow.cliArg = [...(rules.allow.cliArg ?? []), ...allow];
  }
  if (deny.length > 0) {
    rules.deny.cliArg = [...(rules.deny.cliArg ?? []), ...deny];
  }

  // A server's own allowlist is written into its config, so it is attributed to
  // local settings rather than to a flag.
  const mcpAllow = qualifiedMcpNames(options.mcpServerAlwaysAllow);
  if (mcpAllow.length > 0) {
    rules.allow.localSettings = [
      ...(rules.allow.localSettings ?? []),
      ...mcpAllow,
    ];
  }

  return rules;
}

/**
 * Round-trip each entry through the rule parser so a flag and a settings file
 * that mean the same thing are stored identically. Without it `Bash(ls:*)` from a
 * flag and the same rule from disk would not compare equal, and the dialog would
 * offer to add a rule that is already there.
 */
function normalize(tools: string[] | undefined): string[] {
  if (!tools || tools.length === 0) return [];
  return parseToolListFromCLI(tools).map((rule) =>
    permissionRuleValueToString(
      normalizePermissionRuleValue(permissionRuleValueFromString(rule)),
    ),
  );
}

function qualifiedMcpNames(
  alwaysAllow: Record<string, string[]> | undefined,
): string[] {
  if (!alwaysAllow) return [];
  const names: string[] = [];
  for (const [serverName, toolNames] of Object.entries(alwaysAllow)) {
    for (const toolName of toolNames) {
      names.push(
        isMcpToolName(toolName)
          ? normalizeMcpRuleName(toolName)
          : buildMcpToolName(serverName, toolName),
      );
    }
  }
  return names;
}
