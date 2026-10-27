/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { atomicWriteFile } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';
import stripJsonComments from 'strip-json-comments';
import { normalizeProjectRoot } from './approval-project-root.js';
import {
  clipToWidth,
  cpLen,
  cpSlice,
  getCachedStringWidth,
  sanitizeTerminalLine,
} from '../ui/utils/textUtils.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

export const HOOK_APPROVALS_FILENAME = 'hookApprovals.json';

export type HookApprovalStatus = 'approved' | 'rejected';
export type HookApprovalState = HookApprovalStatus | 'pending';

/**
 * The user's persisted decision for the `hooks` block of a workspace
 * `.qwen/settings.json`. Like an MCP approval it is bound to the hash of the
 * exact configuration reviewed, and of the environment values it references:
 * any change to either returns the block to `pending`.
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

/**
 * The workspace hooks block as written in `.qwen/settings.json`, before
 * `${VAR}` resolution: startup and `/hooks` resolve against different
 * environments, so only the unresolved text hashes the same on both.
 */
export function getProjectHooksForApproval(settings: {
  getProjectHooks(): Record<string, unknown> | undefined;
  workspace: { originalSettings: { hooks?: unknown } };
}): Record<string, unknown> | undefined {
  // Resolution keeps the structure, so the resolved block (already withheld
  // in an untrusted folder) decides whether there is anything to gate.
  const resolved = settings.getProjectHooks();
  if (!isRecord(resolved) || summarizeProjectHooks(resolved).length === 0) {
    return undefined;
  }
  const hooks = settings.workspace.originalSettings.hooks;
  return isRecord(hooks) ? hooks : undefined;
}

/** The separated hook scopes `loadCliConfig` takes, with the block it gates. */
export function getSeparatedHookSettings(settings: {
  getSystemHooks(): Record<string, unknown> | undefined;
  getUserHooks(): Record<string, unknown> | undefined;
  getProjectHooks(): Record<string, unknown> | undefined;
  workspace: { path: string; originalSettings: { hooks?: unknown } };
}) {
  // A copy: the hook registry tags loaded definitions in place, and an ACP
  // daemon reuses one settings instance.
  const projectHooks = structuredClone(settings.getProjectHooks());
  const gated = getProjectHooksForApproval(settings);
  return {
    systemHooks: settings.getSystemHooks(),
    userHooks: settings.getUserHooks(),
    projectHooks,
    ...(gated
      ? {
          projectHooksApproval: {
            root: getProjectHooksRoot(settings),
            hooks: gated,
          },
        }
      : {}),
  };
}

// Set by the hook runner itself, so their launch-time values are not what runs.
const RUNNER_ENV = new Set([
  'ARGUMENTS',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_PROJECT_DIR',
  'QWEN_PROJECT_DIR',
  'QWEN_CODE_CLI',
  'QWEN_CODE_MODEL',
  'QWEN_CODE_PROJECT_DIR',
  'QWEN_CODE_SESSION_ID',
]);

function collectEnvRefs(value: unknown, names: Set<string>, own: Set<string>) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!RUNNER_ENV.has(m[1]) && !own.has(m[1])) names.add(m[1]);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectEnvRefs(v, names, own);
  } else if (isRecord(value)) {
    // A hook's own `env` is part of the block, so it is hashed already.
    const scoped = isRecord(value['env'])
      ? new Set([...own, ...Object.keys(value['env'])])
      : own;
    for (const v of Object.values(value)) collectEnvRefs(v, names, scoped);
  }
}

/**
 * `$VAR`/`${VAR}` values the block reads from the environment (the project
 * `.env` included): they change what runs without changing the file.
 */
function referencedEnv(value: unknown): Array<[string, string | null]> {
  const names = new Set<string>();
  collectEnvRefs(value, names, new Set());
  return [...names].sort().map((n) => [n, process.env[n] ?? null]);
}

/**
 * Sorted-key canonical hash so key order in the file does not matter. Null
 * prototypes keep an own `__proto__` key in the hashed output.
 */
