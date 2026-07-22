/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { ProtectedContent } from './domain.js';
import { readBoundedJson } from './http-json.js';

export interface ProtectContentRequest {
  tenantId: string;
  principalId?: string;
  sourceOperationId: string;
  plaintext: string;
  expiresAt: Date | null;
}

export interface ContentProtector {
  protect(request: ProtectContentRequest): Promise<ProtectedContent>;
  reveal(tenantId: string, content: ProtectedContent): Promise<string>;
  destroy(tenantId: string, keyHandle: string): Promise<void>;
}

interface InMemoryKey {
  tenantId: string;
  key: Buffer;
}

export class InMemoryContentProtector implements ContentProtector {
  private readonly keys = new Map<string, InMemoryKey>();

  async protect(request: ProtectContentRequest): Promise<ProtectedContent> {
    const keyHandle = randomUUID();
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(request.tenantId));
    const encrypted = Buffer.concat([
      cipher.update(request.plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    this.keys.set(keyHandle, { tenantId: request.tenantId, key });
    return {
      keyHandle,
      ciphertext: Buffer.concat([iv, tag, encrypted]).toString('base64url'),
    };
  }

  async reveal(tenantId: string, content: ProtectedContent): Promise<string> {
    const stored = this.keys.get(content.keyHandle);
    if (!stored || stored.tenantId !== tenantId) {
      throw new Error('Content key is unavailable');
    }
    const payload = Buffer.from(content.ciphertext, 'base64url');
    if (payload.length < 28) {
      throw new Error('Protected content is malformed');
    }
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', stored.key, iv);
    decipher.setAAD(Buffer.from(tenantId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  }

  async destroy(tenantId: string, keyHandle: string): Promise<void> {
    const stored = this.keys.get(keyHandle);
    if (stored && stored.tenantId !== tenantId) {
      throw new Error('Content key tenant mismatch');
    }
    this.keys.delete(keyHandle);
  }
}

export interface HttpContentProtectorOptions {
  baseUrl: string;
  bearerToken: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export class HttpContentProtector implements ContentProtector {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: HttpContentProtectorOptions) {
    if (new URL(options.baseUrl).protocol !== 'https:') {
      throw new Error('Content-protection service must use https');
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async protect(request: ProtectContentRequest): Promise<ProtectedContent> {
    const result = await this.request<ProtectedContent>('/v1/content:protect', {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: request.tenantId,
        principal_id: request.principalId,
        source_operation_id: request.sourceOperationId,
        plaintext: request.plaintext,
        expires_at: request.expiresAt?.toISOString() ?? null,
      }),
    });
    if (
      typeof result.keyHandle !== 'string' ||
      result.keyHandle.length === 0 ||
      result.keyHandle.length > 512 ||
      typeof result.ciphertext !== 'string' ||
      result.ciphertext.length === 0 ||
      result.ciphertext.length > 512 * 1024
    ) {
      throw new Error('Content-protection service returned invalid content');
    }
    return result;
  }

  async reveal(tenantId: string, content: ProtectedContent): Promise<string> {
    const result = await this.request<{ plaintext: string }>(
      '/v1/content:reveal',
      {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: tenantId,
          key_handle: content.keyHandle,
          ciphertext: content.ciphertext,
        }),
      },
    );
    if (typeof result.plaintext !== 'string') {
      throw new Error('Content-protection service returned invalid plaintext');
    }
    return result.plaintext;
  }

  async destroy(tenantId: string, keyHandle: string): Promise<void> {
    await this.request('/v1/content:destroy', {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: tenantId,
        key_handle: keyHandle,
      }),
    });
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await this.fetchImplementation(
      new URL(path, this.options.baseUrl),
      {
        ...init,
        headers: {
          authorization: `Bearer ${this.options.bearerToken}`,
          'content-type': 'application/json',
        },
        redirect: 'error',
        signal:
          init.signal ??
          AbortSignal.timeout(this.options.requestTimeoutMs ?? 3_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Content-protection service failed with ${response.status}`,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return readBoundedJson<T>(response, 512 * 1024);
  }
}
