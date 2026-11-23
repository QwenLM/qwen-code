/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  getGitMemoryIdentity,
  listGitMemoryWorktrees,
  resolveGitMemoryLocation,
} from '@qwen-code/qwen-code-core/memory/git-memory-identity.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getLegacyProjectMemoryRoot,
  getMemoryBaseDir,
  resolveProjectMemoryTarget,
  type MemoryProjectScope,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import {
  listTrustedMemoryMarkdownFiles,
  resolveTrustedMemoryRoot,
} from '@qwen-code/qwen-code-core/memory/trusted-memory-filesystem.js';
import { parseAutoMemoryTopicDocument } from '@qwen-code/qwen-code-core/memory/structured-scan.js';
import { readWorktreeSessionStrict } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import { readWorktreeSessionMarkerStrict } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { estimateMemoryImport } from '@qwen-code/qwen-code-core/memory/import-budget.js';
import {
  digest,
  IMPORT_LIMITS,
  MemoryImportRequestError,
  type ImportPreview,
  type ImportSection,
} from './source.js';

export type WorktreeImportTarget = ReturnType<
  typeof resolveProjectMemoryTarget
>;

export interface WorktreeImportPreview extends ImportPreview {
  target: WorktreeImportTarget;
}

export function worktreeTargetKey(target: WorktreeImportTarget): string {
  return JSON.stringify([target.owner, target.scope, target.memoryRoot]);
}

export function matchesWorktreeTarget(
  actual: WorktreeImportTarget,
  expected: unknown,
): boolean {
  if (expected === null || typeof expected !== 'object') return false;
  const fields = expected as Partial<WorktreeImportTarget>;
  return (
    actual.owner === fields.owner &&
    actual.scope === fields.scope &&
    actual.memoryRoot === fields.memoryRoot
  );
}

const repreview =
  'The worktree memory target or source changed. Preview again and confirm the current selection.';

export function assertWorktreeTarget(
  actual: WorktreeImportTarget,
  expected: unknown,
): void {
  if (!matchesWorktreeTarget(actual, expected))
    throw new MemoryImportRequestError(repreview);
}

export function assertWorktreePreview(
  preview: WorktreeImportPreview,
  target: unknown,
  digest: unknown,
): void {
  assertWorktreeTarget(preview.target, target);
  if (preview.digest !== digest) throw new MemoryImportRequestError(repreview);
}

export function assertWorktreeSelectionScope(selection: unknown): void {
  if (
    Array.isArray(selection) &&
    selection.some(
      (item: unknown) =>
        item &&
        typeof item === 'object' &&
        'scope' in item &&
        item.scope !== 'project',
    )
  )
    throw new MemoryImportRequestError(
      'Worktree sources can only be imported into project memory.',
    );
}

async function lstat(file: string) {
  return fs.lstat(file).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return undefined;
  });
}

