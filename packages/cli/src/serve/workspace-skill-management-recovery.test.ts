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

  it.each(['foo.backup-1', 'foo.installing-abc123', 'bar.backup-1'])(
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
});
