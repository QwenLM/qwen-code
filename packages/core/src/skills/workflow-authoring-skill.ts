/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview How the model reaches the bundled `workflow-authoring`
 * reference in this session.
 *
 * The authoring reference is a bundled skill rather than tool-description
 * prose because only the turn that actually writes a script needs it, while a
 * tool description is paid for on every turn. That trade only works if the
 * Workflow tool knows which of three situations it is in, because each one
 * wants a different description:
 *
 * - The model can load the skill. Point at it.
 * - The model has no way to load any skill (skills are off, the Skill tool is
 *   denied, or it is deferred with no ToolSearch to reveal it). Inline the
 *   reference, or the model writes scripts against nothing.
 * - The user turned this reference off (the skill by name, or the whole
 *   bundled level). Carry neither: inlining would put back, at a higher
 *   per-turn price, exactly the text they asked to remove.
 *
 * The decision is made once, when the Workflow tool is constructed, and
 * recorded on it. Every other surface that talks about the reference — the
 * failure hint, the keyword reminder — reads that record instead of asking
 * again, so a mid-session `/skills` toggle cannot make them disagree with the
 * description the model is holding.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { parseSkillContent } from './skill-load.js';
import { resolveBundleDir } from '../utils/bundlePaths.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKFLOW_AUTHORING_SKILL');

/** Name of the bundled authoring reference, as the model would invoke it. */
export const WORKFLOW_AUTHORING_SKILL_NAME = 'workflow-authoring';

/** The reference as the Skill tool would load it. */
export interface WorkflowAuthoringReference {
  /** Markdown body, frontmatter stripped. */
  body: string;
  /** Directory holding `SKILL.md`, the base for relative paths in the body. */
  baseDir: string;
}

/**
 * Resolved once: the file ships with the build and cannot change under a
 * running process, and the Workflow tool reads it during construction.
 * `undefined` = not attempted yet, `null` = attempted and unreadable.
 */
let cachedReference: WorkflowAuthoringReference | null | undefined;

/** Where the bundled reference lives, in both a source tree and a build. */
function referencePath(): string {
  return path.join(
    resolveBundleDir(import.meta.url),
    'bundled',
    WORKFLOW_AUTHORING_SKILL_NAME,
    'SKILL.md',
  );
}

/**
 * The bundled reference's body, or `null` when it cannot be read.
 *
 * Synchronous on purpose: the Workflow tool builds its description in a
 * constructor. The file is small and read at most once per process.
 *
 * Never throws — a build that somehow shipped without the file must still
 * construct its Workflow tool.
 */
export function readWorkflowAuthoringReference(): WorkflowAuthoringReference | null {
  if (cachedReference !== undefined) return cachedReference;
  try {
    const filePath = referencePath();
    const parsed = parseSkillContent(readFileSync(filePath, 'utf8'), filePath);
    cachedReference = { body: parsed.body, baseDir: path.dirname(filePath) };
  } catch (error) {
    debugLogger.warn(`cannot read the workflow-authoring reference: ${error}`);
    cachedReference = null;
  }
  return cachedReference;
}

/**
 * How the reference reaches the model in this session.
 *
 * - `skill` — the Skill tool is in the request; the model can load it.
 * - `skill-via-tool-search` — the Skill tool is registered but a `tools.eager`
 *   allowlist can withhold its schema (it is not listed in `tools.visible`);
 *   the model may have to reveal it with ToolSearch first, and the pointer has
 *   to say so. A reveal already made does not change this: `/clear` drops
 *   reveals, and the route is decided only once.
 * - `inline` — no route to any skill; the reference has to travel in the
 *   Workflow tool's own description.
 * - `withheld` — the user turned this reference off; carry nothing.
 */
export type WorkflowAuthoringRoute =
  | 'skill'
  | 'skill-via-tool-search'
  | 'inline'
  | 'withheld';

/**
 * Decide the route for this config.
 *
 * Order matters: a user opt-out wins over the lack of a Skill tool, because
 * the opt-out says "not this text" regardless of how it would have arrived.
 *
 * Tool presence is read through `getAllToolNames()`, which counts lazy
 * factories: this runs while the Workflow tool itself is being constructed,
 * and the Skill tool may not be instantiated yet. A question this cannot
 * answer resolves to `skill` — pointing at a skill that turns out to be
 * missing costs the model one failed call, while inlining ~15 KB of reference
 * into every request costs every turn of the session.
 */
