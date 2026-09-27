/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  normalizeQwenCustomIgnoreFileNames,
  QwenIgnoreParser,
} from './qwenIgnoreParser.js';

it('keeps relative ignore files and rejects names outside the configured root', () => {
  expect(
    normalizeQwenCustomIgnoreFileNames([
      ' .cursorignore ',
      '.cursorignore',
      'nested\\.ignore',
      '.qwenignore',
      '',
      '/absolute',
      '../escape',
      'nested/../escape',
      'bad\0file',
    ]),
  ).toEqual(['.cursorignore', 'nested/.ignore']);
});

it('preserves leading pattern whitespace in qwenignore files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwenignore-space-'));
  try {
    await fs.writeFile(path.join(root, '.qwenignore'), ' leading.txt\n');
    const parser = new QwenIgnoreParser(root);
    expect(parser.isIgnored(' leading.txt')).toBe(true);
    expect(parser.isIgnored('leading.txt')).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
