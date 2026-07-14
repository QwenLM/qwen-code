#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { constants as osConstants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyChangedFiles } from '../.github/scripts/ci/classify-profile.mjs';

const SETTINGS_SCHEMA_PATH =
  'packages/vscode-ide-companion/schemas/settings.schema.json';
const SUPPORTED_HOSTS = new Set(['darwin/arm64', 'darwin/x64', 'linux/x64']);
const PASSTHROUGH_ENV_KEYS = new Set([
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'RUNNER_TEMP',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

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

export function assertSupportedHost(
  platform = process.platform,
  arch = process.arch,
) {
  if (!SUPPORTED_HOSTS.has(`${platform}/${arch}`)) {
    throw new Error(
      `npm run verify:pr supports macOS x64/ARM64 and Linux x64; found ${platform}/${arch}. Use GitHub CI for unsupported hosts.`,
    );
  }
}

function createBaseEnvironment(baseEnv) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (PASSTHROUGH_ENV_KEYS.has(key) && value !== undefined) env[key] = value;
  }
  return { ...env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
}

export function createGitEnvironment(baseEnv, { home, hooksPath } = {}) {
  const env = createBaseEnvironment(baseEnv);
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
  });
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;
  }
  if (hooksPath) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooksPath,
    });
  }
  return env;
}

function runGit(cwd, args, baseEnv) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: createGitEnvironment(baseEnv),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `git ${args.join(' ')} exited with failure`,
    );
  }
  return result.stdout;
}

export function inspectRepository({ base, cwd, env = process.env }) {
  const status = runGit(
    cwd,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    env,
  );
  if (status) {
    throw new Error(
      'The caller working tree must have no staged, unstaged, or untracked changes.',
    );
  }

  const head = runGit(cwd, ['rev-parse', 'HEAD'], env).trim();
  let baseSha;
  try {
    baseSha = runGit(
      cwd,
      ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
      env,
    ).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to resolve base ref ${base}: ${message}`);
  }
  const mergeBase = runGit(cwd, ['merge-base', baseSha, head], env).trim();
  const changedFiles = runGit(
    cwd,
    ['diff', '--name-only', '--no-renames', '-z', mergeBase, head, '--'],
    env,
  )
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

const GITHUB_HELPER_TEST = [
  'Run GitHub CI helper tests',
  'node',
  '--test',
  '.github/scripts/pr-safety-precheck.test.mjs',
  '.github/scripts/ci/classify-profile.test.mjs',
  '.github/scripts/resolve-sandbox-image.test.mjs',
];

function isRegularWorktreeFile(worktree, file) {
  let currentPath = worktree;
  let stats;
  const segments = file.split('/');

  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    stats = lstatSync(currentPath, { throwIfNoEntry: false });
    if (!stats || stats.isSymbolicLink()) return false;
    if (index < segments.length - 1 && !stats.isDirectory()) return false;
  }

  return stats?.isFile() === true;
}

export function createValidationSteps({ prettierFiles = [], profile }) {
  if (profile === 'docs_only') return [];
  const commands =
    profile === 'github_ci_only'
      ? [
          ['Set up linters', 'node', 'scripts/lint.js', '--setup'],
          ['Run actionlint', 'node', 'scripts/lint.js', '--actionlint'],
          ['Run yamllint', 'node', 'scripts/lint.js', '--yamllint'],
          GITHUB_HELPER_TEST,
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
          GITHUB_HELPER_TEST,
          ...(prettierFiles.length > 0
            ? [
                [
                  'Run Prettier',
                  'npx',
                  'prettier',
                  '--experimental-cli',
                  '--check',
                  '--ignore-unknown',
                  '--',
                  ...prettierFiles,
                ],
              ]
            : []),
          ['Run i18n check', 'npm', 'run', 'check-i18n'],
          [
            'Check settings schema',
            'npm',
            'run',
            'generate:settings-schema',
            '--',
            '--check',
          ],
          [
            'Ensure settings schema is committed',
            'git',
            'cat-file',
            '-e',
            `HEAD:${SETTINGS_SCHEMA_PATH}`,
          ],
          [
            'Check committed settings schema',
            'git',
            'diff',
            '--exit-code',
            'HEAD',
            '--',
            SETTINGS_SCHEMA_PATH,
          ],
          ['Run typecheck', 'npm', 'run', 'typecheck'],
          [
            'Check serve fast-path bundle closure',
            'npm',
            'run',
            'check:serve-fast-path-bundle',
          ],
          [
            'Run unit tests',
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
          [
            'Run script tests',
            'npm',
            'run',
            'test:scripts',
            '--',
            '--no-file-parallelism',
          ],
          [
            'Run no-AK integration tests',
            'npm',
            'run',
            'test:integration:no-ak:sandbox:none',
          ],
          [
            'Install Playwright Chromium',
            'npx',
            'playwright',
            'install',
            'chromium',
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
    steps.find(
      ({ name }) => name === 'Install dependencies',
    ).installEnvironment = true;
    for (const name of [
      'Install Playwright Chromium',
      'Run web shell smoke tests',
    ]) {
      steps.find((candidate) => candidate.name === name).playwrightEnvironment =
        true;
    }
    steps.find(({ name }) => name === 'Run web shell smoke tests').playwright =
      true;
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

  for (const pythonStep of steps) {
    pythonStep.pythonEnvironment = true;
  }
  return steps;
}

export function createStepEnvironment({ baseEnv, home, playwrightPort, step }) {
  const env = createBaseEnvironment(baseEnv);
  Object.assign(env, {
    CI: 'true',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    HOME: home,
    NPM_CONFIG_CACHE: join(home, '.npm'),
    NPM_CONFIG_GLOBAL: 'false',
    NPM_CONFIG_GLOBALCONFIG: '/dev/null',
    NPM_CONFIG_PREFIX: join(home, '.npm-prefix'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
    NO_COLOR: 'true',
    USERPROFILE: home,
  });

  if (step.installEnvironment) {
    Object.assign(env, {
      HUSKY: '0',
      NPM_CONFIG_FETCH_RETRIES: '5',
      NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '120000',
      NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '20000',
      NPM_CONFIG_FETCH_TIMEOUT: '300000',
      NPM_CONFIG_IGNORE_SCRIPTS: 'false',
    });
  }

  if (step.pythonEnvironment) {
    Object.assign(env, {
      PIP_CONFIG_FILE: '/dev/null',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PIP_NO_INPUT: '1',
      PIP_REQUIRE_VIRTUALENV: 'false',
      PIP_USER: 'false',
      PYTHONNOUSERSITE: '1',
      PYTHONUTF8: '1',
      UV_NO_CONFIG: '1',
    });
  }

  if (step.playwrightEnvironment) {
    env.PLAYWRIGHT_BROWSERS_PATH = join(home, 'playwright');
  }

  if (step.playwright) env.PLAYWRIGHT_PORT = String(playwrightPort);
  return env;
}

function quoteArgument(argument) {
  const display = argument.replace(
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0).toString(16)}}`,
  );
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(display)
    ? display
    : `'${display.replaceAll("'", `'"'"'`)}'`;
}

