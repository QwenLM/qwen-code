/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendShellHistoryFile } from './shell-history-file.js';

const lock = vi.hoisted(() => vi.fn());
vi.mock('proper-lockfile', () => ({
  default: { lock },
  lock,
}));

describe('shell history lock compromise', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-history-compromised-'),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects append promises and does not write after losing the lock', async () => {
    const compromise = Object.assign(new Error('lock lost'), {
      code: 'ECOMPROMISED',
    });
    const releaseError = Object.assign(new Error('already released'), {
      code: 'ERELEASED',
    });
    vi.mocked(lock).mockImplementationOnce(async (_file, options) => {
      queueMicrotask(() => {
        const onCompromise =
          options.onCompromised ??
          ((error: Error) => {
            throw error;
          });
        onCompromise(compromise);
      });
      return async () => {
        throw releaseError;
      };
    });
    const historyFile = path.join(tempDir, 'shell_history');
    await fs.writeFile(historyFile, JSON.stringify(['seed']));

    const append = appendShellHistoryFile(historyFile, 'must not persist');
    await expect(append).rejects.toBe(compromise);
    expect(JSON.parse(await fs.readFile(historyFile, 'utf8'))).toEqual([
      'seed',
    ]);
  });
});
