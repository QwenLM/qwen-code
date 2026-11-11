/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';
import { closeDirHandleQuietly, logger } from './internal.js';
import { repairYamlFrontmatter } from './yamlRepair.js';
import { deriveCommandName } from './commandNamespace.js';
import {
  parseSlashCommandToolsFromFrontmatter,
  parseBooleanFrontmatter,
  parseEffortValue,
} from './frontmatterParsers.js';
import type {
  FrontmatterShell,
  ParsedFrontmatter,
  SkillArgument,
  SkillDefinition,
  SkillLoadError,
} from './types.js';

let pendingLoadErrors: SkillLoadError[] = [];
const scopedLoadErrors = new AsyncLocalStorage<SkillLoadError[]>();

/** Isolate diagnostics when independent source providers load concurrently. */
export function withSkillLoadErrors<T>(run: () => Promise<T>): Promise<T> {
  return scopedLoadErrors.run([], run);
}

function currentLoadErrors(): SkillLoadError[] {
  // Public one-shot loaders keep their existing drainSkillLoadErrors contract.
  // Concurrent Resource providers use the scoped store instead.
  return scopedLoadErrors.getStore() ?? pendingLoadErrors;
}

export function drainSkillLoadErrors(): SkillLoadError[] {
  const scoped = scopedLoadErrors.getStore();
  if (scoped) return scoped.splice(0);
  const errors = pendingLoadErrors;
  pendingLoadErrors = [];
  return errors;
}

const FRONTMATTER_SHELLS: readonly string[] = ['bash', 'powershell'];

export const FRONTMATTER_REGEX =
  /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/;

export function parseFrontmatter(
  content: string,
  filePath?: string,
): ParsedFrontmatter | null {
  const fromParsed = (parsed: unknown): ParsedFrontmatter | null => {
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const { name, description } = obj;
      return extractExtendedFields(obj, {
        name: typeof name === 'string' ? name : undefined,
        description: typeof description === 'string' ? description : undefined,
      });
    }
    return null;
  };

  try {
    const result = fromParsed(load(content));
    if (result) return result;
  } catch (yamlError) {
    try {
      const result = fromParsed(load(repairYamlFrontmatter(content)));
      if (result) return result;
    } catch {
      // Continue to simple parser fallback.
    }
    logger.debug(
      'YAML frontmatter parsing failed, falling back to simple parser:',
      yamlError,
    );
    const yamlMsg =
      yamlError instanceof Error ? yamlError.message : String(yamlError);
    const warnMsg = `Skill frontmatter YAML parse error (falling back to simple parser): ${yamlMsg}`;
    const nameMatch = content.match(/^name:\s*(.+)/m);
    const errorName = nameMatch
      ? nameMatch[1]?.trim()
      : filePath
        ? path.basename(path.dirname(filePath))
        : undefined;
    currentLoadErrors().push({
      name: errorName,
      filePath: filePath ?? 'skill frontmatter',
      message: warnMsg,
      configType: 'skill',
      severity: 'warning',
    });
  }

  return parseSimpleFrontmatter(content);
}

