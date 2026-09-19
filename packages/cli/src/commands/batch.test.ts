/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import {
  describeBatch,
  fetchBatch,
  prepareEndpoint,
  resolveEndpoint,
  submitBatch,
  toRequestLine,
} from './batch.js';

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockResolve = vi.hoisted(() => vi.fn());
const mockResolveProxy = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('../config/settings.js', () => ({ loadSettings: mockLoadSettings }));
vi.mock('../utils/modelConfigUtils.js', () => ({
  getAuthTypeFromEnv: vi.fn(() => undefined),
  resolveCliGenerationConfig: mockResolve,
}));
vi.mock('./channel/proxy.js', () => ({ resolveProxy: mockResolveProxy }));
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: vi.fn(),
}));

const ep = { apiKey: 'k', baseUrl: 'https://x/v1', model: 'qwen-plus' };
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe('toRequestLine', () => {
  it('wraps a bare chat body and fills the default model', () => {
    expect(toRequestLine({ messages: [] }, 3, 'qwen-plus')).toEqual({
      custom_id: '3',
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model: 'qwen-plus', messages: [] },
    });
  });

  it('keeps a full request line and lets its model win', () => {
    const line = { custom_id: 'a', body: { model: 'qwen-max', messages: [] } };
    expect(toRequestLine(line, 0, 'qwen-plus')).toMatchObject({
      custom_id: 'a',
      body: { model: 'qwen-max' },
    });
  });

  it('rejects a declared url/method that is not POST /v1/chat/completions', () => {
    // Silently rewriting an embeddings line to chat/completions would only
    // surface hours later as per-line provider rejections.
    expect(() =>
      toRequestLine(
        {
          custom_id: 'e1',
          method: 'POST',
          url: '/v1/embeddings',
          body: { model: 'text-embedding-v4', input: 'x' },
        },
        0,
        'qwen-plus',
      ),
    ).toThrow('e1');
    expect(() =>
      toRequestLine(
        { custom_id: 'g1', method: 'GET', url: '/v1/other', body: {} },
        0,
        'qwen-plus',
      ),
    ).toThrow('GET /v1/other');
  });
});

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
    mockResolve.mockReturnValue({ apiKey: 'k', baseUrl: '', model: 'm' });
    expect(resolveEndpoint({}).baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    mockResolve.mockReturnValue({
      apiKey: 'k',
      baseUrl: 'https://h/v1/',
      model: 'm',
    });
    expect(resolveEndpoint({}).baseUrl).toBe('https://h/v1');
  });

  it('surfaces resolver warnings on stderr, not stdout', () => {
    mockLoadSettings.mockReturnValue({
      merged: { security: { auth: { selectedType: AuthType.USE_OPENAI } } },
    });
    mockResolve.mockReturnValue({
      apiKey: 'k',
      baseUrl: '',
      model: 'm',
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
    mockResolve.mockReturnValue({ apiKey: 'k', baseUrl: '', model: 'm' });
    const resolved = await prepareEndpoint({});
    expect(mockResolveProxy).toHaveBeenCalledWith(
      undefined,
      'http://proxy.internal:8080',
    );
    expect(resolved.apiKey).toBe('k');
  });
});

describe('describeBatch', () => {
  it('reports queued, running, and finished phases', () => {
    const base = {
      id: 'b',
      status: 'in_progress',
      created_at: 100,
      expires_at: 200,
    };
    expect(describeBatch(base, 160)).toContain('queued 60s');
    expect(describeBatch({ ...base, in_progress_at: 130 }, 160)).toContain(
      'running 30s',
    );
    expect(
      describeBatch({
        ...base,
        status: 'completed',
        in_progress_at: 130,
        completed_at: 150,
        request_counts: { total: 4, completed: 3, failed: 1 },
      }),
    ).toContain('3/4 done, 1 failed\tran 20s');
  });

  it('reports terminal statuses as terminal, never as running/queued', () => {
    // A failed job with a start timestamp must not read as still running.
    expect(
      describeBatch(
        { id: 'b', status: 'failed', created_at: 100, in_progress_at: 130 },
        4000,
      ),
    ).toContain('\tfailed\t');
    expect(
      describeBatch({ id: 'b', status: 'expired', created_at: 100 }, 4000),
    ).toContain('\texpired\t');
    expect(
      describeBatch(
        { id: 'b', status: 'cancelled', created_at: 100, in_progress_at: 130 },
        4000,
      ),
    ).toContain('\tcancelled\t');
  });
});

