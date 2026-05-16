/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const SERVE_PROTOCOL_VERSION = 'v1' as const;

export const SUPPORTED_SERVE_PROTOCOL_VERSIONS = [
  SERVE_PROTOCOL_VERSION,
] as const;

export type ServeProtocolVersion =
  (typeof SUPPORTED_SERVE_PROTOCOL_VERSIONS)[number];

export interface ServeProtocolVersions {
  current: ServeProtocolVersion;
  supported: ServeProtocolVersion[];
}

export interface ServeCapabilityDescriptor {
  since: ServeProtocolVersion;
}

export const SERVE_CAPABILITY_REGISTRY = {
  health: { since: SERVE_PROTOCOL_VERSION },
  capabilities: { since: SERVE_PROTOCOL_VERSION },
  session_create: { since: SERVE_PROTOCOL_VERSION },
  session_list: { since: SERVE_PROTOCOL_VERSION },
  session_prompt: { since: SERVE_PROTOCOL_VERSION },
  session_cancel: { since: SERVE_PROTOCOL_VERSION },
  session_events: { since: SERVE_PROTOCOL_VERSION },
  session_set_model: { since: SERVE_PROTOCOL_VERSION },
  permission_vote: { since: SERVE_PROTOCOL_VERSION },
} as const satisfies Record<string, ServeCapabilityDescriptor>;

export type ServeFeature = keyof typeof SERVE_CAPABILITY_REGISTRY;

export const SERVE_FEATURES = Object.freeze(
  Object.keys(SERVE_CAPABILITY_REGISTRY) as ServeFeature[],
);

export function getServeFeatures(): ServeFeature[] {
  return [...SERVE_FEATURES];
}

export function getServeProtocolVersions(): ServeProtocolVersions {
  return {
    current: SERVE_PROTOCOL_VERSION,
    supported: [...SUPPORTED_SERVE_PROTOCOL_VERSIONS],
  };
}
