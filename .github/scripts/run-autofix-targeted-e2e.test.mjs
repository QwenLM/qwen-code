import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  MAX_TARGETED_E2E_CASES,
  TRUSTED_EXTERNAL_PROCESS_E2E_TESTS,
} from './ci/main-failure-signature.mjs';
import {
  MAX_CASES,
  TRUSTED_EXTERNAL_PROCESS_TESTS,
  escapeRegex,
  expectedFullName,
  isProtectedVerificationPath,
  validateCandidateScope,
  validateMetadata,
  validateTestPath,
  validateVitestReport,
  verificationEnv,
} from './run-autofix-targeted-e2e.mjs';
import { isProtectedVerificationPath as validatorIsProtectedPath } from './validate-autofix-verification-outputs.mjs';

function withWorkspace(run) {
  const workspace = mkdtempSync(join(tmpdir(), 'targeted-e2e-test-'));
  mkdirSync(join(workspace, 'integration-tests', 'cli'), { recursive: true });
  writeFileSync(
    join(
      workspace,
      'integration-tests',
      'cli',
      'qwen-serve-client-mcp.test.ts',
    ),
    '',
  );
  try {
    return run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function initRepository(workspace) {
  execFileSync('git', ['init'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: workspace,
  });
}

function headSha(workspace) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspace,
    encoding: 'utf8',
  }).trim();
}

function commit(workspace, message) {
  execFileSync('git', ['add', '.'], { cwd: workspace });
  execFileSync('git', ['commit', '-m', message], { cwd: workspace });
}

function metadata(testCase) {
  return {
    schemaVersion: 1,
    kind: 'main-e2e-failure',
    verification: {
      eligible: true,
      complete: true,
      reasons: [],
      totalCases: 1,
      cases: [testCase],
    },
  };
}

const testCase = {
  id: 'cli/qwen-serve-client-mcp.test.ts > suite > case (a+b)',
  file: 'cli/qwen-serve-client-mcp.test.ts',
  name: 'suite > case (a+b)',
  job: 'E2E Test (Linux) - sandbox:none - shard 1/3',
  os: 'linux',
  sandbox: 'none',
  shard: '1/3',
};

test('converts Vitest log IDs to exact reporter full names and regexes', () => {
  assert.equal(expectedFullName(testCase), 'suite case (a+b)');
  assert.equal(escapeRegex('suite case (a+b)'), 'suite case \\(a\\+b\\)');
});

test('validates candidate scope and rebuilds before targeted E2E cases', () => {
  const source = readFileSync(
    new URL('./run-autofix-targeted-e2e.mjs', import.meta.url),
    'utf8',
  );
  const scopeAt = source.indexOf(
    'validateCandidateScope(metadata, base, workspace)',
  );
  const installAt = source.indexOf("'--ignore-scripts'");
  const dependenciesAt = source.indexOf("[workspace, 'dependencies']");
  const generateAt = source.indexOf(
    "run('npm', ['run', 'generate'], candidateOptions)",
  );
  const buildAt = source.indexOf(
    "run('npm', ['run', 'build'], candidateOptions)",
  );
  const bundleAt = source.indexOf(
    "run('npm', ['run', 'bundle'], candidateOptions)",
  );
  const outputAuditAt = source.indexOf("run('node', [outputValidator]");
  const finalizeAt = source.indexOf("[workspace, 'finalize']");
  const reportAt = source.indexOf("[workspace, 'report', reportName]");
  const vitestAt = source.indexOf('run(vitestWrapper,');
  const removeReportAt = source.indexOf(
    "[workspace, 'remove-report', reportName]",
    vitestAt,
  );
  const cleanupAt = source.indexOf("[workspace, 'cleanup']", vitestAt);
  const finalOutputAuditAt = source.indexOf(
    "run('node', [outputValidator]",
    outputAuditAt + 1,
  );
  for (const position of [
    scopeAt,
    installAt,
    dependenciesAt,
    generateAt,
    buildAt,
    bundleAt,
    outputAuditAt,
    finalizeAt,
    reportAt,
    vitestAt,
    removeReportAt,
    cleanupAt,
    finalOutputAuditAt,
  ]) {
    assert.notEqual(position, -1);
  }
  assert.ok(scopeAt < installAt);
  assert.ok(installAt < dependenciesAt);
  assert.ok(dependenciesAt < generateAt);
  assert.ok(generateAt < buildAt);
  assert.ok(buildAt < bundleAt);
  assert.ok(bundleAt < outputAuditAt);
  assert.ok(outputAuditAt < finalizeAt);
  assert.ok(finalizeAt < reportAt);
  assert.ok(reportAt < vitestAt);
  assert.ok(vitestAt < removeReportAt);
  assert.ok(removeReportAt < cleanupAt);
  assert.ok(cleanupAt < finalOutputAuditAt);
});

