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
function resolveMetadataPath(base: string, target: string): string {
  const resolved = path.resolve(base, target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function memoryImportRepositoryIdentity(projectRoot: string): string {
  let current = fs.realpathSync(projectRoot);
  while (true) {
    const git = path.join(current, '.git');
    if (fs.existsSync(git)) {
      const stat = fs.lstatSync(git);
      if (stat.isSymbolicLink())
        throw new Error(
          'Symlinked Git metadata is not supported for memory import.',
        );
      if (stat.isDirectory()) return fs.realpathSync(git);
      const pointer = readMetadata(git);
      if (!pointer.startsWith('gitdir: '))
        throw new Error('Invalid Git directory pointer.');
      const directory = fs.realpathSync(
        path.resolve(current, pointer.slice(8)),
      );
      const common = path.join(directory, 'commondir');
      if (!fs.existsSync(common)) return fs.realpathSync(current);
      const commonDirectory = fs.realpathSync(
        path.resolve(directory, readMetadata(common)),
      );
      const backlink = resolveMetadataPath(
        directory,
        readMetadata(path.join(directory, 'gitdir')),
      );
      if (
        backlink !== fs.realpathSync(git) ||
        fs.realpathSync(path.dirname(directory)) !==
          fs.realpathSync(path.join(commonDirectory, 'worktrees'))
      )
        throw new Error('Invalid linked worktree registration.');
      return commonDirectory;
    }
    const parent = path.dirname(current);
    if (parent === current) return fs.realpathSync(projectRoot);
    current = parent;
  }
}
const identities = new Map<string, string>();
export function clearMemoryImportIdentityCache(): void {
  identities.clear();
}
export function getImportedProjectMemoryRoot(
  projectRoot: string,
  refresh = false,
): string {
  const key = path.resolve(projectRoot);
  let repository = refresh ? undefined : identities.get(key);
  if (!repository) {
    identities.delete(key);
    repository = memoryImportRepositoryIdentity(projectRoot);
    if (identities.size >= 256)
      identities.delete(identities.keys().next().value!);
    identities.set(key, repository);
  }
  const identity = createHash('sha256').update(repository).digest('hex');
  return path.join(
    Storage.getRuntimeBaseDir(),
    'imported-project-memory',
    identity,
  );
}
