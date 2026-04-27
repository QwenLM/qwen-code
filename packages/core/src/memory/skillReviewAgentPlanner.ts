/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
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

function isScopedTool(toolName: string): boolean {
  return (
    toolName === ToolNames.SHELL ||
    toolName === ToolNames.EDIT ||
    toolName === ToolNames.WRITE_FILE ||
    toolName === ToolNames.SKILL_MANAGE
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
      return ctx.filePath && isProjectSkillPath(ctx.filePath, projectRoot)
        ? 'allow'
        : 'deny';
    case ToolNames.SKILL_MANAGE:
      return 'allow';
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
      return `ManagedSkillReview(edit: only within ${getProjectSkillsRoot(projectRoot)})`;
    case ToolNames.WRITE_FILE:
      return `ManagedSkillReview(write_file: only within ${getProjectSkillsRoot(projectRoot)})`;
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
  'You may create new skills or update existing ones.',
  'Do NOT delete any skills unless the user has explicitly requested deletion in this conversation. Autonomous deletion is not permitted.',
  '',
  'Review the conversation above and consider saving or updating a skill if appropriate.',
  '',
  'Focus on: was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way, or did the user expect or desire a different method or outcome? If a relevant skill already exists, update it with what you learned. Otherwise, create a new skill if the approach is reusable.',
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
    'Use `list_directory` and `read_file` to inspect existing skills before writing.',
    'Use `skill_manage` to create or update project-level skills only.',
    'Each skill requires a SKILL.md with YAML frontmatter:',
    '',
    '---',
    'name: <skill-name>',
    'description: <one-line description>',
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
      ToolNames.SKILL_MANAGE,
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
