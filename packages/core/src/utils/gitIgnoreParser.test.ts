/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { GitIgnoreParser } from './gitIgnoreParser.js';

it('honours escaped and leading spaces in gitignore patterns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitignore-space-'));
  try {
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(
      path.join(root, '.gitignore'),
      'foo\\ bar.txt\n leading.txt\n',
    );
    const parser = new GitIgnoreParser(root);
    expect(parser.isIgnored('foo bar.txt')).toBe(true);
    expect(parser.isIgnored('fooXbar.txt')).toBe(false);
    expect(parser.isIgnored(' leading.txt')).toBe(true);
    expect(parser.isIgnored('leading.txt')).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
