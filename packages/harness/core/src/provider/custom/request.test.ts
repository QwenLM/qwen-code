/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { withHttpServer } from '../../test-utils/http-server.js';
import { customProviderRequest } from './request.js';

describe('customProviderRequest', () => {
  it('keeps the third-party destination and headers without Qoder identity', async () => {
    let receivedHeaders: IncomingMessage['headers'] | undefined;
    await withHttpServer(
      (request, response) => {
        receivedHeaders = request.headers;
        request.resume();
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"error":"bad request"}');
      },
      async (baseUrl) => {
        const response = await customProviderRequest(
          `${baseUrl}/images/generations`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer custom-provider-secret',
              'Content-Type': 'application/json',
            },
            body: '{}',
          },
          {
            operation: 'customProvider.image.generate',
            requestId: 'image-request-1',
            requestTimeoutMs: 600_000,
            bodyIdleTimeoutMs: 600_000,
          },
        );

        // 第三方状态原样交给 provider 适配器判定，本函数不翻译。
        expect(response.status).toBe(400);
        expect(receivedHeaders?.['authorization']).toBe(
          'Bearer custom-provider-secret',
        );
        expect(receivedHeaders?.['cosy-clienttype']).toBeUndefined();
        expect(receivedHeaders?.['cosy-version']).toBeUndefined();
        expect(receivedHeaders?.['cosy-machineos']).toBeUndefined();
      },
    );
  });

  it('honours the caller abort signal', async () => {
    await withHttpServer(
      (request, response) => {
        request.resume();
        setTimeout(() => response.end('{}'), 5_000).unref?.();
      },
      async (baseUrl) => {
        const controller = new AbortController();
        const pending = customProviderRequest(
          `${baseUrl}/v1/systemone`,
          { method: 'POST', body: '{}', signal: controller.signal },
          {
            operation: 'judgment.typesafe',
            requestId: 'judgment-request-1',
            requestTimeoutMs: 10_000,
            singleAttempt: true,
          },
        );
        controller.abort();

        await expect(pending).rejects.toThrow();
      },
    );
  });
});
