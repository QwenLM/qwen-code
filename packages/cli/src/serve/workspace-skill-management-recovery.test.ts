import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWorkspaceSkill } from './workspace-skill-management.js';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

const roots: string[] = [];
const markdown = (name: string) =>
  `---\nname: ${name}\ndescription: Reproduction fixture\n---\nInstructions.\n`;
async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr15030-probe-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  execFileMock.mockReset();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('workspace Skill install recovery', () => {
  it('installs every file after a nested Contents API request fails', async () => {
    const workspace = await temporary();
    const fixture = await temporary();
    await fs.mkdir(path.join(fixture, 'skills/foo/references'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(fixture, 'skills/foo/SKILL.md'),
      markdown('foo'),
    );
    await fs.writeFile(
      path.join(fixture, 'skills/foo/references/guide.md'),
      'guide',
    );
    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const operation =
          args[0] === 'clone'
            ? fs.cp(fixture, args[args.length - 1], { recursive: true })
            : Promise.resolve();
        void operation.then(
          () => callback(null, '', ''),
          (error: Error) => callback(error, '', ''),
        );
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/contents/skills/foo/references?'))
          return new Response('rate limited', { status: 429 });
        if (input.includes('/contents/skills/foo?'))
          return Response.json([
            {
              name: 'api-only.txt',
              type: 'file',
              path: 'skills/foo/api-only.txt',
              download_url:
                'https://raw.githubusercontent.com/owner/repo/main/skills/foo/api-only.txt',
            },
            {
              name: 'SKILL.md',
              type: 'file',
              path: 'skills/foo/SKILL.md',
              download_url:
                'https://raw.githubusercontent.com/owner/repo/main/skills/foo/SKILL.md',
            },
            { name: 'references', type: 'dir', path: 'skills/foo/references' },
          ]);
        if (input.endsWith('/api-only.txt'))
          return new Response('discard partial attempt');
        if (input.endsWith('/SKILL.md')) return new Response(markdown('foo'));
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );
    await installWorkspaceSkill(workspace, {
      name: 'foo',
      scope: 'workspace',
      source: {
        type: 'github',
        url: 'https://github.com/owner/repo/blob/main/skills/foo/SKILL.md',
      },
    });
    expect(
      await fs.readFile(
        path.join(workspace, '.qwen/skills/foo/SKILL.md'),
        'utf8',
      ),
    ).toBe(markdown('foo'));
    expect(
      await fs.readFile(
        path.join(workspace, '.qwen/skills/foo/references/guide.md'),
        'utf8',
      ),
    ).toBe('guide');
    expect(
      (await fs.readdir(path.join(workspace, '.qwen/skills/foo'))).sort(),
    ).toEqual(['SKILL.md', 'references']);
    expect(await fs.readdir(path.join(workspace, '.qwen'))).toEqual(['skills']);
  });

  it.each(['foo.reference-1', 'foo.notes-abc123', 'bar.reference-1'])(
    'preserves all staged files while installing another skill (%s)',
    async (name) => {
      const workspace = await temporary();
      const source = await temporary();
      await fs.writeFile(path.join(source, 'SKILL.md'), markdown('foo'));
      let release!: () => void;
      let parked!: () => void;
      const pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        parked = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          if (input.includes('/contents/skills/foo?'))
            return Response.json([
              {
                name: 'a.txt',
                type: 'file',
                path: 'skills/foo/a.txt',
                download_url:
                  'https://raw.githubusercontent.com/owner/repo/main/skills/foo/a.txt',
              },
              {
                name: 'SKILL.md',
                type: 'file',
                path: 'skills/foo/SKILL.md',
                download_url:
                  'https://raw.githubusercontent.com/owner/repo/main/skills/foo/SKILL.md',
              },
            ]);
          if (input.endsWith('/a.txt')) return new Response('must survive');
          if (input.endsWith('/SKILL.md')) {
            parked();
            await pause;
            return new Response(markdown(name));
          }
          throw new Error(`Unexpected fetch: ${input}`);
        }),
      );
      const victim = installWorkspaceSkill(workspace, {
        name,
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/main/skills/foo/SKILL.md',
        },
      });
      await ready;
      try {
        await installWorkspaceSkill(workspace, {
          name: 'foo',
          scope: 'workspace',
          source: { type: 'folder', path: source },
        });
      } finally {
        release();
      }
      await victim;
      expect(
        await fs.readFile(
          path.join(workspace, '.qwen/skills', name, 'a.txt'),
          'utf8',
        ),
      ).toBe('must survive');
      expect(
        await fs.readFile(
          path.join(workspace, '.qwen/skills', name, 'SKILL.md'),
          'utf8',
        ),
      ).toBe(markdown(name));
    },
  );

  it('falls back to git when a Contents API listing reaches the page limit', async () => {
    const workspace = await temporary();
    const fixture = await temporary();
    await fs.writeFile(path.join(fixture, 'SKILL.md'), markdown('foo'));
    await fs.writeFile(path.join(fixture, 'a.txt'), 'must survive');
    const before = new Set(await fs.readdir(os.tmpdir()));
    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const checkout = args[args.length - 1];
        const operation =
          args[0] === 'clone'
            ? fs.cp(fixture, checkout, { recursive: true }).then(async () => {
                await fs.mkdir(path.join(checkout, '.git'), {
                  recursive: true,
                });
                await fs.writeFile(
                  path.join(checkout, '.git/config'),
                  '[remote "origin"]\n\turl = https://x-access-token:ghp_SECRET@github.com/owner/repo.git\n',
                );
              })
            : Promise.resolve();
        void operation.then(
          () => callback(null, '', ''),
          (error: Error) => callback(error, '', ''),
        );
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/contents?ref=main')) {
          return Response.json(
            Array.from({ length: 1000 }, (_, index) =>
              index === 0
                ? {
                    name: 'SKILL.md',
                    type: 'file',
                    path: 'SKILL.md',
                    download_url:
                      'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
                  }
                : {
                    name: `missing-${index}.txt`,
                    type: 'file',
                    path: `missing-${index}.txt`,
                  },
            ),
          );
        }
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );
    await installWorkspaceSkill(workspace, {
      name: 'foo',
      scope: 'workspace',
      source: {
        type: 'github',
        url: 'https://github.com/owner/repo/blob/main/SKILL.md',
      },
    });
    expect(execFileMock).toHaveBeenCalled();
    expect(
      (await fs.readdir(path.join(workspace, '.qwen/skills/foo'))).sort(),
    ).toEqual(['SKILL.md', 'a.txt']);
    expect(
      await fs.readFile(path.join(workspace, '.qwen/skills/foo/a.txt'), 'utf8'),
    ).toBe('must survive');
    expect(
      (await fs.readdir(os.tmpdir())).filter(
        (name) => name.startsWith('qwen-skill-git-') && !before.has(name),
      ),
    ).toEqual([]);
  });

  it('reports a staging fault during the git fallback as a server error', async () => {
    const workspace = await temporary();
    const fixture = await temporary();
    await fs.writeFile(path.join(fixture, 'SKILL.md'), markdown('foo'));
    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const operation =
          args[0] === 'clone'
            ? fs.cp(fixture, args[args.length - 1], { recursive: true })
            : Promise.resolve();
        void operation.then(
          () => callback(null, '', ''),
          (error: Error) => callback(error, '', ''),
        );
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/contents?ref=main')) {
          return new Response('rate limited', { status: 429 });
        }
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );
    const copyFile = vi
      .spyOn(fs, 'copyFile')
      .mockImplementationOnce(async (_source, target) => {
        throw Object.assign(new Error('no space left on device'), {
          code: 'ENOSPC',
          dest: String(target),
        });
      });

    try {
      await expect(
        installWorkspaceSkill(workspace, {
          name: 'foo',
          scope: 'workspace',
          source: {
            type: 'github',
            url: 'https://github.com/owner/repo/blob/main/SKILL.md',
          },
        }),
      ).rejects.toMatchObject({
        code: 'skill_staging_failed',
        statusCode: 500,
      });
    } finally {
      copyFile.mockRestore();
    }
  });

  it('excludes a root-level .git directory from a folder install', async () => {
    const workspace = await temporary();
    const source = await temporary();
    await fs.writeFile(path.join(source, 'SKILL.md'), markdown('foo'));
    await fs.writeFile(path.join(source, 'a.txt'), 'must survive');
    await fs.mkdir(path.join(source, '.git'));
    await fs.writeFile(
      path.join(source, '.git/config'),
      '[remote "origin"]\n\turl = https://x-access-token:ghp_SECRET@github.com/owner/repo.git\n',
    );
    await installWorkspaceSkill(workspace, {
      name: 'foo',
      scope: 'workspace',
      source: { type: 'folder', path: source },
    });
    expect(
      (await fs.readdir(path.join(workspace, '.qwen/skills/foo'))).sort(),
    ).toEqual(['SKILL.md', 'a.txt']);
  });

  it('keeps a live staging directory when another scope shares the base directory', async () => {
    const workspace = await temporary();
    const source = await temporary();
    await fs.writeFile(path.join(source, 'SKILL.md'), markdown('other'));
    const previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(workspace, '.qwen');
    let release!: () => void;
    let parked!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      parked = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/contents/skills/foo?'))
          return Response.json([
            {
              name: 'a.txt',
              type: 'file',
              path: 'skills/foo/a.txt',
              download_url:
                'https://raw.githubusercontent.com/owner/repo/main/skills/foo/a.txt',
            },
            {
              name: 'SKILL.md',
              type: 'file',
              path: 'skills/foo/SKILL.md',
              download_url:
                'https://raw.githubusercontent.com/owner/repo/main/skills/foo/SKILL.md',
            },
          ]);
        if (input.endsWith('/a.txt')) return new Response('must survive');
        if (input.endsWith('/SKILL.md')) {
          parked();
          await pause;
          return new Response(markdown('foo'));
        }
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );
    try {
      const victim = installWorkspaceSkill(workspace, {
        name: 'foo',
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/main/skills/foo/SKILL.md',
        },
      });
      await ready;
      try {
        await expect(
          installWorkspaceSkill(workspace, {
            name: 'foo',
            scope: 'global',
            source: { type: 'folder', path: source },
          }),
        ).rejects.toMatchObject({ code: 'skill_name_mismatch' });
      } finally {
        release();
      }
      await victim;
      expect(
        await fs.readFile(
          path.join(workspace, '.qwen/skills/foo/a.txt'),
          'utf8',
        ),
      ).toBe('must survive');
    } finally {
      release();
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
    }
  });

  it('does not start git when the generation is already closed', async () => {
    const workspace = await temporary();
    let closed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        closed = true;
        return new Response('rate limited', { status: 429 });
      }),
    );
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(null, '', '');
    });
    const generationClosed = () => {
      if (closed) {
        const error = new Error('generation closed');
        error.name = 'WorkspaceGenerationClosedError';
        throw error;
      }
    };
    await expect(
      installWorkspaceSkill(
        workspace,
        {
          name: 'foo',
          scope: 'workspace',
          source: {
            type: 'github',
            url: 'https://github.com/owner/repo/blob/main/skills/foo/SKILL.md',
          },
        },
        undefined,
        generationClosed,
      ),
    ).rejects.toMatchObject({ name: 'WorkspaceGenerationClosedError' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('stops the git fallback when the generation closes during the clone', async () => {
    const workspace = await temporary();
    const fixture = await temporary();
    await fs.mkdir(path.join(fixture, 'skills/foo'), { recursive: true });
    await fs.writeFile(
      path.join(fixture, 'skills/foo/SKILL.md'),
      markdown('foo'),
    );
    let closed = false;
    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const operation =
          args[0] === 'clone'
            ? fs.cp(fixture, args[args.length - 1], { recursive: true })
            : Promise.resolve();
        void operation.then(
          () => {
            if (args[0] === 'clone') closed = true;
            callback(null, '', '');
          },
          (error: Error) => callback(error, '', ''),
        );
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    const generationClosed = () => {
      if (closed) {
        const error = new Error('generation closed');
        error.name = 'WorkspaceGenerationClosedError';
        throw error;
      }
    };
    const readdirTargets: string[] = [];
    const nativeReaddir = fs.readdir.bind(fs);
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(((
      ...args: Parameters<typeof fs.readdir>
    ) => {
      readdirTargets.push(String(args[0]));
      return nativeReaddir(...args);
    }) as typeof fs.readdir);
    try {
      await expect(
        installWorkspaceSkill(
          workspace,
          {
            name: 'foo',
            scope: 'workspace',
            source: {
              type: 'github',
              url: 'https://github.com/owner/repo/blob/main/skills/foo/SKILL.md',
            },
          },
          undefined,
          generationClosed,
        ),
      ).rejects.toMatchObject({ name: 'WorkspaceGenerationClosedError' });
      expect(
        readdirTargets.filter((target) =>
          target
            .split(path.sep)
            .some((segment) => segment.startsWith('qwen-skill-git-')),
        ),
      ).toEqual([]);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('keeps public git fallback independent of a rejected API token', async () => {
    const workspace = await temporary();
    const fixture = await temporary();
    await fs.mkdir(path.join(fixture, 'skills/foo'), { recursive: true });
    await fs.writeFile(
      path.join(fixture, 'skills/foo/SKILL.md'),
      markdown('foo'),
    );
    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const operation =
          args[0] === 'clone'
            ? fs.cp(fixture, args[args.length - 1], { recursive: true })
            : Promise.resolve();
        void operation.then(
          () => callback(null, '', ''),
          (error: Error) => callback(error, '', ''),
        );
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 401 })),
    );
    const token = 'ghp_TEST_TOKEN';
    vi.stubEnv('QWEN_SERVER_TOKEN', 'qwen-server-bearer');
    vi.stubEnv('https_proxy', 'http://proxy.invalid:8080');
    await installWorkspaceSkill(
      workspace,
      {
        name: 'foo',
        scope: 'workspace',
        source: {
          type: 'github',
          url: 'https://github.com/owner/repo/blob/main/skills/foo/SKILL.md',
        },
      },
      token,
    );
    expect(
      await fs.readFile(
        path.join(workspace, '.qwen/skills/foo/SKILL.md'),
        'utf8',
      ),
    ).toBe(markdown('foo'));
    expect(execFileMock).toHaveBeenCalledTimes(2);
    for (const [, argv, options] of execFileMock.mock.calls) {
      expect(JSON.stringify([argv, options])).not.toContain(token);
      const env = (options as { env: NodeJS.ProcessEnv }).env;
      expect(env).toMatchObject({
        GIT_TERMINAL_PROMPT: '0',
        https_proxy: 'http://proxy.invalid:8080',
      });
      expect(env['PATH']).toBe(process.env['PATH']);
      expect(env['HOME']).toBe(process.env['HOME']);
      expect(env['QWEN_SERVER_TOKEN']).toBeUndefined();
    }
  });

  it('restores the original Skill when aliased installs share a backup timestamp', async () => {
    const workspace = await temporary();
    const source = await temporary();
    const invalid = await temporary();
    await fs.writeFile(path.join(source, 'SKILL.md'), markdown('foo'));
    await fs.writeFile(path.join(invalid, 'SKILL.md'), markdown('other'));
    const previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(workspace, '.qwen');
    vi.spyOn(Date, 'now').mockReturnValue(1_785_000_000_000);
    const destination = path.join(workspace, '.qwen', 'skills', 'foo');
    let release!: () => void;
    let parked!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      parked = resolve;
    });
    try {
      await installWorkspaceSkill(workspace, {
        name: 'foo',
        scope: 'workspace',
        source: { type: 'folder', path: source },
      });
      const original = await fs.readFile(
        path.join(destination, 'SKILL.md'),
        'utf8',
      );
      const nativeRename = fs.rename.bind(fs);
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (
          String(from).includes('.installing-') &&
          String(to) === destination
        ) {
          parked();
          await pause;
          throw new Error('commit failed');
        }
        await nativeRename(from, to);
      });
      const victim = installWorkspaceSkill(workspace, {
        name: 'foo',
        scope: 'workspace',
        source: { type: 'folder', path: source },
      });
      await ready;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          installWorkspaceSkill(workspace, {
            name: 'foo',
            scope: 'global',
            source: { type: 'folder', path: invalid },
          }),
        ).rejects.toMatchObject({ code: 'skill_name_mismatch' });
      }
      release();
      await expect(victim).rejects.toThrow('commit failed');
      await expect(
        fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'),
      ).resolves.toBe(original);
    } finally {
      release();
      vi.restoreAllMocks();
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
    }
  });

  it('reclaims dead-owner install artifacts and keeps a live peer artifact', async () => {
    const workspace = await temporary();
    const source = await temporary();
    await fs.writeFile(path.join(source, 'SKILL.md'), markdown('foo'));
    const workDir = path.join(workspace, '.qwen');
    await fs.mkdir(workDir, { recursive: true });
    const live = path.join(workDir, '.skills-foo.installing-55555-live');
    const dead = path.join(workDir, '.skills-foo.installing-424242-dead');
    await fs.mkdir(live);
    await fs.mkdir(dead);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 424242) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      return true;
    });

    try {
      await installWorkspaceSkill(workspace, {
        name: 'foo',
        scope: 'workspace',
        source: { type: 'folder', path: source },
      });
      expect((await fs.lstat(live)).isDirectory()).toBe(true);
      await expect(fs.access(dead)).rejects.toThrow();
    } finally {
      kill.mockRestore();
    }
  });

  it('registers the staging directory before it exists on disk', async () => {
    const workspace = await temporary();
    const source = await temporary();
    const invalid = await temporary();
    await fs.writeFile(path.join(source, 'SKILL.md'), markdown('foo'));
    await fs.writeFile(path.join(source, 'a.txt'), 'must survive');
    await fs.writeFile(path.join(invalid, 'SKILL.md'), markdown('other'));
    const previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(workspace, '.qwen');
    const nativeMkdir = fs.mkdir.bind(fs);
    let staging = '';
    let parked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parkedOnce = false;
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementation(((
      ...args: Parameters<typeof fs.mkdir>
    ) =>
      Promise.resolve(nativeMkdir(...args)).then(async (created) => {
        const target = String(args[0]);
        if (!parkedOnce && target.includes('.skills-foo.installing-')) {
          parkedOnce = true;
          staging = target;
          parked();
          await pause;
        }
        return created;
      })) as typeof fs.mkdir);
    try {
      const victim = installWorkspaceSkill(workspace, {
        name: 'foo',
        scope: 'workspace',
        source: { type: 'folder', path: source },
      });
      await ready;
      await expect(
        installWorkspaceSkill(workspace, {
          name: 'foo',
          scope: 'global',
          source: { type: 'folder', path: invalid },
        }),
      ).rejects.toMatchObject({ code: 'skill_name_mismatch' });
      expect((await fs.lstat(staging)).isDirectory()).toBe(true);
      release();
      await victim;
      expect(
        (await fs.readdir(path.join(workspace, '.qwen/skills/foo'))).sort(),
      ).toEqual(['SKILL.md', 'a.txt']);
    } finally {
      release();
      mkdirSpy.mockRestore();
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
    }
  });

  it('rejects a package whose staged file disappears before commit', async () => {
    const workspace = await temporary();
    const source = await temporary();
    await fs.writeFile(path.join(source, 'SKILL.md'), markdown('foo'));
    await fs.writeFile(path.join(source, 'a.txt'), 'must survive');
    const nativeCopyFile = fs.copyFile.bind(fs);
    const staged: string[] = [];
    const copyFile = vi
      .spyOn(fs, 'copyFile')
      .mockImplementation(async (from, to) => {
        await nativeCopyFile(from, to);
        staged.push(String(to));
        const [first] = staged;
        if (staged.length === 2 && first) await fs.rm(first);
      });

    try {
      await expect(
        installWorkspaceSkill(workspace, {
          name: 'foo',
          scope: 'workspace',
          source: { type: 'folder', path: source },
        }),
      ).rejects.toMatchObject({
        code: 'skill_staging_failed',
        statusCode: 500,
      });
      await expect(
        fs.access(path.join(workspace, '.qwen/skills/foo')),
      ).rejects.toThrow();
    } finally {
      copyFile.mockRestore();
    }
  });
});
