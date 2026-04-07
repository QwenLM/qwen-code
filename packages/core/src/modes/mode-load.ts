/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode file loading utilities.
 *
 * Parses MODE.md files with YAML frontmatter and markdown body,
 * following the same pattern as SKILL.md and subagent .md files.
 */

import type { ModeConfig, ModeLevel, ValidationResult } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizeContent } from '../utils/textUtils.js';

const debugLogger = createDebugLogger('MODE_LOAD');
const MODE_MANIFEST_FILE = 'MODE.md';

/**
 * Result of parsing a MODE.md file.
 */
interface ModeParseResult {
  config: ModeConfig;
  body: string;
}

/**
 * Load modes from a directory by scanning subdirectories for MODE.md files.
 *
 * @param baseDir - Absolute path to directory containing mode subdirectories
 * @param level - Storage level to assign to loaded modes
 * @returns Array of parsed mode configurations
 */
export async function loadModesFromDir(
  baseDir: string,
  level: ModeLevel,
): Promise<ModeConfig[]> {
  debugLogger.debug(`Loading modes from directory: ${baseDir}`);
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const modes: ModeConfig[] = [];
    debugLogger.debug(`Found ${entries.length} entries in ${baseDir}`);

    for (const entry of entries) {
      // Only process directories (each mode is a directory)
      if (!entry.isDirectory()) {
        debugLogger.warn(`Skipping non-directory entry: ${entry.name}`);
        continue;
      }

      const modeDir = path.join(baseDir, entry.name);
      const modeManifest = path.join(modeDir, MODE_MANIFEST_FILE);

      try {
        await fs.access(modeManifest);
        const content = await fs.readFile(modeManifest, 'utf8');
        const parsed = parseModeContent(content, modeManifest);
        // Override level since this is determined by the source directory
        parsed.config.level = level;
        modes.push(parsed.config);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        debugLogger.debug(
          `Skipping ${entry.name}: ${errorMessage}`,
        );
        continue;
      }
    }

    return modes;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    debugLogger.debug(`Cannot read modes directory ${baseDir}: ${errorMessage}`);
    return [];
  }
}

/**
 * Load a single mode file directly (not from directory scanning).
 *
 * @param filePath - Absolute path to MODE.md file
 * @param level - Storage level to assign
 * @returns Parsed mode configuration
 */
export async function loadModeFile(
  filePath: string,
  level: ModeLevel,
): Promise<ModeConfig> {
  debugLogger.debug(`Loading mode file: ${filePath}`);
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = parseModeContent(content, filePath);
  parsed.config.level = level;
  return parsed.config;
}

/**
 * Parse MODE.md content into a ModeConfig and body string.
 *
 * @param content - Raw file content
 * @param filePath - Absolute path to file (for error messages)
 * @returns Parsed mode configuration and markdown body
 */