function formatCommand(command) {
  return command.map(quoteArgument).join(' ');
}

function signalChild(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export function executeChild({ command, cwd, env }) {
  return new Promise((resolveResult) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      detached: process.platform !== 'win32',
      env,
      stdio: 'inherit',
    });
    let forwardedSignal;
    let settled = false;
    const signalHandlers = new Map();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      resolveResult(result);
    };

    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        if (forwardedSignal) {
          signalChild(child, 'SIGKILL');
          return;
        }
        forwardedSignal = signal;
        signalChild(child, signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    child.once('error', (error) => {
      finish({
        error,
        relaySignal: forwardedSignal,
        signal: forwardedSignal,
        status: null,
      });
    });
    child.once('exit', (status, signal) => {
      finish({
        relaySignal: forwardedSignal,
        signal: forwardedSignal ?? signal,
        status,
      });
    });
  });
}

class ValidationFailure extends Error {
  constructor({ command, detail, exitCode, relaySignal, signal, stage }) {
    super(`${stage}: ${detail}`);
    this.command = command;
    this.detail = detail;
    this.exitCode = exitCode;
    this.relaySignal = relaySignal;
    this.signal = signal;
    this.stage = stage;
  }
}

function commandFailure(stage, command, result) {
  if (!result.error && !result.signal && result.status === 0) return undefined;
  const signalNumber = result.signal
    ? osConstants.signals[result.signal]
    : undefined;
  const exitCode =
    typeof result.status === 'number'
      ? result.status
      : typeof signalNumber === 'number'
        ? 128 + signalNumber
        : 1;
  const detail = result.error
    ? `spawn error: ${result.error.message}`
    : result.signal
      ? `terminated by signal ${result.signal}`
      : `exited with status ${exitCode}`;
  return new ValidationFailure({
    command,
    detail,
    exitCode,
    relaySignal: result.relaySignal,
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
    const startedAt = now();
    let playwrightPort;
    if (currentStep.playwright) {
      try {
        playwrightPort = await allocatePort();
      } catch (error) {
        throw new ValidationFailure({
          command: currentStep.command,
          detail: `unable to allocate Playwright port: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: 1,
          stage: currentStep.name,
        });
      }
    }
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

function runWorktreeGit({ args, cwd, env }) {
  return spawnSync('git', args, { cwd, env, stdio: 'inherit' });
}

export async function withTemporaryWorktree({
  baseEnv = process.env,
  cwd,
  gitCommand = runWorktreeGit,
  head,
  makeContainer = () =>
    mkdtempSync(
      join(
        realpathSync(process.platform === 'win32' ? tmpdir() : '/tmp'),
        'qwen-verify-pr-',
      ),
    ),
  removeContainer = (container) =>
    rmSync(container, { recursive: true, force: true }),
  reportCleanup = console.error,
  validate,
}) {
  if (!head) throw new Error('Temporary worktree requires an inspected HEAD.');
  const createdContainer = makeContainer();
  let container = createdContainer;
  let gitBaseEnv;
  let paths;
  let added = false;
  const cleanupFailures = [];
  let primaryError;
  let validationResult;

  try {
    container = realpathSync(createdContainer);
    paths = {
      container,
      home: join(container, 'home'),
      hooks: join(container, 'hooks'),
      pythonRoot: join(container, 'python'),
      temp: join(container, 'tmp'),
      worktree: join(container, 'worktree'),
    };
    for (const directory of [
      paths.home,
      paths.hooks,
      paths.pythonRoot,
      paths.temp,
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    gitBaseEnv = {
      ...baseEnv,
      RUNNER_TEMP: container,
      TEMP: paths.temp,
      TMP: paths.temp,
      TMPDIR: paths.temp,
    };
    const gitEnv = createGitEnvironment(gitBaseEnv, {
      home: paths.home,
      hooksPath: paths.hooks,
    });
    const addCommand = ['worktree', 'add', '--detach', paths.worktree, head];
    const addFailure = commandFailure(
      'Create temporary worktree',
      ['git', ...addCommand],
      gitCommand({ args: addCommand, cwd, env: gitEnv }),
    );
    if (addFailure) throw addFailure;
    added = true;
    validationResult = await validate(paths);
  } catch (error) {
    primaryError = error;
  } finally {
    if (added && paths) {
      const removeCommand = [
        'worktree',
        'remove',
        '--force',
        '--force',
        paths.worktree,
      ];
      const cleanupFailure = commandFailure(
        'Clean up temporary worktree',
        ['git', ...removeCommand],
        gitCommand({
          args: removeCommand,
          cwd,
          env: createGitEnvironment(gitBaseEnv, {
            home: paths.home,
            hooksPath: paths.hooks,
          }),
        }),
      );
      if (cleanupFailure) cleanupFailures.push(cleanupFailure);
    }
    try {
      removeContainer(container);
    } catch (error) {
      cleanupFailures.push(
        new ValidationFailure({
          detail: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          stage: 'Clean up temporary container',
        }),
      );
    }
  }

  if (primaryError) {
    for (const failure of cleanupFailures) {
      reportCleanup(`Cleanup also failed: ${failure.message}`);
    }
    throw primaryError;
  }
  if (cleanupFailures.length > 0) {
    for (const failure of cleanupFailures.slice(1)) {
      reportCleanup(`Cleanup also failed: ${failure.message}`);
    }
    throw cleanupFailures[0];
  }
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
    arch = process.arch,
    baseEnv = process.env,
    error = console.error,
    inspect = inspectRepository,
    log = console.log,
    nodeVersion = process.versions.node,
    now = Date.now,
    platform = process.platform,
    runValidationSteps = runSteps,
    temporaryWorktree = withTemporaryWorktree,
  } = {},
) {
  const startedAt = now();
  assertNode22(nodeVersion);
  assertSupportedHost(platform, arch);
  const repository = inspect({ base, cwd, env: baseEnv });
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
      baseEnv,
      cwd,
      head: repository.head,
      reportCleanup: error,
      validate: async ({ container, home, pythonRoot, temp, worktree }) => {
        const prettierFiles =
          profile === 'full'
            ? repository.changedFiles.filter((file) =>
                isRegularWorktreeFile(worktree, file),
              )
            : [];
        const steps = createValidationSteps({ prettierFiles, profile });
        if (profile === 'full' && needsPythonChecks(repository.changedFiles)) {
          steps.push(...createPythonSteps({ pythonRoot }));
        }
        await runValidationSteps({
          allocatePort,
          baseEnv: {
            ...baseEnv,
            RUNNER_TEMP: container,
            TEMP: temp,
            TMP: temp,
            TMPDIR: temp,
          },
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
      `Rerun: npm run verify:pr -- --base ${quoteArgument(options.base)} --profile ${options.profile}`,
    );
    if (typeof context.relaySignal === 'string') {
      relaySignal(context.relaySignal);
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
