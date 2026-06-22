/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Saved-workflow resolution. Workflow scripts persisted at
 * `.qwen/workflows/<name>.js` (project) or `~/.qwen/workflows/<name>.js`
 * (user) are both surfaced as slash commands (CLI: `SavedWorkflowLoader`)
 * AND resolvable by name from inside a running workflow via the
 * `workflow('<name>')` global (core: `WorkflowOrchestrator`). This module
 * is the single source of truth for the directory layout, the filename
 * convention, and the read/list logic shared by both consumers.
 *
 * Precedence: when the same `<name>.js` exists in both scopes, the
 * project-level file wins (matches `FileCommandLoader`'s project-over-user
 * precedence for custom commands).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKFLOW_SAVED');

/**
 * Saved-workflow name constraint. Lower-case, digits, hyphens; must start
 * with a letter. The name doubles as the `.js` filename stem AND the slash
 * command name (`deep-research.js` → `/deep-research`), so it must be safe
 * for both a path segment and a command token (no spaces, dots, slashes).
 */
export const WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

export type SavedWorkflowSource = 'project' | 'user';

/** One discovered saved-workflow script (metadata only — no source read). */
export interface SavedWorkflowEntry {
  /** Filename stem, e.g. `deep-research`. Doubles as the slash command name. */
  name: string;
  /** Absolute path to the `.js` file. */
  scriptPath: string;
  /** Which scope the file was found in. */
  source: SavedWorkflowSource;
}

/** A resolved saved workflow with its script source loaded. */
export interface ResolvedSavedWorkflow {
  name: string;
  scriptPath: string;
  script: string;
}

/** Result of a {@link saveWorkflowScript} attempt. */
export type WorkflowSaveResult =
  | { status: 'saved'; name: string; scope: SavedWorkflowSource; path: string }
  | { status: 'exists'; name: string; scope: SavedWorkflowSource; path: string }
  | { status: 'invalid-name'; error: string }
  | { status: 'empty-script'; error: string };

/**
 * Validate a saved-workflow name. Returns an error string when invalid,
 * `null` when OK. Shared by the save dialog (CLI) and any caller that
 * accepts a user-supplied name.
 */
export function validateWorkflowName(name: string): string | null {
  if (!name) return 'Workflow name is required.';
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    return (
      `Invalid workflow name "${name}". Use lower-case letters, digits, and ` +
      `hyphens only (must start with a letter, max 41 chars).`
    );
  }
  return null;
}

/** Both scope directories, project first (higher precedence). */
export function getSavedWorkflowDirs(config: Config): Array<{
  dir: string;
  source: SavedWorkflowSource;
}> {
  return [
    { dir: config.storage.getProjectWorkflowsDir(), source: 'project' },
    { dir: Storage.getUserWorkflowsDir(), source: 'user' },
  ];
}

/**
 * True when a saved-workflow root dir is itself a symlink. `readWorkflowFileSecurely`
 * realpaths the root so it can tolerate symlinked *ancestors* (e.g. a project under
 * macOS `/tmp -> /private/tmp`); but that same laundering turns a checked-in
 * `.qwen/workflows -> /outside` link into the allowed boundary — letting discovery
 * list, `workflow('<name>')` read, and the save dialog write external files. The
 * per-entry symlink check in {@link listJsFiles} can't catch this because the link
 * is the dir, not the files it exposes. So we refuse a symlinked root outright for
 * all three operations. A missing dir (the common case) is not a symlink, so this
 * is transparent until someone actually links the dir.
 */
async function isSymlinkedRoot(dir: string): Promise<boolean> {
  return fs
    .lstat(dir)
    .then((st) => st.isSymbolicLink())
    .catch(() => false);
}

async function listJsFiles(dir: string): Promise<string[]> {
  // Refuse a symlinked root dir: `readdir` would otherwise enumerate the
  // external target's `*.js` files as project workflows, and the per-entry
  // symlink check below can't see it (the link is the dir, not the entries).
  if (await isSymlinkedRoot(dir)) {
    debugLogger.warn(`refusing symlinked saved-workflow dir: ${dir}`);
    return [];
  }
  try {
    const names = await fs.readdir(dir);
    const out: string[] = [];
    for (const n of names) {
      if (!n.endsWith('.js')) continue;
      // Skip symlinks. A malicious repo could ship `<name>.js` as a symlink to
      // an arbitrary file (e.g. `~/.aws/credentials`); discovering and later
      // reading it would leak the target through the snapshot `script` field,
      // sandbox parse-error messages, and telemetry.
      const st = await fs.lstat(path.join(dir, n)).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      out.push(n);
    }
    return out;
  } catch (e) {
    // Missing directory is the common case (user never saved a workflow).
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      debugLogger.warn(`listJsFiles failed for ${dir}: ${e}`);
    }
    return [];
  }
}

/**
 * Read a candidate workflow file, but only after proving its canonical real
 * path stays inside one of the saved-workflow directories. `fs.realpath`
 * resolves both `..` and symlinks, so this single check defeats path
 * traversal (a `name`/`scriptPath` containing `..`) AND symlink escape (a
 * file inside the dir that links out). Throws otherwise.
 */
