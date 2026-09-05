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
import {
  isBinary,
  normalizeContent,
  stripAnsiAndControl,
  stripHtmlComments,
} from '../utils/textUtils.js';
import { isWithinRoot } from '../utils/fileUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  BUILT_IN_OUTPUT_STYLES,
  getBuiltInOutputStyle,
  type OutputStyleDefinition,
  type OutputStyleSource,
} from './output-styles.js';

const debugLogger = createDebugLogger('OUTPUT_STYLE_FILES');

/** Directory name, under `~/.qwen` and a project's `.qwen`, that holds style files. */
export const OUTPUT_STYLES_DIR_NAME = 'output-styles';

/**
 * A style file larger than this is skipped: it is a prompt, not a document.
 * The bound matches `LOOP_TASK_FILE_MAX_BYTES`, the house bound for file text
 * injected into the system prompt — a style file this size already costs
 * roughly 6k tokens on every request in the session.
 */
const MAX_OUTPUT_STYLE_FILE_BYTES = 25_000;
const MAX_OUTPUT_STYLE_NAME_LENGTH = 64;
const MAX_DERIVED_DESCRIPTION_LENGTH = 120;

/** Frontmatter keys a style file may carry; anything else is reported and ignored. */
const KNOWN_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'keep-coding-instructions',
]);

/**
 * The frontmatter fence, tolerant of the variants a hand-written Markdown file
 * carries: trailing whitespace on either fence, and an empty block.
 */
const FRONTMATTER_FENCE =
  /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)([\s\S]*)$/;

/**
 * Whether a fenced block is frontmatter at all, rather than a decorative `---`
 * rule around prose. Frontmatter is a mapping of the keys this loader knows;
 * anything else keeps its text in the prompt instead of silently losing it.
 */
function isFrontmatterBlock(block: string): boolean {
  let sawKey = false;
  for (const line of block.split('\n')) {
    const trimmed = line.trimStart();
    // A blank line, or a YAML comment -- which a Markdown heading also looks
    // like, so a block of nothing else is prose rather than frontmatter.
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    // An indented line continues the value of the key above it.
    if (/^\s/.test(line)) {
      if (!sawKey) {
        return false;
      }
      continue;
    }
    const key = /^([A-Za-z0-9_-]+):(?:\s|$)/.exec(line)?.[1];
    if (!key || !KNOWN_FRONTMATTER_KEYS.has(key)) {
      return false;
    }
    sawKey = true;
  }
  return sawKey || !block.trim();
}

/**
 * Parses one `*.md` style file.
 *
 * The file is the style's prompt with an optional YAML frontmatter:
 * `name` (defaults to the file name), `description` (defaults to the first
 * line of the body) and `keep-coding-instructions` (defaults to what the
 * built-in style of the same name declares, and to `false` otherwise, so a
 * custom style is assumed not to be about coding unless it says so).
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
  const fence = FRONTMATTER_FENCE.exec(normalized);
  const match = fence && isFrontmatterBlock(fence[1]) ? fence : null;
  const frontmatter: Record<string, unknown> = match ? parseYaml(match[1]) : {};
  // HTML comments are a note to the reader, not an instruction to the model,
  // and the sibling `.qwen/rules/` loader already drops them from the same
  // sink. Stripping where the body is cut covers the prompt, the derived
  // description and the empty-body rejection at once.
  const body = stripHtmlComments(match ? match[2] : normalized).trim();

  const fallbackName = path.basename(filePath).replace(/\.md$/i, '').trim();
  const name = validateOutputStyleName(
    typeof frontmatter['name'] === 'string'
      ? frontmatter['name'].trim()
      : fallbackName,
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

  const keepCodingInstructions = resolveKeepCodingInstructions(
    frontmatter,
    name,
    filePath,
  );

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
 * Whether the style keeps the software-engineering section of the base prompt.
 *
 * A file that declares nothing inherits the built-in style it shadows, so
 * rewriting `concise.md` changes the wording without silently deleting the
 * verification and faithful-reporting guidance; a file with no built-in
 * counterpart is assumed not to be about coding. A declared value is read in
 * the parser's own terms -- the YAML fallback parser yields strings, so
 * `True` arrives as `'True'` -- and anything else is reported and kept `false`.
 */
function resolveKeepCodingInstructions(
  frontmatter: Record<string, unknown>,
  name: string,
  filePath: string,
): boolean {
  if (!('keep-coding-instructions' in frontmatter)) {
    return getBuiltInOutputStyle(name)?.keepCodingInstructions ?? false;
  }
  const raw = frontmatter['keep-coding-instructions'];
  const spelling = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  if (spelling === true || spelling === 'true') {
    return true;
  }
  if (spelling !== false && spelling !== 'false') {
    debugLogger.warn(
      `Output style ${filePath}: keep-coding-instructions value ${JSON.stringify(raw)} is not true or false; treating it as false`,
    );
  }
  return false;
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
): Promise<string | null> {
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
  return realPath;
}

/**
 * Reads at most `MAX_OUTPUT_STYLE_FILE_BYTES + 1` bytes: the extra byte is the
 * over-size signal and the only thing needed past the cap, so the bound holds
 * on the bytes actually read rather than on a `stat` the file can outgrow.
 */
async function readBoundedStyleFile(readPath: string): Promise<Buffer> {
  const handle = await fs.open(readPath, 'r');
  try {
    const cap = MAX_OUTPUT_STYLE_FILE_BYTES + 1;
    const buffer = Buffer.alloc(cap);
    let total = 0;
    // A single read() can come back short before EOF; loop until full or EOF.
    while (total < cap) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        cap - total,
        total,
      );
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
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
      const readPath = await resolveStyleFileToRead(
        filePath,
        source,
        confineTo,
      );
      if (!readPath) {
        continue;
      }
      const buffer = await readBoundedStyleFile(readPath);
      if (buffer.byteLength > MAX_OUTPUT_STYLE_FILE_BYTES) {
        debugLogger.warn(
          `Skipping output style ${filePath}: larger than ${MAX_OUTPUT_STYLE_FILE_BYTES} bytes`,
        );
        continue;
      }
      // A UTF-16 file -- what PowerShell's `>` and Notepad write -- decodes as
      // NUL-riddled mojibake that still parses as a style and reaches the
      // system prompt, so the bytes are sniffed before they are decoded.
      if (isBinary(buffer)) {
        debugLogger.warn(
          `Skipping output style ${filePath}: it is not UTF-8 text`,
        );
        continue;
      }
      const style = parseOutputStyleFile(
        buffer.toString('utf8'),
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
   * read from a project the user has trusted. A project whose style directory
   * is the user's own is skipped, since it would only repeat the user level.
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
  // Compare the directories that would actually be read: the user level
  // resolves through `QWEN_HOME`, so `projectRoot` vs `os.homedir()` both
  // drops a legitimate project level and lets a relocated `QWEN_HOME` load
  // the user's own files a second time, labelled `(project)`.
  const includeProject =
    projectRoot !== undefined &&
    path.resolve(getProjectOutputStylesDir(projectRoot)) !==
      path.resolve(getUserOutputStylesDir());
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
