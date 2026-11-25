/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview MCP instructions delta attachment generator.
 *
 * Computes the delta between currently connected MCP servers with instructions
 * and previously announced servers. This avoids rebuilding MCP instructions in
 * the system prompt on every turn, which would invalidate provider prompt
 * caching whenever a server connects/disconnects late.
 *
 * Design:
 *   - State is tracked in AttachmentToolUseContext.announcedMcpInstructionServers
 *   - Delta is computed by comparing announced set vs current connected set
 *   - Added servers' instructions are emitted as mcp_instructions_delta attachment
 *   - Removed servers (announced but no longer connected) are listed for retraction
 *   - After compaction, the announced set should be reset to force re-announcement
 */

import {
  type AttachmentToolUseContext,
  type AttachmentExternalContext,
  McpInstructionsDeltaAttachment,
} from '../types.js';
import { runLogger } from '../../utils/runLogger.js';

/**
 * Compute MCP instructions delta and return 0 or 1 delta attachments.
 *
 * Returns an empty array when:
 *   - No mcpClientManager is available in externalContext
 *   - No servers have been added or removed since last announcement
 *
 * When a delta exists, updates ctx.announcedMcpInstructionServers in-place.
 */
export function getMcpInstructionsDeltaAttachments(
  ctx: AttachmentToolUseContext,
  externalContext?: AttachmentExternalContext,
): McpInstructionsDeltaAttachment[] {
  const mcpManager = externalContext?.mcpClientManager;
  if (!mcpManager) return [];

  const serverInfos = mcpManager.getConnectedServerInstructions();

  runLogger.log(
    `[MCP InstructionsDelta] Connected servers: ${serverInfos.length}, ` +
      `with instructions: ${
        serverInfos
          .filter((s) => s.instructions)
          .map((s) => s.serverName)
          .join(', ') || '(none)'
      }, ` +
      `already announced: ${[...ctx.announcedMcpInstructionServers].join(', ') || '(none)'}`,
  );

  // Build current connected set (only servers that have instructions)
  const currentWithInstructions = new Map<string, string>();
  const connectedNames = new Set<string>();
  for (const info of serverInfos) {
    connectedNames.add(info.serverName);
    if (info.instructions) {
      currentWithInstructions.set(info.serverName, info.instructions);
    }
  }

  const announced = ctx.announcedMcpInstructionServers;

  // Phase 1: Compute added (have instructions, not yet announced)
  const added: Array<{ name: string; block: string }> = [];
  for (const [name, instructions] of currentWithInstructions) {
    if (!announced.has(name)) {
      added.push({ name, block: `## ${name}\n${instructions}` });
    }
  }

  // Phase 2: Compute removed (announced but no longer connected)
  const removedNames: string[] = [];
  for (const name of announced) {
    if (!connectedNames.has(name)) {
      removedNames.push(name);
    }
  }

  // No changes
  if (added.length === 0 && removedNames.length === 0) {
    runLogger.log('[MCP InstructionsDelta] No delta — skipping.');
    return [];
  }

  // Sort for deterministic output
  added.sort((a, b) => a.name.localeCompare(b.name));
  removedNames.sort();

  const addedNames = added.map((a) => a.name);
  const addedBlocks = added.map((a) => a.block);

  // Update tracking state
  for (const name of addedNames) {
    announced.add(name);
  }
  for (const name of removedNames) {
    announced.delete(name);
  }

  runLogger.log(
    `[MCP InstructionsDelta] Delta emitted — ` +
      `added: [${addedNames.join(', ')}], ` +
      `removed: [${removedNames.join(', ')}], ` +
      `announced after update: [${[...announced].join(', ')}]`,
  );

  return [
    new McpInstructionsDeltaAttachment({
      type: 'mcp_instructions_delta',
      addedNames,
      addedBlocks,
      removedNames,
    }),
  ];
}

/**
 * Reset the MCP instructions delta tracking state.
 *
 * Should be called after compaction to force re-announcement of all
 * currently connected servers' instructions.
 */
export function resetMcpInstructionsDeltaState(
  ctx: AttachmentToolUseContext,
): void {
  runLogger.log(
    `[MCP InstructionsDelta] Reset — clearing ${ctx.announcedMcpInstructionServers.size} announced servers (post-compaction).`,
  );
  ctx.announcedMcpInstructionServers.clear();
}
