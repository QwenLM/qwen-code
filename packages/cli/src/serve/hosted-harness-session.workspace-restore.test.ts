/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BOOT_ID,
  PROMPT_ID,
  SESSION_ID,
  app,
  domainEnablement,
  enforceInlineResourceLimit,
  expectFullStreamedAnswer,
  headers,
  hookPin,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server } from 'node:http';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionStoreHttpError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import { parseToolResultManifestBytes } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { HostedRestoreKeptBytes } from './hosted-restore-kept-bytes.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { ResourceToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import type { ShellPublisherDescriptor } from './managed-shell-publisher.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import * as stdio from '../utils/stdioHelpers.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import { LocalShellStreamCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-stream-capture.js';
import type { HistoryMaintenance } from '@qwen-code/qwen-code-core/managed-runtime/managed-history-maintenance-record.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  type DetachedFamily = 'child_run' | 'monitor_run';

  async function prewriteDetachedOutput(
    family: DetachedFamily,
    publication: boolean,
    childSessionKind?: 'child_agent' | 'workflow',
  ): Promise<void> {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const journalStore = new LocalJsonlManagedSessionJournalStore({
      runtimeBaseDir: state.root,
      sessionId: SESSION_ID,
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
    });
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore,
      resourceStore: resources,
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({
              engine: 'managed',
              sessionId: SESSION_ID,
              toolProfile: 'hosted-workspace-shell/1',
              ...(publication ? { captureBytes: 1024 * 1024 } : {}),
            }),
          ),
        ),
        rootSnapshotRef: await resources.publish(
          'managed-root',
          Buffer.from(JSON.stringify({ cwd: state.root })),
        ),
        createdBy: 'hosted-harness',
      },
    });
    // A DurableToolResultResourceStore honors the id-pinned publish the
    // segment store requires; this disk-backed double lands those bytes in
    // the same session resource root, so the /load route's own store reads
    // the exact layout a production write would have left.
    const durable: DurableToolResultResourceStore = {
      async publish(kind, bytes, resourceId = randomUUID()) {
        const directory = path.join(state.root, 'resources', SESSION_ID, kind);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(directory, resourceId), bytes);
        return {
          resourceId,
          kind,
          schemaVersion: 1,
          byteLength: bytes.byteLength,
          digest: createHash('sha256').update(bytes).digest('hex'),
        };
      },
      read: (ref) => resources.read(ref),
    };
    state.toolResults = durable;
    try {
      const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };
      const segmentStore = new ResourceToolResultSegmentStore(durable);
      const capture = new LocalShellStreamCapture(
        segmentStore,
        durable,
        {
          tenantId: key.tenantId,
          sessionId: key.sessionId,
          turnId: 'turn-1',
          executionCallId: 'bg-execution',
          callId: 'binding-1',
          invocationDigest: 'd'.repeat(64),
          bindingGeneration: '1',
          captureId: 'capture-1',
          revision: 1,
        } as const,
        async () => undefined,
        { segmentsPerPage: 512 },
      );
      const open = await capture.open();
      capture.setStarted(7);
      await capture.write('stdout', Buffer.from('hello output!'));
      await capture.finish('stdout', true);
      await capture.finish('stderr', true);
      const envelope = await capture.finalize('success', [], undefined, {
        exitCode: 0,
        signalName: null,
      });
      const tip = assertManagedSessionDurableRef(
        envelope.capture?.manifest as Parameters<
          typeof assertManagedSessionDurableRef
        >[0],
        'settled capture manifest',
      );
      expect(capture.currentManifest).toEqual(tip);
      if (family === 'child_run') {
        const childRuns = new HostedChildRunSession(
          { authority: managed.authority, resources: managed.resources },
          key,
        );
        await childRuns.admit({
          shellId: 'bg-1',
          ownerScopeId: key.sessionId,
          executionCallId: 'bg-execution',
          args: { command: 'printf hi', is_background: true },
        });
        await childRuns.dispatchStarted('bg-1', BINDING);
        await childRuns.attach('bg-1', BINDING, {
          unitName: 'qwen-bg-1',
          pid: 7,
          started: true,
        });
        await childRuns.advanceOutput('bg-1', open);
        await childRuns.advanceOutput('bg-1', tip);
        await childRuns.settleExited('bg-1', {
          exitCode: 0,
          exitSignal: null,
        });
      } else {
        const monitors = new HostedMonitorSession(
          { authority: managed.authority, resources: managed.resources },
          key,
        );
        await monitors.admit({
          monitorId: 'bg-1',
          ownerScopeId: key.sessionId,
          executionCallId: 'bg-execution',
          args: { command: 'tail -f build.log' },
          maxEvents: 100,
          idleTimeoutMs: 60_000,
          debounceMs: 1_000,
        });
        await monitors.dispatchStarted('bg-1', BINDING);
        await monitors.attach('bg-1', BINDING, { unitName: 'qwen-mon-1' });
        await monitors.advanceOutput('bg-1', open);
        await monitors.advanceOutput('bg-1', tip);
        await monitors.settleQuiet('bg-1', 'exited');
      }
      if (childSessionKind !== undefined) {
        // A child Session record (either kind) beside the detached shell
        // one: it owns no output manifest, so the workspace restore must
        // skip it rather than refuse the whole Session.
        const inputRef = await resources.publish(
          'managed-input',
          Buffer.from('{"prompt":"audit the diff"}'),
        );
        await managed.authority.commitExtensionRecord(
          {
            operation: 'commitExtensionRecord',
            commandId: 'agent-1',
            sessionKey: key,
            contentDigest: 'd'.repeat(64),
          },
          {
            domain: 'child_run',
            record: {
              kind: childSessionKind,
              childRunId: 'agent-1',
              ownerScopeId: key.sessionId,
              rootSessionId: key.sessionId,
              depth: 1,
              completion: 'sent',
              inputRef,
              workspaceMode: 'shared',
              workingDirectory: '.',
              childSessionId: null,
              predecessorChildRunId: null,
              resultVersion: 1,
              resultRef: null,
              terminalReceiptRef: null,
              stopReason: null,
              stopRequested: false,
              run: {
                state: 'admitted',
                reason: null,
                definition: {
                  definitionId: 'agent-def-1',
                  definitionRevision: 1,
                  definitionDigest: 'f'.repeat(64),
                },
                executionCallId: 'agent-call-1',
                effectId: null,
                dispatchId: null,
                deliveryId: null,
                execution: 'intent',
                runtime: null,
                delivery: { target: 'session', state: 'planned' },
              },
            },
          },
          { class: 'trusted_entry' },
        );
      }
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  async function loadDetachedSession() {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding-1',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'listStagedDeliveries',
    ).mockResolvedValue([]);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    return { server, loaded };
  }

  it.each([
    ['child_run' as DetachedFamily, false],
    ['child_run' as DetachedFamily, true],
    ['monitor_run' as DetachedFamily, false],
    ['monitor_run' as DetachedFamily, true],
  ])(
    'restores a Session whose settled %s output lineage includes history revisions (publication=%s)',
    async (family, publication) => {
      domainEnablement.childRun = true;
      domainEnablement.monitorRun = true;
      // Round-17 P2-1: a settled detached capture's lineage rides every
      // record revision into the verified population — its pending
      // history revisions are the ledger, and a detached capture never
      // had a foreground receipt. Neither fact may be read as corruption.
      await prewriteDetachedOutput(family, publication);
      const { server, loaded } = await loadDetachedSession();
      expect(loaded.status).toBe(200);
      expect(
        (
          await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
            'X-Qwen-Client-Id',
            loaded.body.clientId as string,
          )
        ).status,
      ).toBe(204);
    },
  );

  it.each(['child_agent', 'workflow'] as const)(
    'restores a Session whose detached lineage sits beside a %s record',
    async (childSessionKind) => {
      domainEnablement.childRun = true;
      // The child_run domain holds every kind at H4: the shell lineage must
      // still verify while a child Session record is skipped, not misparsed.
      await prewriteDetachedOutput('child_run', false, childSessionKind);
      const { server, loaded } = await loadDetachedSession();
      expect(loaded.status).toBe(200);
      expect(
        (
          await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
            'X-Qwen-Client-Id',
            loaded.body.clientId as string,
          )
        ).status,
      ).toBe(204);
    },
  );

  it('still refuses the restore when a detached capture loses page content', async () => {
    domainEnablement.childRun = true;
    await prewriteDetachedOutput('child_run', false);
    // The record's settled lineage is intact, but a page it names is gone
    // from the store: content verification must refuse, like any other
    // committed-resource loss.
    const walk = async (directory: string): Promise<string[]> => {
      const names: string[] = [];
      for (const entry of await readdir(directory, {
        withFileTypes: true,
      })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) names.push(...(await walk(full)));
        else names.push(full);
      }
      return names;
    };
    let removed = 0;
    for (const file of await walk(path.join(state.root, 'resources'))) {
      if ((await readFile(file, 'utf8')).includes('"type":"page"')) {
        await rm(file);
        removed += 1;
      }
    }
    expect(removed).toBeGreaterThan(0);
    const { loaded } = await loadDetachedSession();
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
  });

  it.each(['completed', 'model-error', 'execution-error'])(
    'closes the Shell publisher after a %s turn',
    async (ending) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'activeHoldRuntimeSessionIds',
      ).mockResolvedValue([]);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
        randomUUID(),
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      const execute = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'execute')
        .mockResolvedValue({
          executionStatus: 'not_started',
          responseParts: [],
          capture: null,
          error: { message: 'command validation failed' },
        });
      if (ending === 'execution-error')
        execute.mockRejectedValue(new Error('lost execution reply'));
      let descriptor: ShellPublisherDescriptor | undefined;
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'registerPublisher',
      ).mockImplementation(async (value) => {
        descriptor = value;
        return '1';
      });
      const close = vi.spyOn(HostedShellPublisher.prototype, 'close');
      const start = vi.spyOn(HostedShellPublisher.prototype, 'start');
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
        })
        .expect(200);
      const clientId = created.body.clientId as string;
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'run_shell_command',
          callId: 'shell',
          args: { command: 'printf hello' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        await toolTurn!.execute(
          [call],
          [
            {
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            },
          ],
          'test-model',
          signal,
        );
        await toolTurn!.consumeResults();
        if (ending === 'model-error') throw new Error('model failed');
        return { text: 'done', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'run command' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(
            ending === 'execution-error',
          );
        },
        { timeout: settleTimeoutMs() },
      );
      try {
        expect(descriptor).toBeDefined();
        expect(execute).toHaveBeenCalledOnce();
        // The publisher lives on the Session: a turn end never closes it.
        expect(close).not.toHaveBeenCalled();
        const answer = await fetch(descriptor!.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${descriptor!.token}` },
        });
        expect([200, 400, 409]).toContain(answer.status);
      } finally {
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        );
        // The Session's own close is what closes the publisher now.
        expect(close).toHaveBeenCalledOnce();
        for (const publisher of start.mock.contexts)
          await (publisher as HostedShellPublisher).close();
      }
    },
  );

  it('clears the active prompt and the session when Shell publisher cleanup never settles', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: { message: 'command validation failed' },
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
    const realClose = HostedShellPublisher.prototype.close;
    const server = await app(true);
    let closeCalls = 0;
    const parkedResumers: Array<() => void> = [];
    const start = vi.spyOn(HostedShellPublisher.prototype, 'start');
    let clientId = '';
    try {
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
        })
        .expect(200);
      clientId = created.body.clientId as string;
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'run_shell_command',
          callId: 'shell',
          args: { command: 'printf hello' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        await toolTurn!.execute(
          [call],
          [
            {
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            },
          ],
          'test-model',
          signal,
        );
        await toolTurn!.consumeResults();
        return { text: 'done', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'run command' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      // Availability clears first, exactly like the turn discipline
      // promises. The publisher is Session-scoped — nothing closes it at
      // the turn's end — so deletion follows the ⑤ ordering: it enters
      // the ordered drain, waits there while it is parked, and answers
      // once the drain completes.
      for (const publisher of start.mock.contexts) {
        (publisher as HostedShellPublisher).close = () => {
          closeCalls += 1;
          return new Promise<void>((resolve) => {
            parkedResumers.push(resolve);
          });
        };
      }
      expect(closeCalls).toBe(0);
      const deletion = headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).set('X-Qwen-Client-Id', clientId);
      // Supertest sends lazily: subscribing starts the request, so the drain
      // actually parks while we assert on it.
      void deletion.catch(() => undefined);
      await vi.waitFor(() => expect(closeCalls).toBe(1), {
        timeout: settleTimeoutMs(),
      });
      for (const resume of parkedResumers) resume();
      await deletion.expect(204);
    } finally {
      for (const resume of parkedResumers) resume();
      for (const publisher of start.mock.contexts) {
        const instance = publisher as HostedShellPublisher;
        instance.close = realClose;
        await realClose.call(instance);
      }
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('cold loads a workspace after a durable no-op context compression', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);
    const toolProfile = 'hosted-workspace-files/1';
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile,
    });
    expect(created.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .expect(204);
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      sessionId: SESSION_ID,
      sessionKey,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
    });
    const operationId = randomUUID();
    try {
      const admitted: HistoryMaintenance = {
        schemaVersion: 1,
        kind: 'context_compression',
        operationId,
        expectedCompactionRevision: 0,
        historyCutSequence: managed.authority.committedSequence,
        requestRef: await managed.resources.publish(
          'managed-message',
          Buffer.from('{}'),
        ),
        phase: 'admitted',
        attempt: 0,
        candidateRef: null,
        outcome: null,
        failureCode: null,
        compactionRevision: null,
        run: {
          state: 'admitted',
          reason: null,
          definition: null,
          executionCallId: null,
          effectId: null,
          dispatchId: null,
          deliveryId: null,
          execution: null,
          runtime: null,
          delivery: null,
        },
      };
      const generating: HistoryMaintenance = {
        ...admitted,
        phase: 'generating',
        attempt: 1,
        run: { ...admitted.run, state: 'running' },
      };
      const completed: HistoryMaintenance = {
        ...generating,
        phase: 'settled',
        outcome: 'noop',
        run: { ...generating.run, state: 'settled' },
      };
      for (const record of [admitted, generating, completed]) {
        await managed.authority.commitHistoryMaintenance(
          {
            operation: 'contextCompression',
            commandId: `${operationId}:${record.phase}`,
            sessionKey,
            contentDigest: createHash('sha256')
              .update(JSON.stringify(record))
              .digest('hex'),
          },
          { record },
          { class: 'harness', activation: managed.activation },
        );
      }
    } finally {
      await managed.close();
    }
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile });
    expect(loaded.status).toBe(200);
    const status = await headers(
      supertest(server).get(
        `/session/${SESSION_ID}/context/compressions/${operationId}`,
      ),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      operationId,
      status: 'completed',
      outcome: 'noop',
      compactionRevision: 0,
    });
    expect(state.model).not.toHaveBeenCalled();
  });

  it.each(['invalid todo body', 'missing todo ancestor'])(
    'refuses a workspace cold load with %s',
    async (fault) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const server = await app(true);
      const toolProfile = 'hosted-workspace-shell/1';
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
      });
      expect(created.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .expect(204);
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const managed = await openManagedSession({
        runtimeBaseDir: state.root,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        sessionId: SESSION_ID,
        sessionKey,
        cwd: state.root,
        version: 'hosted-harness/1',
        workerId: BOOT_ID,
        activationLeaseDurationMs: 60_000,
      });
      let missingRef: ManagedSessionDurableRef | undefined;
      try {
        const content = {
          todos:
            fault === 'invalid todo body'
              ? [{ id: 'a' }]
              : [{ id: 'a', content: 'Keep this task', status: 'pending' }],
        };
        const commitTodo = () =>
          managed.authority.commitDomainRecord(
            {
              operation: 'writeHostedTodos',
              commandId: randomUUID(),
              sessionKey,
              contentDigest: createHash('sha256')
                .update(JSON.stringify(content))
                .digest('hex'),
            },
            { domain: 'todo_state', content },
            { class: 'trusted_entry' },
          );
        const first = await commitTodo();
        if (fault === 'missing todo ancestor') {
          missingRef = { ...first.recordRef, resourceId: randomUUID() };
          const publish = managed.resources.publish.bind(managed.resources);
          const damaged = vi
            .spyOn(managed.resources, 'publish')
            .mockImplementation((kind, bytes) =>
              publish(
                kind,
                kind === 'managed-todo_state'
                  ? Buffer.from(
                      JSON.stringify({
                        ...JSON.parse(bytes.toString('utf8')),
                        previousRecordRef: missingRef,
                      }),
                    )
                  : bytes,
              ),
            );
          await commitTodo();
          damaged.mockRestore();
        }
      } finally {
        await managed.close();
      }
      const reads = vi.spyOn(
        LocalManagedSessionResourceStore.prototype,
        'read',
      );
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const refused = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(refused.body.reason).toBe('restore_verification_failed');
      if (fault === 'invalid todo body')
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining('Stored Hosted Todo state is invalid'),
        );
      else expect(reads).toHaveBeenCalledWith(missingRef);
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it('refuses a workspace cold load before another input when a committed resource is missing', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);
    const body = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    };
    const created = await headers(supertest(server).post('/session')).send(
      body,
    );
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const submitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(submitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    const original = LocalManagedSessionResourceStore.prototype.read;
    const damaged = vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    );
    damaged.mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      ref,
    ) {
      return ref.kind === 'managed-input'
        ? Promise.reject(new Error('missing committed input'))
        : original.call(this, ref);
    });
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('restore_verification_failed');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('missing committed input'),
    );
    log.mockRestore();
    expect(state.model).toHaveBeenCalledTimes(1);
    damaged.mockRestore();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it('reads each resource once on a workspace cold load, apart from the definition and the latest checkpoint', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);
    const toolProfile = 'hosted-workspace-files/1';
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile,
    });
    expect(created.status).toBe(200);
    for (const promptId of [PROMPT_ID, randomUUID()]) {
      const prompt = [{ type: 'text', text: `hello ${promptId}` }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', created.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
    }
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .expect(204);
    const reads = new Map<string, { kind: string; count: number }>();
    const read = LocalManagedSessionResourceStore.prototype.read;
    const counted = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockImplementation(function (
        this: LocalManagedSessionResourceStore,
        ref,
      ) {
        const entry = reads.get(ref.resourceId);
        reads.set(ref.resourceId, {
          kind: ref.kind,
          count: (entry?.count ?? 0) + 1,
        });
        return read.call(this, ref);
      });
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile });
    counted.mockRestore();
    expect(loaded.status).toBe(200);
    const kinds = new Set([...reads.values()].map(({ kind }) => kind));
    for (const kind of [
      'managed-message',
      'managed-checkpoint',
      'managed-input',
      'managed-turn-result',
    ])
      expect(kinds).toContain(kind);
    expect(
      [...reads.values()].filter(({ kind }) => kind === 'managed-checkpoint')
        .length,
    ).toBeGreaterThan(2);
    // The checkpoints and message bodies the restore verification reads
    // serve the checkpoint checks and the history projection too. Two reads
    // happen once per load whatever the history: the load route reads the
    // definition before the verification does, and the restore bundle reads
    // the latest checkpoint for its run authorization.
    expect(
      [...reads.values()].filter(
        ({ kind, count }) => count !== (kind === 'managed-definition' ? 2 : 1),
      ),
    ).toEqual([{ kind: 'managed-checkpoint', count: 2 }]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it('refuses a cold load when a settled file tool outcome is missing from its checkpoint', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'file contents' }],
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const server = await app(true);
    const body = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    };
    const created = await headers(supertest(server).post('/session')).send(
      body,
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'call',
        args: { file_path: 'a' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'read a' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    const original = LocalManagedSessionResourceStore.prototype.read;
    const damaged = vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    );
    damaged.mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      ref,
    ) {
      return ref.kind === 'managed-tool-outcome'
        ? Promise.reject(
            new Error(
              'missing settled tool outcome\nqwen serve: forged\x1b[2J',
            ),
          )
        : original.call(this, ref);
    });
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('restore_verification_failed');
    // The cause is Store-influenced text: the single-line tag must strip
    // newlines and control sequences rather than replay them to stderr.
    const verifyLine = `qwen serve: Hosted Session ${SESSION_ID} load refused (workspace_verify): Error: missing settled tool outcomeqwen serve: forged`;
    expect(log.mock.calls.map(([line]) => line)).toContain(verifyLine);
    expect(
      log.mock.calls
        .map(([line]) => line)
        .every((line) => line === stripAnsiAndControl(line)),
    ).toBe(true);
    expect(
      damaged.mock.calls.some(([ref]) => ref.kind === 'managed-tool-outcome'),
    ).toBe(true);
    expect(state.model).toHaveBeenCalledTimes(1);
    // The Store fault that fails the gate can take the seal down with it;
    // the tag must already be on record before close() runs.
    log.mockClear();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'close',
    ).mockRejectedValueOnce(new Error('seal lost'));
    const unsealed = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(unsealed.status).toBe(503);
    expect(unsealed.body.code).toBe('managed_session_open_failed');
    expect(log.mock.calls.map(([line]) => line)).toContain(verifyLine);
    damaged.mockRestore();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it('refuses a cold load when a complete empty Shell stream loses its seal', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);
    const body = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    };
    const created = await headers(supertest(server).post('/session')).send(
      body,
    );
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const sealedResources = new Map<string, Buffer>();
    state.toolResults = {
      async publish(kind, bytes, resourceId = randomUUID()) {
        const key = `${kind}/${resourceId}`;
        const previous = sealedResources.get(key);
        if (previous && !previous.equals(bytes))
          throw new Error('Resource conflict');
        sealedResources.set(key, Buffer.from(bytes));
        return {
          resourceId,
          kind,
          schemaVersion: 1,
          byteLength: bytes.length,
          digest: createHash('sha256').update(bytes).digest('hex'),
        };
      },
      async read(ref) {
        const bytes = sealedResources.get(`${ref.kind}/${ref.resourceId}`);
        return bytes ? Buffer.from(bytes) : resources.read(ref);
      },
    };
    const segments = new ResourceToolResultSegmentStore(state.toolResults);
    const captureId = randomUUID();
    const capture = new LocalShellResultCapture(segments, resources, {
      tenantId: 'tenant',
      sessionId: SESSION_ID,
      turnId: PROMPT_ID,
      executionCallId: randomUUID(),
      callId: 'call',
      invocationDigest: 'digest',
      bindingGeneration: '1',
      captureId,
      revision: 1,
    });
    capture.setStarted(1);
    capture.setProcessResult({
      rawOutput: Buffer.alloc(0),
      output: '',
      exitCode: 0,
      signal: null,
      error: null,
      aborted: false,
      pid: 1,
      executionMethod: 'child_process',
    });
    await Promise.all([
      capture.finish('stdout', true),
      capture.finish('stderr', true),
    ]);
    const envelope = await capture.finalize('success', []);
    expect(envelope.capture?.captureStatus).toBe('complete');
    const manifest = envelope.capture!.manifest!;
    await segments.close();
    const manifestBody = parseToolResultManifestBytes(
      await resources.read(manifest),
    );
    const reader = new ResourceToolResultSegmentStore(state.toolResults);
    expect(
      await reader.readRange({
        manifestRef: manifest,
        expectedIdentity: manifestBody,
        streamId: 'stdout',
        offset: 0,
        length: 0,
      }),
    ).toEqual({ status: 'ok', result: Buffer.alloc(0) });
    await reader.close();
    const events = LocalManagedSessionAuthority.prototype.eventsInSequenceRange;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'eventsInSequenceRange',
    ).mockImplementation(function (
      this: LocalManagedSessionAuthority,
      start,
      end,
    ) {
      return [
        ...events.call(this, start, end),
        {
          kind: 'tool.receipt',
          payload: { resultRef: manifest },
        } as unknown as ManagedSessionEvent,
      ];
    });
    const sealId = createHash('sha256')
      .update(JSON.stringify([captureId, 'stderr', 'seal']))
      .digest('hex');
    const sealKey = `managed-tool-result-content/${sealId}`;
    const seal = sealedResources.get(sealKey)!;
    expect(seal).toBeDefined();
    sealedResources.delete(sealKey);
    const read = vi.spyOn(state.toolResults, 'read');
    const handedOver = vi.spyOn(
      ManagedSessionRecordSink.prototype,
      'rememberMessageBody',
    );
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('restore_verification_failed');
    // The content check failed after the message bodies were verified, and a
    // load the checks refuse hands none of them to the shared body cache.
    expect(handedOver).not.toHaveBeenCalled();
    expect(
      read.mock.calls.map(([ref]) => [ref.kind, ref.resourceId]),
    ).toContainEqual(['managed-tool-result-content', sealId]);
    read.mockRestore();
    sealedResources.set(sealKey, seal);
    const reread = vi.spyOn(state.toolResults, 'read');
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(loaded.status).toBe(200);
    expect(handedOver.mock.calls.map(([ref]) => ref.kind)).toContain(
      'managed-message',
    );
    handedOver.mockRestore();
    // The verification read the manifest once, through the Session's
    // resources; its manifest check and both content reads use those bytes.
    expect(
      reread.mock.calls.filter(
        ([ref]) => ref.resourceId === manifest.resourceId,
      ),
    ).toEqual([]);
    expect(
      reread.mock.calls.map(([ref]) => [ref.kind, ref.resourceId]),
    ).toContainEqual(['managed-tool-result-content', sealId]);
    reread.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
    // Past its budget a manifest is read through the tool-result store again,
    // for the manifest check and for each content stream.
    const unkept = vi
      .spyOn(HostedRestoreKeptBytes.prototype, 'keep')
      .mockReturnValue(false);
    const fallback = vi.spyOn(state.toolResults, 'read');
    const reloaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(reloaded.status).toBe(200);
    expect(
      fallback.mock.calls.filter(
        ([ref]) => ref.resourceId === manifest.resourceId,
      ),
    ).toHaveLength(3);
    fallback.mockRestore();
    unkept.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      reloaded.body.clientId as string,
    );
  });

  it('keeps one restore cut while activation renewal advances the log', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    let renew: (() => Promise<unknown>) | undefined;
    let cut = 0;
    const restore = LocalManagedSessionAuthority.prototype.restoreBundle;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'restoreBundle',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      const bundle = await restore.call(this);
      renew = () => this.renewActivation({ leaseDurationMs: 60_000 });
      cut = bundle.throughSequence;
      return bundle;
    });
    const read = LocalManagedSessionResourceStore.prototype.read;
    let renewed = false;
    const reads = new Map<string, number>();
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      reference,
    ) {
      if (renew)
        reads.set(
          reference.resourceId,
          (reads.get(reference.resourceId) ?? 0) + 1,
        );
      if (renew && reference.kind === 'managed-root' && !renewed) {
        renewed = true;
        await renew();
      }
      return read.call(this, reference);
    });
    const projection = vi.spyOn(ManagedSessionRecordSink.prototype, 'project');
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(renewed).toBe(true);
    expect(reads.size).toBeGreaterThan(0);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(loaded.body.lastEventId).toBeGreaterThan(cut);
    expect(projection).toHaveBeenCalledWith(cut);
    expect(state.assertWritable).toHaveBeenCalledTimes(2);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it.each(['conflicting-ref', 'extension-domain'])(
    'refuses a cold load with %s in retained history',
    async (fault) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      });
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        created.body.clientId as string,
      );
      const events =
        LocalManagedSessionAuthority.prototype.eventsInSequenceRange;
      const damaged = vi
        .spyOn(LocalManagedSessionAuthority.prototype, 'eventsInSequenceRange')
        .mockImplementation(function (
          this: LocalManagedSessionAuthority,
          start,
          end,
        ) {
          return [
            ...events.call(this, start, end),
            {
              kind:
                fault === 'extension-domain'
                  ? 'domain.committed'
                  : 'tool.receipt',
              payload:
                fault === 'extension-domain'
                  ? { domain: 'unsupported' }
                  : {
                      resultRef: {
                        ...this.sessionHeader.rootSnapshotRef,
                        schemaVersion: 2,
                      },
                    },
            } as unknown as ManagedSessionEvent,
          ];
        });
      const refused = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(refused.body.reason).toBe('restore_verification_failed');
      expect(state.model).not.toHaveBeenCalled();
      damaged.mockRestore();
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        loaded.body.clientId as string,
      );
    },
  );

  it('fences an accepted delayed title and deduplicates a completed delivery', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const send = (title: string, managedRenameRevision: string) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/title`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ title, managedRenameRevision });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = LocalManagedSessionAuthority.prototype.commitDomainRecord;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockImplementation(function (
      this: LocalManagedSessionAuthority,
      command,
      request,
      actor,
    ) {
      if (request.content['managedRenameRevision'] === '1') {
        entered();
        return held.then(() => original.call(this, command, request, actor));
      }
      return original.call(this, command, request, actor);
    });
    const older = send('A', '1').then((response) => response);
    await waiting;
    await send('B', '2')
      .expect(200)
      .expect((response) =>
        expect(response.body.managedRenameRevision).toBe('2'),
      );
    release();
    expect((await older).status).toBe(409);
    const before = await readFile(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      'utf8',
    );
    await send('B', '2').expect(200);
    expect(
      await readFile(path.join(state.root, `${SESSION_ID}.jsonl`), 'utf8'),
    ).toBe(before);
    await send('A', '3').expect(200);
  });

  it.each([
    'hosted-workspace-files/1',
    'hosted-workspace-shell/1',
    'hosted-workspace-team-lead/1',
  ])(
    'loads a renamed %s Session and verifies its retained title resources',
    async (toolProfile) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
      });
      expect(created.status).toBe(200);
      for (const title of ['First title', 'Second title']) {
        await headers(supertest(server).post(`/session/${SESSION_ID}/title`))
          .set('X-Qwen-Client-Id', created.body.clientId as string)
          .send({ title })
          .expect(200);
      }
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        created.body.clientId as string,
      );
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        loaded.body.clientId as string,
      );
      const read = LocalManagedSessionResourceStore.prototype.read;
      const damaged = vi
        .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
        .mockImplementation(function (
          this: LocalManagedSessionResourceStore,
          reference,
        ) {
          return reference.kind === 'managed-session_metadata'
            ? Promise.reject(new Error('title resource missing'))
            : read.call(this, reference);
        });
      const refused = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(refused.body.reason).toBe('restore_verification_failed');
      expect(state.model).not.toHaveBeenCalled();
      damaged.mockRestore();
      const retry = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile });
      expect(retry.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        retry.body.clientId as string,
      );
    },
  );

  it('refuses attachment if writer ownership is lost during restore validation', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    state.assertWritable.mockRejectedValueOnce(new Error('writer lost'));
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('workspace_not_writable');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('writer lost'));
    // A write-probe failure during restore validation is a writer-lease
    // refusal, not a verification one.
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (workspace_writable): Error: writer lost`,
    );
    log.mockRestore();
    expect(state.model).not.toHaveBeenCalled();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  // A fenced writer fails the refusal's cleanup as well: the seal, and with
  // it possibly the activation release, reports the writer conflict. The load
  // must still answer that self-healing 409, whose wait the coordinator does
  // not charge to the retry budget, rather than the generic open failure.
  it.each([
    ['the seal fails', false],
    ['both the release and the seal fail', true],
  ])(
    'answers a writer conflict when %s while refusing a load',
    async (_label, releaseFails) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      });
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        created.body.clientId as string,
      );
      const conflict = () =>
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_writer_conflict',
          'Writer fenced',
        );
      const spies: Array<{ mockRestore(): void }> = [];
      // Armed by the refusal itself, so only the refusal's close fails.
      state.assertWritable.mockImplementationOnce(async () => {
        if (releaseFails)
          spies.push(
            vi
              .spyOn(
                LocalManagedSessionAuthority.prototype,
                'releaseActivation',
              )
              .mockRejectedValueOnce(conflict()),
          );
        spies.push(
          vi
            .spyOn(LocalManagedSessionAuthority.prototype, 'close')
            .mockRejectedValueOnce(conflict()),
        );
        throw new Error('writer lost');
      });
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      try {
        const refused = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('managed_session_writer_conflict');
        const lines = log.mock.calls.map(([line]) => String(line));
        expect(
          lines.some((line) => line.includes('close failed during open')),
        ).toBe(releaseFails);
      } finally {
        for (const spy of spies) spy.mockRestore();
        log.mockRestore();
      }
      expect(state.model).not.toHaveBeenCalled();
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        loaded.body.clientId as string,
      );
    },
  );

  it.each(['missing manifest', 'missing part', 'corrupt part'])(
    'rejects cold Workspace load with a %s and recovers intact bytes',
    async (damage) => {
      const text = '长😀'.repeat(25_000);
      state.model.mockImplementationOnce(async ({ textDeltas }) => {
        await textDeltas!.delta(text);
        return { text, model: 'test-model' };
      });
      await enforceInlineResourceLimit();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      });
      expect(created.status).toBe(200);
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', created.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript?limit=256`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expectFullStreamedAnswer(transcript.body, text);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .expect(204);

      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const kind =
        damage === 'missing manifest'
          ? 'managed-message-chunks'
          : 'managed-message-part';
      const directory = path.join(resources.sessionRoot, kind);
      const files = await readdir(directory);
      expect(files.length).toBeGreaterThan(0);
      const file = path.join(directory, files[0]);
      const original = await readFile(file);
      if (damage === 'corrupt part') {
        const corrupt = Buffer.from(original);
        corrupt[0] ^= 1;
        await writeFile(file, corrupt);
      } else {
        await rm(file);
      }

      const replacement = await app(true);
      const load = () =>
        headers(
          supertest(replacement).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
        });
      const rejected = await load();
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe('hosted_turn_recovery_required');

      await writeFile(file, original);
      const restored = await load();
      expect(restored.status).toBe(200);
      const cold = await headers(
        supertest(replacement).get(
          `/session/${SESSION_ID}/transcript?limit=256`,
        ),
      ).set('X-Qwen-Client-Id', restored.body.clientId as string);
      expectFullStreamedAnswer(cold.body, text);
      await headers(
        supertest(replacement).delete(`/session/${SESSION_ID}`),
      ).expect(204);
    },
  );

  it.each(['assistant', 'cancellation'] as const)(
    'rejects an oversized complete %s record before acquisition and permits retry and reload',
    async (mode) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const acquire = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockResolvedValue();
      const server = await app(true);
      const toolProfile = 'hosted-workspace-files/1';
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
      });
      expect(created.status).toBe(200);
      const writes = vi.spyOn(ManagedSessionRecordSink.prototype, 'write');
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'read_file',
          callId: 'call',
          args: { file_path: 'a' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        if (mode === 'cancellation') {
          const user = writes.mock.calls.find(
            ([record]) => record.type === 'user',
          )![0];
          const assistant = {
            ...user,
            uuid: randomUUID(),
            parentUuid: user.uuid,
            type: 'assistant',
            model: 'test-model',
            message: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: call.callId,
                    name: call.name,
                    args: call.args,
                  },
                },
              ],
            },
          };
          call.callId = 'c'.repeat(
            65_535 -
              Buffer.byteLength(JSON.stringify(assistant)) +
              call.callId.length,
          );
        }
        await toolTurn!.execute(
          [call],
          [
            ...(mode === 'assistant' ? [{ text: 'x'.repeat(65_100) }] : []),
            {
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            },
          ],
          'test-model',
          signal,
        );
        throw new Error('oversized record was accepted');
      });
      const prompt = [{ type: 'text', text: 'read a' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const clientId = created.body.clientId as string;
      const send = async (promptId: string) => {
        const response = await headers(
          supertest(server).post(`/session/${SESSION_ID}/prompt`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ prompt, promptId, payloadDigest });
        expect(response.status).toBe(202);
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
      };
      await send(PROMPT_ID);
      expect(acquire).not.toHaveBeenCalled();
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'turn_error', promptId: PROMPT_ID }),
        ]),
      );
      await send('44444444-4444-4444-8444-444444444444');
      expect(state.model).toHaveBeenCalledTimes(2);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        loaded.body.clientId as string,
      );
    },
  );

  it('omits settled output when only the complete tool result record exceeds the limit', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '55555555-5555-4555-8555-555555555555',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'x'.repeat(65_200) }],
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const publish = vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    let response: Record<string, unknown> | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'call',
        args: { file_path: 'a' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      const parts = await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      response = parts[0].functionResponse?.response;
      await toolTurn!.consumeResults();
      return { text: 'request a smaller range', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'read a' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    // The default 1s waitFor timeout races this turn's durable writes on
    // contended CI runners; the assertions are unchanged.
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(response?.['outputOmitted']).toBe(true);
    expect(response?.['executionStatus']).toBe('success');
    expect(release).toHaveBeenCalledOnce();
    for (const [, bytes] of publish.mock.calls)
      expect(bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
  });

  it.each([
    ['workspace_busy', false],
    ['workspace_unavailable', false],
    ['partial', false],
    ['managed_runtime_provider_operation_failed', false],
    ['runtime_control_operation_invalid', false],
    ['workspace_busy', true],
  ] as const)(
    'preserves the original Shell receipt and continuation across %s recovery (Hooks: %s)',
    async (refusalCode, hooks) => {
      const partial = refusalCode === 'partial';
      const captureStatus = partial
        ? ('partial' as const)
        : ('complete' as const);
      const captureReason = partial ? ('storage_failed' as const) : null;
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const key = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      const manifest = await resources.publish(
        'managed-tool-result-manifest',
        Buffer.from(
          JSON.stringify({
            toolResult: 'managed-tool-result/1',
            type: 'manifest',
            tenantId: key.tenantId,
            sessionId: SESSION_ID,
            turnId: PROMPT_ID,
            executionCallId: 'shell-execution',
            callId: 'model-shell-call',
            invocationDigest: 'digest',
            bindingGeneration: '1',
            captureId: randomUUID(),
            revision: 1,
            executionStatus: 'success',
            exitCode: 0,
            signal: null,
            captureScope: 'process_pipes',
            capturePolicy: 'complete_required',
            captureStatus,
            captureReason,
            upstreamTruncated: false,
            contents: ['stdout', 'stderr'].map((streamId) => ({
              streamId,
              role: streamId,
              mimeType: 'application/octet-stream',
              state: partial && streamId === 'stderr' ? 'incomplete' : 'sealed',
              byteLength: 0,
              digest: createHash('sha256').update('').digest('hex'),
              missingRanges: [],
              body: { pages: [] },
            })),
          }),
        ),
      );
      const envelope = {
        executionStatus: 'success' as const,
        responseParts: [{ text: 'hi' }],
        capture: {
          manifest,
          captureStatus,
          captureReason,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        },
      };
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      if (hooks)
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'hookControl',
        ).mockImplementation(async (operation) => ({
          operationId: operation.operationId,
          state: 'settled',
          catalog: { ...hookPin, hooks: [] },
        }));
      const acquire = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockImplementation(async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding-1',
            generation: '1',
            workspaceGeneration: '1',
          };
        });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
        executionCallId: 'shell-execution',
        runtimeBindingId: 'binding-1',
        bindingGeneration: '1',
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue(
        envelope,
      );
      const acknowledge = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acknowledgeV3')
        .mockRejectedValueOnce(
          new HostedWorkspaceBrokerRejection(409, 'runtime_execution_conflict'),
        )
        .mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      state.publicationRequest.mockImplementation(
        async (
          resourceStore: LocalManagedSessionResourceStore,
          route: string,
          body: unknown,
        ) => {
          if (route === '/grants') return { state: 'OPEN' };
          if (route === '/receipts/verify') return body;
          if (route.endsWith('/finished')) return { result: envelope };
          if (route.endsWith('/admissions/prepare'))
            return resourceStore.publish(
              'managed-tool-outcome',
              Buffer.from(JSON.stringify(body)),
            );
          throw new Error('Unexpected publication route ' + route);
        },
      );
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let failed = false;
      let failFinalSettlement = true;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, record) {
          if (!failed && record.type === 'tool_result') {
            failed = true;
            throw new Error('lost history write');
          }
          if (record.subtype === 'turn_result' && failFinalSettlement)
            throw new Error('lost final settlement');
          return originalWrite.call(this, record);
        },
      );
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'run_shell_command',
          callId: 'model-shell-call',
          args: { command: 'printf hi' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        await toolTurn!.execute(
          [call],
          [
            {
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            },
          ],
          'test-model',
          signal,
        );
        throw new Error('Expected a lost history write');
      });
      state.model.mockImplementationOnce(
        async ({ toolTurn, resumeFromToolResults }) => {
          expect(resumeFromToolResults).toHaveLength(1);
          await toolTurn!.consumeResults();
          return { text: 'resumed after Shell', model: 'test-model' };
        },
      );
      const first = await app(true);
      const created = await headers(supertest(first).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
        ...(hooks ? { hookCatalog: hookPin } : {}),
      });
      expect(created.status).toBe(200);
      const close = (target: Server, clientId: string) =>
        hooks
          ? headers(
              supertest(target).post(`/session/${SESSION_ID}/detach`),
            ).set('X-Qwen-Client-Id', clientId)
          : headers(supertest(target).delete(`/session/${SESSION_ID}`));
      const prompt = [{ type: 'text', text: 'run Shell' }];
      const payloadDigest =
        'sha256:' +
        createHash('sha256').update(JSON.stringify(prompt)).digest('hex');
      await headers(supertest(first).post('/session/' + SESSION_ID + '/prompt'))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(first).get('/session/' + SESSION_ID + '/status'),
          ).set('X-Qwen-Client-Id', created.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(failed).toBe(true);
      expect(acknowledge).not.toHaveBeenCalled();
      await close(first, created.body.clientId).expect(204);
      const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
      const releasedBefore = releases.mock.calls.length;
      const second = await app(true);
      const checkpointBefore = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      const prepare = vi.mocked(HostedWorkspaceBroker.prototype.prepareV3);
      const execute = vi.mocked(HostedWorkspaceBroker.prototype.executeV3);
      const acquireCount = acquire.mock.calls.length;
      for (const failure of [
        'missing page',
        'corrupt page',
        'missing segment',
        'corrupt segment',
        'missing empty seal',
      ]) {
        state.publicationRequest.mockRejectedValueOnce(new Error(failure));
        const refused = await headers(
          supertest(second).post('/session/' + SESSION_ID + '/load'),
        ).send({ managedSessionStore: store() });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_turn_recovery_required');
        expect(state.model).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledOnce();
        expect(acquire).toHaveBeenCalledTimes(acquireCount);
        expect(acknowledge).not.toHaveBeenCalled();
        const unchanged = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: key,
        });
        const recoverable = (events: ManagedSessionEvent[]) =>
          events.filter((event) =>
            [
              'message.committed',
              'checkpoint.committed',
              'tool.receipt',
            ].includes(event.kind),
          );
        expect(recoverable(unchanged.events)).toEqual(
          recoverable(checkpointBefore.events),
        );
      }
      const conflict = await headers(
        supertest(second).post('/session/' + SESSION_ID + '/load'),
      ).send({ managedSessionStore: store(), captureBytes: 512 });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('hosted_tool_profile_conflict');
      if (partial) {
        acknowledge.mockReset();
        acknowledge.mockResolvedValue();
        for (let attempt = 0; attempt < 2; attempt++) {
          const loaded = await headers(
            supertest(second).post('/session/' + SESSION_ID + '/load'),
          ).send({ managedSessionStore: store() });
          expect(loaded.status).toBe(409);
          expect(loaded.body.code).toBe('hosted_turn_recovery_required');
          expect(loaded.body.reason).toBe('publication_incomplete');
          expect(acknowledge).toHaveBeenLastCalledWith('shell-execution', {
            executionCallId: 'shell-execution',
            manifest,
            deliveryStatus: 'blocked',
            historyRevision: null,
          });
          expect(state.model).toHaveBeenCalledOnce();
          expect(prepare).toHaveBeenCalledOnce();
          expect(execute).toHaveBeenCalledOnce();
          expect(acquire).toHaveBeenCalledTimes(acquireCount);
        }
        const repaired = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: key,
        });
        expect(
          repaired.events.filter((event) => event.kind === 'tool.receipt'),
        ).toHaveLength(1);
        expect(
          repaired.events.filter(
            (event) =>
              event.kind === 'message.committed' &&
              event.payload['role'] === 'tool_result',
          ),
        ).toHaveLength(1);
        return;
      }
      const bindRefused = !refusalCode.startsWith('workspace_');
      const refusal = new HostedWorkspaceBrokerRejection(
        refusalCode === 'runtime_control_operation_invalid' ? 400 : 409,
        refusalCode,
      );
      if (bindRefused)
        vi.mocked(
          HostedWorkspaceBroker.prototype.fileHistory,
        ).mockRejectedValueOnce(refusal);
      else acquire.mockRejectedValueOnce(refusal);
      const refused = await headers(
        supertest(second).post('/session/' + SESSION_ID + '/load'),
      ).send({
        managedSessionStore: store(),
      });
      expect(refused.status).toBe(bindRefused ? 503 : 409);
      expect(refused.body.code).toBe(
        bindRefused ? 'managed_session_open_failed' : refusalCode,
      );
      if (!hooks) expect(releases).toHaveBeenCalledTimes(releasedBefore);
      expect(state.model).toHaveBeenCalledOnce();
      expect(acknowledge).toHaveBeenCalledOnce();
      const originalOwner = (execute.mock.contexts[0] as HostedWorkspaceBroker)
        .runtimeSessionId;
      expect(
        (acknowledge.mock.contexts[0] as HostedWorkspaceBroker)
          .runtimeSessionId,
      ).toBe(originalOwner);
      if (hooks) expect(originalOwner).not.toBe(PROMPT_ID);
      const checkpointAfter = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      expect(
        checkpointAfter.events.filter((event) => event.kind === 'tool.receipt'),
      ).toEqual(
        checkpointBefore.events.filter(
          (event) => event.kind === 'tool.receipt',
        ),
      );
      const savedCheckpoint = checkpointAfter.events.findLast(
        (event) => event.kind === 'checkpoint.committed',
      );
      expect(savedCheckpoint).toBeDefined();
      const stateRef = assertManagedSessionDurableRef(
        savedCheckpoint!.payload['stateRef'],
        'savedCheckpoint.stateRef',
      );
      const savedState = JSON.parse(
        (await resources.read(stateRef)).toString('utf8'),
      );
      expect(savedState.continuation.phase).toBe('results_ready');
      expect(savedState.tools.items[0]).toMatchObject({
        executionCallId: 'shell-execution',
        state: 'settled',
        consumed: false,
      });
      state.assertWritable
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('writer lost after recovery'));
      const ownerLost = await headers(
        supertest(second).post('/session/' + SESSION_ID + '/load'),
      ).send({ managedSessionStore: store() });
      expect(ownerLost.status).toBe(409);
      expect(ownerLost.body.code).toBe('hosted_turn_recovery_required');
      expect(ownerLost.body.reason).toBe('workspace_not_writable');
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('writer lost after recovery'),
      );
      expect(state.model).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      acknowledge.mockClear();
      acknowledge.mockRejectedValueOnce(
        new HostedWorkspaceBrokerRejection(409, 'runtime_execution_conflict'),
      );
      const loaded = await headers(
        supertest(second).post('/session/' + SESSION_ID + '/load'),
      ).send({
        managedSessionStore: store(),
      });
      expect(loaded.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(second).get('/session/' + SESSION_ID + '/status'),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(2);
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(
        (acknowledge.mock.contexts[0] as HostedWorkspaceBroker)
          .runtimeSessionId,
      ).toBe(originalOwner);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('runtime_execution_conflict'),
      );
      await close(second, loaded.body.clientId).expect(204);
      failFinalSettlement = false;
      const third = await app(true);
      const reopened = await headers(
        supertest(third).post('/session/' + SESSION_ID + '/load'),
      ).send({
        managedSessionStore: store(),
      });
      expect(reopened.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(third).get('/session/' + SESSION_ID + '/status'),
          ).set('X-Qwen-Client-Id', reopened.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(acknowledge).toHaveBeenCalledTimes(2);
      expect(state.model).toHaveBeenCalledTimes(2);
      const transcript = await headers(
        supertest(third).get('/session/' + SESSION_ID + '/transcript'),
      ).set('X-Qwen-Client-Id', reopened.body.clientId as string);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_complete',
            promptId: PROMPT_ID,
          }),
        ]),
      );
      await headers(supertest(third).delete('/session/' + SESSION_ID)).expect(
        204,
      );
      const project = vi.spyOn(ManagedSessionRecordSink.prototype, 'project');
      const fourth = await app(true);
      const settled = await headers(
        supertest(fourth).post('/session/' + SESSION_ID + '/load'),
      ).send({
        managedSessionStore: store(),
      });
      expect(settled.status).toBe(200);
      expect(acknowledge).toHaveBeenCalledTimes(2);
      expect(project).toHaveBeenCalledWith(expect.any(Number));
      await headers(supertest(fourth).delete('/session/' + SESSION_ID)).expect(
        204,
      );
    },
  );

  it('recovers a proven unstarted Shell after its history reply is lost', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
      executionCallId: 'shell-execution',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
    });
    const acknowledge = vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledgeV3',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    state.publicationRequest.mockImplementation(
      async (_resourceStore, route: string, body: { operation: string }) => {
        if (route !== '/grants')
          throw new Error('Unexpected publication route');
        return {
          state:
            body.operation === 'close_not_started' ? 'NOT_STARTED' : 'OPEN',
        };
      },
    );
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failed = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, record) {
        if (!failed && record.type === 'tool_result') {
          failed = true;
          await originalWrite.call(this, record);
          throw new Error('lost history reply');
        }
        return originalWrite.call(this, record);
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'run_shell_command',
        callId: 'model-shell-call',
        args: { command: 'printf hi' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      throw new Error('Expected a lost history reply');
    });
    state.model.mockImplementationOnce(
      async ({ toolTurn, resumeFromToolResults }) => {
        expect(resumeFromToolResults).toHaveLength(1);
        await toolTurn!.consumeResults();
        return { text: 'resumed after unstarted Shell', model: 'test-model' };
      },
    );
    const first = await app(true);
    const created = await headers(supertest(first).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'run Shell' }];
    await headers(supertest(first).post('/session/' + SESSION_ID + '/prompt'))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(first).get('/session/' + SESSION_ID + '/status'),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(failed).toBe(true);
    await headers(supertest(first).delete('/session/' + SESSION_ID)).expect(
      204,
    );
    const second = await app(true);
    const loaded = await headers(
      supertest(second).post('/session/' + SESSION_ID + '/load'),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
    });
    expect(loaded.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(second).get('/session/' + SESSION_ID + '/status'),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).toHaveBeenCalledTimes(2);
    expect(acknowledge).not.toHaveBeenCalled();
    await headers(supertest(second).delete('/session/' + SESSION_ID)).expect(
      204,
    );
  });
});
