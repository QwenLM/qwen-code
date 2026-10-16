/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createNodeReplMcpServer,
  NODE_REPL_INSTRUCTIONS,
  resolveContextFromEnv,
} from './mcp-server.js';

async function connected(moduleRoots: string[] = []) {
  const tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-js-mcp-'));
  const { server, dispose } = createNodeReplMcpServer({
    cwd: tmpRootDir,
    homeDir: os.homedir(),
    tmpRootDir,
    readableRoots: [tmpRootDir],
    moduleRoots,
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

describe('JavaScript MCP server', () => {
  it('exposes only js and js_reset with compact entry instructions', async () => {
    const { client, close } = await connected();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(['js', 'js_reset']);
      const js = tools.find((tool) => tool.name === 'js')!;
      expect(Object.keys(js.inputSchema.properties ?? {}).sort()).toEqual([
        'code',
        'timeout_ms',
        'title',
      ]);
      expect(js.inputSchema.required).toEqual(['code']);
      expect(
        (js.inputSchema.properties?.['timeout_ms'] as { default?: number })
          ?.default,
      ).toBe(30000);
      expect(js.description).toContain('global cua');
      expect(js.annotations).toMatchObject({
        destructiveHint: true,
        openWorldHint: true,
      });
      expect(client.getInstructions()).toBe(NODE_REPL_INSTRUCTIONS);
      expect(client.getServerVersion()?.version).toBe(
        JSON.parse(
          fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        ).version,
      );
    } finally {
      await close();
    }
  });

  it('preloads cua from an unrelated cwd, emits documentation once, and repeats after reset', async () => {
    const { client, close } = await connected();
    try {
      const first = await client.callTool({
        name: 'js',
        arguments: {
          code: 'var count = 41; nodeRepl.write(typeof cua.getApp);',
        },
      });
      expect(first.isError).not.toBe(true);
      expect(textOf(first)).toContain('Computer Use JavaScript runtime');
      expect(textOf(first)).toContain('function');
      const next = await client.callTool({
        name: 'js',
        arguments: { code: 'nodeRepl.write(++count);' },
      });
      expect(textOf(next)).toContain('42');
      expect(textOf(next)).not.toContain('Computer Use JavaScript runtime');
      const rewritten = await client.callTool({
        name: 'js',
        arguments: { code: 'cua.rewriteDocumentation();' },
      });
      expect(textOf(rewritten)).toContain('Computer Use JavaScript runtime');
      await client.callTool({ name: 'js_reset', arguments: {} });
      const reset = await client.callTool({
        name: 'js',
        arguments: { code: 'nodeRepl.write(typeof count);' },
      });
      expect(textOf(reset)).toContain('Computer Use JavaScript runtime');
      expect(textOf(reset)).toContain('undefined');
    } finally {
      await close();
    }
  });

  it('returns a terminal result in one call and recovers from timeout without replay', async () => {
    const { client, close } = await connected();
    try {
      await client.callTool({
        name: 'js',
        arguments: { code: 'var count = 0;' },
      });
      const timeout = await client.callTool({
        name: 'js',
        arguments: {
          code: 'await new Promise(() => {}); count++;',
          timeout_ms: 100,
        },
      });
      expect(timeout.isError).toBe(true);
      expect(textOf(timeout)).toContain('timeout');
      const next = await client.callTool({
        name: 'js',
        arguments: {
          code: 'await new Promise(r => setTimeout(r, 50)); nodeRepl.write(count);',
        },
      });
      expect(next.isError).not.toBe(true);
      expect(textOf(next)).toContain('0');
      expect(textOf(next)).not.toContain('still running');
    } finally {
      await close();
    }
  });

  it('replaces a stuck kernel and allows a new call', async () => {
    const { client, close } = await connected();
    try {
      const result = await client.callTool({
        name: 'js',
        arguments: {
          code: 'await nodeRepl.signal.waitUntil(new Promise(() => {}));',
          timeout_ms: 100,
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('timeout');
      const next = await client.callTool({
        name: 'js',
        arguments: { code: 'nodeRepl.write("fresh");' },
      });
      expect(next.isError).not.toBe(true);
      expect(textOf(next)).toContain('fresh');
      expect(textOf(next)).toContain('Computer Use JavaScript runtime');
    } finally {
      await close();
    }
  }, 15000);

  it('does not run user code after a timeout during first-call preloading', async () => {
    const { client, close } = await connected();
    try {
      const result = await client.callTool({
        name: 'js',
        arguments: {
          code: 'globalThis.preloadEffect = true;',
          timeout_ms: 1,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const next = await client.callTool({
        name: 'js',
        arguments: {
          code: 'nodeRepl.write(typeof globalThis.preloadEffect);',
        },
      });
      expect(next.isError).not.toBe(true);
      expect(textOf(next)).toContain(result.isError ? 'undefined' : 'boolean');
    } finally {
      await close();
    }
  });

  it('retains host-configured module roots across reset', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-js-module-'));
    const root = path.join(dir, 'node_modules');
    const pkg = path.join(root, 'host-fixture');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: 'host-fixture',
        type: 'module',
        exports: './index.js',
      }),
    );
    fs.writeFileSync(path.join(pkg, 'index.js'), 'export const value = 73;');
    const { client, close } = await connected([root]);
    try {
      for (let i = 0; i < 2; i++) {
        const result = await client.callTool({
          name: 'js',
          arguments: {
            code: 'nodeRepl.write((await import("host-fixture")).value);',
          },
        });
        expect(result.isError).not.toBe(true);
        expect(textOf(result)).toContain('73');
        await client.callTool({ name: 'js_reset', arguments: {} });
      }
    } finally {
      await close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports runtime errors and rejects invalid timeouts', async () => {
    const { client, close } = await connected();
    try {
      const error = await client.callTool({
        name: 'js',
        arguments: { code: 'throw new Error("fixture failure");' },
      });
      expect(error.isError).toBe(true);
      expect(textOf(error)).toContain('fixture failure');
      const invalid = await client.callTool({
        name: 'js',
        arguments: { code: 'nodeRepl.write(1)', timeout_ms: 600001 },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await close();
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
