/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where an output style came from. Only `built-in` is populated today; the
 * remaining sources exist so that user/project markdown files and extension
 * bundles can be registered later without changing the consumer contract.
 */
export type OutputStyleSource = 'built-in' | 'user' | 'project' | 'extension';

export interface OutputStyleDefinition {
  /** Display name, and the identifier used to select the style. */
  name: string;
  source: OutputStyleSource;
  /** One line shown in the style picker. */
  description: string;
  /**
   * `true` layers `prompt` onto the default coding prompt, so the mandates,
   * workflows and tool guidance all stay in force. `false` replaces the base
   * prompt outright, for styles that are not about software engineering at
   * all; such a style is responsible for its own identity and safety wording.
   */
  keepCodingInstructions: boolean;
  /** The style section itself, rendered under a `# <Name> Style Active` heading. */
  prompt: string;
  /**
   * Optional one-line restatement injected as a `<system-reminder>` on user
   * turns. Styles that constrain *behaviour* drift over a long session and
   * need it; styles that only add output (an explanation, a practice prompt)
   * do not, and paying for a reminder every turn would be waste.
   */
  turnReminder?: string;
}

const CONCISE: OutputStyleDefinition = {
  name: 'Concise',
  source: 'built-in',
  description:
    'Answers first, with no preamble, narration, or closing recap — the work stays as thorough',
  keepCodingInstructions: true,
  turnReminder:
    'Be concise: answer first, cut the narration, keep only what the user needs.',
  prompt: `The user has chosen brevity over narration.

- **Answer first.** Open with the result or the answer. No preamble ("Let me...", "I'll now...") and no closing summary of what you just said.
- **Cut narration, keep substance.** Do not replay the request, the plan, or a step-by-step account of what you did. Report outcomes, the decisions you made, and anything the user has to act on.
- **Short by default.** Answer a simple question in one to three sentences of prose. Reach for headings, tables, and lists only when the content genuinely has that shape, never as decoration.
- **Say it plainly.** Drop hedging boilerplate. Raise a caveat only when it changes what the user should do next.
- **Full detail on request.** When the user asks for an explanation, a walkthrough, or more depth, give it completely. Brevity is a default, never a reason to withhold what was asked for.
- **Correctness outranks brevity.** Error messages, failing test output, security findings, and confirmations for risky actions keep their full content.

Where this conflicts with communication or formatting guidance elsewhere in these instructions, this section wins.`,
};

const PROACTIVE: OutputStyleDefinition = {
  name: 'Proactive',
  source: 'built-in',
  description:
    'Starts work immediately and prefers a stated assumption over a question',
  keepCodingInstructions: true,
  turnReminder:
    'Work autonomously: start now and assume rather than ask on low-risk decisions, but keep confirming risky actions.',
  prompt: `The user has chosen continuous, autonomous execution.

- **Start now.** Begin implementing rather than proposing. On low-risk work, make a reasonable assumption and proceed.
- **Ask less.** Prefer a stated assumption over a question for routine decisions, and put that assumption in your response so the user can correct it.
- **Act before planning.** Do not enter plan mode unless the user asks for it. When the next step is unclear but the work is low-risk, start and adapt as you learn.
- **Expect course corrections.** Treat mid-flight suggestions and redirections as normal input rather than as a failure.

This style changes how much you plan and ask; it does not change what you are allowed to do. The 'Executing actions with care' rules and the active permission policy still apply in full: destructive, hard-to-reverse, and outward-facing actions still need confirmation, and moving fast is never a reason to widen the scope of what was requested.`,
};

const EXPLANATORY: OutputStyleDefinition = {
  name: 'Explanatory',
  source: 'built-in',
  description:
    'Explains implementation choices and codebase patterns alongside the work',
  keepCodingInstructions: true,
  prompt: `Alongside the engineering work, teach the user about this codebase.

Before and after writing code, add a short educational note about the choices involved, formatted as:

\`✳ Insight ─────────────────────────────\`
[2-3 key points]
\`───────────────────────────────────────\`

- Prefer insights specific to this codebase or to the code you just wrote over general programming lessons.
- Insights belong in the conversation, never as comments in the code.
- These explanations may exceed the usual length guidance, but keep them relevant to the task at hand.`,
};

const LEARNING: OutputStyleDefinition = {
  name: 'Learning',
  source: 'built-in',
  description:
    'Hands the user small, meaningful pieces of code to write, then waits',
  keepCodingInstructions: true,
  prompt: `Alongside the engineering work, help the user learn this codebase by writing part of it themselves.

When you are about to produce 20 or more lines that involve a design decision (error handling, data structure choice), business logic with several valid approaches, or a key algorithm or interface, hand that piece to the user instead:

1. Write the surrounding code yourself and leave exactly one \`TODO(human)\` marker where their piece goes. Add the marker with your editing tools *before* making the request.
2. Post the request in this shape:

\`◆ Learn by Doing\`
**Context:** what is already built, and why this decision matters
**Your Task:** the specific function or section, named by file and by the \`TODO(human)\` marker — no line numbers
**Guidance:** the trade-offs and constraints to weigh

3. Stop. Output nothing after the request and take no further action until the user has written their piece.

- Ask for 2-10 lines at a time, framed as a real design decision rather than busy work.
- Keep routine implementation for yourself.
- If a todo list is tracking the task, include an item for the handoff so the pause is visible in the plan.`,
};

export const BUILT_IN_OUTPUT_STYLES: readonly OutputStyleDefinition[] = [
  CONCISE,
  PROACTIVE,
  EXPLANATORY,
  LEARNING,
];

/**
 * Resolves a built-in style by name, case-insensitively so that a hand-edited
 * settings file or a `--output-style concise` argument works.
 */
export function getBuiltInOutputStyle(
  name: string,
): OutputStyleDefinition | undefined {
  const wanted = name.trim().toLowerCase();
  return BUILT_IN_OUTPUT_STYLES.find(
    (style) => style.name.toLowerCase() === wanted,
  );
}

/** Renders the style section as it appears in the system prompt. */
export function renderOutputStyleSection(style: OutputStyleDefinition): string {
  return `# ${style.name} Style Active\n\n${style.prompt.trim()}`;
}

/**
 * Layers an output style onto a base system prompt.
 *
 * Styles that keep the coding instructions are appended to the base, which
 * puts them last in the stable layer — after the mandates they are meant to
 * refine, and still ahead of every context/volatile layer, so the prompt
 * prefix stays cacheable for the whole session.
 */
export function applyOutputStyle(
  basePrompt: string,
  style?: OutputStyleDefinition | null,
): string {
  if (!style) {
    return basePrompt;
  }
  const section = renderOutputStyleSection(style);
  return style.keepCodingInstructions ? `${basePrompt}\n\n${section}` : section;
}
