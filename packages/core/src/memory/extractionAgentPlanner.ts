/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { runForkedAgent, getCacheSafeParams } from '../utils/forkedAgent.js';
import { buildFunctionResponseParts } from '../tools/agent/fork-subagent.js';
import type { Content } from '@google/genai';
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from './prompt.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';
import type { AutoMemoryType } from './types.js';
import {
  scanAutoMemoryTopicDocuments,
  scanUserAutoMemoryTopicDocuments,
} from './scan.js';
import { ToolNames } from '../tools/tool-names.js';
import { createMemoryScopedAgentConfig } from './memory-scoped-agent-config.js';

const MAX_TOPIC_SUMMARY_CHARS = 280;

const debugLogger = createDebugLogger('AUTO_MEMORY_EXTRACTION_AGENT');

const EXTRACTION_AGENT_SYSTEM_PROMPT = [
  'You are now acting as the managed memory extraction subagent for an AI coding assistant.',
  '',
  'The recent conversation history is already in your context. Analyze only that recent conversation and use it to update persistent managed memory.',
  '',
  'Rules:',
  '- Read existing memory files first to avoid creating duplicates.',
  '- Extract only durable facts stated by the user.',
  '- Ignore temporary, session-specific, speculative, or question content.',
  '- If the user explicitly asks the assistant to remember something durable, preserve it.',
  '- Use one of the allowed topics: user, feedback, project, reference.',
  '- Keep entries concise and suitable for bullet points. No leading bullet markers.',
  '- Do not investigate repository code, git history, or unrelated files.',
  '- Work only from the conversation history in your context and the existing memory files.',
  '- If nothing durable should be saved, make no file changes.',
  '',
  ...TYPES_SECTION_INDIVIDUAL,
  ...WHAT_NOT_TO_SAVE_SECTION,
  '',
  'Memory file format reference:',
  ...MEMORY_FRONTMATTER_EXAMPLE,
].join('\n');

export interface AutoMemoryExtractionExecutionResult {
  touchedTopics: AutoMemoryType[];
  /** True when at least one file inside the project-level memory root was written/edited. */
  touchedProjectScope: boolean;
  /** True when at least one file inside the user-level memory root was written/edited. */
  touchedUserScope: boolean;
  systemMessage?: string;
}

/**
 * Ensure the history slice ends with a `model` text message so that
 * agent-headless can send the task prompt as the first user turn without
 * creating consecutive user messages (Gemini API constraint).
 *
 * - Trailing `user` message: drop it.
 * - Last `model` message has open function calls: close them with placeholder
 *   responses and append a model ack so the sequence stays valid.
 * - Otherwise: return a shallow copy as-is.
 */
