/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Permission adapter for the daemon-direct side panel (issue #5626).
 *
 * Converts an unresolved daemon `permission` transcript block (from
 * `useDaemonPendingPermissions`) into the `{ options, toolCall }` shape the
 * webui `PermissionDrawer` renders. Approving/denying is then a single
 * `actions.submitPermission(requestId, optionId)` call.
 */

import type { DaemonTranscriptBlock } from '@qwen-code/webui/daemon-react-sdk';
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';

type PermissionBlock = Extract<DaemonTranscriptBlock, { kind: 'permission' }>;

export interface PendingPermissionView {
  requestId: string;
  options: PermissionOption[];
  toolCall: PermissionToolCall;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Derive the option `kind` the drawer uses for styling/keyboard shortcuts
 * (allow vs. reject) from the daemon option's `raw` payload, falling back to a
 * generic label so unknown kinds still render.
 */
function getOptionKind(raw: unknown, fallback: string): string {
  const kind = getString(asRecord(raw), 'kind');
  return kind ?? fallback;
}

/** Pull the nested tool input (command/description/etc.) for preview rendering. */
function getRawInput(
  toolCall: Record<string, unknown> | undefined,
): PermissionToolCall['rawInput'] {
  if (!toolCall) return undefined;
  const nested =
    asRecord(toolCall['rawInput']) ??
    asRecord(toolCall['input']) ??
    asRecord(toolCall['args']);
  return (nested ?? toolCall) as PermissionToolCall['rawInput'];
}

/** Convert the first unresolved permission block into a drawer-ready view. */
export function toPendingPermissionView(
  block: PermissionBlock,
): PendingPermissionView {
  const toolCallRecord = asRecord(block.toolCall);
  const meta = asRecord(toolCallRecord?.['_meta']);
  const toolName =
    getString(meta, 'toolName') ??
    getString(toolCallRecord, 'toolName') ??
    getString(toolCallRecord, 'name');
  const toolKind = getString(toolCallRecord, 'kind');
  const toolCallId =
    getString(toolCallRecord, 'toolCallId') ??
    getString(toolCallRecord, 'id');

  const options: PermissionOption[] = block.options.map((opt) => ({
    optionId: opt.optionId,
    name: opt.label,
    kind: getOptionKind(opt.raw, 'allow_once'),
  }));

  const toolCall: PermissionToolCall = {
    title: getString(toolCallRecord, 'title') ?? block.title,
    ...(toolKind ? { kind: toolKind } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    rawInput: getRawInput(toolCallRecord),
  };

  return { requestId: block.requestId, options, toolCall };
}
