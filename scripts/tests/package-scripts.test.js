/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { hooks as pnpmHooks, workspacePackageNames } from '../../.pnpmfile.mjs';
import { getPinnedPnpmPackage } from '../pnpm-package.js';

import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function readWorkflow(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

const releaseStepScript = readWorkflow('.github/scripts/run-release-step.sh');

describe('package scripts', () => {
  it('accepts only an exact pnpm package-manager version', () => {
    expect(getPinnedPnpmPackage({ packageManager: 'pnpm@11.24.0' })).toBe(
      'pnpm@11.24.0',
    );
    // `corepack use pnpm@x.y.z` appends the tarball's integrity hash; the
    // bootstrap must accept the string corepack itself writes.
    const hashed =
      'pnpm@11.24.0+sha512.bd27e345e976dcb0be0b7a1228217b049a817e21b1f355c90dbe7dc46671895a8bc1e6d06c24554505ea93ea0b45f489a27ec1bfbc8de6a9659fca0f16fa0000';
    expect(getPinnedPnpmPackage({ packageManager: hashed })).toBe(hashed);
    expect(() =>
      getPinnedPnpmPackage({ packageManager: 'pnpm@latest' }),
    ).toThrow('packageManager must pin an exact pnpm version');
    expect(() =>
      getPinnedPnpmPackage({
        packageManager: 'pnpm@11.24.0+sha512.not-hex',
      }),
    ).toThrow('packageManager must pin an exact pnpm version');
  });

  it('pins pnpm with the corepack integrity hash', () => {
    expect(readPackageJson().packageManager).toMatch(
      /^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/,
    );
  });

  it('keeps internal pnpm workspaces independent of manifest versions', () => {
    const packageJson = {
      dependencies: {
        '@qwen-code/qwen-code-core': 'file:../core',
        '@qwen-code/channel-base': '0.22.4',
        fixture: 'file:../fixture',
      },
      devDependencies: {
        '@qwen-code/acp-bridge': 'file:../acp-bridge',
      },
      optionalDependencies: {
        '@qwen-code/sdk': '0.22.4',
      },
    };

    expect(pnpmHooks.readPackage(packageJson)).toEqual({
      dependencies: {
        '@qwen-code/qwen-code-core': 'workspace:*',
        '@qwen-code/channel-base': 'workspace:*',
        fixture: 'file:../fixture',
      },
      devDependencies: {
        '@qwen-code/acp-bridge': 'workspace:*',
      },
      optionalDependencies: {
        '@qwen-code/sdk': 'workspace:*',
      },
    });
  });

  it('keeps the pnpm rewrite set in sync with the workspace manifests', () => {
    const { workspaces } = readPackageJson();
    const negated = workspaces
      .filter((entry) => entry.startsWith('!'))
      .map((entry) => entry.slice(1));
    const directories = [];
    for (const pattern of workspaces) {
      if (pattern.startsWith('!')) continue;
      if (pattern.endsWith('/*')) {
        const parent = pattern.slice(0, -2);
        for (const entry of readdirSync(path.join(root, parent))) {
          directories.push(`${parent}/${entry}`);
        }
      } else {
        directories.push(pattern);
      }
    }
    const names = directories
      .filter((directory) => !negated.includes(directory))
      .map((directory) => {
        const manifestPath = path.join(root, directory, 'package.json');
        if (!existsSync(manifestPath)) return undefined;
        return JSON.parse(readFileSync(manifestPath, 'utf8')).name;
      })
      .filter((name) => name !== undefined);

    // A member missing from the set keeps its release version or file:
    // specifier under pnpm, which is exactly the lockfile staleness the
    // rewrite exists to prevent.
    expect([...workspacePackageNames].sort()).toEqual(
      [...new Set(names)].sort(),
    );
  });

  it('mirrors the npm workspace boundaries in pnpm-workspace.yaml', () => {
    const workspace = parse(readWorkflow('pnpm-workspace.yaml'));

    expect([...workspace.packages].sort()).toEqual(
      [...readPackageJson().workspaces].sort(),
    );
  });

  it('mirrors npm overrides in pnpm-workspace.yaml', () => {
    const workspace = parse(readWorkflow('pnpm-workspace.yaml'));
    const { cliui, ...npmOverrides } = readPackageJson().overrides;

    expect(workspace.overrides).toMatchObject({
      ...npmOverrides,
      'cliui>wrap-ansi': cliui['wrap-ansi'],
    });
  });

  it('checks both lockfiles for integrity', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/check-lockfile.js')],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Lockfile check passed.');
    expect(result.stdout).toContain('pnpm lockfile check passed.');
  });

  it('keeps the internal release-age exception independent of the version', () => {
    const workspace = parse(
      readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
    );

    expect(workspace.minimumReleaseAgeExclude).toEqual([
      '@qwen-code/channel-base',
    ]);
  });

  it('imports packages without hard links so patch-package cannot corrupt the store', () => {
    const workspace = parse(
      readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
    );

    // The root postinstall rewrites node_modules files in place. Under
    // 'auto' or 'hardlink' those files are hard links into the
    // content-addressable store, so the rewrite corrupts the store entry and
    // every later worktree misses its --offline stage.
    expect(readPackageJson().scripts.postinstall).toBe('patch-package');
    expect(['clone-or-copy', 'copy', 'clone']).toContain(
      workspace.packageImportMethod,
    );
  });

  it('keeps the pnpm lockfile out of prettier so formatting cannot fight pnpm', () => {
    const ignored = readFileSync(path.join(root, '.prettierignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(ignored).toContain('pnpm-lock.yaml');
  });

  it('keeps channel workspace lock entries independent of release versions', () => {
    const lockfile = parse(
      readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'),
    );
    const specifiers = Object.values(lockfile.importers).flatMap((importer) =>
      ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap(
        (field) => {
          const entry = importer[field]?.['@qwen-code/channel-base'];
          return entry ? [entry.specifier] : [];
        },
      ),
    );

    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers)).toEqual(new Set(['workspace:*']));
  });

  it('bootstraps worktrees with frozen pnpm dependencies and skips prepare', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-worktree-setup-'));
    const commandDir = path.join(binDir, 'runner bin');
    const logFile = path.join(binDir, 'corepack.log');
    mkdirSync(commandDir);

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(commandDir, 'corepack.cmd'),
          '@echo %QWEN_SKIP_PREPARE% %QWEN_SKIP_NOTICE_GENERATION% %*>>"%WORKTREE_SETUP_LOG%"\r\n',
        );
      } else {
        writeFileSync(
          path.join(commandDir, 'corepack'),
          '#!/bin/sh\necho "$QWEN_SKIP_PREPARE $QWEN_SKIP_NOTICE_GENERATION $*" >> "$WORKTREE_SETUP_LOG"\n',
        );
        chmodSync(path.join(commandDir, 'corepack'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/setup-worktree.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${commandDir}${path.delimiter}${process.env.PATH ?? ''}`,
            WORKTREE_SETUP_LOG: logFile,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(logFile, 'utf8').trim()).toBe(
        '1 1 pnpm install --frozen-lockfile --offline',
      );
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'resolves the path variable under its native Windows casing',
    () => {
      const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-worktree-path-'));
      const commandDir = path.join(binDir, 'runner bin');
      const logFile = path.join(binDir, 'corepack.log');
      mkdirSync(commandDir);

      try {
        writeFileSync(
          path.join(commandDir, 'corepack.cmd'),
          '@echo %QWEN_SKIP_PREPARE% %QWEN_SKIP_NOTICE_GENERATION% %*>>"%WORKTREE_SETUP_LOG%"\r\n',
        );

        // Native shells expose the path variable as `Path`; a case-sensitive
        // `env.PATH` read on the spread object would miss it and report
        // Corepack unavailable.
        const env = { ...process.env, WORKTREE_SETUP_LOG: logFile };
        delete env.PATH;
        delete env.Path;
        env.Path = `${commandDir}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ''}`;

        const result = spawnSync(
          process.execPath,
          [path.join(root, 'scripts/setup-worktree.js')],
          {
            cwd: root,
            encoding: 'utf8',
            env,
          },
        );

        expect(result.status).toBe(0);
        expect(readFileSync(logFile, 'utf8').trim()).toBe(
          '1 1 pnpm install --frozen-lockfile --offline',
        );
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );

  it('fails closed when Corepack is unavailable', () => {
    const binDir = mkdtempSync(
      path.join(tmpdir(), 'qwen-worktree-no-corepack-'),
    );
    const env = { ...process.env, PATH: binDir };
    for (const name of Object.keys(env)) {
      if (name !== 'PATH' && name.toUpperCase() === 'PATH') delete env[name];
    }

    try {
      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/setup-worktree.js')],
        { cwd: root, encoding: 'utf8', env },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Corepack is required');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('falls back to registry access when the pnpm store is incomplete', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-worktree-fallback-'));
    const logFile = path.join(binDir, 'corepack.log');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'corepack.cmd'),
          '@echo %QWEN_SKIP_PREPARE% %QWEN_SKIP_NOTICE_GENERATION% %*>>"%WORKTREE_SETUP_LOG%"\r\n@if "%4"=="--offline" exit /b 1\r\n',
        );
      } else {
        writeFileSync(
          path.join(binDir, 'corepack'),
          '#!/bin/sh\necho "$QWEN_SKIP_PREPARE $QWEN_SKIP_NOTICE_GENERATION $*" >> "$WORKTREE_SETUP_LOG"\n[ "$4" != "--offline" ]\n',
        );
        chmodSync(path.join(binDir, 'corepack'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/setup-worktree.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: binDir,
            WORKTREE_SETUP_LOG: logFile,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        '1 1 pnpm install --frozen-lockfile --offline',
        '1 1 pnpm install --frozen-lockfile --prefer-offline',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('preserves a worktree bootstrap interrupt status', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-worktree-signal-'));
    const logFile = path.join(binDir, 'corepack.log');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'corepack.cmd'),
          '@echo called>>"%WORKTREE_SETUP_LOG%"\r\n@exit /b 130\r\n',
        );
      } else {
        writeFileSync(
          path.join(binDir, 'corepack'),
          '#!/bin/sh\necho called >> "$WORKTREE_SETUP_LOG"\nkill -INT $$\n',
        );
        chmodSync(path.join(binDir, 'corepack'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/setup-worktree.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            WORKTREE_SETUP_LOG: logFile,
          },
        },
      );

      expect(result.status).toBe(130);
      expect(readFileSync(logFile, 'utf8').trim()).toBe('called');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('does not couple Node REPL to Qwen release versions', () => {
    const versionScript = readFileSync(
      path.join(root, 'scripts/version.js'),
      'utf8',
    );

    expect(versionScript).toContain(
      'const workspacesToExclude = [\n' +
        "  '@qwen-code/sdk',\n" +
        "  '@qwen-code/mobile-mcp',\n" +
        "  '@qwen-code/node-repl-mcp',\n" +
        "  '@qwen-code/qwen-live',\n" +
        '];',
    );
  });

  it('smoke-tests the real worktree bootstrap on every supported host', () => {
    const workflow = parse(
      readWorkflow('.github/workflows/pnpm-worktree-smoke.yml'),
    );
    const job = workflow.jobs.install;

    expect(job.strategy.matrix.os).toEqual([
      'ubuntu-latest',
      'macos-latest',
      'windows-latest',
    ]);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(
      job.steps.find(
        (step) => step.name === 'Install frozen pnpm worktree dependencies',
      )?.run,
    ).toBe('node scripts/setup-worktree.js');

    // The pnpm linker only materializes declared dependencies, so a
    // workspace import that npm's hoisting hides breaks typecheck and tests
    // in the bootstrapped tree; resolve one through the worst offender.
    const resolveCheck = job.steps.find(
      (step) => step.name === 'Verify workspace links resolve',
    );
    expect(resolveCheck?.run).toContain(
      '@qwen-code/qwen-code-core/package.json',
    );
    expect(resolveCheck?.run).toContain('packages/vscode-ide-companion');

    // `git diff --exit-code` misses untracked files; the install must leave
    // the porcelain output empty on every host, including Windows (hence
    // the explicit POSIX shell).
    const cleanCheck = job.steps.find(
      (step) => step.name === 'Ensure bootstrap keeps the worktree clean',
    );
    expect(cleanCheck?.shell).toBe('bash');
    expect(cleanCheck?.run).toContain('git status --porcelain');

    // The checks only mean anything after the install; pin the order.
    const stepNames = job.steps.map((step) => step.name);
    expect(
      stepNames.indexOf('Install frozen pnpm worktree dependencies'),
    ).toBeLessThan(stepNames.indexOf('Verify workspace links resolve'));
    expect(stepNames.indexOf('Verify workspace links resolve')).toBeLessThan(
      stepNames.indexOf('Ensure bootstrap keeps the worktree clean'),
    );

    // A post-merge run is the only witness of a regression on main, so
    // consecutive merges must not cancel each other.
    expect(workflow.concurrency['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );

    // Substring check on the raw job text: an exact `step.run` match is
    // bypassed by any other spelling of a build step (block scalar,
    // compound command).
    const installJob = getWorkflowJob(
      readWorkflow('.github/workflows/pnpm-worktree-smoke.yml'),
      'install',
    );
    expect(installJob).not.toContain('npm run build');
    expect(installJob).not.toContain('node scripts/build.js');
  });

  it('runs the pnpm smoke workflow when a dependency input changes', () => {
    const workflow = parse(
      readWorkflow('.github/workflows/pnpm-worktree-smoke.yml'),
    );
    const expectedPaths = [
      '.github/workflows/pnpm-worktree-smoke.yml',
      '.npmrc',
      '.pnpmfile.mjs',
      'package.json',
      'packages/*/package.json',
      '!packages/desktop-shell/package.json',
      '!packages/live-host/package.json',
      'packages/channels/*/package.json',
      'integrations/*/package.json',
      'patches/**',
      'packages/audio-capture/install.js',
      'packages/core/scripts/postinstall.js',
      'packages/vscode-ide-companion/scripts/generate-notices.js',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/generate-git-commit-info.js',
      'scripts/prepare.js',
      'scripts/pnpm-package.js',
      'scripts/setup-worktree.js',
    ];

    expect(workflow.on.pull_request.paths).toEqual(expectedPaths);
    expect(workflow.on.push.paths).toEqual(expectedPaths);
  });

  it('builds the standalone qwen-live daemon in the root build order', () => {
    const buildScript = readFileSync(
      path.join(root, 'scripts/build.js'),
      'utf8',
    );

    // The qwen-live e2e harness spawns packages/qwen-live/dist/index.js and
    // the workspace unit tests run from src, so this pin is what catches the
    // root build silently dropping the package.
    const startIndex = buildScript.indexOf('const buildOrder = [');
    expect(startIndex).toBeGreaterThan(-1);
    const buildOrder = buildScript.slice(
      startIndex,
      buildScript.indexOf('];', startIndex),
    );
    expect(buildOrder).toContain("'packages/qwen-live',");
  });

  it('keeps the Mem0 Extension manifest aligned with release versions', () => {
    const versionScript = readFileSync(
      path.join(root, 'scripts/version.js'),
      'utf8',
    );

    expect(versionScript).toContain(
      "'integrations/external-context-mem0/qwen-extension.json'",
    );
    expect(versionScript).toContain(
      'const mem0Manifest = readJson(mem0ManifestPath);',
    );
    expect(versionScript).toContain('mem0Manifest.version = newVersion');
    expect(versionScript).toContain(
      'writeJson(mem0ManifestPath, mem0Manifest);',
    );
    expect(versionScript).toContain(
      "'npx prettier --experimental-cli --write integrations/external-context-mem0/qwen-extension.json'",
    );
  });

  it('lets the CI unit lane retry a contended attempt', () => {
    // Identical work measures 6.7min or 36min on this fleet depending only on
    // which host the job lands on, and the same commit run three times failed
    // three disjoint test sets (#10490). A retry lets that pass; a real break
    // still fails every attempt. The release lane already runs this way.
    const packageJson = readPackageJson();
    // `test:ci` ends in `&&`, so args appended to it would reach only
    // `test:scripts`. The workspaces half is its own script, ending in `--`,
    // so a flag appended to it reaches every workspace's vitest.
    expect(packageJson.scripts['test:ci:workspaces']).toMatch(/--$/);
    expect(packageJson.scripts['test:ci:workspaces']).toContain(
      'npm run test:ci --workspaces --if-present',
    );
    expect(packageJson.scripts['test:ci']).toBe(
      'npm run test:ci:workspaces && npm run test:scripts',
    );

    const step = getWorkflowStep(
      getWorkflowJob(readWorkflow('.github/workflows/ci.yml'), 'test'),
      'Run tests and generate reports',
    );
    expect(step).toContain(
      'VITEST_RETRY: "${{ vars.QWEN_CI_VITEST_RETRY || \'2\' }}"',
    );
    // 'off' must omit the flag rather than pass --retry=0, which would
    // outrank a workspace's own config-level retry (sdk-typescript).
    expect(step).toContain('[ "${VITEST_RETRY}" != \'off\' ]');
    expect(step).toContain('retry_arg=(--retry="${VITEST_RETRY}")');
    expect(step).toContain('npm run test:ci:workspaces -- "${retry_arg[@]}"');
    expect(step).toContain('npm run test:scripts -- "${retry_arg[@]}"');
  });

  it('bounds the CI unit step so a hang fails instead of stalling', () => {
    // #10490's run 3 was cancelled at ~60 minutes, leaving behind
    // orphaned test processes; a stall reads as a timeout, not a failure.
    const step = getWorkflowStep(
      getWorkflowJob(readWorkflow('.github/workflows/ci.yml'), 'test'),
      'Run tests and generate reports',
    );
    expect(step).toContain('timeout-minutes: 110');
  });

  it('keeps the serve fast-path bundle check outside unit test scripts', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['test:ci']).not.toContain(
      'npm run check:serve-fast-path-bundle',
    );
    expect(packageJson.scripts.preflight).toContain(
      'npm run check:serve-fast-path-bundle',
    );
  });

  it('limits SDK integration tests through the forks pool', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['test:integration:sdk:sandbox:none']).toContain(
      '--poolOptions.forks.maxForks 2',
    );
    expect(
      packageJson.scripts['test:integration:sdk:sandbox:docker'],
    ).toContain('--poolOptions.forks.maxForks 2');
  });

  it('cleans package build artifacts before checking the serve fast path bundle', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['check:serve-fast-path-bundle']).toBe(
      [
        'node scripts/clean-package-build-artifacts.js',
        '&& npm run build -- --cli-only',
        '&& cross-env DEV=true npm run bundle',
        '&& node scripts/check-serve-fast-path-bundle.js',
      ].join(' '),
    );
    expect(packageJson.scripts['check:serve-fast-path-bundle']).not.toContain(
      'npm run clean',
    );
  });

  it('defines a release test script that disables workspace coverage', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['test:release']).toBe(
      'npm run test:release:workspaces && npm run test:scripts',
    );
    expect(packageJson.scripts['test:release:workspaces']).toBe(
      [
        'cross-env NODE_OPTIONS="--max-old-space-size=3072"',
        'npm run test:ci --workspaces --if-present -- --coverage.enabled=false',
      ].join(' '),
    );

    // No workspace forces coverage from its test:ci script any more; the
    // configs decide, and only a post-merge run flips their switch on. A
    // reintroduced `--coverage` flag would override the switch on every
    // pull-request run.
    for (const workspace of [
      'packages/vscode-ide-companion',
      'packages/web-shell',
    ]) {
      const workspacePackageJson = JSON.parse(
        readFileSync(path.join(root, workspace, 'package.json'), 'utf8'),
      );
      expect(workspacePackageJson.scripts['test:ci']).not.toContain(
        '--coverage',
      );
      const vitestConfig = readFileSync(
        path.join(root, workspace, 'vitest.config.ts'),
        'utf8',
      );
      expect(vitestConfig).toContain(
        "enabled: process.env['QWEN_CI_COVERAGE'] === '1'",
      );
    }
  });

  it('skips build/bundle/husky but still generates git-commit info when CI builds explicitly', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts.prepare).toBe('node scripts/prepare.js');

    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-skip-'));
    const logFile = path.join(binDir, 'commands.log');
    writeFileSync(logFile, '');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'husky.cmd'),
          '@echo(husky>>"%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo(npm %*>>"%PREPARE_LOG_FILE%"\r\n',
        );
      } else {
        writeFileSync(
          path.join(binDir, 'husky'),
          '#!/bin/sh\necho husky >> "$PREPARE_LOG_FILE"\n',
        );
        writeFileSync(
          path.join(binDir, 'npm'),
          '#!/bin/sh\necho "npm $*" >> "$PREPARE_LOG_FILE"\n',
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '1',
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Skipping prepare');
      // git-commit info is still generated so a later per-workspace build or
      // typecheck (e.g. the review tooling's) doesn't fail on the missing
      // module; the heavy build/bundle/husky are skipped.
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        'npm run generate',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('runs prepare steps in order when CI does not skip prepare', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-bin-'));
    const logFile = path.join(binDir, 'commands.log');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'husky.cmd'),
          '@echo(husky>>"%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo(npm %*>>"%PREPARE_LOG_FILE%"\r\n',
        );
      } else {
        writeFileSync(
          path.join(binDir, 'husky'),
          '#!/bin/sh\necho husky >> "$PREPARE_LOG_FILE"\n',
        );
        writeFileSync(
          path.join(binDir, 'npm'),
          '#!/bin/sh\necho "npm $*" >> "$PREPARE_LOG_FILE"\n',
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '',
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        'husky',
        'npm run build',
        'npm run bundle',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('exits when a prepare step fails', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-fail-'));
    const logFile = path.join(binDir, 'commands.log');
    writeFileSync(logFile, '');

    try {
      if (process.platform === 'win32') {
        writeFileSync(path.join(binDir, 'husky.cmd'), '@exit /b 7\r\n');
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo npm %* >> "%PREPARE_LOG_FILE%"\r\n',
        );
      } else {
        writeFileSync(path.join(binDir, 'husky'), '#!/bin/sh\nexit 7\n');
        writeFileSync(
          path.join(binDir, 'npm'),
          '#!/bin/sh\necho "npm $*" >> "$PREPARE_LOG_FILE"\n',
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '',
          },
        },
      );

      expect(result.status).toBe(7);
      expect(result.stderr).toContain('prepare: husky exited with status 7');
      expect(readFileSync(logFile, 'utf8')).toBe('');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('reports the failing prepare step after earlier steps succeed', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-late-fail-'));
    const logFile = path.join(binDir, 'commands.log');
    writeFileSync(logFile, '');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'husky.cmd'),
          '@echo(husky>>"%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          [
            '@echo(npm %*>>"%PREPARE_LOG_FILE%"',
            '@if "%1 %2"=="run build" exit /b 7',
            '@exit /b 0',
            '',
          ].join('\r\n'),
        );
      } else {
        writeFileSync(
          path.join(binDir, 'husky'),
          '#!/bin/sh\necho husky >> "$PREPARE_LOG_FILE"\n',
        );
        writeFileSync(
          path.join(binDir, 'npm'),
          [
            '#!/bin/sh',
            'echo "npm $*" >> "$PREPARE_LOG_FILE"',
            'if [ "$1 $2" = "run build" ]; then exit 7; fi',
            '',
          ].join('\n'),
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '',
          },
        },
      );

      expect(result.status).toBe(7);
      expect(result.stderr).toContain(
        'prepare: npm run build exited with status 7',
      );
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        'husky',
        'npm run build',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'reports when a prepare command is killed by a signal',
    () => {
      const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-signal-'));

      try {
        writeFileSync(path.join(binDir, 'husky'), '#!/bin/sh\nkill -TERM $$\n');
        writeFileSync(path.join(binDir, 'npm'), '#!/bin/sh\nexit 0\n');
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);

        const result = spawnSync(
          process.execPath,
          [path.join(root, 'scripts/prepare.js')],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
              QWEN_SKIP_PREPARE: '',
            },
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'prepare: husky killed by signal SIGTERM',
        );
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports when a prepare command cannot be spawned',
    () => {
      const missingBinDir = mkdtempSync(
        path.join(tmpdir(), 'qwen-prepare-missing-bin-'),
      );

      try {
        const result = spawnSync(
          process.execPath,
          [path.join(root, 'scripts/prepare.js')],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: missingBinDir,
              QWEN_SKIP_PREPARE: '',
            },
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('prepare: husky failed:');
      } finally {
        rmSync(missingBinDir, { recursive: true, force: true });
      }
    },
  );

  it('wires release quality checks to fast explicit validation steps', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    const workspaceTestScript = readWorkflow(
      '.github/scripts/run-release-workspace-tests.sh',
    );
    const buildJob = getWorkflowJob(workflow, 'quality_build');
    const workspaceTestJob = getWorkflowJob(workflow, 'workspace_tests');
    const buildStep = getWorkflowStep(buildJob, 'Build Project');
    const serveFastPathStep = getWorkflowStep(
      buildJob,
      'Check Serve Fast Path Bundle',
    );
    const packStep = getWorkflowStep(buildJob, 'Pack Build Outputs');
    const uploadStep = getWorkflowStep(buildJob, 'Upload Build Outputs');
    const verifyPackageStep = getWorkflowStep(
      buildJob,
      'Verify Prepared Package',
    );
    const workspaceTestStep = getWorkflowStep(
      workspaceTestJob,
      'Run Workspace Tests',
    );
    const scriptsTestStep = getWorkflowStep(
      getWorkflowJob(workflow, 'quality_scripts'),
      'Run Script Tests',
    );

    expect(buildJob).toContain("name: 'Check Serve Fast Path Bundle'");
    expect(buildJob).toContain('npm run check:serve-fast-path-bundle');
    expect(buildJob.indexOf(serveFastPathStep)).toBeLessThan(
      buildJob.indexOf(buildStep),
    );
    expect(buildJob.indexOf(uploadStep)).toBeGreaterThan(
      buildJob.indexOf(packStep),
    );
    expect(buildJob.indexOf(verifyPackageStep)).toBeGreaterThan(
      buildJob.indexOf(uploadStep),
    );
    expect(verifyPackageStep).toContain('run-release-step.sh verify-package');
    expect(releaseStepScript).toContain('npm run bundle');
    expect(releaseStepScript).toContain('dist/review-sources.sha256');
    expect(releaseStepScript).toContain('npm run prepare:package');
    expect(workspaceTestStep).toContain(
      '.github/scripts/run-release-workspace-tests.sh',
    );
    expect(workspaceTestScript).toContain('npm run test:release:workspaces');
    expect(workspaceTestScript).not.toContain('npm run test:ci');
    expect(scriptsTestStep).toContain('npm run test:scripts');
    for (const cappedStep of [workspaceTestStep, scriptsTestStep]) {
      for (const name of ['VITEST_MAX_THREADS', 'VITEST_MAX_FORKS']) {
        expect(cappedStep).toContain(
          `${name}: "\${{ startsWith(runner.name, 'ecs-qwen-') && (vars.QWEN_CI_VITEST_MAX_WORKERS || '4') || '' }}"`,
        );
      }
      for (const name of ['VITEST_MIN_THREADS', 'VITEST_MIN_FORKS']) {
        expect(cappedStep).toContain(
          `${name}: "\${{ startsWith(runner.name, 'ecs-qwen-') && '1' || '' }}"`,
        );
      }
    }
  });

  it('skips release install-time prepare and builds before publish bundling', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    expect(workflow.slice(0, workflow.indexOf('jobs:'))).not.toContain(
      'CI_BOT_PAT',
    );
    const installSteps =
      workflow.match(
        / {6}- (?:&[^\n]+\n {8})?name: 'Install Dependencies'[\s\S]*?(?=\n {6}- (?:&[^\n]+\n {8})?name: '|\n {4}[A-Za-z0-9_-]+:|$)/g,
      ) || [];

    // The validation jobs reuse the anchored install step; only the anchor
    // definition plus prepare and publish appear as full textual copies.
    expect(installSteps.length).toBe(3);
    for (const installStep of installSteps) {
      expect(installStep).toContain(
        'npm ci --ignore-scripts --no-audit --progress=false',
      );
      expect(installStep).toContain('npm run postinstall');
      expect(installStep).toContain('npm run generate');
      expect(installStep).not.toContain('QWEN_SKIP_PREPARE');
      expect(installStep).not.toContain('CI_BOT_PAT');
    }

    for (const jobName of ['integration_none', 'integration_docker']) {
      const integrationJob = getWorkflowJob(workflow, jobName);
      const buildStep = getWorkflowStep(integrationJob, 'Build Bundle');
      expect(buildStep).toContain('npm run build && npm run bundle');
    }

    const publishJob = getWorkflowJob(workflow, 'publish');
    expect(publishJob.slice(0, publishJob.indexOf('steps:'))).not.toContain(
      'CI_BOT_PAT',
    );
    const checkoutStep = getWorkflowStep(publishJob, 'Checkout');
    const releaseBranchStep = getWorkflowStep(
      publishJob,
      'Prepare release branch',
    );
    const pushReleaseBranchStep = getWorkflowStep(
      publishJob,
      'Conditionally push release branch',
    );
    const buildStep = getWorkflowStep(
      publishJob,
      'Build Bundle and Prepare Package',
    );

    expect(checkoutStep).toContain('persist-credentials: false');
    expect(releaseBranchStep).not.toContain('CI_BOT_PAT');
    expect(pushReleaseBranchStep).toContain(
      "CI_BOT_PAT: '${{ secrets.CI_BOT_PAT }}'",
    );
    expect(releaseStepScript).toContain('git config core.hooksPath .husky');
    expect(releaseStepScript).toContain('export GH_TOKEN="${CI_BOT_PAT}"');
    expect(releaseStepScript).toContain('gh auth setup-git');
    const exportTokenIdx = releaseStepScript.indexOf(
      'export GH_TOKEN="${CI_BOT_PAT}"',
    );
    const setupGitIdx = releaseStepScript.indexOf(
      'gh auth setup-git',
      exportTokenIdx,
    );
    expect(setupGitIdx).toBeGreaterThan(exportTokenIdx);
    expect(setupGitIdx).toBeLessThan(
      releaseStepScript.indexOf('git push --force --set-upstream'),
    );
    expect(buildStep).toContain('run-release-step.sh build-package');
  });

  it('skips npm packages whose release version is already published', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    const publishJob = getWorkflowJob(workflow, 'publish');
    const publishStep = getWorkflowStep(publishJob, 'Publish npm packages');
    expect(publishStep).toContain(
      "RELEASE_VERSION: '${{ needs.prepare.outputs.release_version }}'",
    );
    expect(releaseStepScript).toContain(
      'package_name="$(node -p "require(\'./package.json\').name")"',
    );
    expect(releaseStepScript).toContain('publish_args+=(--dry-run)');
    expect(releaseStepScript).toContain(
      'npm view "${package_name}@${RELEASE_VERSION}" version',
    );
    expect(releaseStepScript).toContain('already published; skipping');
    expect(releaseStepScript).toContain('exit 0');
    expect(releaseStepScript).toContain(
      'npm publish --provenance "${publish_args[@]}"',
    );
    expect(releaseStepScript).toContain(
      'Every channel package was already published; nothing shipped',
    );
  });

  it('meets npm trusted publishing requirements', () => {
    for (const [workflowPath, jobName, publishStepName] of [
      ['.github/workflows/release.yml', 'publish', 'Publish npm packages'],
      [
        '.github/workflows/release-sdk.yml',
        'release-sdk',
        'Publish @qwen-code/sdk',
      ],
      [
        '.github/workflows/cd-cua-driver.yml',
        'publish-sdk',
        'Publish immutable SDK tarball',
      ],
      [
        '.github/workflows/cd-cua-driver.yml',
        'publish-node-repl',
        'Publish immutable Node REPL tarball',
      ],
      ['.github/workflows/cd-mobile-mcp.yml', 'build-and-publish', 'Publish'],
    ]) {
      const publishJob = getWorkflowJob(readWorkflow(workflowPath), jobName);
      const installStep = getWorkflowStep(publishJob, 'Install npm 11');
      const publishStep = getWorkflowStep(publishJob, publishStepName);
      const publishImplementation =
        workflowPath === '.github/workflows/release.yml'
          ? releaseStepScript
          : publishStep;
      expect(installStep).toContain('npm install --global npm@11.19.0');
      expect(publishJob).toContain("id-token: 'write'");
      expect(publishImplementation).toContain('--provenance');
      expect(publishJob).toContain("name: 'production-release'");
      expect(publishJob.indexOf(installStep)).toBeLessThan(
        publishJob.indexOf(publishStep),
      );
    }

    for (const packageDirectory of [
      'integrations/external-context-mem0',
      'packages/audio-capture',
      'packages/cli',
      'packages/channels/base',
      'packages/channels/dingtalk',
      'packages/channels/dws',
      'packages/channels/feishu',
      'packages/channels/github',
      'packages/channels/qqbot',
      'packages/channels/telegram',
      'packages/channels/wecom',
      'packages/channels/weixin',
      'packages/cua-driver/typescript',
      'packages/mobile-mcp',
      'packages/node-repl',
      'packages/sdk-typescript',
    ]) {
      const packageJson = JSON.parse(
        readFileSync(path.join(root, packageDirectory, 'package.json'), 'utf8'),
      );
      expect(packageJson.repository?.url?.replace(/^git\+/, '')).toBe(
        'https://github.com/QwenLM/qwen-code.git',
      );
    }
  });

  it('fast-tracks trusted autofix issue triggers before LLM assessment', () => {
    const workflow = readWorkflow('.github/workflows/qwen-autofix.yml');
    const issueJob = getWorkflowJob(workflow, 'issue-autofix');
    const scanStep = getWorkflowStep(issueJob, 'Find candidate issues');
    const fastTrackStep = getWorkflowStep(issueJob, 'Fast-track decision');
    const assessStep = getWorkflowStep(issueJob, 'Assess candidates');

    expect(issueJob.indexOf(scanStep)).toBeLessThan(
      issueJob.indexOf(fastTrackStep),
    );
    expect(issueJob.indexOf(fastTrackStep)).toBeLessThan(
      issueJob.indexOf(assessStep),
    );
    expect(fastTrackStep).toContain("id: 'fasttrack'");
    expect(fastTrackStep).toContain('FAST_TRACK=false');
    expect(fastTrackStep).toContain('FAST_TRACK=true');
    expect(fastTrackStep).toContain('fast_tracked=false');
    expect(fastTrackStep).toContain('-n "${FORCED_ISSUE}"');
    expect(fastTrackStep).toContain(
      'Fast-tracked: trusted trigger bypasses LLM assessment.',
    );
    expect(assessStep).toContain(
      "steps.fasttrack.outputs.fast_tracked != 'true'",
    );
  });

  it('skips autofix install-time prepare without disabling dependency scripts', () => {
    const workflow = readWorkflow('.github/workflows/qwen-autofix.yml');

    // review-address restores the shared build-cli bundle instead of
    // compiling, so its install step is npm ci only; the other two jobs
    // still build from sources. Husky hooks are re-armed after the
    // prepare-skip only where git commits happen (build-cli never commits).
    for (const [jobName, stepName, armsHooks] of [
      ['issue-autofix', 'Install dependencies and build', true],
      ['build-cli', 'Install dependencies and build', false],
      ['review-address', 'Install dependencies', true],
    ]) {
      const job = getWorkflowJob(workflow, jobName);
      const installStep = getWorkflowStep(job, stepName);

      expect(installStep).toContain("QWEN_SKIP_PREPARE: '1'");
      expect(installStep).toContain(
        'npm ci --prefer-offline --no-audit --progress=false',
      );
      if (armsHooks) {
        expect(installStep).toContain('git config core.hooksPath .husky');
      }
      expect(installStep).not.toContain('--ignore-scripts');
    }
  });

  it('runs changed autofix tests instead of full touched-package suites', () => {
    const workflow = readWorkflow('.github/workflows/qwen-autofix.yml');
    const reviewVerificationRunner = readWorkflow(
      '.github/scripts/run-autofix-review-verification.sh',
    );
    const reviewJob = getWorkflowJob(workflow, 'review-address');

    for (const verificationBody of [
      getWorkflowStep(
        getWorkflowJob(workflow, 'issue-autofix'),
        'Verification gate',
      ),
      reviewVerificationRunner,
    ]) {
      expect(verificationBody).toContain(
        'npm run test --workspace "${p}" --if-present -- --changed origin/main --passWithNoTests',
      );
      expect(verificationBody).toContain(
        'bash "${RUNNER_TEMP}/resolve-owning-packages.sh"',
      );
      expect(verificationBody).toContain('pkg.scripts?.test');
      expect(verificationBody).toContain('!= *vitest*');
      expect(verificationBody).not.toContain(
        'npm run test --workspace "${p}" --if-present\n',
      );
    }

    expect(getWorkflowStep(reviewJob, 'Verification gate')).toContain(
      'bash --norc "${RUNNER_TEMP}/run-autofix-review-verification.sh"',
    );
  });
});
