/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DiscoveredMCPTool } from '../mcp/tools/mcp-tool.js';
import { normalizeMcpSegment } from '../mcp/tools/mcp-names.js';
import { MCP_CALL_TOOL_NAME } from './mcp-lazy/constants.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AnyDeclarativeTool } from './tools.js';
import {
  BASH_INPUT_TOOL_NAME,
  MONITOR_TOOL_NAME,
  SHELL_TOOL_NAME,
  getToolAliases,
  resolveToolName,
} from './tool-names.js';
import { runLogger } from '../utils/runLogger.js';

/** Execution-local narrowing; never changes an agent definition or Config. */
export interface AgentToolConstraints {
  disallowedTools?: string[];
  bashCommandClamp?: string[];
  requiredTools?: string[];
}

export function normalizeAgentToolConstraints(input: {
  disallowedTools?: unknown;
  bashCommandClamp?: unknown;
}): Pick<AgentToolConstraints, 'disallowedTools' | 'bashCommandClamp'> {
  const normalize = (value: unknown, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.some(
        (entry) =>
          typeof entry !== 'string' || !entry || entry !== entry.trim(),
      )
    ) {
      throw new TypeError(
        `agent() opts.${name} must be an array of non-empty strings without surrounding whitespace. Spawn refused.`,
      );
    }
    return value.length ? [...new Set(value as string[])].sort() : undefined;
  };
  const disallowedTools = normalize(input.disallowedTools, 'disallowedTools');
  const bashCommandClamp = normalize(
    input.bashCommandClamp,
    'bashCommandClamp',
  );
  for (const entry of bashCommandClamp ?? []) {
    const match = /^Bash\((.+)\)$/s.exec(entry);
    if (!match || !match[1].trim() || match[1] !== match[1].trim()) {
      throw new TypeError(
        `agent() opts.bashCommandClamp entry '${entry}' must be a Bash(<command or prefix>) rule with non-empty, unpadded content. Spawn refused.`,
      );
    }
  }
  return { disallowedTools, bashCommandClamp };
}

function ruleToolName(rule: string): string {
  return /^(.*?)\(.*\)$/s.exec(rule)?.[1] ?? rule;
}

export function agentToolDenyMatches(rule: string, name: string): boolean {
  const denied = resolveToolName(ruleToolName(rule));
  if (denied === resolveToolName(name)) return true;
  if (!name.startsWith('mcp__') || !denied.startsWith('mcp__')) return false;
  if (denied === 'mcp__*' || denied === 'mcp__*__*') return true;
  const server = denied.slice(5).split('__');
  return (
    (server.length === 1 || server[1] === '*') &&
    name.startsWith(`mcp__${server[0]}__`)
  );
}

/** Validate against the discovered pool before removing anything from it. */
function validateDeny(rule: string, names: string[]): void {
  const name = ruleToolName(rule);
  if (!name || /[\s()]/.test(name)) {
    throw new TypeError(
      `agent() opts.disallowedTools entry '${rule}' has an unparseable tool name. Spawn refused.`,
    );
  }
  let normalizedMcp: string | undefined;
  if (/^mcp__/i.test(name)) {
    const parts = name.slice(5).split('__');
    if (
      parts.length > 2 ||
      !parts[0] ||
      parts[1] === '' ||
      parts.some((part) => part.includes('*') && part !== '*')
    ) {
      throw new TypeError(
        `agent() opts.disallowedTools entry '${rule}' is not an MCP tool/server name. Use mcp__*, mcp__server, mcp__server__*, or an exact tool name. Spawn refused.`,
      );
    }
    normalizedMcp = `mcp__${parts.map((part) => (part === '*' ? part : normalizeMcpSegment(part))).join('__')}`;
  } else if (name.includes('*')) {
    throw new TypeError(
      `agent() opts.disallowedTools entry '${rule}' uses a wildcard outside an MCP server specification. Spawn refused.`,
    );
  }
  if (names.some((candidate) => agentToolDenyMatches(rule, candidate))) return;
  const corrected =
    names.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ??
    (normalizedMcp &&
    names.some((candidate) =>
      agentToolDenyMatches(
        normalizedMcp.toLowerCase(),
        candidate.toLowerCase(),
      ),
    )
      ? normalizedMcp
      : undefined);
  if (corrected) {
    throw new TypeError(
      `agent() opts.disallowedTools entry '${rule}' does not match the tool pool; check case and normalized spelling ('${corrected}'). Spawn refused.`,
    );
  }
  runLogger.debug(
    `agent() disallowedTools '${rule}' matches no tool in this session's pool; the deny is a no-op here.`,
  );
}

