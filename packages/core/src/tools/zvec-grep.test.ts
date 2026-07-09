/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { _resetZvecGrepInstallForTest, ZvecGrepTool } from './zvec-grep.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

const UNINDEXED_STATUS = [
  'root\t/tmp/workspace',
  'policy\tundecided',
  'indexed\tno',
  'source\tunindexed',
].join('\n');

type QueuedSpawnResult = {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: NodeJS.ErrnoException;
};

const tempRoots: string[] = [];
const API_ENV_NAMES = [
  'ZVEC_GREP_API_KEY',
  'DASHSCOPE_API_KEY',
  'QWEN_API_KEY',
  'ZVEC_GREP_EMBEDDING',
] as const;
const originalApiEnv = Object.fromEntries(
  API_ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof API_ENV_NAMES)[number], string | undefined>;

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zvec-grep-tool-test-'));
  tempRoots.push(root);
  return root;
}

function createTool(
  root: string,
  interactive = true,
  fileReadCache = new FileReadCache(),
): ZvecGrepTool {
  return new ZvecGrepTool({
    getTargetDir: () => root,
    isInteractive: () => interactive,
    getWorkspaceContext: () => ({
      isPathWithinWorkspace: (filePath: string) =>
        filePath === root || filePath.startsWith(`${root}${path.sep}`),
    }),
    getFileReadCache: () => fileReadCache,
    getFileReadCacheDisabled: () => false,
  } as unknown as Config);
}

function queueSpawnResult(result: QueuedSpawnResult): void {
  spawnMock.mockImplementationOnce((() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.pid = 12345;
    child.unref = vi.fn();

    process.nextTick(() => {
      if (result.error) {
        child.emit('error', result.error);
        return;
      }
      if (result.stdout) {
        child.stdout.emit('data', Buffer.from(result.stdout));
      }
      if (result.stderr) {
        child.stderr.emit('data', Buffer.from(result.stderr));
      }
      child.emit('close', result.code ?? 0);
    });

    return child;
  }) as unknown as typeof spawn);
}

function setFakeRemoteEmbeddingKey(): void {
  process.env['DASHSCOPE_API_KEY'] = 'test-api-key';
}

function clearEmbeddingEnv(): void {
  for (const name of API_ENV_NAMES) {
    delete process.env[name];
  }
}

