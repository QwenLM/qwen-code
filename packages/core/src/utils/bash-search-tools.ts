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
let bundledResolution: Promise<BundledSearchBinaries | null> | undefined;
let availabilityByConfig = new WeakMap<object, boolean>();

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
  canHostSearch = true,
): Promise<boolean> {
  // A user who opted out of ripgrep must keep the dedicated search tools
  // rather than have `rg` injected into Bash behind their back. Do not cache
  // this per-config decision as a missing binary: another Config in the same
  // process may use the bundled search surface.
  if (
    !canHostSearch ||
    !config.getUseRipgrep() ||
    !config.getUseBuiltinRipgrep()
  ) {
    availabilityByConfig.set(config, false);
    return false;
  }
  // One function prelude cannot attach each root's ignore files only to
  // searches within that root. Keep the dedicated tools for multi-root
  // workspaces instead of leaking one root's patterns into another.
  if (!hasSingleWorkspaceRoot(config)) {
    availabilityByConfig.set(config, false);
    return false;
  }
  if (bundled === undefined) {
    bundledResolution ??= resolveBundledSearchBinaries();
    bundled = await bundledResolution;
  }
  const available = bundled !== null;
  availabilityByConfig.set(config, available);
  return available;
}

/**
 * Whether the bundled Bash search surface replaces the dedicated search tools.
 * Reports `false` until {@link resolveBashSearchAvailability} has run, so the
 * dedicated tools stay in play for anything that runs before tool registration.
 */
export function isBashSearchAvailable(config?: object): boolean {
  let current: object | null | undefined = config;
  while (current) {
    const available = availabilityByConfig.get(current);
    if (available !== undefined) {
      return available && bundled !== undefined && bundled !== null;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

export function _resetBashSearchToolsForTest(): void {
  bundled = undefined;
  bundledResolution = undefined;
  availabilityByConfig = new WeakMap();
}

function getIgnoreFiles(
  config: Config,
  cwd: string,
  customIgnoreFiles: string[] | undefined,
): string[] {
  const workspaceRoot = config.getWorkspaceContext?.().getDirectories()[0];
  if (!workspaceRoot) {
    return [];
  }
  const relative = path.relative(workspaceRoot, cwd);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    (relative !== '' && path.isAbsolute(relative))
  ) {
    return [];
  }
  const names = getQwenIgnoreFileNames(customIgnoreFiles);
  // `.qwenignore` goes last so its rules win the native last-match-wins pass.
  const ordered = [
    ...names.filter((name) => name !== '.qwenignore'),
    ...names.filter((name) => name === '.qwenignore'),
  ];
  return ordered
    .map((name) => path.join(workspaceRoot, name))
    .filter((file) => fs.existsSync(file));
}

function shellFunction(name: string, command: string, args: string[]): string {
  const defaults = args.length > 0 ? ` ${args.join(' ')}` : '';
  return `${name}() { ${command}${defaults} "$@"; }`;
}

function grepFunction(command: string, args: string[]): string {
  const defaults = args.length > 0 ? ` ${args.join(' ')}` : '';
  return `grep() {
  local qwen_grep_arg qwen_grep_option qwen_grep_short
  for qwen_grep_arg in "$@"; do
    case "$qwen_grep_arg" in
      --) break ;;
      --config|--config=*|---*|--filter|--filter=*|--pager|--pager=*|--save-config|--save-config=*|--view|--view=*|--query|--query=*)
        printf '%s\\n' 'grep: this option is disabled by Qwen Code' >&2
        return 2
        ;;
    esac
    case "$qwen_grep_arg" in
      -?*)
        qwen_grep_short=\${qwen_grep_arg#-}
        while [[ -n "$qwen_grep_short" ]]; do
          qwen_grep_option=\${qwen_grep_short:0:1}
          qwen_grep_short=\${qwen_grep_short:1}
          case "$qwen_grep_option" in
            Q)
              printf '%s\\n' 'grep: this option is disabled by Qwen Code' >&2
              return 2
              ;;
            A|B|C|D|d|e|f|g|J|K|M|m|N|O|t|Z|'?') break ;;
          esac
        done
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
    !isBashSearchAvailable(config) ||
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
