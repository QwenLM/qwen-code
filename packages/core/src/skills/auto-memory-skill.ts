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

/**
 * The main session's auto-memory policy for this config: the resident policy
 * with a pointer to the bundled reference, or the full policy where no skill
 * can be loaded. The indexes always travel as request-tail catalog data.
 */
export function buildMainSessionAutoMemoryPrompt(
  config: Config,
  memoryDir: string,
  indexContent: string | null,
  userSection: UserAutoMemorySection,
  teamSection: TeamAutoMemorySection | undefined,
): string {
  const reference = buildAutoMemoryReferenceSection(
    resolveBundledReferenceRoute(config, AUTO_MEMORY_SKILL_NAME),
  );
  if (reference === undefined) {
    return buildManagedAutoMemoryPrompt(
      memoryDir,
      indexContent,
      userSection,
      teamSection,
      { includeIndexes: false },
    );
  }
  return buildResidentAutoMemoryPrompt(
    memoryDir,
    userSection,
    teamSection,
    reference,
  );
}