describe('submitBatch / fetchBatch', () => {
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

  it('uploads normalized JSONL then creates the batch', async () => {
    const file = path.join(dir, 'in.jsonl');
    fs.writeFileSync(file, '{"messages":[{"role":"user","content":"hi"}]}\n\n');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonRes({ id: 'batch-1', status: 'validating' }));

    const job = await submitBatch(ep, file, '24h');

    expect(job.id).toBe('batch-1');
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0];
    expect(uploadUrl).toBe('https://x/v1/files');
    expect(uploadInit.headers.Authorization).toBe('Bearer k');
    const form = uploadInit.body as FormData;
    expect(form.get('purpose')).toBe('batch');
    const uploaded = await (form.get('file') as Blob).text();
    expect(JSON.parse(uploaded.trim())).toMatchObject({
      custom_id: '0',
      url: '/v1/chat/completions',
      body: { model: 'qwen-plus' },
    });
    const [, createInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(createInit.body)).toEqual({
      input_file_id: 'file-1',
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
  });

  it('surfaces HTTP errors with the response body', async () => {
    const file = path.join(dir, 'in.jsonl');
    fs.writeFileSync(file, '{"messages":[]}\n');
    fetchMock.mockResolvedValueOnce(
      new Response('no such route', { status: 404 }),
    );
    await expect(submitBatch(ep, file, '24h')).rejects.toThrow(
      'POST /files -> HTTP 404: no such route',
    );
  });

  it('strips a UTF-8 BOM (the PowerShell 5.1 / Notepad default)', async () => {
    const file = path.join(dir, 'bom.jsonl');
    fs.writeFileSync(file, '\uFEFF{"messages":[]}\n');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonRes({ id: 'batch-1', status: 'validating' }));
    const job = await submitBatch(ep, file, '24h');
    expect(job.id).toBe('batch-1');
  });

  it('names the file and line when a line is not valid JSON', async () => {
    const file = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(file, '{"messages":[]}\n{"a":}\n');
    await expect(submitBatch(ep, file, '24h')).rejects.toThrow(`${file}:2:`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a line that is not a JSON object', async () => {
    const file = path.join(dir, 'arr.jsonl');
    fs.writeFileSync(file, '{"messages":[]}\n[1,2]\n');
    await expect(submitBatch(ep, file, '24h')).rejects.toThrow(
      `${file}:2: each line must be a JSON object`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps custom_id aligned to the file line numbering across blank lines', async () => {
    const file = path.join(dir, 'blanks.jsonl');
    fs.writeFileSync(
      file,
      '{"messages":[{"role":"user","content":"one"}]}\n\n{"messages":[{"role":"user","content":"three"}]}\n',
    );
    fetchMock
      .mockResolvedValueOnce(jsonRes({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonRes({ id: 'batch-1', status: 'validating' }));
    await submitBatch(ep, file, '24h');
    const form = fetchMock.mock.calls[0][1].body as FormData;
    const lines = (await (form.get('file') as Blob).text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { custom_id: string });
    expect(lines.map((l) => l.custom_id)).toEqual(['0', '2']);
  });

  it('deletes the uploaded file and names its id when the create fails', async () => {
    // The upload is already a billed object by the time create runs; a
    // failed create must not orphan it, and the id is the only handle.
    const file = path.join(dir, 'in.jsonl');
    fs.writeFileSync(file, '{"messages":[]}\n');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ id: 'file-9' }))
      .mockResolvedValueOnce(new Response('quota', { status: 500 }));
    await expect(submitBatch(ep, file, '24h')).rejects.toThrow('HTTP 500');
    const deletes = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'DELETE')
      .map(([url]) => url);
    expect(deletes).toEqual(['https://x/v1/files/file-9']);
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('file-9'),
    );
  });

  it('refuses to fetch an unsettled batch', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ id: 'b', status: 'in_progress', created_at: 0 }),
    );
    await expect(fetchBatch(ep, 'b', dir, false)).rejects.toThrow(
      'b is in_progress',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('writes output and error files and deletes remote files on request', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({
          id: 'b',
          status: 'completed',
          created_at: 0,
          input_file_id: 'in',
          output_file_id: 'out',
          error_file_id: 'err',
        }),
      )
      .mockResolvedValueOnce(new Response('{"custom_id":"0"}\n'))
      .mockResolvedValueOnce(new Response('{"custom_id":"1"}\n'))
      .mockResolvedValue(jsonRes({ deleted: true }));

    const { written } = await fetchBatch(ep, 'b', dir, true);

    expect(written).toEqual([
      path.join(dir, 'b.output.jsonl'),
      path.join(dir, 'b.error.jsonl'),
    ]);
    expect(fs.readFileSync(written[1], 'utf8')).toBe('{"custom_id":"1"}\n');
    const deletes = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'DELETE')
      .map(([url]) => url);
    expect(deletes).toEqual([
      'https://x/v1/files/in',
      'https://x/v1/files/out',
      'https://x/v1/files/err',
    ]);
  });

  it('still reports a successful fetch when a remote delete fails', async () => {
    // The results are already on disk; a failed DELETE must not abort the
    // command before the written paths reach the user.
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({
          id: 'b',
          status: 'completed',
          created_at: 0,
          input_file_id: 'in',
          output_file_id: 'out',
        }),
      )
      .mockResolvedValueOnce(new Response('{"custom_id":"0"}\n'))
      .mockResolvedValueOnce(jsonRes({ deleted: true }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const { written } = await fetchBatch(ep, 'b', dir, true);

    expect(written).toEqual([path.join(dir, 'b.output.jsonl')]);
    expect(fs.readFileSync(written[0], 'utf8')).toBe('{"custom_id":"0"}\n');
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('could not delete remote file out'),
    );
  });
});
