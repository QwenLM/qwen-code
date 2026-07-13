#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyChangedFiles } from '../.github/scripts/ci/classify-profile.mjs';

export function parseArgs(argv) {
  const options = {
    base: 'origin/main',
    help: false,
    profile: 'full',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') {
      options.help = true;
      continue;
    }

    if (option !== '--base' && option !== '--profile') {
      throw new Error(`Unknown option or positional argument: ${option}`);
    }

    const value = argv[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${option}`);
    }

    if (option === '--base') options.base = value;
    if (option === '--profile') {
      if (value !== 'full' && value !== 'auto') {
        throw new Error(`Invalid profile: ${value}`);
      }
      options.profile = value;
    }
  }

  return options;
}

export function assertNode22(version) {
  if (Number.parseInt(version, 10) !== 22) {
    throw new Error(`Node 22 is required; found ${version}`);
  }
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `git ${args.join(' ')} exited with failure`,
    );
  }
  return result.stdout;
}

export function inspectRepository({ base, cwd }) {
  const status = runGit(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (status) {
    throw new Error(
      'The caller working tree must have no staged, unstaged, or untracked changes.',
    );
  }

  const head = runGit(cwd, ['rev-parse', 'HEAD']).trim();
  let baseSha;
  try {
    baseSha = runGit(cwd, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${base}^{commit}`,
    ]).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to resolve base ref ${base}: ${message}`);
  }
  const mergeBase = runGit(cwd, ['merge-base', baseSha, head]).trim();
  const changedFiles = runGit(cwd, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    mergeBase,
    head,
    '--',
  ])
    .split('\0')
    .filter(Boolean);

  if (changedFiles.length === 0) {
    throw new Error(`No committed changes found against ${base}.`);
  }

  return { baseSha, changedFiles, head, mergeBase };
}

export function selectProfile({
  changedFiles,
  classify = classifyChangedFiles,
  requestedProfile,
}) {
  return requestedProfile === 'auto' ? classify(changedFiles) : 'full';
}

function step(name, ...command) {
  return { command, name };
}

export function createValidationSteps({ profile }) {
  if (profile === 'docs_only') return [];
  const commands =
    profile === 'github_ci_only'
      ? [
          ['Set up linters', 'node', 'scripts/lint.js', '--setup'],
          ['Run actionlint', 'node', 'scripts/lint.js', '--actionlint'],
          ['Run yamllint', 'node', 'scripts/lint.js', '--yamllint'],
          [
            'Run GitHub CI helper tests',
            'node',
            '--test',
            '.github/scripts/pr-safety-precheck.test.mjs',
            '.github/scripts/ci/classify-profile.test.mjs',
            '.github/scripts/resolve-sandbox-image.test.mjs',
          ],
        ]
      : [
          [
            'Install dependencies',
            'npm',
            'ci',
            '--prefer-offline',
            '--no-audit',
            '--progress=false',
            '--ignore-scripts=false',
          ],
          [
            'Audit critical runtime dependencies',
            'npm',
            'run',
            'audit:runtime:critical',
          ],
          ['Check lockfile', 'npm', 'run', 'check:lockfile'],
          [
            'Check desktop workspace isolation',
            'npm',
            'run',
            'check:desktop-isolation',
          ],
          ['Set up linters', 'node', 'scripts/lint.js', '--setup'],
          ['Run ESLint', 'node', 'scripts/lint.js', '--eslint'],
          ['Run actionlint', 'node', 'scripts/lint.js', '--actionlint'],
          ['Run shellcheck', 'node', 'scripts/lint.js', '--shellcheck'],
          ['Run yamllint', 'node', 'scripts/lint.js', '--yamllint'],
          [
            'Run Prettier',
            'npx',
            'prettier',
            '--experimental-cli',
            '--check',
            '.',
          ],
          ['Run i18n check', 'npm', 'run', 'check-i18n'],
          [
            'Check settings schema',
            'npm',
            'run',
            'generate:settings-schema',
            '--',
            '--check',
          ],
          ['Run typecheck', 'npm', 'run', 'typecheck'],
          [
            'Check serve fast-path bundle closure',
            'npm',
            'run',
            'check:serve-fast-path-bundle',
          ],
          ['Run unit tests', 'npm', 'run', 'test:ci'],
          [
            'Run no-AK integration tests',
            'npm',
            'run',
            'test:integration:no-ak:sandbox:none',
          ],
          [
            'Run web shell smoke tests',
            'npm',
            'run',
            'test:e2e:smoke',
            '--workspace=packages/web-shell',
          ],
        ];
  const steps = commands.map(([name, ...command]) => step(name, ...command));
  if (profile === 'full') {
    steps[0].installEnvironment = true;
    for (const testStep of steps.slice(14)) testStep.testEnvironment = true;
    for (const isolatedHomeStep of steps.slice(14, 16)) {
      isolatedHomeStep.isolatedHome = true;
    }
    steps[16].playwright = true;
  }
  return steps;
}

export function needsPythonChecks(changedFiles) {
  return changedFiles.some((file) => {
    const normalized = file.replace(/\\/g, '/');
    return (
      normalized.startsWith('packages/sdk-python/') ||
      normalized === '.github/workflows/sdk-python.yml'
    );
  });
}

export function getVenvPythonPath(venv, platform = process.platform) {
  return platform === 'win32'
    ? join(venv, 'Scripts', 'python.exe')
    : join(venv, 'bin', 'python');
}

export function createPythonSteps({ platform = process.platform, pythonRoot }) {
  const steps = [
    {
      ...step('Require uv', 'uv', '--version'),
      uvRequirement: true,
    },
  ];

  for (const version of ['3.10', '3.11', '3.12']) {
    const venv = join(pythonRoot, version);
    const python = getVenvPythonPath(venv, platform);
    const commands = [
      ['Create virtualenv', 'uv', 'venv', '--python', version, '--seed', venv],
      ['Upgrade pip', python, '-m', 'pip', 'install', '--upgrade', 'pip'],
      [
        'Install SDK test dependencies',
        python,
        '-m',
        'pip',
        'install',
        '-e',
        'packages/sdk-python[dev]',
      ],
      [
        'Run Ruff',
        python,
        '-m',
        'ruff',
        'check',
        '--config',
        'packages/sdk-python/pyproject.toml',
        'packages/sdk-python',
      ],
      [
        'Run Ruff format',
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
        'Run Mypy',
        python,
        '-m',
        'mypy',
        '--config-file',
        'packages/sdk-python/pyproject.toml',
        'packages/sdk-python/src',
      ],
      [
        'Run Pytest',
        python,
        '-m',
        'pytest',
        '-c',
        'packages/sdk-python/pyproject.toml',
        'packages/sdk-python/tests',
        '-q',
      ],
    ];
    steps.push(
      ...commands.map(([name, ...command]) =>
        step(`${name} (Python ${version})`, ...command),
      ),
    );
  }

  return steps;
}

export function createStepEnvironment({ baseEnv, home, playwrightPort, step }) {
  const env = { ...baseEnv };

  if (step.installEnvironment) {
    Object.assign(env, {
      HUSKY: '0',
      NPM_CONFIG_FETCH_RETRIES: '5',
      NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '120000',
      NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '20000',
      NPM_CONFIG_FETCH_TIMEOUT: '300000',
    });
    delete env.QWEN_SKIP_PREPARE;
  }

  if (step.testEnvironment) {
    Object.assign(env, {
      CI: 'true',
      NO_COLOR: 'true',
    });
    for (const key of [
      'OPENAI_API_KEY',
      'DASHSCOPE_API_KEY',
      'QWEN_API_KEY',
      'GEMINI_API_KEY',
      'QWEN_DEFAULT_AUTH_TYPE',
    ]) {
      delete env[key];
    }
  }

  if (step.isolatedHome) {
    env.HOME = home;
    env.USERPROFILE = home;
  }

  if (step.playwright) env.PLAYWRIGHT_PORT = String(playwrightPort);
  return env;
}

function quoteArgument(argument) {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(argument)
    ? argument
    : `'${argument.replaceAll("'", `'"'"'`)}'`;
}

