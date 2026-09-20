/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview How the model reaches the bundled `agent-delegation` reference.
 *
 * Prompt-writing craft is the part of the Agent tool's guidance that only the
 * turn actually briefing an agent needs, while the tool's description is paid
 * for on every turn of every session (#12054). It therefore lives in a bundled
 * skill, and the description carries a pointer — or, where no skill can be
 * loaded, the reference itself. The four-way decision is shared with the
 * `workflow-authoring` reference; see `bundled-reference.ts`.
 *
 * What stays in the description on purpose: when to delegate at all, how a
 * background agent reports back, the rules against peeking, racing and
 * relaunching, disjoint write scopes for concurrent agents, and the fork facts
 * that shape the call (`fork_turns`, no `model` on a fork, pass a `name`). A
 * model that never loads this skill still makes correct, safe calls; it just
 * writes a less well-briefed prompt.
 */

import type { Config } from '../config/config.js';
import { ToolDisplayNames } from '../tools/tool-names.js';
import {
  readBundledReference,
  resolveBundledReferenceSurface,
  toolSearchRevealSentence,
  type BundledReference,
  type BundledReferenceSurface,
} from './bundled-reference.js';

/** Name of the bundled reference, as the model would invoke it. */
export const AGENT_DELEGATION_SKILL_NAME = 'agent-delegation';

export function resolveAgentDelegationSurface(
  config: Config,
): BundledReferenceSurface {
  return resolveBundledReferenceSurface(config, AGENT_DELEGATION_SKILL_NAME);
}

const POINTER = `## Writing the prompt

Before writing a delegation prompt, load the \`${AGENT_DELEGATION_SKILL_NAME}\` skill — what to put in the prompt, what not to delegate, how a fork prompt differs, and a worked example.`;

/**
 * Leads the inlined reference, mirroring the workflow reference's note: the
 * body is written for sessions that can load skills, so say up front that the
 * pointers inside it do not apply here. A rule separator follows, because the
 * body opens with its own title and would otherwise read as a continuation of
 * the fork section above it.
 */
const INLINE_NOTE =
  'Skills cannot be loaded in this session, so the delegation reference follows in full.';

/**
 * The Agent tool's prompt-writing section for this session.
 *
 * Empty when the user turned the reference off — inlining would put back, at
 * the per-turn price, exactly the text they asked to remove.
 */
export function buildAgentDelegationSection(
  surface: BundledReferenceSurface,
  // Defaults to the real file read so that, in a session where skills are
  // enabled but the file is somehow missing, the caller still gets a pointer
  // rather than nothing. Tests can inject a stub.
  reference: BundledReference | null = readBundledReference(
    AGENT_DELEGATION_SKILL_NAME,
  ),
): string {
  switch (surface) {
    case 'pointer':
      return POINTER;
    case 'pointer-via-tool-search':
      return `${POINTER} ${toolSearchRevealSentence(ToolDisplayNames.SKILL)}`;
    case 'inline':
      return reference
        ? `${INLINE_NOTE}\n\n---\n\n${reference.body.trim()}`
        : POINTER;
    case 'withheld':
      return '';
    default: {
      // Typed `never` so a new surface is a compile error rather than a
      // silently empty section.
      const unhandled: never = surface;
      return unhandled;
    }
  }
}
