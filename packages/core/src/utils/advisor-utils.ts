/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/** Maximum focus length (chars) accepted by the /advisor slash command. */
export const ADVISOR_MAX_INPUT_LENGTH = 4096;

export function buildAdvisorPrompt(focus: string): string {
  return [
    '<system-reminder>',
    'You are acting as an ADVISOR — an independent senior reviewer giving a second opinion on the conversation so far. The transcript above may be truncated to the most recent turns; treat what is shown as the evidence available to you.',
    '',
    'CRITICAL CONSTRAINTS:',
    '- You have NO tools. Base every claim strictly on evidence present in the transcript; never claim to have verified something you could not observe.',
    '- Do not perform the task or write the implementation. Review only.',
    '- Be direct about problems: flawed assumptions, premature conclusions, unverified claims, risky next steps.',
    '- The main conversation is NOT interrupted; your review is shown to the user only.',
    '',
    'Respond in markdown with exactly these sections:',
    '## Verdict — one short paragraph: is the current approach or conclusion sound?',
    '## Risks — concrete risks or flawed assumptions, each citing transcript evidence. Write "None found" if none.',
    '## Missing evidence — claims asserted but not verified in the visible transcript (earlier verification may exist outside the shown window).',
    '## Recommendation — the single most valuable next action.',
    '</system-reminder>',
    '',
    focus || 'Review the conversation above.',
  ].join('\n');
}
