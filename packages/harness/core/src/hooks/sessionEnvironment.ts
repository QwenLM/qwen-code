/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { runLogger } from '../utils/runLogger.js';
import { isNodeError } from '../utils/errors.js';
import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';
import { getConfigHomeDir } from '../utils/paths.js';
import { HookEventName } from './types.js';

export const ENV_FILE_EVENTS = new Set<HookEventName>([
  HookEventName.Setup,
  HookEventName.SessionStart,
  HookEventName.CwdChanged,
  HookEventName.FileChanged,
]);

const HOOK_ENV_PRIORITY: Record<string, number> = {
  setup: 0,
  sessionstart: 1,
  cwdchanged: 2,
  filechanged: 3,
};

const HOOK_ENV_REGEX =
  /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/;
const CWD_ENV_REGEX = /^(cwdchanged|filechanged)-hook-\d+\.sh$/;

// 三态缓存，按 sessionId 键控：
//   未命中  = 尚未加载（需要读盘）
//   null    = 已读盘、没有文件（不再重复读）
//   string  = 已加载并缓存
// 单进程多会话下必须按会话分开：单槽缓存会让 A 会话的 hook 失效掉 B 会话的
// 脚本，交替调用时也会互相踩（每次都退回读盘）。
const sessionEnvScriptCache = new Map<string, string | null>();

const SESSION_ENV_DIR = 'session-env';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getSessionEnvDir(sessionId: string): string {
  return path.join(getConfigHomeDir(), SESSION_ENV_DIR, sessionId);
}

export function getEnvFilePath(
  sessionId: string,
  eventName: HookEventName,
  hookIndex: number,
): string {
  const prefix = eventName.toLowerCase();
  return path.join(
    getSessionEnvDir(sessionId),
    `${prefix}-hook-${hookIndex}.sh`,
  );
}

export function createEnvFile(
  sessionId: string,
  eventName: HookEventName,
  hookIndex: number,
): string {
  const filePath = getEnvFilePath(sessionId, eventName, hookIndex);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, '', { mode: 0o600 });
  return filePath;
}

export function truncateEnvFile(filePath: string): void {
  try {
    fs.writeFileSync(filePath, '');
  } catch {
    // ignore — best effort
  }
}

export async function getSessionEnvScript(
  sessionId: string,
): Promise<string | null> {
  if (process.platform === 'win32') {
    return null;
  }

  const cached = sessionEnvScriptCache.get(sessionId);
  if (cached !== undefined) {
    return cached;
  }

  const scripts: string[] = [];

  // Check the hook env file passed from the parent process (e.g., trajectory
  // runner or external orchestrator). This allows venv/conda activation to
  // persist across shell commands.
  const parentEnvFile = process.env[`${BRAND_FIXED_ENV_PREFIX}ENV_FILE`];
  if (parentEnvFile) {
    try {
      const envScript = fs.readFileSync(parentEnvFile, 'utf-8').trim();
      if (envScript) {
        scripts.push(envScript);
        runLogger.debug(
          `Session environment loaded from parent hook env file: ${parentEnvFile}`,
        );
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        runLogger.debug(`Failed to read parent hook env file: ${e}`);
      }
    }
  }

  const dir = getSessionEnvDir(sessionId);
  try {
    const files = fs.readdirSync(dir);
    const hookFiles = files
      .filter((f) => HOOK_ENV_REGEX.test(f))
      .sort(sortHookEnvFiles);

    for (const file of hookFiles) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content) {
          scripts.push(content);
        }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          runLogger.debug(`Failed to read hook env file ${filePath}: ${e}`);
        }
      }
    }

    if (hookFiles.length > 0) {
      runLogger.debug(
        `Session environment loaded from ${hookFiles.length} hook file(s)`,
      );
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      runLogger.debug(`Failed to load session environment from hooks: ${e}`);
    }
  }

  if (scripts.length === 0) {
    sessionEnvScriptCache.set(sessionId, null);
    return null;
  }

  const script = scripts.join('\n') + '\n';
  sessionEnvScriptCache.set(sessionId, script);
  return script;
}

/**
 * 让下一次 `getSessionEnvScript` 重新读盘。传入 sessionId 只失效该会话；
 * 省略时清空全部——多会话进程里调用方几乎总是知道自己属于哪个会话，
 * 不传就等于把别的会话的缓存一起丢掉。
 */
export function invalidateSessionEnvCache(sessionId?: string): void {
  if (sessionId === undefined) {
    runLogger.debug('Invalidating session environment cache for all sessions');
    sessionEnvScriptCache.clear();
    return;
  }
  runLogger.debug(`Invalidating session environment cache: ${sessionId}`);
  sessionEnvScriptCache.delete(sessionId);
}

export function clearCwdEnvFiles(sessionId: string): void {
  try {
    const dir = getSessionEnvDir(sessionId);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const f of files) {
      if (CWD_ENV_REGEX.test(f)) {
        try {
          fs.writeFileSync(path.join(dir, f), '');
        } catch {
          // ignore — best effort
        }
      }
    }
    invalidateSessionEnvCache(sessionId);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      runLogger.debug(`Failed to clear cwd env files: ${e}`);
    }
  }
}

export function cleanupSessionEnvDir(sessionId: string): void {
  // 缓存条目必须随目录一起走：Map 按 sessionId 累积，长命进程（daemon）里
  // 只增不减就是内存泄漏。
  sessionEnvScriptCache.delete(sessionId);
  try {
    const dir = getSessionEnvDir(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore — best effort
  }
}

export function cleanupOldSessionEnvDirs(
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): boolean {
  let succeeded = true;
  try {
    const baseDir = path.join(getConfigHomeDir(), SESSION_ENV_DIR);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (error) {
      return isNodeError(error) && error.code === 'ENOENT';
    }

    const cutoff = Date.now() - maxAgeMs;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(baseDir, entry.name);
      try {
        const stats = fs.statSync(dirPath);
        if (stats.mtimeMs < cutoff) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      } catch {
        succeeded = false;
      }
    }

    // Try to remove the base dir if empty
    try {
      fs.rmdirSync(baseDir);
    } catch {
      // ignore — not empty or other error
    }
    return succeeded;
  } catch {
    return false;
  }
}

function sortHookEnvFiles(a: string, b: string): number {
  const aMatch = a.match(HOOK_ENV_REGEX);
  const bMatch = b.match(HOOK_ENV_REGEX);
  const aType = aMatch?.[1] ?? '';
  const bType = bMatch?.[1] ?? '';
  if (aType !== bType) {
    return (
      (HOOK_ENV_PRIORITY[aType] ?? 99) - (HOOK_ENV_PRIORITY[bType] ?? 99)
    );
  }
  const aIndex = parseInt(aMatch?.[2] ?? '0', 10);
  const bIndex = parseInt(bMatch?.[2] ?? '0', 10);
  return aIndex - bIndex;
}
