/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/resource';

export { AuthType } from '@qwen-code/resource';

/**
 * Product-level fallback used when neither settings nor env select a type.
 * Callers can override it at startup; the CLI sets `qoder-oauth`.
 */
let defaultAuthType: AuthType = AuthType.QODER_BROWSER;

export function setDefaultAuthType(authType: AuthType): void {
  defaultAuthType = authType;
}

/** Product default used when neither settings nor env select a type. */
export function getDefaultAuthType(): AuthType {
  return defaultAuthType;
}

/**
 * Resolve the effective auth type from settings + environment.
 * Falls back to the product default when no explicit selection exists.
 */
function isAuthType(value: string): value is AuthType {
  return (Object.values(AuthType) as string[]).includes(value);
}

export function resolveEffectiveAuthType(
  selectedType: AuthType | string | undefined,
): AuthType {
  if (selectedType && isAuthType(selectedType)) {
    return selectedType;
  }
  return defaultAuthType;
}
