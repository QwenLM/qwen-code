/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export const REPOSITORY_CONTEXT_VERSION = 1 as const;
export const OPENJDK_PLATFORM_SPECIALIST = 'openjdk-platform-impact' as const;

const OPENJDK_UNVERIFIED_DIMENSIONS = [
  'CPU backend interactions were not verified on every target architecture',
  'cross-platform implementations were not verified on every affected target',
] as const;

export interface RepositoryContext {
  version: typeof REPOSITORY_CONTEXT_VERSION;
  adapter: 'openjdk';
  domains: string[];
  relatedPaths: string[];
  testSelections: string[];
  requiredConfigurations: string[];
  specialists: Array<typeof OPENJDK_PLATFORM_SPECIALIST>;
  unverifiedDimensions: string[];
}

export interface RepositoryContextPlan {
  repositoryContext?: unknown;
}

const CONTEXT_KEYS = [
  'version',
  'adapter',
  'domains',
  'relatedPaths',
  'testSelections',
  'requiredConfigurations',
  'specialists',
  'unverifiedDimensions',
].sort();

function isSafeString(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isSafeString);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSortedUnique(values: string[]): boolean {
  return values.every(
    (value, index) => index === 0 || compareText(values[index - 1], value) < 0,
  );
}

/** Validate repository context before any downstream consumer trusts it. */
export function validateRepositoryContext(value: unknown): RepositoryContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('repositoryContext must be an object');
  }
  const context = value as Record<string, unknown>;
  const keys = Object.keys(context).sort();
  if (
    keys.length !== CONTEXT_KEYS.length ||
    keys.some((key, index) => key !== CONTEXT_KEYS[index])
  ) {
    throw new Error('repositoryContext has unknown or missing fields');
  }
  if (context['version'] !== REPOSITORY_CONTEXT_VERSION) {
    throw new Error('unsupported repositoryContext version');
  }
  if (context['adapter'] !== 'openjdk') {
    throw new Error('unsupported repositoryContext adapter');
  }
  for (const field of [
    'domains',
    'relatedPaths',
    'testSelections',
    'requiredConfigurations',
    'specialists',
    'unverifiedDimensions',
  ] as const) {
    if (!isStringArray(context[field])) {
      throw new Error(`repositoryContext.${field} must be a safe string array`);
    }
    if (!isSortedUnique(context[field])) {
      throw new Error(`repositoryContext.${field} must be sorted and unique`);
    }
  }
  const token = /^[A-Za-z0-9._:/+-]+$/;
  for (const field of [
    'domains',
    'testSelections',
    'requiredConfigurations',
  ] as const) {
    if ((context[field] as string[]).some((value) => !token.test(value))) {
      throw new Error(`repositoryContext.${field} contains an unsafe token`);
    }
  }
  const repositoryPath = /^[A-Za-z0-9._/@+$:-]+$/;
  if (
    (context['relatedPaths'] as string[]).some(
      (path) => !safeRelativePath(path) || !repositoryPath.test(path),
    )
  ) {
    throw new Error('repositoryContext.relatedPaths contains an unsafe path');
  }
  const specialists = context['specialists'];
  if (
    !isStringArray(specialists) ||
    specialists.some(
      (specialist: string) => specialist !== OPENJDK_PLATFORM_SPECIALIST,
    )
  ) {
    throw new Error('repositoryContext contains an unknown specialist');
  }
  if (
    (context['unverifiedDimensions'] as string[]).some(
      (dimension) =>
        !OPENJDK_UNVERIFIED_DIMENSIONS.includes(
          dimension as (typeof OPENJDK_UNVERIFIED_DIMENSIONS)[number],
        ),
    )
  ) {
    throw new Error(
      'repositoryContext contains an unknown unverified dimension',
    );
  }
  return context as unknown as RepositoryContext;
}

export function repositoryContextOf(
  plan: RepositoryContextPlan,
): RepositoryContext | null {
  if (plan.repositoryContext === undefined) return null;
  return validateRepositoryContext(plan.repositoryContext);
}

export interface TestGroup {
  name: string;
  entries: string[];
}

