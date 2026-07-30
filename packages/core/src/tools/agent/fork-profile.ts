/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import { QWEN_DIR } from '../../config/storage.js';
import { normalizeContent } from '../../utils/textUtils.js';
import { parse as parseYaml } from '../../utils/yaml-parser.js';
import { isValidForkToolWildcard } from './fork-subagent.js';

const FORK_PROFILE_DIR = 'fork-profiles';
const FORK_PROFILE_NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;

export interface ForkProfile {
  readonly name: string;
  readonly tools: readonly string[];
  readonly promptHint?: string;
}

export function validateForkProfileName(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.trim() !== name || name.length === 0) {
    return 'must be a non-empty string without surrounding whitespace';
  }
  if (name.length < 2 || name.length > 50) {
    return 'must be between 2 and 50 characters';
  }
  if (
    !FORK_PROFILE_NAME_PATTERN.test(name) ||
    name.startsWith('-') ||
    name.startsWith('_') ||
    name.endsWith('-') ||
    name.endsWith('_')
  ) {
    return 'may contain only letters, numbers, hyphens, and underscores, without a leading or trailing separator';
  }
  return undefined;
}

export function loadForkProfile(
  projectRoot: string,
  requestedName: string,
): ForkProfile {
  const nameError = validateForkProfileName(requestedName);
  if (nameError) {
    throw new Error(`Fork profile name ${nameError}.`);
  }

  const profilePath = path.join(
    projectRoot,
    QWEN_DIR,
    FORK_PROFILE_DIR,
    `${requestedName}.md`,
  );

  let content: string;
  try {
    content = fs.readFileSync(profilePath, 'utf8');
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      throw new Error(
        `Fork profile "${requestedName}" was not found at ${profilePath}.`,
      );
    }
    throw new Error(
      `Failed to read fork profile "${requestedName}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const normalizedContent = normalizeContent(content);
  const match = normalizedContent.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    throw new Error(
      `Invalid fork profile "${requestedName}": missing YAML frontmatter.`,
    );
  }

  const document = parseDocument(match[1], { schema: 'core' });
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid fork profile "${requestedName}": malformed YAML frontmatter.`,
    );
  }

  const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
  const profileName = frontmatter['name'];
  if (typeof profileName !== 'string' || profileName !== requestedName) {
    throw new Error(
      `Invalid fork profile "${requestedName}": frontmatter name must exactly match the filename.`,
    );
  }

  const tools = frontmatter['tools'];
  if (!Array.isArray(tools)) {
    throw new Error(
      `Invalid fork profile "${requestedName}": tools must be an array.`,
    );
  }
  if (
    tools.some(
      (toolName) =>
        typeof toolName !== 'string' ||
        toolName.trim().length === 0 ||
        toolName.trim() !== toolName,
    )
  ) {
    throw new Error(
      `Invalid fork profile "${requestedName}": tools must contain non-empty names without surrounding whitespace.`,
    );
  }

  const typedTools = tools as string[];
  if (typedTools.includes('*')) {
    throw new Error(
      `Invalid fork profile "${requestedName}": tools does not accept "*"; omit fork_profile for unrestricted execution.`,
    );
  }
  if (typedTools.some((toolName) => !isValidForkToolWildcard(toolName))) {
    throw new Error(
      `Invalid fork profile "${requestedName}": wildcard entries must be "mcp__*" or a trailing MCP tool-prefix pattern such as "mcp__github__read_*".`,
    );
  }

  const promptHint = frontmatter['promptHint'];
  if (promptHint !== undefined && typeof promptHint !== 'string') {
    throw new Error(
      `Invalid fork profile "${requestedName}": promptHint must be a string.`,
    );
  }

  return Object.freeze({
    name: requestedName,
    tools: Object.freeze([...typedTools]),
    ...(typeof promptHint === 'string' && promptHint.trim().length > 0
      ? { promptHint: promptHint.trim() }
      : {}),
  });
}