function formatCommand(command) {
  return command.map(quoteArgument).join(' ');
}

function executeChild({ command, cwd, env }) {
  return spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    stdio: 'inherit',
  });
}

class ValidationFailure extends Error {
  constructor({ command, detail, exitCode, signal, stage }) {
    super(`${stage}: ${detail}`);
    this.command = command;
    this.detail = detail;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stage = stage;
  }
}

function commandFailure(stage, command, result) {
  if (!result.error && !result.signal && result.status === 0) return undefined;
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const detail = result.error
    ? `spawn error: ${result.error.message}`
    : result.signal
      ? `terminated by signal ${result.signal}`
      : `exited with status ${exitCode}`;
  return new ValidationFailure({
    command,
    detail,
    exitCode,
    signal: result.signal ?? undefined,
    stage,
  });
}

export async function runSteps({
  allocatePort,
  baseEnv,
  cwd,
  execute = executeChild,
  home,
  log = console.log,
  now = Date.now,
  steps,
}) {
  for (const [index, currentStep] of steps.entries()) {
    log(`[${index + 1}/${steps.length}] ${currentStep.name}`);
    log(`Command: ${formatCommand(currentStep.command)}`);
    const playwrightPort = currentStep.playwright
      ? await allocatePort()
      : undefined;
    const startedAt = now();
    const result = await execute({
      command: currentStep.command,
      cwd,
      env: createStepEnvironment({
        baseEnv,
        home,
        playwrightPort,
        step: currentStep,
      }),
    });
    log(`Elapsed: ${((now() - startedAt) / 1000).toFixed(1)}s`);

    const failure = commandFailure(
      currentStep.name,
      currentStep.command,
      result,
    );
    if (!failure) continue;
    if (currentStep.uvRequirement) {
      failure.detail = `uv is required for Python SDK verification. Install uv and ensure it is on PATH. ${failure.detail}`;
      failure.message = `${failure.stage}: ${failure.detail}`;
    }
    throw failure;
  }
}

