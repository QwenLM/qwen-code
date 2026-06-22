/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  OssPublisher,
  signOssPut,
  ossCredentialsFromEnv,
  type HttpPut,
  type OssCredentials,
} from './oss-publisher.js';

const creds: OssCredentials = {
  accessKeyId: 'AKID',
  accessKeySecret: 'SECRET',
};
const input = { id: 'cafe1234', title: 'T', html: '<p>hi</p>' };
const fixedNow = () => new Date('2026-06-21T00:00:00Z');

describe('signOssPut', () => {
  const base = {
    credentials: creds,
    bucket: 'bkt',
    key: 'artifacts/cafe1234/index.html',
    contentType: 'text/html',
    date: 'Sun, 21 Jun 2026 00:00:00 GMT',
    acl: 'public-read',
  };

  it('produces an OSS Authorization header and the acl header', () => {
    const { authorization, ossHeaders } = signOssPut(base);
    expect(authorization).toMatch(/^OSS AKID:.+/);
    // base64 signature after the colon
    expect(authorization.split(':')[1]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(ossHeaders['x-oss-object-acl']).toBe('public-read');
  });

  it('is deterministic and key-sensitive', () => {
    expect(signOssPut(base).authorization).toBe(signOssPut(base).authorization);
    const other = signOssPut({ ...base, key: 'artifacts/other/index.html' });
    expect(other.authorization).not.toBe(signOssPut(base).authorization);
  });

  it('includes the security token header when present', () => {
    const { ossHeaders } = signOssPut({
      ...base,
      credentials: { ...creds, securityToken: 'STS' },
    });
    expect(ossHeaders['x-oss-security-token']).toBe('STS');
  });
});

describe('ossCredentialsFromEnv', () => {
  it('reads OSS_* names', () => {
    expect(
      ossCredentialsFromEnv({
        OSS_ACCESS_KEY_ID: 'a',
        OSS_ACCESS_KEY_SECRET: 'b',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      accessKeyId: 'a',
      accessKeySecret: 'b',
      securityToken: undefined,
    });
  });
  it('falls back to ALIBABA_CLOUD_* names', () => {
    expect(
      ossCredentialsFromEnv({
        ALIBABA_CLOUD_ACCESS_KEY_ID: 'a',
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'b',
      } as NodeJS.ProcessEnv),
    ).toMatchObject({ accessKeyId: 'a', accessKeySecret: 'b' });
  });
  it('returns undefined when missing', () => {
    expect(ossCredentialsFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('OssPublisher', () => {
  it('PUTs to the virtual-hosted URL with signed headers and returns the public url', async () => {
    let captured:
      | { url: string; headers: Record<string, string>; body: string }
      | undefined;
    const httpPut: HttpPut = async (url, headers, body) => {
      captured = { url, headers, body };
    };
    const pub = new OssPublisher(
      { bucket: 'bkt', endpoint: 'oss-cn-hangzhou.aliyuncs.com' },
      { httpPut, credentials: () => creds, now: fixedNow },
    );

    const res = await pub.publish(input);

    const expectedUrl =
      'https://bkt.oss-cn-hangzhou.aliyuncs.com/artifacts/cafe1234/index.html';
    expect(captured?.url).toBe(expectedUrl);
    expect(captured?.headers['Authorization']).toMatch(/^OSS AKID:/);
    expect(captured?.headers['Content-Type']).toBe('text/html');
    expect(captured?.headers['x-oss-object-acl']).toBe('public-read');
    expect(captured?.headers['Date']).toBeTruthy();
    expect(captured?.body).toBe('<p>hi</p>');
    expect(res.url).toBe(expectedUrl);
  });

  it('uses publicBaseUrl for the returned url when set', async () => {
    const httpPut: HttpPut = async () => {};
    const res = await new OssPublisher(
      {
        bucket: 'bkt',
        endpoint: 'oss-cn-hangzhou.aliyuncs.com',
        publicBaseUrl: 'https://cdn.example.com/',
      },
      { httpPut, credentials: () => creds, now: fixedNow },
    ).publish(input);
    expect(res.url).toBe(
      'https://cdn.example.com/artifacts/cafe1234/index.html',
    );
  });

  it('uses a timeout signal for default uploads', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await new OssPublisher(
        { bucket: 'bkt', endpoint: 'oss-cn-hangzhou.aliyuncs.com' },
        { credentials: () => creds, now: fixedNow },
      ).publish(input);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('hides OSS error response bodies from thrown errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('secret AccessKeyId', { status: 403 })),
    );
    try {
      await expect(
        new OssPublisher(
          { bucket: 'bkt', endpoint: 'oss-cn-hangzhou.aliyuncs.com' },
          { credentials: () => creds, now: fixedNow },
        ).publish(input),
      ).rejects.toThrow('OSS upload failed: 403');
      await expect(
        new OssPublisher(
          { bucket: 'bkt', endpoint: 'oss-cn-hangzhou.aliyuncs.com' },
          { credentials: () => creds, now: fixedNow },
        ).publish(input),
      ).rejects.not.toThrow('AccessKeyId');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('honors a custom keyPrefix', async () => {
    let url = '';
    const httpPut: HttpPut = async (u) => {
      url = u;
    };
    await new OssPublisher(
      { bucket: 'bkt', endpoint: 'e.aliyuncs.com', keyPrefix: '/pages/' },
      { httpPut, credentials: () => creds, now: fixedNow },
    ).publish(input);
    expect(url).toBe('https://bkt.e.aliyuncs.com/pages/cafe1234/index.html');
  });

  it('rejects invalid keyPrefix values', async () => {
    const httpPut = vi.fn<HttpPut>(async () => {});
    await expect(
      new OssPublisher(
        {
          bucket: 'bkt',
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          keyPrefix: '/',
        },
        { httpPut, credentials: () => creds, now: fixedNow },
      ).publish(input),
    ).rejects.toThrow(/keyPrefix/i);
    await expect(
      new OssPublisher(
        {
          bucket: 'bkt',
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          keyPrefix: 'bad prefix',
        },
        { httpPut, credentials: () => creds, now: fixedNow },
      ).publish(input),
    ).rejects.toThrow(/keyPrefix/i);
    expect(httpPut).not.toHaveBeenCalled();
  });

  it('rejects when bucket/endpoint/credentials are missing', async () => {
    const httpPut = vi.fn<HttpPut>(async () => {});
    await expect(
      new OssPublisher(
        { bucket: '', endpoint: 'e' },
        { httpPut, credentials: () => creds },
      ).publish(input),
    ).rejects.toThrow(/bucket/i);
    await expect(
      new OssPublisher(
        { bucket: 'b', endpoint: '' },
        { httpPut, credentials: () => creds },
      ).publish(input),
    ).rejects.toThrow(/endpoint/i);
    await expect(
      new OssPublisher(
        { bucket: 'b', endpoint: 'oss-cn-hangzhou.aliyuncs.com' },
        { httpPut, credentials: () => undefined },
      ).publish(input),
    ).rejects.toThrow(/credentials/i);
    expect(httpPut).not.toHaveBeenCalled();
  });

  it('rejects non-Aliyun OSS endpoints before signing credentials', async () => {
    const httpPut = vi.fn<HttpPut>(async () => {});
    await expect(
      new OssPublisher(
        { bucket: 'b', endpoint: 'evil.example.com' },
        { httpPut, credentials: () => creds },
      ).publish(input),
    ).rejects.toThrow(/aliyun oss endpoint/i);
    expect(httpPut).not.toHaveBeenCalled();
  });

  it('propagates upload failure', async () => {
    const httpPut: HttpPut = async () => {
      throw new Error('403 Forbidden');
    };
    await expect(
      new OssPublisher(
        { bucket: 'b', endpoint: 'oss-cn-hangzhou.aliyuncs.com' },
        { httpPut, credentials: () => creds, now: fixedNow },
      ).publish(input),
    ).rejects.toThrow(/403/);
  });
});
