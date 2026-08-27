/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  runForkedAgent,
  type ForkedAgentResult,
} from '../agents/forkedAgent.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  AUTO_MEMORY_PINNED_DIRNAME,
  getUserAutoMemoryRoot,
} from './paths.js';
import { createMemoryScopedAgentConfig } from './memory-scoped-agent-config.js';
import { DREAM_OPERATIONS_FILENAME } from './dream-operations.js';
import { scanUserAutoMemoryTopicDocuments } from './scan.js';
import { renderWriterKeywordVocabularySnapshot } from './writer-keyword-vocabulary.js';

const MAX_TURNS = 8;
const MAX_TIME_MINUTES = 5;

const USER_DREAM_SYSTEM_PROMPT = `You are consolidating durable, cross-project User Memory for an AI coding assistant.

You may use only the supplied User Memory directory. Do not infer project-specific facts, inspect project files, or read session transcripts.

Rules:
- Preserve accurate user preferences, background, responsibilities, and personal references.
- Treat files under the top-level \`${AUTO_MEMORY_PINNED_DIRNAME}/\` directory as protected read-only records. Never modify, overwrite, rename, merge into, or delete them.
- Merge semantic duplicates into one complete canonical file.
- Keep one independently retrievable fact, rule, preference, or reference per file.
- Use description for what the memory says and usage_scenarios for future tasks where it would help.
- Every memory must have one fixed category, 1-3 usage_scenarios, and 2-6 keywords in YAML frontmatter.
- Use discriminative retrieval terms or short phrases; prefer domain-qualified phrases over generic single words and put at most 2 exact identifiers last.
- Compress repetition; split only at semantic retrieval boundaries.
- Preserve the complete rule or fact, including Why and How to apply when present.
- Do not edit MEMORY.md. The runtime rebuilds it after your work.
- If nothing needs consolidation, do nothing.`;

export function buildUserConsolidationTaskPrompt(
  memoryRoot: string,
  options: { keywordVocabularySnapshot?: string } = {},
): string {
  return [
    `User Memory directory: \`${memoryRoot}\``,
    'This directory already exists. Only read and write inside it.',
    'Do not read any project memory, repository file, or transcript.',
    '',
    '## Inspect and consolidate',
    '',
    '- List the directory and read relevant topic files.',
    '- Backfill missing `description`, `category`, `usage_scenarios`, and `keywords` from the complete body.',
    '- Keep 2-6 discriminative retrieval terms or short phrases; prefer domain-qualified phrases over generic single words, with at most 2 exact identifiers last.',
    '- Remove duplicate, generic, or corpus-wide hub keywords.',
    '- Refresh `description`, `category`, `usage_scenarios`, and `keywords` whenever body meaning changes.',
    '- Inspect memories over roughly 1,200 characters and remove repetition or incidental detail.',
    '- Strongly compress or split memories over 2,400 characters.',
    '- Split only into semantic retrieval units, never at fixed character positions.',
    '- Write every new, split, or canonical replacement file before scheduling an old file for deletion.',
    '',
    options.keywordVocabularySnapshot?.trim() ?? '',
    '',
    '## Schedule safe deletions',
    '',
    `If files must be removed, write \`${memoryRoot}/${DREAM_OPERATIONS_FILENAME}\` after all replacement files are valid.`,
    'Use this exact JSON shape with paths relative to User Memory:',
    '`{"version":1,"delete":["feedback/old.md"],"operations":[{"type":"dedupe","sources":["feedback/old.md"],"target":"feedback/canonical.md"},{"type":"split","source":"user/long.md","targets":["user/role.md","user/goals.md"]}]}`',
    '- `delete` lists every old file the runtime should remove.',
    '- `dedupe` lists redundant sources merged into a surviving target.',
    '- `split` lists one old source replaced by at least two surviving targets.',
    '- Use an empty operations array for a plain stale-file deletion.',
    '- Never schedule or modify files under the top-level `pinned/` directory.',
    `- Never schedule \`${AUTO_MEMORY_INDEX_FILENAME}\`, the operations file, an absolute path, or a path outside User Memory.`,
    `- Do not edit \`${memoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\`; the runtime validates operations and rebuilds it.`,
    '',
    'Return a brief summary without quoting memory contents.',
  ].join('\n');
}

export async function planUserAutoMemoryDreamByAgent(
  config: Config,
  projectRoot: string,
  abortSignal?: AbortSignal,
): Promise<ForkedAgentResult> {
  const memoryRoot = getUserAutoMemoryRoot();
  const docs = await scanUserAutoMemoryTopicDocuments().catch(() => []);
  const scopedConfig = createMemoryScopedAgentConfig(config, projectRoot, {
    includeUserMemory: true,
    userMemoryOnly: true,
    restrictReadsToMemoryPaths: true,
    protectPinnedMemory: true,
  });
  const result = await runForkedAgent({
    name: 'managed-user-memory-dreamer',
    config: scopedConfig,
    taskPrompt: buildUserConsolidationTaskPrompt(memoryRoot, {
      keywordVocabularySnapshot: renderWriterKeywordVocabularySnapshot(docs, {
        scopes: ['user'],
      }),
    }),
    systemPrompt: USER_DREAM_SYSTEM_PROMPT,
    maxTurns: MAX_TURNS,
    maxTimeMinutes: config.getMemoryAgentTimeoutMinutes() ?? MAX_TIME_MINUTES,
    tools: [
      ToolNames.READ_FILE,
      ToolNames.GREP,
      ToolNames.LS,
      ToolNames.WRITE_FILE,
      ToolNames.EDIT,
    ],
    abortSignal,
    suppressChatRecording: true,
  });

  if (result.status !== 'completed') {
    throw new Error(result.terminateReason || 'User Dream agent failed');
  }
  return result;
}
