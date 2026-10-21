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
import { isSubpath } from '../../utils/paths.js';
import { openNoFollow } from '../../utils/no-follow-open.js';
import { getTrustedWorkflowAncestors } from './workflow-ancestors.js';
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

function getProjectWorkflowsDir(config: Config): string {
  const target = config.getTargetDir?.();
  return target
    ? path.join(target, '.qwen', 'workflows')
    : config.storage.getProjectWorkflowsDir();
}

/** Base scope directories only, project first. Ancestors require host trust. */
export function getSavedWorkflowDirs(config: Config): Array<{
  dir: string;
  source: SavedWorkflowScope;
}> {
  return [
    { dir: getProjectWorkflowsDir(config), source: 'project' },
    { dir: Storage.getUserWorkflowsDir(), source: 'user' },
  ];
}

/** Base path roots only; ancestor admission is limited to exact saved files. */
export function getWorkflowScriptRoots(config: Config): string[] {
  return [
    ...getSavedWorkflowDirs(config).map(({ dir }) => dir),
    config.storage.getGeneratedWorkflowsDir(),
  ];
}

export async function isSymlinkedRoot(dir: string): Promise<boolean> {
  return fs
    .lstat(dir)
    .then((st) => st.isSymbolicLink())
    .catch(() => false);
}

interface WorkflowRoot {
  dir: string;
  source?: SavedWorkflowScope;
  ancestor?: boolean;
  targetBoundary?: string | null;
  checked?: Promise<WorkflowRootCheck>;
}

interface WorkflowRootCheck {
  real?: string;
  symlink?: boolean;
  refused?: string;
}

