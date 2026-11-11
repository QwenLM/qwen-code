/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LlmGenerationConfig } from '../../config/generation-config.js';
import {
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortLevel,
} from '../../config/model-values.js';

export const CUSTOM_PROVIDER_SOURCE = 'custom';
/** Provider id that implicitly selects the Alibaba Cloud Model Studio type. */
export const ALIBABA_PROVIDER = 'alibaba';
/** Input-only compatibility alias; runtime descriptors always use `alibaba`. */
export const ALIYUN_BAILIAN_PROVIDER_ALIAS = 'aliyun-bailian';

/** Declared as an array so parsing and the type share one source of truth. */
export const CUSTOM_PROVIDER_TYPES = ['openai-compatible', 'alibaba'] as const;
export type CustomProviderType = (typeof CUSTOM_PROVIDER_TYPES)[number];

/** Wire adapter selected independently from provider-specific built-in behavior. */
export type CustomProviderAdapterKind =
  | CustomProviderType
  | 'openai-responses'
  | 'anthropic-compatible'
  | 'gemini';

export type CustomProviderAuthType =
  | 'bearer'
  | 'api-key'
  | 'google-api-key';

export const CUSTOM_PROVIDER_THINKING_WIRE_MODES = [
  'enabled',
  'adaptive',
] as const;
export type CustomProviderThinkingWireMode =
  (typeof CUSTOM_PROVIDER_THINKING_WIRE_MODES)[number];
export type CustomProviderReasoningEffortLevel = Exclude<
  ReasoningEffortLevel,
  'none'
>;
/** Derived from the canonical level list so ordering is defined in one place. */
export const CUSTOM_PROVIDER_REASONING_EFFORT_LEVELS: readonly CustomProviderReasoningEffortLevel[] =
  REASONING_EFFORT_LEVELS.filter(
    (level): level is CustomProviderReasoningEffortLevel => level !== 'none',
  );

/**
 * Anthropic reasoning features are not implied by a single capability bit.
 * `modes` declares the provider-native wire shapes while the remaining fields
 * declare which optional controls that model accepts.
 */
export interface CustomProviderThinkingCapabilities {
  /** All accepted wire modes; permits models that support enabled and adaptive. */
  modes: readonly CustomProviderThinkingWireMode[];
  preferredMode?: CustomProviderThinkingWireMode;
  /**
   * Whether `thinking.type=enabled` requires a fixed `budget_tokens` value.
   * Settings inherit a built-in model's policy when omitted; models without a
   * built-in fallback preserve the legacy Anthropic behavior (`true`).
   */
  requiresBudgetForEnabled?: boolean;
  /**
   * Accepted effort values, resolved at parse time. Empty means the model
   * rejects `reasoning.effort` entirely; the settings-level `supportsEffort`
   * shorthand is expanded to the full level list by the parser.
   */
  supportedEffortLevels: readonly CustomProviderReasoningEffortLevel[];
  /** Provider/model-specific beta headers required only when effort is used. */
  requiredBetasForEffort: readonly string[];
}

export type CustomProviderAnthropicCacheTtl = '5m' | '1h';

export interface CustomProviderAnthropicCacheConfig {
  mode: 'off' | 'auto';
  ttl: CustomProviderAnthropicCacheTtl;
}

/** Resolved provider-level options for the Anthropic Messages adapter. */
export interface CustomProviderAnthropicConfig {
  /** `false` omits the header for gateways that reject it. */
  version: string | false;
  betas: readonly string[];
  queryParams: Readonly<Record<string, string>>;
  cache: CustomProviderAnthropicCacheConfig;
}

/**
 * Builds the authentication header for a custom provider request. An empty key
 * represents an unauthenticated endpoint and therefore adds no auth header.
 * `authType` is already resolved to a concrete value upstream (see parser.ts),
 * so every transport shares the same mapping instead of hand-writing the
 * ternary.
 */
