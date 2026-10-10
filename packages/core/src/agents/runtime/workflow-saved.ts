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
 * Inside a repository, the `.qwen/workflows` directories of the project's
 * trusted ancestors (up to the nearest Git root; see `workflow-ancestors.ts`)
 * sit between the two: from `repo/packages/a`, a name resolves to the nearest
 * of `repo/packages/a`, `repo/packages`, `repo`, then the user scope. Saving
 * still writes to the project's own directory.
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
import {
  constants as fsConstants,
  promises as fs,
  realpathSync,
} from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import { QWEN_DIR, Storage } from '../../config/storage.js';
import { atomicWriteFile } from '../../utils/atomicFileWrite.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { resolveWorkflowAncestorScope } from './workflow-ancestors.js';
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
  /** The tier the loaded file belongs to; absent for a generated script. */
  source?: SavedWorkflowSource;
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

/**
 * The project scope's directory: `<targetDir>/.qwen/workflows`. Anchored on
 * the Config's own target directory, not on `config.storage` — a derived
 * Config (a subagent's worktree) rebinds its target directory but inherits
 * its parent's `Storage`, and must neither read nor save into the parent's
 * project. A Config without a target directory falls back to its storage.
 */
function getProjectWorkflowsDir(config: Config): string {
  const targetDir = config.getTargetDir?.();
  return typeof targetDir === 'string' && targetDir.length > 0
    ? path.join(targetDir, QWEN_DIR, 'workflows')
    : config.storage.getProjectWorkflowsDir();
}

/**
 * Both base scope directories, project first (higher precedence). Name
 * resolution and listing also search the trusted ancestors of the project
 * between these two; see {@link resolveWorkflowAncestorScope}.
 */
export function getSavedWorkflowDirs(config: Config): Array<{
  dir: string;
  source: SavedWorkflowScope;
}> {
  return [
    { dir: getProjectWorkflowsDir(config), source: 'project' },
    { dir: Storage.getUserWorkflowsDir(), source: 'user' },
  ];
}

/**
 * Every directory a `{scriptPath}` may resolve anywhere into: both base saved
 * scopes plus the generated-scripts root. Name resolution and discovery
 * deliberately use the saved scopes instead — a generated script is loadable
 * by path, never addressable by name.
 *
 * Extension directories are deliberately absent. The loader checks that a
 * file sits under a root, not that it is a workflow script, so a root is a
 * grant over every file beneath it: an extension declaring `"workflows": "."`
 * would expose its `.env` settings file to `{scriptPath}`. Extension workflows
 * are instead readable by exact real path, one discovered file at a time. A
 * trusted ancestor's workflows directory is absent for the same reason: only
 * the `<name>.js` files directly in it are readable.
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
 * per-entry symlink check in {@link listWorkflowFiles} can't catch this because the link
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

function isWithin(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir + path.sep);
}

const SYMLINKED_ROOT = 'symlinked' as const;
const OUTSIDE_PROJECT_ROOT = 'outside-the-project' as const;

/** One directory a saved workflow can be found in, as one lookup sees it. */
interface WorkflowScopeDir {
  /** The path as configured; listed entries are spelled under it. */
  dir: string;
  source: SavedWorkflowScope;
  /**
   * A trusted ancestor's directory: only the `<name>.js` files directly in it
   * are readable, never the rest of the directory.
   */
  ancestor: boolean;
  /** Real path of `dir`; `null` when the directory is refused or absent. */
  realDir: string | null;
  /** Why `realDir` is `null` when that is a refusal rather than an absence. */
  refusal?: typeof SYMLINKED_ROOT | typeof OUTSIDE_PROJECT_ROOT;
}

/**
 * Every directory one public lookup reads, resolved once: the saved scopes
 * in precedence order (target project, its trusted ancestors nearest first,
 * user) and the generated-scripts root. A lookup builds one and uses it for
 * every selection and read it makes; the next lookup builds a new one.
 */
interface WorkflowDiscovery {
  scopes: WorkflowScopeDir[];
  generated: WorkflowScopeDir;
}

