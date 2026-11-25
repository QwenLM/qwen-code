/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  runLogger,
  sanitizePath,
  setCwd,
  setOriginalCwd,
  setShellCwd,
  Storage,
} from '@qwen-code/core';

export const ENV_WORKER_CWD = 'WORKER_CWD';

/**
 * workerData 中携带启动信息的命名空间键；宿主入口负责把各自的 workerData
 * 翻译成这个形状。
 */
export const WORKER_DATA_KEY = 'workerRuntime';

type UnknownRecord = Record<string, unknown>;

export interface WorkerCwdShimOptions {
  cwd?: string;
  workerData?: unknown;
  env?: NodeJS.ProcessEnv;
  processRef?: NodeJS.Process;
  configHomeDir?: string;
}

export interface InstalledWorkerCwdShim {
  initialCwd: string;
  getCwd: () => string;
  restore: () => void;
}

interface WorkerTranscriptProjectBridgeResult {
  logicalProjectDir: string;
  realProjectDir: string;
  copied: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getWorkerDataCwd(workerData: unknown): string | undefined {
  if (!isRecord(workerData)) {
    return undefined;
  }
  const runtime = workerData[WORKER_DATA_KEY];
  if (!isRecord(runtime)) {
    return undefined;
  }
  const cwd = runtime['cwd'];
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

export function resolveWorkerRuntimeCwd(
  options: WorkerCwdShimOptions = {},
): string {
  const processRef = options.processRef ?? process;
  const env = options.env ?? processRef.env;
  const cwd =
    options.cwd ??
    getWorkerDataCwd(options.workerData) ??
    env[ENV_WORKER_CWD] ??
    processRef.cwd();

  return path.resolve(cwd);
}

function resolveExistingDirectory(cwd: string): string {
  const resolved = path.resolve(cwd);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    const error = new Error(`ENOTDIR: not a directory, chdir '${resolved}'`);
    (error as NodeJS.ErrnoException).code = 'ENOTDIR';
    throw error;
  }
  // Keep the caller-provided logical path because transcript project buckets are keyed by cwd.
  return resolved.normalize('NFC');
}

function isSamePathIdentity(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).normalize('NFC');
  const normalizedRight = path.resolve(right).normalize('NFC');
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function getTranscriptProjectDir(
  projectRoot: string,
  configHomeDir: string,
): string {
  return path.join(configHomeDir, 'projects', sanitizePath(projectRoot));
}

function copyMissingPath(source: string, target: string): boolean {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    if (fs.existsSync(target) && !fs.lstatSync(target).isDirectory()) {
      return false;
    }
    fs.mkdirSync(target, { recursive: true });
    let copied = false;
    for (const entry of fs.readdirSync(source)) {
      copied =
        copyMissingPath(path.join(source, entry), path.join(target, entry)) ||
        copied;
    }
    return copied;
  }

  if (fs.existsSync(target)) {
    // The logical cwd bucket is authoritative after the shim starts; keep files already written there.
    return false;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), target);
    return true;
  }

  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  return true;
}

function printWorkerRuntimeLog(message: string): void {
  runLogger.log(`[worker-runtime] ${message}`);
}