export function parseModeContent(
  content: string,
  filePath: string,
): ModeParseResult {
  debugLogger.debug(`Parsing mode content from: ${filePath}`);

  // Normalize content to handle BOM and CRLF line endings
  const normalizedContent = normalizeContent(content);

  // Split frontmatter and content
  const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
  const match = normalizedContent.match(frontmatterRegex);

  if (!match) {
    throw new Error('Invalid MODE format: missing YAML frontmatter');
  }

  const [, frontmatterYaml, body] = match;

  // Parse YAML frontmatter
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYaml(frontmatterYaml) as Record<string, unknown>;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse YAML frontmatter: ${errorMessage}`);
  }

  // Validate required fields
  const name = frontmatter.name as string | undefined;
  const displayName = frontmatter.displayName as string | undefined;
  const description = frontmatter.description as string | undefined;
  const icon = frontmatter.icon as string | undefined;
  const systemPrompt = frontmatter.systemPrompt as string | undefined;

  if (!name) {
    throw new Error('Missing required field: name');
  }
  if (!displayName) {
    throw new Error('Missing required field: displayName');
  }
  if (!description) {
    throw new Error('Missing required field: description');
  }
  if (!icon) {
    throw new Error('Missing required field: icon');
  }
  if (!systemPrompt) {
    throw new Error('Missing required field: systemPrompt');
  }

  // Build config object
  const config: ModeConfig = {
    name,
    displayName,
    description,
    icon,
    systemPrompt,
    level: 'builtin', // Will be overridden by caller
    filePath,
  };

  // Optional fields
  if (Array.isArray(frontmatter.allowedTools)) {
    config.allowedTools = frontmatter.allowedTools as string[];
  }
  if (Array.isArray(frontmatter.deniedTools)) {
    config.deniedTools = frontmatter.deniedTools as string[];
  }
  if (Array.isArray(frontmatter.allowedSubagents)) {
    config.allowedSubagents = frontmatter.allowedSubagents as string[];
  }
  if (Array.isArray(frontmatter.allowedSkills)) {
    config.allowedSkills = frontmatter.allowedSkills as string[];
  }
  if (typeof frontmatter.approvalMode === 'string') {
    config.approvalMode = frontmatter.approvalMode as ModeConfig['approvalMode'];
  }
  if (typeof frontmatter.color === 'string') {
    config.color = frontmatter.color as string;
  }
  if (typeof frontmatter.inheritedFrom === 'string') {
    config.inheritedFrom = frontmatter.inheritedFrom as string;
  }

  // Model config
  if (
    typeof frontmatter.model === 'string' ||
    typeof frontmatter.temperature === 'number' ||
    typeof frontmatter.top_p === 'number' ||
    typeof frontmatter.max_output_tokens === 'number'
  ) {
    config.modelConfig = {};
    if (typeof frontmatter.model === 'string') {
      config.modelConfig.model = frontmatter.model as string;
    }
    if (typeof frontmatter.temperature === 'number') {
      config.modelConfig.temperature = frontmatter.temperature as number;
    }
    if (typeof frontmatter.top_p === 'number') {
      config.modelConfig.top_p = frontmatter.top_p as number;
    }
    if (typeof frontmatter.max_output_tokens === 'number') {
      config.modelConfig.max_output_tokens =
        frontmatter.max_output_tokens as number;
    }
  }

  // Run config
  if (
    typeof frontmatter.max_turns === 'number' ||
    typeof frontmatter.max_time_minutes === 'number'
  ) {
    config.runConfig = {};
    if (typeof frontmatter.max_turns === 'number') {
      config.runConfig.max_turns = frontmatter.max_turns as number;
    }
    if (typeof frontmatter.max_time_minutes === 'number') {
      config.runConfig.max_time_minutes =
        frontmatter.max_time_minutes as number;
    }
  }

  debugLogger.debug(`Parsed mode: ${name} from ${filePath}`);

  return { config, body };
}

/**
 * Get the default path for user modes.
 *
 * @param homeDir - User's home directory path
 * @returns Absolute path to ~/.qwen/modes/
 */
export function getUserModesDir(homeDir: string): string {
  return path.join(homeDir, '.qwen', 'modes');
}

/**
 * Get the default path for project modes.
 *
 * @param projectDir - Project root directory path
 * @returns Absolute path to <project>/.qwen/modes/
 */
export function getProjectModesDir(projectDir: string): string {
  return path.join(projectDir, '.qwen', 'modes');
}

/**
 * Generate the default file path for a mode.
 *
 * @param name - Mode name
 * @param level - Storage level
 * @param baseDir - Base directory (home or project)
 * @returns Absolute path for the MODE.md file
 */
export function getModeFilePath(
  name: string,
  level: ModeLevel,
  baseDir: string,
): string {
  const modesDir =
    level === 'user'
      ? getUserModesDir(baseDir)
      : level === 'project'
        ? getProjectModesDir(baseDir)
        : path.join(baseDir, 'modes');

  return path.join(modesDir, `${normalizeModeName(name)}`, MODE_MANIFEST_FILE);
}

/**
 * Normalize a mode name for use in file paths.
 *
 * @param name - Mode name
 * @returns Normalized name (lowercase, hyphens instead of spaces)
 */
function normalizeModeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}