async function pathAliases(start: string, checkout: string): Promise<string[]> {
  const aliases = [checkout];
  let current = path.resolve(start);
  while (true) {
    if ((await fs.realpath(current).catch(() => undefined)) === checkout) {
      aliases.push(current);
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(aliases)];
}

async function workspaceWorktrees(
  cwd: string,
  aliases: string[],
): Promise<string[]> {
  const { identity, separateCommonDir } = resolveGitMemoryLocation(cwd);
  const commonDir = identity?.commonDir ?? separateCommonDir;
  if (!commonDir) return [];
  const directories = new Set<string>();
  const checkouts = new Set<string>();
  const canonicalWorkspace = await fs.realpath(cwd);
  const base = Storage.getRuntimeBaseDir();
  const canonicalBase = await fs.realpath(base).catch(() => undefined);
  if (!canonicalBase) return [];
  for (const alias of aliases) {
    const project = new Storage(alias, base).getProjectDir();
    const chats = path.join(project, 'chats');
    directories.add(chats);
    directories.add(path.join(chats, 'archive'));
  }
  for (const directory of directories) {
    if (!(await lstat(directory))?.isDirectory()) continue;
    if (
      (await fs.realpath(directory)) !==
      path.join(canonicalBase, path.relative(base, directory))
    )
      continue;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const sessionId = /^([\w-]{1,128})\.worktree\.json$/.exec(
        entry.name,
      )?.[1];
      if (!sessionId || !entry.isFile()) continue;
      const result = await readWorktreeSessionStrict(
        path.join(directory, entry.name),
      );
      if (result.state !== 'valid') continue;
      const { workspaceCwd, worktreePath, supersededBy } = result.session;
      if (
        supersededBy ||
        !workspaceCwd ||
        !path.isAbsolute(workspaceCwd) ||
        !path.isAbsolute(worktreePath) ||
        (await fs.realpath(workspaceCwd).catch(() => undefined)) !==
          canonicalWorkspace
      )
        continue;
      const worktree = getGitMemoryIdentity(worktreePath);
      if (
        worktree?.kind !== 'linked' ||
        worktree.commonDir !== commonDir ||
        (await fs.realpath(worktreePath).catch(() => undefined)) !==
          worktree.checkout
      )
        continue;
      const marker = await readWorktreeSessionMarkerStrict(worktree.checkout);
      if (marker.state !== 'valid' || marker.sessionId !== sessionId) continue;
      checkouts.add(worktreePath);
      checkouts.add(worktree.checkout);
    }
  }
  return [...checkouts];
}

async function explicitSource(source: string): Promise<string> {
  const provided = path.resolve(source);
  const legacyRoot = getLegacyProjectMemoryRoot(provided);
  const entry = await lstat(provided);
  const checkout =
    getGitMemoryIdentity(provided)?.checkout === provided ||
    (await lstat(path.join(provided, '.git'))) !== undefined;
  if (
    (await lstat(legacyRoot))?.isDirectory() &&
    (!entry || checkout || path.basename(provided) !== 'memory')
  )
    return legacyRoot;
  if (!entry?.isDirectory() || checkout)
    throw new MemoryImportRequestError(
      'No old memory directory found for --source. Provide the old checkout path or its memory directory.',
    );
  return provided;
}

async function readTopic(file: string): Promise<string> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > IMPORT_LIMITS.fileBytes
    )
      throw new MemoryImportRequestError(
        'Legacy memory topics must be regular files at most 512 KiB each.',
      );
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.size !== stat.size
    )
      throw new MemoryImportRequestError(repreview);
    const content = bytes.subarray(0, length).toString('utf8');
    if (content.includes('\0'))
      throw new MemoryImportRequestError(
        'Legacy memory topics must be Markdown text.',
      );
    return content;
  } finally {
    await handle.close();
  }
}

