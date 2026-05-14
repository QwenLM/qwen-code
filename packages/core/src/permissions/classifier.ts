/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUTO approval mode LLM classifier.
 *
 * Two-stage flow:
 *   Stage 1 (fast):  shouldBlock-only output, max_tokens=32, thinking off.
 *                    Allow path returns immediately (~300ms).
 *   Stage 2 (review): full output { thinking, shouldBlock, reason },
 *                     max_tokens=4096, thinking on. Reviews stage-1 blocks
 *                     to reduce false positives.
 *
 * Fail-closed: any non-abort failure (API error, timeout, schema failure,
 * context overflow) returns shouldBlock=true with unavailable=true.
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { isContextLengthExceededError } from '../utils/contextLengthError.js';
import { runSideQuery } from '../utils/sideQuery.js';
import {
  buildClassifierSystemPrompt,
  STAGE1_SUFFIX,
  STAGE2_SUFFIX,
} from './classifier-prompts/system-prompt.js';
import { buildClassifierContents } from './classifier-transcript.js';

/** Stage-1 timeout: fast model p99 is ~1.5s; 3s catches stuck cases. */
export const STAGE1_TIMEOUT_MS = 3_000;
/** Stage-2 timeout: thinking takes longer; 10s caps infrastructure failure. */
export const STAGE2_TIMEOUT_MS = 10_000;

/** Token usage attributed to a single classifier call. */
export interface ClassifierUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Input to the classifier orchestrator. */
export interface ClassifierInput {
  toolName: string;
  toolParams: Record<string, unknown>;
  /** Main session history. Transcript construction strips assistant text and
   *  tool results — see classifier-transcript module. Forwarded by reference
   *  (read-only). */
  messages: readonly Content[];
  config: Config;
  signal: AbortSignal;
}

/** Outcome of a classifier call. */
export interface ClassifierResult {
  /** True when the action should be blocked. */
  shouldBlock: boolean;
  /**
   * One short sentence shown to the user on block (and surfaced in the
   * tool error returned to the main LLM). Empty when `shouldBlock=false`.
   */
  reason: string;
  /** Stage-2 thinking content, when available. Not displayed to user. */
  thinking?: string;
  /** Model name actually used for the call (typically the fast model). */
  model: string;
  /** Wall-clock latency in milliseconds. */
  durationMs: number;
  /** Per-stage token usage; undefined when classifier was unavailable. */
  usage?: ClassifierUsage;
  /**
   * True when the classifier could not respond (API error, timeout,
   * schema failure, context overflow). The caller MUST treat this as a
   * block but distinguish it from a policy block in UI/telemetry — it
   * represents infrastructure failure rather than policy judgement.
   */
  unavailable?: boolean;
  /** Which stage produced the final verdict. */
  stage: 'fast' | 'thinking';
}

// ─── Schemas ────────────────────────────────────────────────────────────

interface Stage1Response {
  shouldBlock: boolean;
}

interface Stage2Response {
  thinking: string;
  shouldBlock: boolean;
  reason: string;
}

const STAGE1_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['shouldBlock'],
  additionalProperties: false,
  properties: { shouldBlock: { type: 'boolean' } },
};

const STAGE2_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['thinking', 'shouldBlock', 'reason'],
  additionalProperties: false,
  properties: {
    thinking: { type: 'string' },
    shouldBlock: { type: 'boolean' },
    reason: { type: 'string' },
  },
};

// ─── Orchestrator ───────────────────────────────────────────────────────

/**
 * Evaluate a pending tool call through the two-stage classifier.
 *
 * Returns a `ClassifierResult` describing the verdict. Throws `AbortError`
 * only when the user-supplied `input.signal` is aborted; all other failures
 * are converted into `unavailable=true` block results (fail-closed).
 */
export async function classifyAction(
  input: ClassifierInput,
): Promise<ClassifierResult> {
  const overallStart = Date.now();
  const contents = buildClassifierContents(
    input.messages,
    input.config.getToolRegistry(),
    { toolName: input.toolName, toolParams: input.toolParams },
  );

  // Build the base prompt once. Stage 2 only fires when stage 1 returns
  // block (~20% of calls per spec); compose its suffix lazily inside the
  // stage-2 branch below.
  const baseSystemPrompt = buildClassifierSystemPrompt(input.config);
  const stage1SystemPrompt = baseSystemPrompt + STAGE1_SUFFIX;

  // Stage 1 ──────────────────────────────────────────────────────────────
  const stage1Signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(STAGE1_TIMEOUT_MS),
  ]);

  let stage1: Stage1Response;
  try {
    stage1 = (await runSideQuery<Stage1Response>(input.config, {
      contents,
      schema: STAGE1_SCHEMA,
      systemInstruction: stage1SystemPrompt,
      abortSignal: stage1Signal,
      purpose: 'permission_classifier_stage1',
      maxAttempts: 2,
      config: {
        temperature: 0,
        maxOutputTokens: 32,
        thinkingConfig: { includeThoughts: false },
      },
    })) as Stage1Response;
  } catch (err) {
    if (input.signal.aborted) throw err;
    return failClosed(
      'Classifier stage 1 unavailable',
      err,
      'fast',
      overallStart,
      input.config,
    );
  }

  if (!stage1.shouldBlock) {
    return {
      shouldBlock: false,
      reason: '',
      model: getModelLabel(input.config),
      durationMs: Date.now() - overallStart,
      stage: 'fast',
    };
  }

  // Stage 2 ──────────────────────────────────────────────────────────────
  const stage2Signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(STAGE2_TIMEOUT_MS),
  ]);

  let stage2: Stage2Response;
  try {
    stage2 = (await runSideQuery<Stage2Response>(input.config, {
      contents,
      schema: STAGE2_SCHEMA,
      systemInstruction: baseSystemPrompt + STAGE2_SUFFIX,
      abortSignal: stage2Signal,
      purpose: 'permission_classifier_stage2',
      maxAttempts: 2,
      config: {
        temperature: 0,
        maxOutputTokens: 4096,
        thinkingConfig: { includeThoughts: true },
      },
    })) as Stage2Response;
  } catch (err) {
    if (input.signal.aborted) throw err;
    // Stage 1 said block; stage 2 review failed. Honor stage 1's signal but
    // surface as unavailable so the UI / denialTracking treat it as
    // infrastructure failure, not a policy decision.
    return {
      shouldBlock: true,
      reason: 'Stage 1 flagged this as risky; stage 2 review was unavailable.',
      unavailable: true,
      model: getModelLabel(input.config),
      durationMs: Date.now() - overallStart,
      stage: 'thinking',
    };
  }

  return {
    shouldBlock: stage2.shouldBlock,
    reason: stage2.shouldBlock ? stage2.reason : '',
    thinking: stage2.thinking,
    model: getModelLabel(input.config),
    durationMs: Date.now() - overallStart,
    stage: 'thinking',
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function failClosed(
  baseMessage: string,
  err: unknown,
  stage: 'fast' | 'thinking',
  startedAt: number,
  config: Config,
): ClassifierResult {
  const reason = isContextLengthExceededError(err)
    ? 'Conversation transcript exceeds classifier context window'
    : `${baseMessage} - blocked for safety`;
  return {
    shouldBlock: true,
    reason,
    unavailable: true,
    model: getModelLabel(config),
    durationMs: Date.now() - startedAt,
    stage,
  };
}

function getModelLabel(config: Config): string {
  return config.getFastModel?.() ?? config.getModel() ?? 'unknown';
}

// Re-export Content type for callers that build inputs.
export type { Content };
