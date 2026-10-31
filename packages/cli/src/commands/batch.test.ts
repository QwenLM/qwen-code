/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yargs from 'yargs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import {
  assertValidWindow,
  batchRequest,
  downloadRemoteFile,
  getBatchJob,
  listBatchJobs,
} from './batch-client.js';
import {
  batchCommand,
  listWorkflowCommand,
  prepareEndpoint,
  resolveEndpoint,
} from './batch.js';
import { BatchTaskStore } from './batch-task.js';
import { writeStdoutLine } from '../utils/stdioHelpers.js';

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockResolve = vi.hoisted(() => vi.fn());
const mockResolveProxy = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockIgnoreBrokenPipe = vi.hoisted(() => vi.fn());

vi.mock('../config/settings.js', () => ({ loadSettings: mockLoadSettings }));
vi.mock('../utils/modelConfigUtils.js', () => ({
  getAuthTypeFromEnv: vi.fn(() => undefined),
  resolveCliGenerationConfig: mockResolve,
}));
vi.mock('./channel/proxy.js', () => ({ resolveProxy: mockResolveProxy }));
vi.mock('../utils/stdioHelpers.js', () => ({
  ignoreBrokenPipe: mockIgnoreBrokenPipe,
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: vi.fn(),
}));

const ep = { apiKey: 'k', baseUrl: 'https://x/v1', model: 'qwen-plus' };

describe('resolveEndpoint', () => {
  it('rejects non-openai auth types', () => {
    mockLoadSettings.mockReturnValue({
      merged: { security: { auth: { selectedType: AuthType.QWEN_OAUTH } } },
    });
    expect(() => resolveEndpoint({})).toThrow(/auth type "openai"/);
  });

  it('falls back to the DashScope base URL and strips trailing slashes', () => {
    mockLoadSettings.mockReturnValue({
      merged: { security: { auth: { selectedType: AuthType.USE_OPENAI } } },
    });
    mockResolve.mockReturnValue({
      apiKey: 'k',
      baseUrl: '',
      model: 'm',
      authType: AuthType.USE_OPENAI,
    });
    expect(resolveEndpoint({}).baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    mockResolve.mockReturnValue({
      apiKey: 'k',
      baseUrl: 'https://h/v1/',
      model: 'm',
      authType: AuthType.USE_OPENAI,
    });
    expect(resolveEndpoint({}).baseUrl).toBe('https://h/v1');
  });

  it('rejects a model that resolves onto the Responses wire', () => {
    // The resolver can flip the protocol: a model pinned to
    // `wireApi: "responses"` turns an `openai` startup into
    // `openai-responses`, which has no Batch API. Refusing the selected type
    // alone would upload a body the provider rejects per line, hours later.
    mockLoadSettings.mockReturnValue({
      merged: { security: { auth: { selectedType: AuthType.USE_OPENAI } } },
    });
    mockResolve.mockReturnValue({
      apiKey: 'k',
      baseUrl: '',
      model: 'qwen-plus',
      authType: AuthType.USE_OPENAI_RESPONSES,
    });
    expect(() => resolveEndpoint({})).toThrow(
      /"qwen-plus" resolves to auth type "openai-responses"/,
    );
  });

  it('surfaces resolver warnings on stderr, not stdout', () => {
    mockLoadSettings.mockReturnValue({
      merged: { security: { auth: { selectedType: AuthType.USE_OPENAI } } },
    });
    mockResolve.mockReturnValue({
      apiKey: 'k',
      baseUrl: '',
      model: 'm',
      authType: AuthType.USE_OPENAI,
      warnings: ['model m is not served by the resolved provider'],
    });
    resolveEndpoint({});
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('model m is not served'),
    );
  });
});