function extractExtendedFields(
  obj: Record<string, unknown>,
  base: { name?: string; description?: string },
): ParsedFrontmatter {
  const result: ParsedFrontmatter = { ...base };

  const model = obj['model'];
  if (typeof model === 'string') {
    result.model = model;
  }

  const parsedTools = parseSlashCommandToolsFromFrontmatter(
    obj['allowed-tools'] ?? obj['allowed_tools'],
  );
  if (parsedTools.length > 0) {
    result.allowedTools = parsedTools;
  }

  const whenToUse =
    obj['when-to-use'] ?? obj['when_to_use'] ?? obj['whenToUse'];
  if (typeof whenToUse === 'string') {
    result.whenToUse = whenToUse;
  }

  const argumentHintRaw =
    obj['argument-hint'] ?? obj['argument_hint'] ?? obj['argumentHint'];
  if (argumentHintRaw != null) {
    const argumentHint = String(argumentHintRaw);
    if (argumentHint) {
      result.argumentHint = argumentHint;
    }
  }

  const rawArgs = obj['arguments'];
  if (Array.isArray(rawArgs)) {
    const args: SkillArgument[] = [];
    for (const arg of rawArgs) {
      if (arg && typeof arg === 'object' && 'name' in arg) {
        const a = arg as Record<string, unknown>;
        const argName = a['name'];
        const argDesc = a['description'];
        const argReq = a['required'];
        if (typeof argName === 'string') {
          args.push({
            name: argName,
            description: typeof argDesc === 'string' ? argDesc : undefined,
            required: typeof argReq === 'boolean' ? argReq : false,
          });
        }
      }
    }
    if (args.length > 0) {
      result.arguments = args;
    }
  }

  const disableModelInvocation =
    obj['disable-model-invocation'] ?? obj['disable_model_invocation'];
  if (disableModelInvocation !== undefined) {
    result.disableModelInvocation = parseBooleanFrontmatter(
      disableModelInvocation,
    );
  }

  const userInvocable =
    obj['user-invocable'] ?? obj['user_invocable'] ?? obj['userInvocable'];
  if (userInvocable !== undefined) {
    result.userInvocable = parseBooleanFrontmatter(userInvocable);
  }

  const effortRaw = obj['effort'];
  if (effortRaw !== undefined) {
    const effort = parseEffortValue(effortRaw);
    if (effort !== undefined) {
      result.effort = effort;
    } else {
      logger.warn(
        `Skill has invalid effort '${String(effortRaw)}'. Valid options: low, medium, high, max, or a positive integer.`,
      );
    }
  }

  const context = obj['context'];
  if (typeof context === 'string' && context === 'fork') {
    result.context = 'fork';
  }

  const agent = obj['agent'];
  if (typeof agent === 'string') {
    result.agent = agent;
  }

  const hooks = obj['hooks'];
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    result.hooks = hooks as Record<string, unknown>;
  }

  const paths = obj['paths'];
  if (paths !== undefined) {
    const parsedPaths = parseSkillPaths(paths);
    if (parsedPaths && parsedPaths.length > 0) {
      result.paths = parsedPaths;
    }
  }

  const shell = obj['shell'];
  if (shell !== undefined) {
    const normalized = String(shell).trim().toLowerCase();
    if (FRONTMATTER_SHELLS.includes(normalized)) {
      result.shell = normalized as FrontmatterShell;
    } else if (normalized !== '') {
      logger.warn(
        `Skill has unrecognized shell '${String(shell)}'. Valid values: ${FRONTMATTER_SHELLS.join(', ')}. Falling back to bash.`,
      );
    }
  }

  return result;
}

function expandBraces(pattern: string): string[] {
  const braceMatch = pattern.match(/^([^{}]*)\{([^}]+)\}(.*)$/);
  if (!braceMatch) {
    return [pattern];
  }

  const prefix = braceMatch[1] || '';
  const alternatives = braceMatch[2] || '';
  const suffix = braceMatch[3] || '';
  const parts = alternatives.split(',').map((alt) => alt.trim());

  const expanded: string[] = [];
  for (const part of parts) {
    expanded.push(...expandBraces(prefix + part + suffix));
  }
  return expanded;
}

function parseSkillPaths(value: unknown): string[] | undefined {
  let rawPatterns: string[];
  if (typeof value === 'string') {
    rawPatterns = value
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter(Boolean);
  } else if (Array.isArray(value)) {
    rawPatterns = value
      .filter((item): item is string => typeof item === 'string')
      .map((p) => p.trim())
      .filter(Boolean);
  } else {
    return undefined;
  }

  rawPatterns = rawPatterns.flatMap((p) => expandBraces(p));

  const patterns = rawPatterns
    .map((pattern) => (pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern))
    .filter((p) => p.length > 0);

  if (patterns.length === 0 || patterns.every((p) => p === '**')) {
    return undefined;
  }

  return patterns;
}

