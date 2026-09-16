/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getClipboardPasteDirectory } from './clipboard-paste-directory.js';
import { cleanupOldClipboardImages } from './clipboardUtils.js';
import {
  readLocalBootId,
  readPidNamespaceId,
  readProcStartToken,
} from '@qwen-code/qwen-code-core/utils/process-liveness.js';
import { runExitCleanup } from '../../utils/cleanup.js';

vi.mock('@qwen-code/qwen-code-core/utils/process-liveness.js', () => ({
  readLocalBootId: vi.fn(),
  readPidNamespaceId: vi.fn(),
  readProcStartToken: vi.fn(),
}));

describe('clipboard paste ownership', () => {
  let root: string;
  beforeEach(async () => {
    vi.mocked(readLocalBootId).mockReturnValue('aaaa-bbbb');
    vi.mocked(readPidNamespaceId).mockReturnValue(42);
    vi.mocked(readProcStartToken).mockReturnValue('aaaa-bbbb:100');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'clipboard-ownership-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await runExitCleanup();
    await fs.rm(root, { recursive: true, force: true });
  });
  it.each([[101], [60, 60]])(
    'keeps accepted files through shared cleanup: %j',
    async (...counts: number[]) => {
      const directory = await getClipboardPasteDirectory(root);
      const paths: string[] = [];
      for (const count of counts) {
        for (let i = 0; i < count; i++) {
          const file = path.join(directory, `clipboard-${paths.length}.png`);
          await fs.writeFile(file, 'image fixture');
          paths.push(file);
        }
        await cleanupOldClipboardImages(root);
        for (const file of paths)
          expect(await fs.readFile(file, 'utf8')).toBe('image fixture');
      }
      await runExitCleanup();
      await expect(fs.stat(directory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
  it('shares initialization for simultaneous pastes and isolates different runtimes', async () => {
    const [one, two, other] = await Promise.all([
      getClipboardPasteDirectory(root),
      getClipboardPasteDirectory(root),
      getClipboardPasteDirectory(path.join(root, 'other')),
    ]);
    expect(one).toBe(two);
    expect(other).not.toBe(one);
  });
  it('records its process identity for later cleanup', async () => {
    const directory = await getClipboardPasteDirectory(root);
    expect(
      JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')),
    ).toEqual({ pidNs: 42, procStart: 'aaaa-bbbb:100' });
  });

  it.each([
    [
      'exited local owner',
      { pidNs: 42, procStart: 'aaaa-bbbb:100' },
      'ESRCH',
      null,
      true,
    ],
    [
      'reused local PID',
      { pidNs: 42, procStart: 'aaaa-bbbb:100' },
      null,
      'aaaa-bbbb:200',
      true,
    ],
    [
      'live local owner',
      { pidNs: 42, procStart: 'aaaa-bbbb:100' },
      null,
      'aaaa-bbbb:100',
      false,
    ],
    [
      'unreadable start token',
      { pidNs: 42, procStart: 'aaaa-bbbb:100' },
      null,
      null,
      false,
    ],
    [
      'permission denied',
      { pidNs: 42, procStart: 'aaaa-bbbb:100' },
      'EPERM',
      null,
      false,
    ],
    [
      'access denied',
      { pidNs: 42, procStart: 'aaaa-bbbb:100' },
      'EACCES',
      null,
      false,
    ],
    [
      'unknown signal error',
      { pidNs: 42, procStart: 'aaaa-bbbb:100' },
      'EIO',
      null,
      false,
    ],
    [
      'foreign namespace',
      { pidNs: 99, procStart: 'aaaa-bbbb:100' },
      'ESRCH',
      null,
      false,
    ],
    [
      'foreign boot',
      { pidNs: 42, procStart: 'cccc-dddd:100' },
      'ESRCH',
      null,
      false,
    ],
    [
      'unknown namespace',
      { pidNs: null, procStart: 'aaaa-bbbb:100' },
      'ESRCH',
      null,
      false,
    ],
    [
      'unknown start token',
      { pidNs: 42, procStart: null },
      'ESRCH',
      null,
      false,
    ],
    [
      'invalid start token',
      { pidNs: 42, procStart: 'aaaa-bbbb:bad' },
      'ESRCH',
      null,
      false,
    ],
    ['unknown schema', {}, 'ESRCH', null, false],
    ['legacy owner', undefined, 'ESRCH', null, false],
    ['malformed marker', 'invalid json', 'ESRCH', null, false],
  ] as const)(
    'handles %s conservatively',
    async (_label, identity, error, currentStart, reaped) => {
      const directory = path.join(root, 'clipboard', 'paste-11111-abcdef');
      await fs.mkdir(directory, { recursive: true });
      const image = path.join(directory, 'clipboard-image.png');
      await fs.writeFile(image, 'pending image');
      if (identity !== undefined)
        await fs.writeFile(
          path.join(directory, 'owner.json'),
          typeof identity === 'string' ? identity : JSON.stringify(identity),
        );
      vi.mocked(readProcStartToken).mockReturnValue(currentStart);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        if (error) throw Object.assign(new Error(error), { code: error });
        return true;
      });
      await getClipboardPasteDirectory(root);
      if (reaped) {
        await expect(fs.stat(directory)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        expect(await fs.readFile(image, 'utf8')).toBe('pending image');
      }
      if (
        typeof identity !== 'object' ||
        identity === null ||
        !('pidNs' in identity) ||
        identity.pidNs !== 42 ||
        !('procStart' in identity) ||
        identity.procStart !== 'aaaa-bbbb:100'
      ) {
        expect(kill).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['namespace', 'boot'] as const)(
    'preserves other owners when our %s is unknown',
    async (unknown) => {
      const directory = path.join(root, 'clipboard', 'paste-11111-abcdef');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, 'owner.json'),
        JSON.stringify({ pidNs: 42, procStart: 'aaaa-bbbb:100' }),
      );
      if (unknown === 'namespace')
        vi.mocked(readPidNamespaceId).mockReturnValue(null);
      else vi.mocked(readLocalBootId).mockReturnValue(null);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('invisible'), { code: 'ESRCH' });
      });
      await getClipboardPasteDirectory(root);
      expect((await fs.stat(directory)).isDirectory()).toBe(true);
      expect(kill).not.toHaveBeenCalled();
    },
  );
});
