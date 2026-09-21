/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview How a tool reaches a bundled reference skill in this session.
 *
 * Long guidance that only one turn in a session needs — how to write a
 * workflow script, how to brief a subagent — belongs in a bundled skill rather
 * than in a tool description, because a description is paid for on every turn
 * while a skill body is paid for when it is loaded. That trade only works if
 * the tool knows which of four situations it is in:
 *
 * - The model can load the skill. Point at it.
 * - The Skill tool's schema can be withheld by a `tools.eager` allowlist, so
 *   the model reaches it through the tool_search + tool_call bridge. Point at
 *   it and say so.
 * - The model has no route to any skill (skills are off, the Skill tool is
 *   denied, or it is deferred with no tool_search + tool_call bridge to reach
 *   it). Inline the reference, or the guidance reaches nobody.
 * - The user turned this reference off, by name or by disabling the whole
 *   bundled level. Carry neither: inlining would put back, at a higher
 *   per-turn price, exactly the text they asked to remove.
 *
 * Extracted from the `workflow-authoring` implementation (#11013) when the
 * Agent tool needed the same decision (#12054), so the two cannot drift.
 * Each tool decides once, when it is constructed, and records the answer.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { ToolMode } from '../tools/code-mode.js';
import { ToolNames } from '../tools/tool-names.js';
import { parseSkillContent } from './skill-load.js';
import { resolveBundleDir } from '../utils/bundlePaths.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('BUNDLED_REFERENCE');

/** A bundled reference as the Skill tool would load it. */
export interface BundledReference {
  /** Markdown body, frontmatter stripped. */
  body: string;
  /** Directory holding `SKILL.md`, the base for relative paths in the body. */
  baseDir: string;
}

/**
 * Read at most once per skill per process: the file ships with the build and
 * cannot change under a running process. `null` = attempted and unreadable.
 *
 * No reset seam: a test that needs a different file resets the module registry
 * (`vi.resetModules()` plus a `node:fs` mock), which is also the only way to
 * exercise the read failing rather than a substituted function.
 */
const cache = new Map<string, BundledReference | null>();

/** Where a bundled reference lives, in both a source tree and a build. */
function referencePath(skillName: string): string {
  return path.join(
    resolveBundleDir(import.meta.url),
    'bundled',
    skillName,
    'SKILL.md',
  );
}

/**
 * A bundled reference's body, or `null` when it cannot be read.
 *
 * Synchronous on purpose: the tools that need it build their descriptions in a
 * constructor. Never throws — a build that somehow shipped without the file
 * must still construct its tools.
 */
export function readBundledReference(
  skillName: string,
): BundledReference | null {
  const cached = cache.get(skillName);
  if (cached !== undefined) return cached;
  let reference: BundledReference | null = null;
  try {
    const filePath = referencePath(skillName);
    const parsed = parseSkillContent(readFileSync(filePath, 'utf8'), filePath);
    reference = { body: parsed.body, baseDir: path.dirname(filePath) };
  } catch (error) {
    debugLogger.warn(`cannot read the ${skillName} reference: ${error}`);
  }
  cache.set(skillName, reference);
  return reference;
}

/**
 * How a reference reaches the model in this session.
 *
 * - `skill` — the Skill tool is in the request; the model can load it.
 * - `skill-via-tool-search` — the Skill tool is registered but its schema can
 *   be withheld by a `tools.eager` allowlist; the model reaches it through the
 *   tool_search + tool_call bridge. Whether it is declared right now is not
 *   asked: this is recorded for the session, and a resumed-history
 *   re-declaration lasts only until `/clear`.
 * - `inline` — no route to any skill; the reference has to travel in the
 *   tool's own description.
 * - `withheld` — the user turned this reference off; carry nothing.
 */
export type BundledReferenceRoute =
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
 * factories: this runs while the tool that needs it is being constructed, and
 * the Skill tool may not be instantiated yet. A question this cannot answer
 * resolves to `skill` — pointing at a skill that turns out to be missing costs
 * the model one failed call, while inlining the reference into every request
 * costs every turn of the session.
 */
export function resolveBundledReferenceRoute(
  config: Config,
  skillName: string,
): BundledReferenceRoute {
  try {
    if (config.getDisabledSkillLevels?.()?.has('bundled')) return 'withheld';
    if (
      config.isSkillEnabled?.({
        name: skillName,
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
    if (
      // CodeModeOnly hides both bridge tools (`code-mode.ts` HIDDEN_TOOLS),
      // so registration is not reachability there: a bridge pointer would
      // name tools the session cannot call, while a deferred Skill tool
      // stays reachable through the `exec` binding. Fall through to `skill`;
      // the plain pointer stays honest (the #12271 rule at fileUtils.ts).
      config.getToolMode?.() !== ToolMode.CodeModeOnly &&
      isToolDeferredBehindToolSearch(config, ToolNames.SKILL)
    ) {
      // A withheld schema is only reachable through the tool_search +
      // tool_call bridge. Without BOTH halves the Skill tool is registered
      // but invisible, which is no route at all — with tool_search alone the
      // schema can be reviewed but never invoked. Whether it is declared
      // right now is not asked: this is recorded for the session, and a
      // resumed-history re-declaration lasts only until `/clear`.
      return toolNames.includes(ToolNames.TOOL_SEARCH) &&
        toolNames.includes(ToolNames.TOOL_CALL)
        ? 'skill-via-tool-search'
        : 'inline';
    }
    return 'skill';
  } catch (error) {
    debugLogger.warn(`cannot resolve the ${skillName} route: ${error}`);
    return 'skill';
  }
}

/**
 * What a tool's description holds about the reference, derived from the route
 * plus whether the file can actually be read.
 *
 * - `pointer` — names the skill.
 * - `pointer-via-tool-search` — names the skill and says to reach it through
 *   the tool_search + tool_call bridge.
 * - `inline` — carries the reference in full.
 * - `withheld` — says nothing about it.
 */
export type BundledReferenceSurface =
  | 'pointer'
  | 'pointer-via-tool-search'
  | 'inline'
  | 'withheld';

export function resolveBundledReferenceSurface(
  config: Config,
  skillName: string,
): BundledReferenceSurface {
  const route = resolveBundledReferenceRoute(config, skillName);
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
      return readBundledReference(skillName) ? 'inline' : 'pointer';
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
 * drops it — a decision recorded once has to ask this.
 */
function isToolDeferredBehindToolSearch(config: Config, name: string): boolean {
  if (!config.getToolRegistry?.()?.isPermissionDeferred?.(name)) return false;
  return !config.getVisibleTools?.()?.has(name);
}

/**
 * Whether a registered tool's schema is withheld from the request right now:
 * deferred as above and not revealed through ToolSearch yet. For a question
 * asked again on every turn, such as the Workflow keyword reminder's.
 *
 * Mirrors `ToolRegistry.isDeferredAndHidden`, which cannot be used here: it
 * answers false for a tool that is still only a lazy factory, which is exactly
 * the state while the tool asking the question is being constructed.
 */
export function isToolHiddenBehindToolSearch(
  config: Config,
  name: string,
): boolean {
  if (!isToolDeferredBehindToolSearch(config, name)) return false;
  return !config.getToolRegistry?.()?.isDeferredToolRevealed?.(name);
}

/**
 * The one wording for reaching a hidden deferred tool through the
 * tool_search + tool_call bridge, shared by every tool description, failure
 * hint and reminder that needs it so they never phrase it differently.
 * tool_search only REVIEWS the schema — invoking still goes through tool_call,
 * so the sentence must name both halves or it sends the model down a dead end.
 *
 * Conditional on purpose: a description is built once, and a tool can be
 * re-declared later in the session (a resumed history that references it) and
 * dropped again by `/clear`, so neither a flat "it is deferred" nor leaving
 * the sentence out stays true for the whole session.
 */
export function toolSearchBridgeSentence(toolDisplayName: string): string {
  return `If the ${toolDisplayName} tool is not in your tool list, review its schema with \`tool_search\` and then invoke it with \`tool_call\`.`;
}
