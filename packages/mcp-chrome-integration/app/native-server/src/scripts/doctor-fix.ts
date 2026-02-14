/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * doctor-fix.ts
 *
 * Fix attempt utilities for the doctor diagnostic script.
 */

import fs from 'fs';
import path from 'path';
import { BrowserType } from './browser-config';
import {
  ensureExecutionPermissions,
  getLogDir,
  tryRegisterUserLevelHost,
} from './utils';
import { DoctorFixAttempt } from './doctor-types';
import { stringifyError } from './doctor-utils';

/**
 * Attempt to fix common issues.
 */
export async function attemptFixes(
  enabled: boolean,
  silent: boolean,
  distDir: string,
  targetBrowsers: BrowserType[] | undefined,
): Promise<DoctorFixAttempt[]> {
  if (!enabled) return [];

  const fixes: DoctorFixAttempt[] = [];
  const logDir = getLogDir();
  const nodePathFile = path.join(distDir, 'node_path.txt');

  const withMutedConsole = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!silent) return await fn();
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
    }
  };

  const attempt = async (
    id: string,
    description: string,
    action: () => Promise<void> | void,
  ) => {
    try {
      await withMutedConsole(async () => {
        await action();
      });
      fixes.push({ id, description, success: true });
    } catch (e) {
      fixes.push({ id, description, success: false, error: stringifyError(e) });
    }
  };

  await attempt('logs', 'Ensure logs directory exists', async () => {
    fs.mkdirSync(logDir, { recursive: true });
  });

  await attempt(
    'node_path',
    'Write node_path.txt for run_host scripts',
    async () => {
      fs.writeFileSync(nodePathFile, process.execPath, 'utf8');
    },
  );

  await attempt(
    'permissions',
    'Fix execution permissions for native host files',
    async () => {
      await ensureExecutionPermissions();
    },
  );

  await attempt(
    'register',
    'Re-register Native Messaging host (user-level)',
    async () => {
      const ok = await tryRegisterUserLevelHost(targetBrowsers);
      if (!ok) {
        throw new Error('User-level registration failed');
      }
    },
  );

  return fixes;
}
