/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  runForkedAgent,
  getCacheSafeParams,
} from '../background/forkedAgent.js';
import { buildFunctionResponseParts } from '../agents/runtime/forkSubagent.js';
import type { Content } from '@google/genai';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type {
  PermissionCheckContext,
  PermissionDecision,
} from '../permissions/types.js';
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from './prompt.js';
import { AUTO_MEMORY_INDEX_FILENAME, getAutoMemoryRoot } from './paths.js';
import type { AutoMemoryType } from './types.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { ToolNames } from '../tools/tool-names.js';
import { isShellCommandReadOnlyAST } from '../utils/shellAstParser.js';
import { stripShellWrapper } from '../utils/shell-utils.js';
import { isAutoMemPath } from './paths.js';

const MAX_TOPIC_SUMMARY_CHARS = 280;

type MemoryScopedPermissionManager = Pick<
  PermissionManager,
  | 'evaluate'
  | 'findMatchingDenyRule'
  | 'hasMatchingAskRule'
  | 'hasRelevantRules'
  | 'isToolEnabled'
>;

function isScopedTool(toolName: string): boolean {
  return (
    toolName === ToolNames.SHELL ||
    toolName === ToolNames.EDIT ||
    toolName === ToolNames.WRITE_FILE
  );
}

function mergePermissionDecision(
  scopedDecision: PermissionDecision,
  baseDecision: PermissionDecision,
): PermissionDecision {
  const priority: Record<PermissionDecision, number> = {
    deny: 4,
    ask: 3,
    allow: 2,
    default: 1,
  };
  return priority[baseDecision] > priority[scopedDecision]
    ? baseDecision
    : scopedDecision;
}

async function evaluateScopedDecision(
  ctx: PermissionCheckContext,
  projectRoot: string,
): Promise<PermissionDecision> {
  switch (ctx.toolName) {
    case ToolNames.SHELL: {
      if (!ctx.command) {
        return 'deny';
      }
      const isReadOnly = await isShellCommandReadOnlyAST(
        stripShellWrapper(ctx.command),
      );
      return isReadOnly ? 'allow' : 'deny';
    }
    case ToolNames.EDIT:
    case ToolNames.WRITE_FILE:
      return ctx.filePath && isAutoMemPath(ctx.filePath, projectRoot)
        ? 'allow'
        : 'deny';
    default:
      return 'default';
  }
}

function getScopedDenyRule(
  ctx: PermissionCheckContext,
  projectRoot: string,
): string | undefined {
  switch (ctx.toolName) {
    case ToolNames.SHELL:
      return 'ManagedAutoMemory(run_shell_command: read-only only)';
    case ToolNames.EDIT:
      return `ManagedAutoMemory(edit: only within ${getAutoMemoryRoot(projectRoot)})`;
    case ToolNames.WRITE_FILE:
      return `ManagedAutoMemory(write_file: only within ${getAutoMemoryRoot(projectRoot)})`;
    default:
      return undefined;
  }
}

function createMemoryScopedAgentConfig(
  config: Config,
  projectRoot: string,
): Config {
  const basePm = config.getPermissionManager?.();
  const scopedPm: MemoryScopedPermissionManager = {
    hasRelevantRules(ctx: PermissionCheckContext): boolean {
      return isScopedTool(ctx.toolName) || !!basePm?.hasRelevantRules(ctx);
    },
    hasMatchingAskRule(ctx: PermissionCheckContext): boolean {
      return basePm?.hasMatchingAskRule(ctx) ?? false;
    },
    findMatchingDenyRule(ctx: PermissionCheckContext): string | undefined {
      const scoped = getScopedDenyRule(ctx, projectRoot);
      if (scoped) {
        return scoped;
      }
      return basePm?.findMatchingDenyRule(ctx);
    },
    async evaluate(ctx: PermissionCheckContext): Promise<PermissionDecision> {
      const scopedDecision = await evaluateScopedDecision(ctx, projectRoot);
      if (!basePm) {
        return scopedDecision;
      }
      const baseDecision = basePm.hasRelevantRules(ctx)
        ? await basePm.evaluate(ctx)
        : 'default';
      return mergePermissionDecision(scopedDecision, baseDecision);
    },
    async isToolEnabled(toolName: string): Promise<boolean> {
      // Registry-level check: is this tool type allowed at all?
      // Scoped tools (SHELL/EDIT/WRITE_FILE) are enabled — per-invocation
      // restrictions are enforced in evaluate().
      if (isScopedTool(toolName)) {
        return true;
      }
      if (basePm) {
        return basePm.isToolEnabled(toolName);
      }
      return true;
    },
  };

  const scopedConfig = Object.create(config) as Config;
  scopedConfig.getPermissionManager = () =>
    scopedPm as unknown as PermissionManager;
  return scopedConfig;
}

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
  const docs = await scanAutoMemoryTopicDocuments(projectRoot);
  if (docs.length === 0) {
    return '';
  }
  return docs
    .map((doc) => {
      const body = truncate(
        doc.body === '_No entries yet._' ? '' : doc.body,
        MAX_TOPIC_SUMMARY_CHARS,
      );
      return [
        `- [${doc.title}](${doc.relativePath}) — ${doc.description || '(no description)'}`,
        `  topic=${doc.type}`,
        `  path=${doc.filePath}`,
        `  current=${body || '(empty)'}`,
      ].join('\n');
    })
    .join('\n\n');
}

