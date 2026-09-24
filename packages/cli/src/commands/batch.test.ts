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
import { batchRequest } from './batch-client.js';
import {
  describeBatch,
  fetchBatch,
  getBatch,
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

  it('hoists a custom_id written on a bare body into the envelope', () => {
    // Otherwise the caller's own handle is both lost as the batch id (the
    // results can no longer be mapped back) and sent to the provider as an
    // unrecognised field inside the chat body.
    expect(
      toRequestLine({ custom_id: 'mine', messages: [] }, 3, 'qwen-plus'),
    ).toEqual({
      custom_id: 'mine',
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model: 'qwen-plus', messages: [] },
    });
  });

  it('rejects a full request line with no body instead of nesting the envelope', () => {
    // Read as a bare body, this line's declared method/url would be dropped
    // and silently rewritten to the defaults — the failure the check above
    // exists to prevent, reached from the other side.
    expect(() =>
      toRequestLine(
        { custom_id: 'doc-9', method: 'PUT', url: '/v1/embeddings' },
        0,
        'qwen-plus',
      ),
    ).toThrow(/custom_id doc-9: a full request line must carry a "body"/);
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
    // Pin the *phase* column (the one before `expires`), not a bare
    // `\tfailed\t`: describeBatch emits the status column unconditionally, so
    // that substring still passes with the SETTLED phase branch deleted.
    const failed = describeBatch(
      { id: 'b', status: 'failed', created_at: 100, in_progress_at: 130 },
      4000,
    );
    expect(failed).toContain('\tfailed\texpires');
    expect(failed).not.toMatch(/running|queued/);

    const expired = describeBatch(
      { id: 'b', status: 'expired', created_at: 100 },
      4000,
    );
    expect(expired).toContain('\texpired\texpires');
    expect(expired).not.toMatch(/running|queued/);

    const cancelled = describeBatch(
      { id: 'b', status: 'cancelled', created_at: 100, in_progress_at: 130 },
      4000,
    );
    expect(cancelled).toContain('\tcancelled\texpires');
    expect(cancelled).not.toMatch(/running|queued/);
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

  it('refuses a window the provider does not offer, before uploading anything', async () => {
    // Forwarding it verbatim costs a full upload to learn that 12h is not a
    // window — and the upload is the billable half of the mistake.
    const file = path.join(dir, 'in.jsonl');
    fs.writeFileSync(file, '{"messages":[{"role":"user","content":"hi"}]}\n');

    await expect(submitBatch(ep, file, '12h')).rejects.toThrow(
      '--window must be between 24h and 14d',
    );
    await expect(submitBatch(ep, file, '15d')).rejects.toThrow(
      '--window must be between 24h and 14d',
    );
    await expect(submitBatch(ep, file, 'soon')).rejects.toThrow(
      '--window must be a number followed by h or d',
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // The boundaries themselves are accepted.
    fetchMock
      .mockResolvedValueOnce(jsonRes({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonRes({ id: 'batch-1', status: 'validating' }));
    await expect(submitBatch(ep, file, '14d')).resolves.toMatchObject({
      id: 'batch-1',
    });
  });

  it('refuses a file over the request-count ceiling without uploading it', async () => {
    const file = path.join(dir, 'huge.jsonl');
    const line = '{"messages":[{"role":"user","content":"hi"}]}\n';
    fs.writeFileSync(file, line.repeat(50_001));

    await expect(submitBatch(ep, file, '24h')).rejects.toThrow(
      'more than 50000 requests',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a single request over the per-line ceiling', async () => {
    const file = path.join(dir, 'fat-line.jsonl');
    const content = 'x'.repeat(6 * 1024 * 1024 + 1);
    fs.writeFileSync(
      file,
      JSON.stringify({ messages: [{ role: 'user', content }] }) + '\n',
    );

    await expect(submitBatch(ep, file, '24h')).rejects.toThrow(
      'over the 6291456-byte per-line limit',
    );
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('deletes the uploaded file and names its id when the create is refused', async () => {
    // The upload is already a billed object by the time create runs; a 4xx is
    // the provider definitely refusing the job, so the input is an orphan.
    const file = path.join(dir, 'in.jsonl');
    fs.writeFileSync(file, '{"messages":[]}\n');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ id: 'file-9' }))
      .mockResolvedValueOnce(new Response('bad window', { status: 400 }));
    await expect(submitBatch(ep, file, '24h')).rejects.toThrow('HTTP 400');
    const deletes = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'DELETE')
      .map(([url]) => url);
    expect(deletes).toEqual(['https://x/v1/files/file-9']);
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('file-9'),
    );
  });

  it('keeps the uploaded file when the create fails ambiguously', async () => {
    // A 5xx (or a dropped socket) can arrive *after* the provider accepted
    // the job. Deleting the input then breaks a live, billing job whose id
    // was never reported, so the file is kept and the ambiguity is named.
    const file = path.join(dir, 'in.jsonl');
    fs.writeFileSync(file, '{"messages":[]}\n');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ id: 'file-9' }))
      .mockResolvedValueOnce(new Response('quota', { status: 500 }));
    await expect(submitBatch(ep, file, '24h')).rejects.toThrow('HTTP 500');
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
    ).toEqual([]);
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('may exist and be billing'),
    );
  });

  it('keeps the uploaded file when the create response body is unreadable', async () => {
    // A gateway that answers an accepted create with an HTML page: the job
    // exists, its id never reached us, and the input is its only local trace.
    const file = path.join(dir, 'in.jsonl');
    fs.writeFileSync(file, '{"messages":[]}\n');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ id: 'file-9' }))
      .mockResolvedValueOnce(
        new Response('<html><body>502</body></html>', { status: 200 }),
      );
    await expect(submitBatch(ep, file, '24h')).rejects.toThrow();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
    ).toEqual([]);
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('unreadable body'),
    );
  });

  it('rejects a file whose custom_id values collide', async () => {
    // Duplicate ids make the provider's output rows unmappable back to the
    // input, which is the one thing the docs tell users to do themselves.
    const file = path.join(dir, 'dupes.jsonl');
    fs.writeFileSync(
      file,
      '{"custom_id":"a","messages":[]}\n{"custom_id":"a","messages":[]}\n',
    );
    await expect(submitBatch(ep, file, '24h')).rejects.toThrow(
      `${file}:2: custom_id "a" is already used by line 1`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads a UTF-16LE input file (the PowerShell 5.1 `>` default)', async () => {
    // The BOM strip alone cannot help here: every character is NUL-padded, so
    // JSON.parse fails on line 1 with a message that does not name the cause.
    const file = path.join(dir, 'utf16.jsonl');
    fs.writeFileSync(file, '\uFEFF{"messages":[]}\n', 'utf16le');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ id: 'file-1' }))
      .mockResolvedValueOnce(jsonRes({ id: 'batch-1', status: 'validating' }));
    const job = await submitBatch(ep, file, '24h');
    expect(job.id).toBe('batch-1');
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(
      JSON.parse((await (form.get('file') as Blob).text()).trim()),
    ).toEqual({
      custom_id: '0',
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model: 'qwen-plus', messages: [] },
    });
  });

  it('names the remedy for a UTF-16BE input file it cannot decode', async () => {
    const file = path.join(dir, 'utf16be.jsonl');
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('{}')]),
    );
    await expect(submitBatch(ep, file, '24h')).rejects.toThrow(
      /UTF-16BE \(big-endian\) input is not supported/,
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

  it('leaves nothing under the final name when a download is cut short', async () => {
    // A truncated body written straight to `<id>.output.jsonl` looks complete:
    // its last line is still valid JSON, so the next fetch — and anything
    // consuming that directory — reads a short paid result as a finished one.
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({
          id: 'b',
          status: 'completed',
          created_at: 0,
          output_file_id: 'out',
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"custom_id":"0"}\n'),
              );
              controller.error(new Error('terminated'));
            },
          }),
          { status: 200 },
        ),
      );

    await expect(fetchBatch(ep, 'b', dir, false)).rejects.toThrow('terminated');
    expect(fs.existsSync(path.join(dir, 'b.output.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'b.output.jsonl.part'))).toBe(false);
  });

  it('refuses a batch id that is not a safe filename component', async () => {
    // The id becomes `<id>.output.jsonl` under outDir and a URL segment:
    // separators or dots-only prefixes would write outside the directory.
    await expect(fetchBatch(ep, '../escape', dir, false)).rejects.toThrow(
      /invalid batch id/,
    );
    await expect(fetchBatch(ep, 'a/b', dir, false)).rejects.toThrow(
      /invalid batch id/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an id that would move a status query off /batches', async () => {
    // `status` (and `cancel`) put the id in the URL next to the API key;
    // `../../x` would otherwise reach GET /x with the bearer token.
    await expect(getBatch(ep, '../../escaped-namespace')).rejects.toThrow(
      /invalid batch id/,
    );
    await expect(getBatch(ep, 'b?x=1')).rejects.toThrow(/invalid batch id/);
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
