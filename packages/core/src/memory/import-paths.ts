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
      const backlink = fs.realpathSync(
        path.resolve(directory, readMetadata(path.join(directory, 'gitdir'))),
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
export function getImportedProjectMemoryRoot(projectRoot: string): string {
  const identity = createHash('sha256')
    .update(memoryImportRepositoryIdentity(projectRoot))
    .digest('hex');
  return path.join(
    Storage.getRuntimeBaseDir(),
    'imported-project-memory',
    identity,
  );
}
