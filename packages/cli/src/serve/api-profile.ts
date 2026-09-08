/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';

export const API_PROFILES = ['full', 'minimal'] as const;
export type ApiProfile = (typeof API_PROFILES)[number];
export const DEFAULT_API_PROFILE: ApiProfile = 'full';

// Exact paths: allowing a session must not allow its administrative subroutes.
// Exported so `server.test.ts` can assert every entry still resolves to a route
// a real app registers: a path renamed upstream would otherwise sit here as a
// dead entry, silently narrowing the profile with nothing failing.
export const MINIMAL_PROFILE_PATHS = [
  '/health',
  '/capabilities',
  '/session',
  '/session/:id',
  '/session/:id/prompt',
  '/session/:id/cancel',
  '/session/:id/events',
  '/session/:id/status',
  '/session/:id/transcript',
  '/session/:id/context',
  '/session/:id/export',
  '/session/:id/pending-prompts',
  '/session/:id/heartbeat',
  '/session/:id/metadata',
  '/session/:id/model',
  '/session/:id/load',
  '/session/:id/resume',
  '/session/:id/permission/:requestId',
  '/permission/:requestId',
  '/workspace/tools',
  '/file',
  '/file/bytes',
  '/stat',
  '/list',
  '/glob',
];

const MINIMAL_PROFILE_MATCHERS = MINIMAL_PROFILE_PATHS.map(
  (path) => new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}/?$`, 'i'),
);

// Advertise only capabilities whose complete route surface remains available.
// Exported so `api-profile.test.ts` can assert every tag still exists in
// SERVE_CAPABILITY_REGISTRY: a tag renamed upstream would fall out of this set
// silently, dropping a working capability from `/capabilities` under minimal.
export const MINIMAL_FEATURES = new Set([
  'health',
  'capabilities',
  'session_create',
  'session_id_override',
  'session_scope_override',
  'session_load',
  'session_resume',
  'unstable_session_resume',
  'session_prompt',
  'session_cancel',
  'session_events',
  'slow_client_warning',
  'typed_event_schema',
  'session_set_model',
  'client_identity',
  'client_heartbeat',
  'session_permission_vote',
  'permission_vote',
  'session_context',
  'session_status',
  'session_close',
  'session_metadata',
  'session_export',
  'session_transcript',
  'session_transcript_pagination',
  'workspace_file_read',
  'workspace_file_bytes',
  'workspace_file_read_cursor',
  'require_auth',
  'allow_origin',
  'rate_limit',
  'permission_mediation',
]);

export function profileFeatures<T extends string>(
  features: T[],
  profile: ApiProfile = DEFAULT_API_PROFILE,
): T[] {
  return profile === 'minimal'
    ? features.filter((feature) => MINIMAL_FEATURES.has(feature))
    : features;
}

export function apiProfileGate(
  profile: ApiProfile = DEFAULT_API_PROFILE,
): RequestHandler | undefined {
  if (profile === 'full') return undefined;
  return (req, res, next) => {
    if (MINIMAL_PROFILE_MATCHERS.some((matcher) => matcher.test(req.path))) {
      next();
      return;
    }
    // SDK idempotent operations treat 404 as success; a disabled route isn't missing.
    res.status(403).json({
      error: 'Route disabled by API profile',
      code: 'api_profile_disabled',
      apiProfile: profile,
    });
  };
}
