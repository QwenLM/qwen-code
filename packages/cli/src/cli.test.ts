/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv } from 'yargs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveBootstrapRoute, runCliEntry } from './cli.js';

const mocks = vi.hoisted(() => ({
  main: vi.fn(),
  tryRunServeFastPath: vi.fn(),
  initStartupProfiler: vi.fn(),
  initCpuProfiler: vi.fn(),
  mcpHandler: vi.fn(),
  mcpBuilder: vi.fn(),
  mcpListHandler: vi.fn(),
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

  beforeEach(() => {
    stdout = [];
    vi.clearAllMocks();
    mocks.tryRunServeFastPath.mockResolvedValue(false);
    process.env['CLI_VERSION'] = '9.9.9';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
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
    expect(helpText).toContain('Manage MCP servers');
    expect(helpText).toContain('Run Qwen Code as a local HTTP daemon');
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

  it('keeps the serve fast path ahead of the full CLI startup', async () => {
    mocks.tryRunServeFastPath.mockResolvedValue(true);

    await runCliEntry(['serve']);

    expect(mocks.tryRunServeFastPath).toHaveBeenCalledWith(['serve']);
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
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
    expect(source).toContain("process.argv[2] === 'serve'");
    expect(source).toContain("process.argv[2] === 'mcp'");
    expect(source).toContain("hasFlag('--help', '-h')");
    expect(source).toContain("hasFlag('--version', '-v')");
  });
});
