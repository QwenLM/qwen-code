/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ReportStore } from './report-store.js';

const mutation = vi.hoisted(() => ({ path: '', append: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] === mutation.path) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
          const before = await stat();
          // Schedule a real writer after the descriptor's initial metadata read.
          if (mutation.append) await actual.appendFile(mutation.path, ' ');
          else {
            const bytes = await actual.readFile(mutation.path);
            bytes[0] = 0x20;
            await actual.writeFile(mutation.path, bytes);
          }
          return before;
        });
      }
      return handle;
    },
  };
});

it.each([true, false])(
  'refuses source changes during reading (growth=%s) without publishing',
  async (growth) => {
    const root = await mkdtemp(join(tmpdir(), 'qwen-report-race-'));
    try {
      const path = join(root, 'report.json');
      await writeFile(
        path,
        await readFile(new URL('../test-fixtures/mixed.json', import.meta.url)),
      );
      mutation.path = await realpath(path);
      mutation.append = growth;
      const store = await ReportStore.create(root);
      await expect(store.importReport('report.json')).rejects.toMatchObject({
        code: 'INVALID_REPORT',
      });
      expect(await readdir(root)).toEqual(['report.json']);
      if (growth) expect((await readFile(path)).at(-1)).toBe(0x20);
    } finally {
      mutation.path = '';
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
);
