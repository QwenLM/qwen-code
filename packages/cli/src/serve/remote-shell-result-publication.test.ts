/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolResultSegmentLedger } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import type { ManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';
import type { ManagedContextBoot } from './managed-context-envelope.js';
import { RemoteShellResultPublisher } from './remote-shell-result-publication.js';

const digest = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

const boot = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
} as unknown as ManagedContextBoot;
const binding = {
  publication: 'managed-tool-publication/1',
  publicationId: 'publication-a',
  sessionKey: {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
  },
  turnId: 'turn-a',
  executionCallId: 'execution-a',
  modelCallId: 'model-call-a',
  runtimeBindingId: 'binding-a',
  reference: {
    sessionId: 'runtime-a',
    promptId: 'runtime-a',
    callId: 'runtime-call-a',
    argsDigest: 'sha256:' + 'a'.repeat(64),
  },
  bindingGeneration: '1',
  captureId: 'capture-a',
  revision: 1,
  captureScope: 'process_pipes',
  capturePolicy: 'complete_required',
  argsRef: {
    resourceId: 'args-a',
    kind: 'managed-tool-input',
    schemaVersion: 1,
    byteLength: 2,
    digest: 'a'.repeat(64),
  },
  requestDigest: 'sha256:' + 'b'.repeat(64),
  writerId: 'writer-a',
  writerGeneration: 1,
  activationId: 'activation-a',
  activationEpoch: 1,
  intentSequence: 1,
  checkpointRef: {
    resourceId: 'checkpoint-a',
    kind: 'managed-checkpoint',
    schemaVersion: 1,
    byteLength: 2,
    digest: 'c'.repeat(64),
  },
};
const installation = {
  protocolVersion: 3,
  publication: 'managed-tool-publication/1',
  publicationId: 'publication-a',
  publicationToken: 'A'.repeat(43),
  serviceBaseUrl: 'http://127.0.0.1:4567/',
  binding,
};
const request = {
  reference: binding.reference,
  capture: {
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
    executionCallId: 'execution-a',
    bindingGeneration: '1',
    capturePolicy: 'complete_required' as const,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('remote Shell result publication', () => {
  it('publishes both raw streams, resources and the final envelope under one grant', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit) => {
        const path = decodeURIComponent(input.pathname);
        calls.push(path);
        expect(init.headers).toMatchObject({
          'X-Qwen-Tenant-Id': 'tenant-a',
          'X-Qwen-Tool-Publication-Token': 'A'.repeat(43),
        });
        const bytes = Buffer.from(init.body as Buffer);
        let receipt: Record<string, unknown>;
        if (path.endsWith('/segments/stdout/0')) {
          receipt = {
            captureId: 'capture-a',
            streamId: 'stdout',
            ordinal: 0,
            byteLength: bytes.length,
            digest: digest(bytes),
          };
        } else if (path.endsWith('/seal')) {
          receipt = JSON.parse(bytes.toString('utf8')) as Record<
            string,
            unknown
          >;
        } else if (path.includes('/resources/')) {
          const kind = path.split('/resources/')[1]!.split('/')[0]!;
          receipt = {
            resourceId: 'resource-' + calls.length,
            kind,
            schemaVersion: 1,
            byteLength: bytes.length,
            digest: digest(bytes),
          };
        } else if (path.endsWith('/finish')) {
          receipt = {
            producerPhase: 'FINISHED',
            terminal: { byteLength: bytes.length, digest: digest(bytes) },
          };
        } else {
          throw new Error(`Unexpected publication route ${path}`);
        }
        return new Response(JSON.stringify(receipt), { status: 200 });
      }),
    );
    const publisher = new RemoteShellResultPublisher();
    publisher.install(installation, boot);
    const { identity, sink } = await publisher.prepare(request);
    sink.setStarted(42);
    await sink.write('stdout', Buffer.from([0, 255, 0x61]));
    await sink.finish('stdout', true);
    await sink.finish('stderr', true);
    sink.setProcessResult({
      rawOutput: Buffer.alloc(0),
      output: '',
      exitCode: 0,
      signal: null,
      error: null,
      aborted: false,
      pid: 42,
      executionMethod: 'child_process',
    });
    const envelope = await sink.finalize('success', []);
    expect(envelope.capture?.captureStatus).toBe('complete');
    await publisher.finish(identity, envelope);
    expect(calls.filter((path) => path.includes('/segments/'))).toHaveLength(1);
    expect(calls.filter((path) => path.endsWith('/seal'))).toHaveLength(2);
    expect(calls.filter((path) => path.includes('/resources/'))).toHaveLength(
      2,
    );
    expect(calls.at(-1)).toMatch(/\/finish$/u);
    const terminalBytes = Buffer.from(JSON.stringify(envelope));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL) =>
        input.pathname.endsWith('/finish') &&
        !input.pathname.includes('/operations/')
          ? new Response(
              JSON.stringify({
                error: { code: 'managed_tool_result_conflict' },
              }),
              { status: 409 },
            )
          : new Response(
              JSON.stringify({
                state: 'SUCCEEDED',
                receipt: {
                  producerPhase: 'FINISHED',
                  terminal: {
                    byteLength: terminalBytes.length,
                    digest: digest(terminalBytes),
                  },
                },
              }),
              { status: 200 },
            ),
      ),
    );
    await publisher.finish(identity, envelope);
    await expect(
      publisher.finish(identity, {
        ...envelope,
        responseParts: [{ text: 'changed' }],
      }),
    ).rejects.toThrow('Publication finish was not confirmed.');
  });

  it('serializes concurrent stdout and stderr operations for one publication', async () => {
    let active = false;
    let busy = 0;
    let resources = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit) => {
        if (active) {
          busy++;
          return new Response(
            JSON.stringify({
              error: { code: 'managed_tool_publication_busy' },
            }),
            { status: 429 },
          );
        }
        active = true;
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const route = decodeURIComponent(input.pathname);
          const bytes = Buffer.from(init.body as Buffer);
          let receipt: Record<string, unknown>;
          if (route.includes('/segments/')) {
            const [, streamId, ordinal] =
              route.match(/\/segments\/(stdout|stderr)\/(\d+)$/u) ?? [];
            receipt = {
              captureId: 'capture-a',
              streamId,
              ordinal: Number(ordinal),
              byteLength: bytes.length,
              digest: digest(bytes),
            };
          } else if (route.endsWith('/seal')) {
            receipt = JSON.parse(bytes.toString('utf8')) as Record<
              string,
              unknown
            >;
          } else if (route.includes('/resources/')) {
            resources++;
            receipt = {
              resourceId: `resource-${resources}`,
              kind: route.split('/resources/')[1]!.split('/')[0],
              schemaVersion: 1,
              byteLength: bytes.length,
              digest: digest(bytes),
            };
          } else if (route.endsWith('/finish')) {
            receipt = {
              producerPhase: 'FINISHED',
              terminal: { byteLength: bytes.length, digest: digest(bytes) },
            };
          } else {
            throw new Error(`Unexpected publication route ${route}`);
          }
          return new Response(JSON.stringify(receipt), { status: 200 });
        } finally {
          active = false;
        }
      }),
    );
    const publisher = new RemoteShellResultPublisher();
    publisher.install(installation, boot);
    const { identity, sink } = await publisher.prepare(request);
    sink.setStarted(42);
    await Promise.all([
      sink.write('stdout', Buffer.alloc(1024 * 1024, 1)),
      sink.write('stderr', Buffer.alloc(1024 * 1024, 2)),
    ]);
    await Promise.all([
      sink.finish('stdout', true),
      sink.finish('stderr', true),
    ]);
    sink.setProcessResult({
      rawOutput: Buffer.alloc(0),
      output: '',
      exitCode: 0,
      signal: null,
      error: null,
      aborted: false,
      pid: 42,
      executionMethod: 'child_process',
    });
    const envelope = await sink.finalize('success', []);
    expect(envelope.capture?.captureStatus).toBe('complete');
    await publisher.finish(identity, envelope);
    expect(busy).toBe(0);
    expect(resources).toBe(3);
  });

  it('retries a busy publication with the original operation identity', async () => {
    let attempts = 0;
    const operationIds: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit) => {
        if (input.pathname.includes('/operations/'))
          return new Response(
            JSON.stringify({
              error: { code: 'managed_tool_publication_unknown' },
            }),
            { status: 404 },
          );
        attempts++;
        operationIds.push(
          (init.headers as Record<string, string>)[
            'X-Qwen-Tool-Publication-Operation'
          ],
        );
        if (attempts === 1)
          return new Response(
            JSON.stringify({
              error: { code: 'managed_tool_publication_busy' },
            }),
            { status: 429 },
          );
        const bytes = Buffer.from(init.body as Buffer);
        return new Response(
          JSON.stringify({
            captureId: 'capture-a',
            streamId: 'stdout',
            ordinal: 0,
            byteLength: bytes.length,
            digest: digest(bytes),
          }),
        );
      }),
    );
    const publisher = new RemoteShellResultPublisher();
    publisher.install(installation, boot);
    const { sink } = await publisher.prepare(request);
    const store = Reflect.get(sink, 'store') as ToolResultSegmentStore;
    expect(
      await store.publish({
        captureId: 'capture-a',
        streamId: 'stdout',
        ordinal: 0,
        bytes: Buffer.from('x'),
      }),
    ).toMatchObject({ status: 'ok' });
    expect(operationIds).toEqual(['seg-stdout-0', 'seg-stdout-0']);
  });

  it('rejects a grant for another Workspace before recording it', () => {
    const publisher = new RemoteShellResultPublisher();
    expect(() =>
      publisher.install(
        {
          ...installation,
          binding: {
            ...binding,
            sessionKey: { ...binding.sessionKey, workspaceId: 'other' },
          },
        },
        boot,
      ),
    ).toThrow('conflicts');
    expect(() => publisher.prepare(request)).toThrow('missing');
  });

  it('uses the first segment ordinal as each page slot', async () => {
    const routes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit) => {
        routes.push(decodeURIComponent(input.pathname));
        const bytes = Buffer.from(init.body as Buffer);
        return new Response(
          JSON.stringify({
            resourceId: 'resource-' + routes.length,
            kind: 'managed-tool-result-page',
            schemaVersion: 1,
            byteLength: bytes.length,
            digest: digest(bytes),
          }),
        );
      }),
    );
    const publisher = new RemoteShellResultPublisher();
    publisher.install(installation, boot);
    const { sink } = await publisher.prepare(request);
    const resources = Reflect.get(
      sink,
      'resources',
    ) as ManagedSessionResourceStore;
    for (const firstOrdinal of [0, 512]) {
      await resources.publish(
        'managed-tool-result-page',
        Buffer.from(JSON.stringify({ streamId: 'stdout', firstOrdinal })),
      );
    }
    expect(routes).toEqual([
      expect.stringContaining(
        '/resources/managed-tool-result-page/page:stdout:0',
      ),
      expect.stringContaining(
        '/resources/managed-tool-result-page/page:stdout:512',
      ),
    ]);
  });

  it('replays an installation with reordered JSON fields', () => {
    const publisher = new RemoteShellResultPublisher();
    publisher.install(installation, boot);
    expect(() =>
      publisher.install(
        {
          binding: {
            reference: { ...binding.reference },
            ...Object.fromEntries(
              Object.entries(binding).filter(([key]) => key !== 'reference'),
            ),
          },
          serviceBaseUrl: installation.serviceBaseUrl,
          publicationToken: installation.publicationToken,
          publicationId: installation.publicationId,
          publication: installation.publication,
          protocolVersion: installation.protocolVersion,
        },
        boot,
      ),
    ).not.toThrow();
  });

  it('reports exhausted capture capacity separately from storage failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit) => {
        const path = decodeURIComponent(input.pathname);
        if (path.includes('/segments/'))
          return new Response(
            JSON.stringify({
              error: {
                code: 'managed_tool_publication_quota_exhausted',
              },
            }),
            { status: 507 },
          );
        const bytes = Buffer.from(init.body as Buffer);
        if (path.includes('/resources/'))
          return new Response(
            JSON.stringify({
              resourceId: 'manifest-a',
              kind: 'managed-tool-result-manifest',
              schemaVersion: 1,
              byteLength: bytes.length,
              digest: digest(bytes),
            }),
          );
        throw new Error(`Unexpected publication route ${path}`);
      }),
    );
    const publisher = new RemoteShellResultPublisher();
    publisher.install(installation, boot);
    const { sink } = await publisher.prepare(request);
    sink.setStarted(42);
    await sink.write('stdout', Buffer.from('abc'));
    await sink.finish('stdout', true);
    await sink.finish('stderr', true);
    sink.setProcessResult({
      rawOutput: Buffer.alloc(0),
      output: '',
      exitCode: 0,
      signal: null,
      error: null,
      aborted: false,
      pid: 42,
      executionMethod: 'child_process',
    });
    const envelope = await sink.finalize('success', []);
    expect(envelope.capture?.captureStatus).toBe('unavailable');
    expect(envelope.capture?.captureReason).toBe('quota_exhausted');
  });
});

