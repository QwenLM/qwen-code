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
 *
 * Active extensions add a third tier: the `.js` files an extension ships
 * (`workflow-extension.ts` discovers them at extension load). They are always
 * addressed as `<extension name>:<meta.name>`, which a project or user name
 * can never spell, so the tiers never shadow each other. Their files are
 * readable by exact path only — the extension directories are deliberately
 * not workflow script roots (see {@link getWorkflowScriptRoots}).
 *
 * A generated-scripts root, `<projectDir>/workflows/generated`
 * (`Storage.getGeneratedWorkflowsDir`), is trusted for `{scriptPath}` loads
 * only. Scripts a tool generates for a single run go there: they are neither
 * listed as slash commands nor resolvable by name, so emitting one never
 * hands the user a command for a run that is already over.
 */

import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import { atomicWriteFile } from '../../utils/atomicFileWrite.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type { ExtensionWorkflowDefinition } from './workflow-extension.js';

const debugLogger = createDebugLogger('WORKFLOW_SAVED');

/**
 * Saved-workflow name constraint. Lower-case, digits, hyphens; must start
 * with a letter. The name doubles as the `.js` filename stem AND the slash
 * command name (`deep-research.js` → `/deep-research`), so it must be safe
 * for both a path segment and a command token (no spaces, dots, slashes).
 */
export const WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

/** The scopes a saved workflow can be written to. */
export type SavedWorkflowScope = 'project' | 'user';

/** Where a discovered saved workflow comes from. Extensions are read-only. */
export type SavedWorkflowSource = SavedWorkflowScope | 'extension';

/** One discovered saved-workflow script (metadata only — no source read). */
export interface SavedWorkflowEntry {
  /**
   * Filename stem, e.g. `deep-research`, or `<extension>:<meta.name>` for an
   * extension workflow. Doubles as the slash command name.
   */
  name: string;
  /** Absolute path to the `.js` file. */
  scriptPath: string;
  /** Which tier the file was found in. */
  source: SavedWorkflowSource;
  /** Owning extension's manifest name; extension workflows only. */
  extensionName?: string;
  /** Owning extension's display name, when it declares one. */
  extensionDisplayName?: string;
  /** `meta.description`, parsed when the extension loaded; extension workflows only. */
  description?: string;
  /**
   * `meta.whenToUse`, parsed when the extension loaded; extension workflows
   * only. When present, the workflow's command is listed for the model.
   */
  whenToUse?: string;
}

/** A resolved saved workflow with its script source loaded. */
export interface ResolvedSavedWorkflow {
  name: string;
  scriptPath: string;
  script: string;
  savedWorkflowName?: string;
}

/** Result of a {@link saveWorkflowScript} attempt. */
export type WorkflowSaveResult =
  | { status: 'saved'; name: string; scope: SavedWorkflowScope; path: string }
  | { status: 'exists'; name: string; scope: SavedWorkflowScope; path: string }
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

/**
 * Extension-name part of a qualified workflow name. Mirrors the extension
 * manifest's `validateName` so every installable extension can prefix one.
 */
const EXTENSION_NAME_SOURCE = '[A-Za-z0-9._-]+';

/** `<extension name>:<meta.name>` — how an extension workflow is addressed. */
export const EXTENSION_WORKFLOW_NAME_PATTERN = new RegExp(
  `^(${EXTENSION_NAME_SOURCE}):(${WORKFLOW_NAME_PATTERN.source.slice(1, -1)})$`,
);

const EXTENSION_NAME_PATTERN = new RegExp(`^${EXTENSION_NAME_SOURCE}$`);

/** Whether an extension name can prefix its workflows' names. */
export function isValidWorkflowExtensionName(extensionName: string): boolean {
  return EXTENSION_NAME_PATTERN.test(extensionName);
}

/** `gcp` + `deep-research` → `gcp:deep-research`. */
export function qualifyExtensionWorkflowName(
  extensionName: string,
  workflowName: string,
): string {
  return `${extensionName}:${workflowName}`;
}

/** Split `<extension>:<meta.name>`; `null` when the name does not have that shape. */
export function parseExtensionWorkflowName(
  name: string,
): { extensionName: string; workflowName: string } | null {
  const match = EXTENSION_WORKFLOW_NAME_PATTERN.exec(name);
  return match ? { extensionName: match[1], workflowName: match[2] } : null;
}

/**
 * Workflow definitions of the active extensions. The single place this tier
 * reads extension state from, so listing, name resolution, and the file
 * allowlist cannot disagree. Tolerates configs without extension support.
 */