test('removes GitHub and provider credentials from the test environment', () => {
  const env = verificationEnv('/tmp/isolated-home', {
    PATH: '/usr/bin',
    CI_DEV_BOT_PAT: 'bot-secret',
    GITHUB_TOKEN: 'workflow-secret',
    GH_TOKEN: 'gh-secret',
    OPENAI_API_KEY: 'openai-secret',
    DASHSCOPE_API_KEY: 'dashscope-secret',
    QWEN_API_KEY: 'qwen-secret',
    MODELSCOPE_API_KEY: 'modelscope-secret',
    QWEN_CUSTOM_API_KEY_INTERNAL: 'custom-secret',
    CUSTOM_ANTHROPIC_KEY: 'custom-provider-secret',
    QWEN_SERVER_TOKEN: 'server-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    OPENAI_BASE_URL: 'https://provider.example',
    OPENAI_MODEL: 'provider-model',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/tmp/isolated-home',
    QWEN_HOME: '/tmp/isolated-home',
    XDG_CONFIG_HOME: '/tmp/isolated-home/.config',
    XDG_CACHE_HOME: '/tmp/isolated-home/.cache',
    KEEP_OUTPUT: 'true',
    VERBOSE: 'true',
    QWEN_SKIP_PREPARE: '1',
    QWEN_SKIP_SETTINGS_SCHEMA_GENERATION: '1',
  });
});

test('protects targeted E2E tests and their execution inputs', () => {
  for (const file of [
    '.github/workflows/qwen-autofix.yml',
    '.gitattributes',
    '.gitignore',
    '.npmrc',
    'esbuild.config.js',
    'eslint.config.js',
    'eslint.legacy-filenames.mjs',
    'integration-tests/cli/sample.test.ts',
    'integration-tests/vitest.config.ts',
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'packages/core/package.json',
    'packages/core/npm-shrinkwrap.json',
    'packages/core/tsconfig.json',
    'packages/sdk-typescript/tsconfig.build.json',
    'packages/web-shell/tsconfig.lib.json',
    'packages/core/src/config/config.test.ts',
    'packages/sdk-typescript/test/unit/DaemonClient.test.ts',
    'packages/core/src/test-utils/config.ts',
    'packages/core/src/node_modules/shadow/index.js',
    'packages/web-shell/test/setup.ts',
    'packages/cli/test-setup.ts',
    'packages/core/src/__fixtures__/config.json',
    'packages/core/src/__mocks__/client.ts',
    'packages/core/src/__snapshots__/config.snap',
    'packages/sdk-typescript/scripts/build.js',
    'packages/cua-driver/test-harness/apps/cross-platform/electron/build.sh',
    'packages/web-templates/build.mjs',
    'packages/web-shell/vite.config.ts',
    'packages/webui/postcss.config.cjs',
    'packages/webui/tailwind.config.cjs',
    'packages/webui/vite.config.ts',
    'packages/chrome-extension/config/esbuild.background.config.js',
    'packages/vscode-ide-companion/eslint.config.mjs',
    'packages/vscode-ide-companion/esbuild.js',
    'patches/ink.patch',
    'scripts/build.js',
    'tsconfig.json',
    'vitest.config.ts',
    'packages/cli/src/config/settings.ts',
    'packages/cli/src/config/settingsSchema.ts',
    'packages/cli/src/i18n/languages.ts',
    'packages/core/src/index.ts',
    'packages/core/src/config/approval-mode.ts',
    'packages/core/src/config/clearContextDefaults.ts',
    'packages/core/src/config/config.ts',
    'packages/core/src/hooks/stopHookCap.ts',
    'packages/core/src/services/loopDetectionService.ts',
    'packages/core/src/telemetry/constants.ts',
    'packages/core/src/telemetry/index.ts',
    'packages/core/src/utils/qwenIgnoreParser.ts',
    'packages/vscode-ide-companion/schemas/settings.schema.json',
  ]) {
    assert.equal(isProtectedVerificationPath(file), true, file);
  }
  assert.equal(
    isProtectedVerificationPath('packages/core/src/feature.ts'),
    false,
  );
});