describe('prepareEndpoint', () => {
  it('installs the proxy dispatcher from settings before resolving', async () => {
    // This command path never builds a Config, so without this the global
    // fetch ignores HTTPS_PROXY/settings.proxy and dials out directly.
    mockLoadSettings.mockReturnValue({
      merged: {
        security: { auth: { selectedType: AuthType.USE_OPENAI } },
        proxy: 'http://proxy.internal:8080',
      },
    });
    mockResolve.mockReturnValue({
      apiKey: 'k',
      baseUrl: '',
      model: 'm',
      authType: AuthType.USE_OPENAI,
    });
    const resolved = await prepareEndpoint({});
    expect(mockResolveProxy).toHaveBeenCalledWith(
      undefined,
      'http://proxy.internal:8080',
    );
    expect(resolved.apiKey).toBe('k');
  });

  it('ranks the --proxy flag above settings, as the rest of the CLI does', async () => {
    // `--proxy` is a top-level global option and the highest-priority proxy
    // source everywhere else; dropping it here would send every upload,
    // create, poll and download of a paid job around the proxy the operator
    // explicitly named.
    mockLoadSettings.mockReturnValue({
      merged: {
        security: { auth: { selectedType: AuthType.USE_OPENAI } },
        proxy: 'http://proxy.internal:8080',
      },
    });
    mockResolve.mockReturnValue({
      apiKey: 'k',
      baseUrl: '',
      model: 'm',
      authType: AuthType.USE_OPENAI,
    });
    await prepareEndpoint({}, { proxy: 'http://jump-host:1080' });
    expect(mockResolveProxy).toHaveBeenCalledWith(
      'http://jump-host:1080',
      'http://proxy.internal:8080',
    );
  });
});

