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
import { validateForkToolList } from './fork-subagent.js';

const FORK_PROFILE_DIR = 'fork-profiles';
const FORK_PROFILE_NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;
const MAX_FORK_PROFILE_BYTES = 64 * 1024;
const MAX_FORK_PROFILE_PROMPT_HINT_CHARS = 200;

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

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function throwForkProfileReadError(
  error: unknown,
  requestedName: string,
  profilePath: string,
): never {
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

  let resolvedProjectRoot: string;
  let resolvedProfilePath: string;
  try {
    resolvedProjectRoot = fs.realpathSync(projectRoot);
    resolvedProfilePath = fs.realpathSync(profilePath);
  } catch (error) {
    throwForkProfileReadError(error, requestedName, profilePath);
  }

  const resolvedProfileDir = path.join(
    resolvedProjectRoot,
    QWEN_DIR,
    FORK_PROFILE_DIR,
  );
  if (!isWithinDirectory(resolvedProfileDir, resolvedProfilePath)) {
    throw new Error(
      `Invalid fork profile "${requestedName}": ${profilePath} resolves outside ${resolvedProfileDir}.`,
    );
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedProfilePath);
  } catch (error) {
    throwForkProfileReadError(error, requestedName, profilePath);
  }
  if (!stats.isFile()) {
    throw new Error(
      `Invalid fork profile "${requestedName}": ${profilePath} is not a regular file.`,
    );
  }
  if (stats.size > MAX_FORK_PROFILE_BYTES) {
    throw new Error(
      `Invalid fork profile "${requestedName}": file is larger than ${MAX_FORK_PROFILE_BYTES} bytes.`,
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(resolvedProfilePath, 'utf8');
  } catch (error) {
    throwForkProfileReadError(error, requestedName, profilePath);
  }

  const normalizedContent = normalizeContent(content);
  const match = normalizedContent.match(
    /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/,
  );
  if (!match) {
    throw new Error(
      `Invalid fork profile "${requestedName}": missing YAML frontmatter.`,
    );
  }
  if (match[2]?.trim()) {
    throw new Error(
      `Invalid fork profile "${requestedName}": Markdown body content is not supported; move profile guidance into frontmatter promptHint.`,
    );
  }

  const document = parseDocument(match[1], { schema: 'core' });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(
      `Invalid fork profile "${requestedName}": malformed YAML frontmatter.`,
    );
  }

  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = document.toJS();
  } catch {
    throw new Error(
      `Invalid fork profile "${requestedName}": malformed YAML frontmatter.`,
    );
  }
  if (
    rawFrontmatter === null ||
    typeof rawFrontmatter !== 'object' ||
    Array.isArray(rawFrontmatter)
  ) {
    throw new Error(
      `Invalid fork profile "${requestedName}": frontmatter must be a YAML mapping.`,
    );
  }
  const frontmatter = Object.assign(
    Object.create(null) as Record<string, unknown>,
    rawFrontmatter,
  );
  const profileName = frontmatter['name'];
  if (typeof profileName !== 'string' || profileName !== requestedName) {
    throw new Error(
      `Invalid fork profile "${requestedName}": frontmatter name must exactly match the filename.`,
    );
  }

  const tools = frontmatter['tools'];
  const toolsError = validateForkToolList(tools);
  if (toolsError) {
    throw new Error(
      `Invalid fork profile "${requestedName}": tools ${toolsError}.`,
    );
  }
  const typedTools = tools as string[];

  const promptHint = frontmatter['promptHint'];
  if (promptHint !== undefined && typeof promptHint !== 'string') {
    throw new Error(
      `Invalid fork profile "${requestedName}": promptHint must be a string.`,
    );
  }
  const trimmedPromptHint =
    typeof promptHint === 'string' ? promptHint.trim() : undefined;
  if (
    trimmedPromptHint !== undefined &&
    trimmedPromptHint.length > MAX_FORK_PROFILE_PROMPT_HINT_CHARS
  ) {
    throw new Error(
      `Invalid fork profile "${requestedName}": promptHint must not exceed ${MAX_FORK_PROFILE_PROMPT_HINT_CHARS} characters.`,
    );
  }

  return Object.freeze({
    name: requestedName,
    tools: Object.freeze([...typedTools]),
    ...(trimmedPromptHint ? { promptHint: trimmedPromptHint } : {}),
  });
}
