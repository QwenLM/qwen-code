import {
  type SkillConfig,
  type SkillValidationResult,
  parseModelField,
  parsePathsField,
  validateSkillName,
} from './types.js';
import { validateSymlinkTarget } from './symlinkScope.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizeContent } from '../utils/textUtils.js';

const debugLogger = createDebugLogger('SKILL_LOAD');

const SKILL_MANIFEST_FILE = 'SKILL.md';

export async function loadSkillsFromDir(
  baseDir: string,
): Promise<SkillConfig[]> {
  debugLogger.debug(`Loading skills from directory (skill-load): ${baseDir}`);
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const skills: SkillConfig[] = [];
    debugLogger.debug(`Found ${entries.length} entries in ${baseDir}`);

    for (const entry of entries) {
      // Process directories and symlinks that resolve to directories.
      // Plain files are silently skipped (each skill must be a directory).
      const isDirectory = entry.isDirectory();
      const isSymlink = entry.isSymbolicLink();

      if (!isDirectory && !isSymlink) {
        debugLogger.warn(`Skipping non-directory entry: ${entry.name}`);
        continue;
      }

      const skillDir = path.join(baseDir, entry.name);

      // For symlinks, verify the target (a) resolves and (b) is a
      // directory. Shared with `skill-manager.ts` so the two parsers
      // stay in sync. Targets pointing outside `baseDir` are allowed
      // — see `symlinkScope.ts` for the rationale.
      if (isSymlink) {
        const check = await validateSymlinkTarget(skillDir);
        if (!check.ok) {
          if (check.reason === 'not-directory') {
            debugLogger.warn(
              `Skipping symlink ${entry.name} that does not point to a directory`,
            );
          } else {
            debugLogger.warn(
              `Skipping invalid symlink ${entry.name}: ${check.error instanceof Error ? check.error.message : 'Unknown error'}`,
            );
          }
          continue;
        }
      }
      const skillManifest = path.join(skillDir, SKILL_MANIFEST_FILE);

      try {
        // Check if SKILL.md exists
        await fs.access(skillManifest);

        const content = await fs.readFile(skillManifest, 'utf8');
        const config = parseSkillContent(content, skillManifest);
        skills.push(config);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        debugLogger.error(
          `Failed to parse skill at ${skillDir}: ${errorMessage}`,
        );
        continue;
      }
    }

    return skills;
  } catch (error) {
    // Directory doesn't exist or can't be read
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    debugLogger.debug(
      `Cannot read skills directory ${baseDir}: ${errorMessage}`,
    );
    return [];
  }
}

export function parseSkillContent(
  content: string,
  filePath: string,
): SkillConfig {
  debugLogger.debug(`Parsing skill content from: ${filePath}`);

  // Normalize content to handle BOM and CRLF line endings
  const normalizedContent = normalizeContent(content);

  // Split frontmatter and content
  // Use (?:\n|$) to allow frontmatter ending with or without trailing newline
  const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
  const match = normalizedContent.match(frontmatterRegex);

  if (!match) {
    throw new Error('Invalid format: missing YAML frontmatter');
  }

  const [, frontmatterYaml, body] = match;

  // Parse YAML frontmatter
  const frontmatter = parseYaml(frontmatterYaml) as Record<string, unknown>;

  // Extract required fields
  const nameRaw = frontmatter['name'];
  const descriptionRaw = frontmatter['description'];

  if (nameRaw == null || nameRaw === '') {
    throw new Error('Missing "name" in frontmatter');
  }

  if (descriptionRaw == null || descriptionRaw === '') {
    throw new Error('Missing "description" in frontmatter');
  }

  // Convert to strings
  const name = String(nameRaw);
  // Reject unsafe names early — the value flows into the SkillTool
  // description, schema enums, and the path-activation
  // <system-reminder>, all of which the model treats as trusted text.
  validateSkillName(name);
  const description = String(descriptionRaw);

  // Extract optional fields
  const allowedToolsRaw = frontmatter['allowedTools'] as unknown[] | undefined;
  let allowedTools: string[] | undefined;

  if (allowedToolsRaw !== undefined) {
    if (Array.isArray(allowedToolsRaw)) {
      allowedTools = allowedToolsRaw.map(String);
    } else {
      throw new Error('"allowedTools" must be an array');
    }
  }

  // Extract optional model field
  const model = parseModelField(frontmatter);
  const argumentHint =
    typeof frontmatter['argument-hint'] === 'string'
      ? frontmatter['argument-hint']
      : undefined;

  // `whenToUse` and `disable-model-invocation` were historically only
  // parsed by the project/user/bundled parser in skill-manager.ts, which
  // meant an extension SKILL.md with `disable-model-invocation: true`
  // had the flag silently stripped — and (post-paths PR) would still
  // fire path-activation reminders for a skill the model can't invoke.
  // Extract them here too so the extension and managed parsers agree.
  const whenToUse =
    typeof frontmatter['when_to_use'] === 'string'
      ? frontmatter['when_to_use']
      : undefined;
  const disableModelInvocationRaw = frontmatter['disable-model-invocation'];
  const disableModelInvocation =
    disableModelInvocationRaw === true || disableModelInvocationRaw === 'true'
      ? true
      : undefined;

  // Optional `paths` frontmatter: glob patterns that gate when this skill
  // is offered to the model (conditional skill).
  const paths = parsePathsField(frontmatter);

  const config: SkillConfig = {
    name,
    description,
    allowedTools,
    argumentHint,
    model,
    filePath,
    // Set skillRoot to the directory containing SKILL.md so command
    // hooks for extension skills get `QWEN_SKILL_ROOT` set in their
    // environment (registerSkillHooks.ts:116 skips the env var when
    // skillRoot is undefined). Matches the project/user/bundled
    // parser in skill-manager.ts. The previous omission silently
    // broke `$QWEN_SKILL_ROOT/scripts/...` references in extension
    // skill hook commands.
    //
    // Note: extension parser still does not extract `hooks:`
    // frontmatter; that's a separate alignment task and may be
    // intentionally restricted to managed (project/user/bundled)
    // skills as a security boundary. If hooks become supported here
    // they need their own extraction pass and the same managed-vs-
    // extension trust review.
    skillRoot: path.dirname(filePath),
    body: body.trim(),
    level: 'extension',
    whenToUse,
    disableModelInvocation,
    paths,
  };

  // Validate the parsed configuration
  const validation = validateConfig(config);
  if (!validation.isValid) {
    throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
  }

  debugLogger.debug(`Successfully parsed skill: ${name} from ${filePath}`);
  return config;
}

export function validateConfig(
  config: Partial<SkillConfig>,
): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required fields
  if (typeof config.name !== 'string') {
    errors.push('Missing or invalid "name" field');
  } else if (config.name.trim() === '') {
    errors.push('"name" cannot be empty');
  }

  if (typeof config.description !== 'string') {
    errors.push('Missing or invalid "description" field');
  } else if (config.description.trim() === '') {
    errors.push('"description" cannot be empty');
  }

  // Validate allowedTools if present
  if (config.allowedTools !== undefined) {
    if (!Array.isArray(config.allowedTools)) {
      errors.push('"allowedTools" must be an array');
    } else {
      for (const tool of config.allowedTools) {
        if (typeof tool !== 'string') {
          errors.push('"allowedTools" must contain only strings');
          break;
        }
      }
    }
  }

  // Warn if body is empty
  if (!config.body || config.body.trim() === '') {
    warnings.push('Skill body is empty');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}
