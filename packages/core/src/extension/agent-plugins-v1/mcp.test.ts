/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_PLUGIN_MCP_SCHEMA,
  loadAgentPluginMcpServers,
  validateAgentPluginStdioRuntimePaths,
} from './mcp.js';

describe('Agent Plugins v1 MCP', () => {
  let pluginRoot: string;
  let pluginDataRoot: string;

  beforeEach(() => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-'));
    pluginDataRoot = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-data-parent-')),
      'data',
    );
    fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'work'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'bin', 'server'), 'server');
  });

  afterEach(() => {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(pluginDataRoot), { recursive: true, force: true });
  });

  it('maps valid stdio and Streamable HTTP entries independently', async () => {
    const resolvedPluginRoot = fs.realpathSync.native(pluginRoot);
    const resolvedDataRoot = path.join(
      fs.realpathSync.native(path.dirname(pluginDataRoot)),
      path.basename(pluginDataRoot),
    );
    writeMcp({
      local: {
        type: 'stdio',
        command: './bin/server',
        args: ['${PLUGIN_ROOT}/input', '${PLUGIN_DATA}/state'],
        env: { CACHE: '${PLUGIN_DATA}/cache' },
        cwd: '${PLUGIN_ROOT}/work',
      },
      remote: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {
          'X-Plugin': 'portable',
          Authorization: 'removed',
          'Content-Type': 'removed',
        },
      },
      unsupported: { type: 'sse', url: 'https://example.com/sse' },
      invalid: { type: 'stdio', command: '../escape' },
    });

    const servers = await loadAgentPluginMcpServers(
      pluginRoot,
      pluginDataRoot,
      { createDataDir: true },
    );

    expect(Object.keys(servers)).toEqual(['local', 'remote']);
    expect(servers['local']).toMatchObject({
      command: path.join(resolvedPluginRoot, 'bin', 'server'),
      args: [`${resolvedPluginRoot}/input`, `${resolvedDataRoot}/state`],
      cwd: path.join(resolvedPluginRoot, 'work'),
      agentPluginV1: true,
    });
    expect(servers['local']?.env).toMatchObject({
      PLUGIN_ROOT: resolvedPluginRoot,
      PLUGIN_DATA: resolvedDataRoot,
      CACHE: `${resolvedDataRoot}/cache`,
    });
    expect(servers['remote']).toEqual({
      httpUrl: 'https://example.com/mcp',
      headers: { 'X-Plugin': 'portable' },
      agentPluginV1: true,
    });
    expect(fs.statSync(pluginDataRoot).isDirectory()).toBe(true);
  });

  it('creates stdio cwd directories inside PLUGIN_DATA', async () => {
    writeMcp({
      local: {
        type: 'stdio',
        command: './bin/server',
        cwd: '${PLUGIN_DATA}/work',
      },
    });

    const server = (
      await loadAgentPluginMcpServers(pluginRoot, pluginDataRoot, {
        createDataDir: true,
      })
    )['local'];

    expect(server).toBeDefined();
    expect(fs.statSync(server!.cwd!).isDirectory()).toBe(true);
    expect(() => validateAgentPluginStdioRuntimePaths(server!)).not.toThrow();
  });

  it('disables all MCP on a top-level error', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'mcp.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {},
        unknown: true,
      }),
    );
    expect(await loadAgentPluginMcpServers(pluginRoot, pluginDataRoot)).toEqual(
      {},
    );
  });

  it('rejects unsafe HTTP endpoints and reserved environment variables', async () => {
    writeMcp({
      insecure: { type: 'streamable-http', url: 'http://example.com/mcp' },
      reserved: {
        type: 'stdio',
        command: 'node',
        env: { PLUGIN_ROOT: 'override' },
      },
      loopback: {
        type: 'streamable-http',
        url: 'http://127.0.0.1:3000/mcp',
      },
    });
    expect(await loadAgentPluginMcpServers(pluginRoot, pluginDataRoot)).toEqual(
      {
        loopback: {
          httpUrl: 'http://127.0.0.1:3000/mcp',
          agentPluginV1: true,
        },
      },
    );
  });

  it('expands variables once and isolates escaping package paths', async () => {
    const resolvedPluginRoot = fs.realpathSync.native(pluginRoot);
    const literalDataRoot = path.join(
      path.dirname(pluginDataRoot),
      '${PLUGIN_ROOT}',
    );
    const resolvedLiteralDataRoot = path.join(
      fs.realpathSync.native(path.dirname(literalDataRoot)),
      path.basename(literalDataRoot),
    );
    writeMcp({
      singlePass: {
        type: 'stdio',
        command: 'node',
        args: ['${PLUGIN_DATA}'],
        env: { LITERAL: '${PLUGIN_ROOT}/${UNKNOWN}' },
        cwd: '${PLUGIN_DATA}/work',
      },
      badCommand: { type: 'stdio', command: './../escape' },
      driveRelativeCommand: { type: 'stdio', command: 'C:escape' },
      badCwd: { type: 'stdio', command: 'node', cwd: './../escape' },
    });

    const servers = await loadAgentPluginMcpServers(
      pluginRoot,
      literalDataRoot,
    );

    expect(Object.keys(servers)).toEqual(['singlePass']);
    expect(servers['singlePass']?.args).toEqual([resolvedLiteralDataRoot]);
    expect(servers['singlePass']?.args?.[0]).toContain('${PLUGIN_ROOT}');
    expect(servers['singlePass']?.env?.['LITERAL']).toBe(
      `${resolvedPluginRoot}/${'${UNKNOWN}'}`,
    );
    expect(servers['singlePass']?.cwd).toBe(
      path.join(resolvedLiteralDataRoot, 'work'),
    );
  });

  it('keeps HTTP servers when the stdio data directory cannot be created', async () => {
    const fileParent = path.join(path.dirname(pluginDataRoot), 'file');
    fs.writeFileSync(fileParent, 'not a directory');
    writeMcp({
      local: { type: 'stdio', command: 'node' },
      remote: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
      },
    });

    expect(
      await loadAgentPluginMcpServers(
        pluginRoot,
        path.join(fileParent, 'data'),
        { createDataDir: true },
      ),
    ).toEqual({
      remote: {
        httpUrl: 'https://example.com/mcp',
        agentPluginV1: true,
      },
    });
  });

  it('validates remote URL and headers per entry', async () => {
    writeMcp({
      credentials: {
        type: 'streamable-http',
        url: 'https://user@example.com/mcp',
      },
      fragment: {
        type: 'streamable-http',
        url: 'https://example.com/mcp#fragment',
      },
      duplicateHeader: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { 'X-Test': 'one', 'x-test': 'two' },
      },
      invalidHeader: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { 'X-Test': 'bad\nvalue' },
      },
      ipv6Loopback: {
        type: 'streamable-http',
        url: 'http://[::1]:3000/mcp',
      },
    });

    expect(await loadAgentPluginMcpServers(pluginRoot, pluginDataRoot)).toEqual(
      {
        ipv6Loopback: {
          httpUrl: 'http://[::1]:3000/mcp',
          agentPluginV1: true,
        },
      },
    );
  });

  it('retains valid prototype-named servers and headers as own fields', async () => {
    const headers: Record<string, unknown> = {};
    Object.defineProperty(headers, '__proto__', {
      value: 'literal',
      enumerable: true,
    });
    const entries: Record<string, unknown> = {};
    Object.defineProperty(entries, '__proto__', {
      value: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers,
      },
      enumerable: true,
    });
    writeMcp(entries);

    const servers = await loadAgentPluginMcpServers(pluginRoot, pluginDataRoot);

    expect(Object.hasOwn(servers, '__proto__')).toBe(true);
    expect(
      Object.hasOwn(servers['__proto__']?.headers ?? {}, '__proto__'),
    ).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'loads an mcp.json symlink contained in the plugin',
    async () => {
      const inside = path.join(pluginRoot, 'inside-mcp.json');
      fs.writeFileSync(
        inside,
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {
            local: { type: 'stdio', command: 'node' },
          },
        }),
      );
      fs.symlinkSync(inside, path.join(pluginRoot, 'mcp.json'));

      expect(
        await loadAgentPluginMcpServers(pluginRoot, pluginDataRoot),
      ).toMatchObject({
        local: { command: 'node', agentPluginV1: true },
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'disables MCP when mcp.json is a symlink escape',
    async () => {
      const outside = `${pluginRoot}-outside-mcp.json`;
      fs.writeFileSync(
        outside,
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {},
        }),
      );
      fs.symlinkSync(outside, path.join(pluginRoot, 'mcp.json'));
      expect(
        await loadAgentPluginMcpServers(pluginRoot, pluginDataRoot),
      ).toEqual({});
      fs.rmSync(outside, { force: true });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'revalidates linked stdio paths immediately before launch',
    async () => {
      writeMcp({
        local: {
          type: 'stdio',
          command: './bin/server',
          cwd: '${PLUGIN_ROOT}/work',
        },
      });
      const server = (
        await loadAgentPluginMcpServers(pluginRoot, pluginDataRoot, {
          createDataDir: true,
        })
      )['local'];
      expect(server).toBeDefined();
      expect(() => validateAgentPluginStdioRuntimePaths(server!)).not.toThrow();

      const outside = `${pluginRoot}-outside-server`;
      fs.writeFileSync(outside, 'outside');
      fs.rmSync(path.join(pluginRoot, 'bin', 'server'));
      fs.symlinkSync(outside, path.join(pluginRoot, 'bin', 'server'));

      expect(() => validateAgentPluginStdioRuntimePaths(server!)).toThrow(
        'outside plugin root',
      );
      fs.rmSync(outside, { force: true });
    },
  );

  function writeMcp(mcpServers: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(pluginRoot, 'mcp.json'),
      JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers }),
    );
  }
});