async function readWorkflowFileSecurely(
  filePath: string,
  config: Config,
): Promise<string> {
  const real = await fs.realpath(filePath); // throws ENOENT if absent
  const dirs = (
    await Promise.all(
      getSavedWorkflowDirs(config).map(async ({ dir }) => {
        // Exclude a symlinked root: realpath(dir) would launder a
        // `.qwen/workflows -> /outside` link into the allowed boundary, so a
        // file resolving under the link's target would pass the check below.
        if (await isSymlinkedRoot(dir)) return null;
        try {
          return await fs.realpath(dir);
        } catch {
          return path.resolve(dir);
        }
      }),
    )
  ).filter((d): d is string => d !== null);
  const inside = dirs.some(
    (d) => real === d || real.startsWith(d + path.sep),
  );
  if (!inside) {
    throw new Error(
      `refusing to load a workflow file outside the saved-workflow directories: '${filePath}'.`,
    );
  }
  return fs.readFile(real, 'utf8');
}

/**
 * Enumerate all saved workflows across both scopes. Project entries shadow
 * same-named user entries (project wins). Sorted by name for stable
 * slash-command ordering.
 */
export async function listSavedWorkflows(
  config: Config,
): Promise<SavedWorkflowEntry[]> {
  const byName = new Map<string, SavedWorkflowEntry>();
  // Iterate user FIRST then project so project entries overwrite (win).
  for (const { dir, source } of [...getSavedWorkflowDirs(config)].reverse()) {
    for (const file of await listJsFiles(dir)) {
      const name = file.slice(0, -'.js'.length);
      // Skip files whose stem isn't a legal workflow/command name — they
      // can't be a slash command and `workflow('<name>')` can't address them.
      if (!WORKFLOW_NAME_PATTERN.test(name)) continue;
      byName.set(name, { name, scriptPath: path.join(dir, file), source });
    }
  }
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Resolve `workflow('<name>')` or `workflow({scriptPath})` to a loaded
 * script. The string form looks up `<name>.js` in project then user scope;
 * the `{scriptPath}` form reads the file at the given path directly.
 *
 * Throws with an actionable, available-names message on a miss — the
 * message text mirrors upstream so scripts written against either runtime
 * see the same error.
 */
export async function resolveSavedWorkflowScript(
  nameOrRef: string | { scriptPath: string },
  config: Config,
): Promise<ResolvedSavedWorkflow> {
  if (typeof nameOrRef === 'object' && nameOrRef !== null) {
    const scriptPath = nameOrRef.scriptPath;
    if (typeof scriptPath !== 'string' || scriptPath.length === 0) {
      throw new Error(
        "workflow() expects a workflow name (string) or {scriptPath: string}.",
      );
    }
    let script: string;
    try {
      script = await readWorkflowFileSecurely(scriptPath, config);
    } catch (e) {
      throw new Error(
        `workflow({scriptPath: '${scriptPath}'}): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const name = path.basename(scriptPath).replace(/\.js$/, '');
    return { name, scriptPath, script };
  }

  if (typeof nameOrRef !== 'string') {
    throw new Error(
      "workflow() expects a workflow name (string) or {scriptPath: string}.",
    );
  }

  const name = nameOrRef;
  // Reject names that aren't legal workflow stems before joining them into a
  // directory path, so `workflow('../../outside')` can't escape the saved-
  // workflow dirs. The realpath boundary check in `readWorkflowFileSecurely`
  // is a second line of defence, but a clear name error is the better signal.
  const nameError = validateWorkflowName(name);
  if (nameError) {
    throw new Error(`workflow('${name}'): ${nameError}`);
  }
  for (const { dir } of getSavedWorkflowDirs(config)) {
    const scriptPath = path.join(dir, `${name}.js`);
    try {
      const script = await readWorkflowFileSecurely(scriptPath, config);
      return { name, scriptPath, script };
    } catch {
      // Not in this scope (absent or rejected) — try the next.
    }
  }

  const available = (await listSavedWorkflows(config)).map((e) => e.name);
  throw new Error(
    `workflow('${name}'): no workflow with that name. Available: ` +
      `${available.length > 0 ? available.join(', ') : '(none)'}.`,
  );
}

/**
 * Save a workflow script to `.qwen/workflows/<name>.js` (project) or
 * `~/.qwen/workflows/<name>.js` (user). Powers the `/workflows` save dialog.
 *
 * Validates the name and refuses to clobber an existing file unless
 * `overwrite` is set (the dialog uses the `exists` result to prompt for
 * confirmation, then retries with `overwrite: true`). Returns a discriminated
 * result rather than throwing on the expected user-facing failures
 * (invalid name, empty script, name collision); only a genuine I/O failure
 * (mkdir / writeFile) rejects.
 */
export async function saveWorkflowScript(
  config: Config,
  opts: {
    name: string;
    scope: SavedWorkflowSource;
    script: string;
    overwrite?: boolean;
  },
): Promise<WorkflowSaveResult> {
  const { name, scope, script, overwrite = false } = opts;
  const nameError = validateWorkflowName(name);
  if (nameError) return { status: 'invalid-name', error: nameError };
  if (!script || script.trim().length === 0) {
    return {
      status: 'empty-script',
      error: 'This run has no script source to save.',
    };
  }
  const dir =
    scope === 'project'
      ? config.storage.getProjectWorkflowsDir()
      : Storage.getUserWorkflowsDir();
  // Refuse to write through a symlinked root (e.g. `.qwen/workflows -> /outside`):
  // it would persist the script outside the project/user workflow dir. The save
  // overlay's try/catch surfaces this message as a user-facing error.
  if (await isSymlinkedRoot(dir)) {
    throw new Error(
      `refusing to save into a symlinked saved-workflow directory: '${dir}'.`,
    );
  }
  const filePath = path.join(dir, `${name}.js`);
  if (!overwrite) {
    try {
      await fs.access(filePath);
      return { status: 'exists', name, scope, path: filePath };
    } catch {
      // Doesn't exist — fall through and write.
    }
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, script, 'utf8');
  return { status: 'saved', name, scope, path: filePath };
}
