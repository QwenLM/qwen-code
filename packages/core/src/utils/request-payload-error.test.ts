/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getRequestPayloadTooLargeInfo,
  REQUEST_PAYLOAD_TOO_LARGE_RECOVERY_MESSAGE,
} from './request-payload-error.js';
import { getContextLengthExceededInfo } from './contextLengthError.js';

function sdkStyle413(message?: string): Error {
  // Shape mirrors the OpenAI SDK's APIError for a 413 served as an HTML
  // error page by a reverse proxy (#10380).
  return Object.assign(
    new Error(
      message ??
        '413 POST https://gateway.internal/v1/chat/completions: Request Entity Too Large\n' +
          '<html>\n<head><title>413 Request Entity Too Large</title></head>\n' +
          '<body><center><h1>413 Request Entity Too Large</h1></center></body>\n</html>',
    ),
    { status: 413 },
  );
}

describe('getRequestPayloadTooLargeInfo', () => {
  it('detects an SDK-style 413 with an HTML error page body', () => {
    expect(getRequestPayloadTooLargeInfo(sdkStyle413()).isTooLarge).toBe(true);
  });

  it('detects a bare status 413 without any wording', () => {
    const error = Object.assign(new Error('bad request'), { status: 413 });
    expect(getRequestPayloadTooLargeInfo(error).isTooLarge).toBe(true);
  });

  it('finds the status through a wrapping cause chain', () => {
    const wrapped = new Error('request failed', { cause: sdkStyle413() });
    expect(getRequestPayloadTooLargeInfo(wrapped).isTooLarge).toBe(true);
  });

  it('exposes the deep-found status so re-thrown errors keep it', () => {
    // The actionable-error copy in llm-chat must reuse this cause-aware
    // result; a shallow top-level lookup returns undefined here (#10380).
    const wrapped = new Error('request failed', { cause: sdkStyle413() });
    expect(getRequestPayloadTooLargeInfo(wrapped).status).toBe(413);
    expect(getRequestPayloadTooLargeInfo(sdkStyle413()).status).toBe(413);
    // A wording-only match carries no status.
    expect(
      getRequestPayloadTooLargeInfo(new Error('payload too large')).status,
    ).toBeUndefined();
  });

  it('falls back to standard 413 reason phrases when status is lost', () => {
    for (const message of [
      'Request Entity Too Large',
      'The request body is too large for this gateway',
      'payload too large',
      'Content Too Large',
    ]) {
      expect(getRequestPayloadTooLargeInfo(new Error(message)).isTooLarge).toBe(
        true,
      );
    }
  });

  it('does not fire for other statuses or unrelated messages', () => {
    expect(
      getRequestPayloadTooLargeInfo(
        Object.assign(new Error('nope'), { status: 400 }),
      ).isTooLarge,
    ).toBe(false);
    expect(
      getRequestPayloadTooLargeInfo(
        Object.assign(new Error('server exploded'), { status: 500 }),
      ).isTooLarge,
    ).toBe(false);
    expect(
      getRequestPayloadTooLargeInfo(new Error('connection timed out'))
        .isTooLarge,
    ).toBe(false);
    // A stray "413" that is not a 413 reason phrase must not match.
    expect(
      getRequestPayloadTooLargeInfo(new Error('task 413 failed unexpectedly'))
        .isTooLarge,
    ).toBe(false);
    expect(getRequestPayloadTooLargeInfo(null).isTooLarge).toBe(false);
    expect(getRequestPayloadTooLargeInfo('plain string').isTooLarge).toBe(
      false,
    );
  });

  it('does not widen token-wording overflow detection for 413s', () => {
    // Regression: a 413 must stay unrecognized by the token-wording
    // detector, so upload/file endpoints and other shared helpers never
    // see it as a context overflow; recovery is model-request-scoped.
    expect(getContextLengthExceededInfo(sdkStyle413()).isExceeded).toBe(false);
  });

  it('keeps the recovery message actionable', () => {
    expect(REQUEST_PAYLOAD_TOO_LARGE_RECOVERY_MESSAGE).toMatch(
      /start a new session/i,
    );
    expect(REQUEST_PAYLOAD_TOO_LARGE_RECOVERY_MESSAGE).toMatch(/413/);
  });
});
