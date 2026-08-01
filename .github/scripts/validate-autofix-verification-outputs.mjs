#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export function isProtectedVerificationPath(file) {
  return (
    file === '.gitattributes' ||
    file === '.gitignore' ||
    file === '.npmrc' ||
    file === 'esbuild.config.js' ||
    file === 'eslint.config.js' ||
    file === 'eslint.legacy-filenames.mjs' ||
    file === 'package.json' ||
    file === 'package-lock.json' ||
    file === 'npm-shrinkwrap.json' ||
    file === 'tsconfig.json' ||
    file === 'vitest.config.ts' ||
    file === 'packages/cli/src/config/settings.ts' ||
    file === 'packages/cli/src/config/settingsSchema.ts' ||
    file === 'packages/cli/src/i18n/languages.ts' ||
    file === 'packages/core/src/index.ts' ||
    file === 'packages/core/src/config/approval-mode.ts' ||
    file === 'packages/core/src/config/clearContextDefaults.ts' ||
    file === 'packages/core/src/config/config.ts' ||
    file === 'packages/core/src/hooks/stopHookCap.ts' ||
    file === 'packages/core/src/services/loopDetectionService.ts' ||
    file === 'packages/core/src/telemetry/constants.ts' ||
    file === 'packages/core/src/telemetry/index.ts' ||
    file === 'packages/core/src/utils/qwenIgnoreParser.ts' ||
    file === 'packages/vscode-ide-companion/schemas/settings.schema.json' ||
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

function isSymbolicLink(file, workspace) {
  try {
    return lstatSync(join(workspace, file)).isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function listProtectedCandidateChanges(base, workspace = process.cwd()) {
  const changedOutput = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`],
    {
      cwd: workspace,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    },
  );
  const changedText = changedOutput.toString('utf8');
  if (!Buffer.from(changedText).equals(changedOutput))
    throw new Error('Candidate changed a path that is not valid UTF-8');
  const changed = changedText.split('\0').filter(Boolean);
  return changed.filter(
    (file) =>
      isProtectedVerificationPath(file) || isSymbolicLink(file, workspace),
  );
}

export function isAllowedVerificationOutput(file) {
  return (
    file.startsWith('dist/') ||
    /^packages\/[^/]+\/dist\//.test(file) ||
    /^packages\/channels\/[^/]+\/dist\//.test(file) ||
    file.startsWith('integrations/external-context/dist/') ||
    file === 'packages/cli/src/generated/git-commit.ts' ||
    file === 'packages/core/src/generated/git-commit.ts' ||
    file === 'packages/web-templates/src/generated/exportHtmlTemplate.ts' ||
    file === 'packages/web-templates/src/generated/insightTemplate.ts' ||
    file.startsWith('packages/web-templates/src/export-html/dist/') ||
    file.startsWith('packages/web-templates/src/insight/dist/') ||
    /(^|\/)tsconfig\.tsbuildinfo$/.test(file)
  );
}

function readSealedDependencies(workspace) {
  const manifest = readFileSync(
    join(workspace, '.git', 'autofix-verification-dependencies'),
  );
  if (!manifest.length || manifest[manifest.length - 1] !== 0) {
    throw new Error('Invalid sealed dependency manifest');
  }
  const dependencies = manifest.toString('utf8').split('\0').filter(Boolean);
  if (
    new Set(dependencies).size !== dependencies.length ||
    dependencies.some(
      (file) =>
        (file !== 'node_modules' && !file.endsWith('/node_modules')) ||
        file.startsWith('/') ||
        file.split('/').includes('..'),
    )
  ) {
    throw new Error('Invalid sealed dependency manifest');
  }
  for (const file of dependencies) {
    const stats = lstatSync(join(workspace, file));
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Invalid sealed dependency directory: ${file}`);
    }
  }
  return dependencies;
}

export function listUnexpectedVerificationOutputs(workspace = process.cwd()) {
  const dependencyPathspecs = readSealedDependencies(workspace).map(
    (file) => `:(exclude,top,glob)${file}/**`,
  );
  const args = [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    '.',
    ...dependencyPathspecs,
  ];
  const ignored = execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  const untracked = execFileSync(
    'git',
    [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '.',
      ...dependencyPathspecs,
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    },
  );
  return [...new Set(`${ignored}${untracked}`.split('\0').filter(Boolean))]
    .filter(
      (file) =>
        isSymbolicLink(file, workspace) || !isAllowedVerificationOutput(file),
    )
    .sort();
}

function main() {
  const baseArgIndex = process.argv.indexOf('--base');
  if (baseArgIndex !== -1) {
    const base = process.argv[baseArgIndex + 1];
    if (!base || base.startsWith('--')) {
      throw new Error('--base requires a Git revision');
    }
    const protectedChanges = listProtectedCandidateChanges(base);
    if (protectedChanges.length) {
      console.error('Candidate changes trusted verification inputs:');
      for (const file of protectedChanges) console.error(`- ${file}`);
      process.exit(1);
    }
    return;
  }

  const unexpected = listUnexpectedVerificationOutputs();
  if (unexpected.length) {
    console.error('Unexpected candidate verification outputs:');
    for (const file of unexpected) console.error(`- ${file}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
