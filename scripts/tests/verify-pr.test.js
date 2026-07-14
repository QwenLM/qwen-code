/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNode22,
  assertSupportedHost,
  createGitEnvironment,
  createPythonSteps,
  createStepEnvironment,
  createValidationSteps,
  getVenvPythonPath,
  needsPythonChecks,
  inspectRepository,
  parseArgs,
  runCli,
  runSteps,
  selectProfile,
  verifyPullRequest,
  withTemporaryWorktree,
} from '../verify-pr.js';

const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd, args, baseEnv = process.env) {
  const result = spawnSync('git', ['-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: createGitEnvironment(baseEnv, {
      home: cwd,
      hooksPath: '/dev/null',
    }),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function createRepository(baseEnv = process.env) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'verify-pr-test-'));
  tempDirs.push(cwd);
  const template = path.join(cwd, '.git-template');
  mkdirSync(template);
  git(cwd, ['init', '--quiet', `--template=${template}`], baseEnv);
  rmSync(template, { recursive: true });
  git(cwd, ['config', 'user.email', 'verify-pr@example.com'], baseEnv);
  git(cwd, ['config', 'user.name', 'Verify PR Test'], baseEnv);
  writeFileSync(path.join(cwd, 'README.md'), 'initial\n');
  git(cwd, ['add', 'README.md'], baseEnv);
  git(cwd, ['commit', '--quiet', '-m', 'initial'], baseEnv);
  writeFileSync(path.join(cwd, 'source.js'), 'export {};\n');
  git(cwd, ['add', 'source.js'], baseEnv);
  git(cwd, ['commit', '--quiet', '-m', 'change'], baseEnv);
  return cwd;
}

async function captureValidation({ baseEnv, changedFiles, worktree }) {
  let execution;
  await verifyPullRequest(
    { base: 'origin/main', cwd: '/caller', requestedProfile: 'full' },
    {
      baseEnv,
      inspect: () => ({
        baseSha: '1'.repeat(40),
        changedFiles,
        head: '2'.repeat(40),
        mergeBase: '1'.repeat(40),
      }),
      log: () => {},
      nodeVersion: '22.17.0',
      runValidationSteps: async (options) => {
        execution = options;
      },
      temporaryWorktree: async ({ head, validate }) => {
        expect(head).toBe('2'.repeat(40));
        return validate({
          container: '/owned/container',
          home: '/owned/home',
          hooks: '/owned/hooks',
          pythonRoot: '/owned/python',
          temp: '/owned/tmp',
          worktree,
        });
      },
    },
  );
  return execution;
}

