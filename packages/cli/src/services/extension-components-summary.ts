/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Extension } from '@qwen-code/qwen-code-core';
import { t } from '../i18n/index.js';

/**
 * One-line summary of what an extension ships, for the extension detail
 * views. The Ink view and the OpenTUI dialog both call this, so the two
 * surfaces cannot drift apart.
 */
export function extensionComponentsSummary(extension: Extension): string {
  const parts: string[] = [];
  const mcpCount = extension.mcpServers
    ? Object.keys(extension.mcpServers).length
    : 0;
  if (mcpCount) parts.push(t('{{count}} MCP', { count: String(mcpCount) }));
  if (extension.skills?.length)
    parts.push(
      t('{{count}} Skills', { count: String(extension.skills.length) }),
    );
  if (extension.commands?.length)
    parts.push(
      t('{{count}} Commands', { count: String(extension.commands.length) }),
    );
  if (extension.agents?.length)
    parts.push(
      t('{{count}} Agents', { count: String(extension.agents.length) }),
    );
  if (extension.workflows?.length)
    parts.push(
      t('{{count}} Workflows', { count: String(extension.workflows.length) }),
    );
  return parts.length ? parts.join(' · ') : t('None');
}