export function customProviderAuthHeaders(
  authType: CustomProviderAuthType,
  apiKey: string,
): Record<string, string> {
  if (apiKey === '') return {};
  return authType === 'api-key'
    ? { 'x-api-key': apiKey }
    : { Authorization: `Bearer ${apiKey}` };
}

/** Semantic request purposes that may opt into a provider-specific model. */
export type CustomProviderRoutingPurpose =
  | 'utility'
  | 'session_title'
  | 'summary'
  | 'compact'
  | 'subagent';

export interface CustomProviderModelCapabilities {
  tools: boolean;
  vision: boolean;
  /** Whether this model accepts Anthropic-style content-block `cache_control` markers. */
  cacheControl?: boolean;
  thinking: CustomProviderThinkingCapabilities;
}

export function supportsCustomProviderModelThinking(
  capabilities: CustomProviderModelCapabilities,
): boolean {
  return capabilities.thinking.modes.length > 0;
}

export interface CustomProviderTimeoutConfig {
  firstPayloadTimeoutMs: number;
  streamIdleTimeoutMs?: number;
}

export interface CustomProviderModelRuntime {
  modelId: string;
  displayName: string;
  contextWindow: number;
  /** True when capacity is a fallback budget rather than declared model metadata. */
  contextWindowEstimated?: true;
  maxOutputTokens: number;
  /** True when capabilities were synthesized because no model metadata was declared. */
  implicit?: true;
  capabilities: CustomProviderModelCapabilities;
  /** Internal adapter defaults for built-in models only. User configuration
   * lives in `model.preferences[provider/model]`. */
  generationDefaults?: LlmGenerationConfig;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
}

/**
 * Secret-bearing provider configuration. This must never be projected into
 * model catalog entries, UI state, remote worker state, or log payloads.
 */
export interface CustomProviderRuntime {
  providerId: string;
  type: CustomProviderType;
  displayName: string;
  adapter: CustomProviderAdapterKind;
  authType: CustomProviderAuthType;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  routing: Partial<Record<CustomProviderRoutingPurpose, string>>;
  models: ReadonlyMap<string, CustomProviderModelRuntime>;
  timeouts: CustomProviderTimeoutConfig;
  anthropic?: CustomProviderAnthropicConfig;
}

/** Public, secret-free model metadata that is safe to expose through catalog. */
export interface CustomProviderModelDescriptor {
  key: string;
  providerId: string;
  providerDisplayName: string;
  adapter: CustomProviderAdapterKind;
  format: 'openai' | 'anthropic' | 'gemini';
  modelId: string;
  displayName: string;
  contextWindow: number;
  /** True when capacity is a fallback budget rather than declared model metadata. */
  contextWindowEstimated?: true;
  maxOutputTokens: number;
  /** True when the descriptor uses conservative synthesized metadata. */
  implicit?: true;
  capabilities: CustomProviderModelCapabilities;
  /** Built-in model default for the catalog thinking toggle. */
  defaultThinkingEnabled?: boolean;
}

export interface CustomProviderPublicDescriptor {
  providerId: string;
  displayName: string;
  defaultModelKey: string;
  models: readonly CustomProviderModelDescriptor[];
}

export interface CustomProviderValidationIssue {
  providerId: string;
  field?: string;
  message: string;
}

export interface CustomProviderParseResult {
  providers: readonly CustomProviderRuntime[];
  issues: readonly CustomProviderValidationIssue[];
}

export type CustomProvidersInactiveReason =
  | 'not_authenticated'
  | 'remote_worker'
  | 'feature_disabled'
  | 'service_account';

export type CustomProvidersState =
  | { status: 'not_configured' }
  | {
      status: 'inactive';
      reason: CustomProvidersInactiveReason;
    }
  | {
      status: 'invalid_configuration';
      issues: readonly CustomProviderValidationIssue[];
    }
  | {
      status: 'active';
      providerCount: number;
      modelCount: number;
      /** Non-fatal issues encountered during partial activation. */
      issues?: readonly CustomProviderValidationIssue[];
    };

export function customProviderModelKey(
  providerId: string,
  modelId: string,
): string {
  return `${providerId}/${modelId}`;
}
