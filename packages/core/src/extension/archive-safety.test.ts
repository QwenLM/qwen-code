/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertTarArchiveHasNoLinks } from './archive-safety.js';

describe('assertTarArchiveHasNoLinks', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-tar-safety-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a large link set without throwing outside the promise',
    async () => {
      const links = Array.from({ length: 101 }, (_, index) => `link-${index}`);
      await Promise.all(
        links.map(async (link) => {
          await fs.symlink('missing-target', path.join(root, link));
        }),
      );
      const archive = path.join(root, 'links.tar');
      await tar.c({ cwd: root, file: archive }, links);

      await expect(assertTarArchiveHasNoLinks(archive)).rejects.toThrow(
        'more than 100 unsupported link entries',
      );
    },
  );
});
