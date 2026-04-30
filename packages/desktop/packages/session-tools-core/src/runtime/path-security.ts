import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

function normalizePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function isWithin(base: string, target: string): boolean {
  const normalizedBase = normalizePath(base);
  const normalizedTarget = normalizePath(target);
  const rel = relative(normalizedBase, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realpathIfExists(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

/**
 * Lexical + symlink-aware containment check for existing paths.
 */
export function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);

  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = realpathIfExists(resolvedBase);
  const realTarget = realpathIfExists(resolvedTarget);
  return isWithin(realBase, realTarget);
}

/**
 * Containment check for output/creation paths.
 *
 * Prevents symlink escapes by validating the nearest existing ancestor's real path.
 */
export function isPathWithinDirectoryForCreation(targetPath: string, baseDir: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);

  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = realpathIfExists(resolvedBase);

  if (existsSync(resolvedTarget)) {
    return isPathWithinDirectory(resolvedTarget, realBase);
  }

  let current = dirname(resolvedTarget);
  while (true) {
    if (existsSync(current)) {
      const realCurrent = realpathSync.native(current);
      return isWithin(realBase, realCurrent);
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
