/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DaemonCapabilityMissingError,
  DaemonClient,
  DaemonHttpError,
  type DaemonMemoryImportPreview,
  type DaemonMemoryImportRequest,
  type DaemonMemoryImportSection,
  type DaemonMemoryImportSource,
  type DaemonMemoryImportTask,
  type WorkspaceDaemonClient,
} from '../../src/daemon/index.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';

const source: DaemonMemoryImportSource = {
  version: 1,
  source: 'codex',
  files: [{ path: 'MEMORY.md', content: '# Project\nUse focused tests.' }],
};
const section: DaemonMemoryImportSection = {
  id: 'section-1',
  groupId: 'group-1',
  title: 'Project',
  path: 'MEMORY.md',
  line: 1,
  content: source.files[0]!.content,
  references: [],
  suggestedScope: 'project',
  sourceProject: '/old/project',
  reason: 'Project guidance',
  selectable: true,
};
const preview: DaemonMemoryImportPreview = {
  version: 1,
  kind: 'preview',
  digest: 'digest-1',
  groups: [],
  sections: [section],
  warnings: [],
  estimate: {
    basis: 'source-only-with-context-reserve',
    modelCalls: 2,
    sourceTokens: 10,
    maxOutputTokens: 16_384,
    reservedTokens: 150_000,
    exceedsBudget: false,
    limits: {
      maxCalls: 32,
      maxReservedTokens: 512_000,
      batchSections: 8,
      sourceBytes: 65_536,
      contextBytes: 32_768,
      outputTokens: 8192,
      promptBytes: 32_768,
    },
  },
};
const task: DaemonMemoryImportTask = {
  version: 1,
  kind: 'task',
  id: 'batch-1',
  status: 'queued',
  createdAt: '2026-11-13T00:00:00Z',
  updatedAt: '2026-11-13T00:00:00Z',
  items: [{ id: section.id, scope: 'project', status: 'pending' }],
  usage: { modelCalls: 0, reservedTokens: 0 },
  budget: { maxCalls: 32, maxReservedTokens: 512_000 },
};
const request: DaemonMemoryImportRequest = {
  source,
  selection: [{ id: section.id, scope: 'project' }],
  idempotencyKey: 'stable-request-key',
};

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const operations: Array<{
  name: string;
  method: string;
  path: string;
  body?: unknown;
  response: unknown;
  status?: number;
  invoke: (workspace: WorkspaceDaemonClient) => Promise<unknown>;
}> = [
  {
    name: 'preview',
    method: 'POST',
    path: '/preview',
    body: source,
    response: preview,
    invoke: (ws) => ws.previewMemoryImport(source, 'ui-1'),
  },
  {
    name: 'submit',
    method: 'POST',
    path: '/batches',
    body: request,
    response: task,
    status: 202,
    invoke: (ws) => ws.submitMemoryImport(request, 'ui-1'),
  },
  {
    name: 'list',
    method: 'GET',
    path: '/batches',
    response: [task],
    invoke: (ws) => ws.listMemoryImports(),
  },
  {
    name: 'status',
    method: 'GET',
    path: '/batches/batch-1',
    response: task,
    invoke: (ws) => ws.getMemoryImport('batch-1'),
  },
  {
    name: 'source',
    method: 'GET',
    path: '/batches/batch-1/sources/section-1',
    response: section,
    invoke: (ws) => ws.getMemoryImportSource('batch-1', 'section-1'),
  },
  {
    name: 'cancel',
    method: 'POST',
    path: '/batches/batch-1/cancel',
    response: { ...task, status: 'cancelled' },
    invoke: (ws) => ws.cancelMemoryImport('batch-1', 'ui-1'),
  },
  {
    name: 'retry',
    method: 'POST',
    path: '/batches/batch-1/retry',
    response: task,
    status: 202,
    invoke: (ws) => ws.retryMemoryImport('batch-1', 'ui-1'),
  },
];

