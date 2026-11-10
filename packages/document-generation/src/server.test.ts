/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let fixture: string;

beforeEach(async () => {
  await mkdir(path.resolve('../../.qwen'), { recursive: true });
  fixture = await mkdtemp(path.resolve('../../.qwen/docx-runtime-'));
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe('packaged document server', () => {
  it('starts from the packed extension without reading repository dependencies', async () => {
    const packed = JSON.parse(
      execFileSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['pack', '--pack-destination', fixture, '--json'],
        { encoding: 'utf8', shell: process.platform === 'win32' },
      ),
    );
    const files = packed[0].files.map((file: { path: string }) => file.path);
    expect(files).toEqual(
      expect.arrayContaining([
        'dist/server.js',
        'dist/server.js.LEGAL.txt',
        'dist/NOTICES.txt',
        'qwen-extension.json',
        'skills/generate-document/SKILL.md',
      ]),
    );
    expect(
      files.some(
        (file: string) =>
          file.includes('node_modules') || file.endsWith('.test.ts'),
      ),
    ).toBe(false);
    execFileSync('tar', [
      '-xzf',
      path.join(fixture, packed[0].filename),
      '-C',
      fixture,
    ]);
    const workspace = path.join(fixture, 'workspace');
    await mkdir(workspace);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        process.allowedNodeEnvironmentFlags.has('--permission')
          ? '--permission'
          : '--experimental-permission',
        `--allow-fs-read=${fixture}`,
        `--allow-fs-write=${workspace}`,
        path.join(fixture, 'package', 'dist', 'server.js'),
        '--workspace',
        workspace,
      ],
      cwd: fixture,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'packed-docx-test', version: '1.0.0' });
    let diagnostics = '';
    transport.stderr?.on('data', (chunk) => {
      diagnostics += chunk.toString();
    });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe('document-generation');
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['generate_docx']);
      const result = await client.callTool({
        name: 'generate_docx',
        arguments: {
          outputPath: 'packed.docx',
          title: 'Packed',
          paragraphs: ['Self-contained runtime'],
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        resolvedPath: path.join(workspace, 'packed.docx'),
      });
      expect(
        (await readFile(path.join(workspace, 'packed.docx'))).length,
      ).toBeGreaterThan(0);
    } catch (error) {
      throw new Error(`Packed server failed: ${diagnostics}`, { cause: error });
    } finally {
      await client.close();
    }
  }, 15_000);

  it.each([{ args: [] }, { args: ['--workspace', 'relative'] }])(
    'fails startup with invalid workspace arguments $args',
    ({ args }) => {
      const result = spawnSync(
        process.execPath,
        [path.resolve('dist/server.js'), ...args],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/workspace|Usage/);
    },
  );
});
