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
import { normalizeContent, stripAnsiAndControl } from '../utils/textUtils.js';
import { isWithinRoot } from '../utils/fileUtils.js';
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

  // Both description sources come from an untrusted file and are rendered
  // straight into a picker row, so they get the same treatment the sibling
  // `name` field already gets -- and the same cap, whether declared or
  // derived. `stripAnsiAndControl` covers C0/C1; `\p{Cf}` covers the format
  // characters that reorder a row (U+202E) or hide text, which it does not.
  const declaredDescription = sanitizeDescription(
    typeof frontmatter['description'] === 'string'
      ? frontmatter['description']
      : '',
  );
  const description =
    declaredDescription ||
    sanitizeDescription(deriveDescription(body)) ||
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

/**
 * Makes a description safe to render in a terminal row: no escape sequences,
 * no control or format characters, one line, and never longer than the cap
 * the derived description already used.
 */
function sanitizeDescription(description: string): string {
  const flattened = stripAnsiAndControl(description)
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return flattened.length > MAX_DERIVED_DESCRIPTION_LENGTH
    ? flattened.slice(0, MAX_DERIVED_DESCRIPTION_LENGTH)
    : flattened;
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
 * Decides whether one directory entry may be read as a style file, and
 * returns the path to read it from.
 *
 * A style file's body goes into the system prompt verbatim, so a link is an
 * exfiltration vector: `.qwen/output-styles/notes.md -> ~/.aws/credentials`
 * is committable, survives `git clone`, and needs no user action beyond
 * starting the CLI. This mirrors `readLoopTaskFile`, which guards the
 * identical sink.
 *
 * A project file must not be a link at all -- the repo author does not own
 * the machine's files, and a link naming one is never something they need.
 * A user file may be a link, because `~/.qwen/output-styles/x.md ->
 * ~/dotfiles/x.md` is an ordinary setup, but its target has to stay inside
 * the user's own root. Both refuse `nlink > 1`, which is how a hard link to
 * a sensitive file looks like an ordinary regular file, and both confine the
 * canonical path so a symlinked *ancestor* (a checked-in `.qwen -> /outside`,
 * which a final-component `lstat` cannot see) is caught too.
 */
async function resolveStyleFileToRead(
  filePath: string,
  source: Exclude<OutputStyleSource, 'built-in'>,
  confineTo: string,
): Promise<{ readPath: string; size: number } | null> {
  // `lstat` is the guard for a project file: it does not follow the final
  // component, so a symlink is not a regular file and never reaches the read.
  // The explicit branch below changes no outcome -- it exists so a refused
  // symlink says why instead of disappearing silently.
  const stat =
    source === 'project' ? await fs.lstat(filePath) : await fs.stat(filePath);
  if (source === 'project' && stat.isSymbolicLink()) {
    debugLogger.warn(`Skipping output style ${filePath}: it is a symlink`);
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }
  if (stat.nlink > 1) {
    debugLogger.warn(`Skipping output style ${filePath}: it is a hard link`);
    return null;
  }
  const realPath = await fs.realpath(filePath);
  const realRoot = await fs.realpath(confineTo);
  if (realPath !== realRoot && !isWithinRoot(realPath, realRoot)) {
    debugLogger.warn(
      `Skipping output style ${filePath}: it resolves outside ${realRoot}`,
    );
    return null;
  }
  return { readPath: realPath, size: stat.size };
}

/**
 * Loads every `*.md` file directly inside `dir` as a style. A missing
 * directory yields no styles; an unreadable or invalid file is reported and
 * skipped so one bad file never hides the others. Files are read in name
 * order, and a later file that repeats an earlier file's name is skipped.
 *
 * `confineTo` is the root a style file must resolve inside: the project root
 * for project styles, the user's `~/.qwen` root for user styles.
 */
export async function loadOutputStylesFromDir(
  dir: string,
  source: Exclude<OutputStyleSource, 'built-in'>,
  confineTo: string,
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
      const resolved = await resolveStyleFileToRead(
        filePath,
        source,
        confineTo,
      );
      if (!resolved) {
        continue;
      }
      if (resolved.size > MAX_OUTPUT_STYLE_FILE_BYTES) {
        debugLogger.warn(
          `Skipping output style ${filePath}: larger than ${MAX_OUTPUT_STYLE_FILE_BYTES} bytes`,
        );
        continue;
      }
      const style = parseOutputStyleFile(
        await fs.readFile(resolved.readPath, 'utf8'),
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

/**
 * The root a user style file must resolve inside. It is the home directory
 * rather than `~/.qwen`, because `~/.qwen/output-styles/x.md ->
 * ~/dotfiles/x.md` is an ordinary dotfiles setup and has to keep working;
 * an explicit `QWEN_HOME` relocates the root with it.
 */
export function getUserOutputStylesRoot(): string {
  const envDir = process.env['QWEN_HOME'];
  if (envDir) {
    return Storage.getGlobalQwenDir();
  }
  return os.homedir() || path.dirname(Storage.getGlobalQwenDir());
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
          projectRoot,
        )
      : Promise.resolve([]),
    loadOutputStylesFromDir(
      getUserOutputStylesDir(),
      'user',
      getUserOutputStylesRoot(),
    ),
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
