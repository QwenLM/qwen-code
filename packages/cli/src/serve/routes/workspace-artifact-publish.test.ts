/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  clearRememberedShareTargets,
  registerWorkspaceArtifactPublishRoutes,
} from './workspace-artifact-publish.js';
import { loadSettings } from '../../config/settings.js';

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    OssPublisher: class {
      constructor(
        readonly config: unknown,
        readonly deps: unknown,
      ) {}
      publish = publish;
    },
  };
});

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return { ...actual, loadSettings: vi.fn() };
});

function mockSettings(artifact: Record<string, unknown>) {
  vi.mocked(loadSettings).mockReturnValue({
    merged: { artifact },
    user: { settings: {} },
    workspace: { settings: {} },
    forScope: vi.fn().mockReturnValue({ settings: {} }),
  } as never);
}

const HTML = '<!doctype html><h1>report</h1>';

/** Serves `html` back in windows no larger than the read cap. */
function windowReader(html: string, sizeOverride?: number) {
  const buffer = Buffer.from(html, 'utf8');
  const sizeBytes = sizeOverride ?? buffer.length;
  return vi.fn(
    async (_p: unknown, opts: { offset: number; maxBytes: number }) => {
      const slice = buffer.subarray(opts.offset, opts.offset + opts.maxBytes);
      return {
        buffer: slice,
        sizeBytes,
        returnedBytes: slice.length,
        offset: opts.offset,
        truncated: false,
      };
    },
  );
}

function makeApp(readBytesWindow = windowReader(HTML)) {
  const app = express();
  app.use(express.json());
  app.locals['fsFactory'] = {
    forRequest: () => ({
      resolve: vi.fn(async (p: string) => `/workspace/${p}`),
      readBytesWindow,
    }),
  };
  registerWorkspaceArtifactPublishRoutes(app, {
    boundWorkspace: '/workspace',
    sendBridgeError: (res, err) => {
      res.status(500).json({ error: (err as Error).message });
    },
  });
  return app;
}

