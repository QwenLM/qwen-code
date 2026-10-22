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
import { normalizeProjectRoot } from './approval-project-root.js';
import { sanitizeTerminalLine } from '../ui/utils/textUtils.js';
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

/** The project whose `.qwen/settings.json` the loaded workspace hooks come from. */
export function getProjectHooksRoot(settings: {
  workspace: { path: string };
}): string {
  return path.dirname(path.dirname(settings.workspace.path));
}

/** The separated hook scopes `loadCliConfig` takes, with the project root they gate under. */
export function getSeparatedHookSettings(settings: {
  getSystemHooks(): Record<string, unknown> | undefined;
  getUserHooks(): Record<string, unknown> | undefined;
  getProjectHooks(): Record<string, unknown> | undefined;
  workspace: { path: string };
}) {
  // A copy: the hook registry tags loaded definitions in place, and an ACP
  // daemon reuses one settings instance, whose block must keep its hash.
  const projectHooks = structuredClone(settings.getProjectHooks());
  return {
    systemHooks: settings.getSystemHooks(),
    userHooks: settings.getUserHooks(),
    projectHooks,
    // Only a block with something runnable is gated, so only it needs a root.
    ...(isRecord(projectHooks) && summarizeProjectHooks(projectHooks).length > 0
      ? { projectHooksRoot: getProjectHooksRoot(settings) }
      : {}),
  };
}

/**
 * Sorted-key canonical hash so key order in the file does not matter. Null
 * prototypes keep an own `__proto__` key in the hashed output.
 */
export function hashProjectHooks(hooks: Record<string, unknown>): string {
  const stable = JSON.stringify(hooks, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = Object.create(null);
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

/**
 * Repo-controlled text for the dialog: one row, no escapes or format
 * characters, and a cut that says so — the elided tail may be the payload.
 */
function displayText(value: unknown, max = 200): string {
  const text = sanitizeTerminalLine(String(value ?? '')).replace(
    /\p{Cf}/gu,
    '',
  );
  return text.length > max
    ? `${text.slice(0, max)}… [${text.length} chars, full value in .qwen/settings.json]`
    : text;
}

function keyList(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map((v) => displayText(v)).join(', ');
  if (isRecord(value))
    return Object.keys(value)
      .map((k) => displayText(k))
      .join(', ');
  return undefined;
}

function describeHook(hook: Record<string, unknown>): string {
  const details: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) details.push(`${label}: ${value}`);
  };
  let head: string;
  switch (hook['type']) {
    case 'command':
      head = displayText(hook['command']);
      add('env', keyList(hook['env']));
      if (hook['shell']) add('shell', displayText(hook['shell']));
      if (hook['async'] === true) details.push('async');
      break;
    case 'http':
      head = `http ${displayText(hook['url'])}`;
      add('headers', keyList(hook['headers']));
      add('allowedEnvVars', keyList(hook['allowedEnvVars']));
      break;
    case 'prompt':
      head = `prompt "${displayText(hook['prompt'])}"`;
      break;
    default:
      head = displayText(hook['type'] ?? 'unknown');
  }
  return details.length > 0 ? `${head} [${details.join('; ')}]` : head;
}

/**
 * One display line per hook the registry could run. A block with no such
 * line declares nothing executable and is not gated.
 */
export function summarizeProjectHooks(
  hooks: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  for (const [event, definitions] of Object.entries(hooks)) {
    if (!Array.isArray(definitions)) continue;
    for (const definition of definitions) {
      if (!isRecord(definition) || !Array.isArray(definition['hooks'])) {
        continue;
      }
      const matcher = definition['matcher']
        ? `[${displayText(definition['matcher'], 80)}]`
        : '';
      for (const hook of definition['hooks']) {
        if (isRecord(hook)) {
          lines.push(
            `${displayText(event, 40)}${matcher}  ${describeHook(hook)}`,
          );
        }
      }
    }
  }
  return lines;
}

/**
 * The hook lines that fit in `maxRows`, the last row naming how many were
 * left out, so the options below the list always stay on screen.
 */
export function fitHookLines(
  lines: readonly string[],
  maxRows: number,
): readonly string[] {
  const rows = Math.max(1, Math.floor(maxRows));
  if (lines.length <= rows) return lines;
  const shown = Math.max(0, rows - 1);
  return [
    ...lines.slice(0, shown),
    `… and ${lines.length - shown} more (see .qwen/settings.json)`,
  ];
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
    const record: unknown = this.file.config[normalizeProjectRoot(projectRoot)];
    if (!isRecord(record) || record['hash'] !== hashProjectHooks(hooks)) {
      return 'pending';
    }
    const status = record['status'];
    return status === 'approved' || status === 'rejected' ? status : 'pending';
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

/** Drops the cache so the next read sees edits made to the file by hand. */
export function reloadHookApprovals(): void {
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
      forceMode: true,
    });
  } catch (error) {
    writeStderrLine('Error saving hook approvals file.');
    writeStderrLine(getErrorMessage(error));
  }
}

/**
 * Live approval state of a workspace's project hooks, or `undefined` when the
 * workspace declares nothing runnable. A repository can ship arbitrary
 * commands in its `.qwen/settings.json` hooks, so — like a project MCP
 * server — they run only after the user has approved this exact
 * configuration.
 */
export function getProjectHooksApprovalState(
  projectHooks: unknown,
  projectRoot: string,
): HookApprovalState | undefined {
  if (
    !isRecord(projectHooks) ||
    summarizeProjectHooks(projectHooks).length === 0
  ) {
    return undefined;
  }
  return loadHookApprovals().getState(projectRoot, projectHooks);
}

/** True while project hooks must not load: no decision yet, or rejected. */
export function isProjectHooksPendingApproval(
  projectHooks: unknown,
  projectRoot: string,
): boolean {
  const state = getProjectHooksApprovalState(projectHooks, projectRoot);
  return state !== undefined && state !== 'approved';
}

/** The stderr line a headless run prints for withheld project hooks. */
export function getProjectHooksHeadlessWarning(
  state: HookApprovalState | undefined,
): string {
  return state === 'rejected'
    ? `Project hooks in .qwen/settings.json were not loaded: they were rejected for this folder and are not asked about again until they change (decisions are kept in ${getHookApprovalsPath()}).`
    : 'Project hooks in .qwen/settings.json were not loaded: they are not approved for this folder. Run qwen interactively here to review them.';
}
