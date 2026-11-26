/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import stableStringify from 'json-stable-stringify';
import {
  ENV_REPEATED_TOOL_CALL_THRESHOLD,
  readBrandEnv,
} from '../config/brand.js';
import type { ModelToolUseBlock } from '../provider/event/modelCompleteEvent.js';

// ---------------------------------------------------------------------------
// Continuation confirmation
//
// Asking the user something that is not a permission question.
//
// The doom-loop guard needs a prompt — "you have asked for this same call N
// times, carry on?" — and it is deliberately *not* routed through
// `checkPermission`. There is no tool check to run, no rule that could answer
// it and no mode that should skip it: the question is about the shape of the
// conversation, not about whether a tool may act. Sending it through the
// permission manager would mean inventing a checker whose only job is to
// always ask, and then every mode and every rule would get a vote on
// something they know nothing about.
//
// So it has its own seam. The host implements it with the same queue and the
// same dialog the permission prompts use — sharing the UI is the point —
// while the decision path stays separate.
// ---------------------------------------------------------------------------

/** What the user is being asked to confirm. */
export interface ContinuationRequest {
  /** Discriminates the prompt so the UI can render the right body. */
  readonly kind: string;
  readonly title: string;
  /** The tool the loop is stuck on. */
  readonly toolName: string;
  /** How many times in a row it has been requested identically. */
  readonly repeatCount: number;
  /** The threshold that tripped the guard. */
  readonly threshold: number;
  /** A short rendering of the repeated input. */
  readonly inputPreview?: string;
  /** Cancellation. A cancelled turn must take the prompt down with it. */
  readonly signal?: AbortSignal;
}

/**
 * How the user answered.
 *
 * `once` and `session` differ in scope exactly as they do in a permission prompt,
 * which is why the words are the same: a query can compare a doom-loop choice
 * against an ordinary permission choice without translating.
 */
export type ContinuationDecision =
  | { outcome: 'once'; updatedInput?: Record<string, unknown> }
  | { outcome: 'session'; updatedInput?: Record<string, unknown> }
  | { outcome: 'deny'; reason?: string };

/**
 * The host's prompt for a non-permission confirmation.
 *
 * Absent means there is nobody to ask — a headless run, a fork — and the caller
 * must then decide for itself. It must not assume approval.
 */
export type ConfirmContinuation = (
  request: ContinuationRequest,
) => Promise<ContinuationDecision>;

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export const REPEATED_TOOL_CALL_THRESHOLD = 5;
export const REPEATED_TOOL_CALL_TERMINAL_REASON =
  'repeated_tool_call_denied' as const;
export const REPEATED_TOOL_CALL_PERMISSION_KIND =
  'repeated_tool_call' as const;
export const REPEATED_TOOL_CALL_DECISION_REASON_TYPE =
  'repeatedToolCall' as const;
const DEFAULT_SESSION_ALLOWED_KEY_LIMIT = 128;

export interface DoomLoopGuardOptions {
  threshold?: number;
  sessionAllowedKeys?: Set<string>;
  sessionAllowedKeyLimit?: number;
}

export interface RepeatedToolCallDetection {
  toolName: string;
  inputKey: string;
  repeatCount: number;
  threshold: number;
  inputPreview: string;
}

export interface DoomLoopGuardCheckResult {
  allowed: boolean;
  detected: boolean;
  detection?: RepeatedToolCallDetection;
}

export function getRepeatedToolCallThreshold(): number {
  const raw = readBrandEnv(ENV_REPEATED_TOOL_CALL_THRESHOLD)?.trim();
  if (!raw) {
    return REPEATED_TOOL_CALL_THRESHOLD;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : REPEATED_TOOL_CALL_THRESHOLD;
}

/**
 * Detects a doom-loop shape where the model asks for the exact same tool
 * invocation consecutively. Text chanting is intentionally out of scope; if
 * needed later, it should be handled by a separate content-output guard.
 */
export class DoomLoopGuard {
  private readonly threshold: number;
  private readonly sessionAllowedKeyLimit: number;
  private readonly sessionAllowedKeys: Set<string>;
  private readonly sessionAllowedKeyOrder: string[];
  private lastInputKey?: string;
  private consecutiveCount = 0;

  constructor(options: DoomLoopGuardOptions = {}) {
    this.threshold = options.threshold ?? getRepeatedToolCallThreshold();
    this.sessionAllowedKeyLimit =
      options.sessionAllowedKeyLimit ?? DEFAULT_SESSION_ALLOWED_KEY_LIMIT;
    this.sessionAllowedKeys = options.sessionAllowedKeys ?? new Set<string>();
    this.sessionAllowedKeyOrder = [...this.sessionAllowedKeys];
    this.pruneSessionAllowedKeys();
  }

  check(block: ModelToolUseBlock): DoomLoopGuardCheckResult {
    const inputJson = stableJson(block.input);
    const inputKey = buildRepeatedToolCallKeyFromJson(block.name, inputJson);

    if (this.sessionAllowedKeys.has(inputKey)) {
      this.clearStreak();
      return { allowed: true, detected: false };
    }

    const repeatCount =
      inputKey === this.lastInputKey ? this.consecutiveCount + 1 : 1;

    if (repeatCount < this.threshold) {
      this.record(inputKey, repeatCount);
      return { allowed: true, detected: false };
    }

    return {
      allowed: false,
      detected: true,
      detection: {
        toolName: block.name,
        inputKey,
        repeatCount,
        threshold: this.threshold,
        inputPreview: previewStableInputJson(inputJson),
      },
    };
  }

  allowForSession(inputKey: string): void {
    if (this.sessionAllowedKeys.has(inputKey)) {
      const existingIndex = this.sessionAllowedKeyOrder.indexOf(inputKey);
      if (existingIndex >= 0) {
        this.sessionAllowedKeyOrder.splice(existingIndex, 1);
      }
    }
    this.sessionAllowedKeys.add(inputKey);
    this.sessionAllowedKeyOrder.push(inputKey);
    this.pruneSessionAllowedKeys();
  }

  allowOnce(inputKey: string): void {
    this.record(inputKey, 1);
  }

  /** A result must not clear the streak of a different invocation key. */
  neutralize(inputKey: string): void {
    if (this.lastInputKey === inputKey) this.clearStreak();
  }

  private record(inputKey: string, consecutiveCount: number): void {
    this.lastInputKey = inputKey;
    this.consecutiveCount = consecutiveCount;
  }

  private clearStreak(): void {
    this.lastInputKey = undefined;
    this.consecutiveCount = 0;
  }

  private pruneSessionAllowedKeys(): void {
    while (this.sessionAllowedKeyOrder.length > this.sessionAllowedKeyLimit) {
      const evicted = this.sessionAllowedKeyOrder.shift();
      if (evicted !== undefined) {
        this.sessionAllowedKeys.delete(evicted);
      }
    }
  }
}

export function buildRepeatedToolCallKey(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return buildRepeatedToolCallKeyFromJson(toolName, stableJson(input));
}

export function stableJson(value: unknown): string {
  return stableStringify(value) ?? 'null';
}

function buildRepeatedToolCallKeyFromJson(
  toolName: string,
  inputJson: string,
): string {
  return `${toolName}:${inputJson}`;
}

function previewStableInputJson(inputJson: string): string {
  return inputJson.length <= 500 ? inputJson : `${inputJson.slice(0, 497)}...`;
}
