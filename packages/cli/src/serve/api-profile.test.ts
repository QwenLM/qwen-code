/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  API_PROFILES,
  DEFAULT_API_PROFILE,
  MINIMAL_PROFILE_PATHS,
  apiProfileGate,
  isMinimalProfilePath,
} from './api-profile.js';

const OPENAPI_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/developers/qwen-serve-openapi.yaml',
);

/** `/session/{id}/prompt` (OpenAPI) -> `/session/:id/prompt` (Express). */
function toExpressPath(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1');
}

function callGate(profile: 'full' | 'minimal', reqPath: string) {
  const gate = apiProfileGate(profile);
  const next = vi.fn<NextFunction>();
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  gate?.({ path: reqPath } as Request, res as unknown as Response, next);
  return { gate, next, res };
}

describe('api profile', () => {
  it('defaults to full, which installs no gate at all', () => {
    expect(DEFAULT_API_PROFILE).toBe('full');
    expect(apiProfileGate('full')).toBeUndefined();
    expect(API_PROFILES).toEqual(['full', 'minimal']);
  });

  it('passes minimal-profile paths through', () => {
    const { next, res } = callGate('minimal', '/session/abc-123/prompt');
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('404s paths outside the profile with a distinguishable code', () => {
    const { next, res } = callGate('minimal', '/workspace/trust');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'api_profile_disabled' }),
    );
  });

  it('matches the way Express routes: case-insensitive, optional trailing slash', () => {
    // A gate stricter than the router would let these reach a route the
    // profile means to disable.
    expect(isMinimalProfilePath('/Session/abc/Prompt')).toBe(true);
    expect(isMinimalProfilePath('/session/abc/prompt/')).toBe(true);
  });

  it('does not let a path parameter swallow extra segments', () => {
    // `:id` is `[^/]+`, so a deeper path must not match a shallower pattern.
    expect(isMinimalProfilePath('/session/abc/prompt/extra')).toBe(false);
    expect(isMinimalProfilePath('/workspace/tools/../trust')).toBe(false);
  });

  it('excludes the high-risk surface', () => {
    for (const disabled of [
      '/workspace/trust',
      '/workspace/settings',
      '/workspace/extensions',
      '/workspace/git/push',
      '/workspace/generate',
      '/scheduled-tasks',
      '/usage/dashboard',
      '/file/write',
      '/file/edit',
    ]) {
      expect(isMinimalProfilePath(disabled)).toBe(false);
    }
  });
});

describe('minimal profile / OpenAPI drift guard', () => {
  const spec = parseYaml(readFileSync(OPENAPI_PATH, 'utf8')) as {
    paths: Record<string, unknown>;
  };
  const specPaths = Object.keys(spec.paths).map(toExpressPath).sort();
  const profilePaths = [...MINIMAL_PROFILE_PATHS].sort();

  it('describes exactly the paths the minimal profile serves', () => {
    // Both directions: a path in the spec that the profile 404s is a broken
    // promise to partners; a path the profile serves that the spec omits is
    // an undocumented surface they will find anyway.
    expect(specPaths).toEqual(profilePaths);
  });

  it('every documented path is actually reachable under the profile', () => {
    for (const specPath of specPaths) {
      const concrete = specPath.replace(/:[^/]+/g, 'x');
      expect(isMinimalProfilePath(concrete)).toBe(true);
    }
  });
});
