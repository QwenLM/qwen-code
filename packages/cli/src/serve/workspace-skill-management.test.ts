import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import archiver from 'archiver';
import { Storage } from '@qwen-code/qwen-code-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteWorkspaceSkill,
  installWorkspaceSkill,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PACKAGE_BYTES,
  MAX_ZIP_ARCHIVE_BYTES,
} from './workspace-skill-management.js';

const temporaryDirectories: string[] = [];

function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: Test skill\n---\n\nInstructions.\n`;
}

async function zip(files: Record<string, string>): Promise<string> {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  const archive = archiver('zip');
  archive.pipe(output);
  for (const [name, content] of Object.entries(files)) {
    archive.append(content, { name });
  }
  const complete = new Promise<void>((resolve, reject) => {
    output.on('end', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  await archive.finalize();
  await complete;
  return Buffer.concat(chunks).toString('base64');
}

function zeroStream(bytes: number): Readable {
  let remaining = bytes;
  return new Readable({
    read() {
      if (remaining === 0) {
        this.push(null);
        return;
      }
      const size = Math.min(remaining, 64 * 1024);
      remaining -= size;
      this.push(Buffer.alloc(size));
    },
  });
}

async function zipSized(
  files: Array<{ name: string; content?: string; bytes?: number }>,
): Promise<string> {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(output);
  for (const file of files) {
    archive.append(
      file.bytes === undefined ? (file.content ?? '') : zeroStream(file.bytes),
      { name: file.name },
    );
  }
  const complete = new Promise<void>((resolve, reject) => {
    output.on('end', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  await archive.finalize();
  await complete;
  return Buffer.concat(chunks).toString('base64');
}

async function createSparseFile(filePath: string, size: number): Promise<void> {
  const handle = await fs.open(filePath, 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

function githubSkillListing(): Response {
  return new Response(
    JSON.stringify([
      {
        name: 'SKILL.md',
        path: 'SKILL.md',
        type: 'file',
        download_url:
          'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
      },
    ]),
    { status: 200 },
  );
}

async function expectNoPartialInstall(
  workspace: string,
  skillName: string,
): Promise<void> {
  const qwen = path.join(workspace, '.qwen');
  const entries = await fs
    .readdir(qwen)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  expect(
    entries.filter(
      (entry) => entry.includes('.installing-') || entry.includes('.backup-'),
    ),
  ).toEqual([]);
  await expect(
    fs.access(path.join(qwen, 'skills', skillName)),
  ).rejects.toThrow();
}

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('workspace Skill management', () => {
  it('installs folder files into the workspace and deletes them', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    await fs.mkdir(path.join(source, 'references'));
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('demo-skill'),
    );
    await fs.writeFile(
      path.join(source, 'references', 'example.md'),
      'example',
    );

    const result = await installWorkspaceSkill(workspace, {
      name: 'demo-skill',
      scope: 'workspace',
      source: { type: 'folder', path: source },
    });

    expect(result.installedPath).toBe(
      path.join(workspace, '.qwen', 'skills', 'demo-skill', 'SKILL.md'),
    );
    expect(
      await fs.readFile(
        path.join(
          workspace,
          '.qwen',
          'skills',
          'demo-skill',
          'references',
          'example.md',
        ),
        'utf8',
      ),
    ).toBe('example');

    await deleteWorkspaceSkill(
      workspace,
      'workspace',
      'demo-skill',
      result.installedPath!,
    );
    await expect(
      fs.access(path.dirname(result.installedPath!)),
    ).rejects.toThrow();
  });

  it('does not copy its own staging directory into a folder package', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    await fs.writeFile(path.join(workspace, 'SKILL.md'), skillMarkdown('self'));
    await fs.writeFile(path.join(workspace, 'A0.txt'), 'must survive');

    // Force the source walk to descend into .qwen after the two root files
    // are staged, which is the order that exposes the self-copy.
    const nativeReaddir = fs.readdir.bind(fs);
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(((
      ...args: Parameters<typeof fs.readdir>
    ) =>
      Promise.resolve(nativeReaddir(...args)).then((entries) => {
        if (String(args[0]) !== workspace || !Array.isArray(entries)) {
          return entries;
        }
        const nameOf = (entry: unknown) =>
          typeof entry === 'string' ? entry : (entry as { name: string }).name;
        return [...entries].sort((left, right) => {
          if (nameOf(left) === '.qwen') return 1;
          if (nameOf(right) === '.qwen') return -1;
          return 0;
        });
      })) as typeof fs.readdir);

    try {
      await installWorkspaceSkill(workspace, {
        name: 'self',
        scope: 'workspace',
        source: { type: 'folder', path: workspace },
      });
    } finally {
      readdirSpy.mockRestore();
    }

    const entries = (
      await fs.readdir(path.join(workspace, '.qwen', 'skills', 'self'), {
        recursive: true,
      })
    ).map(String);
    expect(entries.filter((entry) => entry.includes('.installing-'))).toEqual(
      [],
    );
    expect(entries.some((entry) => entry.startsWith('.qwen'))).toBe(false);
    expect(entries.sort()).toEqual(['A0.txt', 'SKILL.md']);
  });

  it('does not create Skill directories after the generation closes', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('demo-skill'),
    );
    let checks = 0;

    await expect(
      installWorkspaceSkill(
        workspace,
        {
          name: 'demo-skill',
          scope: 'workspace',
          source: { type: 'folder', path: source },
        },
        undefined,
        () => {
          checks += 1;
          if (checks === 3) throw new Error('generation closed');
        },
      ),
    ).rejects.toThrow('generation closed');

    await expect(fs.access(path.join(workspace, '.qwen'))).rejects.toThrow();
  });

  it('installs a ZIP into the global Skill directory', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const globalDirectory = await temporaryDirectory('qwen-skill-global-');
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(globalDirectory);

    const result = await installWorkspaceSkill(workspace, {
      name: 'zip-skill',
      scope: 'global',
      source: {
        type: 'zip',
        contentBase64: await zip({
          'zip-skill/SKILL.md': skillMarkdown('zip-skill'),
          'zip-skill/assets/data.txt': 'data',
          '__MACOSX/zip-skill/._SKILL.md': 'finder metadata',
          'zip-skill/.DS_Store': 'finder metadata',
        }),
      },
    });

    expect(result.installedPath).toBe(
      path.join(globalDirectory, 'skills', 'zip-skill', 'SKILL.md'),
    );
    await expect(fs.readFile(result.installedPath!, 'utf8')).resolves.toContain(
      'name: zip-skill',
    );
  });

  it('installs a Skill from a GitHub SKILL.md URL', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              {
                name: 'SKILL.md',
                path: 'SKILL.md',
                type: 'file',
                download_url:
                  'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
              },
            ]),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(skillMarkdown('github-skill'), { status: 200 }),
        ),
    );

    const result = await installWorkspaceSkill(
      workspace,
      {
        name: 'github-skill',
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/main/SKILL.md',
        },
      },
      'github-token',
    );

    await expect(fs.readFile(result.installedPath!, 'utf8')).resolves.toContain(
      'name: github-skill',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/owner/repo/contents?ref=main',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer github-token',
        }),
      }),
    );
  });

  it('explains when a GitHub Skill path does not exist', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'missing-skill',
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/main/missing/SKILL.md',
        },
      }),
    ).rejects.toMatchObject({
      code: 'github_api_failed',
      message: expect.stringContaining('repository URL, branch, and path'),
      statusCode: 404,
    });
  });

  it('explains when GitHub denies access to a Skill file', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              {
                name: 'SKILL.md',
                path: 'SKILL.md',
                type: 'file',
                download_url:
                  'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
              },
            ]),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 403 })),
    );

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'private-skill',
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/main/SKILL.md',
        },
      }),
    ).rejects.toMatchObject({
      code: 'github_skill_download_failed',
      message: expect.stringContaining('private or API rate-limited'),
      statusCode: 502,
    });
  });

  it.each([
    [401, 'authentication failed'],
    [429, 'rate limit exceeded'],
  ])(
    'explains GitHub Skill file HTTP %i failures',
    async (status, expectedMessage) => {
      const workspace = await temporaryDirectory('qwen-skill-workspace-');
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify([
                {
                  name: 'SKILL.md',
                  path: 'SKILL.md',
                  type: 'file',
                  download_url:
                    'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
                },
              ]),
              { status: 200 },
            ),
          )
          .mockResolvedValueOnce(new Response(null, { status })),
      );

      await expect(
        installWorkspaceSkill(workspace, {
          name: 'unavailable-skill',
          scope: 'workspace',
          source: {
            type: 'github',
            url: 'https://github.com/owner/repo/blob/main/SKILL.md',
          },
        }),
      ).rejects.toMatchObject({
        code: 'github_skill_download_failed',
        message: expect.stringContaining(expectedMessage),
        statusCode: 502,
      });
    },
  );

  it('rejects an oversized Skill name before reading its source', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(path.join(source, 'SKILL.md'), skillMarkdown('demo'));

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'x'.repeat(257),
        scope: 'workspace',
        source: { type: 'folder', path: source },
      }),
    ).rejects.toMatchObject({ code: 'invalid_skill_name' });
  });

  it('rejects install-artifact-shaped Skill names before reading their source', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = path.join(workspace, 'missing-source');

    // Names shaped exactly like reinstall artifacts are skipped by the
    // skill loaders, so creating one must fail loudly instead of reporting
    // success for a skill that would never load.
    for (const name of [
      'foo.backup-1-2',
      'foo.installing-12345-67890',
      'foo.backup-1-2-extra',
      '.probe.installing-123456',
      'release.installing-notes',
    ]) {
      await expect(
        installWorkspaceSkill(workspace, {
          name,
          scope: 'workspace',
          source: { type: 'folder', path: source },
        }),
      ).rejects.toMatchObject({
        code: 'invalid_skill_name',
        message: expect.stringContaining('reserved install-artifact suffix'),
      });
    }
  });

  it('accepts non-artifact Skill names near the reserved install suffix', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');

    for (const name of [
      'foo-backup-1-2',
      'foo.backup.notes',
      'foo.backup-1_2',
    ]) {
      await fs.writeFile(path.join(source, 'SKILL.md'), skillMarkdown(name));

      await expect(
        installWorkspaceSkill(workspace, {
          name,
          scope: 'workspace',
          source: { type: 'folder', path: source },
        }),
      ).resolves.toMatchObject({ skillName: name });
    }
  });

  it('keeps the base Skill install whole after rejecting an artifact-shaped name', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const artifact = await temporaryDirectory('qwen-skill-source-');
    const source = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(artifact, 'SKILL.md'),
      skillMarkdown('.probe.installing-123456'),
    );
    await fs.writeFile(path.join(source, 'SKILL.md'), skillMarkdown('probe'));

    await expect(
      installWorkspaceSkill(workspace, {
        name: '.probe.installing-123456',
        scope: 'workspace',
        source: { type: 'folder', path: artifact },
      }),
    ).rejects.toMatchObject({ code: 'invalid_skill_name' });

    const installed = await installWorkspaceSkill(workspace, {
      name: 'probe',
      scope: 'workspace',
      source: { type: 'folder', path: source },
    });
    await expect(
      fs.readFile(installed.installedPath!, 'utf8'),
    ).resolves.toContain('name: probe');
    expect(
      (await fs.readdir(path.join(workspace, '.qwen', 'skills'))).sort(),
    ).toEqual(['probe']);
  });

  it('rejects relative folder paths before reading files', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'unsafe-skill',
        scope: 'workspace',
        source: { type: 'folder', path: '../unsafe-skill' },
      }),
    ).rejects.toThrow('must be absolute');
  });

  it('reports malformed GitHub URLs as invalid sources', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'invalid-source',
        scope: 'workspace',
        source: { type: 'github', url: 'not a URL' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_skill_source' });
  });

  it.each(['--upload-pack', 'main%20--upload-pack'])(
    'rejects unsafe GitHub ref %s before making a request',
    async (ref) => {
      const workspace = await temporaryDirectory('qwen-skill-workspace-');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        installWorkspaceSkill(workspace, {
          name: 'invalid-ref',
          scope: 'workspace',
          source: {
            type: 'github',
            url: `https://github.com/owner/repo/blob/${ref}/SKILL.md`,
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid_skill_source' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects traversal in a GitHub Skill path before making a request', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'invalid-path',
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/main/..%2F../users/SKILL.md',
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_skill_source' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('installs a GitHub Skill file above the previous 2 MiB cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const payload = Buffer.from(
      skillMarkdown('sized-skill').padEnd(2 * 1024 * 1024 + 1, 'x'),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(githubSkillListing())
        .mockResolvedValueOnce(new Response(body, { status: 200 })),
    );

    const result = await installWorkspaceSkill(workspace, {
      name: 'sized-skill',
      scope: 'workspace',
      source: {
        type: 'github',
        url: 'https://github.com/owner/repo/blob/main/SKILL.md',
      },
    });

    await expect(fs.stat(result.installedPath!)).resolves.toMatchObject({
      size: payload.length,
    });
  });

  it('rejects a GitHub Skill file from content-length before reading it', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    let read = false;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(githubSkillListing())
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'content-length'
                ? String(MAX_FILE_BYTES + 1)
                : null,
          },
          body: {
            cancel: async () => undefined,
            getReader: () => {
              read = true;
              throw new Error('body should not be read');
            },
          },
        }),
    );

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'large-github-skill',
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/main/SKILL.md',
        },
      }),
    ).rejects.toMatchObject({
      code: 'skill_package_too_large',
      message: 'Skill file is too large',
      statusCode: 413,
    });
    expect(read).toBe(false);
    await expectNoPartialInstall(workspace, 'large-github-skill');
  });

  it('cancels a GitHub Skill file one byte over the per-file cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cancelled) return;
        controller.enqueue(new Uint8Array(MAX_FILE_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(githubSkillListing())
        .mockResolvedValueOnce(new Response(body, { status: 200 })),
    );

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'large-github-skill',
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/main/SKILL.md',
        },
      }),
    ).rejects.toMatchObject({
      code: 'skill_package_too_large',
      message: 'Skill file is too large',
      statusCode: 413,
    });
    expect(cancelled).toBe(true);
    await expectNoPartialInstall(workspace, 'large-github-skill');
  });

  it('rejects a symbolic link as the source folder', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    const sourceLink = path.join(workspace, 'source-link');
    await fs.writeFile(path.join(source, 'SKILL.md'), skillMarkdown('linked'));
    await fs.symlink(source, sourceLink);

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'linked',
        scope: 'workspace',
        source: { type: 'folder', path: sourceLink },
      }),
    ).rejects.toMatchObject({ code: 'invalid_skill_folder' });
  });

  it('installs a ZIP entry larger than the previous 2 MiB file cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const asset = 'x'.repeat(2 * 1024 * 1024 + 1);

    const result = await installWorkspaceSkill(workspace, {
      name: 'large-skill',
      scope: 'workspace',
      source: {
        type: 'zip',
        contentBase64: await zip({
          'large-skill/SKILL.md': skillMarkdown('large-skill'),
          'large-skill/asset.txt': asset,
        }),
      },
    });

    await expect(
      fs.stat(path.join(path.dirname(result.installedPath!), 'asset.txt')),
    ).resolves.toMatchObject({ size: asset.length });
  });

  it('installs a ZIP whose expanded content exceeds the previous 6 MiB cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const largeFile = 'x'.repeat(1_600_000);

    const result = await installWorkspaceSkill(workspace, {
      name: 'large-total-skill',
      scope: 'workspace',
      source: {
        type: 'zip',
        contentBase64: await zip({
          'large-total-skill/SKILL.md': skillMarkdown('large-total-skill'),
          'large-total-skill/one.txt': largeFile,
          'large-total-skill/two.txt': largeFile,
          'large-total-skill/three.txt': largeFile,
          'large-total-skill/four.txt': largeFile,
        }),
      },
    });

    await expect(
      fs.stat(path.join(path.dirname(result.installedPath!), 'four.txt')),
    ).resolves.toMatchObject({ size: largeFile.length });
  });

  it('keeps the existing Skill when replacement validation fails', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    const invalidSource = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('stable-skill'),
    );
    await fs.writeFile(
      path.join(invalidSource, 'SKILL.md'),
      skillMarkdown('different-name'),
    );
    const validRequest = {
      name: 'stable-skill',
      scope: 'workspace' as const,
      source: { type: 'folder' as const, path: source },
    };
    const installed = await installWorkspaceSkill(workspace, validRequest);

    await expect(
      installWorkspaceSkill(workspace, {
        ...validRequest,
        source: { type: 'folder', path: invalidSource },
      }),
    ).rejects.toThrow('does not match requested name');
    await expect(
      fs.readFile(installed.installedPath!, 'utf8'),
    ).resolves.toContain('name: stable-skill');
  });

  it('deletes legacy install-artifact-shaped Skill directories', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const name = 'foo.backup-1-2';
    const skillDir = path.join(workspace, '.qwen', 'skills', name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, skillMarkdown(name));

    await expect(
      deleteWorkspaceSkill(workspace, 'workspace', name, skillFile),
    ).resolves.toEqual({
      skillName: name,
      scope: 'workspace',
      deleted: true,
    });
    await expect(fs.stat(skillDir)).rejects.toThrow();
  });

  it('keeps a committed replacement when backup cleanup fails', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    const replacement = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('stable-skill'),
    );
    await fs.writeFile(
      path.join(replacement, 'SKILL.md'),
      `${skillMarkdown('stable-skill')}Replacement instructions.`,
    );
    const request = {
      name: 'stable-skill',
      scope: 'workspace' as const,
      source: { type: 'folder' as const, path: source },
    };
    await installWorkspaceSkill(workspace, request);
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('cleanup failed'));

    const result = await installWorkspaceSkill(workspace, {
      ...request,
      source: { type: 'folder', path: replacement },
    });

    await expect(fs.readFile(result.installedPath!, 'utf8')).resolves.toContain(
      'Replacement instructions.',
    );
    await expect(
      fs.readdir(path.join(workspace, '.qwen', 'skills')),
    ).resolves.toEqual(['stable-skill']);
  });

  it('preserves the install error when staging cleanup fails', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('different-name'),
    );
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('cleanup failed'));

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'expected-name',
        scope: 'workspace',
        source: { type: 'folder', path: source },
      }),
    ).rejects.toThrow('does not match requested name');
    await expect(
      fs.readdir(path.join(workspace, '.qwen', 'skills')),
    ).resolves.toEqual([]);
  });

  it('removes legacy install artifacts before installing', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    const baseDir = path.join(workspace, '.qwen', 'skills');
    const legacyBackup = path.join(baseDir, '.stable-skill.backup-legacy');
    const staleBackup = path.join(
      path.dirname(baseDir),
      '.skills-stable-skill.backup-stale',
    );
    const datedBackup = path.join(
      baseDir,
      '.stable-skill.backup-1792788267646',
    );
    const randomStaging = path.join(
      path.dirname(baseDir),
      '.skills-stable-skill.installing-sdk0Bp',
    );
    const foreignBackup = path.join(
      path.dirname(baseDir),
      '.skills-stable-skill.backup-my_data.txt',
    );
    await fs.mkdir(legacyBackup, { recursive: true });
    await fs.mkdir(staleBackup, { recursive: true });
    await fs.mkdir(datedBackup, { recursive: true });
    await fs.mkdir(randomStaging, { recursive: true });
    await fs.mkdir(foreignBackup, { recursive: true });
    await fs.writeFile(
      path.join(legacyBackup, 'SKILL.md'),
      skillMarkdown('stable-skill'),
    );
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('stable-skill'),
    );

    await installWorkspaceSkill(workspace, {
      name: 'stable-skill',
      scope: 'workspace',
      source: { type: 'folder', path: source },
    });

    await expect(fs.access(legacyBackup)).rejects.toThrow();
    await expect(fs.access(staleBackup)).rejects.toThrow();
    await expect(fs.access(datedBackup)).rejects.toThrow();
    await expect(fs.access(randomStaging)).rejects.toThrow();
    await expect(fs.access(foreignBackup)).resolves.toBeUndefined();
  });

  it('restores the existing Skill when committing a replacement fails', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    const replacement = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('stable-skill'),
    );
    await fs.writeFile(
      path.join(replacement, 'SKILL.md'),
      `${skillMarkdown('stable-skill')}Replacement instructions.`,
    );
    const request = {
      name: 'stable-skill',
      scope: 'workspace' as const,
      source: { type: 'folder' as const, path: source },
    };
    const installed = await installWorkspaceSkill(workspace, request);
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(
      async (sourcePath, targetPath) => {
        if (String(sourcePath).includes('.installing-')) {
          throw new Error('commit failed');
        }
        await rename(sourcePath, targetPath);
      },
    );

    await expect(
      installWorkspaceSkill(workspace, {
        ...request,
        source: { type: 'folder', path: replacement },
      }),
    ).rejects.toThrow('commit failed');
    await expect(
      fs.readFile(installed.installedPath!, 'utf8'),
    ).resolves.not.toContain('Replacement instructions.');
  });

  it('rolls back a replacement when the generation closes at commit', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    const replacement = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('stable-skill'),
    );
    await fs.writeFile(
      path.join(replacement, 'SKILL.md'),
      `${skillMarkdown('stable-skill')}Replacement instructions.`,
    );
    const installed = await installWorkspaceSkill(workspace, {
      name: 'stable-skill',
      scope: 'workspace',
      source: { type: 'folder', path: source },
    });
    let generationClosed = false;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(
      async (sourcePath, targetPath) => {
        await rename(sourcePath, targetPath);
        if (String(sourcePath).includes('.installing-')) {
          generationClosed = true;
        }
      },
    );

    await expect(
      installWorkspaceSkill(
        workspace,
        {
          name: 'stable-skill',
          scope: 'workspace',
          source: { type: 'folder', path: replacement },
        },
        undefined,
        () => {
          if (generationClosed) throw new Error('generation closed');
        },
      ),
    ).rejects.toThrow('generation closed');
    await expect(
      fs.readFile(installed.installedPath!, 'utf8'),
    ).resolves.not.toContain('Replacement instructions.');
  });

  it('fits the largest ZIP archive in the 10 MiB JSON body', () => {
    const jsonLimit = 10 * 1024 * 1024;
    const envelope = JSON.stringify({
      name: 'n'.repeat(256),
      scope: 'workspace',
      source: { type: 'zip', contentBase64: '' },
    });
    const envelopeBytes = Buffer.byteLength(envelope);
    expect(envelopeBytes).toBe(330);
    expect(MAX_ZIP_ARCHIVE_BYTES).toBe(
      3 * Math.floor((jsonLimit - envelopeBytes) / 4),
    );
    const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);
    expect(
      envelopeBytes + base64Length(MAX_ZIP_ARCHIVE_BYTES),
    ).toBeLessThanOrEqual(jsonLimit);
    expect(
      envelopeBytes + base64Length(MAX_ZIP_ARCHIVE_BYTES + 1),
    ).toBeGreaterThan(jsonLimit);
  });

  it('rejects a ZIP archive one byte over the transport ceiling', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'archive-skill',
        scope: 'workspace',
        source: {
          type: 'zip',
          contentBase64: Buffer.alloc(MAX_ZIP_ARCHIVE_BYTES + 1).toString(
            'base64',
          ),
        },
      }),
    ).rejects.toMatchObject({
      code: 'skill_package_too_large',
      message: 'Skill ZIP exceeds the allowed archive size',
      statusCode: 413,
    });
    await expectNoPartialInstall(workspace, 'archive-skill');
  });

  it('accepts a ZIP archive at the transport ceiling before unzipping', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'archive-skill',
        scope: 'workspace',
        source: {
          type: 'zip',
          contentBase64: Buffer.alloc(MAX_ZIP_ARCHIVE_BYTES).toString('base64'),
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_skill_package' });
    await expectNoPartialInstall(workspace, 'archive-skill');
  });

  it('rejects a ZIP entry one byte over the per-file cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'bomb-skill',
        scope: 'workspace',
        source: {
          type: 'zip',
          contentBase64: await zipSized([
            {
              name: 'bomb-skill/SKILL.md',
              content: skillMarkdown('bomb-skill'),
            },
            { name: 'bomb-skill/asset.bin', bytes: MAX_FILE_BYTES + 1 },
          ]),
        },
      }),
    ).rejects.toMatchObject({
      code: 'skill_package_too_large',
      message: 'Skill ZIP entry exceeds the allowed size',
      statusCode: 413,
    });
    await expectNoPartialInstall(workspace, 'bomb-skill');
  });

  it('rejects a ZIP that expands past the package cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const skill = skillMarkdown('bomb-skill');

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'bomb-skill',
        scope: 'workspace',
        source: {
          type: 'zip',
          contentBase64: await zipSized([
            { name: 'bomb-skill/SKILL.md', content: skill },
            { name: 'bomb-skill/one.bin', bytes: MAX_FILE_BYTES },
            {
              name: 'bomb-skill/two.bin',
              bytes:
                MAX_PACKAGE_BYTES +
                1 -
                MAX_FILE_BYTES -
                Buffer.byteLength(skill),
            },
          ]),
        },
      }),
    ).rejects.toMatchObject({
      code: 'skill_package_too_large',
      message: 'Skill ZIP expands beyond the allowed size',
      statusCode: 413,
    });
    await expectNoPartialInstall(workspace, 'bomb-skill');
  });

  it('installs a folder file above the previous 2 MiB cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    const asset = Buffer.alloc(2 * 1024 * 1024 + 1, 0x78);
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('folder-skill'),
    );
    await fs.writeFile(path.join(source, 'asset.bin'), asset);

    const result = await installWorkspaceSkill(workspace, {
      name: 'folder-skill',
      scope: 'workspace',
      source: { type: 'folder', path: source },
    });

    await expect(
      fs.stat(path.join(path.dirname(result.installedPath!), 'asset.bin')),
    ).resolves.toMatchObject({ size: asset.length });
  });

  it('installs a folder file at the per-file cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('cap-skill'),
    );
    await createSparseFile(path.join(source, 'asset.bin'), MAX_FILE_BYTES);

    const result = await installWorkspaceSkill(workspace, {
      name: 'cap-skill',
      scope: 'workspace',
      source: { type: 'folder', path: source },
    });

    await expect(
      fs.stat(path.join(path.dirname(result.installedPath!), 'asset.bin')),
    ).resolves.toMatchObject({ size: MAX_FILE_BYTES });
  });

  it('rejects a sparse folder file one byte over the per-file cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('cap-skill'),
    );
    await createSparseFile(path.join(source, 'asset.bin'), MAX_FILE_BYTES + 1);

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'cap-skill',
        scope: 'workspace',
        source: { type: 'folder', path: source },
      }),
    ).rejects.toMatchObject({
      code: 'skill_package_too_large',
      message: 'Skill file is too large: asset.bin',
      statusCode: 413,
    });
    await expectNoPartialInstall(workspace, 'cap-skill');
  });

  it('rejects sparse folder files one byte over the package cap', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    const skill = skillMarkdown('budget-skill');
    const skillBytes = Buffer.byteLength(skill);
    await fs.writeFile(path.join(source, 'SKILL.md'), skill);
    await createSparseFile(path.join(source, 'one.bin'), MAX_FILE_BYTES);
    await createSparseFile(
      path.join(source, 'two.bin'),
      MAX_PACKAGE_BYTES + 1 - MAX_FILE_BYTES - skillBytes,
    );

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'budget-skill',
        scope: 'workspace',
        source: { type: 'folder', path: source },
      }),
    ).rejects.toMatchObject({
      code: 'skill_package_too_large',
      message: 'Skill package exceeds the allowed size',
      statusCode: 413,
    });
    await expectNoPartialInstall(workspace, 'budget-skill');
  });

  it('installs 129 folder files', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      skillMarkdown('many-skill'),
    );
    for (let index = 0; index < 128; index += 1) {
      await fs.writeFile(path.join(source, `file-${index}.txt`), 'x');
    }

    const result = await installWorkspaceSkill(workspace, {
      name: 'many-skill',
      scope: 'workspace',
      source: { type: 'folder', path: source },
    });

    const installed = await fs.readdir(path.dirname(result.installedPath!));
    expect(installed).toHaveLength(129);
  });

  it('installs a folder of 2000 files and rejects 2001', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const accepted = await temporaryDirectory('qwen-skill-source-');
    const rejected = await temporaryDirectory('qwen-skill-source-');
    await fs.writeFile(
      path.join(accepted, 'SKILL.md'),
      skillMarkdown('count-skill'),
    );
    await fs.writeFile(
      path.join(rejected, 'SKILL.md'),
      skillMarkdown('count-skill'),
    );
    for (let index = 0; index < MAX_FILES - 1; index += 1) {
      await fs.writeFile(path.join(accepted, `file-${index}.txt`), 'x');
      await fs.writeFile(path.join(rejected, `file-${index}.txt`), 'x');
    }
    await fs.writeFile(path.join(rejected, 'overflow.txt'), 'x');

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'count-skill',
        scope: 'workspace',
        source: { type: 'folder', path: accepted },
      }),
    ).resolves.toMatchObject({ skillName: 'count-skill' });

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'count-skill',
        scope: 'workspace',
        source: { type: 'folder', path: rejected },
      }),
    ).rejects.toMatchObject({
      code: 'skill_too_many_files',
      message: 'Skill package has too many files (max 2000)',
      statusCode: 400,
    });
  });

  it('rejects a ZIP with 2001 files and ignores platform metadata', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const accepted: Record<string, string> = {
      'count-skill/SKILL.md': skillMarkdown('count-skill'),
      '__MACOSX/count-skill/._SKILL.md': 'junk',
      'count-skill/.DS_Store': 'junk',
      'count-skill/._notes': 'junk',
    };
    for (let index = 0; index < MAX_FILES - 1; index += 1) {
      accepted[`count-skill/file-${index}.txt`] = 'x';
    }

    const result = await installWorkspaceSkill(workspace, {
      name: 'count-skill',
      scope: 'workspace',
      source: { type: 'zip', contentBase64: await zip(accepted) },
    });
    const installed = await fs.readdir(path.dirname(result.installedPath!));
    expect(installed).toHaveLength(MAX_FILES);
    expect(installed).not.toContain('.DS_Store');
    expect(installed).not.toContain('__MACOSX');
    expect(installed).not.toContain('._notes');

    accepted['count-skill/overflow.txt'] = 'x';
    await expect(
      installWorkspaceSkill(workspace, {
        name: 'count-skill',
        scope: 'workspace',
        source: { type: 'zip', contentBase64: await zip(accepted) },
      }),
    ).rejects.toMatchObject({
      code: 'skill_too_many_files',
      message: 'Skill ZIP contains too many files (max 2000)',
      statusCode: 400,
    });
    await expect(fs.access(result.installedPath!)).resolves.toBeUndefined();
    const entries = await fs.readdir(path.join(workspace, '.qwen'));
    expect(
      entries.filter(
        (entry) => entry.includes('.installing-') || entry.includes('.backup-'),
      ),
    ).toEqual([]);
  });

  it('rejects an empty folder', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const source = await temporaryDirectory('qwen-skill-source-');

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'empty-skill',
        scope: 'workspace',
        source: { type: 'folder', path: source },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_skill_package',
      message: 'Skill package has an invalid file count',
    });
    await expectNoPartialInstall(workspace, 'empty-skill');
  });
});