export function getActiveExtensionWorkflows(
  config: Config,
): ExtensionWorkflowDefinition[] {
  try {
    return (config.getActiveExtensions?.() ?? []).flatMap(
      (extension) => extension.workflows ?? [],
    );
  } catch {
    return [];
  }
}

/**
 * The active extension workflow a `scriptPath` names, for synchronous labels;
 * the approval dialog uses {@link findActiveExtensionWorkflowByPathCanonical}.
 * Picks a label only — the security check is the loader's allowlist.
 *
 * Discovered paths are real paths, so a spelling through a symlinked ancestor
 * (macOS `/var` → `/private/var`) misses the lexical comparison and is retried
 * against its real path. The disk is touched only when an active extension
 * workflow exists and the lexical spelling did not match.
 */
export function findActiveExtensionWorkflowByPath(
  config: Config,
  scriptPath: string,
): ExtensionWorkflowDefinition | undefined {
  const workflows = getActiveExtensionWorkflows(config);
  if (workflows.length === 0) return undefined;
  const resolved = path.resolve(scriptPath);
  const lexical = workflows.find(
    (workflow) => path.resolve(workflow.scriptPath) === resolved,
  );
  if (lexical) return lexical;
  let real: string;
  try {
    real = realpathSync(scriptPath);
  } catch {
    return undefined;
  }
  return workflows.find((workflow) => workflow.scriptPath === real);
}

/** Like {@link findActiveExtensionWorkflowByPath}, comparing real paths. */
export async function findActiveExtensionWorkflowByPathCanonical(
  config: Config,
  scriptPath: string,
): Promise<ExtensionWorkflowDefinition | undefined> {
  const workflows = getActiveExtensionWorkflows(config);
  if (workflows.length === 0) return undefined;
  let real: string;
  try {
    real = await fs.realpath(scriptPath);
  } catch {
    return undefined;
  }
  return workflows.find((workflow) => workflow.scriptPath === real);
}

/** Both scope directories, project first (higher precedence). */
export function getSavedWorkflowDirs(config: Config): Array<{
  dir: string;
  source: SavedWorkflowScope;
}> {
  return [
    { dir: config.storage.getProjectWorkflowsDir(), source: 'project' },
    { dir: Storage.getUserWorkflowsDir(), source: 'user' },
  ];
}

/**
 * Every directory a `{scriptPath}` may resolve into: both saved scopes plus
 * the generated-scripts root. Name resolution and discovery deliberately use
 * {@link getSavedWorkflowDirs} instead — a generated script is loadable by
 * path, never addressable by name.
 *
 * Extension directories are deliberately absent. The loader checks that a
 * file sits under a root, not that it is a workflow script, so a root is a
 * grant over every file beneath it: an extension declaring `"workflows": "."`
 * would expose its `.env` settings file to `{scriptPath}`. Extension workflows
 * are instead readable by exact real path, one discovered file at a time.
 */
export function getWorkflowScriptRoots(config: Config): string[] {
  return [
    ...getSavedWorkflowDirs(config).map(({ dir }) => dir),
    config.storage.getGeneratedWorkflowsDir(),
  ];
}

/**
 * True when a workflow script root dir is itself a symlink. `readWorkflowFileSecurely`
 * realpaths the root so it can tolerate symlinked *ancestors* (e.g. a project under
 * macOS `/tmp -> /private/tmp`); but that same laundering turns a checked-in
 * `.qwen/workflows -> /outside` link into the allowed boundary — letting discovery
 * list, `workflow('<name>')` read, and the save dialog write external files. The
 * per-entry symlink check in {@link listJsFiles} can't catch this because the link
 * is the dir, not the files it exposes. So we refuse a symlinked root outright for
 * all three operations. A missing dir (the common case) is not a symlink, so this
 * is transparent until someone actually links the dir.
 */