function parseSimpleFrontmatter(content: string): ParsedFrontmatter | null {
  const lines = content.split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const nameMatch = line.match(/^\s*name:\s*(.*)$/);
    if (nameMatch) {
      name = nameMatch[1]?.trim();
      continue;
    }

    const descMatch = line.match(/^\s*description:\s*(.*)$/);
    if (descMatch) {
      const descLines = [descMatch[1]?.trim() ?? ''];

      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1] ?? '';
        if (nextLine.match(/^[ \t]+\S/)) {
          descLines.push(nextLine.trim());
          i++;
        } else {
          break;
        }
      }

      description = descLines.filter(Boolean).join(' ');
    }
  }

  if (name !== undefined && description !== undefined) {
    return { name, description };
  }
  if (description !== undefined) {
    return { description };
  }
  return null;
}

export function resolveSkillDir(skill: SkillDefinition): string {
  if (skill.isBuiltin) return process.cwd();
  if (skill.kind === 'plugin-command' && skill.pluginPath) {
    return skill.pluginPath;
  }
  return path.dirname(skill.location);
}

export function extractDescriptionFromBody(
  body: string,
  fallbackLabel: string = 'Skill',
): string {
  if (!body || body.trim().length === 0) {
    return fallbackLabel;
  }

  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const headingMatch = trimmed.match(/^#+\s+(.+)$/);
    const text = headingMatch ? headingMatch[1]?.trim() ?? '' : trimmed;

    if (text.length === 0) continue;

    if (text.length > 100) {
      return text.substring(0, 97) + '...';
    }
    return text;
  }

  return fallbackLabel;
}

export interface SkillScanLimits {
  maxDepth?: number;
  maxDirectories?: number;
  maxEntries?: number;
  maxSkills?: number;
  maxConcurrency?: number;
}

export interface LoadSkillsFromDirOptions {
  allowDirectSkill?: boolean;
  requireSkills?: boolean;
  scanLimits?: SkillScanLimits;
}

export async function loadSkillsFromDir(
  dir: string,
  options: LoadSkillsFromDirOptions = {},
): Promise<SkillDefinition[]> {
  try {
    const absoluteSearchPath = path.resolve(dir);
    const canonicalSearchPath = await fs
      .realpath(absoluteSearchPath)
      .catch(() => null);
    if (!canonicalSearchPath) {
      return [];
    }

    const stats = await fs.stat(canonicalSearchPath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      return [];
    }

    const scanState = createSkillScanState(
      canonicalSearchPath,
      options.scanLimits,
    );

    const directSkillPath = path.join(absoluteSearchPath, 'SKILL.md');
    try {
      const directStats = await scanState.limit(() => fs.stat(directSkillPath));
      if (!directStats.isFile()) {
        throw new Error('Direct skill path is not a file');
      }
      if (options.allowDirectSkill) {
        const identity = path.basename(absoluteSearchPath);
        const { skill, reportedLoadFailure } = await scanState.limit(() =>
          loadSkillFileWithDiagnostics(directSkillPath, identity, identity),
        );
        recordSkillScanWarnings(absoluteSearchPath, scanState);
        if (!skill && options.requireSkills && !reportedLoadFailure) {
          const message =
            `No skill was loaded from ${directSkillPath}. ` +
            `The file exists but has no usable frontmatter or body; ` +
            `check its contents.`;
          currentLoadErrors().push({
            filePath: directSkillPath,
            message,
            configType: 'skill',
            severity: 'error',
          });
          logger.warn(`[SkillResource] ${message}`);
        }
        return skill ? [skill] : [];
      }
      const message =
        `Ignoring SKILL.md at the root of skills directory ${absoluteSearchPath}. ` +
        `Skills must live in subdirectories (<skills>/<name>/SKILL.md); ` +
        `move it into its own subdirectory.`;
      currentLoadErrors().push({
        filePath: directSkillPath,
        message,
        configType: 'skill',
        severity: 'warning',
      });
      logger.warn(`[SkillResource] ${message}`);
    } catch {
      // No root SKILL.md.
    }

    const entries = await readEntriesWithBudget(absoluteSearchPath, scanState);
    const discoveredSkills = await scanSkillContainer(
      absoluteSearchPath,
      entries,
      1,
      scanState,
    );
    recordSkillScanWarnings(absoluteSearchPath, scanState);

    if (discoveredSkills.length === 0 && entries.length > 0) {
      const truncatedByBudget = scanState.limitHits.size > 0;
      if (options.requireSkills && !truncatedByBudget) {
        const message =
          `No skills were loaded from ${absoluteSearchPath}. ` +
          `The directory is not empty, but no valid <skill-name>/SKILL.md was found ` +
          `(nested category directories are also scanned). ` +
          `Check the directory layout and SKILL.md frontmatter.`;
        currentLoadErrors().push({
          filePath: absoluteSearchPath,
          message,
          configType: 'skill',
          severity: 'error',
        });
        logger.warn(`[SkillResource] ${message}`);
      } else {
        logger.debug(
          `Failed to load skills from ${absoluteSearchPath}. The directory is not empty but no valid skills were discovered. Please ensure SKILL.md files are present in subdirectories and have valid frontmatter.`,
        );
      }
    }

    return discoveredSkills;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    currentLoadErrors().push({
      filePath: dir,
      message: `Error discovering skills in ${dir}: ${errMsg}`,
      configType: 'skill',
    });
  }

  return [];
}