export async function previewWorktreeMemory(
  cwd: string,
  options: {
    scope?: MemoryProjectScope;
    source?: string;
    lexicalCwd?: string;
    excludedRoots?: ReadonlySet<string>;
    hintWorkspaceScope?: boolean;
  } = {},
): Promise<WorktreeImportPreview> {
  const target = resolveProjectMemoryTarget(cwd, {
    scope: options.scope,
    readOnly: true,
  });
  const roots = new Set<string>();
  const warnings: string[] = [];
  const repository = getGitMemoryIdentity(cwd);
  if (
    options.hintWorkspaceScope &&
    target.scope === 'git-root' &&
    repository &&
    (await fs.realpath(cwd)) !== repository.checkout
  )
    warnings.push(
      'Use --scope workspace to target the same directory as qwen serve with its default workspace scope.',
    );
  if (options.source) {
    roots.add(await explicitSource(options.source));
  } else {
    const lexicalCwd = options.lexicalCwd ?? cwd;
    let legacyOwners: string[] = [];
    if (target.scope === 'workspace') {
      const alias = await pathAliases(lexicalCwd, await fs.realpath(cwd));
      legacyOwners = [...alias, ...(await workspaceWorktrees(cwd, alias))];
    } else if (repository) {
      legacyOwners = listGitMemoryWorktrees(repository.commonDir);
      if (repository.kind !== 'bare')
        legacyOwners.push(
          ...(await pathAliases(lexicalCwd, repository.checkout)),
        );
      if (
        repository.kind === 'linked' &&
        path.basename(repository.commonDir) === '.git'
      ) {
        const candidate = getLegacyProjectMemoryRoot(
          path.dirname(repository.commonDir),
        );
        if (
          candidate !== target.memoryRoot &&
          (await lstat(candidate))?.isDirectory()
        )
          warnings.push(
            `Unverified old checkout memory at ${candidate}. Open the main checkout to verify it or explicitly preview with --source.`,
          );
      }
    }
    for (const owner of legacyOwners)
      roots.add(getLegacyProjectMemoryRoot(owner));
  }

  const sections: ImportSection[] = [];
  const groups: ImportPreview['groups'] = [];
  let files = 0;
  let bytes = 0;
  const seen = new Set<string>();
  const active = await fs
    .realpath(target.memoryRoot)
    .catch(() => target.memoryRoot);
  for (const root of [...roots].sort()) {
    if (root === target.memoryRoot || options.excludedRoots?.has(root))
      continue;
    const anchor = options.source ? path.dirname(root) : getMemoryBaseDir();
    const resolved = await resolveTrustedMemoryRoot(root, anchor);
    if (!resolved || resolved === active || seen.has(resolved)) continue;
    if (
      (await fs.realpath(anchor)) !== path.dirname(resolved) &&
      options.source
    )
      throw new MemoryImportRequestError(
        'Explicit legacy memory directory must not be a symlink.',
      );
    if (
      !options.source &&
      resolved !==
        path.join(await fs.realpath(anchor), path.relative(anchor, root))
    )
      continue;
    seen.add(resolved);
    const groupId = digest(JSON.stringify(['worktree', resolved]));
    const topics: ImportSection[] = [];
    for (const entry of await listTrustedMemoryMarkdownFiles(
      root,
      anchor,
      AUTO_MEMORY_INDEX_FILENAME,
    )) {
      if (++files > IMPORT_LIMITS.files)
        throw new MemoryImportRequestError(
          'Too many legacy memory topics. Preview a single old library with --source.',
        );
      const content = await readTopic(entry.resolvedPath);
      if ((bytes += Buffer.byteLength(content)) > IMPORT_LIMITS.totalBytes)
        throw new MemoryImportRequestError(
          'Legacy memory preview exceeds the byte limit.',
        );
      if (!content.trim()) continue;
      const selectable =
        Buffer.byteLength(content) <= IMPORT_LIMITS.sectionBytes;
      if (!selectable)
        warnings.push(
          `${root}/${entry.relativePath} exceeds the 64 KiB per-topic import limit.`,
        );
      topics.push({
        id: digest(JSON.stringify([groupId, entry.relativePath, content])),
        groupId,
        title:
          parseAutoMemoryTopicDocument(entry.relativePath, content)?.title ??
          entry.relativePath,
        path: entry.relativePath,
        line: 1,
        content,
        references: [],
        suggestedScope: 'project',
        sourceProject: root,
        reason: 'Legacy project memory topic.',
        selectable,
      });
    }
    if (!topics.length) continue;
    groups.push({
      id: groupId,
      scope: 'project',
      sourceProject: root,
      sectionIds: topics.map((topic) => topic.id),
      estimate: estimateMemoryImport(
        topics.filter(({ selectable }) => selectable),
      ),
    });
    sections.push(...topics);
  }

  return {
    version: 1,
    kind: 'preview',
    digest: digest(
      JSON.stringify([worktreeTargetKey(target), sections.map(({ id }) => id)]),
    ),
    target,
    groups,
    sections,
    warnings,
    estimate: estimateMemoryImport(
      sections.filter(({ selectable }) => selectable),
    ),
  };
}
