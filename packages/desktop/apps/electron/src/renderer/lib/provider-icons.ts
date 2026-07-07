/**
 * Provider Icons
 *
 * Maps the built-in Qwen backend to display metadata.
 * Used in AI Settings page and anywhere connection logos are needed.
 */

import type { LlmProviderType } from '@craft-agent/shared/config/llm-connections'

/**
 * Icon URLs for each provider
 */
export const providerIcons = {} as const

export type ProviderIconKey = keyof typeof providerIcons

/** Human-readable provider names */
const providerDisplayNames: Record<string, string> = {
  qwen: 'Qwen Code',
}

/** Get a human-readable provider name from provider type and optional base URL */
export function getProviderDisplayName(providerType: string, _baseUrl?: string | null): string {
  return providerDisplayNames[providerType] || providerType
}

/**
 * Get provider icon URL for a given provider type and optional base URL.
 *
 * @param providerType - The LLM provider type
 * @param baseUrl - Ignored for the Qwen-only backend
 * @param authProvider - Ignored for the Qwen-only backend
 * @returns Icon URL string or null if no matching icon
 */
export function getProviderIcon(
  _providerType: LlmProviderType | string,
  _baseUrl?: string | null,
  _authProvider?: string | null
): string | null {
  return null
}
