/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  MINIMAL_FEATURES,
  apiProfileGate,
  profileFeatures,
} from './api-profile.js';
import {
  SERVE_CAPABILITY_REGISTRY,
  getAdvertisedServeFeatures,
} from './capabilities.js';

describe('API profile gate', () => {
  it('preserves enabled prompt features without advertising disabled timeouts', () => {
    const enabled = getAdvertisedServeFeatures(undefined, {
      promptDeadlineMs: 10000,
      writerIdleTimeoutMs: 10000,
    });
    expect(profileFeatures(enabled, 'minimal')).toEqual(
      expect.arrayContaining([
        'non_blocking_prompt',
        'prompt_absolute_deadline',
        'writer_idle_timeout',
      ]),
    );
    const defaults = profileFeatures(getAdvertisedServeFeatures(), 'minimal');
    expect(defaults).toContain('non_blocking_prompt');
    expect(defaults).not.toContain('prompt_absolute_deadline');
    expect(defaults).not.toContain('writer_idle_timeout');
    expect(profileFeatures(enabled, 'full')).toEqual(enabled);
  });

  it('leaves full routing unchanged', () => {
    expect(apiProfileGate()).toBeUndefined();
    expect(apiProfileGate('full')).toBeUndefined();
  });

  it('matches Express paths without allowing administrative subroutes', async () => {
    const app = express();
    app.use(apiProfileGate('minimal')!);
    app.post('/session/:id/prompt', (_req, res) => res.sendStatus(204));
    app.post('/workspace/trust', (_req, res) => res.sendStatus(204));
    for (const path of ['/session/abc/prompt', '/Session/abc/Prompt/']) {
      await request(app).post(path).expect(204);
    }
    for (const path of [
      '/workspace/trust',
      '/session/abc/prompt/extra',
      '/file/write',
    ]) {
      const res = await request(app).post(path).expect(403);
      expect(res.body.code).toBe('api_profile_disabled');
    }
  });

  it('advertises only tags the capability registry still defines', () => {
    // The filter matches by string, so a tag renamed upstream simply stops
    // matching: the capability disappears from `/capabilities` under minimal
    // while its route keeps working, and nothing else fails. Fail here instead.
    const registered = new Set<string>(Object.keys(SERVE_CAPABILITY_REGISTRY));
    expect(
      [...MINIMAL_FEATURES].filter((tag) => !registered.has(tag)).sort(),
    ).toEqual([]);
  });
});
