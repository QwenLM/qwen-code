/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Config,
  WorkflowAncestorTrustProvider,
} from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import {
  getSavedWorkflowDirs,
  getWorkflowScriptRoots,
  listSavedWorkflows,
  resolveSavedWorkflowScript,
  saveWorkflowScript,
} from './workflow-saved.js';
import {
  MAX_WORKFLOW_ANCESTOR_DIRS,
  resolveWorkflowAncestorScope,
} from './workflow-ancestors.js';

/**
 * Fixture, all under one real temp dir:
 *
 *   repo/.git/
 *   repo/.qwen/workflows/{root-only,shared}.js     ROOT_ONLY / ROOT
 *   repo/packages/.qwen/workflows/shared.js         PACKAGES
 *   repo/packages/a/                                <- target directory
 *   home/.qwen/workflows/{user-only,shared}.js      USER_ONLY / USER
 */
let base: string;
let repo: string;
let packages: string;
let target: string;
let prevQwenHome: string | undefined;

const wf = (dir: string) => path.join(dir, '.qwen', 'workflows');
const userWorkflows = () => path.join(base, 'home', '.qwen', 'workflows');
const marker = (m: string) => `// ${m}\nreturn "${m}";\n`;

async function put(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
}

const trustAll: WorkflowAncestorTrustProvider = async (dirs) =>
  dirs.map(() => true);

function configFor(
  targetDir: string,
  provider: WorkflowAncestorTrustProvider | null = trustAll,
  storageDir: string = targetDir,
): Config {
  return {
    storage: new Storage(storageDir),
    getTargetDir: () => targetDir,
    getWorkflowAncestorTrustProvider: () => provider ?? undefined,
  } as unknown as Config;
}

const names = async (config: Config) =>
  (await listSavedWorkflows(config)).map((e) => `${e.name}@${e.scriptPath}`);
const scriptOf = async (name: string, config: Config) =>
  (await resolveSavedWorkflowScript(name, config)).script;

beforeEach(async () => {
  base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'wf-ancestors-')),
  );
  repo = path.join(base, 'repo');
  packages = path.join(repo, 'packages');
  target = path.join(packages, 'a');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(target, { recursive: true });
  await put(path.join(wf(repo), 'root-only.js'), marker('ROOT_ONLY'));
  await put(path.join(wf(repo), 'shared.js'), marker('ROOT'));
  await put(path.join(wf(packages), 'shared.js'), marker('PACKAGES'));
  await put(path.join(userWorkflows(), 'user-only.js'), marker('USER_ONLY'));
  await put(path.join(userWorkflows(), 'shared.js'), marker('USER'));
  prevQwenHome = process.env['QWEN_HOME'];
  process.env['QWEN_HOME'] = path.join(base, 'home', '.qwen');
});

afterEach(async () => {
  if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
  else process.env['QWEN_HOME'] = prevQwenHome;
  await fs.chmod(base, 0o700).catch(() => undefined);
  await fs.rm(base, { recursive: true, force: true });
});