/** Parse the assignment subset of jtreg TEST.groups used for recommendations. */
export function parseTestGroups(text: string): TestGroup[] {
  const logicalLines: string[] = [];
  let pending = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (pending.length === 0 && (trimmed === '' || trimmed.startsWith('#'))) {
      continue;
    }
    const continued = /\\\s*$/.test(rawLine);
    const part = rawLine.replace(/\\\s*$/, '').trim();
    pending = `${pending} ${part}`.trim();
    if (!continued) {
      if (pending.length > 0) logicalLines.push(pending);
      pending = '';
    }
  }
  if (pending.length > 0) logicalLines.push(pending);

  const groups = new Map<string, string[]>();
  for (const line of logicalLines) {
    const match = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    groups.set(
      match[1],
      match[2].split(/\s+/).filter((entry) => entry.length > 0),
    );
  }
  return [...groups]
    .map(([name, entries]) => ({ name, entries }))
    .sort((a, b) => compareText(a.name, b.name));
}

/** Recognize OpenJDK only from the declared jcheck project. */
export function isOpenJdkConfig(text: string): boolean {
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== 'general') continue;
    const assignment = /^([^=]+)=(.*)$/.exec(line);
    if (
      assignment?.[1].trim() === 'project' &&
      assignment[2].trim() === 'jdk'
    ) {
      return true;
    }
  }
  return false;
}

export function isOpenJdkWorktree(worktree: string): boolean {
  const conf = join(worktree, '.jcheck', 'conf');
  return existsSync(conf) && isOpenJdkConfig(readFileSync(conf, 'utf8'));
}

const MAX_DIRECTORY_ENTRIES = 256;
const MAX_RELATED_PATHS = 128;
const MAX_CLASS_SEARCH_DIRECTORIES = 512;

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !path.split(/[\\/]/).includes('..')
  );
}

function boundedDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareText)
      .slice(0, MAX_DIRECTORY_ENTRIES);
  } catch {
    return [];
  }
}

function addExistingPath(
  worktreeReal: string,
  candidate: string,
  relatedPaths: Set<string>,
): void {
  if (relatedPaths.size >= MAX_RELATED_PATHS || !safeRelativePath(candidate)) {
    return;
  }
  const absolute = join(worktreeReal, candidate);
  try {
    const resolved = realpathSync(absolute);
    const rel = relative(worktreeReal, resolved);
    if (!safeRelativePath(rel) || !statSync(resolved).isFile()) return;
    relatedPaths.add(candidate.split(sep).join('/'));
  } catch {
    // A missing, broken, or inaccessible candidate is not repository context.
  }
}

const SOURCE_SUFFIXES = [
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.inline.hpp',
  '.java',
] as const;

function sourceStem(file: string): string {
  return file.replace(/(?:\.inline)?\.[^.]+$/, '');
}

function sameStemNames(file: string): string[] {
  const stem = sourceStem(file);
  return SOURCE_SUFFIXES.map((suffix) => `${stem}${suffix}`);
}

function platformStem(file: string, platform: string): string {
  const stem = sourceStem(file);
  const tokens = platform.split('_').sort((a, b) => b.length - a.length);
  let logical = stem;
  for (const token of tokens) {
    if (logical.endsWith(`_${token}`)) {
      logical = logical.slice(0, -token.length - 1);
    }
  }
  return logical;
}

function platformStemNames(
  file: string,
  sourcePlatform: string,
  targetPlatform: string,
): string[] {
  const logical = platformStem(file, sourcePlatform);
  return SOURCE_SUFFIXES.map(
    (suffix) => `${logical}_${targetPlatform}${suffix}`,
  );
}

