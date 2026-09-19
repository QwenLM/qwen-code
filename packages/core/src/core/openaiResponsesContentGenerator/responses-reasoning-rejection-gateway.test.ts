/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isEncryptedReasoningRejection } from './responses-reasoning-rejection.js';

const error = {
  error: {
    code: 'invalid_encrypted_content',
    type: 'invalid_request_error',
    param: 'input',
    message: 'Conflicting authenticated continuation identities.',
  },
};

function gateway(fields: Record<string, unknown>): string {
  return (
    'data: ' +
    JSON.stringify({
      routify_response: {
        success: false,
        status: 400,
        error_source: 'CLIENT_ERROR',
        ...fields,
      },
    }) +
    '\n\n'
  );
}

describe('gateway-wrapped encrypted reasoning rejection reproduction', () => {
  const message = `AllModelsFailed: ${JSON.stringify(error)}`;
  it('recognizes the structured gateway error control', () => {
    expect(
      isEncryptedReasoningRejection(400, gateway({ error_detail: error })),
    ).toBe(true);
  });

  it('recognizes the same error carried by AllModelsFailed', () => {
    expect(
      isEncryptedReasoningRejection(
        400,
        gateway({ error_message: `AllModelsFailed: ${JSON.stringify(error)}` }),
      ),
    ).toBe(true);
  });

  it.each([
    { status: 500 },
    { status: '400' },
    { success: true },
    { error_detail: { error: { code: 'another_error' } } },
  ])('rejects contradictory gateway metadata: %j', (fields) => {
    expect(
      isEncryptedReasoningRejection(
        400,
        gateway({ error_message: message, ...fields }),
      ),
    ).toBe(false);
  });

  it.each([
    `Quoted: ${message}`,
    `${message} trailing text`,
    `${message} ${JSON.stringify(error)}`,
    `AllModelsFailed: [${JSON.stringify(error)}]`,
    'AllModelsFailed: {"error":{"code":"other","code":"invalid_encrypted_content"}}',
    'AllModelsFailed: {"error":{"code":"invalid_encrypted_content","message":"raw\nnewline"}}',
    `AllModelsFailed: ${JSON.stringify({ debug: error })}`,
    `AllModelsFailed: ${JSON.stringify({ error: { code: 'other', message } })}`,
    `AllModelsFailed: ${JSON.stringify({ routify_response: { success: false, status: 400, error_message: message } })}`,
  ])('rejects malformed or unrelated nested errors: %s', (error_message) => {
    expect(isEncryptedReasoningRejection(400, gateway({ error_message }))).toBe(
      false,
    );
  });

  it('requires HTTP 400 and an authoritative gateway error_message', () => {
    const body = gateway({ error_message: message });
    expect(isEncryptedReasoningRejection(404, body)).toBe(false);
    expect(
      isEncryptedReasoningRejection(400, gateway({ debug: message })),
    ).toBe(false);
    expect(
      isEncryptedReasoningRejection(
        400,
        JSON.stringify({
          error: { code: 'other' },
          routify_response: JSON.parse(body.slice(6)).routify_response,
        }),
      ),
    ).toBe(false);
  });

  it('shares the object budget between the outer and quoted envelopes', () => {
    // Two outer objects plus two nested error objects leave room for 28 extras.
    expect(
      isEncryptedReasoningRejection(
        400,
        gateway({
          error_message: message,
          extra: Array.from({ length: 28 }, () => ({})),
        }),
      ),
    ).toBe(true);
    expect(
      isEncryptedReasoningRejection(
        400,
        gateway({
          error_message: message,
          extra: Array.from({ length: 29 }, () => ({})),
        }),
      ),
    ).toBe(false);
  });
});
