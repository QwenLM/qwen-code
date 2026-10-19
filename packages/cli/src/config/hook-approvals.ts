/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { atomicWriteFile } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';
import stripJsonComments from 'strip-json-comments';
import { normalizeProjectRoot } from './mcpApprovals.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

export const HOOK_APPROVALS_FILENAME = 'hookApprovals.json';

export type HookApprovalStatus = 'approved' | 'rejected';
export type HookApprovalState = HookApprovalStatus | 'pending';

/**
 * The user's persisted decision for the `hooks` block of a workspace
 * `.qwen/settings.json`. Like an MCP approval it is bound to the hash of the
 * exact configuration reviewed: any edit returns the block to `pending`.
 */
export interface HookApprovalRecord {
  hash: string;
  status: HookApprovalStatus;
}

/** `{ [projectRoot]: record }` — user-local, one decision per project. */
export type HookApprovalsConfig = Record<string, HookApprovalRecord>;

export function getHookApprovalsPath(): string {
  if (process.env['QWEN_CODE_HOOK_APPROVALS_PATH']) {
    return process.env['QWEN_CODE_HOOK_APPROVALS_PATH'];
  }
  return path.join(Storage.getGlobalQwenDir(), HOOK_APPROVALS_FILENAME);
}

/** Sorted-key canonical hash so key order in the file does not matter. */
export function hashProjectHooks(hooks: Record<string, unknown>): string {
  const stable = JSON.stringify(hooks, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k];
      }
      return sorted;
    }
    return value;
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class LoadedHookApprovals {
  constructor(
    readonly file: { path: string; config: HookApprovalsConfig },
    readonly errors: Array<{ message: string; path: string }>,
  ) {}

  getState(
    projectRoot: string,
    hooks: Record<string, unknown>,
  ): HookApprovalState {
    const record = this.file.config[normalizeProjectRoot(projectRoot)];
    if (!isRecord(record) || record.hash !== hashProjectHooks(hooks)) {
      return 'pending';
    }
    return record.status;
  }

  async setState(
    projectRoot: string,
    hooks: Record<string, unknown>,
    status: HookApprovalStatus,
  ): Promise<void> {
    Object.defineProperty(this.file.config, normalizeProjectRoot(projectRoot), {
      value: { hash: hashProjectHooks(hooks), status },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    await saveHookApprovals(this.file);
  }
}

let loadedHookApprovals: LoadedHookApprovals | undefined;

/** FOR TESTING ONLY. Resets the in-memory cache. */
export function resetHookApprovalsForTesting(): void {
  loadedHookApprovals = undefined;
}

export function loadHookApprovals(): LoadedHookApprovals {
  if (loadedHookApprovals) {
    return loadedHookApprovals;
  }
  const errors: Array<{ message: string; path: string }> = [];
  let config: HookApprovalsConfig = Object.create(null);
  const filePath = getHookApprovalsPath();
  try {
    if (fs.existsSync(filePath)) {
      const parsed: unknown = JSON.parse(
        stripJsonComments(fs.readFileSync(filePath, 'utf-8')),
      );
      if (isRecord(parsed)) {
        config = Object.assign(Object.create(null), parsed);
      } else {
        errors.push({
          message: 'Hook approvals file is not a valid JSON object.',
          path: filePath,
        });
      }
    }
  } catch (error: unknown) {
    errors.push({ message: getErrorMessage(error), path: filePath });
  }
  loadedHookApprovals = new LoadedHookApprovals(
    { path: filePath, config },
    errors,
  );
  for (const error of errors) {
    writeStderrLine(`Warning: hook approvals file error: ${error.message}`);
  }
  return loadedHookApprovals;
}

async function saveHookApprovals(file: {
  path: string;
  config: HookApprovalsConfig;
}): Promise<void> {
  try {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    await atomicWriteFile(file.path, JSON.stringify(file.config, null, 2), {
      mode: 0o600,
    });
  } catch (error) {
    writeStderrLine('Error saving hook approvals file.');
    writeStderrLine(getErrorMessage(error));
  }
}

function hasHooks(hooks: Record<string, unknown> | undefined): boolean {
  return hooks !== undefined && Object.keys(hooks).length > 0;
}

/**
 * Live approval state of a workspace's project hooks, or `undefined` when the
 * workspace declares none. A repository can ship arbitrary commands in its
 * `.qwen/settings.json` hooks, so — like a project MCP server — they run only
 * after the user has approved this exact configuration.
 */
export function getProjectHooksApprovalState(
  projectHooks: Record<string, unknown> | undefined,
  projectRoot: string,
): HookApprovalState | undefined {
  if (!hasHooks(projectHooks)) {
    return undefined;
  }
  return loadHookApprovals().getState(projectRoot, projectHooks!);
}

/** True while project hooks must not load: no decision yet, or rejected. */
export function isProjectHooksPendingApproval(
  projectHooks: Record<string, unknown> | undefined,
  projectRoot: string,
): boolean {
  const state = getProjectHooksApprovalState(projectHooks, projectRoot);
  return state !== undefined && state !== 'approved';
}
