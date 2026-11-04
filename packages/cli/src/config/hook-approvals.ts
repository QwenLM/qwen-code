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
import { readProjectEnvFiles } from './environment.js';
import type { Settings } from './settingsSchema.js';
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
 * exact configuration reviewed, and of the env sources the workspace controls:
 * any change to either returns the block to `pending`.
 */
export interface HookApprovalRecord {
  hash: string;
  status: HookApprovalStatus;
}

/** `{ [projectRoot]: record }` — user-local, one decision per project. */
export type HookApprovalsConfig = Record<string, HookApprovalRecord>;

/** What one approval decision covers. */
export interface ProjectHooksApproval {
  /** The project whose `.qwen/settings.json` the hooks come from. */
  root: string;
  /**
   * The block before `${VAR}` resolution: startup and `/hooks` resolve
   * against different environments, so only this text hashes the same.
   */
  hooks: Record<string, unknown>;
  /** The resolved block: what the registry runs, so what the gate counts. */
  resolved: Record<string, unknown>;
  /**
   * The env the workspace supplies: its `.env` files and `settings.env`. A
   * hook, or a script it starts, can read any of it, so a change there can
   * change what runs without touching the block.
   */
  env: { files: Record<string, unknown>; settings: unknown };
}

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

/** The workspace hooks the gate covers, or `undefined` when none would run. */
export function getProjectHooksForApproval(settings: {
  merged: Settings;
  getProjectHooks(): Record<string, unknown> | undefined;
  workspace: {
    path: string;
    originalSettings: { hooks?: unknown; env?: unknown };
  };
}): ProjectHooksApproval | undefined {
  // Already withheld in an untrusted folder.
  const resolved = settings.getProjectHooks();
  if (!isRecord(resolved) || summarizeProjectHooks(resolved).length === 0) {
    return undefined;
  }
  const hooks = settings.workspace.originalSettings.hooks;
  if (!isRecord(hooks)) return undefined;
  const root = getProjectHooksRoot(settings);
  return {
    root,
    hooks,
    resolved,
    env: {
      files: readProjectEnvFiles(settings.merged, root),
      settings: settings.workspace.originalSettings.env ?? null,
    },
  };
}

/** The separated hook scopes `loadCliConfig` takes, with the block it gates. */
export function getSeparatedHookSettings(
  settings: Parameters<typeof getProjectHooksForApproval>[0] & {
    getSystemHooks(): Record<string, unknown> | undefined;
    getUserHooks(): Record<string, unknown> | undefined;
  },
) {
  // A copy: the hook registry tags loaded definitions in place, and an ACP
  // daemon reuses one settings instance.
  const projectHooks = structuredClone(settings.getProjectHooks());
  const projectHooksApproval = getProjectHooksForApproval(settings);
  return {
    systemHooks: settings.getSystemHooks(),
    userHooks: settings.getUserHooks(),
    projectHooks,
    // Display-only: when the settings layer withheld the workspace scope,
    // the listing still shows the raw block as disabled (untrusted). This
    // never feeds execution — getProjectHooks() reads projectHooks only.
    projectHooksDisplayOnly: structuredClone(
      settings.workspace?.originalSettings?.hooks as
        | Record<string, unknown>
        | undefined,
    ),
    ...(projectHooksApproval ? { projectHooksApproval } : {}),
  };
}

/**
 * Sorted-key canonical hash so key order in the file does not matter. Null
 * prototypes keep an own `__proto__` key in the hashed output.
 */
export function hashProjectHooks(
  approval: Pick<ProjectHooksApproval, 'hooks' | 'env'>,
): string {
  const stable = JSON.stringify(
    { hooks: approval.hooks, env: approval.env },
    (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = Object.create(null);
        for (const k of Object.keys(obj).sort()) {
          sorted[k] = obj[k];
        }
        return sorted;
      }
      return value;
    },
  );
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

/**
 * `hook` is the resolved entry, which decides what runs; the text shown is
 * `raw`'s, as written, so resolved env values never reach the screen.
 */
