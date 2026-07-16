import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import archiver from 'archiver';
import { Storage } from '@qwen-code/qwen-code-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteWorkspaceSkill,
  installWorkspaceSkill,
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

  it('rejects unsafe GitHub refs before making a request', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'invalid-ref',
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/--upload-pack/SKILL.md',
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_skill_source' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops reading an oversized GitHub Skill file', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
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
        .mockResolvedValueOnce(new Response(oversizedBody, { status: 200 })),
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
      statusCode: 413,
    });
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

  it('reports an expanded ZIP entry over the limit as too large', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');

    await expect(
      installWorkspaceSkill(workspace, {
        name: 'large-skill',
        scope: 'workspace',
        source: {
          type: 'zip',
          contentBase64: await zip({
            'large-skill/SKILL.md': skillMarkdown('large-skill'),
            'large-skill/asset.txt': 'x'.repeat(2 * 1024 * 1024 + 1),
          }),
        },
      }),
    ).rejects.toMatchObject({
      code: 'skill_package_too_large',
      statusCode: 413,
    });
  });

  it('reports a ZIP whose total expanded content is over the limit', async () => {
    const workspace = await temporaryDirectory('qwen-skill-workspace-');
    const largeFile = 'x'.repeat(1_600_000);

    await expect(
      installWorkspaceSkill(workspace, {
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
      }),
    ).rejects.toMatchObject({
      code: 'skill_package_too_large',
      statusCode: 413,
    });
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
});
