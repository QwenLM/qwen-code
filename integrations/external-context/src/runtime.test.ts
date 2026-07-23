/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderTimeoutError } from './http-client.js';
import { observeProviderOperation } from './runtime.js';
import type { ProviderBinding } from './types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('observeProviderOperation', () => {
  it('logs bounded metadata without result content', async () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(
      observeProviderOperation({
        binding: binding(),
        operation: 'search',
        execute: async () => [
          { id: 'one', content: 'sensitive provider result' },
        ],
        count: (items) => items.length,
      }),
    ).resolves.toHaveLength(1);

    const output = write.mock.calls.join(' ');
    expect(output).toMatch(
      /provider=generic-http-search-v1 operation=search status=ok duration_ms=\d+ count=1/,
    );
    expect(output).not.toContain('sensitive provider result');
  });

  it('classifies timeouts without logging provider error details', async () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const error = new ProviderTimeoutError();

    await expect(
      observeProviderOperation({
        binding: binding(),
        operation: 'search',
        execute: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);

    const output = write.mock.calls.join(' ');
    expect(output).toMatch(
      /provider=generic-http-search-v1 operation=search status=timeout duration_ms=\d+/,
    );
    expect(output).not.toContain(error.message);
  });
});

function binding(): ProviderBinding {
  return {
    type: 'generic-http-search-v1',
    provider: {
      search: vi.fn(),
    },
  };
}
