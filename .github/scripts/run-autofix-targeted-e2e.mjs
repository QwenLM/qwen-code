#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_CASES = 5;
const CASE_TIMEOUT_MS = 20 * 60 * 1000;
const TRUSTED_EXTERNAL_PROCESS_TESTS = new Set([
  'cli/qwen-serve-client-mcp.test.ts',
]);
const SAFE_ENV_NAMES = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'CI',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'TMPDIR',
  'TMP',
  'TEMP',
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      fail('Invalid arguments');
    options[key.slice(2)] = value;
  }
  return options;
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function expectedFullName(testCase) {
  return testCase.name
    .split(' > ')
    .map((segment) => segment.trim())
    .join(' ');
}

export function validateTestPath(file, workspace = process.cwd()) {
  if (
    typeof file !== 'string' ||
    !file ||
    file.includes('\0') ||
    file.includes('\n')
  )
    fail('Invalid E2E test path');
  if (isAbsolute(file)) fail('Absolute E2E test paths are forbidden');
  const normalized = normalize(file);
  if (normalized === '..' || normalized.startsWith(`..${sep}`))
    fail('E2E test path escapes integration-tests');
  if (!/\.test\.[cm]?[jt]sx?$/.test(normalized))
    fail('E2E target is not a test file');
  if (!TRUSTED_EXTERNAL_PROCESS_TESTS.has(normalized))
    fail(
      `E2E target is not in the trusted external-process allowlist: ${file}`,
    );
  const root = resolve(workspace, 'integration-tests');
  const absolute = resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
    fail('E2E test path escapes integration-tests');
  if (!existsSync(absolute)) fail(`E2E test file does not exist: ${file}`);
  return { normalized, absolute };
}

export function validateMetadata(metadata, workspace = process.cwd()) {
  if (metadata?.schemaVersion !== 1 || metadata?.kind !== 'main-e2e-failure')
    fail('Unsupported targeted E2E metadata');
  const verification = metadata?.verification;
  if (!verification?.eligible || !verification?.complete)
    fail(
      `Targeted E2E metadata is not eligible: ${(verification?.reasons ?? []).join('; ')}`,
    );
  if (!Array.isArray(verification.cases) || verification.cases.length === 0)
    fail('No targeted E2E cases were provided');
  if (
    verification.cases.length > MAX_CASES ||
    verification.totalCases !== verification.cases.length
  )
    fail('Targeted E2E case set is incomplete or exceeds the limit');

  return verification.cases.map((testCase) => {
    if (testCase.os !== 'linux') fail(`Unsupported E2E OS: ${testCase.os}`);
    if (testCase.sandbox !== 'none')
      fail(`Unsupported E2E sandbox: ${testCase.sandbox}`);
    if (
      typeof testCase.name !== 'string' ||
      !testCase.name.trim() ||
      testCase.name.length > 1000 ||
      /[\0\r\n]/.test(testCase.name)
    )
      fail('Invalid E2E test name');
    const path = validateTestPath(testCase.file, workspace);
    const canonicalId = `${path.normalized} > ${testCase.name}`;
    if (testCase.id !== canonicalId || canonicalId.length > 1200)
      fail('Invalid E2E test ID');
    return {
      ...testCase,
      id: canonicalId,
      file: path.normalized,
      fullName: expectedFullName(testCase),
    };
  });
}

