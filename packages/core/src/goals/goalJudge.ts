/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part, Schema } from '@google/genai';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { reportError } from '../utils/errorReporting.js';

const debugLogger = createDebugLogger('GOAL_JUDGE');

/**
 * System prompt for the goal-completion judge.
 *
 * Wording is aligned with Claude Code 2.1.140's `Stop` prompt-hook evaluator
 * (function `cRK` in the compiled binary): it forces the judge to ground its
 * verdict on transcript evidence and to default to "not met" whenever the
 * evidence is ambiguous. The strict JSON shape lets us pair this with the
 * model's structured-output mode below.
 */
const JUDGE_SYSTEM_PROMPT = `You are evaluating a stop-condition hook in an autonomous coding agent.
Read the conversation transcript above carefully, then judge whether the
user-provided condition is satisfied.

Your response MUST be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}

Always include a "reason" field, quoting specific text from the transcript
whenever possible. If the transcript does not contain clear evidence that the
condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.`;

/**
 * Wraps the raw user condition into a transcript-grounded question, matching
 * Claude Code's `Based on the conversation transcript above...` framing so the
 * model sees the condition as a binary judgement task, not a new directive.
 */
const userJudgementPrompt = (condition: string): string =>
  `Based on the conversation transcript above, has the following stopping ` +
  `condition been satisfied? Answer based on transcript evidence only.\n` +
  `Condition JSON string: ${JSON.stringify(condition)}`;

const RESPONSE_SCHEMA: Schema = {
  // Schema typing in @google/genai uses an enum-like Type, but accepts the
  // lower-cased literals at runtime for the upstream JSON-schema payload.
  type: 'OBJECT' as unknown as Schema['type'],
  properties: {
    ok: { type: 'BOOLEAN' as unknown as Schema['type'] },
    reason: { type: 'STRING' as unknown as Schema['type'] },
  },
  required: ['ok', 'reason'],
};

export interface JudgeResult {
  ok: boolean;
  reason: string;
}

const JUDGE_REASON_FALLBACK =
  'Goal judge unavailable; continue working toward the goal and run `/goal clear` to stop early.';
const MAX_REASON_LEN = 240;

function reportGoalJudgeFailure(error: unknown, stage: string): void {
  void reportError(
    error,
    'Goal judge failed',
    { stage },
    `goal-judge-${stage}`,
  ).catch((reportErr) => {
    debugLogger.debug(
      `Goal judge error reporting failed: ${
        reportErr instanceof Error ? reportErr.message : String(reportErr)
      }`,
    );
  });
}

/**
 * Max number of trailing conversation messages we feed to the judge. Capping
 * by message count (rather than tokens) keeps the judge call cheap and avoids
 * runaway costs on long sessions; the most recent turns are also the most
 * relevant to "did we just finish the goal?" decisions.
 */
const TRANSCRIPT_TAIL_MESSAGES = 24;

/** Per-text-part character cap. Same purpose as the message cap above. */
const TRANSCRIPT_PART_CHAR_CAP = 4_000;

/**
 * Calls a small fast model (or the main model if no fast model is configured)
 * to evaluate whether the goal condition holds after the latest turn.
 *
 * Any failure — timeout, non-JSON response, missing fields, aborted signal —
 * is converted into `{ok:false, reason:<fallback>}` so the /goal loop can keep
 * running and the user retains control via `/goal clear`. We deliberately fail
 * "not met" so a flaky judge never short-circuits a real goal.
 */
