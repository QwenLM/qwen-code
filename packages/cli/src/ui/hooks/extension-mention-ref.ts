/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type Extension,
  stripTerminalControlSequences,
} from '@qwen-code/qwen-code-core';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import { MAX_SUGGESTIONS_TO_SHOW } from '../components/SuggestionsDisplay.js';
import { t } from '../../i18n/index.js';

/**
 * Prefix used for extension mention references. When the user selects an
 * extension from the `@` autocomplete, the inserted value is `ext:<name>`.
 * This prefix disambiguates extension mentions from file paths and MCP
 * resource references at parse time.
 */
export const EXTENSION_REF_PREFIX = 'ext:';

/**
 * Parses an `ext:<name>` reference string. Returns the extension name
 * portion if the input starts with the extension prefix, or `null` otherwise.
 */
export function parseExtensionRef(pathName: string): { name: string } | null {
  if (!pathName.startsWith(EXTENSION_REF_PREFIX)) return null;
  const name = pathName.slice(EXTENSION_REF_PREFIX.length);
  if (!name) return null;
  return { name };
}

/**
 * Builds the canonical `ext:<name>` reference string for an extension.
 */
export function buildExtensionRef(extensionName: string): string {
  return `${EXTENSION_REF_PREFIX}${extensionName}`;
}

/**
 * Case-insensitive match of an extension name against a list of extensions.
 * Matches against `extension.name` and `extension.config.name` (the canonical
 * slugs). `displayName` is intentionally excluded: it often contains spaces
 * which the `@`-path parser truncates at, so matching would be unreliable.
 */
export function matchExtensionByRef(
  name: string,
  extensions: Extension[],
): Extension | undefined {
  const lower = name.toLowerCase();
  return extensions.find(
    (ext) =>
      ext.name.toLowerCase() === lower ||
      ext.config.name.toLowerCase() === lower,
  );
}

/**
 * Returns autocomplete suggestions for extensions matching the given pattern.
 * Unlike MCP server suggestions (which require a non-empty pattern to avoid
 * flooding), extensions show on bare `@` because their count is typically small.
 */
export function getExtensionSuggestions(
  config: Config | undefined,
  pattern: string,
): Suggestion[] {
  if (!config) return [];
  if (config.isTrustedFolder?.() === false) return [];
  const extensions = config.getActiveExtensions?.() ?? [];
  if (extensions.length === 0) return [];

  const query = pattern.toLowerCase();
  return extensions
    .filter((ext) => {
      const displayName = (ext.displayName || ext.name).toLowerCase();
      const name = ext.name.toLowerCase();
      return displayName.includes(query) || name.includes(query);
    })
    .sort((a, b) => {
      const aName = (a.displayName || a.name).toLowerCase();
      const bName = (b.displayName || b.name).toLowerCase();
      const aPrefix = aName.startsWith(query) ? 0 : 1;
      const bPrefix = bName.startsWith(query) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      return aName.localeCompare(bName);
    })
    .slice(0, MAX_SUGGESTIONS_TO_SHOW)
    .map((ext) => ({
      label: stripTerminalControlSequences(ext.displayName || ext.name),
      value: buildExtensionRef(ext.name),
      description: ext.config.description
        ? stripTerminalControlSequences(ext.config.description)
        : undefined,
      sourceBadge: t('Extension'),
      isDirectory: false,
    }));
}

/**
 * Builds a structured context text block for an extension that has been
 * @-mentioned. This text is injected into the user message so the model
 * knows about the extension's capabilities.
 */
export function buildExtensionContextText(extension: Extension): string {
  const displayName = extension.displayName || extension.name;
  const lines: string[] = [];

  lines.push(
    `--- Extension: ${displayName} (untrusted third-party content) ---`,
  );
  if (extension.config.description) {
    lines.push(extension.config.description);
    lines.push('');
  }

  const capabilities: string[] = [];

  // Skills
  if (extension.skills && extension.skills.length > 0) {
    const skillNames = extension.skills.map((s) => s.name).join(', ');
    capabilities.push(`- Skills: ${skillNames} (invoke via /<skill-name>)`);
  }

  // MCP Servers
  if (extension.mcpServers && Object.keys(extension.mcpServers).length > 0) {
    const serverNames = Object.keys(extension.mcpServers).join(', ');
    capabilities.push(`- MCP Servers: ${serverNames}`);
  }

  // Agents
  if (extension.agents && extension.agents.length > 0) {
    const agentNames = extension.agents.map((a) => a.name).join(', ');
    capabilities.push(`- Agents: ${agentNames}`);
  }

  if (capabilities.length > 0) {
    lines.push('Available capabilities from this extension:');
    lines.push(...capabilities);
    lines.push('');
  }

  lines.push(`--- End Extension: ${displayName} ---`);

  return lines.join('\n');
}
