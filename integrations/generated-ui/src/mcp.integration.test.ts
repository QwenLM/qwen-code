/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_URI,
  MAX_RESULT_BYTES,
  MAX_RESULT_CHARS,
  META_KEY,
  parseToolResult,
  type ShowInput,
} from './contracts.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const bundle = join(packageRoot, 'dist/main.js');
const directories: string[] = [];
const clients: Client[] = [];
const input: ShowInput = {
  title: 'Capacity estimate',
  summary: 'An illustrative local calculation; adjust inputs to compare.',
  html: '<label>Workers <input id="workers" type="number" value="4"></label><output id="capacity"></output>',
  css: 'label { display: block; }',
  javascript:
    'function update(){ui.text("capacity", String(Number(ui.input("workers").value)*25));} ui.on("workers","input",update); update();',
};

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-generated-ui-'));
  directories.push(directory);
  return directory;
}

async function connect(cwd: string, path = bundle): Promise<Client> {
  const client = new Client({ name: 'generated-ui-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path],
      cwd,
      env: {},
      stderr: 'pipe',
    }),
  );
  return client;
}

async function show(client: Client, args: unknown): Promise<CallToolResult> {
  const result = (await client.callTool({
    name: 'generated_ui_show',
    arguments: args as Record<string, unknown>,
  })) as CallToolResult;
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    MAX_RESULT_BYTES,
  );
  return result;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('built generated UI MCP artifact', () => {
  it('advertises one model-only show tool and the fixed local App resource', async () => {
    const client = await connect(await temporary());
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'generated_ui_show',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120 },
          summary: { type: 'string', minLength: 1, maxLength: 2000 },
          html: { type: 'string', minLength: 1, maxLength: 12_000 },
          css: { type: 'string', maxLength: 6000 },
          javascript: { type: 'string', maxLength: 12_000 },
        },
        required: ['title', 'summary', 'html', 'css', 'javascript'],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: APP_URI, visibility: ['model'] } },
    });
    const { resources } = await client.listResources();
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      uri: APP_URI,
      mimeType: 'text/html;profile=mcp-app',
    });
    const resource = (await client.readResource({ uri: APP_URI })).contents[0];
    expect(resource).toMatchObject({
      uri: APP_URI,
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
        },
      },
    });
    if (!('text' in resource)) throw new Error('Expected an HTML resource.');
    expect(typeof resource.text).toBe('string');
    expect(Buffer.byteLength(resource.text)).toBeLessThanOrEqual(1024 * 1024);
  });

  it('keeps concurrent cards independent without mutating the resource or workspace', async () => {
    const root = await temporary();
    const client = await connect(root);
    const before = await client.readResource({ uri: APP_URI });
    const secondInput = {
      ...input,
      title: 'Second independent card',
      html: '<p>SECOND_DOCUMENT_MARKER</p>',
      javascript: 'throw new Error("Never executed by the MCP server");',
    };
    const [first, second] = await Promise.all([
      show(client, input),
      show(client, secondInput),
    ]);
    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(parseToolResult(first)).toMatchObject(input);
    expect(parseToolResult(second)).toMatchObject(secondInput);
    expect(parseToolResult(first).documentId).not.toBe(
      parseToolResult(second).documentId,
    );
    expect(await client.readResource({ uri: APP_URI })).toEqual(before);
    expect(await show(client, input)).toEqual(first);
    expect(JSON.stringify(before)).not.toContain('SECOND_DOCUMENT_MARKER');
    expect(await readdir(root)).toEqual([]);
    const resource = before.contents[0];
    if (!('text' in resource)) throw new Error('Expected an HTML resource.');
    const display = {
      type: 'mcp_app',
      html: resource.text,
      toolResult: first,
      toolArguments: input,
      fallbackText: `${input.title}\n${input.summary}`,
    };
    expect(Buffer.byteLength(JSON.stringify(display))).toBeLessThan(
      2 * 1024 * 1024,
    );
    await client.close();
    const restarted = await connect(root);
    expect(await show(restarted, input)).toEqual(first);
  });

  it('keeps generated source out of the public summary and round-trips Unicode', async () => {
    const client = await connect(await temporary());
    const candidate = {
      ...input,
      title: '容量模拟 😀',
      summary: '修改输入参数，查看本地估计。',
      html: '<p>PRIVATE_HTML_MARKER 中文 😀</p>',
      javascript: 'const PRIVATE_JAVASCRIPT_MARKER = "中文 😀";',
    };
    const result = await show(client, candidate);
    expect(parseToolResult(result)).toMatchObject(candidate);
    const publicOutput = JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
    });
    expect(publicOutput).toContain(candidate.summary);
    expect(publicOutput).not.toContain('PRIVATE_HTML_MARKER');
    expect(publicOutput).not.toContain('PRIVATE_JAVASCRIPT_MARKER');
    expect(result._meta).toHaveProperty(META_KEY);
  });

  it('rejects invalid or oversized candidates with short errors and no partial snapshot', async () => {
    const client = await connect(await temporary());
    const candidates = [
      {},
      { ...input, title: '' },
      { ...input, html: 42 },
      { ...input, css: 'x'.repeat(6001) },
      { ...input, javascript: 'x'.repeat(12_001) },
      { ...input, html: '界'.repeat(8000) },
      { ...input, html: '\u0001'.repeat(8000) },
      { ...input, html: 'h'.repeat(12_000), javascript: 'j'.repeat(12_000) },
      { ...input, ['UNTRUSTED_' + 'x'.repeat(40_000)]: true },
      {
        title: [],
        summary: [],
        html: [],
        css: [],
        javascript: [],
        ['UNTRUSTED_' + 'x'.repeat(40_000)]: true,
      },
    ];
    for (const candidate of candidates) {
      const result = await show(client, candidate);
      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result).length).toBeLessThan(512);
      expect(JSON.stringify(result)).toMatch(
        /INVALID_DOCUMENT|Input validation error/,
      );
      expect(JSON.stringify(result)).not.toContain('UNTRUSTED_');
    }
    expect(parseToolResult(await show(client, input))).toMatchObject(input);
  });

  it('runs the packed extension outside the source tree without node_modules', async () => {
    const output = await temporary();
    const packageManagerCli = process.env['npm_execpath'];
    const npmCli =
      packageManagerCli && basename(packageManagerCli) === 'npm-cli.js'
        ? packageManagerCli
        : process.platform === 'win32'
          ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
          : undefined;
    const packed = JSON.parse(
      execFileSync(
        npmCli ? process.execPath : 'npm',
        [
          ...(npmCli ? [npmCli] : []),
          'pack',
          '--ignore-scripts',
          '--pack-destination',
          output,
          '--json',
        ],
        { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 },
      ),
    ) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const files = packed[0].files.map((file) => file.path);
    expect(files).toEqual(
      expect.arrayContaining([
        'dist/main.js',
        'dist/app.html',
        'qwen-extension.json',
        'skills/generated-ui/SKILL.md',
        'README.md',
      ]),
    );
    expect(
      files.some(
        (file) => file.startsWith('src/') || file.startsWith('node_modules/'),
      ),
    ).toBe(false);
    execFileSync(
      'tar',
      ['-xzf', join(output, packed[0].filename), '-C', output],
      { timeout: 10_000 },
    );
    const root = await temporary();
    const client = await connect(root, join(output, 'package/dist/main.js'));
    expect(parseToolResult(await show(client, input))).toMatchObject(input);
    expect(
      (await client.readResource({ uri: APP_URI })).contents[0],
    ).toHaveProperty('text');
    const manifest = JSON.parse(
      await readFile(join(output, 'package/qwen-extension.json'), 'utf8'),
    );
    expect(manifest.mcpServers['generated-ui'].includeTools).toEqual([
      'generated_ui_show',
    ]);
    expect(await readdir(root)).toEqual([]);
  }, 45_000);
});
