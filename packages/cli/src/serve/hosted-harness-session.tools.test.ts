/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Part } from '@google/genai';
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
import * as modelRecovery from './hosted-model-recovery.js';
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
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { WorkflowStartCancelledError } from '@qwen-code/qwen-code-core/agents/runtime/workflow-runner.js';
import { channelInputId } from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import { HostedChannelSession } from './hosted-channel-session.js';
import { HostedMcpManager } from './hosted-mcp-settings.js';
import { commitHostedFileHistory } from './hosted-file-history.js';
import { oweHostedTurnCleanup } from './hosted-turn-cleanup.js';
import {
  LlmRequestPreparationError,
  type LlmPreparedRequest,
} from '@qwen-code/qwen-code-core/core/llm-chat.js';
import type {
  ManagedMcpControl,
  ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import {
  assertManagedSessionDurableRef,
  ManagedSessionAppendUnsettledError,
  ManagedSessionRecordError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import { HostedHookSession } from './hosted-hook-session.js';
import { HostedMcpSession } from './hosted-mcp-session.js';
import { installAccessLogMiddleware } from './server/access-log.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import { MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST } from './managed-extension-profile.js';
import {
  HostedToolRecoveryRequiredError,
  hostedRuntimeSessionId,
  HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
import { HostedModelUnavailableError } from './hosted-agent-definition.js';
import {
  HOSTED_APPROVAL_TIMEOUT_MS,
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  endHostedAction,
  readHostedActionOptions,
  resolveHostedAction,
} from './hosted-tool-approval.js';
import * as stdio from '../utils/stdioHelpers.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import { createSettleTimeout } from '../test-utils/settle-timeout.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import type {
  ManagedHookCatalog,
  ManagedHookControl,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedAutomationSession } from './hosted-automation-session.js';
import { AUTOMATION_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';
import { recoverHostedRuntimeTurn } from './hosted-runtime-recovery.js';
import { createMonitorWakeRunTurn } from './hosted-monitor-wake-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedTeamSession } from './hosted-team-session.js';
import { teamMemberPreamble } from './hosted-member-chain.js';
import { findHostedApprovalContinuation } from './hosted-approval-continuation.js';
import { HOSTED_QUESTION_POLICY } from './hosted-user-question.js';

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

/**
 * Parks a Turn that drove nothing durable: the model refuses before any
 * file-history prepare, leaving only the unsettled input in the journal.
 */
async function parkBlockedTextTurn(profile: boolean) {
  const server = await app(true);
  const created = await headers(supertest(server).post('/session')).send({
    sessionId: SESSION_ID,
    sessionScope: 'thread',
    managedSessionStore: store(),
    ...(profile ? { toolProfile: 'hosted-workspace-files/1' } : {}),
  });
  expect(created.status).toBe(200);
  const clientId = created.body.clientId as string;
  state.model.mockRejectedValueOnce(
    new HostedToolRecoveryRequiredError(new Error('store gone')),
  );
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
      expect(status.body.hasActivePrompt).toBe(false);
    },
    { timeout: settleTimeoutMs() },
  );
  await headers(supertest(server).delete(`/session/${SESSION_ID}`));
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

  const AUTOMATION_ID = `asch_${'1'.repeat(32)}`;
  const AUTOMATION_SLOT = 'schedule:2026-03-08T07:00:00Z';
  const automationDefinition = {
    goal: 'Nightly build',
    cron: '0 2 * * *',
    timezone: 'Asia/Shanghai',
    prompt: 'Run the build.',
  };

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

  /**
   * A channel turn died inside write_file, leaving an await_runtime
   * checkpoint and file_history.pendingTurn. Shared by the attachment
   * and the transient-retry witnesses.
   */
  async function prewriteChannelWriteInterruption(
    cleanupDebt = false,
    previousPromptId?: string,
    interruption: 'runtime' | 'queued' | 'approval' = 'runtime',
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
              toolProfile: 'hosted-workspace-files/1',
              ...(cleanupDebt || previousPromptId
                ? {}
                : { hookCatalog: hookPin }),
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

      if (previousPromptId) {
        const content = Buffer.from(
          JSON.stringify([{ type: 'text', text: 'prior completed turn' }]),
        );
        await managed.authority.submitInput(
          {
            operation: 'submitInput',
            commandId: previousPromptId,
            sessionKey: key,
            contentDigest: createHash('sha256').update(content).digest('hex'),
          },
          {
            inputId: previousPromptId,
            turnId: previousPromptId,
            source: 'hosted-harness',
            contentRef: await resources.publish('managed-input', content),
            admissionRef: await resources.publish(
              'managed-admission',
              Buffer.from('{}'),
            ),
            deadline: null,
            wakeReason: 'input',
          },
        );
        await createManagedHarnessHandle(managed).ensureRunnable();
        await managed.sink.write({
          uuid: `${previousPromptId}:terminal`,
          parentUuid: null,
          sessionId: SESSION_ID,
          timestamp: new Date().toISOString(),
          type: 'system',
          subtype: 'turn_result',
          cwd: state.root,
          version: 'hosted-harness/1',
          daemonPromptId: previousPromptId,
          systemPayload: {
            promptId: previousPromptId,
            state: 'completed',
            stopReason: 'end_turn',
            endedAt: Date.now(),
          },
        } as ChatRecord);
      }
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
      if (interruption === 'queued') return channelTurn;
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
      if (interruption === 'approval') {
        const requestId = 'channel-recovery-approval';
        const invocationRef = await resources.publish(
          'managed-tool-input',
          Buffer.from('{}'),
        );
        const now = Date.now();
        const optionsRef = await resources.publish(
          'managed-action-options',
          Buffer.from(
            JSON.stringify({
              v: 1,
              requestId,
              turnId: channelTurn,
              functionCallId: 'approval-call',
              toolName: 'write_file',
              policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
              inputRevision: 1,
              createdAt: now,
              expiresAt: now + 600_000,
              options: [
                { id: 'allow', label: 'Allow' },
                { id: 'deny', label: 'Deny' },
              ],
            }),
          ),
        );
        await harness.commitDurableWait(
          {
            requestId,
            kind: 'permission',
            source: 'tool_call',
            optionsRef,
            inputRevision: '1',
            invocationRef,
            attemptId: 'approval-attempt',
            routeRef: invocationRef,
          },
          { turnId: channelTurn, promptId: channelTurn },
        );
        return channelTurn;
      }
      if (cleanupDebt) {
        const broker = new HostedWorkspaceBroker(
          { baseUrl: 'http://127.0.0.1:1', token: 'test' },
          key,
          channelTurn,
        );
        broker.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
        await oweHostedTurnCleanup(managed, channelTurn, broker);
      }
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

  it('refuses a targeted cancel for an original parked Turn without aborting or driving it', async () => {
    const f = await recoveryFileSession();
    state.model.mockRejectedValueOnce(new LlmRequestPreparationError('parked'));
    await f.submit();
    await f.idle();
    const response = await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/cancel`))
      .send({ promptId: PROMPT_ID })
      .expect(409);
    expect(response.body.code).toBe('hosted_turn_recovery_required');
    expect(state.model).toHaveBeenCalledOnce();
    const authority = f.resident.managed.authority;
    expect(
      authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .filter((event) => event.kind === 'cancel.requested'),
    ).toEqual([]);
  });

  it.each([false, true])(
    'refuses a delayed original cancellation load for a later parked input (cold: %s)',
    async (cold) => {
      const f = await recoveryFileSession();
      await f.submit();
      await f.idle();
      const later = randomUUID();
      const prompt = [{ type: 'text', text: 'later parked input' }];
      state.model.mockRejectedValueOnce(
        new LlmRequestPreparationError('parked'),
      );
      await f
        .authorize(supertest(f.server).post(`/session/${SESSION_ID}/prompt`))
        .send({
          prompt,
          promptId: later,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await f.idle();
      f.resident.recoveredTurn = later;
      await f.owe(later);
      f.resident.monitorWake?.close();
      if (cold) await f.resident.managed.close();
      const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
      releases.mockClear();
      vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
      vi.mocked(HostedWorkspaceBroker.prototype.warm).mockClear();
      const server = cold ? await app(true) : f.server;
      const response = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          passiveManagedRuntimeRecovery: true,
          cancellationTakeover: true,
          cancellationPromptId: PROMPT_ID,
        })
        .expect(409);
      expect(response.body.code).toBe('hosted_cancel_identity_mismatch');
      expect(
        response.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
      ).toBeUndefined();
      expect(response.body.clientId).toBeUndefined();
      expect(f.resident.recoveredTurn).toBe(later);
      expect(releases).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.warm).not.toHaveBeenCalled();
      expect(state.model).toHaveBeenCalledTimes(2);
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
        saved.events.some(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === later,
        ),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    'settles only the original parked input when a later wake-owned input is queued (cold: %s)',
    async (cold) => {
      const f = await recoveryFileSession();
      state.model.mockRejectedValueOnce(
        new LlmRequestPreparationError('parked'),
      );
      await f.submit();
      await f.idle();
      f.resident.monitorWake?.close();
      const managed = f.resident.managed;
      const key = managed.authority.sessionHeader.sessionKey;
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
      const queued = await automations.fire({
        scheduleId: AUTOMATION_ID,
        definitionRevision: 1,
        occurrenceKey: AUTOMATION_SLOT,
        trigger: 'scheduled',
        firedAt: Date.now(),
      });
      const originalRun = managed.authority.extensionRecord(
        'automation_run',
        queued.run!.automationRunId,
      );
      expect(originalRun).toBeDefined();
      const before = managed.authority.eventsInSequenceRange(
        1,
        managed.authority.committedSequence,
      );
      expect(
        before.findLast((event) => event.kind === 'input.accepted')?.payload,
      ).toMatchObject({
        turnId: queued.inputId,
        source: AUTOMATION_INPUT_SOURCE,
      });
      expect(
        before.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
      ).toBe(false);
      // Observe this cancellation request separately from the independent queued-input pump.
      vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
        function (this: HostedMonitorWakeScheduler) {
          this.close();
        },
      );
      if (cold) await managed.close();
      const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
      const warm = vi.mocked(HostedWorkspaceBroker.prototype.warm);
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      const cancel = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'cancel')
        .mockResolvedValue();
      acquire.mockClear();
      warm.mockClear();
      release.mockClear();
      const server = cold ? await app(true) : f.server;
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          passiveManagedRuntimeRecovery: true,
          cancellationTakeover: true,
          cancellationPromptId: PROMPT_ID,
        })
        .expect(200);
      expect(
        loaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
      ).toBeUndefined();
      const current = cold ? capturedWakeSession() : f.resident;
      current.monitorWake?.close();
      const authority = current.managed.authority;
      const after = authority.eventsInSequenceRange(
        1,
        authority.committedSequence,
      );
      expect(
        after
          .filter((event) => event.kind === 'turn.settled')
          .map((event) => ({
            turnId: event.payload['turnId'],
            outcome: event.payload['outcome'],
          })),
      ).toEqual([{ turnId: PROMPT_ID, outcome: 'cancelled' }]);
      expect(
        after.some(
          (event) =>
            event.kind === 'cancel.requested' &&
            (event.payload['target'] as { turnId?: string } | undefined)
              ?.turnId === queued.inputId,
        ),
      ).toBe(false);
      expect(
        authority.extensionRecord(
          'automation_run',
          queued.run!.automationRunId,
        ),
      ).toEqual(originalRun);
      expect(state.model).toHaveBeenCalledOnce();
      expect(state.model.mock.calls[0]?.[0].promptId).toBe(PROMPT_ID);
      expect(cancel).not.toHaveBeenCalled();
      for (const broker of [
        ...acquire.mock.contexts,
        ...warm.mock.contexts,
        ...release.mock.contexts,
      ]) {
        expect((broker as HostedWorkspaceBroker).runtimeSessionId).not.toBe(
          hostedRuntimeSessionId(queued.inputId),
        );
      }
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', loaded.body.clientId)
        .expect(204);
    },
  );

  it.each([false, true])(
    'holds the original cancellation load gate across its await and releases it after settlement (failure: %s)',
    async (failSettlement) => {
      const f = await recoveryFileSession();
      state.model.mockRejectedValueOnce(
        new LlmRequestPreparationError('parked'),
      );
      await f.submit();
      await f.idle();
      const original =
        f.resident.managed.authority.harnessRunAuthorization.bind(
          f.resident.managed.authority,
        );
      let entered!: () => void;
      let release!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const authorization = vi
        .spyOn(f.resident.managed.authority, 'harnessRunAuthorization')
        .mockImplementationOnce(async () => {
          entered();
          await gate;
          return original();
        });
      if (failSettlement)
        authorization.mockRejectedValueOnce(new Error('settle unavailable'));
      const loading = headers(
        supertest(f.server).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          passiveManagedRuntimeRecovery: true,
          cancellationTakeover: true,
          cancellationPromptId: PROMPT_ID,
        })
        .then((response) => response);
      try {
        await entering;
        expect(f.resident.hooksBusy).toBe(true);
        if (!failSettlement) {
          await f.resident.managed.sink.write({
            uuid: randomUUID(),
            parentUuid: null,
            sessionId: SESSION_ID,
            timestamp: new Date().toISOString(),
            type: 'system',
            subtype: 'turn_result',
            cwd: state.root,
            version: 'hosted-harness/1',
            daemonPromptId: PROMPT_ID,
            systemPayload: {
              promptId: PROMPT_ID,
              state: 'cancelled',
              stopReason: 'cancelled',
              endedAt: Date.now(),
            },
          } as ChatRecord);
          f.resident.blocked = false;
        }
        const prompt = [{ type: 'text', text: 'must wait for original load' }];
        const rejected = await f
          .authorize(supertest(f.server).post(`/session/${SESSION_ID}/prompt`))
          .send({
            prompt,
            promptId: randomUUID(),
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(409);
        expect(rejected.body.code).toBe('hosted_hook_operation_active');
        expect(state.model).toHaveBeenCalledOnce();
      } finally {
        release();
      }
      const loaded = await loading;
      expect(loaded.status).toBe(failSettlement ? 409 : 200);
      expect(f.resident.hooksBusy).toBe(false);
      expect(state.model).toHaveBeenCalledOnce();
      const events = f.resident.managed.authority.eventsInSequenceRange(
        1,
        f.resident.managed.authority.committedSequence,
      );
      expect(
        events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
      ).toBe(!failSettlement);
      if (!failSettlement) {
        const prompt = [{ type: 'text', text: 'after original load' }];
        await f
          .authorize(supertest(f.server).post(`/session/${SESSION_ID}/prompt`))
          .send({
            prompt,
            promptId: randomUUID(),
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          })
          .expect(202);
        await f.idle();
        expect(state.model).toHaveBeenCalledTimes(2);
      }
    },
  );

  it('uses only cleanup attachment when the original cancellation load finds a terminal input after restart', async () => {
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    await f.owe();
    f.resident.monitorWake?.close();
    await f.resident.managed.close();
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockClear();
    neverStartedReconcile.fn.mockClear();
    const kick = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick');
    kick.mockClear();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
        cancellationPromptId: PROMPT_ID,
      })
      .expect(200);
    expect(loaded.body.recoveryCleanupOnly).toBe(true);
    expect(
      loaded.body._meta?.['qwen.daemon.managedRuntimeRecovery'],
    ).toBeUndefined();
    expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.warm).not.toHaveBeenCalled();
    expect(neverStartedReconcile.fn).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
    expect(state.model).toHaveBeenCalledOnce();
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
  });

  const recoveryReplayCases = [
    ['cancel', 'admitted'],
    ['cancel', 'settled'],
    ['continue', 'admitted'],
    ['continue', 'settled'],
  ] as const;

  it.each(recoveryReplayCases)(
    'keeps a later parked input and its held Runtime untouched by an original %s %s replay',
    async (route, replay) => {
      const f = await recoveryFileSession();
      await f.submit();
      await f.idle();
      f.resident.monitorWake?.close();
      const authority = f.resident.managed.authority;
      const checkpointId = 'original-checkpoint';
      const activationId = 'original-activation';
      if (replay === 'admitted')
        f.resident.admissions.set(PROMPT_ID, {
          digest: `recovery:${checkpointId}:${activationId}`,
          lastEventId: authority.committedSequence,
        });
      else f.resident.admissions.delete(PROMPT_ID);
      const later = randomUUID();
      const bytes = Buffer.from(
        JSON.stringify([{ type: 'text', text: 'later' }]),
      );
      await authority.submitInput(
        {
          operation: 'submitInput',
          commandId: later,
          sessionKey: authority.sessionHeader.sessionKey,
          contentDigest: createHash('sha256').update(bytes).digest('hex'),
        },
        {
          inputId: later,
          turnId: later,
          source: 'hosted-harness',
          contentRef: await f.resident.managed.resources.publish(
            'managed-input',
            bytes,
          ),
          admissionRef: await f.resident.managed.resources.publish(
            'managed-admission',
            Buffer.from('{}'),
          ),
          deadline: null,
          wakeReason: 'input',
        },
      );
      const lease = {
        promptId: later,
        runtimeSessionId: hostedRuntimeSessionId(later),
      };
      f.resident.recoveredTurn = later;
      f.resident.runtimeLeaseHeld = lease;
      f.resident.runtimeLeaseOwedByTerminalRoute = true;
      const before = authority.eventsInSequenceRange(
        1,
        authority.committedSequence,
      );
      expect(before.some((event) => event.kind === 'hosted.cleanup')).toBe(
        false,
      );
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      const response = await f
        .authorize(
          supertest(f.server).post(
            `/session/${SESSION_ID}/managed-runtime/${route}`,
          ),
        )
        .send({ promptId: PROMPT_ID, checkpointId, activationId })
        .expect(200);
      expect(response.body).toMatchObject({
        accepted: true,
        promptId: PROMPT_ID,
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(release).not.toHaveBeenCalled();
      expect(f.resident.runtimeLeaseHeld).toBe(lease);
      expect(f.resident.runtimeLeaseOwedByTerminalRoute).toBe(true);
      expect(f.resident.recoveredTurn).toBe(later);
      expect(
        authority.eventsInSequenceRange(1, authority.committedSequence),
      ).toEqual(before);
      expect(
        before.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
      ).toBe(true);
      expect(
        before.some(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === later,
        ),
      ).toBe(false);
      expect(state.model).toHaveBeenCalledOnce();
    },
  );

  it.each(recoveryReplayCases)(
    'retries only the original held Runtime cleanup on its %s %s replay',
    async (route, replay) => {
      const f = await recoveryFileSession();
      await f.submit();
      await f.idle();
      f.resident.monitorWake?.close();
      const authority = f.resident.managed.authority;
      const checkpointId = 'original-checkpoint';
      const activationId = 'original-activation';
      if (replay === 'admitted')
        f.resident.admissions.set(PROMPT_ID, {
          digest: `recovery:${checkpointId}:${activationId}`,
          lastEventId: authority.committedSequence,
        });
      else f.resident.admissions.delete(PROMPT_ID);
      const lease = {
        promptId: PROMPT_ID,
        runtimeSessionId: hostedRuntimeSessionId(PROMPT_ID),
      };
      f.resident.runtimeLeaseHeld = lease;
      f.resident.runtimeLeaseOwedByTerminalRoute = true;
      const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
      release.mockClear();
      release.mockRejectedValueOnce(
        new Error('original handback is unavailable'),
      );
      const send = () =>
        f
          .authorize(
            supertest(f.server).post(
              `/session/${SESSION_ID}/managed-runtime/${route}`,
            ),
          )
          .send({ promptId: PROMPT_ID, checkpointId, activationId })
          .expect(200);
      await send();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(f.resident.runtimeLeaseHeld).toBe(lease);
      expect(f.resident.runtimeLeaseOwedByTerminalRoute).toBe(true);
      await send();
      await vi.waitFor(() =>
        expect(f.resident.runtimeLeaseHeld).toBeUndefined(),
      );
      expect(f.resident.runtimeLeaseOwedByTerminalRoute).toBe(false);
      expect(release).toHaveBeenCalledTimes(2);
      expect(
        release.mock.contexts.map(
          (broker) => (broker as HostedWorkspaceBroker).runtimeSessionId,
        ),
      ).toEqual([lease.runtimeSessionId, lease.runtimeSessionId]);
      expect(state.model).toHaveBeenCalledOnce();
    },
  );

  it('inspects original recovery evidence and rechecks only terminal cleanup', async () => {
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    await f.owe();
    f.resident.blocked = true;
    f.resident.cleanupBlocked = true;
    const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
    releases.mockClear();
    const read = () =>
      f
        .authorize(
          supertest(f.server).get(
            `/session/${SESSION_ID}/status?promptId=${PROMPT_ID}`,
          ),
        )
        .expect(200);
    expect((await read()).body.recovery).toMatchObject({
      state: 'cleanup_pending',
      promptId: PROMPT_ID,
      inputSettled: true,
      continuationReady: true,
      nextTurnAllowed: false,
    });
    expect(releases).not.toHaveBeenCalled();
    const recheck = () =>
      f
        .authorize(
          supertest(f.server).post(`/session/${SESSION_ID}/recovery/recheck`),
        )
        .send({ promptId: PROMPT_ID })
        .expect(202);
    await Promise.all([recheck(), recheck()]);
    expect((await read()).body.recovery).toMatchObject({
      state: 'ready',
      nextTurnAllowed: true,
    });
    await recheck();
    expect(releases).toHaveBeenCalledOnce();
    f.resident.blocked = true;
    f.resident.cleanupBlocked = true;
    expect((await read()).body.recovery.state).toBe('cleanup_pending');
    await recheck();
    expect((await read()).body.recovery.nextTurnAllowed).toBe(true);
    expect(releases).toHaveBeenCalledOnce();
    expect(releases).toHaveBeenCalledWith({
      bindingId: 'binding',
      generation: '1',
    });
    expect(state.model).toHaveBeenCalledOnce();
  });

  it('refuses recovery cleanup for a different original input', async () => {
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    await f.owe();
    const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
    releases.mockClear();
    const other = randomUUID();
    const status = await f
      .authorize(
        supertest(f.server).get(
          `/session/${SESSION_ID}/status?promptId=${other}`,
        ),
      )
      .expect(200);
    expect(status.body.recovery).toMatchObject({
      state: 'operator_required',
      inputSettled: false,
      nextTurnAllowed: false,
    });
    await f
      .authorize(
        supertest(f.server).post(`/session/${SESSION_ID}/recovery/recheck`),
      )
      .send({ promptId: other })
      .expect(409);
    expect(releases).not.toHaveBeenCalled();
    expect(state.model).toHaveBeenCalledOnce();
  });

  it('keeps a later terminal cleanup latch when rechecking an older input', async () => {
    const f = await recoveryFileSession();
    await f.submit();
    await f.idle();
    const prompt = [{ type: 'text', text: 'later' }];
    const later = randomUUID();
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/prompt`))
      .send({
        prompt,
        promptId: later,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await f.idle();
    f.resident.blocked = true;
    f.resident.cleanupBlocked = true;
    const recheck = (promptId: string) =>
      f
        .authorize(
          supertest(f.server).post(`/session/${SESSION_ID}/recovery/recheck`),
        )
        .send({ promptId })
        .expect(202);
    await recheck(PROMPT_ID);
    expect(f.resident.cleanupBlocked).toBe(true);
    expect(f.resident.blocked).toBe(true);
    await recheck(later);
    expect(f.resident.cleanupBlocked).toBe(false);
    expect(f.resident.blocked).toBe(false);
    expect(state.model).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'reopens only original terminal cleanup across restart (release already observed: %s)',
    async (releasedBeforeRestart) => {
      const f = await recoveryFileSession();
      await f.submit();
      await f.idle();
      await commitHostedFileHistory(f.resident.managed, {
        schemaVersion: 1,
        state: { ownerSessionId: SESSION_ID, snapshots: [], files: {} },
        pendingTurn: PROMPT_ID,
        pendingUndo: null,
      });
      await f.owe();
      const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
      if (releasedBeforeRestart)
        await new HostedWorkspaceBroker(
          { baseUrl: 'http://127.0.0.1:1', token: 'test' },
          f.resident.managed.authority.sessionHeader.sessionKey,
          hostedRuntimeSessionId(PROMPT_ID),
        ).release({ bindingId: 'binding', generation: '1' });
      f.resident.monitorWake?.close();
      await f.resident.managed.close();
      releases.mockClear();
      vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
      vi.mocked(HostedWorkspaceBroker.prototype.warm).mockClear();
      neverStartedReconcile.fn.mockClear();
      const previousWake = wakeDeps.last;
      const kick = vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick');
      kick.mockClear();
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          recoveryCleanupPromptId: PROMPT_ID,
        })
        .expect(200);
      expect(loaded.body.recoveryCleanupOnly).toBe(true);
      const authorize = (request: supertest.Test) =>
        headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
      const status = await authorize(
        supertest(replacement).get(
          `/session/${SESSION_ID}/status?promptId=${PROMPT_ID}`,
        ),
      ).expect(200);
      expect(status.body.recovery).toMatchObject({
        state: 'ready',
        promptId: PROMPT_ID,
        inputSettled: true,
        continuationReady: true,
        nextTurnAllowed: true,
      });
      const history = await authorize(
        supertest(replacement).get(`/session/${SESSION_ID}/files/history`),
      ).expect(200);
      expect(history.body.history.pendingTurn).toBeNull();
      expect(releases).toHaveBeenCalledExactlyOnceWith({
        bindingId: 'binding',
        generation: '1',
      });
      expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.warm).not.toHaveBeenCalled();
      expect(neverStartedReconcile.fn).not.toHaveBeenCalled();
      expect(kick).not.toHaveBeenCalled();
      expect(wakeDeps.last).toBe(previousWake);
      expect(state.model).toHaveBeenCalledOnce();
      await headers(supertest(replacement).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          passiveManagedRuntimeRecovery: true,
          toolProfile: 'hosted-workspace-files/2',
        })
        .expect(409);
      const passive = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({
          managedSessionStore: store(),
          passiveManagedRuntimeRecovery: true,
          toolProfile: 'hosted-workspace-files/1',
        })
        .expect(200);
      expect(passive.body.recoveryCleanupOnly).toBe(true);
      expect(passive.body.clientId).toBe(loaded.body.clientId);
      expect(kick).not.toHaveBeenCalled();
      expect(wakeDeps.last).toBe(previousWake);
      expect(neverStartedReconcile.fn).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
      expect(releases).toHaveBeenCalledOnce();
      expect(state.model).toHaveBeenCalledOnce();
      const prompt = [{ type: 'text', text: 'next turn' }];
      const next = {
        prompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      };
      await authorize(
        supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
      )
        .send(next)
        .expect(409);
      expect(state.model).toHaveBeenCalledOnce();
      const upgraded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      expect(upgraded.body.recoveryCleanupOnly).not.toBe(true);
      expect(upgraded.body.clientId).not.toBe(loaded.body.clientId);
      const ordinary = (request: supertest.Test) =>
        headers(request).set('X-Qwen-Client-Id', upgraded.body.clientId);
      await ordinary(
        supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
      )
        .send(next)
        .expect(202);
      await vi.waitFor(
        async () => {
          const current = await ordinary(
            supertest(replacement).get(
              `/session/${SESSION_ID}/status?promptId=${next.promptId}`,
            ),
          ).expect(200);
          expect(current.body.recovery.nextTurnAllowed).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(2);
      await ordinary(
        supertest(replacement).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it('requires an ordinary load before managing MCP on a cleanup-only Session', async () => {
    const f = await recoveryFileSession('hosted-workspace-shell/1');
    await f.submit();
    await f.idle();
    f.resident.monitorWake?.close();
    await f.resident.managed.close();
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        recoveryCleanupPromptId: PROMPT_ID,
      })
      .expect(200);
    expect(loaded.body.recoveryCleanupOnly).toBe(true);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
    const journal = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
    const before = await journal();
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    acquire.mockClear();
    const control = vi.spyOn(HostedWorkspaceBroker.prototype, 'control');
    const definitions = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'mcpDefinitions')
      .mockResolvedValue([]);
    const route = `/session/${SESSION_ID}/mcp/management`;
    for (const request of [
      authorize(supertest(replacement).get(route)),
      authorize(
        supertest(replacement).get(`${route}/operations/${randomUUID()}`),
      ),
      authorize(supertest(replacement).post(route)).send({
        operationId: randomUUID(),
        actorKey: 'c'.repeat(64),
        action: 'add',
        serverId: 'demo',
        expectedRevision: 0,
        server: {
          serverId: 'demo',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
      }),
      headers(supertest(replacement).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        mcpManagementOnly: true,
      }),
    ]) {
      const refused = await request.expect(409);
      expect(refused.body.code).toBe('hosted_mcp_session_load_required');
    }
    expect(await journal()).toEqual(before);
    expect(acquire).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
    expect(definitions).not.toHaveBeenCalled();
    expect(state.model).toHaveBeenCalledOnce();
    const upgraded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
      .expect(200);
    expect(upgraded.body.recoveryCleanupOnly).not.toBe(true);
    await headers(supertest(replacement).get(route))
      .set('X-Qwen-Client-Id', upgraded.body.clientId)
      .expect(200);
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', upgraded.body.clientId)
      .expect(204);
  });

  it('refuses cold cleanup before the original input is durably settled', async () => {
    const f = await recoveryFileSession();
    state.model.mockRejectedValueOnce(new LlmRequestPreparationError('parked'));
    await f.submit();
    await f.idle();
    await f.owe();
    f.resident.monitorWake?.close();
    await f.resident.managed.close();
    const releases = vi.mocked(HostedWorkspaceBroker.prototype.release);
    releases.mockClear();
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockClear();
    neverStartedReconcile.fn.mockClear();
    const previousWake = wakeDeps.last;
    const replacement = await app(true);
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/load`))
      .send({
        managedSessionStore: store(),
        recoveryCleanupPromptId: PROMPT_ID,
      })
      .expect(409);
    expect(releases).not.toHaveBeenCalled();
    expect(HostedWorkspaceBroker.prototype.acquire).not.toHaveBeenCalled();
    expect(neverStartedReconcile.fn).not.toHaveBeenCalled();
    expect(wakeDeps.last).toBe(previousWake);
    expect(state.model).toHaveBeenCalledOnce();
  });

  it('clears a cleanup-only block when continue confirms the original owner (R3-14)', async () => {
    const f = await recoveryFileSession();
    f.resident.runtimeLeaseHeld = {
      promptId: PROMPT_ID,
      runtimeSessionId: hostedRuntimeSessionId(PROMPT_ID),
    };
    state.model.mockImplementationOnce(async () => {
      await f.owe();
      return { text: 'completed', model: 'test-model' };
    });
    vi.spyOn(
      HostedWorkspaceToolTurn.prototype,
      'cleanup',
    ).mockRejectedValueOnce(new Error('release unavailable'));
    await f.submit();
    await f.idle();
    expect(f.resident.cleanupBlocked).toBe(true);
    const authorization =
      await f.resident.managed.authority.harnessRunAuthorization();
    if (authorization.status !== 'runnable')
      throw new Error('fixture checkpoint is not runnable');
    await f
      .authorize(
        supertest(f.server).post(
          `/session/${SESSION_ID}/managed-runtime/continue`,
        ),
      )
      .send({
        promptId: PROMPT_ID,
        checkpointId: authorization.checkpoint.identity.checkpointId,
        activationId: f.resident.managed.activation.activationId,
      })
      .expect(409);
    await vi.waitFor(() => {
      expect(f.resident.runtimeLeaseHeld).toBeUndefined();
      expect(
        f.resident.managed.authority
          .eventsInSequenceRange(
            1,
            f.resident.managed.authority.committedSequence,
          )
          .some(
            (event) =>
              event.kind === 'hosted.cleanup' &&
              event.payload['state'] === 'confirmed',
          ),
      ).toBe(true);
    });
    const loaded = await headers(
      supertest(f.server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        passiveManagedRuntimeRecovery: true,
      })
      .expect(200);
    expect(loaded.body.recoveryRequired).not.toBe(true);
    expect((await f.status()).body.recoveryBlocked).toBe(false);
    expect(f.resident.cleanupBlocked).toBe(false);
    await f
      .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
      .expect(204);
  });

  it('leaves a parked owner operable after lifecycle close requires recovery (R3-5)', async () => {
    const f = await recoveryFileSession();
    state.model.mockImplementationOnce(async () => {
      await f.owe();
      throw new LlmRequestPreparationError('parked request');
    });
    await f.submit();
    await f.idle();
    state.setLifecycleAuthority.mockClear();
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/lifecycle`))
      .send({
        kind: 'close',
        sessionKey: f.resident.managed.authority.sessionHeader.sessionKey,
        authority: { operationId: 'close-parked', claimGeneration: 1 },
      })
      .expect(503);
    expect(state.setLifecycleAuthority).not.toHaveBeenCalled();
    const cancel = await f
      .authorize(
        supertest(f.server).post(
          `/session/${SESSION_ID}/managed-runtime/cancel`,
        ),
      )
      .send({
        promptId: PROMPT_ID,
        checkpointId: 'checkpoint',
        activationId: f.resident.managed.activation.activationId,
      });
    expect(cancel.body.code).not.toBe('hosted_session_closing');
    expect(cancel.body.code).not.toBe('hosted_lifecycle_operation_active');
    await f
      .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
      .expect(204);
  });

  it('keeps a journaled cancellation after the recovered request deadline passes (R3-2)', async () => {
    const f = await recoveryFileSession();
    let modelWaiting = false;
    state.model.mockImplementationOnce(async ({ modelScope, signal }) => {
      const prepared: LlmPreparedRequest = {
        request: {
          model: 'fixture',
          contents: [{ role: 'user', parts: [{ text: 'original' }] }],
          config: { temperature: 0.3 },
        },
        history: [{ role: 'user', parts: [{ text: 'original' }] }],
        completedToolCallIds: [],
        routeSelector: 'openai:fixture',
        providerPin: 'a'.repeat(64),
        promptTokensForClamp: 12,
      };
      const request = modelRecovery.createHostedModelRequest(
        f.resident.managed,
        PROMPT_ID,
        prepared,
        0,
        false,
        undefined,
        { bootId: BOOT_ID, eventEpoch: 'source-epoch' },
      );
      await modelScope!.beginMainAttempt(
        'fixture',
        await modelRecovery.publishHostedModelRequest(
          f.resident.managed,
          request,
        ),
      );
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(
            new LlmRequestPreparationError('park cancellation before terminal'),
          ),
        );
        modelWaiting = true;
      });
    });
    await f.submit(10_000);
    // Bounded by the submitted deadline: a later model entry would put /cancel
    // past the deadline the ordering assertion below pins.
    await vi.waitFor(() => expect(modelWaiting).toBe(true), {
      timeout: 10_000,
    });
    await f
      .authorize(supertest(f.server).post(`/session/${SESSION_ID}/cancel`))
      .expect(204);
    await f.idle();
    const events = () =>
      f.resident.managed.authority.eventsInSequenceRange(
        1,
        f.resident.managed.authority.committedSequence,
      );
    const deadline = events().find((event) => event.kind === 'input.accepted')!
      .payload['deadline'] as number;
    const cancellation = events().find(
      (event) => event.kind === 'cancel.requested',
    )!;
    expect(cancellation.occurredAt).toBeLessThan(deadline);
    const now = Date.now.bind(Date);
    const elapsedStart = now();
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => deadline + 1 + now() - elapsedStart);
    try {
      state.model.mockImplementationOnce(async ({ signal }) => {
        signal.throwIfAborted();
        return { text: 'unexpected', model: 'fixture' };
      });
      await headers(supertest(f.server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          driveRuntimeRecovery: true,
        })
        .expect(200);
      await vi.waitFor(
        () =>
          expect(
            events().filter((event) => event.kind === 'turn.settled'),
          ).toHaveLength(1),
        { timeout: settleTimeoutMs() },
      );
      expect(
        events().find((event) => event.kind === 'turn.settled')!.payload,
      ).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
    } finally {
      clock.mockRestore();
    }
    await f.idle();
    await f
      .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
      .expect(204);
  });

  it('keeps resident recovery and concurrent close consistent (R3-8)', async () => {
    const f = await recoveryFileSession();
    const publish = LocalManagedSessionResourceStore.prototype.publish;
    const refuse = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'publish')
      .mockImplementation(function (
        this: LocalManagedSessionResourceStore,
        kind,
        bytes,
      ) {
        return kind === 'managed-turn-result'
          ? Promise.reject(new Error('terminal unavailable'))
          : publish.call(this, kind, bytes);
      });
    state.model.mockImplementationOnce(async ({ modelScope }) => {
      const finish = await modelScope!.beginMainAttempt('fixture');
      await finish(true, {});
      return { text: 'committed answer', model: 'fixture' };
    });
    await f.submit();
    await f.idle();
    refuse.mockRestore();
    const find = modelRecovery.findHostedCommittedModelOutput;
    let release!: () => void;
    let reading = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(
      modelRecovery,
      'findHostedCommittedModelOutput',
    ).mockImplementationOnce(async (...args) => {
      const committed = await find(...args);
      expect(committed).toBeDefined();
      reading = true;
      await gate;
      return committed;
    });
    const loading = headers(
      supertest(f.server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
        driveRuntimeRecovery: true,
      })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(reading).toBe(true), {
        timeout: settleTimeoutMs(),
      });
      f.resident.mcpClosing = true;
      const closingRefusal = await headers(
        supertest(f.server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
        driveRuntimeRecovery: true,
      });
      expect(closingRefusal.status).toBe(409);
      expect(closingRefusal.body.code).toBe('hosted_session_closing');
      f.resident.mcpClosing = false;
      await headers(supertest(f.server).post(`/session/${SESSION_ID}/load`))
        .send({
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-files/1',
          driveRuntimeRecovery: true,
        })
        .expect(409);
      const closed = await f.authorize(
        supertest(f.server).delete(`/session/${SESSION_ID}`),
      );
      release();
      const loaded = await loading;
      if (closed.status === 204) {
        expect([404, 409]).toContain(loaded.status);
        await f
          .authorize(supertest(f.server).get(`/session/${SESSION_ID}/status`))
          .expect(404);
      } else {
        expect(closed.status).toBe(409);
        expect(closed.body.code).toBe('hosted_turn_active');
        expect(loaded.status).toBe(200);
        await f.status();
        await f.idle();
        await f
          .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
          .expect(204);
      }
    } finally {
      f.resident.mcpClosing = false;
      release();
      await loading;
    }
  });

  it.each(['ordinary', 'wake'])(
    'retries completed native-file cleanup on the real scheduler cadence (%s)',
    async (source) => {
      const f = await recoveryFileSession();
      vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      const prepare = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'prepare')
        .mockImplementation(async () => randomUUID());
      const execute = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'execute')
        .mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'written' }],
        });
      let unavailable = true;
      const releases: Array<{
        owner: string;
        options: unknown;
        failed: boolean;
        at: number;
      }> = [];
      vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
        async function (this: HostedWorkspaceBroker, options) {
          releases.push({
            owner: this.runtimeSessionId,
            options,
            failed: unavailable,
            at: Date.now(),
          });
          if (unavailable)
            throw new HostedWorkspaceBrokerRejection(
              503,
              'runtime_unavailable',
            );
        },
      );
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: 'write_file',
          callId: 'call-1',
          args: { file_path: 'a.txt', content: 'x' },
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
        return { text: 'done', model: 'test-model' };
      });
      try {
        if (source === 'ordinary') await f.submit();
        else {
          const managed = f.resident.managed;
          const content = Buffer.from(JSON.stringify({ text: 'write a.txt' }));
          await managed.authority.submitInput(
            {
              operation: 'submitInput',
              commandId: PROMPT_ID,
              sessionKey: managed.authority.sessionHeader.sessionKey,
              contentDigest: createHash('sha256').update(content).digest('hex'),
            },
            {
              inputId: PROMPT_ID,
              turnId: PROMPT_ID,
              source: 'monitor',
              contentRef: await managed.resources.publish(
                'managed-input',
                content,
              ),
              admissionRef: await managed.resources.publish(
                'managed-admission',
                Buffer.from('{}'),
              ),
              deadline: null,
              wakeReason: 'input',
            },
          );
          (
            f.resident as unknown as { monitorWake: HostedMonitorWakeScheduler }
          ).monitorWake.kick();
        }
        await vi.waitFor(
          () => {
            expect(f.resident.cleanupBlocked).toBe(true);
            expect(releases.length).toBeGreaterThan(0);
          },
          { timeout: settleTimeoutMs() },
        );
        await vi.waitFor(
          () => expect(releases.filter((item) => item.failed)).toHaveLength(4),
          { timeout: settleTimeoutMs() },
        );
        expect(releases[3].at - releases[2].at).toBeGreaterThanOrEqual(400);
        expect(releases).toHaveLength(4);
        expect(f.resident.blocked).toBe(true);
        unavailable = false;
        await vi.waitFor(
          () => {
            expect(f.resident.blocked).toBe(false);
            expect(f.resident.cleanupBlocked).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        expect(releases.filter((item) => !item.failed)).toHaveLength(1);
        expect(
          releases.every(
            (item) => item.owner === hostedRuntimeSessionId(PROMPT_ID),
          ),
        ).toBe(true);
        expect(releases.at(-1)!.options).toEqual({
          bindingId: 'binding',
          generation: '1',
        });
        expect(state.model).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledOnce();
        const events = f.resident.managed.authority.eventsInSequenceRange(
          1,
          f.resident.managed.authority.committedSequence,
        );
        expect(
          events.filter(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === PROMPT_ID,
          ),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.kind === 'hosted.cleanup').at(-1)!
            .payload['state'],
        ).toBe('confirmed');
      } finally {
        unavailable = false;
        await f
          .authorize(supertest(f.server).delete(`/session/${SESSION_ID}`))
          .expect(204);
      }
    },
  );

  it('retries consumed channel cleanup while keeping new turns blocked', async () => {
    const previous = 'previous-prompt';
    const channelTurn = await prewriteChannelWriteInterruption(false, previous);
    mockBrokerBroker();
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => {},
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const owners: string[] = [];
    let faults = 0;
    vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        owners.push(this.runtimeSessionId);
        if (this.runtimeSessionId === channelTurn)
          throw new HostedWorkspaceBrokerRejection(
            404,
            'runtime_session_not_found',
          );
        if (this.runtimeSessionId === previous && faults-- > 0)
          throw new HostedWorkspaceBrokerRejection(503, 'runtime_unavailable');
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      })
      .expect(200);
    const resident = capturedWakeSession();
    const broker = new HostedWorkspaceBroker(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      resident.managed.authority.sessionHeader.sessionKey,
      previous,
    );
    broker.runtime = {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    };
    await oweHostedTurnCleanup(resident.managed, previous, broker);
    faults = 2;
    const params = wakeDeps.last as Parameters<
      typeof createMonitorWakeRunTurn
    >[0];
    expect(
      await createMonitorWakeRunTurn(params)({
        turnId: channelTurn,
        text: 'write deploy.txt',
        source: 'channel',
      }),
    ).toBe('busy');
    const scheduler = (
      resident as unknown as {
        monitorWake: {
          deps: {
            next: () => Promise<unknown>;
            recoverBlocked: () => Promise<void>;
          };
        };
      }
    ).monitorWake;
    expect(await scheduler.deps.next()).toBeUndefined();
    expect(resident.blocked).toBe(true);
    expect(resident.cleanupBlocked).toBe(true);
    await scheduler.deps.recoverBlocked();
    expect(owners.filter((id) => id === previous)).toHaveLength(2);
    expect(resident.blocked).toBe(true);
    await scheduler.deps.recoverBlocked();
    expect(owners.filter((id) => id === previous)).toHaveLength(3);
    expect(resident.blocked).toBe(false);
    expect(resident.cleanupBlocked).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
    const events = resident.managed.authority.eventsInSequenceRange(
      1,
      resident.managed.authority.committedSequence,
    );
    expect(
      events.filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === channelTurn,
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.kind === 'hosted.cleanup').at(-1)!.payload[
        'state'
      ],
    ).toBe('confirmed');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
  });

  it('settles a channel wake whose missing Runtime has another prompt cleanup owner (R2-63)', async () => {
    const previous = 'previous-prompt';
    const channelTurn = await prewriteChannelWriteInterruption(false, previous);
    mockBrokerBroker();
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => {},
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockImplementation(async function (this: HostedWorkspaceBroker) {
      if (this.runtimeSessionId === channelTurn)
        throw new HostedWorkspaceBrokerRejection(
          404,
          'runtime_session_not_found',
        );
    });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      })
      .expect(200);
    const resident = capturedWakeSession();
    const broker = new HostedWorkspaceBroker(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      resident.managed.authority.sessionHeader.sessionKey,
      previous,
    );
    broker.runtime = {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    };
    await oweHostedTurnCleanup(resident.managed, previous, broker);
    const params = wakeDeps.last as Parameters<
      typeof createMonitorWakeRunTurn
    >[0];
    const runTurn = createMonitorWakeRunTurn(params);
    await expect(
      runTurn({
        turnId: channelTurn,
        text: 'write deploy.txt',
        source: 'channel',
      }),
    ).resolves.toBe('settled');
    expect(resident.blocked).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
    const events = resident.managed.authority.eventsInSequenceRange(
      1,
      resident.managed.authority.committedSequence,
    );
    expect(
      events.filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === channelTurn,
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.kind === 'hosted.cleanup').at(-1)!.payload[
        'state'
      ],
    ).toBe('confirmed');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
  });
});

