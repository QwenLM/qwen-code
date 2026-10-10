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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface NodeReplCall {
  code: string;
  output: string;
}

// MCP tools are deferred, so the model usually reaches them through the
// tool_call bridge; each use is reported as the tool it invokes and that
// tool's arguments.
function* toolUses(
  events: unknown[],
): Generator<{ id: unknown; name: unknown; input: unknown }> {
  for (const event of events) {
    if (!isRecord(event) || event.type !== 'assistant') continue;
    if (!isRecord(event.message) || !Array.isArray(event.message.content))
      continue;
    for (const block of event.message.content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const input = block.input;
      yield block.name === 'tool_call' && isRecord(input)
        ? { id: block.id, name: input.name, input: input.arguments }
        : { id: block.id, name: block.name, input };
    }
  }
}

export function collectSuccessfulNodeReplCalls(
  events: unknown[],
): NodeReplCall[] {
  const codeById = new Map<string, string>();
  for (const { id, name, input } of toolUses(events)) {
    if (
      typeof id === 'string' &&
      name === 'mcp__node-repl__node_repl' &&
      isRecord(input) &&
      typeof input.code === 'string'
    ) {
      codeById.set(id, input.code);
    }
  }
  const successful: NodeReplCall[] = [];
  for (const event of events) {
    if (!isRecord(event) || event.type !== 'user') continue;
    if (!isRecord(event.message) || !Array.isArray(event.message.content))
      continue;
    for (const block of event.message.content) {
      if (
        !isRecord(block) ||
        block.type !== 'tool_result' ||
        block.is_error !== false ||
        typeof block.tool_use_id !== 'string' ||
        typeof block.content !== 'string'
      ) {
        continue;
      }
      const code = codeById.get(block.tool_use_id);
      if (code !== undefined) successful.push({ code, output: block.content });
    }
  }
  return successful;
}

// The bundled SDK loads its own dependencies. A run that registered a module
// directory would pass even if that stopped working, so it does not count.
export function moduleDirectoryRegistrationRequested(
  events: unknown[],
): boolean {
  for (const { name } of toolUses(events)) {
    if (
      typeof name === 'string' &&
      name.endsWith('node_repl_add_node_module_dir')
    ) {
      return true;
    }
  }
  return false;
}