interface WorkflowSnapshot {
  saved: WorkflowRoot[];
  roots: WorkflowRoot[];
  extensions: ExtensionWorkflowDefinition[];
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function workflowSnapshot(config: Config): Promise<WorkflowSnapshot> {
  const [projectDir, userDir, generated] = getWorkflowScriptRoots(config);
  const project = { dir: projectDir, source: 'project' as const };
  const user: WorkflowRoot = { dir: userDir, source: 'user' };
  const extensions = getActiveExtensionWorkflows(config);
  const target = path.resolve(project.dir, '..', '..');
  const canonicalTarget = await fs.realpath(target).catch(() => undefined);
  const ancestors = canonicalTarget
    ? await getTrustedWorkflowAncestors(
        canonicalTarget,
        config.getWorkflowAncestorTrustProvider?.(),
      )
    : [];
  const userReal = ancestors.length
    ? (await checkedRoot(user).catch(() => undefined))?.real
    : undefined;
  const saved: WorkflowRoot[] = [
    { ...project, targetBoundary: canonicalTarget ?? null },
    ...ancestors
      .map((dir) => path.join(dir, '.qwen', 'workflows'))
      .filter(
        (dir) => dir !== project.dir && dir !== user.dir && dir !== userReal,
      )
      .map((dir) => ({
        dir,
        source: 'project' as const,
        ancestor: true,
      })),
    user,
  ];
  return {
    saved,
    roots: [...saved, { dir: generated }],
    extensions,
  };
}

async function checkRoot(root: WorkflowRoot): Promise<WorkflowRootCheck> {
  const refuse = (reason: string, symlink = false): WorkflowRootCheck => {
    debugLogger.warn(
      `refusing saved-workflow directory '${root.dir}': ${reason}`,
    );
    return { refused: reason, ...(symlink ? { symlink: true } : {}) };
  };
  if (root.targetBoundary === null)
    return refuse('unverifiable project target');
  try {
    if (root.ancestor) {
      const qwen = await fs.lstat(path.dirname(root.dir));
      if (qwen.isSymbolicLink())
        return refuse('symlinked .qwen directory', true);
      if (!qwen.isDirectory()) return {};
    }
    const stat = await fs.lstat(root.dir);
    if (stat.isSymbolicLink())
      return refuse('symlinked workflows directory', true);
    if (!stat.isDirectory()) return {};
    const real = await fs.realpath(root.dir);
    if (root.targetBoundary && !isSubpath(root.targetBoundary, real)) {
      return refuse('outside project target');
    }
    if (root.ancestor && real !== root.dir)
      return refuse('non-canonical ancestor directory');
    return { real };
  } catch (error) {
    if (isMissing(error)) return {};
    throw new Error(`workflow directory '${root.dir}': ${String(error)}`);
  }
}

const checkedRoot = (root: WorkflowRoot) => (root.checked ??= checkRoot(root));

async function savedCandidate(
  root: WorkflowRoot,
  name: string,
): Promise<string | undefined> {
  if (!WORKFLOW_NAME_PATTERN.test(name) || !(await checkedRoot(root)).real) {
    return undefined;
  }
  const file = path.join(root.dir, `${name}.js`);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(`workflow file '${file}': ${String(error)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  const real = await fs.realpath(file);
  return path.basename(real) === `${name}.js` ? file : undefined;
}

async function listSnapshot(
  snapshot: WorkflowSnapshot,
): Promise<{ entries: SavedWorkflowEntry[]; unavailable: string[] }> {
  const byName = new Map<string, SavedWorkflowEntry>();
  const unavailable: string[] = [];
  for (const workflow of snapshot.extensions) {
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
  for (const root of snapshot.saved) {
    try {
      if (!(await checkedRoot(root)).real) continue;
      let files: string[];
      try {
        files = await fs.readdir(root.dir);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const file of files) {
        if (!file.endsWith('.js')) continue;
        const name = file.slice(0, -3);
        const candidate = await savedCandidate(root, name);
        if (candidate && !byName.has(name)) {
          byName.set(name, {
            name,
            scriptPath: candidate,
            source: root.source!,
          });
        }
      }
    } catch (error) {
      const diagnostic = `workflow directory '${root.dir}': ${String(error)}`;
      unavailable.push(diagnostic);
      debugLogger.warn(`Could not list ${diagnostic}`);
      // Commands may execute listed paths directly. Do not expose farther
      // namesakes when this root's contents could not be determined.
      break;
    }
  }
  return {
    entries: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unavailable,
  };
}

async function outsideRoots(
  file: string,
  snapshot: WorkflowSnapshot,
): Promise<Error> {
  const checked = await Promise.all(
    snapshot.roots.map(async (root) => ({
      root,
      ...(await checkedRoot(root).catch(
        (error: unknown): WorkflowRootCheck => ({
          refused: String(error),
        }),
      )),
    })),
  );
  const dirs = checked.flatMap(({ root, real, refused }) =>
    refused ? [] : [real ?? path.resolve(root.dir)],
  );
  const refused = checked.flatMap(({ root, symlink }) =>
    symlink ? [root.dir] : [],
  );
  const refusedNote = refused.length
    ? `; refused symlinked ${refused.length === 1 ? 'root' : 'roots'}: ${refused.join(', ')}`
    : '';
  const refusedOther = checked.flatMap(({ root, refused, symlink }) =>
    refused && !symlink ? [`${root.dir} (${refused})`] : [],
  );
  const refusedOtherNote = refusedOther.length
    ? `; refused roots: ${refusedOther.join(', ')}`
    : '';
  const extensionNote = snapshot.extensions.length
    ? `; active extension workflow files: ${snapshot.extensions.length}`
    : '';
  return new Error(
    `refusing to load a workflow file outside the workflow script roots (checked: ${dirs.join(', ')}${refusedNote}${refusedOtherNote}${extensionNote}): '${file}'.`,
  );
}

async function readWorkflowFile(
  file: string,
  snapshot: WorkflowSnapshot,
  selectedRoot?: WorkflowRoot,
): Promise<{
  script: string;
  savedWorkflowName?: string;
  source?: SavedWorkflowSource;
}> {
  const real = await fs.realpath(file);
  const parent = await fs.realpath(path.dirname(file));
  const lexical = path.resolve(file);
  const extension = snapshot.extensions.find(
    (entry) => entry.scriptPath === real,
  );
  let root = selectedRoot;
  if (!root) {
    let owningRootError: unknown;
    const pathRoot = async (
      candidate: WorkflowRoot,
    ): Promise<WorkflowRootCheck> => {
      try {
        return await checkedRoot(candidate);
      } catch (error) {
        if (
          !extension &&
          (isSubpath(path.resolve(candidate.dir), lexical) ||
            isSubpath(candidate.dir, parent))
        )
          owningRootError ??= error;
        return {};
      }
    };
    let spelling = lexical;
    if (snapshot.saved.some((candidate) => candidate.ancestor)) {
      const marker = `${path.sep}.qwen${path.sep}workflows${path.sep}`;
      const match =
        process.platform === 'win32'
          ? /[\\/]\.qwen[\\/]workflows[\\/]/i.exec(lexical)
          : undefined;
      const index =
        process.platform === 'win32'
          ? (match?.index ?? -1)
          : lexical.indexOf(marker);
      if (index !== -1) {
        // Preserve workflow-directory links while resolving aliases of their owner.
        const owner = lexical.slice(0, index + 1);
        spelling = path.join(
          await fs.realpath(owner),
          '.qwen',
          'workflows',
          lexical.slice(index + (match?.[0].length ?? marker.length)),
        );
      }
    }
    const baseRoots = snapshot.roots.filter((candidate) => !candidate.ancestor);
    let baseOwnsSpelling = false;
    for (const candidate of baseRoots) {
      const checked = await pathRoot(candidate);
      if (
        checked.real &&
        isSubpath(checked.real, parent) &&
        (isSubpath(path.resolve(candidate.dir), spelling) ||
          isSubpath(checked.real, spelling))
      )
        baseOwnsSpelling = true;
      if (
        checked.real &&
        isSubpath(checked.real, real) &&
        isSubpath(checked.real, parent)
      ) {
        root = candidate;
        break;
      }
    }
    const ownsExtension =
      extension &&
      path.join(parent, path.basename(file)) === extension.scriptPath;
    if (!root && !ownsExtension) {
      for (const candidate of snapshot.saved.filter(
        (entry) => entry.ancestor,
      )) {
        const checked = await pathRoot(candidate);
        if (
          checked.real === parent &&
          path.dirname(real) === parent &&
          path.extname(file) === '.js' &&
          (await savedCandidate(candidate, path.basename(file, '.js')))
        ) {
          root = candidate;
          break;
        }
      }
    }
    const claimedAncestors = snapshot.saved.filter(
      (candidate) =>
        candidate.ancestor &&
        (isSubpath(candidate.dir, spelling) ||
          isSubpath(candidate.dir, parent)),
    );
    if (!root && !ownsExtension && owningRootError) throw owningRootError;
    if (
      !root &&
      !ownsExtension &&
      !baseOwnsSpelling &&
      claimedAncestors.length
    ) {
      throw await outsideRoots(file, snapshot);
    }
    for (const ancestor of claimedAncestors) {
      const ownsLexicalPath = root
        ? isSubpath(path.resolve(root.dir), spelling) ||
          isSubpath((await checkedRoot(root)).real!, spelling)
        : baseOwnsSpelling || spelling === extension?.scriptPath;
      if (
        isSubpath(ancestor.dir, spelling) &&
        !ownsLexicalPath &&
        !(await checkedRoot(ancestor)).real
      ) {
        throw await outsideRoots(file, snapshot);
      }
    }
    if (!root && !ownsExtension) {
      for (const candidate of baseRoots) {
        const checked = await pathRoot(candidate);
        if (checked.real && isSubpath(checked.real, real)) {
          root = candidate;
          break;
        }
      }
    }
  }
  const rootReal = root && (await checkedRoot(root)).real;
  if ((!rootReal || !isSubpath(rootReal, real)) && !extension) {
    throw await outsideRoots(file, snapshot);
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`workflow file is not an ordinary file: '${file}'.`);
  }
  if ((selectedRoot || root?.ancestor) && stat.isSymbolicLink()) {
    throw new Error(`refusing symlinked workflow file: '${file}'.`);
  }
  const handle = await openNoFollow(
    selectedRoot || root?.ancestor ? file : real,
  );
  try {
    const opened = await handle.stat();
    const currentReal = await fs.realpath(file);
    if (
      !opened.isFile() ||
      (!stat.isSymbolicLink() &&
        (opened.ino !== stat.ino || opened.dev !== stat.dev)) ||
      currentReal !== real ||
      (root && (await checkRoot(root)).real !== rootReal)
    ) {
      throw new Error(`workflow file changed while reading: '${file}'.`);
    }
    const name = path.basename(real, '.js');
    const savedWorkflowName =
      root?.source && WORKFLOW_NAME_PATTERN.test(name) ? name : extension?.name;
    return {
      script: await handle.readFile('utf8'),
      ...(savedWorkflowName ? { savedWorkflowName } : {}),
      ...(root?.source
        ? { source: root.source }
        : extension
          ? { source: 'extension' as const }
          : {}),
    };
  } finally {
    await handle.close();
  }
}

/** Target, trusted ancestors, user, and namespaced active extensions. */
export async function listSavedWorkflows(
  config: Config,
): Promise<SavedWorkflowEntry[]> {
  const { entries } = await listSnapshot(await workflowSnapshot(config));
  return entries;
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
    try {
      const loaded = await readWorkflowFile(
        scriptPath,
        await workflowSnapshot(config),
      );
      return {
        name: path.basename(scriptPath).replace(/\.js$/, ''),
        scriptPath,
        ...loaded,
      };
    } catch (error) {
      throw new Error(
        `workflow({scriptPath: '${scriptPath}'}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (typeof nameOrRef !== 'string') {
    throw new Error(
      'workflow() expects a workflow name (string) or {scriptPath: string}.',
    );
  }
  const name = nameOrRef;
  const qualified = parseExtensionWorkflowName(name);
  if (!qualified) {
    const error = validateWorkflowName(name);
    if (error) throw new Error(`workflow('${name}'): ${error}`);
  }
  const snapshot = await workflowSnapshot(config);
  if (qualified) {
    const workflow = snapshot.extensions.find((entry) => entry.name === name);
    if (workflow) {
      try {
        return {
          name,
          scriptPath: workflow.scriptPath,
          ...(await readWorkflowFile(workflow.scriptPath, snapshot)),
          savedWorkflowName: name,
          source: 'extension',
        };
      } catch (error) {
        throw new Error(
          `workflow('${name}'): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else {
    for (const root of snapshot.saved) {
      const scriptPath = await savedCandidate(root, name);
      if (scriptPath) {
        return {
          name,
          scriptPath,
          ...(await readWorkflowFile(scriptPath, snapshot, root)),
        };
      }
    }
  }
  const { entries, unavailable } = await listSnapshot(snapshot);
  const available = entries.map((entry) => entry.name);
  const diagnostic = unavailable.length
    ? ` Listing incomplete: ${unavailable.join('; ')}.`
    : '';
  throw new Error(
    `workflow('${name}'): no workflow with that name. Available: ${available.length ? available.join(', ') : '(none)'}.${diagnostic}`,
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
 * (invalid name, empty script, name collision). Unverifiable or unsafe roots
 * and genuine I/O failures reject.
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
  const target = path.resolve(dir, '..', '..');
  const canonicalTarget =
    scope === 'project'
      ? await fs.realpath(target).catch(() => {
          throw new Error(
            `refusing to save into an unverifiable project target: '${target}'.`,
          );
        })
      : undefined;
  const root: WorkflowRoot = {
    dir,
    source: scope,
    targetBoundary: canonicalTarget,
  };
  const assertSaveRoot = async () => {
    if (await isSymlinkedRoot(dir)) {
      throw new Error(
        `refusing to save into a symlinked saved-workflow directory: '${dir}'.`,
      );
    }
    if (canonicalTarget) {
      const qwen = path.dirname(dir);
      let cursor = qwen;
      while (true) {
        try {
          const real = await fs.realpath(cursor);
          if (!isSubpath(canonicalTarget, real)) {
            throw new Error(
              `refusing to save outside the project target: '${dir}'.`,
            );
          }
          break;
        } catch (error) {
          if (!isMissing(error)) throw error;
          const parent = path.dirname(cursor);
          if (parent === cursor) throw error;
          cursor = parent;
        }
      }
    }
  };
  await assertSaveRoot();
  await fs.mkdir(dir, { recursive: true });
  await assertSaveRoot();
  if (!(await checkRoot(root)).real) {
    throw new Error(
      `refusing to save into an invalid saved-workflow directory: '${dir}'.`,
    );
  }
  const filePath = path.join(dir, `${name}.js`);
  try {
    const existing = await fs.lstat(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(
        `refusing to overwrite a symlink or non-file workflow: '${filePath}'.`,
      );
    }
    if (!overwrite) return { status: 'exists', name, scope, path: filePath };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (overwrite) {
    await atomicWriteFile(filePath, script, {
      encoding: 'utf8',
      noFollow: true,
    });
  } else {
    await fs.writeFile(filePath, script, { encoding: 'utf8', flag: 'wx' });
  }
  return { status: 'saved', name, scope, path: filePath };
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
