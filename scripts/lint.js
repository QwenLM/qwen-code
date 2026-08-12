#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const ACTIONLINT_VERSION = '1.7.12';
const SHELLCHECK_VERSION = '0.11.0';
const YAMLLINT_VERSION = '1.35.1';

function sanitizePathPart(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function getLinterTempDir({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const baseDir = env.RUNNER_TEMP || tmpdir();
  const runId = env.GITHUB_RUN_ID;

  if (runId) {
    return join(
      baseDir,
      'qwen-code-linters',
      [
        sanitizePathPart(runId),
        sanitizePathPart(env.GITHUB_RUN_ATTEMPT || '1'),
        sanitizePathPart(env.GITHUB_JOB || 'job'),
      ].join('-'),
    );
  }

  const workspaceHash = createHash('sha256')
    .update(cwd)
    .digest('hex')
    .slice(0, 16);
  return join(baseDir, 'qwen-code-linters', `local-${workspaceHash}`);
}

export function getLinterCacheDir({
  env = process.env,
  homeDir = homedir(),
} = {}) {
  return join(
    env.XDG_CACHE_HOME || join(homeDir, '.cache'),
    'qwen-code',
    'linters',
  );
}

const TEMP_DIR = getLinterTempDir();
// Share versioned archives; extracted binaries stay job-scoped in TEMP_DIR.
const CACHE_DIR = getLinterCacheDir();

function getPlatformArch() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'linux' && arch === 'x64') {
    return {
      actionlint: 'linux_amd64',
      shellcheck: 'linux.x86_64',
    };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return {
      actionlint: 'darwin_amd64',
      shellcheck: 'darwin.x86_64',
    };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      actionlint: 'darwin_arm64',
      shellcheck: 'darwin.aarch64',
    };
  }
  throw new Error(`Unsupported platform/architecture: ${platform}/${arch}`);
}

/**
 * @typedef {{
 *   check: string;
 *   installer: string;
 *   run: string;
 * }}
 */

let lintersCache;

// Built lazily: getPlatformArch() throws on platforms where the POSIX-only
// linters cannot run (e.g. Windows test hosts importing getLinterTempDir).
/** @returns {{[linterName: string]: Linter}} */
function getLinters() {
  if (!lintersCache) {
    const platformArch = getPlatformArch();
    const actionlintArchive = join(
      CACHE_DIR,
      `actionlint_${ACTIONLINT_VERSION}_${platformArch.actionlint}.tar.gz`,
    );
    const shellcheckArchive = join(
      CACHE_DIR,
      `shellcheck_${SHELLCHECK_VERSION}_${platformArch.shellcheck}.tar.xz`,
    );
    lintersCache = {
      actionlint: {
        check: 'command -v actionlint',
        installer: `
      set -e
      mkdir -p "${TEMP_DIR}/actionlint" "${CACHE_DIR}"
      if ! tar -tzf "${actionlintArchive}" >/dev/null 2>&1; then
        curl -fsSL --retry 2 --retry-connrefused --connect-timeout 10 --max-time 90 \
          -o "${TEMP_DIR}/.actionlint.tgz" \
          "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_${platformArch.actionlint}.tar.gz"
        tar -tzf "${TEMP_DIR}/.actionlint.tgz" >/dev/null
        cp "${TEMP_DIR}/.actionlint.tgz" "${actionlintArchive}.$$"
        mv -f "${actionlintArchive}.$$" "${actionlintArchive}"
      fi
      tar -xzf "${actionlintArchive}" -C "${TEMP_DIR}/actionlint"
    `,
        run: `
      actionlint \
        -color \
        -pyflakes= \
        -shellcheck= \
        -ignore 'SC2002:' \
        -ignore 'SC2016:' \
        -ignore 'SC2129:' \
        -ignore 'unexpected key "deployment" for "environment" section' \
        -ignore 'label ".+" is unknown'
    `,
      },
      shellcheck: {
        check: 'command -v shellcheck',
        installer: `
      set -e
      mkdir -p "${TEMP_DIR}/shellcheck" "${CACHE_DIR}"
      if ! tar -tf "${shellcheckArchive}" >/dev/null 2>&1; then
        curl -fsSL --retry 2 --retry-connrefused --connect-timeout 10 --max-time 90 \
          -o "${TEMP_DIR}/.shellcheck.txz" \
          "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.${platformArch.shellcheck}.tar.xz"
        tar -tf "${TEMP_DIR}/.shellcheck.txz" >/dev/null
        cp "${TEMP_DIR}/.shellcheck.txz" "${shellcheckArchive}.$$"
        mv -f "${shellcheckArchive}.$$" "${shellcheckArchive}"
      fi
      tar -xf "${shellcheckArchive}" -C "${TEMP_DIR}/shellcheck" --strip-components=1
    `,
        run: `
      git ls-files | grep -v '^integration-tests/terminal-bench/' | grep -E '^([^.]+|.*\\.(sh|zsh|bash))' | xargs file --mime-type \
        | grep "text/x-shellscript" | awk '{ print substr($1, 1, length($1)-1) }' \
        | xargs shellcheck \
          --check-sourced \
          --enable=all \
          --exclude=SC2002,SC2129,SC2310 \
          --severity=style \
          --format=gcc \
          --color=never | sed -e 's/note:/warning:/g' -e 's/style:/warning:/g'
    `,
      },
      yamllint: {
        check: 'command -v yamllint',
        installer: `pip3 install --user "yamllint==${YAMLLINT_VERSION}"`,
        run: "git ls-files | grep -E '\\.(yaml|yml)' | xargs yamllint --format github",
      },
    };
  }
  return lintersCache;
}

