/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Discontinued-model detection for the ACP `availableModels` payload.
 *
 * The ACP server emits each model id wrapped as `${modelId}(${authType})`,
 * e.g. `qwen3-coder-plus(qwen-oauth)`. Runtime model snapshots are additionally
 * prefixed with `$runtime|${authType}|`, so the wrapped form becomes
 * `$runtime|qwen-oauth|qwen3-coder-plus(qwen-oauth)`.
 *
 * This helper mirrors the encoding contract used by the CLI's
 * `acpModelUtils.ts` and the discontinued check in the CLI's `ModelDialog`.
 * Keep these two files in sync when the encoding evolves.
 */

const RUNTIME_PREFIX = '$runtime|';

/** Auth type marker for the (now-discontinued) Qwen OAuth free tier. */
export const QWEN_OAUTH_AUTH_TYPE = 'qwen-oauth';

/** User-facing strings for the discontinued state (English-only — webview has no i18n runtime). */
export const DISCONTINUED_MESSAGES = {
  badge: '(Discontinued)',
  description: 'Discontinued — switch to Coding Plan or API Key',
  blockedError:
    'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.',
} as const;

export interface ParsedAcpModelId {
  /** Model id with the trailing `(authType)` marker stripped. */
  baseModelId: string;
  /** Auth type extracted from the trailing `(authType)` marker, or `undefined` if none. */
  authType?: string;
  /** True when the id starts with `$runtime|` (cached-token snapshot). */
  isRuntime: boolean;
}

/**
 * Parse an ACP-formatted model id into its components.
 *
 * Returned `baseModelId` may still contain `$runtime|` prefix to preserve the
 * caller's original snapshot id; only the trailing auth-type wrapper is removed.
 */
export function parseAcpModelId(modelId: string): ParsedAcpModelId {
  const trimmed = modelId.trim();
  const isRuntime = trimmed.startsWith(RUNTIME_PREFIX);

  // Anchored trailing `(authType)` — only matches the very end so model labels
  // containing `(...)` mid-string are safe (the encoding always appends
  // `(authType)` last).
  const closeIdx = trimmed.lastIndexOf(')');
  const openIdx = trimmed.lastIndexOf('(');
  if (openIdx >= 0 && closeIdx === trimmed.length - 1 && openIdx < closeIdx) {
    const authType = trimmed.slice(openIdx + 1, closeIdx);
    const baseModelId = trimmed.slice(0, openIdx);
    return { baseModelId, authType, isRuntime };
  }

  return { baseModelId: trimmed, isRuntime };
}

/**
 * Returns true when the model id refers to a non-runtime Qwen OAuth registry
 * entry, matching the CLI's discontinued rule.
 *
 * Runtime snapshots from existing cached tokens are intentionally excluded so
 * already-authenticated sessions keep working until the server rejects them.
 */
export function isDiscontinuedModel(modelId: string): boolean {
  if (typeof modelId !== 'string' || modelId.length === 0) {
    return false;
  }
  const parsed = parseAcpModelId(modelId);
  return parsed.authType === QWEN_OAUTH_AUTH_TYPE && !parsed.isRuntime;
}
