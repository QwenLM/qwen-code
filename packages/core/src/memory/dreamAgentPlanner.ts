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
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  AUTO_MEMORY_PINNED_DIRNAME,
  getAutoMemoryRoot,
} from './paths.js';
import { ToolNames } from '../tools/tool-names.js';
import { escapeShellArg, getShellConfiguration } from '../utils/shell-utils.js';
import { createMemoryScopedAgentConfig } from './memory-scoped-agent-config.js';
import { DREAM_OPERATIONS_FILENAME } from './dream-operations.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { renderWriterKeywordVocabularySnapshot } from './writer-keyword-vocabulary.js';

const MAX_TURNS = 8;
const MAX_TIME_MINUTES = 5;

const DREAM_AGENT_SYSTEM_PROMPT = `You are performing a managed memory dream — a reflective pass over durable memory files.

Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Rules:
- Treat files under the top-level \`${AUTO_MEMORY_PINNED_DIRNAME}/\` directory as protected read-only records. Never modify, overwrite, rename, merge into, or delete them.
- Leave \`${AUTO_MEMORY_PINNED_DIRNAME}/\` out of consolidation analysis; do not list, read, or compare its files during Dream.
- Merge semantically duplicate entries among writable topic files — if the same fact appears in multiple writable files, consolidate into one file and delete the rest.
- Preserve all durable information; do not delete content that is still accurate.
- Fix contradicted or stale facts only when the evidence is clear from the existing memory content or recent transcript signal.
- Keep each file independently retrievable: one coherent fact, rule, preference, or reference per file.
- Use description for what the memory says and usage_scenarios for future tasks where it would help.
- Every memory must have one fixed category, 1-3 usage_scenarios, and 2-6 keywords in YAML frontmatter.
- Use discriminative retrieval terms or short phrases; prefer domain-qualified phrases over generic single words and put at most 2 exact identifiers last.
- Do not edit MEMORY.md. The runtime rebuilds it after your work.
- If nothing needs consolidation, do nothing and say so.`;

export function getTranscriptDir(projectRoot: string): string {
  return path.join(new Storage(projectRoot).getProjectDir(), 'chats');
}

function quoteShellPathWithTrailingSeparator(dirPath: string): string {
  return escapeShellArg(`${dirPath}${path.sep}`, getShellConfiguration().shell);
}

