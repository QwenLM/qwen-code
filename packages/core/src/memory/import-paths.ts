/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Storage } from '../config/storage.js';

function readMetadata(file: string): string {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096)
      throw new Error('Invalid Git metadata.');
    return fs.readFileSync(fd, 'utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
}

// A recorded metadata path (commondir, gitdir backlink) may name a directory
// that no longer exists — git still considers a moved worktree valid. Resolve
// to the real path when possible, but keep the unresolved path otherwise so
// the registration check below reaches its own diagnostic instead of leaking
// a raw ENOENT. Never ACCEPT an unresolvable backlink: the equality check
// against the real .git path is what stops a copied .git file from inheriting
// another repository's imported-memory identity.
function resolveMetadataPath(
  base: string,
  target: string,
  realpath: (file: string) => string,
): string {
  const resolved = path.resolve(base, target);
  try {
    return realpath(resolved);
  } catch {
    return resolved;
  }
}

function dependencyStamp(file: string): string {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}:${stat.mode}`;
    return stat.isDirectory()
      ? identity
      : `${identity}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

function dependenciesMatch(dependencies: Map<string, string>): boolean {
  for (const [file, stamp] of dependencies) {
    if (dependencyStamp(file) !== stamp) return false;
  }
  return true;
}

function resolveRepositoryIdentity(
  projectRoot: string,
  dependencies?: Map<string, string>,
): string {
  const observe = (file: string) => {
    if (dependencies && !dependencies.has(file))
      dependencies.set(file, dependencyStamp(file));
  };
  const observeParents = (file: string) => {
    if (!dependencies) return;
    let current = path.resolve(file);
    while (true) {
      observe(current);
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  };
  const realpath = (file: string) => {
    observeParents(file);
    const resolved = fs.realpathSync(file);
    observeParents(resolved);
    return resolved;
  };
  const metadata = (file: string) => {
    observe(file);
    return readMetadata(file);
  };
  let current = realpath(projectRoot);
  while (true) {
    const git = path.join(current, '.git');
    observe(git);
    if (fs.existsSync(git)) {
      const stat = fs.lstatSync(git);
      if (stat.isSymbolicLink())
        throw new Error(
          'Symlinked Git metadata is not supported for memory import.',
        );
      if (stat.isDirectory()) return realpath(git);
      const pointer = metadata(git);
      if (!pointer.startsWith('gitdir: '))
        throw new Error('Invalid Git directory pointer.');
      const directory = realpath(path.resolve(current, pointer.slice(8)));
      const common = path.join(directory, 'commondir');
      observe(common);
      if (!fs.existsSync(common)) return realpath(current);
      const commonDirectory = realpath(
        path.resolve(directory, metadata(common)),
      );
      const backlink = resolveMetadataPath(
        directory,
        metadata(path.join(directory, 'gitdir')),
        realpath,
      );
      if (
        backlink !== realpath(git) ||
        realpath(path.dirname(directory)) !==
          realpath(path.join(commonDirectory, 'worktrees'))
      )
        throw new Error('Invalid linked worktree registration.');
      return commonDirectory;
    }
    const parent = path.dirname(current);
    if (parent === current) return realpath(projectRoot);
    current = parent;
  }
}
export function memoryImportRepositoryIdentity(projectRoot: string): string {
  return resolveRepositoryIdentity(projectRoot);
}
const identities = new Map<
  string,
  { repository: string; dependencies: Map<string, string> }
>();
export function clearMemoryImportIdentityCache(): void {
  identities.clear();
}
export function getImportedProjectMemoryRoot(
  projectRoot: string,
  refresh = false,
): string {
  const key = path.resolve(projectRoot);
  let entry = refresh ? undefined : identities.get(key);
  if (!entry || !dependenciesMatch(entry.dependencies)) {
    identities.delete(key);
    const dependencies = new Map<string, string>();
    const repository = resolveRepositoryIdentity(projectRoot, dependencies);
    if (!dependenciesMatch(dependencies))
      throw new Error(
        'Git metadata changed while resolving memory import identity. Retry the operation.',
      );
    entry = { repository, dependencies };
    if (identities.size >= 256)
      identities.delete(identities.keys().next().value!);
    identities.set(key, entry);
  }
  const identity = createHash('sha256').update(entry.repository).digest('hex');
  return path.join(
    Storage.getRuntimeBaseDir(),
    'imported-project-memory',
    identity,
  );
}
