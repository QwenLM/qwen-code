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
  type RetryErrorClassificationContext,
  type RetryErrorDiagnosis,
} from './retryErrorClassification.js';

/** Asserts `error` (with `context`) classifies to a match of `expected`. */
function expectVerdict(
  error: unknown,
  expected: object,
  context?: RetryErrorClassificationContext,
) {
  expect(classifyRetryError(error, context)).toMatchObject(expected);
}

/** Classifies a plain `{ status, message }` body; asserts the whole HTTP verdict. */
function expectHttp(
  status: number,
  message: string,
  diagnosis: RetryErrorDiagnosis,
  reason: string,
) {
  const verdict = { kind: 'http', diagnosis, statusCode: status, reason };
  expectVerdict({ status, message }, verdict);
}

/** The `ECONNRESET` socket error SDKs nest as a `cause`. */
const socketReset = () =>
  Object.assign(new Error('socket reset'), {
    code: 'ECONNRESET',
  });

/**
 * The error the Anthropic SDK raises for a mid-stream SSE failure frame:
 * `APIError.generate(undefined, ..., sse.data, createResponseHeaders(...))`
 * (streaming.mjs). `createResponseHeaders` hands `generate` a plain
 * lower-cased record, not a `Headers` instance.
 */
function anthropicSseError(
  error: { type: string; message: string },
  bodyRequestId: string,
  headerRequestId: string,
) {
  const frame = JSON.stringify({
    type: 'error',
    error,
    request_id: bodyRequestId,
  });
  return AnthropicAPIError.generate(undefined, `SSE Error: ${frame}`, frame, {
    'request-id': headerRequestId,
  });
}

const UNCLASSIFIED = {
  kind: 'unknown',
  diagnosis: 'unknown',
  reason: 'unclassified',
};
const CLIENT_400 = {
  kind: 'http',
  diagnosis: 'fail-fast',
  statusCode: 400,
  reason: 'client-error',
};
const NETWORK_400 = {
  kind: 'transport',
  diagnosis: 'retryable',
  statusCode: 400,
  reason: 'network-error',
};
const TRANSPORT_RESET = {
  kind: 'transport',
  diagnosis: 'retryable',
  transportCode: 'ECONNRESET',
  reason: 'transport-error',
};
const PERMANENT = { diagnosis: 'fail-fast', reason: 'permanent-provider-code' };
const UPSTREAM = {
  diagnosis: 'retryable',
  reason: 'upstream-error-without-status',
};
const RATE_LIMITED = { diagnosis: 'retryable', reason: 'rate-limit' };
const ABORTED = { kind: 'abort', diagnosis: 'fail-fast', reason: 'aborted' };

