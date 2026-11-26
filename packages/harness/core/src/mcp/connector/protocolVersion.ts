/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SUPPORTED_PROTOCOL_VERSIONS,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { runLogger } from '../../utils/runLogger.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';

// `SUPPORTED_PROTOCOL_VERSIONS` from the client package lists only the legacy
// family, so the modern revisions this client can pin are tracked here.
const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28'];
const LEGACY_PROTOCOL_VERSIONS = new Set(SUPPORTED_PROTOCOL_VERSIONS);

// Unknown values fall back to automatic negotiation, so they must keep the
// app-level legacy retry available; only a recognized revision replaces it.
export function hasRequestedProtocolVersion(config: MCPServerConfig): boolean {
  const requested = readRequestedVersion(config);
  return (
    requested !== undefined &&
    (MODERN_PROTOCOL_VERSIONS.includes(requested) ||
      LEGACY_PROTOCOL_VERSIONS.has(requested))
  );
}

export function pinsModernProtocolVersion(config: MCPServerConfig): boolean {
  const requested = readRequestedVersion(config);
  return requested !== undefined && MODERN_PROTOCOL_VERSIONS.includes(requested);
}

/**
 * The configured legacy revision the `initialize` handshake must offer. The
 * SDK otherwise offers the newest supported revision, so an explicit
 * 2025-family value would select the handshake without changing its version.
 */
export function pinnedLegacyProtocolVersion(
  config: MCPServerConfig,
): string | undefined {
  const requested = readRequestedVersion(config);
  return requested !== undefined && LEGACY_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : undefined;
}

function readRequestedVersion(config: MCPServerConfig): string | undefined {
  const requested = config.protocolVersion?.trim();
  return requested === undefined || requested.length === 0
    ? undefined
    : requested;
}

/**
 * Applies the configured `protocolVersion` on top of the transport's default
 * policy. A known legacy revision runs the plain `initialize` handshake, a
 * known modern revision pins it, and a revision this client does not know (a
 * newer settings file, a typo) keeps the default. `fallback` is undefined for
 * transports that cannot negotiate, which is also how an explicit revision
 * lands on such a transport and gets reported.
 */
export function resolveProtocolNegotiation(
  serverName: string,
  config: MCPServerConfig,
  fallback: VersionNegotiationOptions | undefined,
): VersionNegotiationOptions | undefined {
  const requested = readRequestedVersion(config);
  if (requested === undefined) return fallback;

  if (fallback === undefined) {
    runLogger.warn(
      `MCP server '${serverName}': protocolVersion '${requested}' does not apply to the configured transport; ignoring it.`,
    );
    return undefined;
  }

  if (MODERN_PROTOCOL_VERSIONS.includes(requested)) {
    return { mode: { pin: requested } };
  }

  if (LEGACY_PROTOCOL_VERSIONS.has(requested)) {
    return { mode: 'legacy' };
  }

  runLogger.warn(
    `MCP server '${serverName}': protocolVersion '${requested}' is not supported by this client (supported: ${[
      ...MODERN_PROTOCOL_VERSIONS,
      ...SUPPORTED_PROTOCOL_VERSIONS,
    ].join(', ')}); using automatic negotiation.`,
  );
  return fallback;
}