describe('workflow ancestors — discovery and precedence', () => {
  it('lists trusted ancestors between the project and the user scope, nearest wins', async () => {
    const config = configFor(target);
    expect(await names(config)).toEqual([
      `root-only@${path.join(wf(repo), 'root-only.js')}`,
      `shared@${path.join(wf(packages), 'shared.js')}`,
      `user-only@${path.join(userWorkflows(), 'user-only.js')}`,
    ]);
    expect(await scriptOf('root-only', config)).toContain('ROOT_ONLY');
    expect(await scriptOf('shared', config)).toContain('PACKAGES');
    expect(await scriptOf('user-only', config)).toContain('USER_ONLY');
    const resolved = await resolveSavedWorkflowScript('shared', config);
    expect(resolved).toMatchObject({
      scriptPath: path.join(wf(packages), 'shared.js'),
      savedWorkflowName: 'shared',
      source: 'project',
    });
  });

  it('lets a definition in the target directory shadow every ancestor', async () => {
    const config = configFor(target);
    await put(path.join(wf(target), 'shared.js'), marker('A'));
    expect(await scriptOf('shared', config)).toContain('A');
    expect(
      (await listSavedWorkflows(config)).find((e) => e.name === 'shared')
        ?.scriptPath,
    ).toBe(path.join(wf(target), 'shared.js'));
  });

  it('rediscovers on every call: adding and removing a nearer definition', async () => {
    const config = configFor(target);
    expect(await scriptOf('shared', config)).toContain('PACKAGES');
    await put(path.join(wf(target), 'shared.js'), marker('A'));
    expect(await scriptOf('shared', config)).toContain('A');
    await fs.rm(path.join(wf(target), 'shared.js'));
    await fs.rm(path.join(wf(packages), 'shared.js'));
    expect(await scriptOf('shared', config)).toContain('ROOT');
  });

  it('asks the host once per lookup, with the strict ancestors nearest first', async () => {
    const provider = vi.fn(trustAll);
    const config = configFor(target, provider);
    await listSavedWorkflows(config);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith([packages, repo]);
    provider.mockClear();
    await resolveSavedWorkflowScript('missing-name', config).catch(() => {});
    // The miss message lists names from the same lookup.
    expect(provider).toHaveBeenCalledTimes(1);
    provider.mockClear();
    await resolveSavedWorkflowScript(
      { scriptPath: path.join(wf(repo), 'root-only.js') },
      config,
    );
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('searches no ancestor without a provider (the base two scopes only)', async () => {
    const config = configFor(target, null);
    expect((await listSavedWorkflows(config)).map((e) => e.name)).toEqual([
      'shared',
      'user-only',
    ]);
    expect(await scriptOf('shared', config)).toContain('USER');
    await expect(scriptOf('root-only', config)).rejects.toThrow(
      /no workflow with that name/,
    );
  });

  it('stops at the first ancestor the host does not trust', async () => {
    const config = configFor(target, async (dirs) =>
      dirs.map((dir) => dir === repo),
    );
    expect((await listSavedWorkflows(config)).map((e) => e.name)).toEqual([
      'shared',
      'user-only',
    ]);
    await expect(scriptOf('root-only', config)).rejects.toThrow(
      /no workflow with that name/,
    );
    await expect(
      resolveSavedWorkflowScript(
        { scriptPath: path.join(wf(repo), 'root-only.js') },
        config,
      ),
    ).rejects.toThrow(/outside the workflow script roots/);
  });

  it('keeps the trusted prefix: packages trusted, repo not', async () => {
    const config = configFor(target, async (dirs) =>
      dirs.map((dir) => dir === packages),
    );
    expect(await scriptOf('shared', config)).toContain('PACKAGES');
    await expect(scriptOf('root-only', config)).rejects.toThrow(
      /no workflow with that name/,
    );
  });

  it.each([
    ['throws', async () => Promise.reject(new Error('boom'))],
    ['answers with the wrong length', async () => [true]],
    [
      'answers truthy non-booleans',
      async (dirs: readonly string[]) =>
        dirs.map(() => 1 as unknown as boolean),
    ],
    ['answers a non-array', async () => ({}) as unknown as boolean[]],
  ])('adds no ancestor when the provider %s', async (_label, provider) => {
    const config = configFor(
      target,
      provider as unknown as WorkflowAncestorTrustProvider,
    );
    expect((await listSavedWorkflows(config)).map((e) => e.name)).toEqual([
      'shared',
      'user-only',
    ]);
  });

  it('applies a revoked or restored ancestor rule on the next lookup', async () => {
    let trustRoot = true;
    const config = configFor(target, async (dirs) =>
      dirs.map((dir) => dir !== repo || trustRoot),
    );
    expect(await scriptOf('root-only', config)).toContain('ROOT_ONLY');
    trustRoot = false;
    await expect(scriptOf('root-only', config)).rejects.toThrow(
      /no workflow with that name/,
    );
    trustRoot = true;
    expect(await scriptOf('root-only', config)).toContain('ROOT_ONLY');
  });

  it('keeps the user scope when a repository at the home directory holds it', async () => {
    // QWEN_HOME is <repo>/.qwen: the root's workflows ARE the user scope.
    process.env['QWEN_HOME'] = path.join(repo, '.qwen');
    const entries = await listSavedWorkflows(configFor(target));
    expect(entries.find((e) => e.name === 'root-only')?.source).toBe('user');
    expect(entries.find((e) => e.name === 'shared')?.scriptPath).toBe(
      path.join(wf(packages), 'shared.js'),
    );
  });
});

describe('workflow ancestors — repository boundary', () => {
  it('stops at a linked worktree or submodule root (a .git file)', async () => {
    await put(path.join(packages, '.git'), 'gitdir: ../.git/worktrees/p\n');
    const provider = vi.fn(trustAll);
    const config = configFor(target, provider);
    expect(await scriptOf('shared', config)).toContain('PACKAGES');
    expect(provider).toHaveBeenCalledWith([packages]);
    await expect(scriptOf('root-only', config)).rejects.toThrow(
      /no workflow with that name/,
    );
  });

  it('searches no ancestor outside a repository', async () => {
    await fs.rm(path.join(repo, '.git'), { recursive: true });
    const provider = vi.fn(trustAll);
    const config = configFor(target, provider);
    expect((await listSavedWorkflows(config)).map((e) => e.name)).toEqual([
      'shared',
      'user-only',
    ]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('adds nothing when the target itself is the repository root', async () => {
    const provider = vi.fn(trustAll);
    const scope = await resolveWorkflowAncestorScope(configFor(repo, provider));
    expect(scope).toEqual({
      canonicalTargetDir: repo,
      repoRoot: repo,
      trustedAncestors: [],
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('treats a .git symlink below the root as an unreliable boundary', async () => {
    await fs.symlink(path.join(repo, '.git'), path.join(packages, '.git'));
    const provider = vi.fn(trustAll);
    const config = configFor(target, provider);
    expect((await listSavedWorkflows(config)).map((e) => e.name)).toEqual([
      'shared',
      'user-only',
    ]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('canonicalizes a target spelled through a symlinked parent', async () => {
    const alias = path.join(base, 'alias');
    await fs.symlink(repo, alias);
    const provider = vi.fn(trustAll);
    const config = configFor(path.join(alias, 'packages', 'a'), provider);
    expect(await scriptOf('root-only', config)).toContain('ROOT_ONLY');
    expect(provider).toHaveBeenCalledWith([packages, repo]);
  });

  it('bounds the ancestor chain', async () => {
    let deep = target;
    for (let i = 0; i < MAX_WORKFLOW_ANCESTOR_DIRS + 3; i++) {
      deep = path.join(deep, `d${i}`);
    }
    await fs.mkdir(deep, { recursive: true });
    const provider = vi.fn(trustAll);
    await listSavedWorkflows(configFor(deep, provider));
    expect(provider.mock.calls[0][0]).toHaveLength(MAX_WORKFLOW_ANCESTOR_DIRS);
    expect(provider.mock.calls[0][0][0]).toBe(path.dirname(deep));
  });
});

describe('workflow ancestors — what an ancestor may expose', () => {
  it('refuses an ancestor whose .qwen or workflows directory is a symlink', async () => {
    const outside = path.join(base, 'outside');
    await put(path.join(outside, 'workflows', 'leak.js'), marker('LEAK'));
    await fs.rm(path.join(packages, '.qwen'), { recursive: true });
    await fs.symlink(outside, path.join(packages, '.qwen'));
    const config = configFor(target);
    const listed = await listSavedWorkflows(config);
    expect(listed.map((e) => e.name)).not.toContain('leak');
    await expect(scriptOf('leak', config)).rejects.toThrow(
      /no workflow with that name/,
    );
    await expect(
      resolveSavedWorkflowScript(
        { scriptPath: path.join(packages, '.qwen', 'workflows', 'leak.js') },
        config,
      ),
    ).rejects.toThrow(/outside the workflow script roots/);
    // The root above is still reachable: a refused directory is not a
    // distrusted one.
    expect(await scriptOf('shared', config)).toContain('ROOT');
  });

  it('reads only direct <valid-name>.js files of an ancestor by path', async () => {
    await put(path.join(wf(repo), '.env'), 'SECRET=1');
    await put(path.join(wf(repo), 'nested', 'deep.js'), marker('DEEP'));
    await put(path.join(wf(repo), 'Bad_Name.js'), marker('BAD'));
    await put(path.join(repo, '.qwen', 'settings.js'), marker('SETTINGS'));
    const config = configFor(target);
    for (const file of [
      path.join(wf(repo), '.env'),
      path.join(wf(repo), 'nested', 'deep.js'),
      path.join(wf(repo), 'Bad_Name.js'),
      path.join(repo, '.qwen', 'settings.js'),
      `${wf(packages)}/../../../.qwen/workflows/.env`,
    ]) {
      await expect(
        resolveSavedWorkflowScript({ scriptPath: file }, config),
      ).rejects.toThrow(/outside the workflow script roots/);
    }
    // The exact-file rule is not a new script root.
    expect(getWorkflowScriptRoots(config)).not.toContain(wf(repo));
  });

  it('runs an explicitly named ancestor file a nearer one shadows', async () => {
    const config = configFor(target);
    const resolved = await resolveSavedWorkflowScript(
      { scriptPath: path.join(wf(repo), 'shared.js') },
      config,
    );
    expect(resolved.script).toContain('ROOT');
    expect(resolved).toMatchObject({
      savedWorkflowName: 'shared',
      source: 'project',
    });
    // The name still runs the nearest one.
    expect(await scriptOf('shared', config)).toContain('PACKAGES');
  });

  it('does not take a directory named <name>.js or a symlinked file as a definition', async () => {
    await fs.mkdir(path.join(wf(target), 'shared.js'), { recursive: true });
    await put(path.join(base, 'outside', 'x.js'), marker('OUTSIDE'));
    await fs.symlink(
      path.join(base, 'outside', 'x.js'),
      path.join(wf(packages), 'root-only.js'),
    );
    const config = configFor(target);
    const listed = await listSavedWorkflows(config);
    expect(listed.find((e) => e.name === 'shared')?.scriptPath).toBe(
      path.join(wf(packages), 'shared.js'),
    );
    expect(listed.find((e) => e.name === 'root-only')?.scriptPath).toBe(
      path.join(wf(repo), 'root-only.js'),
    );
    expect(await scriptOf('shared', config)).toContain('PACKAGES');
    expect(await scriptOf('root-only', config)).toContain('ROOT_ONLY');
  });

  it('keeps a syntactically broken nearest definition selected', async () => {
    await put(path.join(wf(target), 'shared.js'), 'return (;\n');
    expect(await scriptOf('shared', configFor(target))).toBe('return (;\n');
  });

  it.runIf(process.getuid?.() !== 0)(
    'fails, rather than falling back, when the nearest definition is unreadable',
    async () => {
      const file = path.join(wf(packages), 'shared.js');
      await fs.chmod(file, 0o000);
      try {
        const config = configFor(target);
        expect(
          (await listSavedWorkflows(config)).find((e) => e.name === 'shared')
            ?.scriptPath,
        ).toBe(file);
        await expect(scriptOf('shared', config)).rejects.toThrow(
          /workflow\('shared'\): cannot read/,
        );
      } finally {
        await fs.chmod(file, 0o644);
      }
    },
  );

  it.runIf(process.getuid?.() !== 0)(
    'skips an ancestor directory that cannot be listed, for names and the list alike',
    async () => {
      await fs.chmod(wf(packages), 0o300); // traversable, not readable
      try {
        const config = configFor(target);
        expect(
          (await listSavedWorkflows(config)).find((e) => e.name === 'shared')
            ?.scriptPath,
        ).toBe(path.join(wf(repo), 'shared.js'));
        expect(await scriptOf('shared', config)).toContain('ROOT');
      } finally {
        await fs.chmod(wf(packages), 0o755);
      }
    },
  );

  it('fails when the selected file is swapped for a link after it was listed', async () => {
    const file = path.join(wf(packages), 'shared.js');
    const config = configFor(target);
    const realReaddir = fs.readdir.bind(fs);
    const spy = vi
      .spyOn(fs, 'readdir')
      .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        const out = await realReaddir(...args);
        if (String(args[0]) === wf(packages)) {
          await fs.rm(file);
          await put(path.join(base, 'outside', 'x.js'), marker('OUTSIDE'));
          await fs.symlink(path.join(base, 'outside', 'x.js'), file);
        }
        return out as never;
      });
    try {
      // `readdir` saw a regular file; the swap lands before its `lstat`.
      // Either it is then no longer a candidate (ROOT runs) or the read
      // refuses it — the outside file never runs.
      const result = await scriptOf('shared', config).catch((e: Error) =>
        String(e.message),
      );
      expect(result).not.toContain('OUTSIDE');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('workflow ancestors — derived configs and saving', () => {
  it('anchors the project scope on the target directory, not inherited storage', async () => {
    // A derived Config rebinds its target directory but inherits the parent
    // session's Storage (here: the repository root).
    const config = configFor(target, trustAll, repo);
    expect(getSavedWorkflowDirs(config)[0].dir).toBe(wf(target));
    await put(path.join(wf(target), 'own.js'), marker('OWN'));
    expect(await scriptOf('own', config)).toContain('OWN');
    const saved = await saveWorkflowScript(config, {
      name: 'fresh',
      scope: 'project',
      script: marker('FRESH'),
    });
    expect(saved).toMatchObject({
      status: 'saved',
      path: path.join(wf(target), 'fresh.js'),
    });
    await expect(fs.access(path.join(wf(repo), 'fresh.js'))).rejects.toThrow();
    // Generated scripts stay where the session's storage puts them.
    expect(getWorkflowScriptRoots(config)).toContain(
      new Storage(repo).getGeneratedWorkflowsDir(),
    );
  });

  it('saves to the target directory even when an ancestor defines the name', async () => {
    const config = configFor(target);
    const saved = await saveWorkflowScript(config, {
      name: 'shared',
      scope: 'project',
      script: marker('NEW'),
    });
    expect(saved).toMatchObject({
      status: 'saved',
      path: path.join(wf(target), 'shared.js'),
    });
    expect(
      await fs.readFile(path.join(wf(packages), 'shared.js'), 'utf8'),
    ).toContain('PACKAGES');
  });

  it('refuses to save over a symlinked project file, even with overwrite', async () => {
    const outside = path.join(base, 'outside', 'victim.js');
    await put(outside, 'ORIGINAL');
    await fs.mkdir(wf(target), { recursive: true });
    await fs.symlink(outside, path.join(wf(target), 'victim.js'));
    for (const overwrite of [false, true]) {
      await expect(
        saveWorkflowScript(configFor(target), {
          name: 'victim',
          scope: 'project',
          script: marker('X'),
          overwrite,
        }),
      ).rejects.toThrow(/symlinked workflow file/);
    }
    expect(await fs.readFile(outside, 'utf8')).toBe('ORIGINAL');
  });

  it('refuses to save through a project .qwen that links outside the repository', async () => {
    const outside = path.join(base, 'outside-qwen');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(target, '.qwen'));
    await expect(
      saveWorkflowScript(configFor(target), {
        name: 'x',
        scope: 'project',
        script: marker('X'),
      }),
    ).rejects.toThrow(/outside the project/);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    // Nor is such a directory read as the project's.
    await put(path.join(outside, 'workflows', 'leak.js'), marker('LEAK'));
    expect(
      (await listSavedWorkflows(configFor(target))).map((e) => e.name),
    ).not.toContain('leak');
  });

  it('does not let a project .qwen link promote a denied ancestor to the project scope', async () => {
    // Target trusted, root explicitly denied, a/.qwen -> ../../.qwen.
    await put(path.join(wf(repo), 'denied-root.js'), marker('DENIED_ROOT'));
    await fs.symlink(
      path.join('..', '..', '.qwen'),
      path.join(target, '.qwen'),
    );
    const config = configFor(target, async (dirs) =>
      dirs.map((dir) => dir !== repo),
    );
    expect((await listSavedWorkflows(config)).map((e) => e.name)).not.toContain(
      'denied-root',
    );
    await expect(scriptOf('denied-root', config)).rejects.toThrow(
      /no workflow with that name/,
    );
    for (const scriptPath of [
      path.join(target, '.qwen', 'workflows', 'denied-root.js'),
      path.join(wf(repo), 'denied-root.js'),
    ]) {
      await expect(
        resolveSavedWorkflowScript({ scriptPath }, config),
      ).rejects.toThrow(/outside the workflow script roots/);
    }
    // Nor can a save write through the link into the denied root.
    await expect(
      saveWorkflowScript(config, {
        name: 'denied-root',
        scope: 'project',
        script: marker('OVERWRITE'),
        overwrite: true,
      }),
    ).rejects.toThrow(/outside the project/);
    expect(
      await fs.readFile(path.join(wf(repo), 'denied-root.js'), 'utf8'),
    ).toContain('DENIED_ROOT');
    // The trusted packages directory above the target is unaffected.
    expect(await scriptOf('shared', config)).toContain('PACKAGES');
  });

  it('reads a linked ancestor only under that ancestor’s own trust decision', async () => {
    // Same link with the root trusted: the root's files are reachable as the
    // root's scope, never as the target's whole-directory project scope.
    await put(path.join(wf(repo), 'nested', 'deep.js'), marker('DEEP'));
    await fs.symlink(
      path.join('..', '..', '.qwen'),
      path.join(target, '.qwen'),
    );
    const config = configFor(target);
    expect(await scriptOf('root-only', config)).toContain('ROOT_ONLY');
    await expect(
      resolveSavedWorkflowScript(
        {
          scriptPath: path.join(
            target,
            '.qwen',
            'workflows',
            'nested',
            'deep.js',
          ),
        },
        config,
      ),
    ).rejects.toThrow(/outside the workflow script roots/);
  });

  it('refuses a project .qwen that links to a sibling inside the repository', async () => {
    const sibling = path.join(packages, 'b');
    await put(path.join(wf(sibling), 'linked.js'), marker('LINKED'));
    await fs.symlink(path.join(sibling, '.qwen'), path.join(target, '.qwen'));
    const config = configFor(target);
    await expect(scriptOf('linked', config)).rejects.toThrow(
      /no workflow with that name/,
    );
    await expect(
      saveWorkflowScript(config, {
        name: 'more',
        scope: 'project',
        script: marker('M'),
      }),
    ).rejects.toThrow(/outside the project/);
  });

  it('still allows a project .qwen that links within the target directory', async () => {
    const inner = path.join(target, 'config', 'qwen');
    await put(path.join(inner, 'workflows', 'linked.js'), marker('LINKED'));
    await fs.symlink(inner, path.join(target, '.qwen'));
    const config = configFor(target);
    expect(await scriptOf('linked', config)).toContain('LINKED');
    await expect(
      saveWorkflowScript(config, {
        name: 'more',
        scope: 'project',
        script: marker('M'),
      }),
    ).resolves.toMatchObject({ status: 'saved' });
    expect(
      await fs.readFile(path.join(inner, 'workflows', 'more.js'), 'utf8'),
    ).toContain('M');
  });

  it('keeps saving through a user-managed global config directory alias', async () => {
    const dotfiles = path.join(base, 'dotfiles-qwen');
    await fs.mkdir(dotfiles, { recursive: true });
    await fs.symlink(dotfiles, path.join(base, 'aliased-home'));
    process.env['QWEN_HOME'] = path.join(base, 'aliased-home');
    await expect(
      saveWorkflowScript(configFor(target), {
        name: 'mine',
        scope: 'user',
        script: marker('MINE'),
      }),
    ).resolves.toMatchObject({ status: 'saved' });
    expect(
      await fs.readFile(path.join(dotfiles, 'workflows', 'mine.js'), 'utf8'),
    ).toContain('MINE');
  });
});