export function isProtectedVerificationPath(file) {
  return (
    file === '.gitattributes' ||
    file === '.gitignore' ||
    file === '.npmrc' ||
    file === 'esbuild.config.js' ||
    file === 'package.json' ||
    file === 'package-lock.json' ||
    file === 'npm-shrinkwrap.json' ||
    file === 'tsconfig.json' ||
    file === 'vitest.config.ts' ||
    file.startsWith('.github/') ||
    file.startsWith('integration-tests/') ||
    file.startsWith('patches/') ||
    file.startsWith('scripts/') ||
    file.includes('/scripts/') ||
    file.endsWith('/package.json') ||
    file.endsWith('/package-lock.json') ||
    file.endsWith('/npm-shrinkwrap.json') ||
    /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(file) ||
    /(^|\/)(?:test|tests|__tests__|test-utils|fixtures|__fixtures__|mocks|__mocks__)\//.test(
      file,
    ) ||
    /(^|\/)node_modules(?:\/|$)/.test(file) ||
    /(^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /(^|\/)__snapshots__\//.test(file) ||
    /(^|\/)(?:test-setup|setup-tests?)\.[cm]?[jt]sx?$/.test(file) ||
    /(^|\/)(?:build|esbuild)\.(?:[cm]?[jt]s|sh)$/.test(file) ||
    /(^|\/)(?:babel|esbuild|eslint|jest|playwright|postcss|rollup|tailwind|vite|vitest|webpack)(?:\.[^/]*)?\.config\.[cm]?[jt]s$/.test(
      file,
    ) ||
    /(^|\/)\.eslintrc(?:\.[cm]?[jt]s|\.json)?$/.test(file)
  );
}

export function validateCandidateScope(metadata, workspace = process.cwd()) {
  const sourceSha = metadata?.source?.headSha;
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? ''))
    fail('Invalid targeted E2E source SHA');
  run('git', ['merge-base', '--is-ancestor', sourceSha, 'HEAD'], {
    cwd: workspace,
    stdio: 'pipe',
  });
  const changedOutput = run(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', `${sourceSha}...HEAD`],
    { cwd: workspace, stdio: 'pipe', encoding: 'buffer' },
  ).stdout;
  const changedText = changedOutput.toString('utf8');
  if (!Buffer.from(changedText).equals(changedOutput))
    fail('Candidate changed a path that is not valid UTF-8');
  const changed = changedText.split('\0').filter(Boolean);
  const protectedChanges = changed.filter(isProtectedVerificationPath);
  if (protectedChanges.length)
    fail(
      `Candidate changes trusted targeted E2E inputs: ${protectedChanges.join(', ')}`,
    );
}

export function validateVitestReport(
  report,
  testCase,
  workspace = process.cwd(),
) {
  if (report?.success !== true)
    fail(`Vitest did not report success for ${testCase.id}`);
  const assertions = (report?.testResults ?? []).flatMap(
    (result) => result.assertionResults ?? [],
  );
  const matches = assertions.filter(
    (assertion) => assertion.fullName === testCase.fullName,
  );
  if (matches.length !== 1)
    fail(
      `Expected exactly one assertion for ${testCase.id}, found ${matches.length}`,
    );
  if (matches[0].status !== 'passed')
    fail(`Targeted E2E assertion did not pass: ${testCase.id}`);
  const passed = assertions.filter(
    (assertion) => assertion.status === 'passed',
  );
  if (passed.length !== 1)
    fail(`Expected exactly one passed assertion, found ${passed.length}`);

  const expectedFile = resolve(workspace, 'integration-tests', testCase.file);
  const containingResults = (report.testResults ?? []).filter((result) =>
    (result.assertionResults ?? []).some(
      (assertion) => assertion.fullName === testCase.fullName,
    ),
  );
  if (
    containingResults.length !== 1 ||
    resolve(containingResults[0].name) !== expectedFile
  )
    fail(`Vitest report file mismatch for ${testCase.id}`);
}

export function verificationEnv(home, source = process.env) {
  const env = {};
  for (const name of SAFE_ENV_NAMES) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return {
    ...env,
    HOME: home,
    QWEN_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    KEEP_OUTPUT: 'true',
    VERBOSE: 'true',
    QWEN_SKIP_PREPARE: '1',
    QWEN_SKIP_SETTINGS_SCHEMA_GENERATION: '1',
  };
}

