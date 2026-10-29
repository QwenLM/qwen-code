/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createWriteStream, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { ZipFile, type Entry } from 'yauzl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installWorkspaceSkill,
  MAX_SKILL_ARCHIVE_ENTRIES,
  MAX_SKILL_ARCHIVE_EXPANDED_BYTES,
  MAX_SKILL_ARCHIVE_MANIFEST_BYTES,
  WorkspaceSkillRecoveryError,
} from './workspace-skill-management.js';

const directories: string[] = [];
const manifest =
  '---\nname: example\ndescription: Example\n---\nInstructions.\n';
async function workspace() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'skill-archive-test-'),
  );
  directories.push(directory);
  return directory;
}
async function archive(
  files: Array<{ name: string; content?: string; bytes?: number }>,
) {
  const file = path.join(await workspace(), 'source.zip');
  const zip = archiver('zip', { zlib: { level: 1 } });
  const written = pipeline(zip, createWriteStream(file));
  for (const entry of files) {
    const content =
      entry.bytes === undefined
        ? (entry.content ?? '')
        : Readable.from(
            (function* () {
              let remaining = entry.bytes!;
              while (remaining > 0) {
                const size = Math.min(remaining, 65536);
                remaining -= size;
                yield Buffer.alloc(size);
              }
            })(),
          );
    zip.append(content, { name: entry.name });
  }
  await zip.finalize();
  await written;
  return file;
}
const request = (file: string) => ({
  name: 'example',
  scope: 'workspace' as const,
  source: { type: 'prepared-zip' as const, path: file },
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('file-backed Skill ZIP policy', () => {
  it('restores the old installation even if cleaning an unpublished candidate fails', async () => {
    const root = await workspace();
    const file = await archive([{ name: 'SKILL.md', content: manifest }]);
    const installed = await installWorkspaceSkill(root, request(file));
    const rename = fs.rename.bind(fs);
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.installing-'))
        throw new Error('publication failed');
      return rename(from, to);
    });
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target).includes('.installing-'))
        throw new Error('candidate cleanup failed');
      return remove(target, options);
    });
    await expect(installWorkspaceSkill(root, request(file))).rejects.toThrow(
      'publication failed',
    );
    expect(await fs.readFile(installed.installedPath!, 'utf8')).toBe(manifest);
    expect(
      (await fs.readdir(root, { recursive: true })).some((entry) =>
        entry.includes('.backup-'),
      ),
    ).toBe(false);
  });

  it('stops a live entry stream before cancelled extraction returns and removes staging', async () => {
    const file = await archive([
      { name: 'SKILL.md', content: manifest },
      { name: 'asset.bin', bytes: 70 * 1024 * 1024 },
    ]);
    const root = await workspace();
    const controller = new AbortController();
    const streams: Readable[] = [];
    let closed = false;
    const open = ZipFile.prototype.openReadStream;
    vi.spyOn(ZipFile.prototype, 'openReadStream').mockImplementation(function (
      this: ZipFile,
      entry: Entry,
      callback: (error: Error | null, stream: Readable) => void,
    ) {
      return open.call(this, entry, (error, stream) => {
        if (stream && entry.fileName === 'asset.bin') {
          streams.push(stream);
          stream.once('data', () =>
            controller.abort(new Error('stop extraction')),
          );
          stream.once('close', () => {
            closed = true;
          });
        }
        callback(error, stream);
      });
    } as typeof ZipFile.prototype.openReadStream);
    await expect(
      installWorkspaceSkill(root, request(file), undefined, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop extraction');
    expect(streams).toHaveLength(1);
    expect(streams[0].destroyed).toBe(true);
    expect(closed).toBe(true);
    expect(
      (await fs.readdir(root, { recursive: true })).some(
        (entry) => entry.includes('.installing-') || entry.endsWith('SKILL.md'),
      ),
    ).toBe(false);
    expect((await fs.stat(file)).isFile()).toBe(true);
  });

  it.each([
    ['asset.bin', 'asset.bin'],
    ['assets/', 'assets'],
    ['assets/child.bin', 'assets'],
  ])('rejects conflicting native paths %s and %s', async (first, second) => {
    const file = await archive([
      { name: 'SKILL.md', content: manifest },
      { name: first, content: first.endsWith('/') ? '' : 'first' },
      { name: second, content: 'second' },
    ]);
    await expect(
      installWorkspaceSkill(await workspace(), request(file)),
    ).rejects.toMatchObject({ code: 'invalid_skill_package' });
  });

  it('does not overwrite files through filesystem case aliases', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'CaseProbe'), 'probe');
    const aliases = await fs.access(path.join(root, 'caseprobe')).then(
      () => true,
      () => false,
    );
    const file = await archive([
      { name: 'SKILL.md', content: manifest },
      { name: 'Asset.bin', content: 'first' },
      { name: 'asset.bin', content: 'second' },
    ]);
    const operation = installWorkspaceSkill(root, request(file));
    if (aliases)
      await expect(operation).rejects.toMatchObject({
        code: 'invalid_skill_package',
      });
    else {
      const result = await operation;
      const directory = path.dirname(result.installedPath!);
      expect(await fs.readFile(path.join(directory, 'Asset.bin'), 'utf8')).toBe(
        'first',
      );
      expect(await fs.readFile(path.join(directory, 'asset.bin'), 'utf8')).toBe(
        'second',
      );
    }
  });

  it('installs resources above both legacy limits, including nested resource manifests', async () => {
    const file = await archive([
      { name: 'wrapper/SKILL.md', content: manifest },
      { name: 'wrapper/assets/large.bin', bytes: 70 * 1024 * 1024 },
      { name: 'wrapper/assets/nested/SKILL.md', bytes: 33 * 1024 * 1024 },
    ]);
    const root = await workspace();
    const result = await installWorkspaceSkill(root, request(file));
    const installed = path.dirname(result.installedPath!);
    expect((await fs.stat(path.join(installed, 'assets/large.bin'))).size).toBe(
      70 * 1024 * 1024,
    );
    expect(
      (await fs.stat(path.join(installed, 'assets/nested/SKILL.md'))).size,
    ).toBe(33 * 1024 * 1024);
    await expect(
      installWorkspaceSkill(await workspace(), {
        name: 'example',
        scope: 'workspace',
        source: {
          type: 'zip',
          contentBase64: (await fs.readFile(file)).toString('base64'),
        },
      }),
    ).rejects.toMatchObject({ code: 'skill_package_too_large' });
  });

  it.each([0, 1])(
    'enforces the actual 200 MiB expanded ceiling at offset %s',
    async (over) => {
      const file = await archive([
        { name: 'SKILL.md', content: manifest },
        {
          name: 'asset.bin',
          bytes:
            MAX_SKILL_ARCHIVE_EXPANDED_BYTES -
            Buffer.byteLength(manifest) +
            over,
        },
      ]);
      const install = installWorkspaceSkill(await workspace(), request(file));
      if (over)
        await expect(install).rejects.toMatchObject({
          code: 'skill_package_too_large',
          statusCode: 413,
        });
      else
        await expect(install).resolves.toMatchObject({ skillName: 'example' });
    },
  );

  it('checks the normalized root manifest size before reading it as text', async () => {
    const file = await archive([
      { name: 'wrapper/SKILL.md', bytes: MAX_SKILL_ARCHIVE_MANIFEST_BYTES + 1 },
    ]);
    const read = vi.spyOn(fs, 'readFile');
    await expect(
      installWorkspaceSkill(await workspace(), request(file)),
    ).rejects.toMatchObject({ code: 'skill_package_too_large' });
    expect(
      read.mock.calls.some(([file]) => String(file).endsWith('/SKILL.md')),
    ).toBe(false);
  });

  it('accepts an exactly 32 MiB root manifest', async () => {
    const file = await archive([
      {
        name: 'SKILL.md',
        content:
          manifest +
          'x'.repeat(
            MAX_SKILL_ARCHIVE_MANIFEST_BYTES - Buffer.byteLength(manifest),
          ),
      },
    ]);
    await expect(
      installWorkspaceSkill(await workspace(), request(file)),
    ).resolves.toMatchObject({ skillName: 'example' });
  });

  it.each(['directories', 'metadata'])(
    'counts %s before filtering and does not count implicit parents',
    async (kind) => {
      const entries = [
        { name: 'SKILL.md', content: manifest },
        { name: 'implicit/parents/resource.txt', content: 'resource' },
        ...Array.from({ length: MAX_SKILL_ARCHIVE_ENTRIES - 2 }, (_, i) => ({
          name:
            kind === 'directories'
              ? `directory-${i}/`
              : `__MACOSX/ignored-${i}`,
          content: '',
        })),
      ];
      await expect(
        installWorkspaceSkill(
          await workspace(),
          request(await archive(entries)),
        ),
      ).resolves.toMatchObject({ skillName: 'example' });
      entries.push({
        name: kind === 'directories' ? 'one-more/' : '__MACOSX/one-more',
        content: '',
      });
      await expect(
        installWorkspaceSkill(
          await workspace(),
          request(await archive(entries)),
        ),
      ).rejects.toMatchObject({ code: 'skill_too_many_files' });
    },
  );

  it('does not inflate ignored metadata or charge it to the expanded budget', async () => {
    const file = await archive([
      { name: 'SKILL.md', content: manifest },
      { name: '__MACOSX/ignored', bytes: MAX_SKILL_ARCHIVE_EXPANDED_BYTES + 1 },
    ]);
    const result = await installWorkspaceSkill(
      await workspace(),
      request(file),
    );
    await expect(
      fs.readdir(path.dirname(result.installedPath!)),
    ).resolves.toEqual(['SKILL.md']);
  });

  it('retains a failed rollback backup across a later installation', async () => {
    const root = await workspace();
    const file = await archive([{ name: 'SKILL.md', content: manifest }]);
    await installWorkspaceSkill(root, request(file));
    const rename = fs.rename.bind(fs);
    let published = false;
    const mocked = vi
      .spyOn(fs, 'rename')
      .mockImplementation(async (source, target) => {
        if (String(source).includes('.backup-'))
          throw new Error('restore failed');
        await rename(source, target);
        if (String(source).includes('.installing-')) published = true;
      });
    const committed = vi.fn();
    const error = await installWorkspaceSkill(
      root,
      request(file),
      undefined,
      () => {
        if (published)
          throw Object.assign(new Error('generation closed'), {
            name: 'WorkspaceGenerationClosedError',
          });
      },
      { onCommitted: committed },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(WorkspaceSkillRecoveryError);
    expect(committed).not.toHaveBeenCalled();
    if (!(error instanceof WorkspaceSkillRecoveryError)) throw error;
    const backup = error.retainedPaths.find((file) =>
      file.includes('.backup-'),
    )!;
    await expect(
      fs.readFile(path.join(backup, 'SKILL.md'), 'utf8'),
    ).resolves.toBe(manifest);
    mocked.mockRestore();
    await installWorkspaceSkill(root, request(file));
    await expect(
      fs.readFile(path.join(backup, 'SKILL.md'), 'utf8'),
    ).resolves.toBe(manifest);
  });

  it('finishes publication after admission and records commit before backup cleanup', async () => {
    const root = await workspace();
    const file = await archive([{ name: 'SKILL.md', content: manifest }]);
    await installWorkspaceSkill(root, request(file));
    const controller = new AbortController();
    const committed = vi.fn();
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]).includes('.backup-'))
        expect(committed).toHaveBeenCalledOnce();
      return rm(...args);
    });
    await expect(
      installWorkspaceSkill(root, request(file), undefined, undefined, {
        signal: controller.signal,
        beforePublish: () => controller.abort(),
        onCommitted: committed,
      }),
    ).resolves.toMatchObject({ skillName: 'example' });
    expect(committed).toHaveBeenCalledOnce();
  });
});
