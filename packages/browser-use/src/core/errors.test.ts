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
    // A genuine strict-mode violation crosses CDP as the raw exception
    // description, so Playwright's phrase sits behind an "Error: " layer.
    expect(
      sanitizeOperationError(
        'locator.click',
        new Error(
          "locator.click: Error: strict mode violation: locator('button') resolved to 2 elements:",
        ),
      ),
    ).toMatchObject({ code: 'LOCATOR_NOT_UNIQUE' });
    expect(
      sanitizeOperationError(
        'locator.click',
        new Error(
          "strict mode violation: locator('button') resolved to 2 elements:",
        ),
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
    // Page-thrown values render behind an "Error: " wrapper, and appended
    // log tails quote page markup; neither may pick the code.
    expect(
      sanitizeOperationError(
        'locator.evaluate',
        new Error('locator.evaluate: Error: page has been closed'),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(
      sanitizeOperationError(
        'locator.evaluate',
        new Error('locator.evaluate: Error: strict mode violation'),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    // A page-thrown strict-mode lookalike lacks the element count Playwright
    // always appends, so it must not pick the code either.
    expect(
      sanitizeOperationError(
        'locator.evaluate',
        new Error(
          'locator.evaluate: Error: strict mode violation: resolved to elements',
        ),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(
      sanitizeOperationError(
        'locator.click',
        new Error('locator.click: slow response\nTarget crashed'),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(
      sanitizeOperationError(
        'locator.click',
        new Error(
          'locator.click: failed\n<button>Page has been closed</button>',
        ),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    // A genuine Playwright timeout wins over crash-shaped page text.
    const slowCrash = new Error('locator.click: slow\npage crashed');
    slowCrash.name = 'TimeoutError';
    expect(sanitizeOperationError('locator.click', slowCrash)).toMatchObject({
      code: 'OPERATION_TIMEOUT',
    });
  });

  it('does not let a page-thrown primitive pick the code on the evaluate channel', () => {
    // A page-thrown primitive string crosses CDP verbatim behind the
    // evaluate apiName, with no "Error: " wrapper, so on that channel the
    // first line is page-controlled and must not match Playwright's own
    // crash/close phrases.
    expect(
      sanitizeOperationError(
        'locator.evaluate',
        new Error('locator.evaluate: Target crashed'),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(
      sanitizeOperationError(
        'playwright.evaluate',
        new Error('page.evaluate: Page crashed'),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(
      sanitizeOperationError(
        'locator.evaluate',
        new Error('locator.evaluate: frame was detached'),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(
      sanitizeOperationError(
        'locator.type',
        new Error('locator.evaluateHandle: no tab with id 7'),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    // A strict-mode lookalike thrown as a primitive carries no wrapper, and
    // its element count is page-authored text, so it must not classify.
    expect(
      sanitizeOperationError(
        'locator.evaluate',
        new Error(
          "locator.evaluate: strict mode violation: locator('button') resolved to 2 elements:",
        ),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(
      sanitizeOperationError(
        'playwright.evaluate',
        new Error(
          "page.evaluate: strict mode violation: locator('button') resolved to 2 elements:",
        ),
      ),
    ).toMatchObject({ code: 'OPERATION_FAILED' });
    // The genuine failure reaches that channel behind Playwright's
    // "Error: " layer and keeps its code.
    expect(
      sanitizeOperationError(
        'locator.evaluate',
        new Error(
          "locator.evaluate: Error: strict mode violation: locator('button') resolved to 2 elements:",
        ),
      ),
    ).toMatchObject({ code: 'LOCATOR_NOT_UNIQUE' });
    // The same phrases stay classified on channels that never run page code.
    expect(
      sanitizeOperationError('locator.click', new Error('Target crashed ')),
    ).toMatchObject({ code: 'STALE_TAB' });
  });

  it('ignores error-code tokens that no internal producer emits as text', () => {
    for (const token of ['STALE_TAB', 'LOCATOR_NOT_UNIQUE', 'INVALID_LOCATOR'])
      expect(
        sanitizeOperationError(
          'locator.click',
          new Error(`locator.click: ${token}`),
        ),
      ).toMatchObject({ code: 'OPERATION_FAILED' });
  });
});