function run(command, args, options = {}) {
  const executable = options.wrapper ?? command;
  const executableArgs = options.wrapper
    ? [options.cwd, command, ...args]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: options.encoding === 'buffer' ? null : 'utf8',
    stdio: options.stdio ?? 'inherit',
    timeout: options.timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} exited with status ${result.status}`);
  return result;
}

export function runTargetedE2e({
  metadataPath,
  reportPath,
  workspace = process.cwd(),
  commandWrapper,
  vitestWrapper,
  worktreeHelper,
  outputValidator,
}) {
  if (!vitestWrapper) fail('Trusted Vitest wrapper is required');
  let directory;
  let activeReport;
  const lines = ['# Targeted E2E verification', ''];
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const cases = validateMetadata(metadata, workspace);
    validateCandidateScope(metadata, workspace);
    directory = mkdtempSync(join(tmpdir(), 'autofix-targeted-e2e-'));
    const env = verificationEnv(join(directory, 'qwen-home'));
    const candidateOptions = {
      cwd: workspace,
      env,
      timeout: CASE_TIMEOUT_MS,
      wrapper: commandWrapper,
    };
    run(
      'npm',
      [
        'ci',
        '--ignore-scripts',
        '--prefer-offline',
        '--no-audit',
        '--progress=false',
      ],
      candidateOptions,
    );
    run('npx', ['--no-install', 'patch-package'], candidateOptions);
    if (worktreeHelper) {
      run(worktreeHelper, [workspace, 'dependencies'], { cwd: workspace });
    }
    run('npm', ['run', 'generate'], candidateOptions);
    run('npm', ['run', 'build'], candidateOptions);
    run('npm', ['run', 'bundle'], candidateOptions);
    if (outputValidator) {
      run('node', [outputValidator], { cwd: workspace });
    }
    if (worktreeHelper) {
      run(worktreeHelper, [workspace, 'finalize'], { cwd: workspace });
    }

    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index];
      const reportName = `case-${index}`;
      if (commandWrapper && worktreeHelper) {
        activeReport = reportName;
        run(worktreeHelper, [workspace, 'report', reportName], {
          cwd: workspace,
        });
      }
      const jsonPath = `/tmp/qwen-autofix-verify-home/reports/${reportName}/report.json`;
      const pattern = `^${escapeRegex(testCase.fullName)}$`;
      run(vitestWrapper, [workspace, reportName, testCase.file, pattern], {
        cwd: workspace,
        timeout: CASE_TIMEOUT_MS,
      });
      const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
      validateVitestReport(report, testCase, workspace);
      if (commandWrapper && worktreeHelper) {
        run(worktreeHelper, [workspace, 'remove-report', reportName], {
          cwd: workspace,
        });
        activeReport = undefined;
      }
      lines.push(`- ${testCase.id} — passed (${testCase.sandbox})`);
    }
    if (worktreeHelper) {
      run(worktreeHelper, [workspace, 'cleanup'], { cwd: workspace });
    }
    if (outputValidator) {
      run('node', [outputValidator], { cwd: workspace });
    }
    writeFileSync(reportPath, `${lines.join('\n')}\n`);
  } catch (error) {
    lines.push(`- failed: ${String(error.message).replace(/[\r\n]+/g, ' ')}`);
    writeFileSync(reportPath, `${lines.join('\n')}\n`);
    throw error;
  } finally {
    if (activeReport && worktreeHelper) {
      try {
        run(worktreeHelper, [workspace, 'remove-report', activeReport], {
          cwd: workspace,
        });
      } catch (cleanupError) {
        void cleanupError;
      }
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.metadata || !options.report) fail('Missing required arguments');
  runTargetedE2e({
    metadataPath: options.metadata,
    reportPath: options.report,
    commandWrapper: options['command-wrapper'],
    vitestWrapper: options['vitest-wrapper'],
    worktreeHelper: options['worktree-helper'],
    outputValidator: options['output-validator'],
  });
}
