/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mountWebShellAssets,
  buildWebShellCsp,
  buildWebShellPermissionsPolicy,
} from './web-shell-static.js';

const stderr = vi.hoisted(() => ({ writeStderrLine: vi.fn() }));
vi.mock('../utils/stdioHelpers.js', () => stderr);

describe('Web Shell sandbox framing', () => {
  it('allows live previews and PDF blobs while retaining shell isolation', () => {
    const csp = buildWebShellCsp();
    expect(csp).toContain('frame-src http: https: blob:;');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("media-src 'self' data:");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
    );
    expect(csp).not.toContain('frame-src *');
  });

  it('retains the explicit embedding ancestor allowlist', () => {
    const csp = buildWebShellCsp(['chrome-extension://test-extension']);
    expect(csp).toContain('frame-ancestors chrome-extension://test-extension');
    expect(csp).toContain('frame-src http: https: blob:;');
  });

  it('keeps camera, microphone, and geolocation host-blocked', () => {
    const policy = buildWebShellPermissionsPolicy();
    expect(policy).toContain('camera=()');
    expect(policy).toContain('microphone=(self)');
    expect(policy).toContain('geolocation=()');
    expect(policy).toContain('payment=()');
    expect(policy).toContain('clipboard-write=(self)');
    expect(policy).not.toContain('localhost');
  });
});

describe('public PWA HTTP routes', () => {
  let directory: string;
  let app: express.Express;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'qwen-pwa-'));
    await mkdir(path.join(directory, 'assets'));
    await writeFile(
      path.join(directory, 'manifest.webmanifest'),
      '{"name":"Qwen Code"}',
    );
    await writeFile(
      path.join(directory, 'sw.js'),
      'self.addEventListener("fetch", () => {});',
    );
    await writeFile(
      path.join(directory, 'assets', 'index-abc12345.js'),
      'export {};',
    );
    await writeFile(path.join(directory, 'assets', 'icon-192.png'), 'icon');
    await writeFile(path.join(directory, 'assets', 'icon.svg'), '<svg/>');
    await writeFile(path.join(directory, 'assets', 'future-config.json'), '{}');
    app = express();
    mountWebShellAssets(app, directory);
    app.use((_req, res) => {
      res.status(401).send('Unauthorized');
    });
    app.use(
      (
        _err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).send('Error');
      },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    stderr.writeStderrLine.mockReset();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['/manifest.webmanifest', '/MANIFEST.WEBMANIFEST/'])(
    'serves %s without a token and permits revalidation',
    async (url) => {
      const response = await request(app).get(url).expect(200);
      expect(response.headers['content-type']).toContain(
        'application/manifest+json',
      );
      expect(JSON.parse(response.text)).toEqual({ name: 'Qwen Code' });
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      await request(app).head(url).expect(200);
      await request(app)
        .get(url)
        .set('If-None-Match', response.headers['etag'])
        .expect(304);
    },
  );

  it('serves a root worker with the correct type and scope', async () => {
    const response = await request(app).get('/sw.js').expect(200);
    expect(response.headers['content-type']).toContain(
      'application/javascript',
    );
    expect(response.headers['service-worker-allowed']).toBe('/');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.text).toContain('addEventListener');
  });

  it('revalidates unhashed icons but keeps hashed build assets immutable', async () => {
    expect(
      (await request(app).get('/assets/icon.svg').expect(200)).headers[
        'cache-control'
      ],
    ).toBe('no-cache');
    expect(
      (await request(app).get('/assets/icon-192.png').expect(200)).headers[
        'cache-control'
      ],
    ).toBe('no-cache');
    expect(
      (await request(app).get('/assets/index-abc12345.js').expect(200)).headers[
        'cache-control'
      ],
    ).toContain('immutable');
    expect(
      (await request(app).get('/assets/future-config.json').expect(200))
        .headers['cache-control'],
    ).toBe('no-cache');
  });

  it.each(['/sw.js', '/manifest.webmanifest'])(
    'returns 404, not HTML or a catch-all 500, when %s is absent',
    async (url) => {
      await rm(path.join(directory, url.slice(1)));
      const response = await request(app).get(url).expect(404);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toBe('Not found');
    },
  );

  it('logs a route-specific error when a PWA file cannot be read', async () => {
    vi.spyOn(express.response, 'sendFile').mockImplementation(function (
      this: express.Response,
      ...args: unknown[]
    ) {
      const callback = args.at(-1) as (
        error: Error & { status: number },
      ) => void;
      callback(
        Object.assign(new Error('EACCES: permission denied'), { status: 403 }),
      );
      return this;
    });

    await request(app)
      .get('/sw.js')
      .expect(500, 'Failed to load Web Shell asset');
    expect(stderr.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('/sw.js'),
    );
    expect(stderr.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('EACCES: permission denied'),
    );
  });

  it('retains authentication for API requests and writes', async () => {
    await request(app).get('/capabilities').expect(401);
    await request(app).post('/sw.js').expect(401);
    await request(app).post('/manifest.webmanifest').expect(401);
    await request(app).get('/sw.js/extra').expect(401);
  });
});
