/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type {
  PermissionCheckContext,
  PermissionDecision,
} from '../permissions/types.js';
import { runForkedAgent } from '../utils/forkedAgent.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  assertRealProjectSkillPath,
  getProjectSkillsRoot,
  isProjectSkillPath,
  SKILL_FILE_NAME,
} from '../skills/skill-paths.js';
import {
  buildAgentHistory,
  listExistingSkillDirNames,
} from './skillReviewAgentPlanner.js';

export const LEARN_SKILL_AGENT_NAME = 'learn-skill-creator' as const;
export const DEFAULT_LEARN_SKILL_MAX_TURNS = 12;
export const DEFAULT_LEARN_SKILL_TIMEOUT_MS = 180_000;

/**
 * Mandatory directory-name prefix for skills created by the `/learn` command.
 * The project `.gitignore` re-ignores directories matching
 * `.qwen/skills/learned-skill-<glob>` so these user-initiated learned skills
 * stay out of version control. The `source: learned` frontmatter marker is
 * the file-level signal for edit protection (analogous to `source: auto-skill`
 * for auto-generated skills).
 */
export const LEARNED_SKILL_DIR_PREFIX = 'learned-skill-' as const;

export interface LearnSkillInput {
  rawInput: string;
}

export interface LearnSkillResult {
  touchedSkillFiles: string[];
  summary?: string;
}

type LearnScopedPermissionManager = Pick<
  PermissionManager,
  | 'evaluate'
  | 'findMatchingDenyRule'
  | 'hasMatchingAskRule'
  | 'hasRelevantRules'
  | 'isToolEnabled'
>;

async function hasLearnedSource(filePath: string): Promise<boolean | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return false;
  }
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(
    content,
  );
  if (!match) return false;
  return /^source:\s*learned\s*$/m.test(match[1]);
}

