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
  session_scope_override: { since: 'v1' },
  session_load: { since: 'v1' },
  // ACP backs this with `connection.unstable_resumeSession`. Surface
  // the unstable prefix so clients don't pin against a `v1` shape that
  // the underlying ACP method may still change.
  unstable_session_resume: { since: 'v1' },
  session_list: { since: 'v1' },
  session_prompt: { since: 'v1' },
  session_cancel: { since: 'v1' },
  session_events: { since: 'v1' },
  session_set_model: { since: 'v1' },
  client_identity: { since: 'v1' },
  session_permission_vote: { since: 'v1' },
  permission_vote: { since: 'v1' },
  // Issue #4175 PR 15. Daemon was booted with `--require-auth` (or
  // `requireAuth: true`), so even loopback callers must carry a bearer
  // token. Advertised CONDITIONALLY — only when the flag is on — so
  // SDK clients can branch on its presence to surface a clear "this
  // deployment requires auth" hint instead of speculatively trying
  // requests and parsing the resulting 401 body. Loopback developer
  // defaults (no flag) omit the tag, preserving the bit-for-bit shape
  // older clients expect.
  require_auth: { since: 'v1' },
} as const satisfies Record<string, ServeCapabilityDescriptor>;

export type ServeFeature = keyof typeof SERVE_CAPABILITY_REGISTRY;

/**
 * Subset of `ServeFeature` whose advertisement depends on runtime config
 * (currently just `require_auth`, which is announced only when the
 * daemon was started with `--require-auth`). Kept as a single source of
 * truth so `getAdvertisedServeFeatures` and the route layer stay in
 * agreement about which tags are baseline-on vs. opt-in.
 */
export const CONDITIONAL_SERVE_FEATURES: ReadonlySet<ServeFeature> = new Set([
  'require_auth',
]);

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

/**
 * Per-deployment feature toggles surfaced through `/capabilities`.
 *
 * `requireAuth` controls whether the conditional `require_auth` tag is
 * advertised. Other Wave 4 follow-ups can extend this object as more
 * deployment-shape capability tags appear (e.g. `redact_errors`).
 */
export interface AdvertiseFeatureToggles {
  requireAuth?: boolean;
}

export function getAdvertisedServeFeatures(
  protocolVersion: ServeProtocolVersion = SERVE_PROTOCOL_VERSION,
  toggles: AdvertiseFeatureToggles = {},
): ServeFeature[] {
  return SERVE_FEATURES.filter((feature) => {
    if (!isFeatureAvailableInProtocol(feature, protocolVersion)) return false;
    // Conditional tags require an explicit toggle. Without this gate
    // every daemon would advertise `require_auth` regardless of whether
    // the operator opted in, breaking the "tag presence = behavior is
    // on" contract clients depend on.
    if (CONDITIONAL_SERVE_FEATURES.has(feature)) {
      if (feature === 'require_auth') return toggles.requireAuth === true;
      return false;
    }
    return true;
  });
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
