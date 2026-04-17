/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  runForkedAgent,
  type ForkedAgentResult,
} from '../utils/forkedAgent.js';
import { getProjectHash, QWEN_DIR } from '../utils/paths.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryRoot,
  isAutoMemPath,
} from './paths.js';
import { ToolNames } from '../tools/tool-names.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type {
  PermissionCheckContext,
  PermissionDecision,
} from '../permissions/types.js';
import { isShellCommandReadOnlyAST } from '../utils/shellAstParser.js';
import { stripShellWrapper } from '../utils/shell-utils.js';

const MAX_TURNS = 8;
const MAX_TIME_MINUTES = 5;

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

const DREAM_AGENT_SYSTEM_PROMPT = `You are performing a managed memory dream — a reflective pass over durable memory files.

Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Rules:
- Merge semantically duplicate entries — if the same fact appears in multiple files, consolidate into one file and delete the rest.
- Preserve all durable information; do not delete content that is still accurate.
- Fix contradicted or stale facts only when the evidence is clear from the existing memory content or recent transcript signal.
- Update the MEMORY.md index to accurately reflect surviving files.
- Keep the MEMORY.md index concise: one line per file in the format \`- [Title](relative/path.md) — one-line hook\`.
- If nothing needs consolidation, do nothing and say so.`;

function getTranscriptDir(projectRoot: string): string {
  const projectHash = getProjectHash(projectRoot);
  return `${QWEN_DIR}/tmp/${projectHash}/chats`;
}

export function buildConsolidationTaskPrompt(
  memoryRoot: string,
  transcriptDir: string,
): string {
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
    '- If `logs/` or `sessions/` subdirectories exist, review recent entries there',
    '',
    '## Phase 2 — Gather recent signal',
    '',
    'Look for new information worth persisting. Sources in rough priority order:',
    '',
    '1. Existing memories that drifted — facts that contradict something you now know from current memory files',
    '2. Transcript search — if you need specific context, grep session transcripts for narrow terms:',
    `   \`grep -rn "<narrow term>" ${transcriptDir}/ --include="*.jsonl" | tail -50\``,
    '',
    "Don't exhaustively read transcripts. Look only for things you already suspect matter.",
    '',
    '## Phase 3 — Consolidate',
    '',
    'For each topic directory:',
    '- Identify duplicate or near-duplicate `.md` files (same fact expressed differently)',
    '- Merge duplicates: write the canonical version into one file, delete the redundant files',
    '- Fix stale or contradicted facts when clear from the existing content',
    '- Convert relative dates (for example: "yesterday", "last week") to absolute dates when preserving them',
    '',
    '## Phase 4 — Prune and index',
    '',
    `Update \`${memoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\` to reflect surviving files.`,
    'Each entry: `- [Title](relative/path.md) — one-line hook`',
    'Keep the index under roughly 200 lines and ~25KB.',
    'Remove pointers to deleted, stale, wrong, or superseded files. Add pointers to any newly created files.',
    'If an index line is too verbose, shorten it and move the detail back into the memory file itself.',
    '',
    '---',
    '',
    'Return a brief summary of what you consolidated, updated, or pruned. If nothing needed consolidation, say so briefly.',
  ].join('\n');
}

export async function planManagedAutoMemoryDreamByAgent(
  config: Config,
  projectRoot: string,
): Promise<ForkedAgentResult> {
  const memoryRoot = getAutoMemoryRoot(projectRoot);
  const transcriptDir = getTranscriptDir(projectRoot);
  const scopedConfig = createMemoryScopedAgentConfig(config, projectRoot);
  const result = await runForkedAgent({
    name: 'managed-auto-memory-dreamer',
    config: scopedConfig,
    taskPrompt: buildConsolidationTaskPrompt(memoryRoot, transcriptDir),
    systemPrompt: DREAM_AGENT_SYSTEM_PROMPT,
    maxTurns: MAX_TURNS,
    maxTimeMinutes: MAX_TIME_MINUTES,
    tools: [
      ToolNames.READ_FILE,
      ToolNames.GREP,
      ToolNames.GLOB,
      ToolNames.LS,
      ToolNames.SHELL,
      ToolNames.WRITE_FILE,
      ToolNames.EDIT,
    ],
  });

  if (result.status === 'failed') {
    throw new Error(result.terminateReason || 'Dream agent failed');
  }

  return result;
}
