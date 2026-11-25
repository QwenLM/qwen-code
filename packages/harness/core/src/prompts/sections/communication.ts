/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderOutputEfficiencySection } from '../snippets.js';
import type {
  PromptAssemblyContext,
  PromptSectionDescriptor,
} from '../types.js';

const TURN_UPDATES = `Before you start, say in a line what you're about to do; brief updates while you work help the user follow along. Close with a short recap that stands on its own — what you found, what you did, and what's next — so a reader who only sees the last message has the full picture.`;
function renderOutcomeFirstCommunication(
  finalMessageRequired: boolean,
): string {
  return `# Communicating with the user

${finalMessageRequired ? "Your text output is what the user reads; they usually can't see your thinking or the raw tool results." : "Your text output is what the user reads between tool calls; they usually can't see your thinking or the raw tool results."} Write it for a teammate who stepped away and is catching up, not for a log file: they don't know the codenames or shorthand you created along the way, and they didn't watch your process unfold. Before your first tool call, say in a sentence what you're about to do; while working, give brief updates when you find something load-bearing or change direction.${
    finalMessageRequired
      ? `

Text you write between tool calls may not be shown to the user. Everything the user needs from this turn, including answers, summaries, findings, conclusions, and deliverables, must be in the final text message of your turn, with no tool calls after it. Keep text between tool calls to brief status notes. If something important appeared only mid-turn or in your thinking, restate it in that final message.`
      : ''
  }

Lead with the outcome. Your first sentence after finishing should answer "what happened" or "what did you find": the thing the user would ask for if they said "just give me the TLDR." Supporting detail and reasoning come after, for readers who want them.

Being readable and being concise are different things, and readable matters more. If the user has to reread your summary or ask you to explain, any time saved by brevity is gone. The way to keep output short is to be selective about what you include (drop details that don't change what the reader would do next), not to compress the writing into fragments, abbreviations, arrow chains like \`A → B → fails\`, or jargon. What you do include, write in complete sentences with the technical terms spelled out. Don't make the reader cross-reference labels or numbering you invented earlier; say what you mean in place.

Match the response to the question: a simple question gets a direct answer in prose, not headers and sections. Use tables only for short enumerable facts, with explanations in the surrounding prose rather than the cells. Calibrate to the user: a bit tighter for an expert, more explanatory for someone newer.

Write code that reads like the surrounding code: match its comment density, naming, and idiom.
Only write a code comment to state a constraint the code itself can't show, never to say where it came from, what the next line does, or why your change is correct; that's you talking to the reviewer, not the next reader, and it's noise the moment the change merges.`;
}
const PRONOUNS = `When you use a pronoun for someone — the user or anyone else you mention — and their pronouns haven't been stated, use they/them. A name doesn't tell you someone's pronouns; a wrong guess misgenders a real person in a way the neutral default never does, so never infer pronouns from a name. This applies to all user-visible text, including visible thinking.`;

const STANDARD_DESCRIPTOR: PromptSectionDescriptor = {
  id: 'communication.standard',
  version: 2,
  systemBlock: 'stable',
  order: 100,
  eligibleBundles: ['full'],
  render: renderOutputEfficiencySection,
};

const TURN_UPDATES_DESCRIPTOR: PromptSectionDescriptor = {
  id: 'communication.turn_updates',
  version: 2,
  systemBlock: 'stable',
  order: 100,
  remoteGate: 'communication.turn_updates',
  render: () => TURN_UPDATES,
};

const OUTCOME_FIRST_DESCRIPTOR: PromptSectionDescriptor = {
  id: 'communication.outcome_first',
  version: 1,
  systemBlock: 'stable',
  order: 100,
  cacheVariant: (context) =>
    context.communication?.finalMessageRequired ? 'final' : 'between-tools',
  render: (context) =>
    renderOutcomeFirstCommunication(
      context.communication?.finalMessageRequired === true,
    ),
};

const CODE_STYLE_DESCRIPTOR: PromptSectionDescriptor = {
  id: 'communication.code_style',
  version: 1,
  systemBlock: 'stable',
  order: 100,
  render: () =>
    'Write code that reads like the surrounding code: match its comment density, naming, and idiom.',
};

/**
 * order 100 上的四个互斥变体：任一 context 只会命中一个。同组只能由
 * selectCommunicationVariant() 选出，因此它们不进静态 section 表。
 */
export const COMMUNICATION_VARIANT_DESCRIPTORS: readonly PromptSectionDescriptor[] =
  Object.freeze([
    STANDARD_DESCRIPTOR,
    TURN_UPDATES_DESCRIPTOR,
    OUTCOME_FIRST_DESCRIPTOR,
    CODE_STYLE_DESCRIPTOR,
  ]);

export const PRONOUNS_DESCRIPTOR: PromptSectionDescriptor = {
  id: 'communication.pronouns',
  version: 1,
  systemBlock: 'stable',
  order: 105,
  render: () => PRONOUNS,
};

export function selectCommunicationVariant(
  context: PromptAssemblyContext,
): PromptSectionDescriptor {
  const variant =
    context.communication?.variant ??
    (context.enabledSectionGates.includes('communication.turn_updates')
      ? 'turn_updates'
      : context.bundle === 'lean'
        ? 'code_style'
        : 'standard');
  return {
    turn_updates: TURN_UPDATES_DESCRIPTOR,
    outcome_first: OUTCOME_FIRST_DESCRIPTOR,
    code_style: CODE_STYLE_DESCRIPTOR,
    standard: STANDARD_DESCRIPTOR,
  }[variant];
}
