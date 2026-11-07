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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { oweHostedTurnCleanup } from './hosted-turn-cleanup.js';
import { LlmRequestPreparationError } from '@qwen-code/qwen-code-core/core/llm-chat.js';
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
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  assertManagedSessionDurableRef,
  ManagedSessionAppendUnsettledError,
  ManagedSessionJournalFencedError,
  ManagedSessionRecordError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import {
  HostedHookRecoveryRequiredError,
  HostedHookSession,
} from './hosted-hook-session.js';
import { HostedMcpRecoveryRequiredError } from './hosted-mcp-session.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import type { ShellPublisherDescriptor } from './managed-shell-publisher.js';
import {
  HostedToolRecoveryRequiredError,
  hostedRuntimeSessionId,
  HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
import {
  HostedApprovalWaiters,
  endHostedAction,
} from './hosted-tool-approval.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import * as stdio from '../utils/stdioHelpers.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import { createSettleTimeout } from '../test-utils/settle-timeout.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import type {
  ManagedHookCatalog,
  ManagedHookControl,
  ManagedHookOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedMonitorLoop } from './hosted-monitor-loop.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import { LocalShellStreamCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-stream-capture.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedSessionMessageSession } from './hosted-session-message-session.js';
import { HostedSessionCommandSession } from './hosted-session-command-session.js';
import type { HistoryMaintenance } from '@qwen-code/qwen-code-core/managed-runtime/managed-history-maintenance-record.js';
import { HostedTeamSession } from './hosted-team-session.js';
import { teamMemberPreamble } from './hosted-member-chain.js';
import { hostedWakeContinuationId } from './hosted-wake-continuation.js';

const wakeDeps = vi.hoisted(() => ({
  last: undefined as unknown,
  runTurnGate: undefined as Promise<void> | undefined,
}));

const domainEnablement = vi.hoisted(() => ({
  childRun: true,
  monitorRun: true,
  teams: false,
  teamPlan: false,
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
      // #13856: monitor_run is enabled in production, so the real gate
      // decides it; the hook stays for a case that needs it shut.
      assertManagedSessionDomainEnabled: (
        domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
      ) => {
        if (domain === 'monitor_run' && !domainEnablement.monitorRun) {
          throw new actual.ManagedSessionRecordError(
            'domain monitor_run is registered but not enabled for submission.',
          );
        }
        if (domain === 'team_plan' && domainEnablement.teamPlan) return;
        actual.assertManagedSessionDomainEnabled(domain);
      },
      // H4b: record commits gate per kind, beside the admission mock. The
      // shell kind is enabled in production (#13856), so every kind the
      // production list carries goes through the real gate; a case that
      // needs the shell kind shut closes it per test. A kind production
      // has not enabled stays a fixture, admitted so the case runs what it
      // is about rather than the kind gate.
      assertManagedSessionChildRunKindEnabled: (kind: string) => {
        if (kind === 'shell' && !domainEnablement.childRun) {
          throw new actual.ManagedSessionRecordError(
            'domain child_run kind shell is registered but not enabled for submission.',
          );
        }
        if (
          !(
            actual.MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS as readonly string[]
          ).includes(kind)
        )
          return;
        actual.assertManagedSessionChildRunKindEnabled(kind);
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
      const runTurn = actual.createMonitorWakeRunTurn(params as never);
      const gate = wakeDeps.runTurnGate;
      return gate
        ? async (...args: Parameters<typeof runTurn>) => {
            await gate;
            return runTurn(...args);
          }
        : runTurn;
    },
  };
});

const neverStartedReconcile = vi.hoisted(() => ({
  fn: vi.fn((input: unknown) => input),
  gate: undefined as Promise<void> | undefined,
}));
vi.mock('./hosted-never-started-reconcile.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('./hosted-never-started-reconcile.js')
    >();
  return {
    ...actual,
    reconcileNeverStartedChildRuns: async (
      input: Parameters<typeof actual.reconcileNeverStartedChildRuns>[0],
    ) => {
      neverStartedReconcile.fn(input);
      const gate = neverStartedReconcile.gate;
      neverStartedReconcile.gate = undefined;
      if (gate !== undefined) await gate;
      return actual.reconcileNeverStartedChildRuns(input);
    },
  };
});

const state = vi.hoisted(() => ({
  root: '',
  assertWritable: vi.fn(async () => undefined),
  toolResults: null as DurableToolResultResourceStore | null,
  publicationRequest: vi.fn(),
  storeOptions: [] as Array<Record<string, unknown>>,
  ownershipReleases: [] as Array<Record<string, unknown>>,
  setLifecycleAuthority: vi.fn(),
  modelConfig: vi.fn(),
  authorizeLifecycle: vi.fn(async () => undefined),
  authorizeOrdinary: vi.fn(async (_kind?: 'legacy-close') => undefined),
  approvalSelections: new Map<
    string,
    { mode: 'default' | 'auto-edit' | 'yolo'; revision: number }
  >(),
  approvalQueries: [] as string[],
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
      modelSelection?: { modelId: string; revision: number };
      modelConfig?: import('./hosted-model-config.js').HostedModelConfigReader;
    }) => ({
      text: 'hello back',
      model: 'test-model',
    }),
  ),
  workflow: vi.fn(
    async (_input: {
      signal: AbortSignal;
      sessionId: string;
      launch: unknown;
    }) => ({
      text: 'Hello from workflow',
      parts: [{ text: 'Hello from workflow' }] as Array<{ text: string }>,
      model: 'workflow',
    }),
  ),
}));

// HTTP-store fixtures retain their original container; native local snapshot
// preparation is verified by the Core snapshot and process-recovery suites.
vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/local-managed-session-writer.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/managed-runtime/local-managed-session-writer.js')
    >()),
    acquireLocalManagedSessionWriter: (
      options: Parameters<typeof SessionWriterLease.acquire>[0],
    ) =>
      SessionWriterLease.acquire({
        ...options,
        takeoverPolicy: 'certified',
        lockSchema: { schemaVersion: 3, formatVersion: 1 },
      }),
  }),
);

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
        // A generic factory refusal. The descriptor under test carries
        // allowInsecureHttp, so borrowing the real store's plaintext-gate
        // message would pin a refusal production cannot produce here.
        throw new ManagedSessionRecordError(
          'store factory refused the descriptor.',
        );
      }
      const resourceStore = LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: options.sessionKey,
      });
      resourceStore.publish = async (...args) => {
        const published =
          await LocalManagedSessionResourceStore.prototype.publish.apply(
            resourceStore,
            args,
          );
        const [kind, bytes] = args;
        if (kind === 'managed-definition' || kind === 'managed-admission') {
          const value = JSON.parse(bytes.toString()) as Record<string, unknown>;
          const selection =
            kind === 'managed-definition'
              ? { mode: value['approvalMode'] ?? 'yolo', revision: 0 }
              : (value['approvalSelection'] as
                  | { mode: 'default' | 'auto-edit' | 'yolo'; revision: number }
                  | undefined);
          if (selection)
            state.approvalSelections.set(
              options.sessionKey.sessionId,
              selection as {
                mode: 'default' | 'auto-edit' | 'yolo';
                revision: number;
              },
            );
        }
        return published;
      };
      const journalStore = new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: options.sessionKey.sessionId,
        transcriptPath: path.join(
          state.root,
          `${options.sessionKey.sessionId}.jsonl`,
        ),
      });
      let journal: Awaited<ReturnType<typeof journalStore.open>> | undefined;
      const openJournal = journalStore.open.bind(journalStore);
      journalStore.open = async (request) =>
        (journal = await openJournal(request));
      return {
        journalStore,
        resourceStore,
        toolResultResources: state.toolResults ?? resourceStore,
        assertWritable: state.assertWritable,
        claimUserMessages: async () => [],
        setLifecycleAuthority: state.setLifecycleAuthority,
        modelConfig: state.modelConfig,
        authorizeOrdinary: state.authorizeOrdinary,
        authorizeLifecycle: state.authorizeLifecycle,
        approvalSelection: async () => {
          state.approvalQueries.push(options.sessionKey.sessionId);
          return state.approvalSelections.get(options.sessionKey.sessionId);
        },
        publication: {
          owner: async () => ({ writerId: BOOT_ID, writerGeneration: 1 }),
          request: (route: string, body: unknown, token?: string) =>
            state.publicationRequest(resourceStore, route, body, token),
          rememberAdmission: () => undefined,
        },
        close: async () => undefined,
        stopLocal: async () => undefined,
        quiesceOwnership: async () => undefined,
        releaseOwnership: async (
          request: Record<string, unknown> & {
            commitProof: {
              lastCommitSequence: number;
              committedPrefixHash: string;
            };
          },
        ) => {
          state.ownershipReleases.push(request);
          await journal!.seal(request.commitProof);
          return {
            format: 'qwen-hosted-harness-release/1',
            state: 'RELEASED',
            ...options.sessionKey,
            ...request,
            writerGeneration: 1,
            journalRevision: 1,
            committedSequence: request.commitProof.lastCommitSequence,
          };
        },
      };
    },
  }),
);
vi.mock('./hosted-harness-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hosted-harness-model.js')>()),
  runHostedHarnessTextTurn: state.model,
}));

vi.mock('./hosted-workflow-turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hosted-workflow-turn.js')>()),
  runHostedWorkflowTurn: state.workflow,
}));

const BOOT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROMPT_ID = '33333333-3333-4333-8333-333333333333';

// Keep slow-host slack, but make all settle waits share the current test's
// remaining time, including waits hidden inside helper functions.
const MAX_SETTLE_TIMEOUT_MS = isSlowTestHost() ? 45_000 : 10_000;
let settleTimeoutMs: () => number;

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

beforeEach(({ task }) => {
  settleTimeoutMs = createSettleTimeout(task.timeout, MAX_SETTLE_TIMEOUT_MS);
  wakeDeps.runTurnGate = undefined;
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'resolveCapabilities',
  ).mockResolvedValue();
  state.approvalSelections.clear();
  state.approvalQueries.length = 0;
  state.modelConfig.mockReset();
  vi.spyOn(
    HostedWorkspaceBroker.prototype,
    'capabilityDigest',
    'get',
  ).mockReturnValue(WORKSPACE_CAPABILITY_DIGEST);
});

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

async function app(
  withBroker = false,
  instanceId?: string,
  extensionPackages = true,
) {
  const result = express();
  result.use(express.json());
  const advertised = createHostedHarnessContract(
    `sha256:${'a'.repeat(64)}`,
    BOOT_ID,

    ['hosted-workspace-shell/1', 'hosted-workspace-mcp/1'],
    instanceId,
  );
  const contract = extensionPackages
    ? advertised
    : {
        ...advertised,
        features: advertised.features?.filter(
          (feature) => feature !== 'session-extension-packages/1',
        ),
      };
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
    baseUrl: 'https://store.test',
    tenantId: 'tenant',
    workspaceId: 'workspace',
    writerId: BOOT_ID,
    leaseDurationMs: 60_000,
  };
}