const fixtureSuite = JSON.parse(
  readFileSync(
    path.resolve(
      process.cwd(),
      '../core/src/managed-runtime/contracts/managed-tool-result-v1.fixtures.json',
    ),
    'utf8',
  ),
) as {
  segmentSequences: Array<{
    id: string;
    steps: Array<{
      op: 'publish' | 'seal' | 'prefix';
      request: Record<string, unknown>;
      expected: unknown;
    }>;
  }>;
};

it.each(fixtureSuite.segmentSequences)(
  'replays the original O1a segment sequence $id through the remote adapter',
  async ({ steps }) => {
    const ledger = new ToolResultSegmentLedger();
    const captures = new Map<string, string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit) => {
        const route = decodeURIComponent(input.pathname);
        const publicationId = route.match(/\/publications\/([^/]+)\//u)?.[1];
        const captureId = publicationId && captures.get(publicationId);
        if (!captureId) throw new Error('Unknown fixture publication.');
        const bytes = Buffer.from(init.body as Buffer);
        const segment = route.match(/\/segments\/([^/]+)\/([0-9]+)$/u);
        const stream = route.match(/\/streams\/([^/]+)\/(seal|prefix)$/u);
        let result;
        if (segment) {
          result = ledger.publish({
            captureId,
            streamId: segment[1],
            ordinal: Number(segment[2]),
            bytes,
            digest: (init.headers as Record<string, string>)[
              'X-Qwen-Tool-Segment-Digest'
            ],
          });
        } else if (stream?.[2] === 'seal') {
          result = ledger.seal({
            captureId,
            streamId: stream[1],
            ...JSON.parse(bytes.toString('utf8')),
          });
        } else if (stream?.[2] === 'prefix') {
          result = ledger.prefix({ captureId, streamId: stream[1] });
        } else {
          throw new Error('Unknown fixture route ' + route);
        }
        if (result.status === 'refused')
          return new Response(
            JSON.stringify({ error: { code: result.code } }),
            {
              status:
                result.code === 'managed_tool_result_conflict' ? 409 : 400,
            },
          );
        return new Response(
          JSON.stringify(
            segment
              ? { ...result.result, captureId, streamId: segment[1] }
              : result.result,
          ),
          { status: 200 },
        );
      }),
    );
    const publisher = new RemoteShellResultPublisher();
    const stores = new Map<string, ToolResultSegmentStore>();
    const storeFor = async (captureId: string) => {
      const selected = captureId === 'capture-02' ? captureId : 'capture-01';
      const existing = stores.get(selected);
      if (existing) return existing;
      const suffix = selected.slice(-2);
      const publicationId = 'publication-' + suffix;
      const executionCallId = 'execution-' + suffix;
      captures.set(publicationId, selected);
      publisher.install(
        {
          ...installation,
          publicationId,
          binding: {
            ...binding,
            publicationId,
            executionCallId,
            captureId: selected,
          },
        },
        boot,
      );
      const { sink } = await publisher.prepare({
        ...request,
        capture: { ...request.capture, executionCallId },
      });
      const store = Reflect.get(sink, 'store') as ToolResultSegmentStore;
      stores.set(selected, store);
      return store;
    };
    for (const step of steps) {
      const captureId = String(step.request['captureId'] ?? 'capture-01');
      const store = await storeFor(captureId);
      const raw = { ...step.request };
      if (step.op === 'publish') {
        const bytes = raw['bytes'] as
          | { base64: string }
          | { fill: { byte: number; length: number } }
          | undefined;
        if (bytes && 'base64' in bytes)
          raw['bytes'] = Buffer.from(bytes.base64, 'base64');
        else if (bytes && 'fill' in bytes)
          raw['bytes'] = Buffer.alloc(bytes.fill.length, bytes.fill.byte);
      }
      const actual = await store[step.op](raw);
      expect(actual).toEqual(step.expected);
    }
  },
);
