/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolResultSegmentLedger } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  escapeShellArg,
  getShellConfiguration,
} from '@qwen-code/qwen-code-core/utils/shell-utils.js';
import type { ToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import type { ManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';
import type { ManagedContextBoot } from './managed-context-envelope.js';
import { RemoteShellResultPublisher } from './remote-shell-result-publication.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
} from './managed-runtime-tool-executor.js';

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
  it.each(['segment', 'finish'])(
    'recovers %s publication without repeating a real Shell side effect',
    async (fault) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-expiry-'));
      const marker = path.join(root, 'effects');
      const script = path.join(root, 'output.cjs');
      await fs.writeFile(
        script,
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write(Buffer.alloc(1048576));`,
      );
      const { shell } = getShellConfiguration();
      const input = {
        command: `${shell === 'powershell' ? '& ' : ''}${escapeShellArg(process.execPath, shell)} ${escapeShellArg(script, shell)}`,
        is_background: false,
      };
      const reference = {
        ...binding.reference,
        argsDigest: 'sha256:' + managedToolDigest(input),
      };
      let failedOperation: string | undefined;
      let recovered = false;
      let originalBytes: Buffer | undefined;
      let replayed = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: URL, init: RequestInit) => {
          const operation = (init.headers as Record<string, string>)[
            'X-Qwen-Tool-Publication-Operation'
          ];
          if (url.pathname.endsWith('/recover')) {
            expect(operation).toBe(failedOperation);
            recovered = true;
            return new Response(JSON.stringify({ state: 'RETRYABLE' }));
          }
          if (url.pathname.includes('/operations/'))
            return new Response(JSON.stringify({ state: 'EXPIRED' }));
          const bytes = Buffer.from(init.body as Buffer);
          const selected =
            fault === 'segment'
              ? url.pathname.includes('/segments/')
              : url.pathname.endsWith('/finish');
          if (selected && !failedOperation) {
            failedOperation = operation;
            originalBytes = Buffer.from(bytes);
            return new Response(
              JSON.stringify({
                error: { code: 'managed_tool_publication_operation_expired' },
              }),
              { status: 409 },
            );
          }
          if (operation === failedOperation) {
            expect(recovered).toBe(true);
            expect(bytes).toEqual(originalBytes);
            replayed = true;
          }
          const receipt = url.pathname.includes('/segments/')
            ? {
                captureId: 'capture-a',
                streamId: 'stdout',
                ordinal: 0,
                byteLength: bytes.length,
                digest: digest(bytes),
              }
            : url.pathname.endsWith('/seal')
              ? JSON.parse(bytes.toString('utf8'))
              : url.pathname.endsWith('/finish')
                ? {
                    producerPhase: 'FINISHED',
                    terminal: {
                      byteLength: bytes.length,
                      digest: digest(bytes),
                    },
                  }
                : {
                    resourceId: operation,
                    kind: url.pathname.split('/resources/')[1]!.split('/')[0],
                    schemaVersion: 1,
                    byteLength: bytes.length,
                    digest: digest(bytes),
                  };
          return new Response(JSON.stringify(receipt));
        }),
      );
      const publisher = new RemoteShellResultPublisher();
      publisher.install(
        { ...installation, binding: { ...binding, reference } },
        boot,
      );
      const executor = new ManagedToolExecutor(
        async () => createManagedToolSet(root, 'runtime-a'),
        publisher,
      );
      const execution = {
        ...request,
        reference,
        toolName: 'run_shell_command',
        input,
      };
      try {
        await executor.executeV3(execution);
        await vi.waitFor(
          () => expect(executor.statusV3(reference).state).toBe('settled'),
          { timeout: 10_000 },
        );
        expect(
          executor.statusV3(reference).result?.capture?.captureStatus,
        ).toBe('complete');
        expect(replayed).toBe(true);
        await executor.executeV3(execution);
        expect(await fs.readFile(marker, 'utf8')).toBe('x');
      } finally {
        await executor.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

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
              error: { code: 'managed_tool_publication_operation_unknown' },
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

  it.each(['http failure', 'lost request', 'non-JSON gateway failure'])(
    'replays an unknown operation after %s',
    async (failure) => {
      const attempts: Array<{ id: string; bytes: Buffer }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL, init: RequestInit) => {
          if (input.pathname.includes('/operations/'))
            return new Response(
              JSON.stringify({
                error: { code: 'managed_tool_publication_operation_unknown' },
              }),
              { status: 404 },
            );
          const bytes = Buffer.from(init.body as Buffer);
          attempts.push({
            id: (init.headers as Record<string, string>)[
              'X-Qwen-Tool-Publication-Operation'
            ],
            bytes,
          });
          if (attempts.length === 1) {
            if (failure === 'lost request')
              throw new TypeError('connection reset');
            if (failure === 'non-JSON gateway failure')
              return new Response('<html>gateway unavailable</html>', {
                status: 502,
              });
            return new Response(
              JSON.stringify({ error: { code: 'internal_error' } }),
              { status: 503 },
            );
          }
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
          bytes: Buffer.from('same bytes'),
        }),
      ).toMatchObject({ status: 'ok' });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toEqual(attempts[1]);
    },
  );

  it('waits through a failed status lookup before replaying the original segment', async () => {
    let posts = 0;
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit) => {
        if (input.pathname.includes('/operations/')) {
          reads++;
          return reads === 1
            ? new Response(
                JSON.stringify({ error: { code: 'internal_error' } }),
                { status: 503 },
              )
            : new Response(
                JSON.stringify({
                  error: { code: 'managed_tool_publication_operation_unknown' },
                }),
                { status: 404 },
              );
        }
        posts++;
        if (posts === 1)
          return new Response(
            JSON.stringify({ error: { code: 'internal_error' } }),
            { status: 503 },
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
        bytes: Buffer.from('replay'),
      }),
    ).toMatchObject({ status: 'ok' });
    expect(posts).toBe(2);
    expect(reads).toBe(2);
  });

  it('replays a failed server operation after its claim is released', async () => {
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit) => {
        if (input.pathname.includes('/operations/'))
          return new Response(JSON.stringify({ state: 'RETRYABLE' }));
        posts++;
        if (posts === 1)
          return new Response(
            JSON.stringify({ error: { code: 'internal_error' } }),
            { status: 503 },
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
        bytes: Buffer.from('replay'),
      }),
    ).toMatchObject({ status: 'ok' });
    expect(posts).toBe(2);
  });

  it('stops capture on a definite storage permission failure', async () => {
    let statusReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL) => {
        if (input.pathname.includes('/operations/')) statusReads++;
        return new Response(
          JSON.stringify({
            error: { code: 'managed_tool_publication_storage_denied' },
          }),
          { status: 403 },
        );
      }),
    );
    const publisher = new RemoteShellResultPublisher();
    publisher.install(installation, boot);
    const { sink } = await publisher.prepare(request);
    const store = Reflect.get(sink, 'store') as ToolResultSegmentStore;
    await expect(
      store.publish({
        captureId: 'capture-a',
        streamId: 'stdout',
        ordinal: 0,
        bytes: Buffer.from('denied'),
      }),
    ).rejects.toThrow('HTTP 403');
    expect(statusReads).toBe(0);
  });

  it.each([false, true])(
    'recovers an expired original segment with fixed bytes (lost recovery response: %s)',
    async (loseRecoveryReply) => {
      const posts: Buffer[] = [];
      let recovered = false;
      let recoveries = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL, init: RequestInit) => {
          expect(init.headers).toMatchObject({
            'X-Qwen-Tool-Publication-Operation': 'seg-stdout-0',
          });
          if (input.pathname.endsWith('/recover')) {
            expect(init.method).toBe('POST');
            recovered = true;
            recoveries++;
            if (loseRecoveryReply)
              throw new TypeError('lost recovery response');
            return new Response(JSON.stringify({ state: 'RETRYABLE' }));
          }
          if (input.pathname.includes('/operations/'))
            return new Response(
              JSON.stringify({ state: recovered ? 'RETRYABLE' : 'EXPIRED' }),
            );
          const bytes = Buffer.from(init.body as Buffer);
          posts.push(bytes);
          if (!recovered)
            return new Response(
              JSON.stringify({
                error: { code: 'managed_tool_publication_operation_expired' },
              }),
              { status: 409 },
            );
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
          bytes: Buffer.from('original'),
        }),
      ).toMatchObject({ status: 'ok' });
      expect(posts).toEqual([Buffer.from('original'), Buffer.from('original')]);
      expect(recoveries).toBe(1);
    },
  );

  it.each([
    'managed_tool_publication_claim_expired',
    'managed_tool_publication_claim_lost',
    'managed_tool_publication_busy',
  ])('resumes the original retryable segment after %s', async (code) => {
    const posts: Buffer[] = [];
    let observations = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL, init: RequestInit) => {
        expect(init.headers).toMatchObject({
          'X-Qwen-Tool-Publication-Operation': 'seg-stdout-0',
        });
        expect(input.pathname.endsWith('/recover')).toBe(false);
        if (input.pathname.includes('/operations/')) {
          observations++;
          return new Response(JSON.stringify({ state: 'RETRYABLE' }));
        }
        const bytes = Buffer.from(init.body as Buffer);
        posts.push(bytes);
        if (posts.length === 1)
          return new Response(JSON.stringify({ error: { code } }), {
            status: 409,
          });
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
        bytes: Buffer.from('original'),
      }),
    ).toMatchObject({ status: 'ok' });
    expect(posts).toEqual([Buffer.from('original'), Buffer.from('original')]);
    expect(observations).toBe(1);
  });

  it.each(
    ['EXPIRED', 'RETRYABLE'].flatMap((state) => [
      { state, status: 400, code: 'invalid_request' },
      { state, status: 409, code: 'managed_tool_result_conflict' },
    ]),
  )(
    'does not override HTTP $status $code with $state status',
    async ({ state, status, code }) => {
      let posts = 0;
      let observations = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL) => {
          expect(input.pathname.endsWith('/recover')).toBe(false);
          if (input.pathname.includes('/operations/')) {
            observations++;
            return new Response(JSON.stringify({ state }));
          }
          posts++;
          return new Response(JSON.stringify({ error: { code } }), { status });
        }),
      );
      const publisher = new RemoteShellResultPublisher();
      publisher.install(installation, boot);
      const { sink } = await publisher.prepare(request);
      const store = Reflect.get(sink, 'store') as ToolResultSegmentStore;
      const publication = store.publish({
        captureId: 'capture-a',
        streamId: 'stdout',
        ordinal: 0,
        bytes: Buffer.from('original'),
      });
      if (status === 400) {
        await expect(publication).rejects.toThrow('HTTP 400');
      } else {
        await expect(publication).resolves.toMatchObject({
          status: 'refused',
          code,
        });
      }
      expect(posts).toBe(1);
      expect(observations).toBe(1);
    },
  );

  it.each([409, 429])(
    'waits through HTTP %s recovery contention without consuming recovery attempts',
    async (status) => {
      const posts: Buffer[] = [];
      let recoveryRequests = 0;
      let recovered = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL, init: RequestInit) => {
          expect(init.headers).toMatchObject({
            'X-Qwen-Tool-Publication-Operation': 'seg-stdout-0',
          });
          if (input.pathname.endsWith('/recover')) {
            recoveryRequests++;
            if (recoveryRequests <= 4)
              return new Response(
                JSON.stringify({
                  error: { code: 'managed_tool_publication_busy' },
                }),
                { status },
              );
            recovered = true;
            return new Response(JSON.stringify({ state: 'RETRYABLE' }));
          }
          if (input.pathname.includes('/operations/'))
            return new Response(
              JSON.stringify({ state: recovered ? 'RETRYABLE' : 'EXPIRED' }),
            );
          const bytes = Buffer.from(init.body as Buffer);
          posts.push(bytes);
          if (!recovered)
            return new Response(
              JSON.stringify({
                error: { code: 'managed_tool_publication_operation_expired' },
              }),
              { status: 409 },
            );
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
          bytes: Buffer.from('original'),
        }),
      ).toMatchObject({ status: 'ok' });
      expect(posts).toEqual([Buffer.from('original'), Buffer.from('original')]);
      expect(recoveryRequests).toBe(5);
    },
  );

  it('bounds expired-attempt recovery instead of retrying forever', async () => {
    let recoveries = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL) => {
        if (input.pathname.endsWith('/recover')) recoveries++;
        if (input.pathname.includes('/operations/'))
          return new Response(JSON.stringify({ state: 'EXPIRED' }));
        return new Response(
          JSON.stringify({ error: { code: 'internal_error' } }),
          { status: 503 },
        );
      }),
    );
    const publisher = new RemoteShellResultPublisher();
    publisher.install(installation, boot);
    const { sink } = await publisher.prepare(request);
    const store = Reflect.get(sink, 'store') as ToolResultSegmentStore;
    await expect(
      store.publish({
        captureId: 'capture-a',
        streamId: 'stdout',
        ordinal: 0,
        bytes: Buffer.from('original'),
      }),
    ).rejects.toThrow('EXPIRED');
    expect(recoveries).toBe(3);
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
        if (route.includes('/operations/'))
          return new Response(
            JSON.stringify({
              error: { code: 'managed_tool_publication_operation_unknown' },
            }),
            { status: 404 },
          );
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
