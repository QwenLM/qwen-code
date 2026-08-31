/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { DEFAULT_FILE_FILTERING_OPTIONS } from './file-filtering-options.js';
import { getQwenIgnoreFileNames } from './qwenIgnoreParser.js';
import { resolveHealthyBuiltinRipgrep } from './ripgrepUtils.js';
import { escapeShellArg, getShellConfiguration } from './shell-utils.js';

type SearchBinary = 'bfs' | 'ugrep';

interface BundledSearchBinaries {
  ripgrep: string;
  bfs: string;
  ugrep: string;
}

// Resolved by `resolveBashSearchAvailability` because the ripgrep health probe
// spawns a process. Synchronous readers use this cached answer and fall back to
// the dedicated search surface until resolution completes.
let bundled: BundledSearchBinaries | null | undefined;
let bashSearchEnabled = false;

function getBundledSearchBinary(ripgrep: string, binary: SearchBinary): string {
  const platformDirectory = path.basename(path.dirname(ripgrep));
  const vendorDirectory = path.dirname(path.dirname(path.dirname(ripgrep)));
  return path.join(vendorDirectory, binary, platformDirectory, binary);
}

function hasSingleWorkspaceRoot(config: Config): boolean {
  return config.getWorkspaceContext?.().getDirectories().length === 1;
}

async function resolveBundledSearchBinaries(): Promise<BundledSearchBinaries | null> {
  // Windows is deliberately out of scope: hosting every shell command in Git
  // Bash is a separable behavior change with its own risk surface.
  if (os.platform() === 'win32') {
    return null;
  }
  if (getShellConfiguration().shell !== 'bash') {
    return null;
  }
  const ripgrep = await resolveHealthyBuiltinRipgrep();
  if (!ripgrep) {
    return null;
  }

  const bfs = getBundledSearchBinary(ripgrep, 'bfs');
  const ugrep = getBundledSearchBinary(ripgrep, 'ugrep');
  if (!fs.existsSync(bfs) || !fs.existsSync(ugrep)) {
    return null;
  }
  return { ripgrep, bfs, ugrep };
}

/**
 * Probes the bundled binaries at most once, then records whether this Config
 * can use them for {@link isBashSearchAvailable}.
 */
export async function resolveBashSearchAvailability(
  config: Config,
): Promise<boolean> {
  // A user who opted out of ripgrep must keep the dedicated search tools
  // rather than have `rg` injected into Bash behind their back. Do not cache
  // this per-config decision as a missing binary: another Config in the same
  // process may use the bundled search surface.
  if (!config.getUseRipgrep() || !config.getUseBuiltinRipgrep()) {
    bashSearchEnabled = false;
    return false;
  }
  // One function prelude cannot attach each root's ignore files only to
  // searches within that root. Keep the dedicated tools for multi-root
  // workspaces instead of leaking one root's patterns into another.
  if (!hasSingleWorkspaceRoot(config)) {
    bashSearchEnabled = false;
    return false;
  }
  if (bundled === undefined) {
    bundled = await resolveBundledSearchBinaries();
  }
  bashSearchEnabled = bundled !== null;
  return bashSearchEnabled;
}

/**
 * Whether the bundled Bash search surface replaces the dedicated search tools.
 * Reports `false` until {@link resolveBashSearchAvailability} has run, so the
 * dedicated tools stay in play for anything that runs before tool registration.
 */
export function isBashSearchAvailable(): boolean {
  return bashSearchEnabled && bundled !== undefined && bundled !== null;
}

export function _resetBashSearchToolsForTest(): void {
  bundled = undefined;
  bashSearchEnabled = false;
}

function getIgnoreFiles(
  config: Config,
  cwd: string,
  customIgnoreFiles: string[] | undefined,
): string[] {
  const workspaceRoot = config.getWorkspaceContext?.().getDirectories()[0];
  const relative = workspaceRoot ? path.relative(workspaceRoot, cwd) : '';
  const root =
    workspaceRoot &&
    (relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative)))
      ? workspaceRoot
      : cwd;
  const names = getQwenIgnoreFileNames(customIgnoreFiles);
  // `.qwenignore` goes last so its rules win the native last-match-wins pass.
  const ordered = [
    ...names.filter((name) => name !== '.qwenignore'),
    ...names.filter((name) => name === '.qwenignore'),
  ];
  return ordered
    .map((name) => path.join(root, name))
    .filter((file) => fs.existsSync(file));
}

function shellFunction(name: string, command: string, args: string[]): string {
  const defaults = args.length > 0 ? ` ${args.join(' ')}` : '';
  return `${name}() { ${command}${defaults} "$@"; }`;
}

function grepFunction(command: string, args: string[]): string {
  const defaults = args.length > 0 ? ` ${args.join(' ')}` : '';
  return `grep() {
  local qwen_grep_arg
  for qwen_grep_arg in "$@"; do
    case "$qwen_grep_arg" in
      --) break ;;
      --config|--config=*|---*|--filter|--filter=*|--pager|--pager=*|--save-config|--save-config=*|--view|--view=*|-Q*|-[^-]*Q*|--query|--query=*)
        printf '%s\\n' 'grep: this option is disabled by Qwen Code' >&2
        return 2
        ;;
    esac
  done
  ${command}${defaults} "$@"
}`;
}

export function wrapWithBashSearchTools(
  command: string,
  config: Config,
  cwd: string,
): string {
  const binaries = bundled;
  if (
    !binaries ||
    config.getUseRipgrep?.() === false ||
    config.getUseBuiltinRipgrep?.() === false ||
    !hasSingleWorkspaceRoot(config)
  ) {
    return command;
  }

  const configuredFiltering = config.getFileFilteringOptions?.();
  const filtering = {
    respectGitIgnore:
      configuredFiltering?.respectGitIgnore ??
      DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
    respectQwenIgnore:
      configuredFiltering?.respectQwenIgnore ??
      DEFAULT_FILE_FILTERING_OPTIONS.respectQwenIgnore,
    customIgnoreFiles:
      configuredFiltering?.customIgnoreFiles ??
      DEFAULT_FILE_FILTERING_OPTIONS.customIgnoreFiles,
  };
  const ignoreFiles = filtering.respectQwenIgnore
    ? getIgnoreFiles(config, cwd, filtering.customIgnoreFiles)
    : [];

  const rgArgs = [
    '--hidden',
    '--glob',
    escapeShellArg('!.git', 'bash'),
    ...(filtering.respectGitIgnore
      ? ['--no-require-git']
      : ['--no-ignore-vcs']),
  ];
  const grepArgs = ['-G', '--hidden', '-I', '--exclude-dir=.git'];
  if (filtering.respectGitIgnore) {
    grepArgs.push('--ignore-files');
  }
  for (const ignoreFile of ignoreFiles) {
    const escaped = escapeShellArg(ignoreFile, 'bash');
    rgArgs.push('--ignore-file', escaped);
    grepArgs.push(`--ignore-files=${escaped}`);
  }

  const functions = [
    shellFunction('rg', escapeShellArg(binaries.ripgrep, 'bash'), rgArgs),
    grepFunction(escapeShellArg(binaries.ugrep, 'bash'), grepArgs),
    shellFunction('find', escapeShellArg(binaries.bfs, 'bash'), ['-S', 'dfs']),
  ];

  return `${functions.join('\n')}\n${command}`;
}
