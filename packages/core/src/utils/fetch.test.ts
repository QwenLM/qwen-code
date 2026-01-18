/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { FetchError, formatFetchErrorForUser } from './fetch.js';

describe('formatFetchErrorForUser', () => {
  it('includes troubleshooting hints for TLS errors', () => {
    const tlsCause = new Error('unable to verify the first certificate');
    (tlsCause as Error & { code?: string }).code =
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE';

    const fetchError = new TypeError('fetch failed') as TypeError & {
      cause?: unknown;
    };
    fetchError.cause = tlsCause;

    const message = formatFetchErrorForUser(fetchError, {
      url: 'https://chat.qwen.ai',
    });

    expect(message).toContain('fetch failed');
    expect(message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(message).toContain('Troubleshooting:');
    expect(message).toContain('Confirm you can reach https://chat.qwen.ai');
    expect(message).toContain('--proxy');
    expect(message).toContain('NODE_EXTRA_CA_CERTS');
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
