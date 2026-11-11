/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import type { ModelStreamTool } from '../provider/modelStreamRequest.js';
import type { ModelPolicyLabels } from '../core/model-policy.js';

import type { Config } from '../config/config.js';
import type { ChatCompressionInfo } from '../core/turn-events.js';
import type { Message } from './message-types.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import type { CompressionTrigger, CompressionUsagePayload } from '../utils/events.js';
import type { SystemPrompt } from '../prompts/types.js';
import { PreCompactTrigger } from '../hooks/types.js';
import type { ForkedAgentCompletion } from '../core/forkedAgent.js';


export type { CompressionTrigger };
export type { CompressionRequestModel } from '../core/compact-request-resolver.js';

/** Snapshot of the model and token values used by an automatic threshold check. */
export interface AutoCompactPolicyObservation {
  model: string;
  base_threshold_tokens: number;
  qcs_cap_tokens: number | null;
  evaluated_tokens: number;
}

/**
 * Map a compression trigger onto the PreCompact hook trigger. Only automatic
 * compaction reports as `Auto`; manual and reactive both surface as `Manual`.
 */
export function toPreCompactTrigger(
  trigger: CompressionTrigger,
): PreCompactTrigger {
  return trigger === 'auto' ? PreCompactTrigger.Auto : PreCompactTrigger.Manual;
}

/**
 * Map a compression trigger onto the two-valued transcript boundary metadata.
 * The persisted schema distinguishes only automatic and manual compaction, so
 * reactive recovery keeps the existing manual wire representation while
 * progress events retain the richer `reactive` value.
 */
export function toCompactMetadataTrigger(
  trigger: CompressionTrigger,
): 'manual' | 'auto' {
  return trigger === 'auto' ? 'auto' : 'manual';
}

export type CompressionPipelineTarget = 'main' | 'subagent';

export type CompactModelSource =
  | 'current'
  | 'explicit'
  | 'custom_provider'
  | 'sdk-policy'
  | 'fixed';

// ---------------------------------------------------------------------------
// Partial compact options
// ---------------------------------------------------------------------------

/**
 * Controls which portion of the working history is summarized.
 *
 * - `up_to`  : Summarize messages[0..pivotIndex], keep messages[pivotIndex..]
 *              verbatim after the summary. Good for "compress the early
 *              exploration phase, keep recent work intact."
 * - `from`   : Keep messages[0..pivotIndex] verbatim, summarize
 *              messages[pivotIndex..]. Rarely needed; provided for symmetry.
 *
 * `pivotIndex` is an index into `CompressionStageContext.workingHistory`.
 */
export interface PartialCompactOptions {
  direction: 'up_to' | 'from';
  /**
   * Split point in `workingHistory`.  Messages on the summarized side of
   * this index are fed to the fork; the verbatim side is preserved as-is.
   */
  pivotIndex: number;
}

export interface CompressionBoundary {
  startIndex: number;
  prefixContents: readonly Message[];
  contents: readonly Message[];
  source: 'initial_history' | 'compact_boundary';
}

export interface CompressionPipelinePersistedState {
  replacementDecisions: Record<string, string>;
  seenFunctionResponseIds: string[];
}

/**
 * Failure vocabulary emitted by compaction model-request classification and
 * consumed by the auto-compact breaker policy. Single source of truth: the
 * producer (`classifyCompactionRequestError`) and the consumer (`cleanup.ts`)
 * both type against this union, so renaming or adding a reason is a compile
 * error at every site rather than a silently mis-classified breaker strike.
 */
export type CompactionFailureReason =
  | 'provider_error'
  | 'provider_access'
  | 'cancelled'
  | 'empty_summary'
  | 'reasoning_only'
  | 'media_too_large'
  | 'prompt_too_long'
  | 'quota_exhausted'
  | 'auth_error'
  | 'model_queued'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'local_error';

export type SummaryParseReason =
  | 'summary_parse_paired'
  | 'summary_parse_open_only'
  | 'summary_parse_close_only'
  | 'summary_parse_plain';

/**
 * Reasons that block auto-compact for the remainder of the query (retrying the
 * model request cannot repair them), rather than consuming a retry strike.
 */
export type BlockingCompactionFailureReason = Extract<
  CompactionFailureReason,
  'quota_exhausted' | 'auth_error' | 'local_error'
>;

/**
 * Runtime membership table for {@link BlockingCompactionFailureReason}. Typed as
 * an exhaustive `Record` so adding a blocking reason to the union above is a
 * compile error here until it is listed — the breaker can never silently
 * mis-count a new blocking reason as a retry strike.
 */
const BLOCKING_COMPACTION_FAILURE_REASONS: Record<
  BlockingCompactionFailureReason,
  true
> = {
  quota_exhausted: true,
  auth_error: true,
  local_error: true,
};

export function isBlockingCompactionFailureReason(
  reason: string | undefined,
): reason is BlockingCompactionFailureReason {
  return (
    reason !== undefined &&
    Object.hasOwn(BLOCKING_COMPACTION_FAILURE_REASONS, reason)
  );
}

