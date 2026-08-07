/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Omni policy-pipeline protocol types.
 *
 * The wire-facing pieces live where their consumers already are —
 * `ToolExecutionOrigin` / `PolicyArtifactBatch` next to the scheduler
 * protocol in core/turn.ts, `MediaPolicyToolDescriptor` next to the tool
 * framework in tools/tools.ts — and are re-exported here so omni code can
 * import everything policy-related from one place.
 */

export type {
  ToolExecutionOrigin,
  PolicyArtifactBatch,
} from '../../core/turn.js';
export type {
  MediaPolicyToolDescriptor,
  MediaPolicyToolOutputSpec,
} from '../../tools/tools.js';
export type {
  ComparisonCondition,
  ComparisonOperator,
  ConditionEvaluation,
  ConditionOperand,
  FixedPolicyCondition,
  FixedPolicyConditionContext,
  FixedPolicyField,
} from './conditions.js';

import type { FixedPolicyCondition } from './conditions.js';
import type { OmniModality } from '../recognition.js';

/** Provenance labels a fixed policy can match on: `user` = user-attached
 * input, `tool` = tool-result media, `policy` = a derivative produced by
 * another fixed policy. */
export type FixedPolicyOrigin = 'user' | 'tool' | 'policy';

/**
 * One fixed policy AFTER config normalization (policy design §8): every
 * field present, defaults applied, structure validated. The orchestrator
 * consumes only this shape — raw settings never reach it.
 */
export interface NormalizedFixedPolicy {
  /** Unique id (settings key). Ties run records, staging dirs and the
   * `fixed_policy` execution origin back to their configuration. */
  id: string;
  /** Bigger runs first; ties broken by id (ascending) for determinism. */
  priority: number;
  /** Modalities the policy applies to. */
  mediaTypes: OmniModality[];
  /** Resource provenances the policy applies to. */
  origins: FixedPolicyOrigin[];
  /** Optional condition; absent means "always applies". */
  when?: FixedPolicyCondition;
  /** What to do when `when` cannot be decided (default: skip). */
  onConditionUnavailable: 'skip' | 'run';
  /** Media-policy tool the policy invokes. */
  toolName: string;
  /** Fixed tool arguments (io params are injected per invocation). */
  arguments: Record<string, unknown>;
  /** Max executions of THIS policy along one derivation chain. */
  maxRunsPerLineage: number;
  /** Failure behavior: keep the source in the delivery set and move on,
   * or abort the whole media delivery. */
  onFailure: 'continue' | 'abort';
  output: {
    /** Whether derivatives re-enter policy matching. */
    reprocessMedia: boolean;
    /** Whether the source stays in the delivery set alongside the
     * derivatives (`keep`) or is replaced by them (`omit`). */
    source: 'keep' | 'omit';
  };
  /** Pipeline stage the policy runs in. Transport-guard policies fail
   * closed regardless of `onFailure`. */
  stage: 'preprocessing' | 'transport_guard';
}

/** Normalized `omni.processing` view the pipeline consumes. */
export interface NormalizedOmniProcessingConfig {
  fixedPolicies: NormalizedFixedPolicy[];
  transportGuardPolicies: NormalizedFixedPolicy[];
}

/** Structural Config view for the processing config accessor (optional so
 * stub configs and embedders without omni settings keep working; the real
 * accessor lands with config normalization). */
export interface OmniProcessingConfigView {
  getOmniProcessingConfig?: () => NormalizedOmniProcessingConfig | undefined;
}

/**
 * Raw (pre-normalization) shape of one
 * `omni.processing.policyTools.<toolName>` settings entry. Full semantic
 * validation happens in the config-normalization pass; these types only
 * capture the structure the lenient readers navigate.
 */
export interface OmniPolicyToolModelAccessSettings {
  /** Whether the model (and direct client calls) may invoke the tool.
   * Default: false — media-policy tools are fixed-policy-only unless
   * explicitly opened up. */
  enabled?: boolean;
  /** Overrides the tool description the model sees. */
  description?: string;
  /** Filled in when the model omits them. */
  defaultArguments?: Record<string, unknown>;
  /** Harness-injected arguments, hidden from the model's schema; a model
   * call that passes any of these keys explicitly is a parameter error. */
  lockedArguments?: Record<string, unknown>;
  /** Narrowing-only projection over the tool's native schema. */
  parameterSchema?: Record<string, unknown>;
  /** Artifact behavior for model-origin calls (Stage B). */
  output?: Record<string, unknown>;
}

/** Raw shape of one `omni.processing.policyTools.<toolName>` entry. */
export interface OmniPolicyToolSettings {
  /** Tool-level settings validated against the descriptor's settingsSchema. */
  settings?: Record<string, unknown>;
  /** Per-tool runtime limits (timeoutMs, maxConcurrency). */
  runtime?: Record<string, unknown>;
  /** Model-callability gate and argument projection. */
  modelAccess?: OmniPolicyToolModelAccessSettings;
}

/** Raw `omni.processing.policyTools` map as loaded from settings. Values
 * may be null (scope-merge tombstones) or malformed — readers must treat
 * anything non-conforming as absent (fail closed). */
export type OmniPolicyToolsSettings = Record<
  string,
  OmniPolicyToolSettings | null
>;