function toolConstraintNames(tool: AnyDeclarativeTool): string[] {
  return tool instanceof DiscoveredMCPTool
    ? [
        tool.name,
        tool.getFullyQualifiedName(),
        ...(tool.exposedName ? [tool.exposedName] : []),
      ]
    : getToolAliases(tool.name);
}

/** Snapshot the caller/discovered pool before an agent definition narrows it. */
export function getAgentToolConstraintNames(
  tools: readonly AnyDeclarativeTool[],
): string[] {
  return tools.flatMap(toolConstraintNames);
}

/** Returns denies for the permission boundary, including model-facing MCP aliases. */
export function applyAgentToolConstraints(
  registry: ToolRegistry,
  constraints: AgentToolConstraints,
  definitionDenies: readonly string[] = [],
  lazyMcpToolNames: readonly string[] = [],
  validationToolNames?: readonly string[],
): string[] {
  const normalized = normalizeAgentToolConstraints(constraints);
  const tools = registry.getAllKnownTools().map((tool) => ({
    tool,
    names: toolConstraintNames(tool),
  }));
  const names = [
    ...(validationToolNames ?? tools.flatMap((entry) => entry.names)),
    ...lazyMcpToolNames,
    'Skill',
    'StructuredOutput',
  ];
  if (
    normalized.bashCommandClamp?.length &&
    tools.some(
      (entry) =>
        entry.tool instanceof DiscoveredMCPTool &&
        entry.names.includes(SHELL_TOOL_NAME),
    )
  ) {
    throw new Error(
      'agent() opts.bashCommandClamp cannot bind under an MCP Bash alias. Spawn refused.',
    );
  }
  for (const rule of normalized.disallowedTools ?? [])
    validateDeny(rule, names);
  const narrowed = !!(
    normalized.disallowedTools?.length || normalized.bashCommandClamp?.length
  );
  const denies = [
    ...(normalized.disallowedTools ?? []),
    ...(narrowed ? ['REPL'] : []),
    // These host surfaces can execute outside Bash's command permission path.
    ...(normalized.bashCommandClamp?.length
      ? ['mcp__*', 'PowerShell', MONITOR_TOOL_NAME, BASH_INPUT_TOOL_NAME]
      : []),
  ];
  if (
    denies.some((rule) => ['mcp__*', 'mcp__*__*'].includes(ruleToolName(rule)))
  ) {
    denies.push(MCP_CALL_TOOL_NAME);
  }
  for (const required of constraints.requiredTools ?? []) {
    if (
      [...definitionDenies, ...denies].some((rule) =>
        agentToolDenyMatches(rule, required),
      )
    ) {
      throw new Error(
        `agent() schema mode needs ${required}, but the spawn's merged disallowedTools deny it. Spawn refused.`,
      );
    }
  }
  for (const entry of tools) {
    if (
      entry.names.some((name) =>
        denies.some((rule) => agentToolDenyMatches(rule, name)),
      )
    ) {
      registry.unregisterTool(entry.tool.name);
      denies.push(...entry.names);
    }
  }
  if (
    normalized.bashCommandClamp?.length &&
    !registry.getTool(SHELL_TOOL_NAME)
  ) {
    throw new Error(
      'agent() opts.bashCommandClamp cannot bind: the resolved tool pool has no Bash. Drop the clamp or the Bash deny. Spawn refused.',
    );
  }
  return [...new Set(denies)];
}
