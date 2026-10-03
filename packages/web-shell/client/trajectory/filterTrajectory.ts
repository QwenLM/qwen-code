/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Trajectory, TrajectoryRow } from './types';

export interface TrajectoryFilter {
  query: string;
  type: 'all' | TrajectoryRow['kind'];
  status: 'all' | 'success' | 'error' | 'cancelled' | 'running' | 'unknown';
}

export interface TrajectorySearchIndex {
  rows: Array<{
    key: string;
    kind: TrajectoryRow['kind'];
    status?: Exclude<TrajectoryFilter['status'], 'all'>;
    fields: string[];
  }>;
  truncatedCount: number;
}

const METADATA_LIMIT = 2048;
const BODY_LIMIT = 8192;
const TOOL_SLOT_LIMIT = 4096;
const WINDOW_BODY_LIMIT = 2_097_152;
const MAX_DEPTH = 8;
const MAX_NODES = 512;
const TOOL_SLOT_NODES = 256;

function executionStatus(
  row: TrajectoryRow,
): Exclude<TrajectoryFilter['status'], 'all'> | undefined {
  if (row.kind === 'request') {
    return row.status === 'ok' ? 'success' : row.status;
  }
  if (row.kind !== 'tool') return undefined;
  switch (row.toolStatus ?? row.block.status) {
    case 'success':
    case 'completed':
      return 'success';
    case 'error':
    case 'failed':
      return 'error';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'pending':
    case 'in_progress':
    case 'running':
      return 'running';
    default:
      return 'unknown';
  }
}

function metadata(row: TrajectoryRow): Array<string | undefined> {
  switch (row.kind) {
    case 'request':
      return [
        row.model,
        row.recordId,
        row.responseId,
        row.promptId,
        row.subagentId,
        row.parentToolCallId,
      ];
    case 'tool':
      return [
        row.block.toolName,
        row.block.title,
        row.block.toolCallId,
        row.block.parentToolCallId,
        row.block.subagentType,
      ];
    case 'user':
    case 'message':
      return [row.block.id];
    case 'other':
      return [row.block.kind, row.block.id];
  }
}

function body(row: TrajectoryRow): unknown[] {
  if (row.kind === 'request') return [];
  if (row.kind === 'tool') {
    return [
      row.block.rawInput,
      row.block.rawOutput === undefined
        ? row.block.content
        : row.block.rawOutput,
    ];
  }
  if (row.kind === 'user' || row.kind === 'message') return [row.block.text];
  switch (row.block.kind) {
    case 'shell':
    case 'status':
    case 'error':
    case 'debug':
      return [row.block.text];
    case 'user_shell':
      return [row.block.command, row.block.text];
    case 'permission':
      return [row.block.title];
    case 'prompt_cancelled':
      return [row.block.reason];
    default:
      return [];
  }
}

export function buildTrajectorySearchIndex(
  trajectory: Trajectory,
): TrajectorySearchIndex {
  let windowRemaining = WINDOW_BODY_LIMIT;
  let truncatedCount = 0;
  const rows = trajectory.rows.map((row) => {
    const fields: string[] = [];
    let truncated = false;
    let remaining = METADATA_LIMIT;
    const append = (text: string) => {
      if (/^data:/i.test(text)) return;
      const part = text.slice(0, remaining);
      if (/^\s*data:/i.test(part)) return;
      if (part.length < text.length) truncated = true;
      remaining -= part.length;
      if (part.length > 0) fields.push(part.toLowerCase());
    };
    for (const field of metadata(row)) {
      if (field !== undefined) append(field);
    }
    let rowRemaining = BODY_LIMIT;
    let rowNodes = MAX_NODES;
    for (const value of body(row)) {
      const tool = row.kind === 'tool';
      remaining = Math.min(
        tool ? TOOL_SLOT_LIMIT : rowRemaining,
        windowRemaining,
      );
      const allotted = remaining;
      let nodes = tool ? TOOL_SLOT_NODES : rowNodes;
      const allottedNodes = nodes;
      const ancestors = new Set<object>();
      const visit = (item: unknown, depth: number) => {
        if (depth > MAX_DEPTH || nodes === 0) {
          truncated = true;
          return;
        }
        nodes--;
        if (item === undefined) return;
        if (
          item === null ||
          typeof item === 'string' ||
          typeof item === 'boolean' ||
          typeof item === 'number'
        ) {
          append(String(item));
          return;
        }
        if (typeof item !== 'object') return;
        if (
          !Array.isArray(item) &&
          Object.getPrototypeOf(item) !== Object.prototype &&
          Object.getPrototypeOf(item) !== null
        )
          return;
        if (ancestors.has(item)) {
          truncated = true;
          return;
        }
        ancestors.add(item);
        if (Array.isArray(item)) {
          for (let i = 0; i < item.length; i++) {
            if (nodes === 0 || remaining === 0 || depth === MAX_DEPTH) {
              truncated = true;
              break;
            }
            visit(item[i], depth + 1);
          }
        } else {
          const record = item as Record<string, unknown>;
          const type = record['type'];
          const typedFields =
            typeof record['mimeType'] === 'string' &&
            record['data'] !== undefined
              ? ['name']
              : type === 'text'
                ? ['text']
                : type === 'content'
                  ? ['content']
                  : type === 'diff'
                    ? ['path', 'oldText', 'newText']
                    : typeof type === 'string' &&
                        [
                          'image',
                          'audio',
                          'resource',
                          'resource_link',
                          'file',
                          'blob',
                          'embedded_resource',
                          'terminal',
                        ].includes(type)
                      ? ['name']
                      : undefined;
          const visitProperty = (key: string) => {
            if (nodes === 0 || remaining === 0 || depth === MAX_DEPTH) {
              truncated = true;
              return false;
            }
            if (!typedFields) {
              visit(key, depth + 1);
              if (nodes === 0 || remaining === 0) {
                truncated = true;
                return false;
              }
            }
            visit(record[key], depth + 1);
            return true;
          };
          if (typedFields) {
            for (const key of typedFields) {
              if (record[key] !== undefined && !visitProperty(key)) break;
            }
          } else {
            for (const key in record) {
              if (!Object.hasOwn(record, key)) continue;
              if (
                ['base64', 'blob', 'inlineData', 'inline_data'].includes(key) ||
                (key === 'data' && typeof record['mimeType'] === 'string')
              )
                continue;
              if (!visitProperty(key)) break;
            }
          }
        }
        ancestors.delete(item);
      };
      visit(value, 0);
      const consumed = allotted - remaining;
      windowRemaining -= consumed;
      rowRemaining -= consumed;
      rowNodes -= allottedNodes - nodes;
    }
    if (truncated) truncatedCount++;
    return {
      key: row.key,
      kind: row.kind,
      status: executionStatus(row),
      fields,
    };
  });
  return { rows, truncatedCount };
}

export function filterTrajectory(
  index: TrajectorySearchIndex,
  filter: TrajectoryFilter,
): string[] {
  const query = filter.query.trim().toLowerCase();
  return index.rows
    .filter(
      (row) =>
        (filter.type === 'all' || row.kind === filter.type) &&
        (filter.status === 'all' || row.status === filter.status) &&
        (!query || row.fields.some((field) => field.includes(query))),
    )
    .map((row) => row.key);
}