function testGroupEntryMatches(entry: string, candidate: string): boolean {
  if (entry === '/' || entry.startsWith('-') || entry.startsWith(':')) {
    return false;
  }
  const directory = entry.replace(/\/$/, '');
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

function readContainedFile(worktree: string, path: string): string | null {
  try {
    const resolved = realpathSync(join(worktree, path));
    const rel = relative(worktree, resolved);
    if (!safeRelativePath(rel) || !statSync(resolved).isFile()) return null;
    return readFileSync(resolved, 'utf8');
  } catch {
    return null;
  }
}

function selectTestGroups(
  worktree: string,
  file: string,
  prefix: string,
  candidates: string[],
  selections: Set<string>,
): void {
  const text = readContainedFile(worktree, file);
  if (text === null) return;
  const groups = parseTestGroups(text);
  for (const group of groups) {
    if (group.entries.some((entry) => entry.startsWith('-'))) continue;
    if (
      group.entries.some((entry) =>
        candidates.some((candidate) => testGroupEntryMatches(entry, candidate)),
      )
    ) {
      selections.add(`${prefix}:${group.name}`);
    }
  }
}

function addHotspotCompiler(
  worktree: string,
  path: string,
  context: MutableContext,
): void {
  const match = /^src\/hotspot\/share\/opto\/(.+)$/.exec(path);
  if (!match) return;
  context.domains.add('c2');
  context.domains.add('compiler');
  context.domains.add('hotspot');
  context.configurations.add('fastdebug');
  context.configurations.add('server');
  context.specialists.add(OPENJDK_PLATFORM_SPECIALIST);
  context.unverified.add(
    'CPU backend interactions were not verified on every target architecture',
  );
  for (const name of sameStemNames(basename(path))) {
    addExistingPath(worktree, join(dirname(path), name), context.relatedPaths);
  }
  selectTestGroups(
    worktree,
    'test/hotspot/jtreg/TEST.groups',
    'hotspot',
    ['compiler', 'test/hotspot/jtreg/compiler'],
    context.tests,
  );
}

function addJavaClasses(
  worktree: string,
  path: string,
  context: MutableContext,
): void {
  const match = /^src\/([^/]+)\/([^/]+)\/classes\/(.+\/)?([^/]+\.java)$/.exec(
    path,
  );
  if (!match) return;
  const [, module, , packagePrefix = '', file] = match;
  context.domains.add('class-library');
  context.domains.add(module);
  for (const sourceSet of boundedDirectories(join(worktree, 'src', module))) {
    addExistingPath(
      worktree,
      join('src', module, sourceSet, 'classes', packagePrefix, file),
      context.relatedPaths,
    );
    addExistingPath(
      worktree,
      join('src', module, sourceSet, 'classes', 'module-info.java'),
      context.relatedPaths,
    );
    addExistingPath(
      worktree,
      join('src', module, sourceSet, 'classes', 'module-info.java.extra'),
      context.relatedPaths,
    );
  }
  const packagePath = packagePrefix.replace(/\/$/, '');
  selectTestGroups(
    worktree,
    'test/jdk/TEST.groups',
    'test/jdk',
    [packagePath, `test/jdk/${packagePath}`].filter(Boolean),
    context.tests,
  );
}

function scanPlatformLayers(
  worktree: string,
  sourcePlatform: string,
  relativeFile: string,
  file: string,
  context: MutableContext,
): void {
  for (const layer of ['cpu', 'os', 'os_cpu'] as const) {
    const root = join(worktree, 'src', 'hotspot', layer);
    for (const targetPlatform of boundedDirectories(root)) {
      const names = [
        ...sameStemNames(file),
        ...platformStemNames(file, sourcePlatform, targetPlatform),
      ];
      for (const name of names) {
        addExistingPath(
          worktree,
          join('src', 'hotspot', layer, targetPlatform, relativeFile, name),
          context.relatedPaths,
        );
      }
    }
  }
}

function addJavaDeclaration(
  worktree: string,
  module: string,
  nativeFile: string,
  context: MutableContext,
): void {
  const className = sourceStem(nativeFile).replace(
    /_(?:aix|bsd|linux|macosx|unix|windows)$/,
    '',
  );
  const target = `${className}.java`;
  const queue = boundedDirectories(join(worktree, 'src', module)).map(
    (sourceSet) => join('src', module, sourceSet, 'classes'),
  );
  let visited = 0;
  while (queue.length > 0 && visited < MAX_CLASS_SEARCH_DIRECTORIES) {
    const directory = queue.shift() as string;
    visited++;
    let entries;
    try {
      entries = readdirSync(join(worktree, directory), { withFileTypes: true })
        .sort((a, b) => compareText(a.name, b.name))
        .slice(0, MAX_DIRECTORY_ENTRIES);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.isFile() && entry.name === target) {
        addExistingPath(worktree, candidate, context.relatedPaths);
      }
    }
  }
}