function bridgeWorkerTranscriptProject(
  logicalCwd: string,
  configHomeDir = Storage.getGlobalConfigDir(),
): WorkerTranscriptProjectBridgeResult | null {
  // SDK WorkerTransport sessions created before this shim preserved logical cwd could have
  // written transcript data under the realpath bucket. Copy missing files back into the logical
  // bucket so normal resume logic keeps using the logical cwd.
  let realCwd: string;
  try {
    realCwd = fs.realpathSync(logicalCwd).normalize('NFC');
  } catch (error) {
    printWorkerRuntimeLog(
      `failed to resolve worker cwd realpath logical_root=${logicalCwd}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }

  if (isSamePathIdentity(logicalCwd, realCwd)) {
    return null;
  }

  const logicalProjectDir = getTranscriptProjectDir(logicalCwd, configHomeDir);
  const realProjectDir = getTranscriptProjectDir(realCwd, configHomeDir);
  printWorkerRuntimeLog(
    `detected worker cwd realpath mismatch logical_root=${logicalCwd} real_root=${realCwd} logical_project_dir=${logicalProjectDir} real_project_dir=${realProjectDir}`,
  );
  if (!fs.existsSync(realProjectDir)) {
    printWorkerRuntimeLog(
      `no realpath transcript project bucket found logical_root=${logicalCwd} real_root=${realCwd} real_project_dir=${realProjectDir}`,
    );
    return {
      logicalProjectDir,
      realProjectDir,
      copied: false,
    };
  }

  let copied = false;
  try {
    copied = copyMissingPath(realProjectDir, logicalProjectDir);
    if (copied) {
      printWorkerRuntimeLog(
        `copied missing transcript project data from real cwd bucket to logical cwd bucket logical_root=${logicalCwd} real_root=${realCwd} logical_project_dir=${logicalProjectDir} real_project_dir=${realProjectDir}`,
      );
    } else {
      printWorkerRuntimeLog(
        `realpath transcript project bucket already reconciled logical_root=${logicalCwd} real_root=${realCwd} logical_project_dir=${logicalProjectDir} real_project_dir=${realProjectDir}`,
      );
    }
  } catch (error) {
    printWorkerRuntimeLog(
      `failed to copy transcript project data from real cwd bucket to logical cwd bucket logical_root=${logicalCwd} real_root=${realCwd} logical_project_dir=${logicalProjectDir} real_project_dir=${realProjectDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    logicalProjectDir,
    realProjectDir,
    copied,
  };
}

function defineProcessMethod(
  processRef: NodeJS.Process,
  name: 'cwd' | 'chdir',
  value: () => string,
): void;
function defineProcessMethod(
  processRef: NodeJS.Process,
  name: 'cwd' | 'chdir',
  value: (directory: string) => void,
): void;
function defineProcessMethod(
  processRef: NodeJS.Process,
  name: 'cwd' | 'chdir',
  value: (() => string) | ((directory: string) => void),
): void {
  const descriptor = Object.getOwnPropertyDescriptor(processRef, name);
  Object.defineProperty(processRef, name, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value,
  });
}

export function installWorkerCwdShim(
  options: WorkerCwdShimOptions = {},
): InstalledWorkerCwdShim {
  const processRef = options.processRef ?? process;
  const originalCwdDescriptor = Object.getOwnPropertyDescriptor(
    processRef,
    'cwd',
  );
  const originalChdirDescriptor = Object.getOwnPropertyDescriptor(
    processRef,
    'chdir',
  );
  const originalPwd = processRef.env['PWD'];
  const restoreCwd = processRef.cwd();
  let currentCwd = resolveExistingDirectory(resolveWorkerRuntimeCwd(options));
  printWorkerRuntimeLog(
    `installed worker cwd shim initial_cwd=${currentCwd} restore_cwd=${restoreCwd}`,
  );
  bridgeWorkerTranscriptProject(currentCwd, options.configHomeDir);

  const syncLogicalCwd = (nextCwd: string) => {
    currentCwd = resolveExistingDirectory(nextCwd);
    setCwd(currentCwd);
    setOriginalCwd(currentCwd);
    setShellCwd(currentCwd);
    processRef.env['PWD'] = currentCwd;
  };

  syncLogicalCwd(currentCwd);

  defineProcessMethod(processRef, 'cwd', () => currentCwd);
  defineProcessMethod(processRef, 'chdir', (directory: string) => {
    if (typeof directory !== 'string') {
      throw new TypeError('The "directory" argument must be of type string.');
    }
    const nextCwd = path.isAbsolute(directory)
      ? directory
      : path.resolve(currentCwd, directory);
    syncLogicalCwd(nextCwd);
  });

  return {
    initialCwd: currentCwd,
    getCwd: () => currentCwd,
    restore: () => {
      if (originalCwdDescriptor) {
        Object.defineProperty(processRef, 'cwd', originalCwdDescriptor);
      }
      if (originalChdirDescriptor) {
        Object.defineProperty(processRef, 'chdir', originalChdirDescriptor);
      }
      if (originalPwd === undefined) {
        delete processRef.env['PWD'];
      } else {
        processRef.env['PWD'] = originalPwd;
      }
      setCwd(restoreCwd);
      setOriginalCwd(restoreCwd);
      setShellCwd(restoreCwd);
    },
  };
}
