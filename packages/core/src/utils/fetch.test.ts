/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FetchError, formatFetchErrorForUser } from './fetch.js';

function makeTlsError(): Error {
  const tlsCause = new Error('unable to verify the first certificate');
  (tlsCause as Error & { code?: string }).code =
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  const fetchError = new TypeError('fetch failed') as TypeError & {
    cause?: unknown;
  };
  fetchError.cause = tlsCause;
  return fetchError;
}

describe('formatFetchErrorForUser', () => {
  const saved = {
    QWEN_TLS_INSECURE: process.env['QWEN_TLS_INSECURE'],
    NODE_TLS_REJECT_UNAUTHORIZED: process.env['NODE_TLS_REJECT_UNAUTHORIZED'],
  };

  beforeEach(() => {
    delete process.env['QWEN_TLS_INSECURE'];
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('includes troubleshooting hints for TLS errors', () => {
    const message = formatFetchErrorForUser(makeTlsError(), {
      url: 'https://chat.qwen.ai',
    });

    expect(message).toContain('fetch failed');
    expect(message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(message).toContain('Troubleshooting:');
    expect(message).toContain('Confirm you can reach https://chat.qwen.ai');
    expect(message).toContain('--proxy');
    expect(message).toContain('NODE_EXTRA_CA_CERTS');
    expect(message).toContain('--insecure');
  });

  it('omits the --insecure hint when verification is already disabled', () => {
    process.env['QWEN_TLS_INSECURE'] = '1';
    const message = formatFetchErrorForUser(makeTlsError());

    expect(message).toContain('already disabled');
    expect(message).not.toContain('NODE_EXTRA_CA_CERTS');
    expect(message).not.toContain('pass `--insecure`');
  });

  it('includes troubleshooting hints for network codes', () => {
    const fetchError = new FetchError(
      'Request timed out after 100ms',
      'ETIMEDOUT',
    );
    const message = formatFetchErrorForUser(fetchError, {
      url: 'https://example.com',
    });

    expect(message).toContain('Request timed out after 100ms');
    expect(message).toContain('Troubleshooting:');
    expect(message).toContain('Confirm you can reach https://example.com');
    expect(message).toContain('--proxy');
    expect(message).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('does not include troubleshooting for non-fetch errors', () => {
    expect(formatFetchErrorForUser(new Error('boom'))).toBe('boom');
  });
});