function addPlatformNative(
  worktree: string,
  path: string,
  context: MutableContext,
): void {
  const hotspot =
    /^src\/hotspot\/(cpu|os|os_cpu)\/([^/]+)\/(.*\/)?([^/]+)$/.exec(path);
  const native = /^src\/([^/]+)\/([^/]+)\/native\/(.*\/)?([^/]+)$/.exec(path);
  if (!hotspot && !native) return;
  context.domains.add('platform-native');
  context.specialists.add(OPENJDK_PLATFORM_SPECIALIST);
  context.unverified.add(
    'cross-platform implementations were not verified on every affected target',
  );

  if (hotspot) {
    const [, layer, platform, relativeFile = '', file] = hotspot;
    context.domains.add('hotspot');
    for (const token of platform.split('_')) context.domains.add(token);
    context.configurations.add(platform.replaceAll('_', '-'));
    scanPlatformLayers(worktree, platform, relativeFile, file, context);
    context.domains.add(layer);
    return;
  }

  const [, module, sourceSet, relativeFile = '', file] = native!;
  context.domains.add(module);
  context.domains.add(sourceSet);
  if (sourceSet !== 'share') context.configurations.add(sourceSet);
  const nativeNames = new Set([
    ...sameStemNames(file),
    ...SOURCE_SUFFIXES.map(
      (suffix) => `${platformStem(file, sourceSet)}${suffix}`,
    ),
  ]);
  for (const siblingSourceSet of boundedDirectories(
    join(worktree, 'src', module),
  )) {
    for (const name of nativeNames) {
      addExistingPath(
        worktree,
        join('src', module, siblingSourceSet, 'native', relativeFile, name),
        context.relatedPaths,
      );
    }
  }
  addJavaDeclaration(worktree, module, file, context);
}

interface MutableContext {
  domains: Set<string>;
  relatedPaths: Set<string>;
  tests: Set<string>;
  configurations: Set<string>;
  specialists: Set<typeof OPENJDK_PLATFORM_SPECIALIST>;
  unverified: Set<string>;
}

/** Build deterministic, bounded OpenJDK context for changed repository paths. */
export function buildRepositoryContext(
  worktree: string,
  changedPaths: string[],
  trustedJcheckConfig?: string,
): RepositoryContext | null {
  const worktreeReal = realpathSync(worktree);
  const isOpenJdk =
    trustedJcheckConfig === undefined
      ? isOpenJdkWorktree(worktreeReal)
      : isOpenJdkConfig(trustedJcheckConfig);
  if (!isOpenJdk) return null;
  const context: MutableContext = {
    domains: new Set(),
    relatedPaths: new Set(),
    tests: new Set(),
    configurations: new Set(),
    specialists: new Set(),
    unverified: new Set(),
  };
  const normalizedPaths = new Set<string>();
  for (const path of sorted(changedPaths)) {
    if (!safeRelativePath(path)) {
      throw new Error(
        `changed path escapes the worktree: ${JSON.stringify(path)}`,
      );
    }
    const normalized = path.replaceAll('\\', '/');
    normalizedPaths.add(normalized);
    addHotspotCompiler(worktreeReal, normalized, context);
    addJavaClasses(worktreeReal, normalized, context);
    addPlatformNative(worktreeReal, normalized, context);
  }
  for (const path of normalizedPaths) context.relatedPaths.delete(path);
  return validateRepositoryContext({
    version: REPOSITORY_CONTEXT_VERSION,
    adapter: 'openjdk',
    domains: sorted(context.domains),
    relatedPaths: sorted(context.relatedPaths),
    testSelections: sorted(context.tests),
    requiredConfigurations: sorted(context.configurations),
    specialists: sorted(context.specialists),
    unverifiedDimensions: sorted(context.unverified),
  });
}
