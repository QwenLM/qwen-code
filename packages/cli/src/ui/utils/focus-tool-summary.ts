/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { canonicalToolName } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import { localizeToolDisplayName, t } from '../../i18n/index.js';
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
  hasNotice?: boolean;
}

const FILE_TOOLS = new Set([
  'ReadFile',
  'WriteFile',
  'Edit',
  'NotebookEdit',
  'Read File',
  'Read File(s)',
  'Read Directory',
]);

function singleLine(text: string): string {
  return stripUnsafeCharacters(text)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .trim();
}

function toolName(tool: FocusToolSummaryInput): string {
  const canonical = canonicalToolName(tool.name);
  const name = typeof canonical === 'string' ? canonical : tool.name;
  return singleLine(
    Object.hasOwn(TOOL_DISPLAY_BY_NAME, name)
      ? TOOL_DISPLAY_BY_NAME[name]
      : name,
  );
}

function toolIdentity(tool: FocusToolSummaryInput, maxWidth: number): string {
  const rawName = toolName(tool);
  const name = localizeToolDisplayName(rawName);
  if (!FILE_TOOLS.has(rawName)) return truncateToWidth(name, maxWidth);

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
  if (
    !path &&
    ['Read File', 'Read File(s)', 'Read Directory'].includes(rawName)
  ) {
    if (/^Error attempting to read files$/i.test(identity)) identity = '';
    else
      identity = identity.replace(/^Read (?:file(?:\(s\))?|directory)\s*/i, '');
  }
  if (!path && /^[{[]/.test(identity)) {
    try {
      if (typeof JSON.parse(identity) === 'object') identity = '';
    } catch {
      // Bracketed filenames are not JSON argument fallbacks.
    }
  }
  const width = Math.max(0, maxWidth - getCachedStringWidth(name) - 1);
  if (getCachedStringWidth(identity) > width && /[/\\]/.test(identity)) {
    identity = `…/${identity.split(/[/\\]/).filter(Boolean).at(-1) ?? ''}`;
  }
  return truncateToWidth(
    identity ? `${name} ${truncateToWidth(identity, width)}` : name,
    maxWidth,
  );
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
        tool.hasImages ||
        tool.hasNotice,
    )
  )
    return undefined;

  const failed = tools.filter((tool) => tool.status === 'error');
  const cancelled = tools.filter((tool) => tool.status === 'cancelled').length;
  const status =
    failed.length > 0 ? 'error' : cancelled > 0 ? 'cancelled' : 'success';
  const maxWidth = options.maxWidth ?? 80;
  let text: string;
  if (tools.length === 1) {
    const template =
      status === 'error'
        ? '{{tool}} failed (Ctrl+O for details)'
        : status === 'cancelled'
          ? '{{tool}} cancelled (Ctrl+O for details)'
          : '{{tool}} (Ctrl+O for details)';
    const suffixWidth = getCachedStringWidth(t(template, { tool: '' }));
    const nameWidth = getCachedStringWidth(
      localizeToolDisplayName(toolName(tools[0])),
    );
    const identity = toolIdentity(
      tools[0],
      maxWidth >= suffixWidth + nameWidth
        ? Math.min(40, maxWidth - suffixWidth)
        : 40,
    );
    text = t(template, { tool: identity });
  } else {
    const parts = [t('Tools: {{count}}', { count: String(tools.length) })];
    if (failed.length > 0) {
      const names = [
        ...new Set(
          failed.map((tool) => localizeToolDisplayName(toolName(tool))),
        ),
      ];
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
    const suffixWidth = getCachedStringWidth(
      t('{{summary}} (Ctrl+O for details)', { summary: '' }),
    );
    const summary = parts.join(', ');
    text = t('{{summary}} (Ctrl+O for details)', {
      summary:
        maxWidth > suffixWidth
          ? truncateToWidth(summary, maxWidth - suffixWidth)
          : summary,
    });
  }
  return { text: truncateToWidth(text, maxWidth), status };
}
