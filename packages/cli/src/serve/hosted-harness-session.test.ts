/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import * as hostedHistory from './hosted-file-history.js';
import type { HostedFileHistoryState } from './hosted-file-history-protocol.js';
import {
  LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { SessionTranscriptChangedError } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { channelInputId } from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import { HostedChannelSession } from './hosted-channel-session.js';
import { commitHostedFileHistory } from './hosted-file-history.js';
import { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import { parseToolResultManifestBytes } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type {
  ManagedMcpControl,
  ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { parseMonitorRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { ResourceToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import type { ManagedSessionEvent } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  assertManagedSessionDurableRef,
  ManagedSessionRecordError,
  ManagedSessionWritesStoppedError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import {
  attributeShellReceipts,
  registerHostedHarnessSessionRoutes,
  settleCancelledHookTurn,
  settleCrashedWakeTurnAftermath,
} from './hosted-harness-session.js';
import {
  HostedHookRecoveryRequiredError,
  HostedHookSession,
} from './hosted-hook-session.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import type { ShellPublisherDescriptor } from './managed-shell-publisher.js';
import {
  HostedToolRecoveryRequiredError,
  hostedRuntimeSessionId,
  HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
import {
  HOSTED_APPROVAL_TIMEOUT_MS,
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
} from './hosted-tool-approval.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import * as stdio from '../utils/stdioHelpers.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import type {
  ManagedHookCatalog,
  ManagedHookControl,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedAutomationSession } from './hosted-automation-session.js';
import {
  AUTOMATION_INPUT_SOURCE,
  automationRunId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { HostedMonitorLoop } from './hosted-monitor-loop.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';
import { recoverHostedRuntimeTurn } from './hosted-runtime-recovery.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import { LocalShellStreamCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-stream-capture.js';
import { monitorWakeNeedsRecovery } from './hosted-monitor-wake-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';

const wakeDeps = vi.hoisted(() => ({
  last: undefined as unknown,
}));

const domainEnablement = vi.hoisted(() => ({
  childRun: false,
  monitorRun: false,
}));

vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js')
      >();
    return {
      ...actual,
      assertManagedSessionDomainEnabled: (
        domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
      ) => {
        if (domain === 'child_run' && domainEnablement.childRun) return;
        if (domain === 'monitor_run' && domainEnablement.monitorRun) return;
        actual.assertManagedSessionDomainEnabled(domain);
      },
      // H4b: record commits gate per kind, beside the admission mock.
      assertManagedSessionChildRunKindEnabled: (kind: string) => {
        if (!domainEnablement.childRun) {
          actual.assertManagedSessionChildRunKindEnabled(kind);
        }
      },
    };
  },
);

vi.mock('./hosted-monitor-wake-turn.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./hosted-monitor-wake-turn.js')>();
  return {
    ...actual,
    createMonitorWakeRunTurn: (params: never) => {
      wakeDeps.last = params;
      return actual.createMonitorWakeRunTurn(params as never);
    },
  };
});

const state = vi.hoisted(() => ({
  root: '',
  assertWritable: vi.fn(async () => undefined),
  toolResults: null as DurableToolResultResourceStore | null,
  publicationRequest: vi.fn(),
  storeOptions: [] as Array<Record<string, unknown>>,
  setLifecycleAuthority: vi.fn(),
  authorizeLifecycle: vi.fn(async () => undefined),
  authorizeOrdinary: vi.fn(async (_kind?: 'legacy-close') => undefined),
  model: vi.fn(
    async (_input: {
      signal: AbortSignal;
      toolTurn?: HostedWorkspaceToolTurn;
      hooks?: import('./hosted-hook-session.js').HostedHookSession;
      promptId?: string;
      modelScope?: import('@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js').ManagedHookModelScope;
      resumeFromToolResults?: readonly unknown[];
      textDeltas?: import('./hosted-text-deltas.js').HostedTextDeltaStream;
      workspaceContext?: { read(): string | undefined };
    }) => ({
      text: 'hello back',
      model: 'test-model',
    }),
  ),
}));

vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js')
    >()),
    HTTP_MANAGED_SESSION_STORE_CONTRACT: { maxInlineResourceBytes: 64 * 1024 },
    // The load route's catch classifies with instanceof against this class;
    // the wholesale module mock must still export it or the handler dies.
    ManagedSessionStoreHttpError: class ManagedSessionStoreHttpError extends Error {
      constructor(
        readonly status: number,
        readonly remoteCode: string,
        message: string,
      ) {
        super(message);
        this.name = 'ManagedSessionStoreHttpError';
      }
    },
    ManagedSessionStoreTransportError: class ManagedSessionStoreTransportError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ManagedSessionStoreTransportError';
      }
    },
    createHttpManagedSessionStores: (options: {
      baseUrl: string;
      sessionKey: { tenantId: string; workspaceId: string; sessionId: string };
    }) => {
      state.storeOptions.push(options);
      if (options.baseUrl.includes('rejected-store')) {
        throw new ManagedSessionRecordError(
          'baseUrl uses plaintext HTTP on a non-loopback host; writer tokens would cross the wire unencrypted. Pass allowInsecureHttp: true to opt in.',
        );
      }
      const resourceStore = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: options.sessionKey,
      });
      return {
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: options.sessionKey.sessionId,
          transcriptPath: path.join(
            state.root,
            `${options.sessionKey.sessionId}.jsonl`,
          ),
        }),
        resourceStore,
        toolResultResources: state.toolResults ?? resourceStore,
        assertWritable: state.assertWritable,
        setLifecycleAuthority: state.setLifecycleAuthority,
        authorizeOrdinary: state.authorizeOrdinary,
        authorizeLifecycle: state.authorizeLifecycle,
        publication: {
          owner: async () => ({ writerId: BOOT_ID, writerGeneration: 1 }),
          request: (route: string, body: unknown, token?: string) =>
            state.publicationRequest(resourceStore, route, body, token),
          rememberAdmission: () => undefined,
        },
        close: async () => undefined,
      };
    },
  }),
);
vi.mock('./hosted-harness-model.js', () => ({
  runHostedHarnessTextTurn: state.model,
}));

const BOOT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROMPT_ID = '33333333-3333-4333-8333-333333333333';

async function enforceInlineResourceLimit() {
  const actual = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js')
  >('@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js');
  const bounded = actual.createHttpManagedSessionStores({
    baseUrl: 'http://127.0.0.1:8080',
    writerId: BOOT_ID,
    sessionKey: {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    },
  }).resourceStore;
  const publish = LocalManagedSessionResourceStore.prototype.publish;
  vi.spyOn(
    LocalManagedSessionResourceStore.prototype,
    'publish',
  ).mockImplementation(async function (
    this: LocalManagedSessionResourceStore,
    kind,
    bytes,
  ) {
    await bounded.publish(kind, bytes);
    return publish.call(this, kind, bytes);
  });
}

function expectFullStreamedAnswer(
  page: {
    events: Array<{ type: string; data?: Record<string, unknown> }>;
    hasMore: boolean;
  },
  text: string,
) {
  expect(page.hasMore).toBe(false);
  const { events } = page;
  expect(events.filter((event) => event.type === 'turn_complete')).toHaveLength(
    1,
  );
  expect(events.filter((event) => event.type === 'turn_error')).toEqual([]);
  const deltas = events
    .filter((event) => event.type === 'session_update')
    .map((event) => {
      const update = event.data?.['update'] as
        | { sessionUpdate?: string; content?: { text?: string } }
        | undefined;
      return update?.sessionUpdate === 'agent_message_chunk'
        ? (update.content?.text ?? '')
        : '';
    });
  expect(deltas.filter(Boolean).length).toBeGreaterThan(1);
  expect(deltas.join('')).toBe(text);
  const records = events
    .filter((event) => event.type === 'managed_journal_event')
    .map((event) => event.data?.['record'] as ChatRecord | undefined);
  const answer = records.find(
    (record) =>
      record?.type === 'assistant' &&
      record.message?.parts?.some((part) => part.text === text),
  );
  expect(answer?.message?.parts).toEqual([{ text }]);
  expect(answer?.parentUuid).toEqual(expect.any(String));
  expect(answer?.daemonPromptId).toBe(PROMPT_ID);
}

const listeners = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...listeners].map(
      (listener) =>
        new Promise<void>((resolve) => {
          listener.close(() => resolve());
          listener.closeAllConnections();
        }),
    ),
  );
  listeners.clear();
});

async function app(withBroker = false) {
  const result = express();
  result.use(express.json());
  const contract = createHostedHarnessContract(
    `sha256:${'a'.repeat(64)}`,
    BOOT_ID,
  );
  installHostedHarnessContractMiddleware(result, contract);
  registerHostedHarnessSessionRoutes(
    result,
    contract,
    state.root,
    withBroker ? { baseUrl: 'http://127.0.0.1:1', token: 'test' } : undefined,
  );
  const listener = createServer(result);
  listeners.add(listener);
  // Match supertest's IPv4 URL; wildcard IPv6 can share an unrelated IPv4 port.
  await new Promise<void>((resolve) =>
    listener.listen(0, '127.0.0.1', resolve),
  );
  return listener;
}

function headers<T extends supertest.Test>(request: T): T {
  return request
    .set('X-Qwen-Harness-Protocol-Version', '1')
    .set('X-Qwen-Harness-Boot-Id', BOOT_ID);
}

function store() {
  return {
    baseUrl: 'http://store.test',
    tenantId: 'tenant',
    workspaceId: 'workspace',
    writerId: BOOT_ID,
    leaseDurationMs: 60_000,
  };
}

async function mcpApp(unknownConfigure = false, serverIds = ['demo']) {
  const requests: ManagedMcpControl[] = [];
  const replies = new Map<string, ManagedMcpOperationView>();
  const brokerOwners = new Set<string>();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      brokerOwners.add(this.runtimeSessionId);
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    },
  );
  vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'control').mockImplementation(
    async function (this: HostedWorkspaceBroker, operation) {
      if (!brokerOwners.has(this.runtimeSessionId))
        throw new Error('Runtime Session is not active in this Broker process');
      requests.push(operation);
      if (operation.kind === 'mcp-status' || operation.kind === 'mcp-cancel')
        return (
          replies.get(operation.targetOperationId) ?? {
            operationId: operation.targetOperationId,
            state: 'outcome_unknown',
          }
        );
      if (operation.kind === 'mcp-configure') {
        const settled: ManagedMcpOperationView = {
          operationId: operation.operationId,
          state: 'settled',
          catalog: {
            serverId: operation.serverId,
            serverRevision: operation.serverRevision,
            definitionDigest: operation.definitionDigest,
            configRevision: operation.configRevision,
            connectionGeneration: operation.configRevision,
            catalogRevision: operation.configRevision,
            tools: [],
            resources: [{ name: 'note', uri: 'memory://note' }],
            prompts: [{ name: 'greet' }],
            discovery: {
              tools: 'complete',
              resources: 'complete',
              prompts: 'complete',
            },
          },
        };
        replies.set(operation.operationId, settled);
        return unknownConfigure
          ? { operationId: operation.operationId, state: 'outcome_unknown' }
          : settled;
      }
      if (operation.kind === 'mcp-discover')
        return {
          ...replies.get(operation.grant.operationId)!,
          operationId: operation.operationId,
        };
      return (
        replies.get(operation.operationId) ?? {
          operationId: operation.operationId,
          state: 'settled',
          response: { contents: [] },
        }
      );
    },
  );
  const server = await app(true);
  const created = await headers(supertest(server).post('/session')).send({
    sessionId: SESSION_ID,
    sessionScope: 'thread',
    managedSessionStore: store(),
    toolProfile: 'hosted-workspace-mcp/1',
    mcpServers: serverIds.map((serverId) => ({
      serverId,
      serverRevision: 1,
      definitionDigest: 'a'.repeat(64),
    })),
  });
  expect(created.status).toBe(200);
  const authorize = (request: supertest.Test) =>
    headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
  return { server, authorize, requests, replies, brokerOwners };
}

const hookPin = {
  catalogId: 'test',
  catalogRevision: 1,
  definitionDigest: 'b'.repeat(64),
};
async function hookApp(asyncEnd = false) {
  const requests: ManagedHookControl[] = [];
  const catalog: ManagedHookCatalog = {
    ...hookPin,
    hooks: [
      HookEventName.Notification,
      HookEventName.SessionEnd,
      HookEventName.SessionDelete,
    ].map((eventName) => ({
      hookId: eventName,
      eventName,
      sequential: false,
      async: asyncEnd && eventName === HookEventName.SessionEnd,
      failClosed: true,
      onceKey: null,
      config: { type: 'command' as const },
    })),
  };
  vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
    async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    },
  );
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'authorizeLifecycle',
  ).mockResolvedValue();
  const release = vi
    .spyOn(HostedWorkspaceBroker.prototype, 'release')
    .mockResolvedValue();
  vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
    async (operation) => {
      requests.push(operation);
      if (operation.kind === 'hook-catalog')
        return {
          operationId: operation.operationId,
          state: 'settled',
          catalog: { ...catalog, ...operation.pin },
        };
      return {
        operationId: operation.operationId,
        state: 'settled',
        result: {
          success: true,
          outcome: 'success',
          duration: 0,
          output: { hookSpecificOutput: { additionalContext: 'checked' } },
        },
      };
    },
  );
  const server = await app(true);
  const definition = {
    sessionId: SESSION_ID,
    sessionScope: 'thread',
    managedSessionStore: store(),
    toolProfile: 'hosted-workspace-files/1',
    approvalMode: 'yolo',
    hookCatalog: hookPin,
  };
  const created = await headers(supertest(server).post('/session')).send(
    definition,
  );
  expect(created.status).toBe(200);
  const authorize = (request: supertest.Test) =>
    headers(request).set('X-Qwen-Client-Id', created.body.clientId);
  return {
    server,
    authorize,
    definition,
    catalog,
    requests,
    release,
    clientId: created.body.clientId,
  };
}

describe('attributeShellReceipts', () => {
  const input = (turnId: string, source = 'hosted-harness') =>
    ({
      kind: 'input.accepted',
      payload: { turnId, source },
    }) as unknown as ManagedSessionEvent;
  const receipt = () =>
    ({
      kind: 'tool.receipt',
      payload: { executionCallId: 'call' },
    }) as unknown as ManagedSessionEvent;

  it('attributes a receipt behind a queued monitor notification to the foreground prompt', () => {
    const { promptId, receipts } = attributeShellReceipts([
      input('prompt'),
      input('monitor:1:notify:1', 'monitor'),
      receipt(),
    ]);
    expect(promptId).toBe('prompt');
    expect(receipts.map((item) => item.promptId)).toEqual(['prompt']);
  });

  it('attributes a receipt behind a queued automation input to the foreground prompt', () => {
    // H6: an automation input is never a parked Turn either, so a receipt
    // behind its queued input still belongs to the occupied prompt.
    const { promptId, receipts } = attributeShellReceipts([
      input('prompt'),
      input('arun_1:input', AUTOMATION_INPUT_SOURCE),
      receipt(),
    ]);
    expect(promptId).toBe('prompt');
    expect(receipts.map((item) => item.promptId)).toEqual(['prompt']);
  });

  it('attributes a receipt behind a settled turn to no prompt at all', () => {
    const { promptId, receipts } = attributeShellReceipts([
      input('prompt'),
      receipt(),
      {
        kind: 'turn.settled',
        payload: { turnId: 'prompt' },
      } as unknown as ManagedSessionEvent,
      receipt(),
    ]);
    expect(promptId).toBeNull();
    expect(receipts.map((item) => item.promptId)).toEqual(['prompt']);
  });
});

describe('settleCancelledHookTurn', () => {
  it('does not count a queued monitor notification toward the parked turn', async () => {
    const events = [
      {
        kind: 'input.accepted',
        sequence: 5,
        payload: { turnId: 'prompt', source: 'hosted-harness' },
      } as unknown as ManagedSessionEvent,
      {
        kind: 'input.accepted',
        sequence: 7,
        payload: { turnId: 'monitor:1:notify:1', source: 'monitor' },
      } as unknown as ManagedSessionEvent,
    ];
    const extensionRecordsInDomain = vi.fn(() => []);
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 7,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain,
        },
        resources: { read: async () => Buffer.from('{}') },
        sink: { project: async () => [] },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await settleCancelledHookTurn(session);
    // The monitor input is never its own parked Turn, so the sole pending
    // turn is the prompt itself and the Hook execution scan actually ran
    // — with the notification counted, the early none-of-one exit would
    // leave this hook turn wedged forever.
    expect(extensionRecordsInDomain).toHaveBeenCalledWith('hook_execution');
  });

  it('does not count a queued automation input toward the parked turn', async () => {
    const events = [
      {
        kind: 'input.accepted',
        sequence: 5,
        payload: { turnId: 'prompt', source: 'hosted-harness' },
      } as unknown as ManagedSessionEvent,
      {
        kind: 'input.accepted',
        sequence: 7,
        payload: { turnId: 'arun_1:input', source: AUTOMATION_INPUT_SOURCE },
      } as unknown as ManagedSessionEvent,
    ];
    const extensionRecordsInDomain = vi.fn(() => []);
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 7,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain,
        },
        resources: { read: async () => Buffer.from('{}') },
        sink: { project: async () => [] },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await settleCancelledHookTurn(session);
    // Same arithmetic as the monitor notification: the queued automation
    // input is nobody's parked turn, so the prompt is the sole pending one.
    expect(extensionRecordsInDomain).toHaveBeenCalledWith('hook_execution');
  });

  it('settles a monitor wake that already started and parks', async () => {
    // A wake that started — the projection holds its records — and then
    // parked are its own settled owner: the cancelled settle must act.
    const events = [
      {
        kind: 'input.accepted',
        sequence: 7,
        payload: { turnId: 'monitor:1:notify:1', source: 'monitor' },
      } as unknown as ManagedSessionEvent,
    ];
    const extensionRecordsInDomain = vi.fn(() => []);
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 8,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain,
        },
        resources: { read: async () => Buffer.from('{}') },
        sink: {
          project: async () => [{ daemonPromptId: 'monitor:1:notify:1' }],
        },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await settleCancelledHookTurn(session);
    // Once the wake ran, its turn parks exactly like a prompt's: the
    // cancelled settle must own it, or the Session stays blocked and every
    // later prompt answers hosted_turn_recovery_required.
    expect(extensionRecordsInDomain).toHaveBeenCalledWith('hook_execution');
  });
});

describe('Hosted Harness no-tool session', () => {
  beforeEach(async () => {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'workspaceContext',
    ).mockResolvedValue([]);
    resetManagedRuntimeDispatchGatesForTest();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.toolResults = null;
    state.assertWritable.mockReset();
    state.assertWritable.mockResolvedValue(undefined);
    state.authorizeLifecycle.mockReset();
    state.authorizeLifecycle.mockResolvedValue(undefined);
    state.setLifecycleAuthority.mockReset();
    state.authorizeOrdinary.mockReset();
    state.authorizeOrdinary.mockResolvedValue(undefined);
    state.model.mockReset();
    state.publicationRequest.mockReset();
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  it.each(['close', 'delete'] as const)(
    'settles %s lifecycle Hooks once and retains the attachment until detach',
    async (kind) => {
      const { server, authorize, requests, release } = await hookApp();
      const operation = {
        kind,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
        authority: { operationId: 'op-l3', claimGeneration: 1 },
      };
      const first = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      ).send(operation);
      expect(first.status).toBe(200);
      expect(
        first.body.effects.map((effect: { event: string }) => effect.event),
      ).toEqual(
        kind === 'close' ? ['SessionEnd'] : ['SessionEnd', 'SessionDelete'],
      );
      expect(release).not.toHaveBeenCalled();
      const retry = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      ).send({
        ...operation,
        authority: { ...operation.authority, claimGeneration: 2 },
      });
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(
        requests
          .filter((request) => request.kind === 'hook-execute')
          .map((request) => request.input.hook_event_name),
      ).toEqual(
        kind === 'close' ? ['SessionEnd'] : ['SessionEnd', 'SessionDelete'],
      );
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({})
        .expect(409);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/cancel`))
        .send({})
        .expect(409);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({ authority: { operationId: 'op-l3', claimGeneration: 2 } })
        .expect(204);
      expect(release).toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'authorizes detach after the coordinator recovers effects without a Harness lifecycle request (clientId=%s)',
    async (withClientId) => {
      const { server, authorize, requests } = await hookApp();
      const transcriptPath = path.join(state.root, `${SESSION_ID}.jsonl`);
      const transcript = await readFile(transcriptPath, 'utf8');
      const releaseActivation = vi
        .spyOn(LocalManagedSessionAuthority.prototype, 'releaseActivation')
        .mockRejectedValue(new Error('journal appends are fenced'));
      state.authorizeOrdinary.mockRejectedValue(
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_lifecycle_active',
          'DRAINING',
        ),
      );
      const authority = {
        operationId: 'recovered-effects',
        claimGeneration: 2,
      };
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(404);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', 'wrong-client')
        .send({ authority })
        .expect(404);
      expect(state.authorizeLifecycle).not.toHaveBeenCalled();
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority })
        .expect(204);
      expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(authority);
      expect(state.authorizeLifecycle).toHaveBeenCalledExactlyOnceWith();
      expect(state.authorizeOrdinary).not.toHaveBeenCalled();
      expect(releaseActivation).not.toHaveBeenCalled();
      expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
      expect(requests).toEqual([]);
      expect(state.model).not.toHaveBeenCalled();
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({})
        .expect(404);
    },
  );

  it.each(['close', 'delete'] as const)(
    'adopts the original idle attachment for %s without reopening or replaying Hooks',
    async (kind) => {
      const { server, authorize, definition, requests, clientId } =
        await hookApp();
      const descriptorCount = state.storeOptions.length;
      const transcriptPath = path.join(state.root, `${SESSION_ID}.jsonl`);
      const transcript = await readFile(transcriptPath, 'utf8');
      state.assertWritable.mockClear();
      const authority = { operationId: 'adopt-original', claimGeneration: 1 };
      const load = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
          ...definition,
          lifecycleAuthority: authority,
        });
      const adopted = await load();
      expect(adopted.status).toBe(200);
      expect(adopted.body.clientId).toBe(clientId);
      expect(state.storeOptions).toHaveLength(descriptorCount);
      expect(state.assertWritable).toHaveBeenCalledTimes(1);
      expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
      expect(requests).toEqual([]);
      const operation = {
        kind,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
        authority,
      };
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      )
        .send(operation)
        .expect(200);
      expect((await load()).body.clientId).toBe(adopted.body.clientId);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      )
        .send(operation)
        .expect(200);
      expect(
        requests
          .filter((request) => request.kind === 'hook-execute')
          .map((request) => request.input.hook_event_name),
      ).toEqual(
        kind === 'close' ? ['SessionEnd'] : ['SessionEnd', 'SessionDelete'],
      );
      for (const route of ['prompt', 'cancel']) {
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/${route}`),
        ).expect(404);
        await headers(supertest(server).post(`/session/${SESSION_ID}/${route}`))
          .set('X-Qwen-Client-Id', randomUUID())
          .expect(404);
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/${route}`),
        ).expect(409);
      }
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', randomUUID())
        .expect(404);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
        409,
      );
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({ authority })
        .expect(204);
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each([
    { tenantId: 'foreign' },
    { workspaceId: 'foreign' },
    { writerToken: 'f'.repeat(40) },
    { baseUrl: 'http://foreign-store.test' },
    { writerId: randomUUID() },
  ])(
    'refuses lifecycle adoption with a different original grant: %s',
    async (changed) => {
      const { server, authorize, definition, requests } = await hookApp();
      state.assertWritable.mockClear();
      await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          ...definition,
          managedSessionStore: { ...store(), ...changed },
          lifecycleAuthority: { operationId: 'adopt', claimGeneration: 1 },
        })
        .expect(409);
      expect(state.assertWritable).not.toHaveBeenCalled();
      expect(state.setLifecycleAuthority).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(204);
    },
  );

  it('restores original authority after refused adoption and guards concurrent claims', async () => {
    const { server, authorize, definition, requests } = await hookApp();
    const load = (operationId: string) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        ...definition,
        lifecycleAuthority: { operationId, claimGeneration: 1 },
      });
    state.assertWritable.mockRejectedValueOnce(new Error('claim refused'));
    expect((await load('stale')).status).toBe(503);
    expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);
    let release!: () => void;
    state.assertWritable.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const pending = load('current').then((response) => response);
    await vi.waitFor(() => expect(release).toBeDefined());
    try {
      expect((await load('competing')).status).toBe(409);
      expect(requests).toEqual([]);
    } finally {
      release();
    }
    expect((await pending).status).toBe(200);
    expect((await load('other-operation')).status).toBe(409);
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send(definition)
      .expect(409);
    await headers(supertest(server).post('/session'))
      .send({
        ...definition,
        lifecycleAuthority: { operationId: 'create', claimGeneration: 1 },
      })
      .expect(400);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: { operationId: 'current', claimGeneration: 1 } })
      .expect(204);
  });

  it.each(['prompt', 'title', 'hooks/operations'])(
    'refuses a late ordinary %s preflight after lifecycle adoption',
    async (route) => {
      const { server, authorize, definition, requests } = await hookApp();
      const transcriptPath = path.join(state.root, `${SESSION_ID}.jsonl`);
      const before = await readFile(transcriptPath, 'utf8');
      let release!: () => void;
      state.authorizeOrdinary.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            release = () => resolve(undefined);
          }),
      );
      const prompt = [{ type: 'text', text: 'late request' }];
      const pending = authorize(
        supertest(server).post(`/session/${SESSION_ID}/${route}`),
      )
        .send(
          route === 'title'
            ? { title: 'late title' }
            : route === 'hooks/operations'
              ? {
                  operationId: 'ea17a7bc-b8d6-4f42-9e82-3859309fe92a',
                  event: 'Notification',
                  input: { message: 'late', notification_type: 'test' },
                }
              : {
                  prompt,
                  promptId: PROMPT_ID,
                  payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
                },
        )
        .then((response) => response);
      await vi.waitFor(() => expect(release).toBeDefined());
      try {
        await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({
            ...definition,
            lifecycleAuthority: { operationId: 'adopt', claimGeneration: 1 },
          })
          .expect(200);
      } finally {
        release();
      }
      const refused = await pending;
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_lifecycle_operation_active');
      expect(requests).toEqual([]);
      expect(state.model).not.toHaveBeenCalled();
      expect(await readFile(transcriptPath, 'utf8')).toBe(before);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({ authority: { operationId: 'adopt', claimGeneration: 1 } })
        .expect(204);
    },
  );

  it.each([true, false])(
    'retains the attachment and restores authority when a recovered detach claim is rejected (clientId=%s)',
    async (withClientId) => {
      const { server, authorize, requests } = await hookApp();
      state.authorizeOrdinary.mockRejectedValue(
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_lifecycle_active',
          'DRAINING',
        ),
      );
      state.authorizeLifecycle.mockRejectedValueOnce(new Error('stale claim'));
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority: { operationId: 'stale', claimGeneration: 1 } })
        .expect(503);
      expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);
      expect(requests).toEqual([]);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(409);
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority: { operationId: 'valid', claimGeneration: 2 } })
        .expect(204);
      expect(state.authorizeLifecycle).toHaveBeenCalledTimes(2);
      expect(requests).toEqual([]);
    },
  );

  it.each([true, false])(
    'rejects malformed detach authority without bypassing a persistent fence (clientId=%s)',
    async (withClientId) => {
      const { server, authorize, requests } = await hookApp();
      state.authorizeOrdinary.mockRejectedValue(
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_lifecycle_active',
          'DRAINING',
        ),
      );
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority: { operationId: 'malformed', claimGeneration: 0 } })
        .expect(400);
      expect(state.authorizeLifecycle).not.toHaveBeenCalled();
      expect(state.setLifecycleAuthority).not.toHaveBeenCalled();
      await (withClientId ? authorize : headers)(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .send({ authority: { operationId: 'valid', claimGeneration: 2 } })
        .expect(204);
      expect(requests).toEqual([]);
    },
  );

  it.each(['title', 'prompt'] as const)(
    'checks attachment identity before ordinary Store authorization for %s',
    async (route) => {
      const { server, authorize } = await hookApp();
      state.authorizeOrdinary.mockClear();
      for (const clientId of [undefined, 'wrong-client']) {
        const request = headers(
          supertest(server).post(`/session/${SESSION_ID}/${route}`),
        );
        if (clientId) request.set('X-Qwen-Client-Id', clientId);
        const rejected = await request.send({ title: 'renamed' });
        expect(rejected.status).toBe(404);
        expect(rejected.body.code).toBe('hosted_session_not_found');
        expect(state.authorizeOrdinary).not.toHaveBeenCalled();
      }
      await authorize(supertest(server).post(`/session/${SESSION_ID}/title`))
        .send({ title: 'renamed' })
        .expect(200);
      expect(state.authorizeOrdinary).toHaveBeenCalledOnce();
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(204);
    },
  );

  it('uses the legacy close admission for an attached protocol zero Session with Hooks', async () => {
    const { server, authorize, requests } = await hookApp();
    state.authorizeOrdinary.mockImplementation(async (kind) => {
      if (kind !== 'legacy-close')
        throw new ManagedSessionStoreHttpError(
          409,
          'managed_session_lifecycle_active',
          'Ordinary admission closed',
        );
    });
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({})
      .expect(409);
    await authorize(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
    expect(state.authorizeOrdinary).toHaveBeenLastCalledWith('legacy-close');
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd', 'SessionDelete']);
  });

  it.each([
    ['prompt', new TypeError('network timeout')],
    ['detach', new TypeError('network timeout')],
    [
      'prompt',
      new ManagedSessionStoreHttpError(
        503,
        'internal_error',
        'Store unavailable',
      ),
    ],
    [
      'detach',
      new ManagedSessionStoreHttpError(
        503,
        'internal_error',
        'Store unavailable',
      ),
    ],
    [
      'prompt',
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_writer_conflict',
        'Writer fenced',
      ),
    ],
    [
      'detach',
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_writer_conflict',
        'Writer fenced',
      ),
    ],
  ])(
    'reports an ordinary %s authorization failure as unavailable: %s',
    async (route, cause) => {
      const { server, authorize, requests } = await hookApp();
      state.authorizeOrdinary.mockRejectedValueOnce(cause);
      const rejected = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/${route}`),
      ).send({});
      expect(rejected.status).toBe(503);
      expect(rejected.body.code).toBe(
        'hosted_execution_authorization_unavailable',
      );
      expect(state.model).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(204);
    },
  );

  it.each([
    new TypeError('network timeout'),
    new ManagedSessionStoreHttpError(
      503,
      'internal_error',
      'Store unavailable',
    ),
    new ManagedSessionStoreHttpError(
      409,
      'managed_session_writer_conflict',
      'Writer fenced',
    ),
  ])(
    'cancels an active Turn despite ordinary authorization failure: %s',
    async (cause) => {
      const { server, authorize } = await hookApp();
      let signal!: AbortSignal;
      let finish!: () => void;
      state.model.mockImplementationOnce(
        (input) =>
          new Promise((resolve) => {
            signal = input.signal;
            finish = () => resolve({ text: '', model: 'test-model' });
            signal.addEventListener('abort', finish, { once: true });
          }),
      );
      const prompt = [{ type: 'text', text: 'wait for cancellation' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1));
      state.authorizeOrdinary.mockClear();
      state.authorizeOrdinary.mockRejectedValue(cause);
      try {
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/cancel`),
        ).expect(404);
        expect(signal.aborted).toBe(false);
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/cancel`),
        ).expect(204);
        expect(signal.aborted).toBe(true);
        expect(state.authorizeOrdinary).not.toHaveBeenCalled();
      } finally {
        finish();
      }
      await vi.waitFor(async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      });
      state.authorizeOrdinary.mockResolvedValue(undefined);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it('resumes the undispatched Delete Hook after revocation without cancelling or repeating End', async () => {
    const { server, authorize, requests } = await hookApp();
    let permitted = true;
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (request) => {
      const result = await original(request);
      if (request.kind === 'hook-execute') permitted = false;
      return result;
    });
    vi.mocked(
      HostedWorkspaceBroker.prototype.authorizeLifecycle,
    ).mockImplementation(async () => {
      if (!permitted) throw new Error('ACL revoked');
    });
    const operation = {
      kind: 'delete',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'op-revoked', claimGeneration: 1 },
    };
    const first = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
    ).send(operation);
    expect(first.status).toBe(503);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd']);
    vi.mocked(
      HostedWorkspaceBroker.prototype.authorizeLifecycle,
    ).mockResolvedValue();
    const retry = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
    ).send({
      ...operation,
      authority: { ...operation.authority, claimGeneration: 2 },
    });
    expect(retry.status).toBe(200);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd', 'SessionDelete']);
    expect(
      requests.filter((request) => request.kind === 'hook-cancel'),
    ).toHaveLength(0);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: { operationId: 'op-revoked', claimGeneration: 2 } })
      .expect(204);
  });

  it('waits for an async End child to settle before dispatching Delete', async () => {
    const { server, authorize, requests } = await hookApp(true);
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    let endSettled = false;
    control.mockImplementation(async (request) => {
      if (
        !endSettled &&
        (request.kind === 'hook-status' ||
          (request.kind === 'hook-execute' &&
            request.input.hook_event_name === HookEventName.SessionEnd))
      ) {
        requests.push(request);
        return { operationId: request.operationId, state: 'running' };
      }
      return original(request);
    });
    const operation = {
      kind: 'delete',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'async-end', claimGeneration: 1 },
    };
    try {
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      )
        .send(operation)
        .expect(503);
      expect(
        requests
          .filter((request) => request.kind === 'hook-execute')
          .map((request) => request.input.hook_event_name),
      ).toEqual(['SessionEnd']);
    } finally {
      endSettled = true;
    }
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        ...operation,
        authority: { operationId: 'async-end', claimGeneration: 2 },
      })
      .expect(200);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd', 'SessionDelete']);
    expect(
      requests.filter((request) => request.kind === 'hook-cancel'),
    ).toEqual([]);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: { operationId: 'async-end', claimGeneration: 2 } })
      .expect(204);
  });

  it('allows the valid operation after an invalid lifecycle claim is rejected', async () => {
    const { server, authorize, requests } = await hookApp();
    state.authorizeLifecycle.mockRejectedValueOnce(new Error('stale claim'));
    const operation = {
      kind: 'close',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'invalid', claimGeneration: 1 },
    };
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send(operation)
      .expect(503);
    expect(requests).toHaveLength(0);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        ...operation,
        kind: 'delete',
        authority: { operationId: 'valid', claimGeneration: 2 },
      })
      .expect(200);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd', 'SessionDelete']);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: { operationId: 'valid', claimGeneration: 2 } })
      .expect(204);
  });

  it('keeps an unknown End blocked without cancelling or redispatching it on takeover', async () => {
    const { server, authorize, requests } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (request) => {
      if (request.kind === 'hook-catalog') return original(request);
      requests.push(request);
      return { operationId: request.operationId, state: 'outcome_unknown' };
    });
    const operation = {
      kind: 'delete',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'unknown-delete', claimGeneration: 1 },
    };
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send(operation)
      .expect(503);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        ...operation,
        authority: { ...operation.authority, claimGeneration: 2 },
      })
      .expect(503);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input.hook_event_name),
    ).toEqual(['SessionEnd']);
    expect(
      requests.filter((request) => request.kind === 'hook-cancel'),
    ).toHaveLength(0);
    expect(state.model).not.toHaveBeenCalled();
    control.mockImplementation(original);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({
        authority: { operationId: 'unknown-delete', claimGeneration: 2 },
      })
      .expect(204);
  });

  it('refuses a new prompt while the journal close is still sealing', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = LocalJsonlManagedSessionJournalHandle.prototype.seal;
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'seal',
    ).mockImplementation(async function (
      this: LocalJsonlManagedSessionJournalHandle,
      commit,
    ) {
      entered();
      await gate;
      await original.call(this, commit);
    });
    const closing = headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).then((response) => response);
    await started;
    try {
      const prompt = [{ type: 'text', text: 'late input' }];
      const rejected = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        });
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe('hosted_session_closing');
      expect(state.model).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect((await closing).status).toBe(204);
  });

  const AUTOMATION_ID = `asch_${'1'.repeat(32)}`;
  const AUTOMATION_SLOT = 'schedule:2026-03-08T07:00:00Z';
  const automationDefinition = {
    goal: 'Nightly build',
    cron: '0 2 * * *',
    timezone: 'Asia/Shanghai',
    prompt: 'Run the build.',
  };
  const fireBody = (
    definitionRevision = 1,
    occurrenceKey = AUTOMATION_SLOT,
    trigger = 'scheduled',
  ) => ({
    kind: 'fire_run',
    scheduleId: AUTOMATION_ID,
    definitionRevision,
    occurrenceKey,
    trigger,
    firedAt: Date.parse('2026-03-08T07:00:05Z'),
  });

  it('defines, fires and settles an automation run through the operations route', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    const operations = (body: Record<string, unknown>) =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...body });
    // The route is the attached client's, like every Session mutation.
    const unattached = await headers(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({
      operationId: randomUUID(),
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: automationDefinition,
    });
    expect(unattached.status).toBe(404);
    // Malformed operations never reach the funnel.
    const noOperationId = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: automationDefinition,
    });
    expect(noOperationId.status).toBe(400);
    expect(noOperationId.body.code).toBe('invalid_automation_operation');
    expect(
      (
        await operations({
          kind: 'define_schedule',
          scheduleId: 'asch_nope',
          definition: automationDefinition,
        })
      ).status,
    ).toBe(400);
    expect(
      (await operations({ kind: 'define_schedule', scheduleId: AUTOMATION_ID }))
        .status,
    ).toBe(400);
    expect(
      (await operations({ kind: 'noop', scheduleId: AUTOMATION_ID })).status,
    ).toBe(400);
    expect(
      (await operations({ ...fireBody(1, ''), scheduleId: AUTOMATION_ID }))
        .status,
    ).toBe(400);
    expect(
      (await operations(fireBody(1, AUTOMATION_SLOT, 'webhook'))).status,
    ).toBe(400);
    expect((await operations({ ...fireBody(0) })).status).toBe(400);
    // An instant the turn text cannot render must die at admission, as a
    // request-shape error — not as a post-claim RangeError re-classified.
    const unrenderable = await operations({
      ...fireBody(),
      firedAt: Number.MAX_SAFE_INTEGER,
    });
    expect(unrenderable.status).toBe(400);
    expect(unrenderable.body.code).toBe('invalid_automation_operation');
    // Nothing defined yet: a fire is not found, not a 503.
    const missing = await operations(fireBody());
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('automation_not_found');
    // The mode gate and the contract answer their own codes.
    const perRun = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: { ...automationDefinition, sessionMode: 'per_run' },
    });
    expect(perRun.status).toBe(409);
    expect(perRun.body.code).toBe('automation_mode_disabled');
    const badCron = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: { ...automationDefinition, cron: '0 25 * * *' },
    });
    expect(badCron.status).toBe(400);
    expect(badCron.body.code).toBe('invalid_automation_operation');
    // Define: 202 with the committed definition; the same content replays.
    const defined = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: automationDefinition,
    });
    expect(defined.status).toBe(202);
    expect(defined.body).toMatchObject({
      state: 'settled',
      replayed: false,
      schedule: {
        scheduleId: AUTOMATION_ID,
        revision: 1,
        definitionRevision: 1,
        goal: 'Nightly build',
        sessionMode: 'persistent',
        targetSessionId: SESSION_ID,
        overlap: 'skip',
        catchUp: 'none',
        catchUpLimit: null,
        enabled: true,
        state: 'admitted',
      },
    });
    expect(typeof defined.body.operationId).toBe('string');
    const replayedDefine = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: automationDefinition,
    });
    expect(replayedDefine.status).toBe(202);
    expect(replayedDefine.body.replayed).toBe(true);
    const stale = await operations(fireBody(2));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('automation_revision_stale');
    // Fire: the run dispatches with its input; the wake pump delivers it
    // as a text turn while the Session idles; the run settles from the
    // turn's own result.
    const fired = await operations(fireBody());
    expect(fired.status).toBe(202);
    expect(fired.body.replayed).toBe(false);
    expect(fired.body.run).toMatchObject({
      scheduleId: AUTOMATION_ID,
      definitionRevision: 1,
      occurrenceKey: AUTOMATION_SLOT,
      state: 'running',
      execution: 'dispatch_started',
    });
    const runId = fired.body.run.automationRunId as string;
    expect(runId).toMatch(/^arun_[0-9a-f]{64}$/);
    expect(fired.body.inputId).toBe(`${runId}:input`);
    await vi.waitFor(
      async () => {
        const again = await operations(fireBody());
        expect(again.status).toBe(202);
        expect(again.body.replayed).toBe(true);
        expect(again.body.run.state).toBe('settled');
        expect(again.body.run.execution).toBe('settled');
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(state.model).toHaveBeenCalledTimes(1);
    const modelInput = state.model.mock.calls[0]![0] as {
      promptId?: string;
      prompt?: string;
    };
    expect(modelInput.promptId).toBe(`${runId}:input`);
    expect(modelInput.prompt).toContain('Scheduled automation: Nightly build');
    expect(modelInput.prompt?.endsWith('Run the build.')).toBe(true);
    const status = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    );
    expect(status.body).toMatchObject({
      hasActivePrompt: false,
      recoveryBlocked: false,
    });
    // Retire: a new occurrence is refused, the settled one still replays.
    const retired = await operations({
      kind: 'retire_schedule',
      scheduleId: AUTOMATION_ID,
    });
    expect(retired.status).toBe(202);
    expect(retired.body.schedule).toMatchObject({
      revision: 2,
      state: 'cancelled',
      enabled: false,
    });
    const late = await operations(fireBody(2, 'manual:late', 'manual'));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('automation_retired');
    expect((await operations(fireBody())).body.run.state).toBe('settled');
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    // Claim, dispatch, settle: three run revisions, and the automation
    // input's turn settled by the pump, not by the close path.
    expect(
      journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            event.payload['domain'] === 'automation_run',
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${runId}:1`, `${runId}:2`, `${runId}:3`]);
    const settled = journal.events.filter(
      (event) =>
        event.kind === 'turn.settled' &&
        event.payload['turnId'] === `${runId}:input`,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload['outcome']).toBe('completed');
  });

  async function prewriteAutomationSession(
    toolProfile?: string,
    captureBytes?: number,
  ): Promise<string> {
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
              ...(toolProfile === undefined ? {} : { toolProfile }),
              ...(captureBytes === undefined ? {} : { captureBytes }),
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
    try {
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      await automations.define({
        scheduleId: AUTOMATION_ID,
        operationId: randomUUID(),
        definition: automationDefinition,
      });
      const fired = await automations.fire({
        scheduleId: AUTOMATION_ID,
        definitionRevision: 1,
        occurrenceKey: AUTOMATION_SLOT,
        trigger: 'scheduled',
        firedAt: Date.parse('2026-03-08T07:00:05Z'),
      });
      return fired.inputId;
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  // A prewrite whose automation turn ran and ended with the writer's crash:
  // the journal carries the committed input, the transcript carries the
  // turn attempt, and the hook pin keeps a bare load from refusing the
  // crash the way a parked prompt would refuse it without one.
  async function prewriteAutomationCrashedTurnSession(): Promise<string> {
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
              hookCatalog: hookPin,
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
    try {
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      await automations.define({
        scheduleId: AUTOMATION_ID,
        operationId: randomUUID(),
        definition: automationDefinition,
      });
      const fired = await automations.fire({
        scheduleId: AUTOMATION_ID,
        definitionRevision: 1,
        occurrenceKey: AUTOMATION_SLOT,
        trigger: 'scheduled',
        firedAt: Date.parse('2026-03-08T07:00:05Z'),
      });
      // The attempt the writer itself sealed: the turn ran here and died.
      await managed.sink.write({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: fired.inputId,
        message: { role: 'user', parts: [{ text: 'queued' }] },
      } as never);
      return fired.inputId;
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  // A prewrite whose journal carries one parked harness prompt beside the
  // queued automation input: the parked prompt keeps the wake pump blocked
  // on load (recovery verdict), like prewriteMonitorSession's do.
  async function prewriteAutomationParkedSession(): Promise<string> {
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
              hookCatalog: hookPin,
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
    try {
      // The parked prompt: an input that never ran a turn, so the Session
      // opens recovery-blocked and its wake pump does not start.
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: 'prompt-1',
          sessionKey: key,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: 'prompt-1',
          turnId: 'prompt-1',
          source: 'hosted-harness',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from('[{"type":"text","text":"hi"}]', 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      await automations.define({
        scheduleId: AUTOMATION_ID,
        operationId: randomUUID(),
        definition: automationDefinition,
      });
      const fired = await automations.fire({
        scheduleId: AUTOMATION_ID,
        definitionRevision: 1,
        occurrenceKey: AUTOMATION_SLOT,
        trigger: 'scheduled',
        firedAt: Date.parse('2026-03-08T07:00:05Z'),
      });
      return fired.inputId;
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  // A prewrite whose automation wake turn crashed inside its Runtime call:
  // exactly what a Harness kill mid-execution leaves durable — the
  // committed input, the turn's user record, the dispatch's tool.intent,
  // and an await_runtime checkpoint pinning this turn. 'run_shell_command'
  // parks a Shell call instead: the hooks/MCP-defined Session of this
  // fixture deterministically declines its Broker identity.
  async function prewriteAutomationParkedWakeSession(
    tooling: 'read_file' | 'run_shell_command' = 'read_file',
  ): Promise<string> {
    const shellArg = tooling === 'run_shell_command';
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
              hookCatalog: hookPin,
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
    try {
      // The baseline goes down first: with any continuation content but
      // no checkpoint the authority restores blocked (missing_checkpoint),
      // so the turn's before_model lands before the automation records.
      const handle = createManagedHarnessHandle(managed);
      await handle.ensureRunnable();
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      await automations.define({
        scheduleId: AUTOMATION_ID,
        operationId: randomUUID(),
        definition: automationDefinition,
      });
      const fired = await automations.fire({
        scheduleId: AUTOMATION_ID,
        definitionRevision: 1,
        occurrenceKey: AUTOMATION_SLOT,
        trigger: 'scheduled',
        firedAt: Date.parse('2026-03-08T07:00:05Z'),
      });
      const inputId = fired.inputId;
      // The attempt the owner died inside: prompt, intent, checkpoint —
      // and the assistant's functionCall the checkpoint's item names.
      const userRecord = {
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: inputId,
        message: { role: 'user', parts: [{ text: 'queued' }] },
      };
      await managed.sink.write(userRecord as never);
      const callName = shellArg ? 'run_shell_command' : 'read_file';
      await managed.sink.write({
        uuid: 'msg-wake-1',
        parentUuid: userRecord.uuid,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: inputId,
        message: {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'fc-wake-1', name: callName, args: {} },
            },
          ],
        },
      } as never);
      const argsRef = await resources.publish(
        shellArg ? 'managed-tool-args' : 'managed-tool-input',
        Buffer.from(
          shellArg
            ? JSON.stringify({ command: 'cat a.txt' })
            : JSON.stringify({
                harnessSessionId: SESSION_ID,
                runtimeSessionId: 'rt-wake-1',
              }),
        ),
      );
      const toolDefinitionRef = await resources.publish(
        'managed-tool-definition',
        Buffer.from('{}'),
      );
      await managed.authority.appendExecutionEvent(
        {
          operation: 'recordToolIntent',
          commandId: `intent:${inputId}`,
          sessionKey: key,
          contentDigest: 'b'.repeat(64),
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `intent:${inputId}`,
          sessionKey: key,
          kind: 'tool.intent',
          occurredAt: Date.now(),
          subject: {
            type: 'activation',
            scopeId: managed.activation.activationId,
            ...managed.activation,
          },
          payload: {
            executionCallId: 'ex-wake-1',
            batchId: 'batch-wake-1',
            ordinal: 0,
            toolDefinitionRef,
            argsRef,
            outcomeSource: 'runtime',
          },
        }),
        { class: 'harness', activation: managed.activation },
      );
      await handle.commitAwaitRuntimeBatch(
        [
          {
            functionCallId: 'fc-wake-1',
            toolName: shellArg ? 'run_shell_command' : 'read_file',
            executionCallId: 'ex-wake-1',
            invocationBindingId: 'bind-wake-1',
            capabilityVersion: 'cap-1',
            policyVersion: 'pol-1',
            mediaVersion: null,
            modelMessageId: 'msg-wake-1',
            partIndex: 0,
            ordinal: 0,
            inputDigest: 'c'.repeat(64),
            progressCursor: null,
            attemptId: 'att-wake-1',
            routeRef: await resources.publish(
              'managed-route',
              Buffer.from('{"model":"qwen3-coder-plus"}'),
            ),
          },
        ],
        { turnId: inputId, promptId: inputId },
      );
      return inputId;
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  // The Broker answers each status poll once in the order given: TypeError
  // entries throw, then {@link mockRepairBroker.unlatch} lets the rest
  // play out, so a wedge and its recovery share one fixture run. Statuses
  // on the cold surface (`acquire` never called) answer 404 — the old
  // tails — while recorded calls keep `acquire`/`status`/`release` order.
  function mockRepairBroker() {
    mockBrokerBroker();
    const repair = {
      script: [] as Array<{ state: 'running' } | { state: 'settled' }>,
      latched: true,
      order: [] as string[],
      unlatch: () => {
        repair.latched = false;
      },
    };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        repair.order.push('acquire');
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      () => {
        repair.order.push('status');
        if (!repair.order.includes('acquire')) {
          return Promise.reject(
            new HostedWorkspaceBrokerRejection(
              404,
              'runtime_session_not_found',
            ),
          );
        }
        if (repair.latched) {
          return Promise.reject(
            new TypeError('Runtime Broker status lost to a 503'),
          );
        }
        const next = repair.script.shift() ?? { state: 'settled' as const };
        return Promise.resolve(next as never);
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
      () => {
        repair.order.push('release');
        return Promise.resolve();
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    return repair;
  }

  it('keeps a turn that ended unanswered out of the next wake turn history', async () => {
    await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    state.model.mockImplementationOnce(() => {
      throw new Error('model exploded');
    });
    // The first run fails from its turn's own error.
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('settled');
      },
      { timeout: 10_000 },
    );
    const exploded = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    // The next occurrence's wake turn never receives the exploded turn's
    // prompt: what ended without an answer is over.
    state.model.mockClear();
    const slot = 'schedule:2026-03-08T11:00:00Z';
    const fired = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
    expect(fired.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    const modelInput = state.model.mock.calls.at(-1)![0] as {
      promptId?: string;
      history?: Array<{ type?: string; daemonPromptId?: string }>;
    };
    expect(modelInput.promptId).toBe(
      `${automationRunId(AUTOMATION_ID, slot)}:input`,
    );
    expect(
      (modelInput.history ?? []).some(
        (entry) =>
          entry.type === 'user' && entry.daemonPromptId === `${exploded}:input`,
      ),
    ).toBe(false);
    // Let the second run reach its own settle before the teardown.
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('settled');
      },
      { timeout: 15_000 },
    );
    await vi.waitFor(
      async () => {
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
      },
      { timeout: 15_000 },
    );
  }, 45_000);

  it('retries the crashed input consume against a transient transcript conflict', async () => {
    const inputId = await prewriteAutomationCrashedTurnSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      // One moved-journal conflict on the first consume attempt, then the
      // writer owns the transcript again: the attempt is a retry, never a
      // drop, or every later reload re-classifies the same crash.
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let thrown = 0;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        function (this: ManagedSessionRecordSink, record) {
          if (
            record.type === 'system' &&
            record.subtype === 'turn_result' &&
            thrown === 0
          ) {
            thrown += 1;
            throw new SessionTranscriptChangedError();
          }
          return originalWrite.call(this, record);
        },
      );
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: undefined,
        turnId: inputId,
      });
      expect(aftermath).toBe('settled');
      expect(thrown).toBe(1);
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      const run = automations
        .runs()
        .find((each) => each.occurrenceKey === AUTOMATION_SLOT);
      expect(run?.run.state).toBe('failed');
      expect(run?.run.execution).toBe('outcome_unknown');
      const journal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(true);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('settles the journal side of a deterministically declined wake park and still unblocks', async () => {
    // A shell tool on a hooks-defined Session: the recovery machinery
    // reads the decline deterministically, so the session must not wedge
    // in a permanent retry loop — the journal side settles anyway (lane
    // B audit round 1).
    const inputId =
      await prewriteAutomationParkedWakeSession('run_shell_command');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: '', baseUrl: 'http://broker' } as never,
        turnId: inputId,
      });
      expect(aftermath).toBe('settled');
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      const run = automations
        .runs()
        .find((each) => each.occurrenceKey === AUTOMATION_SLOT);
      expect(run?.run.state).toBe('failed');
      expect(run?.run.execution).toBe('outcome_unknown');
      const checkpoint =
        await createManagedHarnessHandle(managed).ensureRunnable();
      expect(checkpoint.continuation.phase).not.toBe('await_runtime');
      const projected = await managed.sink.project();
      expect(
        projected.filter(
          (entry) =>
            entry.type === 'tool_result' &&
            entry.daemonPromptId === inputId &&
            (entry.message?.parts ?? []).some(
              (part) =>
                part.functionResponse?.response?.['executionStatus'] ===
                'cancelled',
            ),
        ),
      ).toHaveLength(1);
      const journal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(true);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('keeps a wake park pending when its checkpoint read was erased, settling nothing', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      // The checkpoint read blipped: a `missing_state` verdict WITH its
      // message, erasure that proves nothing. Settling over it would skip
      // the stop/release but still consume the input, closing every
      // retry channel the park has.
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'harnessRunAuthorization',
      ).mockResolvedValue({
        status: 'blocked',
        reason: 'missing_state',
        message: 'managed session store answered 503',
      } as never);
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: '', baseUrl: 'http://broker' } as never,
        turnId: inputId,
      });
      expect(aftermath).toBe('pending');
      // Nothing consumed, nothing settled: every retry channel still
      // sees the park.
      const journal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(true);
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(false);
      expect(
        (await managed.sink.project()).filter(
          (entry) =>
            entry.daemonPromptId === inputId && entry.type === 'tool_result',
        ),
      ).toHaveLength(0);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('refuses a prompt retriably when the wake park probe read nothing', async () => {
    await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    // Only the route's checkpoint probe takes this spy: an erased verdict
    // must not answer "no park" over state nobody read.
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'missing_state',
      message: 'managed session store answered 503',
    } as never);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: randomUUID(),
      payloadDigest,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_in_progress');
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['source'] === 'hosted-harness',
      ),
    ).toBe(false);
    repair.unlatch();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('settles the parked runtime after a broker fault, releasing its lease and unblocking', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const slot = 'schedule:2026-03-08T11:00:00Z';
    // The classification's own block is the verified starting point, not
    // a race against it.
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 15_000 },
    );
    // While the Broker keeps faulting, the crash's aftermath stays
    // pending: the Session holds its block rather than letting a fire run
    // against an unsettled park.
    await vi.waitFor(
      async () => {
        const refused = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_session_blocked');
      },
      { timeout: 15_000 },
    );
    repair.unlatch();
    // The pump's blocked cycle retries the same settle: the parked
    // execution is cancelled durably, the wake session's lease goes back,
    // the input is consumed, and the Session takes the next fire in
    // process.
    repair.script.push({ state: 'running' }, { state: 'settled' });
    await vi.waitFor(
      async () => {
        const accepted = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(accepted.status).toBe(202);
      },
      { timeout: 15_000 },
    );
    expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalled();
    // The cold Broker's space is not assumed: an adoption must precede
    // every status poll and every release on it (audit round: the parked
    // status query and the release otherwise answer 404 and 503). Order
    // asserts only have teeth once adoption HAPPENED (-1 < anything).
    expect(repair.order).toContain('acquire');
    expect(repair.order.indexOf('acquire')).toBeLessThan(
      repair.order.indexOf('status'),
    );
    expect(repair.order.indexOf('acquire')).toBeLessThan(
      repair.order.indexOf('release'),
    );
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('settled');
      },
      { timeout: 15_000 },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      key,
    );
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === inputId,
      ),
    ).toBe(true);
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('outcome_unknown');
      },
      { timeout: 15_000 },
    );
    const zombieRun = automationRunId(AUTOMATION_ID, slot);
    expect(
      journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            String(event.payload['operationId']).startsWith(`${zombieRun}:`),
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${zombieRun}:1`, `${zombieRun}:2`, `${zombieRun}:3`]);
    await vi.waitFor(
      async () => {
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
      },
      { timeout: 15_000 },
    );
    // The parked call's cancelled tool_result is durably paired with its
    // call, and the checkpoint left await_runtime for good.
    const reopened = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const projected = await reopened.sink.project();
      const cancelled = projected.filter(
        (entry) =>
          entry.type === 'tool_result' &&
          entry.daemonPromptId === inputId &&
          (entry.message?.parts ?? []).some(
            (part) =>
              part.functionResponse?.response?.['executionStatus'] ===
              'cancelled',
          ),
      );
      expect(cancelled).toHaveLength(1);
      const checkpoint =
        await createManagedHarnessHandle(reopened).ensureRunnable();
      expect(checkpoint.continuation.phase).not.toBe('await_runtime');
    } finally {
      await reopened.close().catch(() => undefined);
    }
  }, 45_000);

  it.each([
    // A cold (replacement) Broker reads the RELEASING row.
    'runtime_session_not_acquirable',
    // The live Broker whose worker release failed still holds the
    // session in process and answers from its ready check.
    'runtime_session_not_ready',
  ])(
    'finishes the release after a transient release failure, in the very next pass (adopt refused %s)',
    async (refusal) => {
      const inputId = await prewriteAutomationParkedWakeSession();
      const repair = mockRepairBroker();
      // The first pass commits the cancelled results, and the worker's
      // release dies on its way: the aftermath is `pending` and the session
      // is RELEASING. The adopt then answers 409 — a RELEASING session
      // refuses it too — and only the explicit release on the second pass
      // completes the condition; acquire's 409 is no proof by itself.
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        () => {
          repair.order.push('acquire');
          return Promise.reject(
            new HostedWorkspaceBrokerRejection(409, refusal),
          );
        },
      );
      vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementationOnce(
        async () => {
          repair.order.push('release');
          throw new TypeError('worker release died on its way');
        },
      );
      repair.unlatch();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        );
      // The classification's block is the verified starting point: only
      // after it does the aftermath retry, so the order assertions below
      // read a settled, complete sequence, never one mid-flight.
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: 15_000 },
      );
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: 15_000 },
      );
      // Two passes: the 409-refused adopt leaves nothing to stop (no poll),
      // the release block's own adopt then meets a dying release (pending);
      // the next pass repeats both adopts and the release completes —
      // exactly the affirmative release result the consume depends on.
      expect(repair.order).toEqual([
        'acquire',
        'acquire',
        'release',
        'acquire',
        'release',
      ]);
      expect(repair.order).not.toContain('status');
      expect(repair.order).not.toContain('cancel');
      const key = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const journal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(true);
      const refreshed = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...fireBody() });
      expect(refreshed.status).toBe(202);
      expect(refreshed.body.run.state).toBe('failed');
      expect(refreshed.body.run.execution).toBe('outcome_unknown');
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
    45_000,
  );

  it('settles the aftermath over a Broker that reports the wake session released, polling nothing', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    // The lease is gone for good: the adopt refuses 409
    // runtime_session_not_acquirable and every status poll would answer
    // 404 runtime_session_not_found — the pair the real Broker answers
    // for a released identity. The aftermath must not let that 404
    // escape as a failed pass: nothing remains to stop, so it polls
    // nothing, and the 409-aware release block completes the park.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      () => {
        repair.order.push('acquire');
        return Promise.reject(
          new HostedWorkspaceBrokerRejection(
            409,
            'runtime_session_not_acquirable',
          ),
        );
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      () => {
        repair.order.push('status');
        return Promise.reject(
          new HostedWorkspaceBrokerRejection(404, 'runtime_session_not_found'),
        );
      },
    );
    // The consume's turn_result write gates the end of the settle: the
    // classification, the adopt refusals, the cancelled-results commit
    // and the release have all completed when it enters, so the order
    // assertions read a settled sequence however fast the runner is —
    // never the mid-flight of a blocked window that may already be gone.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let releaseConsume!: () => void;
    let consumeEntered = false;
    const consuming = new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result') {
          consumeEntered = true;
          return consuming.then(() => originalWrite.call(this, record));
        }
        return originalWrite.call(this, record);
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    await vi.waitFor(
      () => {
        expect(consumeEntered).toBe(true);
      },
      { timeout: 15_000 },
    );
    // One pass: the refused adopt stops nothing, the release block's own
    // adopt tolerates the same 409, and the explicit release completes
    // it. A single poll would have met the 404 above and wedged the
    // Session behind a read that can never answer.
    expect(repair.order).toEqual(['acquire', 'acquire', 'release']);
    releaseConsume();
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 15_000 },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      key,
    );
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === inputId,
      ),
    ).toBe(true);
    const refreshed = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody() });
    expect(refreshed.status).toBe(202);
    expect(refreshed.body.run.state).toBe('failed');
    expect(refreshed.body.run.execution).toBe('outcome_unknown');
    // The released-session answers are the probe's fixture, not the
    // close path's: the delete below re-acquires the lease it hands
    // back, so the Broker goes back to answering adoptable first.
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        repair.order.push('acquire');
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.mocked(HostedWorkspaceBroker.prototype.status).mockResolvedValue({
      state: 'settled',
    } as never);
    await vi.waitFor(
      async () => {
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
      },
      { timeout: 15_000 },
    );
    // The parked call's cancelled tool_result is durably paired with its
    // call, and the checkpoint left await_runtime for good.
    const reopened = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const projected = await reopened.sink.project();
      const cancelled = projected.filter(
        (entry) =>
          entry.type === 'tool_result' &&
          entry.daemonPromptId === inputId &&
          (entry.message?.parts ?? []).some(
            (part) =>
              part.functionResponse?.response?.['executionStatus'] ===
              'cancelled',
          ),
      );
      expect(cancelled).toHaveLength(1);
      const checkpoint =
        await createManagedHarnessHandle(reopened).ensureRunnable();
      expect(checkpoint.continuation.phase).not.toBe('await_runtime');
    } finally {
      await reopened.close().catch(() => undefined);
    }
  }, 45_000);

  it('repairs through the reconcile route while blocked, and reports once consumed', async () => {
    await prewriteAutomationParkedWakeSession();
    mockBrokerBroker();
    // A settled execution stops nothing; only the consume hangs, until
    // the test lets go: the aftermath is provably in flight when the
    // first reconcile answers.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let releaseConsume!: () => void;
    let consumeEntered!: () => void;
    const consuming = new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      consumeEntered = resolve;
    });
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result') {
          consumeEntered();
          return consuming.then(() => originalWrite.call(this, record));
        }
        return originalWrite.call(this, record);
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const reconcile = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({
        operationId: randomUUID(),
        kind: 'reconcile_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey: AUTOMATION_SLOT,
      });
    await entered;
    // The pump's own aftermath is mid-flight: the route reports instead
    // of competing for the checkpoint.
    const during = await reconcile();
    expect(during.status).toBe(202);
    expect(during.body.repaired).toBe(false);
    releaseConsume();
    await vi.waitFor(
      async () => {
        const after = await reconcile();
        expect(after.status).toBe(202);
        expect(after.body.run.state).toBe('failed');
        expect(after.body.run.execution).toBe('outcome_unknown');
      },
      { timeout: 15_000 },
    );
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 15_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);

  it('treats a reconcile over a consumed crash as a settled-run replay', async () => {
    await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const reconcile = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({
        operationId: randomUUID(),
        kind: 'reconcile_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey: AUTOMATION_SLOT,
      });
    state.model.mockImplementationOnce(() => {
      throw new Error('model exploded');
    });
    // The aftermath — here performed by the pump's own cycle, the same
    // one the route drives when it is first — answers through the run.
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('settled');
      },
      { timeout: 15_000 },
    );
    // Nothing of the crash is pending once settled and consumed: the
    // reconcile is a report of the settled run, not another repair.
    const replay = await reconcile();
    expect(replay.status).toBe(202);
    expect(replay.body.repaired).toBe(false);
    expect(replay.body.run.state).toBe('failed');
    expect(replay.body.run.execution).toBe('settled');
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    const crashed = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    expect(
      journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            String(event.payload['operationId']).startsWith(`${crashed}:`),
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${crashed}:1`, `${crashed}:2`, `${crashed}:3`]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);

  it('refuses a prompt while a wake park is still unsettled, retriably', async () => {
    await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    // The first projection the wake classification reads after the load
    // hangs until the test lets go: only the prompt route's own
    // checkpoint probe may answer this refusal, never the pump's later
    // classification (which would also refuse, from a shadowing cause).
    const originalProject = ManagedSessionRecordSink.prototype.project;
    let afterLoad = false;
    let hanging = false;
    let releaseClassify!: () => void;
    const classifyGate = new Promise<void>((resolve) => {
      releaseClassify = resolve;
    });
    vi.spyOn(ManagedSessionRecordSink.prototype, 'project').mockImplementation(
      function (this: ManagedSessionRecordSink) {
        if (afterLoad && !hanging) {
          hanging = true;
          return classifyGate.then(() => originalProject.call(this));
        }
        return originalProject.call(this);
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    afterLoad = true;
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: randomUUID(),
      payloadDigest,
    });
    // The coordinator's transient-window exemption retries exactly this
    // code until the pump settles the park.
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_in_progress');
    // Nothing was admitted: the checkpoint probe, not the admission path,
    // held the line.
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['source'] === 'hosted-harness',
      ),
    ).toBe(false);
    releaseClassify();
    repair.unlatch();
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 15_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);

  it('refuses a prompt whose wake-park probe let the pump block the Session', async () => {
    await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    repair.unlatch();
    // The pump's first post-load classification hangs at its projection
    // read: the prompt route's checkpoint probe must run first, while
    // the Session is still unblocked.
    const originalProject = ManagedSessionRecordSink.prototype.project;
    let afterLoad = false;
    let classificationHung = false;
    let releaseClassify!: () => void;
    const classifyGate = new Promise<void>((resolve) => {
      releaseClassify = resolve;
    });
    vi.spyOn(ManagedSessionRecordSink.prototype, 'project').mockImplementation(
      function (this: ManagedSessionRecordSink) {
        if (afterLoad && !classificationHung) {
          classificationHung = true;
          return classifyGate.then(() => originalProject.call(this));
        }
        return originalProject.call(this);
      },
    );
    // The route probe's checkpoint read hangs next, so the block lands
    // strictly between the probe's start and its answer.
    const originalAuthorization =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    let probeHung = false;
    let probedResolve!: () => void;
    let releaseProbe!: () => void;
    const probed = new Promise<void>((resolve) => {
      probedResolve = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(function (this: LocalManagedSessionAuthority) {
      if (afterLoad && !probeHung) {
        probeHung = true;
        probedResolve();
        return probeGate.then(() => originalAuthorization.call(this));
      }
      return originalAuthorization.call(this);
    });
    // The worker release hangs last: the aftermath then holds the block
    // with the cancelled results already committed — exactly the window
    // in which the probe's answer (no in-progress items remain) can no
    // longer see the park.
    let releaseHung = false;
    let releasingResolve!: () => void;
    let releaseRelease!: () => void;
    const releasing = new Promise<void>((resolve) => {
      releasingResolve = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      releaseRelease = resolve;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
      () => {
        repair.order.push('release');
        if (!releaseHung) {
          releaseHung = true;
          releasingResolve();
          return releaseGate;
        }
        return Promise.resolve();
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    afterLoad = true;
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    // Promise.resolve dispatches the supertest thenable at once (its
    // request only leaves on .then), so the probe is in flight while
    // the test drives the pump below.
    const prompted = Promise.resolve(
      authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send({
        prompt,
        promptId: randomUUID(),
        payloadDigest,
      }),
    );
    // The probe is in flight; the pump now classifies the same park,
    // and its aftermath stops, commits the cancelled results and parks
    // at the held release — the block the probe started before.
    await probed;
    releaseClassify();
    await releasing;
    releaseProbe();
    const refused = await prompted;
    // The post-probe re-read, not the probe, held the line: the durable
    // session-scope code, while the transient-window one belongs to the
    // probe's own finding (the sibling pin above).
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    // Nothing was admitted.
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['source'] === 'hosted-harness',
      ),
    ).toBe(false);
    releaseRelease();
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 15_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);

  it('reopens over a queued automation input as idle and runs it', async () => {
    // The Harness died between the dispatch and the turn: the input sits
    // accepted in the journal. On load it is nobody's parked Turn — the
    // pump delivers it — exactly like a monitor notification.
    const turnId = await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBeUndefined();
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
      interval: 50,
    });
    expect(
      (state.model.mock.calls[0]![0] as { promptId?: string }).promptId,
    ).toBe(turnId);
    await vi.waitFor(
      async () => {
        const again = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(again.status).toBe(202);
        expect(again.body.run.state).toBe('settled');
      },
      { timeout: 10_000, interval: 50 },
    );
    const status = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    );
    expect(status.body).toMatchObject({
      hasActivePrompt: false,
      recoveryBlocked: false,
    });
    // A user prompt is admitted right after: the queued input never
    // blocked the Session.
    const prompt = [{ type: 'text', text: 'hi' }];
    const answered = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    expect(answered.status).toBe(202);
    await vi.waitFor(
      async () => {
        expect(state.model).toHaveBeenCalledTimes(2);
        const idle = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(idle.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it('loads an automation-carrying journal through the Workspace restore verifier', async () => {
    const automationTurn = await prewriteAutomationSession(
      'hosted-workspace-files/1',
    );
    expect(automationTurn).toContain('arun_');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    // The verifier's domain list now reads the schedule and run records,
    // their prompt and input resources — or the session never reopens.
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBeUndefined();
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const replayed = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody() });
    expect(replayed.status).toBe(202);
    expect(replayed.body.replayed).toBe(true);
    expect(replayed.body.run.state).toBe('running');
    await vi.waitFor(
      async () => {
        const settled = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(settled.status).toBe(202);
        expect(settled.body.run.state).toBe('settled');
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it('maps non-path-safe turn ids to stable path-safe Broker ids', () => {
    const colon = `arun_${'a'.repeat(32)}:input`;
    const mapped = hostedRuntimeSessionId(colon);
    expect(mapped).toMatch(/^wake-[0-9a-f]{64}$/);
    expect(mapped).toBe(hostedRuntimeSessionId(colon));
    // The mapped form is path-safe itself, so a second layer is inert.
    expect(hostedRuntimeSessionId(mapped)).toBe(mapped);
    expect(hostedRuntimeSessionId('<mon_1>:notify:3')).toMatch(
      /^wake-[0-9a-f]{64}$/,
    );
    const plain = 'prompt-1_ok.2';
    expect(hostedRuntimeSessionId(plain)).toBe(plain);
    expect(hostedRuntimeSessionId('..')).not.toBe('..');
  });

  it('runs a tool-calling wake turn under a path-safe Broker session id', async () => {
    const inputId = await prewriteAutomationSession('hosted-workspace-files/1');
    await writeFile(
      path.join(state.root, 'wake-target.txt'),
      'the wake file content',
    );
    const acquired: string[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        acquired.push(this.runtimeSessionId);
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    // The wake turn's model asks for a file: the tool turn must not die
    // at the Broker's path-safe Runtime Session id rule.
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'wake-tool',
        args: { file_path: 'wake-target.txt' },
        isClientInitiated: false,
        prompt_id: inputId,
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
      return { text: 'read it', model: 'test-model' };
    });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const runId = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    // The discriminating point of the F6 wall: which id reaches acquire.
    await vi.waitFor(() => expect(acquired.length).toBeGreaterThan(0), {
      timeout: 10_000,
      interval: 50,
    });
    const expected = `wake-${createHash('sha256').update(`${runId}:input`).digest('hex')}`;
    expect(acquired).toContain(expected);
    expect(acquired).not.toContain(`${runId}:input`);
    expect(acquired.every((id) => /^[A-Za-z0-9._-]{1,512}$/.test(id))).toBe(
      true,
    );
    // The turn went past the acquisition the production refusal stopped:
    // in this brokerless test bed the turn ends recovery-blocked instead
    // of passing acquisition at all, and the F3 path settles the run.
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('outcome_unknown');
      },
      { timeout: 15_000, interval: 50 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('keeps the mapped Runtime identity through the Tool v3 publication lane of a wake shell turn', async () => {
    const inputId = await prewriteAutomationSession(
      'hosted-workspace-shell/1',
      1024 * 1024,
    );
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
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
      executionCallId: 'shell-execution',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'hi' }],
      capture: {
        captureStatus: 'detached',
        captureReason: null,
        manifest: null,
        previewTruncated: false,
        deliveryStatus: 'pending',
      },
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledgeV3',
    ).mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const grants: Array<{ binding?: { reference?: Record<string, unknown> } }> =
      [];
    state.publicationRequest.mockImplementation(
      async (_resources, route, body) => {
        if (route === '/grants') {
          grants.push(
            body as {
              binding?: { reference?: Record<string, unknown> };
            },
          );
          return { state: 'OPEN' };
        }
        throw new Error('Unexpected publication route ' + route);
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'run_shell_command',
        callId: 'wake-shell',
        args: { command: 'cat wake-target.txt' },
        isClientInitiated: false,
        prompt_id: inputId,
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
      return { text: 'read it', model: 'test-model' };
    });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await vi.waitFor(() => expect(grants.length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
    // The discriminating point of the Tool v3 identity wall: binding
    // reference names the Broker's mapped execution session AND the
    // checkpoint's logical prompt id — one pair, two axes; each answers
    // the compare that owns it, and neither sits in the other's seat.
    const runId = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    const mapped = `wake-${createHash('sha256').update(`${runId}:input`).digest('hex')}`;
    const references = grants
      .filter((grant) => grant.binding !== undefined)
      .map((grant) => grant.binding!.reference ?? {});
    // The reserve must be among them: a renew body legitimately has no
    // binding, and assertions over an empty set prove nothing.
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference['sessionId']).toBe(mapped);
      expect(reference['promptId']).toBe(`${runId}:input`);
      expect(reference['sessionId']).not.toBe(`${runId}:input`);
      expect(reference['promptId']).not.toBe(mapped);
    }
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);

  it('settles an automation run as failed/unknown when its turn went recovery-blocked', async () => {
    await prewriteAutomationCrashedTurnSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('outcome_unknown');
      },
      { timeout: 10_000, interval: 50 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('settles, consumes and unblocks on a crash, and later fires run once', async () => {
    await prewriteAutomationCrashedTurnSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // The crashed wake turn settles failed/unknown first.
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('outcome_unknown');
      },
      { timeout: 10_000 },
    );
    const crashed = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    // The settlement of that crash is also its release: once settled and
    // consumed, the Session takes the next fire without a reload.
    const slot = 'schedule:2026-03-08T11:00:00Z';
    const zombieRun = automationRunId(AUTOMATION_ID, slot);
    await vi.waitFor(
      async () => {
        const accepted = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(accepted.status).toBe(202);
      },
      { timeout: 10_000 },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    let journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      key,
    );
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === `${crashed}:input`,
      ),
    ).toBe(true);
    // Reload: the same crash no longer re-blocks, and the slot fires.
    await vi.waitFor(
      async () => {
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
      },
      { timeout: 15_000 },
    );
    const reloaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(reloaded.status).toBe(200);
    const authorizeReloaded = (request: supertest.Test) =>
      headers(request).set(
        'X-Qwen-Client-Id',
        reloaded.body.clientId as string,
      );
    const fired = await authorizeReloaded(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
    expect(fired.status).toBe(202);
    expect(fired.body.replayed).toBe(true);
    journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      key,
    );
    expect(
      journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            String(event.payload['operationId']).startsWith(`${zombieRun}:`),
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${zombieRun}:1`, `${zombieRun}:2`, `${zombieRun}:3`]);
  }, 45_000);

  it('still refuses a fire while a parked block persists, even after the close path', async () => {
    await prewriteAutomationParkedSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBe(true);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // The parked prompt keeps the Session blocked: a fresh fire is refused
    // before it could commit a run that cannot start.
    const slot = 'schedule:2026-03-08T11:00:00Z';
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_session_blocked');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const zombieRun = automationRunId(AUTOMATION_ID, slot);
    expect(
      (
        await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          key,
        )
      ).events.some(
        (event) =>
          event.kind === 'domain.committed' &&
          String(event.payload['operationId']).startsWith(`${zombieRun}:`),
      ),
    ).toBe(false);
    // The close path settles inputs only of the monitor/automation
    // sources, and the pinned prompt here is a user record: it keeps the
    // Session parked across a reload, and every fire keeps answering 409
    // instead of committing anything.
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const reloaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(reloaded.status).toBe(200);
    const authorizeReloaded = (request: supertest.Test) =>
      headers(request).set(
        'X-Qwen-Client-Id',
        reloaded.body.clientId as string,
      );
    const refusedAgain = await authorizeReloaded(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
    expect(refusedAgain.status).toBe(409);
    expect(refusedAgain.body.code).toBe('hosted_session_blocked');
    expect(
      (
        await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          key,
        )
      ).events.some(
        (event) =>
          event.kind === 'domain.committed' &&
          String(event.payload['operationId']).startsWith(`${zombieRun}:`),
      ),
    ).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('settles a pending automation input model-free on the close path', async () => {
    const turnId = await prewriteAutomationParkedSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBe(true);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    // Only DELETE's own settle may speak for an input that never ran: the
    // parked prompt kept the wake pump blocked, and the close path settled
    // it model-free, cancelling the run with its execution proven never to
    // have started.
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    const settled = journal.events.filter(
      (event) =>
        event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'session_closing',
    });
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: resources,
    });
    try {
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      );
      const run = automations
        .runs()
        .find((each) => each.occurrenceKey === AUTOMATION_SLOT);
      expect(run?.run.state).toBe('cancelled');
      expect(run?.run.execution).toBe('not_started_proven');
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('settles a failed automation run from its turn error through the wake runner catch', async () => {
    await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    state.model.mockImplementationOnce(() => {
      throw new Error('model exploded');
    });
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('settled');
      },
      { timeout: 10_000, interval: 50 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('answers a fire that lost its store with a retryable 503, and fires after recovery', async () => {
    await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const operations = (body: Record<string, unknown>) =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...body });
    // The queued slot from the prewrite settles first, so nothing but the
    // fire under test reads the store once the fault is armed.
    await vi.waitFor(
      async () => {
        expect((await operations(fireBody())).body.run.state).toBe('settled');
      },
      { timeout: 10_000, interval: 50 },
    );
    const read = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockRejectedValueOnce(
        new ManagedSessionStoreHttpError(
          503,
          'store_unavailable',
          'store down',
        ),
      );
    const slot = 'schedule:2026-03-08T09:00:00Z';
    const refused = await operations(fireBody(1, slot));
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('automation_operation_failed');
    read.mockRestore();
    // The transient fault never settled the occurrence: the claim
    // committed, so the re-drive dispatches that same run.
    const recovered = await operations(fireBody(1, slot));
    expect(recovered.status).toBe(202);
    expect(recovered.body.replayed).toBe(true);
    const runId = recovered.body.run.automationRunId as string;
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    expect(
      journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            event.payload['domain'] === 'automation_run' &&
            String(event.payload['operationId']).startsWith(`${runId}:`),
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${runId}:1`, `${runId}:2`]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('answers an operation against a dead journal writer with a retryable 503', async () => {
    await prewriteAutomationSession();
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const operations = (body: Record<string, unknown>) =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...body });
    await vi.waitFor(
      async () => {
        expect((await operations(fireBody())).body.run.state).toBe('settled');
      },
      { timeout: 10_000, interval: 50 },
    );
    // WritesStoppedError extends ManagedSessionRecordError: reordering the
    // arm below the plain-record arm would flip the answer to 400 — and
    // the scanner would record the slot skipped forever.
    const read = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockRejectedValueOnce(
        new ManagedSessionWritesStoppedError(new Error('writer died')),
      );
    const slot = 'schedule:2026-03-08T09:00:00Z';
    const refused = await operations(fireBody(1, slot));
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('automation_operation_failed');
    read.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  const MONITOR_BINDING = { runtimeBindingId: 'binding-1', generation: '1' };

  async function prewriteMonitorSession(): Promise<string> {
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
              hookCatalog: hookPin,
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
    const turnId = 'monitor-1:notify:1';
    try {
      // A parked harness prompt keeps the wake pump blocked without asking
      // the close path to care: only DELETE's own settle may speak for an
      // unattempted monitor notification.
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: 'prompt-1',
          sessionKey: key,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: 'prompt-1',
          turnId: 'prompt-1',
          source: 'hosted-harness',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from('[{"type":"text","text":"hi"}]', 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
      const monitors = new HostedMonitorSession(
        { authority: managed.authority, resources: managed.resources },
        key,
      );
      await monitors.admit({
        monitorId: 'monitor-1',
        ownerScopeId: key.sessionId,
        executionCallId: 'call-1',
        args: { command: 'tail -f build.log' },
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1_000,
      });
      await monitors.dispatchStarted('monitor-1', MONITOR_BINDING);
      await monitors.attach('monitor-1', MONITOR_BINDING, { watch: 'started' });
      await monitors.observe(
        'monitor-1',
        { lines: ['one'] },
        {
          input: {
            inputId: turnId,
            turnId,
            source: 'monitor',
            contentRef: await managed.resources.publish(
              'managed-input',
              Buffer.from('{"text":"<task-notification />"}', 'utf8'),
            ),
            admissionRef: await managed.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            deadline: null,
            wakeReason: 'input',
          },
        },
      );
    } finally {
      await managed.close().catch(() => undefined);
    }
    return turnId;
  }

  // The journal shape a child run's acceptance leaves behind when its
  // notification input is still owed: accepted, never settled, and the
  // Session holds no prompt of its own.
  async function prewriteChildNotificationSession(): Promise<string> {
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
              hookCatalog: hookPin,
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
    const turnId = 'run-1:accept:notify';
    try {
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: turnId,
          sessionKey: key,
          contentDigest: 'b'.repeat(64),
        },
        {
          inputId: turnId,
          turnId,
          source: 'child_agent',
          contentRef: await managed.resources.publish(
            'managed-input',
            Buffer.from('{"text":"<task-notification />"}', 'utf8'),
          ),
          admissionRef: await managed.resources.publish(
            'managed-admission',
            Buffer.from('{}', 'utf8'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
    } finally {
      await managed.close().catch(() => undefined);
    }
    return turnId;
  }

  // A Session that has accepted a child result: the restore verifier must
  // admit the child_acceptance domain its journal now carries.
  async function prewriteAcceptedChildSession(): Promise<string> {
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
              hookCatalog: hookPin,
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
    try {
      const children = new HostedChildAgentSession(
        { authority: managed.authority, resources: managed.resources },
        key,
      );
      await children.admit({
        childRunId: 'run-1',
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'sent',
        description: 'audit the diff',
        prompt: 'review the change',
        definition: {
          definitionId: 'hosted-agent/hosted-workspace-shell/1',
          definitionRevision: 1,
          definitionDigest:
            managed.authority.sessionHeader.definitionRef.digest,
        },
        workingDirectory: '.',
        executionCallId: 'run-1',
      });
      await children.dispatchStarted('run-1', {
        dispatchId: 'dispatch-1',
        runtime: { runtimeBindingId: 'binding-1', generation: '1' },
      });
      await children.attach('run-1', '550e8400-e29b-41d4-a716-446655440001');
      await children.settleCompleted('run-1', {
        result: Buffer.from('审阅通过', 'utf8'),
        receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      });
      await children.accept('run-1', {
        notification: { description: 'audit the diff' },
      });
    } finally {
      await managed.close().catch(() => undefined);
    }
    return 'run-1:accept:notify';
  }

  function mockBrokerBroker() {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl').mockImplementation(
      async (operation) => {
        if (operation.kind === 'hook-catalog')
          return {
            operationId: operation.operationId,
            state: 'settled' as const,
            catalog: {
              ...hookPin,
              hooks: [
                HookEventName.Notification,
                HookEventName.SessionEnd,
                HookEventName.SessionDelete,
              ].map((eventName) => ({
                hookId: eventName,
                eventName,
                sequential: false,
                async: false,
                failClosed: true,
                onceKey: null,
                config: { type: 'command' as const },
              })),
              ...operation.pin,
            },
          };
        return {
          operationId: operation.operationId,
          state: 'settled' as const,
          result: {
            success: true,
            outcome: 'success' as const,
            duration: 0,
            output: { hookSpecificOutput: { additionalContext: 'checked' } },
          },
        };
      },
    );
  }

  it.each([
    new TypeError('network timeout'),
    new ManagedSessionStoreHttpError(
      409,
      'managed_session_writer_conflict',
      'Writer fenced',
    ),
  ])(
    'keeps the Monitor wake scheduler after refused detach: %s',
    async (cause) => {
      mockBrokerBroker();
      const closeWake = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'close');
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          captureBytes: 1024 * 1024,
        })
        .expect(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          created.body.clientId as string,
        );
      state.authorizeOrdinary.mockRejectedValueOnce(cause);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(503);
      expect(closeWake).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
      await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).expect(200);
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({})
        .expect(204);
      expect(closeWake).toHaveBeenCalledOnce();
      await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).expect(404);
    },
  );

  it('settles a pending Monitor notification as session_closing when the Session closes', async () => {
    domainEnablement.monitorRun = true;
    const notificationTurnId = await prewriteMonitorSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBe(true);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    const settled = journal.events.filter(
      (event) =>
        event.kind === 'turn.settled' &&
        event.payload['turnId'] === notificationTurnId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'session_closing',
    });
    expect(
      (
        await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string)
      ).status,
    ).toBe(404);
  });

  /**
   * A channel turn died inside write_file, leaving an await_runtime
   * checkpoint and file_history.pendingTurn. Shared by the attachment
   * and the transient-retry witnesses.
   */
  async function prewriteChannelWriteInterruption(): Promise<string> {
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
              toolProfile: 'hosted-workspace-files/1',
              hookCatalog: hookPin,
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
    const channelIdentity = {
      tenantId: 'tenant',
      channelInstanceId: 'mail-1',
      accountGeneration: 1,
      platformEventId: '1700:99',
      semanticRevision: 1,
    };
    const channelTurn = channelInputId(channelIdentity);
    try {
      const channels = new HostedChannelSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      await channels.submitInput({
        inputId: channelTurn,
        channelInstanceId: channelIdentity.channelInstanceId,
        accountId: 'agent@example.com',
        accountGeneration: channelIdentity.accountGeneration,
        platformEventId: channelIdentity.platformEventId,
        semanticRevision: 1,
        scope: {
          kind: 'chat_thread',
          senderId: null,
          chatId: 'alice@example.com',
          threadId: 'thread-1',
        },
        policy: {
          adapter: 'email',
          senderPolicy: 'allowlist',
          allowedSenders: ['alice@example.com'],
          dispatchMode: 'followup',
        },
        senderId: 'alice@example.com',
        chatId: 'alice@example.com',
        threadId: 'thread-1',
        subject: 'Deploy',
        text: 'write deploy.txt',
        attachments: [],
        replyContext: { parent: '<a@example.com>', references: [] },
      });
      // The wake turn began — its user record is minted — and died inside
      // write_file before the tool result arrived.
      await managed.sink.write({
        uuid: `${channelTurn}:user`,
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: channelTurn,
        message: { role: 'user', parts: [{ text: 'write deploy.txt' }] },
      } as ChatRecord);
      const harness = createManagedHarnessHandle(managed);
      await harness.ensureRunnable();
      const activation = managed.activation;
      const executionId = 'exec-channel-write';
      const toolDefinitionRef = await resources.publish(
        'managed-tool-definition',
        Buffer.from(JSON.stringify({ name: 'write_file' })),
      );
      const toolInput = await resources.publish(
        'managed-tool-input',
        Buffer.from(
          JSON.stringify({
            harnessSessionId: SESSION_ID,
            runtimeSessionId: channelTurn,
            payloadJson: JSON.stringify({
              toolName: 'write_file',
              input: { file_path: 'deploy.txt', content: 'x' },
            }),
          }),
        ),
      );
      await managed.authority.appendExecutionEvent(
        {
          operation: 'toolIntent',
          commandId: `tool-intent:${executionId}`,
          sessionKey: key,
          contentDigest: toolInput.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `tool-intent:${executionId}`,
          sessionKey: key,
          kind: 'tool.intent',
          occurredAt: Date.now(),
          subject: {
            type: 'activation',
            scopeId: activation.activationId,
            ...activation,
          },
          payload: {
            executionCallId: executionId,
            batchId: 'batch-1',
            ordinal: 0,
            toolDefinitionRef,
            argsRef: toolInput,
            outcomeSource: 'runtime',
          },
        }),
        { class: 'harness', activation },
      );
      await harness.commitAwaitRuntimeBatch(
        [
          {
            functionCallId: 'call-1',
            toolName: 'write_file',
            executionCallId: executionId,
            invocationBindingId: executionId,
            capabilityVersion: 'workspace-capability/1',
            policyVersion: 'preapproved-workspace-tools/1',
            mediaVersion: null,
            modelMessageId: 'message-1',
            partIndex: 0,
            ordinal: 0,
            inputDigest: 'a'.repeat(64),
            progressCursor: null,
            attemptId: 'attempt-1',
            routeRef: toolInput,
          },
        ],
        { turnId: channelTurn, promptId: channelTurn },
      );
      await commitHostedFileHistory(managed, {
        schemaVersion: 1,
        state: { ownerSessionId: SESSION_ID, snapshots: [], files: {} },
        pendingTurn: channelTurn,
        pendingUndo: null,
      });
    } finally {
      await managed.close();
    }
    return channelTurn;
  }

  it('recovers a channel turn interrupted inside a Write at attachment instead of refusing the load', async () => {
    // The R4 P1 witness: the load gate refused every attachment shape (the
    // input is pump-owned, so no takeover can match the marker) and the
    // pump that would settle the turn never started. The gate now lets the
    // pump's own recovery load.
    const channelTurn = await prewriteChannelWriteInterruption();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const server = await app(true);
    // Refused 409 hosted_turn_recovery_required before the gate exception.
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    // …and the pump settles right after attachment, with the stop proven
    // through the Broker rather than assumed.
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        const settled = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === channelTurn,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload).toMatchObject({
          outcome: 'cancelled',
          stopReason: 'harness_interruption',
        });
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(
      async () => {
        const history = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .expect(200);
        expect(history.body.history?.pendingTurn ?? null).toBeNull();
      },
      { timeout: 10_000 },
    );
    expect(
      vi.mocked(HostedWorkspaceBroker.prototype.status),
    ).toHaveBeenCalled();
    // The handback lands after the durable markers the waitFor blocks on
    // above; asserting it synchronously races them (round 6's flaky probe).
    await vi.waitFor(
      async () => {
        expect(
          vi.mocked(HostedWorkspaceBroker.prototype.release),
        ).toHaveBeenCalled();
      },
      { timeout: 10_000 },
    );
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
  });

  it('retries an interrupted channel Write recovery after a transient fault instead of latching blocked', async () => {
    // The R6 P1 witness: one Broker-status fault, healthy afterwards. The
    // pump must not latch session.blocked on the first attempt — it
    // retries and the settlement still lands.
    const channelTurn = await prewriteChannelWriteInterruption();
    mockBrokerBroker();
    const status = vi.spyOn(HostedWorkspaceBroker.prototype, 'status');
    status.mockRejectedValueOnce(new Error('broker hiccup'));
    status.mockResolvedValue({ state: 'settled' });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        const settled = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === channelTurn,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload).toMatchObject({ outcome: 'cancelled' });
      },
      { timeout: 10_000 },
    );
    // The first attempt died at the fault; the busy retry proved the stop
    // on the second pass — never a terminal block.
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(
      async () => {
        const history = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .expect(200);
        expect(history.body.history?.pendingTurn ?? null).toBeNull();
      },
      { timeout: 10_000 },
    );
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
  });

  it('keeps an interrupted channel Write honest when the stop throws post-cancel and the retry reclaims the record', async () => {
    // R8-1 through the wake funnel: attempt 1 cancels the parked execution
    // and its post-cancel poll reads a still-reconcilable unknown — a throw
    // exit of the stop loop. The busy-cadence retry then reads the
    // reclaimed record as a definitive not-found, so only the unobserved id
    // carried across the attempts keeps the settle from journaling a
    // cancellation nobody witnessed.
    const channelTurn = await prewriteChannelWriteInterruption();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockResolvedValueOnce({ state: 'executing' })
      .mockResolvedValueOnce({ state: 'unknown' })
      // The retry: the Broker reclaimed the record.
      .mockResolvedValue(undefined);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        expect(
          journal.events.filter(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === channelTurn,
          ),
        ).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    // The parked execution's journaled outcome is the honest unobservable
    // one — never the cancelled a witnessed stop would have earned.
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    const outcomes = (
      transcript.body.events as Array<{ data?: { record?: ChatRecord } }>
    )
      .filter(
        (event) =>
          event.data?.record?.type === 'tool_result' &&
          event.data.record.daemonPromptId === channelTurn,
      )
      .map(
        (event) =>
          (
            event.data?.record?.message?.parts?.[0]?.functionResponse
              ?.response as Record<string, unknown> | undefined
          )?.['executionStatus'],
      );
    expect(outcomes).toEqual(['unknown']);
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
  });

  it('keeps an interrupted channel Write unsettled while its settle cannot verify the park', async () => {
    // R9-2 through the wake funnel: the stop proves cleanly, but the
    // settle's own authorization re-read faults transiently — a
    // retry-inviting refusal the funnel must answer busy with, never a
    // terminal record over a turn whose parked executions the settle
    // could not see.
    const channelTurn = await prewriteChannelWriteInterruption();
    mockBrokerBroker();
    // Hold the stop's first Broker read until the load answered, so the
    // settle block arms deterministically behind it; the block then
    // catches the settle's own re-read and the funnel's retryable check.
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => {
        await statusGate;
        return { state: 'settled' };
      });
    let blockSettleReads = false;
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      if (blockSettleReads)
        return {
          status: 'blocked',
          reason: 'missing_state',
          message: 'Session Store answered 503',
        } as never;
      return original.call(this);
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    // The pump is parked in the stop's gated Broker read now; arm the
    // settle block behind it and let the stop through.
    await vi.waitFor(
      () => {
        expect(status.mock.calls.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    blockSettleReads = true;
    releaseStatus();
    // The settle's refusal surfaces as the retry-inviting busy answer.
    await vi.waitFor(
      () => {
        expect(
          stderr.mock.calls.some(([line]) =>
            String(line).includes(
              'defers its recovery to the next wake attempt',
            ),
          ),
        ).toBe(true);
      },
      { timeout: 10_000 },
    );
    const readSettled = async () =>
      (
        await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        )
      ).events.filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === channelTurn,
      );
    // While the block holds, no terminal record lands over the park the
    // settle could not verify.
    expect(await readSettled()).toHaveLength(0);
    // The block lifts; the busy-cadence retry settles the turn for real.
    blockSettleReads = false;
    await vi.waitFor(
      async () => {
        expect(await readSettled()).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
  });

  it('crosses a durable store fault to 503 instead of mislabelling it as 400 (F10)', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const body = (operationId: string, id: string, text: string) => ({
      operationId,
      kind: 'submit_input',
      inputId: id,
      channelInstanceId: 'mail-1',
      accountId: 'agent@example.com',
      accountGeneration: 1,
      platformEventId: `1700:${id === 'chin-f10a' ? 88 : 89}`,
      semanticRevision: 1,
      senderId: 'alice@example.com',
      chatId: 'alice@example.com',
      threadId: 'thread-1',
      subject: 'Bug',
      text,
      attachments: [
        {
          fileName: 'a.txt',
          mimeType: 'text/plain',
          bytesBase64: Buffer.from('note').toString('base64'),
        },
      ],
      replyContext: { parent: '<a@example.com>', references: [] },
      scope: {
        kind: 'chat_thread',
        senderId: null,
        chatId: 'alice@example.com',
        threadId: 'thread-1',
      },
      policy: {
        adapter: 'email',
        senderPolicy: 'allowlist',
        allowedSenders: ['alice@example.com'],
        dispatchMode: 'followup',
      },
    });
    // The store's own transient fault must never answer as a deterministic
    // verdict: its message class falls to the retryable envelope.
    const failed = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'publish')
      .mockImplementationOnce(async () => {
        throw new ManagedSessionStoreTransportError('Session Store flap');
      });
    const first = await headers(
      supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send(body('aaaaaaaa-0000-4000-8000-000000000001', 'chin-f10a', 'reply'));
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ code: 'channel_operation_failed' });
    failed.mockRestore();
    // A record-validation refusal stays the deterministic 400.
    const second = await headers(
      supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send(
        body(
          'aaaaaaaa-0000-4000-8000-000000000002',
          'chin-f10b',
          '€'.repeat(30_000),
        ),
      );
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({
      code: 'invalid_channel_operation',
    });
    // And the healthy path admits the same work afterwards.
    const third = await headers(
      supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send(body('aaaaaaaa-0000-4000-8000-000000000003', 'chin-f10a', 'reply'));
    expect(third.status).toBe(202);
    // The admitted turn must reach its terminal record before the close —
    // a delete that lands mid-turn answers 409 (hosted_session_busy).
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === 'chin-f10a',
          ),
        ).toBe(true);
      },
      { timeout: 10_000 },
    );
    // The terminal record lands while the pump's own busy epoch is still
    // closing out, so the close can answer 409 for one more tick — a
    // refused close is a no-op, and the retry converges (F10's gate).
    await vi.waitFor(
      async () => {
        expect(
          (
            await headers(
              supertest(server).delete(`/session/${SESSION_ID}`),
            ).set('X-Qwen-Client-Id', clientId)
          ).status,
        ).toBe(204);
      },
      { timeout: 10_000 },
    );
  });

  it('wires the wake pump with the shared recovery predicate (M3b)', async () => {
    domainEnablement.monitorRun = true;
    await prewriteMonitorSession();
    mockBrokerBroker();
    wakeDeps.last = undefined;
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(
      (wakeDeps.last as { needsRecovery?: unknown } | undefined)?.needsRecovery,
    ).toBe(monitorWakeNeedsRecovery);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // R1-5: a pending child-acceptance notification is wake-pump work, not
  // a parked Turn — counted as unsettled, it would refuse every load and
  // wedge exactly the pump that was supposed to deliver it.
  it('loads a Session whose only owed input is a child acceptance notification', async () => {
    domainEnablement.childRun = true;
    const notificationTurnId = await prewriteChildNotificationSession();
    mockBrokerBroker();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(JSON.stringify(log.mock.calls)).not.toContain('unsettled_input');
    // The load made the queued notification runnable: let its wake settle
    // before the close route executes, or DELETE races an active wake turn
    // (409 hosted_turn_active) and the fixture teardown races its journal
    // writes.
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === notificationTurnId,
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // R1-32: the reopen verifier must admit the child_acceptance domain —
  // a Session that has accepted a child result must reopen, never refuse
  // its own committed history as an unsupported domain.
  it('reopens a Session whose journal carries a child_acceptance commit', async () => {
    domainEnablement.childRun = true;
    const notificationTurnId = await prewriteAcceptedChildSession();
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'domain.committed' &&
          event.payload['domain'] === 'child_acceptance',
      ),
    ).toBe(true);
    // The acceptance left its notification owed: let the wake settle it
    // before the close route executes, exactly like the R1-5 lifecycle.
    await vi.waitFor(
      async () => {
        const settled = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        expect(
          settled.events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === notificationTurnId,
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // An array-valued `lineage` must not be silently accepted as a root
  // Session — every non-plain-object lineage is a 400 with the same code
  // the malformed object shapes already get, and only absent or `null`
  // lineage means "root".
  it('refuses an array-valued lineage on session create', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
      lineage: [],
    });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('invalid_hosted_lineage');
    const scrambled = await headers(supertest(server).post('/session')).send({
      sessionId: randomUUID(),
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
      lineage: 'x',
    });
    expect(scrambled.status).toBe(400);
    expect(scrambled.body.code).toBe('invalid_hosted_lineage');
    const absent = await headers(supertest(server).post('/session')).send({
      sessionId: randomUUID(),
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      captureBytes: 1024 * 1024,
    });
    expect(absent.status).toBe(200);
  });

  // R1-4: a rejected consume commit is isolated behind the turn's durable
  // settlement — the turn still completes, the Session never blocks, and
  // the refusal only logs; the owed id survives for a later flush.
  it('settles a completed turn even when its consume flush rejects', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const childRunId = `${PROMPT_ID}:call-1`;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const callRequest = {
        name: 'agent',
        callId: 'call-1',
        args: {
          description: 'audit the diff',
          prompt: 'review the change',
          run_in_background: false,
        },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [callRequest],
        [
          {
            functionCall: {
              id: callRequest.callId,
              name: callRequest.name,
              args: callRequest.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'done', model: 'test-model' };
    });
    const consumptionFails = vi
      .spyOn(HostedChildAgentSession.prototype, 'markConsumed')
      .mockRejectedValueOnce(new Error('store lost the consume commit'));
    const operation = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId, ...body });
    const prompt = [{ type: 'text', text: 'run the audit' }];
    const posted = (async () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        }))();
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'child_run',
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    await operation({
      kind: 'dispatch_started',
      dispatchId: 'dispatch-1',
      runtimeBindingId: 'binding-1',
      generation: '1',
    }).expect(202);
    await operation({
      kind: 'attach',
      childSessionId: '550e8400-e29b-41d4-a716-446655440001',
    }).expect(202);
    await operation({
      kind: 'commit_result',
      result: '审阅通过',
      receipt: '{}',
    }).expect(202);
    await operation({ kind: 'accept' }).expect(202);
    await posted;
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
        expect(consumptionFails).toHaveBeenCalled();
      },
      { timeout: 15_000, interval: 100 },
    );
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === PROMPT_ID,
      ),
    ).toBe(true);
    expect(consumptionFails).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).toContain('consumption faltered');
    log.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
  }, 60_000);

  // The record truth forbids an unproven start: intent-only runs
  // receive `409 child_operation_conflict` both for attach and for
  // fail-started=true. The relay reconciles from the record instead of
  // blaming the wire code, but the wire must refuse those calls anyway.
  it('refuses an attach or start-fail over a run that never dispatched', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const childRunId = `${PROMPT_ID}:call-1`;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const callRequest = {
        name: 'agent',
        callId: 'call-1',
        args: {
          description: 'audit the diff',
          prompt: 'review the change',
          run_in_background: false,
        },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [callRequest],
        [
          {
            functionCall: {
              id: callRequest.callId,
              name: callRequest.name,
              args: callRequest.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'done', model: 'test-model' };
    });
    const operation = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId, ...body });
    const prompt = [{ type: 'text', text: 'run the audit' }];
    const posted = (async () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        }))();
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'child_run',
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    // The intent state has no legal successor for attach or for fail-truth.
    const attachRefused = await operation({
      kind: 'attach',
      childSessionId: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect(attachRefused.status).toBe(409);
    expect(attachRefused.body.code).toBe('child_operation_record');
    const failRefused = await operation({
      kind: 'fail',
      stopReason: 'child_failed',
      started: true,
    });
    expect(failRefused.status).toBe(409);
    expect(failRefused.body.code).toBe('child_operation_record');
    // And the lawful path the honest chain takes: dispatch then attach.
    await operation({
      kind: 'dispatch_started',
      dispatchId: 'dispatch-1',
      runtimeBindingId: 'binding-1',
      generation: '1',
    }).expect(202);
    await operation({
      kind: 'attach',
      childSessionId: '550e8400-e29b-41d4-a716-446655440001',
    }).expect(202);
    await posted;
  }, 60_000);

  // The never-started verdict names its minted Session on the wire:
  // `fail` with `creation_failed` accepts a `childSessionId` and a
  // replay restating it settles, but renaming it answers the relay's
  // readable refusal — 409 child_operation_record — and a malformed id
  // never reaches the record machine at all.
  it('commits a never-started verdict naming its minted Session', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const childRunId = `${PROMPT_ID}:call-1`;
    const childSessionId = '550e8400-e29b-41d4-a716-446655440099';
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const callRequest = {
        name: 'agent',
        callId: 'call-1',
        args: {
          description: 'audit the diff',
          prompt: 'review the change',
          run_in_background: false,
        },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [callRequest],
        [
          {
            functionCall: {
              id: callRequest.callId,
              name: callRequest.name,
              args: callRequest.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'done', model: 'test-model' };
    });
    const operation = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId, ...body });
    const prompt = [{ type: 'text', text: 'run the audit' }];
    const posted = (async () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        }))();
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'child_run',
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    const malformed = await operation({
      kind: 'fail',
      stopReason: 'creation_failed',
      started: false,
      childSessionId: 42,
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('invalid_child_operation');
    await operation({
      kind: 'fail',
      stopReason: 'creation_failed',
      started: false,
      childSessionId,
    }).expect(202);
    // A replay restating the same Session is the same revision.
    await operation({
      kind: 'fail',
      stopReason: 'creation_failed',
      started: false,
      childSessionId,
    }).expect(202);
    const renamed = await operation({
      kind: 'fail',
      stopReason: 'creation_failed',
      started: false,
      childSessionId: '550e8400-e29b-41d4-a716-446655440098',
    });
    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe('child_operation_record');
    await posted;
  }, 60_000);

  // Any early refusal of a claimed request — validation, profile, blocked —
  // still restores the stamped authority. A pre-try return leaking it
  // would attach the claim's lifecycle headers onto this shared client's
  // every later write, and a refusal like that restores nothing at all.
  it('never leaks the claimed stamp through an early refusal', async () => {
    domainEnablement.childRun = true;
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    state.authorizeOrdinary.mockRejectedValue(
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_lifecycle_active',
        'DRAINING',
      ),
    );
    // The validation arm: the childRunId the route rejects with 400
    // invalid_child_operation *after* the claim was stamped.
    state.setLifecycleAuthority.mockClear();
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/children/operations`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        operationId: 'not-a-uuid',
        childRunId: 'prompt:call-1',
        kind: 'cancel',
        authority: {
          operationId: 'close-1',
          claimGeneration: 7,
          kind: 'close',
        },
      });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('invalid_child_operation');
    expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);

    // The profile arm: a Session with no child Agents at all answers
    // hosted_children_unavailable on the same seam — same restore.
    state.authorizeOrdinary.mockRejectedValue(
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_lifecycle_active',
        'DRAINING',
      ),
    );
    const files = await headers(supertest(server).post('/session')).send({
      sessionId: randomUUID(),
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(files.status).toBe(200);
    state.setLifecycleAuthority.mockClear();
    const filesRefused = await headers(
      supertest(server).post(
        `/session/${files.body.sessionId}/children/operations`,
      ),
    )
      .set('X-Qwen-Client-Id', files.body.clientId as string)
      .send({
        operationId: randomUUID(),
        childRunId: 'prompt:call-1',
        kind: 'cancel',
        authority: {
          operationId: 'close-1',
          claimGeneration: 7,
          kind: 'close',
        },
      });
    expect(filesRefused.status).toBe(409);
    expect(filesRefused.body.code).toBe('hosted_children_unavailable');
    expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);
  });

  // P1 (lifecycle fence): with ordinary authorization closed by the
  // closing parent's fence, its own child cleanup must present the
  // matching lifecycle claim to pass — and nothing else may.
  it('admits claimed child operations while the lifecycle fence holds', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    const childRunId = `${PROMPT_ID}:call-1`;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const callRequest = {
        name: 'agent',
        callId: 'call-1',
        args: { description: 'audit the diff', prompt: 'review the change' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      await toolTurn!.execute(
        [callRequest],
        [
          {
            functionCall: {
              id: callRequest.callId,
              name: callRequest.name,
              args: callRequest.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'started', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'launch in the background' }];
    const posted = (async () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        }))();
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        );
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'child_run',
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    await posted;
    // Let the launch turn settle fully: the fence must close only after
    // its answers exist, not against mid-flight writes.
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 15_000, interval: 100 },
    );
    state.authorizeOrdinary.mockRejectedValue(
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_lifecycle_active',
        'DRAINING',
      ),
    );
    const operation = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId, ...body });
    // No claim presented: the ordinary fence keeps refusing.
    const active = await operation({ kind: 'cancel' });
    expect(active.status).toBe(409);
    expect(active.body.code).toBe('hosted_lifecycle_operation_active');
    expect(state.authorizeLifecycle).not.toHaveBeenCalled();
    // The matching lifecycle claim: authorized through its own gate,
    // carrying the lifecycle kind the fence phase requires (the
    // pre-effects evaluation never asks for DRAINING). And at the
    // moment the child operation's verb commits, the store client still
    // carries the claim — the stamp is only restored at the route's
    // own boundary, never before the write.
    const originalRequestStop = HostedChildAgentSession.prototype.requestStop;
    let stampedDuringVerb: unknown;
    vi.spyOn(
      HostedChildAgentSession.prototype,
      'requestStop',
    ).mockImplementation(function (
      this: HostedChildAgentSession,
      runId: string,
    ) {
      stampedDuringVerb = state.setLifecycleAuthority.mock.calls.at(-1)?.[0];
      return originalRequestStop.call(this, runId);
    });
    const first = await operation({
      kind: 'cancel',
      authority: { operationId: 'close-1', claimGeneration: 7, kind: 'close' },
    });
    expect(first.status).toBe(202);
    expect(stampedDuringVerb).toEqual({
      operationId: 'close-1',
      claimGeneration: 7,
    });
    expect(state.authorizeLifecycle).toHaveBeenCalledTimes(1);
    expect(state.authorizeLifecycle).toHaveBeenLastCalledWith('close');
    // A claim the gate itself refuses: conflict, never a silent pass —
    // and the shared client authority is restored, so a fresh valid
    // claim can still be evaluated on the next request.
    state.authorizeLifecycle.mockRejectedValueOnce(
      new ManagedSessionStoreHttpError(
        409,
        'managed_session_lifecycle_claim',
        'stale',
      ),
    );
    const conflict = await operation({
      kind: 'cancel',
      authority: { operationId: 'close-1', claimGeneration: 7, kind: 'close' },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('hosted_lifecycle_operation_conflict');
    expect(state.setLifecycleAuthority).toHaveBeenLastCalledWith(undefined);
    // The very next valid claim evaluates independently of that refusal:
    // it is passed its own lifecycle kind and gets its own gate answer.
    await operation({
      kind: 'cancel',
      authority: { operationId: 'close-2', claimGeneration: 8, kind: 'delete' },
    }).expect(202);
    expect(state.authorizeLifecycle).toHaveBeenCalledTimes(3);
    expect(state.authorizeLifecycle).toHaveBeenLastCalledWith('delete');
    log.mockRestore();
    state.authorizeOrdinary.mockReset();
    state.authorizeOrdinary.mockResolvedValue(undefined);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
  }, 60_000);

  it('settles a running Monitor watch as stop_requested when the Session closes', async () => {
    domainEnablement.monitorRun = true;
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
      'registerPublisher',
    ).mockResolvedValue('1');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
      executionCallId: 'monitor-execution',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [
        {
          text: 'Monitor watch started under unit qwen-mon-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
        },
      ],
      capture: {
        captureStatus: 'detached',
        captureReason: null,
        manifest: null,
        previewTruncated: false,
        deliveryStatus: 'pending',
      },
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledgeV3',
    ).mockResolvedValue();
    state.publicationRequest.mockImplementation(
      async (_resources, route, _body) => {
        if (route === '/grants') return { state: 'OPEN' };
        throw new Error('Unexpected publication route ' + route);
      },
    );
    const stop = vi.spyOn(HostedMonitorLoop.prototype, 'stop');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const readMonitorRun = async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
      const commits = journal.events.filter(
        (event) =>
          event.kind === 'domain.committed' &&
          event.payload['domain'] === 'monitor_run',
      );
      expect(commits.length).toBeGreaterThan(0);
      const ref = assertManagedSessionDurableRef(
        commits.at(-1)!.payload['recordRef'],
        'monitor_run record',
      );
      return parseMonitorRun(
        JSON.parse(
          (
            await LocalManagedSessionResourceStore.create({
              runtimeBaseDir: state.root,
              sessionKey: key,
            }).read(ref)
          ).toString('utf8'),
        ),
      );
    };
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'monitor',
        callId: 'monitor-call',
        args: { command: 'tail -f build.log' },
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
      return { text: 'monitor started', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'watch the build' }];
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
      { timeout: 10_000 },
    );
    // Admission attached the record but nothing settled it: a live
    // observation loop is the only owner of its terminal write.
    expect((await readMonitorRun()).stopReason).toBeNull();
    expect((await readMonitorRun()).run.state).toBe('running');
    expect((await readMonitorRun()).run.execution).toBe('running_attached');
    expect(stop).not.toHaveBeenCalled();
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
    expect(stop).toHaveBeenCalledTimes(1);
    const settled = await readMonitorRun();
    expect(settled.stopReason).toBe('stop_requested');
    expect(settled.run.state).toBe('cancelled');
    expect(settled.run.execution).toBe('settled');
  });

  it('parks a Monitor on runtime_lost when the Session closes over a refused release', async () => {
    domainEnablement.monitorRun = true;
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
    // The turn's terminal settlement rides this release; a busy refusal
    // leaves the Runtime's sweep unproven: the Session is still here, so
    // is every task it hosted, stopped or not — nobody may say which.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockRejectedValue(
      new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy'),
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
      executionCallId: 'monitor-execution',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [
        {
          text: 'Monitor watch started under unit qwen-mon-rt. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.',
        },
      ],
      capture: {
        captureStatus: 'detached',
        captureReason: null,
        manifest: null,
        previewTruncated: false,
        deliveryStatus: 'pending',
      },
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledgeV3',
    ).mockResolvedValue();
    state.publicationRequest.mockImplementation(
      async (_resources, route, _body) => {
        if (route === '/grants') return { state: 'OPEN' };
        throw new Error('Unexpected publication route ' + route);
      },
    );
    const stop = vi.spyOn(HostedMonitorLoop.prototype, 'stop');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const readMonitorRun = async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
      const commits = journal.events.filter(
        (event) =>
          event.kind === 'domain.committed' &&
          event.payload['domain'] === 'monitor_run',
      );
      expect(commits.length).toBeGreaterThan(0);
      const ref = assertManagedSessionDurableRef(
        commits.at(-1)!.payload['recordRef'],
        'monitor_run record',
      );
      return parseMonitorRun(
        JSON.parse(
          (
            await LocalManagedSessionResourceStore.create({
              runtimeBaseDir: state.root,
              sessionKey: key,
            }).read(ref)
          ).toString('utf8'),
        ),
      );
    };
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      })
      .expect(200);
    const clientId = created.body.clientId as string;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'monitor',
        callId: 'monitor-call',
        args: { command: 'tail -f build.log' },
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
      return { text: 'monitor started', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'watch the build' }];
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
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect((await readMonitorRun()).stopReason).toBeNull();
    expect((await readMonitorRun()).run.execution).toBe('running_attached');
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
    // The loop still ends locally — only the record claim changes: the
    // Runtime was never told anything stopped, so the run must keep an
    // unproven end with its rebuild path, never mint stop_requested.
    expect(stop).toHaveBeenCalledTimes(1);
    const parked = await readMonitorRun();
    expect(parked.stopReason).toBeNull();
    expect(parked.run.state).toBe('recovery_blocked');
    expect(parked.run.reason).toBe('runtime_lost');
    expect(parked.run.execution).toBe('outcome_unknown');
  });

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

  it('runs and queries a Hook-only operation without opening a user turn', async () => {
    const { server, authorize, requests } = await hookApp();
    const operationId = randomUUID();
    const operation = {
      operationId,
      event: 'Notification',
      input: { message: 'ready', notification_type: 'test' },
    };
    const response = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send(operation);
    expect(response.status).toBe(200);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
        ).send(operation)
      ).status,
    ).toBe(200);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const conflict = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({ ...operation, input: { ...operation.input, message: 'changed' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('hosted_hook_operation_conflict');
    expect(log).not.toHaveBeenCalled();
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(1);
    const status = await authorize(
      supertest(server).get(
        `/session/${SESSION_ID}/hooks/operations/${operationId}`,
      ),
    );
    expect(status.status).toBe(200);
    expect(status.body.state).toBe('settled');
    expect(
      (await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`)))
        .status,
    ).toBe(204);
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(1);
  });

  it.each([
    ['a Hook operation', 200, 'hosted_hook_operation_active'],
    ['Session deletion', 204, 'hosted_session_closing'],
  ])('refuses a prompt while %s runs', async (trigger, settled, code) => {
    const { server, authorize } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => (dispatched = resolve));
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute') {
        dispatched();
        await held;
      }
      return original(operation);
    });
    const running = (
      trigger === 'Session deletion'
        ? headers(supertest(server).delete(`/session/${SESSION_ID}`))
        : authorize(
            supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
          ).send({
            operationId: randomUUID(),
            event: 'Notification',
            input: { message: 'ready', notification_type: 'test' },
          })
    ).then(
      (response) => response,
      () => undefined,
    );
    await started;
    try {
      const refused = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({});
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe(code);
    } finally {
      finish();
      expect((await running)?.status).toBe(settled);
    }
  });

  it.each(['continue', 'cancel'])(
    'refuses Runtime-only %s for a Hook Session without changing its owner or records',
    async (operation) => {
      const { server, authorize, requests, release } = await hookApp();
      const before = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
      const control = await authorize(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/${operation}`,
        ),
      ).send({
        promptId: PROMPT_ID,
        checkpointId: 'checkpoint',
        activationId: 'activation',
      });
      expect(control.status).toBe(409);
      expect(control.body.code).toBe('hosted_hook_recovery_required');
      expect(requests).toEqual([]);
      expect(release).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      const after = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
      expect(after.body.events).toEqual(before.body.events);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each([1, 2])(
    'recovers Hook activation after %s failed installation(s) without accepting stranded prompts',
    async (failures) => {
      const { server, authorize } = await hookApp();
      const install = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'installActivation',
      );
      for (let index = 0; index < failures; index++)
        install.mockRejectedValueOnce(new Error('activation unavailable'));
      const operation = {
        operationId: randomUUID(),
        event: 'Notification',
        input: { message: 'ready', notification_type: 'test' },
      };
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
      )
        .send(operation)
        .expect(503);
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      if (failures === 2) {
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({ prompt, promptId: PROMPT_ID, payloadDigest })
          .expect(409);
        expect(state.model).not.toHaveBeenCalled();
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
        )
          .send(operation)
          .expect(200);
      }
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      expect(state.model).toHaveBeenCalledOnce();
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each([
    [
      'managed_hook_handler_unavailable',
      HookEventName.UserPromptSubmit,
      false,
      false,
    ],
    [
      'managed_hook_command_isolation_unavailable',
      HookEventName.UserPromptSubmit,
      false,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.SessionStart,
      false,
      false,
    ],
    [
      'managed_hook_command_isolation_unavailable',
      HookEventName.SessionStart,
      false,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.SessionStart,
      true,
      false,
    ],
    [
      'managed_hook_command_isolation_unavailable',
      HookEventName.SessionStart,
      true,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.SessionStart,
      false,
      true,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.PreToolUse,
      false,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.UserPromptSubmit,
      true,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.UserPromptSubmit,
      false,
      true,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.InstructionsLoaded,
      false,
      false,
    ],
    [
      'managed_hook_command_isolation_unavailable',
      HookEventName.InstructionsLoaded,
      false,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.InstructionsLoaded,
      true,
      false,
    ],
    [
      'managed_hook_handler_unavailable',
      HookEventName.InstructionsLoaded,
      false,
      true,
    ],
    [
      'unrecognized_runtime_error',
      HookEventName.InstructionsLoaded,
      false,
      false,
    ],
  ] as const)(
    'settles only a cancelled pre-model Hook (%s, %s, reload=%s, modelStarted=%s)',
    async (code, event, reload, modelStarted) => {
      const { server, authorize, catalog, requests, definition } =
        await hookApp();
      Object.assign(catalog, {
        hooks: [
          {
            ...catalog.hooks[0],
            eventName: event,
            onceKey: 'submit-once',
          },
        ],
      });
      const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
      const original = control.getMockImplementation()!;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'hook-execute') {
          requests.push(operation);
          return {
            operationId: operation.operationId,
            state: 'settled',
            error: { code },
          };
        }
        return original.call(this, operation);
      });
      state.model.mockImplementationOnce(
        async ({ hooks, promptId, signal, modelScope }) => {
          if (modelStarted) await modelScope!.beginMainAttempt('test-model');
          await hooks!.fire(
            event,
            event === HookEventName.SessionStart
              ? `session-start:${SESSION_ID}`
              : event === HookEventName.InstructionsLoaded
                ? `${promptId}:native:${'c'.repeat(64)}:0`
                : promptId!,
            { prompt_id: promptId },
            signal,
          );
          throw new Error('The refused Hook must stop this turn.');
        },
      );
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: 10_000 },
      );
      const child = requests.find((entry) => entry.kind === 'hook-execute')!;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const write = vi.spyOn(ManagedSessionRecordSink.prototype, 'write');
      if (reload)
        write.mockImplementation(function (
          this: ManagedSessionRecordSink,
          record,
        ) {
          if (record.subtype === 'turn_result')
            throw new Error('settlement unavailable');
          return originalWrite.call(this, record);
        });
      await authorize(
        supertest(server).post(
          `/session/${SESSION_ID}/hooks/operations/${child.operationId}/cancel`,
        ),
      ).expect(reload ? 409 : 200);
      if (reload) {
        const blocked = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(blocked.body.recoveryBlocked).toBe(true);
        write.mockRestore();
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/detach`),
        ).expect(204);
        const replacement = await app(true);
        const loaded = await headers(
          supertest(replacement).post(`/session/${SESSION_ID}/load`),
        )
          .send({
            ...definition,
            ...(event === HookEventName.UserPromptSubmit
              ? { driveRuntimeRecovery: true }
              : { passiveManagedRuntimeRecovery: true }),
          })
          .expect(200);
        expect(loaded.body.recoveryRequired).toBeUndefined();
        await headers(
          supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId)
          .send({ prompt, promptId: randomUUID(), payloadDigest })
          .expect(202);
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(replacement).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: 10_000 },
        );
        return;
      }
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      if (
        event === HookEventName.PreToolUse ||
        modelStarted ||
        code === 'unrecognized_runtime_error'
      ) {
        expect(status.body.recoveryBlocked).toBe(true);
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({ prompt, promptId: randomUUID(), payloadDigest })
          .expect(409);
        return;
      }
      expect(status.body.recoveryBlocked).toBe(false);
      const transcript = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_complete',
            promptId: PROMPT_ID,
          }),
        ]),
      );
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: randomUUID(), payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send(definition)
        .expect(200);
      expect(loaded.body.recoveryRequired).toBeUndefined();
    },
  );

  it.each([
    'single',
    'batch',
    'result-write-failure',
    'result-ack-failure',
    'terminal-write-failure',
    'reload',
    'unknown',
    'unfinished-model',
    'wrong-prompt',
    'wrong-call',
    'large-batch',
    'large-batch-partial',
    'large-batch-reload',
    'large-batch-utf8',
  ])(
    'recovers only proven-unstarted cancelled PreToolUse (%s)',
    async (mode) => {
      const { server, authorize, catalog, requests, definition } =
        await hookApp();
      const large = mode.startsWith('large-batch');
      if (large) {
        const actual = await vi.importActual<
          typeof import('@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js')
        >(
          '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js',
        );
        const bounded = actual.createHttpManagedSessionStores({
          baseUrl: 'http://127.0.0.1:8080',
          writerId: BOOT_ID,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        }).resourceStore;
        const publish = LocalManagedSessionResourceStore.prototype.publish;
        vi.spyOn(
          LocalManagedSessionResourceStore.prototype,
          'publish',
        ).mockImplementation(async function (
          this: LocalManagedSessionResourceStore,
          kind,
          bytes,
        ) {
          await bounded.publish(kind, bytes);
          return publish.call(this, kind, bytes);
        });
      }
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], eventName: HookEventName.PreToolUse }],
      });
      if (mode.startsWith('wrong-')) {
        const fire = HostedHookSession.prototype.fire;
        vi.spyOn(HostedHookSession.prototype, 'fire').mockImplementation(
          function (
            this: HostedHookSession,
            event,
            operationId,
            input,
            ...rest
          ) {
            return fire.call(
              this,
              event,
              operationId,
              {
                ...input,
                ...(event === HookEventName.PreToolUse
                  ? mode === 'wrong-prompt'
                    ? { prompt_id: randomUUID() }
                    : { tool_use_id: 'different-call' }
                  : {}),
              },
              ...rest,
            );
          },
        );
      }
      const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
      const original = control.getMockImplementation()!;
      control.mockImplementation(async (operation) => {
        if (operation.kind !== 'hook-execute') return original(operation);
        requests.push(operation);
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: {
            code:
              mode === 'unknown'
                ? 'unrecognized_runtime_error'
                : 'managed_hook_handler_unavailable',
          },
        };
      });
      const calls = Array.from(
        { length: large ? 650 : mode === 'single' ? 1 : 2 },
        (_, i) => ({
          name: large ? 'read_file' : 'write_file',
          callId: mode === 'large-batch-utf8' ? `调用-${i}` : `call-${i}`,
          args: large
            ? { file_path: 'x' }
            : { file_path: `notes-${i}.txt`, content: 'hello' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        }),
      );
      state.model.mockImplementationOnce(
        async ({ toolTurn, signal, modelScope }) => {
          const complete = await modelScope!.beginMainAttempt('test-model');
          if (mode !== 'unfinished-model') await complete(true, []);
          await toolTurn!.execute(
            calls,
            calls.map((call) => ({
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            })),
            'test-model',
            signal,
          );
          throw new Error('The refused Hook must stop this turn.');
        },
      );
      const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
      const prompt = [{ type: 'text', text: 'write notes' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: true,
          });
        },
        { timeout: 10_000 },
      );
      const child = requests.find((entry) => entry.kind === 'hook-execute')!;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const write = vi.spyOn(ManagedSessionRecordSink.prototype, 'write');
      const reload = mode === 'reload' || mode === 'large-batch-reload';
      const fail =
        mode.includes('failure') || reload || mode === 'large-batch-partial';
      let resultWrites = 0;
      if (fail)
        write.mockImplementation(async function (
          this: ManagedSessionRecordSink,
          record,
        ) {
          if (large && record.type === 'tool_result' && ++resultWrites === 2)
            throw new Error('second result write unavailable');
          if (record.type === 'tool_result' && mode.startsWith('result-')) {
            if (mode === 'result-ack-failure')
              await originalWrite.call(this, record);
            throw new Error('result write unavailable');
          }
          if (
            !large &&
            record.subtype === 'turn_result' &&
            !mode.startsWith('result-')
          )
            throw new Error('settlement unavailable');
          return originalWrite.call(this, record);
        });
      await authorize(
        supertest(server).post(
          `/session/${SESSION_ID}/hooks/operations/${child.operationId}/cancel`,
        ),
      ).expect(fail ? 409 : 200);
      if (
        fail ||
        mode === 'unknown' ||
        mode === 'unfinished-model' ||
        mode.startsWith('wrong-')
      ) {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(true);
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({ prompt, promptId: randomUUID(), payloadDigest })
          .expect(409);
        if (large || mode === 'result-ack-failure') {
          const partial = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          );
          const results: ChatRecord[] = partial.body.events.flatMap(
            (event: { data?: { record?: ChatRecord } }) =>
              event.data?.record?.type === 'tool_result'
                ? [event.data.record]
                : [],
          );
          expect(results).toHaveLength(1);
          expect(results[0].message!.parts!.length).toBeGreaterThan(0);
          if (large)
            expect(results[0].message!.parts!.length).toBeLessThan(
              calls.length,
            );
          else
            expect(
              results[0].message!.parts!.map(
                (part) => part.functionResponse?.id,
              ),
            ).toEqual(calls.map((call) => call.callId));
          expect(
            partial.body.events.filter(
              (event: { type: string }) => event.type === 'turn_complete',
            ),
          ).toHaveLength(0);
        }
        if (!fail) return;
      }
      write.mockRestore();
      let owner = authorize;
      let recovered = server;
      if (reload) {
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/detach`),
        ).expect(204);
        recovered = await app(true);
        const loaded = await headers(
          supertest(recovered).post(`/session/${SESSION_ID}/load`),
        )
          .send(definition)
          .expect(200);
        expect(loaded.body.recoveryRequired).toBeUndefined();
        owner = (request) =>
          headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
      } else {
        await Promise.all(
          [0, 1].map(() =>
            owner(
              supertest(recovered).get(
                `/session/${SESSION_ID}/hooks/operations/${child.operationId}`,
              ),
            ).expect(200),
          ),
        );
      }
      const status = await owner(
        supertest(recovered).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.recoveryBlocked).toBe(false);
      const transcript = await owner(
        supertest(recovered).get(`/session/${SESSION_ID}/transcript`),
      );
      const records: ChatRecord[] = transcript.body.events.flatMap(
        (event: { data?: { record?: ChatRecord } }) =>
          event.data?.record ? [event.data.record] : [],
      );
      const responses = records.flatMap(
        (record) =>
          record.message?.parts?.flatMap((part) =>
            part.functionResponse ? [part.functionResponse] : [],
          ) ?? [],
      );
      if (large) {
        const results = records.filter(
          (record) => record.type === 'tool_result',
        );
        expect(results).toHaveLength(2);
        for (const record of results)
          expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(
            64 * 1024,
          );
        const assistant = records.find(
          (record) => record.type === 'assistant',
        )!;
        expect(results[0].parentUuid).toBe(assistant.uuid);
        expect(results[1].parentUuid).toBe(results[0].uuid);
        expect(
          Buffer.byteLength(JSON.stringify(assistant)),
        ).toBeLessThanOrEqual(64 * 1024);
        expect(
          Buffer.byteLength(
            JSON.stringify({
              ...results[0],
              message: {
                role: 'user',
                parts: results.flatMap((record) => record.message!.parts!),
              },
            }),
          ),
        ).toBeGreaterThan(64 * 1024);
      }
      expect(responses).toEqual(
        calls.map((call) => ({
          id: call.callId,
          name: call.name,
          response: { error: expect.stringContaining('cancelled') },
        })),
      );
      expect(
        transcript.body.events.filter(
          (event: { type: string }) => event.type === 'turn_complete',
        ),
      ).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      expect(
        requests.filter((entry) => entry.kind === 'hook-execute'),
      ).toHaveLength(1);
      await owner(supertest(recovered).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: randomUUID(), payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await owner(
            supertest(recovered).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      await owner(
        supertest(recovered).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each([HookEventName.SessionStart, HookEventName.InstructionsLoaded])(
    'does not settle a later turn from a previously cancelled %s',
    async (event) => {
      const { server, authorize, catalog, requests, definition } =
        await hookApp();
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], eventName: event }],
      });
      const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
      const original = control.getMockImplementation()!;
      control.mockImplementation(async (operation) => {
        if (operation.kind !== 'hook-execute') return original(operation);
        requests.push(operation);
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_hook_handler_unavailable' },
        };
      });
      state.model.mockImplementationOnce(
        async ({ hooks, promptId, signal }) => {
          await hooks!.fire(
            event,
            event === HookEventName.SessionStart
              ? `session-start:${SESSION_ID}`
              : `${promptId}:native:${'c'.repeat(64)}:0`,
            { prompt_id: promptId },
            signal,
          );
          throw new Error('The refused Hook must stop this turn.');
        },
      );
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const submit = (promptId: string) =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId,
            payloadDigest,
          },
        );
      const expectBlocked = () =>
        vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(status.body).toMatchObject({
              hasActivePrompt: false,
              recoveryBlocked: true,
            });
          },
          { timeout: 10_000 },
        );
      await submit(PROMPT_ID).expect(202);
      await expectBlocked();
      const child = requests.find(
        (operation) => operation.kind === 'hook-execute',
      )!;
      const route = `/session/${SESSION_ID}/hooks/operations/${child.operationId}`;
      await authorize(supertest(server).post(`${route}/cancel`)).expect(200);

      state.model.mockRejectedValueOnce(new HostedHookRecoveryRequiredError());
      await submit(randomUUID()).expect(202);
      await expectBlocked();
      await authorize(supertest(server).get(route)).expect(200);
      await submit(randomUUID()).expect(409);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send(definition)
        .expect(200);
      expect(loaded.body.recoveryRequired).toBe(true);
      expect(
        requests.filter((operation) => operation.kind === 'hook-execute'),
      ).toHaveLength(1);
    },
  );

  it.each([
    undefined,
    'managed-hook-message-chunks',
    'managed-hook-message-part',
  ])(
    'restores the saved Hook pin and verifies its message closure (missing: %s)',
    async (missingKind) => {
      const { server, authorize, catalog, requests } = await hookApp();
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], config: { type: 'function' } }],
      });
      for (let index = 0; index < 2; index++) {
        const prompt = [{ type: 'text', text: 'x'.repeat(40 * 1024) }];
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({
            prompt,
            promptId: randomUUID(),
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(false);
          },
          { timeout: 10_000 },
        );
      }
      const operation = {
        operationId: randomUUID(),
        event: 'Notification',
        input: { message: 'ready', notification_type: 'test' },
      };
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
      )
        .send(operation)
        .expect(200);
      expect(
        requests.filter((request) => request.kind === 'hook-execute'),
      ).toHaveLength(1);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/hooks/registrations`),
      )
        .send({
          operationId: randomUUID(),
          expectedRevision: 1,
          catalog: { ...hookPin, catalogRevision: 2 },
        })
        .expect(200);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
      const replacement = await app(true);
      await headers(supertest(replacement).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          hookCatalog: { ...hookPin, catalogRevision: 2 },
        })
        .expect(409);
      if (missingKind) {
        const read = LocalManagedSessionResourceStore.prototype.read;
        const damaged = vi
          .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
          .mockImplementation(function (
            this: LocalManagedSessionResourceStore,
            ref,
          ) {
            return ref.kind === missingKind
              ? Promise.reject(new Error('missing Hook snapshot resource'))
              : read.call(this, ref);
          });
        const refused = await headers(
          supertest(replacement).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_turn_recovery_required');
        damaged.mockRestore();
      }
      const reads = new Map<string, { kind: string; count: number }>();
      const read = LocalManagedSessionResourceStore.prototype.read;
      const counted = vi
        .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
        .mockImplementation(function (
          this: LocalManagedSessionResourceStore,
          ref,
        ) {
          if (ref.kind.startsWith('managed-hook')) {
            const entry = reads.get(ref.resourceId);
            reads.set(ref.resourceId, {
              kind: ref.kind,
              count: (entry?.count ?? 0) + 1,
            });
          }
          return read.call(this, ref);
        });
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      counted.mockRestore();
      expect(loaded.status).toBe(200);
      // The load verified every Hook record, input, result and message part
      // once, however many revisions name it. A plan is read again to walk
      // its message snapshot.
      expect(reads.size).toBeGreaterThan(10);
      expect(
        [...reads.values()].filter(
          ({ kind, count }) => count !== (kind === 'managed-hook-plan' ? 2 : 1),
        ),
      ).toEqual([]);
      const restored = (request: supertest.Test) =>
        headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
      await restored(
        supertest(replacement).post(`/session/${SESSION_ID}/hooks/operations`),
      )
        .send(operation)
        .expect(200);
      const current = await restored(
        supertest(replacement).get(`/session/${SESSION_ID}/hooks`),
      );
      expect(current.body.catalog.catalogRevision).toBe(2);
      expect(
        requests.filter((request) => request.kind === 'hook-execute'),
      ).toHaveLength(1);
      expect(state.model).toHaveBeenCalledTimes(2);
      await restored(
        supertest(replacement).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it('finishes a stopped Hook turn after its final settlement write is lost', async () => {
    const { server, authorize, definition, catalog, requests } =
      await hookApp();
    Object.assign(catalog, {
      hooks: [
        {
          ...catalog.hooks[0],
          hookId: 'stop-after-tools',
          eventName: HookEventName.PostToolBatch,
        },
      ],
    });
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const originalControl = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      const response = await originalControl(operation);
      return operation.kind === 'hook-execute'
        ? {
            ...response,
            result: {
              success: true,
              outcome: 'success' as const,
              duration: 0,
              output: { continue: false, stopReason: 'Stopped after tools.' },
            },
          }
        : response;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '55555555-5555-4555-8555-555555555555',
    );
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'original result' }],
      });
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failFinalSettlement = true;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.subtype === 'turn_result' && failFinalSettlement)
          throw new Error('lost final settlement');
        return originalWrite.call(this, record);
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'stopped-call',
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
      expect(toolTurn!.hookStopReason).toBe('Stopped after tools.');
      return { text: toolTurn!.hookStopReason!, model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'read a' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const saved = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      key,
    );
    const checkpoint = saved.events.findLast(
      (event) => event.kind === 'checkpoint.committed',
    )!;
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const savedState = JSON.parse(
      (
        await resources.read(
          assertManagedSessionDurableRef(
            checkpoint.payload['stateRef'],
            'checkpoint',
          ),
        )
      ).toString(),
    );
    expect(savedState.continuation.phase).toBe('turn_settled');
    expect(savedState.tools.items).toEqual([
      expect.objectContaining({ state: 'settled', consumed: false }),
    ]);
    expect(saved.events.some((event) => event.kind === 'turn.settled')).toBe(
      false,
    );
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
    failFinalSettlement = false;
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    ).send(definition);
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).not.toBe(true);
    const restored = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
    await vi.waitFor(
      async () => {
        const status = await restored(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 10_000 },
    );
    const transcript = await restored(
      supertest(replacement).get(`/session/${SESSION_ID}/transcript`),
    );
    expect(
      transcript.body.events.filter(
        (event: { type: string }) => event.type === 'turn_complete',
      ),
    ).toHaveLength(1);
    expect(state.model).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(
      requests.filter((operation) => operation.kind === 'hook-execute'),
    ).toHaveLength(1);
    await restored(supertest(replacement).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: randomUUID(), payloadDigest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await restored(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 10_000 },
    );
    await restored(
      supertest(replacement).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it.each([false, true])(
    'reports and clears the unknown Hook fence (reload: %s)',
    async (reload) => {
      const append = vi.spyOn(
        LocalJsonlManagedSessionJournalHandle.prototype,
        'appendTransaction',
      );
      const { server, authorize, requests, release, definition } =
        await hookApp();
      const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
      const original = control.getMockImplementation()!;
      let known = false;
      control.mockImplementation(async (operation) => {
        if (operation.kind === 'hook-catalog') return original(operation);
        requests.push(operation);
        const operationId =
          operation.kind === 'hook-status' || operation.kind === 'hook-cancel'
            ? operation.targetOperationId
            : operation.operationId;
        return known
          ? {
              operationId,
              state: 'settled',
              result: { success: true, outcome: 'success', duration: 0 },
            }
          : { operationId, state: 'outcome_unknown' };
      });
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const operationId = randomUUID();
      const send = (id: string) =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
        ).send({
          operationId: id,
          event: 'Notification',
          input: { message: 'effect', notification_type: 'test' },
        });
      const unknown = await send(operationId);
      expect(unknown.status).toBe(503);
      expect(unknown.body.code).toBe('hosted_hook_operation_failed');
      expect((await send(randomUUID())).status).toBe(409);
      const replay = await send(operationId);
      expect(replay.status).toBe(503);
      expect(replay.body.code).toBe('hosted_hook_operation_failed');
      const blocked = `qwen serve: Hosted Hook operation ${operationId} is recovery blocked: Error: Hosted Hook requires reconciliation of its original execution.`;
      expect(
        log.mock.calls
          .map(([line]) => line)
          .filter((line) => line.includes('Hosted Hook operation')),
      ).toEqual([blocked, blocked]);
      expect(
        (
          await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          )
        ).body.recoveryBlocked,
      ).toBe(true);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(503);
      expect(release).not.toHaveBeenCalled();
      let current = server;
      let owner = authorize;
      if (reload) {
        await (
          append.mock.contexts[0] as LocalJsonlManagedSessionJournalHandle
        ).abort();
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60 * 1000);
        current = await app(true);
        const loaded = await headers(
          supertest(current).post(`/session/${SESSION_ID}/load`),
        )
          .send(definition)
          .expect(200);
        expect(loaded.body.recoveryRequired).toBe(true);
        owner = (request) =>
          headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
      }
      expect(
        (await owner(supertest(current).get(`/session/${SESSION_ID}/status`)))
          .body.recoveryBlocked,
      ).toBe(true);
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const submit = () =>
        owner(supertest(current).post(`/session/${SESSION_ID}/prompt`)).send({
          prompt,
          promptId: randomUUID(),
          payloadDigest,
        });
      await submit().expect(409);
      expect(state.model).not.toHaveBeenCalled();
      expect(
        requests.filter((request) => request.kind === 'hook-execute'),
      ).toHaveLength(1);
      known = true;
      await owner(
        supertest(current).get(
          `/session/${SESSION_ID}/hooks/operations/${operationId}`,
        ),
      ).expect(200);
      expect(
        (await owner(supertest(current).get(`/session/${SESSION_ID}/status`)))
          .body.recoveryBlocked,
      ).toBe(false);
      await submit().expect(202);
      await vi.waitFor(
        async () => {
          const status = await owner(
            supertest(current).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: 10_000 },
      );
      expect(state.model).toHaveBeenCalledOnce();
      await owner(
        supertest(current).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it('logs the cause of a failed Hook operation before answering 503', async () => {
    const { server, authorize } = await hookApp();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'installActivation',
    ).mockRejectedValueOnce(new Error('activation unavailable'));
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const operationId = randomUUID();
    const failed = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({
      operationId,
      event: 'Notification',
      input: { message: 'ready', notification_type: 'test' },
    });
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('hosted_hook_operation_failed');
    expect(log).toHaveBeenCalledWith(
      `qwen serve: Hosted Hook operation ${operationId} failed: Error: activation unavailable`,
    );
  });

  it('settles End and Delete before releasing the Hook Runtime', async () => {
    const { server, authorize, requests, release } = await hookApp();
    const order: string[] = [];
    const released: Array<[string, boolean]> = [];
    release.mockImplementation(async function (this: HostedWorkspaceBroker) {
      released.push([this.runtimeSessionId, Boolean(this.runtime)]);
      if (this.runtime) order.push('release');
    });
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute')
        order.push(operation.input.hook_event_name);
      return original(operation);
    });
    expect(
      (await authorize(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    expect(order).toEqual(['SessionEnd', 'SessionDelete', 'release']);
    // Both Hook operations replaced the load activation and restored it;
    // neither names an earlier owner, so only this load's Runtime is released.
    expect(released).toEqual([
      [expect.stringMatching(/^hooks-activation-/), true],
    ]);
    expect(
      requests.filter((request) => request.kind === 'hook-execute'),
    ).toHaveLength(2);
    expect(
      requests
        .filter((request) => request.kind === 'hook-execute')
        .map((request) => request.input),
    ).toEqual([
      expect.objectContaining({
        hook_event_name: 'SessionEnd',
        reason: 'other',
      }),
      expect.objectContaining({
        hook_event_name: 'SessionDelete',
        deleted_session_id: SESSION_ID,
      }),
    ]);
  });

  it('logs a failed Session deletion and keeps the Session usable', async () => {
    const { server, authorize } = await hookApp();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'installActivation',
    ).mockRejectedValueOnce(new Error('activation unavailable'));
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('managed_session_close_failed');
    expect(log).toHaveBeenCalledWith(
      `qwen serve: Hosted Session ${SESSION_ID} close failed: Error: activation unavailable`,
    );
    // The busy guards run before body validation, so an empty prompt shows
    // the deletion cleared its Hook flag.
    const prompt = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({});
    expect(prompt.status).toBe(400);
    expect(prompt.body.code).toBe('invalid_hosted_prompt');
    expect(
      (await authorize(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it('pins dynamic Hook revisions and rejects unscoped operations', async () => {
    const { server, authorize } = await hookApp();
    const operationId = randomUUID();
    const route = `/session/${SESSION_ID}/hooks/registrations`;
    const catalog = { ...hookPin, catalogRevision: 2 };
    expect(
      (
        await headers(supertest(server).post(route)).send({
          operationId,
          expectedRevision: 0,
          catalog,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await authorize(supertest(server).post(route)).send({
          operationId,
          expectedRevision: 0,
          catalog,
        })
      ).status,
    ).toBe(200);
    const current = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/hooks`),
    );
    expect(current.body.catalog.catalogRevision).toBe(2);
    expect(JSON.stringify(current.body)).not.toContain('"config"');
    expect(
      (
        await authorize(supertest(server).post(route)).send({
          operationId: randomUUID(),
          expectedRevision: 0,
          catalog,
        })
      ).status,
    ).toBe(409);
    expect(
      (await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`)))
        .status,
    ).toBe(204);
  });

  it('refuses file history APIs on the MCP profile without blocking its session', async () => {
    const { server, authorize } = await mcpApp();
    const history = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    );
    expect(history.status).toBe(409);
    expect(history.body.code).toBe('hosted_file_history_unavailable');
    const undo = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    ).send({ promptId: PROMPT_ID, requestId: randomUUID() });
    expect(undo.status).toBe(409);
    expect(undo.body.code).toBe('hosted_file_history_unavailable');
    expect(HostedWorkspaceBroker.prototype.fileHistory).not.toHaveBeenCalled();
    const status = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    );
    expect(status.body.recoveryBlocked).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it.each([false, true])(
    'unblocks MCP resource requests after the original unknown operation settles (Broker restarted: %s)',
    async (restartBroker) => {
      const { server, authorize, requests, replies, brokerOwners } =
        await mcpApp();
      const operationId = randomUUID();
      replies.set(operationId, { operationId, state: 'outcome_unknown' });
      const send = (id: string) =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
        ).send({
          operationId: id,
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        });
      expect((await send(operationId)).body.state).toBe('outcome_unknown');
      const status = () =>
        authorize(supertest(server).get(`/session/${SESSION_ID}/status`));
      expect((await status()).body.recoveryBlocked).toBe(true);
      expect((await send(randomUUID())).status).toBe(409);
      const prompt = [{ type: 'text', text: 'blocked by raw operation' }];
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/prompt`),
          ).send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
        ).status,
      ).toBe(409);
      expect(state.model).not.toHaveBeenCalled();

      const settled: ManagedMcpOperationView = {
        operationId,
        state: 'settled',
        response: { contents: [{ uri: 'memory://note', text: 'late result' }] },
      };
      replies.set(operationId, settled);
      const originalOwner = [...brokerOwners][0];
      if (restartBroker) brokerOwners.clear();
      const recovered = await authorize(
        supertest(server).get(
          `/session/${SESSION_ID}/mcp/operations/${operationId}`,
        ),
      );
      expect(recovered.status).toBe(200);
      expect(recovered.body).toEqual(settled);
      expect([...brokerOwners]).toEqual([originalOwner]);
      expect((await status()).body.recoveryBlocked).toBe(false);
      const next = await send(randomUUID());
      expect(next.status).toBe(202);
      expect(next.body.state).toBe('settled');
      expect(
        requests.filter((request) => request.kind === 'mcp-invoke'),
      ).toHaveLength(2);
      expect(
        requests.filter((request) => request.kind === 'mcp-configure'),
      ).toHaveLength(1);
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
  );

  it.each(['cancel', 'deadline'] as const)(
    'stops first-prompt MCP initialization after %s without admitting input or configuring another server',
    async (ending) => {
      const { server, authorize, requests, replies } = await mcpApp(false, [
        'demo',
        'second',
      ]);
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const original = control.getMockImplementation()!;
      const admit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'submitInput',
      );
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let configurationId: string | undefined;
      let returned = false;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        const response = await original.call(this, operation);
        if (
          operation.kind === 'mcp-configure' &&
          operation.serverId === 'demo'
        ) {
          configurationId = operation.operationId;
          replies.set(configurationId, {
            operationId: configurationId,
            state: 'outcome_unknown',
          });
          await pending;
          replies.set(configurationId, response);
          returned = true;
        }
        return response;
      });
      const prompt = [{ type: 'text', text: 'cancel initial discovery' }];
      const send = (id: string, deadlineMs?: number) =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId: id,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
            ...(deadlineMs === undefined ? {} : { deadlineMs }),
          },
        );
      let response: supertest.Response | undefined;
      const submitted = send(
        PROMPT_ID,
        ending === 'deadline' ? 1000 : undefined,
      ).then((value) => {
        response = value;
      });
      try {
        await vi.waitFor(() => expect(configurationId).toBeDefined(), {
          timeout: 10_000,
        });
        if (ending === 'cancel')
          expect(
            (
              await authorize(
                supertest(server).post(`/session/${SESSION_ID}/cancel`),
              )
            ).status,
          ).toBe(204);
        await vi.waitFor(() => expect(response).toBeDefined(), {
          timeout: 3000,
        });
        expect(response!.status).toBe(503);
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(admit).not.toHaveBeenCalled();
        expect(state.model).not.toHaveBeenCalled();
        expect((await send(randomUUID())).body.error).toBe(
          'hosted_mcp_recovery_required',
        );
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(503);
        finish();
        await vi.waitFor(() => expect(returned).toBe(true));
        expect(
          requests
            .filter((request) => request.kind === 'mcp-configure')
            .map((request) => request.serverId),
        ).toEqual(['demo']);
        expect(admit).not.toHaveBeenCalled();
        expect((await send(randomUUID())).status).toBe(202);
        await vi.waitFor(
          async () =>
            expect(
              (
                await authorize(
                  supertest(server).get(`/session/${SESSION_ID}/status`),
                )
              ).body.hasActivePrompt,
            ).toBe(false),
          { timeout: 10_000 },
        );
        expect(
          requests
            .filter((request) => request.kind === 'mcp-configure')
            .map((request) => request.serverId),
        ).toEqual(['demo', 'second']);
        expect(state.model).toHaveBeenCalledOnce();
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(204);
      } finally {
        finish();
        await submitted;
        await vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(status.status === 404 || !status.body.hasActivePrompt).toBe(
              true,
            );
          },
          { timeout: 10_000 },
        );
        await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );

  it('does not admit input when cancellation arrives during publication after MCP initialization', async () => {
    const { server, authorize } = await mcpApp();
    const original = LocalManagedSessionResourceStore.prototype.publish;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let publishing = false;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      ...args
    ) {
      const result = await original.apply(this, args);
      if (args[0] === 'managed-input') {
        publishing = true;
        await pending;
      }
      return result;
    });
    const admit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'submitInput',
    );
    const prompt = [{ type: 'text', text: 'cancel before input admission' }];
    const submitted = authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(publishing).toBe(true));
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/cancel`),
          )
        ).status,
      ).toBe(204);
      finish();
      expect((await submitted).status).toBe(503);
      expect(admit).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
    } finally {
      finish();
      await submitted;
    }
  });

  it.each(['status', 'cancel'] as const)(
    'serves MCP %s during dispatch and keeps admissions fenced until both finish',
    async (kind) => {
      const { server, authorize, requests, replies } = await mcpApp();
      const operationId = randomUUID();
      replies.set(operationId, { operationId, state: 'outcome_unknown' });
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const original = control.getMockImplementation()!;
      let finishInvoke!: () => void;
      let finishRecovery!: () => void;
      const invoking = new Promise<void>((resolve) => {
        finishInvoke = resolve;
      });
      const recovering = new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });
      let invokeStarted = false;
      let recoveryStarted = false;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'mcp-invoke') {
          invokeStarted = true;
          await invoking;
        }
        if (
          operation.kind === (kind === 'status' ? 'mcp-status' : 'mcp-cancel')
        ) {
          recoveryStarted = true;
          await recovering;
        }
        return original.call(this, operation);
      });
      const invoke = authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      )
        .send({
          operationId,
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        })
        .then((response) => response);
      let recovery: Promise<supertest.Response> | undefined;
      try {
        await vi.waitFor(() => expect(invokeStarted).toBe(true));
        const url = `/session/${SESSION_ID}/mcp/operations/${operationId}`;
        recovery = authorize(
          kind === 'status'
            ? supertest(server).get(url)
            : supertest(server).post(`${url}/cancel`),
        ).then((response) => response);
        await vi.waitFor(() => expect(recoveryStarted).toBe(true));
        finishInvoke();
        expect((await invoke).status).toBe(202);
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(409);
        const prompt = [{ type: 'text', text: 'still recovering' }];
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/prompt`),
            ).send({
              prompt,
              promptId: PROMPT_ID,
              payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
            })
          ).status,
        ).toBe(409);
        finishRecovery();
        expect((await recovery).status).toBe(kind === 'status' ? 200 : 202);
        expect(
          requests.filter((request) => request.kind === 'mcp-invoke'),
        ).toHaveLength(1);
        const settled: ManagedMcpOperationView = {
          operationId,
          state: 'settled',
          response: { contents: [] },
        };
        replies.set(operationId, settled);
        expect((await authorize(supertest(server).get(url))).body).toEqual(
          settled,
        );
        expect(
          (
            await authorize(
              supertest(server).post(`/session/${SESSION_ID}/detach`),
            )
          ).status,
        ).toBe(204);
      } finally {
        finishInvoke();
        finishRecovery();
        await invoke;
        await recovery;
      }
    },
  );

  it('refuses every MCP operation and prompt admission while close is pending', async () => {
    const { server, authorize } = await mcpApp();
    const resource = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      ).send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      });
    const operationId = (await resource()).body.operationId as string;
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const original = control.getMockImplementation()!;
    let released: () => void = () => undefined;
    const releasePending = new Promise<void>((resolve) => {
      released = resolve;
    });
    let releasing = false;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (operation.kind === 'mcp-release') {
        releasing = true;
        await releasePending;
      }
      return original.call(this, operation);
    });
    const closed = headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).then((response) => response);
    const admit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'submitInput',
    );
    try {
      await vi.waitFor(() => expect(releasing).toBe(true));
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const sendPrompt = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest,
      });
      expect(sendPrompt.status).toBe(409);
      const configure = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
      ).send({
        operationId: randomUUID(),
        expectedRevision: 1,
        server: {
          serverId: 'demo',
          serverRevision: 2,
          definitionDigest: 'b'.repeat(64),
        },
      });
      expect(configure.status).toBe(409);
      expect((await resource()).status).toBe(409);
      expect(
        (
          await authorize(
            supertest(server).get(
              `/session/${SESSION_ID}/mcp/operations/${operationId}`,
            ),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await authorize(
            supertest(server).post(
              `/session/${SESSION_ID}/mcp/operations/${operationId}/cancel`,
            ),
          )
        ).status,
      ).toBe(409);
      expect(admit).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
    } finally {
      released();
    }
    expect((await closed).status).toBe(204);
  });

  it.each([
    [
      'an MCP configuration',
      'mcp-configure',
      202,
      'hosted_mcp_operation_active',
    ],
    ['Session deletion', 'mcp-release', 204, 'hosted_session_closing'],
  ] as const)(
    'refuses a prompt while %s runs',
    async (trigger, parked, settled, code) => {
      const { server, authorize } = await mcpApp();
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      )
        .send({
          operationId: randomUUID(),
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        })
        .expect(202);
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const original = control.getMockImplementation()!;
      let dispatched!: () => void;
      const started = new Promise<void>((resolve) => (dispatched = resolve));
      let finish!: () => void;
      const held = new Promise<void>((resolve) => (finish = resolve));
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === parked) {
          dispatched();
          await held;
        }
        return original.call(this, operation);
      });
      const running = (
        trigger === 'Session deletion'
          ? headers(supertest(server).delete(`/session/${SESSION_ID}`))
          : authorize(
              supertest(server).post(
                `/session/${SESSION_ID}/mcp/configurations`,
              ),
            ).send({
              operationId: randomUUID(),
              expectedRevision: 1,
              server: {
                serverId: 'demo',
                serverRevision: 1,
                definitionDigest: 'a'.repeat(64),
              },
            })
      ).then(
        (response) => response,
        () => undefined,
      );
      await started;
      try {
        const refused = await authorize(
          supertest(server).post(`/session/${SESSION_ID}/prompt`),
        ).send({});
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe(code);
      } finally {
        finish();
        expect((await running)?.status).toBe(settled);
      }
    },
  );

  it.each(['invoke', 'close'])(
    'restores the owner before %s after an idle Broker restart',
    async (next) => {
      const { server, authorize, brokerOwners } = await mcpApp();
      const invoke = () =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
        ).send({
          operationId: randomUUID(),
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        });
      expect((await invoke()).body.state).toBe('settled');
      brokerOwners.clear();
      if (next === 'invoke')
        expect((await invoke()).body.state).toBe('settled');
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
    },
  );

  it.each([
    { kind: 'resource_read', uri: '' },
    { kind: 'resource_read', uri: '   ' },
    { kind: 'prompt_get', name: '', arguments: {} },
    { kind: 'prompt_get', name: '   ', arguments: {} },
    { kind: 'resource_read', uri: 'memory://\ud800' },
    { kind: 'prompt_get', name: 'greet\udfff', arguments: {} },
    { kind: 'prompt_get', name: 'greet', arguments: { value: '\ud800' } },
    { kind: 'prompt_get', name: 'greet', arguments: { ['\udfff']: 'value' } },
  ])(
    'rejects invalid MCP strings before committing or dispatching: %j',
    async (request) => {
      const { server, authorize, requests } = await mcpApp();
      const commit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'commitExtensionRecord',
      );
      const rejected = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
      ).send({ operationId: randomUUID(), serverId: 'demo', request });
      expect(rejected.status).toBe(400);
      expect(commit).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.recoveryBlocked).toBe(false);
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
  );

  it.each(['unknown', 'failed'] as const)(
    'settles a turn after %s discovery and can retry and reload',
    async (failure) => {
      const { server, authorize } = await mcpApp();
      const physical = vi
        .mocked(HostedWorkspaceBroker.prototype.control)
        .getMockImplementation()!;
      let fail = true;
      vi.mocked(HostedWorkspaceBroker.prototype.control).mockImplementation(
        async function (this: HostedWorkspaceBroker, operation) {
          if (operation.kind === 'mcp-discover' && fail) {
            fail = false;
            if (failure === 'unknown') throw new Error('Broker 503');
            return {
              operationId: operation.operationId,
              state: 'settled',
              error: { code: 'managed_mcp_connection_failed' },
            };
          }
          return physical.call(this, operation);
        },
      );
      let modelRequests = 0;
      state.model.mockImplementation(async ({ toolTurn }) => {
        await toolTurn!.declarations(new AbortController().signal);
        modelRequests++;
        return { text: 'done', model: 'test-model' };
      });
      const send = (promptId: string) => {
        const prompt = [{ type: 'text', text: 'hello' }];
        return authorize(
          supertest(server).post(`/session/${SESSION_ID}/prompt`),
        ).send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        });
      };
      expect((await send(PROMPT_ID)).status).toBe(202);
      await vi.waitFor(
        async () => {
          const transcript = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          );
          expect(transcript.body.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'turn_error',
                promptId: PROMPT_ID,
              }),
            ]),
          );
        },
        { timeout: 10_000 },
      );
      expect(modelRequests).toBe(0);
      expect((await send(randomUUID())).status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: 10_000 },
      );
      expect(modelRequests).toBe(1);
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
        managedSessionStore: store(),
      });
      expect(loaded.status).toBe(200);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

  it('keeps MCP load explicit and outside Workspace-only cold validation', async () => {
    const { server, authorize } = await mcpApp();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    )
      .send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      })
      .expect(202);
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
    state.assertWritable.mockRejectedValue(
      new Error('Workspace-only validation must not run'),
    );
    const load = (body: Record<string, unknown>) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        ...body,
      });
    expect((await load({})).body.code).toBe('hosted_tool_profile_conflict');
    expect(
      (await load({ toolProfile: 'hosted-workspace-mcp/1' })).body.code,
    ).toBe('invalid_hosted_mcp_servers');
    const mcpServers = [
      { serverId: 'demo', serverRevision: 1, definitionDigest: 'a'.repeat(64) },
    ];
    expect(
      (
        await load({
          toolProfile: 'hosted-workspace-mcp/1',
          mcpServers: [{ ...mcpServers[0], serverRevision: 2 }],
        })
      ).body.code,
    ).toBe('hosted_tool_profile_conflict');
    const loaded = await load({
      toolProfile: 'hosted-workspace-mcp/1',
      mcpServers,
    });
    expect(loaded.status).toBe(200);
    expect(state.assertWritable).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
  });

  it('keeps valid Unicode arguments intact through raw MCP admission', async () => {
    const { server, authorize, requests } = await mcpApp();
    const request = {
      kind: 'prompt_get',
      name: 'greet',
      arguments: { ['名字😀']: '你好😀' },
    };
    const response = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({ operationId: randomUUID(), serverId: 'demo', request });
    expect(response.status).toBe(202);
    expect(response.body.state).toBe('settled');
    expect(requests.find((entry) => entry.kind === 'mcp-invoke')).toMatchObject(
      { request },
    );
    expect(
      (await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`)))
        .status,
    ).toBe(204);
  });

  it('settles a turn overlapping explicit configuration without latching recovery', async () => {
    const { server, authorize, requests } = await mcpApp();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({
      operationId: randomUUID(),
      serverId: 'demo',
      request: { kind: 'resource_read', uri: 'memory://note' },
    });
    let resumeModel!: () => void;
    let resumeConfigure!: () => void;
    const modelBarrier = new Promise<void>((resolve) => {
      resumeModel = resolve;
    });
    const configurationBarrier = new Promise<void>((resolve) => {
      resumeConfigure = resolve;
    });
    let modelEntered = false;
    let configurationEntered = false;
    state.model.mockImplementation(async ({ signal, toolTurn }) => {
      modelEntered = true;
      await modelBarrier;
      await toolTurn!.declarations(signal);
      return { text: 'done', model: 'test-model' };
    });
    const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
    const physical = control.getMockImplementation()!;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (
        operation.kind === 'mcp-configure' &&
        operation.configRevision === 2
      ) {
        configurationEntered = true;
        await configurationBarrier;
      }
      if (operation.kind === 'mcp-discover' && configurationEntered)
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_mcp_binding_conflict' },
        };
      return physical.call(this, operation);
    });
    const send = (promptId: string) => {
      const prompt = [{ type: 'text', text: 'hello' }];
      return authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({
        prompt,
        promptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    };
    expect((await send(PROMPT_ID)).status).toBe(202);
    await vi.waitFor(() => expect(modelEntered).toBe(true));
    const configuring = authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
    )
      .send({
        operationId: randomUUID(),
        expectedRevision: 1,
        server: {
          serverId: 'demo',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
      })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(configurationEntered).toBe(true));
      resumeModel();
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      const transcript = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'turn_error', promptId: PROMPT_ID }),
        ]),
      );
      resumeConfigure();
      expect((await configuring).status).toBe(202);
      configurationEntered = false;
      expect((await send(randomUUID())).status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: 10_000 },
      );
      expect(
        requests.filter((entry) => entry.kind === 'mcp-configure'),
      ).toHaveLength(2);
      expect(
        (
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          )
        ).status,
      ).toBe(204);
    } finally {
      resumeModel();
      resumeConfigure();
      await configuring;
    }
  });

  it.each([
    [16, 200],
    [17, 400],
    [32, 400],
  ])(
    'checks the MCP pin limit at creation (%i pins)',
    async (count, status) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: Array.from({ length: count }, (_, index) => ({
          serverId: `server-${index}`,
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        })),
      });
      if (created.status === 200)
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      expect(created.status).toBe(status);
      if (status === 400)
        expect(created.body.code).toBe('invalid_hosted_mcp_servers');
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each([17, 32])(
    'loads and detaches an existing %i-pin MCP Session',
    async (count) => {
      const mcpServers = Array.from({ length: count }, (_, index) => ({
        serverId: `server-${index}`,
        serverRevision: 1,
        definitionDigest: 'a'.repeat(64),
      }));
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey,
      });
      const transcriptPath = path.join(state.root, `${SESSION_ID}.jsonl`);
      const previous = await openManagedSession({
        runtimeBaseDir: state.root,
        cwd: state.root,
        transcriptPath,
        sessionId: SESSION_ID,
        sessionKey,
        version: 'hosted-harness/1',
        workerId: BOOT_ID,
        activationLeaseDurationMs: 60_000,
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: SESSION_ID,
          transcriptPath,
        }),
        resourceStore: resources,
        create: {
          definitionRef: await resources.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile: 'hosted-workspace-mcp/1',
                mcpServers,
              }),
            ),
          ),
          rootSnapshotRef: await resources.publish(
            'managed-root',
            Buffer.from('{}'),
          ),
          createdBy: 'hosted-harness',
        },
      });
      await previous.close();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers,
        managedSessionStore: store(),
      });
      expect(loaded.status).toBe(200);
      expect(
        (
          await headers(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string)
        ).status,
      ).toBe(204);
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each(['prompt', 'configuration', 'resource'])(
    'reports exhausted Runtime capacity from the MCP %s entry point',
    async (entryPoint) => {
      const { server, authorize } = await mcpApp();
      const resource = () =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
        ).send({
          operationId: randomUUID(),
          serverId: 'demo',
          request: { kind: 'resource_read', uri: 'memory://note' },
        });
      if (entryPoint === 'configuration')
        expect((await resource()).status).toBe(202);
      const control = vi.mocked(HostedWorkspaceBroker.prototype.control);
      const physical = control.getMockImplementation()!;
      control.mockImplementationOnce(async (operation) => {
        expect(operation.kind).toBe('mcp-configure');
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_mcp_connection_quota' },
        };
      });
      const admit = vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'submitInput',
      );
      const prompt = [{ type: 'text', text: 'hello' }];
      const sendPrompt = () =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          },
        );
      const rejected =
        entryPoint === 'prompt'
          ? await sendPrompt()
          : entryPoint === 'resource'
            ? await resource()
            : await authorize(
                supertest(server).post(
                  `/session/${SESSION_ID}/mcp/configurations`,
                ),
              ).send({
                operationId: randomUUID(),
                expectedRevision: 1,
                server: {
                  serverId: 'demo',
                  serverRevision: 2,
                  definitionDigest: 'a'.repeat(64),
                },
              });
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe('managed_mcp_connection_quota');
      expect(admit).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      control.mockImplementation(physical);
      if (entryPoint === 'prompt') {
        expect((await sendPrompt()).status).toBe(202);
        await vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(false);
          },
          { timeout: 10_000 },
        );
        expect(state.model).toHaveBeenCalledOnce();
      }
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
  );

  it('reconciles an unknown initial MCP configuration before admitting a retried prompt', async () => {
    const { server, authorize, requests } = await mcpApp(true);
    const admit = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'submitInput',
    );
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const send = () =>
      authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest,
      });
    const rejected = await send();
    expect(rejected.status).toBe(503);
    expect(admit).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
    expect(requests.map((request) => request.kind)).toEqual(['mcp-configure']);

    const replacement = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
    ).send({
      operationId: randomUUID(),
      expectedRevision: 1,
      server: {
        serverId: 'demo',
        serverRevision: 1,
        definitionDigest: 'a'.repeat(64),
      },
    });
    expect(replacement.status).toBe(503);
    expect(replacement.body.error).toBe('hosted_mcp_recovery_required');
    expect(requests.map((request) => request.kind)).toEqual(['mcp-configure']);

    const admitted = await send();
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 10_000 },
    );
    expect(admit).toHaveBeenCalledOnce();
    expect(state.model).toHaveBeenCalledOnce();
    expect(requests.map((request) => request.kind)).toEqual([
      'mcp-configure',
      'mcp-status',
    ]);
    expect(requests[1]).toMatchObject({
      targetOperationId: requests[0].operationId,
    });
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it('pins the /2 file profile through create and load and advertises glob', async () => {
    const body = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/2',
    };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send(
      body,
    );
    expect(created.status).toBe(200);
    let createDeclarations: string[] | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn }) => {
      // Capture, don't assert: an AssertionError inside this callback is
      // swallowed by executeHostedTurn's catch, so only an assertion after
      // the turn settles can fail the test.
      createDeclarations = (
        await toolTurn!.declarations(new AbortController().signal)
      ).map((tool) => tool.name!);
      return { text: 'text without side effects', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'hello' }];
    const clientId = created.body.clientId as string;
    expect(
      (
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
      ).status,
    ).toBe(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    expect(createDeclarations).toEqual([
      'read_file',
      'write_file',
      'edit',
      'glob',
    ]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    expect(
      (
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
        })
      ).status,
    ).toBe(409);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    let resumedDeclarations: string[] | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      resumedDeclarations = (await toolTurn!.declarations(signal)).map(
        (tool) => tool.name!,
      );
      return { text: 'resumed', model: 'test-model' };
    });
    const nextPrompt = [{ type: 'text', text: 'again' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: nextPrompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    expect(resumedDeclarations).toEqual([
      'read_file',
      'write_file',
      'edit',
      'glob',
    ]);
    expect(state.model).toHaveBeenCalledTimes(2);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it('requires the saved explicit Shell profile and advertises it only with a Broker', async () => {
    const body = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    };
    expect(
      (await headers(supertest(await app()).post('/session')).send(body))
        .status,
    ).toBe(400);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send(
      body,
    );
    expect(created.status).toBe(200);
    state.model.mockImplementationOnce(async ({ toolTurn }) => {
      expect(
        (await toolTurn!.declarations(new AbortController().signal)).map(
          (tool) => tool.name,
        ),
      ).toEqual([
        'read_file',
        'write_file',
        'edit',
        'run_shell_command',
        // H4b: a Shell-laned root Session advertises its Agent tool.
        'agent',
      ]);
      return { text: 'text without side effects', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'hello' }];
    const clientId = created.body.clientId as string;
    expect(
      (
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
      ).status,
    ).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    expect(acquire).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    expect(
      (
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
        })
      ).status,
    ).toBe(409);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    let resumedDeclarations: string[] | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      resumedDeclarations = (await toolTurn!.declarations(signal)).map(
        (tool) => tool.name!,
      );
      return { text: 'resumed', model: 'test-model' };
    });
    const nextPrompt = [{ type: 'text', text: 'again' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: nextPrompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    expect(resumedDeclarations).toEqual([
      'read_file',
      'write_file',
      'edit',
      'run_shell_command',
      'monitor',
      // H4b: a Shell-laned root Session advertises its Agent tool.
      'agent',
    ]);
    expect(state.model).toHaveBeenCalledTimes(2);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it.each(['completed', 'model-error', 'execution-error'])(
    'closes the Shell publisher after a %s turn',
    async (ending) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
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
        { timeout: 10_000 },
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
        { timeout: 10_000 },
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
        timeout: 10_000,
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

  it('distinguishes strict create and load outcomes', async () => {
    const server = await app();
    const missing = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(missing.status).toBe(404);

    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const exists = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(exists.status).toBe(409);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('passes the broker-provisioned writer credential and insecure opt-in to the store', async () => {
    const server = await app();
    state.storeOptions.length = 0;
    const writerToken = `qwt1_${'a'.repeat(43)}`;
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: { ...store(), writerToken, allowInsecureHttp: true },
    });
    expect(created.status).toBe(200);
    expect(state.storeOptions.at(-1)).toMatchObject({
      baseUrl: store().baseUrl,
      writerId: BOOT_ID,
      leaseDurationMs: 60_000,
      writerToken,
      allowInsecureHttp: true,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('answers 400 when the store factory refuses the descriptor', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: {
        ...store(),
        baseUrl: 'http://rejected-store.test',
      },
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe('invalid_managed_session_store');
    expect(created.body.message).toContain('plaintext HTTP');
  });

  it('answers 400 with the reason when the descriptor itself is rejected', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: { ...store(), writerToken: 'short' },
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe('invalid_managed_session_store');
    expect(created.body.message).toContain('writerToken is invalid');
  });

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
      { timeout: 10_000 },
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
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
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

  it('refuses a cold load when a settled file tool outcome is missing from its checkpoint', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
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
      { timeout: 10_000 },
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
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(
      read.mock.calls.map(([ref]) => [ref.kind, ref.resourceId]),
    ).toContainEqual(['managed-tool-result-content', sealId]);
    read.mockRestore();
    sealedResources.set(sealKey, seal);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: body.toolProfile });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
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

  it.each(['hosted-workspace-files/1', 'hosted-workspace-shell/1'])(
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
      expect(state.model).not.toHaveBeenCalled();
      damaged.mockRestore();
      const retry = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
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
    // A write-probe failure during restore validation is a writer-lease
    // refusal, not a verification one.
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (workspace_writable): Error: writer lost`,
    );
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

  // Parks a plain Session with its Turn unsettled: the settlement's durable
  // write is refused, so the input stays accepted-but-unsettled.
  async function parkUnsettledPlainTurn(server: Server): Promise<void> {
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      return kind === 'managed-turn-result'
        ? Promise.reject(new Error('store lost the settlement'))
        : publish.call(this, kind, bytes);
    });
    const prompt = [{ type: 'text', text: 'park me' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(true);
    });
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    log.mockRestore();
  }

  it('marks the publication flag not-applicable on a profile-less cold refusal', async () => {
    const server = await app(true);
    await parkUnsettledPlainTurn(server);
    const parked = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      { tenantId: 'tenant', workspaceId: 'workspace', sessionId: SESSION_ID },
    );
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    // The load's own open installs one activation record; the guard decides
    // at that boundary, before close() appends its release record after it.
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (unsettled_input): {"incompletePublication":null,"unsettled":["${PROMPT_ID}"],"resume":null,"settle":null,"through":${parked.events.at(-1)!.sequence + 1}}`,
    );
  });

  it('names the broker posture when a takeover load has no Runtime to take over', async () => {
    const server = await app(true);
    await parkUnsettledPlainTurn(server);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const takeover = {
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    };
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send(takeover);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (takeover_unavailable): profile=none broker=ready`,
    );
    const plain = await app();
    const refusedPlain = await headers(
      supertest(plain).post(`/session/${SESSION_ID}/load`),
    ).send(takeover);
    expect(refusedPlain.status).toBe(409);
    expect(refusedPlain.body.code).toBe('hosted_turn_recovery_required');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (takeover_unavailable): profile=none broker=none`,
    );
  });

  it('names the blocked authorization reason a refused restore discarded', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'identity_mismatch',
      message: 'checkpoint names another session',
    });
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(
      log.mock.calls
        .map(([line]) => line)
        .some(
          (line) =>
            line.includes('load refused (restore_blocked): basis=checkpoint') &&
            line.includes('reason=identity_mismatch') &&
            line.includes('message=checkpoint names another session'),
        ),
    ).toBe(true);
  });

  it('declines a drive takeover when the refused restore is durably blocked', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'identity_mismatch',
      message: 'checkpoint names another session',
    });
    // The drive shape asked for a takeover answer: a durable blocked
    // verdict can never change on retry, so it declines with its typed
    // reason instead of inviting an unbounded retry.
    const drive = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
    expect(drive.status).toBe(409);
    expect(drive.body.code).toBe('hosted_turn_recovery_declined');
    expect(drive.body.reason).toBe('checkpoint_blocked');
    // The cancellation shape keeps the baseline retriable refusal even on
    // the same durable verdict: nothing may terminalize for a cancel.
    const passive = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    });
    expect(passive.status).toBe(409);
    expect(passive.body.code).toBe('hosted_turn_recovery_required');
  });

  it('refuses an attached cancellation redrive of a parked no-tool Turn retriably', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    // The terminal settlement write fails: the Turn stays parked in the
    // attached Session — its input accepted, never settled, nothing live.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const write = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(async function (
        this: ManagedSessionRecordSink,
        record,
      ) {
        if (record.subtype === 'turn_result')
          throw new Error('settlement unavailable');
        return originalWrite.call(this, record);
      });
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    write.mockRestore();
    // A drive redrive keeps the typed decline.
    const drive = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
    expect(drive.status).toBe(409);
    expect(drive.body.code).toBe('hosted_turn_recovery_declined');
    expect(drive.body.reason).toBe('model_start');
    // The cancellation redrive must NOT mint the plain attach the old arm
    // answered (R10-1): no kernel is consulted here, so nothing "mirrors an
    // inapplicable" — a 200 would let the coordinator's cancel land as a
    // no-op and wedge this Session permanently.
    const passive = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    });
    expect(passive.status).toBe(409);
    expect(passive.body.code).toBe('hosted_turn_recovery_required');
    // The parked Turn also answers the plain cancel route honestly: no
    // live execution can be aborted, so 204 would certify a cancel that
    // never happened (R10-3's sibling route).
    const cancelled = await headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_turn_recovery_required');
  });

  it('allows only one concurrent attachment for a session ID', async () => {
    const server = await app();
    const create = () =>
      headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
    const results = await Promise.all([create(), create()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('keeps the caller session ID, commits a text turn, and refuses duplicate inference', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    expect(created.body.sessionId).toBe(SESSION_ID);
    expect(created.body.lastEventId).toBeGreaterThan(0);

    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const send = () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    const admitted = await send();
    expect(admitted.status).toBe(202);
    expect(admitted.body.promptId).toBe(PROMPT_ID);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    expect(state.model).toHaveBeenCalledTimes(1);

    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(transcript.status).toBe(200);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'session_update',
          promptId: PROMPT_ID,
        }),
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
      ]),
    );
    expect(
      (transcript.body.events as Array<{ id: number }>).map(
        (event) => event.id,
      ),
    ).toEqual(
      (transcript.body.events as Array<{ id: number }>).map(
        (_, index) => index + 1,
      ),
    );
    const listener = server;
    const address = listener.address();
    expect(address && typeof address !== 'string').toBe(true);
    const controller = new AbortController();
    try {
      const stream = await fetch(
        `http://127.0.0.1:${(address as { port: number }).port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': created.body.clientId as string,
            'X-Qwen-Event-Epoch': admitted.body.eventEpoch as string,
            'Last-Event-ID': String(admitted.body.lastEventId),
          },
          signal: controller.signal,
        },
      );
      expect(stream.status).toBe(200);
      expect(stream.headers.get('x-qwen-event-epoch')).toBe(
        admitted.body.eventEpoch,
      );
      const reader = stream.body!.getReader();
      let frames = '';
      while (!frames.includes('event: turn_complete')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        frames += new TextDecoder().decode(chunk.value);
      }
      const ids = [...frames.matchAll(/^id: (\d+)$/gm)].map((match) =>
        Number(match[1]),
      );
      expect(ids).toEqual(
        ids.map((_, index) => Number(admitted.body.lastEventId) + index + 1),
      );
      expect(frames).toContain('event: session_update');
      expect(frames).toContain(`"promptId":"${PROMPT_ID}"`);
    } finally {
      controller.abort();
      listener.closeAllConnections();
    }
    const repeated = await send();
    expect(repeated.status).toBe(202);
    expect(repeated.body.lastEventId).toBe(admitted.body.lastEventId);
    expect(state.model).toHaveBeenCalledTimes(1);

    const title = await headers(
      supertest(server).post(`/session/${SESSION_ID}/title`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ title: 'Hosted test' });
    expect(title.status).toBe(200);
    expect(title.body.persisted).toBe(true);

    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const gone = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(gone.status).toBe(404);
  });

  it.each([false, true])(
    'completes a long answer (streamed: %s) under the real inline bound',
    async (streamed) => {
      // Past the limit the durable message record commits as chunks; the turn
      // used to fail after the whole answer had already streamed (#13326).
      const text = '长😀'.repeat(25_000);
      state.model.mockImplementationOnce(async ({ textDeltas }) => {
        if (streamed) {
          expect(textDeltas).toBeDefined();
          await textDeltas!.delta(text);
        }
        return { text, model: 'test-model' };
      });
      await enforceInlineResourceLimit();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const server = await app(streamed);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...(streamed ? { toolProfile: 'hosted-workspace-files/1' } : {}),
      });
      expect(created.status).toBe(200);
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      const admitted = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest });
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', created.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript?limit=256`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_complete',
            promptId: PROMPT_ID,
          }),
        ]),
      );
      expect(
        (transcript.body.events as Array<Record<string, unknown>>).filter(
          (event) => event['type'] === 'turn_error',
        ),
      ).toEqual([]);
      if (streamed) {
        expectFullStreamedAnswer(transcript.body, text);
        await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
          .set('X-Qwen-Client-Id', created.body.clientId as string)
          .expect(204);
        const reloaded = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
        });
        expect(reloaded.status).toBe(200);
        const cold = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript?limit=256`),
        ).set('X-Qwen-Client-Id', reloaded.body.clientId as string);
        expectFullStreamedAnswer(cold.body, text);
      } else {
        const answer = transcript.body.events.find(
          (event: {
            type: string;
            data?: { update?: { content?: { text?: string } } };
          }) => event.type === 'session_update',
        );
        expect(answer?.data?.update?.content?.text).toBe(text);
      }
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
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
        { timeout: 10_000 },
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
  it('replays a settled prompt admission from the journal after a reload', async () => {
    // After a load, session.admissions is empty, so the idempotent retry is
    // answered from the journal's input.accepted watermark. That watermark
    // is the accepted sequence N — the first admission answered N+1 because
    // the in-memory path replies after committing wake.requested — and the
    // replay must answer exactly N: answering the live committedSequence
    // would skip past events the destination has not seen, and refusing
    // would loop the coordinator forever (D4's withdraw-and-resubmit).
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    expect(state.model).toHaveBeenCalledTimes(1);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);

    const replayed = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(replayed.status).toBe(202);
    expect(replayed.body.lastEventId).toBe(admitted.body.lastEventId - 1);

    // A replay is only one replays: a different body under the accepted
    // Id is a conflict, not a watermark (R9-1) — the model gets called
    // for nothing, and the destination cannot silently stream the
    // previous Turn's events as this request's answer.
    const offered = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: [{ type: 'text', text: 'different' }],
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256')
          .update(JSON.stringify([{ type: 'text', text: 'different' }]))
          .digest('hex')}`,
      });
    expect(offered.status).toBe(409);
    expect(offered.body.code).toBe('hosted_prompt_conflict');
    const status = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(status.body.hasActivePrompt).toBe(false);
    expect(state.model).toHaveBeenCalledTimes(1);
  });

  it('refuses the replay retriably when the admission identity cannot be read', async () => {
    // The replay's async writer runs detached: a failed admission read
    // must still answer — retriably, since the replay can never be
    // certified — or the request hangs on an unhandled rejection (R9-1's
    // deferred aftermath).
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const read = LocalManagedSessionResourceStore.prototype.read;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      reference,
    ) {
      if (reference.kind === 'managed-admission')
        throw new Error('admission read unavailable');
      return read.call(this, reference);
    });
    const replayed = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_prompt_recovery_required');
    expect(state.model).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported prompt content before model or tool execution', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'image', data: 'forbidden' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(rejected.status).toBe(400);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

  it('rejects prompts whose durable user record would exceed the store limit', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const prompt = [{ type: 'text', text: 'x'.repeat(65_300) }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(rejected.status).toBe(413);
    expect(state.model).not.toHaveBeenCalled();
    const status = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(status.body.recoveryBlocked).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

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
          { timeout: 10_000 },
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
      { timeout: 10_000 },
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
        { timeout: 10_000 },
      );
      expect(failed).toBe(true);
      expect(acknowledge).not.toHaveBeenCalled();
      await close(first, created.body.clientId).expect(204);
      const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
      const releasedBefore = releases.mock.calls.length;
      const second = await app(true);
      const checkpointBefore = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
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
        const unchanged = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          key,
        );
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
        const repaired = await LocalJsonlManagedSessionJournalStore.read(
          path.join(state.root, `${SESSION_ID}.jsonl`),
          key,
        );
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
      const checkpointAfter = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
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
        { timeout: 10_000 },
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
        { timeout: 10_000 },
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
      { timeout: 10_000 },
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
      { timeout: 10_000 },
    );
    expect(state.model).toHaveBeenCalledTimes(2);
    expect(acknowledge).not.toHaveBeenCalled();
    await headers(supertest(second).delete('/session/' + SESSION_ID)).expect(
      204,
    );
  });

  it('ends an event stream when its attachment closes', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const listener = server;
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': created.body.clientId as string,
          },
          signal: AbortSignal.timeout(3_000),
        },
      );
      expect(stream.status).toBe(200);
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(closed.status).toBe(204);
      const reader = stream.body!.getReader();
      let done = false;
      while (!done) ({ done } = await reader.read());
      expect(done).toBe(true);
    } finally {
      listener.closeAllConnections();
    }
  });

  it('stops writing an event stream after backpressure ends it', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events.length).toBeGreaterThan(2);
      },
      { timeout: 10_000 },
    );

    const originalWrite = ServerResponse.prototype.write;
    let frames = 0;
    let ends = 0;
    const write = vi
      .spyOn(ServerResponse.prototype, 'write')
      .mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<ServerResponse['write']>
      ) {
        if (typeof args[0] === 'string' && args[0].startsWith('id: ')) {
          frames++;
          originalWrite.apply(this, args);
          return false;
        }
        return originalWrite.apply(this, args);
      });
    const end = vi
      .spyOn(ServerResponse.prototype, 'end')
      .mockImplementation(function (this: ServerResponse) {
        ends++;
        return this;
      });
    const listener = server;
    const abort = new AbortController();
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': clientId,
          },
          signal: abort.signal,
        },
      );
      expect(stream.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(frames).toBe(1);
      expect(ends).toBe(1);
    } finally {
      write.mockRestore();
      end.mockRestore();
      abort.abort();
      listener.closeAllConnections();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('logs the failure cause while keeping the public turn error generic', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    state.model.mockRejectedValueOnce(new Error('model initialization failed'));
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
              data: {
                sessionId: SESSION_ID,
                promptId: PROMPT_ID,
                code: 'hosted_turn_failed',
                message: 'Hosted Harness turn failed.',
              },
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    expect(log).toHaveBeenCalledWith(
      `qwen serve: Hosted Harness turn ${PROMPT_ID} failed: Error: model initialization failed`,
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it.each([
    ['managed-message', 'turn_error', 0],
    ['managed-turn-result', 'turn_complete', 1],
    ['runnable-check', 'turn_error', 0],
  ])(
    'settles a turn after one %s failure',
    async (failedKind, terminalType, modelCalls) => {
      const server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
      expect(created.status).toBe(200);
      let failed = false;
      if (failedKind === 'runnable-check') {
        const restore = LocalManagedSessionAuthority.prototype.restoreBundle;
        vi.spyOn(
          LocalManagedSessionAuthority.prototype,
          'restoreBundle',
        ).mockImplementation(function (this: LocalManagedSessionAuthority) {
          if (!failed) {
            failed = true;
            return Promise.reject(new Error('transient restore failure'));
          }
          return restore.call(this);
        });
      } else {
        const publish = LocalManagedSessionResourceStore.prototype.publish;
        vi.spyOn(
          LocalManagedSessionResourceStore.prototype,
          'publish',
        ).mockImplementation(function (
          this: LocalManagedSessionResourceStore,
          kind,
          bytes,
        ) {
          if (kind === failedKind && !failed) {
            failed = true;
            return Promise.reject(new Error('transient store failure'));
          }
          return publish.call(this, kind, bytes);
        });
      }
      const clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'hello' }];
      const send = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: PROMPT_ID,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          });
      const admitted = await send();
      expect(admitted.status).toBe(202);
      // The default 1s waitFor timeout races the settlement retry's durable
      // writes on contended CI runners; the assertions are unchanged.
      await vi.waitFor(
        async () => {
          const transcript = await headers(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(transcript.body.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: terminalType,
                promptId: PROMPT_ID,
              }),
            ]),
          );
        },
        { timeout: 10_000 },
      );
      expect(failed).toBe(true);
      expect(state.model).toHaveBeenCalledTimes(modelCalls);
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(false);
      const retried = await send();
      expect(retried.status).toBe(202);
      expect(retried.body).toEqual(admitted.body);
      expect(state.model).toHaveBeenCalledTimes(modelCalls);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      const nextPrompt = [{ type: 'text', text: 'next' }];
      const nextPromptId = '44444444-4444-4444-8444-444444444444';
      const next = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          prompt: nextPrompt,
          promptId: nextPromptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
        });
      expect(next.status).toBe(202);
      await vi.waitFor(
        async () => {
          const transcript = await headers(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(transcript.body.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'turn_complete',
                promptId: nextPromptId,
              }),
            ]),
          );
        },
        { timeout: 10_000 },
      );
      expect(state.model).toHaveBeenCalledTimes(modelCalls + 1);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

  it('preserves a recovery failure when Shell cleanup also fails', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceToolTurn.prototype, 'close').mockRejectedValue(
      new Error('cleanup failed'),
    );
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('original result unknown')),
    );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'run Shell' }];
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
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events.filter(
        (event: { type: string }) => event.type === 'turn_error',
      ),
    ).toEqual([]);
  });

  it('answers a user cancel on a recovery-blocked Session whose Turn settled', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    // The Turn settles terminally and only the publisher cleanup fails, so
    // the Session latches recovery-blocked *with* a durable terminal record.
    vi.spyOn(HostedWorkspaceToolTurn.prototype, 'close').mockRejectedValue(
      new Error('cleanup failed'),
    );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'run Shell' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(true);
    });
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
        }),
      ]),
    );
    // The client's cancel flow hard-requires the 204 before it streams that
    // record — a definitive refusal is reported as an unknown mutation
    // outcome and retried forever, while nothing remains here to abort.
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
  });

  it('blocks new prompts when terminal settlement keeps failing', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-turn-result') {
        return Promise.reject(new Error('store down'));
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events.filter(
        (event: { type: string }) =>
          event.type === 'turn_complete' || event.type === 'turn_error',
      ),
    ).toEqual([]);
    const nextPrompt = [{ type: 'text', text: 'next' }];
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: '44444444-4444-4444-8444-444444444444',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('hosted_turn_recovery_required');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('refuses a bare load of a recovery-blocked Turn after detach', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockRejectedValue(
      new Error('broker gone'),
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: 'call-1',
        args: { file_path: 'a', content: 'x' },
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
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
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
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('settles a cancelled turn when writing its user record fails once', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    let rejectWrite: ((reason?: unknown) => void) | undefined;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-message') {
        return new Promise<Awaited<ReturnType<typeof publish>>>(
          (_resolve, reject) => {
            rejectWrite = reject;
          },
        );
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'wait' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(rejectWrite).toBeDefined());
    const cancelled = await headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(cancelled.status).toBe(204);
    rejectWrite?.(new Error('transient store failure'));
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('reports an aborted live turn as cancelled after a Java-style cold reattach', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    state.model.mockImplementationOnce(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new Error('cancelled')),
          );
        }),
    );
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'wait' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1));
    const reattached = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
      driveRuntimeRecovery: false,
      cancellationTakeover: true,
    });
    expect(reattached.status).toBe(200);
    expect(reattached.body.clientId).toBe(created.body.clientId);
    const cancelled = await headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', reattached.body.clientId as string);
    expect(cancelled.status).toBe(204);
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    expect(log).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('reports a deadline-exceeded turn as a classified failure, not a cancellation', async () => {
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    state.model.mockImplementationOnce(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'wait' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest, deadlineMs: 2000 });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1));
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
              data: expect.objectContaining({
                code: 'hosted_turn_deadline_exceeded',
              }),
            }),
          ]),
        );
        expect(
          (transcript.body.events as Array<{ type: string }>).some(
            (event) => event.type === 'turn_complete',
          ),
        ).toBe(false);
      },
      { timeout: 10_000 },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    );
    const settled = saved.events.find(
      (event) => event.kind === 'turn.settled',
    )!;
    expect(settled.payload['outcome']).toBe('error');
    expect(settled.payload['stopReason']).toBe('deadline_exceeded');
    // The settled Turn frees the Session for the next prompt.
    const followUp = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: randomUUID(), payloadDigest });
    expect(followUp.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('classifies a deadline expiry on the retried settlement path', async () => {
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    let rejectWrite: ((reason?: unknown) => void) | undefined;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'publish',
    ).mockImplementation(function (
      this: LocalManagedSessionResourceStore,
      kind,
      bytes,
    ) {
      if (kind === 'managed-message' && !rejectWrite) {
        return new Promise<Awaited<ReturnType<typeof publish>>>(
          (_resolve, reject) => {
            rejectWrite = reject;
          },
        );
      }
      return publish.call(this, kind, bytes);
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'wait' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        deadlineMs: 2000,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(rejectWrite).toBeDefined());
    // Let the deadline fire while the user-record write is still hung, so
    // the turn fails before the model ran and the settlement retry path
    // (not the runner's own catch) classifies the abort.
    await new Promise((resolve) => setTimeout(resolve, 2250));
    rejectWrite?.(new Error('transient store failure'));
    await vi.waitFor(
      async () => {
        const transcript = await headers(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
              data: expect.objectContaining({
                code: 'hosted_turn_deadline_exceeded',
              }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    );
    const settled = saved.events.find(
      (event) => event.kind === 'turn.settled',
    )!;
    expect(settled.payload['outcome']).toBe('error');
    expect(settled.payload['stopReason']).toBe('deadline_exceeded');
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });
});

describe('Hosted Harness tool approvals', () => {
  // Turns commit and sync several records, which can take over a second
  // on a busy host.
  const waitFor = <T>(check: () => T | Promise<T>) =>
    vi.waitFor(check, { timeout: 10_000 });

  beforeEach(async () => {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'workspaceContext',
    ).mockResolvedValue([]);
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockImplementation(
      async () => randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  const files = 'hosted-workspace-files/1';

  async function definitions(): Promise<unknown[]> {
    const paths = (await readdir(state.root, { recursive: true })).filter(
      (entry) =>
        entry.includes(`managed-definition${path.sep}`) &&
        !path.basename(entry).startsWith('.'),
    );
    return Promise.all(
      paths.map(async (entry) =>
        JSON.parse(await readFile(path.join(state.root, entry), 'utf8')),
      ),
    );
  }

  it('pins a mode that can ask at creation and refuses other modes', async () => {
    const server = await app(true);
    const create = (extra: Record<string, unknown>) =>
      headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...extra,
      });
    for (const extra of [
      { approvalMode: 'plan' },
      { approvalMode: 'auto' },
      { approvalMode: null },
      { approvalMode: 'default', approvalTimeoutMs: 999 },
    ]) {
      const refused = await create({ toolProfile: files, ...extra });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('invalid_hosted_approval');
    }
    expect(await definitions()).toEqual([]);

    const noTools = await create({ approvalMode: 'plan' });
    expect(noTools.status).toBe(200);
    expect(noTools.body).not.toHaveProperty('approvalMode');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      noTools.body.clientId as string,
    );
    expect(await definitions()).toEqual([
      { engine: 'managed', sessionId: SESSION_ID },
    ]);
  });

  it.each([
    { approvalMode: 'plan', approvalTimeoutMs: 60_000 },
    { approvalMode: 'default' },
    { approvalTimeoutMs: 60_000 },
  ])(
    'refuses to load a tool Session whose saved approval is %o',
    async (saved) => {
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resourceStore = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey,
      });
      const managed = await openManagedSession({
        runtimeBaseDir: state.root,
        transcriptPath: '',
        sessionId: SESSION_ID,
        sessionKey,
        cwd: state.root,
        version: 'hosted-harness/1',
        workerId: BOOT_ID,
        activationLeaseDurationMs: 60_000,
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: SESSION_ID,
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        }),
        resourceStore,
        create: {
          definitionRef: await resourceStore.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile: files,
                ...saved,
              }),
            ),
          ),
          rootSnapshotRef: await resourceStore.publish(
            'managed-root',
            Buffer.from(JSON.stringify({ cwd: state.root })),
          ),
          createdBy: 'hosted-harness',
        },
        requireNew: true,
      });
      await managed.close();
      const loaded = await headers(
        supertest(await app(true)).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(409);
      expect(loaded.body.code).toBe('hosted_tool_profile_conflict');
    },
  );

  it('keeps a yolo tool Session definition unchanged', async () => {
    const created = await headers(
      supertest(await app(true)).post('/session'),
    ).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'yolo',
      approvalTimeoutMs: 5,
    });
    expect(created.status).toBe(200);
    expect(created.body.approvalMode).toBe('yolo');
    expect(await definitions()).toEqual([
      { engine: 'managed', sessionId: SESSION_ID, toolProfile: files },
    ]);
  });

  it('answers approvals through the resolve route across turns and a reload', async () => {
    const requestIds: string[] = [];
    const wait = HostedApprovalWaiters.prototype.wait;
    vi.spyOn(HostedApprovalWaiters.prototype, 'wait').mockImplementation(
      function (this: HostedApprovalWaiters, requestId, ...rest) {
        requestIds.push(requestId);
        return wait.call(this, requestId, ...rest);
      },
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: randomUUID(),
        args: { file_path: 'notes.txt', content: 'hello' },
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
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'default',
      approvalTimeoutMs: 60_000,
    });
    expect(created.status).toBe(200);
    expect(created.body.approvalMode).toBe('default');
    expect(await definitions()).toEqual([
      {
        engine: 'managed',
        sessionId: SESSION_ID,
        toolProfile: files,
        approvalMode: 'default',
        approvalTimeoutMs: 60_000,
      },
    ]);
    const answer = (clientId: string, requestId: string, optionId: string) =>
      headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestId}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          optionId,
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        });
    const runTurn = async (clientId: string, promptId: string) => {
      const prompt = [{ type: 'text', text: 'write notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      const count = requestIds.length + 1;
      await waitFor(() => expect(requestIds).toHaveLength(count));
      return requestIds.at(-1)!;
    };
    const finished = async (clientId: string) =>
      waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });

    let clientId = created.body.clientId as string;
    const first = await runTurn(clientId, PROMPT_ID);
    const missing = await answer('other-client', first, 'allow');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('hosted_session_not_found');
    const unknown = await answer(
      clientId,
      `tool_approval_${'0'.repeat(32)}`,
      'allow',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('action_not_found');
    const invalid = await answer(clientId, first, 'later');
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_action_response');
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    // Reading the options fails before anything is written.
    const failure = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockRejectedValueOnce(new Error('store down'));
    const failed = await answer(clientId, first, 'allow');
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('action_resolution_failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('store down'));
    failure.mockRestore();
    log.mockRestore();
    const allowed = await answer(clientId, first, 'allow');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({
      requestId: first,
      state: 'decided',
      optionId: 'allow',
    });
    await finished(clientId);
    expect((await answer(clientId, first, 'allow')).status).toBe(200);
    const changed = await answer(clientId, first, 'deny');
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('action_already_resolved');

    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(loaded.body.approvalMode).toBe('default');
    clientId = loaded.body.clientId as string;
    const secondPrompt = randomUUID();
    const second = await runTurn(clientId, secondPrompt);
    expect(second).not.toBe(first);
    expect((await answer(clientId, second, 'allow')).status).toBe(200);
    await finished(clientId);

    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(2);
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events
        .filter((event: { type: string }) => event.type === 'turn_complete')
        .map((event: { promptId: string }) => event.promptId),
    ).toEqual([PROMPT_ID, secondPrompt]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  async function waitingSession() {
    const requestIds: string[] = [];
    const wait = HostedApprovalWaiters.prototype.wait;
    vi.spyOn(HostedApprovalWaiters.prototype, 'wait').mockImplementation(
      function (this: HostedApprovalWaiters, requestId, ...rest) {
        requestIds.push(requestId);
        return wait.call(this, requestId, ...rest);
      },
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'edit',
        callId: 'call-1',
        args: { file_path: 'a.txt', old_string: 'a', new_string: 'b' },
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
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'default',
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'edit a' }];
    const submit = async (promptId: string) => {
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      const count = requestIds.length + 1;
      await waitFor(() => expect(requestIds).toHaveLength(count));
    };
    await submit(PROMPT_ID);
    const answer = (optionId: string) =>
      headers(
        supertest(server).post(
          `/session/${SESSION_ID}/actions/${requestIds.at(-1)}/resolve`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          optionId,
          inputRevision: 1,
          policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
        });
    const status = async () =>
      (
        await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId)
      ).body;
    return { server, clientId, answer, status, submit };
  }

  it('streams a message_retracted envelope when a restarted attempt retracts its prefix', async () => {
    state.model.mockImplementationOnce(async (input) => {
      const deltas = (
        input as {
          textDeltas?: {
            delta(text: string): Promise<void>;
            retract(): Promise<void>;
          };
        }
      ).textDeltas;
      await deltas!.delta('orphaned prefix');
      await deltas!.retract();
      await deltas!.delta('recovered');
      return { text: 'recovered', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'yolo',
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'retry' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    const events = transcript.body.events as Array<{
      id: number;
      type: string;
      promptId?: string;
      data?: {
        turnId?: string;
        messageId?: string;
        fromSequence?: number;
        update?: { sessionUpdate?: string; content?: { text?: string } };
      };
    }>;
    const chunks = events.filter((event) => event.type === 'session_update');
    const retractions = events.filter(
      (event) => event.type === 'message_retracted',
    );
    expect(retractions).toHaveLength(1);
    expect(retractions[0]!.promptId).toBe(PROMPT_ID);
    expect(retractions[0]!.data?.turnId).toBe(PROMPT_ID);
    // The retraction names the orphaned prefix's first delta and lands
    // between the orphaned chunks and the replay's.
    expect(retractions[0]!.data?.fromSequence).toBe(chunks[0]!.id);
    expect(retractions[0]!.id).toBeGreaterThan(chunks[0]!.id);
    const replayed = chunks.filter((chunk) => chunk.id > retractions[0]!.id);
    expect(
      replayed.map((chunk) => chunk.data?.update?.content?.text).join(''),
    ).toBe('recovered');
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
      ]),
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it('blocks the Session at once when recording an answer stops its writes', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { answer, status } = await waitingSession();
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValueOnce(new Error('journal down'));
    const failed = await answer('allow');
    expect(failed.status).toBe(409);
    expect(failed.body.code).toBe('hosted_turn_recovery_required');
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      }),
    );
    expect(HostedWorkspaceBroker.prototype.prepare).not.toHaveBeenCalled();
    expect((await answer('allow')).body.code).toBe(
      'hosted_turn_recovery_required',
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('journal down'));
  });

  it('retains the turn recovery error on cold load of a pending file edit', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    vi.mocked(HostedWorkspaceBroker.prototype.execute).mockRejectedValueOnce(
      new Error('lost execution reply'),
    );
    expect((await answer('allow')).status).toBe(200);
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      }),
    );
    const history = await headers(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(history.body.history.pendingTurn).toBe(PROMPT_ID);
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .send({})
      .expect(204);
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.execute).mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.fileHistory).mockClear();
    state.model.mockClear();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), toolProfile: files });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (file_history_pending): {"pendingTurn":"${PROMPT_ID}","pendingUndo":null,"unsettled":"${PROMPT_ID}","takeover":false}`,
    );
    expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.fileHistory).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
  });

  it.each(['pending-snapshot', 'history-settled'])(
    'reloads settled file results after %s without redispatch',
    async (phase) => {
      vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
      const { server, clientId, answer, status } = await waitingSession();
      const fileState = {
        ownerSessionId: SESSION_ID,
        snapshots: [],
        files: {},
      };
      if (phase === 'pending-snapshot') {
        vi.mocked(
          HostedWorkspaceBroker.prototype.fileHistory,
        ).mockImplementation(async (operation) => {
          if (operation.action === 'snapshot')
            throw new Error('snapshot reply lost');
          return fileState;
        });
      } else {
        vi.spyOn(
          HostedWorkspaceToolTurn.prototype,
          'consumeResults',
        ).mockRejectedValueOnce(
          new HostedToolRecoveryRequiredError(
            new Error('interrupted before model continuation'),
          ),
        );
      }
      expect((await answer('allow')).status).toBe(200);
      await waitFor(async () =>
        expect(await status()).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        }),
      );
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .send({})
        .expect(204);
      vi.mocked(HostedWorkspaceBroker.prototype.fileHistory)
        .mockResolvedValue(fileState)
        .mockClear();
      state.model.mockImplementationOnce(
        async ({ toolTurn, resumeFromToolResults }) => {
          expect(resumeFromToolResults).toHaveLength(1);
          await toolTurn!.consumeResults();
          return {
            text: 'resumed from saved file result',
            model: 'test-model',
          };
        },
      );
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(200);
      const recoveredId = loaded.body.clientId as string;
      await waitFor(async () => {
        const response = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', recoveredId);
        expect(response.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      expect(HostedWorkspaceBroker.prototype.fileHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          action: phase === 'pending-snapshot' ? 'snapshot' : 'bind',
        }),
      );
      const history = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', recoveredId);
      expect(history.body.history.pendingTurn).toBeNull();
      expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', recoveredId)
        .send({})
        .expect(204);
      expect(
        (
          await headers(
            supertest(server).post(`/session/${SESSION_ID}/load`),
          ).send({ managedSessionStore: store(), toolProfile: files })
        ).status,
      ).toBe(200);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
    },
  );

  it('passively reattaches a live Turn and cancels it without opening another writer', async () => {
    const { server, clientId, answer, status } = await waitingSession();
    // The frozen binding fences both resident reattach branches: a foreign
    // tenant or Workspace meets the budget-bounded already_attached refusal,
    // while a drifted Session Store address refuses with the retryable
    // conflict its only caller needs to retry instead of failing the Turn.
    for (const [changed, expected] of [
      [{ tenantId: 'other' }, 409],
      [{ workspaceId: 'other' }, 409],
      [{ baseUrl: 'http://other-store.test' }, 409],
    ] as const) {
      for (const recovery of [
        { passiveManagedRuntimeRecovery: true },
        { driveRuntimeRecovery: true },
      ]) {
        const refused = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: { ...store(), ...changed },
          ...recovery,
        });
        expect(refused.status).toBe(expected);
      }
    }
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({ managedSessionStore: store(), toolProfile: files })
      .expect(409);
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        passiveManagedRuntimeRecovery: true,
      })
      .expect(409);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(200);
    expect(loaded.body).toMatchObject({ clientId, approvalMode: 'default' });
    expect(loaded.body._meta).toBeUndefined();
    expect(await status()).toMatchObject({ hasActivePrompt: true });
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      }),
    );
    expect(HostedWorkspaceBroker.prototype.prepare).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    const late = await answer('allow');
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('action_cancelled');
  });

  it('refuses answers once the Session is recovery-blocked', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'resolveAction',
    ).mockRejectedValueOnce(new Error('fenced'));
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    await waitFor(async () =>
      expect(await status()).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      }),
    );
    const refused = await answer('allow');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fenced'));
  });

  it('asks again in the Turn after one whose calls were all refused', async () => {
    const { server, clientId, answer, status, submit } = await waitingSession();
    const finished = () =>
      waitFor(async () =>
        expect(await status()).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        }),
      );
    expect(await definitions()).toEqual([
      {
        engine: 'managed',
        sessionId: SESSION_ID,
        toolProfile: files,
        approvalMode: 'default',
        approvalTimeoutMs: HOSTED_APPROVAL_TIMEOUT_MS,
      },
    ]);
    expect((await answer('deny')).status).toBe(200);
    await finished();
    const second = randomUUID();
    await submit(second);
    expect((await answer('allow')).status).toBe(200);
    await finished();
    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      transcript.body.events
        .filter((event: { type: string }) => event.type === 'turn_complete')
        .map((event: { promptId: string }) => event.promptId),
    ).toEqual([PROMPT_ID, second]);
  });

  it('keeps a replay retryable when it fails before writing on a stopped Session', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const { server, clientId, answer, status } = await waitingSession();
    expect((await answer('allow')).status).toBe(200);
    await waitFor(async () =>
      expect(await status()).toMatchObject({ hasActivePrompt: false }),
    );
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValueOnce(new Error('journal down'));
    await headers(supertest(server).post(`/session/${SESSION_ID}/title`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ title: 'renamed' })
      .expect(503);
    // Only a Session whose writes stopped refuses the next write as well.
    await headers(supertest(server).post(`/session/${SESSION_ID}/title`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ title: 'renamed again' })
      .expect(503);
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockRejectedValueOnce(new Error('store unavailable'));
    const failed = await answer('allow');
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('action_resolution_failed');
    expect((await answer('allow')).status).toBe(200);
    const changed = await answer('deny');
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('action_already_resolved');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('store unavailable'),
    );
  });

  it('asks again in the next Turn after an approval expired unanswered', async () => {
    const { answer, status, submit } = await waitingSession();
    const finished = () =>
      waitFor(async () =>
        expect(await status()).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        }),
      );
    // An answer after the expiry time expires the Action at once.
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + HOSTED_APPROVAL_TIMEOUT_MS);
    const late = await answer('allow');
    now.mockRestore();
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('action_expired');
    await finished();
    await submit(randomUUID());
    expect((await answer('allow')).status).toBe(200);
    await finished();
    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
  });
  it.each([
    'success',
    'conflict',
    'closing',
    'old-history-unavailable',
    'corrupt-receipt',
    'release',
    'busy',
    'warm',
    'bind',
    'unsupported',
    'unknown-acquire',
    'unknown-released',
    'unknown-bind',
    'refusal-release',
    'capacity',
    'partial',
  ])(
    'settles undo or preserves its recovery boundary (%s)',
    async (scenario) => {
      const releaseFails = scenario === 'release';
      let writePromptId = PROMPT_ID;
      const historyState: HostedFileHistoryState = {
        ownerSessionId: SESSION_ID,
        snapshots: [
          {
            promptId: PROMPT_ID,
            timestamp: '2026-09-30T00:00:00.000Z',
            trackedFileBackups: {
              'notes.txt': {
                backupFileName: null,
                version: 1,
                backupTime: '2026-09-30T00:00:00.000Z',
              },
            },
          },
        ],
        files: {
          'notes.txt': { digest: `sha256:${'a'.repeat(64)}`, mode: 0o644 },
        },
      };
      if (scenario === 'partial') {
        historyState.snapshots[0].trackedFileBackups['other.txt'] = {
          ...historyState.snapshots[0].trackedFileBackups['notes.txt'],
        };
        historyState.files['other.txt'] = historyState.files['notes.txt'];
      }
      const conflict = scenario === 'conflict';
      const control = vi
        .mocked(HostedWorkspaceBroker.prototype.fileHistory)
        .mockImplementation(async (operation) =>
          operation.action === 'rewind'
            ? {
                state: conflict
                  ? historyState
                  : { ...historyState, files: { 'notes.txt': null } },
                filesChanged: conflict ? [] : ['notes.txt'],
                filesFailed: [],
                conflict,
              }
            : historyState,
        );
      state.model.mockImplementation(async ({ toolTurn, signal }) => {
        const call = {
          name: 'write_file',
          callId: 'write',
          args: { file_path: 'notes.txt', content: 'hello' },
          isClientInitiated: false,
          prompt_id: writePromptId,
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
          'model',
          signal,
        );
        await toolTurn!.consumeResults();
        return { text: 'done', model: 'test' };
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: files,
      });
      expect(created.status).toBe(200);
      let clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'write notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          prompt,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .send({})
        .expect(204);
      if (scenario === 'old-history-unavailable') {
        const read = LocalManagedSessionResourceStore.prototype.read;
        const fault = vi
          .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
          .mockImplementation(async function (
            this: LocalManagedSessionResourceStore,
            ref,
          ) {
            const bytes = await read.call(this, ref);
            if (
              ref.kind === 'managed-file_history' &&
              JSON.parse(bytes.toString('utf8')).pendingTurn
            )
              throw new Error('old history resource unavailable');
            return bytes;
          });
        const acquisitions = vi.mocked(HostedWorkspaceBroker.prototype.acquire)
          .mock.calls.length;
        const refused = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_turn_recovery_required');
        expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledTimes(
          acquisitions,
        );
        fault.mockRestore();
      }
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(loaded.status).toBe(200);
      clientId = loaded.body.clientId as string;
      const before = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(before.body.history.state).toEqual(historyState);
      if (scenario === 'corrupt-receipt') {
        const read = LocalManagedSessionResourceStore.prototype.read;
        const fault = vi
          .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
          .mockImplementation(async function (
            this: LocalManagedSessionResourceStore,
            ref,
          ) {
            const bytes = await read.call(this, ref);
            if (ref.kind !== 'managed-file_history') return bytes;
            const record = JSON.parse(bytes.toString('utf8'));
            record.undoReceipts = [
              {
                requestId: randomUUID(),
                promptId: PROMPT_ID,
                filesChanged: ['missing.txt'],
                conflict: false,
              },
            ];
            return Buffer.from(JSON.stringify(record));
          });
        const log = vi
          .spyOn(stdio, 'writeStderrLineSafe')
          .mockImplementation(() => {});
        const detail =
          'Invalid Hosted file history undo receipt 0: filesChanged must contain only tracked paths.';
        const failed = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(failed.status).toBe(503);
        expect(failed.body).toEqual({
          error: 'hosted_file_history_failed',
          code: 'hosted_file_history_failed',
        });
        expect(log).toHaveBeenCalledWith(
          `qwen serve: Hosted file history read failed: Error: ${detail}`,
        );
        await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
          .set('X-Qwen-Client-Id', clientId)
          .send({})
          .expect(204);
        log.mockClear();
        const failedLoad = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store(), toolProfile: files });
        expect(failedLoad.status).toBe(503);
        expect(failedLoad.body).toEqual({
          error: 'managed_session_open_failed',
          code: 'managed_session_open_failed',
        });
        expect(log).toHaveBeenCalledWith(
          `qwen serve: Hosted Session open failed: Error: ${detail}`,
        );
        fault.mockRestore();
        await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({ managedSessionStore: store(), toolProfile: files })
          .expect(200);
        await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).expect(204);
        return;
      }
      if (releaseFails)
        vi.mocked(
          HostedWorkspaceBroker.prototype.release,
        ).mockRejectedValueOnce(new Error('release response lost'));
      const request = { promptId: PROMPT_ID, requestId: randomUUID() };
      const undo = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/files/rewind`))
          .set('X-Qwen-Client-Id', clientId)
          .send(request);
      const physicalUndo = control.getMockImplementation()!;
      let rewinds = 0;
      control.mockImplementation(async (operation) => {
        if (operation.action === 'rewind') {
          const pending = await headers(
            supertest(server).get(`/session/${SESSION_ID}/files/history`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(pending.body.history.pendingUndo).toEqual({
            requestId: expect.any(String),
            promptId: operation.promptId,
          });
          if (rewinds++ === 0) {
            expect(pending.body.history.pendingUndo).toEqual(request);
            expect(pending.body.history.state).toEqual(historyState);
          }
        }
        return physicalUndo(operation);
      });
      if (scenario === 'closing') {
        const releaseActivation =
          LocalManagedSessionAuthority.prototype.releaseActivation;
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let closing = false;
        vi.spyOn(
          LocalManagedSessionAuthority.prototype,
          'releaseActivation',
        ).mockImplementation(async function (
          this: LocalManagedSessionAuthority,
          ...args
        ) {
          closing = true;
          await pending;
          return releaseActivation.apply(this, args);
        });
        const closed = headers(
          supertest(server).post(`/session/${SESSION_ID}/detach`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .then((response) => response);
        const acquisitions = vi.mocked(HostedWorkspaceBroker.prototype.acquire)
          .mock.calls.length;
        const controls = control.mock.calls.length;
        try {
          await waitFor(() => expect(closing).toBe(true));
          const refused = await undo();
          expect(refused.status).toBe(409);
          expect(refused.body.code).toBe('hosted_mcp_operation_active');
          expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledTimes(
            acquisitions,
          );
          expect(control).toHaveBeenCalledTimes(controls);
        } finally {
          finish();
          expect((await closed).status).toBe(204);
        }
        return;
      }
      if (
        scenario !== 'success' &&
        scenario !== 'conflict' &&
        scenario !== 'release' &&
        scenario !== 'old-history-unavailable'
      ) {
        const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
        const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
        const acquiredBefore = acquire.mock.calls.length;
        const releasedBefore = release.mock.calls.length;
        const retryable = ['busy', 'bind', 'unsupported', 'capacity'].includes(
          scenario,
        );
        if (scenario === 'warm')
          vi.mocked(HostedWorkspaceBroker.prototype.warm).mockRejectedValueOnce(
            new Error('warm response lost'),
          );
        if (['busy', 'unknown-acquire', 'unknown-released'].includes(scenario))
          acquire.mockRejectedValueOnce(
            new HostedWorkspaceBrokerRejection(
              scenario === 'busy' ? 409 : 503,
              scenario === 'unknown-released'
                ? 'runtime_session_not_acquirable'
                : 'workspace_busy',
            ),
          );
        if (
          ['bind', 'unsupported', 'unknown-bind', 'refusal-release'].includes(
            scenario,
          )
        )
          control.mockRejectedValueOnce(
            new HostedWorkspaceBrokerRejection(
              scenario === 'unsupported'
                ? 400
                : scenario === 'unknown-bind'
                  ? 503
                  : 409,
              scenario === 'unsupported'
                ? 'runtime_control_operation_invalid'
                : 'managed_runtime_provider_operation_failed',
            ),
          );
        if (scenario === 'refusal-release')
          release.mockRejectedValueOnce(new Error('release response lost'));
        if (scenario === 'capacity')
          vi.spyOn(
            hostedHistory,
            'assertHostedFileHistoryCapacity',
          ).mockRejectedValueOnce(
            new hostedHistory.HostedFileHistoryRefusedError(
              'capacity exhausted',
            ),
          );
        if (scenario === 'partial') {
          const physical = control.getMockImplementation()!;
          control.mockImplementation(async (operation) => {
            const result = await physical(operation);
            return operation.action === 'rewind'
              ? {
                  state: {
                    ...historyState,
                    files: { ...historyState.files, 'notes.txt': null },
                  },
                  filesChanged: ['notes.txt'],
                  filesFailed: ['other.txt'],
                  conflict: false,
                }
              : result;
          });
        }
        const response = await undo();
        expect(response.status).toBe(retryable ? 409 : 503);
        if (!retryable)
          expect(response.body.code).toBe(
            'hosted_file_history_recovery_required',
          );
        if (scenario === 'capacity')
          expect(response.body.code).toBe(
            'hosted_file_history_capacity_exceeded',
          );
        if (scenario === 'busy')
          expect(response.body.code).toBe('workspace_busy');
        if (scenario === 'bind' || scenario === 'unsupported')
          expect(response.body.code).toBe('hosted_file_history_refused');
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: !retryable,
        });
        const after = await headers(
          supertest(server).get(`/session/${SESSION_ID}/files/history`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(after.body.history.pendingUndo).toEqual(
          scenario === 'partial' ? request : null,
        );
        expect(after.body.history.state).toEqual(historyState);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(scenario === 'partial' ? 1 : 0);
        expect(acquire).toHaveBeenCalledTimes(
          acquiredBefore + (['capacity', 'warm'].includes(scenario) ? 0 : 1),
        );
        expect(release).toHaveBeenCalledTimes(
          releasedBefore +
            (['bind', 'unsupported', 'refusal-release'].includes(scenario)
              ? 1
              : 0),
        );
        if (retryable) {
          if (scenario === 'bind' || scenario === 'unsupported') {
            acquire.mockRejectedValueOnce(
              new HostedWorkspaceBrokerRejection(
                409,
                'runtime_session_not_acquirable',
              ),
            );
            const reused = await undo();
            expect(reused.status).toBe(409);
            expect(reused.body.code).toBe('runtime_session_not_acquirable');
            const stillUsable = await headers(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(stillUsable.body.recoveryBlocked).toBe(false);
            request.requestId = randomUUID();
          }
          expect((await undo()).status).toBe(200);
          expect((await undo()).status).toBe(200);
          expect(
            control.mock.calls.filter(([op]) => op.action === 'rewind'),
          ).toHaveLength(1);
        }
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
        return;
      }
      const response = await undo();
      expect(response.status).toBe(releaseFails ? 503 : conflict ? 409 : 200);
      if (releaseFails)
        expect(response.body.code).toBe(
          'hosted_file_history_recovery_required',
        );
      const after = await headers(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(after.body.history.pendingUndo).toEqual(
        releaseFails ? request : null,
      );
      expect(after.body.history.state.files).toEqual(
        conflict ? historyState.files : { 'notes.txt': null },
      );
      expect(after.body.history.undoReceipts).toEqual([
        {
          ...request,
          filesChanged: conflict ? [] : ['notes.txt'],
          conflict,
        },
      ]);
      if (!releaseFails) {
        const replay = await undo();
        expect(replay.status).toBe(conflict ? 409 : 200);
        expect(replay.body).toEqual(response.body);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(1);
        await headers(
          supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ promptId: PROMPT_ID, requestId: randomUUID() })
          .expect(conflict ? 409 : 200);
        const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
        const acquisitions = acquire.mock.calls.length;
        expect((await undo()).body).toEqual(response.body);
        expect(acquire).toHaveBeenCalledTimes(acquisitions);

        const anotherPrompt = randomUUID();
        historyState.snapshots.push({
          ...historyState.snapshots[0],
          promptId: anotherPrompt,
        });

        writePromptId = randomUUID();
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            promptId: writePromptId,
            prompt,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await waitFor(async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        });
        expect((await undo()).body).toEqual(response.body);
        const controls = control.mock.calls.length;
        const acquired = acquire.mock.calls.length;
        const mismatched = await headers(
          supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ ...request, promptId: anotherPrompt });
        expect(mismatched.status).toBe(409);
        expect(mismatched.body.code).toBe('hosted_file_rewind_conflict');
        expect(control).toHaveBeenCalledTimes(controls);
        expect(acquire).toHaveBeenCalledTimes(acquired);
        expect(
          control.mock.calls.filter(([op]) => op.action === 'rewind'),
        ).toHaveLength(2);
      }
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .send({})
        .expect(204);
      const reopened = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile: files });
      expect(reopened.status).toBe(releaseFails ? 409 : 200);
      if (releaseFails)
        expect(reopened.body.code).toBe(
          'hosted_file_history_recovery_required',
        );
      else {
        clientId = reopened.body.clientId as string;
        const acquisitions = vi.mocked(HostedWorkspaceBroker.prototype.acquire)
          .mock.calls.length;
        expect((await undo()).body).toEqual(response.body);
        expect(HostedWorkspaceBroker.prototype.acquire).toHaveBeenCalledTimes(
          acquisitions,
        );
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );
});

describe('Hosted Harness Runtime turn takeover', () => {
  const BOOT_ID_2 = '77777777-7777-4777-8777-777777777777';

  /** Captured per parked turn so tests can assert which loads acquire the
   * Runtime lease: a cold load never does, a passive takeover adopts it. */
  let acquireSpy: MockInstance<HostedWorkspaceBroker['acquire']>;

  beforeEach(async () => {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'workspaceContext',
    ).mockResolvedValue([]);
    resetManagedRuntimeDispatchGatesForTest();
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  function replacementApp() {
    const result = express();
    result.use(express.json());
    const contract = createHostedHarnessContract(
      `sha256:${'a'.repeat(64)}`,
      BOOT_ID_2,
    );
    installHostedHarnessContractMiddleware(result, contract);
    registerHostedHarnessSessionRoutes(result, contract, state.root, {
      baseUrl: 'http://127.0.0.1:1',
      token: 'test',
    });
    return result;
  }

  function replacementHeaders<T extends supertest.Test>(request: T): T {
    return request
      .set('X-Qwen-Harness-Protocol-Version', '1')
      .set('X-Qwen-Harness-Boot-Id', BOOT_ID_2);
  }

  function storeFor(writerId: string) {
    return { ...store(), writerId };
  }

  const FILE_PROFILE = 'hosted-workspace-files/1';
  const CALL = {
    name: 'write_file',
    callId: 'call-1',
    args: { file_path: 'a.txt', content: 'x' },
    isClientInitiated: false,
    prompt_id: PROMPT_ID,
  };
  const CALL_B = {
    name: 'write_file',
    callId: 'call-2',
    args: { file_path: 'b.txt', content: 'y' },
    isClientInitiated: false,
    prompt_id: PROMPT_ID,
  };

  /**
   * Drives a Workspace turn to its parked await_runtime checkpoint: the Broker
   * execute hangs until the owner is "crashed" via cancel, leaving the turn
   * unsettled in the journal.
   */
  async function parkToolTurn(
    retainOwnerOrCalls: boolean | Array<typeof CALL> = false,
    toolProfile = FILE_PROFILE,
  ) {
    // Callers pass either a retainOwner flag or the parked call list.
    const retainOwner = retainOwnerOrCalls === true;
    const calls = Array.isArray(retainOwnerOrCalls)
      ? retainOwnerOrCalls
      : [CALL];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    acquireSpy = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    if (calls.length === 1) {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
        '66666666-6666-4666-8666-666666666666',
      );
    } else {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare')
        .mockResolvedValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        .mockResolvedValue('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    }
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockImplementation((_id, _payload, signal) =>
        signal?.aborted
          ? Promise.reject(new Error('aborted'))
          : new Promise((_, reject) =>
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              ),
            ),
      );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile,
    });
    expect(created.status).toBe(200);
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          calls,
          calls.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        ) as never,
    );
    const prompt = [{ type: 'text', text: 'write a.txt' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    if (!retainOwner) {
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
      expect(closed.status).toBe(204);
    }
    // Only the parked owner's own acquires are behind us; a takeover's
    // acquire must be visible to the asserting test.
    acquireSpy.mockClear();
    return { server, clientId: created.body.clientId as string };
  }

  async function loadReplacement(passive = false, toolProfile = FILE_PROFILE) {
    const server = replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile,
      // Only the coordinator's takeover may drive or report a parked Turn.
      [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']:
        true,
    });
    return { server, loaded };
  }

  /**
   * Drives a Workspace turn to the parked agent wait through the
   * PRODUCTION admission itself (R1-8): the model launches a foreground
   * `agent` call, `acceptChildAgent`'s `commitAwaitAgent` lands the
   * durable wait, and the owner's death is staged by failing the
   * cancellation-time abandoned fold — the checkpoint stays at
   * `await_agent` and the journal keeps every step of the admission.
   */
  async function parkAgentWaitTurn(): Promise<{ clientId: string }> {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    acquireSpy = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const sabotage = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(async function (
        this: ManagedSessionRecordSink,
        record,
      ) {
        if (
          record.type === 'tool_result' &&
          record.daemonPromptId === PROMPT_ID
        )
          throw new Error('settlement unavailable');
        return originalWrite.call(this, record);
      });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
    });
    expect(created.status).toBe(200);
    const agentCall = {
      name: 'agent',
      callId: 'call-1',
      args: {
        description: 'audit the diff',
        prompt: 'review the change',
        run_in_background: false,
      },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [agentCall],
          [
            {
              functionCall: {
                id: 'call-1',
                name: 'agent',
                args: agentCall.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    const prompt = [{ type: 'text', text: 'launch the audit' }];
    const payloadDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(prompt))
      .digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const latestCheckpointState = async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        key,
      );
      const checkpoint = journal.events.findLast(
        (event) => event.kind === 'checkpoint.committed',
      );
      if (checkpoint === undefined) return undefined;
      return JSON.parse(
        (
          await resources.read(
            assertManagedSessionDurableRef(
              checkpoint.payload['stateRef'],
              'checkpoint',
            ),
          )
        ).toString(),
      );
    };
    // The wait is durable exactly when the admission's checkpoint names it:
    // anything earlier (the Session's initial checkpoint) must not pass.
    await vi.waitFor(
      async () => {
        expect((await latestCheckpointState())?.continuation.phase).toBe(
          'await_agent',
        );
      },
      { timeout: 10_000 },
    );
    // The owner "crashes": the cancellation reaches the abandoned fold,
    // whose write was sabotaged — the wait stays parked, and the durable
    // record is exactly what the library-level wedge hand-mints.
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    sabotage.mockRestore();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const savedState = await latestCheckpointState();
    expect(savedState.continuation.phase).toBe('await_agent');
    expect(savedState.agentWait.runs).toMatchObject([
      {
        childRunId: `${PROMPT_ID}:call-1`,
        functionCallId: 'call-1',
        consumed: false,
      },
    ]);
    return { clientId: created.body.clientId as string };
  }

  /**
   * The two-resume shape R2 exposes (R2-2/R2-1/R2-3): fg1 folded live and
   * its wait resolved — the checkpoint carries the all-consumed group.
   * `orphan` additionally admits fg2 in the admit→commit gap, so its own
   * wait row never minted; `carried` stops there, a clean carried shape
   * whose round holds no sibling gap.
   */
  async function parkAgentWaitResumeShape(
    shape: 'orphan' | 'carried',
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
    try {
      const harness = createManagedHarnessHandle(managed);
      const contentRef = await managed.resources.publish(
        'managed-input',
        Buffer.from(JSON.stringify([{ type: 'text', text: 'audit' }])),
      );
      const admissionRef = await managed.resources.publish(
        'managed-admission',
        Buffer.from(
          JSON.stringify({ promptId: PROMPT_ID, digest: 'a'.repeat(64) }),
        ),
      );
      await managed.authority.submitInput(
        {
          operation: 'submitInput',
          commandId: PROMPT_ID,
          sessionKey: key,
          contentDigest: 'a'.repeat(64),
        },
        {
          inputId: PROMPT_ID,
          turnId: PROMPT_ID,
          source: 'hosted-harness',
          contentRef,
          admissionRef,
          deadline: null,
          wakeReason: 'input',
        },
      );
      await harness.ensureRunnable();
      const children = new HostedChildAgentSession(
        { authority: managed.authority, resources: managed.resources },
        key,
      );
      const definition = {
        definitionId: 'hosted-agent/hosted-workspace-shell/1',
        definitionRevision: 1,
        definitionDigest: managed.authority.sessionHeader.definitionRef.digest,
      };
      const fg1 = `${PROMPT_ID}:call-1`;
      const launched1 = await children.admit({
        childRunId: fg1,
        ownerScopeId: SESSION_ID,
        rootSessionId: SESSION_ID,
        completion: 'tool',
        description: 'first audit',
        prompt: 'review one',
        definition,
        workingDirectory: '.',
        executionCallId: fg1,
      });
      // The dead batch's own round: it reached call-1's wait; the orphan
      // shape's call-2 is the call its owner never reached.
      const parts =
        shape === 'orphan'
          ? [
              { functionCall: { id: 'call-1', name: 'agent', args: {} } },
              { functionCall: { id: 'call-2', name: 'agent', args: {} } },
            ]
          : [{ functionCall: { id: 'call-1', name: 'agent', args: {} } }];
      await managed.sink.write({
        uuid: 'assistant-1',
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: state.root,
        version: 'test',
        daemonPromptId: PROMPT_ID,
        message: { role: 'model', parts },
      });
      await harness.commitAwaitAgent(
        [
          {
            childRunId: fg1,
            functionCallId: 'call-1',
            toolName: 'agent',
            modelMessageId: 'assistant-1',
            consumed: false,
          },
        ],
        { turnId: PROMPT_ID, promptId: PROMPT_ID },
        { attemptId: 'attempt-1', routeRef: launched1.inputRef },
      );
      await children.dispatchStarted(fg1, {
        dispatchId: 'dispatch-1',
        runtime: { runtimeBindingId: 'binding-1', generation: '1' },
      });
      await children.attach(fg1, 'child-session-1');
      await children.settleCompleted(fg1, {
        result: Buffer.from('{"review":"one clean"}', 'utf8'),
        receipt: Buffer.from('{"stopReason":"end_turn"}', 'utf8'),
      });
      await children.accept(fg1, {});
      await managed.sink.write({
        uuid: randomUUID(),
        parentUuid: 'assistant-1',
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: state.root,
        version: 'test',
        daemonPromptId: PROMPT_ID,
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'agent',
                response: { output: '{"review":"one clean"}' },
              },
            },
          ],
        },
      });
      const advanced = await harness.resolveAwaitAgent(fg1);
      expect(advanced?.continuation.phase).toBe('model_output_committed');
      if (shape === 'orphan') {
        const fg2 = `${PROMPT_ID}:call-2`;
        // Admitted in the admit→commit gap: the wait row for call-2 was
        // never minted, so the cancelled takeover meets it as a ledger
        // orphan, never as another wait (R2-2).
        await children.admit({
          childRunId: fg2,
          ownerScopeId: SESSION_ID,
          rootSessionId: SESSION_ID,
          completion: 'tool',
          description: 'second audit',
          prompt: 'review two',
          definition,
          workingDirectory: '.',
          executionCallId: fg2,
        });
      }
    } finally {
      await managed.close();
    }
  }

  it('settles the cancelled takeover of an admitted foreground orphan without waiting on it (R2-2)', async () => {
    await parkAgentWaitResumeShape('orphan');
    const { server, loaded } = await loadReplacement(
      true,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    expect(recovery.phase).toBe('await_agent');
    // The orphan never settles in this test: an un-aborted fill would hold
    // this reply hostage to the child's terminal forever.
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const body = JSON.stringify(transcript.body);
    // The admitted orphan meets the live arm's abandoned answer, never the
    // never-admitted one and never a poll.
    expect(body).toContain('cancelled before the child agent finished');
    expect(body).not.toContain(
      'cancelled before this child agent was admitted',
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 8000);

  it('the carried all-consumed continue adopts the takeover without claiming the mount (R2-1/R2-3)', async () => {
    await parkAgentWaitResumeShape('carried');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    acquireSpy = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(
      false,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_agent');
    expect(recovery.executions).toMatchObject([
      {
        functionCallId: 'call-1',
        outcome: 'known',
        status: { state: 'settled' },
      },
    ]);
    // The model's next round after the recovery emits a Runtime tool: its
    // turn-bound batch is the fault line R2-1 names — without the resolved
    // adoption it throws "Runtime work cannot continue a prior activation."
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [CALL],
          [
            {
              functionCall: {
                id: CALL.callId,
                name: CALL.name,
                args: CALL.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    acquireSpy.mockClear();
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 10_000 },
    );
    // The Runtime batch committed as takeover-era work: the shell round's
    // own durable wait is what follows the adopted continue.
    expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(1);
    // The agent-side of this arm must not claim the mount in advance:
    // resumeCommittedResults's unconditional acquire is exactly what would
    // refuse a later foreground agent call (R2-3). The carried shape's own
    // resume leg performs no acquire before the model's tool work asks.
    const firstAcquireOrder =
      acquireSpy.mock.invocationCallOrder.at(-1) ?? Number.MAX_SAFE_INTEGER;
    const firstExecuteOrder = vi
      .mocked(HostedWorkspaceBroker.prototype.execute)
      .mock.invocationCallOrder.at(-1)!;
    expect(firstAcquireOrder).toBeLessThan(firstExecuteOrder);
    expect(
      acquireSpy.mock.calls.length,
      'the acquire belongs to the model-round tool work, never the resume arm',
    ).toBe(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('a faulting adoption read blocks the continue before the model round starts (R2-9)', async () => {
    await parkAgentWaitResumeShape('carried');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(
      false,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    let calls = 0;
    const originalAuthorization =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      calls += 1;
      // The gate read answers; every later read faults — one of them is
      // the carried adoption's own authorization.
      if (calls > 1) throw new Error('store hiccup');
      return originalAuthorization.call(this);
    });
    state.model.mockClear();
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    // The swallowed-read shape would start the model round anyway; the
    // guarded one blocks the Turn first.
    expect(state.model).not.toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('admits a continue for the parked agent wait (R1-8)', async () => {
    await parkAgentWaitTurn();
    const { server, loaded } = await loadReplacement(
      false,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_agent');
    expect(recovery.executions).toMatchObject([
      {
        functionCallId: 'call-1',
        outcome: 'known',
        status: { state: 'executing' },
      },
    ]);
    // The gate this PR exists for: reverting it makes this answer 409
    // hosted_turn_recovery_required while the parent stays wedged.
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    // The re-driven Turn now waits on the ledger for a child that never
    // settles in this test: abandon it the way a live cancel would, so
    // the test leaves nothing in flight.
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('settles the parked agent wait through the cancel route (R1-8)', async () => {
    await parkAgentWaitTurn();
    const { server, loaded } = await loadReplacement(
      true,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
    expect(recovery.phase).toBe('await_agent');
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    // The cancelled takeover folded the live arm's abandoned answer and
    // advanced the checkpoint past its wait — exactly once.
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const journal = await LocalJsonlManagedSessionJournalStore.read(
      path.join(state.root, `${SESSION_ID}.jsonl`),
      key,
    );
    expect(
      journal.events.filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === PROMPT_ID,
      ),
    ).toHaveLength(1);
    const checkpoint = journal.events.findLast(
      (event) => event.kind === 'checkpoint.committed',
    )!;
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    const savedState = JSON.parse(
      (
        await resources.read(
          assertManagedSessionDurableRef(
            checkpoint.payload['stateRef'],
            'checkpoint',
          ),
        )
      ).toString(),
    );
    // The cancelled terminal advanced the checkpoint past the wait and
    // closed the Turn boundary — no carried group survives the turn's end
    // (encode drops the key for a null group, so the field is absent).
    expect(savedState.continuation.phase).toBe('before_model');
    expect(savedState.agentWait ?? null).toBeNull();
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(JSON.stringify(transcript.body)).toContain(
      'cancelled before the child agent finished',
    );
    expect(JSON.stringify(transcript.body)).toContain('"turn_complete"');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it.each(
    (['continue', 'cancel'] as const).flatMap((route) =>
      (['closing', 'authorizing', 'detached'] as const).map((phase) => ({
        route,
        phase,
      })),
    ),
  )(
    'fences recovery $route admission when $phase',
    async ({ route, phase }) => {
      await parkToolTurn();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
      const { server, loaded } = await loadReplacement();
      expect(loaded.status).toBe(200);
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      const clientId = loaded.body.clientId as string;
      state.model.mockClear();
      const cancel = vi.mocked(HostedWorkspaceBroker.prototype.cancel);
      cancel.mockClear();
      let finishRelease!: () => void;
      let finishAuthorization!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        finishRelease = resolve;
      });
      const authorizationGate = new Promise<void>((resolve) => {
        finishAuthorization = resolve;
      });
      let releasing = false;
      let authorizing = false;
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'release',
      ).mockImplementationOnce(async () => {
        releasing = true;
        await releaseGate;
      });
      if (phase !== 'closing') {
        const original =
          LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
        vi.spyOn(
          LocalManagedSessionAuthority.prototype,
          'harnessRunAuthorization',
        ).mockImplementation(async function (
          this: LocalManagedSessionAuthority,
        ) {
          const authorization = await original.call(this);
          authorizing = true;
          await authorizationGate;
          return authorization;
        });
      }
      const admit = () =>
        replacementHeaders(
          supertest(server).post(
            `/session/${SESSION_ID}/managed-runtime/${route}`,
          ),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ promptId: PROMPT_ID, ...recovery })
          .then((response) => response);
      let request: Promise<supertest.Response> | undefined;
      let closing: Promise<supertest.Response> | undefined;
      try {
        if (phase !== 'closing') {
          request = admit();
          await vi.waitFor(() => expect(authorizing).toBe(true));
        }
        closing = replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).then((response) => response);
        await vi.waitFor(() => expect(releasing).toBe(true));
        if (phase === 'detached') {
          finishRelease();
          expect((await closing).status).toBe(204);
        }
        if (phase === 'closing') request = admit();
        finishAuthorization();
        const refused = await request!;
        expect(refused.status).toBe(phase === 'detached' ? 404 : 409);
        expect(refused.body.code).toBe(
          phase === 'detached'
            ? 'hosted_session_not_found'
            : 'hosted_session_closing',
        );
        expect(state.model).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        finishRelease();
        expect((await closing).status).toBe(204);
      } finally {
        finishAuthorization();
        finishRelease();
        await request;
        await closing;
      }
    },
  );

  it('keeps a bare cold load of a parked Turn inert', async () => {
    await parkToolTurn();
    const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (file_history_pending): {"pendingTurn":"${PROMPT_ID}","pendingUndo":null,"unsettled":"${PROMPT_ID}","takeover":false}`,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it('replays a takeover load idempotently until its continue is admitted', async () => {
    await parkToolTurn();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('results_ready');

    // The original reply was presumably lost: the coordinator repeats the
    // takeover load against the same process and must get the same snapshot
    // instead of a bare already-attached refusal — without driving again.
    const repeated = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body._meta?.['qwen.daemon.managedRuntimeRecovery']).toEqual(
      recovery,
    );
    expect(execute).toHaveBeenCalledOnce();

    // A plain re-load still refuses while the recovery is pending.
    const bare = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(bare.status).toBe(409);
    expect(bare.body.code).toBe('hosted_session_already_attached');

    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );

    // After the continue settles, nothing is owed: a redrive answers the
    // plain attach (no recovery to recompute), not a refusal and not the
    // old snapshot — the re-answer mechanism needs no consumption rule.
    const afterContinue = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(afterContinue.status).toBe(200);
    expect(
      afterContinue.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    ).toBeUndefined();
    expect(afterContinue.body.clientId).toBe(loaded.body.clientId);
    expect(afterContinue.body.recoveryRequired).not.toBe(true);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps a turn that ended unanswered out of the resume request history too', async () => {
    // The continue builder must exclude an errored-turn prompt exactly
    // like the execute builder: a parked user Turn resumed through the
    // takeover must not replay the errored turn's naked user record.
    const ERRORED = 'eeeeeeee-1111-4222-8333-eeeeeeeeeeee';
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    acquireSpy = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockImplementation((_id, _payload, signal) =>
        signal?.aborted
          ? Promise.reject(new Error('aborted'))
          : new Promise((_, reject) =>
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              ),
            ),
      );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
    });
    expect(created.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    // Phase 0: a turn that ends unanswered — the model explodes and the
    // naked user record would be a live second-execution hazard.
    state.model.mockImplementationOnce(() => {
      throw new Error('model exploded');
    });
    const doomedPrompt = [{ type: 'text', text: 'doomed' }];
    const doomedDigest = `sha256:${createHash('sha256').update(JSON.stringify(doomedPrompt)).digest('hex')}`;
    const admitted = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt: doomedPrompt,
      promptId: ERRORED,
      payloadDigest: doomedDigest,
    });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // Phase 1: the parked user Turn (parkToolTurn's shape, inline).
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [CALL],
          [
            {
              functionCall: {
                id: CALL.callId,
                name: CALL.name,
                args: CALL.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    const prompt = [{ type: 'text', text: 'write a.txt' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admittedPark = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admittedPark.status).toBe(202);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    await authorize(supertest(server).post(`/session/${SESSION_ID}/cancel`));
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    // Takeover + continue: the resume request is the second builder.
    execute.mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server: replacement, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    state.model.mockClear();
    const continued = await replacementHeaders(
      supertest(replacement).post(
        `/session/${SESSION_ID}/managed-runtime/continue`,
      ),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    const modelInput = state.model.mock.calls.at(-1)![0] as {
      promptId?: string;
      history?: Array<{ type?: string; daemonPromptId?: string }>;
    };
    expect(modelInput.promptId).toBe(PROMPT_ID);
    const history = modelInput.history ?? [];
    // The errored turn's naked user record is out; the parked turn's own
    // records stay in.
    expect(history.some((entry) => entry.daemonPromptId === ERRORED)).toBe(
      false,
    );
    expect(history.some((entry) => entry.daemonPromptId === PROMPT_ID)).toBe(
      true,
    );
    // The teardown deletes nothing the resumed Turn still writes: it
    // settles before the Session goes.
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(replacement).delete(`/session/${SESSION_ID}`),
    );
  }, 30_000);

  it.each([FILE_PROFILE, 'hosted-workspace-files/2'])(
    'settles the parked execution on load and continues the turn (%s)',
    async (toolProfile) => {
      await parkToolTurn([CALL], toolProfile);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
      // Non-empty so "fetched" is distinguishable from "never fetched": an
      // empty read assembles to '', which the slot already looks like.
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'workspaceContext',
      ).mockResolvedValue([{ name: 'AGENTS.md', text: 'never touch prod' }]);
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      const { server, loaded } = await loadReplacement(false, toolProfile);
      expect(loaded.status).toBe(200);
      // The takeover holds the lease until the continued Turn settles.
      expect(release).not.toHaveBeenCalled();
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as {
        phase: string;
        checkpointId: string;
        activationId: string;
        executions: Array<Record<string, unknown>>;
      };
      expect(recovery.phase).toBe('results_ready');
      expect(recovery.executions).toEqual([
        expect.objectContaining({
          executionCallId: '66666666-6666-4666-8666-666666666666',
          outcome: 'known',
          status: { state: 'settled' },
        }),
      ]);
      let declarations: string[] | undefined;
      let recoveredContext: string | undefined;
      state.model.mockImplementationOnce(
        async ({ toolTurn, signal, workspaceContext }) => {
          // The takeover-built attachment must have read the Workspace
          // instructions before this recovered turn drives the model.
          recoveredContext = workspaceContext?.read();
          declarations = (await toolTurn!.declarations(signal)).map(
            (tool) => tool.name!,
          );
          return { text: 'continued', model: 'test-model' };
        },
      );
      const clientId = loaded.body.clientId as string;
      const continued = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(continued.status).toBe(200);
      expect(continued.body.accepted).toBe(true);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      expect(declarations).toEqual([
        'read_file',
        'write_file',
        'edit',
        ...(toolProfile.endsWith('/2') ? ['glob'] : []),
      ]);
      // The takeover-built attachment starts with an undefined slot: the
      // recovered turn must have populated it before driving the model, or
      // the user-visible answer is synthesized with no project instructions.
      expect(recoveredContext).toContain('--- Context from: AGENTS.md ---');
      expect(recoveredContext).toContain('never touch prod');
      const transcript = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_complete',
            promptId: PROMPT_ID,
          }),
        ]),
      );
      expect(
        state.model.mock.calls.some(
          (call) =>
            (call[0] as { resumeFromToolResults?: unknown[] })
              .resumeFromToolResults?.length === 1,
        ),
      ).toBe(true);
      // The recovered turn's Runtime Session is released once it settles — one
      // release for the tool turn's own reconciliation acquire, one for the
      // recovered lease.
      expect(release).toHaveBeenCalledTimes(2);
      // A replayed continuation for the settled Turn replays the receipt
      // without driving the model again.
      const modelCallsBeforeReplay = state.model.mock.calls.length;
      const replayed = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(replayed.status).toBe(200);
      expect(replayed.body.accepted).toBe(true);
      expect(state.model.mock.calls.length).toBe(modelCallsBeforeReplay);
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    },
  );

  function failFinalAuthorization(failure: 'blocked' | 'exception') {
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    const acquisitionsBefore = acquireSpy.mock.calls.length;
    let failed = false;
    return vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'harnessRunAuthorization')
      .mockImplementation(async function (this: LocalManagedSessionAuthority) {
        if (acquireSpy.mock.calls.length > acquisitionsBefore && !failed) {
          failed = true;
          if (failure === 'exception') throw new Error('store hiccup');
          return { status: 'blocked', reason: 'missing_state' } as never;
        }
        return original.call(this);
      });
  }

  it.each(
    (['blocked', 'exception'] as const).flatMap((failure) =>
      [false, true].map((retry) => ({ failure, retry })),
    ),
  )(
    'releases a resident passive adoption after $failure, retry=$retry',
    async ({ failure, retry }) => {
      const { server, clientId } = await parkToolTurn(true);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'prepared',
      });
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      const stderr = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => undefined);
      const owedLines = () =>
        stderr.mock.calls.filter(
          ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
        );
      const passiveLoad = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
          managedSessionStore: store(),
          toolProfile: FILE_PROFILE,
          passiveManagedRuntimeRecovery: true,
        });
      const authorization = failFinalAuthorization(failure);
      const refused = await passiveLoad();
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(acquireSpy).toHaveBeenCalledOnce();
      expect(authorization).toHaveBeenCalledTimes(
        failure === 'blocked' ? 4 : 2,
      );
      if (failure === 'blocked')
        expect(await authorization.mock.results[1].value).toMatchObject({
          status: 'blocked',
          reason: 'missing_state',
        });
      expect(release).not.toHaveBeenCalled();
      const firstRefusalDiagnostics = owedLines().length;
      let repeatedRefusalDiagnostics: number | undefined;
      authorization.mockRestore();
      if (retry) {
        const loaded = await passiveLoad();
        expect(loaded.status).toBe(200);
        expect(loaded.body.clientId).toBe(clientId);
        expect(acquireSpy).toHaveBeenCalledTimes(2);
        expect(release).not.toHaveBeenCalled();
        // Successful attachment drains the refusal's diagnostic record.
        const failedAgain = failFinalAuthorization(failure);
        expect((await passiveLoad()).status).toBe(409);
        repeatedRefusalDiagnostics = owedLines().length;
        failedAgain.mockRestore();
      }
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
      expect(closed.status).toBe(204);
      expect(release).toHaveBeenCalledOnce();
      expect(
        (release.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
      ).toBe(PROMPT_ID);
      expect(firstRefusalDiagnostics).toBe(1);
      if (retry) expect(repeatedRefusalDiagnostics).toBe(2);
    },
  );

  it('refuses a teardown that lands while a resident passive load is adopting', async () => {
    const { server } = await parkToolTurn(true);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockClear();
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
      );
    let finishAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      finishAcquire = resolve;
    });
    acquireSpy.mockImplementationOnce(() => acquireGate as never);
    let loading: Promise<supertest.Response> | undefined;
    try {
      loading = headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          toolProfile: FILE_PROFILE,
          passiveManagedRuntimeRecovery: true,
        })
        .then((response) => response);
      await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      // The parked recovery holds close()'s fence for its whole await, so a
      // DELETE without a client id is refused instead of racing the adoption:
      // releasing mid-adoption persists the record RELEASED and every later
      // acquire of that identity answers 409 runtime_session_not_acquirable.
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('hosted_turn_active');
      finishAcquire();
      const loaded = await loading;
      expect(loaded.status).toBe(200);
      expect(release).not.toHaveBeenCalled();
      expect(owedLines()).toHaveLength(0);
    } finally {
      finishAcquire();
      await loading;
    }
  }, 30_000);

  it.each(['resolved', 'rejected'])(
    'keeps teardown fenced until overlapping passive loads finish (%s)',
    async (secondOutcome) => {
      const { server, clientId } = await parkToolTurn(true);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'prepared',
      });
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      let finishFirst!: () => void;
      let finishSecond!: () => void;
      let rejectSecond!: (cause: Error) => void;
      const firstGate = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve, reject) => {
        finishSecond = resolve;
        rejectSecond = reject;
      });
      acquireSpy
        .mockImplementationOnce(() => firstGate as never)
        .mockImplementationOnce(() => secondGate as never);
      const passiveLoad = () =>
        headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({
            managedSessionStore: store(),
            toolProfile: FILE_PROFILE,
            passiveManagedRuntimeRecovery: true,
          })
          .then((response) => response);
      let firstLoad: Promise<supertest.Response> | undefined;
      let secondLoad: Promise<supertest.Response> | undefined;
      try {
        firstLoad = passiveLoad();
        await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledOnce(), {
          timeout: 10_000,
        });
        secondLoad = passiveLoad();
        await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledTimes(2), {
          timeout: 10_000,
        });
        const bothInFlight = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(bothInFlight.status).toBe(409);
        expect(bothInFlight.body.code).toBe('hosted_turn_active');
        expect(release).not.toHaveBeenCalled();
        finishFirst();
        const first = await firstLoad;
        expect(first.status).toBe(200);
        expect(first.body.clientId).toBe(clientId);
        const prematureClose = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(prematureClose.status).toBe(409);
        expect(prematureClose.body.code).toBe('hosted_turn_active');
        expect(release).not.toHaveBeenCalled();
        if (secondOutcome === 'rejected') {
          rejectSecond(new Error('store hiccup'));
        } else {
          finishSecond();
        }
        const second = await secondLoad;
        expect(second.status).toBe(secondOutcome === 'resolved' ? 200 : 409);
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
        expect(release).toHaveBeenCalledOnce();
        expect(
          (release.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
        ).toBe(PROMPT_ID);
        const repeatedClose = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(repeatedClose.status).toBe(404);
        expect(release).toHaveBeenCalledOnce();
      } finally {
        finishFirst();
        finishSecond();
        await Promise.all([firstLoad, secondLoad]);
      }
    },
    30_000,
  );

  it('refuses a teardown that lands after a resident passive load published its adoption', async () => {
    const { server } = await parkToolTurn(true);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockClear();
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
      );
    // onPassiveRuntimeAcquired publishes the adopted lease as soon as acquire
    // resolves, and the recovery reads execution states after that: gating the
    // read holds the teardown in the published-but-unfinished window.
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockResolvedValue({ state: 'prepared' });
    let finishStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      finishStatus = resolve;
    });
    status.mockImplementationOnce(async () => {
      await statusGate;
      return { state: 'prepared' };
    });
    let loading: Promise<supertest.Response> | undefined;
    try {
      loading = headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          toolProfile: FILE_PROFILE,
          passiveManagedRuntimeRecovery: true,
        })
        .then((response) => response);
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('hosted_turn_active');
      finishStatus();
      const loaded = await loading;
      expect(loaded.status).toBe(200);
      // The adopted lease stays on the live Session: releasing it here would
      // answer 409 runtime_session_not_acquirable to every later acquire of
      // the same identity.
      expect(release).not.toHaveBeenCalled();
      expect(owedLines()).toHaveLength(0);
    } finally {
      finishStatus();
      await loading;
    }
  }, 30_000);

  it('records the owed adoption when a teardown strands a drive redrive', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
      );
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    release.mockClear();
    let finishAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      finishAcquire = resolve;
    });
    acquireSpy.mockImplementationOnce(() => acquireGate as never);
    let redriving: Promise<supertest.Response> | undefined;
    try {
      redriving = replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: storeFor(BOOT_ID_2),
          toolProfile: FILE_PROFILE,
          driveRuntimeRecovery: true,
        })
        .then((response) => response);
      await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      // The close route fences an active Turn, MCP work and Hooks — not a
      // parked redrive whose await has not recorded its lease yet.
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).expect(204);
      finishAcquire();
      const redriven = await redriving;
      expect(redriven.status).toBe(404);
      expect(redriven.body.code).toBe('hosted_session_not_found');
      // The teardown handed the lease it could see; the redrive's own
      // adoption is named instead of released, because a release would
      // persist RELEASED and wedge every retried acquire of the identity.
      expect(release).toHaveBeenCalledOnce();
      expect(owedLines()).toHaveLength(1);
    } finally {
      finishAcquire();
      await redriving;
    }
  }, 30_000);

  it.each(['blocked', 'exception'] as const)(
    'records a cold passive adoption after final authorization is %s',
    async (failure) => {
      await parkToolTurn();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'prepared',
      });
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      const stderr = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => undefined);
      const authorization = failFinalAuthorization(failure);
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(409);
      expect(loaded.body.code).toBe('hosted_turn_recovery_required');
      expect(acquireSpy).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expect(
        stderr.mock.calls.some(
          ([line]) => line.includes('stays owed') && line.includes(PROMPT_ID),
        ),
      ).toBe(true);
      authorization.mockRestore();
      const reloaded = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        passiveManagedRuntimeRecovery: true,
      });
      expect(reloaded.status).toBe(200);
      expect(release).not.toHaveBeenCalled();
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).expect(204);
      expect(release).toHaveBeenCalledOnce();
      expect(
        (release.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
      ).toBe(PROMPT_ID);
    },
  );

  it('reports the undriven recovered Turn as in flight until a terminal route drives it', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const getStatus = () =>
      replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
    // The takeover answered with recovery, but the recovered Turn is still
    // owned by the client: /status must not read the Session as idle, or the
    // SDK's settlement check learns the Turn is terminal while it is not.
    const afterLoad = await getStatus();
    expect(afterLoad.body.hasActivePrompt).toBe(true);
    expect(afterLoad.body.recoveryBlocked).toBe(false);
    // A user cancel cannot stop an undriven recovered Turn — only the
    // coordinator's managed-runtime/cancel settles its parked executions —
    // so the route refuses instead of confirming a cancellation that never
    // happened. A fresh Turn must not start over the checkpoint the takeover
    // just advertised either.
    const userCancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(userCancelled.status).toBe(409);
    expect(userCancelled.body.code).toBe('hosted_turn_recovery_required');
    const freshPrompt = [{ type: 'text', text: 'a second turn' }];
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_active');
    // The refusal is the only oncall-visible evidence of a recovered Turn
    // that nobody drives — it must be logged, not just answered.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('refused a fresh prompt while recovered Turn'),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        expect((await getStatus()).body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // The recovered Turn settled: the Session admits fresh Turns again.
    const nextPrompt = [{ type: 'text', text: 'after the takeover' }];
    const nextPromptId = '55555555-5555-4555-8555-555555555555';
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: nextPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const later = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(later.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: nextPromptId,
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-answers a redriven takeover load whose reply was lost', async () => {
    await parkToolTurn();
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('results_ready');
    expect(execute).toHaveBeenCalledTimes(1);
    // The load reply is lost: the coordinator redrives the identical load
    // against the already-attached Session, which must re-answer the
    // recovery snapshot instead of wedging the Turn on a 409 loop.
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    expect(redriven.body.clientId).toBe(loaded.body.clientId);
    expect(redriven.body.lastEventId).toBe(loaded.body.lastEventId);
    const redrivenRecovery = redriven.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as Record<string, unknown>;
    expect(redrivenRecovery).toEqual(recovery);
    // The redrive dispatches nothing: the parked execution stays settled
    // exactly once.
    expect(execute).toHaveBeenCalledTimes(1);
    // The redriven snapshot admits the continuation.
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', redriven.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: redrivenRecovery['checkpointId'],
        activationId: redrivenRecovery['activationId'],
      });
    expect(continued.status).toBe(200);
    expect(continued.body.accepted).toBe(true);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', redriven.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', redriven.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
      ]),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-answers a redriven passive takeover load whose reply was lost', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(async () => {
        stopConfirmed = true;
      });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_runtime');
    // The passive load reply is lost; the redrive re-reads the Broker state
    // and re-answers the snapshot rather than refusing with a 409.
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    expect(redriven.body.clientId).toBe(loaded.body.clientId);
    const redrivenRecovery = redriven.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as Record<string, unknown>;
    expect(redrivenRecovery).toEqual(recovery);
    // The redriven snapshot admits the cancellation.
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', redriven.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: redrivenRecovery['checkpointId'],
        activationId: redrivenRecovery['activationId'],
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    expect(cancel).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666666');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps a transiently blocked restore on the retriable refusal', async () => {
    // A missing_state WITH the authority's store-error message is an erased
    // store call, not a durable verdict: the route must answer the retriable
    // 409, never the typed terminal decline, even though a bare
    // missing_state (no message) and missing_checkpoint both go terminal.
    await parkToolTurn();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'missing_state',
      message: 'the HTTP Managed Session writer is not active.',
    } as never);
    const close = vi.spyOn(LocalManagedSessionAuthority.prototype, 'close');
    const { loaded } = await loadReplacement();
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it('keeps a durably blocked cancel-arm restore on the retriable refusal', async () => {
    // The restore guard runs before the takeover branch: a durable verdict
    // on a cancellation-only load answers the baseline retriable refusal —
    // an attach from a blocked restore is unsafe for ANY shape, and the
    // kernel's inapplicable still wants no terminal write from this code.
    await parkToolTurn();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'opaque_state',
    } as never);
    const { loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBeUndefined();
  });

  it('refuses a cancellation takeover of a parked no-tool Turn retriably', async () => {
    // Where the kernel cannot even be called, nothing may answer "nothing
    // is owed": a minted plain attach would stand a Session whose parked
    // Turn no route resolves, and the loose latch would then admit input
    // the authority can never settle (R5-2'). The cancellation arm gets
    // the baseline retriable refusal instead; drive keeps its typed
    // model_start decline. Surface the connector's workspace==null shape:
    // a definition lacking any toolProfile, so the load stays tool-free.
    await parkToolTurn();
    const read = LocalManagedSessionResourceStore.prototype.read;
    vi.spyOn(
      LocalManagedSessionResourceStore.prototype,
      'read',
    ).mockImplementation(async function (
      this: LocalManagedSessionResourceStore,
      reference,
    ) {
      const bytes = await read.call(this, reference);
      if (reference.kind !== 'managed-definition') return bytes;
      const definition = JSON.parse(bytes.toString('utf8')) as Record<
        string,
        unknown
      >;
      delete definition['toolProfile'];
      return Buffer.from(JSON.stringify(definition));
    });
    const drive = await replacementHeaders(
      supertest(replacementApp()).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      driveRuntimeRecovery: true,
    });
    expect(drive.status).toBe(409);
    expect(drive.body.code).toBe('hosted_turn_recovery_declined');
    expect(drive.body.reason).toBe('model_start');

    // The decline closed its authority, releasing the writer latch for
    // the cancellation arm's load.
    const passive = await replacementHeaders(
      supertest(replacementApp()).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      passiveManagedRuntimeRecovery: true,
    });
    expect(passive.status).toBe(409);
    expect(passive.body.code).toBe('hosted_turn_recovery_required');
    expect(passive.body.reason).toBeUndefined();
  });

  it('replays the snapshot only to a request re-proving its store identity', async () => {
    // The replay hands over the attached session's client id, so a caller
    // with the harness token and a matching takeover shape must also
    // re-prove tenant/workspace/store — otherwise it drives a session whose
    // journal identity it never proved.
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const mismatched = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: { ...storeFor(BOOT_ID_2), tenantId: 'other-tenant' },
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('hosted_session_already_attached');
    // The workspace half of the identity check guards the same handover:
    // a matching tenant under the wrong workspace is still a caller that
    // never proved this Session's journal identity.
    const wrongWorkspace = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: {
        ...storeFor(BOOT_ID_2),
        workspaceId: 'other-workspace',
      },
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(wrongWorkspace.status).toBe(409);
    expect(wrongWorkspace.body.code).toBe('hosted_session_already_attached');
    const matching = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(matching.status).toBe(200);
  });

  function mockAuthorizationWithPhase(phase: string, approval: unknown) {
    // Pass the REAL authorization through with only the wait shape
    // changed: a wholesale replacement breaks the integrity checks the
    // route performs between open, restore and takeover.
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      const authorization = await original.call(this);
      if (authorization.status !== 'runnable') return authorization;
      return {
        ...authorization,
        checkpoint: {
          ...authorization.checkpoint,
          continuation: {
            ...authorization.checkpoint.continuation,
            phase,
          },
          ...(approval === undefined ? {} : { approval }),
        },
      } as never;
    });
  }

  it('carries a takeover decline reason onto the wire', async () => {
    // The seven-reason taxonomy was witnessed only at the restore guard:
    // this pins a recoverHostedRuntimeTurn decline reaching the route's
    // own emitter with its typed reason intact.
    await parkToolTurn();
    mockAuthorizationWithPhase('before_model', undefined);
    const { loaded } = await loadReplacement();
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_declined');
    expect(loaded.body.reason).toBe('model_start');
  });

  it('carries a resident kernel decline reason onto the wire', async () => {
    const { server } = await parkToolTurn(true);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({ status: 'blocked', reason: 'identity_mismatch' });
    const declined = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
    expect(declined.status).toBe(409);
    expect(declined.body.code).toBe('hosted_turn_recovery_declined');
    expect(declined.body.reason).toBe('checkpoint_blocked');
  });

  it.each([false, true])(
    'reattaches a resident requested approval (passive=%s)',
    async (passive) => {
      const { server, clientId } = await parkToolTurn(true);
      mockAuthorizationWithPhase('await_approval', { state: 'requested' });
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        toolProfile: FILE_PROFILE,
        [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']:
          true,
      });
      expect(loaded.status).toBe(200);
      expect(loaded.body.clientId).toBe(clientId);
      expect(loaded.body.recoveryRequired).toBeUndefined();
      expect(acquireSpy).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'settles a payable resident projection after a lost terminal write (passive=%s)',
    async (passive) => {
      await parkToolTurn();
      vi.mocked(HostedWorkspaceBroker.prototype.execute).mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
      const { server, loaded } = await loadReplacement();
      expect(loaded.status).toBe(200);
      const recovery = loaded.body._meta['qwen.daemon.managedRuntimeRecovery'];
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const write = vi
        .spyOn(ManagedSessionRecordSink.prototype, 'write')
        .mockImplementation(function (this: ManagedSessionRecordSink, item) {
          if (item.subtype === 'turn_result')
            return Promise.reject(new Error('terminal write unavailable'));
          return originalWrite.call(this, item);
        });
      await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        })
        .expect(200);
      await vi.waitFor(async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      });
      write.mockRestore();
      const history = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
      expect(history.body.history.pendingTurn).toBeNull();
      expect(history.body.history.pendingUndo).toBeNull();
      mockAuthorizationWithPhase('turn_settled', null);
      const redriven = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']:
          true,
      });
      expect(redriven.status).toBe(200);
      expect(redriven.body.clientId).toBe(loaded.body.clientId);
      await vi.waitFor(async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      });
    },
  );

  it('refuses a resident inapplicable redrive while a rewind owns the prompt slot', async () => {
    const realAuthorization =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    await parkToolTurn();
    vi.mocked(HostedWorkspaceBroker.prototype.execute).mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    const recovery = loaded.body._meta['qwen.daemon.managedRuntimeRecovery'];
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const write = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(function (this: ManagedSessionRecordSink, item) {
        if (item.subtype === 'turn_result')
          return Promise.reject(new Error('terminal write unavailable'));
        return originalWrite.call(this, item);
      });
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      })
      .expect(200);
    await vi.waitFor(async () => {
      const status = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
      expect(status.body.hasActivePrompt).toBe(false);
      expect(status.body.recoveryBlocked).toBe(true);
    });
    write.mockRestore();
    // An approval-pending redrive answers the inapplicable resident without
    // a projection, clearing the resident latch.
    mockAuthorizationWithPhase('await_approval', { state: 'requested' });
    const armed = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(armed.status).toBe(200);
    // The next redrive turns payable: hold it inside
    // settleProjectablePromptId, admit a rewind inside the window, and
    // only then release the held read.
    let resumeSettle!: () => void;
    const settleHeld = new Promise<void>((resolve) => {
      resumeSettle = resolve;
    });
    let settleParked = false;
    let helperAnswered = false;
    vi.mocked(
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization,
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      if (helperAnswered && !settleParked) {
        settleParked = true;
        await settleHeld;
      }
      const authorization = await realAuthorization.call(this);
      helperAnswered = true;
      if (authorization.status !== 'runnable') return authorization;
      return {
        ...authorization,
        checkpoint: {
          ...authorization.checkpoint,
          continuation: {
            ...authorization.checkpoint.continuation,
            phase: 'turn_settled',
          },
          approval: null,
        },
      } as never;
    });
    const redriven = replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        driveRuntimeRecovery: true,
      })
      .then((response) => response);
    await vi.waitFor(() => {
      expect(settleParked).toBe(true);
    });
    // The rewind's own history read is the only resource read in flight
    // now, so gating it parks the rewind after it took the prompt slot.
    let resumeRewindRead!: () => void;
    const rewindReadHeld = new Promise<void>((resolve) => {
      resumeRewindRead = resolve;
    });
    let rewindParked = false;
    const realRead = LocalManagedSessionResourceStore.prototype.read;
    const readSpy = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockImplementation(async function (
        this: LocalManagedSessionResourceStore,
        ...args: Parameters<LocalManagedSessionResourceStore['read']>
      ) {
        if (!rewindParked) {
          rewindParked = true;
          await rewindReadHeld;
        }
        return realRead.apply(this, args);
      } as never);
    const rewind = replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', armed.body.clientId)
      .send({ requestId: randomUUID(), promptId: PROMPT_ID })
      .then((response) => response);
    await vi.waitFor(() => {
      expect(rewindParked).toBe(true);
    });
    resumeSettle();
    const refused = await redriven;
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_active');
    // The rewind must keep its prompt slot: /status may never report the
    // Session idle while a workspace mutation is in flight.
    const during = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', armed.body.clientId);
    expect(during.body.hasActivePrompt).toBe(true);
    resumeRewindRead();
    readSpy.mockRestore();
    await rewind;
    await vi.waitFor(async () => {
      const status = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', armed.body.clientId);
      expect(status.body.hasActivePrompt).toBe(false);
    });
  });

  it.each(['removed', 'closing'] as const)(
    'refuses a resident inapplicable redrive when its attachment is %s',
    async (attachmentState) => {
      await parkToolTurn();
      vi.mocked(HostedWorkspaceBroker.prototype.execute).mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
      const { server, loaded } = await loadReplacement();
      expect(loaded.status).toBe(200);
      const originalAuthorization =
        LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
      let resumeAuthorization!: () => void;
      const authorizationGate = new Promise<void>((resolve) => {
        resumeAuthorization = resolve;
      });
      let authorizationCalls = 0;
      let authorizationHeld = false;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'harnessRunAuthorization',
      ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
        const authorization = await originalAuthorization.call(this);
        if (authorization.status !== 'runnable') return authorization;
        if (++authorizationCalls === 2) {
          authorizationHeld = true;
          await authorizationGate;
        }
        return {
          ...authorization,
          checkpoint: {
            ...authorization.checkpoint,
            continuation: {
              ...authorization.checkpoint.continuation,
              phase: 'await_approval',
            },
            approval: { state: 'requested' },
          },
        } as never;
      });
      let resumeClose!: () => void;
      const closeGate = new Promise<void>((resolve) => {
        resumeClose = resolve;
      });
      let closeHeld = false;
      if (attachmentState === 'closing') {
        vi.mocked(
          HostedWorkspaceBroker.prototype.release,
        ).mockImplementationOnce(async () => {
          closeHeld = true;
          await closeGate;
        });
      }
      const load = replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: storeFor(BOOT_ID_2),
          toolProfile: FILE_PROFILE,
          driveRuntimeRecovery: true,
        })
        .then((response) => response);
      let close: Promise<supertest.Response> | undefined;
      try {
        await vi.waitFor(() => expect(authorizationHeld).toBe(true));
        close = replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).then((response) => response);
        if (attachmentState === 'closing') {
          await vi.waitFor(() => expect(closeHeld).toBe(true));
        } else {
          expect((await close).status).toBe(204);
        }
        resumeAuthorization();
        const refused = await load;
        expect(refused.status).toBe(attachmentState === 'removed' ? 404 : 409);
        expect(refused.body.code).toBe(
          attachmentState === 'removed'
            ? 'hosted_session_not_found'
            : 'hosted_session_closing',
        );
      } finally {
        resumeAuthorization();
        resumeClose();
        await Promise.allSettled(close ? [load, close] : [load]);
      }
      expect((await close!).status).toBe(204);
    },
  );

  it('refuses a cancellation takeover attachment deleted during settlement', async () => {
    const { server } = await parkToolTurn(true);
    const authorize =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      const result = await authorize.call(this);
      if (result.status !== 'runnable') return result;
      return {
        ...result,
        checkpoint: {
          ...result.checkpoint,
          approval: null,
          tools: {
            ...result.checkpoint.tools,
            items: result.checkpoint.tools!.items.map((item) => ({
              ...item,
              state: 'settled',
              consumed: true,
            })),
          },
        },
      } as never;
    });
    let started!: () => void;
    const settling = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, item) {
        await originalWrite.call(this, item);
        if (item.subtype === 'turn_result') {
          started();
          await held;
        }
      },
    );
    const load = headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      })
      .then((response) => response);
    await settling;
    try {
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
        204,
      );
    } finally {
      resume();
    }
    const refused = await load;
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('hosted_session_not_found');
  });

  it('re-answers the unchanged recovery after a lost cancellation report', async () => {
    // Nothing consumed means nothing to unwedge: a failed cancel cannot
    // break the re-answer — the redrive recomputes from the attached state
    // and admits the still-pending cancellation (R5-8's gap, closed by
    // construction in D6's recompute mode).
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'unknown',
    });
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    const replayed = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(replayed.status).toBe(200);
    // The recompute proves the same parked Turn under the live state —
    // the failed cancel's unknown read surfaces honestly in the report.
    const replayRecovery = replayed.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
      executions: Array<{ outcome: string }>;
    };
    expect(replayRecovery.checkpointId).toBe(recovery.checkpointId);
    expect(replayRecovery.activationId).toBe(recovery.activationId);
    expect(replayRecovery.executions[0]?.outcome).toBe('unknown');
  });

  it('refuses a fresh prompt stacked on a Session attached with a parked Turn', async () => {
    // An approval-parked takeover answers inapplicable: the Session
    // attaches plain, with every latch skipped and no recoveryRequired
    // advertised (R5-2). The prompt route must still guard the journal
    // itself (R10-2): a different promptId admitted on top would run from
    // the parked Turn's mid-flight checkpoint, overwrite it on commit, and
    // leave two unsettled inputs that fail every later takeover closed.
    await parkToolTurn();
    mockAuthorizationWithPhase('await_approval', { state: 'requested' });
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBeUndefined();
    const prompt = [{ type: 'text', text: 'stack on the parked Turn' }];
    const stacked = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(stacked.status).toBe(409);
    // The session-level wedge code, deliberately NOT the prompt-scoped
    // one: `hosted_prompt_recovery_required` names the REQUESTED prompt's
    // own unsettled duplicate, and the coordinator proves a lost-reply
    // adoption from it (R11-1); a refusal about someone else's parked
    // work must never mint that proof.
    expect(stacked.body.code).toBe('hosted_turn_recovery_required');
    // Re-posting the PARKED promptId itself is not a replay either: the
    // journal holds it accepted AND unsettled, where only a takeover may
    // settle — answering the replay's 202 would certify an admission the
    // Session cannot drive.
    const parkedPrompt = [{ type: 'text', text: 'write a.txt' }];
    const reposted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: parkedPrompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(parkedPrompt)).digest('hex')}`,
      });
    expect(reposted.status).toBe(409);
    expect(reposted.body.code).toBe('hosted_prompt_recovery_required');
  });

  it('refuses an inapplicable takeover whose projection cannot settle the park', async () => {
    // The checkpoint claims turn_settled while the journal never landed
    // the record: the bare branch's settle conditions do not hold (the
    // executions are still unsettled, the assistant tail carries a
    // functionCall), so no route pays — the load keeps the retriable
    // refusal instead of minting a healthy-looking plain attach (R11-2).
    await parkToolTurn();
    mockAuthorizationWithPhase('turn_settled', undefined);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    for (const passive of [false, true]) {
      const refused = await replacementHeaders(
        supertest(replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']:
          true,
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
    }
    expect(
      log.mock.calls
        .map(([line]) => line)
        .some((line) => line.includes('takeover_inapplicable_unpayable')),
    ).toBe(true);
  });

  it('refuses the attached redrive of an inapplicable takeover it cannot settle', async () => {
    // Stage 1: the requested approval answers inapplicable and the Session
    // attaches (the resolve route can pay that wait). Stage 2: the parked
    // state has since become turn_settled-with-missing-record whose
    // projection cannot pay — the redrive must refuse retriably rather
    // than restate a 200 over a Turn nothing terminalizes (R11-2).
    await parkToolTurn();
    mockAuthorizationWithPhase('await_approval', { state: 'requested' });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    expect(loaded.body.recoveryRequired).toBeUndefined();
    mockAuthorizationWithPhase('turn_settled', null);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(409);
    expect(redriven.body.code).toBe('hosted_turn_recovery_required');
    expect(
      log.mock.calls
        .map(([line]) => line)
        .some((line) => line.includes('takeover_inapplicable_unpayable')),
    ).toBe(true);
  });

  it.each([null, FILE_PROFILE])(
    'settles the cancellation of an ownerless parked Turn on the takeover load (profile=%s)',
    async (toolProfile) => {
      // Arm B: a Turn parked mid model round (the settlement write failed,
      // then its Harness generation died for good). The takeover load
      // carrying the explicit cancellation signal settles the park itself
      // — the writer fence on the load proves the producer generation is
      // dead — instead of refusing forever (round-6 wedge). With tools
      // configured but NOTHING settled (no execution ever ran, the park's
      // checkpoint names no work yet) the same split applies: tools vs the
      // Turn's unpaid Runtime work (P1-1).
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...(toolProfile === null ? {} : { toolProfile }),
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const write = vi
        .spyOn(ManagedSessionRecordSink.prototype, 'write')
        .mockImplementation(async function (
          this: ManagedSessionRecordSink,
          record,
        ) {
          if (record.subtype === 'turn_result')
            throw new Error('settlement unavailable');
          return originalWrite.call(this, record);
        });
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: 10_000 },
      );
      write.mockRestore();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      // Without the explicit signal the very same shape keeps the baseline
      // retriable refusal first: nothing may mint a canned CANCELLED record
      // for a wait whose owner could still exist (the collision guard).
      const parkedRefused = await replacementHeaders(
        supertest(replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
      });
      expect(parkedRefused.status).toBe(409);
      expect(parkedRefused.body.code).toBe('hosted_turn_recovery_required');
      const replacement = replacementApp();
      const taken = await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(taken.status).toBe(200);
      expect(taken.body.recoveryRequired).toBeUndefined();
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) => line.includes('settles the cancelled park on load')),
      ).toBe(true);
      // The cancelled terminal is durable: the plain cancel route reads it
      // back as settled-at-tail (204, nothing left to abort), and the next
      // prompt admits — the park is closed, not hidden.
      const cancelled = await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/cancel`),
      ).set('X-Qwen-Client-Id', taken.body.clientId as string);
      expect(cancelled.status).toBe(204);
      const fresh = [
        { type: 'text', text: 'second turn after the cancelled park' },
      ];
      const admitted = await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', taken.body.clientId as string)
        .send({
          prompt: fresh,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(fresh)).digest('hex')}`,
        });
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(replacement).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', taken.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: 10_000 },
      );
    },
  );

  it.each([null, FILE_PROFILE])(
    'settles the cancellation takeover of a park that is not the first Turn (profile=%s)',
    async (toolProfile) => {
      // R9: Turn 1 completed first, so the sabotaged Turn 2 parks with
      // history behind it — a no-tool Session's restore basis is blocked
      // (history without a checkpoint) and a tool Session's checkpoint
      // names Turn 1, whose tools all settled and were consumed. Neither
      // shape owes Runtime work for a Turn that never reached a tool call;
      // the cancellation takeover settles them exactly like the
      // first-Turn park above.
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...(toolProfile === null ? {} : { toolProfile }),
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const first = [{ type: 'text', text: 'first turn completes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt: first,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(first)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: 10_000 },
      );
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const write = vi
        .spyOn(ManagedSessionRecordSink.prototype, 'write')
        .mockImplementation(async function (
          this: ManagedSessionRecordSink,
          record,
        ) {
          if (record.subtype === 'turn_result')
            throw new Error('settlement unavailable');
          return originalWrite.call(this, record);
        });
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: 10_000 },
      );
      write.mockRestore();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const taken = await replacementHeaders(
        supertest(replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(taken.status).toBe(200);
      expect(taken.body.recoveryRequired).toBeUndefined();
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) => line.includes('settles the cancelled park on load')),
      ).toBe(true);
    },
  );

  it.each(['cancelled', 'decided'])(
    'settles a cancellation takeover whose durable approval already ended (state=%s)',
    async (durableState) => {
      // P1-2: the wait the USER owns is payable while requested; once the
      // durable record ends it, a CANCELLING takeover has only the
      // cancelled-wait answer — the approval copy the dead owner left
      // behind must not hold the session (plain attach + 409 streams
      // forever per round-7's probe).
      await parkToolTurn();
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'harnessRunAuthorization',
      ).mockResolvedValue({
        status: 'runnable',
        checkpoint: {
          identity: {
            turnId: PROMPT_ID,
            promptId: PROMPT_ID,
            checkpointId: 'checkpoint-await-action',
          },
          attempt: {},
          continuation: { phase: 'await_action' },
          approval: { state: 'requested', requestId: 'request-1' },
          output: {},
          followUp: {},
          runtime: {},
          tools: { items: [] },
        },
      } as never);
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'action',
      ).mockReturnValue({ state: durableState } as never);
      const parkedRefused = await replacementHeaders(
        supertest(replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        passiveManagedRuntimeRecovery: true,
      });
      expect(parkedRefused.status).toBe(409);
      expect(parkedRefused.body.code).toBe('hosted_turn_recovery_required');
      const taken = await replacementHeaders(
        supertest(replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(taken.status).toBe(200);
      expect(taken.body.recoveryRequired).toBeUndefined();
    },
  );

  // A REAL checkpoint structurally read as an approval wait: the phase and
  // approval copy are overridden while identity, sequence and the rest of
  // the underlying authority pass through — so the wait's own durable gate
  // and the cancelled settle's close hook both drive on a coherent
  // authority. (A wholesale mock leaves the real latest checkpoint at the
  // tool round's await_runtime and the resolve hook would never fire.)
  function mockApprovalWaitAuthorization() {
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      const authorization = await original.call(this);
      if (authorization.status !== 'runnable') return authorization;
      return {
        ...authorization,
        checkpoint: {
          ...authorization.checkpoint,
          continuation: {
            ...authorization.checkpoint.continuation,
            phase: 'await_action',
          },
          approval: { state: 'requested', requestId: 'request-1' },
          tools: { items: [] },
        },
      } as never;
    });
  }

  it.each(['allow', 'deny'])(
    'settles the redriven cancellation takeover whose approval was answered since the attach (answer=%s)',
    async (optionId) => {
      // R9-2 + R9-3 (round-10/11 probes): the first takeover attaches
      // plain because the durable record says requested; the user answers
      // AFTER the attach through the real resolve route, so the
      // checkpoint copy stays the stale await_action one. The attached
      // branch never consulted the cancellation signal, and the passive
      // kernel threw the park back as an unknown phase. Now the settle
      // pays identically there, AND the wait closes with it — the SAME
      // Session's next prompt executes instead of failing its model-start
      // check on the obsolete phase.
      await parkToolTurn();
      mockApprovalWaitAuthorization();
      const action = vi
        .spyOn(LocalManagedSessionAuthority.prototype, 'action')
        .mockReturnValue({ state: 'requested' } as never);
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(200);
      expect(loaded.body.recoveryRequired).toBeUndefined();
      // The wait the USER owns ends after the attach: the record decides,
      // the copy the dead owner left still says requested.
      action.mockReturnValue({
        state: optionId === 'allow' ? 'decided' : 'cancelled',
      } as never);
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const commits: string[] = [];
      const commitOriginal = (
        LocalManagedSessionAuthority.prototype as unknown as {
          commitCheckpoint: (
            this: LocalManagedSessionAuthority,
            ...args: unknown[]
          ) => Promise<unknown>;
        }
      ).commitCheckpoint;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'commitCheckpoint' as never,
      ).mockImplementation(async function (
        this: LocalManagedSessionAuthority,
        ...args: unknown[]
      ) {
        commits.push(String((args[0] as { commandId?: string }).commandId));
        return commitOriginal.apply(this, args);
      });
      const taken = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(taken.status).toBe(200);
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) =>
            line.includes('settles the cancelled park on the redriven load'),
          ),
      ).toBe(true);
      // The same signal redriven inside the stream's landing window is a
      // re-answer, not a second settle: one Cancelled record total, and
      // no `turn:<id> is already committed` conflict in its place
      // (the round-10 minor).
      const raced = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(raced.status).toBe(200);
      expect(
        log.mock.calls
          .map(([line]) => line)
          .filter((line) =>
            line.includes('settles the cancelled park on the redriven load'),
          ),
      ).toHaveLength(1);
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) => line.includes('takeover_unavailable')),
      ).toBe(false);
      // The cancelled terminal is durable: the plain cancel route reads
      // settled-at-tail (204, nothing left to abort).
      const cancelled = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/cancel`),
      ).set('X-Qwen-Client-Id', taken.body.clientId as string);
      expect(cancelled.status).toBe(204);
      // And the cancelled settle closed the WAIT first: ahead of the
      // terminal record, the durable gate committed its own advance —
      // `model_output_committed`, a model-start family phase the next
      // prompt's run check accepts — so the checkpoint never dies one
      // phase behind the journal's terminal (R9-3, whose obsolete
      // `await_action` wedged the relief turn before it ever called the
      // model; the end-to-end relief-turn proof belongs to the
      // real-stack probe, whose approval-first park has no dangling
      // tool call to answer).
      expect(
        commits.some((id) => id.startsWith('harness:model_output_committed:')),
      ).toBe(true);
    },
  );

  it.each(['exception', 'missing_state'])(
    'refuses retriably when the wait-check reports %s, then settles on the replay',
    async (fault) => {
      // R9-5 (round-11 fault injection, both shapes): an exhausted store
      // retry used to hide as `undefined` inside the cancellation settle
      // — the cancelled terminal got minted over a wait the fault hid,
      // and the Session died on its stale checkpoint afterwards. Whether
      // the fault arrives as an exception or as the authority's own
      // blocked/missing_state verdict (its TransportError conversion
      // never throws), the answer is the same retriable refusal; once it
      // clears, the same shape settles.
      await parkToolTurn();
      mockApprovalWaitAuthorization();
      const action = vi
        .spyOn(LocalManagedSessionAuthority.prototype, 'action')
        .mockReturnValue({ state: 'requested' } as never);
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(200);
      expect(loaded.body.recoveryRequired).toBeUndefined();
      action.mockReturnValue({ state: 'decided' } as never);
      // The caller's wait-gate reads fine (#1); the settle's own
      // wait-check is the one that faults (#2) — mirroring the probe's
      // two faces of the same store failure.
      const authorizationMethod = LocalManagedSessionAuthority.prototype
        .harnessRunAuthorization as (
        this: LocalManagedSessionAuthority,
      ) => ReturnType<LocalManagedSessionAuthority['harnessRunAuthorization']>;
      let helperReads = 0;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'harnessRunAuthorization',
      ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
        helperReads += 1;
        if (helperReads === 2) {
          if (fault === 'exception') throw new Error('store transport failed');
          return { status: 'blocked', reason: 'missing_state' } as never;
        }
        return authorizationMethod.call(this);
      });
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const send = () =>
        replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({
          managedSessionStore: storeFor(BOOT_ID_2),
          passiveManagedRuntimeRecovery: true,
          cancellationTakeover: true,
        });
      const refused = await send();
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(
        log.mock.calls
          .map(([line]) => line)
          .some((line) => line.includes('settles the cancelled park')),
      ).toBe(false);
      // Nothing terminal was minted: the plain cancel still answers the
      // unsettled Turn honestly, exactly like pre-settle stock.
      const cancelled = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/cancel`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
      expect(cancelled.status).toBe(409);
      expect(cancelled.body.code).toBe('hosted_turn_recovery_required');
      // The fault gone, the same shape settles through the same annex.
      const taken = await send();
      expect(taken.status).toBe(200);
      expect(
        log.mock.calls
          .map(([line]) => line)
          .filter((line) =>
            line.includes('settles the cancelled park on the redriven load'),
          ),
      ).toHaveLength(1);
      const settled = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/cancel`),
      ).set('X-Qwen-Client-Id', taken.body.clientId as string);
      expect(settled.status).toBe(204);
    },
  );

  it('arms the undriven marker when a redriven load re-answers a newly drivable recovery', async () => {
    await parkToolTurn();
    // The first passive load meets an execution the Broker cannot account
    // for: the report is undrivable, so the marker stays unarmed.
    const status = vi.spyOn(HostedWorkspaceBroker.prototype, 'status');
    status.mockResolvedValue(undefined);
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const idle = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(idle.body.hasActivePrompt).toBe(false);
    // The reply was lost; by the redrive the Broker can account for the
    // execution, so the re-answer advertises a drivable recovery — and must
    // arm the same marker the first load would have, or a fresh prompt is
    // admitted over the parked execution the report describes.
    status.mockResolvedValue({ state: 'executing' });
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    const freshPrompt = [{ type: 'text', text: 'racing prompt' }];
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_active');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('disarms the undriven marker when a redriven load re-answers undrivable', async () => {
    await parkToolTurn();
    // The first passive load meets a live execution: the report is
    // drivable, so the marker arms — then its 200 reply is lost.
    const status = vi.spyOn(HostedWorkspaceBroker.prototype, 'status');
    status.mockResolvedValue({ state: 'executing' });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    // By the redrive the Broker has forgotten the execution: the recomputed
    // report is undrivable, and the coordinator fails the Turn without ever
    // calling continue/cancel — so the marker the first load armed must
    // discharge here, or no route ever clears it.
    status.mockResolvedValue(undefined);
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    const idle = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(idle.body.hasActivePrompt).toBe(false);
    // The refusal code discriminates the disarm: an armed marker answers
    // hosted_turn_active, while the journal-level guard (R10-2) answers
    // hosted_turn_recovery_required for the still-unsettled parked input.
    const freshPrompt = [{ type: 'text', text: 'after the disarm' }];
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  /** Commits a pending Monitor notification into the parked Session's
   * journal: the wake pump owes it a Turn the moment the Session idles. */
  async function commitMonitorNotification(turnId: string): Promise<void> {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const monitors = new HostedMonitorSession(
        { authority: managed.authority, resources: managed.resources },
        key,
      );
      const binding = { runtimeBindingId: 'binding-1', generation: '1' };
      await monitors.admit({
        monitorId: 'monitor-1',
        ownerScopeId: key.sessionId,
        executionCallId: 'call-1',
        args: { command: 'tail -f build.log' },
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1_000,
      });
      await monitors.dispatchStarted('monitor-1', binding);
      await monitors.attach('monitor-1', binding, { watch: 'started' });
      await monitors.observe(
        'monitor-1',
        { lines: ['one'] },
        {
          input: {
            inputId: turnId,
            turnId,
            source: 'monitor',
            contentRef: await managed.resources.publish(
              'managed-input',
              Buffer.from('{"text":"<task-notification />"}', 'utf8'),
            ),
            admissionRef: await managed.resources.publish(
              'managed-admission',
              Buffer.from('{}', 'utf8'),
            ),
            deadline: null,
            wakeReason: 'input',
          },
        },
      );
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  it('parks the Monitor wake pump while a recovered Turn is undriven', async () => {
    domainEnablement.monitorRun = true;
    try {
      await parkToolTurn([CALL], 'hosted-workspace-shell/1');
      const notificationTurnId = 'monitor-1:notify:1';
      await commitMonitorNotification(notificationTurnId);
      // A drivable passive takeover arms the undriven marker; the load
      // registration also kicks the wake pump that owns the notification.
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'executing',
      });
      wakeDeps.last = undefined;
      state.model.mockClear();
      // Count the pump's kicks so a retry refused while the marker is armed
      // is witnessed, not assumed from a hardcoded sleep.
      const kick = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick');
      const { server, loaded } = await loadReplacement(
        true,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const kicksAtLoad = kick.mock.calls.length;
      const armed = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(armed.body.hasActivePrompt).toBe(true);
      // The wake scheduler came up with the takeover load; the armed marker
      // must read busy to it, or the pump would start the monitor Turn over
      // the parked checkpoint the recovery report just advertised.
      const deps = wakeDeps.last as { busy?: () => boolean } | undefined;
      expect(deps?.busy?.()).toBe(true);
      // The park has something to park: the notification's input is
      // journaled where the pump reads it.
      const journal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      );
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === notificationTurnId,
        ),
      ).toBe(true);
      // At least one pump retry fires and is refused while the marker is
      // armed: no model Turn ran and the notification stays unsettled.
      await vi.waitFor(
        () => expect(kick.mock.calls.length).toBeGreaterThan(kicksAtLoad),
        { timeout: 10_000 },
      );
      expect(state.model).not.toHaveBeenCalled();
      const parkedJournal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      );
      expect(
        parkedJournal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === notificationTurnId,
        ),
      ).toBe(false);
      // Driving the recovered Turn to its terminal record discharges the
      // marker — the pump's busy claim releases with it. The stop step's
      // poll needs a terminal fence: report the execution settled now.
      const statusSpy = vi.mocked(HostedWorkspaceBroker.prototype.status);
      statusSpy.mockResolvedValue({ state: 'settled' });
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      const cancelled = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(cancelled.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      // The discharged marker must let the pump deliver the parked
      // notification: its model turn runs and its input settles.
      await vi.waitFor(() => expect(state.model).toHaveBeenCalled(), {
        timeout: 10_000,
      });
      await vi.waitFor(
        async () => {
          const delivered = await LocalJsonlManagedSessionJournalStore.read(
            path.join(state.root, `${SESSION_ID}.jsonl`),
            {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          );
          expect(
            delivered.events.some(
              (event) =>
                event.kind === 'turn.settled' &&
                event.payload['turnId'] === notificationTurnId,
            ),
          ).toBe(true);
        },
        { timeout: 10_000 },
      );
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.monitorRun = false;
    }
  });

  it('keeps the Monitor wake pump parked after an undrivable redrive disarms the marker', async () => {
    domainEnablement.monitorRun = true;
    try {
      await parkToolTurn([CALL], 'hosted-workspace-shell/1');
      const notificationTurnId = 'monitor-1:notify:1';
      await commitMonitorNotification(notificationTurnId);
      // A drivable passive takeover arms the undriven marker; the load
      // registration also kicks the wake pump that owns the notification.
      const status = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'status')
        .mockResolvedValue({ state: 'executing' });
      wakeDeps.last = undefined;
      state.model.mockClear();
      const kick = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick');
      const { server, loaded } = await loadReplacement(
        true,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const armed = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(armed.body.hasActivePrompt).toBe(true);
      // The lost reply is redriven once the Broker can no longer account
      // for the execution: the undrivable re-answer disarms the marker,
      // but the parked input is still unsettled in the journal, so the
      // pump must stay parked exactly like /prompt keeps refusing.
      status.mockResolvedValue({ state: 'unknown' });
      const redriven = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: 'hosted-workspace-shell/1',
        passiveManagedRuntimeRecovery: true,
      });
      expect(redriven.status).toBe(200);
      const disarmed = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(disarmed.body.hasActivePrompt).toBe(false);
      // A negative assertion can only wait on the clock: past two 500 ms
      // retry intervals the pump must still not have run the notification
      // Turn — no model call, and no turn.settled for a notification no
      // model ever saw. (A fired pump wedges the Session blocked, which
      // stops the kicks, so a kick-count gate would read the buggy arm as
      // a pass.)
      expect(kick.mock.calls.length).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(state.model).not.toHaveBeenCalled();
      const journal = await LocalJsonlManagedSessionJournalStore.read(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      );
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === notificationTurnId,
        ),
      ).toBe(false);
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.monitorRun = false;
    }
  });

  it('keeps the held Runtime lease when a redriven load fails transiently', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    release.mockClear();
    // A transient Broker failure inside the re-answer must refuse with the
    // retry-inviting code — and must NOT release the lease the attached
    // Session already holds: a release persists RELEASED and every later
    // redrive would wedge on runtime_session_not_acquirable.
    acquireSpy.mockRejectedValueOnce(new Error('broker hiccup'));
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(release).not.toHaveBeenCalled();
    // The next redrive recovers: same attachment, same recovery snapshot.
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    expect(redriven.body.clientId).toBe(loaded.body.clientId);
    expect(redriven.body._meta?.['qwen.daemon.managedRuntimeRecovery']).toEqual(
      loaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  /** Drives the parked Turn into the consume/settle crash window: the
   * committed results are consumed into the continuation (checkpoint
   * results_ready, every runtime item settled and consumed) while the
   * journal never lands the terminal record — the state a drive load's
   * lost reply leaves behind. */
  async function consumeParkedToolResults(): Promise<void> {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const outcome = await recoverHostedRuntimeTurn({
        session: managed,
        sessionId: SESSION_ID,
        cwd: state.root,
        promptId: PROMPT_ID,
        brokerOptions: { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        passive: false,
      });
      if (outcome.kind !== 'recovered')
        throw new Error(`expected a recovery, got ${outcome.kind}`);
      await createManagedHarnessHandle(managed).consumeRuntimeResults();
    } finally {
      await managed.close();
    }
  }

  it('disarms the undriven marker when a redriven load settles the cancelled park', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    // The owner dies between consumeRuntimeResults() and
    // settleConsumedRuntimeContinuation(): results_ready with every runtime
    // item settled and consumed, the journal input still unsettled.
    await consumeParkedToolResults();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    // The lost-reply redrive carrying the coordinator's cancellation
    // settles the park without the kernel — and must discharge the marker
    // with it, or /prompt refuses this Session for the rest of the
    // incarnation.
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
      cancellationTakeover: true,
    });
    expect(redriven.status).toBe(200);
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settled.body.hasActivePrompt).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // A user cancel over the settled Turn keeps the plain 204: the
    // client's cancel flow hard-requires it before streaming the terminal
    // record, and a definitive refusal would be retried forever.
    const userCancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(userCancelled.status).toBe(204);
    // The Session is usable again: a fresh prompt is admitted and settles.
    const nextPrompt = [{ type: 'text', text: 'after the redriven settle' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: '99999999-9999-4999-8999-999999999999',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const idle = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(idle.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-answers a redriven takeover load of a Session without a parked Turn', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
    });
    expect(created.status).toBe(200);
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const { server: replacement, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    expect(loaded.body._meta).toBeUndefined();
    // Same lost-reply redrive, but the Session has no parked Turn: the
    // attachment is re-stated as-is.
    const redriven = await replacementHeaders(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    expect(redriven.body.clientId).toBe(loaded.body.clientId);
    expect(redriven.body._meta).toBeUndefined();
    await replacementHeaders(
      supertest(replacement).delete(`/session/${SESSION_ID}`),
    );
  });

  it('reports a parked execution passively and cancels the turn', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => ({
        state: stopConfirmed ? 'settled' : 'prepared',
      }));
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(async () => {
        stopConfirmed = true;
      });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    // Passive takeover adopts the original Runtime without dispatching work.
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    // The owner may lose its first load reply after Harness registered it.
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.clientId).toBe(loaded.body.clientId);
    expect(acquireSpy).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    const recovery = reloaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.phase).toBe('await_runtime');
    expect(recovery.executions).toEqual([
      expect.objectContaining({
        outcome: 'known',
        status: { state: 'prepared' },
      }),
    ]);
    expect(status).toHaveBeenCalled();
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    expect(cancel).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666666');
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // The cancelled round's assistant functionCall must meet a journaled
    // tool_result, or the next turn's history is malformed for providers.
    const toolResults = (
      transcript.body.events as Array<{
        type: string;
        data?: {
          record?: {
            type?: string;
            message?: { parts?: Array<{ functionResponse?: { id?: string } }> };
          };
        };
      }>
    ).filter(
      (event) =>
        event.type === 'managed_journal_event' &&
        event.data?.record?.type === 'tool_result',
    );
    expect(
      toolResults.flatMap(
        (event) =>
          event.data?.record?.message?.parts?.map(
            (part) => part.functionResponse?.id,
          ) ?? [],
      ),
    ).toEqual([CALL.callId]);
    // A cancelled recovery must not wedge the session: the next turn runs.
    const nextPromptId = '44444444-4444-4444-8444-444444444444';
    const nextPrompt = [{ type: 'text', text: 'after cancel' }];
    const next = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        prompt: nextPrompt,
        promptId: nextPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(next.status).toBe(202);
    await vi.waitFor(
      async () => {
        const later = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(later.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: nextPromptId,
              data: expect.objectContaining({ stopReason: 'end_turn' }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    // Exactly once, across the whole lifecycle: the cancel route's own
    // release discharges the owed lease with its identity, so the teardown
    // skips what is now a redundant handback.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease owed when the cancel route fails transiently and settles on retry', async () => {
    await parkToolTurn();
    let released = false;
    let stopConfirmed = false;
    let failNextStatus = false;
    // Model the real Broker: once released, the same identity can never be
    // re-acquired and its reads refuse — a stray release must not stay green.
    acquireSpy.mockImplementation(async () => {
      if (released)
        throw new HostedWorkspaceBrokerRejection(
          409,
          'runtime_session_not_acquirable',
        );
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => {
        if (released)
          throw new HostedWorkspaceBrokerRejection(
            404,
            'runtime_session_not_found',
          );
        if (failNextStatus) {
          failNextStatus = false;
          throw new Error('broker transport blip');
        }
        return { state: stopConfirmed ? 'settled' : 'prepared' };
      },
    );
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(async () => {
        stopConfirmed = true;
      });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async () => {
        released = true;
      });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // One transient transport failure on the cancel route's first read.
    failNextStatus = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    // The coordinator retries a failed cancel: the adopted lease must stay
    // owed, or the retried takeover can never be driven again.
    expect(release).not.toHaveBeenCalled();
    const retried = await cancelTurn();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    expect(cancel).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666666');
    // The only handback is the successful retry's own.
    expect(release).toHaveBeenCalledTimes(1);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the lease owed when the handback 404 carries a foreign code', async () => {
    await parkToolTurn();
    // The parked execution already settled before the owner died: the
    // cancel only has to confirm it, settle the Turn, and release.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    // A 404 whose code is not runtime_session_not_found — a gateway in
    // front of the Broker, or a Broker build without this route — says
    // nothing about the handback, so it must not certify one.
    let foreign404 = true;
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async () => {
        if (foreign404) {
          foreign404 = false;
          throw new HostedWorkspaceBrokerRejection(
            404,
            'runtime_broker_route_not_found',
          );
        }
      });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    // The foreign-coded 404 was not a completed handback: the failure is
    // logged and the lease stays owed for a later terminal route.
    expect(release).toHaveBeenCalledTimes(1);
    expect(
      stderr.mock.calls
        .map(([line]) => line)
        .some((line) => line.includes('failed after the cancellation settled')),
    ).toBe(true);
    // Close is the terminal route with no later retry: it hands the owed
    // lease back itself instead of leaving the Workspace lease pinned.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('keeps the adoption owed through a failed terminal write and settles on the redriven cancel', async () => {
    await parkToolTurn();
    // The parked execution already settled before the owner died: the
    // cancel only has to confirm it, settle the Turn, and release.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failTerminalWrite = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (failTerminalWrite && record.subtype === 'turn_result') {
          failTerminalWrite = false;
          throw new Error('store hiccup');
        }
        return originalWrite.call(this, record);
      },
    );
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // A store hiccup on the terminal turn_result write only. Releasing the
    // adopted session before that write would leave the Turn unsettled with
    // its identity RELEASED — no retry could ever re-acquire it.
    failTerminalWrite = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    expect(release).not.toHaveBeenCalled();
    // The first attempt advanced the checkpoint before the write failed, so
    // the redriven cancel still carries the load-time snapshot. The daemon
    // never re-loads an attached Session, so the route re-admits it against
    // the current checkpoint — the owed, still-READY lease stays acquirable
    // for exactly this retry.
    const retried = await cancelTurn();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    // The retry released once, after the terminal record landed.
    expect(release).toHaveBeenCalledTimes(1);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // A replayed cancel replays at the admission watermark it was admitted
    // under, same as before.
    const replayed = await cancelTurn();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(retried.body.lastEventId);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the lease owed when the takeover load cannot verify workspace writes', async () => {
    await parkToolTurn();
    let released = false;
    acquireSpy.mockImplementation(async () => {
      if (released)
        throw new HostedWorkspaceBrokerRejection(
          409,
          'runtime_session_not_acquirable',
        );
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async () => {
        released = true;
      });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    // The restore-stage write probe passes, so the passive takeover adopts
    // first; the post-recovery probe then rejects once.
    state.assertWritable
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('writer lost'));
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(stderr.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (workspace_writable): Error: writer lost`,
    );
    expect(acquireSpy).toHaveBeenCalled();
    // The refusal invited a retried takeover load: the adopted lease must
    // stay owed — but never silently, since a Session closed before
    // registration leaves no route to hand it back.
    expect(release).not.toHaveBeenCalled();
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) =>
          typeof line === 'string' &&
          line.includes('stays owed') &&
          line.includes(PROMPT_ID),
      );
    expect(owedLines()).toHaveLength(1);
    // The retried takeover on the same daemon re-acquires the READY
    // identity idempotently and reports.
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    expect(
      reloaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    ).toBeDefined();
    expect(owedLines()).toHaveLength(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('records the owed adoption when every takeover load refuses the workspace writes', async () => {
    await parkToolTurn();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => undefined);
    const owedLines = () =>
      stderr.mock.calls.filter(
        ([line]) =>
          typeof line === 'string' &&
          line.includes('stays owed') &&
          line.includes(PROMPT_ID),
      );
    // The probe rejects after every adoption, on every attempt: the refusal
    // is persistent, so the same daemon keeps refusing.
    let probeCalls = 0;
    state.assertWritable.mockImplementation(async () => {
      probeCalls += 1;
      if (probeCalls % 2 === 0) throw new Error('writer lost');
    });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(409);
    expect(stderr.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (workspace_writable): Error: writer lost`,
    );
    const second = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(second.status).toBe(409);
    // Every refused attempt re-adopts the same READY identity — never
    // releasing it, or the wedge this PR removes would reopen — while the
    // stranded adoption is reported exactly once per identity, by name.
    expect(acquireSpy).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    expect(owedLines()).toHaveLength(1);
    // The next successful load drains the record, so a later refusal must
    // report again rather than stay silent on a stale one.
    state.assertWritable.mockImplementation(async () => undefined);
    probeCalls = 0;
    const third = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(third.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    state.assertWritable.mockImplementation(async () => {
      probeCalls += 1;
      if (probeCalls % 2 === 0) throw new Error('writer lost');
    });
    probeCalls = 0;
    const fourth = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(fourth.status).toBe(409);
    expect(owedLines()).toHaveLength(2);
    // Only the successful Session's own teardown released anything.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease held when the cancel meets a blocked session', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    // Drive the recovered turn, then flip the session blocked with an
    // unrecoverable write — same mechanism the continuation fixture uses.
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // The recovery-blocked exit keeps the adopted lease held: no handback is
    // attempted there, since a successful release would persist RELEASED and
    // the next takeover's same-identity re-acquire would conflict forever.
    expect(release).not.toHaveBeenCalled();
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_turn_recovery_required');
    // The blocked refusal does not hand the lease back either: the workspace
    // outlives this refusal, and a RELEASED identity can never be
    // re-acquired by the retirement-time retry.
    expect(release).not.toHaveBeenCalled();
    // The close owns the adopted lease's single handback.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('answers a settled cancellation even when the final handback fails', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockRejectedValueOnce(new Error('broker unreachable'))
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
    };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The terminal record is durable before the handback runs, so a release
    // failure must not refuse an already-settled cancellation.
    const cancelled = await cancelTurn();
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // The admission survives the failed handback: a replay still replays at
    // its watermark, and the replay discharges the owed lease — the failed
    // handback (call 1) plus the replay's own (call 2).
    const replayed = await cancelTurn();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(cancelled.body.lastEventId);
    expect(release).toHaveBeenCalledTimes(2);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    // The teardown must not re-release an already-discharged lease.
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('refuses to settle a cancellation the Broker never confirmed', async () => {
    await parkToolTurn();
    // The cancel is accepted but the stop can never be observed: the
    // execution state becomes unreadable right after it.
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockResolvedValueOnce({ state: 'prepared' })
      .mockResolvedValueOnce({ state: 'executing' })
      .mockRejectedValue(new Error('broker gone'));
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const cancelled = await send();
    expect(cancelled.status).toBe(503);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    // No terminal record may land while the stop is unconfirmed, and the
    // owned Turn keeps the Session refused rather than reading as settled.
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    const between = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(between.body.hasActivePrompt).toBe(true);
    // The coordinator's retry re-drives the same cancellation to settlement.
    let stopConfirmed = false;
    status.mockImplementation(async () => ({
      state: stopConfirmed ? 'settled' : 'prepared',
    }));
    cancel.mockImplementation(async () => {
      stopConfirmed = true;
    });
    const retried = await send();
    expect(retried.status).toBe(200);
    await vi.waitFor(
      async () => {
        const later = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(later.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps an unobserved execution honest when the retry re-reads it as stopped', async () => {
    await parkToolTurn([CALL, CALL_B]);
    const EXEC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const EXEC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    // Attempt 1: the first execution is read executing, cancelled, and then
    // its record vanishes — counted as unobserved — before the second
    // execution's still-reconcilable unknown throws the stop away,
    // discarding the counted set with the return value.
    let vanished = false;
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async (id) => {
        if (id === EXEC_A) return vanished ? undefined : { state: 'executing' };
        return { state: 'unknown' };
      });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async (id) => {
        if (id === EXEC_A) vanished = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const first = await send();
    expect(first.status).toBe(503);
    expect(
      (
        (
          await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', clientId)
        ).body.events as Array<{ type: string }>
      ).filter((event) => event.type === 'turn_complete'),
    ).toHaveLength(0);
    // Attempt 2: the reclaimed record now reads as already-stopped to the
    // fresh stop, so only the carried set keeps the retry from certifying a
    // witnessed cancellation nobody observed.
    status.mockImplementation(async (id) =>
      id === EXEC_B ? { state: 'settled' } : undefined,
    );
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    const outcomes = new Map(
      (settled.body.events as Array<{ data?: { record?: ChatRecord } }>)
        .flatMap((event) =>
          event.data?.record?.type === 'tool_result' &&
          event.data.record.daemonPromptId === PROMPT_ID
            ? [event.data.record]
            : [],
        )
        .map((record) => {
          const response = record.message?.parts?.[0]?.functionResponse;
          return [
            response?.id,
            (response?.response as Record<string, unknown> | undefined)?.[
              'executionStatus'
            ],
          ] as const;
        }),
    );
    expect(outcomes.get('call-1')).toBe('unknown');
    expect(outcomes.get('call-2')).toBe('cancelled');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the cancellation re-drivable when the settle cannot verify the park', async () => {
    await parkToolTurn();
    // The stop proves quickly (the execution is already settled), so only
    // the settle's own authorization read — tens of seconds after the
    // admission and stop reads — comes back non-runnable.
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockResolvedValue({ state: 'settled' });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const original =
      LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
    let authorizationReads = 0;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
      authorizationReads += 1;
      if (authorizationReads === 3)
        return { status: 'blocked', reason: 'missing_state' } as never;
      return original.call(this);
    });
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const cancelled = await send();
    // A settle that could not verify the park journaled nothing, so the
    // route must answer the retry-inviting refusal — never a 200 over a
    // terminal record the parked executions did not earn.
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    const between = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(between.body.hasActivePrompt).toBe(true);
    // The admission was dropped with the failure, so the coordinator's
    // retry re-drives the stop instead of replaying a watermark — the
    // broker read proves the drive re-ran.
    status.mockClear();
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    expect(status).toHaveBeenCalled();
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        settled.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('refuses cancel with a mismatched recovery identity', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: 'ckpt-from-another-epoch',
        activationId: 'activation-from-another-epoch',
      });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_recovery_identity_mismatch');
    expect(cancel).not.toHaveBeenCalled();
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (transcript.body.events as Array<{ type: string }>).filter(
        (event) => event.type === 'turn_complete',
      ),
    ).toHaveLength(0);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('replays a lost cancel admission at its watermark while it runs', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => ({
        state: stopConfirmed ? 'settled' : 'prepared',
      }));
    // Hold the cancel's confirmation open so the replay meets it in flight.
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      () => cancelGate,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The stop step's first status read proves the first cancel was admitted
    // (the route registers the admission before the body runs), so the replay
    // deterministically meets the in-flight admission — polling /status
    // cannot prove this once a takeover also reports the Session in flight.
    let stopStarted!: () => void;
    const stopStartedGate = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    status.mockImplementation(async () => {
      stopStarted();
      return { state: stopConfirmed ? 'settled' : 'prepared' };
    });
    // supertest Test objects are lazy: only a continuation sends the request.
    // Arm the first cancel without awaiting it — its reply lands only after
    // the cancelGate below is released.
    const first = send();
    void first.then(
      () => undefined,
      () => undefined,
    );
    await stopStartedGate;
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.accepted).toBe(true);
    stopConfirmed = true;
    releaseCancel();
    const answered = await first;
    expect(answered.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(answered.body.lastEventId);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('logs the reconciliation root cause of a refused load-resume', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    // The drive consumed the parked results, so the checkpoint now reads
    // results_ready with the file-history marker still pending: detach, and
    // the next bare load computes a resume whose reconciliation reads the
    // drifted snapshot.
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'fileHistory',
    ).mockResolvedValueOnce({
      ownerSessionId: SESSION_ID,
      snapshots: [{ filePath: 'drifted' } as never],
      files: {},
    });
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('managed_session_open_failed');
    // The 503 carries no detail: the root cause an operator needs must be in
    // the daemon log, not swallowed by the final else arm.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Original file history snapshots changed.'),
    );
  });

  it('reports an undrivable recovery passively without arming the Session', async () => {
    await parkToolTurn();
    // Only a still-reconcilable unknown reports as failing to account for
    // the execution: the coordinator cannot drive it either, so arming the
    // marker here would refuse every later route forever.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'unknown',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    expect(recovery.executions).toEqual([
      expect.objectContaining({ outcome: 'unknown' }),
    ]);
    const clientId = loaded.body.clientId as string;
    // The coordinator cannot drive a recovery whose executions are unknown —
    // it fails the Turn without ever calling continue/cancel — so arming
    // the undriven marker here would pile `hosted_turn_active` onto the
    // journal-state refusals G3 already answers for the parked input: the
    // Session must stay unarmed instead.
    const status = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(status.body.hasActivePrompt).toBe(false);
    expect(status.body.recoveryBlocked).toBe(false);
    // G3's journal-state guards own the refusal while the parked input
    // stays unsettled: the user cancel meets R10-3's honest 409, and a
    // fresh prompt meets R10-2's session-level 409 — `hosted_turn_active`
    // here would mean the marker armed, which is exactly what this test
    // forbids for an undrivable report.
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('hosted_turn_recovery_required');
    const freshPrompt = [{ type: 'text', text: 'after a lost runtime' }];
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(409);
    expect(admitted.body.code).toBe('hosted_turn_recovery_required');
    // The settling prompt must not release the lease this load adopted: a
    // release persists RELEASED and wedges the still-parked Turn's next
    // takeover on runtime_session_not_acquirable — the adoption is owed to
    // the terminal recovery route or close() alone.
    expect(release).not.toHaveBeenCalled();
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
  });

  it('drives a takeover cancellation over a terminally abandoned execution', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'abandoned',
    });
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
      executions: Array<Record<string, unknown>>;
    };
    // A terminally fenced record keeps its distinction — it is reported to
    // the coordinator, not folded away — and stays drivable, because the
    // stop step already accepts it as cancellation-complete.
    expect(recovery.executions).toEqual([
      expect.objectContaining({
        outcome: 'known',
        status: { state: 'abandoned' },
      }),
    ]);
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    expect(release).toHaveBeenCalledTimes(1);
    // The execution's stop was never observed — the durable record must say
    // so instead of certifying a cancellation nobody witnessed.
    const settledTranscript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    const toolResults = (
      settledTranscript.body.events as Array<{
        data?: { record?: ChatRecord };
      }>
    ).flatMap((event) =>
      event.data?.record?.type === 'tool_result' &&
      event.data.record.daemonPromptId === PROMPT_ID
        ? [event.data.record]
        : [],
    );
    expect(toolResults).toHaveLength(1);
    const outcome = toolResults[0]?.message?.parts?.[0]?.functionResponse
      ?.response as Record<string, unknown> | undefined;
    expect(outcome?.['executionStatus']).toBe('unknown');
    expect(String(outcome?.['error'])).toContain('could not be observed');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('refuses a file rewind while a recovered Turn is undriven', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    const historySpy = vi.spyOn(hostedHistory, 'readHostedFileHistory');
    // A route that borrows `active` as its busy flag must not be admitted
    // over the undriven Turn either — it would confuse the user cancel with
    // an abort the rewind body never consults, and its own failure would
    // wedge the recovery it races.
    const rewound = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        requestId: '99999999-9999-4999-8999-999999999999',
        promptId: PROMPT_ID,
      });
    expect(rewound.status).toBe(409);
    expect(rewound.body.code).toBe('hosted_turn_active');
    expect(historySpy).not.toHaveBeenCalled();
    const userCancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(userCancelled.status).toBe(409);
    expect(userCancelled.body.code).toBe('hosted_turn_recovery_required');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the failed stop re-drivable after a replay certified the cancel', async () => {
    await parkToolTurn();
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => ({ state: 'prepared' }));
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const cancel = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
      .mockImplementation(() => cancelGate);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    let stopStarted!: () => void;
    const stopStartedGate = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    status.mockImplementation(async () => {
      stopStarted();
      return { state: 'prepared' };
    });
    // supertest requests are lazy until a continuation is attached.
    const first = send();
    void first.then(
      () => undefined,
      () => undefined,
    );
    await stopStartedGate;
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.accepted).toBe(true);
    // The replay answered 200 while the first drive still ran, but the
    // first request's 503 is retry-inviting: a failure before anything
    // durable moved must stay re-drivable, never latched into a permanent
    // block the retry would meet.
    status.mockRejectedValue(new Error('broker gone'));
    releaseCancel();
    const answered = await first;
    expect(answered.status).toBe(503);
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(true);
    expect(later.body.recoveryBlocked).toBe(false);
    // The armed recovery marker is the loud signal: a user cancel and a
    // fresh prompt keep refusing while the Turn stays undriven.
    const userCancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(userCancelled.status).toBe(409);
    expect(userCancelled.body.code).toBe('hosted_turn_recovery_required');
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(409);
    expect(prompted.body.code).toBe('hosted_turn_active');
    // The coordinator's retry falls through the replay branch to the
    // attached-to-unsettled drive and settles the Turn.
    let stopConfirmed = false;
    status.mockImplementation(async () => ({
      state: stopConfirmed ? 'settled' : 'prepared',
    }));
    cancel.mockImplementation(async () => {
      stopConfirmed = true;
    });
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settled.body.hasActivePrompt).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('admits the post-settle failure loudly once the checkpoint has moved', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The stop already confirmed and the cancelled journal entries landed,
    // so the checkpoint has moved — and a failure from here can never be
    // re-driven against the same recovery identity again.
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockRejectedValueOnce(new Error('history write rejected'));
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(503);
    // The checkpoint already moved, so the idempotent second settle inside
    // the branch acts the same retry-any-way guarantee: the cancelled
    // outcome is durable, and the Session is usable rather than armed.
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(false);
    expect(later.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // …and the retirement it skipped stays owed: the admitted prompt's
    // admission drive retires the durable marker ahead of the new Turn (the
    // close-path discharger is the sibling test's witness), so the cold
    // load is still admitted instead of refusing every later restore
    // forever.
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloaded.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('disarms the marker when the terminal record committed but its acknowledgement was lost', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The terminal write commits durably and only its acknowledgement is
    // lost: the Turn IS settled, so no attached-to-unsettled retry could
    // ever re-drive — the armed marker would wedge the Session forever.
    // The fault is gated so only the recovered Turn's record loses its
    // acknowledgement; the fresh prompt below must settle cleanly.
    let failFinalSettlement = true;
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, recordToWrite) {
        if (recordToWrite.subtype === 'turn_result' && failFinalSettlement) {
          await originalWrite.call(this, recordToWrite);
          throw new Error('acknowledgement lost');
        }
        return originalWrite.call(this, recordToWrite);
      },
    );
    const cancelled = await send();
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    // The record landed durably, so the retried cancel is answered from the
    // committed watermark by the settled replay — and the marker is
    // disarmed rather than left armed on a Session nothing could clear.
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body.accepted).toBe(true);
    const status = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(status.body.hasActivePrompt).toBe(false);
    expect(status.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // A fresh prompt is admitted over the cleanly cancelled Turn, with the
    // acknowledgement fault disarmed so the phase witnesses a clean settle.
    failFinalSettlement = false;
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    // Let the admitted Turn finish before the teardown removes its root.
    // hasActivePrompt cannot see a refused settle, so the clean-settle
    // claim is witnessed on the recoveryBlocked latch it would set.
    await vi.waitFor(
      async () => {
        const settled = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(settled.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settled.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('disarms the marker when a re-driven settle noops over a record its write already committed', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // Attempt 1's terminal writes are refused without committing, so its
    // failure is genuinely re-drivable. Attempt 2's settle noops over the
    // already-resolved executions, so the drive reaches the terminal write
    // with nothing durable moved — and that write commits while losing its
    // acknowledgement. The branch that treats the failure as fully
    // re-drivable must still read the committed turn.settled and disarm,
    // or the Session wedges on a record that exists.
    let phase: 'reject' | 'commit-then-reject' | 'clean' = 'reject';
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, recordToWrite) {
        if (recordToWrite.subtype === 'turn_result') {
          if (phase === 'reject')
            throw new Error('terminal record write rejected');
          if (phase === 'commit-then-reject') {
            phase = 'clean';
            await originalWrite.call(this, recordToWrite);
            throw new Error('terminal record acknowledgement lost');
          }
        }
        return originalWrite.call(this, recordToWrite);
      },
    );
    const first = await send();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    const armed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(armed.body.hasActivePrompt).toBe(true);
    phase = 'commit-then-reject';
    const second = await send();
    expect(second.status).toBe(503);
    // The record committed, so the Session is not wedged: the marker is
    // disarmed and a fresh prompt is admitted.
    const disarmed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(disarmed.body.hasActivePrompt).toBe(false);
    expect(disarmed.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(1);
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    // Let the admitted Turn finish before the teardown removes its root.
    await vi.waitFor(
      async () => {
        const settled = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(settled.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('writes the terminal record when a certified replay meets a post-settle failure', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    const status = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'status')
      .mockImplementation(async () => ({
        state: stopConfirmed ? 'settled' : 'prepared',
      }));
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      () => cancelGate,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    console.error('DIAG loaded', loaded.status, JSON.stringify(loaded.body));
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    let stopStarted!: () => void;
    const stopStartedGate = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    status.mockImplementation(async () => {
      stopStarted();
      return { state: stopConfirmed ? 'settled' : 'prepared' };
    });
    // supertest requests are lazy until a continuation is attached.
    const first = send();
    void first.then(
      () => undefined,
      () => undefined,
    );
    await stopStartedGate;
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.accepted).toBe(true);
    // The replay certified this cancellation while in flight, so when a
    // post-settle step then fails, the branch that has the cancellable
    // checkpoint must still land the terminal record the coordinator is
    // streaming for at the watermark.
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockRejectedValueOnce(new Error('history write rejected'));
    stopConfirmed = true;
    releaseCancel();
    const answered = await first;
    expect(answered.status).toBe(503);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(false);
    expect(later.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('admits a partially applied settle loudly once its identity already moved', async () => {
    await parkToolTurn([CALL, CALL_B]);
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The settle moves the checkpoint one resolveAwaitRuntime at a time, so
    // failing the SECOND execution's journal write has already outgrown the
    // identity its retry would have to match — no re-drive can ever land.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let toolResultWrites = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (
          recordToWrite.type === 'tool_result' &&
          recordToWrite.daemonPromptId === PROMPT_ID &&
          ++toolResultWrites === 2
        )
          throw new Error('history write rejected');
        return originalWrite.call(this, recordToWrite);
      },
    );
    const cancelled = await send();
    expect(cancelled.status).toBe(503);
    let transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    // The partially settled identity still settles loudly: the second,
    // idempotent settle completes inside the failure branch, and the
    // cancelled terminal record lands.
    await vi.waitFor(
      async () => {
        transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(false);
    expect(later.body.recoveryBlocked).toBe(false);
    // The admission stays certified, so replaying the same cancel answers
    // its recorded watermark, and the settled outcome is observable from
    // there — nothing stays armed.
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.accepted).toBe(true);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-drives a partially applied settle that could not finish once the store heals', async () => {
    await parkToolTurn([CALL, CALL_B]);
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The second execution's journal write refuses while the store is sick:
    // the first execution's write lands so the settle partially applies and
    // moves the checkpoint, and the idempotent second settle inside the
    // failure branch cannot finish either.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failSettleWrites = false;
    let toolResultWrites = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (
          failSettleWrites &&
          recordToWrite.type === 'tool_result' &&
          recordToWrite.daemonPromptId === PROMPT_ID &&
          ++toolResultWrites >= 2
        )
          throw new Error('history write rejected');
        return originalWrite.call(this, recordToWrite);
      },
    );
    const send = (snapshot: { checkpointId: string; activationId: string }) =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: snapshot.checkpointId,
          activationId: snapshot.activationId,
        });
    failSettleWrites = true;
    const cancelled = await send(recovery);
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    // A settle that could not finish is still re-drivable: the admission is
    // dropped so the coordinator's retry re-runs the idempotent settle, and
    // the armed marker — not a permanent block — keeps the failure visible.
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.hasActivePrompt).toBe(true);
    expect(later.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    // The still-sick retry is admitted and re-drives into the same 503
    // rather than meeting a permanent refusal.
    const sickRetry = await send(recovery);
    expect(sickRetry.status).toBe(503);
    expect(sickRetry.body.code).toBe('managed_runtime_cancel_failed');
    // The Turn never settled, so its file-history marker was never owed to
    // an in-memory retry: close must not retire it — a later takeover still
    // needs the marker to reconcile the resume.
    const before = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(before.body.history.pendingTurn).toBe(PROMPT_ID);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    // …and a fresh incarnation over the same store still finds it — and
    // once the store heals, its re-driven cancel finishes the settle and
    // lands the terminal record.
    failSettleWrites = false;
    const restarted = replacementApp();
    const reloaded = await replacementHeaders(
      supertest(restarted).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    const history = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', reloaded.body.clientId as string);
    expect(history.body.history.pendingTurn).toBe(PROMPT_ID);
    const healedRecovery = reloaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const healedClientId = reloaded.body.clientId as string;
    const healed = await replacementHeaders(
      supertest(restarted).post(
        `/session/${SESSION_ID}/managed-runtime/cancel`,
      ),
    )
      .set('X-Qwen-Client-Id', healedClientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: healedRecovery.checkpointId,
        activationId: healedRecovery.activationId,
      });
    expect(healed.status).toBe(200);
    expect(healed.body.accepted).toBe(true);
    const healedTranscript = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', healedClientId);
    expect(healedTranscript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    const healedStatus = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', healedClientId);
    expect(healedStatus.body.hasActivePrompt).toBe(false);
    expect(healedStatus.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(restarted).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-drives a cancel that moved nothing, even with a stale recovery checkpoint', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The admission fence keys on the activation plus the unsettled Turn
    // precisely because the checkpoint may legitimately have advanced
    // underneath, so the request's load-time checkpointId may already be
    // stale here — the failure classification must key on what this drive
    // moved, never on that stale identity.
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: 'stale-checkpoint-id',
          activationId: recovery.activationId,
        });
    // The settle's first journal write refuses: nothing durable moved, so
    // the failure must stay re-drivable however stale the checkpointId is.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failSettleWrites = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (
          failSettleWrites &&
          recordToWrite.type === 'tool_result' &&
          recordToWrite.daemonPromptId === PROMPT_ID
        )
          throw new Error('history write rejected');
        return originalWrite.call(this, recordToWrite);
      },
    );
    failSettleWrites = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    const retried = await cancelTurn();
    expect(retried.status).toBe(503);
    expect(retried.body.code).toBe('managed_runtime_cancel_failed');
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.recoveryBlocked).toBe(false);
    // Once the store heals, the same cancel re-drives to a clean settlement.
    failSettleWrites = false;
    const healed = await cancelTurn();
    expect(healed.status).toBe(200);
    expect(healed.body.accepted).toBe(true);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('re-drives a cancel whose terminal record keeps failing instead of replaying a false success', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failTerminalWrites = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (failTerminalWrites && recordToWrite.subtype === 'turn_result')
          return Promise.reject(new Error('terminal record write rejected'));
        return originalWrite.call(this, recordToWrite);
      },
    );
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const cancelTurn = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    // The settle lands but every terminal turn_result write is refused: the
    // admission must not stay to replay a watermark no turn_complete can
    // ever appear at — the failure stays re-drivable instead.
    failTerminalWrites = true;
    const first = await cancelTurn();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('managed_runtime_cancel_failed');
    const retried = await cancelTurn();
    expect(retried.status).toBe(503);
    expect(retried.body.code).toBe('managed_runtime_cancel_failed');
    expect(release).not.toHaveBeenCalled();
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.recoveryBlocked).toBe(false);
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          event.type === 'turn_complete' && event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    // The retry path is intact: once the store heals, the same cancel
    // re-drives the idempotent settle and lands the terminal record.
    failTerminalWrites = false;
    const healed = await cancelTurn();
    expect(healed.status).toBe(200);
    expect(healed.body.accepted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const settled = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settled.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // With the fault disarmed before any fresh admission, the Session is
    // fully usable again: a new prompt writes its own terminal record and
    // nothing stays blocked.
    const freshPrompt = [{ type: 'text', text: 'after the healed cancel' }];
    const freshPromptId = '66666666-6666-4666-8666-666666666666';
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: freshPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: freshPromptId,
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    const idle = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(idle.body.hasActivePrompt).toBe(false);
    expect(idle.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps the pending marker and refuses a fresh prompt while the cancelled Turn lacks its terminal record', async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn([CALL, CALL_B]);
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The first settle partially applies (its second journal write refuses
    // once) so the compensating settle completes it, but every terminal
    // turn_result write stays refused: the Turn is durably settled with no
    // terminal record.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let toolResultWrites = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (
          recordToWrite.type === 'tool_result' &&
          recordToWrite.daemonPromptId === PROMPT_ID &&
          ++toolResultWrites === 2
        )
          throw new Error('history write rejected');
        if (recordToWrite.subtype === 'turn_result')
          return Promise.reject(new Error('terminal record write rejected'));
        return originalWrite.call(this, recordToWrite);
      },
    );
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(503);
    const later = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(later.body.recoveryBlocked).toBe(false);
    // Without the terminal record the Turn is still owed its drive, so a
    // fresh prompt keeps refusing — and no retirement site may drop the
    // pending marker a later takeover still needs to reconcile the resume.
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(409);
    expect(prompted.body.code).toBe('hosted_turn_active');
    expect(dropSpy).not.toHaveBeenCalled();
    // Close owes no retirement for a Turn whose record never landed, so the
    // durable marker survives the incarnation boundary.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(dropSpy).not.toHaveBeenCalled();
    const restarted = replacementApp();
    const reloaded = await replacementHeaders(
      supertest(restarted).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(reloaded.status).toBe(200);
    const history = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', reloaded.body.clientId as string);
    expect(history.body.history.pendingTurn).toBe(PROMPT_ID);
    await replacementHeaders(
      supertest(restarted).delete(`/session/${SESSION_ID}`),
    );
  });

  it('keeps a re-adopted lease when an earlier handback resolves late', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'executing',
    });
    let answerFirstRelease!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      answerFirstRelease = resolve;
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementationOnce(() => firstRelease)
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    // A continue naming a stale recovery identity is refused and hands the
    // adopted lease back — that handback is still in flight…
    const mismatched = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: 'checkpoint-stale',
        activationId: 'activation-stale',
      });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('hosted_recovery_identity_mismatch');
    expect(release).toHaveBeenCalledTimes(1);
    // …when the redriven load re-answers the recovery and re-adopts the same
    // Runtime identity. The late success from the stale handback must not
    // clear the fresh adoption's record…
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    answerFirstRelease();
    // Flush the resolved continuation before the close reads the flags.
    await new Promise((resolve) => setImmediate(resolve));
    // …or the Session's close would skip the handback the Broker still
    // needs, leaking the Workspace lease the fresh adoption holds.
    const closed = await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('keeps a re-adopted lease when an earlier handback rejects late', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    let rejectFirstRelease!: (cause: unknown) => void;
    const firstRelease = new Promise<void>((_resolve, reject) => {
      rejectFirstRelease = reject;
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementationOnce(() => firstRelease)
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // A continue naming a stale recovery identity is refused and hands the
    // adopted lease back — that handback is still in flight…
    const mismatched = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: 'checkpoint-stale',
        activationId: 'activation-stale',
      });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('hosted_recovery_identity_mismatch');
    expect(release).toHaveBeenCalledTimes(1);
    // …when the redriven load re-answers the recovery and re-adopts the same
    // Runtime identity, bumping the lease epoch…
    const redriven = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    // …and only then does the stale handback reject. Its failure must NOT
    // arm the owed flag against the fresh adoption, or the next settled
    // prompt would hand back a lease the fresh adoption still holds.
    rejectFirstRelease(
      new HostedWorkspaceBrokerRejection(
        503,
        'runtime_reconciliation_required',
      ),
    );
    // Flush the rejected continuation before the cancel reads the flags.
    await new Promise((resolve) => setImmediate(resolve));
    // The cancellation settles the Turn durably, but its marker retirement
    // fails once: the post-settle failure path answers 503 and hands
    // nothing back, so the fresh adoption's lease is still held when the
    // next prompt runs.
    let failHistoryCommit = true;
    const originalCommit =
      LocalManagedSessionAuthority.prototype.commitDomainRecord;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockImplementation(async function (
      this: LocalManagedSessionAuthority,
      record,
      ...rest
    ) {
      if (failHistoryCommit && record.operation === 'commitFileHistory') {
        failHistoryCommit = false;
        throw new Error('history write rejected');
      }
      return originalCommit.call(this, record, ...rest);
    });
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(503);
    expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // The settled prompt is a terminal route: it must NOT have handed the
    // fresh adoption's lease back — the stale failure armed nothing.
    expect(release).toHaveBeenCalledTimes(1);
    // The close owns the fresh adoption's one handback…
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('settles the cancellation and owes the lease when its release is refused', async () => {
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const releaseOwners: string[] = [];
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockImplementation(async function (this: HostedWorkspaceBroker) {
        releaseOwners.push(this.runtimeSessionId);
        if (release.mock.calls.length < 4)
          throw new HostedWorkspaceBrokerRejection(
            503,
            'runtime_reconciliation_required',
          );
        throw new HostedWorkspaceBrokerRejection(
          404,
          'runtime_session_not_found',
        );
      });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const cancelled = await send();
    // The executions were confirmed stopped, so the route settles the Turn
    // and owes the refused release instead of answering 503 for a lease the
    // Broker already fenced — and the settled-route finally leaves the owed
    // record for the later retry sites instead of racing it back-to-back.
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.accepted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('failed after the cancellation settled'),
    );
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    // A settled prompt Turn is a retry pacing for the owed handback…
    const nextPrompt = [{ type: 'text', text: 'after the owed cancel' }];
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: '55555555-5555-4555-8555-555555555555',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    // …and a cancel replay is one more terminal route retrying it — the
    // flag clears only on a confirmed handback, so the refusal above keeps
    // it owed throughout.
    const replayed = await send();
    expect(replayed.status).toBe(200);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(3), {
      timeout: 10_000,
    });
    // The Broker then definitively forgot the session: its 404 satisfies
    // the handback instead of being retried with log noise forever.
    const nextPrompt2 = [{ type: 'text', text: 'after the broker forgot' }];
    const admitted2 = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt2,
        promptId: '44444444-4444-4444-8444-444444444444',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt2)).digest('hex')}`,
      });
    expect(admitted2.status).toBe(202);
    await vi.waitFor(
      async () => {
        const transcript2 = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript2.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: '44444444-4444-4444-8444-444444444444',
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    expect(release).toHaveBeenCalledTimes(4);
    expect(new Set(releaseOwners).size).toBe(1);
    // The 404-satisfied handback already discharged the lease, so the close
    // is one more terminal route that must NOT release again.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(4);
  });

  it('keeps the owed lease when a fresh prompt exits recovery-blocked', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockRejectedValueOnce(
        new HostedWorkspaceBrokerRejection(
          503,
          'runtime_reconciliation_required',
        ),
      )
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(cancelled.status).toBe(200);
    // The cancelled Turn settled, but the handback was refused: the lease
    // is owed to the next terminal route.
    expect(release).toHaveBeenCalledTimes(1);
    // The fresh prompt's Turn exits recovery-blocked: the parked Turn owns
    // the owed lease now, so the settle-tail retry must NOT fire — a
    // release would persist RELEASED and wedge the later takeover's
    // same-identity re-acquire on runtime_session_not_acquirable.
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
    const nextPrompt = [{ type: 'text', text: 'blocked exit' }];
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: '55555555-5555-4555-8555-555555555555',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    expect(release).toHaveBeenCalledTimes(1);
    // The owed lease survives to close(), whose handback is the
    // discharger of last resort — proof the blocked exit never fired it.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('continues a turn parked in a second tool round without corrupting history', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    const EXEC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const EXEC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare')
      .mockResolvedValueOnce(EXEC_A)
      .mockResolvedValue(EXEC_B);
    const execute = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'execute')
      .mockImplementation((id, _payload, signal) => {
        if (id === EXEC_A) {
          return Promise.resolve({
            executionStatus: 'success',
            responseParts: [{ text: 'a written' }],
          }) as never;
        }
        return signal?.aborted
          ? Promise.reject(new Error('aborted'))
          : new Promise((_, reject) =>
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              ),
            );
      });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
    });
    expect(created.status).toBe(200);
    const CALL_A = {
      name: 'write_file',
      callId: 'call-a',
      args: { file_path: 'a.txt', content: 'a' },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    const CALL_B = {
      ...CALL_A,
      callId: 'call-b',
      args: { file_path: 'b.txt', content: 'b' },
    };
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      await toolTurn!.execute(
        [CALL_A],
        [
          {
            functionCall: {
              id: CALL_A.callId,
              name: CALL_A.name,
              args: CALL_A.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      await toolTurn!.execute(
        [CALL_B],
        [
          {
            functionCall: {
              id: CALL_B.callId,
              name: CALL_B.name,
              args: CALL_B.args,
            },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'unreached', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'write two files' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      () =>
        expect(execute.mock.calls.some((call) => call[0] === EXEC_B)).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'b written' }],
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server: replacement, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      checkpointId: string;
      activationId: string;
      executions: Array<{ executionCallId: string; outcome: string }>;
    };
    expect(recovery.executions).toHaveLength(2);
    expect(
      recovery.executions.every((execution) => execution.outcome === 'known'),
    ).toBe(true);
    const clientId = loaded.body.clientId as string;
    const continued = await replacementHeaders(
      supertest(replacement).post(
        `/session/${SESSION_ID}/managed-runtime/continue`,
      ),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    const continuedCall = state.model.mock.calls.find(
      (call) =>
        (call[0] as { resumeFromToolResults?: unknown })
          .resumeFromToolResults !== undefined,
    );
    expect(continuedCall).toBeDefined();
    const input = continuedCall![0] as unknown as {
      history: Array<{ type: string }>;
      resumeFromToolResults: unknown[];
    };
    // Round one's tool result stays in history; only the parked round's
    // result becomes the resume request. Assert on the tool_result records —
    // the assistant record carries call-a's functionCall either way.
    const historyResults = input.history.filter(
      (entry) => entry.type === 'tool_result',
    );
    expect(JSON.stringify(historyResults)).toContain('call-a');
    expect(JSON.stringify(historyResults)).not.toContain('call-b');
    expect(JSON.stringify(input.resumeFromToolResults)).toContain('call-b');
    expect(JSON.stringify(input.resumeFromToolResults)).not.toContain('call-a');
    await replacementHeaders(
      supertest(replacement).delete(`/session/${SESSION_ID}`),
    );
  });

  it('refuses the load with a retryable refusal when the takeover drive fails', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockRejectedValue(
      new Error('broker unreachable'),
    );
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    // The takeover acquired the Runtime Session before the drive failed; the
    // refusal must hand the lease back or the Workspace stays pinned.
    expect(release).toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('refuses continue with a mismatched recovery identity', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const send = (body: Record<string, unknown>) =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send(body);
    expect((await send({ promptId: PROMPT_ID })).status).toBe(400);
    expect(
      (
        await send({
          promptId: PROMPT_ID,
          checkpointId: 'ckpt-other',
          activationId: 'activation-other',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await replacementHeaders(
          supertest(server).post(
            `/session/44444444-4444-4444-8444-444444444444/managed-runtime/continue`,
          ),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({
            promptId: PROMPT_ID,
            checkpointId: 'ckpt',
            activationId: 'activation',
          })
      ).status,
    ).toBe(404);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('replays a lost continue admission at its original watermark', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const send = () =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const admitted = await send();
    expect(admitted.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // The turn settled by now; the coordinator's replay must still answer
    // with the admission watermark, not the current sequence.
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(admitted.body.lastEventId);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('releases the recovered Runtime lease when the Session detaches', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    expect(release).not.toHaveBeenCalled();
    const clientId = loaded.body.clientId as string;
    const detached = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(detached.status).toBe(204);
    expect(release).toHaveBeenCalled();
  });

  it.each(['inline', 'chunked'])(
    'completes an answer (%s) and clears file history after a recovered Write continuation',
    async (storage) => {
      await parkToolTurn();
      const text =
        storage === 'chunked' ? '续接😀'.repeat(31_000) : 'hello back';
      if (storage === 'chunked') {
        await enforceInlineResourceLimit();
        state.model.mockImplementationOnce(async ({ textDeltas }) => {
          expect(textDeltas).toBeDefined();
          await textDeltas!.delta(text);
          return { text, model: 'test-model' };
        });
      }

      // The parked Write left its file-history obligation durable.
      vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'written' }],
      } as never);
      const { server, loaded } = await loadReplacement();
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      const historyBefore = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(historyBefore.body.history.pendingTurn).toBe(PROMPT_ID);
      const continued = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      expect(continued.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 10_000 },
      );
      const historyAfter = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/files/history`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(historyAfter.body.history.pendingTurn).toBeNull();
      const transcript = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/transcript?limit=256`),
      ).set('X-Qwen-Client-Id', clientId);
      if (storage === 'chunked')
        expectFullStreamedAnswer(transcript.body, text);
      // The obligation is gone: a cold load and a file tool run normally.
      await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      const reloaded = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
      });
      expect(reloaded.status).toBe(200);
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    },
  );

  it('refuses the replay of a continuation that became recovery blocked', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The continuation hits an unrecoverable write: the Session latches
    // blocked without a terminal record.
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
    const send = () =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const admitted = await send();
    expect(admitted.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // "accepted" is the only signal the coordinator ever got, but the Turn
    // will never settle — the replay must surface the refusal instead.
    const replayed = await send();
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_turn_recovery_required');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('leaves the continuation re-drivable when the resume meets a retryable acquisition refusal', async () => {
    // A parked read-only turn carries no file-history pendingTurn marker,
    // so the continuation's resumeCommittedResults() reaches its
    // fall-through re-acquire — the only path on which a retryable Broker
    // refusal escapes raw.
    await parkToolTurn([
      {
        name: 'read_file',
        callId: 'call-1',
        args: { file_path: 'a.txt' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      },
    ] as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'contents' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The continuation's re-acquire meets a retryable busy refusal: the
    // checkpoint's Runtime receipts are still unconsumed, so the Turn must
    // stay re-drivable (recovery-blocked) rather than settle terminally.
    acquireSpy.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
    );
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockClear();
    const send = () =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const continued = await send();
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // No terminal record landed: the Turn is still there to drive.
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(
      (
        transcript.body.events as Array<{ type: string; promptId?: string }>
      ).filter(
        (event) =>
          (event.type === 'turn_complete' || event.type === 'turn_error') &&
          event.promptId === PROMPT_ID,
      ),
    ).toHaveLength(0);
    // A replay meets the refusal rather than re-answering a certified
    // admission that will never settle.
    const replayed = await send();
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_turn_recovery_required');
    // Neither the recovery-blocked drive nor the replay's refusal hands the
    // adopted lease back: a release persists RELEASED, and the same-identity
    // re-acquire the takeover below depends on would conflict with
    // runtime_session_not_acquirable forever.
    expect(release).not.toHaveBeenCalled();
    // …and a fresh incarnation can take the same Turn over: the recovery
    // report is still offered, so the drive can be retried there.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    const { server: restarted, loaded: reloaded } = await loadReplacement();
    expect(reloaded.status).toBe(200);
    expect(
      reloaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    ).toBeDefined();
    await replacementHeaders(
      supertest(restarted).delete(`/session/${SESSION_ID}`),
    );
  });

  it('retires the pending marker when the compensating settle runs after a drive failure', async () => {
    // The parked write_file Turn carries a durable file-history marker; the
    // continuation never reaches its resume, so the compensating settle
    // owns the retirement.
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The drive's first projection read fails before any resume runs, so
    // the marker is still pending when the compensating settle lands.
    vi.spyOn(
      ManagedSessionRecordSink.prototype,
      'project',
    ).mockRejectedValueOnce(new Error('projection lost'));
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 10_000 },
    );
    // The durable record, not a spy: the marker the parked Turn left is
    // retired before the Session goes quiet.
    const history = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(history.body.history.pendingTurn).toBeNull();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('owes the compensating retirement when its write fails, and a settled prompt retires it', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(
      ManagedSessionRecordSink.prototype,
      'project',
    ).mockRejectedValueOnce(new Error('projection lost'));
    // The compensating settle's retirement write fails once: the marker
    // stays durable-owed rather than silently dropped.
    let failHistoryCommit = true;
    const originalCommit =
      LocalManagedSessionAuthority.prototype.commitDomainRecord;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockImplementation(async function (
      this: LocalManagedSessionAuthority,
      record,
      ...rest
    ) {
      if (failHistoryCommit && record.operation === 'commitFileHistory') {
        failHistoryCommit = false;
        throw new Error('history write rejected');
      }
      return originalCommit.call(this, record, ...rest);
    });
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 10_000 },
    );
    // The failed drop left the settled Turn's marker pending…
    const owed = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(owed.body.history.pendingTurn).toBe(PROMPT_ID);
    // …and the next settled prompt's admission drive retires it.
    const freshPrompt = [{ type: 'text', text: 'next turn' }];
    const prompted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: freshPrompt,
        promptId: '88888888-8888-4888-8888-888888888888',
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(freshPrompt)).digest('hex')}`,
      });
    expect(prompted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    const retired = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(retired.body.history.pendingTurn).toBeNull();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('replays a lost continue admission while the turn still runs', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // Hold the continued Turn open so the replay meets a running one — the
    // ordinary case, since a continuation drives the model for minutes.
    let releaseModel!: () => void;
    const modelGate = new Promise<{ text: string; model: string }>(
      (resolve) => {
        releaseModel = () => resolve({ text: 'done', model: 'test-model' });
      },
    );
    state.model.mockImplementationOnce(() => modelGate);
    const send = () =>
      replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
    const admitted = await send();
    expect(admitted.status).toBe(200);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    const replayed = await send();
    expect(replayed.status).toBe(200);
    expect(replayed.body.lastEventId).toBe(admitted.body.lastEventId);
    expect(state.model).toHaveBeenCalledTimes(1);
    // Let the held-open continuation finish before teardown removes its root.
    releaseModel();
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('settles a raw reconciliation failure as a terminal error and keeps the Session usable', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The continuation's reconciliation escapes resumeCommittedResults()
    // raw. The 200 is already sent and no blocked-on-recovery re-drive
    // exists on this route, so the failure must settle the Turn terminally
    // instead of blocking it forever: only an already-wrapped recovery
    // error still lands in the recovery-blocked handler.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockRejectedValueOnce(
      new Error('warm gone'),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(false);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // …and the durable pending-Turn obligation retired with it: a cold load
    // after detach is admitted instead of refused forever, or one warm-up
    // failure would brick the Session's file history.
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloaded.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('retires the pending marker after the compensating terminal write too', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The first terminal turn_result write fails once, so the marker
    // retirement must ride the outer catch's compensating path — or the
    // direct-settle retirement never runs and the cold load is refused.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let failedOnce = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, recordToWrite) {
        if (!failedOnce && recordToWrite.subtype === 'turn_result') {
          failedOnce = true;
          throw new Error('settle-store hiccup');
        }
        return originalWrite.call(this, recordToWrite);
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockRejectedValueOnce(
      new Error('warm gone'),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloaded.status).toBe(200);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('retires the pending marker through close when the retirement write fails once', async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockRejectedValueOnce(new Error('history write rejected'));
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockRejectedValueOnce(
      new Error('warm gone'),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    // The retirement failed at the settle point: it stays owed instead of
    // dragging the settled Turn down with it — and nothing blocks.
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    const settledStatus = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(settledStatus.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    // …and close retires it, so the cold load is still admitted.
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloaded.status).toBe(200);
    const reloadedStatus = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', reloaded.body.clientId as string);
    expect(reloadedStatus.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it("retires a settled Turn's pending marker on a fresh-incarnation load", async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn();
    let stopConfirmed = false;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      async () => ({ state: stopConfirmed ? 'settled' : 'prepared' }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockImplementation(
      async () => {
        stopConfirmed = true;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The marker retirement's durable write stays refused through the
    // cancel *and* the close, so the Session's in-memory owed flag dies
    // with it while the durable marker survives into the next incarnation.
    const commitSpy = vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'commitDomainRecord')
      .mockRejectedValue(new Error('history write rejected'));
    const cancelled = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    // The retirement failure after the settle answers a retry-inviting 503,
    // but the compensating path still lands the terminal record.
    expect(cancelled.status).toBe(503);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
              data: expect.objectContaining({ stopReason: 'cancelled' }),
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    // The marker is still durable before the close…
    const before = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(before.body.history.pendingTurn).toBe(PROMPT_ID);
    // …and close()'s owed retirement fails against the same refused write,
    // so the marker strands across the incarnation boundary.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    await vi.waitFor(
      () => expect(dropSpy.mock.calls.length).toBeGreaterThan(1),
      {
        timeout: 10_000,
      },
    );
    commitSpy.mockRestore();
    // A fresh incarnation's load retires the settled Turn's marker instead
    // of refusing on it forever.
    const restarted = replacementApp();
    const reloadedFresh = await replacementHeaders(
      supertest(restarted).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(reloadedFresh.status).toBe(200);
    const history = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/files/history`),
    ).set('X-Qwen-Client-Id', reloadedFresh.body.clientId as string);
    expect(history.body.history.pendingTurn).toBeNull();
    const freshStatus = await replacementHeaders(
      supertest(restarted).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', reloadedFresh.body.clientId as string);
    expect(freshStatus.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(restarted).delete(`/session/${SESSION_ID}`),
    );
  });

  it('retires an owed file-history marker at admission, before the next write', async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'commitDomainRecord',
    ).mockRejectedValueOnce(new Error('history write rejected'));
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockRejectedValueOnce(
      new Error('warm gone'),
    );
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    // The continuation settled as an error and owes the pending marker's
    // retirement (its retirement write was refused above).
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_error',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    // The drop was invoked, but the drive's busy flag clears only in its
    // finally — wait for that too, or the next /prompt can meet a 409.
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 10_000 },
    );
    // The new Turn's write needs an execution identity of its own — the
    // parked Turn's prepare mock still answers its own id.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '99999999-9999-4999-8999-999999999999',
    );
    // A fresh prompt whose model writes a file: the owed marker must retire
    // at admission — inside the busy flag — or this Turn's first write meets
    // the durable pending marker and blocks with no terminal record.
    const nextPromptId = '55555555-5555-4555-8555-555555555555';
    const nextCall = {
      name: 'write_file',
      callId: 'call-next',
      args: { file_path: 'next.txt', content: 'y' },
      isClientInitiated: false,
      prompt_id: nextPromptId,
    };
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [nextCall],
          [
            {
              functionCall: {
                id: nextCall.callId,
                name: nextCall.name,
                args: nextCall.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    const nextPrompt = [{ type: 'text', text: 'write next.txt' }];
    const admitted = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: nextPrompt,
        promptId: nextPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: nextPromptId,
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    const after = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', clientId);
    expect(after.body.recoveryBlocked).toBe(false);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('skips the file-history retirement read on a completed continuation', async () => {
    const dropSpy = vi.spyOn(hostedHistory, 'dropPendingHostedFileHistoryTurn');
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const transcript = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(transcript.body.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'turn_complete',
              promptId: PROMPT_ID,
            }),
          ]),
        );
      },
      { timeout: 10_000 },
    );
    // A completed continuation already reconciled inside resumeCommittedResults:
    // the settle tail must not pay another fallible durable round trip that
    // could turn a completed answer into an error.
    expect(dropSpy).not.toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('logs the root cause when the recovered continuation fails pre-wrapped', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const { server, loaded } = await loadReplacement();
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    // The reconcile sees a file-history snapshot that drifted from the
    // durable one, so resumeCommittedResults throws an already-wrapped
    // recovery error; the route must rethrow it as-is, or the blocked log
    // line names the wrapper instead of the cause an operator needs.
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'fileHistory',
    ).mockResolvedValueOnce({
      ownerSessionId: SESSION_ID,
      snapshots: [{ filePath: 'drifted' } as never],
      files: {},
    });
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(continued.status).toBe(200);
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Original file history snapshots changed.'),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });
});
