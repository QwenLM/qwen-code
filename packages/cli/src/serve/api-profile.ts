/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * How much of the HTTP surface the daemon exposes.
 *
 *  - `full` (default) — every route the daemon registers. This is the surface
 *    the Web Shell drives; it is NOT covered by the OpenAPI spec and carries
 *    no stability promise for external callers.
 *  - `minimal` — the partner-facing REST subset described by
 *    `docs/developers/qwen-serve-openapi.yaml`. Everything else answers 404.
 *
 * See `docs/plans/2026-09-08-serve-api-decoupling.md`.
 */
export const API_PROFILES = ['full', 'minimal'] as const;

export type ApiProfile = (typeof API_PROFILES)[number];

export const DEFAULT_API_PROFILE: ApiProfile = 'full';

/**
 * Paths the `minimal` profile serves: session lifecycle, prompting, the event
 * stream, permission responses, and read-only workspace context.
 *
 * Deliberately EXCLUDED so a leaked bearer token cannot reach them:
 * `/workspace/trust`, `/workspace/settings`, `/workspace/extensions*`,
 * `/workspace/git/*`, `/workspace/github/*`, `/workspace/channel*`, `/live/*`,
 * `/workspace/voice`, `/workspace/generate`, `/workspace/init`,
 * `/workspace/reload`, `/scheduled-tasks`, `/goals`, `/usage/dashboard`,
 * `/workspace-registrations`.
 *
 * Matching is by PATH, not by method: `/file` (read) and `/file/write` are
 * already distinct paths, so path granularity expresses "read-only file
 * access" without a method × path matrix. The cost is that a path whose GET is
 * safe but whose PATCH is not (`/workspace/settings`) can only be excluded
 * wholesale — a conservative direction.
 *
 * Keep in sync with `docs/developers/qwen-serve-openapi.yaml`; the drift guard
 * in `api-profile.test.ts` checks both directions.
 */
export const MINIMAL_PROFILE_PATHS: readonly string[] = [
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

/**
 * Compile a route pattern into a matcher for `req.path`.
 *
 * The patterns are a hardcoded constant in this file containing only path
 * separators, `:params`, letters and hyphens — no regex metacharacters — so
 * substituting `:param` directly is safe without a general escape pass.
 *
 * Case-insensitive with an optional trailing slash because that is what
 * Express's default (non-strict, case-insensitive) routing accepts; a gate
 * that were stricter than the router would let `/Session/x/Prompt` through to
 * a route the profile means to disable.
 */
function toMatcher(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}/?$`, 'i');
}

const MINIMAL_MATCHERS = MINIMAL_PROFILE_PATHS.map(toMatcher);

/** True when `path` is served under the `minimal` profile. */
export function isMinimalProfilePath(path: string): boolean {
  return MINIMAL_MATCHERS.some((matcher) => matcher.test(path));
}

/**
 * Build the profile gate, or `undefined` for `full` (in which case the caller
 * installs nothing and the middleware chain is byte-identical to before this
 * option existed).
 *
 * Mount AFTER the `authenticate` middleware so an unauthenticated caller gets a
 * uniform 401 and cannot enumerate which routes a deployment enabled by
 * diffing 401 vs 404.
 */
export function apiProfileGate(
  profile: ApiProfile = DEFAULT_API_PROFILE,
): RequestHandler | undefined {
  if (profile === 'full') return undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    if (isMinimalProfilePath(req.path)) return next();
    res.status(404).json({
      error: 'Not found',
      code: 'api_profile_disabled',
      apiProfile: profile,
    });
  };
}