export async function isSymlinkedRoot(dir: string): Promise<boolean> {
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
 * path stays inside one of the workflow script roots (the saved-workflow
 * directories or the generated-scripts root). `fs.realpath` resolves both
 * `..` and symlinks, so this single check defeats path traversal (a
 * `name`/`scriptPath` containing `..`) AND symlink escape (a file inside the
 * dir that links out). Throws otherwise.
 */
async function readWorkflowFileSecurely(
  filePath: string,
  config: Config,
): Promise<string> {
  const real = await fs.realpath(filePath); // throws ENOENT if absent
  const roots = await Promise.all(
    getWorkflowScriptRoots(config).map(async (dir) => {
      // Exclude a symlinked root: realpath(dir) would launder a
      // `.qwen/workflows -> /outside` link into the allowed boundary, so a
      // file resolving under the link's target would pass the check below.
      if (await isSymlinkedRoot(dir)) return { dir, real: null };
      try {
        return { dir, real: await fs.realpath(dir) };
      } catch {
        return { dir, real: path.resolve(dir) };
      }
    }),
  );
  const dirs = roots.flatMap((r) => (r.real === null ? [] : [r.real]));
  const inside = dirs.some((d) => real === d || real.startsWith(d + path.sep));
  const extensionWorkflows = getActiveExtensionWorkflows(config);
  // An extension workflow is allowed by its exact real path, recorded when
  // the extension loaded. A file swapped for a symlink since then resolves
  // elsewhere and no longer matches.
  const isExtensionWorkflow = extensionWorkflows.some(
    (workflow) => workflow.scriptPath === real,
  );
  if (!inside && !isExtensionWorkflow) {
    // Keep refused-but-considered roots visible: dropping a symlinked root
    // from the list reads as if the loader never considered it at all.
    const refused = roots.flatMap((r) => (r.real === null ? [r.dir] : []));
    const refusedNote =
      refused.length > 0
        ? `; refused symlinked ${refused.length === 1 ? 'root' : 'roots'}: ${refused.join(', ')}`
        : '';
    const extensionNote =
      extensionWorkflows.length > 0
        ? `; active extension workflow files: ${extensionWorkflows.length}`
        : '';
    throw new Error(
      `refusing to load a workflow file outside the workflow script roots (checked: ${dirs.join(', ')}${refusedNote}${extensionNote}): '${filePath}'.`,
    );
  }
  return fs.readFile(real, 'utf8');
}

async function resolveSavedWorkflowNameForPath(
  scriptPath: string,
  config: Config,
): Promise<string | undefined> {
  const realScriptPath = await fs.realpath(scriptPath);
  for (const { dir } of getSavedWorkflowDirs(config)) {
    if (await isSymlinkedRoot(dir)) continue;
    let realDir: string;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      continue;
    }
    if (
      realScriptPath !== realDir &&
      !realScriptPath.startsWith(realDir + path.sep)
    ) {
      continue;
    }
    const name = path.basename(realScriptPath).replace(/\.js$/, '');
    return WORKFLOW_NAME_PATTERN.test(name) ? name : undefined;
  }
  return getActiveExtensionWorkflows(config).find(
    (workflow) => workflow.scriptPath === realScriptPath,
  )?.name;
}

/**
 * Enumerate all saved workflows across the project, user, and extension
 * tiers. Project entries shadow same-named user entries (project wins), and
 * both would shadow an extension entry — which cannot happen today, since an
 * extension name always carries a `:` no file stem can. Sorted by name for
 * stable slash-command ordering.
 */