describe('batch-client', () => {
  let dir: string;
  const fetchMock = vi.fn();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-batch-'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a completion window the provider does not offer', () => {
    expect(() => assertValidWindow('12h')).toThrow('between 24h and 14d');
    expect(() => assertValidWindow('15d')).toThrow('between 24h and 14d');
    expect(() => assertValidWindow('soon')).toThrow(
      'a number followed by h or d',
    );
    expect(() => assertValidWindow('24h')).not.toThrow();
    expect(() => assertValidWindow('14d')).not.toThrow();
  });

  it('pages through the batch list with the last id as the cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'b1' }, { id: 'b2' }],
            has_more: true,
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'b3' }], has_more: false })),
      );
    const jobs = await listBatchJobs(ep, 2);
    expect(jobs.map((job) => job.id)).toEqual(['b1', 'b2', 'b3']);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://x/v1/batches?limit=2',
      'https://x/v1/batches?limit=2&after=b2',
    ]);
  });

  it('leaves nothing under the final name when a download is cut short', async () => {
    // A truncated body written straight to the target looks complete: its
    // last line is still valid JSON, so a short paid result reads as whole.
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"custom_id":"0"}\n'));
            controller.error(new Error('terminated'));
          },
        }),
        { status: 200 },
      ),
    );

    const target = path.join(dir, 'output.jsonl');
    await expect(downloadRemoteFile(ep, 'out', target)).rejects.toThrow(
      'terminated',
    );
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });

  it('refuses an id that would move a status query off /batches', async () => {
    // Ids come from a task ledger or a provider response and sit in the URL
    // next to the API key; `../../x` would otherwise reach GET /x with it.
    await expect(getBatchJob(ep, '../../escaped-namespace')).rejects.toThrow(
      /outside the Batch API paths/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never sends the API key outside the Batch API paths', async () => {
    for (const route of [
      '/batches/../../escaped/cancel',
      '/files/a/b/content',
      '/models',
      '/batches/batch-1/../../x',
    ]) {
      await expect(batchRequest(ep, route)).rejects.toThrow(
        /outside the Batch API paths/,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    for (const route of [
      '/files',
      '/batches',
      '/batches?limit=100&after=batch_abc-1',
      '/batches/batch_abc/cancel',
      '/files/file-batch.1/content',
      '/files/file-1',
    ]) {
      await batchRequest(ep, route);
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe('batch list command', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-list-'));
    savedHome = process.env['QWEN_BATCH_HOME'];
    process.env['QWEN_BATCH_HOME'] = home;
    mockIgnoreBrokenPipe.mockClear();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env['QWEN_BATCH_HOME'];
    else process.env['QWEN_BATCH_HOME'] = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('installs the broken-pipe guard before the listing is written', async () => {
    // An unreadable record makes `batch list` write to stderr for the first
    // time, so `batch list 2>&1 | head -1` used to exit 1 on a listing that
    // had already succeeded: the reader leaves, EPIPE lands on a stream with
    // no error listener, and the process dies after the work is done.
    await (listWorkflowCommand.handler as () => Promise<void>)();

    expect(mockIgnoreBrokenPipe).toHaveBeenCalledTimes(1);
  });
});

describe('local batch command environment', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-local-env-'));
    home = path.join(root, 'configured-batch');
    vi.stubEnv('QWEN_HOME', path.join(root, 'qwen-home'));
    vi.stubEnv('QWEN_BATCH_HOME', '');
    mockLoadSettings.mockReset();
    mockResolve.mockClear();
    mockResolveProxy.mockClear();
    mockWriteStderrLine.mockClear();
    vi.mocked(writeStdoutLine).mockClear();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockLoadSettings.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it.each(['list', 'clean'] as const)(
    '%s still uses its configured home if settings loading throws',
    async (command) => {
      const store = new BatchTaskStore(home);
      const task = store.create(
        {
          version: 1,
          name: 'configured',
          kind: 'document-transform',
          shared: { instructions: 'Translate' },
          items: [{ id: 'a', source: 'a.md', target: 'b.md' }],
        },
        root,
        'qwen-plus',
      );
      mockLoadSettings.mockImplementation(() => {
        process.env['QWEN_BATCH_HOME'] = home;
        throw new Error('unrelated invalid settings');
      });

      await yargs(
        command === 'list' ? ['batch', 'list'] : ['batch', 'clean', task.id],
      )
        .command(batchCommand)
        .exitProcess(false)
        .fail(false)
        .parseAsync();

      expect(process.exitCode).toBeUndefined();
      expect(mockLoadSettings).toHaveBeenCalledWith(process.cwd(), {
        preserveInvalidWorkspaceSettings: true,
      });
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        expect.stringContaining('unrelated invalid settings'),
      );
      if (command === 'list') {
        expect(writeStdoutLine).toHaveBeenCalledWith(
          expect.stringContaining(task.id),
        );
        expect(fs.existsSync(store.fileOf(task.id))).toBe(true);
      } else {
        expect(fs.existsSync(store.fileOf(task.id))).toBe(false);
      }
    },
  );

  it.each(['list', 'clean'] as const)(
    '%s uses the task home populated while loading settings',
    async (command) => {
      const store = new BatchTaskStore(home);
      const task = store.create(
        {
          version: 1,
          name: 'configured',
          kind: 'document-transform',
          shared: { instructions: 'Translate' },
          items: [{ id: 'a', source: 'a.md', target: 'b.md' }],
        },
        root,
        'qwen-plus',
      );
      mockLoadSettings.mockImplementation(() => {
        process.env['QWEN_BATCH_HOME'] = home;
        return { merged: {} };
      });

      await yargs(
        command === 'list' ? ['batch', 'list'] : ['batch', 'clean', task.id],
      )
        .command(batchCommand)
        .exitProcess(false)
        .fail(false)
        .parseAsync();

      expect(process.exitCode).toBeUndefined();
      expect(mockWriteStderrLine).not.toHaveBeenCalled();
      if (command === 'list') {
        expect(writeStdoutLine).toHaveBeenCalledWith(
          expect.stringContaining(task.id),
        );
        expect(fs.existsSync(store.fileOf(task.id))).toBe(true);
      } else {
        expect(fs.existsSync(store.fileOf(task.id))).toBe(false);
      }
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockResolveProxy).not.toHaveBeenCalled();
    },
  );
});
