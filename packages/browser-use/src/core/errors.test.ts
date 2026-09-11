/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { invalidArguments, sanitizeOperationError } from './errors.js';
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

describe('operation error classification', () => {
  it('classifies the failure text rather than the Playwright API prefix', () => {
    expect(
      sanitizeOperationError(
        'locator.fill',
        new Error('locator.fill: Element is not an <input> element'),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    const timeout = new Error('locator.click: Timeout 5000ms exceeded');
    timeout.name = 'TimeoutError';
    expect(sanitizeOperationError('locator.click', timeout)).toMatchObject({
      code: 'OPERATION_TIMEOUT',
    });
    expect(
      sanitizeOperationError(
        'locator.click',
        new Error('locator.click: strict mode violation: two buttons'),
      ),
    ).toMatchObject({ code: 'LOCATOR_NOT_UNIQUE' });
  });

  it('keeps classifying genuine locator failures', () => {
    expect(
      sanitizeOperationError(
        'locator.waitFor',
        new Error('locator.waitFor: frame was detached'),
      ),
    ).toMatchObject({ code: 'INVALID_LOCATOR' });
  });

  it('reports a crashed target as STALE_TAB', () => {
    expect(
      sanitizeOperationError('locator.click', new Error('Target crashed ')),
    ).toMatchObject({ code: 'STALE_TAB' });
    expect(
      sanitizeOperationError('tab.screenshot', new Error('Page crashed')),
    ).toMatchObject({ code: 'STALE_TAB' });
    // ...even when the appended browser log quotes a selector.
    expect(
      sanitizeOperationError(
        'locator.click',
        new Error('Target crashed {"method":"DOM.querySelector"}'),
      ),
    ).toMatchObject({ code: 'STALE_TAB' });
  });

  it('prefers Playwright error names over page-influenced message text', () => {
    const closed = new Error('locator.click: watch out, no selector here');
    closed.name = 'TargetClosedError';
    expect(sanitizeOperationError('locator.click', closed)).toMatchObject({
      code: 'STALE_TAB',
    });
    const timeout = new Error('locator.click: waiting for selector "button"');
    timeout.name = 'TimeoutError';
    expect(sanitizeOperationError('locator.click', timeout)).toMatchObject({
      code: 'OPERATION_TIMEOUT',
    });
    // Page-authored text must not pick the reported code.
    expect(
      sanitizeOperationError(
        'locator.evaluate',
        new Error('page threw: invalid selector, timeout imminent'),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
  });
});