function buildAgentHistory(history: Content[]): Content[] {
  if (history.length === 0) return [];
  const last = history[history.length - 1];
  if (last.role !== 'model') {
    return history.slice(0, -1);
  }
  const openCalls = (last.parts ?? []).filter((p) => p.functionCall);
  if (openCalls.length === 0) {
    return [...history];
  }
  const toolResponses = buildFunctionResponseParts(
    last,
    'Background extraction started.',
  );
  return [
    ...history,
    { role: 'user' as const, parts: toolResponses },
    { role: 'model' as const, parts: [{ text: 'Acknowledged.' }] },
  ];
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

async function buildTopicSummaryBlock(projectRoot: string): Promise<string> {
  // User-level scan is best-effort: a read failure on `~/.qwen/memories/`
  // must not deny the extraction agent its view of existing project-level
  // memories (which it uses to avoid creating duplicates).
  const [projectDocs, userDocs] = await Promise.all([
    scanAutoMemoryTopicDocuments(projectRoot),
    scanUserAutoMemoryTopicDocuments().catch((error: unknown) => {
      debugLogger.warn(
        `User-level auto-memory scan failed; extraction agent will see project-level summaries only: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }),
  ]);

  const renderDoc = (doc: (typeof projectDocs)[number], scope: string) => {
    const body = truncate(
      doc.body === '_No entries yet._' ? '' : doc.body,
      MAX_TOPIC_SUMMARY_CHARS,
    );
    return [
      `- [${doc.title}](${doc.relativePath}) — ${doc.description || '(no description)'}`,
      `  scope=${scope}`,
      `  topic=${doc.type}`,
      `  path=${doc.filePath}`,
      `  current=${body || '(empty)'}`,
    ].join('\n');
  };

  const blocks = [
    ...userDocs.map((doc) => renderDoc(doc, 'user')),
    ...projectDocs.map((doc) => renderDoc(doc, 'project')),
  ];

  return blocks.join('\n\n');
}

function buildTaskPrompt(
  projectMemoryRoot: string,
  userMemoryRoot: string,
  topicSummaries: string,
): string {
  return [
    'Managed memory has TWO directories. Choose which one to write each memory into using the per-type `<scope>` guidance in your system instructions:',
    `- USER memory (cross-project, durable knowledge about who the user is): \`${userMemoryRoot}\``,
    `- PROJECT memory (this project only): \`${projectMemoryRoot}\``,
    '',
    'Scan the recent conversation history in your context and update durable managed memory in whichever directory each memory belongs.',
    '',
    'Available tools in this run: `read_file`, `grep_search`, `glob`, `list_directory`, read-only `run_shell_command`, and `write_file`/`edit` for paths inside EITHER managed memory directory above.',
    '- Do not use any other tools.',
    '- You have a limited turn budget. `edit` requires a prior `read_file` of the same file, so the efficient strategy is: first issue all reads in parallel for every file you might update; then issue all `write_file`/`edit` calls in parallel. Do not interleave reads and writes across multiple turns.',
    '- You MUST only use content from the recent conversation history in your context plus the current managed memory files.',
    '- Do not inspect repository code, git history, or unrelated files.',
    '- Prefer updating an existing memory file over creating a duplicate. Check both directories for an existing entry before creating a new one.',
    '- Keep one durable memory per file under `user/`, `feedback/`, `project/`, or `reference/` inside the chosen directory.',
    '',
    '## How to save memories',
    '',
    '**Step 1** — write or update the memory file itself, in the directory chosen by the type `<scope>`, using the required frontmatter format.',
    `**Step 2** — update the \`${AUTO_MEMORY_INDEX_FILENAME}\` in the SAME directory where you wrote the file (\`${userMemoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\` for USER memory, \`${projectMemoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\` for PROJECT memory). The index is one line per entry: \`- [Title](relative/path.md) — one-line hook\`. Never write memory content directly into the index.`,
    '- If you create or delete a memory file, also update the managed memory index in the SAME directory.',
    '- If nothing durable should be saved, make no file changes.',
    '',
    '## Existing memory files (across both directories)',
    '',
    topicSummaries || '(none yet)',
  ].join('\n');
}

/**
 * Derive which memory topics + scopes were touched from the list of file
 * paths written during the agent run. Avoids requiring JSON output from
 * the agent.
 */
function touchedTopicsFromFilePaths(
  filePaths: string[],
  projectRoot: string,
): {
  topics: AutoMemoryType[];
  touchedProjectScope: boolean;
  touchedUserScope: boolean;
} {
  // Use startsWith against the directly-retrieved roots (rather than the
  // isAutoMemPath helper, which calls into paths.ts internals and would
  // bypass module-level mocks in extractionAgentPlanner.test.ts). This
  // also keeps the routing decision symmetric across both scopes.
  const projectRootDir = getAutoMemoryRoot(projectRoot);
  const userRootDir = getUserAutoMemoryRoot();
  // Canonicalize separators to `/` on BOTH sides before the prefix check.
  // On Windows the roots are backslash-native (`C:\Users\foo\...\memory`)
  // while filesTouched (populated from raw model tool-call arguments)
  // commonly comes back forward-slash-normalized — `startsWith` against
  // the raw roots would miss those writes entirely. Also guards against
  // the inverse direction and the historical `/foo/memory` vs
  // `/foo/memory-other/...` collision: the character after the root must
  // be `/` so files inside (never AT) the root match exactly one prefix.
  const canon = (s: string): string => s.replace(/\\/g, '/');
  const isUnderRoot = (canonP: string, canonRoot: string): boolean => {
    if (!canonP.startsWith(canonRoot)) return false;
    return canonP.charAt(canonRoot.length) === '/';
  };
  const canonProject = canon(projectRootDir);
  const canonUser = canon(userRootDir);
  const topicSet = new Set<AutoMemoryType>();
  let touchedProjectScope = false;
  let touchedUserScope = false;

  for (const p of filePaths) {
    const canonP = canon(p);
    let canonRoot: string | undefined;
    if (isUnderRoot(canonP, canonProject)) {
      canonRoot = canonProject;
      touchedProjectScope = true;
    } else if (isUnderRoot(canonP, canonUser)) {
      canonRoot = canonUser;
      touchedUserScope = true;
    } else {
      continue;
    }
    // +1 to also strip the `/` we just checked for.
    const rel = canonP.slice(canonRoot.length + 1);
    const segment = rel.split('/')[0] as AutoMemoryType;
    if (
      segment === 'user' ||
      segment === 'feedback' ||
      segment === 'project' ||
      segment === 'reference'
    ) {
      topicSet.add(segment);
    }
  }
  return {
    topics: [...topicSet],
    touchedProjectScope,
    touchedUserScope,
  };
}

export async function runAutoMemoryExtractionByAgent(
  config: Config,
  projectRoot: string,
): Promise<AutoMemoryExtractionExecutionResult> {
  const cacheSafe = getCacheSafeParams();
  if (!cacheSafe) {
    throw new Error(
      'runAutoMemoryExtractionByAgent: no cache-safe params available; ' +
        'extraction must run after a completed main turn.',
    );
  }
  const extraHistory = buildAgentHistory(cacheSafe.history);

  const topicSummaries = await buildTopicSummaryBlock(projectRoot);
  const projectMemoryRoot = getAutoMemoryRoot(projectRoot);
  const userMemoryRoot = getUserAutoMemoryRoot();
  const scopedConfig = createMemoryScopedAgentConfig(config, projectRoot, {
    allowShell: true,
  });

  const result = await runForkedAgent({
    name: 'managed-auto-memory-extractor',
    config: scopedConfig,
    taskPrompt: buildTaskPrompt(
      projectMemoryRoot,
      userMemoryRoot,
      topicSummaries,
    ),
    systemPrompt: EXTRACTION_AGENT_SYSTEM_PROMPT,
    maxTurns: 5,
    maxTimeMinutes: 2,
    tools: [
      ToolNames.READ_FILE,
      ToolNames.GREP,
      ToolNames.GLOB,
      ToolNames.LS,
      ToolNames.SHELL,
      ToolNames.WRITE_FILE,
      ToolNames.EDIT,
    ],
    extraHistory,
  });

  if (result.status !== 'completed') {
    throw new Error(
      result.terminateReason ||
        'Extraction agent did not complete successfully',
    );
  }

  const { topics, touchedProjectScope, touchedUserScope } =
    touchedTopicsFromFilePaths(result.filesTouched, projectRoot);

  return {
    touchedTopics: topics,
    touchedProjectScope,
    touchedUserScope,
    systemMessage:
      topics.length > 0
        ? `Managed auto-memory updated: ${topics.map((t) => `${t}.md`).join(', ')}`
        : undefined,
  };
}
