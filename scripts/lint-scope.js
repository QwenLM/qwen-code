/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

function affectsAllFiles(file) {
  const name = basename(file);
  return (
    /^(?:eslint[.-]|\.eslintrc|\.eslintignore|prettier\.config\.|\.prettierrc|\.prettierignore|tsconfig.*\.json$|\.yamllint|\.shellcheckrc$|actionlint\.)/.test(
      name,
    ) ||
    /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.gitignore|\.gitattributes|\.editorconfig)$/.test(
      name,
    ) ||
    file.startsWith('eslint-rules/') ||
    /^scripts\/lint(?:[.-]|$)/.test(file)
  );
}

function shellScripts(files, cwd) {
  const candidates = files.filter(
    (file) =>
      !file.startsWith('integration-tests/terminal-bench/') &&
      /^([^.]+|.*\.(sh|zsh|bash))/.test(file),
  );
  const scripts = [];
  for (let index = 0; index < candidates.length; index += 50) {
    const batch = candidates.slice(index, index + 50);
    const types = execFileSync(
      'file',
      ['--brief', '--mime-type', '--', ...batch.map((file) => `./${file}`)],
      {
        cwd,
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n');
    scripts.push(
      ...batch.filter((_, offset) => types[offset] === 'text/x-shellscript'),
    );
  }
  return scripts;
}

export async function getLintScope({
  cwd = process.cwd(),
  baseSha = process.env.LINT_BASE_SHA,
} = {}) {
  if (!baseSha) return { full: true, reason: 'LINT_BASE_SHA is not set' };
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  try {
    if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(baseSha)) {
      throw new Error('LINT_BASE_SHA must be a full commit SHA');
    }
    const mergeBase = git('merge-base', '--all', baseSha, 'HEAD').trim();
    if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(mergeBase)) {
      throw new Error('No unique merge base');
    }
    if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
      const shallow = readFileSync(
        resolve(cwd, git('rev-parse', '--git-path', 'shallow').trim()),
        'utf8',
      )
        .trim()
        .split('\n');
      const aboveBase = new Set(
        git('rev-list', `${mergeBase}..HEAD`, `${mergeBase}..${baseSha}`)
          .trim()
          .split('\n'),
      );
      if (shallow.some((sha) => aboveBase.has(sha))) {
        throw new Error('Shallow history above the merge base');
      }
    }
    // Disabling rename detection includes both paths, so moving a config away
    // still invalidates every file; only the existing destination is linted.
    const changed = git(
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      mergeBase,
      'HEAD',
      '--',
    )
      .split('\0')
      .filter(Boolean);
    if (changed.some(affectsAllFiles)) {
      return {
        full: true,
        reason: 'Lint configuration or dependencies changed',
      };
    }
    const files = changed.filter((file) => {
      try {
        return lstatSync(resolve(cwd, file)).isFile();
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      }
    });
    // Mirror the lane's own terminal-bench exclusion (getLinters().shellcheck
    // in lint.js): those paths are grep-ed out of the full lane too, so a
    // change there must not pay for a whole-repository ShellCheck.
    const shellCandidates = changed.filter(
      (file) => !file.startsWith('integration-tests/terminal-bench/'),
    );
    const existing = new Set(files);
    const changedScripts = shellScripts(
      shellCandidates.filter((file) => existing.has(file)),
      cwd,
    );
    // Sourced helpers affect unchanged entry scripts, including deleted
    // helpers. The extensionless arm stays deliberately conservative — it
    // cannot tell a sourced helper from a Dockerfile or LICENSE — because the
    // full lane's own `file`-based selection cannot see an extensionless
    // helper either, so narrowing it here would drop coverage.
    const shellChanged =
      changedScripts.length > 0 ||
      shellCandidates.some(
        (file) =>
          /\.(?:sh|bash|zsh)$/.test(file) || !basename(file).includes('.'),
      );
    return {
      full: false,
      // Must stay a superset of what `lint:ci` lints. Flat-config `--ext` is
      // additive to the config's own `files` scope, so the full lane also
      // lints `.mts`/`.cts` (tracked today: scripts/review-audit-layers.mts);
      // dropping them here would report green without opening the file.
      eslint: files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)),
      prettier: files,
      shellcheck: shellChanged,
      yamllint: files.filter((file) => /\.ya?ml$/.test(file)),
      actionlint: changed.some(
        (file) =>
          file.startsWith('.github/workflows/') ||
          file.startsWith('.github/actions/') ||
          /(?:^|\/)action\.ya?ml$/.test(file),
      ),
    };
  } catch (error) {
    return {
      full: true,
      reason: `Incremental selection unavailable: ${error.message}`,
    };
  }
}
