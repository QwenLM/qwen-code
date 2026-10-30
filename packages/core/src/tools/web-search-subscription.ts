/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config/config.js';
import { buildSessionAwareFetch } from '../core/outbound-session-id.js';
import { QWEN_SUBSCRIPTION_WEB_SEARCH_URL } from '../qwen/oauth-config.js';
import { QwenSubscriptionSession } from '../qwen/subscription-session.js';
import { SubscriptionOAuthError } from '../qwen/subscription-oauth-client.js';
import {
  subscriptionErrorMessage,
  subscriptionHttpError,
} from '../qwen/subscription-errors.js';
import { buildRuntimeFetchOptions } from '../utils/runtimeFetchOptions.js';
import { ToolErrorType } from './tool-error.js';
import type {
  WebSearchBackend,
  WebSearchBackendRequest,
  WebSearchBackendResult,
  WebSearchSource,
} from './web-search-backend.js';

function failure(message: string): WebSearchBackendResult {
  return {
    ok: false,
    message,
    errorType: ToolErrorType.WEB_SEARCH_BACKEND_FAILED,
  };
}

export class SubscriptionWebSearchBackend implements WebSearchBackend {
  constructor(
    private readonly config: Config,
    private readonly timeoutMs: number,
  ) {}

  async search({
    query,
    signal,
    onProgress,
  }: WebSearchBackendRequest): Promise<WebSearchBackendResult> {
    if ([...query].length > 500) {
      return failure(
        'Qwen Subscription search queries must not exceed 500 characters.',
      );
    }
    const searchSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    const client = new Client({
      name: 'qwen-code-web-search',
      version: this.config.getCliVersion() ?? '0.0.1',
    });
    try {
      const session = new QwenSubscriptionSession();
      const runtime = buildRuntimeFetchOptions(
        'openai',
        this.config.getProxy(),
      );
      const baseFetch = buildSessionAwareFetch(runtime?.fetch, this.config);
      const transport = new StreamableHTTPClientTransport(
        new URL(QWEN_SUBSCRIPTION_WEB_SEARCH_URL),
        {
          fetch: async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input);
            if (url.href !== QWEN_SUBSCRIPTION_WEB_SEARCH_URL) {
              throw new Error('Unsupported subscription search destination.');
            }
            const requestSignal = AbortSignal.any([
              searchSignal,
              ...(init?.signal ? [init.signal] : []),
            ]);
            const token = await session.getAccessToken(requestSignal);
            const send = (accessToken: string) => {
              const headers = new Headers(init?.headers);
              headers.set('Authorization', `Bearer ${accessToken}`);
              return baseFetch(input, {
                ...runtime?.fetchOptions,
                ...init,
                headers,
                signal: requestSignal,
                redirect: 'error',
              });
            };
            let response = await send(token);
            if (response.status === 401) {
              await response.body?.cancel();
              response = await send(
                await session.getAccessToken(requestSignal, token),
              );
            }
            if (!response.ok) {
              const body: unknown = await response
                .json()
                .catch(() => undefined);
              throw subscriptionHttpError(
                response.status,
                body,
                response.headers.get('Retry-After'),
              );
            }
            return response;
          },
        },
      );
      const options = { signal: searchSignal, timeout: this.timeoutMs };
      await client.connect(transport, options);
      const { tools } = await client.listTools(undefined, options);
      if (!tools.some((tool) => tool.name === 'web_search')) {
        return failure(
          'The subscription search service does not expose web_search.',
        );
      }
      onProgress?.(`Searching: ${query}`);
      const result = (await client.callTool(
        { name: 'web_search', arguments: { query } },
        CallToolResultSchema,
        options,
      )) as CallToolResult;
      if (result.isError) {
        return failure('The subscription search service returned an error.');
      }
      const answerText = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n\n')
        .trim();
      if (!answerText) {
        return failure('The subscription search service returned no text.');
      }
      const sources: WebSearchSource[] = [];
      const seen = new Set<string>();
      for (const line of answerText.split(/\r?\n/)) {
        const url = line.trim();
        if (!/^https?:\/\/\S+$/.test(url) || seen.has(url)) continue;
        try {
          new URL(url);
          sources.push({ url, opened: false });
          seen.add(url);
        } catch {
          // Search output is untrusted; malformed links remain plain text.
        }
      }
      return {
        ok: true,
        outcome: {
          answerText,
          sources,
          executedQueries: [query],
          searchCount: 1,
        },
      };
    } catch (error) {
      return failure(
        signal.aborted
          ? 'Web search was cancelled.'
          : searchSignal.aborted
            ? 'Qwen Subscription search timed out.'
            : error instanceof SubscriptionOAuthError
              ? subscriptionErrorMessage(error)
              : 'Qwen Subscription search failed. Please try again.',
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
