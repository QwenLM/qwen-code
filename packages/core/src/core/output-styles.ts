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
   * `false` omits exactly one section of the base prompt — the
   * software-engineering workflow guidance — for a style whose work is not
   * coding. Identity, mandates, safety rules, tool guidance and tone are kept
   * either way; a style never switches those off.
   */
  keepCodingInstructions: boolean;
  /** The style section itself, rendered under the `# Output Style: <name>` heading. */
  prompt: string;
  /**
   * Overrides the generic wording of the per-turn reminder. Every active style
   * is reminded each turn; this only replaces
   * `DEFAULT_OUTPUT_STYLE_TURN_REMINDER` with something style-specific.
   */
  turnReminder?: string;
}

/** Generic reminder wording for a style that does not supply its own. */
export const DEFAULT_OUTPUT_STYLE_TURN_REMINDER =
  'Remember to follow the specific guidelines for this style.';

const CONCISE: OutputStyleDefinition = {
  name: 'Concise',
  source: 'built-in',
  description:
    'Answers first, with no preamble, narration, or closing recap — the work stays as thorough as ever',
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

/**
 * Renders the style section as it appears in the system prompt.
 *
 * The `# Output Style: <name>` wrapper is the contract a custom style file
 * relies on: the file's body becomes `prompt` verbatim and this heading is
 * what names it in the prompt.
 */
export function renderOutputStyleSection(style: OutputStyleDefinition): string {
  return `# Output Style: ${style.name}\n${style.prompt.trim()}`;
}

/**
 * The per-turn reminder line for an active style.
 *
 * Every non-default style gets one; `turnReminder` only replaces the generic
 * wording. Styles drift over a long session — a style that only adds output
 * drifts just as readily as one that constrains behaviour.
 */
export function getOutputStyleTurnReminder(
  style: OutputStyleDefinition,
): string {
  return `${style.name} output style is active. ${
    style.turnReminder ?? DEFAULT_OUTPUT_STYLE_TURN_REMINDER
  }`;
}

/**
 * Appends an output style's section to a base system prompt.
 *
 * The section lands last in the stable layer — after the mandates it refines,
 * and ahead of every context/volatile layer, so a session's prompt prefix
 * stays stable for its whole life. `keepCodingInstructions` is not consulted
 * here: it selects which sections the base prompt was built from, not whether
 * the style is appended.
 */
export function applyOutputStyle(
  basePrompt: string,
  style?: OutputStyleDefinition | null,
): string {
  if (!style) {
    return basePrompt;
  }
  return `${basePrompt}\n\n${renderOutputStyleSection(style)}`;
}
