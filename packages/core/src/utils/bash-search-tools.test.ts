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
import { resolveHealthyBuiltinRipgrep } from './ripgrepUtils.js';
import { getShellConfiguration } from './shell-utils.js';
import {
  _resetBashSearchToolsForTest,
  isBashSearchAvailable,
  resolveBashSearchAvailability,
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
  resolveHealthyBuiltinRipgrep: vi.fn(),
}));
vi.mock('./shell-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shell-utils.js')>()),
  getShellConfiguration: vi.fn(),
}));

const PLATFORM_DIRECTORY = 'arm64-linux';

describe('Bash search tools', () => {
  let projectRoot: string;
  let secondRoot: string;
  let vendorRoot: string;

  beforeEach(async () => {
    _resetBashSearchToolsForTest();
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'qwen-search-project-'));
    secondRoot = await mkdtemp(path.join(os.tmpdir(), 'qwen-search-second-'));
    vendorRoot = await mkdtemp(path.join(os.tmpdir(), 'qwen-search-vendor-'));
    vi.mocked(os.platform).mockReturnValue('linux');
    vi.mocked(getShellConfiguration).mockReturnValue({
      executable: 'bash',
      argsPrefix: ['-c'],
      shell: 'bash',
    });
    await installFakeVendor();
  });

  afterEach(async () => {
    _resetBashSearchToolsForTest();
    vi.restoreAllMocks();
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true }),
      rm(vendorRoot, { recursive: true, force: true }),
    ]);
  });

  async function installFakeVendor() {
    const rg = path.join(vendorRoot, 'ripgrep', PLATFORM_DIRECTORY, 'rg');
    await Promise.all(
      ['ripgrep', 'bfs', 'ugrep'].map((vendor) =>
        mkdir(path.join(vendorRoot, vendor, PLATFORM_DIRECTORY), {
          recursive: true,
        }),
      ),
    );
    await Promise.all([
      writeFile(rg, ''),
      writeFile(path.join(vendorRoot, 'bfs', PLATFORM_DIRECTORY, 'bfs'), ''),
      writeFile(
        path.join(vendorRoot, 'ugrep', PLATFORM_DIRECTORY, 'ugrep'),
        '',
      ),
    ]);
    vi.mocked(resolveHealthyBuiltinRipgrep).mockResolvedValue(rg);
  }

  function createConfig(options?: {
    respectGitIgnore?: boolean;
    respectQwenIgnore?: boolean;
    useRipgrep?: boolean;
    useBuiltinRipgrep?: boolean;
    directories?: string[];
  }): Config {
    return {
      getUseRipgrep: () => options?.useRipgrep ?? true,
      getUseBuiltinRipgrep: () => options?.useBuiltinRipgrep ?? true,
      getWorkspaceContext: () => ({
        getDirectories: () => options?.directories ?? [projectRoot],
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
    const config = createConfig();

    expect(await resolveBashSearchAvailability(config)).toBe(true);
    expect(isBashSearchAvailable()).toBe(true);
    const command = wrapWithBashSearchTools('rg needle .', config, projectRoot);

    expect(command).toContain('rg()');
    expect(command).toContain('grep()');
    expect(command).toContain('find()');
    expect(command).toContain(`/ripgrep/${PLATFORM_DIRECTORY}/rg`);
    expect(command).toContain(`/ugrep/${PLATFORM_DIRECTORY}/ugrep`);
    expect(command).toContain(`/bfs/${PLATFORM_DIRECTORY}/bfs`);
    expect(command).toContain('--hidden');
    expect(command).toContain('--glob \\!.git');
    expect(command).toContain('--no-require-git');
    expect(command).toContain('--exclude-dir=.git');
    expect(command).toContain('--ignore-files');
    expect(command).toContain('this option is disabled by Qwen Code');
    expect(command.indexOf('.agentignore')).toBeLessThan(
      command.indexOf('.qwenignore'),
    );
    expect(command.endsWith('rg needle .')).toBe(true);
  });

  it('stays inert on Windows', async () => {
    vi.mocked(os.platform).mockReturnValue('win32');
    const config = createConfig();

    expect(await resolveBashSearchAvailability(config)).toBe(false);
    expect(isBashSearchAvailable()).toBe(false);
    expect(wrapWithBashSearchTools('rg needle .', config, projectRoot)).toBe(
      'rg needle .',
    );
  });

  it('keeps the command unchanged when the shell is not Bash', async () => {
    vi.mocked(getShellConfiguration).mockReturnValue({
      executable: 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c'],
      shell: 'cmd',
    });
    const config = createConfig();

    expect(await resolveBashSearchAvailability(config)).toBe(false);
    expect(wrapWithBashSearchTools('dir', config, projectRoot)).toBe('dir');
  });

  it('declines when the user opted out of the bundled ripgrep', async () => {
    expect(
      await resolveBashSearchAvailability(createConfig({ useRipgrep: false })),
    ).toBe(false);

    _resetBashSearchToolsForTest();
    expect(
      await resolveBashSearchAvailability(
        createConfig({ useBuiltinRipgrep: false }),
      ),
    ).toBe(false);
  });

  it('does not cache a per-config opt-out as missing binaries', async () => {
    expect(
      await resolveBashSearchAvailability(createConfig({ useRipgrep: false })),
    ).toBe(false);
    expect(await resolveBashSearchAvailability(createConfig())).toBe(true);
  });

  it('declines when the bundled ripgrep does not run', async () => {
    vi.mocked(resolveHealthyBuiltinRipgrep).mockResolvedValue(null);

    expect(await resolveBashSearchAvailability(createConfig())).toBe(false);
  });

  it('keeps dedicated search tools for a multi-root workspace', async () => {
    expect(await resolveBashSearchAvailability(createConfig())).toBe(true);
    const config = createConfig({ directories: [projectRoot, secondRoot] });

    expect(await resolveBashSearchAvailability(config)).toBe(false);
    expect(wrapWithBashSearchTools('rg needle .', config, secondRoot)).toBe(
      'rg needle .',
    );
  });

  it('honors disabled Git and Qwen ignore settings', async () => {
    await writeFile(path.join(projectRoot, '.qwenignore'), 'private.txt\n');
    const config = createConfig({
      respectGitIgnore: false,
      respectQwenIgnore: false,
    });

    expect(await resolveBashSearchAvailability(config)).toBe(true);
    const command = wrapWithBashSearchTools('rg needle .', config, projectRoot);

    expect(command).toContain('--no-ignore-vcs');
    expect(command).not.toContain('--ignore-file ');
    expect(command).not.toContain('--ignore-files');
  });
});