export function resolveWorkflowAuthoringRoute(
  config: Config,
): WorkflowAuthoringRoute {
  try {
    if (config.getDisabledSkillLevels?.()?.has('bundled')) return 'withheld';
    if (
      config.isSkillEnabled?.({
        name: WORKFLOW_AUTHORING_SKILL_NAME,
        level: 'bundled',
      }) === false
    ) {
      return 'withheld';
    }
    if (!config.getSkillManager?.()) return 'inline';
    const registry = config.getToolRegistry?.();
    const toolNames = registry?.getAllToolNames?.();
    if (!Array.isArray(toolNames)) return 'skill';
    if (!toolNames.includes(ToolNames.SKILL)) return 'inline';
    if (isToolDeferredBehindToolSearch(config, ToolNames.SKILL)) {
      // A withheld schema is only reachable through ToolSearch. Without it
      // the Skill tool is registered but invisible, which is no route at all.
      // Whether it is revealed right now is not asked: this is recorded for
      // the session, and a reveal lasts only until `/clear`.
      return toolNames.includes(ToolNames.TOOL_SEARCH)
        ? 'skill-via-tool-search'
        : 'inline';
    }
    return 'skill';
  } catch (error) {
    debugLogger.warn(`cannot resolve the workflow-authoring route: ${error}`);
    return 'skill';
  }
}

/**
 * What the Workflow tool's description holds about the reference, derived from
 * the route plus whether the file can actually be read.
 *
 * - `pointer` — names the skill.
 * - `pointer-via-tool-search` — names the skill and says to reveal the Skill
 *   tool with ToolSearch first.
 * - `inline` — carries the reference in full.
 * - `withheld` — says nothing about it.
 *
 * The Workflow tool records this when it is built; the failure hint and the
 * keyword reminder read that record rather than calling this again.
 */
export type WorkflowAuthoringSurface =
  | 'pointer'
  | 'pointer-via-tool-search'
  | 'inline'
  | 'withheld';

export function resolveWorkflowAuthoringSurface(
  config: Config,
): WorkflowAuthoringSurface {
  const route = resolveWorkflowAuthoringRoute(config);
  switch (route) {
    case 'skill':
      return 'pointer';
    case 'skill-via-tool-search':
      return 'pointer-via-tool-search';
    case 'withheld':
      return 'withheld';
    case 'inline':
      // Inlining needs the file. Without it the pointer is the only text left
      // that names the reference at all.
      return readWorkflowAuthoringReference() ? 'inline' : 'pointer';
    default: {
      // Unreachable while every route has a case above. Typed `never` so a
      // new route is a compile error here rather than a silent pointer.
      const unhandled: never = route;
      return unhandled;
    }
  }
}

/**
 * Whether a registered tool's schema can be withheld from the request:
 * permission-deferred by a `tools.eager` allowlist and not listed in
 * `tools.visible`. A ToolSearch reveal is not consulted, because `/clear`
 * drops it — a decision recorded once has to ask this, not
 * {@link isToolHiddenBehindToolSearch}.
 */
function isToolDeferredBehindToolSearch(config: Config, name: string): boolean {
  if (!config.getToolRegistry?.()?.isPermissionDeferred?.(name)) return false;
  return !config.getVisibleTools?.()?.has(name);
}

/**
 * Whether a registered tool's schema is withheld from the request right now:
 * deferred as above and not revealed through ToolSearch yet. For a question
 * asked again on every turn, such as the keyword reminder's.
 *
 * Mirrors `ToolRegistry.isDeferredAndHidden`, which cannot be used here: it
 * answers false for a tool that is still only a lazy factory, which is exactly
 * the state while the Workflow tool is being constructed.
 */
export function isToolHiddenBehindToolSearch(
  config: Config,
  name: string,
): boolean {
  if (!isToolDeferredBehindToolSearch(config, name)) return false;
  return !config.getToolRegistry?.()?.isDeferredToolRevealed?.(name);
}

/**
 * The one wording for "fetch this tool's schema first", shared by the tool
 * description, the failure hint and the keyword reminder so the three never
 * phrase it differently.
 *
 * Conditional on purpose: the description is built once, and a tool can be
 * revealed later in the session (a ToolSearch call, or a resumed history that
 * references it) and dropped again by `/clear`, so neither a flat "it is
 * deferred" nor leaving the sentence out stays true for the whole session.
 */
export function toolSearchRevealSentence(toolDisplayName: string): string {
  return `If the ${toolDisplayName} tool is not in your tool list, reveal it with ToolSearch first.`;
}
