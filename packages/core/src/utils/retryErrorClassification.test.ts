/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { APIError, APIUserAbortError } from 'openai';
import { describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import {
  classifyRetryError,
  isFallbackEligible,
  isRetryableUpstreamError,
} from './retryErrorClassification.js';

describe('classifyRetryError', () => {
  it('classifies HTTP 429 as retryable rate limiting', () => {
    expect(
      classifyRetryError({ status: 429, message: 'Too Many Requests' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'retryable',
      statusCode: 429,
      reason: 'rate-limit',
    });
  });

  it('classifies the OpenAI SDK APIUserAbortError as an abort, not unknown', () => {
    // A user cancel on the auth_type=openai path surfaces as APIUserAbortError.
    // It must be treated as an abort so retries stop and it is not logged as an
    // api_error — otherwise it falls through to the 'unknown' classification.
    expect(
      classifyRetryError(
        new APIUserAbortError({ message: 'Request was aborted.' }),
      ),
    ).toMatchObject({ kind: 'abort' });
  });

  it('classifies HTTP 503 as retryable rate limiting to match stream retry semantics', () => {
    expect(
      classifyRetryError({ status: 503, message: 'Provider overloaded' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'retryable',
      statusCode: 503,
      reason: 'rate-limit',
    });
  });

  it('classifies provider rate-limit codes as retryable rate limiting', () => {
    expect(
      classifyRetryError(
        new Error(
          '{"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}',
        ),
      ),
    ).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      providerCode: '1302',
      providerMessage: '您的账户已达到速率限制，请您控制请求频率',
      reason: 'rate-limit',
    });

    expect(
      classifyRetryError({
        error: { code: 1305, message: 'IdealTalk rate limit' },
      }),
    ).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      providerCode: '1305',
      providerMessage: 'IdealTalk rate limit',
      reason: 'rate-limit',
    });
  });

  it('honors caller-provided extra rate-limit codes in diagnostics', () => {
    expect(
      classifyRetryError(
        { error: { code: 4999, message: 'Provider-specific throttle' } },
        { extraRetryErrorCodes: [4999] },
      ),
    ).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      providerCode: '4999',
      providerMessage: 'Provider-specific throttle',
      reason: 'rate-limit',
    });
  });

  it('honors extra rate-limit codes on Error instances with status properties', () => {
    const error = Object.assign(new Error('Provider-specific throttle'), {
      status: 4999,
    });

    expect(
      classifyRetryError(error, {
        authType: AuthType.USE_OPENAI,
        extraRetryErrorCodes: [4999],
      }),
    ).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      reason: 'rate-limit',
    });
  });

  it('classifies SSE-embedded non-quota 429 errors as retryable rate limiting', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-1","code":"Throttling.RateLimit","message":"Rate limit exceeded"}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'sse-provider',
      diagnosis: 'retryable',
      statusCode: 429,
      providerCode: 'Throttling.RateLimit',
      providerMessage: 'Rate limit exceeded',
      requestId: 'req-1',
      reason: 'rate-limit',
    });
  });

  it('classifies SSE-embedded allocation quota errors as provider business failures', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-1","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'provider-business',
      diagnosis: 'fail-fast',
      statusCode: 429,
      providerCode: 'Throttling.AllocationQuota',
      providerMessage: 'Allocated quota exceeded',
      requestId: 'req-1',
      reason: 'allocated-quota-exceeded',
    });
  });

  it('does not treat allocation quota text without the structured provider code as fail-fast', () => {
    expect(
      classifyRetryError(new Error('previously allocated quota exceeded')),
    ).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      reason: 'unclassified',
    });
  });

  it('marks Qwen OAuth free-tier quota errors as fail-fast', () => {
    expect(
      classifyRetryError(
        {
          status: 429,
          code: 'insufficient_quota',
          message: 'Free allocated quota exceeded',
        },
        { authType: AuthType.QWEN_OAUTH },
      ),
    ).toMatchObject({
      kind: 'provider-business',
      diagnosis: 'fail-fast',
      statusCode: 429,
      providerCode: 'insufficient_quota',
      reason: 'qwen-oauth-free-tier-quota',
    });
  });

  it('marks request validation errors as fail-fast', () => {
    expect(
      classifyRetryError({
        status: 400,
        code: 'invalid_request_error',
        message: 'Invalid messages in payload',
      }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 400,
      providerCode: 'invalid_request_error',
      reason: 'client-error',
    });
  });

  it('pins 408 and 425 as current client-error fail-fast classifications', () => {
    expect(
      classifyRetryError({ status: 408, message: 'Request Timeout' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 408,
      reason: 'client-error',
    });

    expect(
      classifyRetryError({ status: 425, message: 'Too Early' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 425,
      reason: 'client-error',
    });
  });

  it('classifies a 4xx wrapping a low-level network failure (EOF) as retryable', () => {
    // Mirrors "400 network error for request to ...: EOF" — a peer closing the
    // connection wrapped in a 4xx with no provider error body. Channel/daemon
    // paths have no manual retry, so this must be auto-retried (bounded).
    // Real SDK failures are Error instances (so `message` is not treated as a
    // provider field), unlike a genuine client-error payload.
    const err = Object.assign(
      new Error(
        'network error for request to http://11.0.0.1:8080/v1/chat/completions: Post "http://11.0.0.1:8080/v1/chat/completions": EOF',
      ),
      { status: 400 },
    );
    expect(classifyRetryError(err)).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      statusCode: 400,
      reason: 'network-error',
    });
  });

  it('keeps a 4xx with provider fields fail-fast even if the message mentions EOF', () => {
    // A genuine client error carries provider fields; the network-failure
    // exception must not relabel it as retryable.
    expect(
      classifyRetryError({
        status: 400,
        code: 'invalid_request_error',
        message: 'bad request EOF',
      }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 400,
      reason: 'client-error',
    });
  });

  it('keeps a bare-EOF 4xx message fail-fast without the wrapper marker', () => {
    // The exception is scoped to the demonstrated wrapper shape ('network
    // error for request ...'); a standalone EOF mention in a gateway's
    // permanent client error must not trigger bounded retries.
    expect(
      classifyRetryError(
        Object.assign(new Error('unexpected EOF while parsing request body'), {
          status: 400,
        }),
      ),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 400,
      reason: 'client-error',
    });
  });

  it('finds the network-failure marker in a nested cause message', () => {
    const err = Object.assign(new Error('request failed'), {
      status: 400,
      cause: new Error(
        'network error for request to http://h:8080/v1/chat/completions: EOF',
      ),
    });
    expect(classifyRetryError(err)).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      statusCode: 400,
      reason: 'network-error',
    });
  });

  it('keeps a plain-object 4xx fail-fast even with the marker message', () => {
    // A non-Error payload's `message` is a provider field, i.e. a provider
    // error body — a genuine client error, not a wrapped network failure.
    expect(
      classifyRetryError({
        status: 400,
        message: 'network error for request to http://h: EOF',
      }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 400,
      reason: 'client-error',
    });
  });

  it('keeps a request-id-bearing 4xx fail-fast even with the marker message', () => {
    // With a request id present the Error message counts as a provider
    // field, so the payload is a provider response, not a wrapped failure.
    expect(
      classifyRetryError(
        Object.assign(new Error('network error for request to http://h: EOF'), {
          status: 400,
          request_id: 'req-1',
        }),
      ),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 400,
      reason: 'client-error',
    });
  });

  it('keeps a 4xx with a cause-nested transport code fail-fast', () => {
    // A socket code in the cause chain does not relabel a definitive 4xx;
    // only the message marker does.
    expect(
      classifyRetryError(
        Object.assign(new Error('terminated'), {
          status: 400,
          cause: Object.assign(new Error('socket reset'), {
            code: 'ECONNRESET',
          }),
        }),
      ),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 400,
      reason: 'client-error',
    });
  });

  it('leaves transportCode unset on a marker-matched 4xx that also carries a code', () => {
    // The omission keeps 4xx-wrapped failures out of the transportCode-keyed
    // stream replay/continuation gates (see llm-chat.test.ts).
    const err = Object.assign(
      new Error('network error for request to http://h: EOF'),
      {
        status: 400,
        cause: Object.assign(new Error('socket reset'), {
          code: 'ECONNRESET',
        }),
      },
    );
    expect(classifyRetryError(err)).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      statusCode: 400,
      reason: 'network-error',
    });
    expect(classifyRetryError(err).transportCode).toBeUndefined();
  });

  it('marks auth errors as fail-fast', () => {
    expect(
      classifyRetryError({ status: 401, message: 'Unauthorized' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 401,
      reason: 'auth-error',
    });

    expect(
      classifyRetryError({ status: 403, message: 'Forbidden' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 403,
      reason: 'auth-error',
    });
  });

  it('classifies 529 as retryable capacity overload', () => {
    expect(
      classifyRetryError({ status: 529, message: 'Overloaded' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'retryable',
      statusCode: 529,
      reason: 'capacity-overload',
    });
  });

  it('preserves SSE transport when classifying 529 capacity overload', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/529\ndata:{"request_id":"req-1","code":"Overloaded","message":"Provider overloaded"}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'sse-provider',
      diagnosis: 'retryable',
      statusCode: 529,
      providerCode: 'Overloaded',
      providerMessage: 'Provider overloaded',
      requestId: 'req-1',
      reason: 'capacity-overload',
    });
  });

  it('classifies non-rate-limit 5xx errors as retryable server errors', () => {
    expect(
      classifyRetryError({ status: 500, message: 'Internal error' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'retryable',
      statusCode: 500,
      reason: 'server-error',
    });
  });

  it('keeps non-error HTTP statuses and invalid status fields unknown', () => {
    expect(
      classifyRetryError({ status: 302, message: 'Redirect' }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'unknown',
      statusCode: 302,
      reason: 'http-status',
    });

    expect(
      classifyRetryError({ status: 700, message: 'Invalid status' }),
    ).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      reason: 'unclassified',
    });
  });

  it('classifies transport timeout errors as retryable', () => {
    const error = Object.assign(new Error('socket timed out'), {
      code: 'ETIMEDOUT',
    });

    const classification = classifyRetryError(error);

    expect(classification).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      transportCode: 'ETIMEDOUT',
      reason: 'transport-error',
    });
    expect(classification).not.toHaveProperty('providerCode');
  });

  it('classifies transport codes from Error causes as retryable', () => {
    const error = new Error('request failed', {
      cause: Object.assign(new Error('socket reset'), {
        code: 'ECONNRESET',
      }),
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      transportCode: 'ECONNRESET',
      reason: 'transport-error',
    });
  });

  it('classifies SDK-wrapped transport codes nested in the cause chain', () => {
    // The OpenAI SDK surfaces a pre-header reset as APIConnectionError ->
    // TypeError('fetch failed') -> cause { code: 'ECONNRESET' }; the socket
    // code sits two cause levels down and must still classify as transport.
    const error = Object.assign(new Error('Connection error.'), {
      cause: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('read ECONNRESET'), {
          code: 'ECONNRESET',
        }),
      }),
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      transportCode: 'ECONNRESET',
      reason: 'transport-error',
    });
  });

  it('prefers a transport cause over an HTTP status when both are present', () => {
    // An SDK error can surface an HTTP status while its underlying cause is a
    // socket-level failure. The transport cause is the more fundamental
    // classification and wins, with the HTTP status reported as secondary.
    const error = Object.assign(new Error('upstream failed'), {
      status: 500,
      cause: Object.assign(new Error('socket reset'), {
        code: 'ECONNRESET',
      }),
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      transportCode: 'ECONNRESET',
      statusCode: 500,
      reason: 'transport-error',
    });
  });

  it('keeps a definitive 4xx status authoritative over a transport cause', () => {
    // A 401 that also carries a socket-level cause must stay fail-fast: the
    // server reached a verdict, so a transient cause must not relabel it
    // retryable.
    const error = Object.assign(new Error('unauthorized'), {
      status: 401,
      cause: Object.assign(new Error('socket reset'), {
        code: 'ECONNRESET',
      }),
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 401,
      reason: 'auth-error',
    });
  });

  it('classifies allocated-quota errors from direct properties as fail-fast', () => {
    expect(
      classifyRetryError({
        status: 429,
        code: 'Throttling.AllocationQuota',
        message: 'Allocated quota exceeded',
      }),
    ).toMatchObject({
      kind: 'provider-business',
      diagnosis: 'fail-fast',
      reason: 'allocated-quota-exceeded',
      statusCode: 429,
      providerCode: 'Throttling.AllocationQuota',
    });
  });

  it('does not echo a numeric HTTP-status code as providerCode', () => {
    // `{ status: 429, code: 429 }` is just the HTTP status repeated; it must not
    // surface as a provider-specific code.
    const classification = classifyRetryError({
      status: 429,
      code: 429,
      message: 'Too Many Requests',
    });

    expect(classification.statusCode).toBe(429);
    expect(classification).not.toHaveProperty('providerCode');
  });

  it('does not treat generic SDK error codes as transport retry errors', () => {
    const classification = classifyRetryError(
      Object.assign(new Error('invalid request'), {
        code: 'ERR_BAD_REQUEST',
      }),
    );

    expect(classification).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      reason: 'unclassified',
    });
    expect(classification).not.toHaveProperty('providerCode');
    expect(classification).not.toHaveProperty('providerMessage');
  });

  it('extracts provider fields from Error instances with direct SDK properties', () => {
    const error = Object.assign(new Error('Provider-specific throttle'), {
      code: 'Throttling.Custom',
      request_id: 'req-direct-error',
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      providerCode: 'Throttling.Custom',
      providerMessage: 'Provider-specific throttle',
      requestId: 'req-direct-error',
      reason: 'upstream-error-without-status',
    });
  });

  it('classifies a mid-stream upstream error with no HTTP status as retryable', () => {
    // A gateway that pushes `{"error": {...}}` into an already-200 SSE stream
    // reaches us as `new APIError(undefined, data.error, undefined,
    // response.headers)`: no status, the body's `code`/`message`, and the
    // response's `x-request-id` under the SDK's `requestID` spelling. Observed
    // in the wild as `code: 'KeyError'`, `message: "'id'"`, which used to fall
    // through to 'unknown' and kill the turn on the first attempt.
    const error = Object.assign(new Error("'id'"), {
      code: 'KeyError',
      requestID: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
    });

    const classification = classifyRetryError(error);
    expect(classification).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      reason: 'upstream-error-without-status',
      providerCode: 'KeyError',
      providerMessage: "'id'",
      requestId: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
    });
    expect(classification).not.toHaveProperty('statusCode');
  });

  it('classifies the SDK error a mid-stream gateway frame actually produces', () => {
    // The fixtures above hand-build the shape, so a dependency bump that
    // renames `requestID` would silently reintroduce the incident with the
    // whole suite green. This drives the real constructor the SDK throws from
    // inside its SSE iterator, with real headers, as the oracle.
    const error = new APIError(
      undefined,
      { code: 'KeyError', message: "'id'" },
      undefined,
      new Headers({ 'x-request-id': 'cd7f37f3-d38a-9dec-804f-f70dda5650eb' }),
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      reason: 'upstream-error-without-status',
      providerCode: 'KeyError',
      requestId: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
    });
    expect(isRetryableUpstreamError(error)).toBe(true);

    // The same producer with a present-but-empty header: `Headers.get` returns
    // '' rather than null, and an id the provider never set must not open the
    // gate.
    const untraced = new APIError(
      undefined,
      { code: 'KeyError', message: "'id'" },
      undefined,
      new Headers({ 'x-request-id': '' }),
    );
    expect(untraced.requestID).toBe('');
    expect(classifyRetryError(untraced)).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      reason: 'unclassified',
    });
    expect(isRetryableUpstreamError(untraced)).toBe(false);
  });

  it('classifies the error an Anthropic mid-stream frame actually produces', () => {
    // The Anthropic SDK raises a mid-stream SSE failure with
    // `APIError.generate(undefined, ..., sse.data, createResponseHeaders(...))`
    // (streaming.mjs). `generate` short-circuits on the missing status and
    // builds an `APIConnectionError` *without* headers, so the `request-id`
    // the call site passed never reaches `request_id` — a native frame cannot
    // open the status-less gate on a header id the way the OpenAI SDK's can.
    // What still can is a gateway relaying its own id inside the frame body,
    // which is what an Anthropic-compatible `baseUrl` route sees, and the body
    // reaches the classifier because `generate` keeps the raw frame as the
    // message.
    const tracedFrame = JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: 'Internal server error' },
      request_id: 'gw-trace-1',
    });
    const error = AnthropicAPIError.generate(
      undefined,
      `SSE Error: ${tracedFrame}`,
      tracedFrame,
      // `createResponseHeaders` hands `generate` a plain lower-cased record,
      // not a `Headers` instance.
      { 'request-id': 'header-trace-1' },
    );

    // The header id is dropped even though the call site supplied it; the body
    // id survives through the message.
    expect(error.request_id).toBeUndefined();
    expect(classifyRetryError(error)).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      reason: 'upstream-error-without-status',
      requestId: 'gw-trace-1',
    });
    expect(isRetryableUpstreamError(error)).toBe(true);

    // The same body channel cannot smuggle a permanent rejection into a retry:
    // Anthropic puts `invalid_request_error` in `type`, the payload reader
    // folds that into the provider code, and the permanence guard runs before
    // the request-id branch.
    const permanentFrame = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'max_tokens: field required',
      },
      request_id: 'gw-trace-2',
    });
    const permanent = AnthropicAPIError.generate(
      undefined,
      `SSE Error: ${permanentFrame}`,
      permanentFrame,
      { 'request-id': 'header-trace-2' },
    );

    expect(classifyRetryError(permanent)).toMatchObject({
      diagnosis: 'fail-fast',
      reason: 'permanent-provider-code',
    });
    expect(isRetryableUpstreamError(permanent)).toBe(false);

    // The credential member of the same union, which the SDK maps to 401 when
    // a status survives: relaying it status-less must not change the verdict,
    // or a dead key costs the whole ladder before it surfaces.
    const authFrame = JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
      request_id: 'gw-trace-3',
    });
    const unauthenticated = AnthropicAPIError.generate(
      undefined,
      `SSE Error: ${authFrame}`,
      authFrame,
      { 'request-id': 'header-trace-3' },
    );

    expect(classifyRetryError(unauthenticated)).toMatchObject({
      diagnosis: 'fail-fast',
      reason: 'permanent-provider-code',
    });
    expect(isRetryableUpstreamError(unauthenticated)).toBe(false);
  });

  it('classifies a status-less provider body embedded in the message as retryable', () => {
    // The same upstream failure can arrive with the provider's JSON body pasted
    // into the message rather than on SDK properties. With no `:HTTP_STATUS/`
    // marker there is no status to classify on, so the request id in the body
    // is the only evidence that the provider traced the failure. Raw SSE
    // framing surviving into the message is what earns the `sse-provider` kind
    // here; the SDK strips that framing, so the case above is plain `provider`.
    const error = new Error(
      'id:1\nevent:error\ndata:{"request_id":"req-stream","code":"KeyError","message":"upstream failed"}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'sse-provider',
      diagnosis: 'retryable',
      reason: 'upstream-error-without-status',
      requestId: 'req-stream',
    });
  });

  it('fails fast on a permanent provider code scraped from the message', () => {
    // The permanence guard reads the merged providerCode
    // (`details.providerCode ?? providerFields.providerCode`), and this fixture
    // is the message-scraped half of that merge: the error carries no `.code`
    // property, so the moderation code reaches the guard only through the JSON
    // in the message. Reading the merge object-only flips it from fail-fast to
    // retryable. Several other cases here read the same half — the rate-limit
    // diagnostics and the nested-`.error` sibling among them — so this is not
    // the only pin on it, just the one that pins it for a permanent code. The
    // case above does not read that half at all: its request id comes from a
    // separate reader, so KeyError stays unlisted and retryable either way.
    const error = new Error(
      'id:1\nevent:error\ndata:{"request_id":"req-stream","code":"data_inspection_failed","message":"Output data may contain inappropriate content."}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'sse-provider',
      diagnosis: 'fail-fast',
      reason: 'permanent-provider-code',
      providerCode: 'data_inspection_failed',
      requestId: 'req-stream',
    });
    expect(isRetryableUpstreamError(error)).toBe(false);
  });

  it('fails fast on a permanent provider code nested under .error', () => {
    // `getProviderErrorPayload`'s isApiError fallback reads a nested
    // `.error.code` when no JSON survives in the message — a second input
    // shape that reaches the permanence guard only through the scraped half
    // of the providerCode merge.
    const error = Object.assign(new Error('moderation rejection'), {
      error: {
        code: 'data_inspection_failed',
        message: 'Output data may contain inappropriate content.',
      },
      requestID: 'req-nested',
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'provider',
      diagnosis: 'fail-fast',
      reason: 'permanent-provider-code',
      providerCode: 'data_inspection_failed',
      requestId: 'req-nested',
    });
    expect(isRetryableUpstreamError(error)).toBe(false);
  });

  it('fails fast on a permanent provider code even when the request is traced', () => {
    // A request id decides upstream vs. local, not transient vs. permanent.
    // Moderation, credential/billing and malformed-request rejections arrive
    // after the 200 on a streaming call, so no status is left to fail fast on —
    // without this they would walk the whole production ladder for a verdict
    // that was never going to change.
    const codes = [
      'content_filter',
      'data_inspection_failed',
      // The same rejection the pipeline re-throws out of the provider's body.
      'DataInspectionFailed',
      // DashScope spells output moderation with a prefix.
      'ResponseDataInspectionFailed',
      'InvalidApiKey',
      'Arrearage',
      // Billing exhaustion that neither quota fast-fail intercepts: one needs a
      // 429 status plus the free-tier wording, the other a reset time.
      'insufficient_quota',
      'Model.AccessDenied',
      'invalid_request_error',
      'InvalidParameter',
      // OpenAI's `.type` spelling for a malformed request.
      'invalid_parameter_error',
      // The rest of the pinned Anthropic `ErrorObject` union whose verdict can
      // never change on a re-send: credentials, entitlement, a model that does
      // not exist, and billing. A gateway relaying one of them into an
      // already-200 stream supplies an id and no status, so without these the
      // request-id branch walks the whole ladder for a verdict that was fixed
      // on arrival.
      'authentication_error',
      'permission_error',
      'not_found_error',
      'billing_error',
      // Recoverable by compaction, never by re-sending the identical payload —
      // the reasoning that already puts `context_length_exceeded` on this list.
      'request_too_large',
      // Recoverable by compaction, never by re-sending the identical payload.
      'context_length_exceeded',
    ];

    for (const code of codes) {
      expect(classifyRetryError({ code, requestID: 'req-1' })).toMatchObject({
        diagnosis: 'fail-fast',
        reason: 'permanent-provider-code',
        providerCode: code,
      });
    }
  });

  it('fails fast on a permanent provider type when the body carries no code', () => {
    // The canonical OpenAI malformed-request body puts `invalid_request_error`
    // on `.type` and sets `code` to null, so reading permanence off `code`
    // alone never fires for it and the request id would open the retry gate on
    // a rejection that cannot succeed.
    expect(
      classifyRetryError({
        type: 'invalid_request_error',
        code: null,
        requestID: 'req-1',
      }),
    ).toMatchObject({
      diagnosis: 'fail-fast',
      reason: 'permanent-provider-code',
    });
  });

  it('fails fast on a permanent provider type when the body also carries a code', () => {
    // R16-1. On the message-embedded route the provider body is scraped, and
    // `getRateLimitErrorDetails` collapses that body's `code` and `type` into a
    // single `providerCode` (`String(payload.code ?? payload.type)`), so a
    // permanent `type` was dropped whenever a sibling `code` survived. The
    // object route never had the hole — `getProviderFields` reads `.type`
    // separately. Moderation is the case the permanence list exists for: a
    // gateway relaying `type: 'content_filter'` beside its own `code` is still
    // a rejection that re-sending the identical request cannot change.
    const moderation = new Error(
      'event:error\ndata:{"error":{"message":"blocked","type":"content_filter","code":"moderation_blocked"},"request_id":"req-1"}',
    );
    expect(classifyRetryError(moderation)).toMatchObject({
      diagnosis: 'fail-fast',
      reason: 'permanent-provider-code',
    });
    expect(isRetryableUpstreamError(moderation)).toBe(false);

    // The same collapse on OpenAI's malformed-request shape, which carries both
    // fields: `.type` names the permanent class, `.code` the specific field.
    const malformed = new Error(
      'event:error\ndata:{"error":{"type":"invalid_request_error","code":"missing_required_field","message":"x is required"},"request_id":"req-2"}',
    );
    expect(classifyRetryError(malformed)).toMatchObject({
      diagnosis: 'fail-fast',
      reason: 'permanent-provider-code',
    });
    expect(isRetryableUpstreamError(malformed)).toBe(false);

    // The other end of the same knob: reading `type` off the scraped body must
    // not make every body-named class permanent. A transient one keeps the
    // verdict the request-id branch gives it.
    const transient = new Error(
      'event:error\ndata:{"error":{"message":"upstream died","type":"api_error","code":"upstream_500"},"request_id":"req-3"}',
    );
    expect(classifyRetryError(transient)).toMatchObject({
      diagnosis: 'retryable',
      reason: 'upstream-error-without-status',
    });
    expect(isRetryableUpstreamError(transient)).toBe(true);
  });

  it('fails fast on a permanent provider type from the real SDK error', () => {
    // The hand-built case above pins the guard's reaction to an assumed SDK
    // output; this drives the real constructor, so a dependency bump that
    // stops mapping the body's `type` onto the instance property reds it —
    // the `.type` sibling of the requestID oracle above.
    const error = new APIError(
      undefined,
      { type: 'invalid_request_error', code: null, message: 'x is required' },
      undefined,
      new Headers({ 'x-request-id': 'req-1' }),
    );

    expect(classifyRetryError(error)).toMatchObject({
      diagnosis: 'fail-fast',
      reason: 'permanent-provider-code',
    });
    expect(isRetryableUpstreamError(error)).toBe(false);
  });

  it('does not treat every provider type as permanent', () => {
    // `.type` also carries transient values; matching it against the same
    // anchored list is what keeps a server-side fault retryable. These are the
    // transient members of the pinned Anthropic `ErrorObject` union plus
    // OpenAI's `server_error` — exactly what the permanent spellings must not
    // swallow. `timeout_error` is the one a broad `.*_error` alternative would
    // have caught, turning a gateway timeout into a fail-fast.
    for (const type of ['api_error', 'timeout_error', 'server_error']) {
      expect(classifyRetryError({ type, requestID: 'req-1' })).toMatchObject({
        diagnosis: 'retryable',
        reason: 'upstream-error-without-status',
      });
    }
    // The throttles keep their own arm, which owns the Retry-After-aware delay.
    for (const type of ['rate_limit_error', 'overloaded_error']) {
      expect(classifyRetryError({ type, requestID: 'req-1' })).toMatchObject({
        diagnosis: 'retryable',
        reason: 'rate-limit',
      });
    }
  });

  it('keeps an unrecognised upstream code retryable', () => {
    // The point of the branch: the next gateway bug should not have to be
    // taught to the classifier before it stops killing turns.
    expect(
      classifyRetryError({ code: 'KeyError', requestID: 'req-1' }),
    ).toMatchObject({
      diagnosis: 'retryable',
      reason: 'upstream-error-without-status',
    });
  });

  it('treats an empty request id as no request id', () => {
    // `headers.get('x-request-id')` yields '' for a header that is present but
    // empty — legal HTTP, and what a proxy emits when the upstream set none. An
    // error the provider never traced must not open the retry gate.
    expect(
      classifyRetryError({ code: 'KeyError', requestID: '' }),
    ).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      reason: 'unclassified',
    });
  });

  it('treats an empty request id scraped from the message as no request id', () => {
    // The same rule on the other reader: the rate-limit details scrape a
    // provider body out of the message and do not reject an empty id, so the
    // merge has to fall through it rather than coalesce onto it.
    const error = new Error(
      'id:1\nevent:error\ndata:{"request_id":"","code":"KeyError","message":"upstream failed"}',
    );

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'unknown',
      diagnosis: 'unknown',
      reason: 'unclassified',
    });
  });

  it('keeps permanent local failures without a request id unclassified', () => {
    // A string `code` alone must not open the status-less retry gate — these
    // are permanent, and retrying them burns the whole ladder for nothing.
    const errors = [
      Object.assign(new Error('No API key configured'), {
        code: 'MISSING_API_KEY',
      }),
      Object.assign(new Error('Invalid MCP server configuration'), {
        code: 'invalid_config',
      }),
      // MCP protocol errors carry a numeric JSON-RPC code.
      Object.assign(new Error('Internal error'), { code: -32603 }),
    ];

    for (const error of errors) {
      expect(classifyRetryError(error)).toMatchObject({
        kind: 'unknown',
        diagnosis: 'unknown',
        reason: 'unclassified',
      });
    }
  });

  it('keeps a definitive HTTP status authoritative over a request id', () => {
    // A traced 4xx is still a permanent client error: the status block runs
    // before the status-less branches, so it cannot become retryable.
    expect(
      classifyRetryError({
        status: 400,
        code: 'invalid_request_error',
        request_id: 'req-400',
        message: 'malformed tool call',
      }),
    ).toMatchObject({
      kind: 'http',
      diagnosis: 'fail-fast',
      reason: 'client-error',
      statusCode: 400,
    });
  });

  it('keeps a provider-traced socket cut transport-classified over a request id', () => {
    // The transport branch runs first, and that ordering is load-bearing:
    // isRetryableStreamTransportError admits mid-stream replay only on
    // `kind === 'transport'` plus an allow-listed code, so reclassifying a
    // traced socket cut as a provider error would silently disable replay,
    // continuation recovery, and Anthropic's release of deferred tool calls
    // while the whole suite stayed green. `transportCode` is asserted because
    // that predicate reads it, and no request id is asserted because the
    // transport return deliberately does not spread the provider fields.
    const error = Object.assign(new Error('upstream failed'), {
      requestID: 'req-1',
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'transport',
      diagnosis: 'retryable',
      reason: 'transport-error',
      transportCode: 'ECONNRESET',
    });
  });

  it('does not copy unparsed SSE frames into providerMessage', () => {
    const classification = classifyRetryError(
      new Error('id:1\nevent:error\n:HTTP_STATUS/429\ndata:not-json'),
    );

    expect(classification).toMatchObject({
      kind: 'sse-provider',
      diagnosis: 'retryable',
      statusCode: 429,
      reason: 'rate-limit',
    });
    expect(classification).not.toHaveProperty('providerMessage');
  });

  it('marks abort errors as fail-fast', () => {
    const error = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'abort',
      diagnosis: 'fail-fast',
      reason: 'aborted',
    });
  });

  it('marks axios-style canceled errors as fail-fast aborts', () => {
    const error = Object.assign(new Error('canceled'), {
      name: 'CanceledError',
      code: 'ECONNABORTED',
    });

    expect(classifyRetryError(error)).toMatchObject({
      kind: 'abort',
      diagnosis: 'fail-fast',
      reason: 'aborted',
    });
  });
});

