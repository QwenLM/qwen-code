import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  isAllowedVerificationOutput,
  isProtectedVerificationPath,
  listProtectedCandidateChanges,
  listUnexpectedVerificationOutputs,
} from './validate-autofix-verification-outputs.mjs';

function writeDependencyManifest(workspace, dependencies) {
  writeFileSync(
    join(workspace, '.git', 'autofix-verification-dependencies'),
    Buffer.from(`${dependencies.join('\0')}\0`),
  );
}

function withRepository(run) {
  const workspace = mkdtempSync(join(tmpdir(), 'autofix-outputs-'));
  try {
    writeFileSync(
      join(workspace, '.gitignore'),
      ['node_modules', 'dist', '.env', '**/dist', '*.tsbuildinfo'].join('\n'),
    );
    mkdirSync(join(workspace, 'packages', 'core', 'src'), { recursive: true });
    writeFileSync(
      join(workspace, 'packages', 'core', 'src', 'feature.ts'),
      'v1',
    );
    execFileSync('git', ['init'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: workspace,
    });
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: workspace });
    mkdirSync(join(workspace, 'node_modules'));
    writeDependencyManifest(workspace, ['node_modules']);
    return run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('allows only declared build outputs', () => {
  for (const file of [
    'dist/cli.js',
    'packages/core/dist/index.js',
    'packages/channels/base/dist/index.js',
    'integrations/external-context/dist/index.js',
    'packages/cli/src/generated/git-commit.ts',
    'packages/core/src/generated/git-commit.ts',
    'packages/web-templates/src/generated/insightTemplate.ts',
    'packages/web-templates/src/insight/dist/main.js',
    'packages/core/tsconfig.tsbuildinfo',
  ]) {
    assert.equal(isAllowedVerificationOutput(file), true, file);
  }
  for (const file of [
    '.env',
    'packages/core/node_modules/tool/index.js',
    'packages/core/src/generated/payload.ts',
    'packages/core/vitest.config.ts',
  ]) {
    assert.equal(isAllowedVerificationOutput(file), false, file);
  }
});

test('finds ignored and untracked outputs outside the allowlist', () => {
  withRepository((workspace) => {
    mkdirSync(join(workspace, 'dist'), { recursive: true });
    mkdirSync(join(workspace, 'packages', 'core', 'dist'), { recursive: true });
    mkdirSync(join(workspace, 'packages', 'core', 'node_modules'), {
      recursive: true,
    });
    writeFileSync(join(workspace, 'dist', 'cli.js'), 'ok');
    writeFileSync(
      join(workspace, 'packages', 'core', 'dist', 'index.js'),
      'ok',
    );
    writeFileSync(
      join(workspace, 'packages', 'core', 'node_modules', 'shim.js'),
      'bad',
    );
    mkdirSync(join(workspace, 'integration-tests', 'node_modules'), {
      recursive: true,
    });
    writeFileSync(
      join(workspace, 'integration-tests', 'node_modules', 'injected.js'),
      'bad',
    );
    writeFileSync(join(workspace, '.env'), 'bad');
    writeFileSync(join(workspace, 'unexpected.txt'), 'bad');
    writeDependencyManifest(workspace, [
      'node_modules',
      'packages/core/node_modules',
    ]);

    assert.deepEqual(listUnexpectedVerificationOutputs(workspace), [
      '.env',
      'integration-tests/node_modules/injected.js',
      'unexpected.txt',
    ]);
  });
});

test('rejects symbolic links even below allowed output paths', () => {
  withRepository((workspace) => {
    mkdirSync(join(workspace, 'dist'), { recursive: true });
    symlinkSync(
      '/tmp/candidate-controlled-output',
      join(workspace, 'dist', 'cli.js'),
    );

    assert.deepEqual(listUnexpectedVerificationOutputs(workspace), [
      'dist/cli.js',
    ]);
  });
});

test('fails closed on a malformed sealed dependency manifest', () => {
  withRepository((workspace) => {
    writeFileSync(
      join(workspace, '.git', 'autofix-verification-dependencies'),
      '../node_modules\0',
    );

    assert.throws(
      () => listUnexpectedVerificationOutputs(workspace),
      /Invalid sealed dependency manifest/,
    );
  });
});

test('handles ignored output listings larger than the default child process buffer', () => {
  withRepository((workspace) => {
    const dist = join(workspace, 'dist');
    mkdirSync(dist, { recursive: true });
    for (let index = 0; index < 20_000; index += 1) {
      writeFileSync(
        join(dist, `${index.toString().padStart(5, '0')}-${'x'.repeat(48)}.js`),
        '',
      );
    }

    assert.deepEqual(listUnexpectedVerificationOutputs(workspace), []);
  });
});

test('fails closed on unsafe --base values before they reach git diff', () => {
  withRepository((workspace) => {
    const script = fileURLToPath(
      new URL('./validate-autofix-verification-outputs.mjs', import.meta.url),
    );
    const run = (...args) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: workspace,
        encoding: 'utf8',
      });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
    }).trim();

    assert.equal(run('--base', base).status, 0);
    // A single-dash value used to be absorbed by git diff (e.g. -Sfoo as a
    // sticky pickaxe value), silently disabling the protected-path gate.
    const dashValue = run('--base', '-Sfoo');
    assert.notEqual(dashValue.status, 0);
    assert.match(dashValue.stderr, /--base requires a Git revision/);
    const garbage = run('--base', 'not-a-sha');
    assert.notEqual(garbage.status, 0);
    assert.match(
      garbage.stderr,
      /--base must be a 40-hexadecimal commit SHA/,
    );
    // The inline form used to miss the guard and run the wrong check.
    const inline = run(`--base=${base}`);
    assert.notEqual(inline.status, 0);
    assert.match(
      inline.stderr,
      /--base must be passed as a separate argument/,
    );
  });
});

test('rejects candidate changes to trusted verification inputs', () => {
  withRepository((workspace) => {
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(workspace, 'packages', 'core', 'src', 'feature.ts'),
      'v2',
    );
    writeFileSync(join(workspace, 'package.json'), '{}');
    mkdirSync(join(workspace, 'scripts'), { recursive: true });
    writeFileSync(
      join(workspace, 'scripts', 'unsafe\nname.js'),
      'candidate controlled',
    );
    symlinkSync(
      '/tmp/candidate-controlled-source',
      join(workspace, 'packages', 'core', 'src', 'linked.ts'),
    );
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'candidate'], { cwd: workspace });

    assert.deepEqual(listProtectedCandidateChanges(base, workspace), [
      'package.json',
      'packages/core/src/linked.ts',
      'scripts/unsafe\nname.js',
    ]);
    for (const file of [
      '.gitignore',
      'eslint.config.js',
      'eslint.legacy-filenames.mjs',
      'npm-shrinkwrap.json',
      'packages/core/npm-shrinkwrap.json',
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
      'scripts/build.js',
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
});
