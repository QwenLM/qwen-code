/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function collectAssistantReport(events: unknown[]): string {
  return events
    .filter(
      (event) =>
        isRecord(event) &&
        event.type === 'assistant' &&
        event.parent_tool_use_id == null,
    )
    .flatMap((event) => {
      if (
        !isRecord(event) ||
        !isRecord(event.message) ||
        !Array.isArray(event.message.content)
      )
        return [];
      return event.message.content.filter(isRecord);
    })
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
