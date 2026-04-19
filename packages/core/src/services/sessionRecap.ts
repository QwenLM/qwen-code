/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SESSION_RECAP');

const RECENT_MESSAGE_WINDOW = 30;

const RECAP_SYSTEM_PROMPT = `You generate session recaps for a programming assistant CLI.

You receive the most recent turns of a conversation between a user and an
assistant. The user has stepped away and is now returning. Your sole job is
to remind them where they left off so they can resume quickly.

Content rules:
- Exactly 1 to 3 short sentences. Plain prose, no bullets, no headings, no markdown.
- First: the high-level task — what they are building, debugging, or investigating.
- Then: the concrete next step.
- Do NOT list what was done, recite tool calls, or include status reports.
- Match the dominant language of the conversation (English or Chinese).

Output format — strict:
- Wrap your recap in <recap>...</recap> tags.
- Put NOTHING outside the tags. No preamble, no reasoning, no closing remarks.

Example:
<recap>Investigating intermittent CI failures in the auth retry logic. The next step is to add deterministic timing to the integration test so the race condition reproduces locally.</recap>`;

const RECAP_USER_PROMPT =
  'Generate the recap now. Wrap it in <recap>...</recap>. Nothing outside the tags.';

const RECAP_OPEN_TAG = '<recap>';
const RECAP_TAG_RE = /<recap>([\s\S]*?)<\/recap>/i;

export interface SessionRecapResult {
  text: string;
  modelUsed: string;
}

/**
 * Generate a 1-3 sentence "where did I leave off" summary of the current
 * session. Uses the configured fast model (falls back to main model) with
 * tools disabled and a very small generation budget.
 *
 * Returns null on any failure — recap is best-effort and must never break
 * the main flow or surface errors to the user.
 */
export async function generateSessionRecap(
  config: Config,
  abortSignal: AbortSignal,
): Promise<SessionRecapResult | null> {
  try {
    const geminiClient = config.getGeminiClient();
    if (!geminiClient) return null;

    const fullHistory = geminiClient.getChat().getHistory();
    if (fullHistory.length < 2) return null;

    const dialog = filterToDialog(fullHistory);
    const recentHistory = takeRecentDialog(dialog, RECENT_MESSAGE_WINDOW);
    if (recentHistory.length === 0) return null;

    const model = config.getFastModel() ?? config.getModel();

    const response = await geminiClient.generateContent(
      [
        ...recentHistory,
        { role: 'user', parts: [{ text: RECAP_USER_PROMPT }] },
      ],
      {
        systemInstruction: RECAP_SYSTEM_PROMPT,
        tools: [],
        maxOutputTokens: 300,
        temperature: 0.3,
      },
      abortSignal,
      model,
    );

    if (abortSignal.aborted) return null;

    const raw = (response.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text)
      .filter((t): t is string => typeof t === 'string')
      .join('')
      .trim();

    if (!raw) return null;

    const text = extractRecap(raw);
    if (!text) return null;

    return { text, modelUsed: model };
  } catch (err) {
    debugLogger.warn(
      `Recap generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Extract the recap from a model response. Models often emit reasoning
 * before the actual answer; the <recap>...</recap> tag lets us isolate the
 * useful part. If the close tag is missing (e.g., hit token limit mid-output),
 * take everything after the open tag. If the open tag is missing entirely,
 * return empty — better to skip than show the reasoning preamble.
 */
function extractRecap(raw: string): string {
  const tagged = RECAP_TAG_RE.exec(raw);
  if (tagged?.[1]) return tagged[1].trim();

  const openIdx = raw.toLowerCase().indexOf(RECAP_OPEN_TAG);
  if (openIdx === -1) return '';
  return raw.slice(openIdx + RECAP_OPEN_TAG.length).trim();
}

/**
 * Strip tool calls and tool responses from history; keep only user prompts
 * and the model's text replies. A single tool response can hold a 10K-token
 * file dump that drowns the recap LLM in irrelevant detail.
 *
 * Each remaining message keeps only its text parts, and messages with no
 * text are dropped entirely.
 */
function filterToDialog(history: Content[]): Content[] {
  const out: Content[] = [];
  for (const msg of history) {
    if (msg.role !== 'user' && msg.role !== 'model') continue;
    const textParts = (msg.parts ?? []).filter(
      (part) => typeof part?.text === 'string' && part.text.trim() !== '',
    );
    if (textParts.length === 0) continue;
    out.push({ role: msg.role, parts: textParts });
  }
  return out;
}

/**
 * Take the most recent N messages while preserving turn structure: never
 * start the slice on a tool/model response that would dangle without its
 * preceding user message.
 */
function takeRecentDialog(history: Content[], windowSize: number): Content[] {
  if (history.length <= windowSize) return history;
  let start = history.length - windowSize;
  while (start < history.length && history[start]?.role !== 'user') {
    start++;
  }
  return history.slice(start);
}
