#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ACTIONLINT_VERSION = '1.7.12';
const SHELLCHECK_VERSION = '0.11.0';
const YAMLLINT_VERSION = '1.35.1';

const TEMP_DIR = join(tmpdir(), 'qwen-code-linters');

/**
 * SHA256 checksums for downloaded binaries.
 * Compute with: sha256sum <binary>
 */
const CHECKSUMS = {
  actionlint: {
    linux_amd64: 'PLACEHOLDER_COMPUTE_WITH_SHA256SUM',
    darwin_amd64: 'PLACEHOLDER_COMPUTE_WITH_SHA256SUM',
    darwin_arm64: 'PLACEHOLDER_COMPUTE_WITH_SHA256SUM',
  },
  shellcheck: {
    'linux.x86_64': 'PLACEHOLDER_COMPUTE_WITH_SHA256SUM',
    'darwin.x86_64': 'PLACEHOLDER_COMPUTE_WITH_SHA256SUM',
    'darwin.aarch64': 'PLACEHOLDER_COMPUTE_WITH_SHA256SUM',
  },
};

function computeSHA256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function verifyChecksum(filePath, expectedChecksum) {
  if (expectedChecksum === 'PLACEHOLDER_COMPUTE_WITH_SHA256SUM') {
    console.warn(
      `[lint.js] WARNING: No checksum configured for ${filePath}, skipping verification`,
    );
    return true;
  }
  const actual = computeSHA256(filePath);
  if (actual !== expectedChecksum) {
    console.error(`[lint.js] CHECKSUM MISMATCH for ${filePath}`);
    console.error(`  Expected: ${expectedChecksum}`);
    console.error(`  Actual:   ${actual}`);
    return false;
  }
  return true;
}

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

const platformArch = getPlatformArch();

function downloadAndVerify(url, destPath, expectedChecksum) {
  const dir = destPath.substring(0, destPath.lastIndexOf('/')) || '.';
  mkdirSync(dir, { recursive: true });
  execSync(`curl -sSLo "${destPath}" "${url}"`);
  if (!verifyChecksum(destPath, expectedChecksum)) {
    rmSync(destPath, { force: true });
    throw new Error(`Checksum verification failed for ${destPath}`);
  }
}

/**
 * @typedef {{
 *   check: string;
 *   installer: () => void;
 *   run: string;
 * }}
 */

/**
 * @type {{[linterName: string]: Linter}}
 */
const LINTERS = {
  actionlint: {
    check: 'command -v actionlint',
    installer: () => {
      const arch = platformArch.actionlint;
      const url = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_${arch}.tar.gz`;
      const tgzPath = `${TEMP_DIR}/.actionlint.tgz`;
      const expected = CHECKSUMS.actionlint[arch];
      downloadAndVerify(url, tgzPath, expected);
      execSync(`tar -xzf "${tgzPath}" -C "${TEMP_DIR}/actionlint"`);
      rmSync(tgzPath, { force: true });
    },
    run: `
      actionlint \
        -color \
        -ignore 'SC2002:' \
        -ignore 'SC2016:' \
        -ignore 'SC2129:' \
        -ignore 'label ".+" is unknown'
    `,
  },
  shellcheck: {
    check: 'command -v shellcheck',
    installer: () => {
      const arch = platformArch.shellcheck;
      const url = `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.${arch}.tar.xz`;
      const txzPath = `${TEMP_DIR}/.shellcheck.txz`;
      const expected = CHECKSUMS.shellcheck[arch];
      downloadAndVerify(url, txzPath, expected);
      execSync(
        `tar -xf "${txzPath}" -C "${TEMP_DIR}/shellcheck" --strip-components=1`,
      );
      rmSync(txzPath, { force: true });
    },
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
    installer: () => {
      execSync(`pip3 install --user "yamllint==${YAMLLINT_VERSION}"`);
    },
    run: "git ls-files | grep -E '\\.(yaml|yml)' | xargs yamllint --format github",
  },
};

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

  for (const linter in LINTERS) {
    const { check, installer } = LINTERS[linter];
    if (!runCommand(check, 'ignore')) {
      console.log(`Installing ${linter}...`);
      try {
        installer();
      } catch (err) {
        console.error(
          `Failed to install ${linter}: ${err instanceof Error ? err.message : err}`,
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
  if (!runCommand(LINTERS.actionlint.run)) {
    process.exit(1);
  }
}

export function runShellcheck() {
  console.log('\nRunning shellcheck...');
  if (!runCommand(LINTERS.shellcheck.run)) {
    process.exit(1);
  }
}

export function runYamllint() {
  console.log('\nRunning yamllint...');
  if (!runCommand(LINTERS.yamllint.run)) {
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