async function mcpApp(
  unknownConfigure = false,
  serverIds = ['demo'],
  toolProfile = 'hosted-workspace-mcp/1',
) {
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
    toolProfile,
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
async function hookApp(
  toolProfile = 'hosted-workspace-files/1',
  asyncEnd = false,
) {
  const requests: ManagedHookControl[] = [];
  const catalog: ManagedHookCatalog = {
    ...hookPin,
    hooks: [
      ...(toolProfile === 'hosted-workspace-shell/1'
        ? [HookEventName.SessionStart]
        : []),
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
    toolProfile,
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
    state.ownershipReleases.length = 0;
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
    // Quiesce the wake pump before the Broker mocks come down: DELETE closes
    // the wake scheduler, so a settle retry cannot outlive its test and log
    // into whichever test runs next. A Session already gone answers 404. The
    // wait itself is bounded: a Session fenced behind a never-answering
    // Runtime poll holds the close until the reconcile budget, and such a
    // Session is a plain Hook Session with no pump to quiesce.
    await Promise.all(
      [...listeners].map((listener) =>
        Promise.race([
          headers(supertest(listener).delete(`/session/${SESSION_ID}`)),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]),
      ),
    );
    vi.restoreAllMocks();
    await rm(state.root, {
      recursive: true,
      force: true,
      // A wake pump's final writes can still be in flight at teardown.
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  // #14538: a wake pump pass holds no turn slot while it reads, projects
  // and classifies a crashed input, so the reconcile route's repair waits
  // the pass out instead of consuming the input under it. The holds below
  // find the pass by its stack, never by a line number.
  function wakePassStack(): string {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 80;
    const stack = new Error('wake pass').stack ?? '';
    Error.stackTraceLimit = limit;
    return stack;
  }

  function holdWakePass(
    at: 'input read' | 'transcript projection',
    when: () => boolean = () => true,
  ): { held: () => boolean; open: () => void } {
    let held = false;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    if (at === 'input read') {
      const read = LocalManagedSessionResourceStore.prototype.read;
      vi.spyOn(
        LocalManagedSessionResourceStore.prototype,
        'read',
      ).mockImplementation(async function (
        this: LocalManagedSessionResourceStore,
        ref,
      ) {
        if (
          !held &&
          ref.kind === 'managed-input' &&
          when() &&
          wakePassStack().includes('HostedMonitorWakeScheduler.pump')
        ) {
          held = true;
          await opened;
        }
        return read.call(this, ref);
      });
    } else {
      const project = ManagedSessionRecordSink.prototype.project;
      vi.spyOn(
        ManagedSessionRecordSink.prototype,
        'project',
      ).mockImplementation(async function (
        this: ManagedSessionRecordSink,
        through?: number,
      ) {
        if (
          !held &&
          when() &&
          wakePassStack().includes('hosted-monitor-wake-turn.ts')
        ) {
          held = true;
          await opened;
        }
        return project.call(this, through);
      });
    }
    return { held: () => held, open };
  }

  // Resolves 'waiting' unless `answer` lands first: the route cannot
  // answer while the pass it waits for is held, so this only ever gives a
  // route that skips the wait the time to show it.
  const stillWaiting = (answer: Promise<unknown>) =>
    Promise.race([
      answer.then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
    ]);

  // The journal shape a child run's acceptance leaves behind when its
  // notification input is still owed: accepted, never settled, and the
  // Session holds no prompt of its own.
  async function prewriteChildNotificationSession(): Promise<string> {
    return prewriteChildNotificationOfSource('child_agent');
  }

  // The same planted acceptance notification with a workflow source:
  // its kind never changes the journal shape, only the `source` the wake
  // and close paths predicate on (#13803 K2).
  async function prewriteWorkflowNotificationSession(): Promise<string> {
    return prewriteChildNotificationOfSource('workflow');
  }

  async function prewriteChildNotificationOfSource(
    source: 'child_agent' | 'workflow',
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
          source,
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
    return prewriteAcceptedChildOfKind('child_agent');
  }

  async function prewriteAcceptedChildOfKind(
    kind: 'child_agent' | 'workflow',
    interrupted = false,
  ): Promise<string> {
    state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 0 });
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
      if (kind === 'child_agent') {
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
          workspaceMode: 'shared',
          workingDirectory: '.',
          executionCallId: 'run-1',
        });
      } else {
        const script = 'return { answer: 1 };';
        await children.admitWorkflow({
          childRunId: 'run-1',
          ownerScopeId: SESSION_ID,
          rootSessionId: SESSION_ID,
          completion: 'sent',
          script,
          args: undefined,
          definition: {
            definitionId: 'workflow/unnamed',
            definitionRevision: 1,
            definitionDigest: createHash('sha256')
              .update(script, 'utf8')
              .digest('hex'),
          },
          workingDirectory: '.',
          executionCallId: 'run-1',
        });
      }
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
      if (interrupted) {
        await managed.sink.write({
          uuid: randomUUID(),
          parentUuid: null,
          sessionId: SESSION_ID,
          timestamp: new Date().toISOString(),
          type: 'user',
          cwd: state.root,
          version: 'hosted-harness/1',
          daemonPromptId: 'run-1:accept:notify',
          message: {
            role: 'user',
            parts: [{ text: 'original child notification' }],
          },
        });
      }
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

  it.each(['child_agent', 'workflow'] as const)(
    'continues an interrupted %s wake with no recovered call answer',
    async (kind) => {
      domainEnablement.childRun = true;
      const notificationTurnId = await prewriteAcceptedChildOfKind(kind, true);
      const continuation = hostedWakeContinuationId(notificationTurnId);
      mockBrokerBroker();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store() })
        .expect(200);
      await vi.waitFor(
        async () => {
          const session = capturedWakeSession();
          expect(
            session.managed.authority.eventsInSequenceRange(
              1,
              session.managed.authority.committedSequence,
            ),
          ).toContainEqual(
            expect.objectContaining({
              kind: 'turn.settled',
              payload: expect.objectContaining({
                turnId: continuation,
                outcome: 'completed',
              }),
            }),
          );
          expect(
            session.managed.authority
              .extensionRecordsInDomain('child_run')
              .at(-1)?.record,
          ).toMatchObject({ run: { delivery: { state: 'consumed' } } });
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledOnce();
      expect(state.model.mock.calls[0]![0]).toMatchObject({
        promptId: continuation,
        prompt: expect.stringContaining('审阅通过'),
      });
      const session = capturedWakeSession();
      const records = await session.managed.sink.project();
      expect(records.filter((entry) => entry.type === 'user')).toHaveLength(1);
      expect(
        records.filter(
          (entry) =>
            entry.subtype === 'turn_attempt' &&
            entry.daemonPromptId === continuation,
        ),
      ).toHaveLength(1);
      const events = session.managed.authority.eventsInSequenceRange(
        1,
        session.managed.authority.committedSequence,
      );
      const accepted = events.find(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['turnId'] === continuation,
      )!;
      const settled = events.find(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === notificationTurnId,
      )!;
      expect(accepted.sequence).toBeLessThan(settled.sequence);
      await vi.waitFor(
        async () => {
          expect(
            (
              await headers(
                supertest(server).post(`/session/${SESSION_ID}/detach`),
              )
                .set('X-Qwen-Client-Id', loaded.body.clientId as string)
                .send({})
            ).status,
          ).toBe(204);
        },
        { timeout: settleTimeoutMs() },
      );
      await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({ managedSessionStore: store() })
        .expect(200);
      expect(state.model).toHaveBeenCalledOnce();
    },
    60_000,
  );

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
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
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
    // The settled record lands while the pump's busy epoch is still
    // closing out, so the close can answer 409 for one more tick — a
    // refused close is a no-op, and the retry converges (F10's gate).
    await vi.waitFor(
      async () => {
        expect(
          (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
            .status,
        ).toBe(204);
      },
      { timeout: settleTimeoutMs() },
    );
  });

  // #13803 (K2): the wake pump classifies a workflow child's acceptance
  // notification the same way — its source never wedges the load.
  it('loads a Session whose only owed input is a workflow acceptance notification', async () => {
    domainEnablement.childRun = true;
    const notificationTurnId = await prewriteWorkflowNotificationSession();
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
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === notificationTurnId,
          ),
        ).toBe(true);
        // The settle lands while the pump's busy epoch is still closing
        // out; the close answers 409 until the prompt is released.
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
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
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
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
        const settled = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
        expect(
          settled.events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === notificationTurnId,
          ),
        ).toBe(true);
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: 15_000, interval: 100 },
    );
    // The settled record lands while the pump's busy epoch is still
    // closing out, so the close can answer 409 for one more tick — a
    // refused close is a no-op, and the retry converges (F10's gate).
    await vi.waitFor(
      async () => {
        expect(
          (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
            .status,
        ).toBe(204);
      },
      { timeout: settleTimeoutMs() },
    );
  });

  // H4d-b: a parent with one attached child run, built through the real
  // funnels; `build` then commits the message state under test.
  async function prewriteMessageSession(
    build: (sides: {
      children: HostedChildAgentSession;
      messages: HostedSessionMessageSession;
      managed: Awaited<ReturnType<typeof openManagedSession>>;
    }) => Promise<void>,
  ): Promise<void> {
    state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 0 });
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
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
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
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
      const store = {
        authority: managed.authority,
        resources: managed.resources,
      };
      const children = new HostedChildAgentSession(store, key);
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
        workspaceMode: 'shared',
        executionCallId: 'run-1',
      });
      await children.dispatchStarted('run-1', {
        dispatchId: 'dispatch-1',
        runtime: { runtimeBindingId: 'binding-1', generation: '1' },
      });
      await children.attach('run-1', CHILD_SESSION_ID);
      await build({
        children,
        messages: new HostedSessionMessageSession(
          store,
          key,
          children,
          undefined,
        ),
        managed,
      });
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  const CHILD_SESSION_ID = '550e8400-e29b-41d4-a716-446655440001';

  async function journalEvents() {
    return (
      await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      })
    ).events;
  }

  // H4d-b: a Session whose journal carries a child's message must reopen
  // (the restore verifier admits the domain), run the message's wake turn,
  // and commit the receipt's consumption once that turn settles.
  it('reopens a Session holding a child message and consumes it after its wake turn', async () => {
    const content = Buffer.from('which branch should I use?');
    await prewriteMessageSession(async ({ messages }) => {
      await messages.receive({
        messageId: 'msg_up',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD_SESSION_ID,
        content,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      });
    });
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await vi.waitFor(
      async () => {
        const events = await journalEvents();
        expect(
          events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === 'msg_up:message',
          ),
        ).toBe(true);
        expect(
          events.filter(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'session_message',
          ),
        ).toHaveLength(2);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  it('maps the message route refusals and holds a child settlement for its message', async () => {
    await prewriteMessageSession(async ({ children }) => {
      await children.sendToChild({
        taskId: children.taskIdOf('run-1'),
        text: 'also check the tests',
        messageId: 'msg_down',
        continuationRunId: 'prompt:call-1',
        executionCallId: 'prompt:call-1',
        closing: false,
      });
    });
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const clientId = loaded.body.clientId as string;
    const message = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), ...body });
    const child = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/children/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), childRunId: 'run-1', ...body });
    const invalid = await message({ messageId: 'msg_down', kind: 'teleport' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_message_operation');
    const missing = await message({
      messageId: 'msg_none',
      kind: 'handover',
      targetSessionId: CHILD_SESSION_ID,
    });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('session_message_record');
    const pending = await child({
      kind: 'commit_result',
      result: 'done',
      receipt: '{}',
    });
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('child_messages_pending');
    await message({
      messageId: 'msg_down',
      kind: 'handover',
      targetSessionId: CHILD_SESSION_ID,
    }).expect(202);
    const wrongTarget = await message({
      messageId: 'msg_down',
      kind: 'handover',
      targetSessionId: randomUUID(),
    });
    expect(wrongTarget.status).toBe(409);
    expect(wrongTarget.body.code).toBe('session_message_conflict');
    await message({
      messageId: 'msg_down',
      kind: 'accepted',
      inputId: 'msg_down:message',
    }).expect(202);
    // The settlement must name the message it saw.
    const unseen = await child({
      kind: 'commit_result',
      result: 'done',
      receipt: '{}',
    });
    expect(unseen.status).toBe(409);
    expect(unseen.body.code).toBe('child_messages_pending');
    await child({
      kind: 'commit_result',
      result: 'done',
      receipt: '{}',
      messageCount: 1,
    }).expect(202);
    // A target store that faltered is a retry, never the target's verdict.
    const faltered = vi
      .spyOn(HostedSessionMessageSession.prototype, 'receive')
      .mockRejectedValueOnce(
        new ManagedSessionStoreHttpError(503, 'store_unavailable', 'down'),
      );
    const content2 = Buffer.from('second question');
    const storeDown = await message({
      messageId: 'msg_late2',
      kind: 'receive',
      route: 'to_parent',
      childRunId: 'run-1',
      senderSessionId: CHILD_SESSION_ID,
      contentBase64: content2.toString('base64'),
      contentDigest: createHash('sha256').update(content2).digest('hex'),
    });
    expect(storeDown.status).toBe(503);
    expect(storeDown.body.code).toBe('session_message_failed');
    faltered.mockRestore();
    // An append whose outcome is unknown is the same retryable store fault:
    // a 409 here would make the relay reject a message that may yet commit.
    const unsettled = vi
      .spyOn(HostedSessionMessageSession.prototype, 'receive')
      .mockRejectedValueOnce(
        new ManagedSessionAppendUnsettledError(new Error('ack lost')),
      );
    const unknownOutcome = await message({
      messageId: 'msg_late3',
      kind: 'receive',
      route: 'to_parent',
      childRunId: 'run-1',
      senderSessionId: CHILD_SESSION_ID,
      contentBase64: content2.toString('base64'),
      contentDigest: createHash('sha256').update(content2).digest('hex'),
    });
    expect(unknownOutcome.status).toBe(503);
    expect(unknownOutcome.body.code).toBe('session_message_failed');
    unsettled.mockRestore();
    // A proven journal fence is the same store-side retryable answer: a 4xx
    // here would make the relay reject a message whose receipt is durable.
    const fenced = vi
      .spyOn(HostedSessionMessageSession.prototype, 'receive')
      .mockRejectedValueOnce(
        new ManagedSessionJournalFencedError('journal fenced'),
      );
    const fencedOutcome = await message({
      messageId: 'msg_late4',
      kind: 'receive',
      route: 'to_parent',
      childRunId: 'run-1',
      senderSessionId: CHILD_SESSION_ID,
      contentBase64: content2.toString('base64'),
      contentDigest: createHash('sha256').update(content2).digest('hex'),
    });
    expect(fencedOutcome.status).toBe(503);
    expect(fencedOutcome.body.code).toBe('session_message_failed');
    fenced.mockRestore();
    const noReceipt = await message({ messageId: 'msg_down', kind: 'consume' });
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.body.code).toBe('session_message_record');
    const content = Buffer.from('late question');
    const refused = await message({
      messageId: 'msg_late',
      kind: 'receive',
      route: 'to_parent',
      childRunId: 'run-2',
      senderSessionId: CHILD_SESSION_ID,
      contentBase64: content.toString('base64'),
      contentDigest: createHash('sha256').update(content).digest('hex'),
    });
    // No such child run here: refused for good, before anything publishes.
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('session_message_record');
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // H4d-b: a parent with the attached run-1 loaded; `receive` posts one
  // child message to it through the route.
  async function loadMessageParent() {
    await prewriteMessageSession(async () => undefined);
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const receive = (messageId: string) => {
      const content = Buffer.from(`question ${messageId}`);
      return headers(
        supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          operationId: randomUUID(),
          messageId,
          kind: 'receive',
          route: 'to_parent',
          childRunId: 'run-1',
          senderSessionId: CHILD_SESSION_ID,
          contentBase64: content.toString('base64'),
          contentDigest: createHash('sha256').update(content).digest('hex'),
        })
        .then((response) => response);
    };
    return { server, receive, clientId: loaded.body.clientId as string };
  }

  // H4f × H4d-b: a stopped run's message turns stop with it — the one in
  // flight is aborted and the ones waiting behind it never run.
  it('stops the message turn in flight and the messages waiting behind it', async () => {
    const { server, receive, clientId } = await loadMessageParent();
    let signal!: AbortSignal;
    // An aborted model call rejects, as the provider's does.
    state.model.mockImplementationOnce(
      (input) =>
        new Promise((_resolve, reject) => {
          signal = input.signal;
          signal.addEventListener(
            'abort',
            () => reject(new Error('The model call was aborted.')),
            { once: true },
          );
        }),
    );
    expect((await receive('msg_running')).status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1));
    expect((await receive('msg_waiting')).status).toBe(202);
    const stop = () =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ operationId: randomUUID(), kind: 'stop' });
    // A message turn in flight is aborted; the waiting one never starts.
    expect((await stop()).status).toBe(202);
    expect(signal.aborted).toBe(true);
    const settledOf = async (turnId: string) =>
      (await journalEvents()).find(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
      )?.payload;
    await vi.waitFor(
      async () =>
        expect((await settledOf('msg_running:message'))?.['outcome']).toBe(
          'cancelled',
        ),
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await settledOf('msg_waiting:message')).toBeUndefined();
    // The relay's next stop, with no turn running, settles it.
    expect((await stop()).status).toBe(202);
    expect(await settledOf('msg_waiting:message')).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'stop_requested',
    });
    expect(state.model).toHaveBeenCalledTimes(1);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // H4f × H4d-b: the control plane can lose its attachment before a stop
  // reaches the Session. Its load carries the stop, so the first pass the
  // load kicks starts none of the waiting messages.
  it("loads a stopped run's Session without starting its waiting message", async () => {
    const content = Buffer.from('which branch should I use?');
    await prewriteMessageSession(async ({ messages }) => {
      await messages.receive({
        messageId: 'msg_up',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD_SESSION_ID,
        content,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      });
    });
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
      stopMessages: true,
    });
    expect(loaded.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(state.model).not.toHaveBeenCalled();
    const stopped = await headers(
      supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ operationId: randomUUID(), kind: 'stop' });
    expect(stopped.status).toBe(202);
    expect(
      (await journalEvents()).find(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === 'msg_up:message',
      )?.payload,
    ).toMatchObject({ outcome: 'cancelled', stopReason: 'stop_requested' });
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // A load the resident Session refuses — its identity, its Store or its
  // tool profile — stops nothing; one it admits stops its messages from
  // then on.
  it("stops a resident Session's messages only by a load it admits", async () => {
    const { server, receive } = await loadMessageParent();
    const load = (descriptor: Record<string, unknown>) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: descriptor,
        passiveManagedRuntimeRecovery: true,
        stopMessages: true,
      });
    const wrongTenant = await load({ ...store(), tenantId: 'another' });
    expect(wrongTenant.status).toBe(409);
    const wrongStore = await load({
      ...store(),
      baseUrl: 'https://another-store.test',
    });
    expect(wrongStore.status).toBe(409);
    expect(wrongStore.body.code).toBe('hosted_session_store_mismatch');
    const wrongProfile = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      passiveManagedRuntimeRecovery: true,
      stopMessages: true,
    });
    expect(wrongProfile.status).toBe(409);
    expect(wrongProfile.body.code).toBe('hosted_tool_profile_conflict');
    expect((await receive('msg_runs')).status).toBe(202);
    await vi.waitFor(
      async () =>
        expect(
          (await journalEvents()).find(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === 'msg_runs:message',
          )?.payload['outcome'],
        ).toBe('completed'),
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    const calls = state.model.mock.calls.length;
    const admitted = await load(store());
    expect(admitted.status).toBe(200);
    expect((await receive('msg_held')).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(state.model.mock.calls.length).toBe(calls);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // A message turn that died inside its attempt in an earlier process is
  // not a waiting input: the pump no longer picks it for a stopped
  // Session, so the stop runs its aftermath and nothing stays owed.
  it('settles the crashed message turn of a stopped run', async () => {
    const content = Buffer.from('which branch should I use?');
    await prewriteMessageSession(async ({ messages, managed }) => {
      await messages.receive({
        messageId: 'msg_up',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD_SESSION_ID,
        content,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      });
      await managed.sink.write({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: 'msg_up:message',
        message: { role: 'user', parts: [{ text: 'which branch?' }] },
      });
    });
    mockBrokerBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
      stopMessages: true,
    });
    expect(loaded.status).toBe(200);
    const stopped = await headers(
      supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ operationId: randomUUID(), kind: 'stop' });
    expect(stopped.status).toBe(202);
    expect(
      (await journalEvents()).some(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === 'msg_up:message',
      ),
    ).toBe(true);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  });

  // A message turn that died inside its attempt in an earlier process
  // (or, with `attempted: false`, one still waiting), loaded before its run
  // stopped: the load's pump pass picks it, and is held at `holdAt`.
  async function loadCrashedMessageTurn({
    attempted = true,
    holdAt = 'transcript projection',
  }: {
    attempted?: boolean;
    holdAt?: 'input read' | 'transcript projection';
  } = {}) {
    const content = Buffer.from('which branch should I use?');
    await prewriteMessageSession(async ({ messages, managed }) => {
      await messages.receive({
        messageId: 'msg_up',
        route: 'to_parent',
        childRunId: 'run-1',
        senderSessionId: CHILD_SESSION_ID,
        content,
        contentDigest: createHash('sha256').update(content).digest('hex'),
      });
      if (!attempted) return;
      await managed.sink.write({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'user',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: 'msg_up:message',
        message: { role: 'user', parts: [{ text: 'which branch?' }] },
      });
    });
    mockBrokerBroker();
    const pass = holdWakePass(holdAt);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(200);
    await vi.waitFor(() => expect(pass.held()).toBe(true), {
      timeout: 15_000,
    });
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    return {
      server,
      pass,
      authorize,
      stop: () =>
        authorize(
          supertest(server).post(`/session/${SESSION_ID}/messages/operations`),
        )
          .send({ operationId: randomUUID(), kind: 'stop' })
          .then((response) => response),
      recoveryBlocked: async () =>
        (
          await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          )
        ).body.recoveryBlocked as boolean,
      settles: async () =>
        (await journalEvents()).filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === 'msg_up:message',
        ).length,
    };
  }

  it('has a stop wait out the load pass over a crashed message turn', async () => {
    const { server, pass, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn();
    const stopping = stop();
    expect(await stillWaiting(stopping)).toBe('waiting');
    expect(await settles()).toBe(0);
    pass.open();
    expect((await stopping).status).toBe(202);
    expect(await recoveryBlocked()).toBe(false);
    expect(await settles()).toBe(1);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('leaves a crashed message turn the load pass left blocked to the pump', async () => {
    // The pass's aftermath loses its consume write once, so the pass
    // ends with the Session blocked and the input owed.
    const write = ManagedSessionRecordSink.prototype.write;
    let consumes = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result') {
          consumes += 1;
          if (consumes === 1)
            return Promise.reject(new Error('Store write lost to a 503'));
        }
        return write.call(this, record);
      },
    );
    const { server, pass, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn();
    const stopping = stop();
    expect(await stillWaiting(stopping)).toBe('waiting');
    pass.open();
    expect((await stopping).status).toBe(202);
    // The pass re-arms its blocked cycle, which settles the crash and
    // lifts the block; a consume by the stop would have left it blocked.
    await vi.waitFor(
      async () => {
        expect(await recoveryBlocked()).toBe(false);
        expect(await settles()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(consumes).toBe(2);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('re-arms the blocked cycle of a pass the stop stopped waiting for', async () => {
    const write = ManagedSessionRecordSink.prototype.write;
    let consumes = 0;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result') {
          consumes += 1;
          if (consumes === 1)
            return Promise.reject(new Error('Store write lost to a 503'));
        }
        return write.call(this, record);
      },
    );
    // The stop's wait, cut from its production bound.
    const exclusive = HostedMonitorWakeScheduler.prototype.exclusive;
    vi.spyOn(
      HostedMonitorWakeScheduler.prototype,
      'exclusive',
    ).mockImplementation(function (this: HostedMonitorWakeScheduler, work) {
      return exclusive.call(this, work, 200);
    });
    const { server, pass, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn();
    // The wait expires before the pass has classified the crash: the stop
    // answers without settling anything.
    expect((await stop()).status).toBe(202);
    expect(await settles()).toBe(0);
    expect(consumes).toBe(0);
    pass.open();
    // The pass blocks and loses its consume. Its settle-verify read no
    // longer sees the stopped message input, and it re-arms all the same,
    // so its blocked cycle settles the crash and lifts the block.
    await vi.waitFor(
      async () => {
        expect(await recoveryBlocked()).toBe(false);
        expect(await settles()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(consumes).toBe(2);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('has a stop that waited leave a crashed message turn to a later stop when a prompt was admitted meanwhile', async () => {
    let modelEntered = false;
    let openModel!: () => void;
    const modelHeld = new Promise<void>((resolve) => {
      openModel = resolve;
    });
    state.model.mockImplementationOnce(async () => {
      modelEntered = true;
      await modelHeld;
      return { text: 'hello back', model: 'test-model' };
    });
    const { server, pass, authorize, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn({ holdAt: 'input read' });
    const stopping = stop();
    expect(await stillWaiting(stopping)).toBe('waiting');
    const prompt = [{ type: 'text', text: 'hello' }];
    const prompted = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    expect(prompted.status).toBe(202);
    await vi.waitFor(() => expect(modelEntered).toBe(true), {
      timeout: 15_000,
    });
    pass.open();
    // The re-check after the wait finds the prompt: no aftermath runs
    // under it.
    expect((await stopping).status).toBe(202);
    expect(await settles()).toBe(0);
    openModel();
    // The relay's next stop, on an idle Session, settles the crash.
    await vi.waitFor(
      async () => {
        expect((await stop()).status).toBe(202);
        expect(await settles()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(await recoveryBlocked()).toBe(false);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('has a stop with no crashed message turn owed answer without waiting for the pass', async () => {
    const { server, pass, stop, recoveryBlocked, settles } =
      await loadCrashedMessageTurn({ attempted: false, holdAt: 'input read' });
    // The waiting message settles cancelled at once, and nothing is left
    // that the pass could be settling. A stop that waited would hold until
    // the pass is let go, so the window can be wide.
    const stopping = stop();
    expect(
      await Promise.race([
        stopping.then(() => 'answered'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 5_000)),
      ]),
    ).toBe('answered');
    expect((await stopping).status).toBe(202);
    expect(await settles()).toBe(1);
    pass.open();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await recoveryBlocked()).toBe(false);
    expect(await settles()).toBe(1);
    expect(state.model).not.toHaveBeenCalled();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('refuses a message once the Session close began', async () => {
    const { server, receive } = await loadMessageParent();
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
      // The close already cancelled the pending inputs: a receipt now
      // would wait for a turn nothing runs.
      const refused = await receive('msg_after_close');
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_session_closing');
    } finally {
      release();
    }
    expect((await closing).status).toBe(204);
    expect(
      (await journalEvents()).some(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['inputId'] === 'msg_after_close:message',
      ),
    ).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
  });

  it('lets a message admitted before the close land before its pending inputs are cancelled', async () => {
    const { server, receive } = await loadMessageParent();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = HostedSessionMessageSession.prototype.receive;
    vi.spyOn(
      HostedSessionMessageSession.prototype,
      'receive',
    ).mockImplementation(async function (
      this: HostedSessionMessageSession,
      ...args: Parameters<HostedSessionMessageSession['receive']>
    ) {
      entered();
      await gate;
      return original.apply(this, args);
    });
    const receiving = receive('msg_in_flight');
    await started;
    let closed = false;
    const closing = headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .then((response) => response)
      .finally(() => {
        closed = true;
      });
    // The close waits for the receipt that passed its check.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(false);
    release();
    const received = await receiving;
    expect(received.status).toBe(202);
    expect(received.body.inputId).toBe('msg_in_flight:message');
    expect((await closing).status).toBe(204);
    // Its input is cancelled with the other pending inputs, never left
    // waiting for a turn after the Session closed.
    const events = await journalEvents();
    expect(
      events.some(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['inputId'] === 'msg_in_flight:message',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === 'msg_in_flight:message',
      ),
    ).toBe(true);
    expect(state.model).not.toHaveBeenCalled();
  });

  // H4e-b1: the reopen verifier admits the lead's team roster and board, so
  // a Session that led a team reopens with its own committed history.
  it('reopens a Session whose journal carries its team, board and plan with the plan gate off', async () => {
    domainEnablement.childRun = true;
    domainEnablement.teamPlan = true;
    try {
      const key = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
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
        journalStore: new LocalJsonlManagedSessionJournalStore({
          runtimeBaseDir: state.root,
          sessionId: SESSION_ID,
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        }),
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
        const store = {
          authority: managed.authority,
          resources: managed.resources,
        };
        const children = new HostedChildAgentSession(store, key);
        const teams = new HostedTeamSession(store, key, children);
        await teams.run('team_create', { team_name: 'review' }, 'p:team');
        const member = teams.admitMember('alice');
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
          workspaceMode: 'shared',
          workingDirectory: '.',
          executionCallId: 'run-1',
        });
        await teams.join({
          ...member,
          childRunId: 'run-1',
          planModeRequired: true,
        });
        await children.dispatchStarted('run-1', {
          dispatchId: 'plan-dispatch',
          runtime: { runtimeBindingId: 'plan-binding', generation: '1' },
        });
        await children.attach('run-1', CHILD_SESSION_ID);
        await teams.submitPlan('cmd_reopen_plan', 'run-1', 'Read then edit');
        domainEnablement.teamPlan = false;
        await children.settleFailed('run-1', {
          stopReason: 'child_failed',
          reason: null,
          started: true,
        });
        await teams.run(
          'task_create',
          { subject: 'audit', description: 'audit the diff' },
          'p:task',
        );
      } finally {
        await managed.close().catch(() => undefined);
      }
      mockBrokerBroker();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events
          .filter((event) => event.kind === 'domain.committed')
          .map((event) => event.payload['domain']),
      ).toEqual(
        expect.arrayContaining([
          'team_state',
          'team_task',
          'team_plan',
          'child_run',
        ]),
      );
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    } finally {
      domainEnablement.childRun = true;
      domainEnablement.teamPlan = false;
    }
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
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
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
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
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
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
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
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
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

  // #14387: the relay's recovery-blocked settlement for a child whose
  // Harness generation was lost — dispatched, never continued. The op
  // admits only the lost-Runtime reason, and a replay restating the same
  // verdict is the same revision.
  it('commits a recovery-blocked verdict over a lost generation', async () => {
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
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
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
    // Only the lost-Runtime reason is admitted; anything else is a 400.
    const badReason = await operation({
      kind: 'recovery_blocked',
      reason: 'child_failed',
      childSessionId,
    });
    expect(badReason.status).toBe(400);
    expect(badReason.body.code).toBe('invalid_child_operation');
    await operation({
      kind: 'recovery_blocked',
      reason: 'runtime_lost',
      childSessionId,
    }).expect(202);
    // A replay restating the same verdict is the same revision.
    await operation({
      kind: 'recovery_blocked',
      reason: 'runtime_lost',
      childSessionId,
    }).expect(202);
    await posted;
  }, 60_000);

  // #14387: the blocked settlement of a background child commits a
  // notification an already-idle parent only receives when the route kicks
  // its wake scheduler — the scheduler parks on an empty next() and never
  // rescans on its own. The kick fires on a replay too.
  it('kicks the wake scheduler of an idle parent on a recovery-blocked settlement', async () => {
    domainEnablement.childRun = true;
    mockBrokerBroker();
    const kick = vi
      .spyOn(HostedMonitorWakeScheduler.prototype, 'kick')
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
          run_in_background: true,
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
    // The background launch settles the parent's turn — the Session is
    // idle when the relay's verdict lands.
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
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
    await operation({
      kind: 'dispatch_started',
      dispatchId: 'dispatch-1',
      runtimeBindingId: 'binding-1',
      generation: '1',
    }).expect(202);
    kick.mockClear();
    await operation({
      kind: 'recovery_blocked',
      reason: 'runtime_lost',
    }).expect(202);
    expect(kick).toHaveBeenCalledTimes(1);
    // The settlement's idempotent skip does not extend to the delivery: a
    // replay restating the verdict kicks again.
    kick.mockClear();
    await operation({
      kind: 'recovery_blocked',
      reason: 'runtime_lost',
    }).expect(202);
    expect(kick).toHaveBeenCalledTimes(1);
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
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
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
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
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
      { timeout: settleTimeoutMs() },
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
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
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
      { timeout: settleTimeoutMs() },
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

  it.each([
    ['Tool', () => new HostedToolRecoveryRequiredError(new Error('x'))],
    ['MCP', () => new HostedMcpRecoveryRequiredError()],
    ['Hook', () => new HostedHookRecoveryRequiredError()],
    ['LLM preparation', () => new LlmRequestPreparationError(new Error('x'))],
  ] as const)(
    'returns the Workspace mount when a tool turn goes recovery blocked through a %s error',
    async (_label, blockError) => {
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
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
        '55555555-5555-4555-8555-555555555555',
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
        executionStatus: 'success',
        responseParts: [{ text: 'original result' }],
      });
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'fileHistory',
      ).mockResolvedValue({
        ownerSessionId: SESSION_ID,
        snapshots: [],
        files: {},
      });
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'workspaceContext',
      ).mockResolvedValue([]);
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      const releaseMount = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
        .mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
        'route-claim',
      );
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'read_file',
          callId: 'blocked-tool',
          args: { file_path: 'gone.txt' },
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
        throw blockError();
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'read gone' }];
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
        { timeout: settleTimeoutMs() },
      );
      // #13800: the blocked turn's mount lease must go back — a leaked
      // lease wedged every later tool turn on the same storage — while the
      // Runtime Session stays READY for the recovery fleet: exactly one
      // handback under this turn's claim (another test's owed chain may
      // still reach the prototype under its own), the RELEASED-forever
      // full release never.
      expect(
        releaseMount.mock.calls.filter(([claim]) => claim === 'route-claim'),
      ).toHaveLength(1);
      expect(release).not.toHaveBeenCalled();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    },
  );

  it('returns the Workspace mount when a settled turn parks with its cleanup still owed (#13800)', async () => {
    // The warm answer names the Runtime, so the turn owes its release to
    // the cleanup debt rather than to finish().
    const named = async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(named);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      named,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '55555555-5555-4555-8555-555555555555',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'original result' }],
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'workspaceContext',
    ).mockResolvedValue([]);
    // The turn settles, but its owed full release cannot land.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockRejectedValue(
      new HostedWorkspaceBrokerRejection(503, 'runtime_unavailable'),
    );
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'cleanup-claim',
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'read',
        args: { file_path: 'a.txt' },
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
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'read a' }];
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
      { timeout: settleTimeoutMs() },
    );
    // The cleanup keeps owing its full release; the mount is not held
    // hostage to it.
    expect(
      releaseMount.mock.calls.filter(([claim]) => claim === 'cleanup-claim'),
    ).toHaveLength(1);
  });

  it('returns the Workspace mount when a turn owing its cleanup cannot write its terminal record (#13800)', async () => {
    // The warm answer names the Runtime, so the turn owes its release to
    // the cleanup debt; a terminal write that never lands skips that
    // cleanup and parks the Session blocked.
    const named = async function (this: HostedWorkspaceBroker) {
      this.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
    };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(named);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      named,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '55555555-5555-4555-8555-555555555555',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'original result' }],
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'workspaceContext',
    ).mockResolvedValue([]);
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'terminal-claim',
    );
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result')
          return Promise.reject(new Error('terminal write lost'));
        return originalWrite.call(this, record);
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'read',
        args: { file_path: 'a.txt' },
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
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'read a' }];
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
      { timeout: settleTimeoutMs() },
    );
    // The full release stays owed behind the durable terminal; only the
    // mount goes back.
    expect(release).not.toHaveBeenCalled();
    expect(
      releaseMount.mock.calls.filter(([claim]) => claim === 'terminal-claim'),
    ).toHaveLength(1);
  });

  it('drains a turn-held Runtime at close through the drain arm (#13856)', async () => {
    // The designed hold: the turn's routine release is refused
    // `runtime_session_held`, the turn settles clean (no recovery park),
    // and the Session's close owes the Runtime's drain release.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: { message: 'not run' },
    });
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
    );
    release.mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
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
        // The designed hold is not a wedge: the Session stays healthy.
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]).toEqual([]);
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
    // The close handed the held Runtime back through the drain arm.
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls[1]).toEqual([{ drain: true }]);
  });

  it('closes a Session whose held Runtime is already gone (#13856 R1-1)', async () => {
    // The held turn's Runtime is already gone by the close: the drain's 404
    // names nothing left to stop, so the close tolerates it and answers 204
    // rather than wedging on a 503 over a Session that can never close.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      randomUUID(),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'not_started',
      responseParts: [],
      capture: null,
      error: { message: 'not run' },
    });
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
    );
    release.mockRejectedValueOnce(
      new HostedWorkspaceBrokerRejection(404, 'runtime_session_not_found'),
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'registerPublisher',
    ).mockResolvedValue('1');
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
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          clientId,
        )
      ).status,
    ).toBe(204);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls[1]).toEqual([{ drain: true }]);
  });

  it('restores the held-Runtime drain obligation on a replacement load (#13930 R1-2)', async () => {
    // A restart empties the in-memory held set; the close's drain
    // obligation survives only when the load restores it from the Broker's
    // durable hold rows. The prewritten Session below belongs to a process
    // that died before any close could drain; the Broker still lists the
    // held Runtime Session, so the load must restore the obligation and
    // this process's close must hand the Runtime back through the drain
    // arm. Without the load-time restore the final assertions are red:
    // the fresh process's set is empty and its close drains nothing. The
    // second id is digest-shaped: alongside the cardinality pin (every
    // restored entry drains, not just the first) it carries the close's
    // hostedRuntimeSessionId mapping end-to-end — an already path-safe
    // answer must come back verbatim (#13986 R1-1).
    await prewriteShellProfileSession();
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
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockResolvedValue();
    const restored = [PROMPT_ID, `wake-${'a'.repeat(64)}`];
    const activeHolds = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'activeHoldRuntimeSessionIds')
      .mockResolvedValue(restored);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store() })
      .expect(200);
    expect(activeHolds).toHaveBeenCalledTimes(1);
    // The load is additive: it restores the obligation and never discharges
    // it — only the close drains (#13986 R1-2).
    expect(release).not.toHaveBeenCalled();
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        )
      ).status,
    ).toBe(204);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls).toEqual([[{ drain: true }], [{ drain: true }]]);
    expect(
      (release.mock.contexts as HostedWorkspaceBroker[])
        .map((broker) => broker.runtimeSessionId)
        .sort(),
    ).toEqual([...restored].sort());
  });

  it('closes a Session whose restored hold the restarted Broker cannot drain (#13986 R2-1)', async () => {
    // A worker restart takes the Harness and the Broker down together. The
    // replacement Broker no longer holds the Runtime Session in memory and
    // cannot prove its release, so the drain of a restored hold answers the
    // declared-retryable 503 runtime_reconciliation_required — the
    // Workspace-level cascade owns the Runtime from there. The close must
    // tolerate that answer and retire the Session: before the tolerance the
    // same DELETE rethrew ahead of sessions.delete, answered 503 on every
    // retry, and the reload re-seeded the id — the Session could never
    // leave the registry. The unproven drain still parks the monitor-loop
    // settle on runtime_lost rather than stop_requested.
    await prewriteShellProfileSession();
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
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockRejectedValue(
      new HostedWorkspaceBrokerRejection(
        503,
        'runtime_reconciliation_required',
      ),
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([PROMPT_ID]);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store() })
      .expect(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(204);
    // The Session left the registry: a second close finds nothing to close.
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .expect(404);
  });

  it('loads without the drain obligation when the restore query fails (#13930 R1-2)', async () => {
    // The declared degrade: a failed active-holds query logs and loads
    // without the obligation — never a failed load in the restart window
    // this slice serves. The close then drains nothing.
    await prewriteShellProfileSession();
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
    const release = vi.spyOn(HostedWorkspaceBroker.prototype, 'release');
    release.mockResolvedValue();
    const activeHolds = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'activeHoldRuntimeSessionIds')
      .mockRejectedValue(new Error('broker unreachable'));
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store() })
      .expect(200);
    expect(activeHolds).toHaveBeenCalledTimes(1);
    expect(
      (
        await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        )
      ).status,
    ).toBe(204);
    // No obligation was restored, so the close drains nothing.
    expect(release).not.toHaveBeenCalled();
  });

  it('never queries the held-Runtime inventory on a fresh create (#13930 R1-2)', async () => {
    // A created Session has no hold rows: the restore read is load-only.
    const activeHolds = vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    );
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
      })
      .expect(200);
    expect(activeHolds).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .expect(204);
    expect(activeHolds).not.toHaveBeenCalled();
  });

  it('never queries the held-Runtime inventory on a lifecycle-v2 load (#13986 R1-3)', async () => {
    // The set's only reader is the close's drain loop, which sits in the
    // v1-only close block: a v2 Session would restore an obligation its
    // close never drains — a dead Broker round trip on every load plus
    // in-memory state that reads as an armed drain and is not.
    await prewriteShellProfileSession();
    const activeHolds = vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    );
    const server = await app(true);
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        lifecycleProtocolVersion: 2,
        lifecycleAuthority: { operationId: 'v2-load', claimGeneration: 1 },
      })
      .expect(200);
    expect(activeHolds).not.toHaveBeenCalled();
  });

  it('never queries the held-Runtime inventory for an MCP-profile load (#13986 R3-1)', async () => {
    // The 409 gate admits hosted-workspace-mcp/1 beside the workspace
    // profiles whenever brokerOptions is present, but an MCP-profile
    // Session has no tool turn and can never hold a background Runtime:
    // the restore read would be a dead Broker round trip on every load,
    // and a misleading could-not-restore line whenever the Broker is down.
    await prewriteShellProfileSession('hosted-workspace-mcp/1');
    const activeHolds = vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    );
    const server = await app(true);
    await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers: [
          {
            serverId: 'demo',
            serverRevision: 1,
            definitionDigest: 'a'.repeat(64),
          },
        ],
      })
      .expect(200);
    expect(activeHolds).not.toHaveBeenCalled();
  });

  /** A Session whose process died before any close could drain: the
   * durable definition exists and the writer is free again. */
  async function prewriteShellProfileSession(
    toolProfile = 'hosted-workspace-shell/1',
  ): Promise<void> {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
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
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: resources,
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from(
            JSON.stringify({
              engine: 'managed',
              sessionId: SESSION_ID,
              toolProfile,
              ...(toolProfile === 'hosted-workspace-mcp/1'
                ? {
                    mcpServers: [
                      {
                        serverId: 'demo',
                        serverRevision: 1,
                        definitionDigest: 'a'.repeat(64),
                      },
                    ],
                  }
                : {}),
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
    // The open above only mints the durable definition; closing here frees
    // the writer so the replacement process may open the Session — the
    // death itself is that no close ever drained.
    await managed.close();
  }

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
        { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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
          { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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
    {
      code: 'managed_hook_module_evaluation_abandoned',
      outcome: 'cancelled',
      event: HookEventName.UserPromptSubmit,
    },
    {
      code: 'managed_hook_module_evaluation_timeout',
      outcome: 'timeout',
      event: HookEventName.UserPromptSubmit,
    },
    {
      code: 'managed_hook_module_evaluation_abandoned',
      outcome: 'cancelled',
      event: HookEventName.InstructionsLoaded,
    },
    {
      code: 'managed_hook_module_evaluation_timeout',
      outcome: 'timeout',
      event: HookEventName.InstructionsLoaded,
    },
  ] as const)(
    'settles a turn an evaluation fence parked once the Runtime republishes ($code, $event)',
    async ({ code, outcome, event }) => {
      const { server, authorize, catalog, requests } = await hookApp();
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], eventName: event }],
      });
      const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
      const original = control.getMockImplementation()!;
      const republished = new Map<string, ManagedHookOperationView>();
      let fence = true;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'hook-execute' && fence) {
          fence = false;
          requests.push(operation);
          return {
            operationId: operation.operationId,
            state: 'settled',
            error: { code },
          };
        }
        if (
          (operation.kind === 'hook-status' ||
            operation.kind === 'hook-cancel') &&
          republished.has(operation.targetOperationId)
        )
          return republished.get(operation.targetOperationId)!;
        return original.call(this, operation);
      });
      // The mock stands in for the whole turn body, so fire the Hook from
      // it the way runHostedHarnessTextTurn would. A republished
      // InstructionsLoaded receipt can never carry cancelRequested, so its
      // fence is admitted by its creation inside the parked turn instead.
      state.model.mockImplementationOnce(
        async ({ hooks, promptId, signal }) => {
          await hooks!.fire(
            event,
            event === HookEventName.InstructionsLoaded
              ? `${promptId}:native:${'c'.repeat(64)}:0`
              : promptId!,
            { prompt_id: promptId },
            signal,
          );
          throw new Error('The fenced Hook must stop this turn.');
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
        { timeout: settleTimeoutMs() },
      );
      // Once the evaluation definitively ends the Runtime republishes its
      // receipt, and the next prompt reconciles the fence, settles the parked
      // turn, and is admitted rather than refused for the Session's life.
      const child = requests.find((entry) => entry.kind === 'hook-execute')!;
      republished.set(child.operationId, {
        operationId: child.operationId,
        state: 'settled',
        result: { success: false, outcome, duration: 0, notStarted: true },
      });
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: randomUUID(), payloadDigest })
        .expect(202);
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
        { timeout: settleTimeoutMs() },
      );
      const transcript = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
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
  );

  it.each([
    {
      code: 'managed_hook_module_evaluation_abandoned',
      outcome: 'cancelled',
    },
    {
      code: 'managed_hook_module_evaluation_timeout',
      outcome: 'timeout',
    },
  ] as const)(
    'settles a pre-tool turn an evaluation fence parked once the Runtime republishes ($code)',
    async ({ code, outcome }) => {
      const { server, authorize, catalog, requests } = await hookApp();
      Object.assign(catalog, {
        hooks: [{ ...catalog.hooks[0], eventName: HookEventName.PreToolUse }],
      });
      const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
      const original = control.getMockImplementation()!;
      const republished = new Map<string, ManagedHookOperationView>();
      let fence = true;
      control.mockImplementation(async function (
        this: HostedWorkspaceBroker,
        operation,
      ) {
        if (operation.kind === 'hook-execute' && fence) {
          fence = false;
          requests.push(operation);
          return {
            operationId: operation.operationId,
            state: 'settled',
            error: { code },
          };
        }
        if (
          (operation.kind === 'hook-status' ||
            operation.kind === 'hook-cancel') &&
          republished.has(operation.targetOperationId)
        )
          return republished.get(operation.targetOperationId)!;
        return original.call(this, operation);
      });
      const call = {
        name: 'write_file',
        callId: 'call-0',
        args: { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      // The assistant message commits before the PreToolUse Hook fences, so
      // the parked turn is the pre-tool arm's, never the pre-model one's.
      state.model.mockImplementationOnce(
        async ({ toolTurn, signal, modelScope }) => {
          const complete = await modelScope!.beginMainAttempt('test-model');
          await complete(true, []);
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
          throw new Error('The fenced Hook must stop this turn.');
        },
      );
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
        { timeout: settleTimeoutMs() },
      );
      // Once the evaluation definitively ends the Runtime republishes its
      // receipt, and the next prompt reconciles the fence, settles the
      // parked turn, and is admitted rather than refused for the Session's
      // life — the pre-model arm's contract, applied to the pre-tool arm.
      const child = requests.find((entry) => entry.kind === 'hook-execute')!;
      republished.set(child.operationId, {
        operationId: child.operationId,
        state: 'settled',
        result: { success: false, outcome, duration: 0, notStarted: true },
      });
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: randomUUID(), payloadDigest })
        .expect(202);
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
        { timeout: settleTimeoutMs() },
      );
      const transcript = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      );
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
        { timeout: settleTimeoutMs() },
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
        // The prompt gate re-arms while the Session stays blocked and
        // retries the settle the failed cancel dropped: where the refusal
        // writes already landed durably the retry completes the settlement
        // and admits the prompt, and where the write failure is permanent
        // it refuses again.
        const heals =
          mode === 'result-ack-failure' ||
          mode === 'large-batch-partial' ||
          mode === 'large-batch-reload';
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({ prompt, promptId: randomUUID(), payloadDigest })
          .expect(heals ? 202 : 409);
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
          // No call is refused twice: the retry answers only the calls the
          // dropped settle had not already covered durably.
          expect(results).toHaveLength(large ? 2 : 1);
          expect(results[0].message!.parts!.length).toBeGreaterThan(0);
          if (large)
            expect(results[0].message!.parts!.length).toBeLessThan(
              calls.length,
            );
          expect(
            results.flatMap((result) =>
              result.message!.parts!.map((part) => part.functionResponse?.id),
            ),
          ).toEqual(calls.map((call) => call.callId));
          expect(
            partial.body.events.filter(
              (event: { type: string; promptId?: string }) =>
                event.type === 'turn_complete' && event.promptId === PROMPT_ID,
            ),
          ).toHaveLength(1);
        }
        if (heals)
          // The admitted retry prompt runs its own turn; let it finish
          // before the admissions below race its active Turn.
          await vi.waitFor(
            async () => {
              const settled = await authorize(
                supertest(server).get(`/session/${SESSION_ID}/status`),
              );
              expect(settled.body.hasActivePrompt).toBe(false);
            },
            { timeout: settleTimeoutMs() },
          );
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
          (event: { type: string; promptId?: string }) =>
            event.type === 'turn_complete' && event.promptId === PROMPT_ID,
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
        { timeout: settleTimeoutMs() },
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
          { timeout: settleTimeoutMs() },
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
          { timeout: settleTimeoutMs() },
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
        expect(refused.body.reason).toBe('restore_verification_failed');
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
      { timeout: settleTimeoutMs() },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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

  it('deregisters the Session when the close sealed the writer but the release failed', async () => {
    // A plain Session (no hooks): the close reaches managed.close()
    // directly, so the boundary release fails inside it, after its finally
    // sealed the writer (review round 11, R11-3).
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'releaseActivation',
    ).mockRejectedValue(new Error('resource store unavailable'));
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('managed_session_close_failed');
    // The sealed-but-rejected session is deregistered: a follow-up gets a
    // clean 404 instead of a stranded entry answering against a dead
    // journal. A retried DELETE does not re-run the release either.
    const followUp = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(followUp.status).toBe(404);
    expect(followUp.body.code).toBe('hosted_session_not_found');
  });

  it('keeps the Session when the close rejected before the writer seal landed', async () => {
    // A pre-seal seal() rejection leaves the writer open: the Session must
    // stay registered so a retry can reach it (review round 13, R13-1).
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId);
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'seal',
    ).mockRejectedValue(new Error('seal candidate already exists'));
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('managed_session_close_failed');
    // The pre-seal rejection keeps the Session: a follow-up DELETE reaches
    // the same entry and fails the same way instead of answering 404.
    const followUp = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(followUp.status).toBe(503);
    expect(followUp.body.code).toBe('managed_session_close_failed');
  });

  it('names a retained Hook hold when DELETE cannot release its owner', async () => {
    const { server, authorize, release } = await hookApp();
    release.mockImplementation(async () => {
      throw new HostedWorkspaceBrokerRejection(
        409,
        'managed_runtime_owner_hold_pending',
      );
    });
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    // The generic close code would hide that the Session is still attached
    // because its Hook owner holds unfinished work.
    expect(failed.body.code).toBe('hosted_hook_recovery_required');
    const retry = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(retry.status).toBe(503);
    expect(retry.body.code).toBe('hosted_hook_recovery_required');
  });

  it('keeps the wake pump of a Session its refused DELETE kept alive', async () => {
    domainEnablement.monitorRun = true;
    const { server, authorize, release } = await hookApp(
      'hosted-workspace-shell/1',
    );
    const wakeClose = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'close');
    release.mockImplementation(async () => {
      throw new HostedWorkspaceBrokerRejection(
        409,
        'managed_runtime_owner_hold_pending',
      );
    });
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    const failed = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('hosted_hook_recovery_required');
    // The Session stays attached and fully served — and its wake pump with
    // it: tearing the scheduler down before the Hook close was known
    // terminal would leave the kept Session never delivering a wake turn.
    expect(
      (await authorize(supertest(server).get(`/session/${SESSION_ID}/status`)))
        .status,
    ).toBe(200);
    expect(wakeClose).not.toHaveBeenCalled();
    release.mockResolvedValue();
    await authorize(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
    expect(wakeClose).toHaveBeenCalledOnce();
  });

  it('bounds the prompt-gate reconcile so a stalled Runtime cannot hold the route', async () => {
    const { server, authorize } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute')
        return {
          operationId: operation.operationId,
          state: 'outcome_unknown',
        };
      return original(operation);
    });
    const fenced = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({
      operationId: randomUUID(),
      event: 'Notification',
      input: { message: 'effect', notification_type: 'test' },
    });
    expect(fenced.status).toBe(503);
    expect(
      (await authorize(supertest(server).get(`/session/${SESSION_ID}/status`)))
        .body.recoveryBlocked,
    ).toBe(true);
    // The poll that never answers: only the route's own budget can end it.
    let statusSeen!: () => void;
    const firstStatus = new Promise<void>((resolve) => {
      statusSeen = resolve;
    });
    control.mockImplementation(async (operation) => {
      if (
        operation.kind === 'hook-status' ||
        operation.kind === 'hook-cancel'
      ) {
        statusSeen();
        return new Promise<ManagedHookOperationView>(() => {});
      }
      return original(operation);
    });
    const prompt = [{ type: 'text', text: 'hello' }];
    // Only the reconcile budget's timer is faked — faking setImmediate too
    // would stall the request itself before the poll begins.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // A supertest request fires on the first then: attach it now or the
      // poll below would wait on a request that was never sent.
      const posted = authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .send({
          prompt,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .then((response) => response);
      await firstStatus;
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await posted;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('hosted_turn_recovery_required');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the prompt-gate reconcile when the prompting client disconnects', async () => {
    const { server, authorize } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute')
        return {
          operationId: operation.operationId,
          state: 'outcome_unknown',
        };
      return original(operation);
    });
    const fenced = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({
      operationId: randomUUID(),
      event: 'Notification',
      input: { message: 'effect', notification_type: 'test' },
    });
    expect(fenced.status).toBe(503);
    // The poll that never answers: only the client's own disconnect ends the
    // reconcile ahead of its budget here.
    let statusSeen!: () => void;
    const firstStatus = new Promise<void>((resolve) => {
      statusSeen = resolve;
    });
    control.mockImplementation(async (operation) => {
      if (
        operation.kind === 'hook-status' ||
        operation.kind === 'hook-cancel'
      ) {
        statusSeen();
        return new Promise<ManagedHookOperationView>(() => {});
      }
      return original(operation);
    });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const prompt = [{ type: 'text', text: 'hello' }];
    const posted = authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: randomUUID(),
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    // A supertest request fires on the first then: attach it before the
    // abort, or the poll below waits on a request that was never sent.
    const answered = posted.then(
      (response) => response,
      (cause: unknown) => cause,
    );
    await firstStatus;
    posted.abort();
    await answered;
    // The disconnect reaches the reconcile as its abort reason and is
    // logged, and the pass releases hooksBusy instead of holding every
    // other route at 409 for the rest of the budget.
    await vi.waitFor(
      () => {
        expect(stderr.mock.calls.flat().join('\n')).toContain(
          'The prompting client disconnected.',
        );
      },
      { timeout: settleTimeoutMs() },
    );
    control.mockImplementation(original);
    const deleted = await authorize(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(deleted.body?.code).not.toBe('hosted_turn_active');
  });

  it('retries a settle the reconcile pass dropped once nothing is pending', async () => {
    const { server, authorize, catalog, requests } = await hookApp();
    Object.assign(catalog, {
      hooks: [
        { ...catalog.hooks[0], eventName: HookEventName.UserPromptSubmit },
      ],
    });
    const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'hookControl');
    const original = control.getMockImplementation()!;
    const republished = new Map<string, ManagedHookOperationView>();
    let fence = true;
    control.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      operation,
    ) {
      if (operation.kind === 'hook-execute' && fence) {
        fence = false;
        requests.push(operation);
        return {
          operationId: operation.operationId,
          state: 'settled',
          error: { code: 'managed_hook_module_evaluation_abandoned' },
        };
      }
      if (
        (operation.kind === 'hook-status' ||
          operation.kind === 'hook-cancel') &&
        republished.has(operation.targetOperationId)
      )
        return republished.get(operation.targetOperationId)!;
      return original.call(this, operation);
    });
    state.model.mockImplementationOnce(async ({ hooks, promptId, signal }) => {
      await hooks!.fire(
        HookEventName.UserPromptSubmit,
        promptId!,
        { prompt_id: promptId },
        signal,
      );
      throw new Error('The fenced Hook must stop this turn.');
    });
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
      { timeout: settleTimeoutMs() },
    );
    const child = requests.find((entry) => entry.kind === 'hook-execute')!;
    republished.set(child.operationId, {
      operationId: child.operationId,
      state: 'settled',
      result: {
        success: false,
        outcome: 'cancelled',
        duration: 0,
        notStarted: true,
      },
    });
    // The client disconnects the moment the poll's first record commit
    // lands: the reconcile drains the pending records, but the aborted
    // signal drops the settle at its first checkpoint, leaving the Session
    // blocked with nothing pending.
    let cut = false;
    let posted: supertest.Test | undefined;
    const commit = LocalManagedSessionAuthority.prototype.commitExtensionRecord;
    const commits = vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'commitExtensionRecord')
      .mockImplementation(async function (
        this: LocalManagedSessionAuthority,
        ...args
      ) {
        const receipt = await commit.apply(this, args);
        if (!cut && args[1].domain === 'hook_execution') {
          cut = true;
          posted?.abort();
        }
        return receipt;
      });
    try {
      posted = authorize(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      ).send({ prompt, promptId: randomUUID(), payloadDigest });
      const answered = posted.then(
        (response) => response,
        (cause: unknown) => cause,
      );
      await answered;
      // Both the parked record and its marker must finish committing before
      // the next prompt, or the pending gate would re-arm on its own.
      await vi.waitFor(
        () => {
          expect(
            commits.mock.calls.filter(
              ([, request]) => request.domain === 'hook_execution',
            ),
          ).toHaveLength(2);
        },
        { timeout: settleTimeoutMs() },
      );
    } finally {
      commits.mockRestore();
    }
    const blocked = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    );
    expect(blocked.body.recoveryBlocked).toBe(true);
    // The gate re-arms on the still-blocked Session, retries the dropped
    // settle, and the prompt is admitted rather than refused for life.
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: randomUUID(), payloadDigest })
      .expect(202);
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
      { timeout: settleTimeoutMs() },
    );
    const transcript = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    );
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it('answers an invalid prompt on a fenced Session without reconciling first', async () => {
    const { server, authorize, requests } = await hookApp();
    const control = vi.mocked(HostedWorkspaceBroker.prototype.hookControl);
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (operation) => {
      if (operation.kind === 'hook-execute')
        return {
          operationId: operation.operationId,
          state: 'outcome_unknown',
        };
      return original(operation);
    });
    const fenced = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    ).send({
      operationId: randomUUID(),
      event: 'Notification',
      input: { message: 'effect', notification_type: 'test' },
    });
    expect(fenced.status).toBe(503);
    const statusPolls = () =>
      requests.filter((request) => request.kind === 'hook-status').length;
    const before = statusPolls();
    const rejected = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({});
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('invalid_hosted_prompt');
    // A request the validation refuses never pays a Runtime poll or a
    // durable settle write.
    expect(statusPolls()).toBe(before);
    const transcript = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    );
    expect(
      transcript.body.events.filter(
        (event: { type: string }) => event.type === 'turn_complete',
      ),
    ).toHaveLength(0);
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

  it('admits ordinary Shell with MCP, keeps file history available and refuses Plan before MCP starts', async () => {
    const { server, authorize, requests } = await mcpApp(
      false,
      ['demo'],
      'hosted-workspace-shell/1',
    );
    const history = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/files/history`),
    );
    expect(history.status).toBe(200);
    expect(history.body.history).toBeNull();
    const prompt = [{ type: 'text', text: 'plan without running tools' }];
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      approvalSelection: { mode: 'default', revision: 1, planMode: true },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('invalid_hosted_approval_selection');
    expect(requests).toEqual([]);
    const close = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(close.status).toBe(409);
    expect(close.body.code).toBe('hosted_lifecycle_required');
  });

  it.each(['hosted-workspace-files/1', 'hosted-workspace-shell/1'])(
    'refuses MCP configuration records without definition pins on %s',
    async (toolProfile) => {
      const sessionKey = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const resources = LocalManagedSessionResourceStore.create({
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
        resourceStore: resources,
        create: {
          definitionRef: await resources.publish(
            'managed-definition',
            Buffer.from(
              JSON.stringify({
                engine: 'managed',
                sessionId: SESSION_ID,
                toolProfile,
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
        const fixture = JSON.parse(
          await readFile(
            path.resolve(
              '../core/src/managed-runtime/contracts/managed-mcp-record-v1.fixtures.json',
            ),
            'utf8',
          ),
        ) as {
          templates: {
            mcp_configuration: import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js').ManagedSessionJsonValue;
          };
        };
        await managed.authority.commitExtensionRecord(
          {
            operation: 'commitExtensionRecord',
            commandId: 'configure-1',
            sessionKey,
            contentDigest: 'd'.repeat(64),
          },
          {
            domain: 'mcp_configuration',
            record: fixture.templates.mcp_configuration,
          },
          { class: 'trusted_entry' },
        );
      } finally {
        await managed.close();
      }
      const server = await app(true);
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), toolProfile });
      expect(loaded.status).toBe(409);
      expect(loaded.body.reason).toBe('restore_verification_failed');
      expect(log.mock.calls.map(([line]) => line)).toContain(
        `qwen serve: Hosted Session ${SESSION_ID} load refused (workspace_verify): Error: Hosted MCP configuration is not pinned.`,
      );
      expect(state.model).not.toHaveBeenCalled();
    },
  );

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
          timeout: settleTimeoutMs(),
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
          { timeout: settleTimeoutMs() },
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
        // Cleanup, not proof: a wedged turn must still report the try block's
        // assertion rather than this wait's timeout.
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
        await vi.waitFor(() => expect(invokeStarted).toBe(true), {
          timeout: 10_000,
        });
        const url = `/session/${SESSION_ID}/mcp/operations/${operationId}`;
        recovery = authorize(
          kind === 'status'
            ? supertest(server).get(url)
            : supertest(server).post(`${url}/cancel`),
        ).then((response) => response);
        await vi.waitFor(() => expect(recoveryStarted).toBe(true), {
          timeout: 10_000,
        });
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
        { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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
          { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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

  it.each(['hosted-workspace-files/1', 'hosted-workspace-files/2'])(
    'pins %s through create and load and advertises glob',
    async (toolProfile) => {
      const body = {
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
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
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(createDeclarations).toEqual([
        'read_file',
        'write_file',
        'edit',
        'web_fetch',
        'glob',
        'ask_user_question',
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
            toolProfile:
              toolProfile === 'hosted-workspace-files/1'
                ? 'hosted-workspace-files/2'
                : 'hosted-workspace-files/1',
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
        { timeout: settleTimeoutMs() },
      );
      expect(resumedDeclarations).toEqual([
        'read_file',
        'write_file',
        'edit',
        'web_fetch',
        'glob',
        'ask_user_question',
      ]);
      expect(state.model).toHaveBeenCalledTimes(2);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        loaded.body.clientId as string,
      );
    },
  );

  it('rejects the removed Shell profile on creation and load', async () => {
    const server = await app(true);
    for (const route of ['/session', `/session/${SESSION_ID}/load`]) {
      const response = await headers(supertest(server).post(route)).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/2',
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('hosted_tool_profile_unavailable');
    }
    expect(state.model).not.toHaveBeenCalled();
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
    // Captured here and asserted after the Turn: an assertion inside the
    // model mock fails only the Turn, which the test would not see.
    let firstDeclarations: string[] | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn }) => {
      firstDeclarations = (
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
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(firstDeclarations).toEqual([
      'read_file',
      'write_file',
      'edit',
      'web_fetch',
      'run_shell_command',
      'glob',
      'todo_write',
      // H4b: a Shell-laned root Session advertises its Agent tool,
      // and (H4d-b) messages the child tasks it launched.
      'agent',
      // H4e-b1: with the team domains enabled, so are its team tools.
      'team_create',
      'team_delete',
      // H4e-b3a: the lead stops a member itself.
      'request_shutdown',
      'task_create',
      'task_update',
      'task_list',
      'send_message',
      // #13803: and, behind its own kind gate, its Workflow tool.
      'workflow',
      'ask_user_question',
    ]);
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
      { timeout: settleTimeoutMs() },
    );
    expect(resumedDeclarations).toEqual([
      'read_file',
      'write_file',
      'edit',
      'web_fetch',
      'run_shell_command',
      'glob',
      'todo_write',
      // H4b: a Shell-laned root Session advertises its Agent tool,
      // and (H4d-b) messages the child tasks it launched.
      'agent',
      // H4e-b1: with the team domains enabled, so are its team tools.
      'team_create',
      'team_delete',
      // H4e-b3a: the lead stops a member itself.
      'request_shutdown',
      'task_create',
      'task_update',
      'task_list',
      'send_message',
      // #13803: and, behind its own kind gate, its Workflow tool.
      'workflow',
      'ask_user_question',
    ]);
    expect(state.model).toHaveBeenCalledTimes(2);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      loaded.body.clientId as string,
    );
  });

  it.each([
    'member',
    'child',
    'assistant-member',
    'assistant-child',
    'hook',
    'member-bob',
    'member-broadcast',
  ] as const)(
    'preserves the real model/record boundary for send_message: %s (#14062)',
    async (mode) => {
      await enforceInlineResourceLimit();
      const errors = vi.spyOn(stdio, 'writeStderrLineSafe');
      const member = mode !== 'child' && mode !== 'assistant-child';
      const assistantOverflow = mode.startsWith('assistant-');
      const commandLane = mode === 'member-bob' || mode === 'member-broadcast';
      const to =
        mode === 'member-bob'
          ? 'bob'
          : mode === 'member-broadcast'
            ? '*'
            : 'parent';
      const runCommand = HostedSessionCommandSession.prototype.runCommand;
      const commandCalls = vi
        .spyOn(HostedSessionCommandSession.prototype, 'runCommand')
        .mockImplementation(async function (
          this: HostedSessionCommandSession,
          params,
        ) {
          await runCommand.call(this, params);
          await this.handover(params.commandId, BOOT_ID);
          await this.answered(params.commandId, {
            outcome: 'answered',
            text: 'Scripted leader accepted the short message.',
          });
        });
      const dense = JSON.stringify(Array.from({ length: 6500 }, () => 'aa'));
      const message = assistantOverflow ? 'x'.repeat(65_400) : dense;
      const requests: Array<{
        messages: Array<{
          role: string;
          content?: unknown;
          tool_call_id?: string;
        }>;
      }> = [];
      const modelServer = createServer(async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        const round = requests.length;
        const delta =
          round <= 2
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: round === 1 ? 'call-dense' : 'call-retry',
                    type: 'function',
                    function: {
                      name: 'send_message',
                      arguments: JSON.stringify({
                        to,
                        message:
                          round === 2
                            ? 'shorter'
                            : mode === 'hook'
                              ? 'original'
                              : message,
                      }),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: 'RECOVERED_14062' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'issue-14062',
            choices: [{ index: 0, delta, finish_reason: null }],
          })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'issue-14062',
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: round <= 2 ? 'tool_calls' : 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
      listeners.add(modelServer);
      await new Promise<void>((resolve) =>
        modelServer.listen(0, '127.0.0.1', resolve),
      );
      const address = modelServer.address();
      if (!address || typeof address === 'string')
        throw new Error('No model address');
      const configDir = path.join(state.root, 'config');
      await mkdir(configDir);
      await writeFile(
        path.join(configDir, 'settings.json'),
        JSON.stringify({
          security: { auth: { selectedType: 'openai' } },
          model: { name: 'issue-14062' },
          telemetry: { enabled: false },
          modelProviders: {
            openai: [
              {
                id: 'issue-14062',
                envKey: 'OPENAI_API_KEY',
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                generationConfig: { contextWindowSize: 131_072 },
              },
            ],
          },
        }),
      );
      vi.stubEnv('QWEN_HOME', configDir);
      vi.stubEnv('QWEN_RUNTIME_DIR', path.join(state.root, 'model-runtime'));
      vi.stubEnv('OPENAI_API_KEY', 'test-key');
      vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${address.port}/v1`);
      vi.stubEnv('OPENAI_MODEL', 'issue-14062');
      vi.stubEnv('QWEN_MODEL', 'issue-14062');
      try {
        vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'release',
        ).mockResolvedValue();
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
          'activeHoldRuntimeSessionIds',
        ).mockResolvedValue([]);
        const hookOutput = {
          hookSpecificOutput: {
            hookEventName: HookEventName.PreToolUse,
            updatedInput: { to: 'parent', message: dense },
          },
        };
        const hookResult = {
          success: true,
          outcome: 'success' as const,
          duration: 0,
          output: hookOutput,
        };
        expect(Buffer.byteLength(JSON.stringify(hookResult))).toBeLessThan(
          60 * 1024,
        );
        expect(
          Buffer.byteLength(JSON.stringify({ output: hookOutput })),
        ).toBeLessThan(60 * 1024);
        let rewrites = 0;
        if (mode === 'hook') {
          vi.spyOn(
            HostedWorkspaceBroker.prototype,
            'authorizeLifecycle',
          ).mockResolvedValue();
          vi.spyOn(
            HostedWorkspaceBroker.prototype,
            'hookControl',
          ).mockImplementation(async (operation) => {
            if (operation.kind === 'hook-catalog')
              return {
                operationId: operation.operationId,
                state: 'settled',
                catalog: {
                  ...operation.pin,
                  hooks: [
                    {
                      hookId: 'rewrite',
                      eventName: HookEventName.PreToolUse,
                      sequential: false,
                      async: false,
                      failClosed: true,
                      onceKey: null,
                      config: { type: 'command' },
                    },
                  ],
                },
              };
            return {
              operationId: operation.operationId,
              state: 'settled',
              result:
                operation.kind === 'hook-execute' && rewrites++ === 0
                  ? hookResult
                  : { success: true, outcome: 'success', duration: 0 },
            };
          });
        }
        const actual = await vi.importActual<
          typeof import('./hosted-harness-model.js')
        >('./hosted-harness-model.js');
        state.model.mockImplementationOnce(async (input) =>
          actual.runHostedHarnessTextTurn({
            ...input,
            resumeFromToolResults: undefined,
            sessionId: SESSION_ID,
            cwd: state.root,
            history: [],
            prompt: 'Send the message, shorten after refusal.',
            promptId: PROMPT_ID,
          }),
        );
        const server = await app(true);
        const created = await headers(supertest(server).post('/session'))
          .send({
            sessionId: SESSION_ID,
            sessionScope: 'thread',
            managedSessionStore: store(),
            toolProfile: 'hosted-workspace-shell/1',
            approvalMode: 'yolo',
            lineage: {
              parentSessionId: BOOT_ID,
              rootSessionId: BOOT_ID,
              parentChildRunId: 'run-leaf',
              depth: 1,
            },
            ...(mode === 'hook' ? { hookCatalog: hookPin } : {}),
          })
          .expect(200);
        const authorize = (request: supertest.Test) =>
          headers(request).set(
            'X-Qwen-Client-Id',
            created.body.clientId as string,
          );
        const prompt = [
          {
            type: 'text',
            text:
              (member
                ? teamMemberPreamble({ name: 'alice', teamName: 'review' })
                : '') + 'Send the message.',
          },
        ];
        await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .send({
            prompt,
            promptId: PROMPT_ID,
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
          { timeout: 30_000 },
        );
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
        const settlement = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        );
        expect(settlement).toHaveLength(1);
        expect(settlement[0].payload['outcome']).toBe(
          assistantOverflow ? 'error' : 'completed',
        );
        const deliveries = journal.events.filter(
          (event) =>
            event.kind === 'domain.committed' &&
            event.payload['domain'] === 'session_message',
        );
        expect(deliveries).toHaveLength(
          assistantOverflow || commandLane ? 0 : 1,
        );
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'session_command',
          ),
        ).toBe(commandLane);
        const commands =
          (
            commandCalls.mock.contexts[0] as
              | HostedSessionCommandSession
              | undefined
          )?.commands() ?? [];
        if (commandLane) {
          expect(commandCalls).toHaveBeenCalledOnce();
          expect(commandCalls.mock.calls[0][0]).toMatchObject({
            kind: 'member_message',
            args: { to, message: 'shorter' },
          });
          expect(commands).toHaveLength(1);
          expect(commands[0].run.delivery?.state).toBe('consumed');
        } else {
          expect(commandCalls).not.toHaveBeenCalled();
        }
        expect(requests).toHaveLength(assistantOverflow ? 1 : 3);
        if (assistantOverflow)
          expect(errors).toHaveBeenCalledWith(
            expect.stringContaining(
              'Hosted assistant record exceeds the inline Session Store limit.',
            ),
          );
        if (!assistantOverflow) {
          expect(requests[1].messages).toContainEqual(
            expect.objectContaining({
              role: 'tool',
              tool_call_id: 'call-dense',
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'text',
                  text: expect.stringContaining(
                    commandLane
                      ? 'once encoded (byte_limit) although it fits the 32768-byte member wrapper; shorten escape-dense content and retry.'
                      : 'once encoded (byte_limit); shorten the message or other arguments and retry.',
                  ),
                }),
              ]),
            }),
          );
          expect(requests[2].messages).toContainEqual(
            expect.objectContaining({
              role: 'tool',
              tool_call_id: 'call-retry',
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'text',
                  text: expect.stringContaining(
                    commandLane
                      ? 'Scripted leader accepted'
                      : 'queued for delivery',
                  ),
                }),
              ]),
            }),
          );
        }
        const transcript = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        );
        expect(JSON.stringify(transcript.body)).toContain(
          assistantOverflow ? 'hosted_turn_failed' : 'RECOVERED_14062',
        );
        if (mode === 'member') {
          await authorize(
            supertest(server).post(`/session/${SESSION_ID}/detach`),
          ).expect(204);
          const loaded = await headers(
            supertest(server).post(`/session/${SESSION_ID}/load`),
          )
            .send({ managedSessionStore: store() })
            .expect(200);
          const reloaded = await headers(
            supertest(server).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(JSON.stringify(reloaded.body)).toContain(
            'once encoded (byte_limit)',
          );
          expect(JSON.stringify(reloaded.body)).toContain('RECOVERED_14062');
          expect(requests).toHaveLength(3);
          await headers(supertest(server).delete(`/session/${SESSION_ID}`))
            .set('X-Qwen-Client-Id', loaded.body.clientId as string)
            .expect(204);
        } else {
          await authorize(
            supertest(server).delete(`/session/${SESSION_ID}`),
          ).expect(204);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
    60_000,
  );

  it.each(['hosted-workspace-files/1', 'hosted-workspace-shell/1'])(
    'persists the SSH foreground-only surface through resident and cold loads of %s',
    async (profile) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const server = await app(true);
      const surface = async (clientId: string) => {
        let names: Array<string | undefined> = [];
        state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
          const declarations = await toolTurn!.declarations(signal);
          names = declarations.map((tool) => tool.name);
          for (const tool of declarations) {
            if (tool.name === 'run_shell_command') {
              expect(tool.parametersJsonSchema).not.toHaveProperty(
                'properties.is_background',
              );
            }
          }
          return { text: 'ok', model: 'test-model' };
        });
        const prompt = [{ type: 'text', text: randomUUID() }];
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId: randomUUID(),
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
        expect(names).toEqual([
          'read_file',
          'write_file',
          'edit',
          'web_fetch',
          ...(profile.includes('shell') ? ['run_shell_command'] : []),
          'glob',
          ...(profile.includes('shell') ? ['todo_write'] : []),
        ]);
      };
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: profile,
          foregroundOnly: true,
          ...(profile.includes('shell') ? { captureBytes: 1024 * 1024 } : {}),
        })
        .expect(200);
      let clientId = created.body.clientId as string;
      await surface(clientId);
      for (const foregroundOnly of [undefined, true]) {
        await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({
            managedSessionStore: store(),
            passiveManagedRuntimeRecovery: true,
            ...(foregroundOnly === undefined ? {} : { foregroundOnly }),
          })
          .expect(200);
        await surface(clientId);
      }
      await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          foregroundOnly: false,
        })
        .expect(409);
      await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          childWorkspaces: true,
        })
        .expect(409);
      await surface(clientId);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      for (const incompatible of [
        { foregroundOnly: false },
        { childWorkspaces: true },
      ]) {
        await headers(supertest(server).post(`/session/${SESSION_ID}/load`))
          .send({
            managedSessionStore: store(),
            ...incompatible,
          })
          .expect(409);
      }
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
        })
        .expect(200);
      clientId = loaded.body.clientId as string;
      await surface(clientId);
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    },
  );

  it.each([
    { foregroundOnly: 'true' },
    { childWorkspaces: true },
    { mcpServers: [] },
    { hookCatalog: {} },
    { lineage: {} },
    { toolProfile: 'hosted-workspace-mcp/1' },
  ])('refuses incompatible SSH foreground-only creation: %j', async (extra) => {
    const server = await app(true);
    await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        foregroundOnly: true,
        ...extra,
      })
      .expect(400);
    expect(state.model).not.toHaveBeenCalled();
  });

  // #13753 I2: `childWorkspaces` describes the host, not the Session: the
  // create that carries it advertises isolation, and a later load answers
  // whatever that load restates, since nothing persists it.
  it('advertises worktree isolation only while the create or load restates the host capability', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const server = await app(true);
    const isolationOf = async (clientId: string): Promise<boolean> => {
      let declared: boolean | undefined;
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const agent = (await toolTurn!.declarations(signal)).find(
          (tool) => tool.name === 'agent',
        );
        declared =
          'isolation' in
          ((agent?.parametersJsonSchema as { properties?: object })
            ?.properties ?? {});
        return { text: 'ok', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: randomUUID() }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: randomUUID(),
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
      expect(declared).toBeDefined();
      return declared!;
    };
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      childWorkspaces: true,
    });
    expect(created.status).toBe(200);
    expect(await isolationOf(created.body.clientId as string)).toBe(true);
    // A load re-answered from the resident Session restates it too.
    for (const childWorkspaces of [false, true]) {
      const resident = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        passiveManagedRuntimeRecovery: true,
        ...(childWorkspaces ? { childWorkspaces } : {}),
      });
      expect(resident.status).toBe(200);
      expect(resident.body.clientId).toBe(created.body.clientId);
      expect(await isolationOf(resident.body.clientId as string)).toBe(
        childWorkspaces,
      );
    }
    let clientId = created.body.clientId as string;
    for (const childWorkspaces of [undefined, 'true', true]) {
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        ...(childWorkspaces === undefined ? {} : { childWorkspaces }),
      });
      expect(loaded.status).toBe(200);
      clientId = loaded.body.clientId as string;
      expect(await isolationOf(clientId)).toBe(childWorkspaces === true);
    }
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  // #13753 I3: what a prompt's tool turn declares, read from inside it.
  async function declaredDuring(
    server: Parameters<typeof supertest>[0],
    clientId: string,
  ): Promise<{ tools: string[]; isolation?: unknown }> {
    let declared: { tools: string[]; isolation?: unknown } | undefined;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const tools = await toolTurn!.declarations(signal);
      const agent = tools.find((tool) => tool.name === 'agent');
      declared = {
        tools: tools.map((tool) => tool.name!),
        isolation: ((
          agent?.parametersJsonSchema as {
            properties?: Record<string, { enum?: unknown }>;
          }
        )?.properties ?? {})['isolation']?.enum,
      };
      return { text: 'ok', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: randomUUID() }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: randomUUID(),
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
    expect(declared).toBeDefined();
    return declared!;
  }

  // #13753 I3: `childSnapshots` describes the host like `childWorkspaces`,
  // and counts only beside it.
  it('advertises snapshot isolation only while a create or load restates it beside child Workspaces', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      childWorkspaces: true,
      childSnapshots: true,
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    expect((await declaredDuring(server, clientId)).isolation).toEqual([
      'worktree',
      'snapshot',
    ]);
    for (const [flags, isolation] of [
      [{ childWorkspaces: true }, ['worktree']],
      [{ childSnapshots: true }, undefined],
      [{ childWorkspaces: true, childSnapshots: 'true' }, ['worktree']],
      [
        { childWorkspaces: true, childSnapshots: true },
        ['worktree', 'snapshot'],
      ],
    ] as const) {
      const resident = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        passiveManagedRuntimeRecovery: true,
        ...flags,
      });
      expect(resident.status).toBe(200);
      expect((await declaredDuring(server, clientId)).isolation).toEqual(
        isolation,
      );
    }
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  // The read profile is a saved profile: it is created, and its turns
  // declare the two read tools and no Agent tool, whatever the host serves.
  it('serves the read profile with its two read tools', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-read/1',
      approvalMode: 'default',
      childWorkspaces: true,
      childSnapshots: true,
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    expect(await declaredDuring(server, clientId)).toEqual({
      tools: ['read_file', 'glob'],
      isolation: undefined,
    });
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
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
        // The bridge parser refuses cleartext off-loopback unless the
        // descriptor carries the opt-in; the factory refusal is what this
        // test drives to a 400.
        allowInsecureHttp: true,
      },
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe('invalid_managed_session_store');
    expect(created.body.message).toContain('store factory refused');
  });

  it('answers 400 when the bridge parser refuses a cleartext off-loopback store', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: {
        ...store(),
        baseUrl: 'http://rejected-store.test',
      },
    });
    // The bridge parser's own refusal fires before the store factory runs.
    expect(created.status).toBe(400);
    expect(created.body.error).toBe('invalid_managed_session_store');
    expect(created.body.message).toContain(
      'must use HTTPS outside the loopback interface',
    );
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
    expect(refused.body.reason).toBe('restore_verification_failed');
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

  it('clears predispatch partial intent file history before the cancelled terminal', async () => {
    let originalManaged: Awaited<ReturnType<typeof openManagedSession>>;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'original-binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const execute = vi.spyOn(HostedWorkspaceBroker.prototype, 'execute');
    let prepareOrdinal = 0;
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockImplementation(
      async () => {
        if (prepareOrdinal++ === 0) return 'original-execution-1';
        const authority = originalManaged.authority;
        const commandId = `hosted-cancel:${PROMPT_ID}`;
        await authority.appendExecutionEvent(
          {
            operation: 'requestCancel',
            commandId,
            sessionKey: authority.sessionHeader.sessionKey,
            contentDigest: createHash('sha256').update(PROMPT_ID).digest('hex'),
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: commandId,
            sessionKey: authority.sessionHeader.sessionKey,
            kind: 'cancel.requested',
            occurredAt: Date.now(),
            payload: {
              requestId: commandId,
              target: { turnId: PROMPT_ID },
              reason: 'user',
              requestedBy: 'hosted',
            },
          }),
          { class: 'trusted_entry' },
        );
        throw new Error('crash after first prepared intent');
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      originalManaged = (
        toolTurn as unknown as { session: typeof originalManaged }
      ).session;
      const calls = [0, 1].map((ordinal) => ({
        name: 'write_file',
        callId: `original-call-${ordinal}`,
        args: { file_path: `original-${ordinal}.txt`, content: 'original' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      }));
      await toolTurn!.execute(
        calls,
        calls.map((call) => ({
          functionCall: { id: call.callId, name: call.name, args: call.args },
        })),
        'test-model',
        signal,
      );
      return { text: 'never reached', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      approvalMode: 'yolo',
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'write original' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
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
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        });
      },
      { timeout: settleTimeoutMs() },
    );
    const before = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    expect(
      before.events.filter((event) => event.kind === 'tool.intent'),
    ).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .expect(204);
    const replacementServer = await app(true);
    const loaded = await headers(
      supertest(replacementServer).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
    expect(loaded.status).toBe(200);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(replacementServer).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    const after = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const terminals = after.events.filter(
      (event) => event.kind === 'turn.settled',
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0].payload['outcome']).toBe('cancelled');
    expect(state.model).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    await headers(
      supertest(replacementServer).post(`/session/${SESSION_ID}/detach`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
    const nextServer = await app(true);
    const reloaded = await headers(
      supertest(nextServer).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(reloaded.status).toBe(200);
    const nextPromptId = '55555555-5555-4555-8555-555555555555';
    const nextPrompt = [{ type: 'text', text: 'say hello after cancellation' }];
    await headers(supertest(nextServer).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', reloaded.body.clientId)
      .send({
        prompt: nextPrompt,
        promptId: nextPromptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(async () => {
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === nextPromptId,
        ),
      ).toHaveLength(1);
      const status = await headers(
        supertest(nextServer).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', reloaded.body.clientId);
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    expect(state.model).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    await headers(supertest(nextServer).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', reloaded.body.clientId)
      .expect(204);
  });
  it('targets the original active turn when the durable cancel reply arrives late', async () => {
    let originalManaged: Awaited<ReturnType<typeof openManagedSession>>;
    let finishModel!: () => void;
    let releaseCancelAck!: () => void;
    let cancelCommitted = false;
    const modelGate = new Promise<void>((resolve) => {
      finishModel = resolve;
    });
    const cancelAckGate = new Promise<void>((resolve) => {
      releaseCancelAck = resolve;
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    state.model.mockImplementationOnce(async ({ toolTurn }) => {
      originalManaged = (
        toolTurn as unknown as { session: typeof originalManaged }
      ).session;
      await modelGate;
      return { text: 'original answer completed', model: 'test-model' };
    });
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      approvalMode: 'yolo',
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'complete original answer' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(() => expect(originalManaged).toBeDefined());
    const append = originalManaged!.authority.appendExecutionEvent.bind(
      originalManaged!.authority,
    );
    vi.spyOn(
      originalManaged!.authority,
      'appendExecutionEvent',
    ).mockImplementation(async (...args) => {
      const result = await append(...args);
      if (args[0].operation === 'requestCancel') {
        cancelCommitted = true;
        await cancelAckGate;
      }
      return result;
    });
    const cancelResponse = headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId)
      .timeout(settleTimeoutMs())
      .then((response) => response);
    // A preceding assertion can fail before the request is awaited below.
    void cancelResponse.catch(() => {});
    let finishNextModel!: () => void;
    try {
      await vi.waitFor(() => expect(cancelCommitted).toBe(true), {
        timeout: settleTimeoutMs(),
      });
      finishModel();
      await vi.waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      let nextSignal: AbortSignal | undefined;
      const nextModelGate = new Promise<void>((resolve) => {
        finishNextModel = resolve;
      });
      state.model.mockImplementationOnce(async ({ signal }) => {
        nextSignal = signal;
        await nextModelGate;
        return { text: 'next answer completed', model: 'test-model' };
      });
      const nextPrompt = [{ type: 'text', text: 'complete the next answer' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId)
        .send({
          prompt: nextPrompt,
          promptId: randomUUID(),
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(() => expect(nextSignal).toBeDefined());
      releaseCancelAck();
      const cancelled = await cancelResponse;
      expect(cancelled.status).toBe(204);
      expect(nextSignal!.aborted).toBe(false);
      finishNextModel();
      await vi.waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        journal.events.filter((event) => event.kind === 'cancel.requested'),
      ).toHaveLength(1);
      expect(
        journal.events.filter((event) => event.kind === 'turn.settled'),
      ).toHaveLength(2);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', created.body.clientId)
        .expect(204);
    } finally {
      finishModel();
      releaseCancelAck();
      finishNextModel?.();
      await cancelResponse.catch(() => {});
    }
  });

  it.each(['expired', 'cancelled'])(
    'settles a saved final native plan without new inference (%s)',
    async (actionEnd) => {
      let originalManaged: import('@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js').ManagedSession;
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'original-binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      vi.spyOn(HostedApprovalWaiters.prototype, 'wait').mockImplementation(
        async (requestId) => {
          if (actionEnd !== 'cancelled') return;
          const authority = originalManaged.authority;
          const commandId = `hosted-cancel:${PROMPT_ID}`;
          await authority.appendExecutionEvent(
            {
              operation: 'requestCancel',
              commandId,
              sessionKey: authority.sessionHeader.sessionKey,
              contentDigest: createHash('sha256')
                .update(PROMPT_ID)
                .digest('hex'),
            },
            (sequence) => ({
              v: 1,
              sequence,
              eventId: commandId,
              sessionKey: authority.sessionHeader.sessionKey,
              kind: 'cancel.requested',
              occurredAt: Date.now(),
              payload: {
                requestId: commandId,
                target: { turnId: PROMPT_ID },
                reason: 'user',
                requestedBy: 'hosted',
              },
            }),
            { class: 'trusted_entry' },
          );
          await endHostedAction(originalManaged, requestId, 'cancelled');
        },
      );
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      const crash = vi
        .spyOn(ManagedSessionRecordSink.prototype, 'write')
        .mockImplementation(function (this: ManagedSessionRecordSink, record) {
          if (record.type === 'tool_result')
            return Promise.reject(new Error('crash after final plan'));
          return originalWrite.call(this, record);
        });
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        originalManaged = (
          toolTurn as unknown as { session: typeof originalManaged }
        ).session;
        const call = {
          name: 'write_file',
          callId: 'original-call',
          args: { file_path: 'original.txt', content: 'original' },
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
        return { text: 'never reached', model: 'test-model' };
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
        approvalMode: 'default',
        approvalTimeoutMs: 1000,
      });
      expect(created.status).toBe(200);
      const prompt = [{ type: 'text', text: 'write original' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId)
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
          ).set('X-Qwen-Client-Id', created.body.clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', created.body.clientId)
        .expect(204);
      crash.mockRestore();
      const replacementServer = await app(true);
      const loaded = await headers(
        supertest(replacementServer).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
      expect(loaded.status).toBe(200);
      await vi.waitFor(
        async () => {
          const journal = await LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
          const terminals = journal.events.filter(
            (event) => event.kind === 'turn.settled',
          );
          expect(terminals).toHaveLength(1);
          expect(terminals[0].payload['outcome']).toBe('cancelled');
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(replacementServer).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId);
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: settleTimeoutMs() },
      );
      await headers(
        supertest(replacementServer).post(`/session/${SESSION_ID}/detach`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId)
        .expect(204);
    },
  );

  it.each([
    { broker: false, toolProfile: undefined, redrive: false },
    { broker: true, toolProfile: undefined, redrive: false },
    { broker: true, toolProfile: 'hosted-workspace-files/1', redrive: false },
    { broker: false, toolProfile: undefined, redrive: true },
  ])(
    'compensates a committed final answer without inference or unowned release (%o)',
    async (scenario) => {
      const withBroker = scenario.broker;
      const prepared = {
        request: {
          model: 'test-model',
          contents: [{ role: 'user', parts: [{ text: 'park me' }] }],
          config: { temperature: 0.3 },
        },
        history: [{ role: 'user', parts: [{ text: 'park me' }] }],
        completedToolCallIds: [],
        routeSelector: 'openai:test-model',
        providerPin: 'a'.repeat(64),
        promptTokensForClamp: 12,
      };
      state.model.mockImplementation(async (input) => {
        const prepare = (
          input as unknown as {
            prepareModel: (
              request: unknown,
              round: number,
              pending: boolean,
              context?: string,
            ) => Promise<
              | import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js').ManagedSessionDurableRef
              | undefined
            >;
          }
        ).prepareModel;
        const ref = await prepare(prepared, 0, false);
        const finish = await input.modelScope!.beginMainAttempt(
          'test-model',
          ref,
        );
        await finish(true, {});
        return { text: 'committed original answer', model: 'test-model' };
      });
      const server = await app(withBroker);
      await parkUnsettledPlainTurn(server, scenario.toolProfile);
      if (!scenario.redrive)
        vi.mocked(
          LocalManagedSessionResourceStore.prototype.publish,
        ).mockRestore();
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockImplementation(async () => {
          throw new Error('no tool profile must not release runtime');
        });
      const replacementServer = await app(withBroker);
      const loaded = await headers(
        supertest(replacementServer).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store(), driveRuntimeRecovery: true });
      expect(loaded.status).toBe(200);
      if (scenario.redrive) {
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(replacementServer).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId);
            expect(status.body).toMatchObject({
              hasActivePrompt: false,
              recoveryBlocked: true,
            });
          },
          { timeout: 15_000, interval: 100 },
        );
        vi.mocked(
          LocalManagedSessionResourceStore.prototype.publish,
        ).mockRestore();
        await headers(
          supertest(replacementServer).post(`/session/${SESSION_ID}/load`),
        )
          .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
          .expect(200);
      }
      await vi.waitFor(
        async () => {
          const journal = await LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
          expect(
            journal.events.filter((event) => event.kind === 'turn.settled'),
          ).toHaveLength(1);
        },
        { timeout: 15_000, interval: 100 },
      );
      expect(state.model).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(replacementServer).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId);
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        },
        { timeout: 15_000, interval: 100 },
      );
      await headers(
        supertest(replacementServer).post(`/session/${SESSION_ID}/detach`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId)
        .expect(204);
    },
  );

  // Parks a plain Session with its Turn unsettled: the settlement's durable
  // write is refused, so the input stays accepted-but-unsettled.
  async function parkUnsettledPlainTurn(
    server: Server,
    toolProfile?: string,
  ): Promise<void> {
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      ...(toolProfile ? { toolProfile } : {}),
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
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: isSlowTestHost() ? 30_000 : 1_000 },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    log.mockRestore();
  }

  it('marks the publication flag not-applicable on a profile-less cold refusal', async () => {
    const server = await app(true);
    await parkUnsettledPlainTurn(server);
    const parked = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
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
    expect(refused.body.reason).toBe('takeover_unsupported');
    // The stderr tag carries exactly the body reason's token, so the two
    // channels of the same refusal never disagree.
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (takeover_unsupported): profile=none broker=ready`,
    );
    const plain = await app();
    const refusedPlain = await headers(
      supertest(plain).post(`/session/${SESSION_ID}/load`),
    ).send(takeover);
    expect(refusedPlain.status).toBe(409);
    expect(refusedPlain.body.code).toBe('hosted_turn_recovery_required');
    expect(refusedPlain.body.reason).toBe('takeover_unsupported');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (takeover_unsupported): profile=none broker=none`,
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
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: isSlowTestHost() ? 30_000 : 1_000 },
    );
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
        { timeout: isSlowTestHost() ? 30_000 : 10_000 },
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
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      // Settlement includes fsync-backed writes and can exceed 1s on busy CI.
      { timeout: settleTimeoutMs() },
    );
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
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      // Settlement includes fsync-backed writes and can exceed 1s on busy CI.
      { timeout: settleTimeoutMs() },
    );
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
      { timeout: settleTimeoutMs() },
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

  it('clears the keepalive timer when backpressure stops the stream', async () => {
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
    await vi.waitFor(async () => {
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.body.events.length).toBeGreaterThan(2);
    });

    // Record every interval the route arms so the assertion can name the
    // keepalive one (15s) rather than the pump one (250ms). The end() spy
    // is a no-op so the response stays open and no 'close' event fires —
    // the leak shape from the finding: stop() is the only teardown that
    // runs, so it must clear both timers.
    const armed: Array<{ handle: unknown; timeout: number | undefined }> = [];
    const originalSetInterval = globalThis.setInterval;
    const intervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(function (
        this: unknown,
        ...args: Parameters<typeof setInterval>
      ) {
        const handle = originalSetInterval.apply(this, args);
        armed.push({ handle, timeout: args[1] });
        return handle;
      } as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const originalWrite = ServerResponse.prototype.write;
    const write = vi
      .spyOn(ServerResponse.prototype, 'write')
      .mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<ServerResponse['write']>
      ) {
        if (typeof args[0] === 'string' && args[0].startsWith('id: ')) {
          originalWrite.apply(this, args);
          return false;
        }
        return originalWrite.apply(this, args);
      });
    const end = vi
      .spyOn(ServerResponse.prototype, 'end')
      .mockImplementation(function (this: ServerResponse) {
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
      expect(stream.headers.get('x-accel-buffering')).toBe('no');
      await vi.waitFor(() => {
        expect(end).toHaveBeenCalledTimes(1);
      });
      const keepalive = armed.filter((entry) => entry.timeout === 15_000);
      expect(keepalive).toHaveLength(1);
      expect(clearSpy.mock.calls.flat()).toContain(keepalive[0]!.handle);
    } finally {
      write.mockRestore();
      end.mockRestore();
      intervalSpy.mockRestore();
      clearSpy.mockRestore();
      abort.abort();
      listener.closeAllConnections();
      // Settle the turn this test started before tearing down: while
      // session.active is set the DELETE below answers 409
      // hosted_turn_active and cannot close the session, so a late
      // resource write from the still-draining turn would race
      // afterEach's recursive rm of the scratch tree. The poll runs only
      // after end() is restored — while the spy swallows it, a status
      // response could never complete.
      const settleDeadline = Date.now() + 10_000;
      for (;;) {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        if (status.body.hasActivePrompt === false) break;
        if (Date.now() > settleDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('persists a safe model API failure across cold transcript replay', async () => {
    const { HostedModelApiError } = await import('./hosted-harness-model.js');
    state.model.mockRejectedValueOnce(
      new HostedModelApiError({
        status: 402,
        message: 'Insufficient Balance token=private-provider-secret',
      }),
    );
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    const expectFailure = async (
      target: Awaited<ReturnType<typeof app>>,
      clientId: string,
    ) => {
      const transcript = await headers(
        supertest(target).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.status).toBe(200);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_error',
            data: expect.objectContaining({
              code: 'model_payment_required',
              message:
                'Model API payment required (HTTP 402). Check the provider account balance and billing before retrying.',
            }),
          }),
        ]),
      );
      expect(JSON.stringify(transcript.body)).not.toContain(
        'private-provider-secret',
      );
    };
    await vi.waitFor(
      () => expectFailure(server, created.body.clientId as string),
      {
        timeout: settleTimeoutMs(),
      },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
    const restarted = await app();
    const loaded = await headers(
      supertest(restarted).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await expectFailure(restarted, loaded.body.clientId as string);
    expect(state.model).toHaveBeenCalledOnce();
    await headers(supertest(restarted).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
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
      { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
    // A contended gate runner stalls this settle past the 1 s default
    // waitFor budget; the wait is healthy, its budget was sized for idle.
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
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
      { timeout: settleTimeoutMs() },
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
    expect(rejected.body.reason).toBe('turn_blocked');
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
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    // The pending turn parked at await_runtime, so the refusal names its
    // blocking conjunct under the published gate tag, not only the gate.
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (file_history_pending): {"pendingTurn":"${PROMPT_ID}","pendingUndo":null,"unsettled":"${PROMPT_ID}","takeover":false,"ground":"phase_await_runtime","groundDetail":null}`,
    );
    log.mockRestore();
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    // The owed mount-handback chain stays alive for up to ~1 min and logs
    // a line per failed attempt; chains owned by other tests' blocked
    // turns legitimately appear here between tests. The settled cancelled
    // turn itself remains the only thing in scope: nothing else may log.
    expect(
      log.mock.calls.filter(
        (args) =>
          !String(args[0]).includes(
            'could not release the Workspace mount after its recovery block',
          ),
      ),
    ).toEqual([]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('reports a deadline-exceeded turn as a classified failure, not a cancellation', async () => {
    vi.spyOn(stdio, 'writeStderrLineSafe').mockImplementation(() => {});
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    state.model.mockImplementationOnce(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
          modelStarted();
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const admitted = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest, deadlineMs: 2000 });
      expect(admitted.status).toBe(202);
      await started;
      expect(state.model).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
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
      { timeout: settleTimeoutMs() },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const settled = saved.events.find(
      (event) => event.kind === 'turn.settled',
    )!;
    expect(settled.payload['outcome']).toBe('error');
    expect(settled.payload['stopReason']).toBe('deadline_exceeded');
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  // Each row carries the transcript code and the journal stopReason as
  // separate columns: an unnamed failure keeps settledTurnOutcome's generic
  // stopReason under the generic turn-failure code, so the two coincide
  // only on the named row (#13800 R2-8).
  it.each([
    // A transport failure is the outage #13800 names: the transcript code
    // and the journal stopReason both carry the store's name.
    [
      'a Session store transport failure',
      () => new ManagedSessionStoreTransportError('store flap'),
      'managed_session_store_unavailable',
      'managed_session_store_unavailable',
    ],
    // A bounded tenant-guard wait: the store answered promptly with a
    // retryable contention refusal, so it was never unavailable.
    [
      'a contended tenant guard',
      () =>
        new ManagedSessionStoreHttpError(503, 'tenant_guard_contended', 'held'),
      'hosted_turn_failed',
      'error',
    ],
    // A per-Session refusal keeps its own name, never the outage's.
    [
      'a writer conflict',
      () =>
        new ManagedSessionStoreHttpError(
          409,
          'managed_session_writer_conflict',
          'another writer holds the lease',
        ),
      'hosted_turn_failed',
      'error',
    ],
  ])('classifies a store failure: %s', async (_, failure, code, stopReason) => {
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
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(rejectWrite).toBeDefined());
    rejectWrite?.(failure());
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
              data: expect.objectContaining({ code }),
            }),
          ]),
        );
      },
      { timeout: settleTimeoutMs() },
    );
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const settled = saved.events.find(
      (event) => event.kind === 'turn.settled',
    )!;
    expect(settled.payload['outcome']).toBe('error');
    expect(settled.payload['stopReason']).toBe(stopReason);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  function capturedWakeSession() {
    return (
      wakeDeps.last as {
        session: {
          managed: Awaited<ReturnType<typeof openManagedSession>>;
          admissions: Map<string, { digest: string; lastEventId: number }>;
          runtimeLeaseHeld?: { promptId: string; runtimeSessionId: string };
          runtimeLeaseOwedByTerminalRoute?: boolean;
          blocked: boolean;
          cleanupBlocked?: boolean;
          hooksBusy?: boolean;
          recoveredTurn?: string;
          mcpClosing?: boolean;
          monitorWake?: HostedMonitorWakeScheduler;
        };
      }
    ).session;
  }

  async function recoveryFileSession(toolProfile = 'hosted-workspace-files/1') {
    mockBrokerBroker();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
        approvalMode: 'yolo',
      })
      .expect(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId);
    const prompt = [{ type: 'text', text: 'original' }];
    const submit = (deadlineMs?: number) =>
      authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          ...(deadlineMs ? { deadlineMs } : {}),
        })
        .expect(202);
    const status = () =>
      authorize(supertest(server).get(`/session/${SESSION_ID}/status`)).expect(
        200,
      );
    const idle = () =>
      vi.waitFor(
        async () => expect((await status()).body.hasActivePrompt).toBe(false),
        { timeout: settleTimeoutMs() },
      );
    const resident = capturedWakeSession();
    const owe = async (promptId = PROMPT_ID) => {
      const broker = new HostedWorkspaceBroker(
        { baseUrl: 'http://127.0.0.1:1', token: 'test' },
        resident.managed.authority.sessionHeader.sessionKey,
        hostedRuntimeSessionId(promptId),
      );
      broker.runtime = {
        bindingId: 'binding',
        generation: '1',
        workspaceGeneration: '1',
      };
      await oweHostedTurnCleanup(resident.managed, promptId, broker);
    };
    return { server, authorize, submit, status, idle, resident, owe };
  }

  it.each(['DELETE', 'lifecycle'] as const)(
    'keeps terminal cleanup owed until %s drain really releases its owner',
    async (exit) => {
      const toolProfile =
        exit === 'lifecycle'
          ? 'hosted-workspace-shell/1'
          : 'hosted-workspace-files/1';
      const f = await recoveryFileSession(toolProfile);
      await f.submit();
      await f.idle();
      f.resident.monitorWake?.close();
      await f.owe();
      const cleanupStates = () =>
        f.resident.managed.authority
          .eventsInSequenceRange(
            1,
            f.resident.managed.authority.committedSequence,
          )
          .filter((event) => event.kind === 'hosted.cleanup')
          .map((event) => event.payload['state']);
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      release.mockRejectedValueOnce(
        new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
      );
      const authority = { operationId: 'close-drain', claimGeneration: 1 };
      const close = () =>
        exit === 'DELETE'
          ? f.authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
          : f
              .authorize(
                supertest(f.server).post(`/session/${SESSION_ID}/lifecycle`),
              )
              .send({
                protocolVersion: 2,
                phase: 'settle_resources',
                kind: 'close',
                toolProfile,
                sessionKey:
                  f.resident.managed.authority.sessionHeader.sessionKey,
                authority,
              });
      await close().expect(503);
      expect(release).toHaveBeenCalledExactlyOnceWith({
        bindingId: 'binding',
        generation: '1',
        drain: true,
      });
      expect(cleanupStates()).toEqual(['owed']);
      expect(f.resident.managed.authority.writerSealed).toBe(false);

      await close().expect(exit === 'DELETE' ? 204 : 200);
      expect(release).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenLastCalledWith({
        bindingId: 'binding',
        generation: '1',
        drain: true,
      });
      expect(cleanupStates()).toEqual(['owed', 'confirmed']);
      if (exit === 'lifecycle')
        await f
          .authorize(supertest(f.server).post(`/session/${SESSION_ID}/detach`))
          .send({ authority })
          .expect(204);
    },
  );

  it.each([false, true])(
    'keeps a later active Turn safe from a delayed original cancellation (public children: %s)',
    async (publicChildren) => {
      if (publicChildren) mockBrokerBroker();
      const server = await app(publicChildren);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          ...(publicChildren
            ? {
                toolProfile: 'hosted-workspace-shell/1',
                approvalMode: 'yolo',
                publicChildAgentsVersion: 1,
              }
            : {}),
        })
        .expect(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set('X-Qwen-Client-Id', created.body.clientId);
      const idle = () =>
        vi.waitFor(
          async () => {
            const status = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            ).expect(200);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
      const prompt = [{ type: 'text', text: 'original' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await idle();
      const attached = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          passiveManagedRuntimeRecovery: true,
          ...(publicChildren
            ? {
                toolProfile: 'hosted-workspace-shell/1',
                publicChildAgentsVersion: 1,
              }
            : {}),
        })
        .expect(200);
      expect(attached.body.clientId).toBe(created.body.clientId);
      let laterSignal!: AbortSignal;
      let finishLater!: () => void;
      state.model.mockImplementationOnce(
        ({ signal }) =>
          new Promise((resolve) => {
            laterSignal = signal;
            finishLater = () => resolve({ text: 'later', model: 'test-model' });
            signal.addEventListener('abort', finishLater, { once: true });
          }),
      );
      const later = randomUUID();
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: later, payloadDigest })
        .expect(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(2), {
        timeout: settleTimeoutMs(),
      });
      const cancel = (promptId: unknown) =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/cancel`)).send(
          {
            promptId,
          },
        );
      try {
        await cancel(PROMPT_ID).expect(204);
        expect(laterSignal.aborted).toBe(false);
        await cancel(randomUUID()).expect(409);
        await cancel(null).expect(400);
        expect(laterSignal.aborted).toBe(false);
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).expect(200);
        expect(status.body.hasActivePrompt).toBe(true);
        await cancel(later).expect(204);
        expect(laterSignal.aborted).toBe(true);
      } finally {
        finishLater();
      }
      await idle();
      await cancel(PROMPT_ID).expect(204);
      await cancel(later).expect(204);
      const saved = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        saved.events
          .filter((event) => event.kind === 'cancel.requested')
          .map((event) => event.payload['target']),
      ).toEqual([
        ...(publicChildren ? [{ turnId: PROMPT_ID }] : []),
        { turnId: later },
      ]);
      expect(state.model).toHaveBeenCalledTimes(2);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );
});
