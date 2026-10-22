/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ASSERTIONS, MAX_FILES, MAX_RESULT_CHARS } from './contracts.js';
import { APP_URI, showSchema } from './app-contract.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const bundle = join(packageRoot, 'dist/main.js');
const directories: string[] = [];
const clients: Client[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-explorer-mcp-'));
  directories.push(directory);
  return directory;
}
async function connect(root: string, path = bundle): Promise<Client> {
  const client = new Client({ name: 'explorer-acceptance', version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path],
      cwd: root,
      env: { QWEN_TEST_EXPLORER_WORKSPACE_ROOT: root },
      stderr: 'pipe',
    }),
  );
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = await client.callTool({ name, arguments: args });
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  return result as CallToolResult;
}
async function copyReport(root: string): Promise<void> {
  await writeFile(
    join(root, 'report.json'),
    await readFile(new URL('../test-fixtures/mixed.json', import.meta.url)),
  );
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('actual stdio MCP artifact', () => {
  it('generates bounded views, safely falls back inside the handler, and replays the same immutable result', async () => {
    const root = await temporary();
    await copyReport(root);
    const client = await connect(root);
    const imported = await call(client, 'test_report_import', {
      relativePath: 'report.json',
    });
    const reportId = imported.structuredContent!['reportId'];
    const failed = await call(client, 'test_report_query', {
      reportId,
      query: { kind: 'list', collection: 'failures' },
    });
    const failureId = (
      failed.structuredContent!['items'] as Array<{ itemId: string }>
    )[0].itemId;
    const passed = await call(client, 'test_report_query', {
      reportId,
      query: { kind: 'list', collection: 'assertions', status: 'passed' },
    });
    const passedId = (
      passed.structuredContent!['items'] as Array<{ itemId: string }>
    )[0].itemId;
    const view = {
      schemaVersion: 1,
      reportId,
      sections: [
        {
          kind: 'hypothesis-groups',
          groups: [
            {
              label: 'Assertion evidence',
              hypothesis:
                'Inspect the recorded mismatch before inferring a cause.',
              failureIds: [failureId],
            },
          ],
        },
        { kind: 'evidence', initialFailureId: failureId },
        {
          kind: 'failure-list',
          groupBy: 'file',
          columns: ['title', 'duration'],
          initialTextFilter: 'AssertionError',
        },
      ],
    };
    const shown = await call(client, 'test_report_show', { reportId, view });
    expect(shown.isError).not.toBe(true);
    expect(shown.structuredContent).toMatchObject({
      kind: 'show',
      reportId,
      view,
      viewResolution: {
        mode: 'generated',
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      firstPage: { matchedCount: 1, items: [{ itemId: failureId }] },
      initialDetail: {
        kind: 'detail',
        item: { itemId: failureId },
        field: 'diagnostics',
        offset: 0,
      },
    });
    const invalidCandidates = [
      {
        candidate: { ...view, schemaVersion: 2 },
        reason: 'unsupported-version',
      },
      {
        candidate: { ...view, reportId: `r1_${'f'.repeat(64)}` },
        reason: 'invalid-reference',
      },
      {
        candidate: { ...view, url: 'https://example.test' },
        reason: 'invalid-schema',
      },
      {
        candidate: {
          ...view,
          sections: [
            ...view.sections,
            { kind: 'html', html: '<script>never execute</script>' },
          ],
        },
        reason: 'invalid-schema',
      },
      {
        candidate: { ...view, ['x'.repeat(30_000)]: 'untrusted payload' },
        reason: 'spec-too-large',
      },
      ...[passedId, 'f1999:a19999'].map((id) => ({
        candidate: {
          ...view,
          sections: [
            view.sections[2],
            { kind: 'evidence', initialFailureId: id },
          ],
        },
        reason: 'invalid-reference',
      })),
    ];
    for (const { candidate, reason } of invalidCandidates) {
      const fallback = await call(client, 'test_report_show', {
        reportId,
        view: candidate,
      });
      expect(fallback.isError).not.toBe(true);
      expect(fallback.structuredContent).toMatchObject({
        kind: 'show',
        reportId,
        viewResolution: { mode: 'fixed', reason },
        firstPage: { matchedCount: 1 },
      });
      expect(fallback.structuredContent).not.toHaveProperty('view');
      expect(JSON.stringify(fallback)).not.toContain('untrusted payload');
    }
    for (const invalid of ['not an object', null, []]) {
      const result = await call(client, 'test_report_show', {
        reportId,
        view: invalid,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent ?? {}).not.toHaveProperty(
        'viewResolution',
      );
    }
    const missing = await call(client, 'test_report_show', {
      reportId: `r1_${'f'.repeat(64)}`,
      view,
    });
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { code: 'REPORT_UNAVAILABLE' },
    });
    expect(
      await call(client, 'test_report_query', {
        reportId,
        query: {
          kind: 'list',
          collection: 'failures',
          failureIds: [failureId],
        },
      }),
    ).toMatchObject({
      structuredContent: { matchedCount: 1, items: [{ itemId: failureId }] },
    });
    for (const failureIds of [
      [failureId, passedId],
      [failureId, failureId],
      [],
    ]) {
      expect(
        await call(client, 'test_report_query', {
          reportId,
          query: { kind: 'list', collection: 'failures', failureIds },
        }),
      ).toMatchObject({ isError: true });
    }
    await client.close();
    await rm(join(root, 'report.json'));
    const restarted = await connect(root);
    expect(
      await call(restarted, 'test_report_show', { reportId, view }),
    ).toEqual(shown);
  }, 30_000);

  it('rejects malformed collections without publishing snapshots and keeps serving', async () => {
    const root = await temporary();
    await copyReport(root);
    const valid = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
    const client = await connect(root);
    const invalidReports = [
      {
        report: { ...valid, testResults: Array(MAX_FILES + 1).fill(null) },
        code: 'REPORT_TOO_LARGE',
      },
      {
        report: {
          ...valid,
          testResults: [
            {
              ...valid.testResults[0],
              assertionResults: Array(MAX_ASSERTIONS + 1).fill(null),
            },
          ],
        },
        code: 'REPORT_TOO_LARGE',
      },
      ...['ancestorTitles', 'failureMessages'].map((field) => ({
        report: {
          ...valid,
          testResults: [
            {
              ...valid.testResults[0],
              assertionResults: [
                {
                  ...valid.testResults[0].assertionResults[0],
                  [field]: Array(2_000).fill(null),
                },
              ],
            },
          ],
        },
        code: 'INVALID_REPORT',
      })),
    ];
    for (const { report, code } of invalidReports) {
      await writeFile(join(root, 'invalid.json'), JSON.stringify(report));
      const rejected = await call(client, 'test_report_import', {
        relativePath: 'invalid.json',
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toMatchObject({ code });
    }
    expect(
      await readdir(join(root, '.qwen/test-failure-explorer/reports')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      ),
    ).toEqual([]);
    const imported = await call(client, 'test_report_import', {
      relativePath: 'report.json',
    });
    expect(imported.isError).not.toBe(true);
    const summary = await call(client, 'test_report_query', {
      reportId: imported.structuredContent!['reportId'],
      query: { kind: 'summary' },
    });
    expect(summary.structuredContent!['summary']).toMatchObject({
      computed: { fileEntries: 2, assertions: 4, failures: 1 },
    });
  }, 30_000);

  it('exposes the fixed App with read-only queries and preserves evidence after restart', async () => {
    const root = await temporary();
    await copyReport(root);
    const client = await connect(root);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'test_report_import',
      'test_report_query',
      'test_report_show',
    ]);
    for (const tool of tools) {
      expect(tool._meta?.['ui']).toEqual(
        tool.name === 'test_report_show'
          ? { visibility: ['model'], resourceUri: APP_URI }
          : {
              visibility:
                tool.name === 'test_report_query'
                  ? ['model', 'app']
                  : ['model'],
            },
      );
      expect(tool.annotations).toMatchObject({
        readOnlyHint: tool.name !== 'test_report_import',
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain(
        'workspaceRoot',
      );
    }
    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(1);
    expect(resources.resources[0]).toMatchObject({
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
    if (!('text' in resource)) throw new Error('Expected bundled HTML');
    expect(Buffer.byteLength(resource.text, 'utf8')).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(resource.text).toContain('<script>');
    expect(resource.text).not.toMatch(/<(?:script[^>]*src|link[^>]*href)=/i);
    expect(resource.text).not.toContain('r1_'.concat('a'.repeat(64)));
    const queryTool = tools.find((tool) => tool.name === 'test_report_query')!;
    expect(queryTool.inputSchema.required).toEqual(['reportId', 'query']);
    const queryShape = queryTool.inputSchema.properties!['query'] as {
      anyOf: Array<{ properties: { offset?: { minimum: number } } }>;
    };
    expect(queryShape.anyOf[1].properties.offset?.minimum).toBe(0);
    const imported = await call(client, 'test_report_import', {
      relativePath: 'report.json',
    });
    expect(imported.isError).not.toBe(true);
    const reportId = imported.structuredContent!['reportId'];
    const shown = await call(client, 'test_report_show', { reportId });
    expect(showSchema.safeParse(shown.structuredContent).success).toBe(true);
    expect(shown.structuredContent).toMatchObject({
      kind: 'show',
      reportId,
      viewResolution: { mode: 'fixed' },
      firstPage: { collection: 'failures', returnedCount: 1 },
    });
    expect(shown.structuredContent!['summary']).toEqual(
      imported.structuredContent!['summary'],
    );
    for (const query of [
      { kind: 'summary', ['x'.repeat(30_000)]: 'unexpected' },
      { kind: 'list', collection: 'assertions', status: 'x'.repeat(30_000) },
    ]) {
      const invalid = await call(client, 'test_report_query', {
        reportId,
        query,
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('INVALID_QUERY'),
      });
    }
    const summary = await call(client, 'test_report_query', {
      reportId,
      query: { kind: 'summary' },
    });
    expect(summary.structuredContent!['summary']).toMatchObject({
      reported: { numTotalTestSuites: 4 },
      computed: { fileEntries: 2, failures: 1 },
      provenance: { processExitCode: 'unknown' },
    });
    const listed = await call(client, 'test_report_query', {
      reportId,
      query: { kind: 'list', collection: 'failures' },
    });
    expect(listed.structuredContent).toMatchObject({
      returnedCount: 1,
      nextOffset: null,
    });
    const items = listed.structuredContent!['items'] as Array<{
      itemId: string;
    }>;
    const detail = await call(client, 'test_report_query', {
      reportId,
      query: { kind: 'detail', itemId: items[0].itemId },
    });
    expect(detail.structuredContent!['text']).toContain('AssertionError');
    expect(
      (
        await call(client, 'test_report_import', {
          relativePath: '../escape.json',
        })
      ).structuredContent,
    ).toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await client.close();
    await rm(join(root, 'report.json'));
    const restarted = await connect(root);
    expect(await call(restarted, 'test_report_show', { reportId })).toEqual(
      shown,
    );
    expect(
      await call(restarted, 'test_report_query', {
        reportId,
        query: { kind: 'summary' },
      }),
    ).toEqual(summary);
  }, 30_000);

  it('supports concurrent processes sharing a root while denying another root', async () => {
    const [a, b] = await Promise.all([temporary(), temporary()]);
    await Promise.all([copyReport(a), copyReport(b)]);
    const [first, second, foreign] = await Promise.all([
      connect(a),
      connect(a),
      connect(b),
    ]);
    const imports = await Promise.all(
      [first, second, foreign].map((client) =>
        call(client, 'test_report_import', { relativePath: 'report.json' }),
      ),
    );
    expect(imports[0]).toEqual(imports[1]);
    const reportId = imports[0].structuredContent!['reportId'];
    expect(imports[2].structuredContent!['reportId']).not.toBe(reportId);
    expect(
      (
        await call(foreign, 'test_report_query', {
          reportId,
          query: { kind: 'summary' },
        })
      ).structuredContent,
    ).toMatchObject({ code: 'REPORT_UNAVAILABLE' });
  }, 30_000);

  it('starts from the real packed extension without repository source or node_modules', async () => {
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
    expect(files).toContain('dist/main.js');
    expect(files).toContain('dist/app.html');
    expect(files).toContain('qwen-extension.json');
    expect(files).toContain('skills/test-failure-explorer/SKILL.md');
    expect(
      files.some(
        (file) => file.startsWith('src/') || file.startsWith('test-fixtures/'),
      ),
    ).toBe(false);
    execFileSync(
      'tar',
      ['-xzf', join(output, packed[0].filename), '-C', output],
      { timeout: 10_000 },
    );
    const manifest = JSON.parse(
      await readFile(join(output, 'package/qwen-extension.json'), 'utf8'),
    );
    expect(manifest.mcpServers['test-failure-explorer']).toMatchObject({
      cwd: '${workspacePath}',
      env: { QWEN_TEST_EXPLORER_WORKSPACE_ROOT: '${workspacePath}' },
    });
    expect(
      JSON.parse(await readFile(join(output, 'package/package.json'), 'utf8'))
        .private,
    ).toBe(true);
    const root = await temporary();
    await copyReport(root);
    const packedClient = await connect(
      root,
      join(output, 'package/dist/main.js'),
    );
    expect(
      (await packedClient.readResource({ uri: APP_URI })).contents[0],
    ).toHaveProperty('text');
    expect(
      (
        await call(packedClient, 'test_report_import', {
          relativePath: 'report.json',
        })
      ).isError,
    ).not.toBe(true);
  }, 45_000);

  it('fails startup when the configured root is absent', async () => {
    const client = new Client({ name: 'bad-root', version: '1.0.0' });
    clients.push(client);
    await expect(
      client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [bundle],
          env: {},
          stderr: 'pipe',
        }),
      ),
    ).rejects.toThrow();
  }, 10_000);
});
