/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { getBuiltinRipgrep } from './ripgrepUtils.js';
import { getShellConfiguration } from './shell-utils.js';
import {
  isBashSearchAvailable,
  wrapWithBashSearchTools,
} from './bash-search-tools.js';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  default: {
    ...(await importOriginal<typeof import('node:os')>()),
    platform: vi.fn(),
  },
}));
vi.mock('./ripgrepUtils.js', () => ({
  getBuiltinRipgrep: vi.fn(),
}));
vi.mock('./shell-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shell-utils.js')>()),
  getShellConfiguration: vi.fn(),
}));

describe('Bash search tools', () => {
  let projectRoot: string;
  let vendorRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'qwen-search-project-'));
    vendorRoot = await mkdtemp(path.join(os.tmpdir(), 'qwen-search-vendor-'));
    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(getShellConfiguration).mockReturnValue({
      executable: 'bash',
      argsPrefix: ['-c'],
      shell: 'bash',
    });
    await installFakeVendor('arm64-linux');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(vendorRoot, { recursive: true, force: true }),
    ]);
  });

  async function installFakeVendor(platformDirectory: string) {
    const rg = path.join(
      vendorRoot,
      'ripgrep',
      platformDirectory,
      platformDirectory.endsWith('win32') ? 'rg.exe' : 'rg',
    );
    const executableSuffix = platformDirectory.endsWith('win32') ? '.exe' : '';
    await Promise.all(
      ['ripgrep', 'bfs', 'ugrep'].map((vendor) =>
        mkdir(path.join(vendorRoot, vendor, platformDirectory), {
          recursive: true,
        }),
      ),
    );
    await Promise.all([
      writeFile(rg, ''),
      writeFile(
        path.join(
          vendorRoot,
          'bfs',
          platformDirectory,
          `bfs${executableSuffix}`,
        ),
        '',
      ),
      writeFile(
        path.join(
          vendorRoot,
          'ugrep',
          platformDirectory,
          `ugrep${executableSuffix}`,
        ),
        '',
      ),
    ]);
    vi.mocked(getBuiltinRipgrep).mockReturnValue(rg);
  }

  function createConfig(options?: {
    respectGitIgnore?: boolean;
    respectQwenIgnore?: boolean;
  }): Config {
    return {
      getWorkspaceContext: () => ({
        getDirectories: () => [projectRoot],
      }),
      getTargetDir: () => projectRoot,
      getFileFilteringOptions: () => ({
        respectGitIgnore: options?.respectGitIgnore ?? true,
        respectQwenIgnore: options?.respectQwenIgnore ?? true,
        customIgnoreFiles: ['.agentignore'],
      }),
    } as unknown as Config;
  }

  it('injects bundled rg, ugrep, and bfs into Bash', async () => {
    await Promise.all([
      writeFile(path.join(projectRoot, '.agentignore'), 'agent-only.txt\n'),
      writeFile(path.join(projectRoot, '.qwenignore'), 'private.txt\n'),
    ]);

    expect(isBashSearchAvailable()).toBe(true);
    const command = wrapWithBashSearchTools(
      'rg needle .',
      createConfig(),
      projectRoot,
    );

    expect(command).toContain('rg()');
    expect(command).toContain('grep()');
    expect(command).toContain('find()');
    expect(command).toContain('/ripgrep/arm64-linux/rg');
    expect(command).toContain('/ugrep/arm64-linux/ugrep');
    expect(command).toContain('/bfs/arm64-linux/bfs');
    expect(command).toContain('--no-require-git');
    expect(command).toContain('--ignore-files');
    expect(command.indexOf('.agentignore')).toBeLessThan(
      command.indexOf('.qwenignore'),
    );
    expect(command.endsWith('rg needle .')).toBe(true);
  });

  it('maps Windows Git Bash to bundled rg and ugrep plus system find', async () => {
    vi.mocked(os.platform).mockReturnValue('win32');
    await installFakeVendor('x64-win32');

    const command = wrapWithBashSearchTools(
      'grep needle .',
      createConfig(),
      projectRoot,
    );

    expect(command).toContain('/ripgrep/x64-win32/rg.exe');
    expect(command).toContain('/ugrep/x64-win32/ugrep.exe');
    expect(command).toContain('find() { command find');
    expect(command).not.toContain('/bfs/');
  });

  it('keeps the command unchanged when Bash search is unavailable', () => {
    vi.mocked(getShellConfiguration).mockReturnValue({
      executable: 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c'],
      shell: 'cmd',
    });

    expect(wrapWithBashSearchTools('dir', createConfig(), projectRoot)).toBe(
      'dir',
    );
  });

  it('honors disabled Git and Qwen ignore settings', async () => {
    await writeFile(path.join(projectRoot, '.qwenignore'), 'private.txt\n');

    const command = wrapWithBashSearchTools(
      'rg needle .',
      createConfig({
        respectGitIgnore: false,
        respectQwenIgnore: false,
      }),
      projectRoot,
    );

    expect(command).toContain('--no-ignore-vcs');
    expect(command).not.toContain('--no-require-git');
    expect(command).not.toContain('--ignore-file ');
    expect(command).not.toContain('--ignore-files');
  });
});