describe('verify-pr CLI', () => {
  it('uses the full profile against origin/main by default', () => {
    expect(parseArgs([])).toEqual({
      base: 'origin/main',
      help: false,
      profile: 'full',
    });
  });

  it('accepts base and profile overrides', () => {
    expect(
      parseArgs(['--base', 'origin/release/1.x', '--profile', 'auto']),
    ).toEqual({
      base: 'origin/release/1.x',
      help: false,
      profile: 'auto',
    });
  });

  it('recognizes help', () => {
    expect(parseArgs(['--help'])).toEqual({
      base: 'origin/main',
      help: true,
      profile: 'full',
    });
  });

  it.each([
    ['missing base value', ['--base']],
    ['missing profile value', ['--profile']],
    ['option used as a base value', ['--base', '--help']],
    ['invalid profile', ['--profile', 'quick']],
    ['positional argument', ['main']],
    ['unknown option', ['--dirty-worktree']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it('prints help without starting verification', async () => {
    const output = [];
    let verified = false;
    const exitCode = await runCli(['--help'], {
      log: (message) => output.push(message),
      verify: async () => {
        verified = true;
      },
    });

    expect(exitCode).toBe(0);
    expect(verified).toBe(false);
    expect(output.join('\n')).toMatch(/--base <ref>.*--profile <full\|auto>/s);
  });

  it('runs the real entry point for help and invalid arguments', () => {
    const script = path.resolve('scripts/verify-pr.js');
    const help = spawnSync(process.execPath, [script, '--help'], {
      encoding: 'utf8',
    });
    const invalid = spawnSync(process.execPath, [script, '--unknown'], {
      encoding: 'utf8',
    });

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('npm run verify:pr');
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/Unknown option.*Usage:/s);
  });

  it('reports failure context and a single-step rerun hint', async () => {
    const errors = [];
    const exitCode = await runCli([], {
      error: (message) => errors.push(message),
      log: () => {},
      verify: async () => {
        throw Object.assign(new Error('unit tests failed'), {
          base: 'origin/main',
          command: ['npm', 'run', 'test:ci'],
          detail: 'exited with status 7',
          exitCode: 7,
          head: 'a'.repeat(40),
          profile: 'full',
          stage: 'Run unit tests',
        });
      },
    });

    expect(exitCode).toBe(7);
    expect(errors.join('\n')).toMatch(
      /Stage: Run unit tests.*Command: npm run test:ci.*HEAD: a{40}.*Base: origin\/main.*Profile: full.*Rerun: npm run verify:pr -- --base origin\/main --profile full/s,
    );
  });

  it('relays a child signal after printing failure diagnostics', async () => {
    const events = [];
    const exitCode = await runCli([], {
      error: (message) => events.push(`error:${message}`),
      log: () => {},
      relaySignal: (signal) => events.push(`signal:${signal}`),
      verify: async () => {
        throw Object.assign(new Error('terminated'), {
          command: ['npm', 'run', 'test:ci'],
          detail: 'terminated by signal SIGTERM',
          relaySignal: 'SIGTERM',
          signal: 'SIGTERM',
          stage: 'Run unit tests',
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(events.at(-1)).toBe('signal:SIGTERM');
    expect(events.slice(0, -1).join('\n')).toMatch(
      /error:PR verification failed.*error:Error: terminated by signal SIGTERM/s,
    );
  });

  it('uses a conventional exit code for a child-only signal', async () => {
    let relayed = false;
    const exitCode = await runCli([], {
      error: () => {},
      log: () => {},
      relaySignal: () => {
        relayed = true;
      },
      verify: async () => {
        throw Object.assign(new Error('terminated'), {
          command: ['node', 'child.js'],
          detail: 'terminated by signal SIGPIPE',
          exitCode: 141,
          signal: 'SIGPIPE',
          stage: 'Run child',
        });
      },
    });

    expect(exitCode).toBe(141);
    expect(relayed).toBe(false);
  });
});

describe('caller guards', () => {
  it('requires Node 22', () => {
    expect(() => assertNode22('22.17.0')).not.toThrow();
    expect(() => assertNode22('20.19.0')).toThrow(/Node 22/);
    expect(() => assertNode22('23.0.0')).toThrow(/Node 22/);
  });

  it('rejects hosts that the pinned linter toolchain does not support', () => {
    expect(() => assertSupportedHost('darwin', 'arm64')).not.toThrow();
    expect(() => assertSupportedHost('linux', 'x64')).not.toThrow();
    expect(() => assertSupportedHost('win32', 'x64')).toThrow(
      /supports macOS.*Linux x64.*GitHub CI/i,
    );
    expect(() => assertSupportedHost('linux', 'arm64')).toThrow(
      /supports macOS.*Linux x64.*GitHub CI/i,
    );
  });

  it('isolates fixture commits from global signing and hooks', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'verify-pr-git-config-'));
    tempDirs.push(root);
    const hooks = path.join(root, 'hooks');
    const marker = path.join(root, 'hook-ran');
    const config = path.join(root, 'gitconfig');
    mkdirSync(hooks);
    const hook = path.join(hooks, 'post-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(
      config,
      `[commit]\n\tgpgSign = true\n[core]\n\thooksPath = ${hooks}\n`,
    );

    const cwd = createRepository({
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
    });

    expect(git(cwd, ['log', '--oneline'])).toContain('change');
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves the real Git path required by a PATH wrapper',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'verify-pr-git-wrapper-'));
      tempDirs.push(root);
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      const wrapper = path.join(bin, 'git');
      writeFileSync(wrapper, '#!/bin/sh\nexec "$QWEN_CI_REAL_GIT" "$@"\n');
      chmodSync(wrapper, 0o755);
      const realGit =
        process.env.QWEN_CI_REAL_GIT ||
        spawnSync('sh', ['-c', 'command -v git'], {
          encoding: 'utf8',
          env: process.env,
        }).stdout.trim();

      const cwd = createRepository({
        ...process.env,
        PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
        QWEN_CI_REAL_GIT: realGit,
      });

      expect(git(cwd, ['log', '--oneline'])).toContain('change');
    },
  );

  it('resolves the base and reports committed changed paths', () => {
    const cwd = createRepository();

    const repository = inspectRepository({ base: 'HEAD^', cwd });

    expect(repository.head).toBe(git(cwd, ['rev-parse', 'HEAD']));
    expect(repository.baseSha).toBe(git(cwd, ['rev-parse', 'HEAD^']));
    expect(repository.mergeBase).toBe(
      git(cwd, ['merge-base', 'HEAD^', 'HEAD']),
    );
    expect(repository.changedFiles).toEqual(['source.js']);
  });

  it('ignores Git routing variables when inspecting the caller', () => {
    const caller = createRepository();
    const other = createRepository();
    writeFileSync(path.join(caller, 'source.js'), 'dirty\n');

    expect(() =>
      inspectRepository({
        base: 'HEAD^',
        cwd: caller,
        env: {
          ...process.env,
          GIT_DIR: path.join(other, '.git'),
          GIT_INDEX_FILE: path.join(other, '.git', 'index'),
          GIT_WORK_TREE: other,
        },
      }),
    ).toThrow(/working tree/);
  });

  it.each(['staged', 'unstaged', 'untracked'])(
    'rejects a %s caller change before resolving the base',
    (kind) => {
      const cwd = createRepository();
      const filename = kind === 'untracked' ? 'new.txt' : 'source.js';
      writeFileSync(path.join(cwd, filename), `${kind}\n`);
      if (kind === 'staged') git(cwd, ['add', filename]);

      expect(() => inspectRepository({ base: 'missing-ref', cwd })).toThrow(
        /working tree.*staged.*unstaged.*untracked/i,
      );
    },
  );

  it('rejects an unresolved base ref', () => {
    const cwd = createRepository();

    expect(() => inspectRepository({ base: 'missing-ref', cwd })).toThrow(
      /missing-ref/,
    );
  });

  it('requires a committed change against the merge base', () => {
    const cwd = createRepository();

    expect(() => inspectRepository({ base: 'HEAD', cwd })).toThrow(
      /No committed changes/,
    );
  });
});

describe('profile selection', () => {
  it('keeps the default full profile without classifying paths', () => {
    let classified = false;

    expect(
      selectProfile({
        changedFiles: ['docs/guide.md'],
        classify: () => {
          classified = true;
          return 'docs_only';
        },
        requestedProfile: 'full',
      }),
    ).toBe('full');
    expect(classified).toBe(false);
  });

  it.each([
    [['docs/guide.md'], 'docs_only'],
    [['.github/scripts/pr-safety-precheck.mjs'], 'github_ci_only'],
    [['packages/core/src/index.ts'], 'full'],
    [['docs/guide.md', 'packages/core/src/index.ts'], 'full'],
  ])('classifies auto profile changes %j as %s', (changedFiles, expected) => {
    expect(selectProfile({ changedFiles, requestedProfile: 'auto' })).toBe(
      expected,
    );
  });

  it('treats both sides of a cross-profile rename as changed', () => {
    const cwd = createRepository();
    mkdirSync(path.join(cwd, 'docs'));
    writeFileSync(path.join(cwd, 'docs', 'guide.md'), 'guide\n');
    git(cwd, ['add', 'docs/guide.md']);
    git(cwd, ['commit', '--quiet', '-m', 'add docs']);
    mkdirSync(path.join(cwd, 'packages', 'core'), { recursive: true });
    git(cwd, ['mv', 'docs/guide.md', 'packages/core/guide.ts']);
    git(cwd, ['commit', '--quiet', '-m', 'rename docs to source']);

    const { changedFiles } = inspectRepository({ base: 'HEAD^', cwd });

    expect(changedFiles).toEqual(['docs/guide.md', 'packages/core/guide.ts']);
    expect(selectProfile({ changedFiles, requestedProfile: 'auto' })).toBe(
      'full',
    );
  });
});

describe('validation profiles', () => {
  it('uses the exact dependency-free GitHub CI helper checks', () => {
    expect(
      createValidationSteps({ profile: 'github_ci_only' }).map(
        ({ command }) => command,
      ),
    ).toEqual([
      ['node', 'scripts/lint.js', '--setup'],
      ['node', 'scripts/lint.js', '--actionlint'],
      ['node', 'scripts/lint.js', '--yamllint'],
      [
        'node',
        '--test',
        '.github/scripts/pr-safety-precheck.test.mjs',
        '.github/scripts/ci/classify-profile.test.mjs',
        '.github/scripts/resolve-sandbox-image.test.mjs',
      ],
    ]);
  });

  it('uses the exact full validation sequence without a redundant build', () => {
    expect(
      createValidationSteps({
        prettierFiles: ['scripts/verify-pr.js'],
        profile: 'full',
      }).map(({ command }) => command),
    ).toEqual([
      [
        'npm',
        'ci',
        '--prefer-offline',
        '--no-audit',
        '--progress=false',
        '--ignore-scripts=false',
      ],
      ['npm', 'run', 'audit:runtime:critical'],
      ['npm', 'run', 'check:lockfile'],
      ['npm', 'run', 'check:desktop-isolation'],
      ['node', 'scripts/lint.js', '--setup'],
      ['node', 'scripts/lint.js', '--eslint'],
      ['node', 'scripts/lint.js', '--actionlint'],
      ['node', 'scripts/lint.js', '--shellcheck'],
      ['node', 'scripts/lint.js', '--yamllint'],
      [
        'node',
        '--test',
        '.github/scripts/pr-safety-precheck.test.mjs',
        '.github/scripts/ci/classify-profile.test.mjs',
        '.github/scripts/resolve-sandbox-image.test.mjs',
      ],
      [
        'npx',
        'prettier',
        '--experimental-cli',
        '--check',
        '--ignore-unknown',
        '--',
        'scripts/verify-pr.js',
      ],
      ['npm', 'run', 'check-i18n'],
      ['npm', 'run', 'generate:settings-schema', '--', '--check'],
      [
        'git',
        'cat-file',
        '-e',
        'HEAD:packages/vscode-ide-companion/schemas/settings.schema.json',
      ],
      [
        'git',
        'diff',
        '--exit-code',
        'HEAD',
        '--',
        'packages/vscode-ide-companion/schemas/settings.schema.json',
      ],
      ['npm', 'run', 'typecheck'],
      ['npm', 'run', 'check:serve-fast-path-bundle'],
      [
        'npx',
        'cross-env',
        'NODE_OPTIONS=--max-old-space-size=3072',
        'npm',
        'run',
        'test:ci',
        '--workspaces',
        '--if-present',
        '--',
        '--no-file-parallelism',
      ],
      ['npm', 'run', 'test:scripts', '--', '--no-file-parallelism'],
      ['npm', 'run', 'test:integration:no-ak:sandbox:none'],
      ['npx', 'playwright', 'install', 'chromium'],
      ['npm', 'run', 'test:e2e:smoke', '--workspace=packages/web-shell'],
    ]);
  });

  it('omits Prettier when there are no existing changed files', () => {
    const steps = createValidationSteps({ profile: 'full' });

    expect(steps.map(({ name }) => name)).not.toContain('Run Prettier');
    expect(
      steps.find(({ name }) => name === 'Install dependencies'),
    ).toMatchObject({ installEnvironment: true });
    expect(
      steps.find(({ name }) => name === 'Run web shell smoke tests'),
    ).toMatchObject({ playwright: true, playwrightEnvironment: true });
  });

  it('adds Python checks only for SDK or workflow changes', () => {
    expect(needsPythonChecks(['packages/sdk-python/src/client.py'])).toBe(true);
    expect(needsPythonChecks(['.github/workflows/sdk-python.yml'])).toBe(true);
    expect(needsPythonChecks(['packages/core/src/index.ts'])).toBe(false);
  });

  it('uses the platform-specific virtualenv Python path', () => {
    expect(getVenvPythonPath('/tmp/venv', 'linux')).toBe(
      path.join('/tmp/venv', 'bin', 'python'),
    );
    expect(getVenvPythonPath('C:\\venv', 'win32')).toBe(
      path.join('C:\\venv', 'Scripts', 'python.exe'),
    );
  });

  it('expands the Python checks for 3.10, 3.11, and 3.12', () => {
    const pythonRoot = path.join('/tmp', 'verify-pr-python');
    const commands = createPythonSteps({
      platform: 'linux',
      pythonRoot,
    }).map(({ command }) => command);
    const expected = [['uv', '--version']];
    for (const version of ['3.10', '3.11', '3.12']) {
      const venv = path.join(pythonRoot, version);
      const python = path.join(venv, 'bin', 'python');
      expected.push(
        ['uv', 'venv', '--python', version, '--seed', venv],
        [python, '-m', 'pip', 'install', '--upgrade', 'pip'],
        [python, '-m', 'pip', 'install', '-e', 'packages/sdk-python[dev]'],
        [
          python,
          '-m',
          'ruff',
          'check',
          '--config',
          'packages/sdk-python/pyproject.toml',
          'packages/sdk-python',
        ],
        [
          python,
          '-m',
          'ruff',
          'format',
          '--check',
          '--config',
          'packages/sdk-python/pyproject.toml',
          'packages/sdk-python',
        ],
        [
          python,
          '-m',
          'mypy',
          '--config-file',
          'packages/sdk-python/pyproject.toml',
          'packages/sdk-python/src',
        ],
        [
          python,
          '-m',
          'pytest',
          '-c',
          'packages/sdk-python/pyproject.toml',
          'packages/sdk-python/tests',
          '-q',
        ],
      );
    }
    expect(commands).toEqual(expected);
    expect(
      createPythonSteps({ platform: 'linux', pythonRoot }).every(
        (pythonStep) => pythonStep.pythonEnvironment,
      ),
    ).toBe(true);
  });
});

describe('step execution', () => {
  it('uses a controlled environment and isolated HOME for every step', () => {
    const steps = [
      ...createValidationSteps({ profile: 'full' }),
      ...createPythonSteps({ pythonRoot: '/owned/python' }),
    ];
    const baseEnv = {
      HOME: '/caller/home',
      HTTPS_PROXY: 'http://proxy.example',
      NPM_CONFIG_GLOBAL: 'true',
      NODE_ENV: 'production',
      OPENAI_API_KEY: 'secret',
      PATH: '/usr/bin',
      PIP_REQUIRE_VIRTUALENV: 'true',
      PLAYWRIGHT_BROWSERS_PATH: '/caller/browsers',
      PYTEST_ADDOPTS: '--collect-only',
      QwEn_OaUtH: 'secret',
      QWEN_HOME: '/caller/qwen',
      SAFE: 'must-not-pass',
      SHELL: '/caller/shell',
      TZ: 'Pacific/Honolulu',
      USER: 'caller',
      USERPROFILE: '/caller/profile',
      XAI_API_KEY: 'secret',
    };

    for (const currentStep of steps) {
      const env = createStepEnvironment({
        baseEnv,
        home: '/owned/home',
        playwrightPort: currentStep.playwright ? 43123 : undefined,
        step: currentStep,
      });
      expect(env).toMatchObject({
        CI: 'true',
        HOME: '/owned/home',
        HTTPS_PROXY: 'http://proxy.example',
        LANG: 'C',
        LC_ALL: 'C',
        NPM_CONFIG_GLOBAL: 'false',
        NPM_CONFIG_GLOBALCONFIG: '/dev/null',
        NPM_CONFIG_CACHE: path.join('/owned/home', '.npm'),
        NPM_CONFIG_PREFIX: path.join('/owned/home', '.npm-prefix'),
        NPM_CONFIG_USERCONFIG: path.join('/owned/home', '.npmrc'),
        NO_COLOR: 'true',
        PATH: '/usr/bin',
        TZ: 'UTC',
        USERPROFILE: '/owned/home',
      });
      for (const key of [
        'NODE_ENV',
        'OPENAI_API_KEY',
        'PYTEST_ADDOPTS',
        'QwEn_OaUtH',
        'QWEN_HOME',
        'SAFE',
        'SHELL',
        'USER',
        'XAI_API_KEY',
      ]) {
        expect(env).not.toHaveProperty(key);
      }
      if (currentStep.playwrightEnvironment) {
        expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(
          path.join('/owned/home', 'playwright'),
        );
      } else {
        expect(env).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
      }
      if (currentStep.pythonEnvironment) {
        expect(env).toMatchObject({
          PIP_CONFIG_FILE: '/dev/null',
          PIP_REQUIRE_VIRTUALENV: 'false',
          PIP_USER: 'false',
          PYTHONNOUSERSITE: '1',
          UV_NO_CONFIG: '1',
        });
      } else {
        expect(env).not.toHaveProperty('PIP_REQUIRE_VIRTUALENV');
      }
      expect(env.PLAYWRIGHT_PORT).toBe(
        currentStep.playwright ? '43123' : undefined,
      );
    }
  });

  it('preserves a numeric exit code and stops at the first failure', async () => {
    const steps = createValidationSteps({ profile: 'github_ci_only' });
    const commands = [];

    await expect(
      runSteps({
        allocatePort: async () => 43123,
        baseEnv: {},
        cwd: '/temporary-worktree',
        execute: ({ command }) => {
          commands.push(command.join(' '));
          return { status: commands.length === 2 ? 7 : 0 };
        },
        home: '/temporary-home',
        log: () => {},
        steps,
      }),
    ).rejects.toMatchObject({
      command: steps[1].command,
      exitCode: 7,
      stage: steps[1].name,
    });
    expect(commands).toEqual(
      steps.slice(0, 2).map(({ command }) => command.join(' ')),
    );
  });

  it.each([
    [
      'spawn error',
      { error: new Error('command not found'), status: null },
      /spawn error: command not found/,
      1,
    ],
    ['signal', { signal: 'SIGTERM', status: null }, /signal SIGTERM/, 143],
  ])(
    'reports a %s as a non-zero failure',
    async (_label, result, message, exitCode) => {
      await expect(
        runSteps({
          allocatePort: async () => 43123,
          baseEnv: {},
          cwd: '/temporary-worktree',
          execute: () => result,
          home: '/temporary-home',
          log: () => {},
          steps: createValidationSteps({ profile: 'github_ci_only' }).slice(
            0,
            1,
          ),
        }),
      ).rejects.toMatchObject({
        detail: expect.stringMatching(message),
        exitCode,
      });
    },
  );

  it('reports an actionable error when uv is unavailable', async () => {
    await expect(
      runSteps({
        allocatePort: async () => 43123,
        baseEnv: {},
        cwd: '/temporary-worktree',
        execute: () => ({
          error: Object.assign(new Error('spawn uv ENOENT'), {
            code: 'ENOENT',
          }),
          status: null,
        }),
        home: '/temporary-home',
        log: () => {},
        steps: createPythonSteps({ pythonRoot: '/temporary-python' }).slice(
          0,
          1,
        ),
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/uv is required.*Install uv.*PATH/i),
    });
  });

  it('allocates the Playwright port immediately before its step', async () => {
    const events = [];
    const steps = createValidationSteps({ profile: 'full' }).filter(
      ({ name }) =>
        name === 'Install Playwright Chromium' ||
        name === 'Run web shell smoke tests',
    );

    await runSteps({
      allocatePort: async () => {
        events.push('allocate');
        return 43123;
      },
      baseEnv: {},
      cwd: '/temporary-worktree',
      execute: ({ command, env }) => {
        events.push({ command: command.join(' '), port: env.PLAYWRIGHT_PORT });
        return { status: 0 };
      },
      home: '/temporary-home',
      log: () => {},
      steps,
    });

    expect(events.slice(-2)).toEqual([
      'allocate',
      {
        command: 'npm run test:e2e:smoke --workspace=packages/web-shell',
        port: '43123',
      },
    ]);
  });

  it('attributes Playwright port allocation failures to the current step', async () => {
    const step = createValidationSteps({ profile: 'full' }).find(
      ({ playwright }) => playwright,
    );

    await expect(
      runSteps({
        allocatePort: async () => {
          throw new Error('bind failed');
        },
        baseEnv: {},
        cwd: '/temporary-worktree',
        execute: () => {
          throw new Error('must not execute');
        },
        home: '/temporary-home',
        log: () => {},
        steps: [step],
      }),
    ).rejects.toMatchObject({
      command: step.command,
      detail: expect.stringMatching(/Playwright port.*bind failed/),
      stage: step.name,
    });
  });

  it('escapes control characters only in command display', async () => {
    const command = [
      'npx',
      'prettier',
      'bad\u001b]52;c;payload\u0007\nname.js',
    ];
    const output = [];
    let executed;

    await runSteps({
      allocatePort: async () => 43123,
      baseEnv: {},
      cwd: '/temporary-worktree',
      execute: ({ command: childCommand }) => {
        executed = childCommand;
        return { status: 0 };
      },
      home: '/temporary-home',
      log: (message) => output.push(message),
      steps: [{ command, name: 'Display unsafe path' }],
    });

    expect(executed).toEqual(command);
    const display = output.join(' ');
    expect(
      [...display].every((character) => {
        const codePoint = character.codePointAt(0);
        return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
      }),
    ).toBe(true);
    expect(display).toContain('\\u{1b}');
    expect(display).toContain('\\u{a}');
  });

  it('rejects a schema rewritten before the committed freshness check', async () => {
    const cwd = createRepository();
    const schemaPath = path.join(
      cwd,
      'packages',
      'vscode-ide-companion',
      'schemas',
      'settings.schema.json',
    );
    mkdirSync(path.dirname(schemaPath), { recursive: true });
    writeFileSync(schemaPath, 'committed schema\n');
    git(cwd, ['add', schemaPath]);
    git(cwd, ['commit', '--quiet', '-m', 'add schema']);
    writeFileSync(schemaPath, 'schema rewritten by build\n');
    git(cwd, ['add', schemaPath]);
    const steps = createValidationSteps({ profile: 'full' }).filter(
      ({ name }) =>
        name === 'Ensure settings schema is committed' ||
        name === 'Check committed settings schema',
    );

    await expect(
      runSteps({
        allocatePort: async () => 43123,
        baseEnv: process.env,
        cwd,
        home: '/temporary-home',
        log: () => {},
        steps,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      stage: 'Check committed settings schema',
    });
  });

  it('rejects a generated schema that is not tracked at HEAD', async () => {
    const cwd = createRepository();
    const schemaPath = path.join(
      cwd,
      'packages',
      'vscode-ide-companion',
      'schemas',
      'settings.schema.json',
    );
    mkdirSync(path.dirname(schemaPath), { recursive: true });
    writeFileSync(schemaPath, 'untracked generated schema\n');
    const steps = createValidationSteps({ profile: 'full' }).filter(
      ({ name }) => name === 'Ensure settings schema is committed',
    );

    await expect(
      runSteps({
        allocatePort: async () => 43123,
        baseEnv: process.env,
        cwd,
        home: '/temporary-home',
        log: () => {},
        steps,
      }),
    ).rejects.toMatchObject({
      exitCode: 128,
      stage: 'Ensure settings schema is committed',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'cleans an owned worktree before relaying a real termination signal',
    async () => {
      const cwd = createRepository();
      const head = git(cwd, ['rev-parse', 'HEAD']);
      const harnessRoot = mkdtempSync(path.join(tmpdir(), 'verify-pr-signal-'));
      tempDirs.push(harnessRoot);
      const marker = path.join(harnessRoot, 'cleanup.json');
      const moduleUrl = new URL('../verify-pr.js', import.meta.url).href;
      const harnessScript = `
        import { existsSync, writeFileSync } from 'node:fs';
        import { spawnSync } from 'node:child_process';
        import { runSteps, withTemporaryWorktree } from ${JSON.stringify(moduleUrl)};

        let ownedPaths;
        let relayedSignal;
        try {
          await withTemporaryWorktree({
            cwd: process.cwd(),
            head: ${JSON.stringify(head)},
            validate: async (paths) => {
              ownedPaths = paths;
              await runSteps({
                allocatePort: async () => 43123,
                baseEnv: process.env,
                cwd: paths.worktree,
                home: paths.home,
                log: () => {},
                steps: [{
                  command: [
                    process.execPath,
                    '--input-type=module',
                    '--eval',
                    'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);',
                  ],
                  name: 'Wait for signal',
                }],
              });
            },
          });
        } catch (error) {
          relayedSignal = error.signal;
        }

        const registrations = spawnSync(
          'git',
          ['worktree', 'list', '--porcelain'],
          { cwd: process.cwd(), encoding: 'utf8' },
        ).stdout;
        writeFileSync(
          ${JSON.stringify(marker)},
          JSON.stringify({
            containerExists: existsSync(ownedPaths.container),
            registered: registrations.includes(ownedPaths.worktree),
            signal: relayedSignal,
          }),
        );
        process.kill(process.pid, relayedSignal);
      `;
      const harness = spawn(
        process.execPath,
        ['--input-type=module', '--eval', harnessScript],
        {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      harness.stdout.setEncoding('utf8');
      harness.stderr.setEncoding('utf8');
      harness.stdout.on('data', (chunk) => {
        output += chunk;
      });
      harness.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const completion = new Promise((resolve) => {
        harness.once('exit', (code, signal) => resolve({ code, signal }));
      });
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Signal harness did not start:\n${output}`)),
            10_000,
          );
          const checkReady = () => {
            if (!output.includes('READY')) return;
            clearTimeout(timeout);
            harness.stdout.off('data', checkReady);
            resolve();
          };
          harness.stdout.on('data', checkReady);
          checkReady();
        });

        harness.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 50));
        harness.kill('SIGTERM');
        const result = await completion;

        expect(result).toEqual({ code: null, signal: 'SIGTERM' });
        expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
          containerExists: false,
          registered: false,
          signal: 'SIGTERM',
        });
      } finally {
        if (harness.exitCode === null && harness.signalCode === null) {
          harness.kill('SIGKILL');
          await completion;
        }
      }
    },
    15_000,
  );

  it('uses CI-equivalent npm fetch settings only for npm ci', () => {
    const steps = createValidationSteps({ profile: 'full' });
    const installEnv = createStepEnvironment({
      baseEnv: {
        HUSKY: 'caller-value',
        NPM_CONFIG_GLOBAL: 'true',
        QWEN_SKIP_PREPARE: '1',
        npm_config_ignore_scripts: 'true',
      },
      home: '/temporary-home',
      step: steps[0],
    });
    expect(installEnv).toMatchObject({
      HUSKY: '0',
      NPM_CONFIG_FETCH_RETRIES: '5',
      NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '120000',
      NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '20000',
      NPM_CONFIG_FETCH_TIMEOUT: '300000',
      NPM_CONFIG_GLOBAL: 'false',
      NPM_CONFIG_IGNORE_SCRIPTS: 'false',
    });
    for (const key of ['QWEN_SKIP_PREPARE', 'npm_config_ignore_scripts']) {
      expect(installEnv).not.toHaveProperty(key);
    }
    const laterEnv = createStepEnvironment({
      baseEnv: { HUSKY: 'caller-value', QWEN_SKIP_PREPARE: '1' },
      home: '/temporary-home',
      step: steps[1],
    });
    expect(laterEnv).not.toHaveProperty('NPM_CONFIG_FETCH_RETRIES');
    expect(laterEnv).not.toHaveProperty('HUSKY');
    expect(laterEnv).not.toHaveProperty('QWEN_SKIP_PREPARE');
  });
});

describe('temporary worktree isolation', () => {
  it('checks out the inspected SHA without running caller checkout hooks', async () => {
    const cwd = createRepository();
    const inspectedHead = git(cwd, ['rev-parse', 'HEAD']);
    const root = mkdtempSync(path.join(tmpdir(), 'verify-pr-hooks-'));
    tempDirs.push(root);
    const hooks = path.join(root, 'hooks');
    const marker = path.join(root, 'post-checkout-ran');
    mkdirSync(hooks);
    const hook = path.join(hooks, 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(path.join(cwd, 'source.js'), 'new head\n');
    git(cwd, ['add', 'source.js']);
    git(cwd, ['commit', '--quiet', '-m', 'move head']);

    await withTemporaryWorktree({
      baseEnv: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: hooks,
      },
      cwd,
      head: inspectedHead,
      validate: async (paths) => {
        expect(
          readFileSync(path.join(paths.worktree, 'source.js'), 'utf8'),
        ).toBe('export {};\n');
      },
    });

    expect(existsSync(marker)).toBe(false);
  });

  it('cleans the created container when canonicalization fails', async () => {
    const cwd = createRepository();
    const created = path.join(
      tmpdir(),
      `verify-pr-loop-${process.pid}-${Date.now()}`,
    );
    symlinkSync(created, created);
    tempDirs.push(created);
    const removed = [];

    await expect(
      withTemporaryWorktree({
        cwd,
        head: git(cwd, ['rev-parse', 'HEAD']),
        makeContainer: () => created,
        removeContainer: (container) => removed.push(container),
        validate: async () => {},
      }),
    ).rejects.toThrow();

    expect(removed).toEqual([created]);
  });

  it('runs prepare during the first npm ci despite caller skip settings', async () => {
    const cwd = createRepository();
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'verify-pr-install-fixture',
        private: true,
        scripts: { prepare: 'node prepare.mjs' },
        type: 'module',
        version: '1.0.0',
      }),
    );
    writeFileSync(
      path.join(cwd, 'prepare.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync('prepare-marker.json', JSON.stringify({
  husky: process.env.HUSKY ?? null,
  ignoreScripts: process.env.npm_config_ignore_scripts ?? null,
  skipPrepare: process.env.QWEN_SKIP_PREPARE ?? null,
}));
`,
    );
    const npmHome = mkdtempSync(path.join(tmpdir(), 'verify-pr-npm-home-'));
    tempDirs.push(npmHome);
    const lockResult = spawnSync(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts'],
      {
        cwd,
        encoding: 'utf8',
        env: createStepEnvironment({
          baseEnv: process.env,
          home: npmHome,
          step: { installEnvironment: true },
        }),
      },
    );
    expect(lockResult.status, lockResult.stderr).toBe(0);
    git(cwd, ['add', 'package.json', 'package-lock.json', 'prepare.mjs']);
    git(cwd, ['commit', '--quiet', '-m', 'add install fixture']);
    let marker;
    let ownedContainer;

    await withTemporaryWorktree({
      cwd,
      head: git(cwd, ['rev-parse', 'HEAD']),
      validate: async (paths) => {
        ownedContainer = paths.container;
        await runSteps({
          allocatePort: async () => 43123,
          baseEnv: {
            ...process.env,
            HUSKY: 'caller-value',
            QWEN_SKIP_PREPARE: '1',
            npm_config_ignore_scripts: 'true',
          },
          cwd: paths.worktree,
          home: paths.home,
          log: () => {},
          steps: createValidationSteps({ profile: 'full' }).slice(0, 1),
        });
        marker = JSON.parse(
          readFileSync(
            path.join(paths.worktree, 'prepare-marker.json'),
            'utf8',
          ),
        );
      },
    });

    expect(marker).toMatchObject({
      husky: '0',
      skipPrepare: null,
    });
    expect(marker.ignoreScripts).not.toBe('true');
    expect(existsSync(path.join(cwd, 'prepare-marker.json'))).toBe(false);
    expect(git(cwd, ['status', '--porcelain'])).toBe('');
    expect(existsSync(ownedContainer)).toBe(false);
  });

  it('keeps the caller worktree unchanged and removes owned temporary files', async () => {
    const cwd = createRepository();
    let ownedPaths;

    await withTemporaryWorktree({
      cwd,
      head: git(cwd, ['rev-parse', 'HEAD']),
      validate: async (paths) => {
        ownedPaths = paths;
        expect(paths.container).toBe(realpathSync(paths.container));
        expect(path.dirname(paths.container)).toBe(
          realpathSync(process.platform === 'win32' ? tmpdir() : '/tmp'),
        );
        expect(existsSync(paths.temp)).toBe(true);
        writeFileSync(path.join(paths.worktree, 'source.js'), 'changed\n');
      },
    });

    expect(readFileSync(path.join(cwd, 'source.js'), 'utf8')).toBe(
      'export {};\n',
    );
    expect(existsSync(ownedPaths.container)).toBe(false);
    expect(git(cwd, ['worktree', 'list', '--porcelain'])).not.toContain(
      ownedPaths.worktree,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'uses short canonical temporary paths instead of a long caller TMPDIR',
    async () => {
      const cwd = createRepository();
      const longTemp = path.join(cwd, 'a'.repeat(120));
      mkdirSync(longTemp);
      const previousTemp = process.env.TMPDIR;
      let container;

      process.env.TMPDIR = longTemp;
      try {
        await withTemporaryWorktree({
          cwd,
          head: git(cwd, ['rev-parse', 'HEAD']),
          validate: async (paths) => {
            container = paths.container;
          },
        });
      } finally {
        if (previousTemp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTemp;
      }

      expect(path.dirname(container)).toBe(realpathSync('/tmp'));
    },
  );

  it('fails when owned-worktree cleanup fails after validation succeeds', async () => {
    const cwd = createRepository();
    const commands = [];

    await expect(
      withTemporaryWorktree({
        cwd,
        head: git(cwd, ['rev-parse', 'HEAD']),
        gitCommand: ({ args, cwd: gitCwd, env }) => {
          commands.push(args);
          if (args[1] === 'remove') return { status: 9 };
          return spawnSync('git', args, { cwd: gitCwd, env });
        },
        validate: async () => {},
      }),
    ).rejects.toMatchObject({
      exitCode: 9,
      stage: 'Clean up temporary worktree',
    });
    expect(commands.at(-1).slice(0, 4)).toEqual([
      'worktree',
      'remove',
      '--force',
      '--force',
    ]);
    git(cwd, ['worktree', 'prune']);
  });

  it('preserves validation status and reports a simultaneous cleanup failure', async () => {
    const cwd = createRepository();
    const validationFailure = Object.assign(new Error('validation failed'), {
      exitCode: 7,
    });
    const cleanupReports = [];
    const ownedContainer = mkdtempSync(
      path.join(tmpdir(), 'verify-pr-cleanup-'),
    );
    tempDirs.push(ownedContainer);
    let caught;

    try {
      await withTemporaryWorktree({
        cwd,
        head: git(cwd, ['rev-parse', 'HEAD']),
        gitCommand: ({ args, cwd: gitCwd, env }) =>
          args[1] === 'remove'
            ? { status: 9 }
            : spawnSync('git', args, { cwd: gitCwd, env }),
        makeContainer: () => ownedContainer,
        removeContainer: () => {
          throw new Error('filesystem cleanup failed');
        },
        reportCleanup: (message) => cleanupReports.push(message),
        validate: async () => {
          throw validationFailure;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(validationFailure);
    expect(cleanupReports).toEqual([
      expect.stringMatching(/Cleanup also failed.*status 9/),
      expect.stringMatching(/Cleanup also failed.*filesystem cleanup failed/),
    ]);
    git(cwd, ['worktree', 'prune']);
  });
});

describe('verification orchestration', () => {
  it('reports and skips dependency installation for auto docs-only changes', async () => {
    const cwd = createRepository();
    mkdirSync(path.join(cwd, 'docs'));
    writeFileSync(path.join(cwd, 'docs', 'guide.md'), 'guide\n');
    git(cwd, ['add', 'docs/guide.md']);
    git(cwd, ['commit', '--quiet', '-m', 'docs']);
    const output = [];

    const result = await verifyPullRequest(
      { base: 'HEAD^', cwd, requestedProfile: 'auto' },
      {
        log: (message) => output.push(message),
        nodeVersion: '22.17.0',
        temporaryWorktree: () => {
          throw new Error('must not create a worktree for docs-only changes');
        },
      },
    );

    expect(result.profile).toBe('docs_only');
    expect(output.join('\n')).toMatch(
      /Base: HEAD\^.*HEAD: [0-9a-f]{40}.*Changed files: 1.*Profile: docs_only/s,
    );
    expect(output.join('\n')).toMatch(/full CI skipped/i);
  });

  it('checks Node before inspecting or creating anything', async () => {
    let inspected = false;

    await expect(
      verifyPullRequest(
        { base: 'HEAD', cwd: '/caller', requestedProfile: 'full' },
        {
          inspect: () => {
            inspected = true;
          },
          nodeVersion: '20.19.0',
          temporaryWorktree: () => {
            throw new Error('must not create a worktree');
          },
        },
      ),
    ).rejects.toThrow(/Node 22/);
    expect(inspected).toBe(false);
  });

  it('rejects a dirty caller before creating the temporary worktree', async () => {
    const cwd = createRepository();
    writeFileSync(path.join(cwd, 'source.js'), 'dirty\n');
    let created = false;

    await expect(
      verifyPullRequest(
        { base: 'missing-ref', cwd, requestedProfile: 'full' },
        {
          nodeVersion: '22.17.0',
          temporaryWorktree: () => {
            created = true;
          },
        },
      ),
    ).rejects.toThrow(/working tree/);
    expect(created).toBe(false);
  });

  it('checks only existing regular changed files with Prettier', async () => {
    const worktree = mkdtempSync(path.join(tmpdir(), 'verify-pr-worktree-'));
    tempDirs.push(worktree);
    const outside = mkdtempSync(path.join(tmpdir(), 'verify-pr-outside-'));
    tempDirs.push(outside);
    mkdirSync(path.join(worktree, 'docs'));
    mkdirSync(path.join(worktree, 'tracked-directory'));
    writeFileSync(path.join(worktree, 'source.js'), 'export {};\n');
    writeFileSync(path.join(worktree, 'replacement.js'), 'export {};\n');
    writeFileSync(path.join(worktree, 'docs', 'path with spaces.md'), 'doc\n');
    writeFileSync(path.join(worktree, '-leading-option.md'), 'option\n');
    writeFileSync(path.join(outside, 'external.js'), 'export {};\n');
    symlinkSync(
      path.join(outside, 'external.js'),
      path.join(worktree, 'link.js'),
    );
    symlinkSync(outside, path.join(worktree, 'linked-directory'));
    symlinkSync('loop.js', path.join(worktree, 'loop.js'));
    const execution = await captureValidation({
      changedFiles: [
        'source.js',
        'replacement.js/deleted.js',
        'replacement.js',
        'deleted.js',
        'tracked-directory',
        'docs/path with spaces.md',
        '-leading-option.md',
        'link.js',
        'linked-directory/external.js',
        'loop.js',
      ],
      worktree,
    });

    expect(
      execution.steps.find(({ name }) => name === 'Run Prettier').command,
    ).toEqual([
      'npx',
      'prettier',
      '--experimental-cli',
      '--check',
      '--ignore-unknown',
      '--',
      'source.js',
      'replacement.js',
      'docs/path with spaces.md',
      '-leading-option.md',
    ]);
  });

  it('omits Prettier when all changed paths are deleted or directories', async () => {
    const worktree = mkdtempSync(path.join(tmpdir(), 'verify-pr-worktree-'));
    tempDirs.push(worktree);
    mkdirSync(path.join(worktree, 'tracked-directory'));
    const execution = await captureValidation({
      changedFiles: ['deleted.js', 'tracked-directory'],
      worktree,
    });

    expect(execution.steps.map(({ name }) => name)).not.toContain(
      'Run Prettier',
    );
  });

  it('runs Python-expanded validation steps only in the temporary worktree', async () => {
    const worktree = mkdtempSync(path.join(tmpdir(), 'verify-pr-worktree-'));
    tempDirs.push(worktree);
    mkdirSync(path.join(worktree, 'packages', 'sdk-python', 'src'), {
      recursive: true,
    });
    writeFileSync(
      path.join(worktree, 'packages', 'sdk-python', 'src', 'client.py'),
      'pass\n',
    );
    const execution = await captureValidation({
      baseEnv: { RUNNER_TEMP: '/caller/temp', SAFE: 'kept' },
      changedFiles: ['packages/sdk-python/src/client.py'],
      worktree,
    });

    expect(execution.cwd).toBe(worktree);
    expect(execution.home).toBe('/owned/home');
    expect(execution.baseEnv).toMatchObject({
      RUNNER_TEMP: '/owned/container',
      SAFE: 'kept',
      TEMP: '/owned/tmp',
      TMP: '/owned/tmp',
      TMPDIR: '/owned/tmp',
    });
    const pythonSteps = execution.steps.filter(
      ({ name, uvRequirement }) => uvRequirement || name.includes('(Python '),
    );
    expect(pythonSteps).toHaveLength(22);
    expect(execution.steps[0].command.join(' ')).toBe(
      'npm ci --prefer-offline --no-audit --progress=false --ignore-scripts=false',
    );
    expect(pythonSteps[0].command).toEqual(['uv', '--version']);
  });
});