function isLearnScopedTool(toolName: string): boolean {
  return (
    toolName === ToolNames.READ_FILE ||
    toolName === ToolNames.LS ||
    toolName === ToolNames.GREP ||
    toolName === ToolNames.EDIT ||
    toolName === ToolNames.WRITE_FILE ||
    toolName === ToolNames.WEB_FETCH
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

async function evaluateLearnScopedDecision(
  ctx: PermissionCheckContext,
  projectRoot: string,
): Promise<PermissionDecision> {
  switch (ctx.toolName) {
    case ToolNames.READ_FILE:
    case ToolNames.LS:
    case ToolNames.GREP:
    case ToolNames.WEB_FETCH:
      // /learn is user-initiated — allow reading from any location and
      // fetching any URL. The user explicitly chose to learn from these sources.
      return 'allow';

    case ToolNames.EDIT: {
      if (!ctx.filePath || !isProjectSkillPath(ctx.filePath, projectRoot)) {
        return 'deny';
      }
      try {
        await assertRealProjectSkillPath(ctx.filePath, projectRoot);
      } catch {
        return 'deny';
      }
      const sourceFlag = await hasLearnedSource(ctx.filePath);
      if (sourceFlag === null) {
        return 'allow';
      }
      return sourceFlag ? 'allow' : 'deny';
    }

    case ToolNames.WRITE_FILE: {
      if (!ctx.filePath || !isProjectSkillPath(ctx.filePath, projectRoot)) {
        return 'deny';
      }
      if (path.basename(ctx.filePath) !== SKILL_FILE_NAME) {
        return 'deny';
      }
      try {
        await assertRealProjectSkillPath(ctx.filePath, projectRoot);
      } catch {
        return 'deny';
      }
      try {
        await fs.stat(ctx.filePath);
        return 'deny';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'allow';
        return 'deny';
      }
    }

    default:
      return 'default';
  }
}

function getLearnScopedDenyRule(
  ctx: PermissionCheckContext,
  projectRoot: string,
): string | undefined {
  switch (ctx.toolName) {
    case ToolNames.READ_FILE:
    case ToolNames.LS:
    case ToolNames.GREP:
    case ToolNames.WEB_FETCH:
      return undefined;
    case ToolNames.EDIT:
      return `LearnSkill(edit: only within ${getProjectSkillsRoot(projectRoot)} and only on skills with 'source: learned' in frontmatter)`;
    case ToolNames.WRITE_FILE:
      return `LearnSkill(write_file: only within ${getProjectSkillsRoot(projectRoot)} and only to a path that does not yet exist — use a different skill name, or use \`edit\` to update an existing learned skill)`;
    default:
      return undefined;
  }
}

export function createLearnSkillScopedAgentConfig(
  config: Config,
  projectRoot: string,
): Config {
  const basePm = config.getPermissionManager?.();
  const scopedPm: LearnScopedPermissionManager = {
    hasRelevantRules(ctx: PermissionCheckContext): boolean {
      return isLearnScopedTool(ctx.toolName) || !!basePm?.hasRelevantRules(ctx);
    },
    hasMatchingAskRule(ctx: PermissionCheckContext): boolean {
      return basePm?.hasMatchingAskRule(ctx) ?? false;
    },
    findMatchingDenyRule(ctx: PermissionCheckContext): string | undefined {
      const scoped = getLearnScopedDenyRule(ctx, projectRoot);
      if (scoped) return scoped;
      return basePm?.findMatchingDenyRule(ctx);
    },
    async evaluate(ctx: PermissionCheckContext): Promise<PermissionDecision> {
      const scopedDecision = await evaluateLearnScopedDecision(
        ctx,
        projectRoot,
      );
      if (!basePm) return scopedDecision;
      const baseDecision = basePm.hasRelevantRules(ctx)
        ? await basePm.evaluate(ctx)
        : 'default';
      return mergePermissionDecision(scopedDecision, baseDecision);
    },
    async isToolEnabled(toolName: string): Promise<boolean> {
      if (isLearnScopedTool(toolName)) return true;
      if (basePm) return basePm.isToolEnabled(toolName);
      return true;
    },
  };

  const scopedConfig = Object.create(config) as Config;
  scopedConfig.getPermissionManager = () =>
    scopedPm as unknown as PermissionManager;
  return scopedConfig;
}

export const LEARN_SKILL_SYSTEM_PROMPT = [
  'You are creating a reusable skill from a knowledge source the user has pointed you to.',
  '',
  'Your task is to read/fetch the provided source material, understand it, and create a well-structured SKILL.md file that captures the key knowledge as an actionable, reusable procedure.',
  '',
  'How to handle different input types:',
  '- File/directory paths: use read_file / list_directory / grep_search to explore the content',
  '- URLs: use web_fetch to retrieve the content',
  '- Conversation context: review the conversation history provided to you',
  '- Freetext descriptions: the knowledge is embedded directly in the task prompt',
  '',
  'IMPORTANT constraints:',
  `- When creating a new skill, its directory MUST use the \`${LEARNED_SKILL_DIR_PREFIX}\` prefix (e.g. \`.qwen/skills/${LEARNED_SKILL_DIR_PREFIX}<name>/SKILL.md\`). Keep the frontmatter \`name:\` as the natural \`<name>\` without the prefix.`,
  "- The frontmatter MUST include 'source: learned' so the system can distinguish user-initiated learned skills.",
  "- You may ONLY modify skill files that contain 'source: learned' in their YAML frontmatter. Always read a skill file before editing it.",
  '- Do NOT touch skills that lack this marker — they were created by the user or another system.',
  '',
  'Skill format — the SKILL.md must follow this structure:',
  '1. YAML frontmatter with name, description, source fields',
  '2. A markdown body that includes:',
  '   - A clear title',
  '   - When to use this skill (trigger conditions)',
  '   - Step-by-step procedure',
  '   - Common pitfalls or failure modes (if applicable)',
  '',
  'Distill the knowledge into an actionable, step-by-step procedure that can be followed in future sessions.',
  "If the input does not contain useful knowledge for a skill, say 'Nothing useful to extract.' and stop.",
].join('\n');

/**
 * Build a prompt that instructs the main model to create a skill from the
 * given knowledge source. Used by the `/learn` slash command via
 * `submit_prompt` — the model runs in the normal turn with its full tool set.
 */
export function buildLearnSkillPrompt(
  rawInput: string,
  projectRoot: string,
): string {
  const skillsRoot = getProjectSkillsRoot(projectRoot);
  return [
    'Create a reusable skill from the following knowledge source.',
    '',
    `Knowledge source:\n${rawInput}`,
    '',
    'Instructions:',
    '- If the source is a URL, use web_fetch to retrieve the content.',
    '- If the source is a file/directory path, use read_file / list_directory to read it.',
    '- If the source is a text description, use it directly.',
    '- Distill the knowledge into a well-structured SKILL.md file.',
    '',
    `The skill MUST be saved at \`${skillsRoot}/${LEARNED_SKILL_DIR_PREFIX}<name>/SKILL.md\`.`,
    "The YAML frontmatter MUST include 'source: learned'.",
    'Keep the frontmatter `name:` as the natural `<name>` without the directory prefix.',
    '',
    'Required SKILL.md format:',
    '```',
    '---',
    'name: <skill-name>',
    'description: <one-line description>',
    'source: learned',
    '---',
    '',
    '# <Skill Title>',
    '',
    '## When to Use',
    '<trigger conditions>',
    '',
    '## Procedure',
    '<numbered steps>',
    '',
    '## Pitfalls',
    '<common failure modes>',
    '```',
  ].join('\n');
}

export async function buildLearnTaskPrompt(
  projectRoot: string,
  input: LearnSkillInput,
): Promise<string> {
  const skillsRoot = getProjectSkillsRoot(projectRoot);
  const existing = await listExistingSkillDirNames(projectRoot);
  const existingLine =
    existing.length === 0
      ? '(no skills exist yet — any name is available)'
      : `Existing skill names (do NOT reuse for write_file; use \`edit\` if you want to update one of these): ${existing.join(', ')}`;

  return [
    `Project skills directory: \`${skillsRoot}\``,
    '',
    existingLine,
    '',
    `Knowledge source to learn from:\n${input.rawInput}`,
    '',
    'Use the appropriate tools to gather the knowledge, then create a skill.',
    'Use `write_file` to create a new skill, `edit` to update an existing learned skill.',
    `New skills you create MUST live at \`.qwen/skills/${LEARNED_SKILL_DIR_PREFIX}<name>/SKILL.md\`. The frontmatter MUST include 'source: learned':`,
    '',
    '---',
    'name: <skill-name>',
    'description: <one-line description>',
    'source: learned',
    `learned_at: '${new Date().toISOString()}'`,
    '---',
    '',
    '<markdown body with the procedure/approach>',
  ].join('\n');
}

export async function runLearnSkillByAgent(params: {
  config: Config;
  projectRoot: string;
  input: LearnSkillInput;
  history: Content[];
  maxTurns?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<LearnSkillResult> {
  const scopedConfig = createLearnSkillScopedAgentConfig(
    params.config,
    params.projectRoot,
  );
  const result = await runForkedAgent({
    name: LEARN_SKILL_AGENT_NAME,
    config: scopedConfig,
    taskPrompt: await buildLearnTaskPrompt(params.projectRoot, params.input),
    systemPrompt: LEARN_SKILL_SYSTEM_PROMPT,
    maxTurns: params.maxTurns ?? DEFAULT_LEARN_SKILL_MAX_TURNS,
    maxTimeMinutes:
      (params.timeoutMs ?? DEFAULT_LEARN_SKILL_TIMEOUT_MS) / 60_000,
    tools: [
      ToolNames.READ_FILE,
      ToolNames.LS,
      ToolNames.GREP,
      ToolNames.WRITE_FILE,
      ToolNames.EDIT,
      ToolNames.WEB_FETCH,
    ],
    extraHistory: buildAgentHistory(params.history),
    abortSignal: params.abortSignal,
  });

  if (result.status !== 'completed') {
    throw new Error(
      result.terminateReason ||
        'Learn skill agent did not complete successfully',
    );
  }

  const touchedSkillFiles = result.filesTouched.filter((filePath) =>
    isProjectSkillPath(filePath, params.projectRoot),
  );
  return {
    touchedSkillFiles,
    summary: result.finalText ?? undefined,
  };
}