/**
 * Real path of a base root directory (target project, user, generated), on
 * the rules these roots have always had: a symlinked root is refused, and a
 * root that does not exist yet keeps its lexical spelling.
 */
async function resolveBaseRoot(
  dir: string,
  source: SavedWorkflowScope,
): Promise<WorkflowScopeDir> {
  if (await isSymlinkedRoot(dir)) {
    return {
      dir,
      source,
      ancestor: false,
      realDir: null,
      refusal: SYMLINKED_ROOT,
    };
  }
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    realDir = path.resolve(dir);
  }
  return { dir, source, ancestor: false, realDir };
}

async function buildWorkflowDiscovery(
  config: Config,
): Promise<WorkflowDiscovery> {
  const ancestors = await resolveWorkflowAncestorScope(config);
  const project = await resolveBaseRoot(
    getProjectWorkflowsDir(config),
    'project',
  );
  // A project `.qwen` (or anything above `workflows`) that links out of the
  // target directory would make another directory the project's workflow
  // root, read without asking anyone — including an ancestor the trust
  // policy denies (`a/.qwen -> ../../.qwen`). An ancestor's workflows are
  // reachable only as that ancestor's scope, under its trust decision.
  // Both sides are real paths, so a target under a system alias (`/tmp`)
  // still matches.
  const boundary = ancestors.canonicalTargetDir;
  const projectReal =
    project.realDir !== null && boundary !== null
      ? await fs.realpath(project.dir).catch(() => null)
      : null;
  if (
    projectReal !== null &&
    boundary !== null &&
    !isWithin(projectReal, boundary)
  ) {
    project.realDir = null;
    project.refusal = OUTSIDE_PROJECT_ROOT;
  }
  const user = await resolveBaseRoot(Storage.getUserWorkflowsDir(), 'user');
  const scopes: WorkflowScopeDir[] = [project];
  for (const ancestor of ancestors.trustedAncestors) {
    const dir = path.join(ancestor, QWEN_DIR, 'workflows');
    let realDir: string | null;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      realDir = null;
    }
    // The ancestor is already a real path, so anything but an identical
    // real path means a link in `.qwen` or `workflows`. A directory another
    // scope already covers (a repository at the home directory holds the
    // user scope) is that scope's, not a second copy of it.
    if (
      realDir === null ||
      realDir !== dir ||
      realDir === user.realDir ||
      scopes.some((scope) => scope.realDir === realDir)
    ) {
      continue;
    }
    scopes.push({ dir, source: 'project', ancestor: true, realDir });
  }
  scopes.push(user);
  const generated = await resolveBaseRoot(
    config.storage.getGeneratedWorkflowsDir(),
    'project',
  );
  return { scopes, generated };
}

/**
 * The named workflows one scope offers: stem → file path, for each regular
 * `<valid-name>.js` file directly in the directory. A directory named
 * `foo.js`, a symlink and an illegal stem are not workflows. `null` when the
 * scope is refused, absent or cannot be read — it then offers no names at
 * all, so listing and name resolution cannot disagree about it.
 */
async function listWorkflowFiles(
  scope: WorkflowScopeDir,
): Promise<Map<string, string> | null> {
  if (scope.realDir === null) {
    if (scope.refusal) {
      debugLogger.warn(
        `refusing ${scope.refusal} saved-workflow dir: ${scope.dir}`,
      );
    }
    return null;
  }
  let names: string[];
  try {
    names = await fs.readdir(scope.dir);
  } catch (e) {
    // Missing directory is the common case (user never saved a workflow).
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      debugLogger.warn(`listing saved workflows failed for ${scope.dir}: ${e}`);
    }
    return null;
  }
  const out = new Map<string, string>();
  for (const n of names) {
    if (!n.endsWith('.js')) continue;
    const name = n.slice(0, -'.js'.length);
    // Skip files whose stem isn't a legal workflow/command name — they
    // can't be a slash command and `workflow('<name>')` can't address them.
    if (!WORKFLOW_NAME_PATTERN.test(name)) continue;
    // Skip symlinks. A malicious repo could ship `<name>.js` as a symlink to
    // an arbitrary file (e.g. `~/.aws/credentials`); discovering and later
    // reading it would leak the target through the snapshot `script` field,
    // sandbox parse-error messages, and telemetry.
    const st = await fs.lstat(path.join(scope.dir, n)).catch(() => null);
    if (!st || !st.isFile()) continue;
    out.set(name, path.join(scope.dir, n));
  }
  return out;
}

