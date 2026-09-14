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
 * third saved-workflow tier, addressed as `<extension name>:<file stem>` by the
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
import { createDebugLogger } from '../../utils/debugLogger.js';
import { extractAndStripMeta } from './workflow-sandbox.js';
import {
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

/** One workflow script an active extension ships (metadata only). */
export interface ExtensionWorkflowDefinition {
  /** `<extensionName>:<stem>` — the slash command name and `workflow()` address. */
  name: string;
  /** File name without `.js`. */
  stem: string;
  extensionName: string;
  extensionDisplayName?: string;
  /** Real path of the `.js` file, resolved when the extension loaded. */
  scriptPath: string;
  /** From the statically parsed `export const meta`; the script never ran. */
  description: string;
  whenToUse?: string;
}

interface WorkflowCandidate {
  candidate: string;
  /** Declared in the manifest (warn when missing) vs. the default directory. */
  explicit: boolean;
}

/**
 * Discover the workflow scripts an extension ships.
 *
 * @param extensionRoot The extension's effective directory (a linked
 *   extension's source directory).
 * @param owner The extension's manifest `name` (its stable id) and optional
 *   display name.
 * @param declared The manifest's `workflows` value. `undefined` reads the
 *   default `workflows/` directory; a string or string array reads exactly the
 *   declared directories and `.js` files instead.
 */
export async function loadExtensionWorkflows(
  extensionRoot: string,
  owner: { name: string; displayName?: string },
  declared: unknown,
): Promise<ExtensionWorkflowDefinition[]> {
  const found = new Map<string, ExtensionWorkflowDefinition>();
  try {
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
    const rootReal = await fs.realpath(extensionRoot);
    for (const candidate of candidates) {
      await collectCandidate(candidate, rootReal, owner, found);
    }
  } catch (error) {
    debugLogger.warn(
      `failed to load workflows of extension "${owner.name}": ${error}`,
    );
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
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
      // absolute path is accepted here; containment is checked on the real path.
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
  rootReal: string,
  owner: { name: string; displayName?: string },
  found: Map<string, ExtensionWorkflowDefinition>,
): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(candidate);
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
  const real = await fs.realpath(candidate);
  if (!isPathWithin(rootReal, real)) {
    debugLogger.warn(
      `refusing workflows path of extension "${owner.name}" outside the extension: ${candidate}`,
    );
    return;
  }
  if (stat.isDirectory()) {
    const names = (await fs.readdir(real))
      .filter((name) => name.endsWith('.js'))
      .sort();
    for (const name of names) {
      await collectFile(path.join(real, name), false, owner, found);
    }
    return;
  }
  if (stat.isFile()) {
    await collectFile(real, true, owner, found);
    return;
  }
  debugLogger.warn(
    `ignoring workflows path of extension "${owner.name}" that is neither a directory nor a file: ${candidate}`,
  );
}

async function collectFile(
  filePath: string,
  explicit: boolean,
  owner: { name: string; displayName?: string },
  found: Map<string, ExtensionWorkflowDefinition>,
): Promise<void> {
  const fileName = path.basename(filePath);
  if (!fileName.endsWith('.js')) {
    if (explicit) {
      debugLogger.warn(
        `ignoring declared workflow of extension "${owner.name}" that is not a .js file: ${filePath}`,
      );
    }
    return;
  }
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    debugLogger.warn(
      `skipping workflow of extension "${owner.name}" that is not a regular file: ${filePath}`,
    );
    return;
  }
  const stem = fileName.slice(0, -'.js'.length);
  if (!WORKFLOW_NAME_PATTERN.test(stem)) {
    debugLogger.warn(
      `skipping workflow of extension "${owner.name}" whose file name is not a legal workflow name: ${filePath}`,
    );
    return;
  }
  if (stat.size > MAX_EXTENSION_WORKFLOW_SCRIPT_BYTES) {
    debugLogger.warn(
      `skipping workflow of extension "${owner.name}" larger than ${MAX_EXTENSION_WORKFLOW_SCRIPT_BYTES} bytes: ${filePath}`,
    );
    return;
  }
  const name = qualifyExtensionWorkflowName(owner.name, stem);
  if (found.has(name)) {
    debugLogger.warn(
      `skipping duplicate workflow "${name}" of extension "${owner.name}": ${filePath}`,
    );
    return;
  }
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
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
  found.set(name, {
    name,
    stem,
    extensionName: owner.name,
    ...(owner.displayName ? { extensionDisplayName: owner.displayName } : {}),
    scriptPath: filePath,
    description: meta.description,
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
  });
}
