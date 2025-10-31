/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStreamJsonInputFromIterable } from './input.js';
import * as ioModule from './io.js';

describe('parseStreamJsonInputFromIterable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the shared stream writer for control responses', async () => {
    const writeSpy = vi
      .spyOn(ioModule, 'writeStreamJsonEnvelope')
      .mockImplementation(() => {});

    async function* makeLines(): AsyncGenerator<string> {
      yield JSON.stringify({
        type: 'control_request',
        request_id: 'req-init',
        request: { subtype: 'initialize' },
      });
      yield JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello world' }],
        },
      });
    }

    const result = await parseStreamJsonInputFromIterable(makeLines());

    expect(result.prompt).toBe('hello world');
    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'control_response',
        request_id: 'req-init',
        success: true,
      }),
    );
  });
});