test('shares one protected-path allowlist with the output validator', () => {
  assert.equal(isProtectedVerificationPath, validatorIsProtectedPath);
  for (const file of [
    '.github/workflows/qwen-autofix.yml',
    'eslint.config.js',
    'package.json',
    'packages/cli/src/config/settings.ts',
    'packages/core/src/index.ts',
    'packages/vscode-ide-companion/schemas/settings.schema.json',
    'packages/core/src/feature.ts',
    'packages/core/src/utils/someHelper.ts',
  ]) {
    assert.equal(
      isProtectedVerificationPath(file),
      validatorIsProtectedPath(file),
      file,
    );
  }
});

test('keeps producer and consumer targeted E2E limits in sync', () => {
  assert.equal(MAX_CASES, MAX_TARGETED_E2E_CASES);
  assert.deepEqual(
    [...TRUSTED_EXTERNAL_PROCESS_TESTS].sort(),
    [...TRUSTED_EXTERNAL_PROCESS_E2E_TESTS].sort(),
  );
});

test('rejects candidates that change trusted targeted E2E inputs', () => {
  withWorkspace((workspace) => {
    mkdirSync(join(workspace, 'packages', 'core', 'src'), { recursive: true });
    writeFileSync(
      join(workspace, 'packages', 'core', 'src', 'feature.ts'),
      'v1',
    );
    initRepository(workspace);
    commit(workspace, 'source');
    const sourceSha = headSha(workspace);

    writeFileSync(
      join(workspace, 'packages', 'core', 'src', 'feature.ts'),
      'v2',
    );
    commit(workspace, 'production fix');
    validateCandidateScope(
      { source: { headSha: sourceSha } },
      sourceSha,
      workspace,
    );

    writeFileSync(
      join(
        workspace,
        'integration-tests',
        'cli',
        'qwen-serve-client-mcp.test.ts',
      ),
      'changed',
    );
    commit(workspace, 'weaken test');
    assert.throws(
      () =>
        validateCandidateScope(
          { source: { headSha: sourceSha } },
          sourceSha,
          workspace,
        ),
      /Candidate changes trusted targeted E2E inputs: integration-tests\/cli\/qwen-serve-client-mcp\.test\.ts/,
    );
  });
});

test('scopes the candidate diff to the candidate base, not the failed source SHA', () => {
  withWorkspace((workspace) => {
    mkdirSync(join(workspace, 'packages', 'core', 'src'), { recursive: true });
    writeFileSync(
      join(workspace, 'packages', 'core', 'src', 'feature.ts'),
      'v1',
    );
    initRepository(workspace);
    commit(workspace, 'source');
    const sourceSha = headSha(workspace);

    // An unrelated main commit touching a protected path lands after the
    // failure and before the candidate base. Diffing from the failed source
    // SHA would attribute it to the candidate and falsely abort.
    mkdirSync(join(workspace, 'scripts'), { recursive: true });
    writeFileSync(
      join(workspace, 'scripts', 'unrelated.js'),
      '// main traffic',
    );
    commit(workspace, 'unrelated main change');
    const candidateBase = headSha(workspace);

    writeFileSync(
      join(workspace, 'packages', 'core', 'src', 'feature.ts'),
      'v2',
    );
    commit(workspace, 'production fix');

    validateCandidateScope(
      { source: { headSha: sourceSha } },
      candidateBase,
      workspace,
    );
  });
});

