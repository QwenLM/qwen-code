import type { SkillConfig, SkillValidationResult } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import { createDebugLogger } from '../utils/debugLogger.js';

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
      // Only process directories (each skill is a directory)
      if (!entry.isDirectory()) {
        debugLogger.warn(`Skipping non-directory entry: ${entry.name}`);
        continue;
      }

      const skillDir = path.join(baseDir, entry.name);
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

/**
 * Normalizes skill file content for consistent parsing across platforms.
 * - Strips UTF-8 BOM to ensure frontmatter starts at the first character.
 * - Normalizes line endings so skills authored on Windows (CRLF) parse correctly.
 */
function normalizeSkillFileContent(content: string): string {
  // Strip UTF-8 BOM to ensure frontmatter starts at the first character.
  let normalized = content.replace(/^\uFEFF/, '');

  // Normalize line endings so skills authored on Windows (CRLF) parse correctly.
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return normalized;
}

export function parseSkillContent(
  content: string,
  filePath: string,
): SkillConfig {
  debugLogger.debug(`Parsing skill content from: ${filePath}`);

  // Normalize content to handle BOM and CRLF line endings
  const normalizedContent = normalizeSkillFileContent(content);

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

  const config: SkillConfig = {
    name,
    description,
    allowedTools,
    filePath,
    body: body.trim(),
    level: 'extension',
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
