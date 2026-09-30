/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bounds for the per-server MCP App resource limits, shared by the
 * enforcing read site (`mcp-tool.ts`) and the pool fingerprint
 * (`mcp-pool-key.ts`) so the two cannot drift apart.
 */
export const MCP_APP_RESOURCE_MAX_BYTES_DEFAULT = 1024 * 1024;
// JSON escaping can expand HTML 6x inside the 32 MiB replay envelope.
export const MCP_APP_RESOURCE_MAX_BYTES_CEILING = 4 * 1024 * 1024;
export const MCP_APP_RESOURCE_TIMEOUT_DEFAULT_MS = 10_000;
export const MCP_APP_RESOURCE_TIMEOUT_MIN_MS = 100;
export const MCP_APP_RESOURCE_TIMEOUT_MAX_MS = 120_000;

export function boundedAppLimit(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(Math.floor(value), max))
    : fallback;
}

/**
 * The byte limit a config actually enforces after clamp/floor/fallback.
 * Hashing this instead of the raw configured value keeps configs with
 * byte-identical enforced policy in one pool entry.
 */
export function effectiveAppResourceMaxBytes(
  value: number | undefined,
): number {
  return boundedAppLimit(
    value,
    MCP_APP_RESOURCE_MAX_BYTES_DEFAULT,
    1,
    MCP_APP_RESOURCE_MAX_BYTES_CEILING,
  );
}

/**
 * The deadline a config actually enforces, or null when unset/invalid —
 * the effective fallback then derives from the server `timeout`, which the
 * fingerprint hashes separately.
 */
export function effectiveAppResourceTimeoutMs(
  value: number | undefined,
): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(
        MCP_APP_RESOURCE_TIMEOUT_MIN_MS,
        Math.min(Math.floor(value), MCP_APP_RESOURCE_TIMEOUT_MAX_MS),
      )
    : null;
}