export async function judgeGoal(
  config: Config,
  args: {
    condition: string;
    lastAssistantText: string;
    signal: AbortSignal;
  },
): Promise<JudgeResult> {
  const condition = args.condition.trim();
  if (!condition) return { ok: false, reason: JUDGE_REASON_FALLBACK };
  if (args.signal.aborted) return { ok: false, reason: JUDGE_REASON_FALLBACK };

  // Feed the conversation transcript (trailing N messages) plus the framed
  // judgement prompt — Claude Code's design. The hook input's
  // `last_assistant_message` is appended only when the live history doesn't
  // yet contain it (e.g. before the model turn is committed to chat).
  const transcript = collectTranscript(config, args.lastAssistantText);
  transcript.push({
    role: 'user',
    parts: [{ text: userJudgementPrompt(condition) }],
  });

  const model = config.getFastModel() ?? config.getModel();

  try {
    const client = config.getGeminiClient();
    const response = await client.generateContent(
      transcript,
      {
        systemInstruction: JUDGE_SYSTEM_PROMPT,
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        // Disable extended thinking — the judge is a binary check; thinking
        // burns latency and tokens for no quality gain. Matches Claude Code's
        // `thinkingConfig: { type: "disabled" }` for the same call.
        thinkingConfig: { thinkingBudget: 0 },
      },
      args.signal,
      model,
    );

    const text = extractText(response);
    if (!text) {
      debugLogger.debug(
        'Goal judge returned empty content; defaulting to not-met',
      );
      reportGoalJudgeFailure(
        new Error('Empty judge response'),
        'empty-response',
      );
      return { ok: false, reason: JUDGE_REASON_FALLBACK };
    }
    const parsed = parseJudgeReply(text);
    if (!parsed) {
      debugLogger.debug(
        `Goal judge reply not parseable as JSON (length=${text.length})`,
      );
      reportGoalJudgeFailure(
        new Error('Judge response was not parseable as JSON'),
        'parse',
      );
      return { ok: false, reason: JUDGE_REASON_FALLBACK };
    }
    return parsed;
  } catch (err) {
    debugLogger.debug(
      `Goal judge threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    reportGoalJudgeFailure(err, 'generate-content');
    return { ok: false, reason: JUDGE_REASON_FALLBACK };
  }
}

/**
 * Pulls the trailing slice of the active session's chat history. Failures
 * fall back to a single synthetic user/assistant pair built from
 * `lastAssistantText`, so the judge always has *some* evidence to look at.
 */
function collectTranscript(
  config: Config,
  lastAssistantText: string,
): Content[] {
  try {
    const client = config.getGeminiClient();
    if (!client.isInitialized()) return fallbackTranscript(lastAssistantText);
    const full = client.getHistoryTail(TRANSCRIPT_TAIL_MESSAGES);
    const tail = full.map(capContent);
    if (tail.length === 0) return fallbackTranscript(lastAssistantText);
    // If the live history's last assistant text doesn't include the supplied
    // `lastAssistantText`, splice it in — the Stop hook can fire before the
    // chat history commit on some code paths.
    const lastModelText = lastModelTextOf(tail);
    const haveLast =
      lastModelText.includes(lastAssistantText) ||
      lastAssistantText.trim() === '';
    if (!haveLast && lastAssistantText.trim()) {
      tail.push({
        role: 'model',
        parts: [{ text: lastAssistantText.slice(0, TRANSCRIPT_PART_CHAR_CAP) }],
      });
    }
    return tail;
  } catch (err) {
    debugLogger.debug(
      `Goal judge transcript fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fallbackTranscript(lastAssistantText);
  }
}

function fallbackTranscript(lastAssistantText: string): Content[] {
  if (!lastAssistantText.trim()) return [];
  return [
    {
      role: 'model',
      parts: [{ text: lastAssistantText.slice(0, TRANSCRIPT_PART_CHAR_CAP) }],
    },
  ];
}

function capContent(content: Content): Content {
  if (!content.parts) return content;
  return {
    ...content,
    parts: content.parts.map(capPart),
  };
}

function capPart(part: Part): Part {
  if (typeof part.text === 'string') {
    return part.text.length > TRANSCRIPT_PART_CHAR_CAP
      ? {
          ...part,
          text: part.text.slice(0, TRANSCRIPT_PART_CHAR_CAP) + '…[truncated]',
        }
      : part;
  }

  if (part.functionResponse) {
    return {
      ...part,
      functionResponse: {
        ...part.functionResponse,
        response: capStructuredValue(
          part.functionResponse.response,
        ) as typeof part.functionResponse.response,
      },
    };
  }

  if (part.functionCall) {
    return {
      ...part,
      functionCall: {
        ...part.functionCall,
        args: capStructuredValue(
          part.functionCall.args,
        ) as typeof part.functionCall.args,
      },
    };
  }

  return part;
}

function capStructuredValue(value: unknown): unknown {
  const serialized = safeStringify(value);
  if (serialized.length <= TRANSCRIPT_PART_CHAR_CAP) return value;
  return {
    truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, TRANSCRIPT_PART_CHAR_CAP) + '…[truncated]',
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function lastModelTextOf(transcript: Content[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const c = transcript[i];
    if (c.role !== 'model') continue;
    return (c.parts ?? [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

function extractText(response: unknown): string {
  // generateContent returns a GenerateContentResponse; we accept the response
  // object structurally so judge stays loose-coupled from SDK type churn.
  const candidates = (response as { candidates?: unknown[] } | null)
    ?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const first = candidates[0] as
    | { content?: { parts?: Array<{ text?: unknown }> } }
    | undefined;
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

function parseJudgeReply(text: string): JudgeResult | null {
  const cleaned = stripCodeFence(text).trim();
  // Accept the JSON anywhere in the reply: tolerant to chatty preambles when
  // the model ignores structured-output mode.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const ok = (payload as { ok?: unknown }).ok;
  const reason = (payload as { reason?: unknown }).reason;
  if (typeof ok !== 'boolean') return null;
  const reasonText =
    typeof reason === 'string' && reason.trim()
      ? reason.trim().slice(0, MAX_REASON_LEN)
      : ok
        ? 'Goal condition reported as met.'
        : JUDGE_REASON_FALLBACK;
  return { ok, reason: reasonText };
}

function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : s;
}