function runCommand(command, stdio = 'inherit') {
  try {
    const env = { ...process.env };
    const nodeBin = join(process.cwd(), 'node_modules', '.bin');
    env.PATH = `${nodeBin}:${TEMP_DIR}/actionlint:${TEMP_DIR}/shellcheck:${env.PATH}`;
    if (process.platform === 'darwin') {
      env.PATH = `${env.PATH}:${process.env.HOME}/Library/Python/3.12/bin`;
    } else if (process.platform === 'linux') {
      env.PATH = `${env.PATH}:${process.env.HOME}/.local/bin`;
    }
    execSync(command, { stdio, env });
    return true;
  } catch (_e) {
    return false;
  }
}

export function setupLinters() {
  console.log('Setting up linters...');
  rmSync(TEMP_DIR, { recursive: true, force: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  const linters = getLinters();
  for (const linter in linters) {
    const { check, installer } = linters[linter];
    if (!runCommand(check, 'ignore')) {
      console.log(`Installing ${linter}...`);
      if (!runCommand(installer)) {
        console.error(
          `Failed to install ${linter}. Please install it manually.`,
        );
        process.exit(1);
      }
    }
  }
  console.log('All required linters are available.');
}

export function runESLint() {
  console.log('\nRunning ESLint...');
  if (!runCommand('npm run lint:ci')) {
    process.exit(1);
  }
}

export function runActionlint() {
  console.log('\nRunning actionlint...');
  if (!runCommand(getLinters().actionlint.run)) {
    process.exit(1);
  }
}

export function runShellcheck() {
  console.log('\nRunning shellcheck...');
  if (!runCommand(getLinters().shellcheck.run)) {
    process.exit(1);
  }
}

export function runYamllint() {
  console.log('\nRunning yamllint...');
  if (!runCommand(getLinters().yamllint.run)) {
    process.exit(1);
  }
}

export function runPrettier() {
  console.log('\nRunning Prettier...');
  if (!runCommand('prettier --write .')) {
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--setup')) {
    setupLinters();
  }
  if (args.includes('--eslint')) {
    runESLint();
  }
  if (args.includes('--actionlint')) {
    runActionlint();
  }
  if (args.includes('--shellcheck')) {
    runShellcheck();
  }
  if (args.includes('--yamllint')) {
    runYamllint();
  }
  if (args.includes('--prettier')) {
    runPrettier();
  }

  if (args.length === 0) {
    setupLinters();
    runESLint();
    runActionlint();
    runShellcheck();
    runYamllint();
    runPrettier();
    console.log('\nAll linting checks passed!');
  }
}

main();
