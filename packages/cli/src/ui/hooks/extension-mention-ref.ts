/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import {
  MAX_SUGGESTIONS_TO_SHOW,
  type Suggestion,
} from '../utils/suggestions.js';
import { t } from '../../i18n/index.js';
export {
  EXTENSION_REF_PREFIX,
  parseExtensionRef,
  buildExtensionRef,
  matchExtensionByRef,
  sanitizeDisplayText,
  buildExtensionContextText,
} from '../../utils/extension-mention.js';
import {
  buildExtensionRef,
  sanitizeDisplayText,
} from '../../utils/extension-mention.js';

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
    .map((ext) => ({
      ext,
      safeLabel: sanitizeDisplayText(ext.displayName || ext.name) || ext.name,
    }))
    .filter(({ safeLabel, ext }) => {
      const label = safeLabel.toLowerCase();
      const name = ext.name.toLowerCase();
      return label.includes(query) || name.includes(query);
    })
    .sort((a, b) => {
      const aName = a.safeLabel.toLowerCase();
      const bName = b.safeLabel.toLowerCase();
      const aPrefix = aName.startsWith(query) ? 0 : 1;
      const bPrefix = bName.startsWith(query) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      return aName.localeCompare(bName);
    })
    .slice(0, MAX_SUGGESTIONS_TO_SHOW)
    .map(({ ext, safeLabel }) => ({
      label: safeLabel,
      value: buildExtensionRef(ext.name),
      description: ext.config.description
        ? (sanitizeDisplayText(ext.config.description) ?? undefined)
        : undefined,
      sourceBadge: t('Extension'),
      isDirectory: false,
      category: 'extension' as const,
    }));
}
