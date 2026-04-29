/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import * as fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type {
  PermissionCheckContext,
  PermissionDecision,
} from '../permissions/types.js';
import { runForkedAgent } from '../utils/forkedAgent.js';
import { buildFunctionResponseParts } from '../tools/agent/fork-subagent.js';
import { ToolNames } from '../tools/tool-names.js';
import { isShellCommandReadOnlyAST } from '../utils/shellAstParser.js';
import { stripShellWrapper } from '../utils/shell-utils.js';
import {
  getProjectSkillsRoot,
  isProjectSkillPath,
} from '../skills/skill-paths.js';

export const SKILL_REVIEW_AGENT_NAME = 'managed-skill-extractor' as const;
export const DEFAULT_AUTO_SKILL_MAX_TURNS = 8;
export const DEFAULT_AUTO_SKILL_TIMEOUT_MS = 120_000;

export interface SkillReviewExecutionResult {
  touchedSkillFiles: string[];
  systemMessage?: string;
}

type SkillScopedPermissionManager = Pick<
  PermissionManager,
  | 'evaluate'
  | 'findMatchingDenyRule'
  | 'hasMatchingAskRule'
  | 'hasRelevantRules'
  | 'isToolEnabled'
>;

/**
 * Returns true if the file at `filePath` exists and contains
 * `source: auto-skill` in its YAML frontmatter block.
 * Returns false if the file does not exist (caller may allow creation).
 */
async function hasAutoSkillSource(filePath: string): Promise<boolean | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    // File does not exist — allow creation.
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  if (!match) return false;
  return /^\s*source:\s*auto-skill\s*$/m.test(match[1]);
}

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
    case ToolNames.WRITE_FILE: {
      if (!ctx.filePath || !isProjectSkillPath(ctx.filePath, projectRoot)) {
        return 'deny';
      }
      // For existing files, verify source: auto-skill is present.
      const sourceFlag = await hasAutoSkillSource(ctx.filePath);
      if (sourceFlag === null) {
        // File does not exist yet — allow creation.
        return 'allow';
      }
      return sourceFlag ? 'allow' : 'deny';
    }
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
      return 'ManagedSkillReview(run_shell_command: read-only only)';
    case ToolNames.EDIT:
      return `ManagedSkillReview(edit: only within ${getProjectSkillsRoot(projectRoot)} and only on skills with 'source: auto-skill' in frontmatter)`;
    case ToolNames.WRITE_FILE:
      return `ManagedSkillReview(write_file: only within ${getProjectSkillsRoot(projectRoot)}; existing files must have 'source: auto-skill' in frontmatter)`;
    default:
      return undefined;
  }
}

export function createSkillScopedAgentConfig(
  config: Config,
  projectRoot: string,
): Config {
  const basePm = config.getPermissionManager?.();
  const scopedPm: SkillScopedPermissionManager = {
    hasRelevantRules(ctx: PermissionCheckContext): boolean {
      return isScopedTool(ctx.toolName) || !!basePm?.hasRelevantRules(ctx);
    },
    hasMatchingAskRule(ctx: PermissionCheckContext): boolean {
      return basePm?.hasMatchingAskRule(ctx) ?? false;
    },
    findMatchingDenyRule(ctx: PermissionCheckContext): string | undefined {
      const scoped = getScopedDenyRule(ctx, projectRoot);
      if (scoped) return scoped;
      return basePm?.findMatchingDenyRule(ctx);
    },
    async evaluate(ctx: PermissionCheckContext): Promise<PermissionDecision> {
      const scopedDecision = await evaluateScopedDecision(ctx, projectRoot);
      if (!basePm) return scopedDecision;
      const baseDecision = basePm.hasRelevantRules(ctx)
        ? await basePm.evaluate(ctx)
        : 'default';
      return mergePermissionDecision(scopedDecision, baseDecision);
    },
    async isToolEnabled(toolName: string): Promise<boolean> {
      if (isScopedTool(toolName)) return true;
      if (basePm) return basePm.isToolEnabled(toolName);
      return true;
    },
  };

  const scopedConfig = Object.create(config) as Config;
  scopedConfig.getPermissionManager = () =>
    scopedPm as unknown as PermissionManager;
  return scopedConfig;
}

