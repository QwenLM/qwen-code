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
import { buildFunctionResponseParts } from '../tools/agent/fork-subagent.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  assertRealProjectSkillPath,
  getProjectSkillsRoot,
  isProjectSkillPath,
  SKILL_FILE_NAME,
} from '../skills/skill-paths.js';

export const SKILL_REVIEW_AGENT_NAME = 'managed-skill-extractor' as const;
export const DEFAULT_AUTO_SKILL_MAX_TURNS = 8;
export const DEFAULT_AUTO_SKILL_TIMEOUT_MS = 120_000;

/**
 * Mandatory directory-name prefix for skills created by the review agent.
 * The project `.gitignore` re-ignores directories matching
 * `.qwen/skills/auto-skill-<glob>` so these transient, session-specific
 * skills stay out of version control while hand-authored project skills
 * remain tracked. This is a prompt-level convention only — skill discovery
 * (`SkillManager`) is prefix-agnostic, and the `source: auto-skill`
 * frontmatter marker remains the file-level signal for edit protection.
 */
export const AUTO_SKILL_DIR_PREFIX = 'auto-skill-' as const;

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
 * Returns true if the file at `filePath` exists and its YAML frontmatter
 * contains `source: auto-skill`.
 * Returns null if the file does not exist (caller may allow creation).
 * Returns false for any other read error (EISDIR, EACCES, etc.) — caller
 * should deny in that case.
 */
async function hasAutoSkillSource(filePath: string): Promise<boolean | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File does not exist — allow creation.
      return null;
    }
    // EISDIR, EACCES, EMFILE, EPERM, etc. — deny to be safe.
    return false;
  }
  // Match the opening frontmatter block only (up to the closing ---)
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(
    content,
  );
  if (!match) return false;
  return /^source:\s*auto-skill\s*$/m.test(match[1]);
}