export function buildConsolidationTaskPrompt(
  memoryRoot: string,
  transcriptDir: string,
  options: {
    runtimeManagedOperations?: boolean;
    keywordVocabularySnapshot?: string;
  } = {},
): string {
  const quotedTranscriptDir =
    quoteShellPathWithTrailingSeparator(transcriptDir);
  const runtimeManagedOperations = options.runtimeManagedOperations ?? false;
  const deletionInstructions = runtimeManagedOperations
    ? [
        '## Phase 4 — Schedule safe deletions',
        '',
        `If files must be removed, write \`${memoryRoot}/${DREAM_OPERATIONS_FILENAME}\` only after every replacement file is complete and valid.`,
        'Use paths relative to the memory directory and this exact JSON shape:',
        '`{"version":1,"delete":["project/old.md"],"operations":[{"type":"dedupe","sources":["project/old.md"],"target":"project/canonical.md"},{"type":"split","source":"feedback/long.md","targets":["feedback/rule-a.md","feedback/rule-b.md"]}]}`',
        '- `delete` contains every old file the runtime should remove',
        '- `dedupe` records redundant source files merged into a surviving target',
        '- `split` records one old source replaced by at least two surviving targets',
        '- Omit unrelated operation types; use an empty operations array for plain stale-file deletion',
        '- Never schedule `MEMORY.md`, the operations file, an absolute path, or a path outside the memory directory',
        `- Do not edit \`${memoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\`; the runtime validates operations, deletes scheduled files, and rebuilds it`,
      ]
    : [
        '## Phase 4 — Prune and index',
        '',
        '- Delete redundant or stale files only after every replacement file is complete and valid',
        `- Update \`${memoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\` to contain one concise line per surviving memory`,
        '- Remove pointers to deleted files and add pointers to newly created files',
        `- Do not intentionally remove existing index entries for valid \`${AUTO_MEMORY_PINNED_DIRNAME}/\` files; normal index limits still apply`,
        '- Never create `.dream-operations.json`; manual `/dream` has no background runtime to apply it',
      ];

  return [
    `Memory directory: \`${memoryRoot}\``,
    'This directory already exists — write to it directly with the write_file tool (do not run mkdir or check for its existence).',
    `Session transcripts: \`${transcriptDir}\` (large JSONL files — grep narrowly, don't read whole files)`,
    '',
    '## Phase 1 — Orient',
    '',
    '- List the memory directory to see what files exist',
    `- Read \`${memoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\` to understand the current index`,
    '- Skim topic subdirectories (`user/`, `project/`, `feedback/`, `reference/`)',
    `- Skip \`${AUTO_MEMORY_PINNED_DIRNAME}/\` during Dream; do not list or read files there`,
    '- If `logs/` or `sessions/` subdirectories exist, review recent entries there',
    '',
    '## Phase 2 — Gather recent signal',
    '',
    'Look for new information worth persisting. Sources in rough priority order:',
    '',
    '1. Existing memories that drifted — facts that contradict something you now know from current memory files',
    '2. Transcript search — if you need specific context, grep session transcripts for narrow terms:',
    `   \`grep -rn "<narrow term>" ${quotedTranscriptDir} --include="*.jsonl" | tail -50\``,
    '',
    "Don't exhaustively read transcripts. Look only for things you already suspect matter.",
    '',
    '## Phase 3 — Consolidate',
    '',
    'For each topic directory:',
    '- Identify duplicate or near-duplicate `.md` files (same fact expressed differently)',
    '- Merge duplicates: write the canonical version into one file, delete the redundant files',
    `- Exclude \`${AUTO_MEMORY_PINNED_DIRNAME}/\` from duplicate, stale, and contradiction analysis; never use a pinned file as a merge target or deletion candidate`,
    '- Fix stale or contradicted facts when clear from the existing content',
    '- Convert relative dates (for example: "yesterday", "last week") to absolute dates when preserving them',
    '- Backfill missing `description`, `category`, `usage_scenarios`, and `keywords` from the complete body.',
    '- Remove duplicate, generic, or corpus-wide hub keywords.',
    '- Keep 2-6 discriminative retrieval terms or short phrases; prefer domain-qualified phrases over generic single words, with at most 2 exact identifiers last.',
    '- Refresh `description`, `category`, `usage_scenarios`, and `keywords` whenever the body meaning changes',
    '- Inspect memories over roughly 1,200 characters and remove repetition or incidental detail',
    '- Strongly compress or split memories over 2,400 characters',
    '- Split only at semantic retrieval boundaries, never at a fixed character position',
    '- Preserve the complete rule or fact, including `Why:` and `How to apply:` when present',
    '',
    options.keywordVocabularySnapshot?.trim() ?? '',
    '',
    ...deletionInstructions,
    '',
    '---',
    '',
    'Return a brief summary of what you consolidated, updated, or pruned. If nothing needed consolidation, say so briefly.',
  ].join('\n');
}

export async function planManagedAutoMemoryDreamByAgent(
  config: Config,
  projectRoot: string,
  abortSignal?: AbortSignal,
  options: { suppressChatRecording?: boolean } = {},
): Promise<ForkedAgentResult> {
  const memoryRoot = getAutoMemoryRoot(projectRoot);
  const transcriptDir = getTranscriptDir(projectRoot);
  const docs = await scanAutoMemoryTopicDocuments(projectRoot);
  const scopedConfig = createMemoryScopedAgentConfig(config, projectRoot, {
    allowShell: true,
    includeUserMemory: false,
    protectPinnedMemory: true,
  });
  const result = await runForkedAgent({
    name: 'managed-auto-memory-dreamer',
    config: scopedConfig,
    taskPrompt: buildConsolidationTaskPrompt(memoryRoot, transcriptDir, {
      runtimeManagedOperations: true,
      keywordVocabularySnapshot: renderWriterKeywordVocabularySnapshot(docs, {
        scopes: ['project'],
      }),
    }),
    systemPrompt: DREAM_AGENT_SYSTEM_PROMPT,
    maxTurns: config.getMemoryAgentMaxTurns() ?? MAX_TURNS,
    maxTimeMinutes: config.getMemoryAgentTimeoutMinutes() ?? MAX_TIME_MINUTES,
    tools: [
      ToolNames.READ_FILE,
      ToolNames.GREP,
      ToolNames.GLOB,
      ToolNames.SHELL,
      ToolNames.WRITE_FILE,
      ToolNames.EDIT,
    ],
    abortSignal,
    suppressChatRecording: options.suppressChatRecording,
  });

  if (result.status === 'failed') {
    throw new Error(result.terminateReason || 'Dream agent failed');
  }

  if (result.status === 'cancelled') {
    // runForkedAgent maps AgentTerminateMode.CANCELLED → status 'cancelled'
    // (resolves rather than rejects). Throw here so callers up the stack
    // unwind via their catch paths instead of silently treating an
    // aborted dream as a normal completion (which would overwrite the
    // user-cancelled record with 'completed' + bump dream metadata).
    throw new Error(
      result.terminateReason || 'Dream agent cancelled before completion',
    );
  }

  return result;
}
