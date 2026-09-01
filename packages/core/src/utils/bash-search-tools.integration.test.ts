/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import {
  resolveBashSearchAvailability,
  wrapWithBashSearchTools,
} from './bash-search-tools.js';
import { getShellConfiguration } from './shell-utils.js';

const execFileAsync = promisify(execFile);

// Availability is resolved asynchronously, so a single-root probe config is
// enough to decide whether the bundled binaries exist on this platform.
const bashSearchAvailable = await resolveBashSearchAvailability({
  getUseRipgrep: () => true,
  getUseBuiltinRipgrep: () => true,
  getWorkspaceContext: () => ({ getDirectories: () => ['.'] }),
} as unknown as Config);

describe.skipIf(!bashSearchAvailable)('bundled Bash search tools', () => {
  let projectRoot: string;
  let outsideRoot: string;
  let config: Config;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'qwen-bash-search-'));
    outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'qwen-bash-outside-'));
    config = {
      getUseRipgrep: () => true,
      getUseBuiltinRipgrep: () => true,
      getWorkspaceContext: () => ({
        getDirectories: () => [projectRoot],
      }),
      getTargetDir: () => projectRoot,
      getFileFilteringOptions: () => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
        customIgnoreFiles: ['.agentignore'],
      }),
    } as unknown as Config;
    await resolveBashSearchAvailability(config);

    await mkdir(path.join(projectRoot, '.git'));
    await mkdir(path.join(projectRoot, '.github'));
    await mkdir(path.join(projectRoot, 'nested'));
    await Promise.all([
      writeFile(path.join(projectRoot, '.gitignore'), 'git-secret.txt\n'),
      writeFile(
        path.join(projectRoot, 'nested', '.gitignore'),
        'nested-secret.txt\n',
      ),
      writeFile(path.join(projectRoot, '.agentignore'), '!qwen-secret.txt\n'),
      writeFile(
        path.join(projectRoot, '.qwenignore'),
        'qwen-secret.txt\n*.env\n!allowed.env\n',
      ),
      writeFile(path.join(projectRoot, 'git-secret.txt'), 'needle\n'),
      writeFile(
        path.join(projectRoot, 'nested', 'nested-secret.txt'),
        'needle\n',
      ),
      writeFile(path.join(projectRoot, 'qwen-secret.txt'), 'needle\n'),
      writeFile(path.join(projectRoot, 'blocked.env'), 'needle\n'),
      writeFile(path.join(projectRoot, 'allowed.env'), 'needle\n'),
      writeFile(path.join(projectRoot, '.hidden.txt'), 'needle\n'),
      writeFile(path.join(projectRoot, '.github', 'ci.yml'), 'needle\n'),
      writeFile(path.join(projectRoot, '.git', 'config'), 'needle\n'),
      writeFile(path.join(projectRoot, 'visible.txt'), 'needle\nQ\n'),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  async function execute(command: string): Promise<string> {
    const shell = getShellConfiguration();
    const wrapped = wrapWithBashSearchTools(command, config, projectRoot);
    const result = await execFileAsync(
      shell.executable,
      [...shell.argsPrefix, wrapped],
      { cwd: projectRoot },
    );
    return result.stdout;
  }

  it('applies Git, Qwen, and custom ignore behavior to rg and grep', async () => {
    const [rgOutput, grepOutput, fileOutput] = await Promise.all([
      execute('rg -l needle .'),
      execute('grep -R -l needle .'),
      execute("rg --files | rg '([.]txt|[.]env|[.]yml)$'"),
    ]);

    for (const output of [rgOutput, grepOutput, fileOutput]) {
      expect(output).toContain('visible.txt');
      expect(output).toContain('allowed.env');
      expect(output).toContain('.hidden.txt');
      expect(output).toContain('.github/ci.yml');
      expect(output).not.toContain('.git/config');
      expect(output).not.toContain('git-secret.txt');
      expect(output).not.toContain('nested-secret.txt');
      expect(output).not.toContain('blocked.env');
      expect(output).not.toContain('qwen-secret.txt');
    }
  });

  it('keeps rg and grep aligned on cross-file ignore precedence', async () => {
    await Promise.all([
      writeFile(path.join(projectRoot, '.agentignore'), '*.log\n'),
      writeFile(path.join(projectRoot, '.qwenignore'), '!keep.log\n'),
      writeFile(path.join(projectRoot, 'keep.log'), 'needle\n'),
      writeFile(path.join(projectRoot, 'hidden.log'), 'needle\n'),
    ]);

    const [rgOutput, grepOutput] = await Promise.all([
      execute('rg -l needle .'),
      execute('grep -R -l needle .'),
    ]);

    for (const output of [rgOutput, grepOutput]) {
      expect(output).toContain('keep.log');
      expect(output).not.toContain('hidden.log');
    }
  });

  it('provides find alongside rg and grep', async () => {
    expect(await execute("find . -type f -name 'visible.txt'")).toContain(
      'visible.txt',
    );
  });

  it('does not apply workspace ignore files to outside search paths', async () => {
    const outsideLog = path.join(outsideRoot, 'outside.env');
    await writeFile(outsideLog, 'needle\n');

    const [rgOutput, grepOutput] = await Promise.all([
      execute(`rg -l needle ${outsideRoot}`),
      execute(`grep -R -l needle ${outsideRoot}`),
    ]);

    expect(rgOutput).toContain(outsideLog);
    expect(grepOutput).toContain(outsideLog);
  });

  it('allows Q in an attached grep pattern value', async () => {
    expect(await execute('grep -eQ visible.txt')).toContain('Q');
  });

  it.each([
    'grep --save-config=/tmp/qwen-ugrep.conf needle visible.txt',
    'grep --config=/tmp/qwen-ugrep.conf needle visible.txt',
    "grep --filter='*:touch /tmp/qwen-ugrep-filter' needle visible.txt",
    'grep --pager=cat needle visible.txt',
    'grep --view=cat needle visible.txt',
    'grep --query needle visible.txt',
    'grep ---/tmp/qwen-ugrep.conf needle visible.txt',
    'grep -nQ needle visible.txt',
    'grep -Q needle visible.txt',
    'grep -Qn needle visible.txt',
    'grep -ZQ needle visible.txt',
    'grep -e -- --filter=cat visible.txt',
    'grep --regexp -- --filter=cat visible.txt',
    'grep --colors --filter=cat visible.txt',
  ])('blocks effectful ugrep option in %j', async (command) => {
    await expect(execute(command)).rejects.toMatchObject({
      stderr: expect.stringContaining('this option is disabled by Qwen Code'),
    });
  });
});
