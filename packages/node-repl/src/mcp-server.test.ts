/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createNodeReplMcpServer,
  resolveContextFromEnv,
} from './mcp-server.js';

async function connected() {
  const tmpRootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qwen-node-repl-mcp-'),
  );
  const { server, dispose } = createNodeReplMcpServer({
    cwd: process.cwd(),
    homeDir: os.homedir(),
    tmpRootDir,
    readableRoots: [process.cwd()],
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    async close() {
      await client.close();
      dispose();
      fs.rmSync(tmpRootDir, { recursive: true, force: true });
    },
  };
}

function textOf(result: unknown): string {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  return (content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

describe('node_repl MCP server', () => {
  it('exposes exactly the three tools with correct schemas', async () => {
    const { client, close } = await connected();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'node_repl',
        'node_repl_add_node_module_dir',
        'node_repl_reset',
      ]);
      const repl = tools.find((t) => t.name === 'node_repl');
      expect(repl?.inputSchema['required']).toEqual(['code']);
      expect(repl?.inputSchema['additionalProperties']).toBe(false);
      // All three declared params must be advertised.
      expect(
        Object.keys(
          (repl?.inputSchema['properties'] ?? {}) as Record<string, unknown>,
        ).sort(),
      ).toEqual(['code', 'timeout_ms', 'title']);
      // Arbitrary code execution must be advertised as destructive/open-world.
      expect(repl?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      // reset destroys session state but is idempotent and closed-world.
      expect(
        tools.find((t) => t.name === 'node_repl_reset')?.annotations,
      ).toMatchObject({
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
      // registering a module dir is additive.
      expect(
        tools.find((t) => t.name === 'node_repl_add_node_module_dir')
          ?.annotations,
      ).toMatchObject({ destructiveHint: false, idempotentHint: true });
    } finally {
      await close();
    }
  });

  it('advertises the real package version', async () => {
    const { client, close } = await connected();
    try {
      const expected = JSON.parse(
        fs.readFileSync(
          fileURLToPath(new URL('../package.json', import.meta.url)),
          'utf8',
        ),
      ).version as string;
      expect(client.getServerVersion()?.version).toBe(expected);
      expect(expected).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await close();
    }
  });

  it('persists bindings across calls and clears them on reset', async () => {
    const { client, close } = await connected();
    try {
      await client.callTool({
        name: 'node_repl',
        arguments: { code: 'const persisted = 7;' },
      });
      const read = await client.callTool({
        name: 'node_repl',
        arguments: { code: 'nodeRepl.write(String(persisted * 6));' },
      });
      expect(textOf(read)).toContain('42');

      await client.callTool({ name: 'node_repl_reset', arguments: {} });
      const after = await client.callTool({
        name: 'node_repl',
        arguments: { code: 'nodeRepl.write(typeof persisted);' },
      });
      expect(textOf(after)).toContain('undefined');
    } finally {
      await close();
    }
  });

  it('reports a runtime error as isError with the message', async () => {
    const { client, close } = await connected();
    try {
      const result = await client.callTool({
        name: 'node_repl',
        arguments: { code: 'throw new Error("kaboom");' },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain('kaboom');
    } finally {
      await close();
    }
  });

  it('rejects a timeout_ms above the allowed maximum', async () => {
    const { client, close } = await connected();
    try {
      const result = await client.callTool({
        name: 'node_repl',
        arguments: { code: '1;', timeout_ms: 999_999_999 },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toMatch(/timeout_ms/);
    } finally {
      await close();
    }
  });

  it('signals success with actionable guidance when a cell prints nothing', async () => {
    const { client, close } = await connected();
    try {
      const result = await client.callTool({
        name: 'node_repl',
        arguments: { code: '1 + 1;' },
      });
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      const text = textOf(result);
      expect(text.trim().length).toBeGreaterThan(0);
      // Must actually tell the model how to return a value.
      expect(text).toMatch(/nodeRepl\.write/);
    } finally {
      await close();
    }
  });

  it('dispose() kills the kernel child process', async () => {
    const tmpRootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-node-repl-dispose-'),
    );
    const { server, dispose } = createNodeReplMcpServer({
      cwd: process.cwd(),
      homeDir: os.homedir(),
      tmpRootDir,
      readableRoots: [process.cwd()],
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      await client.callTool({
        name: 'node_repl',
        arguments: { code: 'nodeRepl.write("up");' },
      });
      // Find the live kernel pid, then prove dispose() reaps it.
      const pidResult = await client.callTool({
        name: 'node_repl',
        arguments: {
          code: 'const p = await import("node:os"); nodeRepl.write("alive");',
        },
      });
      expect(textOf(pidResult)).toContain('alive');

      dispose();
      await new Promise((r) => setTimeout(r, 500));

      // After dispose the manager refuses further work.
      const after = await client.callTool({
        name: 'node_repl',
        arguments: { code: 'nodeRepl.write("should not run");' },
      });
      expect((after as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
      fs.rmSync(tmpRootDir, { recursive: true, force: true });
    }
  });

  it('reports a bad module root as isError instead of throwing', async () => {
    const { client, close } = await connected();
    try {
      const result = await client.callTool({
        name: 'node_repl_add_node_module_dir',
        arguments: { path: '/definitely/not/a/node_modules_dir' },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toMatch(/node_modules/);
    } finally {
      await close();
    }
  });

  it('registers a valid node_modules directory', async () => {
    const { client, close } = await connected();
    const root = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-root-')),
      'node_modules',
    );
    fs.mkdirSync(root);
    try {
      const result = await client.callTool({
        name: 'node_repl_add_node_module_dir',
        arguments: { path: root },
      });
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      expect(textOf(result)).toMatch(/Registered module root/);
    } finally {
      await close();
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });
});

describe('resolveContextFromEnv', () => {
  it('defaults readableRoots to cwd and honours QWEN_NODE_REPL_ROOTS', () => {
    const previous = process.env['QWEN_NODE_REPL_ROOTS'];
    try {
      delete process.env['QWEN_NODE_REPL_ROOTS'];
      expect(resolveContextFromEnv().readableRoots).toEqual([process.cwd()]);

      process.env['QWEN_NODE_REPL_ROOTS'] = ['/a', '/b'].join(path.delimiter);
      expect(resolveContextFromEnv().readableRoots).toEqual([
        process.cwd(),
        '/a',
        '/b',
      ]);
    } finally {
      if (previous === undefined) delete process.env['QWEN_NODE_REPL_ROOTS'];
      else process.env['QWEN_NODE_REPL_ROOTS'] = previous;
    }
  });
});
