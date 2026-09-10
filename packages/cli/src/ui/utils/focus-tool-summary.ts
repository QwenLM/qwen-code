/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../../i18n/index.js';
import { TOOL_DISPLAY_BY_NAME } from './tool-display-map.js';
import {
  getCachedStringWidth,
  stripUnsafeCharacters,
  truncateToWidth,
} from './textUtils.js';

export interface FocusToolSummaryInput {
  name: string;
  description?: string;
  args?: Record<string, unknown>;
  status: 'success' | 'error' | 'cancelled' | 'pending';
  isUserInitiated?: boolean;
  isSubagent?: boolean;
  hasImages?: boolean;
}

const FILE_TOOLS = new Set([
  'ReadFile',
  'WriteFile',
  'Edit',
  'NotebookEdit',
  'Read File',
  'Read File(s)',
]);

function singleLine(text: string): string {
  return stripUnsafeCharacters(text)
    .replace(/[\r\n\t\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .trim();
}

function toolName(tool: FocusToolSummaryInput): string {
  return singleLine(TOOL_DISPLAY_BY_NAME[tool.name] ?? tool.name);
}

function toolIdentity(tool: FocusToolSummaryInput): string {
  const name = toolName(tool);
  if (!FILE_TOOLS.has(name)) return truncateToWidth(name, 40);

  const path = [
    'file_path',
    'absolute_path',
    'path',
    'filePath',
    'notebook_path',
  ]
    .map((key) => tool.args?.[key])
    .find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
  let identity = singleLine(path ?? tool.description ?? '');
  if (!path && /^[{[]/.test(identity)) {
    try {
      if (typeof JSON.parse(identity) === 'object') identity = '';
    } catch {
      // Bracketed filenames are not JSON argument fallbacks.
    }
  }
  const width = Math.max(0, 40 - getCachedStringWidth(name) - 1);
  if (getCachedStringWidth(identity) > width && /[/\\]/.test(identity)) {
    identity = `…/${identity.split(/[/\\]/).at(-1)}`;
  }
  return identity ? `${name} ${truncateToWidth(identity, width)}` : name;
}

export function getFocusToolSummary(
  tools: readonly FocusToolSummaryInput[],
  options: {
    isPending?: boolean;
    isUserInitiated?: boolean;
    maxWidth?: number;
  } = {},
): { text: string; status: 'success' | 'error' | 'cancelled' } | undefined {
  if (
    options.isPending ||
    options.isUserInitiated ||
    tools.length === 0 ||
    tools.some(
      (tool) =>
        tool.status === 'pending' ||
        tool.isUserInitiated ||
        tool.isSubagent ||
        tool.hasImages,
    )
  )
    return undefined;

  const failed = tools.filter((tool) => tool.status === 'error');
  const cancelled = tools.filter((tool) => tool.status === 'cancelled').length;
  const status =
    failed.length > 0 ? 'error' : cancelled > 0 ? 'cancelled' : 'success';
  let text: string;
  if (tools.length === 1) {
    const identity = toolIdentity(tools[0]);
    text =
      status === 'error'
        ? t('{{tool}} failed (Ctrl+O for details)', { tool: identity })
        : status === 'cancelled'
          ? t('{{tool}} cancelled (Ctrl+O for details)', { tool: identity })
          : t('{{tool}} (Ctrl+O for details)', { tool: identity });
  } else {
    const parts = [t('Tools: {{count}}', { count: String(tools.length) })];
    if (failed.length > 0) {
      const names = [...new Set(failed.map(toolName))];
      const labels = names.slice(0, 2).map((name) => truncateToWidth(name, 16));
      if (names.length > 2) labels.push('…');
      parts.push(
        t('failed: {{failed}} ({{tools}})', {
          failed: String(failed.length),
          tools: labels.join(', '),
        }),
      );
    }
    if (cancelled > 0)
      parts.push(
        t('cancelled: {{cancelled}}', { cancelled: String(cancelled) }),
      );
    text = t('{{summary}} (Ctrl+O for details)', { summary: parts.join(', ') });
  }
  return { text: truncateToWidth(text, options.maxWidth ?? 80), status };
}
