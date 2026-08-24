/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OssDirectUploader,
  createOmniUploader,
  isOmniDeliveredUri,
  isSelfHostedOssConfigured,
  mentionsOmniDeliveredUri,
  readSelfHostedOssConfig,
} from './oss-upload.js';
import { DashScopeUploader, type FetchFn } from './upload.js';

const SHA256 = '0123456789abcdef'.repeat(4);
const MIME = 'video/mp4';
/** Signatures below are HMAC-SHA1 vectors computed independently (Python
 * hmac/base64) over the canonical strings this uploader must produce — they
 * pin the canonical string layout, not just our own implementation. */
const FIXED_NOW = new Date('2026-08-20T00:00:00Z');
const FIXED_DATE_HEADER = 'Thu, 20 Aug 2026 00:00:00 GMT';
const PUT_SIGNATURE = '1Exjy3FDIm/rwMjyOufk+A+KHAc=';
const GET_EXPIRES = '1787353200';
const GET_SIGNATURE = 'YQiEicen+2nxllERSaGRtzllluc=';
const KEY = 'p/q/0123456789ab-video_sample.mp4';

function stubOssEnv(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    OMNI_OSS_ENDPOINT: 'oss-cn-shanghai-internal.aliyuncs.com',
    OMNI_OSS_BUCKET: 'test-bucket',
    OMNI_OSS_PREFIX: 'p/q',
    OMNI_OSS_ACCESS_KEY_ID: 'ak-test',
    OMNI_OSS_ACCESS_KEY_SECRET: 'sk-test',
    OMNI_OSS_URL_TTL_HOURS: undefined,
    ...overrides,
  };
  for (const [name, value] of Object.entries(base)) {
    vi.stubEnv(name, value);
  }
}