export const SKILL_SCAN_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
]);

const DEFAULT_SKILL_SCAN_LIMITS = {
  maxDepth: 4,
  maxDirectories: 1000,
  maxEntries: 20000,
  maxSkills: 500,
  maxConcurrency: 32,
} as const;

type SkillScanLimitName = 'depth' | 'directories' | 'entries' | 'skills';

interface SkillScanState {
  visited: Set<string>;
  directoriesClaimed: number;
  entriesClaimed: number;
  skillsClaimed: number;
  limitHits: Set<SkillScanLimitName>;
  limits: {
    maxDepth: number;
    maxDirectories: number;
    maxEntries: number;
    maxSkills: number;
  };
  limit: <T>(operation: () => Promise<T>) => Promise<T>;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function createConcurrencyLimiter(
  maxConcurrency: number,
): <T>(operation: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < maxConcurrency) {
        active++;
        resolve();
        return;
      }
      waiters.push(() => {
        active++;
        resolve();
      });
    });

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await operation();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

function createSkillScanState(
  canonicalSearchPath: string,
  overrides: SkillScanLimits | undefined,
): SkillScanState {
  const maxConcurrency = positiveLimit(
    overrides?.maxConcurrency,
    DEFAULT_SKILL_SCAN_LIMITS.maxConcurrency,
  );
  return {
    visited: new Set([canonicalSearchPath]),
    directoriesClaimed: 0,
    entriesClaimed: 0,
    skillsClaimed: 0,
    limitHits: new Set(),
    limits: {
      maxDepth: positiveLimit(
        overrides?.maxDepth,
        DEFAULT_SKILL_SCAN_LIMITS.maxDepth,
      ),
      maxDirectories: positiveLimit(
        overrides?.maxDirectories,
        DEFAULT_SKILL_SCAN_LIMITS.maxDirectories,
      ),
      maxEntries: positiveLimit(
        overrides?.maxEntries,
        DEFAULT_SKILL_SCAN_LIMITS.maxEntries,
      ),
      maxSkills: positiveLimit(
        overrides?.maxSkills,
        DEFAULT_SKILL_SCAN_LIMITS.maxSkills,
      ),
    },
    limit: createConcurrencyLimiter(maxConcurrency),
  };
}

async function readEntriesWithBudget(
  dir: string,
  state: SkillScanState,
): Promise<Dirent[]> {
  return state.limit(async () => {
    const entries: Dirent[] = [];
    const handle = await fs.opendir(dir);
    try {
      for await (const entry of handle) {
        if (state.entriesClaimed >= state.limits.maxEntries) {
          state.limitHits.add('entries');
          break;
        }
        state.entriesClaimed++;
        entries.push(entry);
      }
    } finally {
      await closeDirHandleQuietly(handle);
    }
    return entries;
  });
}

