/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyDeclarativeTool, AnyToolInvocation } from '../index.js';
import { isTool } from '../index.js';
import {
  ToolNames,
  ToolDisplayNames,
  ToolNamesMigration,
  ToolDisplayNamesMigration,
} from '../tools/tool-names.js';

export type ToolName = (typeof ToolNames)[keyof typeof ToolNames];

const normalizeIdentifier = (identifier: string): string =>
  identifier.trim().replace(/^_+/, '');

const toolNameKeys = Object.keys(ToolNames) as Array<keyof typeof ToolNames>;

const TOOL_ALIAS_MAP: Map<ToolName, Set<string>> = (() => {
  const map = new Map<ToolName, Set<string>>();

  const addAlias = (set: Set<string>, alias?: string) => {
    if (!alias) {
      return;
    }
    set.add(normalizeIdentifier(alias));
  };

  for (const key of toolNameKeys) {
    const canonicalName = ToolNames[key];
    const displayName = ToolDisplayNames[key];
    const aliases = new Set<string>();

    addAlias(aliases, canonicalName);
    addAlias(aliases, displayName);
    addAlias(aliases, `${displayName}Tool`);

    for (const [legacyName, mappedName] of Object.entries(ToolNamesMigration)) {
      if (mappedName === canonicalName) {
        addAlias(aliases, legacyName);
      }
    }

    for (const [legacyDisplay, mappedDisplay] of Object.entries(
      ToolDisplayNamesMigration,
    )) {
      if (mappedDisplay === displayName) {
        addAlias(aliases, legacyDisplay);
      }
    }

    map.set(canonicalName, aliases);
  }

  return map;
})();

const getAliasSetForTool = (toolName: ToolName): Set<string> => {
  const aliases = TOOL_ALIAS_MAP.get(toolName);
  if (!aliases) {
    return new Set([normalizeIdentifier(toolName)]);
  }
  return aliases;
};

const sanitizeExactIdentifier = (value: string): string =>
  normalizeIdentifier(value);

const sanitizePatternIdentifier = (value: string): string => {
  const openParenIndex = value.indexOf('(');
  if (openParenIndex === -1) {
    return normalizeIdentifier(value);
  }
  return normalizeIdentifier(value.slice(0, openParenIndex));
};

const filterList = (list?: string[]): string[] =>
  (list ?? []).filter((entry): entry is string =>
    Boolean(entry && entry.trim()),
  );

export function isToolEnabled(
  toolName: ToolName,
  coreTools?: string[],
  excludeTools?: string[],
): boolean {
  const aliasSet = getAliasSetForTool(toolName);
  const matchesIdentifier = (value: string): boolean =>
    aliasSet.has(sanitizeExactIdentifier(value));
  const matchesIdentifierWithArgs = (value: string): boolean =>
    aliasSet.has(sanitizePatternIdentifier(value));

  const filteredCore = filterList(coreTools);
  const filteredExclude = filterList(excludeTools);

  if (filteredCore.length === 0) {
    return !filteredExclude.some((entry) => matchesIdentifier(entry));
  }

  const isExplicitlyEnabled = filteredCore.some(
    (entry) => matchesIdentifier(entry) || matchesIdentifierWithArgs(entry),
  );

  if (!isExplicitlyEnabled) {
    return false;
  }

  return !filteredExclude.some((entry) => matchesIdentifier(entry));
}

const SHELL_TOOL_NAMES = ['run_shell_command', 'ShellTool'];

/**
 * Checks if a tool invocation matches any of a list of patterns.
 *
 * @param toolOrToolName The tool object or the name of the tool being invoked.
 * @param invocation The invocation object for the tool.
 * @param patterns A list of patterns to match against.
 *   Patterns can be:
 *   - A tool name (e.g., "ReadFileTool") to match any invocation of that tool.
 *   - A tool name with a prefix (e.g., "ShellTool(git status)") to match
 *     invocations where the arguments start with that prefix.
 * @returns True if the invocation matches any pattern, false otherwise.
 */
export function doesToolInvocationMatch(
  toolOrToolName: AnyDeclarativeTool | string,
  invocation: AnyToolInvocation,
  patterns: string[],
): boolean {
  let toolNames: string[];
  if (isTool(toolOrToolName)) {
    toolNames = [toolOrToolName.name, toolOrToolName.constructor.name];
  } else {
    toolNames = [toolOrToolName as string];
  }

  if (toolNames.some((name) => SHELL_TOOL_NAMES.includes(name))) {
    toolNames = [...new Set([...toolNames, ...SHELL_TOOL_NAMES])];
  }

  for (const pattern of patterns) {
    const openParen = pattern.indexOf('(');

    if (openParen === -1) {
      // No arguments, just a tool name
      if (toolNames.includes(pattern)) {
        return true;
      }
      continue;
    }

    const patternToolName = pattern.substring(0, openParen);
    if (!toolNames.includes(patternToolName)) {
      continue;
    }

    if (!pattern.endsWith(')')) {
      continue;
    }

    const argPattern = pattern.substring(openParen + 1, pattern.length - 1);

    if (
      'command' in invocation.params &&
      toolNames.includes('run_shell_command')
    ) {
      const argValue = String(
        (invocation.params as { command: string }).command,
      );
      if (argValue === argPattern || argValue.startsWith(argPattern + ' ')) {
        return true;
      }
    }
  }

  return false;
}
