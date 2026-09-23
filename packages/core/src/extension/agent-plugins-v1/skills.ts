/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillConfig } from '../../skills/types.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { normalizeContent } from '../../utils/textUtils.js';
import { parse as parseYaml } from '../../utils/yaml-parser.js';
import { resolveContainedExistingPath } from './paths.js';

const debugLogger = createDebugLogger('AGENT_PLUGINS_V1');

export async function loadAgentPluginSkills(
  pluginRoot: string,
): Promise<SkillConfig[]> {
  const skillsPath = path.join(pluginRoot, 'skills');
  let resolvedSkillsPath: string;
  try {
    resolvedSkillsPath = resolveContainedExistingPath(pluginRoot, skillsPath);
    if (!fs.statSync(resolvedSkillsPath).isDirectory()) {
      debugLogger.warn('Agent Plugins skills path is not a directory.');
      return [];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    debugLogger.warn(
      `Disabling Agent Plugins skills: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(resolvedSkillsPath, {
      withFileTypes: true,
    });
  } catch (error) {
    debugLogger.warn(
      `Disabling Agent Plugins skills: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const skills: SkillConfig[] = [];
  for (const entry of entries) {
    const skillDir = path.join(resolvedSkillsPath, entry.name);
    try {
      const resolvedSkillDir = resolveContainedExistingPath(
        pluginRoot,
        skillDir,
      );
      if (!fs.statSync(resolvedSkillDir).isDirectory()) continue;
      const skillManifest = path.join(resolvedSkillDir, 'SKILL.md');
      const resolvedManifest = resolveContainedExistingPath(
        pluginRoot,
        skillManifest,
      );
      if (!fs.statSync(resolvedManifest).isFile()) continue;
      const content = await fs.promises.readFile(resolvedManifest, 'utf8');
      skills.push(parseAgentPluginSkill(content, resolvedManifest, entry.name));
    } catch (error) {
      debugLogger.warn(
        `Skipping Agent Plugins skill "${entry.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return skills;
}

export function parseAgentPluginSkill(
  content: string,
  filePath: string,
  directoryName = path.basename(path.dirname(filePath)),
): SkillConfig {
  const normalized = normalizeContent(content);
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error('Missing YAML frontmatter.');
  const frontmatter = parseYaml(match[1]) as unknown;
  if (!isRecord(frontmatter)) throw new Error('Frontmatter must be an object.');

  const name = frontmatter['name'];
  if (
    typeof name !== 'string' ||
    countCharacters(name) > 64 ||
    !/^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
  ) {
    throw new Error('Invalid Agent Skills name.');
  }
  if (name !== directoryName) {
    throw new Error('Agent Skills name must match its parent directory.');
  }

  const description = frontmatter['description'];
  if (
    typeof description !== 'string' ||
    description.length === 0 ||
    countCharacters(description) > 1024
  ) {
    throw new Error('Agent Skills description must be 1-1024 characters.');
  }
  validateOptionalString(frontmatter, 'license');
  validateCompatibility(frontmatter['compatibility']);
  validateMetadata(frontmatter['metadata']);
  validateAllowedTools(frontmatter['allowed-tools']);

  return {
    name,
    description,
    filePath,
    skillRoot: path.dirname(filePath),
    body: match[2].trim(),
    level: 'extension',
  };
}

function validateOptionalString(
  frontmatter: Record<string, unknown>,
  field: string,
): void {
  if (
    frontmatter[field] !== undefined &&
    typeof frontmatter[field] !== 'string'
  ) {
    throw new Error(`Agent Skills ${field} must be a string.`);
  }
}

function validateCompatibility(value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    countCharacters(value) > 500
  ) {
    throw new Error(
      'Agent Skills compatibility must be a 1-500 character string.',
    );
  }
}

function validateMetadata(value: unknown): void {
  if (value === undefined) return;
  if (
    !isRecord(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Agent Skills metadata values must be strings.');
  }
}

function validateAllowedTools(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('Agent Skills allowed-tools must be a string.');
  }
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
