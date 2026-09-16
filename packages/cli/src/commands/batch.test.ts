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
  resolveEndpoint,
  submitBatch,
  toRequestLine,
} from './batch.js';

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockResolve = vi.hoisted(() => vi.fn());

vi.mock('../config/settings.js', () => ({ loadSettings: mockLoadSettings }));
vi.mock('../utils/modelConfigUtils.js', () => ({
  getAuthTypeFromEnv: vi.fn(() => undefined),
  resolveCliGenerationConfig: mockResolve,
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
});
