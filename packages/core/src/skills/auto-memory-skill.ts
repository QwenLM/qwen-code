/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview How the main session reaches the bundled `auto-memory`
 * reference.
 *
 * The auto-memory policy is part of the main session's system prompt, so it is
 * paid for on every request, while the main model writes a memory only on the
 * few turns where the user asks it to remember or forget something (#16291).
 * The detailed guidance — every type with its examples, the metadata rules,
 * team memory and when a plan or tasks fit better — therefore lives in a
 * bundled skill, and the prompt keeps a resident policy plus a pointer. Where
 * no skill can be loaded, the session gets the full policy as before. The
 * four-way decision is the one `workflow-authoring` and `agent-delegation`
 * use; see `bundled-reference.ts`.
 *
 * What stays resident on purpose: the directories and their routing, the four
 * types in one line each, what not to save, the two save steps with the
 * frontmatter template and the category list, deduplication, when to read
 * memory, and the rule to verify a remembered file, function or flag before
 * recommending it. A model that never loads this skill still saves and uses
 * memories correctly; it just picks keywords and shapes bodies with less
 * guidance.
 *
 * Only the main session's policy changes. The extraction, Dream, `/remember`
 * and import agents build their own prompts from the full constants.
 */

import type { Config } from '../config/config.js';
import {
  buildManagedAutoMemoryPrompt,
  buildResidentAutoMemoryPrompt,
  type TeamAutoMemorySection,
  type UserAutoMemorySection,
} from '../memory/prompt.js';
import { ToolDisplayNames } from '../tools/tool-names.js';
import {
  resolveBundledReferenceRoute,
  toolSearchBridgeSentence,
  type BundledReferenceRoute,
} from './bundled-reference.js';

/** Name of the bundled reference, as the model would invoke it. */
export const AUTO_MEMORY_SKILL_NAME = 'auto-memory';

const POINTER = `Once you decide to save or reorganize a memory, load the \`${AUTO_MEMORY_SKILL_NAME}\` skill for the full guidance on each memory type with examples, the keyword and usage-scenario rules, team memory, and when a plan or tasks fit better than memory.`;

/**
 * The pointer the resident policy ends with, or `undefined` where no skill can
 * be loaded and the caller sends the full policy instead.
 *
 * Decided on the route rather than on the surface a tool description uses:
 * that surface falls back to a pointer when the reference file cannot be read,
 * but the full policy needs no file, so a session with no route to any skill
 * always gets it.
 */
export function buildAutoMemoryReferenceSection(
  route: BundledReferenceRoute,
): string | undefined {
  switch (route) {
    case 'skill':
      return POINTER;
    case 'skill-via-tool-search':
      return `${POINTER} ${toolSearchBridgeSentence(ToolDisplayNames.SKILL)}`;
    case 'inline':
      return undefined;
    case 'withheld':
      // The user turned the reference off: keep the resident policy and do
      // not name a skill they removed.
      return '';
    default: {
      // Typed `never` so a new route is a compile error rather than a
      // silently missing pointer.
      const unhandled: never = route;
      return unhandled;
    }
  }
}

/** What the main session's legacy auto-memory policy is built from. */
export interface MainSessionAutoMemoryInputs {
  memoryDir: string;
  indexContent: string | null;
  userSection: UserAutoMemorySection;
  teamSection: TeamAutoMemorySection | undefined;
}

/**
 * The main session's auto-memory policy for one route: the resident policy
 * with a pointer to the bundled reference, or the full policy where no skill
 * can be loaded. The indexes always travel as request-tail catalog data.
 */
export function buildMainSessionAutoMemoryPromptForRoute(
  route: BundledReferenceRoute,
  inputs: MainSessionAutoMemoryInputs,
): string {
  const reference = buildAutoMemoryReferenceSection(route);
  if (reference === undefined) {
    return buildManagedAutoMemoryPrompt(
      inputs.memoryDir,
      inputs.indexContent,
      inputs.userSection,
      inputs.teamSection,
      { includeIndexes: false },
    );
  }
  return buildResidentAutoMemoryPrompt(
    inputs.memoryDir,
    inputs.userSection,
    inputs.teamSection,
    reference,
  );
}

/**
 * The main session's policy, resolved for whichever Config reads it.
 *
 * The route is decided at read time, not when memory is refreshed: a
 * subagent reads the policy through a Config derived from the session's, and
 * one whose tool policy leaves out the Skill tool holds no skill manager
 * (#12424), so its route is `inline` and it must get the full policy rather
 * than the session's pointer. Reading it late also follows the Skill tool's
 * reachability when that changes between refreshes, and covers the
 * session-start refresh, which runs before the tool registry exists.
 *
 * Built once per route: a session normally sees one or two routes, and the
 * text for a route only changes when the inputs do, which replaces this
 * object.
 */
export class MainSessionAutoMemoryPolicy {
  private readonly byRoute = new Map<BundledReferenceRoute, string>();

  constructor(readonly inputs: MainSessionAutoMemoryInputs) {}

  forConfig(config: Config): string {
    const route = resolveBundledReferenceRoute(config, AUTO_MEMORY_SKILL_NAME);
    let prompt = this.byRoute.get(route);
    if (prompt === undefined) {
      prompt = buildMainSessionAutoMemoryPromptForRoute(route, this.inputs);
      this.byRoute.set(route, prompt);
    }
    return prompt;
  }
}