/**
 * Read the regular file at a real path. Opened without following a final
 * symlink, so a file swapped for a link after its path was checked is
 * refused rather than read.
 */
async function readRegularFile(realPath: string): Promise<string> {
  const handle = await fs.open(
    realPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`not a regular file: '${realPath}'.`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The ancestor scope `realPath` is a direct `<valid-name>.js` file of, if
 * any. Only those files of a trusted ancestor are readable.
 */
function findAncestorScopeOf(
  discovery: WorkflowDiscovery,
  realPath: string,
): WorkflowScopeDir | undefined {
  const base = path.basename(realPath);
  if (!base.endsWith('.js')) return undefined;
  if (!WORKFLOW_NAME_PATTERN.test(base.slice(0, -'.js'.length))) {
    return undefined;
  }
  return discovery.scopes.find(
    (scope) =>
      scope.ancestor &&
      scope.realDir !== null &&
      path.dirname(realPath) === scope.realDir,
  );
}

/**
 * Read a candidate workflow file, but only after proving its canonical real
 * path stays inside one of the base workflow script roots (the project and
 * user directories or the generated-scripts root), is a direct workflow file
 * of a trusted ancestor's directory, or is an active extension workflow.
 * `fs.realpath` resolves both `..` and symlinks, so this single check
 * defeats path traversal (a `name`/`scriptPath` containing `..`) AND symlink
 * escape (a file inside the dir that links out). Throws otherwise.
 */
async function readWorkflowFileSecurely(
  filePath: string,
  config: Config,
  discovery: WorkflowDiscovery,
): Promise<string> {
  const real = await fs.realpath(filePath); // throws ENOENT if absent
  const baseRoots = [
    ...discovery.scopes.filter((scope) => !scope.ancestor),
    discovery.generated,
  ];
  const dirs = baseRoots.flatMap((r) =>
    r.realDir === null ? [] : [r.realDir],
  );
  const inside =
    dirs.some((d) => isWithin(real, d)) ||
    findAncestorScopeOf(discovery, real) !== undefined;
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
    const refusedNote = [SYMLINKED_ROOT, OUTSIDE_PROJECT_ROOT]
      .map((refusal) => {
        const refused = baseRoots.flatMap((r) =>
          r.realDir === null && r.refusal === refusal ? [r.dir] : [],
        );
        return refused.length > 0
          ? `; refused ${refusal} ${refused.length === 1 ? 'root' : 'roots'}: ${refused.join(', ')}`
          : '';
      })
      .join('');
    const ancestorDirs = discovery.scopes.flatMap((scope) =>
      scope.ancestor && scope.realDir !== null ? [scope.realDir] : [],
    );
    const ancestorNote =
      ancestorDirs.length > 0
        ? `; <name>.js files directly in: ${ancestorDirs.join(', ')}`
        : '';
    const extensionNote =
      extensionWorkflows.length > 0
        ? `; active extension workflow files: ${extensionWorkflows.length}`
        : '';
    throw new Error(
      `refusing to load a workflow file outside the workflow script roots (checked: ${dirs.join(', ')}${refusedNote}${ancestorNote}${extensionNote}): '${filePath}'.`,
    );
  }
  return readRegularFile(real);
}

/** The saved scope a script path belongs to, and the name it is saved under. */
async function resolveSavedWorkflowNameForPath(
  scriptPath: string,
  config: Config,
  discovery: WorkflowDiscovery,
): Promise<{ name?: string; source: SavedWorkflowSource } | undefined> {
  const realScriptPath = await fs.realpath(scriptPath);
  const stem = path.basename(realScriptPath).replace(/\.js$/, '');
  const name = WORKFLOW_NAME_PATTERN.test(stem) ? stem : undefined;
  for (const scope of discovery.scopes) {
    if (scope.realDir === null) continue;
    if (
      scope.ancestor
        ? path.dirname(realScriptPath) !== scope.realDir
        : !isWithin(realScriptPath, scope.realDir)
    ) {
      continue;
    }
    return { name, source: scope.source };
  }
  const extension = getActiveExtensionWorkflows(config).find(
    (workflow) => workflow.scriptPath === realScriptPath,
  );
  return extension ? { name: extension.name, source: 'extension' } : undefined;
}

async function listSavedWorkflowsIn(
  config: Config,
  discovery: WorkflowDiscovery,
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
  // Iterate user FIRST, then ancestors far to near, then the project, so
  // nearer entries overwrite (win).
  for (const scope of [...discovery.scopes].reverse()) {
    const files = await listWorkflowFiles(scope);
    if (!files) continue;
    for (const [name, scriptPath] of files) {
      byName.set(name, { name, scriptPath, source: scope.source });
    }
  }
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Enumerate all saved workflows across the project, its trusted ancestors,
 * the user scope and the extension tier. The nearest directory wins a name:
 * the project's own entry shadows an ancestor's, an ancestor's shadows a
 * farther one's, and any of them shadows the user's — and all would shadow an
 * extension entry, which cannot happen today, since an extension name always
 * carries a `:` no file stem can. Sorted by name for stable slash-command
 * ordering.
 */
export async function listSavedWorkflows(
  config: Config,
): Promise<SavedWorkflowEntry[]> {
  return listSavedWorkflowsIn(config, await buildWorkflowDiscovery(config));
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
 * script. The string form looks up `<name>.js` in the project, its trusted
 * ancestors nearest first, then the user scope, or an active extension's
 * workflow when the name is `<extension>:<meta.name>`; the `{scriptPath}`
 * form reads the file at the given path directly, which may sit in either
 * base saved scope or under the generated-scripts root, or be a workflow file
 * directly in a trusted ancestor's directory.
 *
 * One call reads the directories and their trust once, and reads the one file
 * it selects: the nearest regular `<name>.js`. When that file then cannot be
 * read, the call fails rather than running a farther definition of the name.
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
    const discovery = await buildWorkflowDiscovery(config);
    let script: string;
    try {
      script = await readWorkflowFileSecurely(scriptPath, config, discovery);
    } catch (e) {
      throw new Error(
        `workflow({scriptPath: '${scriptPath}'}): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const name = path.basename(scriptPath).replace(/\.js$/, '');
    const saved = await resolveSavedWorkflowNameForPath(
      scriptPath,
      config,
      discovery,
    );
    return {
      name,
      scriptPath,
      script,
      ...(saved?.name ? { savedWorkflowName: saved.name } : {}),
      ...(saved ? { source: saved.source } : {}),
    };
  }

  if (typeof nameOrRef !== 'string') {
    throw new Error(
      'workflow() expects a workflow name (string) or {scriptPath: string}.',
    );
  }

  const name = nameOrRef;
  const discovery = await buildWorkflowDiscovery(config);
  const notFound = async (): Promise<never> => {
    const available = (await listSavedWorkflowsIn(config, discovery)).map(
      (e) => e.name,
    );
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
          discovery,
        );
        return {
          name,
          scriptPath: workflow.scriptPath,
          script,
          savedWorkflowName: name,
          source: 'extension',
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
  // workflow dirs. The realpath boundary check below is a second line of
  // defence, but a clear name error is the better signal.
  const nameError = validateWorkflowName(name);
  if (nameError) {
    throw new Error(`workflow('${name}'): ${nameError}`);
  }
  for (const scope of discovery.scopes) {
    const scriptPath = (await listWorkflowFiles(scope))?.get(name);
    if (scriptPath === undefined || scope.realDir === null) continue;
    // The nearest definition is the one this name runs. If it cannot be read
    // now — removed, or swapped for a link since it was listed — the call
    // fails; a farther file of the same name never stands in for it.
    let script: string;
    try {
      const real = await fs.realpath(scriptPath);
      if (real !== path.join(scope.realDir, `${name}.js`)) {
        throw new Error(
          `'${scriptPath}' no longer resolves inside ${scope.dir}.`,
        );
      }
      script = await readRegularFile(real);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debugLogger.warn(`refusing saved workflow ${name}: ${reason}`);
      throw new Error(
        `workflow('${name}'): cannot read ${scriptPath}: ${reason}`,
      );
    }
    return {
      name,
      scriptPath,
      script,
      savedWorkflowName: name,
      source: scope.source,
    };
  }

  return notFound();
}

/**
 * Save a workflow script to `.qwen/workflows/<name>.js` (project) or
 * `~/.qwen/workflows/<name>.js` (user). Powers the `/workflows` save dialog.
 * The project is always the session's own target directory, never an
 * ancestor whose workflows the session can discover.
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
      ? getProjectWorkflowsDir(config)
      : Storage.getUserWorkflowsDir();
  // Refuse to write through a symlinked root (e.g. `.qwen/workflows -> /outside`):
  // it would persist the script outside the project/user workflow dir. The save
  // overlay's try/catch surfaces this message as a user-facing error.
  if (await isSymlinkedRoot(dir)) {
    throw new Error(
      `refusing to save into a symlinked saved-workflow directory: '${dir}'.`,
    );
  }
  if (scope === 'project') await assertProjectSaveTarget(config, dir);
  const filePath = path.join(dir, `${name}.js`);
  if (scope === 'project') {
    // A planted `<name>.js -> /outside` link would carry an overwrite out of
    // the project; the open below refuses a link that appears after this.
    const st = await fs.lstat(filePath).catch(() => null);
    if (st?.isSymbolicLink()) {
      throw new Error(
        `refusing to save over a symlinked workflow file: '${filePath}'.`,
      );
    }
  }
  if (!overwrite) {
    try {
      await fs.access(filePath);
      return { status: 'exists', name, scope, path: filePath };
    } catch {
      // Doesn't exist — fall through and write.
    }
  }
  await fs.mkdir(dir, { recursive: true });
  if (scope === 'project') {
    // Re-checked after `mkdir`, which follows a `.qwen` link it finds.
    await assertProjectSaveTarget(config, dir);
    await fs.writeFile(filePath, script, {
      encoding: 'utf8',
      flag:
        fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        (fsConstants.O_NOFOLLOW ?? 0),
    });
  } else {
    await fs.writeFile(filePath, script, 'utf8');
  }
  return { status: 'saved', name, scope, path: filePath };
}

/**
 * Refuse a project save whose directory resolves outside the target
 * directory — the same boundary discovery applies, so a save can never write
 * through a link into an ancestor (trusted or not) or anywhere else. Only the
 * parts of the path that already exist are resolved.
 */
async function assertProjectSaveTarget(
  config: Config,
  dir: string,
): Promise<void> {
  const targetDir = config.getTargetDir?.();
  if (typeof targetDir !== 'string' || targetDir.length === 0) return;
  const boundary = await fs.realpath(targetDir).catch(() => null);
  if (boundary === null) return;
  for (const candidate of [dir, path.dirname(dir)]) {
    const real = await fs.realpath(candidate).catch(() => null);
    if (real === null) continue;
    if (!isWithin(real, boundary)) {
      throw new Error(
        `refusing to save into a saved-workflow directory outside the project: '${dir}'.`,
      );
    }
    return;
  }
}

/**
 * Whether `value` has the shape of a generated run id, `wf_<hex>`. A run id
 * becomes a path segment under the runs and inline-script directories, so an
 * id from outside — a client's `taskId`, a directory name — is checked with
 * this before it is joined into a path.
 */
export function isWorkflowRunId(value: string): boolean {
  return /^wf_[0-9a-f]+$/.test(value);
}

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
  if (!isWorkflowRunId(runId)) {
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
  if (!isWorkflowRunId(runId)) return false;
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
