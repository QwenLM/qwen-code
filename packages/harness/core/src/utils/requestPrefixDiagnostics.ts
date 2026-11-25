/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ModelPrompt } from '../provider/modelStreamRequest.js';

const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

/** Hash only the final provider prompt; no content or schema text leaves here. */
export function requestPrefixFacts(
  prompt: ModelPrompt,
): Record<string, string | number> {
  const facts: Record<string, string | number> = {};
  const system = prompt.messages
    .filter((message) => message.role === 'system')
    .map((message) => JSON.stringify(message));
  const tools = (prompt.tools ?? []).map((tool) => ({
    name: tool.name,
    json: JSON.stringify(tool),
  }));
  // Joined element JSON equals JSON.stringify of the array, so each entry is serialized once.
  const parts = {
    system: `[${system.join(',')}]`,
    tools: `[${tools.map((tool) => tool.json).join(',')}]`,
    messages: JSON.stringify(
      prompt.messages.filter((message) => message.role !== 'system'),
    ),
  };
  for (const [name, json] of Object.entries(parts)) {
    const bytes = Buffer.from(json, 'utf8');
    const prefix = bytes.subarray(0, 4096);
    facts[`${name}_bytes`] = bytes.length;
    facts[`${name}_sha256`] = sha256(bytes);
    facts[`${name}_prefix_bytes`] = prefix.length;
    facts[`${name}_prefix_sha256`] = sha256(prefix);
  }
  // Names are hashed too (MCP names can be private); match a known tool by hashing its name.
  facts['tool_fingerprints'] = tools
    .map(
      (tool) =>
        `${sha256(tool.name).slice(0, 8)}:${sha256(tool.json).slice(0, 12)}`,
    )
    .join(',');
  facts['system_fingerprints'] = system
    .map((json) => sha256(json).slice(0, 12))
    .join(',');
  return facts;
}
