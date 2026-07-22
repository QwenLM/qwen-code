/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv } from 'yargs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FatalError } from '@qwen-code/qwen-code-core';
import { AlreadyReportedError } from './utils/errors.js';
import {
  MCP_COMMANDS,
  TOP_LEVEL_COMMANDS,
  handleCriticalError,
  isExpectedPtyRaceError,
  resolveBootstrapRoute,
  runCliEntry,
  runCliEntryPoint,
} from './cli.js';

const mocks = vi.hoisted(() => ({
  main: vi.fn(),
  tryRunServeFastPath: vi.fn(),
  initStartupProfiler: vi.fn(),
  initializeAcpStartupProfiler: vi.fn(),
  markAcpStartup: vi.fn(),
  initCpuProfiler: vi.fn(),
  mcpHandler: vi.fn(),
  mcpBuilder: vi.fn(),
  mcpListHandler: vi.fn(),
  mcpAddHandler: vi.fn(),
  getCliVersion: vi.fn(),
  installManagedNpmUpdate: vi.fn(),
}));

vi.mock('./gemini.js', () => ({
  main: mocks.main,
}));

vi.mock('./serve/fast-path.js', () => ({
  tryRunServeFastPath: mocks.tryRunServeFastPath,
}));

vi.mock('./utils/startupProfiler.js', () => ({
  initStartupProfiler: mocks.initStartupProfiler,
}));

vi.mock('./utils/acp-startup-profiler.js', () => ({
  initializeAcpStartupProfiler: mocks.initializeAcpStartupProfiler,
  markAcpStartup: mocks.markAcpStartup,
}));

vi.mock('./utils/cpuProfiler.js', () => ({
  initCpuProfiler: mocks.initCpuProfiler,
}));

vi.mock('./utils/version.js', () => ({
  getCliVersion: mocks.getCliVersion,
}));

vi.mock('./utils/managed-npm-update.js', () => ({
  installManagedNpmUpdate: mocks.installManagedNpmUpdate,
}));

vi.mock('./commands/mcp.js', () => ({
  mcpCommand: {
    command: 'mcp',
    describe: 'Manage MCP servers',
    builder: (yargs: Argv) => {
      mocks.mcpBuilder();
      return yargs
        .command({
          command: 'list',
          describe: 'List all configured MCP servers',
          handler: mocks.mcpListHandler,
        })
        .command({
          command: 'add <name>',
          describe: 'Add a server',
          handler: mocks.mcpAddHandler,
        })
        .demandCommand(1, 'You need at least one command before continuing.');
    },
    handler: mocks.mcpHandler,
  },
}));