beforeEach(() => {
  clearRememberedShareTargets();
  publish.mockReset();
  vi.unstubAllEnvs();
  mockSettings({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /workspace/artifact/publish-config', () => {
  it('seeds the destination from settings without inventing a credential', async () => {
    vi.stubEnv('OSS_ACCESS_KEY_ID', '');
    vi.stubEnv('OSS_ACCESS_KEY_SECRET', '');
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_ID', '');
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_SECRET', '');
    mockSettings({
      oss: {
        endpoint: 'oss-cn-hangzhou.aliyuncs.com',
        bucket: 'my-bucket',
        // Credentials are never sourced from settings, even if present.
        accessKeyId: 'ak-id',
        accessKeySecret: 'ak-secret',
      },
    });

    const res = await request(makeApp()).get(
      '/workspace/artifact/publish-config',
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      bucket: 'my-bucket',
      credentialsSource: 'none',
    });
    expect(JSON.stringify(res.body)).not.toContain('ak-secret');
    expect(JSON.stringify(res.body)).not.toContain('ak-id');
  });

  it('reports the environment as the source when settings carry no credential', async () => {
    vi.stubEnv('OSS_ACCESS_KEY_ID', 'env-id');
    vi.stubEnv('OSS_ACCESS_KEY_SECRET', 'env-secret');

    const res = await request(makeApp()).get(
      '/workspace/artifact/publish-config',
    );

    expect(res.body.credentialsSource).toBe('env');
  });

  it('reports no source when nothing is configured', async () => {
    vi.stubEnv('OSS_ACCESS_KEY_ID', '');
    vi.stubEnv('OSS_ACCESS_KEY_SECRET', '');
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_ID', '');
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_SECRET', '');

    const res = await request(makeApp()).get(
      '/workspace/artifact/publish-config',
    );

    expect(res.body.credentialsSource).toBe('none');
  });
});

describe('POST /workspace/artifact/publish', () => {
  let readBytesWindow = windowReader(HTML);

  beforeEach(() => {
    readBytesWindow = windowReader(HTML);
    publish.mockResolvedValue({
      id: 'abc123',
      url: 'https://my-bucket.example.com/artifacts/abc123/index.html',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
  });

  it('publishes the file byte-for-byte and probes the returned link', async () => {
    vi.stubEnv('OSS_ACCESS_KEY_ID', 'env-id');
    vi.stubEnv('OSS_ACCESS_KEY_SECRET', 'env-secret');
    mockSettings({
      oss: { endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'my-bucket' },
    });

    const res = await request(makeApp(readBytesWindow))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html' });

    expect(res.status).toBe(200);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].html).toBe(HTML);
    expect(res.body).toMatchObject({
      url: 'https://my-bucket.example.com/artifacts/abc123/index.html',
      reachable: true,
      reachableStatus: 200,
    });
  });

  it('reports a link the probe could not reach', async () => {
    vi.stubEnv('OSS_ACCESS_KEY_ID', 'env-id');
    vi.stubEnv('OSS_ACCESS_KEY_SECRET', 'env-secret');
    mockSettings({
      oss: { endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'my-bucket' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );

    const res = await request(makeApp(readBytesWindow))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html' });

    expect(res.body).toMatchObject({ reachable: false, reachableStatus: 403 });
  });

  it('leaves reachability unknown when the probe itself fails', async () => {
    vi.stubEnv('OSS_ACCESS_KEY_ID', 'env-id');
    vi.stubEnv('OSS_ACCESS_KEY_SECRET', 'env-secret');
    mockSettings({
      oss: { endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'my-bucket' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const res = await request(makeApp(readBytesWindow))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html' });

    expect(res.status).toBe(200);
    expect(res.body.reachable).toBeNull();
  });

  it('takes the destination and credentials from the request body', async () => {
    const res = await request(makeApp(readBytesWindow))
      .post('/workspace/artifact/publish')
      .send({
        path: 'out/report.html',
        config: {
          endpoint: 'oss-cn-beijing.aliyuncs.com',
          bucket: 'typed-bucket',
          accessKeyId: 'typed-id',
          accessKeySecret: 'typed-secret',
        },
      });

    expect(res.status).toBe(200);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('remembers a target in process memory only when asked', async () => {
    const app = makeApp(readBytesWindow);
    await request(app)
      .post('/workspace/artifact/publish')
      .send({
        path: 'out/report.html',
        remember: 'memory',
        config: {
          endpoint: 'oss-cn-beijing.aliyuncs.com',
          bucket: 'typed-bucket',
          accessKeyId: 'typed-id',
          accessKeySecret: 'typed-secret',
        },
      });

    // The second call carries no config at all and still succeeds.
    const second = await request(app)
      .post('/workspace/artifact/publish')
      .send({ path: 'out/other.html' });

    expect(second.status).toBe(200);
    expect(publish).toHaveBeenCalledTimes(2);

    const config = await request(app).get('/workspace/artifact/publish-config');
    expect(config.body).toMatchObject({
      bucket: 'typed-bucket',
      credentialsSource: 'memory',
    });
    expect(JSON.stringify(config.body)).not.toContain('typed-secret');
  });

  it('forgets an unremembered target after the request', async () => {
    const app = makeApp(readBytesWindow);
    await request(app)
      .post('/workspace/artifact/publish')
      .send({
        path: 'out/report.html',
        config: {
          endpoint: 'oss-cn-beijing.aliyuncs.com',
          bucket: 'typed-bucket',
          accessKeyId: 'typed-id',
          accessKeySecret: 'typed-secret',
        },
      });

    const second = await request(app)
      .post('/workspace/artifact/publish')
      .send({ path: 'out/other.html' });

    expect(second.status).toBe(400);
    expect(second.body.code).toBe('oss_not_configured');
  });

  it('rejects a request with no destination', async () => {
    const res = await request(makeApp(readBytesWindow))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('oss_not_configured');
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a destination with no usable credential', async () => {
    mockSettings({
      oss: { endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'my-bucket' },
    });

    const res = await request(makeApp(readBytesWindow))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('oss_credentials_missing');
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a missing path', async () => {
    const res = await request(makeApp(readBytesWindow))
      .post('/workspace/artifact/publish')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('refuses a file past the publish limit', async () => {
    vi.stubEnv('OSS_ACCESS_KEY_ID', 'env-id');
    vi.stubEnv('OSS_ACCESS_KEY_SECRET', 'env-secret');
    mockSettings({
      oss: { endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'my-bucket' },
    });

    const res = await request(makeApp(windowReader(HTML, 17 * 1024 * 1024)))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('artifact_too_large');
    expect(publish).not.toHaveBeenCalled();
  });

  it('walks a file larger than one read window', async () => {
    vi.stubEnv('OSS_ACCESS_KEY_ID', 'env-id');
    vi.stubEnv('OSS_ACCESS_KEY_SECRET', 'env-secret');
    mockSettings({
      oss: { endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: 'my-bucket' },
    });
    // Three read windows' worth: a single 256 KB read cannot carry it.
    const big = 'x'.repeat(700 * 1024);
    const reader = windowReader(big);

    const res = await request(makeApp(reader))
      .post('/workspace/artifact/publish')
      .send({ path: 'out/report.html' });

    expect(res.status).toBe(200);
    expect(reader.mock.calls.length).toBeGreaterThan(1);
    // Every window must ask for no more than the read cap, and the document
    // must arrive whole.
    for (const [, opts] of reader.mock.calls) {
      expect(opts.maxBytes).toBeLessThanOrEqual(256 * 1024);
    }
    expect(publish.mock.calls[0][0].html).toBe(big);
  });
});
