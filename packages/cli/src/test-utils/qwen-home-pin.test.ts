/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { clearQwenHomePin } from './qwen-home-pin.js';

describe('clearQwenHomePin', () => {
  const original = process.env['QWEN_HOME'];

  afterEach(() => {
    if (original === undefined) {
      delete process.env['QWEN_HOME'];
      return;
    }
    process.env['QWEN_HOME'] = original;
  });

  it('restores the exact value it cleared', () => {
    process.env['QWEN_HOME'] = '/tmp/qwen-pin-test-home';

    const restore = clearQwenHomePin();
    expect(process.env['QWEN_HOME']).toBeUndefined();

    restore();
    expect(process.env['QWEN_HOME']).toBe('/tmp/qwen-pin-test-home');
  });

  it('leaves the variable absent when it was absent', () => {
    delete process.env['QWEN_HOME'];

    const restore = clearQwenHomePin();
    expect(process.env['QWEN_HOME']).toBeUndefined();

    restore();
    expect('QWEN_HOME' in process.env).toBe(false);
  });

  it('can be restored twice without changing the outcome', () => {
    process.env['QWEN_HOME'] = '/tmp/qwen-pin-test-home';

    const restore = clearQwenHomePin();
    restore();
    restore();

    expect(process.env['QWEN_HOME']).toBe('/tmp/qwen-pin-test-home');
  });
});
