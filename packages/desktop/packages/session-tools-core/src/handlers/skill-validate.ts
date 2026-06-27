/**
 * Skill Validate Handler
 *
 * Validates a skill's SKILL.md file for correct format and required fields.
 * Resolves skills from all three tiers: project > workspace > global.
 *
 * The handler resolves the session's workingDirectory on demand from the
 * persisted session.jsonl header — no construction-time propagation needed.
 * If resolution fails, project-tier skills are silently skipped with a warning.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import { resolveSessionWorkingDirectory } from '../source-helpers.ts';
import {
  validateSlug,
  validateSkillContent,
  formatValidationResult,
} from '../validation.ts';

export interface SkillValidateArgs {
  skillSlug: string;
}

/**
 * Resolve the SKILL.md path by checking all three tiers (project > workspace > global).
 * Returns the first match, or null if not found anywhere.
 */
function resolveSkillMdPath(
  ctx: SessionToolContext,
  slug: string,
  workingDirectory: string | undefined
): { path: string; tier: string } | null {
  // 1. Project-level (highest priority): {projectRoot}/.agents/skills/{slug}/SKILL.md
  if (workingDirectory) {
    const projectPath = join(workingDirectory, '.agents', 'skills', slug, 'SKILL.md');
    if (ctx.fs.exists(projectPath)) {
      return { path: projectPath, tier: 'project' };
    }
  }

  // 2. Workspace-level (medium priority): {workspace}/skills/{slug}/SKILL.md
  const workspacePath = join(ctx.workspacePath, 'skills', slug, 'SKILL.md');
  if (ctx.fs.exists(workspacePath)) {
    return { path: workspacePath, tier: 'workspace' };
  }

  // 3. Global-level (lowest priority): ~/.agents/skills/{slug}/SKILL.md
  const globalPath = join(homedir(), '.agents', 'skills', slug, 'SKILL.md');
  if (ctx.fs.exists(globalPath)) {
    return { path: globalPath, tier: 'global' };
  }

  return null;
}

/**
 * Handle the skill_validate tool call.
 *
 * 1. Validate slug format
 * 2. Resolve workingDirectory from ctx or session header (graceful fallback)
 * 3. Resolve SKILL.md from all three tiers (project > workspace > global)
 * 4. Read and validate content (frontmatter + body)
 * 5. Return validation result with warnings if project tier was skipped
 */
export async function handleSkillValidate(
  ctx: SessionToolContext,
  args: SkillValidateArgs
): Promise<ToolResult> {
  const { skillSlug } = args;

  // Validate slug format first
  const slugResult = validateSlug(skillSlug);
  if (!slugResult.valid) {
    return {
      content: [{ type: 'text', text: formatValidationResult(slugResult) }],
      isError: true,
    };
  }

  // Resolve workingDirectory: ctx first (if factories ever populate it), then session header
  const workingDirectory = ctx.workingDirectory
    ?? resolveSessionWorkingDirectory(ctx.workspacePath, ctx.sessionId);

  // Resolve SKILL.md from all three tiers
  const resolved = resolveSkillMdPath(ctx, skillSlug, workingDirectory);
  if (!resolved) {
    const searchedPaths = [
      workingDirectory ? `  - ${join(workingDirectory, '.agents', 'skills', skillSlug, 'SKILL.md')} (project)` : null,
      `  - ${join(ctx.workspacePath, 'skills', skillSlug, 'SKILL.md')} (workspace)`,
      `  - ${join(homedir(), '.agents', 'skills', skillSlug, 'SKILL.md')} (global)`,
    ].filter(Boolean).join('\n');

    const warning = !workingDirectory
      ? '\n\nNote: Project-level skills (.agents/skills/) were not checked — working directory could not be resolved.'
      : '';

    return errorResponse(
      `SKILL.md not found for skill "${skillSlug}". Searched:\n${searchedPaths}${warning}\n\nCreate it with YAML frontmatter.`
    );
  }

  // Read and validate content
  let content: string;
  try {
    content = ctx.fs.readFile(resolved.path);
  } catch (e) {
    return errorResponse(
      `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`
    );
  }

  const result = validateSkillContent(content, skillSlug);
  const tierInfo = `Validated from ${resolved.tier} tier: ${resolved.path}`;
  const formatted = formatValidationResult(result);

  // If workingDirectory couldn't be resolved, warn that project tier was skipped
  const warnings: string[] = [];
  if (!workingDirectory) {
    warnings.push('Note: Project-level skills (.agents/skills/) were not checked — working directory could not be resolved.');
  }
  const warningText = warnings.length > 0 ? '\n\n' + warnings.join('\n') : '';

  return {
    content: [{ type: 'text', text: `${tierInfo}\n\n${formatted}${warningText}` }],
    isError: !result.valid, // warnings don't make it an error
  };
}
