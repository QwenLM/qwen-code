/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API type definitions.
 *
 * These types mirror the API response shapes consumed by the CLI.
 * New OpenAPI responses are normalized at the service boundary so existing UI
 * consumers can keep using the established field names.
 */

import type { ModelStrategy } from './models/types.js';

// ---------------------------------------------------------------------------
// Model types — from GET /api/v2/model/list?Encode=1
// ---------------------------------------------------------------------------

/** A single model returned by the model list API. */
export interface QoderModelConfig {
  /** Unique model key, e.g. "auto", "ultimate", "performance" */
  key: string;
  /** Human-readable display name, e.g. "Ultimate" */
  display_name: string;
  /** API format, always "openai" currently */
  format: string;
  /** Whether the model supports image/vision input */
  is_vl: boolean;
  /** Whether the model supports deep reasoning/thinking */
  is_reasoning: boolean;
  /** Backend URL (always empty — backend resolves actual endpoint) */
  url: string;
  /** "system" for platform models, "user" for user-supplied connections */
  source: string;
  /** 外部模型渠道，例如 "cmcc" */
  outer_provider?: string;
  /** Maximum input context window in tokens */
  max_input_tokens: number;
  /** Local fallback budget; not a verified upstream model capacity. */
  context_window_is_estimate?: boolean;
  /** Supported configurable context window sizes in tokens. */
  available_context_windows?: number[];
  /** Server-designated default configurable context window, when provided. */
  default_context_window?: number;
  /** Maximum output tokens */
  max_output_tokens: number;
  /** Whether this model is enabled for the user's subscription tier */
  enable: boolean;
  /** Whether this is the default model for the scene */
  is_default: boolean;
  /** Whether this model appears in the "New Models" tab */
  is_new: boolean;
  /** Explicit reasoning effort levels supported by this model */
  efforts?: string[];
  /** Whether the model supports disabling thinking explicitly */
  supports_disabled?: boolean;
  /** Server-designated default reasoning effort, when provided */
  default_effort?: string;
  /** Tags, null for platform models, ["custom"] for user-supplied connections */
  tags: string[] | null;
  /** Original top-level key in the server model-list response. */
  server_scene?: string;
  /** Model provider, e.g. "qoder" (added client-side) */
  model_provider: string;
  /** 服务端代码库策略，供已加载目录的纯展示计算使用。 */
  strategies?: readonly ModelStrategy[];
}

// ---------------------------------------------------------------------------
// User plan types — from GET /api/v2/user/plan
// ---------------------------------------------------------------------------

/** User plan/subscription info normalized from GET /api/v2/user/plan. */
export interface QoderUserPlan {
  /** User type key */
  user_type: string;
  /** Plan tier key, e.g. "free", "pro", "teams" */
  plan_tier?: string;
  /** Display name of the plan tier, e.g. "Teams", "Professional", "Free" */
  plan_tier_name: string;
  /** Whether the subscription renews automatically */
  is_renewed?: boolean;
  /** Whether this is a personal version */
  is_personal_version: boolean;
  /** Whether this is the highest tier */
  is_highest_tier?: boolean;
  /** Organization info (present for Teams plans) */
  organization?: {
    org_id: string;
    org_name: string;
    role_name: string;
    is_suspended: boolean;
    can_manage_subscriptions: boolean;
    resource_package_feature_enabled: boolean;
  } | null;
  /** Feature allowances */
  feature_allowed?: {
    quest: boolean;
    wiki: boolean;
    code_review: boolean;
  };
  /** Plan start date (Unix timestamp in seconds) */
  start_date: number;
  /** Plan end date (Unix timestamp in milliseconds, optional) */
  end_date?: number;
}

// ---------------------------------------------------------------------------
// Quota/usage types — from GET /api/v2/quota/usage
// ---------------------------------------------------------------------------

/** Quota usage data normalized from GET /api/v2/quota/usage. */
export interface QoderQuotaUsage {
  /** User ID */
  userId: string;
  /** User type */
  userType: string;
  /** Usage unit reported by Sash v2. */
  usageType?: 'credits';
  /** Total usage percentage */
  totalUsagePercentage: number;
  /** Whether user is on the highest tier */
  isHighestTier: boolean;
  /** Quota expiry timestamp (Unix milliseconds) */
  expiresAt: number;
  /** URL to upgrade plan */
  upgradeUrl: string;
  /** Primary quota bucket (omitted when the account has no personal quota). */
  userQuota?: {
    total: number;
    used: number;
    remaining: number;
    percentage: number;
    unit: string;
  };
  /** Add-on quota bucket (optional) */
  addOnQuota?: {
    total: number;
    used: number;
    remaining: number;
    percentage: number;
    unit: string;
    detailUrl: string;
  };
  /** Organization resource package (optional, for Teams) */
  orgResourcePackage?: {
    used: number;
    cap: number;
    remaining: number;
    percentage: number;
    available: boolean;
    unit: string;
  };
  /** Personal dedicated resource packages (optional). */
  dedicatedResourcePackages?: QoderDedicatedResourcePackage[];
  /** Whether quota is exceeded */
  isQuotaExceeded: boolean;
  /** Whether plan quota is prorated for the current billing period */
  isPlanQuotaProrated?: boolean;
}

/** A server-defined label attached to a dedicated resource package. */
export interface QoderQuotaDisplayLabel {
  dimension: string;
  value: string;
  valueI18n?: Readonly<Record<string, string>>;
}

/** A personal dedicated resource package normalized from quota usage. */
export interface QoderDedicatedResourcePackage {
  id: string;
  name: string;
  description: string;
  total: number;
  used: number;
  remaining: number;
  percentage: number;
  unit: string;
  /** Package expiry timestamp (Unix milliseconds). */
  expiresAt?: number;
  available: boolean;
  status: string;
  displayLabels: QoderQuotaDisplayLabel[];
}

export type EnterpriseUsage =
  | {
      openMode: 'externalBrowser';
      detailUrl: string;
      fallbackUrl?: never;
    }
  | {
      openMode: 'systemDeepLink';
      detailUrl: string;
      fallbackUrl?: string;
    };

/** The quota fields the exhaustion helpers read. */
export type QoderQuotaBalance = Pick<
  QoderQuotaUsage,
  'isQuotaExceeded' | 'userQuota' | 'addOnQuota' | 'orgResourcePackage'
>;

export function isQuotaExhausted(quota: QoderQuotaBalance): boolean {
  return quota.isQuotaExceeded || getQuotaTotalRemaining(quota) <= 0;
}

export function getQuotaTotalRemaining(
  quota: Omit<QoderQuotaBalance, 'isQuotaExceeded'>,
): number {
  return (
    (quota.userQuota?.remaining ?? 0) +
    (quota.addOnQuota?.remaining ?? 0) +
    (quota.orgResourcePackage?.remaining ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Standard model descriptions (hardcoded, matching the original CLI)
// ---------------------------------------------------------------------------

/** Descriptions for standard platform models — not from API. */
export const STANDARD_MODEL_DESCRIPTIONS: Record<string, string> = {
  auto: 'Smartly select the optimal model, balancing performance and cost',
  ultimate: 'Expert-level deep reasoning and thinking with peak output quality',
  performance: 'Advanced reasoning with high output quality',
  efficient: 'Standard reasoning at low cost',
  lite: 'Basic reasoning available on Free (may be slower during peak hours)\nImage input not supported',
};