function runWorktreeGit({ args, cwd }) {
  return spawnSync('git', args, { cwd, stdio: 'inherit' });
}

export async function withTemporaryWorktree({
  cwd,
  gitCommand = runWorktreeGit,
  makeContainer = () => mkdtempSync(join(tmpdir(), 'qwen-verify-pr-')),
  removeContainer = (container) =>
    rmSync(container, { recursive: true, force: true }),
  reportCleanup = console.error,
  validate,
}) {
  const container = makeContainer();
  const paths = {
    container,
    home: join(container, 'home'),
    pythonRoot: join(container, 'python'),
    worktree: join(container, 'worktree'),
  };
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.pythonRoot, { recursive: true });
  let added = false;
  let cleanupFailure;
  let primaryError;
  let validationResult;

  try {
    const addCommand = ['worktree', 'add', '--detach', paths.worktree, 'HEAD'];
    const addFailure = commandFailure(
      'Create temporary worktree',
      ['git', ...addCommand],
      gitCommand({ args: addCommand, cwd }),
    );
    if (addFailure) throw addFailure;
    added = true;
    validationResult = await validate(paths);
  } catch (error) {
    primaryError = error;
  } finally {
    if (added) {
      const removeCommand = ['worktree', 'remove', '--force', paths.worktree];
      cleanupFailure = commandFailure(
        'Clean up temporary worktree',
        ['git', ...removeCommand],
        gitCommand({ args: removeCommand, cwd }),
      );
    }
    try {
      removeContainer(container);
    } catch (error) {
      cleanupFailure ??= new ValidationFailure({
        command: ['remove temporary container', container],
        detail: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        stage: 'Clean up temporary container',
      });
    }
  }

  if (primaryError) {
    if (cleanupFailure)
      reportCleanup(`Cleanup also failed: ${cleanupFailure.message}`);
    throw primaryError;
  }
  if (cleanupFailure) throw cleanupFailure;
  return validationResult;
}

