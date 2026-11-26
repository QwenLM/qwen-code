/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Internal runtime path exemptions. Locations are supplied by the caller;
 * matching never reads product identity or environment configuration.
 */
import { normalize, posix, sep } from 'node:path';
import { getPlatform } from '../../utils/platform.js';
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js';
import type { InternalPathContext } from './internal-path-deps.js';
import { isAutoMemoryPath } from './filesystem-helpers.js';
export type { InternalPathContext } from './internal-path-deps.js';

export const INTERNAL_DIR_NAME = '.qwen';
export const _DIR_SEP = posix.sep;

function toPosixPath(value: string): string {
  return getPlatform() === 'windows' ? windowsPathToPosixPath(value) : value;
}

function prefix(dir: string): string {
  return toPosixPath(dir).replace(/\/$/, '') + '/';
}

/** Descendants only, matching the original subtree exemptions. */
function under(file: string, dir?: string): boolean {
  return (
    !!dir &&
    toPosixPath(file).toLowerCase().startsWith(prefix(dir).toLowerCase())
  );
}

const GLOBAL_READ_SUBDIRS = [
  'plans',
  'skills',
  'agents',
  'policies',
  'extensions',
  'agent-memory',
];
const USER_CONFIG_SUBDIRS = ['skills', 'agents', 'policies', 'extensions'];
const PROJECT_EDITABLE = [
  'todo.md',
  'memory/',
  'agent-memory/',
  'agent-memory-local/',
];
const PROJECT_SETTINGS = ['settings.json', 'settings.local.json'];

export function isGlobalConfigSubdirReadPath(
  absolutePath: string,
  ctx: InternalPathContext = {},
): boolean {
  if (!ctx.userConfigDir) return false;
  const file = toPosixPath(absolutePath).toLowerCase();
  return GLOBAL_READ_SUBDIRS.some((subdir) => {
    const dir = posix.join(toPosixPath(ctx.userConfigDir!), subdir);
    return file === dir.toLowerCase() || under(absolutePath, dir);
  });
}

function matchesProjectInternalPattern(
  absolutePath: string,
  patterns: readonly string[],
  ctx: InternalPathContext,
): boolean {
  if (!under(absolutePath, ctx.projectConfigDir)) return false;
  const relative = toPosixPath(absolutePath)
    .slice(prefix(ctx.projectConfigDir!).length)
    .toLowerCase();
  return patterns.some((pattern) =>
    pattern.endsWith('/') ? relative.startsWith(pattern) : relative === pattern,
  );
}

export function isProjectInternalPath(
  absolutePath: string,
  _cwd: string,
  ctx: InternalPathContext = {},
): boolean {
  return matchesProjectInternalPattern(
    absolutePath,
    [...PROJECT_EDITABLE, ...PROJECT_SETTINGS],
    ctx,
  );
}

export function isProjectInternalEditablePath(
  absolutePath: string,
  _cwd: string,
  ctx: InternalPathContext = {},
): boolean {
  return matchesProjectInternalPattern(absolutePath, PROJECT_EDITABLE, ctx);
}

export function isProjectDirPath(
  absolutePath: string,
  _cwd: string,
  ctx: InternalPathContext = {},
): boolean {
  return under(absolutePath, ctx.projectStorageDir);
}

export function isProjectTempPath(
  absolutePath: string,
  _cwd: string,
  ctx: InternalPathContext = {},
): boolean {
  return (
    under(absolutePath, ctx.projectTempDir) ||
    under(absolutePath, ctx.realProjectTempDir)
  );
}

export function isIsolatedTaskOutput(
  absolutePath: string,
  _cwd: string,
  ctx: InternalPathContext = {},
): boolean {
  return under(absolutePath, ctx.taskOutputDir);
}

export function isPastedImagePath(
  absolutePath: string,
  _cwd: string,
  ctx: InternalPathContext = {},
): boolean {
  return under(absolutePath, ctx.pastedImageDir);
}

/**
 * Checks whether the path is an inbound-upload landing file under the
 * current session. Requires InternalPathContext.sessionId; missing ctx is
 * conservative-deny.
 */
export function isInboundUploadPath(
  absolutePath: string,
  ctx: InternalPathContext = {},
): boolean {
  return under(absolutePath, ctx.inboundUploadDir);
}

export function isUserConfigPath(
  absolutePath: string,
  ctx: InternalPathContext = {},
): boolean {
  return (
    !!ctx.userConfigDir &&
    USER_CONFIG_SUBDIRS.some((subdir) =>
      under(absolutePath, posix.join(toPosixPath(ctx.userConfigDir!), subdir)),
    )
  );
}

export function isSessionPlanFile(
  absolutePath: string,
  ctx: InternalPathContext = {},
): boolean {
  return (
    under(absolutePath, ctx.plansDir) &&
    toPosixPath(absolutePath).toLowerCase().endsWith('.md')
  );
}

export function isMcpToolOutputPath(
  absolutePath: string,
  ctx: InternalPathContext = {},
): boolean {
  return (
    !!ctx.mcpOutputDirName &&
    toPosixPath(absolutePath)
      .toLowerCase()
      .includes('/' + ctx.mcpOutputDirName.toLowerCase() + '/')
  );
}

export function checkReadableInternalPath(
  absolutePath: string,
  cwd: string,
  ctx: InternalPathContext = {},
): boolean {
  return (
    isGlobalConfigSubdirReadPath(absolutePath, ctx) ||
    isProjectInternalPath(absolutePath, cwd, ctx) ||
    isProjectDirPath(absolutePath, cwd, ctx) ||
    isProjectTempPath(absolutePath, cwd, ctx) ||
    isIsolatedTaskOutput(absolutePath, cwd, ctx) ||
    isPastedImagePath(absolutePath, cwd, ctx) ||
    isInboundUploadPath(absolutePath, ctx) ||
    isUserConfigPath(absolutePath, ctx) ||
    isSessionPlanFile(absolutePath, ctx) ||
    isAutoMemoryPath(absolutePath, ctx) ||
    isMcpToolOutputPath(absolutePath, ctx)
  );
}

export function checkEditableInternalPath(
  absolutePath: string,
  cwd: string,
  ctx: InternalPathContext = {},
): boolean {
  return (
    isProjectInternalEditablePath(absolutePath, cwd, ctx) ||
    isProjectDirPath(absolutePath, cwd, ctx) ||
    isProjectTempPath(absolutePath, cwd, ctx) ||
    isIsolatedTaskOutput(absolutePath, cwd, ctx) ||
    isPastedImagePath(absolutePath, cwd, ctx) ||
    isSessionPlanFile(absolutePath, ctx) ||
    isAutoMemoryPath(absolutePath, ctx) ||
    (ctx.agentMemoryDirs ?? []).some((dir) =>
      normalize(absolutePath).startsWith(normalize(dir) + sep),
    )
  );
}
