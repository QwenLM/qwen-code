/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  canonicalToolName,
  ToolDisplayNames,
} from '@qwen-code/qwen-code-core/tools/tool-names.js';
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
  ToolDisplayNames.LS,
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
    const base = identity.split(/[/\\]/).filter(Boolean).at(-1) ?? '';
    identity =
      width >= 4
        ? `…/${truncateToWidth(base, width - 2)}`
        : truncateToWidth(base, width);
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
  const hint = t('{{summary}} (Ctrl+O for details)', { summary: '' });
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
    const showHint = maxWidth >= suffixWidth + nameWidth;
    const reservedWidth =
      suffixWidth - (showHint ? 0 : getCachedStringWidth(hint));
    const identity = toolIdentity(
      tools[0],
      Math.max(0, Math.min(40, maxWidth - reservedWidth)),
    );
    text = t(template, { tool: identity });
    if (!showHint) text = text.slice(0, -hint.length).trimEnd();
  } else {
    const names = [
      ...new Set(failed.map((tool) => localizeToolDisplayName(toolName(tool)))),
    ];
    const summaryFor = (count: number): string => {
      const parts = [t('Tools: {{count}}', { count: String(tools.length) })];
      const labels = names
        .slice(0, count)
        .map((name) => truncateToWidth(name, 16));
      if (names.length > count) labels.push('…');
      if (failed.length > 0)
        parts.push(
          t('failed: {{failed}} ({{tools}})', {
            failed: String(failed.length),
            tools: labels.join(', '),
          }),
        );
      if (cancelled > 0)
        parts.push(
          t('cancelled: {{cancelled}}', { cancelled: String(cancelled) }),
        );
      return parts.join(', ');
    };
    const showHint = getCachedStringWidth(summaryFor(0) + hint) <= maxWidth;
    const budget = maxWidth - (showHint ? getCachedStringWidth(hint) : 0);
    let count = Math.min(2, names.length);
    while (count > 0 && getCachedStringWidth(summaryFor(count)) > budget)
      count--;
    let summary = summaryFor(count);
    if (getCachedStringWidth(summary) > budget) {
      summary = summary.replace(/[（(]…[)）]/g, '').trimEnd();
    }
    text = showHint
      ? t('{{summary}} (Ctrl+O for details)', { summary })
      : summary;
  }
  return { text: truncateToWidth(text, maxWidth), status };
}
