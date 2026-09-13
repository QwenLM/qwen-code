/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import {
  persistAndTruncateToolResult,
  truncateToolOutput,
} from './truncation.js';

vi.mock('../utils/atomicFileWrite.js');
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
vi.mock('../telemetry/loggers.js', () => ({ logToolOutputTruncated: vi.fn() }));

describe.skipIf(process.platform === 'win32')(
  'shared output persistence',
  () => {
    beforeEach(async () => {
      vi.resetAllMocks();
      const actual = await vi.importActual<typeof fs>('node:fs/promises');
      vi.mocked(fs.writeFile).mockImplementation(actual.writeFile);
    });
    afterEach(() => vi.restoreAllMocks());

    it.each(['primary', 'fallback', 'direct'] as const)(
      'does not alter another file when a shared %s entry is replaced',
      async (route) => {
        const root = await fs.mkdtemp(join(tmpdir(), 'qwen-output-entry-'));
        const outputDirectory = join(root, 'output');
        const marker = join(root, 'marker');
        await fs.mkdir(outputDirectory);
        await fs.writeFile(marker, 'unchanged');
        await fs.chmod(marker, 0o640);
        const realFs = await vi.importActual<typeof fs>('node:fs/promises');
        const actual = await vi.importActual<
          typeof import('../utils/atomicFileWrite.js')
        >('../utils/atomicFileWrite.js');
        vi.mocked(atomicWriteFile).mockImplementation(
          (file, content, options) =>
            actual.atomicWriteFile(file, content, options, {
              writeFile: async (temporaryFile, data, writeOptions) => {
                await realFs.writeFile(temporaryFile, data, writeOptions);
                await realFs.unlink(String(temporaryFile));
                await realFs.symlink(marker, String(temporaryFile));
              },
            }),
        );
        if (route === 'fallback') {
          await fs.symlink(marker, join(outputDirectory, 'call.txt'));
          vi.mocked(atomicWriteFile).mockRejectedValueOnce(
            new Error('primary'),
          );
        }
        if (route !== 'primary') {
          vi.mocked(fs.writeFile).mockImplementation(
            async (file, data, options) => {
              if (String(file).endsWith('.output')) {
                await realFs.symlink(marker, String(file));
              }
              await realFs.writeFile(file, data, options);
            },
          );
        }
        const trackToolResultBytes = vi.fn();
        const config = {
          getExecutionEnvironment: () => ({ outputDirectory }),
          getToolResultBytesWritten: () => 0,
          trackToolResultBytes,
          getTruncateToolOutputThreshold: () => 100,
          getTruncateToolOutputLines: () => 100,
        } as unknown as Config;
        try {
          const content = 'x'.repeat(10_000);
          const result =
            route === 'direct'
              ? await truncateToolOutput(config, 'glob', content)
              : await persistAndTruncateToolResult(
                  'call',
                  'glob',
                  content,
                  config,
                );
          expect(await fs.readFile(marker, 'utf8')).toBe('unchanged');
          expect((await fs.stat(marker)).mode & 0o777).toBe(0o640);
          if (route === 'primary') {
            expect(await fs.readFile(result.outputFile!, 'utf8')).toBe(content);
          } else {
            expect(result.outputFile).toBeUndefined();
            expect(result.content).toContain('Could not save full output');
            if (route === 'fallback') {
              expect(trackToolResultBytes.mock.calls).toEqual([
                [10_000],
                [-10_000],
              ]);
            }
          }
        } finally {
          vi.restoreAllMocks();
          await fs.rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);
