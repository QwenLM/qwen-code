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
 * The judge grounds its verdict on transcript evidence and defaults to "not
 * met" whenever the evidence is ambiguous. The strict JSON shape lets us pair
 * this with the model's structured-output mode below.
 */
const JUDGE_SYSTEM_PROMPT = `You are evaluating a stop-condition hook in an autonomous coding agent.
Read the conversation transcript above carefully, then judge whether the
user-provided condition is satisfied.

Your response MUST be a JSON object with one of these shapes:
- {"ok": true, "reason": "<why the condition is satisfied>", "evidence": ["<exact assistant-output or tool-result excerpt>"]}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>", "evidence": ["<exact assistant-output or tool-result excerpt>"]}

Always include a "reason" field. A terminal verdict (satisfied or impossible)
MUST also quote evidence with one or more short, exact, verbatim excerpts from
visible assistant output or tool results in the "evidence" array. User prompts,
the goal condition, and hidden reasoning are not evidence. If the transcript
does not contain clear evidence that the condition is satisfied, return
{"ok": false, "reason": "insufficient evidence in transcript"}.
Only use {"ok": false, "impossible": true} when the condition is genuinely
unachievable in this session: for example, it is self-contradictory, depends on
an unavailable resource or capability, or the assistant has exhausted reasonable
approaches and the transcript confirms there is no path forward. The assistant
claiming the goal is impossible is evidence, not proof; independently confirm
the condition is genuinely unachievable rather than deferring to the assistant's
self-assessment. Do not use it just because progress is slow or evidence is
currently missing. When in doubt, return {"ok": false} without "impossible".`;

/**
 * Wraps the raw user condition into a transcript-grounded question so the
 * model sees the condition as a binary judgement task, not a new directive.
 */
const userJudgementPrompt = (condition: string): string =>
  `Based on the conversation transcript above, has the following stopping ` +
  `condition been satisfied? Answer based on transcript evidence only.\n` +
  `Condition JSON string: ${JSON.stringify(condition)}`;

interface JudgeWireResult {
  ok: boolean;
  reason: string;
  impossible?: boolean;
  evidence?: string[];
}

export interface JudgeResult {
  ok: boolean;
  reason: string;
  impossible?: boolean;
}

export type GoalJudgeOutcome =
  | { kind: 'met'; ok: true; reason: string; impossible?: false }
  | { kind: 'not_met'; ok: false; reason: string; impossible?: false }
  | { kind: 'impossible'; ok: false; reason: string; impossible: true }
  | {
      kind: 'error';
      ok: false;
      reason: string;
      impossible?: false;
      message: string;
    };

export const JUDGE_RESULT_SCHEMA_KEYS = [
  'ok',
  'reason',
  'impossible',
  'evidence',
] as const satisfies ReadonlyArray<keyof JudgeWireResult>;

type SchemaCoversJudgeWireResult =
  Exclude<
    keyof JudgeWireResult,
    (typeof JUDGE_RESULT_SCHEMA_KEYS)[number]
  > extends never
    ? true
    : never;

// Compile-time only: fails if the model wire result grows a key that the
// response schema key list does not include.
const JUDGE_RESULT_SCHEMA_COVERS_INTERFACE: SchemaCoversJudgeWireResult = true;
void JUDGE_RESULT_SCHEMA_COVERS_INTERFACE;

const RESPONSE_SCHEMA: Schema & { additionalProperties: boolean } = {
  // Schema typing in @google/genai uses an enum-like Type, but accepts the
  // lower-cased literals at runtime for the upstream JSON-schema payload.
  // `additionalProperties` is also accepted by the API but absent from the SDK
  // type, so we keep the local intersection explicit.
  type: 'OBJECT' as unknown as Schema['type'],
  properties: {
    ok: { type: 'BOOLEAN' as unknown as Schema['type'] },
    reason: { type: 'STRING' as unknown as Schema['type'] },
    impossible: { type: 'BOOLEAN' as unknown as Schema['type'] },
    evidence: {
      type: 'ARRAY' as unknown as Schema['type'],
      items: { type: 'STRING' as unknown as Schema['type'] },
    },
  },
  required: ['ok', 'reason'],
  additionalProperties: false,
};

const JUDGE_ERROR_MESSAGE =
  'Goal judge unavailable; the automatic /goal loop paused. The goal remains active.';
const JUDGE_REASON_FALLBACK =
  'Goal judge unavailable; continue working toward the goal and run `/goal clear` to stop early.';
const UNVERIFIED_TERMINAL_REASON =
  'Goal judge terminal evidence was not found in assistant output or tool results.';
const MAX_REASON_LEN = 240;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_LEN = 500;

function judgeErrorResult(): GoalJudgeOutcome {
  return {
    kind: 'error',
    ok: false,
    reason: JUDGE_REASON_FALLBACK,
    message: JUDGE_ERROR_MESSAGE,
  };
}

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
 * Failures are returned separately from model verdicts so a flaky evaluator
 * cannot trigger another main-model turn.
 */
