/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadSkill,
  extractFilesFromTarGz,
  fetchAllowedGitHub,
} from './skill-source-download.js';

function tarEntry(name: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  const size = Buffer.byteLength(content);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write('0', 156, 'utf8');
  const data = Buffer.alloc(Math.ceil(size / 512) * 512);
  data.write(content, 0, 'utf8');
  return Buffer.concat([header, data]);
}

function makeTarGz(name: string, content: string): Uint8Array {
  const tar = Buffer.concat([tarEntry(name, content), Buffer.alloc(1024)]);
  return new Uint8Array(gzipSync(tar));
}

function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractFilesFromTarGz', () => {
  it('extracts files under the requested directory', async () => {
    const archive = makeTarGz('repo-main/skills/SKILL.md', 'hello skill');
    const files = await extractFilesFromTarGz(archive, 'skills');

    expect(files).toHaveLength(1);
    expect(files[0]!.relativePath).toBe('SKILL.md');
    expect(Buffer.from(files[0]!.content).toString('utf8')).toBe('hello skill');
  });

  it('rejects an archive whose compressed size exceeds the limit', async () => {
    await expect(
      extractFilesFromTarGz(new Uint8Array(64), 'skills', {
        maxCompressedBytes: 16,
      }),
    ).rejects.toThrowError(/exceeds the maximum allowed size/);
  });

  it('rejects an archive that fails to decompress', async () => {
    await expect(
      extractFilesFromTarGz(new Uint8Array([1, 2, 3, 4, 5]), 'skills'),
    ).rejects.toThrowError(/Failed to decompress skill archive/);
  });

  it('rejects an archive whose decompressed size exceeds the limit', async () => {
    const archive = makeTarGz('repo-main/skills/SKILL.md', 'x'.repeat(2048));
    await expect(
      extractFilesFromTarGz(archive, 'skills', {
        maxDecompressedBytes: 16,
      }),
    ).rejects.toThrowError(/Decompressed skill archive exceeds/);
  });
});

describe('fetchAllowedGitHub', () => {
  function fakeResponse(status: number, location?: string) {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: (key: string) =>
          key.toLowerCase() === 'location' && location ? location : null,
      },
    };
  }

  it('returns the response directly when there is no redirect', async () => {
    const response = fakeResponse(200);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(
      fetchAllowedGitHub('https://raw.githubusercontent.com/a/b/main/SKILL.md'),
    ).resolves.toBe(response);
  });

  it('follows a redirect to an allowed GitHub CDN host', async () => {
    const final = fakeResponse(200);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse(302, 'https://objects.githubusercontent.com/x'),
      )
      .mockResolvedValueOnce(final);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchAllowedGitHub('https://codeload.github.com/a/b/tar.gz/main'),
    ).resolves.toBe(final);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['https://evil.com/x', 'http://raw.githubusercontent.com/x'])(
    'rejects a redirect to %s',
    async (location) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(fakeResponse(302, location)),
      );

      await expect(
        fetchAllowedGitHub('https://raw.githubusercontent.com/a/b/SKILL.md'),
      ).rejects.toThrow(/disallowed host/);
    },
  );

  it('rejects when the redirect limit is exceeded', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          fakeResponse(302, 'https://raw.githubusercontent.com/loop'),
        ),
    );

    await expect(
      fetchAllowedGitHub('https://raw.githubusercontent.com/a', {}, 2),
    ).rejects.toThrow(/maximum number of redirects/);
  });

  it('resolves a relative Location against the current URL', async () => {
    const final = fakeResponse(200);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(302, '/a/b/SKILL.md'))
      .mockResolvedValueOnce(final);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchAllowedGitHub('https://raw.githubusercontent.com/start'),
    ).resolves.toBe(final);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'https://raw.githubusercontent.com/a/b/SKILL.md',
    );
  });
});

describe('downloadSkill', () => {
  it.each([
    'http://github.com/owner/repo/blob/main/skills/x/SKILL.md',
    'https://evil.com/owner/repo/blob/main/skills/x/SKILL.md',
    'https://github.com.attacker.com/owner/repo/blob/main/SKILL.md',
  ])('rejects the unsupported source %s', async (sourceUrl) => {
    await expect(downloadSkill(sourceUrl)).rejects.toThrow();
  });

  it('downloads every file from a GitHub skill directory', async () => {
    const skillContent =
      '---\nname: pptx\ndescription: Create slide decks\n---\nCreate slide decks\n';
    const editingContent = '# Editing guide\n';
    const directoryUrl =
      'https://api.github.com/repos/anthropics/skills/contents/skills/pptx?ref=main';
    const skillUrl =
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/pptx/SKILL.md';
    const editingUrl =
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/pptx/editing.md';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === directoryUrl) {
        return {
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue([
            {
              name: 'SKILL.md',
              path: 'skills/pptx/SKILL.md',
              type: 'file',
              download_url: skillUrl,
            },
            {
              name: 'editing.md',
              path: 'skills/pptx/editing.md',
              type: 'file',
              download_url: editingUrl,
            },
          ]),
        };
      }
      const content = url === skillUrl ? skillContent : editingContent;
      return {
        ok: true,
        status: 200,
        arrayBuffer: vi
          .fn()
          .mockResolvedValue(toArrayBuffer(Buffer.from(content))),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const skill = await downloadSkill(
      'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
    );

    expect(skill.skillContent).toBe(skillContent);
    expect(skill.files.map((file) => file.relativePath)).toEqual([
      'SKILL.md',
      'editing.md',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      directoryUrl,
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          'User-Agent': 'qwen-code',
        }),
      }),
    );
  });
});
