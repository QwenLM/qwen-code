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
