/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { ExitPlanModeTool } from '@qwen-code/qwen-code-core';
import type { ChatRecord, Config, Kind } from '@qwen-code/qwen-code-core';
import type { ExportMessage, ExportSessionData } from './types.js';

/**
 * Normalizes export session data by merging tool call information from tool_result records.
 * This ensures the SSOT contains complete tool call metadata.
 */
export function normalizeSessionData(
  sessionData: ExportSessionData,
  originalRecords: ChatRecord[],
  config: Config,
): ExportSessionData {
  const normalized = [...sessionData.messages];
  const toolCallIndexById = new Map<string, number>();

  // Build index of tool call messages
  normalized.forEach((message, index) => {
    if (message.type === 'tool_call' && message.toolCall?.toolCallId) {
      toolCallIndexById.set(message.toolCall.toolCallId, index);
    }
  });

  // Merge tool result information into tool call messages
  for (const record of originalRecords) {
    if (record.type !== 'tool_result') continue;

    const toolCallMessage = buildToolCallMessageFromResult(record, config);
    if (!toolCallMessage?.toolCall) continue;

    const existingIndex = toolCallIndexById.get(
      toolCallMessage.toolCall.toolCallId,
    );

    if (existingIndex === undefined) {
      // No existing tool call, add this one
      toolCallIndexById.set(
        toolCallMessage.toolCall.toolCallId,
        normalized.length,
      );
      normalized.push(toolCallMessage);
      continue;
    }

    // Merge into existing tool call
    const existingMessage = normalized[existingIndex];
    if (existingMessage.type !== 'tool_call' || !existingMessage.toolCall) {
      continue;
    }

    mergeToolCallData(existingMessage.toolCall, toolCallMessage.toolCall);
  }

  return {
    ...sessionData,
    messages: normalized,
  };
}

/**
 * Merges incoming tool call data into existing tool call.
 */
function mergeToolCallData(
  existing: NonNullable<ExportMessage['toolCall']>,
  incoming: NonNullable<ExportMessage['toolCall']>,
): void {
  if (!existing.content || existing.content.length === 0) {
    existing.content = incoming.content;
  }
  if (existing.status === 'pending' || existing.status === 'in_progress') {
    existing.status = incoming.status;
  }
  if (!existing.rawInput && incoming.rawInput) {
    existing.rawInput = incoming.rawInput;
  }
  if (!existing.kind || existing.kind === 'other') {
    existing.kind = incoming.kind;
  }
  if ((!existing.title || existing.title === '') && incoming.title) {
    existing.title = incoming.title;
  }
  if (
    (!existing.locations || existing.locations.length === 0) &&
    incoming.locations &&
    incoming.locations.length > 0
  ) {
    existing.locations = incoming.locations;
  }
}

/**
 * Builds a tool call message from a tool_result ChatRecord.
 */
function buildToolCallMessageFromResult(
  record: ChatRecord,
  config: Config,
): ExportMessage | null {
  const toolCallResult = record.toolCallResult;
  const toolCallId = toolCallResult?.callId ?? record.uuid;
  const toolName = extractToolNameFromRecord(record);
  const { kind, title, locations } = resolveToolMetadata(
    config,
    toolName,
    (toolCallResult as { args?: Record<string, unknown> } | undefined)?.args,
  );
  const rawInput = normalizeRawInput(
    (toolCallResult as { args?: unknown } | undefined)?.args,
  );

  const content =
    extractDiffContent(toolCallResult?.resultDisplay) ??
    transformPartsToToolCallContent(record.message?.parts ?? []);

  return {
    uuid: record.uuid,
    parentUuid: record.parentUuid,
    sessionId: record.sessionId,
    timestamp: record.timestamp,
    type: 'tool_call',
    toolCall: {
      toolCallId,
      kind,
      title,
      status: toolCallResult?.error ? 'failed' : 'completed',
      rawInput,
      content,
      locations,
      timestamp: Date.parse(record.timestamp),
    },
  };
}

/**
 * Extracts tool name from a ChatRecord.
 */
function extractToolNameFromRecord(record: ChatRecord): string {
  if (!record.message?.parts) {
    return '';
  }

  for (const part of record.message.parts) {
    if ('functionResponse' in part && part.functionResponse?.name) {
      return part.functionResponse.name;
    }
  }

  return '';
}

/**
 * Resolves tool metadata (kind, title, locations) from tool registry.
 */
function resolveToolMetadata(
  config: Config,
  toolName: string,
  args?: Record<string, unknown>,
): {
  kind: string;
  title: string | object;
  locations?: Array<{ path: string; line?: number | null }>;
} {
  const toolRegistry = config.getToolRegistry?.();
  const tool = toolName ? toolRegistry?.getTool?.(toolName) : undefined;

  let title: string | object = tool?.displayName ?? toolName ?? 'tool_call';
  let locations: Array<{ path: string; line?: number | null }> | undefined;
  const kind = mapToolKind(tool?.kind as Kind | undefined, toolName);

  if (tool && args) {
    try {
      const invocation = tool.build(args);
      title = `${title}: ${invocation.getDescription()}`;
      locations = invocation.toolLocations().map((loc) => ({
        path: loc.path,
        line: loc.line ?? null,
      }));
    } catch {
      // Keep defaults on build failure
    }
  }

  return { kind, title, locations };
}

/**
 * Maps tool kind to allowed export kinds.
 */
function mapToolKind(kind: Kind | undefined, toolName?: string): string {
  if (toolName && toolName === ExitPlanModeTool.Name) {
    return 'switch_mode';
  }

  const allowedKinds = new Set<string>([
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'other',
  ]);

  if (kind && allowedKinds.has(kind)) {
    return kind;
  }

  return 'other';
}

/**
 * Extracts diff content from tool result display.
 */
function extractDiffContent(
  resultDisplay: unknown,
): Array<{ type: string; [key: string]: unknown }> | null {
  if (!resultDisplay || typeof resultDisplay !== 'object') {
    return null;
  }

  const display = resultDisplay as Record<string, unknown>;
  if ('fileName' in display && 'newContent' in display) {
    return [
      {
        type: 'diff',
        path: display['fileName'] as string,
        oldText: (display['originalContent'] as string) ?? '',
        newText: display['newContent'] as string,
      },
    ];
  }

  return null;
}

/**
 * Normalizes raw input to string or object.
 */
function normalizeRawInput(value: unknown): string | object | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return value;
  return undefined;
}

/**
 * Transforms Parts to tool call content array.
 */
function transformPartsToToolCallContent(
  parts: Part[],
): Array<{ type: string; [key: string]: unknown }> {
  const content: Array<{ type: string; [key: string]: unknown }> = [];

  for (const part of parts) {
    if ('text' in part && part.text) {
      content.push({
        type: 'content',
        content: { type: 'text', text: part.text },
      });
      continue;
    }

    if ('functionResponse' in part && part.functionResponse) {
      const response = part.functionResponse.response as Record<
        string,
        unknown
      >;
      const outputField = response?.['output'];
      const errorField = response?.['error'];
      const responseText =
        typeof outputField === 'string'
          ? outputField
          : typeof errorField === 'string'
            ? errorField
            : JSON.stringify(response);
      content.push({
        type: 'content',
        content: { type: 'text', text: responseText },
      });
    }
  }

  return content;
}
