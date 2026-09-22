/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Discovery of the workflow scripts an extension ships.
 *
 * An extension contributes `.js` workflow scripts from `<extension>/workflows/`
 * or from the paths its manifest declares in `workflows`. Each one becomes a
 * third saved-workflow tier, addressed as `<extension name>:<meta.name>` by the
 * `/<name>` slash command and by `workflow('<name>')`
 * (`workflow-saved.ts` owns that tier; this module only finds the files).
 *
 * Extension files come from third parties, so discovery is deliberately
 * narrow: every path must resolve inside the extension, symlinks are skipped,
 * only one directory level is read, each file is size-capped, and the
 * `export const meta` block is parsed statically — the script is never
 * executed here. A bad file is skipped with a warning; it never fails the
 * extension load.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isPathWithin } from '../../extension/agent-plugins-v1/paths.js';
import { isResourceExhaustion } from '../../skills/skill-load.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { extractAndStripMeta } from './workflow-sandbox.js';
import {
  computeWorkflowScriptDigest,
  isValidWorkflowExtensionName,
  qualifyExtensionWorkflowName,
  WORKFLOW_NAME_PATTERN,
} from './workflow-saved.js';

const debugLogger = createDebugLogger('WORKFLOW_EXTENSION');

/** Default directory an extension's workflows are read from. */
export const EXTENSION_WORKFLOWS_DIR = 'workflows';

/**
 * Per-file size cap for extension workflow scripts. Project and user scripts
 * are the user's own files and have none; extension files are third-party.
 */
export const MAX_EXTENSION_WORKFLOW_SCRIPT_BYTES = 256 * 1024;

/**
 * Longest `meta.description`, and `meta.whenToUse`, kept from an extension
 * workflow. The text is third-party and reaches the install consent prompt,
 * the command list, the model's skill listing and the approval dialog, where
 * an unbounded value would push the path being approved out of view.
 */
export const MAX_EXTENSION_WORKFLOW_DESCRIPTION_CHARS = 500;

/** One workflow script an active extension ships (metadata only). */
export interface ExtensionWorkflowDefinition {
  /** `<extensionName>:<meta.name>` — the slash command name and `workflow()` address. */
  name: string;
  extensionName: string;
  extensionDisplayName?: string;
  /** Path of the `.js` file; a real path unless discovered with `followSymlinks`. */
  scriptPath: string;
  /**
   * From the statically parsed `export const meta`, shortened to
   * {@link MAX_EXTENSION_WORKFLOW_DESCRIPTION_CHARS}; the script never ran.
   */
  description: string;
  /**
   * `meta.whenToUse`, shortened like `description`; absent when the script
   * declares none or only whitespace. Its presence is what lists the workflow
   * for the model to start on its own — an author who writes no condition
   * leaves the workflow to the user and to other workflows.
   */
  whenToUse?: string;
  /**
   * {@link computeWorkflowScriptDigest} of the script as discovered. Install
   * consent compares it, so an update that only changes a script's code
   * still asks.
   */
  contentDigest: string;
}

export interface LoadExtensionWorkflowsOptions {
  /**
   * Describe the tree the way an install copies it: follow symlinks and check
   * containment on the path as spelled, because the copy replaces each link
   * with the file it points to. Only install consent sets this, so the prompt
   * lists what the installed extension will load. Runtime discovery never
   * does — it reads the tree that actually loads, where links are refused.
   */
  followSymlinks?: boolean;
}

interface WorkflowCandidate {
  candidate: string;
  /** Declared in the manifest (warn when missing) vs. the default directory. */
  explicit: boolean;
}

interface DiscoveryContext {
  root: string;
  owner: { name: string; displayName?: string };
  found: Map<string, ExtensionWorkflowDefinition>;
  followSymlinks: boolean;
}

/**
 * Discover the workflow scripts an extension ships.
 *
 * @param extensionRoot The extension's effective directory (a linked
 *   extension's source directory).
 * @param owner The extension's manifest `name` (its stable id) and optional
 *   display name.
 * @param declared The manifest's `workflows` value. `undefined` or `null`
 *   reads the default `workflows/` directory; a string or string array reads
 *   exactly the declared directories and `.js` files instead.
 */