test('rejects protected paths containing Git quoting characters', () => {
  withWorkspace((workspace) => {
    initRepository(workspace);
    commit(workspace, 'source');
    const sourceSha = headSha(workspace);

    const protectedPath = join(workspace, 'scripts', 'unsafe\nname.js');
    mkdirSync(join(workspace, 'scripts'), { recursive: true });
    writeFileSync(protectedPath, 'candidate controlled');
    commit(workspace, 'quoted path');

    assert.throws(
      () =>
        validateCandidateScope(
          { source: { headSha: sourceSha } },
          sourceSha,
          workspace,
        ),
      /Candidate changes trusted targeted E2E inputs/,
    );
  });
});

test('accepts only existing test files below integration-tests', () => {
  withWorkspace((workspace) => {
    assert.deepEqual(validateTestPath(testCase.file, workspace), {
      normalized: testCase.file,
      absolute: resolve(workspace, 'integration-tests', testCase.file),
    });
    assert.throws(
      () => validateTestPath('../package.json', workspace),
      /escapes integration-tests/,
    );
    assert.throws(
      () => validateTestPath('cli/not-a-test.ts', workspace),
      /not a test file/,
    );
    writeFileSync(
      join(workspace, 'integration-tests', 'cli', 'unsafe.test.ts'),
      '',
    );
    assert.throws(
      () => validateTestPath('cli/unsafe.test.ts', workspace),
      /trusted external-process allowlist/,
    );
  });
});

test('rejects incomplete and unsupported targeted metadata', () => {
  withWorkspace((workspace) => {
    const cases = validateMetadata(metadata(testCase), workspace);
    assert.equal(cases[0].fullName, 'suite case (a+b)');
    assert.throws(
      () =>
        validateMetadata(
          {
            ...metadata(testCase),
            verification: {
              ...metadata(testCase).verification,
              eligible: false,
              reasons: ['provider credentials required'],
            },
          },
          workspace,
        ),
      /provider credentials required/,
    );
    assert.throws(
      () => validateMetadata(metadata({ ...testCase, os: 'macos' }), workspace),
      /Unsupported E2E OS/,
    );
    assert.throws(
      () =>
        validateMetadata(
          metadata({ ...testCase, sandbox: 'docker' }),
          workspace,
        ),
      /Unsupported E2E sandbox/,
    );
    assert.throws(
      () =>
        validateMetadata(
          metadata({ ...testCase, id: `${testCase.id}\nspoofed` }),
          workspace,
        ),
      /Invalid E2E test ID/,
    );
    assert.throws(
      () =>
        validateMetadata(
          metadata({ ...testCase, name: `${testCase.name}\n::error::spoofed` }),
          workspace,
        ),
      /Invalid E2E test name/,
    );
    assert.throws(
      () =>
        validateMetadata(
          {
            ...metadata(testCase),
            verification: {
              ...metadata(testCase).verification,
              totalCases: 2,
            },
          },
          workspace,
        ),
      /case set is incomplete/,
    );
  });
});

test('requires exactly one selected passing assertion in the requested file', () => {
  withWorkspace((workspace) => {
    const validatedCase = validateMetadata(metadata(testCase), workspace)[0];
    const result = {
      name: resolve(workspace, 'integration-tests', testCase.file),
      assertionResults: [
        { fullName: validatedCase.fullName, status: 'passed' },
        { fullName: 'other skipped test', status: 'skipped' },
      ],
    };
    validateVitestReport(
      { success: true, testResults: [result] },
      validatedCase,
      workspace,
    );
    assert.throws(
      () =>
        validateVitestReport(
          {
            success: true,
            testResults: [
              {
                ...result,
                assertionResults: [
                  ...result.assertionResults,
                  { fullName: 'unexpected passing test', status: 'passed' },
                ],
              },
            ],
          },
          validatedCase,
          workspace,
        ),
      /exactly one passed assertion/,
    );
    assert.throws(
      () =>
        validateVitestReport(
          {
            success: true,
            testResults: [
              {
                ...result,
                assertionResults: [
                  { fullName: validatedCase.fullName, status: 'skipped' },
                ],
              },
            ],
          },
          validatedCase,
          workspace,
        ),
      /did not pass/,
    );
    assert.throws(
      () =>
        validateVitestReport(
          {
            success: true,
            testResults: [
              { ...result, name: resolve(workspace, 'other.test.ts') },
            ],
          },
          validatedCase,
          workspace,
        ),
      /file mismatch/,
    );
  });
});
