/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs, truncateSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireSkillArchive } from './skill-archive-input.js';
import { MAX_SKILL_ARCHIVE_BYTES } from './workspace-skill-management.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'skill-input-test-'),
  );
  directories.push(directory);
  const file = path.join(directory, 'source.zip');
  await fs.writeFile(file, 'original');
  return file;
}

describe('owned Skill archives', () => {
  it('keeps a verified independent copy after the borrowed path is replaced', async () => {
    const file = await fixture();
    const expected = createHash('sha256').update('original').digest('hex');
    const owned = await acquireSkillArchive(
      { type: 'zip-file', path: file, sha256: expected.toUpperCase() },
      new AbortController().signal,
    );
    await fs.unlink(file);
    await fs.writeFile(file, 'replacement');
    expect(owned.sha256).toBe(expected);
    await expect(fs.readFile(owned.path, 'utf8')).resolves.toBe('original');
    await owned.dispose();
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('replacement');
    await expect(fs.access(owned.path)).rejects.toThrow();
  });

  it('rejects a digest mismatch without changing the input', async () => {
    const file = await fixture();
    await expect(
      acquireSkillArchive(
        { type: 'zip-file', path: file, sha256: '0'.repeat(64) },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'skill_archive_digest_mismatch' });
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('original');
  });

  it('rejects a symbolic link and a directory', async () => {
    const file = await fixture();
    const link = `${file}.link`;
    await fs.symlink(file, link);
    for (const input of [link, path.dirname(file)]) {
      await expect(
        acquireSkillArchive(
          { type: 'zip-file', path: input },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'invalid_skill_source' });
    }
  });

  it.each(['truncated', 'modified'])(
    'rejects a source %s during copying and closes its handle',
    async (change) => {
      const file = await fixture();
      const open = fs.open.bind(fs);
      const handles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        handles.push(handle);
        const stream = handle.createReadStream.bind(handle);
        vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
          const result = stream(options);
          result.once('data', () => {
            if (change === 'truncated') truncateSync(file, 0);
            else writeFileSync(file, 'modified');
          });
          return result;
        });
        return handle;
      });
      await expect(
        acquireSkillArchive(
          { type: 'zip-file', path: file },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'skill_archive_changed' });
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    },
  );

  it('accepts exactly the raw limit and rejects one more actual byte', async () => {
    function bytes(size: number) {
      return Readable.from(
        (function* () {
          let remaining = size;
          while (remaining > 0) {
            const length = Math.min(remaining, 65536);
            remaining -= length;
            yield Buffer.alloc(length);
          }
        })(),
      );
    }
    const accepted = await acquireSkillArchive(
      bytes(MAX_SKILL_ARCHIVE_BYTES),
      new AbortController().signal,
    );
    expect((await fs.stat(accepted.path)).size).toBe(MAX_SKILL_ARCHIVE_BYTES);
    await accepted.dispose();
    await expect(
      acquireSkillArchive(
        bytes(MAX_SKILL_ARCHIVE_BYTES + 1),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'skill_archive_too_large',
      statusCode: 413,
    });
  });

  it('stops a live receive on cancellation', async () => {
    const controller = new AbortController();
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(1024));
        controller.abort();
      },
    });
    await expect(
      acquireSkillArchive(source, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    source.destroy();
  });
});
