/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyPathShape } from '../../utils/pathShape.js';

/** Execution context supplied by the host, never by model tool arguments. */
export interface ShellReadOnlyContext {
  cwd: string;
}

const MAX_CONTROL_FILE_BYTES = 4096;

function readControlFile(file: string): string | undefined {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_CONTROL_FILE_BYTES) return undefined;
  const text = fs.readFileSync(file, 'utf8');
  return text.includes('\0') ? undefined : text;
}

function hasGitHead(directory: string): boolean {
  try {
    const head = readControlFile(path.join(directory, 'HEAD'));
    return (
      head !== undefined &&
      /^(?:ref:[ \t]*refs\/|[0-9a-f]{40}(?:[0-9a-f]{24})?[ \t\r\n]*$)/.test(
        head,
      )
    );
  } catch {
    return false;
  }
}

function isRegularRepository(directory: string): boolean {
  if (!hasGitHead(directory)) return false;
  try {
    for (const name of ['objects', 'refs']) {
      const file = path.join(directory, name);
      if (!fs.statSync(file).isDirectory()) return false;
      fs.accessSync(file, fs.constants.X_OK);
    }
    return !fs.existsSync(path.join(directory, 'commondir'));
  } catch {
    return false;
  }
}

/** Inspect metadata only: running Git here could itself invoke repo config. */
export function gitReadOnlyContextReason(
  context: ShellReadOnlyContext,
): string | undefined {
  const { cwd } = context;
  let resolvedCwd: string;
  let canonicalCwd: string;
  try {
    if (classifyPathShape(cwd).network.kind === 'network') {
      return 'Git working directory cannot be verified locally';
    }
    resolvedCwd = fs.realpathSync(cwd).normalize('NFC');
    canonicalCwd = resolvedCwd.toLowerCase();
  } catch {
    return 'Git working directory cannot be verified';
  }

  function inspectGitEntry(
    directory: string,
  ): 'trusted' | 'unverified' | 'none' {
    const entry = path.join(directory, '.git');
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entry);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'none'
        : 'unverified';
    }
    try {
      if (stat.isDirectory()) {
        return isRegularRepository(entry) ? 'trusted' : 'none';
      }
      let target: string;
      if (stat.isSymbolicLink()) {
        target = fs.readlinkSync(entry);
      } else if (stat.isFile()) {
        const text = readControlFile(entry);
        if (text === undefined) return 'unverified';
        if (!text.startsWith('gitdir: ')) return 'none';
        target = text.slice(8).replace(/[\r\n]+$/, '');
      } else {
        return 'none';
      }
      if (classifyPathShape(target).network.kind === 'network')
        return 'unverified';
      const resolved = fs.realpathSync(path.resolve(directory, target));
      const normalized = resolved.normalize('NFC').toLowerCase();
      // A planted pointer into the working tree is not trusted. Linked
      // worktrees/submodules can point into another repository's .git tree.
      if (
        normalized === canonicalCwd ||
        normalized.startsWith(canonicalCwd + path.sep) ||
        !normalized.split(path.sep).includes('.git')
      )
        return 'unverified';
      return hasGitHead(resolved) ? 'trusted' : 'none';
    } catch {
      return 'unverified';
    }
  }

  for (let directory = resolvedCwd; ; ) {
    const state = inspectGitEntry(directory);
    if (state === 'trusted') return undefined;
    if (state === 'unverified')
      return 'Git directory redirection cannot be verified';
    for (const name of ['HEAD', 'objects', 'refs']) {
      try {
        const stat = fs.lstatSync(path.join(directory, name));
        if (name !== 'HEAD' || stat.isFile() || stat.isSymbolicLink()) {
          return 'Bare repository indicators require permission checks';
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return 'Git repository layout cannot be verified';
        }
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