function recordSkillScanWarnings(
  searchPath: string,
  state: SkillScanState,
): void {
  if (state.limitHits.size === 0) {
    return;
  }

  const details: string[] = [];
  if (state.limitHits.has('depth')) {
    details.push(`maximum depth ${state.limits.maxDepth}`);
  }
  if (state.limitHits.has('directories')) {
    details.push(`maximum ${state.limits.maxDirectories} directories`);
  }
  if (state.limitHits.has('entries')) {
    details.push(`maximum ${state.limits.maxEntries} directory entries`);
  }
  if (state.limitHits.has('skills')) {
    details.push(`maximum ${state.limits.maxSkills} skills`);
  }
  const message =
    `Skill discovery from ${searchPath} reached its scan budget ` +
    `(${details.join(', ')}); remaining paths were skipped.`;
  currentLoadErrors().push({
    filePath: searchPath,
    message,
    configType: 'skill',
    severity: 'warning',
  });
  logger.warn(`[SkillResource] ${message}`);
}

async function scanSkillContainer(
  containerDir: string,
  entries: Dirent[],
  depth: number,
  state: SkillScanState,
): Promise<SkillDefinition[]> {
  const candidates = entries.filter(
    (entry) =>
      (entry.isDirectory() || entry.isSymbolicLink()) &&
      !SKILL_SCAN_IGNORED_DIRS.has(entry.name),
  );
  const remainingDirectoryBudget =
    state.limits.maxDirectories - state.directoriesClaimed;
  const claimed = candidates.slice(0, Math.max(0, remainingDirectoryBudget));
  state.directoriesClaimed += claimed.length;
  if (claimed.length < candidates.length) {
    state.limitHits.add('directories');
  }

  const results = await Promise.all(
    claimed.map(async (entry): Promise<SkillDefinition[]> => {
      const subDir = path.join(containerDir, entry.name);
      const skillFilePath = path.join(subDir, 'SKILL.md');

      const real = await state
        .limit(() => fs.realpath(subDir))
        .catch(() => null);
      if (!real) {
        return [];
      }
      if (state.visited.has(real)) {
        return [];
      }
      state.visited.add(real);

      try {
        const st = await state.limit(() => fs.stat(skillFilePath));
        if (st.isFile()) {
          if (state.skillsClaimed >= state.limits.maxSkills) {
            state.limitHits.add('skills');
            return [];
          }
          state.skillsClaimed++;
          const skill = await state.limit(() =>
            loadSkillFromFile(skillFilePath, entry.name, entry.name),
          );
          return skill ? [skill] : [];
        }
      } catch {
        // No SKILL.md directly here.
      }
      if (depth >= state.limits.maxDepth) {
        state.limitHits.add('depth');
        return [];
      }
      let subEntries: Dirent[];
      try {
        subEntries = await readEntriesWithBudget(subDir, state);
      } catch {
        return [];
      }
      return scanSkillContainer(subDir, subEntries, depth + 1, state);
    }),
  );
  return results.flat();
}

function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/i.test(path.basename(filePath));
}

function transformSkillFiles(files: string[]): string[] {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const dir = path.dirname(file);
    const group = byDir.get(dir);
    if (group) {
      group.push(file);
    } else {
      byDir.set(dir, [file]);
    }
  }

  const result: string[] = [];
  for (const dirFiles of byDir.values()) {
    const skillFile = dirFiles.find((f) => isSkillFile(f));
    if (skillFile) {
      result.push(skillFile);
    } else {
      result.push(...dirFiles);
    }
  }

  return result;
}