async function withTempFile<T>(
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-oss-'));
  try {
    const filePath = path.join(dir, 'video sample.mp4');
    await fs.writeFile(filePath, 'bytes');
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function okFetch(): ReturnType<typeof vi.fn<FetchFn>> {
  return vi
    .fn<FetchFn>()
    .mockResolvedValue(new Response(null, { status: 200 }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('readSelfHostedOssConfig', () => {
  it('returns null unless bucket, endpoint and both credentials are set', () => {
    for (const missing of [
      'OMNI_OSS_ENDPOINT',
      'OMNI_OSS_BUCKET',
      'OMNI_OSS_ACCESS_KEY_ID',
      'OMNI_OSS_ACCESS_KEY_SECRET',
    ]) {
      stubOssEnv({ [missing]: undefined });
      // Label the value so a failure names the variable that leaked through.
      expect({ missing, config: readSelfHostedOssConfig() }).toEqual({
        missing,
        config: null,
      });
      expect(isSelfHostedOssConfigured()).toBe(false);
    }
  });

  it('normalizes the endpoint scheme, trailing slash and prefix slashes', () => {
    stubOssEnv({
      OMNI_OSS_ENDPOINT: 'https://oss-cn-shanghai-internal.aliyuncs.com/',
      OMNI_OSS_PREFIX: '/a/b/',
    });
    expect(readSelfHostedOssConfig()).toMatchObject({
      endpoint: 'oss-cn-shanghai-internal.aliyuncs.com',
      prefix: 'a/b',
    });
  });

  it('defaults the URL TTL to 47h and rejects non-positive or junk values', () => {
    stubOssEnv();
    expect(readSelfHostedOssConfig()?.urlTtlHours).toBe(47);
    for (const bad of ['0', '-1', 'soon']) {
      stubOssEnv({ OMNI_OSS_URL_TTL_HOURS: bad });
      expect({ bad, ttl: readSelfHostedOssConfig()?.urlTtlHours }).toEqual({
        bad,
        ttl: 47,
      });
    }
    stubOssEnv({ OMNI_OSS_URL_TTL_HOURS: '2' });
    expect(readSelfHostedOssConfig()?.urlTtlHours).toBe(2);
  });

  it('picks up env set after module load', () => {
    stubOssEnv({ OMNI_OSS_BUCKET: undefined });
    expect(isSelfHostedOssConfigured()).toBe(false);
    vi.stubEnv('OMNI_OSS_BUCKET', 'late-bucket');
    expect(readSelfHostedOssConfig()?.bucket).toBe('late-bucket');
  });
});

describe('OssDirectUploader.uploadFile', () => {
  beforeEach(() => {
    stubOssEnv();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  it('PUTs to the content-addressed key with an OSS V1 header signature', async () => {
    const fetchFn = okFetch();
    const url = await withTempFile((filePath) =>
      new OssDirectUploader(readSelfHostedOssConfig()!, fetchFn).uploadFile({
        filePath,
        model: 'qwen-omni',
        mimeType: MIME,
        sha256: SHA256,
      }),
    );

    const [target, init] = fetchFn.mock.calls[0]!;
    expect(String(target)).toBe(
      `https://test-bucket.oss-cn-shanghai-internal.aliyuncs.com/${KEY}`,
    );
    expect(init?.method).toBe('PUT');
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get('authorization')).toBe(`OSS ak-test:${PUT_SIGNATURE}`);
    // The signed Date must be the one on the wire, or OSS recomputes a
    // different signature and answers 403.
    expect(headers.get('date')).toBe(FIXED_DATE_HEADER);
    expect(headers.get('content-type')).toBe(MIME);
    expect((init?.body as Blob).size).toBe(5);

    const presigned = new URL(url);
    expect(presigned.pathname).toBe(`/${KEY}`);
    expect(presigned.searchParams.get('OSSAccessKeyId')).toBe('ak-test');
    expect(presigned.searchParams.get('Expires')).toBe(GET_EXPIRES);
    expect(presigned.searchParams.get('Signature')).toBe(GET_SIGNATURE);
  });

  it('drops the prefix segment when none is configured', async () => {
    stubOssEnv({ OMNI_OSS_PREFIX: undefined });
    const fetchFn = okFetch();
    const url = await withTempFile((filePath) =>
      new OssDirectUploader(readSelfHostedOssConfig()!, fetchFn).uploadFile({
        filePath,
        model: 'qwen-omni',
        mimeType: MIME,
        sha256: SHA256,
      }),
    );
    expect(new URL(url).pathname).toBe('/0123456789ab-video_sample.mp4');
  });

  it('summarizes an upstream rejection without echoing the body', async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', {
        status: 403,
      }),
    );
    await expect(
      withTempFile((filePath) =>
        new OssDirectUploader(readSelfHostedOssConfig()!, fetchFn).uploadFile({
          filePath,
          model: 'qwen-omni',
          mimeType: MIME,
          sha256: SHA256,
        }),
      ),
    ).rejects.toThrow('OSS media upload failed: HTTP 403');
  });

  it('reports an unreadable file without attempting the request', async () => {
    const fetchFn = okFetch();
    await expect(
      new OssDirectUploader(readSelfHostedOssConfig()!, fetchFn).uploadFile({
        filePath: path.join(os.tmpdir(), 'omni-oss-missing', 'nope.mp4'),
        model: 'qwen-omni',
        mimeType: MIME,
        sha256: SHA256,
      }),
    ).rejects.toThrow('Failed to open file for upload: nope.mp4');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rethrows a caller abort untouched', async () => {
    const sentinel = new DOMException('aborted', 'AbortError');
    const fetchFn = vi.fn<FetchFn>().mockRejectedValue(sentinel);
    const controller = new AbortController();
    controller.abort();
    await expect(
      withTempFile((filePath) =>
        new OssDirectUploader(readSelfHostedOssConfig()!, fetchFn).uploadFile({
          filePath,
          model: 'qwen-omni',
          mimeType: MIME,
          sha256: SHA256,
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(sentinel);
  });
});

describe('isOmniDeliveredUri', () => {
  it('matches oss:// references with or without a self-hosted bucket', () => {
    stubOssEnv({ OMNI_OSS_BUCKET: undefined });
    expect(isOmniDeliveredUri('oss://dashscope/uploads/x.mp4')).toBe(true);
    stubOssEnv();
    expect(isOmniDeliveredUri('oss://dashscope/uploads/x.mp4')).toBe(true);
  });

  it('matches a presigned URL on the configured bucket host only', () => {
    stubOssEnv();
    const host = 'test-bucket.oss-cn-shanghai-internal.aliyuncs.com';
    expect(isOmniDeliveredUri(`https://${host}/p/q/x.mp4?Expires=1`)).toBe(
      true,
    );
    expect(isOmniDeliveredUri(`https://other-bucket.aliyuncs.com/x.mp4`)).toBe(
      false,
    );
    expect(isOmniDeliveredUri(`https://evil.example/${host}/x.mp4`)).toBe(
      false,
    );
  });

  it('is false for a presigned URL when no bucket is configured', () => {
    stubOssEnv({ OMNI_OSS_ACCESS_KEY_SECRET: undefined });
    expect(
      isOmniDeliveredUri(
        'https://test-bucket.oss-cn-shanghai-internal.aliyuncs.com/x.mp4',
      ),
    ).toBe(false);
  });

  it('is false for undefined and for non-URL strings', () => {
    stubOssEnv();
    expect(isOmniDeliveredUri(undefined)).toBe(false);
    expect(isOmniDeliveredUri('/local/path/x.mp4')).toBe(false);
  });
});

describe('mentionsOmniDeliveredUri', () => {
  it('recognizes both the oss:// scheme and the delivery bucket host', () => {
    stubOssEnv();
    expect(mentionsOmniDeliveredUri('cannot read oss://a/b.mp4')).toBe(true);
    expect(
      mentionsOmniDeliveredUri(
        'Error while loading data https://test-bucket.oss-cn-shanghai-internal.aliyuncs.com/p/q/x.mp4?Expires=1',
      ),
    ).toBe(true);
    expect(mentionsOmniDeliveredUri('connection loss across the wire')).toBe(
      false,
    );
  });

  it('ignores the bucket host when the bucket is not configured', () => {
    stubOssEnv({ OMNI_OSS_ENDPOINT: undefined });
    expect(
      mentionsOmniDeliveredUri(
        'failed on https://test-bucket.oss-cn-shanghai-internal.aliyuncs.com/x',
      ),
    ).toBe(false);
  });
});

describe('createOmniUploader', () => {
  it('prefers the self-hosted bucket and falls back to DashScope', () => {
    stubOssEnv();
    expect(
      createOmniUploader({ apiKey: 'sk', baseUrl: 'https://x/v1' }),
    ).toBeInstanceOf(OssDirectUploader);
    stubOssEnv({ OMNI_OSS_BUCKET: undefined });
    expect(
      createOmniUploader({ apiKey: 'sk', baseUrl: 'https://x/v1' }),
    ).toBeInstanceOf(DashScopeUploader);
  });
});
