/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac } from 'node:crypto';
import type {
  ArtifactOssConfig,
  ArtifactPublisher,
  PublishArtifactInput,
  PublishedArtifact,
} from './publisher.js';

/** OSS access credentials, read from the environment by default. */
export interface OssCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  /** STS security token (optional). */
  securityToken?: string;
}

/** Performs the HTTP PUT. Injectable so tests don't hit the network. */
export type HttpPut = (
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
) => Promise<void>;

const defaultHttpPut: HttpPut = async (url, headers, body, signal) => {
  const timeout = AbortSignal.timeout(60_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body,
    signal: combinedSignal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `OSS upload failed: ${res.status} ${res.statusText}${
        text ? ` — ${text.slice(0, 300)}` : ''
      }`,
    );
  }
};

/** Reads OSS credentials from the environment (OSS_* or ALIBABA_CLOUD_*). */
export function ossCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OssCredentials | undefined {
  const accessKeyId =
    env['OSS_ACCESS_KEY_ID'] || env['ALIBABA_CLOUD_ACCESS_KEY_ID'];
  const accessKeySecret =
    env['OSS_ACCESS_KEY_SECRET'] || env['ALIBABA_CLOUD_ACCESS_KEY_SECRET'];
  if (!accessKeyId || !accessKeySecret) return undefined;
  const securityToken =
    env['OSS_SESSION_TOKEN'] ||
    env['ALIBABA_CLOUD_SECURITY_TOKEN'] ||
    undefined;
  return { accessKeyId, accessKeySecret, securityToken };
}

/**
 * Builds the OSS V1 (HMAC-SHA1) Authorization header and the x-oss-* headers
 * for a PUT Object request. Pure — separated out so the signature is unit
 * testable against a known vector.
 */
export function signOssPut(params: {
  credentials: OssCredentials;
  bucket: string;
  key: string;
  contentType: string;
  date: string;
  acl?: string;
}): { authorization: string; ossHeaders: Record<string, string> } {
  const ossHeaders: Record<string, string> = {};
  if (params.acl) ossHeaders['x-oss-object-acl'] = params.acl;
  if (params.credentials.securityToken) {
    ossHeaders['x-oss-security-token'] = params.credentials.securityToken;
  }
  // CanonicalizedOSSHeaders: x-oss-* lowercased, sorted, each "k:v\n".
  const canonicalizedHeaders = Object.keys(ossHeaders)
    .sort()
    .map((k) => `${k}:${ossHeaders[k]}\n`)
    .join('');
  const canonicalizedResource = `/${params.bucket}/${params.key}`;
  // PUT \n Content-MD5(empty) \n Content-Type \n Date \n CanonHeaders + CanonResource
  const stringToSign = `PUT\n\n${params.contentType}\n${params.date}\n${canonicalizedHeaders}${canonicalizedResource}`;
  const signature = createHmac('sha1', params.credentials.accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64');
  return {
    authorization: `OSS ${params.credentials.accessKeyId}:${signature}`,
    ossHeaders,
  };
}

const CONTENT_TYPE = 'text/html';

function normalizeEndpoint(raw: string): string {
  const endpoint = raw
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+\.aliyuncs\.com$/i.test(endpoint)) {
    throw new Error(
      `artifact.oss.endpoint does not look like a valid Aliyun OSS endpoint: ${endpoint}`,
    );
  }
  return endpoint;
}

/**
 * Option C, native Aliyun OSS backend (zero new dependencies). Uploads the
 * artifact with a self-signed PUT Object request over the built-in fetch and
 * returns the public URL. Credentials come from the environment — never stored.
 * The object key is deterministic (`{prefix}/{id}/index.html`), so re-publishing
 * overwrites in place and the URL stays stable.
 */
export class OssPublisher implements ArtifactPublisher {
  readonly kind = 'oss';

  constructor(
    private readonly config: ArtifactOssConfig,
    private readonly deps: {
      httpPut?: HttpPut;
      credentials?: () => OssCredentials | undefined;
      now?: () => Date;
    } = {},
  ) {}

  async publish(
    input: PublishArtifactInput,
    signal?: AbortSignal,
  ): Promise<PublishedArtifact> {
    const bucket = this.config.bucket?.trim();
    const rawEndpoint = this.config.endpoint?.trim();
    if (!bucket) {
      throw new Error('artifact.oss.bucket is not configured.');
    }
    if (!rawEndpoint) {
      throw new Error(
        'artifact.oss.endpoint is not configured (e.g. "oss-cn-hangzhou.aliyuncs.com").',
      );
    }
    const endpoint = normalizeEndpoint(rawEndpoint);
    const credentials = (this.deps.credentials ?? ossCredentialsFromEnv)();
    if (!credentials) {
      throw new Error(
        'OSS credentials not found. Set OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET (or ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET).',
      );
    }

    const prefix = (this.config.keyPrefix ?? 'artifacts').replace(
      /^\/+|\/+$/g,
      '',
    );
    const key = `${prefix}/${input.id}/index.html`;
    const acl = this.config.acl ?? 'public-read';
    const date = (this.deps.now ? this.deps.now() : new Date()).toUTCString();

    const { authorization, ossHeaders } = signOssPut({
      credentials,
      bucket,
      key,
      contentType: CONTENT_TYPE,
      date,
      acl,
    });

    const putUrl = `https://${bucket}.${endpoint}/${key}`;
    const httpPut = this.deps.httpPut ?? defaultHttpPut;
    await httpPut(
      putUrl,
      {
        Date: date,
        'Content-Type': CONTENT_TYPE,
        Authorization: authorization,
        ...ossHeaders,
      },
      input.html,
      signal,
    );

    const base = this.config.publicBaseUrl?.trim().replace(/\/+$/, '');
    const url = base ? `${base}/${key}` : putUrl;
    return { id: input.id, url };
  }
}
