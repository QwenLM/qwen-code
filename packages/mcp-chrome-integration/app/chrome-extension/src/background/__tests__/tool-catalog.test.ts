/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_TOOL_NAMES, normalizeToolName } from '../tool-catalog';

function extractToolNamesFromNativeServer() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const toolsPath = path.resolve(
    currentDir,
    '../../../../native-server/src/shared/tools.ts',
  );
  const content = fs.readFileSync(toolsPath, 'utf8');
  const start = content.indexOf('export const TOOL_NAMES');
  if (start === -1) {
    throw new Error('TOOL_NAMES not found in native-server tools.ts');
  }
  const end = content.indexOf('};', start);
  if (end === -1) {
    throw new Error('TOOL_NAMES block end not found');
  }
  const block = content.slice(start, end);
  const matches = [...block.matchAll(/: '([^']+)'/g)].map((m) => m[1]);
  return new Set(matches);
}

test('KNOWN_TOOL_NAMES covers all native-server TOOL_NAMES', () => {
  const extracted = extractToolNamesFromNativeServer();
  const known = new Set(KNOWN_TOOL_NAMES);

  for (const name of extracted) {
    assert.equal(
      known.has(name),
      true,
      `Missing tool name mapping for: ${name}`,
    );
  }
});

test('normalizeToolName maps legacy aliases', () => {
  assert.equal(
    normalizeToolName('browser_capture_screenshot'),
    'chrome_screenshot',
  );
  assert.equal(normalizeToolName('browser_read_page'), 'chrome_read_page');
  assert.equal(normalizeToolName('browser_click'), 'chrome_click_element');
  assert.equal(normalizeToolName('chrome_get_tabs'), 'get_windows_and_tabs');
});
