/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Storage } from '../config/storage.js';
import { QWEN_DIR } from '../utils/paths.js';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import { normalizeContent } from '../utils/textUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  BUILT_IN_OUTPUT_STYLES,
  type OutputStyleDefinition,
  type OutputStyleSource,
} from './output-styles.js';

const debugLogger = createDebugLogger('OUTPUT_STYLE_FILES');

/** Directory name, under `~/.qwen` and a project's `.qwen`, that holds style files. */
export const OUTPUT_STYLES_DIR_NAME = 'output-styles';

/** A style file larger than this is skipped: it is a prompt, not a document. */
const MAX_OUTPUT_STYLE_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_STYLE_NAME_LENGTH = 64;
const MAX_DERIVED_DESCRIPTION_LENGTH = 120;

/** Frontmatter keys a style file may carry; anything else is reported and ignored. */
const KNOWN_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'keep-coding-instructions',
]);

/**
 * Parses one `*.md` style file.
 *
 * The file is the style's prompt with an optional YAML frontmatter:
 * `name` (defaults to the file name), `description` (defaults to the first
 * line of the body) and `keep-coding-instructions` (defaults to `false`, so
 * a custom style is assumed not to be about coding unless it says so).
 *
 * Throws on a file that cannot be a style: an empty body, or a name that is
 * empty, too long, reserved (`default`) or carries control characters.
 */
export function parseOutputStyleFile(
  content: string,
  filePath: string,
  source: Exclude<OutputStyleSource, 'built-in'>,
): OutputStyleDefinition {
  const normalized = normalizeContent(content);
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  const frontmatter: Record<string, unknown> = match ? parseYaml(match[1]) : {};
  const body = (match ? match[2] : normalized).trim();

  const fallbackName = path.basename(filePath).replace(/\.md$/i, '');
  const name = validateOutputStyleName(
    frontmatter['name'] == null
      ? fallbackName
      : String(frontmatter['name']).trim(),
  );

  if (!body) {
    throw new Error('the file has no prompt body');
  }

  const declaredDescription =
    typeof frontmatter['description'] === 'string'
      ? frontmatter['description'].trim()
      : '';
  const description =
    declaredDescription ||
    deriveDescription(body) ||
    `Custom ${name} output style`;

  const keepRaw = frontmatter['keep-coding-instructions'];
  const keepCodingInstructions = keepRaw === true || keepRaw === 'true';

  const unknownKeys = Object.keys(frontmatter).filter(
    (key) => !KNOWN_FRONTMATTER_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    debugLogger.warn(
      `Output style ${filePath}: ignoring unknown frontmatter keys ${unknownKeys.join(', ')}`,
    );
  }

  return { name, source, description, keepCodingInstructions, prompt: body };
}

