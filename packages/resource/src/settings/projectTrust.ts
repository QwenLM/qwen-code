/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { SettingsValues } from './settingsTypes.js';

function realPath(value: string): string {
  // Match the filesystem-touch guard: vouched local device/WSL paths are
  // local, while UNC, unvouched device namespaces, NT objects and autofs
  // host paths must never trigger a network probe during a trust check.
  const localMount =
    /^[\\/]{2}[?.][\\/][A-Za-z]:(?:[\\/].*)?$/.test(value) ||
    /^[\\/]{2}[?.][\\/]volume\{[^}]*\}(?:[\\/]|$)/i.test(value) ||
    /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]/i.test(value);
  if (
    !localMount &&
    (/^[\\/]{2}/.test(value) ||
      /^[\\/]\?\?[\\/]/.test(value) ||
      /^[\\/]net[\\/][^\\/]+(?:[\\/]|$)/.test(value))
  )
    return value;
  try {
    return existsSync(value) ? realpathSync(value) : value;
  } catch {
    return value;
  }
}
function within(project: string, root: string): boolean {
  let projectPath = resolve(project);
  let rootPath = resolve(root);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    projectPath = projectPath.toLowerCase();
    rootPath = rootPath.toLowerCase();
  }
  return (
    projectPath === rootPath ||
    projectPath.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep)
  );
}
export function isProjectTrusted(
  settings: SettingsValues,
  projectPath: string,
  headless: boolean,
): boolean {
  if (headless || settings.security?.folderTrust?.enabled === false)
    return true;
  const directories = [
    ...(settings.permissions?.trustDirectories ?? []),
    ...(settings.permissions?.additionalDirectories ?? []),
  ];
  const project = realPath(projectPath);
  return directories.some((directory) => within(project, realPath(directory)));
}

/** Directory identity for the HOME guard, including symlinks and platform casing. */
export function isSameSettingsDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const result = resolve(realPath(value)).replace(/\\/g, '/');
    return process.platform === 'win32' || process.platform === 'darwin'
      ? result.toLowerCase()
      : result;
  };
  return normalize(left) === normalize(right);
}