describe('classifyRetryError', () => {
  it('classifies HTTP 429 as retryable rate limiting', () => {
    expectHttp(429, 'Too Many Requests', 'retryable', 'rate-limit');
  });

  it('classifies the OpenAI SDK APIUserAbortError as an abort, not unknown', () => {
    // A user cancel on the auth_type=openai path must count as an abort, so
    // retries stop and no api_error is logged, instead of falling to 'unknown'.
    const error = new APIUserAbortError({ message: 'Request was aborted.' });
    expectVerdict(error, { kind: 'abort' });
  });

  it('classifies HTTP 503 as retryable rate limiting to match stream retry semantics', () => {
    expectHttp(503, 'Provider overloaded', 'retryable', 'rate-limit');
  });

  it('classifies provider rate-limit codes as retryable rate limiting', () => {
    const error = new Error(
      '{"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}',
    );
    expectVerdict(error, {
      kind: 'provider',
      ...RATE_LIMITED,
      providerCode: '1302',
      providerMessage: '您的账户已达到速率限制，请您控制请求频率',
    });

    const body = {
      error: { code: 1305, message: 'IdealTalk rate limit' },
    };
    expectVerdict(body, {
      kind: 'provider',
      ...RATE_LIMITED,
      providerCode: '1305',
      providerMessage: 'IdealTalk rate limit',
    });
  });

  it('honors caller-provided extra rate-limit codes in diagnostics', () => {
    expectVerdict(
      { error: { code: 4999, message: 'Provider-specific throttle' } },
      {
        kind: 'provider',
        ...RATE_LIMITED,
        providerCode: '4999',
        providerMessage: 'Provider-specific throttle',
      },
      { extraRetryErrorCodes: [4999] },
    );
  });

  it('honors extra rate-limit codes on Error instances with status properties', () => {
    const error = Object.assign(new Error('Provider-specific throttle'), {
      status: 4999,
    });
    const context = {
      authType: AuthType.USE_OPENAI,
      extraRetryErrorCodes: [4999],
    };

    expectVerdict(error, { kind: 'provider', ...RATE_LIMITED }, context);
  });

  it('classifies SSE-embedded non-quota 429 errors as retryable rate limiting', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-1","code":"Throttling.RateLimit","message":"Rate limit exceeded"}',
    );

    expectVerdict(error, {
      kind: 'sse-provider',
      ...RATE_LIMITED,
      statusCode: 429,
      providerCode: 'Throttling.RateLimit',
      providerMessage: 'Rate limit exceeded',
      requestId: 'req-1',
    });
  });

  it('classifies SSE-embedded allocation quota errors as provider business failures', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-1","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
    );

    expectVerdict(error, {
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
    const error = new Error('previously allocated quota exceeded');
    expectVerdict(error, UNCLASSIFIED);
  });

  it('marks Qwen OAuth free-tier quota errors as fail-fast', () => {
    expectVerdict(
      {
        status: 429,
        code: 'insufficient_quota',
        message: 'Free allocated quota exceeded',
      },
      {
        kind: 'provider-business',
        diagnosis: 'fail-fast',
        statusCode: 429,
        providerCode: 'insufficient_quota',
        reason: 'qwen-oauth-free-tier-quota',
      },
      { authType: AuthType.QWEN_OAUTH },
    );
  });

  it('marks request validation errors as fail-fast', () => {
    expectVerdict(
      {
        status: 400,
        code: 'invalid_request_error',
        message: 'Invalid messages in payload',
      },
      { ...CLIENT_400, providerCode: 'invalid_request_error' },
    );
  });

  it('pins 408 and 425 as current client-error fail-fast classifications', () => {
    expectHttp(408, 'Request Timeout', 'fail-fast', 'client-error');
    expectHttp(425, 'Too Early', 'fail-fast', 'client-error');
  });

  it('classifies a 4xx wrapping a low-level network failure (EOF) as retryable', () => {
    // Mirrors "400 network error for request to ...: EOF": a peer-closed
    // connection wrapped in a 4xx with no provider error body. Channel/daemon
    // paths have no manual retry, so it must auto-retry (bounded). Real SDK
    // failures are Errors, whose `message` is no provider field (unlike a
    // genuine client-error payload's).
    const err = Object.assign(
      new Error(
        'network error for request to http://11.0.0.1:8080/v1/chat/completions: Post "http://11.0.0.1:8080/v1/chat/completions": EOF',
      ),
      { status: 400 },
    );
    expectVerdict(err, NETWORK_400);
  });

  it('keeps a 4xx with provider fields fail-fast even if the message mentions EOF', () => {
    // A genuine client error carries provider fields; the network-failure
    // exception must not relabel it as retryable.
    const body = {
      status: 400,
      code: 'invalid_request_error',
      message: 'bad request EOF',
    };
    expectVerdict(body, CLIENT_400);
  });

  it('keeps a bare-EOF 4xx message fail-fast without the wrapper marker', () => {
    // Only the 'network error for request ...' wrapper qualifies; a bare EOF in
    // a gateway's permanent client error must not trigger bounded retries.
    expectVerdict(
      Object.assign(new Error('unexpected EOF while parsing request body'), {
        status: 400,
      }),
      CLIENT_400,
    );
  });

  it('finds the network-failure marker in a nested cause message', () => {
    const err = Object.assign(new Error('request failed'), {
      status: 400,
      cause: new Error(
        'network error for request to http://h:8080/v1/chat/completions: EOF',
      ),
    });
    expectVerdict(err, NETWORK_400);
  });

  it('keeps a plain-object 4xx fail-fast even with the marker message', () => {
    // A non-Error payload's `message` is a provider field, i.e. a provider
    // error body — a genuine client error, not a wrapped network failure.
    const body = {
      status: 400,
      message: 'network error for request to http://h: EOF',
    };
    expectVerdict(body, CLIENT_400);
  });

  it('keeps a request-id-bearing 4xx fail-fast even with the marker message', () => {
    // With a request id present the Error message counts as a provider field,
    // so the payload is a provider response, not a wrapped failure.
    expectVerdict(
      Object.assign(new Error('network error for request to http://h: EOF'), {
        status: 400,
        request_id: 'req-1',
      }),
      CLIENT_400,
    );
  });

  it('keeps a 4xx with a cause-nested transport code fail-fast', () => {
    // A socket code in the cause chain does not relabel a definitive 4xx;
    // only the message marker does.
    const error = Object.assign(new Error('terminated'), {
      status: 400,
      cause: socketReset(),
    });
    expectVerdict(error, CLIENT_400);
  });

  it('leaves transportCode unset on a marker-matched 4xx that also carries a code', () => {
    // The omission keeps 4xx-wrapped failures out of the transportCode-keyed
    // stream replay/continuation gates (see llm-chat.test.ts).
    const err = Object.assign(
      new Error('network error for request to http://h: EOF'),
      {
        status: 400,
        cause: socketReset(),
      },
    );
    expectVerdict(err, NETWORK_400);
    expect(classifyRetryError(err).transportCode).toBeUndefined();
  });

  it('marks auth errors as fail-fast', () => {
    expectHttp(401, 'Unauthorized', 'fail-fast', 'auth-error');
    expectHttp(403, 'Forbidden', 'fail-fast', 'auth-error');
  });

  it('classifies 529 as retryable capacity overload', () => {
    expectHttp(529, 'Overloaded', 'retryable', 'capacity-overload');
  });

  it('preserves SSE transport when classifying 529 capacity overload', () => {
    const error = new Error(
      'id:1\nevent:error\n:HTTP_STATUS/529\ndata:{"request_id":"req-1","code":"Overloaded","message":"Provider overloaded"}',
    );

    expectVerdict(error, {
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
    expectHttp(500, 'Internal error', 'retryable', 'server-error');
  });

  it('keeps non-error HTTP statuses and invalid status fields unknown', () => {
    expectHttp(302, 'Redirect', 'unknown', 'http-status');
    expectVerdict({ status: 700, message: 'Invalid status' }, UNCLASSIFIED);
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
      cause: socketReset(),
    });

    expectVerdict(error, TRANSPORT_RESET);
  });

  it('classifies SDK-wrapped transport codes nested in the cause chain', () => {
    // The OpenAI SDK's pre-header reset: APIConnectionError -> TypeError('fetch
    // failed') -> cause { code: 'ECONNRESET' }, two levels down, yet transport.
    const error = Object.assign(new Error('Connection error.'), {
      cause: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('read ECONNRESET'), {
          code: 'ECONNRESET',
        }),
      }),
    });

    expectVerdict(error, TRANSPORT_RESET);
  });

  it('prefers a transport cause over an HTTP status when both are present', () => {
    // With an HTTP status over a socket-level cause, the more fundamental
    // transport cause wins and the status is reported as secondary.
    const error = Object.assign(new Error('upstream failed'), {
      status: 500,
      cause: socketReset(),
    });

    expectVerdict(error, { ...TRANSPORT_RESET, statusCode: 500 });
  });

  it('keeps a definitive 4xx status authoritative over a transport cause', () => {
    // A 401 with a socket-level cause stays fail-fast: the server reached a
    // verdict, so a transient cause must not relabel it retryable.
    const error = Object.assign(new Error('unauthorized'), {
      status: 401,
      cause: socketReset(),
    });

    expectVerdict(error, {
      kind: 'http',
      diagnosis: 'fail-fast',
      statusCode: 401,
      reason: 'auth-error',
    });
  });

  it('classifies allocated-quota errors from direct properties as fail-fast', () => {
    const body = {
      status: 429,
      code: 'Throttling.AllocationQuota',
      message: 'Allocated quota exceeded',
    };
    expectVerdict(body, {
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

    expect(classification).toMatchObject(UNCLASSIFIED);
    expect(classification).not.toHaveProperty('providerCode');
    expect(classification).not.toHaveProperty('providerMessage');
  });

  it('extracts provider fields from Error instances with direct SDK properties', () => {
    const error = Object.assign(new Error('Provider-specific throttle'), {
      code: 'Throttling.Custom',
      request_id: 'req-direct-error',
    });

    expectVerdict(error, {
      kind: 'provider',
      ...UPSTREAM,
      providerCode: 'Throttling.Custom',
      providerMessage: 'Provider-specific throttle',
      requestId: 'req-direct-error',
    });
  });

  it('classifies a mid-stream upstream error with no HTTP status as retryable', () => {
    // A gateway pushing `{"error": {...}}` into an already-200 SSE stream
    // reaches us as `new APIError(undefined, data.error, undefined,
    // response.headers)`: no status, the body's code/message, and the
    // `x-request-id` as `requestID`. Seen in the wild as KeyError / "'id'",
    // which fell through to 'unknown' and killed the turn on the first attempt.
    const error = Object.assign(new Error("'id'"), {
      code: 'KeyError',
      requestID: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
    });

    const classification = classifyRetryError(error);
    expect(classification).toMatchObject({
      kind: 'provider',
      ...UPSTREAM,
      providerCode: 'KeyError',
      providerMessage: "'id'",
      requestId: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
    });
    expect(classification).not.toHaveProperty('statusCode');
  });

  it('classifies the SDK error a mid-stream gateway frame actually produces', () => {
    // The case above hand-builds the shape, so an SDK bump renaming `requestID`
    // would bring the incident back with the suite green. This oracle drives
    // the real constructor the SDK throws from its SSE iterator, real headers.
    const error = new APIError(
      undefined,
      { code: 'KeyError', message: "'id'" },
      undefined,
      new Headers({ 'x-request-id': 'cd7f37f3-d38a-9dec-804f-f70dda5650eb' }),
    );

    expectVerdict(error, {
      kind: 'provider',
      ...UPSTREAM,
      providerCode: 'KeyError',
      requestId: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
    });
    expect(isRetryableUpstreamError(error)).toBe(true);

    // Present-but-empty header: `Headers.get` returns '' (not null), and an id
    // the provider never set must not open the gate.
    const untraced = new APIError(
      undefined,
      { code: 'KeyError', message: "'id'" },
      undefined,
      new Headers({ 'x-request-id': '' }),
    );
    expect(untraced.requestID).toBe('');
    expectVerdict(untraced, UNCLASSIFIED);
    expect(isRetryableUpstreamError(untraced)).toBe(false);
  });

  it('classifies the error an Anthropic mid-stream frame actually produces', () => {
    // `generate` (see `anthropicSseError`) short-circuits on the missing status
    // into an `APIConnectionError` *without* headers: the header `request-id`
    // never reaches `request_id`, so unlike OpenAI's a native frame cannot open
    // the status-less gate. A gateway's own id in the frame body (what an
    // Anthropic-compatible `baseUrl` route sees) still can and survives, as
    // `generate` keeps the raw frame as the message.
    const error = anthropicSseError(
      { type: 'api_error', message: 'Internal server error' },
      'gw-trace-1',
      'header-trace-1',
    );

    expect(error.request_id).toBeUndefined();
    expectVerdict(error, {
      kind: 'provider',
      ...UPSTREAM,
      requestId: 'gw-trace-1',
    });
    expect(isRetryableUpstreamError(error)).toBe(true);

    // Nor can that channel smuggle a permanent rejection into a retry: the
    // payload reader folds Anthropic's `type` (`invalid_request_error`) into the
    // provider code, and the permanence guard runs before the request-id branch.
    const permanent = anthropicSseError(
      {
        type: 'invalid_request_error',
        message: 'max_tokens: field required',
      },
      'gw-trace-2',
      'header-trace-2',
    );

    expectVerdict(permanent, PERMANENT);
    expect(isRetryableUpstreamError(permanent)).toBe(false);

    // The credential member (401 when a status survives) must keep its verdict
    // relayed status-less, or a dead key costs the whole ladder to surface.
    const unauthenticated = anthropicSseError(
      { type: 'authentication_error', message: 'invalid x-api-key' },
      'gw-trace-3',
      'header-trace-3',
    );

    expectVerdict(unauthenticated, PERMANENT);
    expect(isRetryableUpstreamError(unauthenticated)).toBe(false);
  });

  it('classifies a status-less provider body embedded in the message as retryable', () => {
    // The provider's JSON body pasted into the message, not on SDK properties.
    // No `:HTTP_STATUS/` marker, so the body's request id is the only evidence
    // the provider traced it. Raw SSE framing in the message earns
    // `sse-provider`; the SDK strips it, so the case above is plain `provider`.
    const error = new Error(
      'id:1\nevent:error\ndata:{"request_id":"req-stream","code":"KeyError","message":"upstream failed"}',
    );

    expectVerdict(error, {
      kind: 'sse-provider',
      ...UPSTREAM,
      requestId: 'req-stream',
    });
  });

  it('fails fast on a permanent provider code scraped from the message', () => {
    // The permanence guard reads the merged providerCode (`details.providerCode
    // ?? providerFields.providerCode`). With no `.code` property this code
    // reaches it only via the message JSON, the scraped half; an object-only
    // merge flips it to retryable. Others read that half too (rate-limit
    // diagnostics, the nested-`.error` sibling); this pins a permanent code.
    // The case above never reads it: its request id has its own reader, so
    // KeyError stays unlisted and retryable either way.
    const error = new Error(
      'id:1\nevent:error\ndata:{"request_id":"req-stream","code":"data_inspection_failed","message":"Output data may contain inappropriate content."}',
    );

    expectVerdict(error, {
      kind: 'sse-provider',
      ...PERMANENT,
      providerCode: 'data_inspection_failed',
      requestId: 'req-stream',
    });
    expect(isRetryableUpstreamError(error)).toBe(false);
  });

  it('fails fast on a permanent provider code nested under .error', () => {
    // `getProviderErrorPayload`'s isApiError fallback reads `.error.code` when
    // no JSON survives in the message: a second shape reaching the permanence
    // guard only via the scraped half of the providerCode merge.
    const error = Object.assign(new Error('moderation rejection'), {
      error: {
        code: 'data_inspection_failed',
        message: 'Output data may contain inappropriate content.',
      },
      requestID: 'req-nested',
    });

    expectVerdict(error, {
      kind: 'provider',
      ...PERMANENT,
      providerCode: 'data_inspection_failed',
      requestId: 'req-nested',
    });
    expect(isRetryableUpstreamError(error)).toBe(false);
  });

  it('fails fast on a permanent provider code even when the request is traced', () => {
    // A request id decides upstream vs. local, not transient vs. permanent.
    // Moderation, credential/billing and malformed-request rejections arrive
    // after a streaming 200 with no status to fail fast on, and would otherwise
    // walk the whole production ladder for a verdict that cannot change.
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
      // The rest of the pinned Anthropic `ErrorObject` union, fixed on arrival
      // (credentials, entitlement, nonexistent model, billing): relayed into a
      // 200 stream with an id, no status, they'd walk the request-id ladder.
      'authentication_error',
      'permission_error',
      'not_found_error',
      'billing_error',
      // Both recoverable by compaction, never by re-sending the identical
      // payload (the reason `context_length_exceeded` was already listed).
      'request_too_large',
      'context_length_exceeded',
    ];

    for (const code of codes) {
      expectVerdict(
        { code, requestID: 'req-1' },
        { ...PERMANENT, providerCode: code },
      );
    }
  });

  it('fails fast on a permanent provider type when the body carries no code', () => {
    // The canonical OpenAI malformed-request body has `invalid_request_error`
    // on `.type` and `code: null`: permanence read off `code` alone never fires
    // and the request id would open the retry gate on a hopeless rejection.
    const body = {
      type: 'invalid_request_error',
      code: null,
      requestID: 'req-1',
    };
    expectVerdict(body, PERMANENT);
  });

  it('fails fast on a permanent provider type when the body also carries a code', () => {
    // R16-1. The message-embedded route scrapes the body, and
    // `getRateLimitErrorDetails` collapsed its `code` and `type` into one
    // `providerCode` (`String(payload.code ?? payload.type)`), dropping a
    // permanent `type` beside a surviving `code`; the object route never had
    // the hole (`getProviderFields` reads `.type` separately). Moderation is
    // why the list exists: `type: 'content_filter'` beside a gateway's `code`
    // is still a rejection re-sending the identical request cannot change.
    const moderation = new Error(
      'event:error\ndata:{"error":{"message":"blocked","type":"content_filter","code":"moderation_blocked"},"request_id":"req-1"}',
    );
    expectVerdict(moderation, PERMANENT);
    expect(isRetryableUpstreamError(moderation)).toBe(false);

    // The same collapse on OpenAI's malformed-request shape, which carries both
    // fields: `.type` names the permanent class, `.code` the specific field.
    const malformed = new Error(
      'event:error\ndata:{"error":{"type":"invalid_request_error","code":"missing_required_field","message":"x is required"},"request_id":"req-2"}',
    );
    expectVerdict(malformed, PERMANENT);
    expect(isRetryableUpstreamError(malformed)).toBe(false);

    // The other end: reading the scraped `type` must not make every body-named
    // class permanent; a transient one keeps the request-id branch's verdict.
    const transient = new Error(
      'event:error\ndata:{"error":{"message":"upstream died","type":"api_error","code":"upstream_500"},"request_id":"req-3"}',
    );
    expectVerdict(transient, UPSTREAM);
    expect(isRetryableUpstreamError(transient)).toBe(true);
  });

  it('fails fast on a permanent provider type from the real SDK error', () => {
    // The case above assumes the SDK output; driving the real constructor, an
    // SDK bump that stops mapping the body's `type` onto the instance reds
    // this (the `.type` sibling of the requestID oracle above).
    const error = new APIError(
      undefined,
      { type: 'invalid_request_error', code: null, message: 'x is required' },
      undefined,
      new Headers({ 'x-request-id': 'req-1' }),
    );

    expectVerdict(error, PERMANENT);
    expect(isRetryableUpstreamError(error)).toBe(false);
  });

  it('does not treat every provider type as permanent', () => {
    // `.type` also carries transient values; the anchored list keeps these
    // server-side faults retryable: the transient members of the pinned
    // Anthropic `ErrorObject` union plus OpenAI's `server_error`. A broad
    // `.*_error` alternative would make `timeout_error` fail-fast.
    for (const type of ['api_error', 'timeout_error', 'server_error']) {
      expectVerdict({ type, requestID: 'req-1' }, UPSTREAM);
    }
    // The throttles keep their own arm, which owns the Retry-After-aware delay.
    for (const type of ['rate_limit_error', 'overloaded_error']) {
      expectVerdict({ type, requestID: 'req-1' }, RATE_LIMITED);
    }
  });

  it('keeps an unrecognised upstream code retryable', () => {
    // The point of the branch: the next gateway bug should not have to be
    // taught to the classifier before it stops killing turns.
    expectVerdict({ code: 'KeyError', requestID: 'req-1' }, UPSTREAM);
  });

  it('treats an empty request id as no request id', () => {
    // `headers.get('x-request-id')` yields '' for a present-but-empty header
    // (legal HTTP; proxies send it when upstream set none). An error the
    // provider never traced must not open the retry gate.
    expectVerdict({ code: 'KeyError', requestID: '' }, UNCLASSIFIED);
  });

  it('treats an empty request id scraped from the message as no request id', () => {
    // Same rule on the other reader: the rate-limit details scrape the body and
    // keep an empty id, so the merge must fall through it, not coalesce onto it.
    const error = new Error(
      'id:1\nevent:error\ndata:{"request_id":"","code":"KeyError","message":"upstream failed"}',
    );

    expectVerdict(error, UNCLASSIFIED);
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
      expectVerdict(error, UNCLASSIFIED);
    }
  });

  it('keeps a definitive HTTP status authoritative over a request id', () => {
    // A traced 4xx is still a permanent client error: the status block runs
    // before the status-less branches, so it cannot become retryable.
    const body = {
      status: 400,
      code: 'invalid_request_error',
      request_id: 'req-400',
      message: 'malformed tool call',
    };
    expectVerdict(body, CLIENT_400);
  });

  it('keeps a provider-traced socket cut transport-classified over a request id', () => {
    // The transport branch runs first, and that order is load-bearing:
    // isRetryableStreamTransportError admits mid-stream replay only on `kind
    // === 'transport'` plus an allow-listed code, so relabelling a traced
    // socket cut as provider would silently disable replay, continuation
    // recovery and Anthropic's deferred tool-call release, suite still green.
    // `transportCode` is asserted as that predicate reads it; no request id,
    // as the transport return deliberately omits the provider fields.
    const error = Object.assign(new Error('upstream failed'), {
      requestID: 'req-1',
      cause: socketReset(),
    });

    expectVerdict(error, TRANSPORT_RESET);
  });

  it('does not copy unparsed SSE frames into providerMessage', () => {
    const classification = classifyRetryError(
      new Error('id:1\nevent:error\n:HTTP_STATUS/429\ndata:not-json'),
    );

    expect(classification).toMatchObject({
      kind: 'sse-provider',
      ...RATE_LIMITED,
      statusCode: 429,
    });
    expect(classification).not.toHaveProperty('providerMessage');
  });

  it('marks abort errors as fail-fast', () => {
    const error = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });

    expectVerdict(error, ABORTED);
  });

  it('marks axios-style canceled errors as fail-fast aborts', () => {
    const error = Object.assign(new Error('canceled'), {
      name: 'CanceledError',
      code: 'ECONNABORTED',
    });

    expectVerdict(error, ABORTED);
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
    // "Retryable, yet not fallback-eligible": no HTTP status means no capacity
    // signal, so retries stay on the primary model. The classification is
    // asserted too, as `false` alone cannot discriminate: a status-less error
    // classified `unknown` is not fallback-eligible either.
    const classification = classifyRetryError({
      code: 'KeyError',
      requestID: 'req-stream',
    });

    expect(classification).toMatchObject({ kind: 'provider', ...UPSTREAM });
    expect(classification.statusCode).toBeUndefined();
    expect(isFallbackEligible(classification)).toBe(false);
  });
});