afterEach(() => {
  _resetZvecGrepInstallForTest();
  spawnMock.mockReset();
  for (const name of API_ENV_NAMES) {
    const value = originalApiEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ZvecGrepTool', () => {
  it('exposes a compact search-oriented schema', () => {
    const tool = createTool(createTempRoot());
    const schema = tool.schema.parametersJsonSchema as {
      properties: Record<string, { enum?: string[]; description?: string }>;
      required: string[];
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      'exclude',
      'glob',
      'limit',
      'operation',
      'path',
      'paths',
      'pattern',
      'query',
    ]);
    expect(schema.required).toEqual(['operation']);
    expect(schema.properties).not.toHaveProperty('include');
    expect(schema.properties).not.toHaveProperty('embedding');
    expect(schema.properties).not.toHaveProperty('background');
    expect(schema.properties['operation']?.enum).toEqual(['semantic', 'rg']);
    expect(schema.properties['operation']?.enum).toContain('semantic');
    expect(schema.properties['operation']?.enum).toContain('rg');
    expect(schema.properties['operation']?.enum).not.toContain('index');
    expect(schema.properties['operation']?.enum).not.toContain('disable_index');
    expect(schema.properties['operation']?.enum).not.toContain('status');
    expect(schema.properties['operation']?.enum).not.toContain('grep');
    expect(schema.properties['query']?.description).toContain(
      'operation="semantic"',
    );
    expect(schema.properties['pattern']?.description).toContain(
      'operation="rg"',
    );
  });

  it('describes zvec-grep without hidden operations', () => {
    const tool = createTool(createTempRoot());

    expect(tool.description).toContain('preferred workspace search tool');
    expect(tool.description).toContain(
      'Use zvec_grep instead of grep_search when available',
    );
    expect(tool.description).toContain('operation="semantic" with query');
    expect(tool.description).toContain('semantic or fuzzy discovery');
    expect(tool.description).toContain('operation="rg" with pattern');
    expect(tool.description).toContain('regular-expression searches');
    expect(tool.description).not.toContain('operation="index"');
    expect(tool.description).not.toContain('operation="status"');
    expect(tool.description).not.toContain('transparently falls back');
    expect(tool.description).not.toContain('installation/indexing');
    expect(tool.description).not.toContain('zvec_grep_semantic_fallback_rg');
  });

  it('falls back to rg for semantic search in interactive unindexed workspaces', async () => {
    setFakeRemoteEmbeddingKey();
    const root = createTempRoot();
    queueSpawnResult({ stdout: UNINDEXED_STATUS });
    queueSpawnResult({});
    queueSpawnResult({
      stdout: 'src/index.ts:1\n  1  // vector index metadata storage\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'vector index metadata storage',
    });

    await expect(invocation.getDefaultPermission()).resolves.toBe('allow');
    const result = await invocation.execute(new AbortController().signal);
    const content = String(result.llmContent);

    expect(content).toContain('src/index.ts:1');
    expect(content).not.toContain('zvec_grep_semantic_fallback_rg');
    expect(content).not.toContain('fallback_reason');
    expect(content).not.toContain('semantic_search: unavailable');
    expect(content).not.toContain('zvec_grep_index_required');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--status']);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--index',
      '--embedding',
      'qwen/text-embedding-v4',
    ]);
    expect(spawnMock.mock.calls[2]?.[1]).toEqual([
      '--rg',
      '(?i)(vector|index|metadata|storage)',
      '--limit',
      '20',
    ]);
  });

  it('uses a lexical rg pattern in non-interactive unindexed workspaces', async () => {
    setFakeRemoteEmbeddingKey();
    const root = createTempRoot();
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.mkdirSync(path.join(root, 'thirdparty'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(root, 'docs', 'README.md'), '# docs');
    fs.writeFileSync(
      path.join(root, 'thirdparty', 'vendor.cc'),
      'int main() {}',
    );

    queueSpawnResult({ stdout: UNINDEXED_STATUS });
    queueSpawnResult({});
    queueSpawnResult({
      stdout: 'docs/README.md:1\n  1  # index types supported\n',
    });
    const invocation = createTool(root, false).build({
      operation: 'semantic',
      query: 'index types supported',
    });

    await expect(invocation.getDefaultPermission()).resolves.toBe('allow');
    const result = await invocation.execute(new AbortController().signal);
    const content = String(result.llmContent);

    expect(content).toContain('docs/README.md:1');
    expect(content).not.toContain('zvec_grep_semantic_fallback_rg');
    expect(content).not.toContain('fallback_reason');
    expect(content).not.toContain('semantic_search: unavailable');
    expect(content).not.toContain('zvec_grep_index_required');
    expect(content).not.toContain('grep_search');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--status']);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--index',
      '--embedding',
      'qwen/text-embedding-v4',
    ]);
    expect(spawnMock.mock.calls[2]?.[1]).toEqual([
      '--rg',
      '(?i)(index|types)',
      '--limit',
      '20',
    ]);
  });

  it('does not build an index for semantic search without an embedding api key', async () => {
    clearEmbeddingEnv();
    const root = createTempRoot();
    queueSpawnResult({ stdout: UNINDEXED_STATUS });
    queueSpawnResult({
      stdout: 'src/index.ts:1\n  1  // vector index metadata storage\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'vector index metadata storage',
    });

    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('src/index.ts:1');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--status']);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--rg',
      '(?i)(vector|index|metadata|storage)',
      '--limit',
      '20',
    ]);
  });

  it('falls back to rg for ready remote indexes without an embedding api key', async () => {
    clearEmbeddingEnv();
    const root = createTempRoot();
    queueSpawnResult({
      stdout: [
        'root\t/tmp/workspace',
        'policy\tindexed',
        'indexed\tyes',
        'embedding\tqwen/text-embedding-v4',
      ].join('\n'),
    });
    queueSpawnResult({
      stdout: 'src/auth.ts:1\n  1  authentication flow\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'authentication flow',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('src/auth.ts:1');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--status']);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--rg',
      '(?i)(authentication|flow)',
      '--limit',
      '20',
    ]);
  });

  it('runs semantic search when a remote index is ready and an api key is set', async () => {
    setFakeRemoteEmbeddingKey();
    const root = createTempRoot();
    queueSpawnResult({
      stdout: [
        'root\t/tmp/workspace',
        'policy\tindexed',
        'indexed\tyes',
        'embedding\tqwen/text-embedding-v4',
      ].join('\n'),
    });
    queueSpawnResult({
      stdout: 'src/auth.ts:1\n  1  authentication flow\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'authentication flow',
      limit: 5,
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('src/auth.ts:1');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--status']);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      'authentication flow',
      '--limit',
      '5',
    ]);
  });

  it('uses the default semantic limit when none is provided', async () => {
    setFakeRemoteEmbeddingKey();
    const root = createTempRoot();
    queueSpawnResult({
      stdout: [
        'root\t/tmp/workspace',
        'policy\tindexed',
        'indexed\tyes',
        'embedding\tqwen/text-embedding-v4',
      ].join('\n'),
    });
    queueSpawnResult({
      stdout: 'src/auth.ts:1\n  1  authentication flow\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'authentication flow',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('src/auth.ts:1');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      'authentication flow',
      '--limit',
      '20',
    ]);
  });

  it('uses a configured local embedding without an api key', async () => {
    clearEmbeddingEnv();
    process.env['ZVEC_GREP_EMBEDDING'] = 'local/embeddinggemma-300m';
    const root = createTempRoot();
    queueSpawnResult({ stdout: UNINDEXED_STATUS });
    queueSpawnResult({});
    queueSpawnResult({
      stdout: 'src/index.ts:1\n  1  // vector index metadata storage\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'vector index metadata storage',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('src/index.ts:1');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--index',
      '--embedding',
      'local/embeddinggemma-300m',
    ]);
    expect(spawnMock.mock.calls[2]?.[1]).toEqual([
      '--rg',
      '(?i)(vector|index|metadata|storage)',
      '--limit',
      '20',
    ]);
  });

  it('prefers code-like terms for semantic rg fallback', async () => {
    clearEmbeddingEnv();
    const root = createTempRoot();
    queueSpawnResult({ stdout: UNINDEXED_STATUS });
    queueSpawnResult({
      stdout: 'src/common/index/fts/fts_query_ast.h:1\n  1  FTS query AST\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'full text search FTS implementation',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('fts_query_ast.h:1');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--rg',
      '(?i)FTS',
      '--limit',
      '20',
    ]);
  });

  it('drops task framing words from semantic rg fallback', async () => {
    clearEmbeddingEnv();
    const root = createTempRoot();
    queueSpawnResult({ stdout: UNINDEXED_STATUS });
    queueSpawnResult({
      stdout: 'packages/core/src/tools/zvec-grep.ts:1\n  1  install\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'please show where current auto install handling is implemented',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('zvec-grep.ts:1');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--rg',
      '(?i)(auto|install)',
      '--limit',
      '20',
    ]);
  });

  it('does not pass semantic fallback queries as exact phrases', async () => {
    setFakeRemoteEmbeddingKey();
    const root = createTempRoot();
    queueSpawnResult({ stdout: UNINDEXED_STATUS });
    queueSpawnResult({});
    queueSpawnResult({
      stdout: 'src/streamer/stream_service.cc:1\n  1  write request flow\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'streamer write flow',
    });

    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('stream_service.cc:1');
    expect(String(result.llmContent)).not.toContain('fallback_reason');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '--index',
      '--embedding',
      'qwen/text-embedding-v4',
    ]);
    expect(spawnMock.mock.calls[2]?.[1]).toEqual([
      '--rg',
      '(?i)(streamer|write|flow)',
      '--limit',
      '20',
    ]);
  });

  it('asks before searching paths outside the workspace', async () => {
    const root = createTempRoot();
    const externalRoot = createTempRoot();

    const invocation = createTool(root).build({
      operation: 'rg',
      query: 'secret',
      paths: [externalRoot],
    });

    await expect(invocation.getDefaultPermission()).resolves.toBe('ask');
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );

    expect(details.type).toBe('info');
    if (details.type !== 'info') {
      throw new Error('expected info confirmation');
    }
    expect(details.prompt).toContain('outside the current workspace');
    expect(details.prompt).toContain(externalRoot);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('runs exact grep through zg --rg without checking index status', async () => {
    const root = createTempRoot();
    queueSpawnResult({
      stdout:
        'src/index.ts:1\n  1  export const validate = true;\nsrc/other.ts:3\n  3  validate();\n',
    });

    const invocation = createTool(root).build({
      operation: 'rg',
      query: 'validate',
      glob: '**/*.ts',
      paths: ['src'],
      limit: 5,
    });
    await expect(invocation.getDefaultPermission()).resolves.toBe('allow');
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('src/index.ts:1');
    expect(String(result.llmContent)).toContain('src/other.ts:3');
    expect(result.returnDisplay).toBe('Found 2 matches');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '--rg',
      'validate',
      '--limit',
      '5',
      '--glob',
      '**/*.ts',
      'src',
    ]);
  });

  it('returns a grep_search-style display for no matches', async () => {
    const root = createTempRoot();
    queueSpawnResult({});

    const invocation = createTool(root).build({
      operation: 'rg',
      query: 'missing',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('No matches found');
    expect(result.returnDisplay).toBe('No matches found');
  });

  it('accepts grep_search-compatible pattern and path aliases', async () => {
    const root = createTempRoot();
    queueSpawnResult({
      stdout: 'src/index.ts:1\n  1  export const validate = true;\n',
    });

    const invocation = createTool(root).build({
      operation: 'rg',
      pattern: 'validate',
      glob: '**/*.ts',
      path: 'src',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(String(result.llmContent)).toContain('src/index.ts:1');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '--rg',
      'validate',
      '--glob',
      '**/*.ts',
      'src',
    ]);
  });

  it('records exact search result files as partial reads', async () => {
    const root = createTempRoot();
    const fileReadCache = new FileReadCache();
    const filePath = path.join(root, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, 'export const validate = true;\n');
    queueSpawnResult({
      stdout: 'src/index.ts:1:export const validate = true;\n',
    });

    const invocation = createTool(root, true, fileReadCache).build({
      operation: 'rg',
      query: 'validate',
      paths: ['src'],
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.resultFilePaths).toEqual([filePath]);
    expect(result.returnDisplay).toBe('Found 1 match');
    const readState = fileReadCache.check(fs.statSync(filePath));
    expect(readState.state).toBe('fresh');
    if (readState.state !== 'fresh') {
      throw new Error('expected fresh read state');
    }
    expect(readState.entry.lastReadWasFull).toBe(false);
  });

  it('expands simple brace globs before passing them to zg --rg', async () => {
    const root = createTempRoot();
    queueSpawnResult({ stdout: 'src/a.cc:1\n  1  validate();\n' });

    const invocation = createTool(root).build({
      operation: 'rg',
      query: 'validate',
      glob: '*.{h,cc,cpp}',
      paths: ['src'],
    });

    await invocation.execute(new AbortController().signal);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '--rg',
      'validate',
      '--glob',
      '*.h',
      '--glob',
      '*.cc',
      '--glob',
      '*.cpp',
      'src',
    ]);
  });

  it('auto-installs zvec-grep and retries when zg is missing', async () => {
    setFakeRemoteEmbeddingKey();
    const root = createTempRoot();
    const error = Object.assign(new Error('spawn zg ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    queueSpawnResult({ error });
    queueSpawnResult({ stdout: 'added 1 package\n' });
    queueSpawnResult({ stdout: UNINDEXED_STATUS });
    queueSpawnResult({});
    queueSpawnResult({
      stdout: 'src/auth.ts:1\n  1  authentication flow\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'authentication flow',
    });
    const result = await invocation.execute(new AbortController().signal);
    const content = String(result.llmContent);

    expect(content).toContain('src/auth.ts:1');
    expect(spawnMock).toHaveBeenCalledTimes(5);
    expect(spawnMock.mock.calls[0]?.[0]).toBe('zg');
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--status']);
    expect(spawnMock.mock.calls[1]?.[0]).toBe('npm');
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      'install',
      '-g',
      '@zvec/zvec-grep@0.1.4',
      '--registry',
      'https://registry.npmmirror.com',
    ]);
    expect(spawnMock.mock.calls[2]?.[0]).toBe('zg');
    expect(spawnMock.mock.calls[2]?.[1]).toEqual(['--status']);
    expect(spawnMock.mock.calls[3]?.[0]).toBe('zg');
    expect(spawnMock.mock.calls[3]?.[1]).toEqual([
      '--index',
      '--embedding',
      'qwen/text-embedding-v4',
    ]);
    expect(spawnMock.mock.calls[4]?.[0]).toBe('zg');
    expect(spawnMock.mock.calls[4]?.[1]).toEqual([
      '--rg',
      '(?i)(authentication|flow)',
      '--limit',
      '20',
    ]);
  });

  it('returns not_installed when automatic install fails', async () => {
    const root = createTempRoot();
    const error = Object.assign(new Error('spawn zg ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    queueSpawnResult({ error });
    queueSpawnResult({
      code: 1,
      stderr: 'npm registry unavailable\n',
    });

    const invocation = createTool(root).build({
      operation: 'semantic',
      query: 'authentication flow',
    });
    const result = await invocation.execute(new AbortController().signal);
    const content = String(result.llmContent);

    expect(content).toContain('zvec-grep is not installed');
    expect(content).toContain('auto-install command failed');
    expect(content).toContain('npm registry unavailable');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
