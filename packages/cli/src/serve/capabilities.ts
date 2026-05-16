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
  health: { since: 'v1' },
  capabilities: { since: 'v1' },
  session_create: { since: 'v1' },
  session_list: { since: 'v1' },
  session_prompt: { since: 'v1' },
  session_cancel: { since: 'v1' },
  session_events: { since: 'v1' },
  session_set_model: { since: 'v1' },
  permission_vote: { since: 'v1' },
} as const satisfies Record<string, ServeCapabilityDescriptor>;

export type ServeFeature = keyof typeof SERVE_CAPABILITY_REGISTRY;

export const SERVE_FEATURES = Object.freeze(
  Object.keys(SERVE_CAPABILITY_REGISTRY) as ServeFeature[],
);

function serveProtocolVersionIndex(version: ServeProtocolVersion): number {
  return SUPPORTED_SERVE_PROTOCOL_VERSIONS.indexOf(version);
}

function isFeatureAvailableInProtocol(
  feature: ServeFeature,
  protocolVersion: ServeProtocolVersion,
): boolean {
  return (
    serveProtocolVersionIndex(SERVE_CAPABILITY_REGISTRY[feature].since) <=
    serveProtocolVersionIndex(protocolVersion)
  );
}

export function getRegisteredServeFeatures(): ServeFeature[] {
  return [...SERVE_FEATURES];
}

export function getAdvertisedServeFeatures(
  protocolVersion: ServeProtocolVersion = SERVE_PROTOCOL_VERSION,
): ServeFeature[] {
  return SERVE_FEATURES.filter((feature) =>
    isFeatureAvailableInProtocol(feature, protocolVersion),
  );
}

export function getServeFeatures(): ServeFeature[] {
  return getAdvertisedServeFeatures();
}

export function getServeProtocolVersions(): ServeProtocolVersions {
  return {
    current: SERVE_PROTOCOL_VERSION,
    supported: [...SUPPORTED_SERVE_PROTOCOL_VERSIONS],
  };
}