describe('workspace memory import', () => {
  it.each(operations)(
    '$name uses authenticated native REST for the selected workspace',
    async (operation) => {
      const restFetch = vi.fn(async () =>
        json(operation.response, operation.status),
      );
      const transportFetch = vi.fn(async (url: string) => {
        expect(url).toBe('http://daemon/base/capabilities');
        return json({ features: ['memory_import_v1'] });
      });
      const transport: DaemonTransport = {
        type: 'acp-http',
        connected: true,
        supportsReplay: true,
        fetch: transportFetch,
        async *subscribeEvents() {},
        dispose() {},
      };
      const client = new DaemonClient({
        baseUrl: 'http://daemon/base',
        token: 'test-token',
        fetch: restFetch,
        transport,
      });
      await expect(
        operation.invoke(client.workspaceById('secondary workspace')),
      ).resolves.toEqual(operation.response);
      expect(transportFetch).toHaveBeenCalledTimes(1);
      expect(restFetch).toHaveBeenCalledTimes(1);
      const [url, init] = restFetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(
        `http://daemon/base/workspaces/secondary%20workspace/memory/import${operation.path}`,
      );
      expect(init.method).toBe(operation.method);
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe('Bearer test-token');
      expect(headers.get('X-Qwen-Client-Id')).toBe(
        operation.method === 'POST' ? 'ui-1' : null,
      );
      expect(init.body).toBe(
        operation.body === undefined
          ? undefined
          : JSON.stringify(operation.body),
      );
      if (operation.body !== undefined)
        expect(headers.get('Content-Type')).toBe('application/json');
    },
  );

  it.each(operations)(
    '$name rejects an unsupported daemon',
    async (operation) => {
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        expect(url).toBe('http://daemon/capabilities');
        return json({ features: [] });
      });
      const ws = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
      }).workspaceById('secondary');
      await expect(operation.invoke(ws)).rejects.toBeInstanceOf(
        DaemonCapabilityMissingError,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('encodes workspace, batch, and section identifiers independently', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return json(
        url.endsWith('/capabilities')
          ? { features: ['memory_import_v1'] }
          : section,
      );
    });
    const ws = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
    }).workspaceByCwd('/work/项目 #1');
    await ws.getMemoryImportSource('batch/one?', 'section/#二');
    expect(fetch.mock.calls[1]![0]).toBe(
      'http://daemon/workspaces/%2Fwork%2F%E9%A1%B9%E7%9B%AE%20%231/memory/import/batches/batch%2Fone%3F/sources/section%2F%23%E4%BA%8C',
    );
  });

  it.each([
    [400, 'memory_import_rejected'],
    [404, 'memory_import_not_found'],
    [503, 'workspace_runtime_unavailable'],
    [503, 'memory_import_recovery_unavailable'],
    [500, 'memory_import_failed'],
  ])('preserves HTTP %s %s without falling back', async (status, code) => {
    const body = { code, error: 'Import request unavailable' };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/capabilities'))
        return json({ features: ['memory_import_v1'] });
      expect(url).toBe(
        'http://daemon/workspaces/secondary/memory/import/batches/batch-1',
      );
      return json(body, status, status === 503 ? { 'Retry-After': '1' } : {});
    });
    const ws = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
    }).workspaceById('secondary');
    const error = await ws
      .getMemoryImport('batch-1')
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DaemonHttpError);
    expect(error).toMatchObject({
      status,
      body,
      retryAfter: status === 503 ? '1' : undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not resubmit or replace the key after losing a submission response', async () => {
    const failure = new TypeError('Connection lost after acceptance');
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/capabilities'))
          return json({ features: ['memory_import_v1'] });
        expect(JSON.parse(init!.body as string)).toEqual(request);
        throw failure;
      },
    );
    const ws = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
    }).workspaceById('secondary');
    await expect(ws.submitMemoryImport(request)).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(request.idempotencyKey).toBe('stable-request-key');
  });
});
