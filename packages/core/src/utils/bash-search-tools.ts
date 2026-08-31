/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { getQwenIgnoreFileNames } from './qwenIgnoreParser.js';
import { getBuiltinRipgrep } from './ripgrepUtils.js';
import { escapeShellArg, getShellConfiguration } from './shell-utils.js';

type SearchBinary = 'bfs' | 'ugrep';

function getBundledSearchBinary(binary: SearchBinary): string | null {
  const ripgrep = getBuiltinRipgrep();
  if (!ripgrep) {
    return null;
  }

  const platformDirectory = path.basename(path.dirname(ripgrep));
  const vendorDirectory = path.dirname(path.dirname(path.dirname(ripgrep)));
  const binaryName = os.platform() === 'win32' ? `${binary}.exe` : binary;
  return path.join(vendorDirectory, binary, platformDirectory, binaryName);
}

function bashExecutable(binary: string): string {
  const normalized =
    os.platform() === 'win32' ? binary.replaceAll('\\', '/') : binary;
  return escapeShellArg(normalized, 'bash');
}

export function isBashSearchAvailable(): boolean {
  if (getShellConfiguration().shell !== 'bash') {
    return false;
  }

  const ripgrep = getBuiltinRipgrep();
  if (!ripgrep || !fs.existsSync(ripgrep)) {
    return false;
  }

  if (os.platform() === 'win32') {
    const ugrep = getBundledSearchBinary('ugrep');
    return Boolean(ugrep && fs.existsSync(ugrep));
  }

  const bfs = getBundledSearchBinary('bfs');
  const ugrep = getBundledSearchBinary('ugrep');
  return Boolean(bfs && ugrep && fs.existsSync(bfs) && fs.existsSync(ugrep));
}

function getIgnoreFiles(config: Config, cwd: string): string[] {
  const roots = config
    .getWorkspaceContext()
    .getDirectories()
    .filter((root) => {
      const relative = path.relative(root, cwd);
      return (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
      );
    })
    .sort((left, right) => right.length - left.length);
  const root = roots[0] ?? config.getTargetDir();
  const names = getQwenIgnoreFileNames(
    config.getFileFilteringOptions().customIgnoreFiles,
  );
  const qwenIgnore = names.filter((name) => name === '.qwenignore');
  const customIgnore = names.filter((name) => name !== '.qwenignore');

  return [...customIgnore, ...qwenIgnore]
    .map((name) => path.join(root, name))
    .filter((file) => fs.existsSync(file));
}

function shellFunction(name: string, command: string, args: string[]): string {
  const defaults = args.length > 0 ? ` ${args.join(' ')}` : '';
  return `${name}() { ${command}${defaults} "$@"; }`;
}

export function wrapWithBashSearchTools(
  command: string,
  config: Config,
  cwd: string,
): string {
  if (!isBashSearchAvailable()) {
    return command;
  }

  const ripgrep = getBuiltinRipgrep();
  if (!ripgrep) {
    return command;
  }

  const filtering = config.getFileFilteringOptions();
  const ignoreFiles = filtering.respectQwenIgnore
    ? getIgnoreFiles(config, cwd)
    : [];
  const rgArgs = filtering.respectGitIgnore
    ? ['--no-require-git']
    : ['--no-ignore-vcs'];
  for (const ignoreFile of ignoreFiles) {
    rgArgs.push('--ignore-file', escapeShellArg(ignoreFile, 'bash'));
  }

  const functions = [shellFunction('rg', bashExecutable(ripgrep), rgArgs)];

  if (os.platform() === 'win32') {
    const ugrep = getBundledSearchBinary('ugrep');
    if (!ugrep || !fs.existsSync(ugrep)) {
      return command;
    }
    functions.push(
      shellFunction('grep', bashExecutable(ugrep), [
        '-G',
        '--hidden',
        '-I',
        ...(filtering.respectGitIgnore ? ['--ignore-files'] : []),
        ...ignoreFiles.map(
          (ignoreFile) =>
            `--ignore-files=${escapeShellArg(ignoreFile.replaceAll('\\', '/'), 'bash')}`,
        ),
      ]),
      shellFunction('find', 'command find', []),
    );
  } else {
    const bfs = getBundledSearchBinary('bfs');
    const ugrep = getBundledSearchBinary('ugrep');
    if (!bfs || !ugrep) {
      return command;
    }

    const grepArgs = ['-G', '--hidden', '-I'];
    if (filtering.respectGitIgnore) {
      grepArgs.push('--ignore-files');
    }
    for (const ignoreFile of ignoreFiles) {
      grepArgs.push(`--ignore-files=${escapeShellArg(ignoreFile, 'bash')}`);
    }
    functions.push(
      shellFunction('grep', bashExecutable(ugrep), grepArgs),
      shellFunction('find', bashExecutable(bfs), ['-S', 'dfs']),
    );
  }

  return `${functions.join('\n')}\n${command}`;
}