function validateOutputStyleName(name: string): string {
  if (!name) {
    throw new Error('the style name is empty');
  }
  if (name.length > MAX_OUTPUT_STYLE_NAME_LENGTH) {
    throw new Error(
      `the style name is longer than ${MAX_OUTPUT_STYLE_NAME_LENGTH} characters`,
    );
  }
  // The name is echoed into the system prompt heading and the picker, so
  // control and format characters (which can hide or reorder text) are refused.
  if (/[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error('the style name contains control characters');
  }
  if (name.toLowerCase() === 'default') {
    throw new Error('"default" is reserved for the built-in default style');
  }
  return name;
}

/** First line of prose in the body, with markdown markers stripped. */
function deriveDescription(body: string): string {
  let inFence = false;
  for (const rawLine of body.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const line = trimmed
      .replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '')
      .replace(/[*_`]/g, '')
      .trim();
    if (!line) {
      continue;
    }
    return line.length > MAX_DERIVED_DESCRIPTION_LENGTH
      ? `${line.slice(0, MAX_DERIVED_DESCRIPTION_LENGTH - 1)}…`
      : line;
  }
  return '';
}

/**
 * Loads every `*.md` file directly inside `dir` as a style. A missing
 * directory yields no styles; an unreadable or invalid file is reported and
 * skipped so one bad file never hides the others. Files are read in name
 * order, and a later file that repeats an earlier file's name is skipped.
 */
export async function loadOutputStylesFromDir(
  dir: string,
  source: Exclude<OutputStyleSource, 'built-in'>,
): Promise<OutputStyleDefinition[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.warn(`Cannot read output styles directory ${dir}:`, error);
    }
    return [];
  }

  const styles: OutputStyleDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of entries.filter((e) => /\.md$/i.test(e)).sort()) {
    const filePath = path.join(dir, entry);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      if (stat.size > MAX_OUTPUT_STYLE_FILE_BYTES) {
        debugLogger.warn(
          `Skipping output style ${filePath}: larger than ${MAX_OUTPUT_STYLE_FILE_BYTES} bytes`,
        );
        continue;
      }
      const style = parseOutputStyleFile(
        await fs.readFile(filePath, 'utf8'),
        filePath,
        source,
      );
      const key = style.name.toLowerCase();
      if (seen.has(key)) {
        debugLogger.warn(
          `Skipping output style ${filePath}: another file in ${dir} already defines "${style.name}"`,
        );
        continue;
      }
      seen.add(key);
      styles.push(style);
    } catch (error) {
      debugLogger.warn(
        `Skipping output style ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return styles;
}

export function getUserOutputStylesDir(): string {
  return path.join(Storage.getGlobalQwenDir(), OUTPUT_STYLES_DIR_NAME);
}

export function getProjectOutputStylesDir(projectRoot: string): string {
  return path.join(projectRoot, QWEN_DIR, OUTPUT_STYLES_DIR_NAME);
}

export interface OutputStyleCatalogOptions {
  /**
   * Project whose `.qwen/output-styles` is included. Leave unset for an
   * untrusted workspace: a checked-in style file is a prompt, so it is only
   * read from a project the user has trusted. A project root that is the
   * home directory is skipped, since it would only repeat the user level.
   */
  projectRoot?: string;
}

/**
 * The selectable styles: built-ins plus the user's and the project's files.
 *
 * Names are unique, case-insensitively, with project > user > built-in
 * precedence, so a project can override a user style or a built-in name.
 * The returned order is built-in, user, project — the order the picker shows.
 */
export async function loadOutputStyleCatalog(
  options: OutputStyleCatalogOptions = {},
): Promise<readonly OutputStyleDefinition[]> {
  const projectRoot = options.projectRoot;
  const includeProject =
    projectRoot !== undefined &&
    path.resolve(projectRoot) !== path.resolve(os.homedir());
  const [projectStyles, userStyles] = await Promise.all([
    includeProject
      ? loadOutputStylesFromDir(
          getProjectOutputStylesDir(projectRoot),
          'project',
        )
      : Promise.resolve([]),
    loadOutputStylesFromDir(getUserOutputStylesDir(), 'user'),
  ]);

  const winners = new Map<string, OutputStyleDefinition>();
  for (const style of [
    ...projectStyles,
    ...userStyles,
    ...BUILT_IN_OUTPUT_STYLES,
  ]) {
    const key = style.name.toLowerCase();
    const winner = winners.get(key);
    if (winner) {
      debugLogger.debug(
        `Output style "${style.name}" (${style.source}) is shadowed by the ${winner.source} style of the same name`,
      );
      continue;
    }
    winners.set(key, style);
  }
  return [...BUILT_IN_OUTPUT_STYLES, ...userStyles, ...projectStyles].filter(
    (style) => winners.get(style.name.toLowerCase()) === style,
  );
}

/** Finds a style by name, case-insensitively, in a catalog. */
export function findOutputStyle(
  styles: readonly OutputStyleDefinition[],
  name: string,
): OutputStyleDefinition | undefined {
  const wanted = name.trim().toLowerCase();
  return styles.find((style) => style.name.toLowerCase() === wanted);
}
