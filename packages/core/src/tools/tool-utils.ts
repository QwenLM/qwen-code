/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolNames,
  ToolDisplayNames,
  ToolNamesMigration,
  ToolDisplayNamesMigration,
} from './tool-names.js';

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

export const getAliasSetForTool = (toolName: string): Set<string> => {
  const aliases = TOOL_ALIAS_MAP.get(toolName as ToolName);
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