/**
 * Query-scoped auto-compact circuit state.
 *
 * This state deliberately lives outside {@link CompressionPipelinePersistedState}:
 * the breaker protects repeated attempts inside one user query, not future turns
 * or resumed sessions.
 */
export interface AutoCompactTrackingState {
  consecutiveFailures: number;
  lastFailureReason?: string;
  blockedReason?: BlockingCompactionFailureReason;
}

export function createAutoCompactTrackingState(): AutoCompactTrackingState {
  return { consecutiveFailures: 0 };
}

export interface CompactSelectionResult {
  selection: ModelSelection;
  policyLabels?: ModelPolicyLabels;
  source?: CompactModelSource;
}

export interface CompressionPipelineInput {
  modelResolution: ModelSelection;
  /** Session-owned provider manager; borrowed without changing its lifecycle. */
  modelProviderManager: ModelProviderManager;
  /** One compact selection shared by hooks, the summary and request retries. */
  compactModelSelection?: Promise<ModelSelection>;
  onCompactModelSelected?: (
    resolution: ModelSelection,
    source?: CompactModelSource,
  ) => void;
  /** Lazy session-policy adapter; returns the Provider's final selection. */
  resolveCompactSelection?: () => Promise<CompactSelectionResult>;
  compactModelSource?: CompactModelSource;
  policyLabels?: ModelPolicyLabels;
  /** Full conversation history (Anthropic format). */
  history: readonly Message[];
  /**
   * Exact ephemeral runtime messages prepended to the parent provider request.
   * Compression forks normalize this prefix together with their selected
   * history so prompt-cache identity does not depend on mutable Config state.
   */
  requestPrefixMessages: readonly Message[];
  /** Estimated token count of the current prompt. */
  promptTokenCount: number;
  /**
   * How `promptTokenCount` was derived. Logged by the auto-compact stage so a
   * systematically low threshold number is diagnosable from the run log:
   * - `usage`          — anchored on server-reported usage (most accurate)
   * - `staged-estimate`— re-estimated after tool-result budget
   * - `estimate`       — no usage anchor available, pure local estimation
   */
  promptTokenSource?: 'usage' | 'staged-estimate' | 'estimate';
  /** Exact parent system prompt content used to preserve fork cache identity. */
  systemPrompt?: SystemPrompt;
  /** Opaque SDK context inherited by compact model requests for this query. */
  customContext?: Readonly<Record<string, string>>;
  /** Tool schemas (for fork context). */
  tools?: readonly ModelStreamTool[];
  promptId: string;
  force: boolean;
  trigger: CompressionTrigger;
  autoCompactTracking: AutoCompactTrackingState;
  /** Observes the exact threshold already used by the auto-compact stage. */
  onAutoCompactThresholdResolved?: (threshold: number) => void;
  onAutoCompactPolicyResolved?: (
    policy: AutoCompactPolicyObservation,
    threshold: number,
  ) => void;
  /** Forwarded unchanged to the forked request runner. */
  onCompactRequestCompleted?: (completion: ForkedAgentCompletion) => void;
  onCompactUsage?: (usage: CompressionUsagePayload) => void;
  config: Config;
  abortSignal?: AbortSignal;
  target: CompressionPipelineTarget;
  /** Root conversation session ID forwarded to every forked model request. */
  rootSessionId: string;
  /** Compression state/storage scope; may be a subagent prompt ID. */
  sessionScopeId: string;
  /** Agent ID for subagent compression contexts; undefined for the main agent. */
  agentId?: string;
  /**
   * User-provided text from a manual `/compact <text>` invocation. Forwarded
   * to PreCompact hooks as `custom_instructions`. Undefined / absent on auto
   * compaction; the hook payload then carries an empty string per spec.
   */
  customInstructions?: string;
  /**
   * Absolute path to the session's JSONL transcript file.
   * Injected into the compact summary message so the model can reference
   * pre-compaction details (exact code, error messages, tool outputs).
   */
  transcriptPath?: string;
  /**
   * Parent agent's requestSetId for subagent/forked-agent request grouping.
   * Explicitly threaded to avoid AsyncLocalStorage boundary issues.
   */
  parentRequestSetId?: string;
  /**
   * Parent agent's BusinessInfo for lifecycle inheritance.
   * Explicitly threaded so forked agents inside the pipeline inherit it.
   */
  parentBusinessInfo?: Readonly<BusinessInfo>;
}

export interface CompressionStageContext {
  input: CompressionPipelineInput;
  state: CompressionPipelinePersistedState;
  boundary: CompressionBoundary;
  fullHistory: readonly Message[];
  workingHistory: readonly Message[];
}

export interface CompressionPipelineResult {
  newHistory: Message[] | null;
  info: ChatCompressionInfo;
  /**
   * Canonical summary text produced by the fork compactor. Forwarded to PostCompact hooks as `compact_summary`.
   * Populated only when `info.compressionStatus === COMPRESSED`.
   */
  compactSummary?: string;
  /** Internal response-shape classification reported through failure_reason. */
  summaryParseReason?: SummaryParseReason;
  /** Internal model identifier to resolve for Pre/PostCompact hook payloads. */
  hookModel?: string;
}