describe('isFallbackEligible', () => {
  it.each([
    [429, 'Too Many Requests', true],
    [503, 'Service Unavailable', true],
    [529, 'Overloaded', true],
    [400, 'Bad Request', false],
    [401, 'Unauthorized', false],
    [403, 'Forbidden', false],
    [500, 'Internal Server Error', false],
    [502, 'Bad Gateway', false],
  ])('classifies HTTP %s fallback eligibility', (status, message, expected) => {
    expect(isFallbackEligible(classifyRetryError({ status, message }))).toBe(
      expected,
    );
  });

  it('returns true for SSE-embedded 429/529 capacity errors', () => {
    for (const status of [429, 529]) {
      const error = new Error(
        `id:1\nevent:error\n:HTTP_STATUS/${status}\ndata:{"request_id":"req-1","code":"Overloaded","message":"Provider overloaded"}`,
      );
      expect(isFallbackEligible(classifyRetryError(error))).toBe(true);
    }
  });

  it('returns false for fail-fast and transport errors', () => {
    const quotaError = {
      status: 429,
      code: 'Throttling.AllocationQuota',
      message: 'Quota exceeded',
    };
    expect(isFallbackEligible(classifyRetryError(quotaError))).toBe(false);

    expect(
      isFallbackEligible({
        kind: 'transport',
        diagnosis: 'retryable',
        reason: 'transport-error',
        statusCode: 503,
        transportCode: 'ECONNRESET',
      }),
    ).toBe(false);
  });

  it('returns false for a status-less upstream error', () => {
    // The property under test is "retryable, yet still not fallback-eligible":
    // with no HTTP status there is no capacity signal, so retries stay on the
    // primary model. Anchored to the classification as well as the predicate —
    // asserting `false` alone cannot discriminate, because a status-less error
    // classified `unknown` is not fallback-eligible either.
    const classification = classifyRetryError({
      code: 'KeyError',
      requestID: 'req-stream',
    });

    expect(classification).toMatchObject({
      kind: 'provider',
      diagnosis: 'retryable',
      reason: 'upstream-error-without-status',
    });
    expect(classification.statusCode).toBeUndefined();
    expect(isFallbackEligible(classification)).toBe(false);
  });
});
