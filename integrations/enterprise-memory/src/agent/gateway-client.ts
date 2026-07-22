/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { sha256Base64Url } from '../security/request-binding.js';

export interface GatewayClientOptions {
  brokerUrl: string;
  gatewayUrl: string;
  certificatePath: string;
  privateKeyPath: string;
  caPath: string;
  responseLimitBytes?: number;
  requestTimeoutMs?: number;
}

interface IssuedCapability {
  token: string;
}

class MemoryServiceHttpError extends Error {
  constructor(readonly status: number) {
    super(`Memory service failed with ${status}`);
  }
}

export class GatewayClient {
  private readonly certificate: Buffer;
  private readonly privateKey: Buffer;
  private readonly ca: Buffer;
  private readonly responseLimitBytes: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: GatewayClientOptions) {
    requireHttps(options.brokerUrl, 'brokerUrl');
    requireHttps(options.gatewayUrl, 'gatewayUrl');
    this.certificate = readFileSync(options.certificatePath);
    this.privateKey = readFileSync(options.privateKeyPath);
    this.ca = readFileSync(options.caPath);
    this.responseLimitBytes = options.responseLimitBytes ?? 128 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1_000;
  }

  async post<T>(path: string, value: unknown, operationId: string): Promise<T> {
    return this.perform<T>(
      'POST',
      path,
      Buffer.from(JSON.stringify(value)),
      operationId,
    );
  }

  async get<T>(path: string, operationId: string): Promise<T> {
    return this.perform<T>('GET', path, Buffer.alloc(0), operationId);
  }

  private async perform<T>(
    method: string,
    path: string,
    body: Buffer,
    operationId: string,
  ): Promise<T> {
    const deadline = Date.now() + this.requestTimeoutMs;
    const capability = await this.withSingleRetry(
      () => this.issueCapability(method, path, operationId, body, deadline),
      deadline,
    );
    if (
      typeof capability.token !== 'string' ||
      capability.token.length === 0 ||
      capability.token.length > 16 * 1024
    ) {
      throw new Error('Capability broker returned an invalid token');
    }
    return this.withSingleRetry(
      () =>
        this.requestJson<T>(
          new URL(path, this.options.gatewayUrl),
          {
            method,
            body,
            headers: {
              authorization: `Bearer ${capability.token}`,
              'content-type': 'application/json',
              'x-operation-id': operationId,
            },
          },
          deadline,
        ),
      deadline,
    );
  }

  private async withSingleRetry<T>(
    operation: () => Promise<T>,
    deadline: number,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error) || deadline - Date.now() < 50) {
        throw error;
      }
      return operation();
    }
  }

  private async issueCapability(
    method: string,
    path: string,
    operationId: string,
    body: Buffer,
    deadline: number,
  ): Promise<IssuedCapability> {
    const brokerBody = Buffer.from(
      JSON.stringify({
        method,
        route: path,
        operation_id: operationId,
        body_sha256: sha256Base64Url(body),
      }),
    );
    return this.requestJson<IssuedCapability>(
      new URL('/v1/capabilities:issue', this.options.brokerUrl),
      {
        method: 'POST',
        body: brokerBody,
        headers: { 'content-type': 'application/json' },
      },
      deadline,
    );
  }

  private requestJson<T>(
    url: URL,
    input: {
      method: string;
      body: Buffer;
      headers: Record<string, string>;
    },
    deadline: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: input.method,
          cert: this.certificate,
          key: this.privateKey,
          ca: this.ca,
          minVersion: 'TLSv1.3',
          rejectUnauthorized: true,
          headers: {
            ...input.headers,
            'content-length': input.body.length,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.responseLimitBytes) {
              request.destroy(
                new Error('Memory service response is too large'),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const status = response.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              reject(new MemoryServiceHttpError(status));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
            } catch {
              reject(new Error('Memory service returned invalid JSON'));
            }
          });
        },
      );
      request.on('error', reject);
      request.setTimeout(Math.max(1, deadline - Date.now()), () => {
        request.destroy(new Error('Memory service request timed out'));
      });
      request.end(input.body);
    });
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof MemoryServiceHttpError) {
    return error.status >= 500;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ECONNRESET' || code === 'EPIPE';
}

function requireHttps(value: string, name: string): void {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use https`);
  }
}