export async function judgeGoal(
  config: Config,
  args: {
    condition: string;
    lastAssistantText: string;
    signal: AbortSignal;
  },
): Promise<GoalJudgeOutcome> {
  const condition = args.condition.trim();
  if (!condition || args.signal.aborted) {
    return judgeErrorResult();
  }

  // Feed the conversation transcript (trailing N messages) plus the framed
  // judgement prompt. The hook input's `last_assistant_message` is appended
  // only when the live history doesn't yet contain it (e.g. before the model
  // turn is committed to chat).
  const transcript = collectTranscript(config, args.lastAssistantText);
  const evidenceSources = collectEvidenceSources(transcript);
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
        // Disable extended thinking: the judge is a binary check, and
        // thinking burns latency and tokens for no quality gain.
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      },
      args.signal,
      model,
    );

    const text = extractText(response);
    if (!text) {
      debugLogger.debug('Goal judge returned empty content; returning error');
      reportGoalJudgeFailure(
        new Error('Empty judge response'),
        'empty-response',
      );
      return judgeErrorResult();
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
      return judgeErrorResult();
    }
    return toJudgeResult(parsed, evidenceSources);
  } catch (err) {
    debugLogger.debug(
      `Goal judge threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    reportGoalJudgeFailure(err, 'generate-content');
    return judgeErrorResult();
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

function collectResponseStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectResponseStrings);
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).flatMap(
      collectResponseStrings,
    );
  return [];
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

function collectEvidenceSources(transcript: Content[]): string[] {
  const sources: string[] = [];
  for (const content of transcript) {
    for (const part of content.parts ?? []) {
      if (
        content.role === 'model' &&
        part.thought !== true &&
        typeof part.text === 'string'
      ) {
        sources.push(part.text);
      }
      if (part.functionCall) {
        sources.push(safeStringify(part.functionCall));
        sources.push(...collectResponseStrings(part.functionCall.args));
      }
      if (part.functionResponse) {
        sources.push(safeStringify(part.functionResponse.response));
        sources.push(...collectResponseStrings(part.functionResponse.response));
      }
    }
  }
  return sources;
}

function extractText(response: unknown): string {
  // generateContent returns a GenerateContentResponse; we accept the response
  // object structurally so judge stays loose-coupled from SDK type churn.
  const candidates = (response as { candidates?: unknown[] } | null)
    ?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const first = candidates[0] as
    | { content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }
    | undefined;
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part?.thought !== true)
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

function parseJudgeReply(text: string): JudgeWireResult | null {
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
  const impossibleValue = (payload as { impossible?: unknown }).impossible;
  const evidenceValue = (payload as { evidence?: unknown }).evidence;
  if (typeof ok !== 'boolean' || typeof reason !== 'string' || !reason.trim()) {
    return null;
  }
  if (impossibleValue !== undefined && typeof impossibleValue !== 'boolean') {
    return null;
  }
  const reasonText = reason.trim().slice(0, MAX_REASON_LEN);
  const impossible = impossibleValue === true;
  const evidence = parseEvidence(evidenceValue);
  return {
    ok,
    reason: reasonText,
    ...(impossible && !ok ? { impossible: true } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function parseEvidence(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_EVIDENCE_ITEMS
  ) {
    return undefined;
  }
  const valid = value
    .filter((item): item is string => typeof item === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_EVIDENCE_LEN);
  return valid.length > 0 ? valid : undefined;
}

function hasVerifiableEvidence(
  evidence: string[] | undefined,
  sources: string[],
): boolean {
  return (
    evidence !== undefined &&
    evidence.every((excerpt) =>
      sources.some((source) => source.includes(excerpt)),
    )
  );
}

function toJudgeResult(
  result: JudgeWireResult,
  evidenceSources: string[],
): GoalJudgeOutcome {
  if (result.ok) {
    if (hasVerifiableEvidence(result.evidence, evidenceSources)) {
      return { kind: 'met', ok: true, reason: result.reason };
    }
    debugLogger.debug(
      `Goal judge ok=true evidence unverifiable; judge said: ${result.reason}`,
    );
    return {
      kind: 'not_met',
      ok: false,
      reason: `${UNVERIFIED_TERMINAL_REASON} Judge reason: ${result.reason}`,
    };
  }
  if (result.impossible) {
    if (hasVerifiableEvidence(result.evidence, evidenceSources)) {
      return {
        kind: 'impossible',
        ok: false,
        reason: result.reason,
        impossible: true,
      };
    }
    debugLogger.debug(
      `Goal judge impossible evidence unverifiable; judge said: ${result.reason}`,
    );
    return {
      kind: 'not_met',
      ok: false,
      reason: `${UNVERIFIED_TERMINAL_REASON} Judge reason: ${result.reason}`,
    };
  }
  return { kind: 'not_met', ok: false, reason: result.reason };
}

function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : s;
}