export async function listSavedWorkflows(
  config: Config,
): Promise<SavedWorkflowEntry[]> {
  const byName = new Map<string, SavedWorkflowEntry>();
  // Lowest precedence first, so user and project entries overwrite.
  for (const workflow of getActiveExtensionWorkflows(config)) {
    byName.set(workflow.name, {
      name: workflow.name,
      scriptPath: workflow.scriptPath,
      source: 'extension',
      extensionName: workflow.extensionName,
      ...(workflow.extensionDisplayName
        ? { extensionDisplayName: workflow.extensionDisplayName }
        : {}),
      description: workflow.description,
      ...(workflow.whenToUse ? { whenToUse: workflow.whenToUse } : {}),
    });
  }
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

/** Hex characters of the SHA-256 kept by {@link computeWorkflowScriptDigest}. */
export const WORKFLOW_SCRIPT_DIGEST_CHARS = 16;

/**
 * Short content digest of a workflow script: the first
 * {@link WORKFLOW_SCRIPT_DIGEST_CHARS} hex characters of its SHA-256. An
 * "always allow" grant for a saved or extension workflow and an extension's
 * install consent both record it, so a change to the script's code asks again.
 */
export function computeWorkflowScriptDigest(script: string): string {
  return createHash('sha256')
    .update(script, 'utf8')
    .digest('hex')
    .slice(0, WORKFLOW_SCRIPT_DIGEST_CHARS);
}

/**
 * Resolve `workflow('<name>')` or `workflow({scriptPath})` to a loaded
 * script. The string form looks up `<name>.js` in project then user scope,
 * or an active extension's workflow when the name is `<extension>:<meta.name>`;
 * the `{scriptPath}` form reads the file at the given path directly, which
 * may sit in either saved scope or under the generated-scripts root.
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
        'workflow() expects a workflow name (string) or {scriptPath: string}.',
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
    const savedWorkflowName = await resolveSavedWorkflowNameForPath(
      scriptPath,
      config,
    );
    return {
      name,
      scriptPath,
      script,
      ...(savedWorkflowName ? { savedWorkflowName } : {}),
    };
  }

  if (typeof nameOrRef !== 'string') {
    throw new Error(
      'workflow() expects a workflow name (string) or {scriptPath: string}.',
    );
  }

  const name = nameOrRef;
  const notFound = async (): Promise<never> => {
    const available = (await listSavedWorkflows(config)).map((e) => e.name);
    throw new Error(
      `workflow('${name}'): no workflow with that name. Available: ` +
        `${available.length > 0 ? available.join(', ') : '(none)'}.`,
    );
  };
  // A qualified name addresses an extension workflow. Checked before the
  // stem validation below, which would otherwise call it an invalid name.
  if (parseExtensionWorkflowName(name)) {
    const workflow = getActiveExtensionWorkflows(config).find(
      (candidate) => candidate.name === name,
    );
    if (workflow) {
      try {
        const script = await readWorkflowFileSecurely(
          workflow.scriptPath,
          config,
        );
        return {
          name,
          scriptPath: workflow.scriptPath,
          script,
          savedWorkflowName: name,
        };
      } catch (error) {
        // Listed but unreadable now (removed, or swapped for a symlink since
        // the extension loaded). Report why: "no workflow with that name"
        // would list this very name as available.
        const reason = error instanceof Error ? error.message : String(error);
        debugLogger.warn(`refusing extension workflow ${name}: ${reason}`);
        throw new Error(`workflow('${name}'): ${reason}`);
      }
    }
    return notFound();
  }
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
      return { name, scriptPath, script, savedWorkflowName: name };
    } catch {
      // Not in this scope (absent or rejected) — try the next.
    }
  }

  return notFound();
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
    scope: SavedWorkflowScope;
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

/**
 * Run-id shape accepted for a persisted inline script. Mirrors the tool's
 * `resumeFromRunId` guard (`workflow.ts`) and the snapshot pruner: the id is
 * a path segment here, so anything but the generated `wf_<hex>` shape is
 * refused rather than joined into a path.
 */
const INLINE_RUN_ID_PATTERN = /^wf_[0-9a-f]+$/;

/**
 * Persist the source of an inline `Workflow({script})` run to
 * `<generated>/inline/<runId>.js` and return that path.
 *
 * The run is what matters, not the copy: this never throws and never blocks
 * a launch. A missing `storage`, a symlinked root, a full disk — each degrades
 * to `null`, which the caller reports by simply omitting the script path from
 * the result. Writing it is what lets a model resume a run (and edit the
 * script first) without re-sending the whole source, and lets a user read
 * what actually ran.
 *
 * `atomicWriteFile` does the write: temp-and-rename with `renameWithRetry`
 * (a transient Windows EPERM must not silently cost the result its script
 * path), `forceMode` so a resume heals a copy some earlier state left more
 * permissive than 0600, and `noFollow` so a symlink planted at the target is
 * replaced rather than written through.
 */
export async function persistInlineWorkflowScript(
  config: Config,
  runId: string,
  script: string,
): Promise<string | null> {
  if (!INLINE_RUN_ID_PATTERN.test(runId)) {
    debugLogger.warn(`refusing to persist a script for run id: ${runId}`);
    return null;
  }
  const storage = config.storage;
  if (!storage) return null;
  try {
    const filePath = storage.getInlineWorkflowScriptPath(runId);
    const dir = path.dirname(filePath);
    // Same refusal the loader makes: a symlinked generated root (or a
    // symlinked `inline/` inside it) would carry the write outside the
    // trusted root, and the loader would refuse to read back what we wrote.
    if (
      (await isSymlinkedRoot(storage.getGeneratedWorkflowsDir())) ||
      (await isSymlinkedRoot(dir))
    ) {
      debugLogger.warn(
        `refusing to persist an inline workflow script into a symlinked root: '${dir}'.`,
      );
      return null;
    }
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(filePath, script, {
      encoding: 'utf8',
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
    return filePath;
  } catch (error) {
    debugLogger.warn(
      `failed to persist inline workflow script for ${runId}: ${error}`,
    );
    return null;
  }
}

/** Best-effort cleanup for a persisted inline workflow script. */
export async function deleteInlineWorkflowScript(
  config: Config,
  runId: string,
): Promise<boolean> {
  if (!INLINE_RUN_ID_PATTERN.test(runId)) return false;
  const storage = config.storage;
  if (!storage) return false;
  try {
    await fs.rm(storage.getInlineWorkflowScriptPath(runId), { force: true });
    return true;
  } catch (error) {
    debugLogger.warn(
      `failed to delete inline workflow script for ${runId}: ${error}`,
    );
    return false;
  }
}
