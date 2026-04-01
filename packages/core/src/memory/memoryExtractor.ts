/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import {
  AgentHeadless,
  ContextState,
} from '../agents/runtime/agent-headless.js';
import type {
  PromptConfig,
  RunConfig,
  ToolConfig,
} from '../agents/runtime/agent-types.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  getMemoryDir,
  regenerateIndex,
  scanMemoryHeaders,
} from './memoryStore.js';
import { formatMemoryManifest } from './memoryScan.js';
import type { MemoryScope } from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const logger = createDebugLogger('MEMORY_EXTRACTOR');

const CURSOR_FILE = '.cursor';
const MAX_EXTRACTOR_TURNS = 2;
const MAX_EXTRACTOR_MINUTES = 1;

/**
 * System prompt for the memory extraction agent.
 */
function buildExtractionPrompt(
  newMessageCount: number,
  existingMemories: string,
  memoryDir: string,
): string {
  return `You are a memory extraction agent. Analyze the last ~${newMessageCount} messages and persist useful facts to ${memoryDir}.

## Strict 2-Turn Budget
- **Turn 1:** Issue ALL read_file and glob calls in parallel to gather existing memory state.
- **Turn 2:** Issue ALL write_file calls in parallel to create/update memories. Then stop.
Do NOT interleave reads and writes. Do NOT use more than 2 turns.

## What to Extract (from last ~${newMessageCount} messages ONLY)
Do NOT investigate source code or verify facts. Only record what was discussed.

Save when:
- User explicitly asks to remember something
- User states a preference, role, or personal fact (type: user)
- User corrects your approach or confirms a non-obvious method (type: feedback)
- A deadline, decision, or project-specific fact is mentioned (type: project)
- An external system or resource URL is referenced (type: reference)

Do NOT save: code patterns derivable from reading code, git history, debugging solutions already in the repo, anything in PROTO.md/AGENTS.md, ephemeral task details.

## Memory File Format
\`\`\`markdown
---
name: short-kebab-name
description: One-line summary used for relevance filtering
type: user|feedback|project|reference
---

The actual memory content here.
\`\`\`

Save as \`{type}_{name}.md\` in ${memoryDir}.

## Existing Memories
${existingMemories}

Check before creating. Update existing if similar. If nothing worth saving, stop immediately.`;
}

/**
 * Read the extraction cursor (index of last processed message).
 */
async function getCursor(scope: MemoryScope, cwd?: string): Promise<number> {
  const cursorPath = path.join(getMemoryDir(scope, cwd), CURSOR_FILE);
  try {
    const raw = await fs.readFile(cursorPath, 'utf-8');
    return parseInt(raw.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Write the extraction cursor.
 */
async function setCursor(
  scope: MemoryScope,
  index: number,
  cwd?: string,
): Promise<void> {
  const cursorPath = path.join(getMemoryDir(scope, cwd), CURSOR_FILE);
  await fs.mkdir(path.dirname(cursorPath), { recursive: true });
  await fs.writeFile(cursorPath, String(index), 'utf-8');
}

/**
 * Extract memories from the conversation history.
 *
 * Spawns a restricted headless agent that reads recent messages and creates
 * memory files. Fire-and-forget — errors are logged, not surfaced.
 *
 * @param config - The proto Config instance (provides model, tools, etc.)
 * @param messageCount - Total number of messages in the conversation
 * @param scope - Which memory directory to write to
 */
export async function extractMemories(
  config: Config,
  messageCount: number,
  scope: MemoryScope = 'project',
): Promise<void> {
  const cwd = config.getProjectRoot();
  const memoryDir = getMemoryDir(scope, cwd);

  // Read cursor to determine how many new messages
  const cursor = await getCursor(scope, cwd);
  const newMessageCount = messageCount - cursor;

  if (newMessageCount < 2) {
    logger.debug(
      `Skipping extraction: only ${newMessageCount} new messages since cursor`,
    );
    return;
  }

  // Scan existing memories to include in the prompt
  const existingHeaders = await scanMemoryHeaders(scope, cwd);
  const manifest = formatMemoryManifest(existingHeaders);

  const systemPrompt = buildExtractionPrompt(
    newMessageCount,
    manifest,
    memoryDir,
  );

  const promptConfig: PromptConfig = {
    systemPrompt,
  };

  const runConfig: RunConfig = {
    max_turns: MAX_EXTRACTOR_TURNS,
    max_time_minutes: MAX_EXTRACTOR_MINUTES,
  };

  const toolConfig: ToolConfig = {
    tools: [ToolNames.READ_FILE, ToolNames.WRITE_FILE, ToolNames.GLOB],
  };

  try {
    const agent = await AgentHeadless.create(
      'memory-extractor',
      config,
      promptConfig,
      { model: config.getModel() },
      runConfig,
      toolConfig,
    );

    const context = new ContextState();
    context.set('memoryDir', memoryDir);
    context.set('newMessageCount', newMessageCount);

    await agent.execute(context);

    // Regenerate the index after extraction
    await regenerateIndex(scope, cwd);

    // Advance cursor
    await setCursor(scope, messageCount, cwd);

    logger.debug(
      `Memory extraction complete: processed ${newMessageCount} messages`,
    );
  } catch (err) {
    logger.error('Memory extraction failed:', err);
    // Best-effort — don't surface errors to the user
  }
}
