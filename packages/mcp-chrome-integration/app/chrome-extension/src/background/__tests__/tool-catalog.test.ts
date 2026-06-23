/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeToolName } from '../tool-catalog';

test('normalizeToolName maps legacy aliases', () => {
  assert.equal(
    normalizeToolName('browser_capture_screenshot'),
    'chrome_screenshot',
  );
  assert.equal(normalizeToolName('browser_read_page'), 'chrome_read_page');
  assert.equal(normalizeToolName('browser_click'), 'chrome_click_element');
  assert.equal(normalizeToolName('chrome_get_tabs'), 'get_windows_and_tabs');
});