export function hashProjectHooks(hooks: Record<string, unknown>): string {
  const env = referencedEnv(hooks);
  const input = env.length > 0 ? { hooks, env } : hooks;
  const stable = JSON.stringify(input, (_key, value) => {
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
  const length = cpLen(text);
  return length > max
    ? `${cpSlice(text, 0, max)}… [${length} chars, full value in .qwen/settings.json]`
    : text;
}

/** `KEY=value` pairs: a command's env can rewrite what runs (`NODE_OPTIONS`, `${VAR}`). */
function envList(value: unknown): string | undefined {
  if (!isRecord(value)) return keyList(value);
  return Object.entries(value)
    .map(([k, v]) => `${displayText(k)}=${displayText(v, 80)}`)
    .join(', ');
}

function keyList(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map((v) => displayText(v)).join(', ');
  if (isRecord(value))
    return Object.keys(value)
      .map((k) => displayText(k))
      .join(', ');
  return undefined;
}

function describeHook(hook: Record<string, unknown>, matcher: unknown): string {
  const details: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) details.push(`${label}: ${value}`);
  };
  let head: string;
  switch (hook['type']) {
    case 'command':
      head = displayText(hook['command']);
      add('env', envList(hook['env']));
      if (hook['shell']) add('shell', displayText(hook['shell']));
      if (hook['async'] === true) details.push('async');
      // What the shell will substitute, so the effective command is visible.
      add(
        'vars',
        referencedEnv(hook)
          .map(
            ([k, v]) => `${k}=${v === null ? '(unset)' : displayText(v, 80)}`,
          )
          .join(', '),
      );
      break;
    case 'http':
      head = `http ${displayText(hook['url'])}`;
      add('headers', keyList(hook['headers']));
      add('allowedEnvVars', keyList(hook['allowedEnvVars']));
      break;
    case 'prompt':
      head = `prompt "${displayText(hook['prompt'])}"`;
      if (hook['model']) add('model', displayText(hook['model'], 80));
      break;
    default:
      head = displayText(hook['type'] ?? 'unknown');
  }
  // Last, so a long matcher cannot push what runs off the row.
  if (matcher) add('matcher', displayText(matcher, 80));
  return details.length > 0 ? `${head} [${details.join('; ')}]` : head;
}

const HOOK_EVENTS = new Set<string>(Object.values(HookEventName));
const REQUIRED_FIELD: Record<string, string> = {
  command: 'command',
  http: 'url',
  prompt: 'prompt',
};

/** Mirrors the registry's checks: anything it would skip never runs. */
function isRunnableHook(hook: unknown): hook is Record<string, unknown> {
  if (!isRecord(hook) || typeof hook['type'] !== 'string') return false;
  const field = REQUIRED_FIELD[hook['type']];
  return field !== undefined && Boolean(hook[field]);
}

/**
 * One display line per hook the registry would run. A block with no such
 * line declares nothing executable and is not gated.
 */
export function summarizeProjectHooks(
  hooks: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  for (const [event, definitions] of Object.entries(hooks)) {
    if (!HOOK_EVENTS.has(event) || !Array.isArray(definitions)) continue;
    for (const definition of definitions) {
      if (!isRecord(definition) || !Array.isArray(definition['hooks'])) {
        continue;
      }
      for (const hook of definition['hooks']) {
        if (isRunnableHook(hook)) {
          lines.push(
            `${displayText(event, 24)}  ${describeHook(hook, definition['matcher'])}`,
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

/** `line` cut to `width` columns with a marker, so a clipped row never looks whole. */
export function fitHookLine(line: string, width: number): string {
  if (getCachedStringWidth(line) <= width) return line;
  const total = cpLen(line);
  const marker = `… [+${total} chars]`;
  const kept = clipToWidth(line, width - getCachedStringWidth(marker));
  return `${kept}… [+${total - cpLen(kept)} chars]`;
}

export class LoadedHookApprovals {
  constructor(
    readonly file: { readonly path: string; config: HookApprovalsConfig },
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

  /**
   * Re-reads the file and replaces only this project's record, so decisions
   * another process wrote meanwhile survive. Throws when the file cannot be
   * read or written rather than overwrite it or report a decision unsaved.
   */
  async setState(
    projectRoot: string,
    hooks: Record<string, unknown>,
    status: HookApprovalStatus,
  ): Promise<void> {
    const { config, errors } = readHookApprovals(this.file.path);
    if (errors.length > 0) {
      throw new Error(`${errors[0].message} (${this.file.path})`);
    }
    Object.defineProperty(config, normalizeProjectRoot(projectRoot), {
      value: { hash: hashProjectHooks(hooks), status },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    fs.mkdirSync(path.dirname(this.file.path), { recursive: true });
    await atomicWriteFile(this.file.path, JSON.stringify(config, null, 2), {
      mode: 0o600,
      forceMode: true,
    });
    this.file.config = config;
  }
}

const warnedErrors = new Set<string>();

/** FOR TESTING ONLY. Forgets which file errors were already reported. */
export function resetHookApprovalsForTesting(): void {
  warnedErrors.clear();
}

function readHookApprovals(filePath: string): {
  config: HookApprovalsConfig;
  errors: Array<{ message: string; path: string }>;
} {
  const errors: Array<{ message: string; path: string }> = [];
  let config: HookApprovalsConfig = Object.create(null);
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
  return { config, errors };
}

/**
 * Read fresh on every call: the file is small, and a long-lived process (an
 * ACP daemon) must see decisions made in another session.
 */
export function loadHookApprovals(): LoadedHookApprovals {
  const filePath = getHookApprovalsPath();
  const { config, errors } = readHookApprovals(filePath);
  for (const error of errors) {
    if (warnedErrors.has(error.message)) continue;
    warnedErrors.add(error.message);
    writeStderrLine(`Warning: hook approvals file error: ${error.message}`);
  }
  return new LoadedHookApprovals({ path: filePath, config }, errors);
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
