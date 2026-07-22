/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readBoundedJson } from './http-json.js';

describe('readBoundedJson', () => {
  it('parses a response inside the byte limit', async () => {
    await expect(
      readBoundedJson<{ ok: boolean }>(new Response('{"ok":true}'), 64),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects declared and streamed oversized responses', async () => {
    await expect(
      readBoundedJson(
        new Response('{}', { headers: { 'content-length': '100' } }),
        10,
      ),
    ).rejects.toThrow('too large');
    await expect(
      readBoundedJson(new Response('12345678901'), 10),
    ).rejects.toThrow('too large');
  });

  it('rejects invalid JSON without returning response content', async () => {
    await expect(
      readBoundedJson(new Response('secret-value'), 64),
    ).rejects.toThrow('invalid JSON');
  });
});