describe('Hosted Harness tool approvals', () => {
  // Turns commit and sync several records, which can take over a second
  // on a busy host.
  const waitFor = <T>(check: () => T | Promise<T>) =>
    vi.waitFor(check, { timeout: settleTimeoutMs() });

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
    await rm(state.root, {
      recursive: true,
      force: true,
      // A wake pump's final writes can still be in flight at teardown.
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  const files = 'hosted-workspace-files/1';
  const questionResponse = {
    answers: [{ questionId: 'q1', optionIds: ['q1o2'] }],
    inputRevision: 1,
    policyRevision: HOSTED_QUESTION_POLICY,
  };

  async function parkedQuestion(
    pinned = true,
    terminal?: 'cancelled' | 'expired' | 'decided',
    timeoutMs = 60_000,
  ) {
    const runtime = {
      bindingId: 'question-original-binding',
      generation: '7',
      workspaceGeneration: '3',
    };
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const claims = new WeakMap<HostedWorkspaceBroker, string>();
    const calls: string[] = [];
    let provisionerKind = pinned ? 'local-process' : undefined;
    const warm = vi.mocked(HostedWorkspaceBroker.prototype.warm);
    warm.mockImplementation(async function (this: HostedWorkspaceBroker) {
      calls.push('warm');
      this.runtime = { ...runtime };
      this.provisionerKind = provisionerKind;
    });
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    acquire.mockImplementation(async function (this: HostedWorkspaceBroker) {
      calls.push('acquire');
      this.runtime = { ...runtime };
      this.provisionerKind = provisionerKind;
      claims.set(this, randomUUID());
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockImplementation(
      function (this: HostedWorkspaceBroker) {
        return claims.get(this);
      },
    );
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockImplementation(async function (this: HostedWorkspaceBroker, claim) {
        expect(claim).toBe(claims.get(this));
        calls.push('releaseMount');
      });
    const wait = vi
      .spyOn(HostedApprovalWaiters.prototype, 'wait')
      .mockRejectedValueOnce(
        new HostedToolRecoveryRequiredError('question writer interrupted'),
      );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'ask_user_question',
        callId: 'question-original-call',
        args: {
          questions: [
            {
              question: 'Which target?',
              header: 'Target',
              options: [
                { label: 'A', description: 'First target' },
                { label: 'B', description: 'Second target' },
              ],
            },
          ],
        },
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
      throw new Error('Interrupted question unexpectedly continued.');
    });
    const original = await app(true);
    const created = await headers(supertest(original).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: files,
        approvalMode: 'yolo',
        approvalTimeoutMs: timeoutMs,
      })
      .expect(200);
    const originalRequest = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    const prompt = [{ type: 'text', text: 'Ask for the target' }];
    await originalRequest(
      supertest(original).post(`/session/${SESSION_ID}/prompt`),
    )
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      const status = await originalRequest(
        supertest(original).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: true,
      });
    });
    const managed = (wakeDeps.last as { session: { managed: ManagedSession } })
      .session.managed;
    const saved = await findHostedApprovalContinuation(managed, PROMPT_ID);
    expect(saved?.plan.stage).toBe('approval');
    expect(saved?.plan.runtime).toEqual({
      ...runtime,
      runtimeSessionId: PROMPT_ID,
      ...(pinned ? { provisionerKind: 'local-process' } : {}),
    });
    const requestId = saved!.plan.actionId!;
    const options = await readHostedActionOptions(
      managed,
      managed.authority.action(requestId)!,
    );
    if (terminal === 'decided')
      expect(
        (
          await resolveHostedAction(
            managed,
            new HostedApprovalWaiters(),
            requestId,
            questionResponse,
          )
        ).status,
      ).toBe(200);
    else if (terminal) await endHostedAction(managed, requestId, terminal);
    await managed.close();
    provisionerKind = 'local-process';
    wait.mockRestore();
    state.model.mockReset();
    state.model.mockImplementation(
      async ({ resumeFromToolResults, signal }) => {
        signal.throwIfAborted();
        expect(JSON.stringify(resumeFromToolResults)).toContain('q1o2');
        calls.push('model');
        return { text: 'question recovered', model: 'test-model' };
      },
    );
    warm.mockClear();
    acquire.mockClear();
    releaseMount.mockClear();
    calls.length = 0;
    const replacement = await app(true);
    return {
      runtime,
      calls,
      warm,
      acquire,
      releaseMount,
      requestId,
      expiresAt: options.expiresAt,
      replacement,
      async load() {
        const loaded = await headers(
          supertest(replacement).post(`/session/${SESSION_ID}/load`),
        )
          .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
          .expect(200);
        return (request: supertest.Test) =>
          headers(request).set(
            'X-Qwen-Client-Id',
            loaded.body.clientId as string,
          );
      },
    };
  }

  it.each([true, false])(
    'cold question recovery preserves owner acquisition order (pinned: %s)',
    async (pinned) => {
      const f = await parkedQuestion(pinned);
      const authorize = await f.load();
      if (pinned)
        await waitFor(() =>
          expect(f.calls).toEqual(['acquire', 'releaseMount']),
        );
      else expect(f.calls).toEqual([]);
      expect(f.warm).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      await authorize(
        supertest(f.replacement).post(
          `/session/${SESSION_ID}/actions/${f.requestId}/resolve`,
        ),
      )
        .send(questionResponse)
        .expect(200);
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(f.calls).toEqual(
        pinned
          ? ['acquire', 'releaseMount', 'acquire', 'model']
          : ['warm', 'acquire', 'model'],
      );
      for (const [expected] of f.acquire.mock.calls)
        expect(expected).toEqual({
          runtimeBindingId: f.runtime.bindingId,
          generation: f.runtime.generation,
        });
      expect(
        f.acquire.mock.contexts.every(
          (broker) =>
            (broker as HostedWorkspaceBroker).runtimeSessionId === PROMPT_ID,
        ),
      ).toBe(true);
      if (pinned)
        expect(f.acquire.mock.contexts[0]).toBe(f.acquire.mock.contexts[1]);
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      if (!pinned) {
        const managed = (
          wakeDeps.last as { session: { managed: ManagedSession } }
        ).session.managed;
        const final = managed.authority
          .eventsInSequenceRange(1, managed.authority.committedSequence)
          .findLast((event) => event.kind === 'hosted.batch.planned')!;
        const planRef = assertManagedSessionDurableRef(
          final.payload['planRef'],
          'final question plan',
        );
        const plan = JSON.parse(
          (await managed.resources.read(planRef)).toString(),
        ) as { runtime: object };
        expect(plan.runtime).not.toHaveProperty('provisionerKind');
      }
      await authorize(
        supertest(f.replacement).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each(['cancelled', 'expired'] as const)(
    'cold question recovery settles %s without acquiring a Runtime',
    async (terminal) => {
      const f = await parkedQuestion(true, terminal);
      const authorize = await f.load();
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(f.calls).toEqual([]);
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.acquire).not.toHaveBeenCalled();
      expect(f.releaseMount).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      await authorize(
        supertest(f.replacement).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each(['cancelled', 'expired', 'decided-then-cancelled'] as const)(
    'cold question recovery stops a busy owner safely (%s)',
    async (outcome) => {
      const decided = outcome === 'decided-then-cancelled';
      const f = await parkedQuestion(
        true,
        decided ? 'decided' : undefined,
        5000,
      );
      f.acquire.mockRejectedValue(
        new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
      );
      const authorize = await f.load();
      await waitFor(() => expect(f.acquire).toHaveBeenCalled());
      if (outcome === 'expired')
        vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt + 1);
      else
        await authorize(
          supertest(f.replacement).post(`/session/${SESSION_ID}/cancel`),
        )
          .send({ promptId: PROMPT_ID })
          .expect(204);
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(f.acquire).toHaveBeenCalledOnce();
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.releaseMount).not.toHaveBeenCalled();
      if (decided) {
        expect(state.model).toHaveBeenCalledOnce();
        expect(state.model.mock.calls[0][0].signal.aborted).toBe(true);
      } else expect(state.model).not.toHaveBeenCalled();
      expect(f.calls).not.toContain('model');
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      const managed = (
        wakeDeps.last as { session: { managed: ManagedSession } }
      ).session.managed;
      expect(managed.authority.action(f.requestId)?.state).toBe(
        decided ? 'decided' : outcome,
      );
      const results = (await managed.sink.project()).filter(
        (item) => item.type === 'tool_result',
      );
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results)).not.toContain('q1o2');
      expect(
        managed.authority
          .eventsInSequenceRange(1, managed.authority.committedSequence)
          .findLast(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === PROMPT_ID,
          )?.payload,
      ).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
      await managed.close();
    },
  );

  it('cold question recovery settles cancellation after the original owner is acquired', async () => {
    const f = await parkedQuestion(true, 'decided');
    const acquire = f.acquire.getMockImplementation()!;
    f.acquire.mockImplementation(async function (
      this: HostedWorkspaceBroker,
      expected,
    ) {
      await acquire.call(this, expected);
      (
        wakeDeps.last as { session: { active: { abort: AbortController } } }
      ).session.active.abort.abort();
    });
    const authorize = await f.load();
    const managed = (wakeDeps.last as { session: { managed: ManagedSession } })
      .session.managed;
    try {
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      });
      const status = await authorize(
        supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.recoveryBlocked).toBe(false);
      expect(f.acquire).toHaveBeenCalledOnce();
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.calls).not.toContain('model');
      expect(
        managed.authority
          .eventsInSequenceRange(1, managed.authority.committedSequence)
          .findLast(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === PROMPT_ID,
          )?.payload,
      ).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
    } finally {
      await managed.close();
    }
  });

  it.each([
    'bindingId',
    'generation',
    'workspaceGeneration',
    'provisionerKind',
  ])(
    'cold question recovery blocks changed %s without warming a substitute',
    async (changed) => {
      const f = await parkedQuestion();
      f.acquire.mockImplementation(async function (
        this: HostedWorkspaceBroker,
      ) {
        this.runtime = {
          ...f.runtime,
          ...(changed !== 'provisionerKind' ? { [changed]: 'changed' } : {}),
        };
        this.provisionerKind =
          changed === 'provisionerKind' ? 'ssh' : 'local-process';
      });
      const authorize = await f.load();
      await waitFor(async () => {
        const status = await authorize(
          supertest(f.replacement).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        });
      });
      expect(f.acquire).toHaveBeenCalledExactlyOnceWith({
        runtimeBindingId: f.runtime.bindingId,
        generation: f.runtime.generation,
      });
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.releaseMount).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
      await (
        wakeDeps.last as { session: { managed: ManagedSession } }
      ).session.managed.close();
    },
  );

  it('loads a failed initial extension selection for management while keeping the first Prompt blocked', async () => {
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'capabilityDigest',
      'get',
    ).mockReturnValue(MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST);
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'original-binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    let failPrepare = true;
    const runtimeStates = new Map<string, string>();
    const control = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'extensionControl')
      .mockImplementation(async (operation) => {
        const common = {
          operationId: operation.operationId,
          executionMode: 'developer-process-group',
        };
        if (operation.kind === 'extension-prepare') {
          if (failPrepare) throw new Error('invalid initial package');
          runtimeStates.set(operation.operationId, 'prepared');
          return {
            ...common,
            state: 'prepared',
            expectedRevision: operation.expectedRevision,
            revision: operation.expectedRevision + 1,
            packages: operation.extensions.map((pin) => ({
              pin,
              assetRoot: `extension://${pin.extensionId}/`,
              contributions: {
                skills: [],
                commands: [],
                agents: [],
                context: [],
                mcpServers: {},
                hooks: {},
                settings: [],
              },
            })),
            mcpServers: [],
            hookCatalog: null,
          };
        }
        if (operation.kind === 'extension-activate')
          runtimeStates.set(operation.operationId, 'active');
        return {
          ...common,
          state: runtimeStates.get(operation.operationId),
          revision: 1,
        };
      });
    const initialSelection = {
      operationId: randomUUID(),
      actorKey: 'a'.repeat(64),
      expectedRevision: 0,
      extensions: [
        {
          extensionId: 'sample',
          packageRevision: 1,
          packageDigest: 'b'.repeat(64),
        },
      ],
    };
    const definition = {
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      publicChildAgentsVersion: 1,
      agentDefinition: {
        agentId: `agent_${'c'.repeat(32)}`,
        revision: '1',
        digest: 'd'.repeat(64),
      },
      initialSelection,
    };
    const original = await app(true);
    await headers(supertest(original).post('/session'))
      .send({ ...definition, sessionId: SESSION_ID, sessionScope: 'thread' })
      .expect(503);
    await headers(supertest(original).post(`/session/${SESSION_ID}/load`))
      .send(definition)
      .expect(503);
    expect(control.mock.calls.map(([operation]) => operation.kind)).toEqual([
      'extension-status',
      'extension-status',
      'extension-prepare',
    ]);
    const replacement = await app(true);
    const attachment = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ ...definition, passiveManagedRuntimeRecovery: true })
      .expect(200);
    expect(control).toHaveBeenCalledTimes(3);
    expect(HostedWorkspaceBroker.prototype.warm).toHaveBeenCalledOnce();
    expect(state.model).not.toHaveBeenCalled();
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', attachment.body.clientId);
    const prompt = [{ type: 'text', text: 'start after configuration' }];
    const promptBody = {
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    };
    await authorize(
      supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
    )
      .send(promptBody)
      .expect(409);
    failPrepare = false;
    const repair = await authorize(
      supertest(replacement).post(
        `/session/${SESSION_ID}/extensions/management`,
      ),
    )
      .send({ ...initialSelection, operationId: randomUUID() })
      .expect(202);
    expect(repair.body).toMatchObject({
      revision: 1,
      operation: { state: 'active' },
    });
    const callsBeforeConflict = control.mock.calls.length;
    const rejected = await authorize(
      supertest(replacement).post(
        `/session/${SESSION_ID}/extensions/management`,
      ),
    )
      .send({ ...initialSelection, operationId: randomUUID() })
      .expect(409);
    expect(rejected.body).toMatchObject({
      error: 'extension_config_revision_conflict',
    });
    expect(control).toHaveBeenCalledTimes(callsBeforeConflict);
    state.model.mockResolvedValue({ text: 'ready', model: 'test-model' });
    await authorize(
      supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
    )
      .send(promptBody)
      .expect(202);
    await waitFor(async () => {
      const status = await authorize(
        supertest(replacement).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body).toMatchObject({
        hasActivePrompt: false,
        recoveryBlocked: false,
      });
    });
    expect(state.model).toHaveBeenCalledOnce();
    await authorize(
      supertest(replacement).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it.each(['write_file', 'exit_plan_mode'] as const)(
    'rechecks live approval after a cold restore while preserving %s approval semantics',
    async (toolName) => {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'original-binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      const wait = vi
        .spyOn(HostedApprovalWaiters.prototype, 'wait')
        .mockRejectedValueOnce(
          new HostedToolRecoveryRequiredError('writer lost during approval'),
        );
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        const call = {
          name: toolName,
          callId: 'original-call',
          args:
            toolName === 'write_file'
              ? { file_path: 'notes.txt', content: 'hello' }
              : { plan: 'Write the notes after approval.' },
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
        return { text: 'not reached', model: 'test-model' };
      });
      const server = await app(true);
      const created = await headers(supertest(server).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: files,
          approvalMode: 'default',
          approvalTimeoutMs: 60_000,
        })
        .expect(200);
      const prompt = [{ type: 'text', text: 'write notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          ...(toolName === 'exit_plan_mode'
            ? {
                approvalSelection: {
                  mode: 'default',
                  revision: 1,
                  planMode: true,
                },
              }
            : {}),
        })
        .expect(202);
      await waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
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
      const action = journal.events.findLast(
        (event) =>
          event.kind === 'action.changed' &&
          event.payload['state'] === 'requested',
      )!;
      expect(action).toBeDefined();
      const requestId = action.payload['requestId'] as string;
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .expect(204);
      wait.mockRestore();
      state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 2 });
      state.model.mockResolvedValue({ text: 'done', model: 'test-model' });
      const replacement = await app(true);
      const loaded = await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      )
        .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
        .expect(200);
      if (toolName === 'exit_plan_mode') {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expect(HostedWorkspaceBroker.prototype.execute).not.toHaveBeenCalled();
        await headers(
          supertest(replacement).post(
            `/session/${SESSION_ID}/actions/${requestId}/resolve`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId as string)
          .send({
            optionId: 'deny',
            inputRevision: 1,
            policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
          })
          .expect(200);
      }
      await waitFor(async () => {
        const status = await headers(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(
        toolName === 'write_file' ? 1 : 0,
      );
      const restored = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(
        restored.events.filter(
          (event) =>
            event.kind === 'action.changed' &&
            event.payload['requestId'] === requestId &&
            event.payload['state'] === 'decided',
        ),
      ).toHaveLength(1);
      await headers(
        supertest(replacement).post(`/session/${SESSION_ID}/detach`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .expect(204);
    },
  );

  it.each([
    ['hosted-workspace-files/1', true],
    ['hosted-workspace-files/2', false],
    ['hosted-workspace-files/3', true],
    ['hosted-workspace-shell/1', true],
    ['hosted-workspace-read/1', false],
  ] as const)(
    'queries live policy only for eligible profile %s',
    async (toolProfile, live) => {
      state.model.mockImplementation(async ({ toolTurn, signal }) => {
        const call = {
          name: 'read_file',
          callId: randomUUID(),
          args: { file_path: 'notes.txt' },
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
      const prompt = [{ type: 'text', text: 'read notes' }];
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        })
        .expect(202);
      await waitFor(async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId as string);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: false,
        });
      });
      expect(state.approvalQueries.length > 0).toBe(live);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledOnce();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .expect(204);
    },
  );

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

  it('accepts the classifier auto mode for a files Session', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: files,
      approvalMode: 'auto',
    });
    expect(created.status).toBe(200);
    expect(created.body.approvalMode).toBe('auto');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

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

  it('pins valid approval settings for a selectable yolo Session', async () => {
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
      {
        engine: 'managed',
        sessionId: SESSION_ID,
        toolProfile: files,
        approvalMode: 'yolo',
        approvalTimeoutMs: HOSTED_APPROVAL_TIMEOUT_MS,
      },
    ]);
  });

  it.each(['default', 'auto-edit', 'auto', 'yolo'] as const)(
    'keeps custom initial %s identity and timeout while applying live and cold Turn overrides',
    async (initialMode) => {
      const identity = {
        agentId: `agent_${'a'.repeat(32)}`,
        revision: '1',
        digest: 'b'.repeat(64),
      };
      const agentDefinition = { ...identity, model: { id: 'configured' } };
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
          args: { file_path: 'override.txt', content: 'selected' },
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
      let server = await app(true);
      const createBody = {
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: files,
        approvalMode: initialMode,
        approvalTimeoutMs: 12_345,
        agentDefinition,
      };
      const created = await headers(supertest(server).post('/session')).send(
        createBody,
      );
      expect(created.status).toBe(200);
      let clientId = created.body.clientId as string;
      const saved = {
        engine: 'managed',
        sessionId: SESSION_ID,
        agentDefinition,
        toolProfile: files,
        ...(initialMode === 'yolo'
          ? {}
          : {
              approvalMode: initialMode,
              approvalTimeoutMs: 12_345,
            }),
      };
      expect(await definitions()).toEqual([saved]);
      const initialJournal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      const send = async (mode: 'default' | 'yolo', revision: number) => {
        const prompt = [
          { type: 'text', text: 'write using the admitted policy' },
        ];
        const promptId = randomUUID();
        const askedBefore = requestIds.length;
        await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send({
            prompt,
            promptId,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
            approvalSelection: { mode, revision },
          })
          .expect(202);
        if (mode === 'default') {
          await waitFor(() => expect(requestIds).toHaveLength(askedBefore + 1));
          const resources = LocalManagedSessionResourceStore.create({
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
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
          const requested = journal.events.findLast(
            (event) =>
              event.kind === 'action.changed' &&
              event.payload['requestId'] === requestIds.at(-1),
          );
          const options = JSON.parse(
            (
              await resources.read(
                assertManagedSessionDurableRef(
                  requested!.payload['optionsRef'],
                  'approval options',
                ),
              )
            ).toString('utf8'),
          );
          expect(options.expiresAt - options.createdAt).toBe(
            initialMode === 'yolo' ? HOSTED_APPROVAL_TIMEOUT_MS : 12_345,
          );
          await headers(
            supertest(server).post(
              `/session/${SESSION_ID}/actions/${requestIds.at(-1)}/resolve`,
            ),
          )
            .set('X-Qwen-Client-Id', clientId)
            .send({
              optionId: 'allow',
              inputRevision: 1,
              policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
            })
            .expect(200);
        }
        await waitFor(async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body).toMatchObject({
            hasActivePrompt: false,
            recoveryBlocked: false,
          });
        });
        expect(requestIds).toHaveLength(
          askedBefore + (mode === 'default' ? 1 : 0),
        );
      };
      await send('default', 1);
      await send('yolo', 2);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      server = await app(true);
      // An earlier committed create whose ACK was lost still conflicts;
      // the connector must load its original definition instead of recreating it.
      await headers(supertest(server).post('/session'))
        .send(createBody)
        .expect(409);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        toolProfile: files,
        agentDefinition: identity,
      });
      expect(loaded.status).toBe(200);
      expect(loaded.body.approvalMode).toBe(initialMode);
      clientId = loaded.body.clientId as string;
      await send('default', 3);
      expect(HostedWorkspaceBroker.prototype.execute).toHaveBeenCalledTimes(3);
      for (const definition of await definitions())
        expect(definition).toEqual(saved);
      const finalJournal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
      expect(finalJournal.header!.definitionRef).toEqual(
        initialJournal.header!.definitionRef,
      );
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
    },
  );

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
    const { server, clientId, answer, status } = await waitingSession();
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValueOnce(new Error('journal down'));
    const failed = await answer('allow');
    expect(failed.status).toBe(409);
    expect(failed.body.code).toBe('hosted_turn_recovery_required');
    expect(failed.body.reason).toBe('writes_stopped');
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
    expect((await answer('allow')).body.reason).toBe('writes_stopped');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('journal down'));
    // The stopped writer outranks turn_blocked on every gate, not only the
    // resolve route: a fresh prompt and both runtime routes name it.
    const followUp = [{ type: 'text', text: 'again' }];
    const prompted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt: followUp,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(followUp)).digest('hex')}`,
      });
    expect(prompted.status).toBe(409);
    expect(prompted.body.code).toBe('hosted_turn_recovery_required');
    expect(prompted.body.reason).toBe('writes_stopped');
    for (const route of ['continue', 'cancel'] as const) {
      const refused = await headers(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/${route}`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: 'ckpt-lost',
          activationId: 'act-lost',
        });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(refused.body.reason).toBe('writes_stopped');
    }
    // The same outrank pins the files/rewind gate: it carries the busy code
    // before any body validation, so a stopped writer is named here too.
    const rewound = await headers(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ requestId: randomUUID(), promptId: PROMPT_ID });
    expect(rewound.status).toBe(409);
    expect(rewound.body.code).toBe('hosted_turn_recovery_required');
    expect(rewound.body.reason).toBe('writes_stopped');
  });

  it('reattaches for MCP management without paying resident cleanup debt or waking work', async () => {
    const { server, authorize, requests } = await mcpApp();
    const prompt = [{ type: 'text', text: 'finish a turn' }];
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await waitFor(async () => {
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.hasActivePrompt).toBe(false);
    });
    const resident = (
      wakeDeps.last as {
        session: { managed: Awaited<ReturnType<typeof openManagedSession>> };
      }
    ).session;
    expect(
      resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
    ).toBe(true);
    const broker = new HostedWorkspaceBroker(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      resident.managed.authority.sessionHeader.sessionKey,
      hostedRuntimeSessionId(PROMPT_ID),
    );
    broker.runtime = {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    };
    await oweHostedTurnCleanup(resident.managed, PROMPT_ID, broker);
    const sequence = resident.managed.authority.committedSequence;
    state.model.mockClear();
    requests.length = 0;
    vi.mocked(HostedWorkspaceBroker.prototype.release).mockClear();
    const kick = vi
      .spyOn(HostedMonitorWakeScheduler.prototype, 'kick')
      .mockImplementation(() => {});
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
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
        mcpManagementOnly: true,
      })
      .expect(200);
    expect(loaded.body.sessionId).toBe(SESSION_ID);
    expect(resident.managed.authority.committedSequence).toBe(sequence);
    expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(state.model).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
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
      .expect(409);
    expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalledOnce();
    expect(resident.managed.authority.committedSequence).toBeGreaterThan(
      sequence,
    );
  });

  it('requires an explicit Session load before cold MCP management without opening its journal', async () => {
    const server = await app(true);
    const before = await readdir(state.root, { recursive: true });
    const load = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        mcpManagementOnly: true,
      })
      .expect(409);
    expect(load.body.code).toBe('hosted_mcp_session_load_required');
    expect(await readdir(state.root, { recursive: true })).toEqual(before);
    expect(state.model).not.toHaveBeenCalled();
  });

  it.each([
    { managedSessionStore: { ...store(), tenantId: 'foreign' } },
    { managedSessionStore: { ...store(), workspaceId: 'foreign' } },
    { managedSessionStore: { ...store(), baseUrl: 'https://foreign.test' } },
    {
      mcpServers: [
        {
          serverId: 'demo',
          serverRevision: 2,
          definitionDigest: 'a'.repeat(64),
        },
      ],
    },
    { toolProfile: 'hosted-workspace-shell/1' },
  ])('rejects a mismatched MCP management attachment %j', async (drift) => {
    const { server } = await mcpApp();
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
        mcpManagementOnly: true,
        ...drift,
      })
      .expect(409);
    expect(HostedWorkspaceBroker.prototype.release).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
  });

  it.each([
    'passiveManagedRuntimeRecovery',
    'driveRuntimeRecovery',
    'cancellationTakeover',
    'stopMessages',
  ])(
    'refuses recovery flag %s on an MCP management attachment',
    async (flag) => {
      const { server } = await mcpApp();
      const load = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      )
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
          mcpManagementOnly: true,
          [flag]: true,
        })
        .expect(400);
      expect(load.body.code).toBe('invalid_mcp_management_attachment');
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it('manages Session MCP over its live owner with command identity and revision checks', async () => {
    const pin = {
      serverId: 'demo',
      serverRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'mcpDefinitions',
    ).mockResolvedValue([{ ...pin, transport: 'stdio' }]);
    const { server, authorize } = await mcpApp();
    const route = `/session/${SESSION_ID}/mcp/management`;
    const snapshot = await authorize(supertest(server).get(route));
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({
      sessionId: SESSION_ID,
      revision: 0,
      supported: true,
    });
    const command = {
      operationId: randomUUID(),
      actorKey: 'c'.repeat(64),
      action: 'disable',
      serverId: 'demo',
      expectedRevision: 0,
    };
    const disabled = await authorize(supertest(server).post(route)).send(
      command,
    );
    expect(disabled.status).toBe(202);
    expect(disabled.body).toMatchObject({
      revision: 1,
      servers: [{ ...pin, state: 'disabled' }],
      operation: { operationId: command.operationId, state: 'settled' },
    });
    const replay = await authorize(supertest(server).post(route)).send(command);
    expect(replay.status).toBe(202);
    expect(replay.body.revision).toBe(1);
    const conflict = await authorize(supertest(server).post(route)).send({
      ...command,
      action: 'remove',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('hosted_mcp_configuration_conflict');
    const stale = await authorize(supertest(server).post(route)).send({
      ...command,
      operationId: randomUUID(),
      action: 'enable',
    });
    expect(stale.status).toBe(409);
    const status = await authorize(
      supertest(server).get(`${route}/operations/${command.operationId}`),
    );
    expect(status.status).toBe(200);
    expect(status.body.operation.state).toBe('settled');
    const foreign = await headers(supertest(server).post(route))
      .set('X-Qwen-Client-Id', 'foreign')
      .send(command);
    expect(foreign.status).toBe(404);
  });

  it('preserves an unknown MCP settings append as retryable instead of a definite conflict', async () => {
    const pin = {
      serverId: 'demo',
      serverRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'mcpDefinitions',
    ).mockResolvedValue([{ ...pin, transport: 'stdio' }]);
    vi.spyOn(HostedMcpManager.prototype, 'submit').mockRejectedValueOnce(
      new ManagedSessionAppendUnsettledError(new Error('Commit response lost')),
    );
    const { server, authorize } = await mcpApp();
    const route = `/session/${SESSION_ID}/mcp/management`;
    const command = {
      operationId: randomUUID(),
      actorKey: 'c'.repeat(64),
      action: 'disable',
      serverId: 'demo',
      expectedRevision: 0,
    };
    const unknown = await authorize(supertest(server).post(route)).send(
      command,
    );
    expect(unknown.status).toBe(503);
    expect(unknown.body.code).toBe('hosted_mcp_recovery_required');
    const retry = await authorize(supertest(server).post(route)).send(command);
    expect(retry.status).toBe(202);
    expect(retry.body.operation).toMatchObject({
      operationId: command.operationId,
      state: 'settled',
    });
  });

  it('keeps concurrent MCP management and private reconfiguration out while a command is pending', async () => {
    const pin = {
      serverId: 'second',
      serverRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    let complete:
      | ((value: Array<typeof pin & { transport: 'stdio' }>) => void)
      | undefined;
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'mcpDefinitions',
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { server, authorize } = await mcpApp();
    const route = `/session/${SESSION_ID}/mcp/management`;
    const command = {
      operationId: randomUUID(),
      actorKey: 'c'.repeat(64),
      action: 'add',
      serverId: 'second',
      expectedRevision: 0,
      server: pin,
    };
    const pending = authorize(supertest(server).post(route))
      .send(command)
      .then((response) => response);
    await vi.waitFor(() => expect(complete).toBeDefined());
    const competing = await authorize(supertest(server).post(route)).send({
      ...command,
      operationId: randomUUID(),
    });
    expect(competing.status).toBe(409);
    expect(competing.body.code).toBe('hosted_turn_active');
    const privateRoute = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/configurations`),
    ).send({
      operationId: randomUUID(),
      expectedRevision: 1,
      server: { ...pin, serverId: 'demo' },
    });
    expect(privateRoute.status).toBe(409);
    complete!([{ ...pin, transport: 'stdio' }]);
    expect((await pending).status).toBe(202);
  });

  it('names writes_stopped on the MCP operations gate when the writer is stopped', async () => {
    const { server, authorize } = await mcpApp();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'writesStopped',
      'get',
    ).mockReturnValue(true);
    const pending = vi
      .spyOn(HostedMcpSession.prototype, 'hasPendingOperations')
      .mockReturnValue(true);
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({
      operationId: randomUUID(),
      serverId: 'demo',
      request: { kind: 'resource_read', uri: 'memory://note' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    // The stopped writer outranks the pending operations the gate fired on.
    expect(refused.body.reason).toBe('writes_stopped');
    pending.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
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
    expect(loaded.body.reason).toBe('file_history_unsettled');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (file_history_pending): {"pendingTurn":"${PROMPT_ID}","pendingUndo":null,"unsettled":"${PROMPT_ID}","takeover":false,"ground":"phase_await_runtime","groundDetail":null}`,
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
      [{ baseUrl: 'https://other-store.test' }, 409],
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
    expect(refused.body.reason).toBe('turn_blocked');
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
  it('keeps a rewound MCP owner accounted for until ordered release', async () => {
    let mcp: HostedMcpSession | undefined;
    let managed: ManagedSession | undefined;
    const open = HostedMcpManager.prototype.open;
    vi.spyOn(HostedMcpManager.prototype, 'open').mockImplementation(
      async function (this: HostedMcpManager) {
        await open.call(this);
        mcp = Reflect.get(this, 'mcp') as HostedMcpSession | undefined;
        managed = Reflect.get(this, 'session') as ManagedSession;
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'mcpDefinitions',
    ).mockResolvedValue([]);
    const { server, authorize } = await mcpApp(
      false,
      ['demo'],
      'hosted-workspace-shell/1',
    );
    await authorize(
      supertest(server).get(`/session/${SESSION_ID}/mcp/management`),
    ).expect(200);
    if (!mcp || !managed) throw new Error('The MCP fixture did not initialize');
    const history = {
      ownerSessionId: SESSION_ID,
      snapshots: [
        {
          promptId: PROMPT_ID,
          timestamp: new Date().toISOString(),
          trackedFileBackups: {},
        },
      ],
      files: {},
    };
    await managed.sink.write({
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      type: 'user',
      cwd: state.root,
      version: 'test',
      message: { role: 'user', parts: [{ text: 'backup fixture' }] },
    });
    await commitHostedFileHistory(managed, {
      schemaVersion: 1,
      state: history,
      pendingTurn: null,
      pendingUndo: null,
      undoReceipts: [],
    });
    vi.mocked(HostedWorkspaceBroker.prototype.fileHistory).mockImplementation(
      async (operation) =>
        operation.action === 'rewind'
          ? {
              state: history,
              filesChanged: [],
              filesFailed: [],
              conflict: false,
            }
          : history,
    );
    const acquire = vi.mocked(HostedWorkspaceBroker.prototype.acquire);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    acquire.mockClear();
    release.mockClear();
    expect(mcp.mountHeld).toBe(false);
    expect(
      managed.authority.extensionRecordsInDomain('mcp_configuration'),
    ).toHaveLength(0);
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .send({ requestId: randomUUID(), promptId: PROMPT_ID })
      .expect(200);
    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire.mock.contexts).toEqual([mcp.broker]);
    expect(mcp.mountHeld).toBe(true);
    expect(release).not.toHaveBeenCalled();
    await mcp.closeResources();
    expect(release).toHaveBeenCalledOnce();
    expect(mcp.mountHeld).toBe(false);
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

  it('bounds a forged line break in the rewind recovery cause', async () => {
    // The broker's rewind failure is cause-derived free text: the recovery
    // tag must reach stderr as one logical line, whatever the cause embeds.
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
    vi.mocked(HostedWorkspaceBroker.prototype.fileHistory).mockImplementation(
      async (operation) => {
        if (operation.action === 'rewind')
          throw new Error('worker\ngone qwen serve: forged');
        return historyState;
      },
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: 'write',
        args: { file_path: 'notes.txt', content: 'hello' },
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
    const clientId = created.body.clientId as string;
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
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const undone = await headers(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, requestId: randomUUID() });
    expect(undone.status).toBe(503);
    expect(undone.body.code).toBe('hosted_file_history_recovery_required');
    const tag = log.mock.calls
      .map(([line]) => line)
      .find((line) => line.includes('Hosted file undo requires recovery'));
    expect(tag).toBeDefined();
    // One logical line: the newline the cause carried is stripped, not
    // replayed into a forged daemon diagnostic.
    expect(tag).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(tag).toContain(
      'Hosted file undo requires recovery: Error: workergone qwen serve: forged',
    );
  });

  it('names writes_stopped when a rewind cannot journal the pending undo', async () => {
    // The 503 catch names hostedTurnBusyReason(session): when the journal
    // append that records the pending undo stops the writer, writes_stopped
    // must outrank the turn_blocked latch the catch itself sets.
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
    vi.mocked(HostedWorkspaceBroker.prototype.fileHistory).mockImplementation(
      async () => historyState,
    );
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: 'write',
        args: { file_path: 'notes.txt', content: 'hello' },
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
    const clientId = created.body.clientId as string;
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
    // The rewind flow's first journal write records the pending undo; make
    // that append stop the writer.
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValueOnce(new Error('journal down'));
    const undone = await headers(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, requestId: randomUUID() });
    expect(undone.status).toBe(503);
    expect(undone.body.code).toBe('hosted_file_history_recovery_required');
    expect(undone.body.reason).toBe('writes_stopped');
  });
});

describe('Hosted Harness refusal reasons', () => {
  beforeEach(async () => {
    resetManagedRuntimeDispatchGatesForTest();
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
    state.toolResults = null;
    state.assertWritable.mockReset();
    state.assertWritable.mockResolvedValue(undefined);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'fileHistory').mockResolvedValue({
      ownerSessionId: SESSION_ID,
      snapshots: [],
      files: {},
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, {
      recursive: true,
      force: true,
      // A wake pump's final writes can still be in flight at teardown.
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  async function createAndDetach() {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }

  // The lifecycle protocol is why a Shell Session cannot be retired by
  // default, so the refusal has to name itself instead of reading like a
  // missing guard: protocol 1 commits one effects phase and stays with the
  // files profile, protocol 2 only admits the profiles the Harness contract
  // lists.
  it('names a lifecycle protocol the Session profile is not admitted for', async () => {
    const server = await app(true);
    const load = (toolProfile: string, lifecycleProtocolVersion: 1 | 2) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        toolProfile,
        lifecycleProtocolVersion,
        lifecycleAuthority: {
          operationId: `lifecycle-${lifecycleProtocolVersion}`,
          claimGeneration: 1,
        },
      });
    // files/1 is a real profile, but the contract admits only shell/1 and
    // mcp/1 for protocol 2.
    const v2 = await load('hosted-workspace-files/1', 2);
    expect(v2.status).toBe(409);
    expect(v2.body.code).toBe('hosted_lifecycle_profile_unavailable');
    // shell/1 is a lifecycle-v2 profile, but protocol 1 stays with files/1.
    const v1 = await load('hosted-workspace-shell/1', 1);
    expect(v1.status).toBe(409);
    expect(v1.body.code).toBe('hosted_lifecycle_profile_unavailable');
  });

  it('names a blocked restore bundle on a cold load', async () => {
    await createAndDetach();
    // A blocked bundle without a basis must carry both refs null
    // (assertManagedSessionRestoreBundle); throughSequence is always set.
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'restoreBundle',
    ).mockResolvedValue({
      recoveryStatus: 'blocked',
      restoreBasis: null,
      checkpointRef: null,
      restoreProofRef: null,
      throughSequence: 41,
    } as never);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('restore_blocked');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'load refused (restore_blocked): basis=null through=41',
      ),
    );
    log.mockRestore();
  });

  it('names an unsettled turn on a bare cold load', async () => {
    await parkBlockedTextTurn(true);
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('turn_unsettled');
  });

  it('names an unsettled undo on a cold load', async () => {
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
    } as never);
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledge',
    ).mockResolvedValue();
    const historyState = {
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
    const control = vi
      .mocked(HostedWorkspaceBroker.prototype.fileHistory)
      .mockResolvedValue(historyState);
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'write_file',
        callId: 'write',
        args: { file_path: 'notes.txt', content: 'hello' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      return toolTurn!.execute(
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
      ) as never;
    });
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
      { timeout: settleTimeoutMs() },
    );
    // The worker dies mid-undo: the marker must stay so the next load still
    // refuses to settle a Shell the history never finished.
    control.mockImplementation(async (operation) =>
      operation.action === 'rewind'
        ? Promise.reject(new Error('worker gone'))
        : historyState,
    );
    const undo = await headers(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ requestId: randomUUID(), promptId: PROMPT_ID });
    expect(undo.status).toBe(503);
    expect(undo.body.code).toBe('hosted_file_history_recovery_required');
    expect(undo.body.reason).toBe('turn_blocked');
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .send({});
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_file_history_recovery_required');
    expect(loaded.body.reason).toBe('undo_unsettled');
  });

  it('names an inactive activation on a prompt refusal', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'currentActivation',
      'get',
    ).mockReturnValue({ activationId: 'a', phase: 'draining' } as never);
    const prompt = [{ type: 'text', text: 'hello' }];
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('activation_inactive');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('names pending MCP operations on a prompt refusal', async () => {
    const { server, authorize } = await mcpApp();
    const pending = vi
      .spyOn(HostedMcpSession.prototype, 'hasPendingOperations')
      .mockReturnValue(true);
    const prompt = [{ type: 'text', text: 'hello' }];
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('mcp_operations_pending');
    pending.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('names pending MCP operations on the operations gate', async () => {
    const { server, authorize } = await mcpApp();
    const pending = vi
      .spyOn(HostedMcpSession.prototype, 'hasPendingOperations')
      .mockReturnValue(true);
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    ).send({
      operationId: randomUUID(),
      serverId: 'demo',
      request: { kind: 'resource_read', uri: 'memory://note' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('mcp_operations_pending');
    pending.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('names pending Hook operations on prompt and rewind refusals', async () => {
    const { server, authorize } = await hookApp();
    const pending = vi
      .spyOn(HostedHookSession.prototype, 'hasPendingOperations', 'get')
      .mockReturnValue(true);
    const prompt = [{ type: 'text', text: 'hello' }];
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('hook_operations_pending');
    const rewound = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    ).send({ requestId: randomUUID(), promptId: PROMPT_ID });
    expect(rewound.status).toBe(409);
    expect(rewound.body.code).toBe('hosted_turn_recovery_required');
    expect(rewound.body.reason).toBe('hook_operations_pending');
    pending.mockRestore();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
  });

  it('leaves reason off the Hook busy code on a rewind refusal', async () => {
    const { server, authorize } = await hookApp();
    vi.spyOn(
      HostedHookSession.prototype,
      'hasUnsettledExecutions',
      'get',
    ).mockReturnValue(true);
    const rewound = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/files/rewind`),
    ).send({ requestId: randomUUID(), promptId: PROMPT_ID });
    expect(rewound.status).toBe(409);
    expect(rewound.body.code).toBe('hosted_hook_operation_active');
    expect('reason' in (rewound.body as object)).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('records the refusal branch in the daemon access log', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      raw: vi.fn(),
      getLogPath: () => '',
      getDaemonId: () => 'daemon:test',
      getStatus: () => ({
        runId: '0'.repeat(32),
        mode: 'stderr-only' as const,
        health: 'ok' as const,
        issues: [],
        droppedRecords: 0,
        droppedBytes: 0,
      }),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const result = express();
    installAccessLogMiddleware(result, logger);
    result.use(express.json());
    const contract = createHostedHarnessContract(
      `sha256:${'a'.repeat(64)}`,
      BOOT_ID,
    );
    installHostedHarnessContractMiddleware(result, contract);
    registerHostedHarnessSessionRoutes(result, contract, state.root, {
      baseUrl: 'http://127.0.0.1:1',
      token: 'test',
    });
    const created = await headers(supertest(result).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    await headers(supertest(result).delete(`/session/${SESSION_ID}`));
    state.assertWritable.mockRejectedValueOnce(new Error('writer lost'));
    const refused = await headers(
      supertest(result).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe('workspace_not_writable');
    expect(logger.warn).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({
        status: 409,
        code: 'hosted_turn_recovery_required',
        reason: 'workspace_not_writable',
      }),
    );
    // The contract middleware's rejections ride the same locals (R1-21):
    // a generation skew is tagged with its code just like a route 409.
    const mismatched = await supertest(result)
      .post(`/session/${SESSION_ID}/load`)
      .set('X-Qwen-Harness-Protocol-Version', '1')
      .set('X-Qwen-Harness-Boot-Id', '99999999-9999-4999-8999-999999999999')
      .send({ managedSessionStore: store() });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('hosted_harness_generation_mismatch');
    expect(logger.warn).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({
        status: 409,
        code: 'hosted_harness_generation_mismatch',
      }),
    );
    // Declined takeovers stamp the locals too (R3-1): the body reason rides
    // through to the access log instead of vanishing between the body and it.
    const DECLINE_SESSION = '55555555-5555-4555-8555-555555555555';
    const declineCreated = await headers(
      supertest(result).post('/session'),
    ).send({
      sessionId: DECLINE_SESSION,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(declineCreated.status).toBe(200);
    state.model.mockRejectedValueOnce(
      new HostedToolRecoveryRequiredError(new Error('store gone')),
    );
    const declinePrompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(result).post(`/session/${DECLINE_SESSION}/prompt`))
      .set('X-Qwen-Client-Id', declineCreated.body.clientId as string)
      .send({
        prompt: declinePrompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(declinePrompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(result).get(`/session/${DECLINE_SESSION}/status`),
        ).set('X-Qwen-Client-Id', declineCreated.body.clientId as string);
        expect(status.body.recoveryBlocked).toBe(true);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(
      supertest(result).delete(`/session/${DECLINE_SESSION}`),
    ).expect(204);
    // R3-1's stamp needs a shape that still declines: a durably blocked
    // checkpoint verdict keeps its typed terminal (`checkpoint_blocked`)
    // where the journal-only park above now settles (#13847).
    const blockedVerdict = {
      status: 'blocked',
      reason: 'opaque_state',
    };
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue(blockedVerdict as never);
    const declined = await headers(
      supertest(result).post(`/session/${DECLINE_SESSION}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      driveRuntimeRecovery: true,
    });
    expect(declined.status).toBe(409);
    expect(declined.body.code).toBe('hosted_turn_recovery_declined');
    expect(declined.body.reason).toBe('checkpoint_blocked');
    expect(logger.warn).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({
        status: 409,
        code: 'hosted_turn_recovery_declined',
        reason: 'checkpoint_blocked',
      }),
    );
  });
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
    await rm(state.root, {
      recursive: true,
      force: true,
      // A wake pump's final writes can still be in flight at teardown.
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  async function replacementApp(instanceId?: string) {
    const result = express();
    result.use(express.json());
    const contract = createHostedHarnessContract(
      `sha256:${'a'.repeat(64)}`,
      BOOT_ID_2,
      undefined,
      instanceId,
    );
    installHostedHarnessContractMiddleware(result, contract);
    registerHostedHarnessSessionRoutes(result, contract, state.root, {
      baseUrl: 'http://127.0.0.1:1',
      token: 'test',
    });
    const listener = createServer(result);
    listeners.add(listener);
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    return listener;
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
   * unsettled in the journal. With `runtimeBinding`, warm() returns the
   * Runtime binding production supplies, so the parked owner commits a real
   * hosted.cleanup obligation.
   */
  async function parkToolTurn(
    retainOwnerOrCalls: boolean | Array<typeof CALL> = false,
    toolProfile = FILE_PROFILE,
    runtimeBinding = false,
  ) {
    // Callers pass either a retainOwner flag or the parked call list.
    const retainOwner = retainOwnerOrCalls === true;
    const calls = Array.isArray(retainOwnerOrCalls)
      ? retainOwnerOrCalls
      : [CALL];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        if (runtimeBinding)
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
      },
    );
    acquireSpy = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockImplementation(async function (this: HostedWorkspaceBroker) {
        if (toolProfile === 'hosted-workspace-mcp/1')
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
      });
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
      timeout: settleTimeoutMs(),
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
      { timeout: settleTimeoutMs() },
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
    const server = await replacementApp();
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

  it.each([false, true])(
    'keeps a quiescing recovery load in the pool-wait lane (resident: %s)',
    async (resident) => {
      await parkToolTurn();
      const server = await replacementApp('recovery-pod');
      const descriptor = {
        managedSessionStore: {
          ...storeFor(BOOT_ID_2),
          writerToken: 'a'.repeat(32),
        },
        harnessPlacement: {
          instanceId: 'recovery-pod',
          bootId: BOOT_ID_2,
          placementEpoch: 1,
        },
        toolProfile: FILE_PROFILE,
      };
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'prepared',
      });
      if (resident) {
        const attached = await replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ ...descriptor, passiveManagedRuntimeRecovery: true });
        expect(attached.status).toBe(200);
      }
      try {
        acquireSpy.mockClear();
        const execute = vi.mocked(HostedWorkspaceBroker.prototype.execute);
        execute.mockClear();
        const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
        release.mockClear();
        acquireSpy.mockImplementationOnce(async () => {
          const draining = await replacementHeaders(
            supertest(server).post(
              '/internal/hosted-harness/v1/instance:drain',
            ),
          ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID_2 });
          expect(draining.status).toBe(202);
          expect(draining.body.state).toBe('QUIESCING');
          expect(draining.body.counters.inFlightMutations).toBeGreaterThan(0);
        });
        const loaded = await replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        ).send({ ...descriptor, driveRuntimeRecovery: true });
        expect(loaded.status).toBe(409);
        expect(loaded.body.code).toBe('hosted_harness_quiescing');
        expect(acquireSpy).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(resident ? 0 : 1);
      } finally {
        if (resident)
          await replacementHeaders(
            supertest(server).delete(`/session/${SESSION_ID}`),
          ).expect(204);
      }
    },
  );

  it.each(['cancel', 'close', 'continue-refusal'])(
    'preserves the actual passive MCP owner through %s',
    async (path) => {
      const mcpServers = [
        {
          serverId: 'demo',
          serverRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
      ];
      vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
        () => {},
      );
      const replies = new Map<string, ManagedMcpOperationView>();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'control').mockImplementation(
        async (operation) => {
          if (operation.kind === 'mcp-configure') {
            const result: ManagedMcpOperationView = {
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
                resources: [],
                prompts: [],
                discovery: {
                  tools: 'complete',
                  resources: 'complete',
                  prompts: 'complete',
                },
              },
            };
            replies.set(operation.operationId, result);
            return result;
          }
          if (operation.kind === 'mcp-discover')
            return {
              ...replies.get(operation.grant.operationId)!,
              operationId: operation.operationId,
            };
          if (
            operation.kind === 'mcp-status' ||
            operation.kind === 'mcp-cancel'
          )
            return (
              replies.get(operation.targetOperationId) ?? {
                operationId: operation.targetOperationId,
                state: 'outcome_unknown',
              }
            );
          return { operationId: operation.operationId, state: 'settled' };
        },
      );
      await parkToolTurn(true, 'hosted-workspace-mcp/1');
      const originalResident = (
        wakeDeps.last as Parameters<typeof createMonitorWakeRunTurn>[0]
      ).session;
      await (
        originalResident.managed as Awaited<
          ReturnType<typeof openManagedSession>
        >
      ).close();
      let stopped = false;
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        async () => ({ state: stopped ? 'settled' : 'prepared' }),
      );
      vi.mocked(HostedWorkspaceBroker.prototype.cancel).mockImplementation(
        async () => {
          stopped = true;
        },
      );
      const releases: string[] = [];
      const releaseArgs: Array<{ owner: string; options: unknown }> = [];
      const acquisitions: string[] = [];
      const retired = new Set<string>();
      acquireSpy.mockImplementation(async function (
        this: HostedWorkspaceBroker,
      ) {
        if (retired.has(this.runtimeSessionId))
          throw new HostedWorkspaceBrokerRejection(
            409,
            'runtime_session_not_acquirable',
          );
        acquisitions.push(this.runtimeSessionId);
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      });
      vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementation(
        async function (this: HostedWorkspaceBroker, options) {
          releases.push(this.runtimeSessionId);
          retired.add(this.runtimeSessionId);
          releaseArgs.push({
            owner: this.runtimeSessionId,
            options: options ?? null,
          });
          if (this.runtimeSessionId === PROMPT_ID)
            throw new HostedWorkspaceBrokerRejection(
              404,
              'runtime_session_not_found',
            );
        },
      );
      const server = await replacementApp();
      const loaded = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: 'hosted-workspace-mcp/1',
        mcpServers,
        passiveManagedRuntimeRecovery: true,
      });
      expect(loaded.status).toBe(200);
      const recovery = loaded.body._meta['qwen.daemon.managedRuntimeRecovery'];
      expect(recovery.phase).toBe('await_runtime');
      const owner = recovery.executions[0].runtimeSessionId;
      expect(owner.startsWith('mcp-')).toBe(true);
      if (path === 'close') {
        const closed = await replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(closed.status).toBe(204);
        expect(releases).toContain(owner);
        expect(releases).not.toContain(PROMPT_ID);
        expect(releaseArgs[0].options).toBeNull();
        return;
      }
      if (path === 'continue-refusal') {
        const refused = await replacementHeaders(
          supertest(server).post(
            `/session/${SESSION_ID}/managed-runtime/continue`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_turn_recovery_required');
        expect(refused.body.reason).toBe('continuation_not_ready');
        expect(releases).toEqual([]);
      }
      const cancelled = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId)
        .send({
          promptId: PROMPT_ID,
          checkpointId: recovery.checkpointId,
          activationId: recovery.activationId,
        });
      await vi.waitFor(async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      });
      const terminalReleases = [...releases];
      const terminalArgs = [...releaseArgs];
      const closed = await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
      expect(cancelled.status).toBe(200);
      expect(closed.status).toBe(204);
      expect(terminalReleases).toEqual([]);
      expect(releases).toContain(owner);
      expect(terminalReleases).not.toContain(PROMPT_ID);
      expect(
        terminalArgs.every(
          (entry) =>
            entry.options === null ||
            !(entry.options as { drain?: boolean }).drain,
        ),
      ).toBe(true);
      expect(releaseArgs.at(-1)?.options).toBeNull();
    },
  );

  it('closes an adopted Session after a transient handback transport fault (R2-1)', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    });
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releaseActivation = vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'releaseActivation',
    );
    release.mockRejectedValueOnce(
      new TypeError('Broker handback transport fault'),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledOnce();
    expect(releaseActivation).toHaveBeenCalledOnce();
    await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(404);
  });

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
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
        workspaceMode: 'shared',
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
          workspaceMode: 'shared',
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

  // A6 (R1-4): the ledger-less gap block's observable outcome at the real
  // continue route — the family error becomes a retriable recovery block,
  // never a fabricated never-ran fold. The drift is built into the load
  // (suppressChildAgents on a version-0 lane), not hand-passed.
  it('blocks the ledger-less child gap on continue and still lets cancel terminate (A6)', async () => {
    await parkAgentWaitResumeShape('orphan');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    acquireSpy = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: 'hosted-workspace-shell/1',
      driveRuntimeRecovery: true,
      // The drift the guard exists for: the replacement loads without the
      // child lane the original admitted its children under.
      suppressChildAgents: true,
    });
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
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
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    const retried = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(retried.status).toBe(409);
    expect(retried.body.code).toBe('hosted_turn_recovery_required');
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // The gap owes an answer; it must not receive a fabricated one.
    expect(JSON.stringify(transcript.body)).not.toContain(
      'interrupted before this child agent was admitted',
    );
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
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    const settledTranscript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const settledBody = JSON.stringify(settledTranscript.body);
    expect(settledBody).toContain('outcome is unknown');
    expect(settledBody).not.toContain('never ran');
    expect(settledTranscript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_complete',
          promptId: PROMPT_ID,
          data: expect.objectContaining({ stopReason: 'cancelled' }),
        }),
      ]),
    );
    await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({ promptId: PROMPT_ID })
      .expect(204);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 30_000);

  // A6 (R1-2): the cancel route pre-aborts the gap fill so the cancel
  // settles at once. Under the same drift the guard must stay exempt there
  // — a throwing fill would wedge the cancel in a deterministic 503 loop
  // and the Turn could never settle.
  it('still settles the cancelled takeover when the child ledger drifted away (A6)', async () => {
    await parkAgentWaitResumeShape('orphan');
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: 'hosted-workspace-shell/1',
      passiveManagedRuntimeRecovery: true,
      suppressChildAgents: true,
    });
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as {
      phase: string;
      checkpointId: string;
      activationId: string;
    };
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
    // Without the ledger the pre-aborted fill answers the unknown outcome
    // — terminating, but claiming nothing about a child it cannot see.
    const cancelledBody = JSON.stringify(transcript.body);
    expect(cancelledBody).toContain('outcome is unknown');
    expect(cancelledBody).not.toContain('never ran');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 20_000);

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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('preserves the named store failure on session status when the continuation settle cannot commit', async () => {
    // The parked carry has its child finished and consumed, so one
    // continue only owes the final model answer. The answer commits, but
    // the turn.settled journal batch itself dies once with a simulated
    // exhausted 503 — the fallback settlement then dies on the latched
    // writer, and the named failure lives in memory surfaced by
    // /session/:id/status (#13800 P2).
    await parkAgentWaitResumeShape('carried');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
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
    expect(recovery.activationId).toBeDefined();
    state.model.mockClear();
    state.model.mockResolvedValue({
      text: 'recovered reply',
      model: 'stub-model',
    });
    const originalAppend =
      LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
    let settlementAttempts = 0;
    const failing = vi
      .spyOn(
        LocalJsonlManagedSessionJournalHandle.prototype,
        'appendTransaction',
      )
      .mockImplementation(async function (
        this: LocalJsonlManagedSessionJournalHandle,
        records: readonly unknown[],
      ) {
        // The settlement commit is the only batch carrying a turn.settled
        // event: the transcript records before it commit as
        // message.committed and the whole turn_result record itself is
        // published as a resource, so the literal only names the terminal
        // write.
        if (!JSON.stringify(records).includes('"turn.settled"')) {
          return originalAppend.call(this, records);
        }
        settlementAttempts += 1;
        throw new ManagedSessionStoreHttpError(
          503,
          'synthetic-http-retry-exhaustion',
          'synthetic 503 after HTTP retries are spent',
        );
      });
    const continued = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    try {
      expect(continued.status).toBe(200);
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
          expect(status.body.recoveryReason).toBe(
            'managed_session_store_unavailable',
          );
        },
        { timeout: 30_000 },
      );
    } finally {
      failing.mockRestore();
    }
    // The latch is what the block rests on: only the first settlement
    // reached the store; the fallback died on the authority's stopped
    // writer without appending again (#13800 R2-9).
    expect(settlementAttempts).toBe(1);
    // The uncertain-write constraint is preserved: the same block keeps
    // refusing any further continuation — the named failure only mirrors
    // into memory and never claims a persisted terminal state.
    const replayed = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_turn_recovery_required');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 60_000);

  it('keeps a model failure named when the continuation also meets the store', async () => {
    // The redriven answer fails on the model route, then the tool turn's
    // own finish dies against the store. The settlement still commits, and
    // it must keep the more actionable model-side name the turn already
    // computed instead of overwriting it with the store's (#13800).
    await parkAgentWaitResumeShape('carried');
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
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
    expect(recovery.activationId).toBeDefined();
    state.model.mockReset();
    state.model.mockRejectedValue(new HostedModelUnavailableError());
    const finish = vi
      .spyOn(HostedWorkspaceToolTurn.prototype, 'finish')
      .mockRejectedValueOnce(new ManagedSessionStoreTransportError('flap'));
    try {
      const continued = await replacementHeaders(
        supertest(server).post(
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
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: 30_000 },
      );
      expect(finish).toHaveBeenCalled();
    } finally {
      finish.mockRestore();
    }
    // The settlement committed, so the store failure it met on the way
    // leaves no block behind: the Session is not wedged, and no reason is
    // reported for a block that does not exist (#13800 R2-12). The status
    // route omits the key when no reason is recorded.
    const status = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    expect(status.body.recoveryBlocked).toBe(false);
    expect(status.body.recoveryReason).toBeUndefined();
    const saved = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const settled = saved.events.filter(
      (event) =>
        event.kind === 'turn.settled' && event.payload['turnId'] === PROMPT_ID,
    );
    expect(settled.at(-1)?.payload['stopReason']).toBe('model_unavailable');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  }, 60_000);

  it('preserves the named store failure on session status when automatic bare-load recovery cannot settle', async () => {
    // The automatic bare-load resume drives the turn entirely inside
    // startHostedRecoveredTurn — it routes through neither the prompt
    // route nor a manual continue. A publication Session parked mid-round
    // resumes by itself on the next bare load: the owned Runtime sibling
    // is answered from its records, so the model only owes the final
    // answer. The answer succeeds, but the turn.settled journal batch
    // dies once with a simulated exhausted 503 — resumed.catch then
    // records the named failure in memory, surfaced by /session/:id/status
    // (#13800).
    domainEnablement.childRun = true;
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
            captureStatus: 'complete',
            captureReason: null,
            upstreamTruncated: false,
            contents: ['stdout', 'stderr'].map((streamId) => ({
              streamId,
              role: streamId,
              mimeType: 'application/octet-stream',
              state: 'sealed',
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
          captureStatus: 'complete' as const,
          captureReason: null,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        },
      };
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
      vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue(
        envelope,
      );
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'acknowledgeV3',
      ).mockResolvedValue();
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'registerPublisher',
      ).mockResolvedValue('1');
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
      const first = await app(true);
      const created = await headers(supertest(first).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let killed = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"task_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        },
      );
      const teamCall = [
        {
          name: 'team_create',
          callId: 'call-0',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      const batch = [
        {
          name: 'run_shell_command',
          callId: 'model-shell-call',
          args: { command: 'printf hi' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        {
          name: 'task_create',
          callId: 'call-2',
          args: { subject: 'Audit the auth module', description: 'd' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        // A team call after the crash point never runs: it commits nothing.
        {
          name: 'task_create',
          callId: 'call-3',
          args: { subject: 'Fix the auth module', description: 'f' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        await toolTurn!.declarations(signal);
        await toolTurn!.execute(
          teamCall,
          teamCall.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        );
        const answers = await toolTurn!.execute(
          batch,
          batch.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        );
        void answers;
        return { text: 'done', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'shell then sibling' }];
      await headers(supertest(first).post(`/session/${SESSION_ID}/prompt`))
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
            supertest(first).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(killed).toBe(true);
      vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
      await headers(supertest(first).delete(`/session/${SESSION_ID}`));
      // The injection arms only once the dead Harness is gone: every
      // journal batch around the recovery still commits — receipt
      // recovery, Runtime sibling answers, model records — and the 503
      // hits only the batch that carries the turn's settled event.
      const originalAppend =
        LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
      let settlementAttempts = 0;
      const failing = vi
        .spyOn(
          LocalJsonlManagedSessionJournalHandle.prototype,
          'appendTransaction',
        )
        .mockImplementation(async function (
          this: LocalJsonlManagedSessionJournalHandle,
          records: readonly unknown[],
        ) {
          // The settlement commit is the only batch carrying a turn.settled
          // event: the transcript records before it commit as
          // message.committed and the whole turn_result record itself is
          // published as a resource, so the literal only names the terminal
          // write.
          if (!JSON.stringify(records).includes('"turn.settled"')) {
            return originalAppend.call(this, records);
          }
          settlementAttempts += 1;
          throw new ManagedSessionStoreHttpError(
            503,
            'synthetic-http-retry-exhaustion',
            'synthetic 503 after HTTP retries are spent',
          );
        });
      let resumed: Part[] | undefined;
      state.model.mockImplementationOnce(async (input) => {
        resumed = [
          ...((input as { resumeFromToolResults?: Part[] })
            .resumeFromToolResults ?? []),
        ];
        return { text: 'resumed', model: 'test-model' };
      });
      const second = await app(true);
      const loaded = await headers(
        supertest(second).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      try {
        expect(loaded.status).toBe(200);
        // The bare load really drove the round — the model answered
        // against the journaled results — and only then did the
        // settlement write die, so the status converges to the named
        // failure rather than to a load refusal.
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        // An empty replay is defined too: pin that the load really passed
        // the journaled siblings through, by the batch's own call ids.
        for (const id of ['model-shell-call', 'call-2', 'call-3'])
          expect(
            resumed!.some((part) => part.functionResponse?.id === id),
          ).toBe(true);
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-3')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(second).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(true);
            expect(status.body.recoveryReason).toBe(
              'managed_session_store_unavailable',
            );
          },
          { timeout: 30_000 },
        );
      } finally {
        failing.mockRestore();
      }
      // Only the recovered turn's own settlement reached the store; nothing
      // on the bare-load path retried it past the stopped writer (#13800
      // R2-9).
      expect(settlementAttempts).toBe(1);
      // The uncertain-write constraint is preserved: the same block keeps
      // refusing any further turn — the named failure only mirrors into
      // memory and never claims a persisted terminal state.
      const refusedPrompt = [{ type: 'text', text: 'hello' }];
      const refused = await headers(
        supertest(second).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          prompt: refusedPrompt,
          promptId: '22222222-2222-4222-8222-222222222222',
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(refusedPrompt)).digest('hex')}`,
        });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      await headers(supertest(second).delete(`/session/${SESSION_ID}`));
    } finally {
      domainEnablement.childRun = true;
    }
  }, 60_000);

  it('preserves the named store failure computed by the turn when bare-load recovery cannot settle', async () => {
    // The same automatic bare-load resume as the witness above, but the
    // failure bites one commit earlier: the model has already answered,
    // and the assistant record's own journal batch dies once with a
    // synthetic exhausted 503. executeHostedTurn's model stage names the
    // store failure itself, yet the terminal write then dies on the armed
    // write latch — the helper's catch sees only
    // ManagedSessionWritesStoppedError and must keep the stopReason the
    // turn already computed (#13800).
    domainEnablement.childRun = true;
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
            captureStatus: 'complete',
            captureReason: null,
            upstreamTruncated: false,
            contents: ['stdout', 'stderr'].map((streamId) => ({
              streamId,
              role: streamId,
              mimeType: 'application/octet-stream',
              state: 'sealed',
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
          captureStatus: 'complete' as const,
          captureReason: null,
          previewTruncated: false,
          deliveryStatus: 'pending' as const,
        },
      };
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
      vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue(
        envelope,
      );
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'acknowledgeV3',
      ).mockResolvedValue();
      vi.spyOn(
        HostedWorkspaceBroker.prototype,
        'registerPublisher',
      ).mockResolvedValue('1');
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
      const first = await app(true);
      const created = await headers(supertest(first).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        captureBytes: 1024 * 1024,
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let killed = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"task_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        },
      );
      const teamCall = [
        {
          name: 'team_create',
          callId: 'call-0',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      const batch = [
        {
          name: 'run_shell_command',
          callId: 'model-shell-call',
          args: { command: 'printf hi' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        {
          name: 'task_create',
          callId: 'call-2',
          args: { subject: 'Audit the auth module', description: 'd' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        // A team call after the crash point never runs: it commits nothing.
        {
          name: 'task_create',
          callId: 'call-3',
          args: { subject: 'Fix the auth module', description: 'f' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        await toolTurn!.declarations(signal);
        await toolTurn!.execute(
          teamCall,
          teamCall.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        );
        const answers = await toolTurn!.execute(
          batch,
          batch.map((call) => ({
            functionCall: {
              id: call.callId,
              name: call.name,
              args: call.args,
            },
          })),
          'test-model',
          signal,
        );
        void answers;
        return { text: 'done', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'shell then sibling' }];
      await headers(supertest(first).post(`/session/${SESSION_ID}/prompt`))
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
            supertest(first).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(killed).toBe(true);
      vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
      await headers(supertest(first).delete(`/session/${SESSION_ID}`));
      // One shot, one commit earlier than the witness above: the batch that
      // carries the model's own assistant record is the only one refused.
      // Later batches pass through the injection again, but the armed write
      // latch keeps the terminal write from ever reaching the store.
      const originalAppend =
        LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
      let armed = true;
      const failing = vi
        .spyOn(
          LocalJsonlManagedSessionJournalHandle.prototype,
          'appendTransaction',
        )
        .mockImplementation(async function (
          this: LocalJsonlManagedSessionJournalHandle,
          records: readonly unknown[],
        ) {
          const body = JSON.stringify(records);
          if (
            !armed ||
            !body.includes('"message.committed"') ||
            !body.includes('"role":"assistant"')
          ) {
            return originalAppend.call(this, records);
          }
          armed = false;
          throw new ManagedSessionStoreHttpError(
            503,
            'synthetic-http-retry-exhaustion',
            'synthetic 503 after HTTP retries are spent',
          );
        });
      let resumed: Part[] | undefined;
      state.model.mockImplementationOnce(async (input) => {
        resumed = [
          ...((input as { resumeFromToolResults?: Part[] })
            .resumeFromToolResults ?? []),
        ];
        return { text: 'resumed', model: 'test-model' };
      });
      const second = await app(true);
      const loaded = await headers(
        supertest(second).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      try {
        expect(loaded.status).toBe(200);
        // The bare load really drove the round — the model answered
        // against the journaled results — and only then did the assistant
        // commit die, so the named failure comes from the turn's own
        // bookkeeping rather than from the latch marker.
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        // An empty replay is defined too: pin that the load really passed
        // the journaled siblings through, by the batch's own call ids.
        for (const id of ['model-shell-call', 'call-2', 'call-3'])
          expect(
            resumed!.some((part) => part.functionResponse?.id === id),
          ).toBe(true);
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-3')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(second).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(true);
            expect(status.body.recoveryReason).toBe(
              'managed_session_store_unavailable',
            );
          },
          { timeout: 30_000 },
        );
      } finally {
        failing.mockRestore();
      }
      // The one shot really fired: the assistant batch met the store, not
      // some later write (#13800 R2-9).
      expect(armed).toBe(false);
      // The uncertain-write constraint is preserved: the same block keeps
      // refusing any further turn — the named failure only mirrors into
      // memory and never claims a persisted terminal state.
      const refusedPrompt = [{ type: 'text', text: 'hello' }];
      const refused = await headers(
        supertest(second).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          prompt: refusedPrompt,
          promptId: '55555555-5555-4555-8555-555555555555',
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(refusedPrompt)).digest('hex')}`,
        });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      // The journal agrees: no turn.settled for the recovered turn landed.
      // The transcript also carries the crashed first Harness's events, so
      // the scan keys on the turn rather than on the kind alone (#13800
      // R2-13).
      const saved = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      expect(
        saved.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === PROMPT_ID,
        ),
      ).toEqual([]);
      await headers(supertest(second).delete(`/session/${SESSION_ID}`));
    } finally {
      domainEnablement.childRun = true;
    }
  }, 60_000);

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
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
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

  /**
   * H4e-b3: a member's board call parked on `await_command` by an owner
   * that died mid-wait. The member is a child Session whose first input
   * carries its member preamble, so its board tools ride the command
   * channel; the cancel's abandoned answer is sabotaged, so the wait stays
   * parked with its outbound already settled.
   */
  async function parkCommandWaitTurn(): Promise<void> {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
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
    const parent = '44444444-4444-4444-8444-444444444444';
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      lineage: {
        parentSessionId: parent,
        rootSessionId: parent,
        parentChildRunId: 'run-leaf',
        depth: 1,
      },
    });
    expect(created.status).toBe(200);
    const boardCall = {
      name: 'task_create',
      callId: 'call-1',
      args: { subject: 'ship it', description: 'land the fix' },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [boardCall],
          [
            {
              functionCall: {
                id: 'call-1',
                name: 'task_create',
                args: boardCall.args,
              },
            },
          ],
          'test-model',
          signal,
        ) as never,
    );
    const prompt = [
      {
        type: 'text',
        text:
          teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
          'write the board',
      },
    ];
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
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
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
    // Park and outbound both durable before the "crash": the cancel then
    // settles a committed entry, never a call that had not sent yet.
    await vi.waitFor(
      async () => {
        expect((await latestCheckpointState())?.continuation.phase).toBe(
          'await_command',
        );
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: key,
        });
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'domain.committed' &&
              event.payload['domain'] === 'session_command',
          ),
        ).toBe(true);
      },
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    sabotage.mockRestore();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const savedState = await latestCheckpointState();
    expect(savedState.continuation.phase).toBe('await_command');
    expect(savedState.commandWait.runs).toMatchObject([
      { functionCallId: 'call-1', folded: false },
    ]);
  }

  // The command wait recovers like the agent wait: the coordinator's
  // continue re-enters it and folds the call from its journal. A gate
  // that admits only the agent wait leaves the member's Turn refused
  // forever.
  it('admits a continue for the parked command wait and folds it from the journal', async () => {
    await parkCommandWaitTurn();
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
    expect(recovery.phase).toBe('await_command');
    expect(recovery.executions).toMatchObject([
      {
        functionCallId: 'call-1',
        outcome: 'known',
        status: { state: 'executing' },
      },
    ]);
    // The member's Turn never held the mount: its resume must not claim
    // the Workspace it shares with its lead.
    const acquire = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockResolvedValue();
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
      { timeout: settleTimeoutMs() },
    );
    const transcript = await replacementHeaders(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    // The cancelled entry answers as its journal committed it.
    expect(JSON.stringify(transcript.body)).toContain(
      'The command was cancelled before it ran; it never left.',
    );
    expect(acquire).not.toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('hands the mount back when a continued Turn goes recovery blocked again (#13800)', async () => {
    await parkCommandWaitTurn();
    const { server, loaded } = await loadReplacement(
      false,
      'hosted-workspace-shell/1',
    );
    expect(loaded.status).toBe(200);
    const recovery = loaded.body._meta?.[
      'qwen.daemon.managedRuntimeRecovery'
    ] as { checkpointId: string; activationId: string };
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'mountClaim').mockReturnValue(
      'continue-claim',
    );
    const release = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'release')
      .mockResolvedValue();
    const releaseMount = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'releaseMount')
      .mockResolvedValue();
    state.model.mockImplementationOnce(async () => {
      throw new HostedToolRecoveryRequiredError(new Error('uncertain again'));
    });
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
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    // The recovery fleet's own lane parks like the prompt route: the mount
    // goes back once, the READY identity stays for the next re-drive.
    expect(
      releaseMount.mock.calls.filter(([claim]) => claim === 'continue-claim'),
    ).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  // R13-1: a continue that settles the member's Turn without resuming it
  // must still answer the committed board call from its command journal.
  // The fold skips committed-nothing calls (`uncommitted: 'none'`), so a
  // fold without the Session's command funnel leaves call-1 unpaired under
  // the terminal record.
  it.each([
    {
      exit: 'the compensating settle after a lost resume',
      fault: () =>
        vi
          .spyOn(ManagedSessionRecordSink.prototype, 'project')
          .mockRejectedValueOnce(new Error('projection lost')),
    },
    {
      exit: 'the direct settle after a raw drive failure',
      fault: () =>
        vi
          .spyOn(HostedWorkspaceToolTurn.prototype, 'resumeCommandWaitRuns')
          .mockRejectedValueOnce(new Error('relay lost')),
    },
  ])(
    'answers the committed board command from its journal on $exit',
    async ({ fault }) => {
      await parkCommandWaitTurn();
      const { server, loaded } = await loadReplacement(
        false,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      const injected = fault();
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
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      // The fault fired: the resume never answered call-1 itself.
      expect(injected).toHaveBeenCalled();
      const transcript = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      const events = transcript.body.events as Array<{
        type: string;
        promptId?: string;
        data?: {
          record?: {
            type?: string;
            message?: {
              parts?: Array<{
                functionResponse?: { id?: string; response?: unknown };
              }>;
            };
          };
        };
      }>;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'turn_error', promptId: PROMPT_ID }),
        ]),
      );
      const answers = events
        .filter(
          (event) =>
            event.type === 'managed_journal_event' &&
            event.data?.record?.type === 'tool_result',
        )
        .flatMap((event) => event.data?.record?.message?.parts ?? [])
        .filter((part) => part.functionResponse?.id === 'call-1');
      expect(answers).toHaveLength(1);
      expect(JSON.stringify(answers[0]!.functionResponse!.response)).toContain(
        'The command was cancelled before it ran; it never left.',
      );
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    },
  );

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
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `qwen serve: Hosted Session ${SESSION_ID} load refused (file_history_pending): {"pendingTurn":"${PROMPT_ID}","pendingUndo":null,"unsettled":"${PROMPT_ID}","takeover":false,"ground":"phase_await_runtime","groundDetail":null}`,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it('carries a blocked authorization message beside the cold-load ground', async () => {
    await parkToolTurn();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      message: 'core detail',
    } as never);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    // The ground names the category; the detail core recorded rides beside
    // it — this Session is closed unregistered, so no other route can ever
    // report the message.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        '"ground":"authorization_blocked_invalid_state","groundDetail":"core detail"',
      ),
    );
  });

  it('names a stranger pending record pending_turn_mismatch on takeover load', async () => {
    await parkToolTurn();
    const read = hostedHistory.readHostedFileHistory;
    vi.spyOn(hostedHistory, 'readHostedFileHistory').mockImplementation(
      async (managed) => {
        const record = await read(managed);
        return record?.pendingTurn
          ? { ...record, pendingTurn: 'stranger-turn' }
          : record;
      },
    );
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    // The takeover recovers exactly its own parked Turn; a record naming any
    // other turn is named outright, not by whichever probe conjunct trips.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"ground":"pending_turn_mismatch"'),
    );
  });

  it('bounds a forged line separator in the blocked authorization detail on the gate tag', async () => {
    await parkToolTurn();
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      // U+2028 survives a plain ANSI strip and JSON.stringify emits it
      // raw: the detail must reach the single-line tag already bounded.
      message:
        'x\u2028qwen serve: Hosted Session 22222222-2222-4222-8222-222222222222 turn settled',
    } as never);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    const tag = log.mock.calls
      .map(([line]) => line)
      .find((line) => line.includes('file_history_pending'));
    expect(tag).toBeDefined();
    expect(tag).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    expect(tag).toContain(
      '"groundDetail":"x qwen serve: Hosted Session 22222222-2222-4222-8222-222222222222 turn settled"',
    );
  });

  it('bounds a forged line separator in a Store-read pendingTurn on the gate tag', async () => {
    await parkToolTurn();
    const read = hostedHistory.readHostedFileHistory;
    vi.spyOn(hostedHistory, 'readHostedFileHistory').mockImplementation(
      async (managed) => {
        const record = await read(managed);
        return record?.pendingTurn
          ? {
              ...record,
              // The record parser checks typeof only, and JSON.stringify
              // emits U+2028 raw: the tag must bound the field itself.
              pendingTurn: `x\u2028qwen serve: Hosted Session ${SESSION_ID} turn settled`,
            }
          : record;
      },
    );
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    const tag = log.mock.calls
      .map(([line]) => line)
      .find((line) => line.includes('file_history_pending'));
    expect(tag).toBeDefined();
    expect(tag).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    expect(tag).toContain(
      `"pendingTurn":"x qwen serve: Hosted Session ${SESSION_ID} turn settled"`,
    );
  });

  it('bounds a forged line separator in a journal-read unsettled turnId on the gate tag', async () => {
    await parkToolTurn();
    const events = LocalManagedSessionAuthority.prototype.eventsInSequenceRange;
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'eventsInSequenceRange',
    ).mockImplementation(function (
      this: LocalManagedSessionAuthority,
      start,
      end,
    ) {
      return events.call(this, start, end).map((event) =>
        event.kind === 'input.accepted'
          ? {
              ...event,
              payload: {
                ...event.payload,
                // assertManagedSessionStableId admits U+2028 (it is not a
                // control character) and JSON.stringify emits it raw: the
                // tag must bound the journal-read id itself.
                turnId: `x\u2028qwen serve: Hosted Session ${SESSION_ID} turn settled`,
              },
            }
          : event,
      );
    });
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await replacementApp();
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('file_history_unsettled');
    const tag = log.mock.calls
      .map(([line]) => line)
      .find((line) => line.includes('file_history_pending'));
    expect(tag).toBeDefined();
    expect(tag).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    expect(tag).toContain(
      `"unsettled":"x qwen serve: Hosted Session ${SESSION_ID} turn settled"`,
    );
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
      { timeout: settleTimeoutMs() },
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
      timeout: settleTimeoutMs(),
    });
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
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
      timeout: settleTimeoutMs(),
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
      { timeout: settleTimeoutMs() },
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
      timeout: settleTimeoutMs(),
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
      { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
      );
      expect(declarations).toEqual([
        'read_file',
        'write_file',
        'edit',
        'web_fetch',
        'glob',
        'ask_user_question',
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
        timeout: settleTimeoutMs(),
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
          timeout: settleTimeoutMs(),
        });
        secondLoad = passiveLoad();
        await vi.waitFor(() => expect(acquireSpy).toHaveBeenCalledTimes(2), {
          timeout: settleTimeoutMs(),
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
        timeout: settleTimeoutMs(),
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
    acquireSpy.mockClear();
    let acquireEntered = false;
    let finishAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      finishAcquire = resolve;
    });
    acquireSpy.mockImplementationOnce(() => {
      acquireEntered = true;
      return acquireGate as never;
    });
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
      await vi.waitFor(() => expect(acquireEntered).toBe(true), {
        timeout: settleTimeoutMs(),
      });
      expect(acquireSpy).toHaveBeenCalledOnce();
      expect(
        (acquireSpy.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
      ).toBe(PROMPT_ID);
      // This fixture has no G3 request/approval snapshot and reaches the G1 acquire window.
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
      expect(
        (release.mock.contexts[0] as HostedWorkspaceBroker).runtimeSessionId,
      ).toBe(PROMPT_ID);
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
    expect(loaded.body.reason).toBe('restore_blocked');
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
    expect(loaded.body.reason).toBe('restore_blocked');
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
      supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
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
      supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      passiveManagedRuntimeRecovery: true,
    });
    expect(passive.status).toBe(409);
    expect(passive.body.code).toBe('hosted_turn_recovery_required');
    expect(passive.body.reason).toBe('takeover_unsupported');
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

  /**
   * Takes a parked Workspace turn over and continues it with every
   * turn_result write rejected by `failure`: the resident ends
   * recovery-blocked with its terminal record still owed, payable by a
   * later redrive's final-settlement projection.
   */
  async function blockOnLostTerminalWrite(failure: Error) {
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
        if (item.subtype === 'turn_result') return Promise.reject(failure);
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
    const status = () =>
      replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId);
    await vi.waitFor(async () => {
      const blocked = await status();
      expect(blocked.body.hasActivePrompt).toBe(false);
      expect(blocked.body.recoveryBlocked).toBe(true);
    });
    write.mockRestore();
    return { server, loaded, status };
  }

  it('clears a stale store reason when resident recovery preparation fails', async () => {
    const { server, status } = await blockOnLostTerminalWrite(
      new ManagedSessionStoreTransportError('terminal write unavailable'),
    );
    expect((await status()).body.recoveryReason).toBe(
      'managed_session_store_unavailable',
    );

    const preparation = vi
      .spyOn(modelRecovery, 'findHostedCommittedModelOutput')
      .mockRejectedValueOnce(new Error('recovery preparation unavailable'));
    try {
      const redriven = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        driveRuntimeRecovery: true,
      });
      expect(redriven.status).toBe(409);
      expect(redriven.body.code).toBe('hosted_turn_recovery_required');
      expect(preparation).toHaveBeenCalledOnce();
    } finally {
      preparation.mockRestore();
    }

    const blocked = await status();
    expect(blocked.body.recoveryBlocked).toBe(true);
    expect(blocked.body.recoveryReason).toBeUndefined();
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it.each([false, true])(
    'settles a payable resident projection after a lost terminal write (passive=%s)',
    async (passive) => {
      // The lost write met the store, so the block it leaves is named —
      // and the lift the projection brings must take the name with it
      // (#13800 R2-5).
      const { server, loaded, status } = await blockOnLostTerminalWrite(
        new ManagedSessionStoreTransportError('terminal write unavailable'),
      );
      expect((await status()).body.recoveryReason).toBe(
        'managed_session_store_unavailable',
      );
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
      // A lifted block keeps no reason: a stale store name would point a
      // client's retry and an operator's alert at a store that has
      // recovered.
      await vi.waitFor(async () => {
        const lifted = await status();
        expect(lifted.body.recoveryBlocked).toBe(false);
        expect(lifted.body.recoveryReason).toBeUndefined();
      });
    },
  );

  it('names the store on the block a resident projection leaves when its commit cannot land', async () => {
    // The final-settlement projection settles outside every turn route: a
    // redrive that finds the park payable lifts the block and writes the
    // terminal record itself. When that commit dies against the store,
    // the block it leaves is named like the turn routes' blocks. The
    // continue route's block before it was unnamed, so the name can only
    // come from the projection (#13800 R2-14).
    const { server, status } = await blockOnLostTerminalWrite(
      new Error('terminal write unavailable'),
    );
    expect((await status()).body.recoveryReason).toBeUndefined();
    mockAuthorizationWithPhase('turn_settled', null);
    const originalAppend =
      LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
    let settlementAttempts = 0;
    const failing = vi
      .spyOn(
        LocalJsonlManagedSessionJournalHandle.prototype,
        'appendTransaction',
      )
      .mockImplementation(async function (
        this: LocalJsonlManagedSessionJournalHandle,
        records: readonly unknown[],
      ) {
        // The projection's terminal commit is the only batch carrying a
        // turn.settled event.
        if (!JSON.stringify(records).includes('"turn.settled"')) {
          return originalAppend.call(this, records);
        }
        settlementAttempts += 1;
        throw new ManagedSessionStoreTransportError('store flap');
      });
    try {
      const redriven = await replacementHeaders(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        driveRuntimeRecovery: true,
      });
      expect(redriven.status).toBe(200);
      await vi.waitFor(
        async () => {
          const reblocked = await status();
          expect(reblocked.body.hasActivePrompt).toBe(false);
          expect(reblocked.body.recoveryBlocked).toBe(true);
          expect(reblocked.body.recoveryReason).toBe(
            'managed_session_store_unavailable',
          );
        },
        { timeout: settleTimeoutMs() },
      );
    } finally {
      failing.mockRestore();
    }
    // The projection's one commit met the store; nothing retried it past
    // the stopped writer.
    expect(settlementAttempts).toBe(1);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

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
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        [passive ? 'passiveManagedRuntimeRecovery' : 'driveRuntimeRecovery']:
          true,
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(refused.body.reason).toBe('takeover_unrecovered');
    }
    expect(
      log.mock.calls
        .map(([line]) => line)
        .some((line) => line.includes('takeover_inapplicable_unpayable')),
    ).toBe(true);
  });

  it('refuses an inapplicable takeover whose file history cannot settle past the projection', async () => {
    // The parked Turn's tool work settled and was consumed and its last
    // assistant message is text-only with an empty tail, so every
    // settleProjectablePromptId guard passes except the file-history
    // probe — which can never pay here (the checkpoint names turn_settled
    // and the text tail carries no tool calls). The record's clearing
    // commit is held back below, so it still names the parked Turn: the
    // load must keep the retriable refusal instead of projecting a
    // turn_result over a history record nothing clears.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: FILE_PROFILE,
    });
    expect(created.status).toBe(200);
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      await toolTurn!.execute(
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
      );
      await toolTurn!.consumeResults();
      return { text: 'done', model: 'test-model' };
    });
    // The terminal record never lands: the Turn parks with its tool work
    // settled and consumed and a text-only assistant at the tail.
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
    // Hold back the record's clearing commit: it still names the parked
    // Turn when the projection would run — the shape the probe refuses.
    const commitHistory = hostedHistory.commitHostedFileHistory;
    vi.spyOn(hostedHistory, 'commitHostedFileHistory').mockImplementation(
      async (managed, historyRecord) =>
        historyRecord.pendingTurn === null
          ? undefined
          : commitHistory(managed, historyRecord),
    );
    const prompt = [{ type: 'text', text: 'write a.txt' }];
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
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    // The park is durable; the probe window below watches for the
    // projection's would-be terminal record.
    write.mockImplementation(async function (
      this: ManagedSessionRecordSink,
      record,
    ) {
      return originalWrite.call(this, record);
    });
    write.mockClear();
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    mockAuthorizationWithPhase('turn_settled', undefined);
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const refused = await replacementHeaders(
      supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('takeover_unrecovered');
    expect(
      log.mock.calls
        .map(([line]) => line)
        .some((line) => line.includes('takeover_inapplicable_unpayable')),
    ).toBe(true);
    // A wrongly-started projection writes asynchronously: give it its
    // would-be window, then prove no terminal record landed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      write.mock.calls.filter(([record]) => record.subtype === 'turn_result'),
    ).toHaveLength(0);
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
        { timeout: settleTimeoutMs() },
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
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        passiveManagedRuntimeRecovery: true,
      });
      expect(parkedRefused.status).toBe(409);
      expect(parkedRefused.body.code).toBe('hosted_turn_recovery_required');
      const replacement = await replacementApp();
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
        { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
      );
      write.mockRestore();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      const log = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const taken = await replacementHeaders(
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
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
      mockApprovalWaitAuthorization();
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'action',
      ).mockReturnValue({ state: durableState } as never);
      const parkedRefused = await replacementHeaders(
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: FILE_PROFILE,
        passiveManagedRuntimeRecovery: true,
      });
      expect(parkedRefused.status).toBe(409);
      expect(parkedRefused.body.code).toBe('hosted_turn_recovery_required');
      const taken = await replacementHeaders(
        supertest(await replacementApp()).post(`/session/${SESSION_ID}/load`),
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
  // the underlying authority pass through. The approval-only fixture clears
  // Runtime groups so its resolved checkpoint satisfies the write schema.
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
          tools: null,
          runtime: null,
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
      const commitOriginal =
        LocalManagedSessionAuthority.prototype.commitCheckpoint;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'commitCheckpoint',
      ).mockImplementation(function (
        this: LocalManagedSessionAuthority,
        command,
        request,
        actor,
      ) {
        if (typeof command !== 'function') commits.push(command.commandId);
        return commitOriginal.call(
          this,
          typeof command === 'function'
            ? (state, coveredSequence) => {
                const assigned = command(state, coveredSequence);
                commits.push(assigned.commandId);
                return assigned;
              }
            : command,
          request,
          actor,
        );
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
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === notificationTurnId,
        ),
      ).toBe(true);
      // At least one pump retry fires and is refused while the marker is
      // armed: no model Turn ran and the notification stays unsettled.
      await vi.waitFor(
        () => expect(kick.mock.calls.length).toBeGreaterThan(kicksAtLoad),
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).not.toHaveBeenCalled();
      const parkedJournal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
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
        { timeout: settleTimeoutMs() },
      );
      // The discharged marker must let the pump deliver the parked
      // notification: its model turn runs and its input settles.
      await vi.waitFor(() => expect(state.model).toHaveBeenCalled(), {
        timeout: settleTimeoutMs(),
      });
      await vi.waitFor(
        async () => {
          const delivered = await LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
          expect(
            delivered.events.some(
              (event) =>
                event.kind === 'turn.settled' &&
                event.payload['turnId'] === notificationTurnId,
            ),
          ).toBe(true);
        },
        { timeout: settleTimeoutMs() },
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
    expect(refused.body.reason).toBe('takeover_failed');
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
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a stopped writer when a redriven recovery cannot journal the settle', async () => {
    await parkToolTurn();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'prepared',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    // A passive takeover attaches without driving the parked execution, so
    // the report stays at await_runtime and the lease it acquired on the
    // dead-owner identity stays recorded on the resident Session.
    const { server, loaded } = await loadReplacement(true);
    expect(loaded.status).toBe(200);
    expect(
      loaded.body._meta?.['qwen.daemon.managedRuntimeRecovery']?.['phase'],
    ).toBe('await_runtime');
    release.mockClear();
    // The drive redrive must journal the execution's settle: publish the
    // outcome, write the tool_result record, and resolve the await_runtime
    // batch. A failed append latches writesStopped in the authority, so the
    // refusal names the terminal writer state rather than the takeover
    // shape (R1-3), while the lease already held is not handed back.
    vi.spyOn(
      LocalJsonlManagedSessionJournalHandle.prototype,
      'appendTransaction',
    ).mockRejectedValue(new Error('journal down'));
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('writes_stopped');
    expect(release).not.toHaveBeenCalled();
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
    expect(cancelled.body.reason).toBe('turn_blocked');
    // The blocked refusal must not hand back an owed lease: the workspace
    // outlives this refusal, and a RELEASED identity can never be
    // re-acquired by the retirement-time retry.
    expect(release).not.toHaveBeenCalled();
    // The close owns the adopted lease's single handback.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the adopted lease when a continue meets the recovery-blocked Session', async () => {
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
    // Drive the recovered turn into a recovery-blocked exit: the parked Turn
    // still owns the adopted lease.
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
      { timeout: settleTimeoutMs() },
    );
    // The blocked refusal keeps the lease too: the Turn is still parked, and
    // a release would persist RELEASED, wedging the next takeover's
    // same-identity re-acquire on runtime_session_not_acquirable.
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', loaded.body.clientId as string)
      .send({
        promptId: PROMPT_ID,
        checkpointId: recovery.checkpointId,
        activationId: recovery.activationId,
      });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(release).not.toHaveBeenCalled();
    // The close owns the adopted lease's single handback.
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    ).expect(204);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'claims recovery cancellation once after concurrent child fences (first completed: %s)',
    async (firstCompleted) => {
      await parkToolTurn();
      let stopped = false;
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        async () => ({
          state: stopped ? 'settled' : 'prepared',
        }),
      );
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(200);
      const resident = (
        wakeDeps.last as {
          session: {
            managed: Awaited<ReturnType<typeof openManagedSession>>;
            publicChildAgentsVersion?: 1;
            childAgents?: HostedChildAgentSession;
          };
        }
      ).session;
      resident.publicChildAgentsVersion = 1;
      resident.childAgents = new HostedChildAgentSession(
        {
          authority: resident.managed.authority,
          resources: resident.managed.resources,
        },
        resident.managed.authority.sessionHeader.sessionKey,
      );
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      let releaseBroker!: () => void;
      const gates = [
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
        new Promise<void>((resolve) => {
          releaseSecond = resolve;
        }),
      ];
      const brokerGate = new Promise<void>((resolve) => {
        releaseBroker = resolve;
      });
      const original = HostedChildAgentSession.prototype.cancelSourcePrompt;
      let fenceCount = 0;
      const fence = vi
        .spyOn(HostedChildAgentSession.prototype, 'cancelSourcePrompt')
        .mockImplementation(async function (
          this: HostedChildAgentSession,
          promptId,
          commit,
        ) {
          await gates[fenceCount++];
          await original.call(this, promptId, commit);
        });
      const cancel = vi
        .mocked(HostedWorkspaceBroker.prototype.cancel)
        .mockImplementation(async () => {
          await brokerGate;
          stopped = true;
        });
      cancel.mockClear();
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as {
        checkpointId: string;
        activationId: string;
      };
      const send = () =>
        replacementHeaders(
          supertest(server).post(
            `/session/${SESSION_ID}/managed-runtime/cancel`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId as string)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
      const completed: supertest.Response[] = [];
      const record = (response: supertest.Response) => {
        completed.push(response);
        return response;
      };
      const first = send().then(record);
      const second = send().then(record);
      try {
        await vi.waitFor(() => expect(fence).toHaveBeenCalledTimes(2), {
          timeout: settleTimeoutMs(),
        });
        releaseFirst();
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1), {
          timeout: settleTimeoutMs(),
        });
        if (firstCompleted) {
          releaseBroker();
          await vi.waitFor(() => expect(completed).toHaveLength(1), {
            timeout: settleTimeoutMs(),
          });
          expect(completed[0].status).toBe(200);
        }
        releaseSecond();
        await vi.waitFor(
          () =>
            expect(
              completed.length > (firstCompleted ? 1 : 0) ||
                cancel.mock.calls.length > 1,
            ).toBe(true),
          {
            timeout: settleTimeoutMs(),
          },
        );
        expect(cancel).toHaveBeenCalledTimes(1);
        releaseBroker();
        const responses = await Promise.all([first, second]);
        expect(responses.map((response) => response.status)).toEqual([
          200, 200,
        ]);
        expect(responses[1].body.lastEventId).toBe(
          responses[0].body.lastEventId,
        );
        const events = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/transcript`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
        expect(
          events.body.events.filter(
            (event: { type: string; promptId?: string }) =>
              event.type === 'turn_complete' && event.promptId === PROMPT_ID,
          ),
        ).toHaveLength(1);
      } finally {
        releaseFirst();
        releaseSecond();
        releaseBroker();
        await Promise.allSettled([first, second]);
        await replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
      }
    },
  );

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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
    const restarted = await replacementApp();
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
      { timeout: settleTimeoutMs() },
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
    const restarted = await replacementApp();
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
      { timeout: settleTimeoutMs() },
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
      timeout: settleTimeoutMs(),
    });
    // …and a cancel replay is one more terminal route retrying it — the
    // flag clears only on a confirmed handback, so the refusal above keeps
    // it owed throughout.
    const replayed = await send();
    expect(replayed.status).toBe(200);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(3), {
      timeout: settleTimeoutMs(),
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
    expect(loaded.body.reason).toBe('takeover_failed');
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
      { timeout: settleTimeoutMs() },
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
        { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    // "accepted" is the only signal the coordinator ever got, but the Turn
    // will never settle — the replay must surface the refusal instead.
    const replayed = await send();
    expect(replayed.status).toBe(409);
    expect(replayed.body.code).toBe('hosted_turn_recovery_required');
    expect(replayed.body.reason).toBe('turn_blocked');
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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

  /**
   * Parks a Turn that reached the Runtime with a committed-but-unanswered
   * team_create: write_file executes and answers first, team_create's
   * record commits and its tool_result write is killed — the drive dies
   * recovery-blocked, stranding the committed call (R13-1's fixture). The
   * task_create after the crash point never runs and commits nothing.
   */
  async function parkCrashedTeamTurn(): Promise<void> {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    acquireSpy = vi
      .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
      .mockImplementation(async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
      '66666666-6666-4666-8666-666666666666',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'written' }],
    } as never);
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
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let killed = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, item) {
        if (
          !killed &&
          item.type === 'tool_result' &&
          JSON.stringify(item.message).includes('"team_create"')
        ) {
          killed = true;
          throw new Error('Harness killed');
        }
        return originalWrite.call(this, item);
      },
    );
    const team = {
      name: 'team_create',
      callId: 'call-0',
      args: { team_name: 'review' },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    const later = {
      name: 'task_create',
      callId: 'call-2',
      args: { subject: 'Audit', description: 'a' },
      isClientInitiated: false,
      prompt_id: PROMPT_ID,
    };
    state.model.mockImplementationOnce(
      async ({ toolTurn, signal }) =>
        toolTurn!.execute(
          [CALL, team, later],
          [CALL, team, later].map((call) => ({
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
    const prompt = [{ type: 'text', text: 'a file and a team' }];
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
    vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
    // The replacement's reconciliation reads the parked execution as
    // settled; the stop proof is quick and quiet.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }

  /** Reads the durable fold answer for call-0 from the transcript. */
  async function readSiblingAnswer(
    server: unknown,
    clientId: string,
  ): Promise<unknown> {
    const transcript = await replacementHeaders(
      supertest(server as never).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', clientId);
    return (
      transcript.body.events as Array<{
        type: string;
        data?: {
          record?: {
            type?: string;
            message?: {
              parts?: Array<{
                functionResponse?: { id?: string; response?: unknown };
              }>;
            };
          };
        };
      }>
    )
      .filter(
        (event) =>
          event.type === 'managed_journal_event' &&
          event.data?.record?.type === 'tool_result',
      )
      .flatMap((event) => event.data?.record?.message?.parts ?? [])
      .find((part) => part.functionResponse?.id === 'call-0');
  }

  it('answers the committed sibling when the continue drive compensates a lost resume', async () => {
    // R13-1: the continue route's compensating settle owes the same
    // committed-sibling fold the cancel route runs — the drive's first
    // project() read faults before the resume fold could run, and the
    // durable settle would otherwise strand the committed team_create
    // unanswered forever: the kept admission replays a retried continue
    // without re-driving.
    domainEnablement.childRun = true;
    domainEnablement.teams = true;
    try {
      await parkCrashedTeamTurn();
      const { server, loaded } = await loadReplacement(
        false,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      // The drive's first projection read fails before any resume runs, so
      // the compensating settle owns the fold as well as the terminal
      // record.
      vi.spyOn(
        ManagedSessionRecordSink.prototype,
        'project',
      ).mockRejectedValueOnce(new Error('projection lost'));
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
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      // The fold's answer is durable: the committed team_create carries a
      // functionResponse in the projection, answered by what committed.
      const sibling = await readSiblingAnswer(server, clientId);
      expect(sibling).toBeDefined();
      expect(
        JSON.stringify(
          (sibling as { functionResponse?: { response?: unknown } })
            ?.functionResponse?.response,
        ),
      ).toContain('committed its team change');
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.teams = false;
      domainEnablement.childRun = false;
    }
  }, 30_000);

  it('answers the committed sibling when the resume fold write fails and the drive settles', async () => {
    // R13-1: the direct settle owes the fold too — the resume fold's
    // answer write for the orphaned team_create fails raw (not
    // recovery-classified), so the inner catch settles the Turn 'error'
    // with the call still unanswered, and the direct settle's fold is the
    // last chance to pair it before the durable record.
    domainEnablement.childRun = true;
    domainEnablement.teams = true;
    try {
      await parkCrashedTeamTurn();
      const { server, loaded } = await loadReplacement(
        false,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      // The resume fold's answer write for the orphaned team_create fails
      // once, so the drive throws raw into the error settle with the
      // answer still owed.
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let foldRefused = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !foldRefused &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          ) {
            foldRefused = true;
            throw new Error('store refused the sibling answer');
          }
          return originalWrite.call(this, item);
        },
      );
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
        { timeout: settleTimeoutMs() },
      );
      const settled = await replacementHeaders(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(settled.body.recoveryBlocked).toBe(false);
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
      const sibling = await readSiblingAnswer(server, clientId);
      expect(sibling).toBeDefined();
      expect(
        JSON.stringify(
          (sibling as { functionResponse?: { response?: unknown } })
            ?.functionResponse?.response,
        ),
      ).toContain('committed its team change');
      await replacementHeaders(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.teams = false;
      domainEnablement.childRun = false;
    }
  }, 30_000);

  it.each([
    // The drive's own settle: the model stage ended the Turn in error.
    ['direct', false],
    // The compensating arm: the tool turn's finish then dies against the
    // store too, so the settle and its fold run in the outer catch.
    ['compensating', true],
  ])(
    'names the store on the block a recovered turn leaves when its committed-call fold meets the store (%s settle)',
    async (_settle, finishFails) => {
      // The resume fold's answer for the orphaned team_create is the model
      // stage's first commit, and its journal batch dies against the store:
      // the stage names the failure and the authority latches its writer.
      // The settle's committed-call fold then owes the same answer, meets
      // only the stopped writer, and refuses — the Turn stays re-drivable,
      // and the block it leaves must carry the store's name like the
      // settlement-write exits' (#13800 R2-15).
      domainEnablement.childRun = true;
      domainEnablement.teams = true;
      try {
        await parkCrashedTeamTurn();
        const { server, loaded } = await loadReplacement(
          false,
          'hosted-workspace-shell/1',
        );
        expect(loaded.status).toBe(200);
        const clientId = loaded.body.clientId as string;
        const recovery = loaded.body._meta?.[
          'qwen.daemon.managedRuntimeRecovery'
        ] as { checkpointId: string; activationId: string };
        // A message batch names its record only by id, so the sink side
        // remembers each sibling answer's id and the journal side refuses the
        // batch that commits one.
        const siblingAnswers = new Set<string>();
        const originalWrite = ManagedSessionRecordSink.prototype.write;
        vi.spyOn(
          ManagedSessionRecordSink.prototype,
          'write',
        ).mockImplementation(async function (
          this: ManagedSessionRecordSink,
          item,
        ) {
          if (
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          )
            siblingAnswers.add(item.uuid);
          return originalWrite.call(this, item);
        });
        const originalAppend =
          LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
        let siblingAppends = 0;
        vi.spyOn(
          LocalJsonlManagedSessionJournalHandle.prototype,
          'appendTransaction',
        ).mockImplementation(async function (
          this: LocalJsonlManagedSessionJournalHandle,
          records: readonly unknown[],
        ) {
          const body = JSON.stringify(records);
          if (
            ![...siblingAnswers].some((id) => body.includes(`"message:${id}"`))
          )
            return originalAppend.call(this, records);
          siblingAppends += 1;
          throw new ManagedSessionStoreTransportError('store flap');
        });
        if (finishFails)
          vi.spyOn(
            HostedWorkspaceToolTurn.prototype,
            'finish',
          ).mockRejectedValueOnce(
            new ManagedSessionStoreTransportError('flap'),
          );
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
            expect(status.body.recoveryBlocked).toBe(true);
            expect(status.body.recoveryReason).toBe(
              'managed_session_store_unavailable',
            );
          },
          { timeout: settleTimeoutMs() },
        );
        // Both folds tried the answer, and only the first reached the store:
        // the fold's refusal is the stopped writer, not a second outage.
        expect(siblingAnswers.size).toBe(2);
        expect(siblingAppends).toBe(1);
        await replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
      } finally {
        domainEnablement.teams = false;
        domainEnablement.childRun = false;
      }
    },
    30_000,
  );

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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      timeout: settleTimeoutMs(),
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.recoveryBlocked).toBe(false);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    await vi.waitFor(
      async () => {
        const status = await replacementHeaders(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    // The retirement failed at the settle point: it stays owed instead of
    // dragging the settled Turn down with it — and nothing blocks.
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
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
      timeout: settleTimeoutMs(),
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

  it.each([
    { exit: 'DELETE', drain: true },
    // The control plane closes a bound Session through the lifecycle: its
    // effects phase retries the owed cleanup before the detach.
    { exit: 'lifecycle', drain: false },
  ])(
    'retires the owed marker before $exit hands back a cleanup-owed recovered lease',
    async ({ exit, drain }) => {
      const cleanupStates: unknown[] = [];
      const appendEvent =
        LocalManagedSessionAuthority.prototype.appendExecutionEvent;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'appendExecutionEvent',
      ).mockImplementation(async function (
        this: LocalManagedSessionAuthority,
        ...args
      ) {
        const appended = await Reflect.apply(appendEvent, this, args);
        if (args[0].operation === 'hostedCleanup')
          cleanupStates.push(
            (
              args[1] as (sequence: number) => {
                payload: Record<string, unknown>;
              }
            )(0).payload['state'],
          );
        return appended;
      });
      await parkToolTurn(false, FILE_PROFILE, true);
      // The parked owner's Runtime binding committed a real cleanup
      // obligation: its release waits on the Turn's file-history marker.
      expect(cleanupStates).toEqual(['owed']);
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
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      const { server, loaded } = await loadReplacement(true);
      expect(loaded.status).toBe(200);
      const clientId = loaded.body.clientId as string;
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      // Only the cancellation's first retirement write fails: the
      // compensating path lands turn.settled and owes the marker.
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
      const send = () =>
        replacementHeaders(
          supertest(server).post(
            `/session/${SESSION_ID}/managed-runtime/cancel`,
          ),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
      expect((await send()).status).toBe(503);
      expect((await send()).status).toBe(200);
      // The replay's handback is refused while the marker still names the
      // Turn, so the lease stays owed into the close.
      await vi.waitFor(
        () =>
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining(
              'Original file history marker is still owed',
            ),
          ),
        { timeout: settleTimeoutMs() },
      );
      expect(release).not.toHaveBeenCalled();
      if (exit === 'DELETE') {
        await replacementHeaders(
          supertest(server).delete(`/session/${SESSION_ID}`),
        ).expect(204);
      } else {
        const authority = { operationId: 'close-op', claimGeneration: 1 };
        await replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({
            kind: 'close',
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
            authority,
          })
          .expect(200);
        await replacementHeaders(
          supertest(server).post(`/session/${SESSION_ID}/detach`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ authority })
          .expect(204);
      }
      // The marker is retired first, so the obligation releases the original
      // Runtime and is confirmed: no 204 with the lease never handed back,
      // and no lifecycle refused on every retry.
      expect(release).toHaveBeenCalledOnce();
      expect(release.mock.contexts[0]).toMatchObject({
        runtimeSessionId: hostedRuntimeSessionId(PROMPT_ID),
      });
      expect(release.mock.calls[0][0]).toEqual({
        bindingId: 'binding',
        generation: '1',
        ...(drain ? { drain: true } : {}),
      });
      expect(cleanupStates).toEqual(['owed', 'confirmed']);
    },
  );

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
      { timeout: settleTimeoutMs() },
    );
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
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
        timeout: settleTimeoutMs(),
      },
    );
    commitSpy.mockRestore();
    // A fresh incarnation's load retires the settled Turn's marker instead
    // of refusing on it forever.
    const restarted = await replacementApp();
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
      { timeout: settleTimeoutMs() },
    );
    await vi.waitFor(() => expect(dropSpy).toHaveBeenCalled(), {
      timeout: settleTimeoutMs(),
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Original file history snapshots changed.'),
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  describe('workflow launch prompts (#13803)', () => {
    const WORKFLOW_SCRIPT =
      'export const meta = { name: "audit", description: "d" };\nreturn { answer: 1 };';
    const WORKFLOW_PIN = {
      definitionId: 'workflow/audit',
      definitionRevision: 1,
      definitionDigest: createHash('sha256')
        .update(WORKFLOW_SCRIPT, 'utf8')
        .digest('hex'),
    };
    function workflowPrompt(
      overrides: Record<string, unknown> = {},
    ): Array<Record<string, unknown>> {
      return [
        {
          type: 'workflow_launch',
          definition: WORKFLOW_PIN,
          script: WORKFLOW_SCRIPT,
          ...overrides,
        },
      ];
    }
    const CHILD_LINEAGE = {
      parentSessionId: '10f4e2c2-93e6-4c26-b24a-b7c8b0f56aa1',
      rootSessionId: '10f4e2c2-93e6-4c26-b24a-b7c8b0f56aa1',
      parentChildRunId: 'run-1',
      depth: 1,
    };
    async function workflowApp(
      childShaped = true,
      withBroker = false,
      toolProfile?: string,
    ) {
      const server = await app(withBroker);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...(childShaped ? { lineage: CHILD_LINEAGE } : {}),
        ...(toolProfile === undefined ? {} : { toolProfile }),
      });
      expect(created.status).toBe(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          created.body.clientId as string,
        );
      const send = (prompt: Array<Record<string, unknown>>, promptId: string) =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          },
        );
      return { server, authorize, send };
    }

    it('admits a workflow launch block and runs it as the turn', async () => {
      const { server, authorize, send } = await workflowApp();
      const prompt = workflowPrompt({ args: { x: 1 } });
      const admitted = await send(prompt, PROMPT_ID);
      expect(admitted.status).toBe(202);
      await vi.waitFor(() => expect(state.workflow).toHaveBeenCalledTimes(1), {
        timeout: settleTimeoutMs(),
      });
      expect(state.workflow).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          launch: {
            definition: WORKFLOW_PIN,
            script: WORKFLOW_SCRIPT,
            args: { x: 1 },
          },
        }),
      );
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).not.toHaveBeenCalled();
      // The user record's message resource carries the one-line summary,
      // never the full launch payload journaling inline — the input
      // resource the input's digest names is where the payload lives.
      const transcript = await readFile(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        'utf8',
      );
      // A fragment, not WORKFLOW_SCRIPT itself: the transcript JSON-escapes
      // the script body, so the whole string literal would never match.
      expect(transcript).not.toContain('export const meta =');
      const tree = await readdir(state.root, { recursive: true });
      const blobs = (
        await Promise.all(
          tree
            .filter((name) => !name.endsWith('.jsonl'))
            .map((name) =>
              readFile(path.join(state.root, name), 'utf8').catch(() => ''),
            ),
        )
      ).join('\n');
      expect(blobs).toContain('<workflow workflow/audit@1 sha256:');
      // R1-14: the turn commits the run's own settled outcome as its own
      // `managed-turn-result` resource, never as transcript text — a branch
      // that threw at commit time would ship an empty resource and pass the
      // watermark checks above. Reading the resource bodies makes that
      // removal visible.
      expect(blobs).toContain('Hello from workflow');
      // A same-body replay answers the same admission watermark.
      const replayed = await send(prompt, PROMPT_ID);
      expect(replayed.status).toBe(202);
      expect(replayed.body.lastEventId).toBe(admitted.body.lastEventId);
      expect(state.workflow).toHaveBeenCalledTimes(1);
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    it('settles a registry-side cancel of the workflow start as a cancelled turn', async () => {
      const { server, authorize, send } = await workflowApp();
      state.workflow.mockRejectedValueOnce(new WorkflowStartCancelledError());
      const admitted = await send(
        workflowPrompt({ args: { x: 1 } }),
        PROMPT_ID,
      );
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      // The turn_result records a cancelled turn, never a failed one: the
      // registry torn down the start with this Turn's signal still live is
      // not a model or runtime failure.
      const lines = (
        await readFile(path.join(state.root, `${SESSION_ID}.jsonl`), 'utf8')
      )
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const turnSettled = lines.find(
        (entry) =>
          entry['type'] === 'system' &&
          entry['subtype'] === 'managed_session_event_v1' &&
          (
            entry['managedSession'] as
              | { kind?: string; payload?: Record<string, unknown> }
              | undefined
          )?.kind === 'turn.settled' &&
          (
            (
              entry['managedSession'] as {
                payload: Record<string, unknown>;
              }
            ).payload as Record<string, unknown>
          )['turnId'] === PROMPT_ID,
      );
      expect(turnSettled).toMatchObject({
        managedSession: {
          payload: { outcome: 'cancelled', stopReason: 'cancelled' },
        },
      });
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    it('refuses malformed workflow blocks at the boundary', async () => {
      const { server, authorize, send } = await workflowApp();
      const malformed: Array<Array<Record<string, unknown>>> = [
        workflowPrompt({
          definition: { ...WORKFLOW_PIN, definitionDigest: 'not-hex' },
        }),
        workflowPrompt({
          definition: { ...WORKFLOW_PIN, definitionRevision: 0 },
        }),
        workflowPrompt({ script: '' }),
        workflowPrompt({ stray: 1 }),
        [...workflowPrompt(), { type: 'text', text: 'mixed' }],
      ];
      for (const prompt of malformed) {
        const response = await send(prompt, randomUUID());
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('invalid_hosted_prompt');
      }
      expect(state.workflow).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    // R1-14: the workflow launch's Turn never constructs the broker-backed
    // tool turn — its work is the runner's own dispatch; a missing guard
    // would let the harness fabricate a broker-backed tool turn for the
    // workflow prompt, invoking the same broker warm the text path calls.
    it('runs a workflow launch without ever warming the Session broker', async () => {
      const warm = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'warm')
        .mockResolvedValue(undefined);
      // A tool-profiled Session: only the launch itself, never a missing
      // profile, keeps the broker-backed tool turn away (#13858 R2-8).
      const { server, authorize, send } = await workflowApp(
        true,
        true,
        'hosted-workspace-shell/1',
      );
      const admitted = await send(workflowPrompt(), PROMPT_ID);
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.workflow).toHaveBeenCalledTimes(1);
      expect(state.model).not.toHaveBeenCalled();
      expect(warm).not.toHaveBeenCalled();
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    // #13803: a workflow_launch block names work outside any managed
    // record, so it is mint-able only by the control plane's own child
    // creation — every other shape keeps the old refusal.
    it('refuses a workflow launch on a session without child lineage', async () => {
      const { server, authorize, send } = await workflowApp(false);
      const response = await send(workflowPrompt(), randomUUID());
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_hosted_prompt');
      expect(state.workflow).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    it('refuses a workflow launch once the child Session has any input', async () => {
      const { server, authorize, send } = await workflowApp();
      // The child's own creation turn is text; after it settles, the
      // route never admits a workflow_launch block again.
      const first = [{ type: 'text', text: 'the creation turn is text' }];
      const admitted = await send(first, randomUUID());
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const response = await send(workflowPrompt(), randomUUID());
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_hosted_prompt');
      expect(state.workflow).not.toHaveBeenCalled();
      expect(state.model).toHaveBeenCalledTimes(1);
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });
  });
  it('refuses a takeover on a Session without any tool profile', async () => {
    await parkBlockedTextTurn(false);
    const server = await replacementApp();
    // The drive shape is G3's typed terminal decline; the retriable refusal
    // with its ground survives on the cancellation-only shape.
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: storeFor(BOOT_ID_2),
      passiveManagedRuntimeRecovery: true,
    });
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('takeover_unsupported');
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('settles a takeover whose parked turn holds nothing unanswerable (#13847)', async () => {
    await parkBlockedTextTurn(true);
    const server = await replacementApp();
    const loadBody = {
      managedSessionStore: storeFor(BOOT_ID_2),
      toolProfile: FILE_PROFILE,
      driveRuntimeRecovery: true,
    };
    const loaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send(loadBody);
    // G3 declined this park terminally and bricked the Session. #13847
    // settles it instead: the interrupted Turn owes no Runtime work and
    // nothing the takeover cannot answer, so it is cancelled durably and
    // this drive keeps only the plain retriable refusal…
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('hosted_turn_recovery_required');
    expect(loaded.body.reason).toBe('takeover_unrecovered');
    // …and the next drive attaches, because the Turn's settle landed the
    // input: the Session is never bricked.
    const reloaded = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send(loadBody);
    expect(reloaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  async function loadParkedRecovery() {
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
    return { server, clientId: loaded.body.clientId as string, recovery };
  }

  it('refuses continue on a profile-less Session', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ promptId: PROMPT_ID, checkpointId: 'x', activationId: 'x' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('recovery_unsupported');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('names a lost authorization read on continue and hands the lease back', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockRejectedValue(
      new Error(
        `journal gone\n\u2028qwen serve: forged\x1b[2J${'x'.repeat(5000)}`,
      ),
    );
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('authorization_unreadable');
    // Strong oracle: the exact expected full line — the newline and the
    // escape sequence are removed outright, the unsafe-class member became
    // a space, and the detail is capped at 4096 before it is interpolated;
    // the filler rides up to that cap.
    const expectedDetailPrefix = 'Error: journal gone qwen serve: forged';
    const expectedLine = `qwen serve: Hosted Session ${SESSION_ID} continue: run authorization could not be read: ${expectedDetailPrefix}${'x'.repeat(4096 - expectedDetailPrefix.length)}`;
    expect(log.mock.calls.map(([emitted]) => emitted)).toContain(expectedLine);
    const line = log.mock.calls
      .map(([emitted]) => emitted)
      .find((emitted) => emitted.includes('could not be read'));
    expect(line).toBeDefined();
    expect(line?.length).toBeLessThan(4400);
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(line).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    await vi.waitFor(
      () => expect(release.mock.calls.length).toBeGreaterThan(releasesBefore),
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a lost authorization read on cancel and keeps the lease owed', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockRejectedValue(
      new Error(
        `journal gone\n\u2028qwen serve: forged\x1b[2J${'x'.repeat(5000)}`,
      ),
    );
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('authorization_unreadable');
    // Strong oracle: same exact-line pin as the continue sibling — the
    // newline and the escape sequence are removed outright, the
    // unsafe-class member became a space, and the detail is capped at 4096
    // before it is interpolated.
    const expectedDetailPrefix = 'Error: journal gone qwen serve: forged';
    const expectedLine = `qwen serve: Hosted Session ${SESSION_ID} cancel: run authorization could not be read: ${expectedDetailPrefix}${'x'.repeat(4096 - expectedDetailPrefix.length)}`;
    expect(log.mock.calls.map(([emitted]) => emitted)).toContain(expectedLine);
    const line = log.mock.calls
      .map(([emitted]) => emitted)
      .find((emitted) => emitted.includes('could not be read'));
    expect(line).toBeDefined();
    expect(line?.length).toBeLessThan(4400);
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(line).not.toMatch(
      /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
    );
    expect(release.mock.calls.length).toBe(releasesBefore);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a not-runnable authorization on continue and hands the lease back', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      message: 'checkpoint record ckpt-1 is not valid JSON.',
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('not_runnable');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'continue: run authorization not runnable: invalid_state: checkpoint record ckpt-1 is not valid JSON.',
      ),
    );
    // The retry-inviting refusal on the resume path returns the adopted
    // lease now, like the authorization-unreadable twin; a retry cannot
    // otherwise re-acquire it.
    await vi.waitFor(
      () => expect(release.mock.calls.length).toBeGreaterThan(releasesBefore),
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a not-runnable authorization on cancel and keeps the lease owed', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      message: 'checkpoint record ckpt-1 is not valid JSON.',
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('not_runnable');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'cancel: run authorization not runnable: invalid_state: checkpoint record ckpt-1 is not valid JSON.',
      ),
    );
    // The cancellation path keeps the adopted lease owed: nothing here is
    // terminal, and a release would persist RELEASED — the retry could
    // never re-acquire that identity.
    expect(release.mock.calls.length).toBe(releasesBefore);
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('omits the absent authorization message on a not-runnable refusal', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'missing_checkpoint',
    } as never);
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/cancel`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('not_runnable');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('not runnable: missing_checkpoint'),
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('undefined'));
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('names a runnable but unready continuation on continue', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'runnable',
      checkpoint: { continuation: { phase: 'await_runtime' } },
    } as never);
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    const releasesBefore = release.mock.calls.length;
    const refused = await replacementHeaders(
      supertest(server).post(`/session/${SESSION_ID}/managed-runtime/continue`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ promptId: PROMPT_ID, ...recovery });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    expect(refused.body.reason).toBe('continuation_not_ready');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('continuation not ready: phase=await_runtime'),
    );
    await vi.waitFor(
      () => expect(release.mock.calls.length).toBeGreaterThan(releasesBefore),
      { timeout: settleTimeoutMs() },
    );
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });

  it('strips control characters from the blocked authorization message', async () => {
    const { server, clientId, recovery } = await loadParkedRecovery();
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    // The message is Store-influenced free text: the single-line tag must
    // strip newlines and control sequences rather than replay them.
    vi.spyOn(
      LocalManagedSessionAuthority.prototype,
      'harnessRunAuthorization',
    ).mockResolvedValue({
      status: 'blocked',
      reason: 'invalid_state',
      message: `invalid_state\n\u2028qwen serve: forged\x1b[2J${'x'.repeat(5000)}`,
    } as never);
    for (const route of ['continue', 'cancel'] as const) {
      log.mockClear();
      const refused = await replacementHeaders(
        supertest(server).post(
          `/session/${SESSION_ID}/managed-runtime/${route}`,
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ promptId: PROMPT_ID, ...recovery });
      expect(refused.status).toBe(409);
      expect(refused.body.reason).toBe('not_runnable');
      // Strong oracle: the exact expected full line — the newline and the
      // escape sequence are removed outright, the unsafe-class member
      // became a space, the detail is capped at 4096 before it is
      // interpolated, and the filler rides up to that cap.
      const expectedDetailPrefix = 'invalid_state qwen serve: forged';
      const expectedLine = `qwen serve: Hosted Session ${SESSION_ID} ${route}: run authorization not runnable: invalid_state: ${expectedDetailPrefix}${'x'.repeat(4096 - expectedDetailPrefix.length)}`;
      expect(log.mock.calls.map(([emitted]) => emitted)).toContain(
        expectedLine,
      );
      const line = log.mock.calls
        .map(([emitted]) => emitted)
        .find((emitted) => emitted.includes('not runnable'));
      expect(line).toBeDefined();
      // The message is capped at 4096 characters before it is interpolated.
      expect(line?.length).toBeLessThan(4400);
      // Oracles independent of the implementation: no C0/C1 control and no
      // code point of the log-line-unsafe class may survive into the line.
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      expect(line).not.toMatch(
        /[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
      );
    }
    await replacementHeaders(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
  });
  // H4e-b1: a user Turn whose batch parks nothing (team calls only) dies
  // after a team call commits and before its tool_result lands. The
  // cancellation takeover settles it; the committed call must be answered
  // from its record, or core's orphan repair tells the next Turn's model to
  // retry it and the retry opens a second task.
  it('answers a committed team call of a cancelled user Turn from its record', async () => {
    domainEnablement.childRun = true;
    try {
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
      // The Harness dies right after task_create's record commits, before
      // its tool_result lands (that one write fails).
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let killed = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"task_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        },
      );
      const calls = [
        {
          name: 'team_create',
          callId: 'call-1',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
        {
          name: 'task_create',
          callId: 'call-2',
          args: { subject: 'Audit the auth module', description: 'd' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        },
      ];
      state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
        await toolTurn!.declarations(signal);
        await toolTurn!.execute(
          calls,
          calls.map((call) => ({
            functionCall: { id: call.callId, name: call.name, args: call.args },
          })),
          'test-model',
          signal,
        );
        return { text: 'done', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'make a team and a task' }];
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
      vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
      // The coordinator's cancellation takeover on a replacement Harness.
      const replacement = await replacementApp();
      const loaded = await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: storeFor(BOOT_ID_2),
        toolProfile: 'hosted-workspace-shell/1',
        passiveManagedRuntimeRecovery: true,
        cancellationTakeover: true,
      });
      expect(loaded.status).toBe(200);
      let seen: ChatRecord[] = [];
      state.model.mockImplementationOnce(async (input) => {
        seen = [...((input as { history?: ChatRecord[] }).history ?? [])];
        return { text: 'ok', model: 'test-model' };
      });
      const next = [{ type: 'text', text: 'what is on the board?' }];
      await replacementHeaders(
        supertest(replacement).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', loaded.body.clientId as string)
        .send({
          prompt: next,
          promptId: '44444444-4444-4444-8444-444444444444',
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(next)).digest('hex')}`,
        })
        .expect(202);
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), {
        timeout: settleTimeoutMs(),
      });
      const answer = seen
        .filter(
          (record) =>
            record.daemonPromptId === PROMPT_ID &&
            record.type === 'tool_result',
        )
        .flatMap((record) => record.message?.parts ?? [])
        .find((part) => part.functionResponse?.id === 'call-2');
      expect(JSON.stringify(answer?.functionResponse?.response)).toContain(
        'committed its team change',
      );
      await vi.waitFor(
        async () => {
          const status = await replacementHeaders(
            supertest(replacement).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      await replacementHeaders(
        supertest(replacement).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.childRun = true;
    }
  }, 30_000);

  // H4e-b1: a Runtime-parked batch whose team sibling committed before the
  // Harness died, its tool_result never landing. Both settle routes of the
  // parked Turn answer it from its record: the cancel route before its
  // terminal, the continue route before the resumed round reads it.
  it.each(['cancel', 'continue'] as const)(
    'answers a committed team sibling of a Runtime park through the %s route',
    async (route) => {
      domainEnablement.childRun = true;
      try {
        vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
        acquireSpy = vi
          .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
          .mockImplementation(async function (this: HostedWorkspaceBroker) {
            this.runtime = {
              bindingId: 'binding',
              generation: '1',
              workspaceGeneration: '1',
            };
          });
        vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
          '66666666-6666-4666-8666-666666666666',
        );
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'release',
        ).mockResolvedValue();
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
        const originalWrite = ManagedSessionRecordSink.prototype.write;
        let killed = false;
        vi.spyOn(
          ManagedSessionRecordSink.prototype,
          'write',
        ).mockImplementation(async function (
          this: ManagedSessionRecordSink,
          item,
        ) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        });
        // A team call after the crash point never runs: it commits nothing.
        const later = {
          name: 'task_create',
          callId: 'call-2',
          args: { subject: 'Audit', description: 'a' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        const team = {
          name: 'team_create',
          callId: 'call-0',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        state.model.mockImplementationOnce(
          async ({ toolTurn, signal }) =>
            toolTurn!.execute(
              [team, CALL, later],
              [team, CALL, later].map((call) => ({
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
        const prompt = [{ type: 'text', text: 'team and a file' }];
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
        vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
        expect(
          (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
            .status,
        ).toBe(204);
        const answerText = 'committed its team change';
        if (route === 'cancel') {
          let stopConfirmed = false;
          vi.spyOn(
            HostedWorkspaceBroker.prototype,
            'status',
          ).mockImplementation(async () => ({
            state: stopConfirmed ? 'settled' : 'prepared',
          }));
          vi.spyOn(
            HostedWorkspaceBroker.prototype,
            'cancel',
          ).mockImplementation(async () => {
            stopConfirmed = true;
          });
          const { server: replacement, loaded } = await loadReplacement(
            true,
            'hosted-workspace-shell/1',
          );
          expect(loaded.status).toBe(200);
          const recovery = loaded.body._meta?.[
            'qwen.daemon.managedRuntimeRecovery'
          ] as { checkpointId: string; activationId: string };
          const cancelled = await replacementHeaders(
            supertest(replacement).post(
              `/session/${SESSION_ID}/managed-runtime/cancel`,
            ),
          )
            .set('X-Qwen-Client-Id', loaded.body.clientId as string)
            .send({
              promptId: PROMPT_ID,
              checkpointId: recovery.checkpointId,
              activationId: recovery.activationId,
            });
          expect(cancelled.status).toBe(200);
          const transcript = await replacementHeaders(
            supertest(replacement).get(`/session/${SESSION_ID}/transcript`),
          ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
          const answer = (
            transcript.body.events as Array<{
              type: string;
              data?: {
                record?: {
                  type?: string;
                  message?: {
                    parts?: Array<{
                      functionResponse?: { id?: string; response?: unknown };
                    }>;
                  };
                };
              };
            }>
          )
            .filter(
              (event) =>
                event.type === 'managed_journal_event' &&
                event.data?.record?.type === 'tool_result',
            )
            .flatMap((event) => event.data?.record?.message?.parts ?? [])
            .find((part) => part.functionResponse?.id === 'call-0');
          expect(JSON.stringify(answer?.functionResponse?.response)).toContain(
            answerText,
          );
          await replacementHeaders(
            supertest(replacement).delete(`/session/${SESSION_ID}`),
          );
          return;
        }
        vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'written' }],
        } as never);
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'workspaceContext',
        ).mockResolvedValue([]);
        const { server: replacement, loaded } = await loadReplacement(
          false,
          'hosted-workspace-shell/1',
        );
        expect(loaded.status).toBe(200);
        const recovery = loaded.body._meta?.[
          'qwen.daemon.managedRuntimeRecovery'
        ] as { checkpointId: string; activationId: string };
        let resumed: Part[] | undefined;
        state.model.mockImplementationOnce(async (input) => {
          resumed = (input as { resumeFromToolResults?: Part[] })
            .resumeFromToolResults;
          return { text: 'continued', model: 'test-model' };
        });
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
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-0')
              ?.functionResponse?.response,
          ),
        ).toContain(answerText);
        expect(
          resumed!.some((part) => part.functionResponse?.id === CALL.callId),
        ).toBe(true);
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-2')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        await vi.waitFor(
          async () => {
            const status = await replacementHeaders(
              supertest(replacement).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        await replacementHeaders(
          supertest(replacement).delete(`/session/${SESSION_ID}`),
        );
      } finally {
        domainEnablement.childRun = true;
      }
    },
    30_000,
  );

  it('answers the committed sibling when the cancel drive compensates a lost fold', async () => {
    // R12-1: the settle landed but the happy-path fold's sibling answer
    // write failed, so the catch's compensating arm must re-run the fold
    // before its terminal record — the kept admission replays a retried
    // cancel without re-driving, so a call left unpaired there would stay
    // unpaired forever.
    domainEnablement.childRun = true;
    domainEnablement.teams = true;
    try {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      acquireSpy = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockImplementation(async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
        '66666666-6666-4666-8666-666666666666',
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
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
      const originalWrite = ManagedSessionRecordSink.prototype.write;
      let killed = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        },
      );
      // A team call after the crash point never runs: it commits nothing.
      const later = {
        name: 'task_create',
        callId: 'call-2',
        args: { subject: 'Audit', description: 'a' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      const team = {
        name: 'team_create',
        callId: 'call-0',
        args: { team_name: 'review' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      state.model.mockImplementationOnce(
        async ({ toolTurn, signal }) =>
          toolTurn!.execute(
            [team, CALL, later],
            [team, CALL, later].map((call) => ({
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
      const prompt = [{ type: 'text', text: 'team and a file' }];
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
      vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
      // The stop proves quickly; the fold's sibling answer write fails
      // once, so the first cancel reaches its compensating arm.
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'settled',
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
      const { server: replacement, loaded } = await loadReplacement(
        true,
        'hosted-workspace-shell/1',
      );
      expect(loaded.status).toBe(200);
      const recovery = loaded.body._meta?.[
        'qwen.daemon.managedRuntimeRecovery'
      ] as { checkpointId: string; activationId: string };
      let foldRefused = false;
      vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
        async function (this: ManagedSessionRecordSink, item) {
          if (
            !foldRefused &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes('"team_create"')
          ) {
            foldRefused = true;
            throw new Error('store refused the sibling answer');
          }
          return originalWrite.call(this, item);
        },
      );
      const send = () =>
        replacementHeaders(
          supertest(replacement).post(
            `/session/${SESSION_ID}/managed-runtime/cancel`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId as string)
          .send({
            promptId: PROMPT_ID,
            checkpointId: recovery.checkpointId,
            activationId: recovery.activationId,
          });
      const cancelled = await send();
      expect(cancelled.status).toBe(503);
      expect(cancelled.body.code).toBe('managed_runtime_cancel_failed');
      const retried = await send();
      expect(retried.status).toBe(200);
      expect(retried.body.accepted).toBe(true);
      const transcript = await replacementHeaders(
        supertest(replacement).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
      const sibling = (
        transcript.body.events as Array<{
          type: string;
          data?: {
            record?: {
              type?: string;
              message?: {
                parts?: Array<{
                  functionResponse?: { id?: string; response?: unknown };
                }>;
              };
            };
          };
        }>
      )
        .filter(
          (event) =>
            event.type === 'managed_journal_event' &&
            event.data?.record?.type === 'tool_result',
        )
        .flatMap((event) => event.data?.record?.message?.parts ?? [])
        .find((part) => part.functionResponse?.id === 'call-0');
      expect(sibling).toBeDefined();
      expect(JSON.stringify(sibling?.functionResponse?.response)).toContain(
        'committed its team change',
      );
      await replacementHeaders(
        supertest(replacement).delete(`/session/${SESSION_ID}`),
      );
    } finally {
      domainEnablement.teams = false;
      domainEnablement.childRun = false;
    }
  }, 30_000);

  // H4e-b1: the bare load's resume reads only the round's journaled results.
  // A sibling the Runtime does not own that committed before the Harness
  // died — a task, a launch, a member before or after its join — must be
  // answered from its records before the resume, or core's orphan repair
  // has the model retry it and the retry redoes it.
  it.each([
    ['task_create', 'committed its team change'],
    ['agent', 'It joined team \\"review\\" as \\"alice\\"'],
    ['agent-before-join', 'Child agent started in the background'],
    ['agent-unnamed', 'started in the background'],
  ] as const)(
    'answers a committed %s sibling before the bare-load resume of a publication Session',
    async (sibling, expected) => {
      domainEnablement.childRun = true;
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
              captureStatus: 'complete',
              captureReason: null,
              upstreamTruncated: false,
              contents: ['stdout', 'stderr'].map((streamId) => ({
                streamId,
                role: streamId,
                mimeType: 'application/octet-stream',
                state: 'sealed',
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
            captureStatus: 'complete' as const,
            captureReason: null,
            previewTruncated: false,
            deliveryStatus: 'pending' as const,
          },
        };
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
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'prepareV3',
        ).mockResolvedValue({
          executionCallId: 'shell-execution',
          runtimeBindingId: 'binding-1',
          bindingGeneration: '1',
        });
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'executeV3',
        ).mockResolvedValue(envelope);
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'acknowledgeV3',
        ).mockResolvedValue();
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'registerPublisher',
        ).mockResolvedValue('1');
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'release',
        ).mockResolvedValue();
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
        const first = await app(true);
        const created = await headers(supertest(first).post('/session')).send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          captureBytes: 1024 * 1024,
        });
        expect(created.status).toBe(200);
        const clientId = created.body.clientId as string;
        const originalWrite = ManagedSessionRecordSink.prototype.write;
        let killed = false;
        if (sibling === 'agent-before-join')
          vi.spyOn(HostedTeamSession.prototype, 'join').mockImplementationOnce(
            async () => {
              killed = true;
              throw new Error('Harness killed');
            },
          );
        vi.spyOn(
          ManagedSessionRecordSink.prototype,
          'write',
        ).mockImplementation(async function (
          this: ManagedSessionRecordSink,
          item,
        ) {
          if (
            sibling !== 'agent-before-join' &&
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes(
              `"${sibling === 'agent-unnamed' ? 'agent' : sibling}"`,
            )
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        });
        const teamCall = [
          {
            name: 'team_create',
            callId: 'call-0',
            args: { team_name: 'review' },
            isClientInitiated: false,
            prompt_id: PROMPT_ID,
          },
        ];
        const siblingCall =
          sibling === 'task_create'
            ? {
                name: 'task_create',
                callId: 'call-2',
                args: { subject: 'Audit the auth module', description: 'd' },
                isClientInitiated: false,
                prompt_id: PROMPT_ID,
              }
            : {
                name: 'agent',
                callId: 'call-2',
                args: {
                  description: 'audit auth',
                  prompt: 'audit the auth module',
                  ...(sibling === 'agent-unnamed' ? {} : { name: 'alice' }),
                },
                isClientInitiated: false,
                prompt_id: PROMPT_ID,
              };
        const batch = [
          {
            name: 'run_shell_command',
            callId: 'model-shell-call',
            args: { command: 'printf hi' },
            isClientInitiated: false,
            prompt_id: PROMPT_ID,
          },
          siblingCall,
          // A team call after the crash point never runs: it commits nothing.
          {
            name: 'task_create',
            callId: 'call-3',
            args: { subject: 'Fix the auth module', description: 'f' },
            isClientInitiated: false,
            prompt_id: PROMPT_ID,
          },
        ];
        state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
          await toolTurn!.declarations(signal);
          await toolTurn!.execute(
            teamCall,
            teamCall.map((call) => ({
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            })),
            'test-model',
            signal,
          );
          const answers = await toolTurn!.execute(
            batch,
            batch.map((call) => ({
              functionCall: {
                id: call.callId,
                name: call.name,
                args: call.args,
              },
            })),
            'test-model',
            signal,
          );
          void answers;
          return { text: 'done', model: 'test-model' };
        });
        const prompt = [{ type: 'text', text: 'shell then sibling' }];
        await headers(supertest(first).post(`/session/${SESSION_ID}/prompt`))
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
              supertest(first).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(status.body.hasActivePrompt).toBe(false);
            expect(status.body.recoveryBlocked).toBe(true);
          },
          { timeout: settleTimeoutMs() },
        );
        expect(killed).toBe(true);
        vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
        await headers(supertest(first).delete(`/session/${SESSION_ID}`));
        let resumed: Part[] | undefined;
        state.model.mockImplementationOnce(async (input) => {
          resumed = [
            ...((input as { resumeFromToolResults?: Part[] })
              .resumeFromToolResults ?? []),
          ];
          return { text: 'resumed', model: 'test-model' };
        });
        const second = await app(true);
        const loaded = await headers(
          supertest(second).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(loaded.status).toBe(200);
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        const answer = JSON.stringify(
          resumed!.find((part) => part.functionResponse?.id === 'call-2')
            ?.functionResponse?.response,
        );
        expect(answer).toContain(expected);
        if (sibling === 'agent-unnamed')
          expect(answer).not.toContain('joined team');
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-3')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        expect(
          resumed!.some(
            (part) => part.functionResponse?.id === 'model-shell-call',
          ),
        ).toBe(true);
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(second).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        await headers(supertest(second).delete(`/session/${SESSION_ID}`));
      } finally {
        domainEnablement.childRun = true;
      }
    },
    30_000,
  );

  // H4e-b1: a Hooks Session never takes over; its bare load is the only
  // recovery route, and with a Write in the round the file-history gate
  // needs every call of the round answered. A committed team call the dead
  // Harness never answered is answered from its record before the gate and
  // before the resume, so the Session loads and the model never retries it.
  it.each(['read_file', 'write_file'] as const)(
    'answers a committed task_create before a Hooks Session resumes on its bare load (Runtime sibling %s)',
    async (sibling) => {
      const kind = 'task_create' as 'task_create' | 'agent';
      domainEnablement.childRun = true;
      try {
        vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'hookControl',
        ).mockImplementation(async (operation) => ({
          operationId: operation.operationId,
          state: 'settled',
          catalog: { ...hookPin, hooks: [] },
        }));
        acquireSpy = vi
          .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
          .mockImplementation(async function (this: HostedWorkspaceBroker) {
            this.runtime = {
              bindingId: 'binding',
              generation: '1',
              workspaceGeneration: '1',
            };
          });
        vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockResolvedValue(
          '66666666-6666-4666-8666-666666666666',
        );
        vi.spyOn(
          HostedWorkspaceBroker.prototype,
          'release',
        ).mockResolvedValue();
        vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'file body' }],
        } as never);
        const first = await app(true);
        const created = await headers(supertest(first).post('/session')).send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-shell/1',
          hookCatalog: hookPin,
        });
        expect(created.status).toBe(200);
        const clientId = created.body.clientId as string;
        const originalWrite = ManagedSessionRecordSink.prototype.write;
        let killed = false;
        vi.spyOn(
          ManagedSessionRecordSink.prototype,
          'write',
        ).mockImplementation(async function (
          this: ManagedSessionRecordSink,
          item,
        ) {
          if (
            !killed &&
            item.type === 'tool_result' &&
            JSON.stringify(item.message).includes(`"${kind}"`)
          ) {
            killed = true;
            throw new Error('Harness killed');
          }
          return originalWrite.call(this, item);
        });
        const team = {
          name: 'team_create',
          callId: 'call-t',
          args: { team_name: 'review' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        const read = {
          name: sibling,
          callId: 'call-r',
          args:
            sibling === 'read_file'
              ? { file_path: 'a.txt' }
              : { file_path: 'a.txt', content: 'x' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        const second =
          kind === 'task_create'
            ? {
                name: 'task_create',
                callId: 'call-k',
                args: { subject: 'Audit the auth module', description: 'd' },
                isClientInitiated: false,
                prompt_id: PROMPT_ID,
              }
            : {
                name: 'agent',
                callId: 'call-k',
                args: {
                  description: 'audit',
                  prompt: 'audit the auth module',
                  run_in_background: true,
                },
                isClientInitiated: false,
                prompt_id: PROMPT_ID,
              };
        // A sibling after the crash point never runs: it commits nothing.
        const third = {
          name: 'task_create',
          callId: 'call-c',
          args: { subject: 'Fix the auth module', description: 'f' },
          isClientInitiated: false,
          prompt_id: PROMPT_ID,
        };
        const fc = (call: {
          callId: string;
          name: string;
          args: Record<string, unknown>;
        }) => ({
          functionCall: { id: call.callId, name: call.name, args: call.args },
        });
        state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
          await toolTurn!.declarations(signal);
          if (kind === 'task_create')
            await toolTurn!.execute([team], [fc(team)], 'test-model', signal);
          await toolTurn!.execute(
            [read, second, third],
            [fc(read), fc(second), fc(third)],
            'test-model',
            signal,
          );
          return { text: 'unreached', model: 'test-model' };
        });
        const prompt = [{ type: 'text', text: 'team, read, second' }];
        await headers(supertest(first).post(`/session/${SESSION_ID}/prompt`))
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
              supertest(first).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
        expect(killed).toBe(true);
        vi.mocked(ManagedSessionRecordSink.prototype.write).mockRestore();
        await headers(
          supertest(first).post(`/session/${SESSION_ID}/detach`),
        ).set('X-Qwen-Client-Id', clientId);
        let resumed: Part[] | undefined;
        let retried = 0;
        state.model.mockImplementationOnce(async (input) => {
          const typed = input as {
            resumeFromToolResults?: Part[];
            toolTurn?: HostedWorkspaceToolTurn;
            signal: AbortSignal;
          };
          resumed = [...(typed.resumeFromToolResults ?? [])];
          // What the real model does after core's orphan repair told it the
          // call "was not recorded ... retry if needed": it retries.
          if (!resumed.some((p) => p.functionResponse?.id === 'call-k')) {
            retried += 1;
            const retry = { ...second, callId: 'call-retry' };
            await typed.toolTurn!.execute(
              [retry],
              [fc(retry)],
              'test-model',
              typed.signal,
            );
          }
          return { text: 'continued', model: 'test-model' };
        });
        const secondApp = await app(true);
        const loaded = await headers(
          supertest(secondApp).post(`/session/${SESSION_ID}/load`),
        ).send({ managedSessionStore: store() });
        expect(loaded.status).toBe(200);
        await vi.waitFor(() => expect(resumed).toBeDefined(), {
          timeout: settleTimeoutMs(),
        });
        await vi.waitFor(
          async () => {
            const status = await headers(
              supertest(secondApp).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', loaded.body.clientId as string);
            expect(status.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
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
        const domainCommits = (domain: string) =>
          journal.events.filter(
            (e) =>
              e.kind === 'domain.committed' &&
              (e.payload as Record<string, unknown>)['domain'] === domain,
          ).length;
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-k')
              ?.functionResponse?.response,
          ),
        ).toContain('committed its team change');
        expect(
          JSON.stringify(
            resumed!.find((part) => part.functionResponse?.id === 'call-c')
              ?.functionResponse?.response,
          ),
        ).toContain('The tool call never ran');
        expect(retried).toBe(0);
        expect(domainCommits('team_task')).toBe(1);
      } finally {
        domainEnablement.childRun = true;
      }
    },
    30_000,
  );
});

describe('Hosted Harness stored definitions', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
  });
  afterEach(async () => {
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

  it('creates and cold-loads a custom public Shell definition with base Hooks and no extension selection', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const server = await app(true);
    const request = {
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      publicChildAgentsVersion: 1,
      lifecycleProtocolVersion: 2,
      agentDefinition: {
        agentId: `agent_${'a'.repeat(32)}`,
        revision: '1',
        digest: 'b'.repeat(64),
      },
      hookCatalog: {
        catalogId: 'deployment',
        catalogRevision: 1,
        definitionDigest: 'c'.repeat(64),
      },
    };
    const created = await headers(supertest(server).post('/session')).send({
      ...request,
      sessionId: SESSION_ID,
      sessionScope: 'thread',
    });
    expect(created.status).toBe(200);
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .expect(204);
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ ...request, passiveManagedRuntimeRecovery: true })
      .expect(200);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
    const refused = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    ).send({ ...request, publicChildAgentsVersion: 0 });
    expect(refused.status).toBe(409);
  });

  it('keeps the public custom Shell gate closed on the legacy extension contract', async () => {
    const server = await app(true, undefined, false);
    await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        publicChildAgentsVersion: 1,
        agentDefinition: {
          agentId: `agent_${'a'.repeat(32)}`,
          revision: '1',
          digest: 'b'.repeat(64),
        },
      })
      .expect(400);
  });

  it('pins creation-time Skills for the built-in agent across resident and cold loads', async () => {
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const sessionSkillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'added',
            description: 'Added at creation',
            body: 'SESSION_CREATION_BODY',
            base_directory: 'docs',
          },
        ]),
      ),
    );
    const request = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      sessionSkillsRef,
    };
    await headers(supertest(server).post('/session')).send(request).expect(200);
    const load = (
      target: Awaited<ReturnType<typeof app>>,
      ref?: typeof sessionSkillsRef,
    ) =>
      headers(supertest(target).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        sessionSkillsRef: ref,
        driveRuntimeRecovery: true,
      });
    await load(server).expect(409);
    await load(server, { ...sessionSkillsRef, digest: 'f'.repeat(64) }).expect(
      409,
    );
    const resident = await load(server, sessionSkillsRef).expect(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', resident.body.clientId)
      .expect(204);
    const replacement = await app(true);
    await load(replacement).expect(409);
    const loaded = await load(replacement, sessionSkillsRef).expect(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled());
    const modelInput = state.model.mock.calls.at(-1)![0] as {
      agentDefinition?: unknown;
      skills?: import('./hosted-skill-catalog.js').HostedSkillCatalog;
    };
    expect(modelInput.agentDefinition).toBeUndefined();
    expect(modelInput.skills?.response({ skill: 'added' })).toContain(
      'SESSION_CREATION_BODY',
    );
    expect(modelInput.skills?.declaration()?.name).toBe('skill');
  });

  it('pins stored definitions across resident and cold loads and delivers instructions to the Turn', async () => {
    const server = await app();
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const instructionsRef = await resources.publish(
      'managed-agent-instructions',
      Buffer.from('D8_PINNED_INSTRUCTIONS'),
    );
    const identity = {
      agentId: `agent_${'a'.repeat(32)}`,
      revision: '1',
      digest: 'b'.repeat(64),
    };
    const definition = {
      ...identity,
      model: { id: 'configured' },
      instructionsRef,
    };
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      agentDefinition: definition,
    });
    expect(created.status).toBe(200);
    const load = (agentDefinition?: typeof identity) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        agentDefinition,
        driveRuntimeRecovery: true,
      });
    expect((await load()).body.error).toBe('hosted_agent_definition_conflict');
    expect(
      (await load({ ...identity, digest: 'c'.repeat(64) })).body.error,
    ).toBe('hosted_agent_definition_conflict');
    expect((await load(identity)).status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
    const loaded = await load(identity);
    expect(loaded.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled());
    expect(state.model.mock.calls.at(-1)?.[0]).toMatchObject({
      agentDefinition: definition,
      agentInstructions: 'D8_PINNED_INSTRUCTIONS',
    });
    await vi.waitFor(
      async () => {
        const response = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(response.status).toBe(204);
      },
      { timeout: settleTimeoutMs() },
    );
  });

  it('loads published Skills from the saved resource after detach and rejects unbound Skill definitions', async () => {
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const skillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'published',
            description: 'Published instructions',
            body: 'ORIGINAL_SKILL_BODY',
            base_directory: 'docs',
          },
        ]),
      ),
    );
    const identity = {
      agentId: `agent_${'a'.repeat(32)}`,
      revision: '1',
      digest: 'b'.repeat(64),
    };
    const definition = { ...identity, skillsRef };
    const request = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      agentDefinition: definition,
    };
    await headers(supertest(server).post('/session')).send(request).expect(400);
    const created = await headers(supertest(server).post('/session'))
      .send({ ...request, toolProfile: 'hosted-workspace-files/1' })
      .expect(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .expect(204);
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store(), agentDefinition: identity })
      .expect(200);
    state.model.mockImplementationOnce(async (input) => {
      const call = {
        name: 'skill',
        callId: 'call-skill',
        args: { skill: 'published' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      expect(await input.toolTurn!.declarations(input.signal)).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'skill' })]),
      );
      const result = await input.toolTurn!.execute(
        [call],
        [
          {
            functionCall: { name: call.name, id: call.callId, args: call.args },
          },
        ],
        'test-model',
        input.signal,
      );
      expect(JSON.stringify(result)).toContain('ORIGINAL_SKILL_BODY');
      expect(JSON.stringify(result)).toContain('docs');
      return { text: 'Skill loaded', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Use the published skill' }];
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );

    expect(state.model).toHaveBeenCalledOnce();
    await expect(state.model.mock.results[0].value).resolves.toMatchObject({
      text: 'Skill loaded',
    });
  });

  // #13753 I3: a snapshot child's read profile declares only read_file and
  // glob, so its Session takes no skill catalog: no instruction names a
  // skill tool that the profile would refuse, failing the Turn.
  it('gives a read-profile Session no skill catalog from its agent definition', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const skillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'published',
            description: 'Published instructions',
            body: 'ORIGINAL_SKILL_BODY',
            base_directory: 'docs',
          },
        ]),
      ),
    );
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        agentDefinition: {
          agentId: `agent_${'a'.repeat(32)}`,
          revision: '1',
          digest: 'b'.repeat(64),
          skillsRef,
        },
        toolProfile: 'hosted-workspace-read/1',
        childWorkspaces: true,
        childSnapshots: true,
      })
      .expect(200);
    state.model.mockImplementationOnce(async (input) => {
      expect((input as { skills?: unknown }).skills).toBeUndefined();
      expect(
        (await input.toolTurn!.declarations(input.signal)).map(
          (tool) => tool.name,
        ),
      ).toEqual(['read_file', 'glob']);
      return { text: 'read only', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Review the change' }];
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
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).toHaveBeenCalledOnce();
    await expect(state.model.mock.results[0].value).resolves.toMatchObject({
      text: 'read only',
    });
  });

  // #13905 (item 42): the drop is not create-only — a read-profile Session
  // loaded from its stored definition takes no skill catalog either, so a
  // regression that keeps the catalog on load is caught here.
  it('keeps a loaded read-profile Session without a skill catalog from its agent definition', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const skillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'published',
            description: 'Published instructions',
            body: 'ORIGINAL_SKILL_BODY',
            base_directory: 'docs',
          },
        ]),
      ),
    );
    const identity = {
      agentId: `agent_${'a'.repeat(32)}`,
      revision: '1',
      digest: 'b'.repeat(64),
    };
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        agentDefinition: { ...identity, skillsRef },
        toolProfile: 'hosted-workspace-read/1',
        childWorkspaces: true,
        childSnapshots: true,
      })
      .expect(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .expect(204);
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store(), agentDefinition: identity })
      .expect(200);
    state.model.mockImplementationOnce(async (input) => {
      expect((input as { skills?: unknown }).skills).toBeUndefined();
      expect(
        (await input.toolTurn!.declarations(input.signal)).map(
          (tool) => tool.name,
        ),
      ).toEqual(['read_file', 'glob']);
      return { text: 'read only', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Review the change' }];
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).toHaveBeenCalledOnce();
    await expect(state.model.mock.results[0].value).resolves.toMatchObject({
      text: 'read only',
    });
  });

  it('recovers a large manual Skill call whose assistant committed before its response', async () => {
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const skillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'published',
            description: 'Instructions',
            body: 'RECOVERED_ORIGINAL_SKILL' + 'x'.repeat(400 * 1024),
            model_invocable: false,
          },
        ]),
      ),
    );
    const identity = {
      agentId: `agent_${'a'.repeat(32)}`,
      revision: '1',
      digest: 'b'.repeat(64),
    };
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        agentDefinition: { ...identity, skillsRef },
        toolProfile: 'hosted-workspace-files/1',
      })
      .expect(200);
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const write = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(async function (
        this: ManagedSessionRecordSink,
        record,
      ) {
        if (
          record.type === 'tool_result' &&
          record.message?.parts?.some(
            (part) => part.functionResponse?.name === 'skill',
          )
        )
          throw new Error('Simulated Skill response commit failure');
        return originalWrite.call(this, record);
      });
    state.model.mockImplementationOnce(async (input) => {
      const call = {
        name: 'skill',
        callId: 'call-recover-skill',
        args: { skill: 'published' },
        isClientInitiated: true,
        prompt_id: PROMPT_ID,
      };
      await input.toolTurn!.execute(
        [call],
        [
          {
            functionCall: { name: call.name, id: call.callId, args: call.args },
          },
        ],
        'test-model',
        input.signal,
      );
      return { text: 'unreached', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Load instructions' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    // The slow-host settle budget, not vitest's 1 s default: this poll flipped
    // in CI on a loaded ecs host (#15579, run 40182849995) before the
    // recovery-blocked state landed.
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
    write.mockRestore();
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId,
    );
    let recovered: readonly unknown[] | undefined;
    state.model.mockImplementationOnce(async (input) => {
      recovered = input.resumeFromToolResults;
      return { text: 'continued', model: 'test-model' };
    });
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        agentDefinition: identity,
        driveRuntimeRecovery: true,
      })
      .expect(200);
    await vi.waitFor(
      () =>
        expect(JSON.stringify(recovered)).toContain('RECOVERED_ORIGINAL_SKILL'),
      { timeout: settleTimeoutMs() },
    );
    expect(JSON.stringify(recovered)).not.toContain('never ran');
    expect(JSON.stringify(recovered)).toContain('Tool output truncated.');
    expect(JSON.stringify(recovered).length).toBeLessThan(201000);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
  });
});