const SKILL_REVIEW_SYSTEM_PROMPT = [
  'You are reviewing this conversation to extract reusable skills.',
  '',
  'Review the conversation above and consider saving or updating a skill if appropriate.',
  '',
  "Focus on: was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way, or did the user expect or desire a different method or outcome? If a relevant skill already exists and has 'source: auto-skill' in its frontmatter, update it with what you learned. Otherwise, create a new skill if the approach is reusable.",
  '',
  'IMPORTANT constraints:',
  "- You may ONLY modify skill files that contain 'source: auto-skill' in their YAML frontmatter. Always read a skill file before editing it.",
  '- Do NOT touch skills that lack this marker — they were created by the user.',
  "- When creating a new skill, you MUST include 'source: auto-skill' in the frontmatter so future review agents can safely update it.",
  '- Do NOT delete any skill. Only create or update.',
  '',
  "If nothing is worth saving, just say 'Nothing to save.' and stop.",
].join('\n');

function buildAgentHistory(history: Content[]): Content[] {
  if (history.length === 0) return [];
  const last = history[history.length - 1];
  if (last.role !== 'model') return history.slice(0, -1);
  const openCalls = (last.parts ?? []).filter((p) => p.functionCall);
  if (openCalls.length === 0) return [...history];
  const toolResponses = buildFunctionResponseParts(
    last,
    'Background skill review started.',
  );
  return [
    ...history,
    { role: 'user' as const, parts: toolResponses },
    { role: 'model' as const, parts: [{ text: 'Acknowledged.' }] },
  ];
}

function buildTaskPrompt(skillsRoot: string): string {
  return [
    `Project skills directory: \`${skillsRoot}\``,
    '',
    'Use `ls` and `read_file` to inspect existing skills before writing.',
    'Use `write_file` to create a new skill, `edit` to update an existing auto-skill.',
    "Each skill lives at .qwen/skills/<name>/SKILL.md. Skills you create MUST include 'source: auto-skill' in the frontmatter:",
    '',
    '---',
    'name: <skill-name>',
    'description: <one-line description>',
    'source: auto-skill',
    `extracted_at: '${new Date().toISOString()}'`,
    '---',
    '',
    '<markdown body with the procedure/approach>',
  ].join('\n');
}

export async function runSkillReviewByAgent(params: {
  config: Config;
  projectRoot: string;
  history: Content[];
  maxTurns?: number;
  timeoutMs?: number;
}): Promise<SkillReviewExecutionResult> {
  const skillsRoot = getProjectSkillsRoot(params.projectRoot);
  const scopedConfig = createSkillScopedAgentConfig(
    params.config,
    params.projectRoot,
  );
  const result = await runForkedAgent({
    name: SKILL_REVIEW_AGENT_NAME,
    config: scopedConfig,
    taskPrompt: buildTaskPrompt(skillsRoot),
    systemPrompt: SKILL_REVIEW_SYSTEM_PROMPT,
    maxTurns: params.maxTurns ?? DEFAULT_AUTO_SKILL_MAX_TURNS,
    maxTimeMinutes:
      (params.timeoutMs ?? DEFAULT_AUTO_SKILL_TIMEOUT_MS) / 60_000,
    tools: [
      ToolNames.READ_FILE,
      ToolNames.LS,
      ToolNames.SHELL,
      ToolNames.WRITE_FILE,
      ToolNames.EDIT,
    ],
    extraHistory: buildAgentHistory(params.history),
  });

  if (result.status !== 'completed') {
    throw new Error(
      result.terminateReason ||
        'Skill review agent did not complete successfully',
    );
  }

  const touchedSkillFiles = result.filesTouched.filter((filePath) =>
    isProjectSkillPath(filePath, params.projectRoot),
  );
  return {
    touchedSkillFiles,
    systemMessage:
      touchedSkillFiles.length > 0
        ? `Skill review updated ${touchedSkillFiles.length} file(s).`
        : undefined,
  };
}
