/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLintScope } from '../lint-scope.js';

const lintScript = fileURLToPath(new URL('../lint.js', import.meta.url));
let root;
let repo;
let baseSha;
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const put = (name, content = 'export const value = 1;\n') => {
  const file = join(repo, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const commit = () => {
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD');
};
const scope = () => getLintScope({ cwd: repo, baseSha });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'incremental-lint-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  put('unchanged.ts');
  baseSha = commit();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')(
  'incremental lint selection',
  () => {
    it('keeps default full scans and falls back for missing or invalid history', async () => {
      expect((await getLintScope({ cwd: repo, baseSha: '' })).full).toBe(true);
      expect(
        (await getLintScope({ cwd: repo, baseSha: 'f'.repeat(40) })).full,
      ).toBe(true);
      expect(
        (await getLintScope({ cwd: repo, baseSha: 'HEAD; touch injected' }))
          .full,
      ).toBe(true);
      expect(existsSync(join(repo, 'injected'))).toBe(false);
      git('checkout', '--orphan', 'unrelated');
      put('other.ts');
      commit();
      expect((await scope()).full).toBe(true);
    });

    it('diffs from the merge base rather than the moving target branch tip', async () => {
      git('checkout', '-qb', 'target');
      put('target-only.ts');
      baseSha = commit();
      git('checkout', '-qb', 'pr', 'HEAD~1');
      put('pr-only.ts');
      commit();
      const result = await scope();
      expect(result.full).toBe(false);
      expect(result.eslint).toEqual(['pr-only.ts']);
      expect(result.prettier).toEqual(['pr-only.ts']);
    });

    it('selects the .mts and .cts files the full lane lints', async () => {
      // `lint:ci` runs `eslint . --ext .ts,.tsx`, and flat-config `--ext` is
      // additive to the config's own `files` scope, which typescript-eslint
      // opens to *.mts/*.cts. Selecting only .ts/.tsx here would report green
      // without ever opening a changed .mts file.
      put('changed.mts');
      put('changed.cts');
      commit();
      const result = await scope();
      expect(result.full).toBe(false);
      expect(result.eslint.sort()).toEqual(['changed.cts', 'changed.mts']);
    });

    it('uses existing rename destinations and preserves spaced, newline and shell-special paths', async () => {
      put('old.ts');
      put('deleted.yaml', 'name: removed\n');
      baseSha = commit();
      renameSync(join(repo, 'old.ts'), join(repo, 'renamed file.ts'));
      rmSync(join(repo, 'deleted.yaml'));
      const special =
        process.platform === 'win32'
          ? 'space file.ts'
          : 'line\nbreak $(touch injected).ts';
      put(special);
      commit();
      const result = await scope();
      expect(result.full).toBe(false);
      expect(result.eslint.sort()).toEqual([special, 'renamed file.ts'].sort());
      expect(result.yamllint).toEqual([]);
      expect(existsSync(join(repo, 'injected'))).toBe(false);
    });

    it.each([
      'eslint-rules/no-core-root-barrel-import.js',
      'eslint.legacy-core-barrel-imports.mjs',
      'nested/.gitignore',
      '.prettierignore',
      'nested/.prettierrc.json',
      'packages/core/package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      '.shellcheckrc',
      '.yamllint.yml',
      '.github/actionlint.yaml',
      'scripts/lint-scope.js',
    ])(
      'runs full checks when %s changes, is deleted, or is renamed',
      async (name) => {
        put(name, '{}\n');
        const withConfig = commit();
        expect((await scope()).full).toBe(true);
        baseSha = withConfig;
        renameSync(join(repo, name), join(repo, 'ordinary.txt'));
        commit();
        expect((await scope()).full).toBe(true);
      },
    );

    it('runs actionlint across workflows after deletions or local action changes', async () => {
      put('.github/workflows/callee.yml', 'name: callee\n');
      baseSha = commit();
      rmSync(join(repo, '.github/workflows/callee.yml'));
      commit();
      expect(await scope()).toMatchObject({
        full: false,
        actionlint: true,
        yamllint: [],
      });
      baseSha = git('rev-parse', 'HEAD');
      put('.github/actions/local/index.js');
      commit();
      expect((await scope()).actionlint).toBe(true);
    });

    it.skipIf(process.platform === 'win32')(
      'selects shell and YAML lanes for changed scripts and configuration data',
      async () => {
        put('bin/space script', '#!/bin/sh\necho hello\n');
        put('not-a-script.sh', 'plain text\n');
        put(
          'integration-tests/terminal-bench/task.sh',
          '#!/bin/sh\necho hello\n',
        );
        put('settings.yaml', 'name: test\n');
        commit();
        expect(await scope()).toMatchObject({
          full: false,
          shellcheck: true,
          yamllint: ['settings.yaml'],
          actionlint: false,
        });
      },
    );

    it('does not extend the shell lane to paths that lane excludes', async () => {
      // The full lane greps terminal-bench out of its candidates, but the
      // escalation arm was evaluated over every changed path, so a PR whose
      // only shell change lived there still staged a whole-repository
      // ShellCheck for a file the lane would never read.
      put(
        'integration-tests/terminal-bench/task.sh',
        '#!/bin/sh\necho hello\n',
      );
      commit();
      expect(await scope()).toMatchObject({ full: false, shellcheck: false });
    });

    it('rechecks unchanged entry scripts when a sourced helper changes or is deleted', async () => {
      put('entry.sh', '#!/bin/sh\n. ./helper\n');
      put('helper', 'value=old\n');
      baseSha = commit();
      put('helper', 'value=new\n');
      commit();
      expect((await scope()).shellcheck).toBe(true);
      rmSync(join(repo, 'helper'));
      commit();
      expect((await scope()).shellcheck).toBe(true);
    });

    it('rejects shallow alternate ancestry even when Git finds a merge base', async () => {
      git('checkout', '-qb', 'side');
      put('side.ts');
      commit();
      git('checkout', '-qb', 'pr', baseSha);
      put('pr.ts');
      const firstParent = commit();
      git('merge', '--no-ff', '-qm', 'merge', 'side');
      const clone = join(root, 'shallow');
      execFileSync('git', [
        'clone',
        '-q',
        '--depth=2',
        pathToFileURL(repo).href,
        clone,
      ]);
      execFileSync('git', ['fetch', '-q', '--depth=2', 'origin', firstParent], {
        cwd: clone,
      });
      expect(
        execFileSync('git', ['merge-base', baseSha, 'HEAD'], {
          cwd: clone,
          encoding: 'utf8',
        }).trim(),
      ).toBe(baseSha);
      const result = await getLintScope({ cwd: clone, baseSha });
      expect(result.full).toBe(true);
      expect(result.reason).toContain('Shallow history above the merge base');
      execFileSync('git', ['fetch', '-q', '--depth=3', 'origin', 'HEAD'], {
        cwd: clone,
      });
      expect((await getLintScope({ cwd: clone, baseSha })).full).toBe(false);
    });

    it('falls back when a shallow checkout cannot reach the base', async () => {
      put('change.ts');
      commit();
      const clone = join(root, 'shallow');
      execFileSync('git', [
        'clone',
        '-q',
        '--depth=1',
        pathToFileURL(repo).href,
        clone,
      ]);
      expect((await getLintScope({ cwd: clone, baseSha })).full).toBe(true);
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'incremental lint subprocesses',
  () => {
    const run = (lanes, fail = '', script = lintScript) => {
      const bin = join(repo, 'node_modules', '.bin');
      const log = join(root, 'calls.jsonl');
      mkdirSync(bin, { recursive: true });
      for (const name of [
        'eslint',
        'prettier',
        'shellcheck',
        'yamllint',
        'actionlint',
        'npm',
      ]) {
        const file = join(bin, name);
        writeFileSync(
          file,
          `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.LINT_LOG, JSON.stringify({name:${JSON.stringify(name)},args:process.argv.slice(2)})+'\\n');\nif (${JSON.stringify(name)} === 'shellcheck') console.log('test.sh:1:1: note: diagnostic');\nprocess.exit(${JSON.stringify(name)} === process.env.FAIL_LINTER ? 7 : 0);\n`,
        );
        chmodSync(file, 0o755);
      }
      const result = spawnSync(
        process.execPath,
        [script, ...lanes.map((lane) => `--${lane}`)],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            // Pin the environment-derived linter temp directory into the
            // fixture. `setupLinters` starts with rmSync(TEMP_DIR), and
            // getLinterTempDir() keys on RUNNER_TEMP plus GITHUB_RUN_ID, so an
            // unpinned child deletes the ambient runner directory.
            RUNNER_TEMP: repo,
            GITHUB_RUN_ID: '1',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_JOB: 'lint-scope-test',
            LINT_BASE_SHA: baseSha,
            LINT_LOG: log,
            FAIL_LINTER: fail,
          },
        },
      );
      return {
        ...result,
        calls: existsSync(log)
          ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
          : [],
      };
    };

    it('passes whole filenames as arguments and keeps each lane’s flags', () => {
      const special = '-space [x] $(touch injected).ts';
      put(special);
      put('shell script.sh', '#!/bin/sh\necho hello\n');
      put('config space.yml', 'name: test\n');
      put('.github/actions/local/action.yml', 'name: local\n');
      commit();
      const result = run(['eslint', 'prettier', 'yamllint', 'actionlint']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls.find(({ name }) => name === 'eslint').args).toEqual([
        '--ext',
        '.ts,.tsx',
        '--max-warnings',
        '0',
        '--no-warn-ignored',
        '--',
        `./${special}`,
      ]);
      expect(
        result.calls
          .filter(({ name }) => name === 'prettier')
          .map(({ args }) => args),
      ).toEqual([
        [
          '--experimental-cli',
          '--check',
          '--ignore-unknown',
          `./${special}`,
          './config space.yml',
        ],
        ['--experimental-cli', '--check', '--ignore-unknown', './action.yml'],
      ]);
      expect(result.calls.find(({ name }) => name === 'yamllint').args).toEqual(
        [
          '--format',
          'github',
          '--',
          './.github/actions/local/action.yml',
          './config space.yml',
        ],
      );
      expect(
        result.calls.find(({ name }) => name === 'actionlint').args,
      ).not.toContain('./.github/actions/local/action.yml');
      expect(existsSync(join(repo, 'injected'))).toBe(false);
    });

    it.each(['eslint', 'prettier', 'yamllint', 'actionlint'])(
      'fails when %s reports an error',
      (lane) => {
        put('changed.ts');
        put('changed.sh', '#!/bin/sh\necho hello\n');
        put('.github/workflows/changed.yml', 'name: test\n');
        commit();
        const result = run([lane], lane);
        expect(result.status).toBe(1);
        // Prettier runs once per selected directory and now reports all of
        // them in one pass; every other lane is a single invocation.
        expect(result.calls.map(({ name }) => name)).toEqual(
          lane === 'prettier' ? [lane, lane] : [lane],
        );
      },
    );

    it('runs GitHub-only lanes without installed Node dependencies', () => {
      const isolated = join(root, 'isolated');
      mkdirSync(isolated);
      writeFileSync(join(isolated, 'package.json'), '{"type":"module"}');
      copyFileSync(lintScript, join(isolated, 'lint.js'));
      copyFileSync(
        join(dirname(lintScript), 'lint-scope.js'),
        join(isolated, 'lint-scope.js'),
      );
      put('workflow.yml', 'name: test\n');
      commit();
      const result = run(['yamllint'], '', join(isolated, 'lint.js'));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Incremental PR lint.');
      expect(result.calls).toEqual([
        {
          name: 'yamllint',
          args: ['--format', 'github', '--', './workflow.yml'],
        },
      ]);
    });

    it('invokes the existing full shell lane for changed sourced helpers', () => {
      put('entry.sh', '#!/bin/sh\n. ./helper\n');
      put('helper', 'value=old\n');
      baseSha = commit();
      put('helper', 'value=new\n');
      commit();
      const result = run(['shellcheck']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toEqual([
        {
          name: 'shellcheck',
          args: [
            '--check-sourced',
            '--enable=all',
            '--exclude=SC2002,SC2129,SC2310',
            '--severity=style',
            '--format=gcc',
            '--color=never',
            'entry.sh',
          ],
        },
      ]);
      expect(result.stdout).toContain('warning: diagnostic');
    });

    it('skips every lane and installer for deletion-only or unsupported-file changes', () => {
      git('rm', 'unchanged.ts');
      put('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      commit();
      const result = run([
        'setup',
        'eslint',
        'prettier',
        'shellcheck',
        'yamllint',
        'actionlint',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toContain('Skipping eslint');
      expect(result.stdout).toContain('Skipping prettier');
      expect(result.stdout).toContain('Skipping shellcheck');
    });

    it('keeps the spawned linter temp dir inside the fixture', () => {
      put('changed.ts');
      commit();
      const result = run(['setup']);
      expect(result.status, result.stderr).toBe(0);
      // The child resolves RUNNER_TEMP/qwen-code-linters/<run>-<attempt>-<job>
      // from the pinned env, so its rmSync/mkdirSync stays in the fixture.
      expect(
        existsSync(join(repo, 'qwen-code-linters', '1-1-lint-scope-test')),
      ).toBe(true);
    });

    it('reports every failing directory in one Prettier run', () => {
      // Prettier runs from each file's own directory with basename targets, so
      // neither its output nor its cwd names the directory. Exiting on the
      // first non-zero status both hid the location and skipped the rest.
      put('package.json', '{"type":"module"}\n');
      baseSha = commit();
      put('packages/alpha/src/one.js', 'const  one=1;\n');
      put('packages/beta/src/two.js', 'const  two=2;\n');
      commit();
      const result = spawnSync(process.execPath, [lintScript, '--prettier'], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          LINT_BASE_SHA: baseSha,
          PATH: `${fileURLToPath(new URL('../../node_modules/.bin', import.meta.url))}:${process.env.PATH}`,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('Checking packages/alpha/src');
      expect(result.stdout).toContain('Checking packages/beta/src');
      expect(result.stdout + result.stderr).toContain('one.js');
      expect(result.stdout + result.stderr).toContain('two.js');
    });

    it.each(['eslint', 'prettier'])(
      'reports real %s errors in a literal filename with glob characters',
      (lane) => {
        put('package.json', '{"type":"module"}\n');
        put(
          'eslint.config.js',
          "export default [{rules: {'no-debugger': 'error'}}];\n",
        );
        baseSha = commit();
        put('-bad [x].js', 'debugger\n');
        commit();
        const result = spawnSync(process.execPath, [lintScript, `--${lane}`], {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            LINT_BASE_SHA: baseSha,
            PATH: `${fileURLToPath(new URL('../../node_modules/.bin', import.meta.url))}:${process.env.PATH}`,
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout + result.stderr).toContain('-bad [x].js');
        expect(result.stdout + result.stderr).toContain(
          lane === 'eslint' ? 'no-debugger' : 'Code style issues',
        );
        expect(readFileSync(join(repo, '-bad [x].js'), 'utf8')).toBe(
          'debugger\n',
        );
      },
    );

    it('honors nested config and ignore files in the actual experimental Prettier CLI', () => {
      put('.prettierignore', 'nested/root-ignored.js\n');
      put('nested/.gitignore', 'generated.js\n');
      put('nested/.prettierrc.json', '{"semi":false}\n');
      baseSha = commit();
      put('nested/manual.js', 'const x = 1\n');
      put('nested/root-ignored.js', 'const x=1\n');
      put('nested/generated.js', 'const x=1\n');
      git('add', '-f', 'nested/generated.js');
      commit();
      const result = spawnSync(process.execPath, [lintScript, '--prettier'], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          LINT_BASE_SHA: baseSha,
          PATH: `${fileURLToPath(new URL('../../node_modules/.bin', import.meta.url))}:${process.env.PATH}`,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(join(repo, 'nested/generated.js'), 'utf8')).toBe(
        'const x=1\n',
      );
    });

    it('preserves the full ESLint command when no opt-in is supplied', () => {
      baseSha = '';
      const result = run(['eslint']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toEqual([{ name: 'npm', args: ['run', 'lint:ci'] }]);
    });
  },
);
