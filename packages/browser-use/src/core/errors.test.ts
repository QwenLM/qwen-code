/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { invalidArguments } from './errors.js';
import { commandSchemas } from './schemas.js';

describe('model-facing argument errors', () => {
  it('includes the field, expected type and keypress usage without echoing its value', () => {
    const result = commandSchemas['cua.keypress'].safeParse({
      tabId: 'tab-1',
      keys: 'private input',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid keys');

    const error = invalidArguments('cua.keypress', result.error);
    expect(error.message).toContain('keys: Expected array, received string');
    expect(error.message).toContain('cua.keypress({ keys: ["Enter"] })');
    expect(error.message).not.toContain('private input');
    expect(error.details).toMatchObject({
      issues: [
        { code: 'invalid_type', path: 'keys', message: expect.any(String) },
      ],
    });
  });

  it('bounds validation output while retaining the focus-based typing guidance', () => {
    const result = commandSchemas['dom_cua.type'].safeParse({
      tabId: 'tab-1',
      text: 'hello',
      ['unknown'.repeat(1_000)]: true,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected unknown field');

    const error = invalidArguments('dom_cua.type', result.error);
    expect(error.message.length).toBeLessThan(400);
    expect(error.message).toContain('Unrecognized key');
    expect(error.message).toContain('dom_cua.click({ node_id })');
    expect(error.message).toContain('dom_cua.type({ text })');
  });
});