function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (typeof address === 'object' && address) resolve(address.port);
        else reject(new Error('Unable to allocate a localhost port.'));
      });
    });
  });
}

export async function verifyPullRequest(
  { base, cwd, requestedProfile },
  {
    allocatePort = allocateFreePort,
    baseEnv = process.env,
    error = console.error,
    inspect = inspectRepository,
    log = console.log,
    nodeVersion = process.versions.node,
    now = Date.now,
    runValidationSteps = runSteps,
    temporaryWorktree = withTemporaryWorktree,
  } = {},
) {
  const startedAt = now();
  assertNode22(nodeVersion);
  const repository = inspect({ base, cwd });
  const profile = selectProfile({
    changedFiles: repository.changedFiles,
    requestedProfile,
  });

  log(`Base: ${base}`);
  log(`HEAD: ${repository.head}`);
  log(`Changed files: ${repository.changedFiles.length}`);
  log(`Profile: ${profile}`);

  if (profile === 'docs_only') {
    log('Docs-only change; full CI skipped.');
    log(`Total elapsed: ${((now() - startedAt) / 1000).toFixed(1)}s`);
    return { ...repository, profile };
  }

  try {
    await temporaryWorktree({
      cwd,
      reportCleanup: error,
      validate: async ({ container, home, pythonRoot, worktree }) => {
        const steps = createValidationSteps({ profile });
        if (profile === 'full' && needsPythonChecks(repository.changedFiles)) {
          steps.push(...createPythonSteps({ pythonRoot }));
        }
        await runValidationSteps({
          allocatePort,
          baseEnv: { ...baseEnv, RUNNER_TEMP: container },
          cwd: worktree,
          home,
          log,
          now,
          steps,
        });
      },
    });
  } catch (failure) {
    if (failure && typeof failure === 'object') {
      failure.base = base;
      failure.head = repository.head;
      failure.profile = profile;
    }
    throw failure;
  }

  log(`Total elapsed: ${((now() - startedAt) / 1000).toFixed(1)}s`);
  return { ...repository, profile };
}

const USAGE = `Usage: npm run verify:pr -- [options]

Options:
  --base <ref>           Base ref (default: origin/main)
  --profile <full|auto>  Validation profile (default: full)
  --help                 Show this help`;

export async function runCli(
  argv,
  {
    cwd = process.cwd(),
    error = console.error,
    log = console.log,
    relaySignal = (signal) => process.kill(process.pid, signal),
    verify = verifyPullRequest,
  } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (parseError) {
    error(
      parseError instanceof Error ? parseError.message : String(parseError),
    );
    error(USAGE);
    return 1;
  }

  if (options.help) {
    log(USAGE);
    return 0;
  }

  try {
    await verify({
      base: options.base,
      cwd,
      requestedProfile: options.profile,
    });
    return 0;
  } catch (failure) {
    const context = failure && typeof failure === 'object' ? failure : {};
    const command = Array.isArray(context.command)
      ? formatCommand(context.command)
      : 'not started';
    error('PR verification failed.');
    error(`Stage: ${context.stage ?? 'Caller guards'}`);
    error(`Command: ${command}`);
    error(`HEAD: ${context.head ?? 'unresolved'}`);
    error(`Base: ${context.base ?? options.base}`);
    error(`Profile: ${context.profile ?? options.profile}`);
    error(`Error: ${context.detail ?? context.message ?? String(failure)}`);
    error(
      Array.isArray(context.command)
        ? `Rerun failed step: ${command}`
        : `Rerun: npm run verify:pr -- --base ${quoteArgument(options.base)} --profile ${options.profile}`,
    );
    if (typeof context.signal === 'string') {
      relaySignal(context.signal);
      return 1;
    }
    return Number.isInteger(context.exitCode) && context.exitCode > 0
      ? context.exitCode
      : 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