function describeHook(
  hook: Record<string, unknown>,
  raw: Record<string, unknown>,
  matcher: unknown,
): string {
  const details: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) details.push(`${label}: ${value}`);
  };
  let head: string;
  switch (hook['type']) {
    case 'command':
      head = displayText(raw['command']);
      // The approval hash binds the project env, but the row shows the
      // unresolved text; say so when a variable decides what actually runs.
      if (
        typeof raw['command'] === 'string' &&
        /\$\{?\w/.test(raw['command'])
      ) {
        details.push(
          'resolves ${VAR} from the environment (project .env/settings.env or shell)',
        );
      }
      add('env', envList(raw['env']));
      if (raw['shell']) add('shell', displayText(raw['shell']));
      if (hook['async'] === true) details.push('async');
      break;
    case 'http':
      head = `http ${displayText(raw['url'])}`;
      add('headers', keyList(raw['headers']));
      add('allowedEnvVars', keyList(raw['allowedEnvVars']));
      break;
    default:
      head = `prompt "${displayText(raw['prompt'])}"`;
      if (raw['model']) add('model', displayText(raw['model'], 80));
  }
  if (raw['type'] !== hook['type']) add('type', displayText(raw['type']));
  // Last, so a long matcher cannot push what runs off the row.
  if (matcher) add('matcher', displayText(matcher, 80));
  return details.length > 0 ? `${head} [${details.join('; ')}]` : head;
}

const HOOK_EVENTS = new Set<string>(Object.values(HookEventName));
// `function` hooks are absent: JSON settings cannot carry their callback.
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

function entry(value: unknown, key: string | number): unknown {
  if (Array.isArray(value) && typeof key === 'number') return value[key];
  return isRecord(value) ? value[key] : undefined;
}

/**
 * One display line per hook the registry would run in `resolved`, worded
 * from the matching entry of `raw` (the unresolved block) where it has one.
 * A block with no such line declares nothing executable and is not gated.
 */
export function summarizeProjectHooks(
  resolved: Record<string, unknown>,
  raw: Record<string, unknown> = resolved,
): string[] {
  const lines: string[] = [];
  for (const [event, definitions] of Object.entries(resolved)) {
    if (!HOOK_EVENTS.has(event) || !Array.isArray(definitions)) continue;
    definitions.forEach((definition, i) => {
      if (!isRecord(definition) || !Array.isArray(definition['hooks'])) return;
      const rawDefinition = entry(entry(raw, event), i);
      definition['hooks'].forEach((hook, j) => {
        if (!isRunnableHook(hook)) return;
        const rawHook = entry(entry(rawDefinition, 'hooks'), j);
        const rawMatcher = entry(rawDefinition, 'matcher');
        lines.push(
          `${displayText(event, 24)}  ${describeHook(
            hook,
            isRecord(rawHook) ? rawHook : hook,
            rawMatcher ?? definition['matcher'],
          )}`,
        );
      });
    });
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

  getState(approval: ProjectHooksApproval): HookApprovalState {
    const record: unknown =
      this.file.config[normalizeProjectRoot(approval.root)];
    if (!isRecord(record) || record['hash'] !== hashProjectHooks(approval)) {
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
    approval: ProjectHooksApproval,
    status: HookApprovalStatus,
  ): Promise<void> {
    const { config, errors } = readHookApprovals(this.file.path);
    if (errors.length > 0) {
      throw new Error(`${errors[0].message} (${this.file.path})`);
    }
    Object.defineProperty(config, normalizeProjectRoot(approval.root), {
      value: { hash: hashProjectHooks(approval), status },
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
  approval: ProjectHooksApproval | undefined,
): HookApprovalState | undefined {
  return approval ? loadHookApprovals().getState(approval) : undefined;
}

/** Sets the session's gate from the stored decision and returns it. */
export function applyProjectHooksApproval(
  config: {
    setProjectHooksPendingApproval(pending: boolean, rejected?: boolean): void;
  },
  approval: ProjectHooksApproval | undefined,
): HookApprovalState | undefined {
  const state = getProjectHooksApprovalState(approval);
  config.setProjectHooksPendingApproval(
    state !== undefined && state !== 'approved',
    state === 'rejected',
  );
  return state;
}

/** The stderr line a headless run prints for withheld project hooks. */
export function getProjectHooksHeadlessWarning(
  state: HookApprovalState | undefined,
): string {
  return state === 'rejected'
    ? `Project hooks in .qwen/settings.json were not loaded: they were rejected for this folder and are not asked about again until they change (decisions are kept in ${getHookApprovalsPath()}).`
    : 'Project hooks in .qwen/settings.json were not loaded: they are not approved for this folder. Run qwen interactively here to review them.';
}