export async function loadSkillsFromCommandsDir(
  dir: string,
): Promise<SkillDefinition[]> {
  try {
    const absoluteSearchPath = path.resolve(dir);
    const stats = await fs.stat(absoluteSearchPath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      return [];
    }

    const allFiles = await collectMarkdownFiles(absoluteSearchPath);
    const skillFiles = transformSkillFiles(allFiles);

    const results = await Promise.all(
      skillFiles.map(async (filePath) => {
        const derived = deriveCommandName({
          filePath,
          baseDir: absoluteSearchPath,
          isSkillFile: isSkillFile(filePath),
        });
        if (!derived) {
          logger.warn(
            `[commands] cannot derive command name for ${filePath}; skipping`,
          );
          return null;
        }
        return loadSkillFromFile(
          filePath,
          derived.identity,
          derived.displayBase,
        );
      }),
    );

    return results.filter((s): s is SkillDefinition => s !== null);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    currentLoadErrors().push({
      filePath: dir,
      message: `Error discovering commands in ${dir}: ${errMsg}`,
      configType: 'skill',
    });
  }

  return [];
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  await collectMarkdownFilesInto(dir, files, new Set<string>());
  return files;
}

async function collectMarkdownFilesInto(
  dir: string,
  files: string[],
  visited: Set<string>,
): Promise<void> {
  const real = await fs.realpath(dir).catch(() => null);
  if (!real || visited.has(real)) return;
  visited.add(real);

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === 'node_modules' || entry.name === '.git') return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const stats = await fs.stat(fullPath).catch(() => null);
        if (stats?.isDirectory()) {
          await collectMarkdownFilesInto(fullPath, files, visited);
        } else if (stats?.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          files.push(fullPath);
        }
        return;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }),
  );
}

export async function loadSkillFromFile(
  filePath: string,
  identity?: string,
  displayBase?: string,
): Promise<SkillDefinition | null> {
  return (await loadSkillFileWithDiagnostics(filePath, identity, displayBase))
    .skill;
}

interface SkillFileLoadResult {
  skill: SkillDefinition | null;
  reportedLoadFailure: boolean;
}

async function loadSkillFileWithDiagnostics(
  filePath: string,
  identity?: string,
  displayBase?: string,
): Promise<SkillFileLoadResult> {
  try {
    const [content, resolvedPath] = await Promise.all([
      fs.readFile(filePath, 'utf-8'),
      fs.realpath(filePath).catch(() => filePath),
    ]);
    const match = content.match(FRONTMATTER_REGEX);

    let body: string;
    let frontmatter: ParsedFrontmatter | null;

    if (match) {
      body = match[2]?.trim() ?? '';
      frontmatter = parseFrontmatter(match[1] ?? '', filePath);
    } else {
      body = content.trim();
      frontmatter = null;
    }

    if (!frontmatter && !body) {
      return { skill: null, reportedLoadFailure: false };
    }

    let description: string;
    let hasUserSpecifiedDescription: boolean;
    if (frontmatter?.description) {
      description = frontmatter.description;
      hasUserSpecifiedDescription = true;
    } else {
      description = extractDescriptionFromBody(body);
      hasUserSpecifiedDescription = false;
    }

    const finalName = identity ?? path.basename(path.dirname(filePath));
    const frontmatterDisplayName = frontmatter?.name?.trim();
    const finalDisplayName =
      frontmatterDisplayName && frontmatterDisplayName.length > 0
        ? frontmatterDisplayName
        : displayBase;

    const {
      name: _name,
      description: _desc,
      ...extendedFields
    } = frontmatter ?? { description: '' };

    return {
      skill: {
        name: finalName,
        ...(finalDisplayName ? { displayName: finalDisplayName } : {}),
        description,
        hasUserSpecifiedDescription,
        location: filePath,
        skillRoot: path.dirname(filePath),
        resolvedPath,
        body,
        userInvocable: extendedFields.userInvocable ?? true,
        ...extendedFields,
      },
      reportedLoadFailure: false,
    };
  } catch (error) {
    const msg = `Error parsing skill file ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
    currentLoadErrors().push({
      filePath,
      message: msg,
      configType: 'skill',
    });
    return { skill: null, reportedLoadFailure: true };
  }
}