function isScopedTool(toolName: string): boolean {
  return (
    toolName === ToolNames.READ_FILE ||
    toolName === ToolNames.LS ||
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
    case ToolNames.READ_FILE:
    case ToolNames.LS: {
      // Read tools are allowed only within the project root. This prevents
      // the review agent from reading arbitrary files (e.g. ~/.aws/credentials)
      // and embedding them into a SKILL.md that gets committed.
      if (!ctx.filePath) return 'allow'; // no path means listing root — allow
      const resolvedRead = path.resolve(projectRoot, ctx.filePath);
      const resolvedRoot = path.resolve(projectRoot);
      if (
        resolvedRead === resolvedRoot ||
        resolvedRead.startsWith(resolvedRoot + path.sep)
      ) {
        return 'allow';
      }
      return 'deny';
    }
    case ToolNames.EDIT: {
      if (!ctx.filePath || !isProjectSkillPath(ctx.filePath, projectRoot)) {
        return 'deny';
      }
      // Reject symlink traversal (realpath check).
      try {
        await assertRealProjectSkillPath(ctx.filePath, projectRoot);
      } catch {
        return 'deny';
      }
      // For existing files, verify source: auto-skill is present.
      const sourceFlag = await hasAutoSkillSource(ctx.filePath);
      if (sourceFlag === null) {
        // File does not exist yet — allow creation (path already validated above).
        return 'allow';
      }
      return sourceFlag ? 'allow' : 'deny';
    }
    case ToolNames.WRITE_FILE: {
      // Invariant for the auto-skill flow:
      //   write_file can ONLY create a brand-new SKILL.md slot
      //   (edit is what updates an existing auto-skill).
      // Together with the EDIT case above, this gives:
      //   create new skill   → write_file at fresh <name>/SKILL.md
      //   update auto-skill  → edit on existing SKILL.md (source: auto-skill)
      // Denying writes to existing paths is the hard guard for #4437 —
      // it's what prevents an agent that picks a colliding name from
      // clobbering either another auto-skill or a user-authored skill.
      // The prompt enumeration is the soft guard above it.
      if (!ctx.filePath || !isProjectSkillPath(ctx.filePath, projectRoot)) {
        return 'deny';
      }
      // Restrict to the canonical `<name>/SKILL.md` slot. Without this,
      // the agent could write auxiliary files (notes, README, attachments)
      // anywhere under `.qwen/skills/**` — SkillManager would ignore them
      // but they still pollute the directory.
      if (path.basename(ctx.filePath) !== SKILL_FILE_NAME) {
        return 'deny';
      }
      try {
        await assertRealProjectSkillPath(ctx.filePath, projectRoot);
      } catch {
        return 'deny';
      }
      // ENOENT → file does not exist → allow creation.
      // Anything else (file present, EACCES, EISDIR, ...) → deny so we
      // never overwrite something we cannot prove is safe to clobber.
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

function getScopedDenyRule(
  ctx: PermissionCheckContext,
  projectRoot: string,
): string | undefined {
  switch (ctx.toolName) {
    case ToolNames.READ_FILE:
    case ToolNames.LS:
      return undefined; // allow within project root — no deny rule needed
    case ToolNames.EDIT:
      return `ManagedSkillReview(edit: only within ${getProjectSkillsRoot(projectRoot)} and only on skills with 'source: auto-skill' in frontmatter)`;
    case ToolNames.WRITE_FILE:
      return `ManagedSkillReview(write_file: only within ${getProjectSkillsRoot(projectRoot)} and only to a path that does not yet exist — use a different skill name like \`<name>-2\`, or use \`edit\` to update an existing auto-skill)`;
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
  `- When creating a new skill, its directory MUST use the \`${AUTO_SKILL_DIR_PREFIX}\` prefix (e.g. \`.qwen/skills/${AUTO_SKILL_DIR_PREFIX}<name>/SKILL.md\`) so the project's .gitignore keeps auto-generated skills out of version control. Keep the frontmatter \`name:\` as the natural \`<name>\` without the prefix.`,
  '- Do NOT delete any skill. Only create or update.',
  '',
  "If nothing is worth saving, just say 'Nothing to save.' and stop.",
].join('\n');

function buildAgentHistory(history: Content[]): Content[] {
  if (history.length === 0) return [];
  const last = history[history.length - 1];
  // If the final message is a user turn (not a model turn), drop it. A trailing
  // user message means the session ended mid-exchange (e.g. user sent a new
  // query that has not yet received a model response). Including it would make
  // the skill-review agent see an open "conversation" with an unanswered user
  // prompt, which can confuse the model and produce hallucinated tool calls
  // attempting to "answer" the user instead of reviewing skills.
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

/**
 * Enumerate directories under the project skills root that contain a
 * SKILL.md. Returned names are the directory basenames (the same identifier
 * the agent uses when picking `.qwen/skills/<name>/SKILL.md`).
 *
 * Best-effort: any read error (ENOENT, EACCES, ...) returns `[]` so a
 * temporarily-unreadable skills dir downgrades to "no enumeration" rather
 * than aborting the task. Exported for tests.
 */
export async function listExistingSkillDirNames(
  projectRoot: string,
): Promise<string[]> {
  const skillsRoot = getProjectSkillsRoot(projectRoot);
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    // Skill dirs can be symlinked — `skill-load.ts` and `skill-manager.ts`
    // both treat `isDirectory() || isSymbolicLink()` as "consider this a
    // skill candidate". Mirror that here so symlinked skills appear in
    // the enumeration and the agent steers clear of their names.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      await fs.stat(path.join(skillsRoot, entry.name, SKILL_FILE_NAME));
      names.push(entry.name);
    } catch {
      // No SKILL.md (or unreadable) — skip; half-built directories
      // shouldn't reserve a name.
    }
  }
  names.sort();
  return names;
}

/**
 * Exported for tests. The "(do not reuse these names)" line is the soft
 * guard for #4437 — the hard guard is `evaluateScopedDecision`'s WRITE_FILE
 * branch denying any write to an existing path.
 *
 * Takes `projectRoot` (not `skillsRoot`) so the displayed path and the
 * enumeration both derive from the same source — keeps them from drifting
 * if a future caller passes a non-standard root.
 */
export async function buildTaskPrompt(projectRoot: string): Promise<string> {
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
    'Use `ls` and `read_file` to inspect existing skills before writing.',
    'Use `write_file` to create a new skill, `edit` to update an existing auto-skill.',
    `New skills you create MUST live at \`.qwen/skills/${AUTO_SKILL_DIR_PREFIX}<name>/SKILL.md\` — the \`${AUTO_SKILL_DIR_PREFIX}\` directory prefix is mandatory so the project's .gitignore keeps auto-generated skills out of version control. Keep the frontmatter \`name:\` as the natural \`<name>\` (no prefix). The frontmatter MUST include 'source: auto-skill':`,
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
  const scopedConfig = createSkillScopedAgentConfig(
    params.config,
    params.projectRoot,
  );
  const result = await runForkedAgent({
    name: SKILL_REVIEW_AGENT_NAME,
    config: scopedConfig,
    taskPrompt: await buildTaskPrompt(params.projectRoot),
    systemPrompt: SKILL_REVIEW_SYSTEM_PROMPT,
    maxTurns: params.maxTurns ?? DEFAULT_AUTO_SKILL_MAX_TURNS,
    maxTimeMinutes:
      (params.timeoutMs ?? DEFAULT_AUTO_SKILL_TIMEOUT_MS) / 60_000,
    tools: [
      ToolNames.READ_FILE,
      ToolNames.LS,
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
