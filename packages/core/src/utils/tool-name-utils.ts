/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** Maximum accepted function-name length across supported providers. */
const MAX_TOOL_NAME_LENGTH = 63;
const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Produces a deterministic name accepted by Gemini and stricter
 * OpenAI-compatible and Anthropic-compatible providers.
 */
export function normalizeToolNameForProvider(name: string): string {
  if (
    name.length <= MAX_TOOL_NAME_LENGTH &&
    PROVIDER_SAFE_TOOL_NAME.test(name)
  ) {
    return name;
  }

  const normalized = sanitizeToolNameForProvider(name);

  const suffix = `_${stableToolNameHash(name)}`;
  return `${normalized.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}

/** Character-only normalization for code that needs an MCP server prefix. */
export function sanitizeToolNameForProvider(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return /^[A-Za-z]/.test(sanitized) ? sanitized : `tool_${sanitized}`;
}

/** Only legacy MCP names need normalization when converting stored history. */
export function normalizeMcpToolName(name: string): string {
  return name.startsWith('mcp__') ? normalizeToolNameForProvider(name) : name;
}

/** Recreates the pre-provider-compatibility name for persisted settings. */
export function generateLegacyMcpToolName(name: string): string {
  let legacyName = name.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (legacyName.length > MAX_TOOL_NAME_LENGTH) {
    legacyName = legacyName.slice(0, 28) + '___' + legacyName.slice(-32);
  }
  return legacyName;
}

/** FNV-1a keeps aliases stable without adding a runtime crypto dependency. */
function stableToolNameHash(name: string): string {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
