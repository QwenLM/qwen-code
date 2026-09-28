/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
          receipt = { producerPhase: 'FINISHED' };
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
