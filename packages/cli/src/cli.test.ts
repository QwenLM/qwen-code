/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv } from 'yargs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  TOP_LEVEL_COMMANDS,
  resolveBootstrapRoute,
  runCliEntry,
} from './cli.js';

const mocks = vi.hoisted(() => ({
  main: vi.fn(),
  tryRunServeFastPath: vi.fn(),
  initStartupProfiler: vi.fn(),
  initCpuProfiler: vi.fn(),
  mcpHandler: vi.fn(),
  mcpBuilder: vi.fn(),
  mcpListHandler: vi.fn(),
  mcpAddHandler: vi.fn(),
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

vi.mock('./utils/cpuProfiler.js', () => ({
  initCpuProfiler: mocks.initCpuProfiler,
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

  it('does not treat flags after -- as bootstrap flags', () => {
    expect(resolveBootstrapRoute(['--', '--version'])).toBe('default');
    expect(resolveBootstrapRoute(['mcp', '--', '--version'])).toBe('mcp');
  });
});

describe('runCliEntry', () => {
  const savedEnv = {
    CLI_VERSION: process.env['CLI_VERSION'],
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

  it('uses the full CLI when global flags precede MCP commands', async () => {
    await runCliEntry(['--safe-mode', 'mcp', 'list']);

    expect(mocks.main).toHaveBeenCalledTimes(1);
    expect(mocks.mcpListHandler).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).toHaveBeenCalledTimes(1);
    expect(mocks.initCpuProfiler).toHaveBeenCalledTimes(1);
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
    expect(mocks.initStartupProfiler).toHaveBeenCalledTimes(1);
    expect(mocks.initCpuProfiler).toHaveBeenCalledTimes(1);
  });

  it('initializes profilers once when the serve fast path falls back', async () => {
    mocks.tryRunServeFastPath.mockResolvedValue(false);

    await runCliEntry(['serve']);

    expect(mocks.tryRunServeFastPath).toHaveBeenCalledWith(['serve']);
    expect(mocks.initStartupProfiler).toHaveBeenCalledTimes(1);
    expect(mocks.initCpuProfiler).toHaveBeenCalledTimes(1);
    expect(mocks.main).toHaveBeenCalledTimes(1);
  });

  it('initializes profilers and loads gemini on the default path', async () => {
    await runCliEntry([]);

    expect(mocks.initStartupProfiler).toHaveBeenCalledTimes(1);
    expect(mocks.initCpuProfiler).toHaveBeenCalledTimes(1);
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
});