export async function loadExtensionWorkflows(
  extensionRoot: string,
  owner: { name: string; displayName?: string },
  declared: unknown,
  options: LoadExtensionWorkflowsOptions = {},
): Promise<ExtensionWorkflowDefinition[]> {
  if (!isValidWorkflowExtensionName(owner.name)) {
    debugLogger.warn(
      `skipping workflows of extension "${owner.name}": the name cannot prefix a workflow name`,
    );
    return [];
  }
  const candidates = declaredWorkflowCandidates(
    extensionRoot,
    owner.name,
    declared,
  );
  if (candidates.length === 0) return [];
  const followSymlinks = options.followSymlinks === true;
  let root: string;
  try {
    root = followSymlinks
      ? path.resolve(extensionRoot)
      : await fs.realpath(extensionRoot);
  } catch (error) {
    // Resource exhaustion fails the whole load closed so a later refresh
    // retries, instead of silently dropping this extension's workflows.
    if (isResourceExhaustion(error)) throw error;
    debugLogger.warn(
      `failed to load workflows of extension "${owner.name}": ${error}`,
    );
    return [];
  }
  const context: DiscoveryContext = {
    root,
    owner,
    found: new Map(),
    followSymlinks,
  };
  for (const candidate of candidates) {
    // Isolated per declared path: one unreadable directory must not drop the
    // paths declared after it.
    try {
      await collectCandidate(candidate, context);
    } catch (error) {
      // Resource exhaustion fails the whole load closed; one unreadable
      // declared path otherwise stays isolated from the rest.
      if (isResourceExhaustion(error)) throw error;
      debugLogger.warn(
        `skipping workflows path of extension "${owner.name}" that could not be read: ${candidate.candidate}: ${error}`,
      );
    }
  }
  return [...context.found.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function declaredWorkflowCandidates(
  extensionRoot: string,
  extensionName: string,
  declared: unknown,
): WorkflowCandidate[] {
  if (declared === undefined || declared === null) {
    return [
      {
        candidate: path.join(extensionRoot, EXTENSION_WORKFLOWS_DIR),
        explicit: false,
      },
    ];
  }
  const entries =
    typeof declared === 'string'
      ? [declared]
      : Array.isArray(declared)
        ? (declared as unknown[])
        : undefined;
  if (!entries) {
    debugLogger.warn(
      `ignoring "workflows" of extension "${extensionName}": expected a path or an array of paths`,
    );
    return [];
  }
  const candidates: WorkflowCandidate[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      debugLogger.warn(
        `ignoring a "workflows" entry of extension "${extensionName}": expected a non-empty path`,
      );
      continue;
    }
    candidates.push({
      // `${extensionPath}` substitution makes a declared path absolute, so an
      // absolute path is accepted here; containment is checked below.
      candidate: path.isAbsolute(entry)
        ? entry
        : path.resolve(extensionRoot, entry),
      explicit: true,
    });
  }
  return candidates;
}

async function collectCandidate(
  { candidate, explicit }: WorkflowCandidate,
  context: DiscoveryContext,
): Promise<void> {
  const { owner, followSymlinks } = context;
  let stat;
  try {
    stat = followSymlinks
      ? await fs.stat(candidate)
      : await fs.lstat(candidate);
  } catch {
    if (explicit) {
      debugLogger.warn(
        `declared workflows path of extension "${owner.name}" not found: ${candidate}`,
      );
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    debugLogger.warn(
      `refusing symlinked workflows path of extension "${owner.name}": ${candidate}`,
    );
    return;
  }
  const resolved = followSymlinks
    ? path.resolve(candidate)
    : await fs.realpath(candidate);
  if (!isPathWithin(context.root, resolved)) {
    debugLogger.warn(
      `refusing workflows path of extension "${owner.name}" outside the extension: ${candidate}`,
    );
    return;
  }
  if (stat.isDirectory()) {
    const names = (await fs.readdir(resolved))
      .filter((name) => name.endsWith('.js'))
      .sort();
    for (const name of names) {
      await collectFile(path.join(resolved, name), false, context);
    }
    return;
  }
  if (stat.isFile()) {
    await collectFile(resolved, true, context);
    return;
  }
  debugLogger.warn(
    `ignoring workflows path of extension "${owner.name}" that is neither a directory nor a file: ${candidate}`,
  );
}

async function collectFile(
  filePath: string,
  explicit: boolean,
  context: DiscoveryContext,
): Promise<void> {
  const { owner, found, followSymlinks } = context;
  const fileName = path.basename(filePath);
  if (!fileName.endsWith('.js')) {
    if (explicit) {
      debugLogger.warn(
        `ignoring declared workflow of extension "${owner.name}" that is not a .js file: ${filePath}`,
      );
    }
    return;
  }
  const stat = await (
    followSymlinks ? fs.stat(filePath) : fs.lstat(filePath)
  ).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    debugLogger.warn(
      `skipping workflow of extension "${owner.name}" that is not a regular file: ${filePath}`,
    );
    return;
  }
  if (stat.size > MAX_EXTENSION_WORKFLOW_SCRIPT_BYTES) {
    debugLogger.warn(
      `skipping workflow of extension "${owner.name}" larger than ${MAX_EXTENSION_WORKFLOW_SCRIPT_BYTES} bytes: ${filePath}`,
    );
    return;
  }
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isResourceExhaustion(error)) throw error;
    debugLogger.warn(`failed to read workflow ${filePath}: ${error}`);
    return;
  }
  let meta;
  try {
    meta = extractAndStripMeta(source).meta;
  } catch (error) {
    debugLogger.warn(
      `skipping workflow ${filePath} with an invalid meta block: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!meta) {
    debugLogger.warn(
      `skipping workflow ${filePath}: it declares no \`export const meta\``,
    );
    return;
  }
  if (!WORKFLOW_NAME_PATTERN.test(meta.name)) {
    debugLogger.warn(
      `skipping workflow of extension "${owner.name}" whose meta.name is not a legal workflow name: ${filePath}`,
    );
    return;
  }
  const name = qualifyExtensionWorkflowName(owner.name, meta.name);
  const whenToUse = meta.whenToUse?.trim();
  if (found.has(name)) {
    debugLogger.warn(
      `skipping duplicate workflow "${name}" of extension "${owner.name}": ${filePath}`,
    );
    return;
  }
  found.set(name, {
    name,
    extensionName: owner.name,
    ...(owner.displayName ? { extensionDisplayName: owner.displayName } : {}),
    scriptPath: filePath,
    description: clampMetaText(meta.description),
    ...(whenToUse ? { whenToUse: clampMetaText(whenToUse) } : {}),
    contentDigest: computeWorkflowScriptDigest(source),
  });
}

/** Shortens by code point, so a surrogate pair is never split. */
function clampMetaText(text: string): string {
  const chars = Array.from(text);
  return chars.length > MAX_EXTENSION_WORKFLOW_DESCRIPTION_CHARS
    ? `${chars.slice(0, MAX_EXTENSION_WORKFLOW_DESCRIPTION_CHARS - 1).join('')}…`
    : text;
}
