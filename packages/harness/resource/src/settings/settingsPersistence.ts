/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'comment-json';
import { lockSync } from 'proper-lockfile';
import {
  publishSettingsFileInvalidation,
  publishSettingsFileWrite,
} from './settingsWriteEvents.js';

const LOCK_STALE_MS = 10_000;
const LOCK_UPDATE_MS = 5_000;
const LOCK_WAIT_TIMEOUT_MS = 3_000;
const LOCK_WAIT_MIN_MS = 10;
const LOCK_WAIT_MAX_MS = 100;
const WINDOWS_RENAME_RETRY_MS = 50;
const WINDOWS_RENAME_ATTEMPTS = 4;
const TEMP_FILE_ATTEMPTS = 3;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const activeMutations = new Set<string>();

const IGNORABLE_FSYNC_ERRORS = new Set([
  'EINVAL',
  'ENOTSUP',
  'EPERM',
  'ENOSYS',
]);
const RETRYABLE_WINDOWS_RENAME_ERRORS = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
]);

export type SettingsFileMutation = (
  latest: Record<string | symbol, unknown>,
) => boolean;

export interface SettingsWriteResult {
  changed: boolean;
  originalSettings: Record<string, unknown>;
  rawJson: string;
  /** Identifies the Resource event emitted for this successful write. */
  writeId?: string;
}

export interface SettingsMutationOptions {
  newFileMode?: number;
  onInfrastructureError?: (
    stage: 'lock-compromised' | 'unlock',
    path: string,
    error: unknown,
  ) => void;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function reportInfrastructureFailure(
  stage: 'lock-compromised' | 'unlock',
  logicalPath: string,
  error: unknown,
  options: SettingsMutationOptions,
): void {
  try {
    options.onInfrastructureError?.(stage, logicalPath, error);
  } catch {
    // Diagnostics cannot turn a committed write into a reported failure.
  }
}

function stripBOM(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function toPlainJsonValue<T = unknown>(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): T {
  if (typeof value !== 'object' || value === null) return value as T;
  if (ancestors.has(value))
    throw new TypeError('Settings values must not contain circular references');
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((entry) => toPlainJsonValue(entry, ancestors)) as T;
    if (Object.prototype.toString.call(value) !== '[object Object]')
      throw new TypeError('Settings values must contain only JSON objects');
    return Object.fromEntries(
      Object.getOwnPropertyNames(value).map((key) => [
        key,
        toPlainJsonValue((value as Record<string, unknown>)[key], ancestors),
      ]),
    ) as T;
  } finally {
    ancestors.delete(value);
  }
}

function waitSynchronously(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(WAIT_BUFFER, 0, 0, milliseconds);
}

function randomLockWait(): number {
  return (
    LOCK_WAIT_MIN_MS +
    Math.floor(Math.random() * (LOCK_WAIT_MAX_MS - LOCK_WAIT_MIN_MS + 1))
  );
}

function acquireSettingsLock(
  logicalPath: string,
  options: SettingsMutationOptions,
): () => void {
  const deadline = performance.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      return lockSync(logicalPath, {
        realpath: false,
        retries: 0,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        onCompromised: (error) => {
          reportInfrastructureFailure(
            'lock-compromised',
            logicalPath,
            error,
            options,
          );
        },
      });
    } catch (error) {
      if (errorCode(error) !== 'ELOCKED') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      waitSynchronously(Math.min(randomLockWait(), remaining));
    }
  }
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function resolveWriteTarget(logicalPath: string): string {
  let candidate = logicalPath;
  const visited = new Set<string>();

  for (let depth = 0; depth < 40; depth += 1) {
    const normalized = path.normalize(path.resolve(candidate));
    if (visited.has(normalized)) {
      const error = new Error('Settings symlink cycle detected');
      (error as NodeJS.ErrnoException).code = 'ELOOP';
      throw error;
    }
    visited.add(normalized);

    const metadata = lstatIfExists(normalized);
    if (!metadata?.isSymbolicLink()) return normalized;
    const target = fs.readlinkSync(normalized);
    candidate = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(normalized), target);
  }

  const error = new Error('Settings symlink chain is too deep');
  (error as NodeJS.ErrnoException).code = 'ELOOP';
  throw error;
}