function buildTaskPrompt(memoryRoot: string, topicSummaries: string): string {
  return [
    `Managed memory directory: \`${memoryRoot}\``,
    '',
    'Scan the recent conversation history in your context and update durable managed memory.',
    '',
    'Available tools in this run: `read_file`, `grep_search`, `glob`, `list_directory`, read-only `run_shell_command`, and `write_file`/`edit` for paths inside the managed memory directory only.',
    '- Do not use any other tools.',
    '- You have a limited turn budget. `edit` requires a prior `read_file` of the same file, so the efficient strategy is: first issue all reads in parallel for every file you might update; then issue all `write_file`/`edit` calls in parallel. Do not interleave reads and writes across multiple turns.',
    '- You MUST only use content from the recent conversation history in your context plus the current managed memory files.',
    '- Do not inspect repository code, git history, or unrelated files.',
    '- Prefer updating an existing memory file over creating a duplicate.',
    '- Keep one durable memory per file under `user/`, `feedback/`, `project/`, or `reference/`.',
    '',
    '## How to save memories',
    '',
    '**Step 1** — write or update the memory file itself using the required frontmatter format.',
    `**Step 2** — update \`${memoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\`. It is an index, not a memory: each entry must be one line in the form \`- [Title](relative/path.md) — one-line hook\`. Never write memory content directly into the index.`,
    '- If you create or delete a memory file, also update the managed memory index.',
    '- If nothing durable should be saved, make no file changes.',
    '',
    '## Existing memory files',
    '',
    topicSummaries || '(none yet)',
  ].join('\n');
}

/**
 * Derive which memory topics were touched from the list of file paths written
 * during the agent run. Avoids requiring JSON output from the agent.
 */
function touchedTopicsFromFilePaths(
  filePaths: string[],
  projectRoot: string,
): AutoMemoryType[] {
  const memoryRoot = getAutoMemoryRoot(projectRoot);
  const topicSet = new Set<AutoMemoryType>();
  for (const p of filePaths) {
    if (!p.startsWith(memoryRoot)) continue;
    const rel = p.slice(memoryRoot.length).replace(/^\//, '');
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
  return [...topicSet];
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
  const memoryRoot = getAutoMemoryRoot(projectRoot);
  const scopedConfig = createMemoryScopedAgentConfig(config, projectRoot);

  const result = await runForkedAgent({
    name: 'managed-auto-memory-extractor',
    config: scopedConfig,
    taskPrompt: buildTaskPrompt(memoryRoot, topicSummaries),
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
    skipEnvHistory: true,
  });

  if (result.status !== 'completed') {
    throw new Error(
      result.terminateReason ||
        'Extraction agent did not complete successfully',
    );
  }

  const touchedTopics = touchedTopicsFromFilePaths(
    result.filesTouched,
    projectRoot,
  );

  return {
    touchedTopics,
    systemMessage:
      touchedTopics.length > 0
        ? `Managed auto-memory updated: ${touchedTopics.map((t) => `${t}.md`).join(', ')}`
        : undefined,
  };
}