describe('resolveBootstrapRoute', () => {
  it('routes top-level help, version, serve, and mcp correctly', async () => {
    expect(resolveBootstrapRoute(['--help'])).toBe('help');
    expect(resolveBootstrapRoute(['--version'])).toBe('version');
    expect(resolveBootstrapRoute(['mcp', '--version'])).toBe('version');
    expect(resolveBootstrapRoute(['serve', '--help'])).toBe('serve');
    expect(resolveBootstrapRoute(['mcp', '--help'])).toBe('mcp');
  });

  it('keeps bundled entrypoint paths out of the route detection', async () => {
    expect(resolveBootstrapRoute(['/repo/dist/cli.js', '--help'])).toBe('help');
    expect(
      resolveBootstrapRoute(['C:\\repo\\dist\\cli.js', 'mcp', '--help']),
    ).toBe('mcp');
  });

  it('falls back to the default route for normal interactive startup', async () => {
    expect(resolveBootstrapRoute([])).toBe('default');
    expect(resolveBootstrapRoute(['--model', 'gpt-4', 'Hello'])).toBe(
      'default',
    );
    expect(resolveBootstrapRoute(['--safe-mode', 'mcp', 'list'])).toBe(
      'default',
    );
  });

  it('does not treat values for global flags as positional commands or bootstrap flags', () => {
    expect(resolveBootstrapRoute(['--model', 'gpt-4', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['-p', 'hello', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['--model', '-v'])).toBe('default');
  });

  it('does not treat flags after -- as bootstrap flags', () => {
    expect(resolveBootstrapRoute(['--', '--version'])).toBe('default');
    expect(resolveBootstrapRoute(['mcp', '--', '--version'])).toBe('mcp');
  });
});

describe('runCliEntry', () => {
  const savedEnv = {
    CLI_VERSION: process.env['CLI_VERSION'],
    QWEN_CODE_MANAGED_NPM_UPDATE_VERSION:
      process.env['QWEN_CODE_MANAGED_NPM_UPDATE_VERSION'],
  };

  let stdout: string[];
  let stderr: string[];
  let savedExitCode: string | number | null | undefined;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    mocks.tryRunServeFastPath.mockResolvedValue(false);
    mocks.getCliVersion.mockResolvedValue('fallback-version');
    process.env['CLI_VERSION'] = '9.9.9';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    if (savedEnv.CLI_VERSION === undefined) {
      delete process.env['CLI_VERSION'];
    } else {
      process.env['CLI_VERSION'] = savedEnv.CLI_VERSION;
    }
    if (savedEnv.QWEN_CODE_MANAGED_NPM_UPDATE_VERSION === undefined) {
      delete process.env['QWEN_CODE_MANAGED_NPM_UPDATE_VERSION'];
    } else {
      process.env['QWEN_CODE_MANAGED_NPM_UPDATE_VERSION'] =
        savedEnv.QWEN_CODE_MANAGED_NPM_UPDATE_VERSION;
    }
    vi.restoreAllMocks();
  });

  it('prints the version without loading the full CLI graph', async () => {
    await runCliEntry(['--version']);

    expect(stdout.join('')).toContain('9.9.9');
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.tryRunServeFastPath).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('runs a managed update worker without starting the CLI', async () => {
    process.env['QWEN_CODE_MANAGED_NPM_UPDATE_VERSION'] = '2.0.0';

    await runCliEntry([]);

    expect(mocks.installManagedNpmUpdate).toHaveBeenCalledWith('2.0.0');
    expect(process.env['QWEN_CODE_MANAGED_NPM_UPDATE_VERSION']).toBeUndefined();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('falls back to getCliVersion when CLI_VERSION is unset', async () => {
    delete process.env['CLI_VERSION'];

    await runCliEntry(['--version']);

    expect(stdout.join('')).toContain('fallback-version');
    expect(mocks.getCliVersion).toHaveBeenCalledTimes(1);
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.tryRunServeFastPath).not.toHaveBeenCalled();
  });

  it('prints top-level help without loading the full CLI graph', async () => {
    await runCliEntry(['--help']);

    const helpText = stdout.join('');
    expect(helpText).toContain('Usage: qwen [options] [command]');
    expect(helpText).toContain('Manage Qwen Code hooks');
    expect(helpText).toContain('Manage MCP servers');
    expect(helpText).toContain('Run Qwen Code as a local HTTP daemon');
    expect(helpText).toContain('--model');
    expect(helpText).toContain('-p, --prompt');
    expect(helpText).toContain('--safe-mode');
    expect(helpText).toContain('-s, --sandbox');
    expect(helpText).toContain('-o, --output-format');
    expect(helpText).toContain('-r, --resume');
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.tryRunServeFastPath).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('routes the MCP help path without booting gemini', async () => {
    await runCliEntry(['mcp', '--help']);

    expect(stdout.join('')).toContain('Manage MCP servers');
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.tryRunServeFastPath).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
    expect(mocks.mcpBuilder).not.toHaveBeenCalled();
  });

  it('does not execute MCP subcommands when showing subcommand help', async () => {
    await runCliEntry(['mcp', 'list', '--help']);

    const helpText = stdout.join('');
    expect(helpText).toContain('List all configured MCP servers');
    expect(mocks.mcpListHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('executes MCP subcommands through the fast path', async () => {
    await runCliEntry(['mcp', 'list']);

    expect(mocks.mcpListHandler).toHaveBeenCalledTimes(1);
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('executes MCP subcommands after -- through the fast path', async () => {
    await runCliEntry(['mcp', '--', 'list']);

    expect(mocks.mcpListHandler).toHaveBeenCalledTimes(1);
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('uses the full CLI when global flags precede MCP commands', async () => {
    await runCliEntry(['--safe-mode', 'mcp', 'list']);

    expect(mocks.main).toHaveBeenCalledTimes(1);
    expect(mocks.mcpListHandler).not.toHaveBeenCalled();
  });

  it('fails MCP fast-path validation without loading the full CLI', async () => {
    await runCliEntry(['mcp', 'doesnotexist']);

    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('Unknown command: doesnotexist');
    expect(mocks.mcpListHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('does not run MCP subcommands with unknown options', async () => {
    await runCliEntry(['mcp', 'list', '--unknown']);

    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('Unknown argument: unknown');
    expect(mocks.mcpListHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('reports routine MCP argument errors without loading the full CLI', async () => {
    await runCliEntry(['mcp', 'add']);

    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('Not enough non-option arguments');
    expect(mocks.mcpAddHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('keeps the serve fast path ahead of the full CLI startup', async () => {
    mocks.tryRunServeFastPath.mockResolvedValue(true);

    await runCliEntry(['serve']);

    expect(mocks.tryRunServeFastPath).toHaveBeenCalledWith(['serve']);
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('initializes profilers once when the serve fast path falls back', async () => {
    mocks.tryRunServeFastPath.mockResolvedValue(false);

    await runCliEntry(['serve']);

    expect(mocks.tryRunServeFastPath).toHaveBeenCalledWith(['serve']);
    expect(mocks.main).toHaveBeenCalledTimes(1);
  });

  it('loads gemini on the default path', async () => {
    await runCliEntry([]);

    expect(mocks.main).toHaveBeenCalledTimes(1);
    expect(mocks.initializeAcpStartupProfiler).not.toHaveBeenCalled();
  });

  it('profiles the Gemini module import only on the ACP path', async () => {
    await runCliEntry(['--acp']);

    expect(mocks.initializeAcpStartupProfiler).toHaveBeenCalledTimes(1);
    expect(mocks.markAcpStartup.mock.calls).toEqual([
      ['geminiImportStart'],
      ['geminiImportEnd'],
    ]);
    expect(mocks.main).toHaveBeenCalledTimes(1);
  });

  it('does not profile when ACP is explicitly disabled', async () => {
    await runCliEntry(['--acp=false']);

    expect(mocks.initializeAcpStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.markAcpStartup).not.toHaveBeenCalled();
    expect(mocks.main).toHaveBeenCalledTimes(1);
  });
});

describe('bootstrap import boundaries', () => {
  it('keeps fast-path-only dependencies out of static imports', () => {
    const source = readFileSync('src/cli.ts', 'utf8');

    expect(source).not.toContain("import yargs from 'yargs'");
    expect(source).not.toContain("from '@qwen-code/qwen-code-core'");
    expect(source).not.toContain("import './gemini.js'");
    expect(source).not.toContain("import { main } from './gemini.js'");
    expect(source).not.toContain("from './utils/acp-startup-profiler.js'");
  });

  it('initializes profilers during bootstrap module evaluation', () => {
    const source = readFileSync('src/cli.ts', 'utf8');

    expect(source).toContain(
      "import { initStartupProfiler } from './utils/startupProfiler.js'",
    );
    expect(source).toContain(
      "import { initCpuProfiler } from './utils/cpuProfiler.js'",
    );
    expect(source.indexOf('initStartupProfiler();')).toBeLessThan(
      source.indexOf('export async function runCliEntry('),
    );
    expect(source.indexOf('initCpuProfiler();')).toBeLessThan(
      source.indexOf('export async function runCliEntry('),
    );
  });

  it('uses the bootstrap file as the production bundle entry', () => {
    const source = readFileSync('../../esbuild.config.js', 'utf8');

    expect(source).toContain("entryPoints: { cli: 'packages/cli/src/cli.ts' }");
  });

  it('keeps bootstrap fast paths in-process in the npm bin wrapper', () => {
    const source = readFileSync('../../scripts/cli-entry.js', 'utf8');

    expect(source).toContain('function isInProcessFastPath()');
    expect(source).toContain("first === 'serve'");
    expect(source).toContain("first === 'mcp'");
    expect(source).toContain("hasFlag('--help', '-h')");
    expect(source).toContain("hasFlag('--version', '-v')");
    expect(source).toContain('UPDATE_COMPLETE_EXIT_CODE = 44');
  });

  it('reloads the CLI through a stable shim after an update', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-cli-update-'));
    const wrongDir = mkdtempSync(path.join(tmpdir(), 'qwen-cli-wrong-'));
    const oldDir = path.join(tempDir, 'old');
    const newDir = path.join(tempDir, 'new');
    const binPath = path.join(tempDir, 'qwen');
    try {
      mkdirSync(oldDir);
      mkdirSync(newDir);
      copyFileSync(
        '../../scripts/cli-entry.js',
        path.join(oldDir, 'entry.mjs'),
      );
      copyFileSync(
        '../../scripts/cli-entry.js',
        path.join(newDir, 'entry.mjs'),
      );
      writeFileSync(
        path.join(oldDir, 'cli.js'),
        `import { chmodSync, rmSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(binPath)}, ${JSON.stringify(`#!/bin/sh\nexec "${process.execPath}" "${path.join(newDir, 'entry.mjs')}" "$@"\n`)});\nchmodSync(${JSON.stringify(binPath)}, 0o755);\nrmSync(${JSON.stringify(oldDir)}, { recursive: true, force: true });\nprocess.exit(44);\n`,
      );
      writeFileSync(
        path.join(newDir, 'cli.js'),
        "process.stdout.write(`${JSON.stringify({ args: process.argv.slice(2), skip: process.env.QWEN_CODE_SKIP_UPDATE_CHECK_ONCE, hasLauncherPid: /^\\d+$/.test(process.env.QWEN_CODE_LAUNCHER_PID ?? ''), launcherPath: process.env.QWEN_CODE_LAUNCHER_PATH })}\\n`);\n",
      );
      writeFileSync(
        binPath,
        `#!/bin/sh\nexec "${process.execPath}" "${path.join(oldDir, 'entry.mjs')}" "$@"\n`,
      );
      chmodSync(binPath, 0o755);
      writeFileSync(
        path.join(wrongDir, 'qwen'),
        '#!/bin/sh\necho wrong-launcher\n',
      );
      chmodSync(path.join(wrongDir, 'qwen'), 0o755);

      const output = execFileSync(binPath, ['--prompt', 'a&b'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${wrongDir}${path.delimiter}${tempDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        },
      });

      expect(JSON.parse(output)).toEqual({
        args: ['--prompt', 'a&b'],
        skip: 'true',
        hasLauncherPid: true,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(wrongDir, { recursive: true, force: true });
    }
  });

  it('does not pass the standalone launcher hint to child processes', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-cli-launcher-env-'));
    const entryPath = path.join(tempDir, 'entry.mjs');
    const launcherPath = path.join(tempDir, 'qwen');
    try {
      copyFileSync('../../scripts/cli-entry.js', entryPath);
      writeFileSync(
        path.join(tempDir, 'cli.js'),
        'process.stdout.write(JSON.stringify({ launcherPath: process.env.QWEN_CODE_LAUNCHER_PATH }));\n',
      );
      writeFileSync(launcherPath, '#!/bin/sh\n');
      chmodSync(launcherPath, 0o755);

      const output = execFileSync(process.execPath, [entryPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          QWEN_CODE_LAUNCHER_PATH: launcherPath,
        },
      });

      expect(JSON.parse(output)).toEqual({});
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ignores malformed relaunch args in the npm bin wrapper', () => {
    const output = execFileSync(
      process.execPath,
      ['../../scripts/cli-entry.js', '--version'],
      {
        encoding: 'utf8',
        env: { ...process.env, QWEN_CODE_RELAUNCH_ARGS: 'not-json' },
      },
    );

    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints CLI_VERSION from the npm bin wrapper version shortcut', () => {
    const output = execFileSync(
      process.execPath,
      ['../../scripts/cli-entry.js', '--version'],
      {
        encoding: 'utf8',
        env: { ...process.env, CLI_VERSION: '7.7.7-test' },
      },
    );

    expect(output).toBe('7.7.7-test\n');
  });

  it('reads package.json from the npm bin wrapper version shortcut', () => {
    const expectedVersion = JSON.parse(
      readFileSync('../../package.json', 'utf8'),
    ).version;
    const env = { ...process.env };
    delete env['CLI_VERSION'];

    const output = execFileSync(
      process.execPath,
      ['../../scripts/cli-entry.js', '--version'],
      {
        encoding: 'utf8',
        env,
      },
    );

    expect(output).toBe(`${expectedVersion}\n`);
  });

  it('resolves and pins managed updates from the configured home', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-managed-npm-'));
    const entryDir = path.join(tempDir, 'bootstrap');
    const entryPath = path.join(entryDir, 'cli-entry.mjs');
    const qwenHome = path.join(tempDir, 'custom', 'qwen');
    try {
      mkdirSync(entryDir, { recursive: true });
      copyFileSync('../../scripts/cli-entry.js', entryPath);
      const bootstrapId = createHash('sha256')
        .update(realpathSync(entryPath))
        .digest('hex')
        .slice(0, 16);
      const launcherRoot = path.join(qwenHome, 'updates', 'npm', bootstrapId);
      const packageRoot = path.join(
        launcherRoot,
        'versions',
        '2.0.0',
        'node_modules',
        '@qwen-code',
        'qwen-code',
      );
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        path.join(entryDir, 'cli.js'),
        "process.stdout.write(JSON.stringify({ build: 'base', pin: process.env.QWEN_CODE_MANAGED_NPM_PIN }));\n",
      );
      writeFileSync(
        path.join(entryDir, 'package.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          version: '1.0.0',
        }),
      );
      writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          version: '2.0.0',
        }),
      );
      writeFileSync(
        path.join(packageRoot, 'cli.js'),
        "process.stdout.write(JSON.stringify({ build: 'managed-2', managed: process.env.QWEN_CODE_MANAGED_NPM_UPDATE, launcher: process.env.QWEN_CODE_CLI, pin: process.env.QWEN_CODE_MANAGED_NPM_PIN, args: process.argv.slice(2) }));\n",
      );
      mkdirSync(launcherRoot, { recursive: true });
      const bootstrapStat = statSync(entryPath);

      mkdirSync(path.join(tempDir, '.qwen'), { recursive: true });
      writeFileSync(
        path.join(tempDir, '.qwen', '.env'),
        '\uFEFFQWEN_HOME: ~\\custom\\qwen\n',
      );
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: tempDir,
        USERPROFILE: tempDir,
        TMPDIR: tempDir,
        TEMP: tempDir,
        TMP: tempDir,
      };
      delete childEnv['QWEN_HOME'];
      delete childEnv['QWEN_CODE_MANAGED_NPM_PIN'];
      const baseSession = JSON.parse(
        execFileSync(process.execPath, [entryPath, '--prompt', 'hello'], {
          encoding: 'utf8',
          env: childEnv,
        }),
      ) as { build: string; pin: string };
      expect(baseSession.build).toBe('base');

      writeFileSync(
        path.join(launcherRoot, 'active.json'),
        JSON.stringify({
          version: '2.0.0',
          bootstrap: realpathSync(entryPath),
          baseVersion: '1.0.0',
          bootstrapCtimeMs: bootstrapStat.ctimeMs,
        }),
      );
      expect(
        JSON.parse(
          execFileSync(process.execPath, [entryPath, '--prompt', 'hello'], {
            encoding: 'utf8',
            env: {
              ...childEnv,
              QWEN_CODE_MANAGED_NPM_PIN: baseSession.pin,
            },
          }),
        ),
      ).toMatchObject({ build: 'base' });
      expect(
        JSON.parse(
          execFileSync(process.execPath, [entryPath, '--prompt', 'hello'], {
            encoding: 'utf8',
            env: { ...childEnv, QWEN_HOME: '' },
          }),
        ),
      ).toMatchObject({ build: 'base' });

      writeFileSync(
        path.join(tempDir, '.qwen', '.env'),
        `QWEN_HOME:${qwenHome}\n`,
      );
      expect(
        JSON.parse(
          execFileSync(process.execPath, [entryPath, '--prompt', 'hello'], {
            encoding: 'utf8',
            env: childEnv,
          }),
        ),
      ).toMatchObject({ build: 'base' });
      writeFileSync(
        path.join(tempDir, '.qwen', '.env'),
        `QWEN_HOME:   \nOTHER=${qwenHome}\n`,
      );
      expect(
        JSON.parse(
          execFileSync(process.execPath, [entryPath, '--prompt', 'hello'], {
            encoding: 'utf8',
            env: childEnv,
          }),
        ),
      ).toMatchObject({ build: 'base' });
      writeFileSync(
        path.join(tempDir, '.qwen', '.env'),
        '\uFEFFQWEN_HOME: ~\\custom\\qwen\n',
      );
      const output = execFileSync(
        process.execPath,
        [entryPath, '--prompt', 'hello'],
        {
          encoding: 'utf8',
          env: childEnv,
        },
      );

      const managedSession = JSON.parse(output) as {
        build: string;
        managed: string;
        launcher: string;
        pin: string;
        args: string[];
      };
      expect(managedSession).toMatchObject({
        build: 'managed-2',
        managed: 'true',
        launcher: realpathSync(entryPath),
        args: ['--prompt', 'hello'],
      });
      writeFileSync(
        path.join(launcherRoot, 'active.json'),
        JSON.stringify({
          version: '3.0.0',
          bootstrap: realpathSync(entryPath),
          baseVersion: '1.0.0',
          bootstrapCtimeMs: bootstrapStat.ctimeMs,
        }),
      );
      expect(
        JSON.parse(
          execFileSync(process.execPath, [entryPath, '--prompt', 'hello'], {
            encoding: 'utf8',
            env: {
              ...childEnv,
              QWEN_HOME: 'different-relative-home',
              QWEN_CODE_MANAGED_NPM_PIN: managedSession.pin,
            },
          }),
        ),
      ).toMatchObject({ build: 'managed-2' });
      writeFileSync(
        path.join(launcherRoot, 'active.json'),
        JSON.stringify({
          version: '2.0.0',
          bootstrap: realpathSync(entryPath),
          baseVersion: '1.0.0',
          bootstrapCtimeMs: bootstrapStat.ctimeMs,
        }),
      );

      const emptyHomeRoot = path.join(tempDir, 'empty-home');
      const emptyQwenHome = path.join(emptyHomeRoot, '.qwen');
      mkdirSync(emptyQwenHome, { recursive: true });
      renameSync(
        path.join(qwenHome, 'updates'),
        path.join(emptyQwenHome, 'updates'),
      );
      const emptyHomeEnv = {
        ...childEnv,
        HOME: '',
        USERPROFILE: '',
        HOMEDRIVE: '',
        HOMEPATH: '',
        TMPDIR: emptyHomeRoot,
        TEMP: emptyHomeRoot,
        TMP: emptyHomeRoot,
      };
      expect(
        JSON.parse(
          execFileSync(process.execPath, [entryPath, '--prompt', 'hello'], {
            encoding: 'utf8',
            env: emptyHomeEnv,
          }),
        ),
      ).toMatchObject({
        build: 'managed-2',
        managed: 'true',
        launcher: realpathSync(entryPath),
        args: ['--prompt', 'hello'],
      });

      const replacement = `${entryPath}.replacement`;
      copyFileSync(entryPath, replacement);
      renameSync(replacement, entryPath);
      utimesSync(entryPath, bootstrapStat.atime, bootstrapStat.mtime);
      expect(statSync(entryPath).ctimeMs).not.toBe(bootstrapStat.ctimeMs);
      expect(
        JSON.parse(
          execFileSync(process.execPath, [entryPath, '--prompt', 'hello'], {
            encoding: 'utf8',
            env: emptyHomeEnv,
          }),
        ),
      ).toMatchObject({ build: 'base' });

      writeFileSync(
        path.join(entryDir, 'package.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          version: '3.0.0',
        }),
      );
      expect(
        JSON.parse(
          execFileSync(process.execPath, [entryPath, '--prompt', 'hello'], {
            encoding: 'utf8',
            env: {
              ...emptyHomeEnv,
              QWEN_CODE_MANAGED_NPM_UPDATE: 'true',
            },
          }),
        ),
      ).toMatchObject({ build: 'base' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('falls through to cli.js when wrapper package.json lookup fails', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-cli-entry-'));
    const entryDir = path.join(tempDir, 'bin');
    try {
      mkdirSync(entryDir);
      copyFileSync(
        '../../scripts/cli-entry.js',
        path.join(entryDir, 'cli-entry.mjs'),
      );
      writeFileSync(
        path.join(entryDir, 'cli.js'),
        "process.stdout.write('fallback-cli\\n');\n",
      );
      const env = { ...process.env };
      delete env['CLI_VERSION'];

      const output = execFileSync(
        process.execPath,
        [path.join(entryDir, 'cli-entry.mjs'), '--version'],
        {
          encoding: 'utf8',
          env,
        },
      );

      expect(output).toBe('fallback-cli\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('copies the npm bin wrapper into the package instead of duplicating it', () => {
    const source = readFileSync('../../scripts/prepare-package.js', 'utf8');

    expect(source).toContain(
      "fs.copyFileSync(path.join(__dirname, 'cli-entry.js'), cliEntryPath)",
    );
    expect(source).not.toContain('const cliEntryContent = `');
  });

  it('keeps bootstrap top-level help commands aligned with config registrations', () => {
    const configSource = readFileSync('src/config/config.ts', 'utf8');
    const commandNameByIdentifier = new Map([
      ['authCommand', 'auth'],
      ['channelCommand', 'channel'],
      ['extensionsCommand', 'extensions'],
      ['hooksCommand', 'hooks'],
      ['mcpCommand', 'mcp'],
      ['reviewCommand', 'review'],
      ['serveCommand', 'serve'],
      ['sessionsCommand', 'sessions'],
      ['fleetCommand', 'fleet'],
      ['updateCommand', 'update'],
    ]);
    const registeredIdentifiers = [
      ...configSource.matchAll(/\.command\((\w+Command)\)/g),
    ].map((match) => match[1]!);
    const bootstrapCommands = new Set(
      TOP_LEVEL_COMMANDS.map(([command]) => command.split(' ')[0]),
    );

    expect(registeredIdentifiers).toHaveLength(commandNameByIdentifier.size);
    for (const identifier of registeredIdentifiers) {
      const commandName = commandNameByIdentifier.get(identifier);
      expect(commandName, `missing mapping for ${identifier}`).toBeDefined();
      expect(bootstrapCommands).toContain(commandName);
    }
  });

  it('keeps bootstrap MCP help commands aligned with MCP registrations', () => {
    const mcpSource = readFileSync('src/commands/mcp.ts', 'utf8');
    const commandNameByIdentifier = new Map([
      ['addCommand', 'add'],
      ['removeCommand', 'remove'],
      ['listCommand', 'list'],
      ['reconnectCommand', 'reconnect'],
      ['approveCommand', 'approve'],
      ['rejectCommand', 'reject'],
    ]);
    const registeredIdentifiers = [
      ...mcpSource.matchAll(/\.command\((\w+Command)\)/g),
    ].map((match) => match[1]!);
    const bootstrapCommands = new Set(
      MCP_COMMANDS.map(([command]) => command.split(' ')[0]),
    );

    expect(registeredIdentifiers).toHaveLength(commandNameByIdentifier.size);
    for (const identifier of registeredIdentifiers) {
      const commandName = commandNameByIdentifier.get(identifier);
      expect(commandName, `missing mapping for ${identifier}`).toBeDefined();
      expect(bootstrapCommands).toContain(commandName);
    }
  });
});

describe('bootstrap error handling', () => {
  const savedEnv = {
    NO_COLOR: process.env['NO_COLOR'],
  };

  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    if (savedEnv.NO_COLOR === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = savedEnv.NO_COLOR;
    }
    vi.restoreAllMocks();
  });

  it('prints FatalError messages and exits with their code', async () => {
    process.env['NO_COLOR'] = '1';

    await expect(
      handleCriticalError(new FatalError('fatal boom', 42)),
    ).rejects.toThrow('process.exit:42');

    const output = stderr.join('');
    expect(output).toContain('fatal boom');
    expect(output).not.toContain('\x1b[31m');
  });

  it('prints FatalError messages in red when color is enabled', async () => {
    delete process.env['NO_COLOR'];

    await expect(
      handleCriticalError(new FatalError('fatal color', 42)),
    ).rejects.toThrow('process.exit:42');

    expect(stderr.join('')).toContain('\x1b[31mfatal color\x1b[0m');
  });

  it('exits AlreadyReportedError without printing another error', async () => {
    await expect(
      handleCriticalError(new AlreadyReportedError('already printed', 7)),
    ).rejects.toThrow('process.exit:7');

    expect(stderr.join('')).toBe('');
  });

  it('prints unexpected errors with the generic critical header', async () => {
    await expect(
      handleCriticalError(new Error('generic boom')),
    ).rejects.toThrow('process.exit:1');

    const output = stderr.join('');
    expect(output).toContain('An unexpected critical error occurred:');
    expect(output).toContain('generic boom');
  });

  it('recognizes expected PTY race errors', () => {
    expect(
      isExpectedPtyRaceError(
        Object.assign(new Error('read EIO'), { code: 'EIO' }),
      ),
    ).toBe(true);
    expect(isExpectedPtyRaceError(new Error('read EAGAIN'))).toBe(true);
    expect(
      isExpectedPtyRaceError(
        new Error('Cannot resize a pty that has already exited'),
      ),
    ).toBe(true);
    expect(isExpectedPtyRaceError(new Error('other failure'))).toBe(false);
  });

  it('wires uncaughtException PTY race suppression without exiting', async () => {
    let uncaughtHandler: ((error: Error) => void) | undefined;
    vi.spyOn(process, 'on').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'uncaughtException') {
        uncaughtHandler = listener as (error: Error) => void;
      }
      return process;
    }) as typeof process.on);

    await runCliEntryPoint(vi.fn(async () => {}));

    expect(uncaughtHandler).toBeDefined();
    uncaughtHandler?.(Object.assign(new Error('read EIO'), { code: 'EIO' }));
    expect(process.exit).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe('');
  });

  it('routes run failures through the critical error handler', async () => {
    const error = new Error('run failed');
    const run = vi.fn(async () => {
      throw error;
    });
    const handleError = vi.fn(async () => {});

    await runCliEntryPoint(run, handleError);

    expect(handleError).toHaveBeenCalledWith(error);
  });

  it('reports when the critical error handler itself fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('run failed');
    });
    const handleError = vi.fn(async () => {
      throw new Error('handler failed');
    });

    await expect(runCliEntryPoint(run, handleError)).rejects.toThrow(
      'process.exit:1',
    );

    const output = stderr.join('');
    expect(output).toContain('Original error:');
    expect(output).toContain('run failed');
    expect(output).toContain('Error handler failed:');
    expect(output).toContain('handler failed');
  });
});