function createTemporaryFile(
  targetPath: string,
  mode: number,
): { descriptor: number; temporaryPath: string } {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  let lastError: unknown;

  for (let attempt = 0; attempt < TEMP_FILE_ATTEMPTS; attempt += 1) {
    const temporaryPath = path.join(
      directory,
      `.${basename}.tmp.${process.pid}.${randomUUID()}`,
    );
    try {
      if (process.platform === 'win32' && lstatIfExists(temporaryPath)) {
        continue;
      }
      return {
        descriptor: fs.openSync(temporaryPath, 'wx', mode),
        temporaryPath,
      };
    } catch (error) {
      lastError = error;
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }

  throw lastError ?? new Error('Unable to allocate a temporary settings file');
}

function flushFile(descriptor: number): void {
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!IGNORABLE_FSYNC_ERRORS.has(errorCode(error) ?? '')) throw error;
  }
}

function renameTemporaryFile(
  temporaryPath: string,
  targetPath: string,
): void {
  const attempts = process.platform === 'win32' ? WINDOWS_RENAME_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(temporaryPath, targetPath);
      return;
    } catch (error) {
      const retryable =
        process.platform === 'win32' &&
        RETRYABLE_WINDOWS_RENAME_ERRORS.has(errorCode(error) ?? '') &&
        attempt + 1 < attempts;
      if (!retryable) throw error;
      waitSynchronously(WINDOWS_RENAME_RETRY_MS);
    }
  }
}

function writeFileAtomicSync(
  logicalPath: string,
  content: string,
  options: SettingsMutationOptions = {},
): void {
  const targetPath = resolveWriteTarget(logicalPath);
  const targetMetadata = lstatIfExists(targetPath);
  if (targetMetadata && !targetMetadata.isFile()) {
    const error = new Error('Settings target is not a regular file');
    (error as NodeJS.ErrnoException).code = 'EINVAL';
    throw error;
  }

  const existingMode =
    targetMetadata === undefined ? undefined : targetMetadata.mode & 0o7777;
  const mode = existingMode ?? options.newFileMode ?? 0o666;
  const { descriptor, temporaryPath } = createTemporaryFile(targetPath, mode);
  let descriptorOpen = true;
  let committed = false;

  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    if (existingMode !== undefined && process.platform !== 'win32') {
      fs.fchmodSync(descriptor, existingMode);
    }
    flushFile(descriptor);
    fs.closeSync(descriptor);
    descriptorOpen = false;
    renameTemporaryFile(temporaryPath, targetPath);
    committed = true;
  } finally {
    if (descriptorOpen) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write error; cleanup continues below.
      }
    }
    if (!committed) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Cleanup is best-effort and cannot replace the persistence error.
      }
    }
  }
}

export function mutateSettingsFile(
  logicalPath: string,
  mutation: SettingsFileMutation,
  options: SettingsMutationOptions = {},
): SettingsWriteResult {
  const normalizedPath = path.normalize(path.resolve(logicalPath));
  if (activeMutations.has(normalizedPath)) {
    const error = new Error('Reentrant settings mutation is not allowed');
    (error as NodeJS.ErrnoException).code = 'ELOCKED';
    throw error;
  }

  fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  activeMutations.add(normalizedPath);
  let release: (() => void) | undefined;
  let sourceUpdated = false;

  try {
    release = acquireSettingsLock(normalizedPath, options);
    const exists = fs.existsSync(normalizedPath);
    const rawJson = exists ? fs.readFileSync(normalizedPath, 'utf8') : '{}\n';
    let parsed: unknown;
    try {
      parsed = parse(stripBOM(rawJson));
    } catch {
      const error = new SyntaxError('Settings file contains invalid JSON.');
      (error as NodeJS.ErrnoException).code = 'EINVAL';
      throw error;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const error = new Error('Settings file must contain a JSON object');
      (error as NodeJS.ErrnoException).code = 'EINVAL';
      throw error;
    }

    const latest = parsed as Record<string | symbol, unknown>;
    const changed = mutation(latest);
    if (!changed) {
      publishSettingsFileWrite(
        normalizedPath,
        exists ? rawJson : undefined,
        false,
      );
      sourceUpdated = true;
      return {
        changed: false,
        originalSettings: toPlainJsonValue(latest),
        rawJson,
      };
    }

    const nextRawJson = stringify(latest, null, 2);
    writeFileAtomicSync(normalizedPath, nextRawJson, options);
    const writeId = randomUUID();
    publishSettingsFileWrite(normalizedPath, nextRawJson, true, writeId);
    sourceUpdated = true;
    return {
      changed: true,
      originalSettings: toPlainJsonValue(latest),
      rawJson: nextRawJson,
      writeId,
    };
  } finally {
    if (!sourceUpdated) publishSettingsFileInvalidation(normalizedPath);
    if (release) {
      try {
        release();
      } catch (error) {
        reportInfrastructureFailure('unlock', normalizedPath, error, options);
      }
    }
    activeMutations.delete(normalizedPath);
  }
}
