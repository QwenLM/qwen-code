/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { withoutAutoMemorySnapshots } from '@qwen-code/qwen-code-core/memory/request-context.js';
import { runSideQuery } from '@qwen-code/qwen-code-core/utils/sideQuery.js';

const RECENT_CONTENTS = 6;
const MAX_CONVERSATION_CHARS = 3000;
const MAX_SUMMARY_CHARS = 120;

const SUMMARY_SYSTEM_PROMPT = `You write the one-line status shown next to a background coding session in a list of sessions.

Rules:
- One line, at most 12 words.
- Say what the session did or found, in plain words. Lead with the outcome.
- No markdown, quotes, emoji, or trailing period.
- Output only the line.`;

/**
 * Asks the model (the fast model when one is configured) for a one-line
 * summary of the latest turn, for the Agent View roster. Returns undefined
 * when there is nothing to summarize or the request fails.
 */
export async function summarizeAgentViewTurn(
  config: Config,
  abortSignal: AbortSignal,
): Promise<string | undefined> {
  try {
    const history = withoutAutoMemorySnapshots(
      config.getLlmClient()?.getHistoryShallow() ?? [],
    );
    const conversation = flattenTail(history.slice(-RECENT_CONTENTS));
    if (!conversation) return undefined;

    const result = await runSideQuery(config, {
      purpose: 'agent-view-summary',
      systemInstruction: SUMMARY_SYSTEM_PROMPT,
      contents: [
        {
          role: 'user',
          parts: [{ text: `Latest conversation:\n${conversation}` }],
        },
      ],
      config: { temperature: 0.2 },
      abortSignal,
      maxAttempts: 1,
    });
    return cleanSummary(result.text);
  } catch {
    return undefined;
  }
}

function flattenTail(contents: Content[]): string {
  const text = contents
    .map((content) => {
      const parts = (content.parts ?? [])
        .map((part) => (part.thought ? '' : (part.text ?? '')))
        .join('')
        .trim();
      return parts ? `${content.role ?? 'user'}: ${parts}` : '';
    })
    .filter(Boolean)
    .join('\n');
  return text.slice(-MAX_CONVERSATION_CHARS).trim();
}

export function cleanSummary(raw: string | undefined): string | undefined {
  const line = (raw ?? '')
    .split('\n')
    .map((value) => value.trim())
    .find(Boolean)
    ?.replace(/^["'`*#\-\s]+|["'`*\s]+$/g, '')
    .replace(/\.$/, '')
    .trim();
  if (!line) return undefined;
  return line.length > MAX_SUMMARY_CHARS
    ? `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : line;
}
