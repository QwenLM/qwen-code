#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getLintScope } from './lint-scope.js';

const ACTIONLINT_VERSION = '1.7.12';
const SHELLCHECK_VERSION = '0.11.0';
const YAMLLINT_VERSION = '1.35.1';
const ACTIONLINT_SHA256 = {
  linux_amd64:
    '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
  linux_arm64:
    '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
  darwin_amd64:
    '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
  darwin_arm64:
    'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
};
const SHELLCHECK_SHA256 = {
  'linux.x86_64':
    '8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198',
  'linux.aarch64':
    '12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588',
  'darwin.x86_64':
    '3c89db4edcab7cf1c27bff178882e0f6f27f7afdf54e859fa041fca10febe4c6',
  'darwin.aarch64':
    '56affdd8de5527894dca6dc3d7e0a99a873b0f004d7aabc30ae407d3f48b0a79',
};

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

export function getCachedArchiveInstaller({
  cacheArchive,
  localArchive,
  expectedSha256,
  downloadUrl,
  archiveCheck,
  extract,
  executable,
}) {
  if (!expectedSha256) {
    throw new Error(`Missing SHA-256 pin for ${downloadUrl}`);
  }
  return `
      set -e
      verify_sha256() {
        "${process.execPath}" -e 'const {createHash}=require("node:crypto");const {readFileSync}=require("node:fs");const actual=createHash("sha256").update(readFileSync(process.argv[1])).digest("hex");if(actual!==process.argv[2]){console.error("SHA-256 mismatch for "+process.argv[1]+": expected "+process.argv[2]+", got "+actual);process.exit(1)}' "$1" "$2"
      }
      mkdir -p "${dirname(cacheArchive)}" || true
      if ! cp "${cacheArchive}" "${localArchive}" 2>/dev/null \
        || ! verify_sha256 "${localArchive}" "${expectedSha256}"; then
        rm -f "${localArchive}"
        curl -fsSL --retry 2 --retry-connrefused --connect-timeout 10 --max-time 90 \
          -o "${localArchive}" "${downloadUrl}"
        verify_sha256 "${localArchive}" "${expectedSha256}"
        ${archiveCheck}
        cache_tmp=''
        if cache_tmp="$(mktemp "${cacheArchive}.XXXXXX")" \
          && cp "${localArchive}" "$cache_tmp" \
          && "${process.execPath}" -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$cache_tmp" "${cacheArchive}"; then
          :
        else
          [ -z "$cache_tmp" ] || rm -f "$cache_tmp"
          echo "Warning: could not persist linter archive to ${cacheArchive}" >&2
        fi
      fi
      ${extract}
      test -x "${executable}"
  `;
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
  if (platform === 'linux' && arch === 'arm64') {
    return {
      actionlint: 'linux_arm64',
      shellcheck: 'linux.aarch64',
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

// Both git-sourced lanes stage the git file list and refuse to hand an empty
// one to the linter; build the two guard fragments once per stage (the same
// parameterized-shell pattern as getCachedArchiveInstaller) so the five
// copies cannot drift apart again.
const stageGitFileList = (label) => `
      files="$(git ls-files)" || { echo "${label}: git ls-files failed; refusing to lint an empty file list" >&2; exit 1; }`;

const refuseEmptyList = (label, variable, reason) => `
      if [ -z "$${variable}" ]; then
        echo "${label}: ${reason}; refusing to pass on an empty file list" >&2
        exit 1
      fi`;

let lintersCache;

// Built lazily: getPlatformArch() throws on platforms where the POSIX-only
// linters cannot run (e.g. Windows test hosts importing getLinterTempDir).
/** @returns {{[linterName: string]: Linter}} */
export function getLinters() {
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
    const actionlintLocalArchive = join(TEMP_DIR, '.actionlint.tgz');
    const shellcheckLocalArchive = join(TEMP_DIR, '.shellcheck.txz');
    lintersCache = {
      actionlint: {
        check: 'command -v actionlint',
        installer: `
      mkdir -p "${TEMP_DIR}/actionlint"
      ${getCachedArchiveInstaller({
        cacheArchive: actionlintArchive,
        localArchive: actionlintLocalArchive,
        expectedSha256: ACTIONLINT_SHA256[platformArch.actionlint],
        downloadUrl: `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_${platformArch.actionlint}.tar.gz`,
        archiveCheck: `tar -tzf "${actionlintLocalArchive}" >/dev/null`,
        extract: `tar -xzf "${actionlintLocalArchive}" -C "${TEMP_DIR}/actionlint"`,
        executable: join(TEMP_DIR, 'actionlint', 'actionlint'),
      })}
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
      mkdir -p "${TEMP_DIR}/shellcheck"
      ${getCachedArchiveInstaller({
        cacheArchive: shellcheckArchive,
        localArchive: shellcheckLocalArchive,
        expectedSha256: SHELLCHECK_SHA256[platformArch.shellcheck],
        downloadUrl: `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.${platformArch.shellcheck}.tar.xz`,
        archiveCheck: `tar -tf "${shellcheckLocalArchive}" >/dev/null`,
        extract: `tar -xf "${shellcheckLocalArchive}" -C "${TEMP_DIR}/shellcheck" --strip-components=1`,
        executable: join(TEMP_DIR, 'shellcheck', 'shellcheck'),
      })}
    `,
        // Stage the list and refuse to pass on an empty one: the final sed
        // swallows every upstream status, so an empty git ls-files (the
        // 2026-09-24 dubious-ownership failure, #12647) otherwise passed
        // the lane having linted nothing.
        run: `${stageGitFileList('shellcheck')}
      candidates="$(printf '%s\\n' "$files" | grep -v '^integration-tests/terminal-bench/' | grep -E '^([^.]+|.*\\.(sh|zsh|bash))')"${refuseEmptyList(
        'shellcheck',
        'candidates',
        'git ls-files matched no shell-script candidates',
      )}
      scripts="$(printf '%s\\n' "$candidates" | xargs file --mime-type | grep 'text/x-shellscript' | awk '{ print substr($1, 1, length($1)-1) }')"${refuseEmptyList(
        'shellcheck',
        'scripts',
        'file --mime-type detected no shell scripts',
      )}
      printf '%s\\n' "$scripts" | xargs shellcheck \\
        --check-sourced \\
        --enable=all \\
        --exclude=SC2002,SC2129,SC2310 \\
        --severity=style \\
        --format=gcc \\
        --color=never | sed -e 's/note:/warning:/g' -e 's/style:/warning:/g'
    `,
      },
      yamllint: {
        check: 'command -v yamllint',
        installer: `pip3 install --user "yamllint==${YAMLLINT_VERSION}"`,
        // Stage the list and refuse to run on an empty one: when git
        // ls-files dies (the 2026-09-24 dubious-ownership failure, #12647)
        // the lane must fail on git's error, not on yamllint's usage screen
        // from a zero-file invocation — and `xargs -r` would turn that
        // failure into a false green.
        run: `${stageGitFileList('yamllint')}
      files="$(printf '%s\\n' "$files" | grep -E '\\.(yaml|yml)')"${refuseEmptyList(
        'yamllint',
        'files',
        'git ls-files matched no yaml files',
      )}
      printf '%s\\n' "$files" | xargs yamllint --format github
    `,
      },
    };
  }
  return lintersCache;
}

// tempDir defaults to the module TEMP_DIR on purpose: getLinters() builds
// every installer and extract path from that same constant, so a tempDir
// that differs from it would put a directory nothing was installed into on
// PATH.
export function getLinterPath({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  tempDir = TEMP_DIR,
} = {}) {
  const nodeBin = join(cwd, 'node_modules', '.bin');
  let path = `${nodeBin}:${tempDir}/actionlint:${tempDir}/shellcheck:${env.PATH}`;
  if (platform === 'darwin') {
    path = `${path}:${env.HOME}/Library/Python/3.12/bin`;
  } else if (platform === 'linux') {
    path = `${path}:${env.HOME}/.local/bin`;
  }
  return path;
}

function runCommand(command, stdio = 'inherit') {
  try {
    const env = { ...process.env };
    env.PATH = getLinterPath();
    execSync(command, { stdio, env });
    return true;
  } catch (_e) {
    return false;
  }
}

export function setupLinters(scope = { full: true }) {
  console.log('Setting up linters...');
  rmSync(TEMP_DIR, { recursive: true, force: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  const linters = getLinters();
  for (const linter in linters) {
    if (!scope.full && !scope[linter]?.length && scope[linter] !== true)
      continue;
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

// `--check`, not `--write`. `--write` reformats in place and exits 0
// whether or not anything changed, and no caller inspects the tree
// afterwards, so for the life of this script the Prettier lane reported a
// pass on unformatted code and CI discarded the rewrites when the job
// ended. ESLint does not cover the gap either: eslint.config.js loads
// eslint-config-prettier, which turns formatting rules off rather than
// enforcing them. `npm run format` remains the way to fix what this
// reports.
export function runPrettier() {
  console.log('\nRunning Prettier...');
  if (!runCommand('prettier --experimental-cli --check .')) {
    process.exit(1);
  }
}

// Prettier's experimental CLI only discovers a config or ignore file in the
// directory it starts from, so the lane has to chdir. One spawn per touched
// directory pays a cold start each (0.24 s measured, against a 37 s whole-repo
// run), which inverts on a wide diff: this repository holds 655 directories
// with prettier-eligible files. Group by the nearest ancestor that actually
// carries one instead, so a diff without nested configuration costs a single
// spawn.
const PRETTIER_CONFIG_FILE =
  /^(?:\.prettierrc(?:\.[^/]+)?|prettier\.config\.(?:js|cjs|mjs|ts)|\.prettierignore|\.gitignore)$/;

function prettierGroupFor(cwd, file, cache) {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    if (!cache.has(directory)) {
      let carriesConfig = false;
      try {
        carriesConfig = readdirSync(join(cwd, directory)).some((name) =>
          PRETTIER_CONFIG_FILE.test(name),
        );
      } catch {
        // An unreadable directory carries nothing this lane could load.
      }
      cache.set(directory, carriesConfig);
    }
    if (cache.get(directory)) return directory;
    if (directory === '.' || directory === '') return '.';
  }
}

function runChangedFiles(command, options, files) {
  if (files.length === 0) {
    console.log(`Skipping ${command}: no relevant changed files.`);
    return;
  }
  console.log(`\nRunning ${command} on ${files.length} selected files...`);
  // Explicit targets do not make the experimental Prettier CLI discover
  // nested config/ignore files. Start in the nearest directory that carries
  // one (see prettierGroupFor) and name each target relative to that
  // directory, so the file Prettier resolves is the file that was selected —
  // a bare basename would miss every file that sits below its group directory.
  const root = process.cwd();
  const configCache = new Map();
  const groups =
    command === 'prettier'
      ? Object.groupBy(files, (file) =>
          prettierGroupFor(root, file, configCache),
        )
      : { '.': files };
  // Accumulate failures instead of exiting on the first non-zero status:
  // Prettier runs per directory with directory-relative targets, so its own
  // output never names the directory, and aborting would leave the remaining
  // directories unchecked and unreported in the same run.
  let failed = false;
  for (const [directory, selected] of Object.entries(groups)) {
    const targets =
      command === 'prettier'
        ? selected.map((file) => posix.relative(directory, file))
        : selected;
    if (command === 'prettier') console.log(`\nChecking ${directory}`);
    // 50 keeps argv far below the OS limit while leaving room for long paths.
    for (let index = 0; index < targets.length; index += 50) {
      const result = spawnSync(
        command,
        [
          ...options,
          // Prettier's experimental CLI escapes paths after `--` as globs.
          // The ./ prefix already prevents filenames being parsed as options.
          ...(command === 'prettier' ? [] : ['--']),
          ...targets.slice(index, index + 50).map((file) => `./${file}`),
        ],
        {
          cwd: join(root, directory),
          env: { ...process.env, PATH: getLinterPath() },
          stdio: 'inherit',
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      if (result.error) console.error(result.error.message);
      if (result.status !== 0) failed = true;
    }
  }
  if (failed) process.exit(1);
}

// A history fallback is the one full scan nobody expects: the lane stays
// green while every file is checked, so without a signal the optimization can
// silently stop working — after #15381 a failing history fetch made 3 of 8
// sampled PR runs fall back to full lint with nothing in the UI showing it.
// Falling back because a lint config or dependency changed is routine and
// stays quiet. The summary is deduplicated because every lane invokes this
// script separately.
function announceHistoryFallback(scope) {
  const reason = scope.full ? (scope.reason ?? '') : '';
  if (!reason.startsWith('Incremental selection unavailable:')) return;
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  console.log(`::warning::${reason}; running the full lint`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const line = `- Incremental lint unavailable: ${reason}\n`;
  try {
    if (readFileSync(summary, 'utf8').includes(reason)) return;
  } catch {
    // Missing summary file is the normal first-write case.
  }
  appendFileSync(summary, line);
}

async function main() {
  const args = process.argv.slice(2);

  const scope = await getLintScope();
  if (
    !scope.full &&
    scope.prettier.length &&
    (args.length === 0 || args.includes('--prettier'))
  ) {
    const { getFileInfo } = await import('prettier');
    const supported = await Promise.all(
      scope.prettier.map(async (file) =>
        (await getFileInfo(file)).inferredParser ? file : null,
      ),
    );
    scope.prettier = supported.filter(Boolean);
  }
  console.log(
    scope.full ? `Full lint: ${scope.reason}` : 'Incremental PR lint.',
  );
  announceHistoryFallback(scope);
  if (args.length === 0 || args.includes('--setup')) setupLinters(scope);
  const lanes = {
    eslint: () =>
      scope.full
        ? runESLint()
        : runChangedFiles(
            'eslint',
            // `lint:ci` in package.json stays the source of truth for the
            // policy: flat-config `--ext` is additive to the config's own
            // `files` scope, and `lint-scope.js` selects the same file types.
            // Keep the three in step — a flag added only there is not applied
            // to this path, and `--no-warn-ignored` is required because
            // eslint.config.js globally ignores tracked vendored trees.
            ['--ext', '.ts,.tsx', '--max-warnings', '0', '--no-warn-ignored'],
            scope.eslint,
          ),
    actionlint: () => {
      if (scope.full || scope.actionlint) runActionlint();
      else console.log('Skipping actionlint: no workflow or action changes.');
    },
    shellcheck: () => {
      if (scope.full || scope.shellcheck) runShellcheck();
      else console.log('Skipping shellcheck: no shell or helper changes.');
    },
    yamllint: () =>
      scope.full
        ? runYamllint()
        : runChangedFiles('yamllint', ['--format', 'github'], scope.yamllint),
    prettier: () =>
      scope.full
        ? runPrettier()
        : runChangedFiles(
            'prettier',
            ['--experimental-cli', '--check', '--ignore-unknown'],
            scope.prettier,
          ),
  };
  for (const [name, run] of Object.entries(lanes)) {
    if (args.length === 0 || args.includes(`--${name}`)) run();
  }
  if (args.length === 0) console.log('\nAll linting checks passed!');
}

// Run the CLI only when this file IS the entry point. The CI provisioning
// steps import the installer helpers (`getLinters`, `getLinterTempDir`); an
// unconditional main() made every such import execute a full lint pass
// instead of installing anything, silently, under continue-on-error
// (PR #16001 review, round 4). The argv[1] guard keeps `node -e` imports
// (no argv[1]) inert too.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
