/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as hostedHistory from './hosted-file-history.js';
import * as modelRecovery from './hosted-model-recovery.js';
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
import {
  SessionTranscriptChangedError,
  SessionWriterLease,
} from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { channelInputId } from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import { HostedChannelSession } from './hosted-channel-session.js';
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
import type { ManagedSessionEvent } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
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
import { hostedHookOccurrenceId } from './hosted-hook-session.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import type { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import {
  HostedToolRecoveryRequiredError,
  hostedRuntimeSessionId,
} from './hosted-workspace-tool-turn.js';
import { HOSTED_TOOL_APPROVAL_POLICY } from './hosted-tool-approval.js';
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
import {
  AUTOMATION_INPUT_SOURCE,
  automationRunId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import { monitorWakeNeedsRecovery } from './hosted-monitor-wake-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedContextCompression } from './hosted-context-compression.js';
import { HostedTeamSession } from './hosted-team-session.js';

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

// R1-2: the finished-before-commit hold reads its switch once at module scope,
// so a vi.stubEnv inside a case cannot arm it. Set the env before the static
// import evaluates that read, under a dedicated Session id. The hold only fires
// for the matching id, so every other Session in the file is unaffected.
const crashBeforeCommitArm = vi.hoisted(() => {
  const sessionId = '880e8400-e29b-41d4-a716-446655440004';
  process.env['QWEN_E2E_CRASH_BEFORE_ASSISTANT_COMMIT'] = sessionId;
  return { sessionId };
});

// Keep slow-host slack, but make all settle waits share the current test's
// remaining time, including waits hidden inside helper functions.
const MAX_SETTLE_TIMEOUT_MS = isSlowTestHost() ? 45_000 : 10_000;
let settleTimeoutMs: () => number;

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
  // A parked pre-tool turn: the prompt's assistant message committed its
  // tool call, then a PreToolUse evaluation fence parked the turn.
  const preToolParkedSession = (
    records: unknown[],
    read: (ref: unknown) => Promise<Buffer>,
  ) => {
    const events = [
      {
        kind: 'input.accepted',
        sequence: 5,
        payload: { turnId: 'prompt', source: 'hosted-harness' },
      } as unknown as ManagedSessionEvent,
      {
        kind: 'model.attempt',
        sequence: 6,
        payload: { attemptId: 'attempt-1', state: 'output_committed' },
      } as unknown as ManagedSessionEvent,
    ];
    return {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 6,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain: () => records,
          domainRecord: () => undefined,
          harnessRunAuthorization: async () => ({
            status: 'runnable',
            checkpoint: { continuation: { phase: 'model_output_committed' } },
          }),
        },
        resources: { read },
        sink: {
          project: async () => [
            {
              daemonPromptId: 'prompt',
              type: 'assistant',
              uuid: 'u-assistant',
              model: 'test-model',
              message: {
                parts: [
                  {
                    functionCall: {
                      id: 'call-0',
                      name: 'write_file',
                      args: {},
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
  };

  const settledPreToolRecord = (occurrenceId: string, resourceId: string) => {
    const resultRef = {
      resourceId,
      kind: 'managed-hook-result',
      schemaVersion: 1,
      byteLength: 2,
      digest: 'b'.repeat(64),
    };
    const record = {
      hookExecutionId: occurrenceId,
      occurrenceId,
      runtimeSessionId: 'runtime-1',
      registrationId: 'registration-1',
      eventName: HookEventName.PreToolUse,
      ordinal: 1,
      hookId: 'hook-1',
      planRef: {
        ...resultRef,
        resourceId: `${resourceId}-plan`,
        kind: 'managed-hook-plan',
      },
      inputRef: {
        ...resultRef,
        resourceId: `${resourceId}-input`,
        kind: 'managed-hook-input',
      },
      resultRef,
      onceKey: null,
      cancelRequested: false,
      run: {
        state: 'settled',
        reason: null,
        definition: {
          definitionId: 'catalog',
          definitionRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
        executionCallId: null,
        effectId: occurrenceId,
        dispatchId: null,
        deliveryId: null,
        execution: 'settled',
        runtime: null,
        delivery: null,
      },
    };
    return { record, resultRef };
  };

  it('does not read a settled PreToolUse result from an unrelated earlier occurrence', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'earlier-prompt:call-9'),
      'r-unrelated',
    );
    const read = vi.fn(async () => Buffer.from('{}'));
    const session = preToolParkedSession([{ record }], read);
    await settleCancelledHookTurn(session);
    // The in-memory occurrence filter runs ahead of any durable read, so a
    // record that cannot match this turn never pays a resources.read —
    // pre-filter this read fired once per historical record per pass.
    expect(read).not.toHaveBeenCalledWith(resultRef);
    expect(read).not.toHaveBeenCalled();
    // The unrelated record is no fence: the parked turn stays parked.
    expect(session.blocked).toBe(true);
  });

  it('treats an unreadable settled PreToolUse result as no fence', async () => {
    const { record } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-gone',
    );
    const read = vi.fn(async () => {
      throw new ManagedSessionRecordError('resource gone');
    });
    const session = preToolParkedSession([{ record }], read);
    // One missing result resource on any historical record must not reject
    // the pass — the open route has no arm for that throw.
    await expect(settleCancelledHookTurn(session)).resolves.toBeUndefined();
    expect(session.blocked).toBe(true);
  });

  it('treats an unreadable settled PreToolUse input as no fence', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-input',
    );
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === resultRef.resourceId)
        return Buffer.from(
          '{"outcome":"timeout","duration":0,"notStarted":true}',
        );
      throw new ManagedSessionRecordError('resource gone');
    });
    const session = preToolParkedSession([{ record }], read);
    // The result read proves the fence, then the input read that would
    // attribute it to the parked turn fails: the record must be skipped,
    // never rejecting the pass and never counting as a match.
    await expect(settleCancelledHookTurn(session)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'r-input-input' }),
    );
    expect(session.blocked).toBe(true);
  });

  it('does not settle a turn on a genuine callback-phase timeout receipt', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-real',
    );
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === resultRef.resourceId)
        // A callback that ran and timed out at its own deadline carries no
        // notStarted marker; only the Runtime's proven non-execution
        // receipts carry it.
        return Buffer.from(
          '{"outcome":"timeout","duration":5000,"error":"Managed hook execution failed."}',
        );
      return Buffer.from(
        '{"prompt_id":"prompt","tool_use_id":"call-0","tool_name":"write_file"}',
      );
    });
    const session = preToolParkedSession([{ record }], read);
    const write = vi.fn();
    (session.managed.sink as unknown as { write: typeof write }).write = write;
    await settleCancelledHookTurn(session);
    // The receipt proves the callback ran: nothing is certified cancelled,
    // so no turn_result is written and the recovery barrier stays latched.
    expect(write).not.toHaveBeenCalled();
    expect(session.blocked).toBe(true);
  });

  it('does not settle a turn on a genuine callback-phase cancelled receipt', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-ran',
    );
    const cancelledRecord = {
      ...record,
      run: { ...record.run, state: 'cancelled' },
    };
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === resultRef.resourceId)
        // A callback cancelled after it ran carries no notStarted marker;
        // only the Runtime's proven non-execution receipts carry it.
        return Buffer.from(
          '{"outcome":"cancelled","duration":3000,"error":"Hook execution cancelled."}',
        );
      return Buffer.from(
        '{"prompt_id":"prompt","tool_use_id":"call-0","tool_name":"write_file"}',
      );
    });
    const session = preToolParkedSession([{ record: cancelledRecord }], read);
    const write = vi.fn();
    (session.managed.sink as unknown as { write: typeof write }).write = write;
    await settleCancelledHookTurn(session);
    // The receipt proves the callback ran: nothing is certified cancelled,
    // so no turn_result is written and the recovery barrier stays latched.
    expect(write).not.toHaveBeenCalled();
    expect(session.blocked).toBe(true);
  });

  it('does not settle a turn on a cancelled receipt whose callback ran inside its own millisecond', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-fast',
    );
    const cancelledRecord = {
      ...record,
      run: { ...record.run, state: 'cancelled' },
    };
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === resultRef.resourceId)
        // A callback dispatched and cancelled inside its own starting
        // millisecond publishes the republish's exact shape minus the
        // marker: millisecond wall clock cannot tell the two apart, so the
        // missing marker is the only thing keeping this certified as real
        // work.
        return Buffer.from(
          '{"outcome":"cancelled","duration":0,"error":"Managed hook execution failed."}',
        );
      return Buffer.from(
        '{"prompt_id":"prompt","tool_use_id":"call-0","tool_name":"write_file"}',
      );
    });
    const session = preToolParkedSession([{ record: cancelledRecord }], read);
    const write = vi.fn();
    (session.managed.sink as unknown as { write: typeof write }).write = write;
    await settleCancelledHookTurn(session);
    // No marker, no fence: nothing is certified cancelled, so no
    // turn_result is written and the recovery barrier stays latched.
    expect(write).not.toHaveBeenCalled();
    expect(session.blocked).toBe(true);
  });

  it('treats an unreadable InstructionsLoaded input of the parked turn as no fence', async () => {
    const hookExecutionId = 'hook-instructions';
    const resultRef = {
      resourceId: 'r-result',
      kind: 'managed-hook-result',
      schemaVersion: 1,
      byteLength: 2,
      digest: 'b'.repeat(64),
    };
    const record = {
      hookExecutionId,
      occurrenceId: hostedHookOccurrenceId(
        HookEventName.InstructionsLoaded,
        `prompt:native:${'c'.repeat(64)}:0`,
      ),
      runtimeSessionId: 'runtime-1',
      registrationId: 'registration-1',
      eventName: HookEventName.InstructionsLoaded,
      ordinal: 1,
      hookId: 'hook-1',
      planRef: {
        ...resultRef,
        resourceId: 'r-plan',
        kind: 'managed-hook-plan',
      },
      inputRef: {
        ...resultRef,
        resourceId: 'r-input',
        kind: 'managed-hook-input',
      },
      resultRef,
      onceKey: null,
      cancelRequested: false,
      run: {
        state: 'settled',
        reason: null,
        definition: {
          definitionId: 'catalog',
          definitionRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
        executionCallId: null,
        effectId: hookExecutionId,
        dispatchId: null,
        deliveryId: null,
        execution: 'settled',
        runtime: null,
        delivery: null,
      },
    };
    const events = [
      {
        kind: 'input.accepted',
        sequence: 5,
        payload: { turnId: 'prompt', source: 'hosted-harness' },
      } as unknown as ManagedSessionEvent,
      // The record's creation commit inside the parked turn: what admits a
      // republished InstructionsLoaded fence, which can never carry
      // cancelRequested, ahead of any durable read.
      {
        kind: 'domain.committed',
        sequence: 6,
        payload: { domain: 'hook_execution', operationId: hookExecutionId },
      } as unknown as ManagedSessionEvent,
    ];
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === 'r-result')
        return Buffer.from(
          '{"outcome":"timeout","duration":0,"notStarted":true}',
        );
      throw new ManagedSessionRecordError('resource gone');
    });
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 6,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain: () => [{ record }],
        },
        resources: { read },
        sink: { project: async () => [] },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await expect(settleCancelledHookTurn(session)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'r-input' }),
    );
    expect(session.blocked).toBe(true);
  });

  it('aborts the pre-model scan when the reconcile signal fires', async () => {
    const reason = new Error('The Hook reconciliation deadline expired.');
    const aborted = new AbortController();
    aborted.abort(reason);
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 5,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => [
            {
              kind: 'input.accepted',
              sequence: 5,
              payload: { turnId: 'prompt', source: 'hosted-harness' },
            } as unknown as ManagedSessionEvent,
          ],
          // The record body is never parsed: the abort lands first.
          extensionRecordsInDomain: () => [{ record: {} }],
        },
        resources: { read: async () => Buffer.from('{}') },
        sink: { project: async () => [] },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await expect(settleCancelledHookTurn(session, aborted.signal)).rejects.toBe(
      reason,
    );
    expect(session.hooksBusy).toBe(false);
  });

  it('aborts the pre-tool scan when the reconcile signal fires', async () => {
    const reason = new Error('The prompting client disconnected.');
    const aborted = new AbortController();
    aborted.abort(reason);
    const { record } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'earlier-prompt:call-9'),
      'r-unrelated',
    );
    const read = vi.fn(async () => Buffer.from('{}'));
    const session = preToolParkedSession([{ record }], read);
    await expect(settleCancelledHookTurn(session, aborted.signal)).rejects.toBe(
      reason,
    );
    expect(session.hooksBusy).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

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

  // Runs before the abort case below: the hold latch (crashBeforeCommitFired)
  // is module scope and never reset, so this case must execute while it is
  // still unset. Otherwise the spent latch, not the session-id comparison,
  // would suppress the hold and this case could not fail for its property.
  it('does not fire the finished-before-commit hold for a non-matching session', async () => {
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'no hold' }];
    const promptId = randomUUID();
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({ prompt, promptId, payloadDigest: digest })
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
    const events = (
      await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      })
    ).events;
    expect(
      events
        .filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === promptId,
        )
        .map((event) => event.payload['outcome']),
    ).toEqual(['completed']);
    expect(
      events.some(
        (event) =>
          event.kind === 'message.committed' &&
          event.payload['role'] === 'assistant',
      ),
    ).toBe(true);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 60_000);

  // R1-2: the finished-before-commit hold must observe the Turn's abort signal.
  // Without the release/addEventListener wiring a leaked flag would park the
  // Session uncancellably; these cases drive a real turn into the hold and prove
  // the abort settles it cancelled with no assistant commit, and that a
  // non-matching Session never holds at all.
  it('settles the finished-before-commit hold cancelled on abort without an assistant commit', async () => {
    const sessionId = crashBeforeCommitArm.sessionId;
    const key = { tenantId: 'tenant', workspaceId: 'workspace', sessionId };
    const readJournal = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${sessionId}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hold then cancel' }];
    const promptId = randomUUID();
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    try {
      await headers(supertest(server).post(`/session/${sessionId}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId, payloadDigest: digest })
        .expect(202);
      // The model resolves and the turn parks in the pre-assistant-commit hold.
      await vi.waitFor(
        () =>
          expect(
            stderr.mock.calls.some(([line]) =>
              String(line).includes(
                'E2E holding finished turn before assistant commit',
              ),
            ),
          ).toBe(true),
        { timeout: settleTimeoutMs() },
      );
      await headers(supertest(server).post(`/session/${sessionId}/cancel`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      // The abort-driven release must settle the turn; if the hold never
      // releases this wait times out rather than passing trivially.
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${sessionId}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const events = (await readJournal()).events;
      expect(
        events
          .filter(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === promptId,
          )
          .map((event) => event.payload['outcome']),
      ).toEqual(['cancelled']);
      expect(
        events.some(
          (event) =>
            event.kind === 'message.committed' &&
            event.payload['role'] === 'assistant',
        ),
      ).toBe(false);
    } finally {
      stderr.mockRestore();
      await Promise.race([
        headers(supertest(server).delete(`/session/${sessionId}`)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }, 60_000);

  it('refuses legacy teardown during compression even without a client id', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const busy = vi
      .spyOn(HostedContextCompression.prototype, 'busy', 'get')
      .mockReturnValue(true);
    try {
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      );
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('session_context_busy');
      const detached = await headers(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(detached.status).toBe(409);
      expect(detached.body.code).toBe('session_context_busy');
    } finally {
      busy.mockRestore();
    }
  });

  it.each(['create', 'resident-load', 'cold-load'])(
    'refuses an omitted Session model configuration digest on %s',
    async (operation) => {
      let server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        modelConfigDigest: `sha256:${'a'.repeat(64)}`,
      });
      expect(created.status).toBe(200);
      if (operation === 'cold-load') {
        await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
          .set('X-Qwen-Client-Id', created.body.clientId as string)
          .expect(204);
        server = await app();
      }
      const result = await headers(
        supertest(server).post(
          operation === 'create' ? '/session' : `/session/${SESSION_ID}/load`,
        ),
      ).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('hosted_agent_definition_conflict');
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it.each([
    new ManagedSessionStoreHttpError(
      503,
      'store_unavailable',
      'store is unavailable',
    ),
    new ManagedSessionStoreTransportError('store connection failed'),
  ])(
    'preserves a private model configuration Store outage as a Store failure: %s',
    async (cause) => {
      const server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        modelConfigDigest: `sha256:${'a'.repeat(64)}`,
      });
      expect(created.status).toBe(200);
      state.modelConfig.mockRejectedValueOnce(cause);
      state.model.mockImplementationOnce(async (input) => {
        await input.modelConfig!();
        return { text: 'unreachable', model: 'test-model' };
      });
      const prompt = [{ type: 'text', text: 'read configuration' }];
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
          const journal = await LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          });
          const settled = journal.events.find(
            (event) => event.kind === 'turn.settled',
          );
          expect(settled?.payload['stopReason']).toBe(
            'managed_session_store_unavailable',
          );
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.modelConfig).toHaveBeenCalledOnce();
    },
  );

  it('persists model selection and refuses changed resident and cold prompt replays', async () => {
    let server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    let clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'model selection' }];
    const request = {
      prompt,
      promptId: PROMPT_ID,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      modelSelection: { modelId: 'model-a', revision: 1 },
    };
    const send = (body = request) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send(body);
    const idle = () =>
      vi.waitFor(
        async () => {
          const result = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(result.body.hasActivePrompt).toBe(false);
        },
        // The turn's settle crosses fsync-backed journal commits before the
        // active flag clears; the default 1s waitFor window flaked on a loaded
        // CI runner (#14101, #13219).
        { timeout: settleTimeoutMs() },
      );
    await send().expect(202);
    await idle();
    expect(state.model.mock.calls[0][0].modelSelection).toEqual(
      request.modelSelection,
    );
    await send({
      ...request,
      modelSelection: { modelId: 'model-b', revision: 2 },
    }).expect(409);
    await send().expect(202);
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', clientId)
      .expect(204);
    server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    clientId = loaded.body.clientId as string;
    await send({
      ...request,
      modelSelection: { modelId: 'model-b', revision: 2 },
    }).expect(409);
    await send().expect(202);
    await send({
      ...request,
      promptId: randomUUID(),
      modelSelection: { modelId: 'model-b', revision: 2 },
    }).expect(202);
    await idle();
    expect(
      state.model.mock.calls.map(([input]) => input.modelSelection),
    ).toEqual([request.modelSelection, { modelId: 'model-b', revision: 2 }]);
  });

  it.each(
    [
      { toolProfile: 'hosted-workspace-files/1', custom: false },
      { toolProfile: 'hosted-workspace-files/1', custom: true },
      { toolProfile: 'hosted-workspace-shell/1', custom: true },
      { toolProfile: 'hosted-workspace-files/3', custom: true },
      { toolProfile: 'hosted-workspace-files/3', custom: false },
    ].flatMap((profile) =>
      [undefined, { mode: 'yolo', revision: 1 }].map((approvalSelection) => ({
        ...profile,
        approvalSelection,
      })),
    ),
  )(
    'preserves approval selection $approvalSelection for $toolProfile custom=$custom across resident and cold replays',
    async ({ approvalSelection, toolProfile, custom }) => {
      const agentDefinition = custom
        ? {
            agentId: `agent_${'a'.repeat(32)}`,
            revision: '1',
            digest: 'b'.repeat(64),
          }
        : undefined;
      let server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
        approvalMode: 'default',
        agentDefinition: agentDefinition && {
          ...agentDefinition,
          model: { id: 'configured' },
        },
      });
      expect(created.status).toBe(200);
      let clientId = created.body.clientId as string;
      const prompt = [{ type: 'text', text: 'approval selection' }];
      const request = {
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        approvalSelection,
      };
      const send = (body = request) =>
        headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
          .set('X-Qwen-Client-Id', clientId)
          .send(body);
      const idle = () =>
        vi.waitFor(
          async () => {
            const result = await headers(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            ).set('X-Qwen-Client-Id', clientId);
            expect(result.body.hasActivePrompt).toBe(false);
          },
          { timeout: settleTimeoutMs() },
        );
      await send().expect(202);
      await idle();
      expect(state.model).toHaveBeenCalledTimes(1);
      await send({
        ...request,
        approvalSelection: { mode: 'auto-edit', revision: 2 },
      }).expect(409);
      await send().expect(202);
      await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({
        managedSessionStore: store(),
        toolProfile,
        agentDefinition,
      });
      expect(loaded.status).toBe(200);
      clientId = loaded.body.clientId as string;
      await send({
        ...request,
        approvalSelection: { mode: 'auto-edit', revision: 2 },
      }).expect(409);
      await send().expect(202);
      await send({
        ...request,
        promptId: randomUUID(),
        approvalSelection: { mode: 'auto-edit', revision: 2 },
      }).expect(202);
      await idle();
      expect(state.model).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    undefined,
    'hosted-workspace-files/2',
    'hosted-workspace-read/1',
    'hosted-workspace-team-lead/1',
  ])(
    'refuses custom approval selection outside the supported profiles (%s)',
    async (toolProfile) => {
      const server = await app(true);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile,
        approvalMode: 'default',
        agentDefinition: {
          agentId: `agent_${'a'.repeat(32)}`,
          revision: '1',
          digest: 'b'.repeat(64),
          model: { id: 'configured' },
        },
      });
      expect(created.status).toBe(200);
      const prompt = [{ type: 'text', text: 'unsupported selection' }];
      const refused = await headers(
        supertest(server).post(`/session/${SESSION_ID}/prompt`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          approvalSelection: { mode: 'yolo', revision: 1 },
        });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('invalid_hosted_approval_selection');
      expect(state.model).not.toHaveBeenCalled();
    },
  );

  it('restores the accepted model selection before re-running an interrupted model', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    state.model.mockImplementationOnce(async (input) => {
      const prepare = (
        input as unknown as {
          prepareModel(
            prepared: LlmPreparedRequest,
            round: number,
            pending: boolean,
          ): Promise<
            | import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js').ManagedSessionDurableRef
            | undefined
          >;
        }
      ).prepareModel;
      const ref = await prepare(
        {
          request: {
            model: 'model-b',
            contents: [
              { role: 'user', parts: [{ text: 'restore model selection' }] },
            ],
            config: {},
          },
          history: [],
          completedToolCallIds: [],
          routeSelector: 'openai:model-b',
          providerPin: 'a'.repeat(64),
          promptTokensForClamp: 0,
        },
        0,
        false,
      );
      await input.modelScope!.beginMainAttempt('model-b', ref);
      throw new HostedToolRecoveryRequiredError('interrupted');
    });
    const prompt = [{ type: 'text', text: 'restore model selection' }];
    const modelSelection = { modelId: 'model-b', revision: 2 };
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        modelSelection,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    // The slow-host settle budget, not vitest's 1 s default: at load ~90 with
    // ~100 concurrent vitest processes the recovery-blocked state had not
    // settled before the default expired (#15528's post-merge run).
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
    const replacement = await app();
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store(), driveRuntimeRecovery: true })
      .expect(200);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(2), {
      timeout: settleTimeoutMs(),
    });
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
    expect(
      state.model.mock.calls.map(([input]) => input.modelSelection),
    ).toEqual([modelSelection, modelSelection]);
  });

  it('re-answers a drive takeover while the resident model turn is active', async () => {
    let releaseModel!: () => void;
    let markFirstChunk!: () => void;
    const modelHeld = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const firstChunk = new Promise<void>((resolve) => {
      markFirstChunk = resolve;
    });
    const text = 'COORDINATOR_RECOVERED';
    state.model.mockImplementationOnce(async ({ textDeltas }) => {
      await textDeltas!.delta('COORDINATOR_');
      markFirstChunk();
      await modelHeld;
      await textDeltas!.delta('RECOVERED');
      return { text, model: 'test-model' };
    });

    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'COORDINATOR_ONLY' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await firstChunk;

    const load = () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        driveRuntimeRecovery: true,
      });
    const takeover = await load();
    expect(takeover.status).toBe(200);
    expect(takeover.body.clientId).toBe(created.body.clientId);
    const redriven = await load();
    expect(redriven.status).toBe(200);
    expect(redriven.body).toMatchObject({
      clientId: takeover.body.clientId,
      eventEpoch: takeover.body.eventEpoch,
      lastEventId: takeover.body.lastEventId,
    });
    expect(state.model).toHaveBeenCalledTimes(1);

    releaseModel();
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
    expect(
      transcript.body.events.filter((event: { type: string }) =>
        ['turn_complete', 'turn_error'].includes(event.type),
      ),
    ).toHaveLength(1);
    expect(state.model).toHaveBeenCalledTimes(1);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
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

  it('runs the never-started reconcile for a fresh Session open', async () => {
    neverStartedReconcile.fn.mockClear();
    await hookApp();
    expect(neverStartedReconcile.fn).toHaveBeenCalledTimes(1);
    expect(neverStartedReconcile.fn).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: expect.anything(),
        resources: expect.anything(),
        childRuns: expect.any(HostedChildRunSession),
        brokerOptions: expect.anything(),
      }),
    );
  });

  it('holds the fresh Session open until the never-started reconcile completes', async () => {
    neverStartedReconcile.fn.mockClear();
    let release!: () => void;
    neverStartedReconcile.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened = false;
    const pending = hookApp().then((app) => {
      opened = true;
      return app;
    });
    try {
      await vi.waitFor(
        () => expect(neverStartedReconcile.fn).toHaveBeenCalledTimes(1),
        { timeout: settleTimeoutMs() },
      );
      expect(opened).toBe(false);
    } finally {
      release();
    }
    await pending;
    expect(opened).toBe(true);
  });

  it.each([
    { tenantId: 'foreign' },
    { workspaceId: 'foreign' },
    { writerToken: 'f'.repeat(40) },
    { baseUrl: 'https://foreign-store.test' },
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

  it('aborts an active Turn and returns 503 when durable cancellation fails', async () => {
    const { server, authorize } = await hookApp();
    let signal!: AbortSignal;
    let finish!: () => void;
    state.model.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          signal = input.signal;
          finish = () => resolve({ text: '', model: 'test-model' });
        }),
    );
    const prompt = [
      { type: 'text', text: 'cancel while Store is unavailable' },
    ];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({ prompt, promptId: PROMPT_ID, payloadDigest })
      .expect(202);
    await vi.waitFor(
      () => expect(state.model).toHaveBeenCalledOnce(),
      // #14101: the admission crosses fsync-backed journal commits before
      // the model call; the default 1s waitFor window flaked on a loaded
      // CI runner (#13219).
      { timeout: settleTimeoutMs() },
    );
    const original =
      LocalManagedSessionAuthority.prototype.appendExecutionEvent;
    const append = vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'appendExecutionEvent')
      .mockImplementation(function (
        this: LocalManagedSessionAuthority,
        ...args
      ) {
        if (args[0].operation === 'requestCancel')
          return Promise.reject(new Error('Store unavailable'));
        return Reflect.apply(original, this, args);
      });
    try {
      const response = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/cancel`),
      );
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('hosted_cancel_commit_failed');
      expect(signal.aborted).toBe(true);
    } finally {
      append.mockRestore();
      finish();
    }
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      },
      // #14101: the cancelled turn's settle crosses fsync-backed journal
      // commits before the active flag clears; the default 1s waitFor
      // window flaked on a loaded CI runner (#13219).
      { timeout: settleTimeoutMs() },
    );
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

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
      await vi.waitFor(
        () => expect(state.model).toHaveBeenCalledTimes(1),
        // #14101: the admission crosses fsync-backed journal commits before
        // the model call; the default 1s waitFor window flaked on a loaded
        // CI runner (#13219).
        { timeout: settleTimeoutMs() },
      );
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
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        // #14101: the cancelled turn's settle crosses fsync-backed journal
        // commits before the active flag clears; the default 1s waitFor
        // window flaked on a loaded CI runner (#13219).
        { timeout: settleTimeoutMs() },
      );
      state.authorizeOrdinary.mockResolvedValue(undefined);
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/detach`),
      ).expect(204);
    },
  );

  it.each(['close', 'delete'] as const)(
    'v2 Shell %s settles Hooks once before resource phases',
    async (kind) => {
      const { server, authorize, requests, release } = await hookApp(
        'hosted-workspace-shell/1',
      );
      const initialHook = randomUUID();
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
      )
        .send({
          operationId: initialHook,
          event: 'Notification',
          input: { message: 'ready', notification_type: 'test' },
        })
        .expect(200);
      await vi.waitFor(async () => {
        const result = await authorize(
          supertest(server).get(
            `/session/${SESSION_ID}/hooks/operations/${initialHook}`,
          ),
        );
        expect(result.body.state).toBe('settled');
      });
      requests.length = 0;
      const operation = {
        protocolVersion: 2,
        phase: 'effects',
        kind,
        toolProfile: 'hosted-workspace-shell/1',
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
        authority: { operationId: `v2-${kind}`, claimGeneration: 1 },
      };
      for (const claimGeneration of [1, 2]) {
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
        )
          .send({
            ...operation,
            authority: { ...operation.authority, claimGeneration },
          })
          .expect(200);
      }
      expect(
        requests
          .filter((request) => request.kind === 'hook-execute')
          .map((request) => request.input.hook_event_name),
      ).toEqual(
        kind === 'close' ? ['SessionEnd'] : ['SessionEnd', 'SessionDelete'],
      );
      expect(release).not.toHaveBeenCalled();
      for (const phase of ['prepare_resources', 'settle_resources']) {
        await authorize(
          supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
        )
          .send({
            ...operation,
            phase,
            authority: { ...operation.authority, claimGeneration: 2 },
          })
          .expect(200);
      }
      expect(state.model).not.toHaveBeenCalled();
      await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
        .send({ authority: { ...operation.authority, claimGeneration: 2 } })
        .expect(204);
    },
  );

  it.each([
    'workspace_lifecycle_claim_fenced',
    'workspace_close_identity_unverified',
  ])('preserves %s during v2 resource preparation', async (code) => {
    const { server, authorize } = await hookApp('hosted-workspace-shell/1');
    state.assertWritable.mockRejectedValueOnce(
      new ManagedSessionStoreHttpError(409, code, 'Cleanup rejected'),
    );
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
    ).send({
      protocolVersion: 2,
      phase: 'prepare_resources',
      kind: 'close',
      toolProfile: 'hosted-workspace-shell/1',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'fenced-v2-shell', claimGeneration: 1 },
    });
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe(code);
    expect(state.model).not.toHaveBeenCalled();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/detach`),
    ).expect(204);
  });

  it('cold-loads a v2 Shell cleanup claim without SessionStart or new execution', async () => {
    const { server, authorize, definition, requests } = await hookApp(
      'hosted-workspace-shell/1',
    );
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/hooks/operations`),
    )
      .send({
        operationId: randomUUID(),
        event: 'Notification',
        input: { message: 'ready', notification_type: 'test' },
      })
      .expect(200);
    const operation = {
      protocolVersion: 2,
      phase: 'effects',
      kind: 'close',
      toolProfile: 'hosted-workspace-shell/1',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'cold-v2-shell', claimGeneration: 1 },
    };
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send(operation)
      .expect(200);
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: operation.authority })
      .expect(204);
    requests.length = 0;
    vi.mocked(HostedWorkspaceBroker.prototype.warm).mockClear();
    const authority = { ...operation.authority, claimGeneration: 2 };
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        ...definition,
        lifecycleProtocolVersion: 2,
        lifecycleAuthority: authority,
      })
      .expect(200);
    const cleanup = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId);
    for (const phase of ['prepare_resources', 'settle_resources']) {
      await cleanup(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
        .send({ ...operation, phase, authority })
        .expect(200);
    }
    expect(requests).toHaveLength(0);
    expect(HostedWorkspaceBroker.prototype.warm).not.toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
    await cleanup(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority })
      .expect(204);
  });

  it('v2 MCP effects retain the owner until resources settle', async () => {
    const { server, authorize, requests } = await mcpApp();
    await authorize(
      supertest(server).post(`/session/${SESSION_ID}/mcp/operations`),
    )
      .send({
        operationId: randomUUID(),
        serverId: 'demo',
        request: { kind: 'resource_read', uri: 'memory://note' },
      })
      .expect(202);
    const operation = {
      protocolVersion: 2,
      phase: 'effects',
      kind: 'close',
      toolProfile: 'hosted-workspace-mcp/1',
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      authority: { operationId: 'v2-mcp', claimGeneration: 1 },
    };
    await authorize(supertest(server).post(`/session/${SESSION_ID}/lifecycle`))
      .send(operation)
      .expect(200);
    expect(
      requests.filter((request) => request.kind === 'mcp-release'),
    ).toHaveLength(0);
    for (const phase of ['prepare_resources', 'settle_resources']) {
      await authorize(
        supertest(server).post(`/session/${SESSION_ID}/lifecycle`),
      )
        .send({ ...operation, phase })
        .expect(200);
    }
    expect(
      requests.filter((request) => request.kind === 'mcp-release'),
    ).toHaveLength(1);
    expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalled();
    expect(state.model).not.toHaveBeenCalled();
    await authorize(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .send({ authority: operation.authority })
      .expect(204);
  });

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
    const { server, authorize, requests } = await hookApp(
      'hosted-workspace-files/1',
      true,
    );
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

  it.each([false, true])(
    'retains a completed gate release failure while the pool drains (retry: %s)',
    async (retry) => {
      const server = await app(true, 'pod-gate');
      vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
      const acquire = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'acquire')
        .mockResolvedValue();
      const prepare = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'prepareReplayable')
        .mockResolvedValue({
          executionCallId: 'gate-execution',
          settled: {
            executionStatus: 'success',
            responseParts: [{ text: '{"kind":"quiet","durationMs":3}' }],
          },
        });
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockRejectedValue(
          new HostedWorkspaceBrokerRejection(503, 'runtime_unavailable', {
            message: 'fixture release refused',
          }),
        );
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        toolProfile: 'hosted-workspace-shell/1',
        managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
        harnessPlacement: {
          instanceId: 'pod-gate',
          bootId: BOOT_ID,
          placementEpoch: 1,
        },
      });
      expect(created.status).toBe(200);
      const authorized = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          created.body.clientId as string,
        );
      const operations = (body: Record<string, unknown>) =>
        authorized(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...body });
      const snapshot = () =>
        headers(supertest(server).get('/internal/hosted-harness/v1/instance'));
      try {
        expect(
          (
            await operations({
              kind: 'define_schedule',
              scheduleId: AUTOMATION_ID,
              definition: { ...automationDefinition, gate: 'printf gate' },
            })
          ).status,
        ).toBe(202);
        const before = await snapshot();
        const fired = await operations(fireBody());
        expect(fired.status).toBe(503);
        expect(fired.body.code).toBe('automation_operation_failed');
        expect(release).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(acquire).not.toHaveBeenCalled();
        expect(state.model).not.toHaveBeenCalled();
        if (retry) {
          release.mockResolvedValue();
          const retried = await operations(fireBody());
          expect(retried.status).toBe(202);
          expect(retried.body.gate.outcome).toBe('quiet');
        }
        await vi.waitFor(
          async () => {
            const ended = await snapshot();
            expect(ended.body.counters.inFlightMutations).toBe(0);
            expect(ended.body.counters.openingSessions).toBe(0);
          },
          { timeout: settleTimeoutMs() },
        );
        const drained = await headers(
          supertest(server).post('/internal/hosted-harness/v1/instance:drain'),
        ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID });
        expect(drained.status).toBe(202);
        await vi.waitFor(
          async () => {
            const after = await snapshot();
            const observation = {
              before: before.body,
              fire: { status: fired.status, body: fired.body },
              drain: { status: drained.status, body: drained.body },
              after: after.body,
              ownershipReleases: state.ownershipReleases,
            };
            expect(observation).toMatchObject({
              after: {
                state: retry ? 'DRAINED' : 'QUIESCING',
                counters: {
                  inFlightMutations: 0,
                  attachedSessions: retry ? 0 : 1,
                  heldResources: retry ? 0 : 1,
                },
              },
              ownershipReleases: retry ? [{ placementEpoch: 1 }] : [],
            });
          },
          { timeout: settleTimeoutMs() },
        );
      } finally {
        release.mockResolvedValue();
        await authorized(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );

  it('keeps interrupted initialization unresolved after quiesce instead of claiming DRAINED', async () => {
    const server = await app(false, 'pod-a');
    let entered!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const original = LocalManagedSessionResourceStore.prototype.read;
    let held = false;
    const read = vi
      .spyOn(LocalManagedSessionResourceStore.prototype, 'read')
      .mockImplementation(async function (
        this: LocalManagedSessionResourceStore,
        ref,
      ) {
        if (ref.kind === 'managed-definition' && !held) {
          held = true;
          entered();
          await gate;
        }
        return original.call(this, ref);
      });
    const opening = headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
        harnessPlacement: {
          instanceId: 'pod-a',
          bootId: BOOT_ID,
          placementEpoch: 1,
        },
      })
      .then((response) => response);
    try {
      await started;
      const draining = await headers(
        supertest(server).post('/internal/hosted-harness/v1/instance:drain'),
      ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID });
      expect(draining.body.state).toBe('QUIESCING');
      expect(draining.body.counters.openingSessions).toBeGreaterThan(0);
      unblock();
      expect((await opening).body.code).toBe('hosted_harness_quiescing');
      const unresolved = await headers(
        supertest(server).get('/internal/hosted-harness/v1/instance'),
      );
      expect(unresolved.body.state).toBe('QUIESCING');
      expect(unresolved.body.counters.openingSessions).toBe(1);
      expect(state.ownershipReleases).toHaveLength(0);
      expect(state.model).not.toHaveBeenCalled();
    } finally {
      unblock();
      await opening;
      read.mockRestore();
    }
  });

  it('quiesces after the running Turn and releases without starting or cancelling queued wake input', async () => {
    const server = await app(false, 'pod-a');
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: { ...store(), writerToken: 'a'.repeat(32) },
      harnessPlacement: {
        instanceId: 'pod-a',
        bootId: BOOT_ID,
        placementEpoch: 1,
      },
    });
    expect(created.status).toBe(200);
    const authorized = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    const operations = (body: Record<string, unknown>) =>
      authorized(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...body });
    expect(
      (
        await operations({
          kind: 'define_schedule',
          scheduleId: AUTOMATION_ID,
          definition: automationDefinition,
        })
      ).status,
    ).toBe(202);
    let finish!: () => void;
    state.model.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { text: 'finished original Turn', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'foreground before drain' }];
    const body = {
      promptId: PROMPT_ID,
      prompt,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    };
    const submit = (payload: Record<string, unknown>) =>
      authorized(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
        payload,
      );
    expect((await submit(body)).status).toBe(202);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const fired = await operations(fireBody());
    expect(fired.status).toBe(202);
    try {
      const drained = await headers(
        supertest(server).post('/internal/hosted-harness/v1/instance:drain'),
      ).send({ operationId: randomUUID(), expectedBootId: BOOT_ID });
      expect(drained.body.state).toBe('QUIESCING');
      expect((await submit(body)).status).toBe(202);
      expect(
        (await submit({ ...body, promptId: randomUUID() })).body.code,
      ).toBe('hosted_harness_quiescing');
      expect(state.ownershipReleases).toHaveLength(0);
      finish();
      await vi.waitFor(
        async () => {
          const instance = await headers(
            supertest(server).get('/internal/hosted-harness/v1/instance'),
          );
          expect(instance.body.state).toBe('DRAINED');
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(1);
      expect(state.ownershipReleases).toHaveLength(1);
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
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === fired.body.inputId,
        ),
      ).toHaveLength(1);
      expect(
        journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === fired.body.inputId,
        ),
      ).toHaveLength(0);
      expect(
        journal.events.filter((event) => event.kind === 'lifecycle.changed'),
      ).toHaveLength(0);
    } finally {
      finish?.();
    }
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
    // A gate the shell checks refuse is a pre-commit refusal of its own, so
    // the control plane can release the caller's key.
    const backgrounded = await operations({
      kind: 'define_schedule',
      scheduleId: AUTOMATION_ID,
      definition: { ...automationDefinition, gate: 'sleep 5 &' },
    });
    expect(backgrounded.status).toBe(400);
    expect(backgrounded.body.code).toBe('automation_gate_invalid');
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
      { timeout: settleTimeoutMs(), interval: 50 },
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
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
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

  it('cancels only the active automation occurrence and preserves later runs', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const operations = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ operationId: randomUUID(), ...body });
    const cancel = (occurrenceKey = AUTOMATION_SLOT) =>
      operations({
        kind: 'cancel_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey,
        automationRunId: automationRunId(AUTOMATION_ID, occurrenceKey),
      });
    expect(
      (
        await operations({
          kind: 'cancel_run',
          scheduleId: AUTOMATION_ID,
          occurrenceKey: '',
          automationRunId: automationRunId(AUTOMATION_ID, AUTOMATION_SLOT),
        })
      ).status,
    ).toBe(400);
    expect((await cancel('manual:missing')).status).toBe(404);
    let signal!: AbortSignal;
    let finish!: () => void;
    state.model.mockImplementationOnce(
      (input) =>
        new Promise((_resolve, reject) => {
          signal = input.signal;
          finish = () => reject(new DOMException('Cancelled', 'AbortError'));
          signal.addEventListener('abort', finish, { once: true });
        }),
    );
    try {
      expect(
        (
          await operations({
            kind: 'define_schedule',
            scheduleId: AUTOMATION_ID,
            definition: automationDefinition,
          })
        ).status,
      ).toBe(202);
      expect((await operations(fireBody())).status).toBe(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1), {
        timeout: settleTimeoutMs(),
      });
      expect(signal.aborted).toBe(false);
      expect(
        (
          await operations({
            kind: 'cancel_run',
            scheduleId: AUTOMATION_ID,
            occurrenceKey: AUTOMATION_SLOT,
            automationRunId: automationRunId(AUTOMATION_ID, 'manual:other'),
          })
        ).status,
      ).toBe(400);
      expect(signal.aborted).toBe(false);
      expect((await cancel()).status).toBe(202);
      expect(signal.aborted).toBe(true);
      await vi.waitFor(
        async () =>
          expect((await operations(fireBody())).body.run.state).toBe(
            'cancelled',
          ),
        { timeout: settleTimeoutMs() },
      );
      expect((await cancel()).body.run.state).toBe('cancelled');
      expect(
        (
          await operations({
            kind: 'define_schedule',
            scheduleId: AUTOMATION_ID,
            definition: automationDefinition,
          })
        ).body.schedule,
      ).toMatchObject({ enabled: true, revision: 1 });
      expect(
        (await operations(fireBody(1, 'manual:later', 'manual'))).status,
      ).toBe(202);
      await vi.waitFor(
        async () =>
          expect(
            (await operations(fireBody(1, 'manual:later', 'manual'))).body.run
              .state,
          ).toBe('settled'),
        { timeout: settleTimeoutMs() },
      );
      expect((await cancel('manual:later')).body.run.state).toBe('settled');
      expect(state.model).toHaveBeenCalledTimes(2);
    } finally {
      finish?.();
    }
  });

  it('cancels one queued automation without aborting foreground or sibling work', async () => {
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
    let signal!: AbortSignal;
    let finish!: () => void;
    state.model.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          signal = input.signal;
          finish = () =>
            resolve({ text: 'foreground done', model: 'test-model' });
        }),
    );
    const prompt = [{ type: 'text', text: 'foreground held' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    try {
      await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .send({ prompt, promptId: PROMPT_ID, payloadDigest })
        .expect(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1), {
        timeout: settleTimeoutMs(),
      });
      expect(
        (
          await operations({
            kind: 'define_schedule',
            scheduleId: AUTOMATION_ID,
            definition: automationDefinition,
          })
        ).status,
      ).toBe(202);
      expect((await operations(fireBody())).status).toBe(202);
      expect(
        (await operations(fireBody(1, 'manual:sibling', 'manual'))).status,
      ).toBe(202);
      expect(
        (
          await operations({
            kind: 'cancel_run',
            scheduleId: AUTOMATION_ID,
            occurrenceKey: AUTOMATION_SLOT,
            automationRunId: automationRunId(AUTOMATION_ID, AUTOMATION_SLOT),
          })
        ).status,
      ).toBe(202);
      expect(signal.aborted).toBe(false);
      expect(state.model).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(
        async () => {
          expect((await operations(fireBody())).body.run).toMatchObject({
            state: 'cancelled',
            execution: 'not_started_proven',
          });
          expect(
            (await operations(fireBody(1, 'manual:sibling', 'manual'))).body.run
              .state,
          ).toBe('settled');
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).toHaveBeenCalledTimes(2);
      expect(signal.aborted).toBe(false);
    } finally {
      finish?.();
    }
  });

  it('consumes a durable queued automation cancel on load without a model call', async () => {
    await prewriteAutomationSession(undefined, undefined, true);
    const server = await app();
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
    });
    expect(loaded.status).toBe(200);
    await vi.waitFor(
      async () => {
        const replay = await headers(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        )
          .set('X-Qwen-Client-Id', loaded.body.clientId as string)
          .send({ operationId: randomUUID(), ...fireBody() });
        expect(replay.body.run).toMatchObject({
          state: 'cancelled',
          execution: 'not_started_proven',
        });
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).not.toHaveBeenCalled();
  });

  async function prewriteAutomationSession(
    toolProfile?: string,
    captureBytes?: number,
    cancel = false,
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
      if (cancel) await automations.requestCancel(fired.run!.automationRunId);
      return fired.inputId;
    } finally {
      await managed.close().catch(() => undefined);
    }
  }

  // A prewrite whose automation turn ran and ended with the writer's crash:
  // the journal carries the committed input, the transcript carries the
  // turn attempt, and the hook pin keeps a bare load from refusing the
  // crash the way a parked prompt would refuse it without one.
  async function prewriteAutomationCrashedTurnSession(
    cancel = false,
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
      if (cancel) await automations.requestCancel(fired.run!.automationRunId);
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
    state.approvalSelections.set(SESSION_ID, { mode: 'yolo', revision: 0 });
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
      { timeout: settleTimeoutMs() },
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
      timeout: settleTimeoutMs(),
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
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
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

  it('registers a wake Runtime a background run still holds, for the close drain (#13856 R1-28)', async () => {
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
      // The wake turn started a background Shell that still holds its Runtime,
      // so the routine release refuses `runtime_session_held`. The aftermath
      // must read that as the designed hold — register it for the close's
      // drain and keep settling — never drain (that would stop a run the user
      // meant to keep), and never wedge the Session on the refusal.
      const repair = mockRepairBroker();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
        () =>
          Promise.reject(
            new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
          ),
      );
      repair.unlatch();
      const heldRuntimeTurns = new Set<string>();
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
        heldRuntimeTurns,
      } as never;
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: '', baseUrl: 'http://127.0.0.1:8080' } as never,
        turnId: inputId,
      });
      expect(aftermath).toBe('settled');
      expect(heldRuntimeTurns.has(inputId)).toBe(true);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  // H4e-b1: a wake Turn that died after a team call committed and before
  // its tool_result landed: the aftermath answers it from its record before
  // the Turn settles, so the next Turn's model is never told to retry it.
  it('answers a committed team call of a crashed wake Turn from its record', async () => {
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
      await managed.sink.write({
        uuid: randomUUID(),
        parentUuid: null,
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
              functionCall: {
                id: 'call-1',
                name: 'team_create',
                args: { team_name: 'review' },
              },
            },
          ],
        },
      });
      const teams = new HostedTeamSession(
        { authority: managed.authority, resources: managed.resources },
        key,
        new HostedChildAgentSession(
          { authority: managed.authority, resources: managed.resources },
          key,
        ),
      );
      await teams.run(
        'team_create',
        { team_name: 'review' },
        `${inputId}:call-1`,
      );
      const session = {
        managed,
        teams,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      expect(
        await settleCrashedWakeTurnAftermath({
          session,
          sessionId: SESSION_ID,
          cwd: state.root,
          brokerOptions: undefined,
          turnId: inputId,
        }),
      ).toBe('settled');
      const answer = (await managed.sink.project())
        .filter(
          (record) =>
            record.daemonPromptId === inputId && record.type === 'tool_result',
        )
        .flatMap((record) => record.message?.parts ?? [])
        .find((part) => part.functionResponse?.id === 'call-1');
      expect(JSON.stringify(answer?.functionResponse?.response)).toContain(
        'committed its team change',
      );
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
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
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
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
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

  it('journals a Broker-fenced wake park as unobserved, never a witnessed cancellation', async () => {
    // R10-1: the aftermath's stop counts the fenced execution into the
    // unobserved carry, and the settle must receive it — otherwise the
    // reclaimed record certifies a cancellation nobody observed.
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
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'abandoned',
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
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
        brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
        turnId: inputId,
      });
      expect(aftermath).toBe('settled');
      const toolResults = (await managed.sink.project()).filter(
        (entry) =>
          entry.daemonPromptId === inputId && entry.type === 'tool_result',
      );
      expect(toolResults).toHaveLength(1);
      const response = toolResults[0]?.message?.parts?.[0]?.functionResponse
        ?.response as Record<string, unknown> | undefined;
      expect(response?.['executionStatus']).toBe('unknown');
      expect(String(response?.['error'])).toContain('could not be observed');
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('keeps a crashed wake turn unsettled while its settle cannot verify the park', async () => {
    // R11-1: the stop proves cleanly, but the settle's own authorization
    // re-read faults transiently — a retry-inviting refusal the aftermath
    // must answer 'pending' with, never a terminal record over parked
    // executions the settle journaled nothing for.
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
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      // The aftermath's own read and the stop's read pass; every read
      // behind the stop's first Broker poll — the settle's own re-read —
      // faults into an erased verdict.
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
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        async () => {
          blockSettleReads = true;
          return { state: 'settled' } as never;
        },
      );
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
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
        brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
        turnId: inputId,
      });
      expect(aftermath).toBe('pending');
      // No terminal record over a park the settle could not verify, and
      // the lease stays for the retry that can.
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(false);
      expect(release).not.toHaveBeenCalled();
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('carries an unobserved stop across aftermath retries, never certifying it witnessed', async () => {
    // R10-1: a stop that throws after counting the fenced execution must
    // hand the id to the pump's retry — the reclaimed record reads as
    // already-stopped there, and a fresh per-pass carry would let the
    // settle journal a cancellation nobody witnessed.
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
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      // Pass 1's pre-cancel read faults after the id is counted; by pass 2
      // the Broker has reclaimed the record, which is no witness.
      let statusCalls = 0;
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        async () => {
          statusCalls += 1;
          if (statusCalls === 1)
            throw new TypeError('Runtime Broker status lost to a 503');
          return undefined as never;
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
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
      const first = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
        turnId: inputId,
      });
      expect(first).toBe('pending');
      const second = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
        turnId: inputId,
      });
      expect(second).toBe('settled');
      const toolResults = (await managed.sink.project()).filter(
        (entry) =>
          entry.daemonPromptId === inputId && entry.type === 'tool_result',
      );
      expect(toolResults).toHaveLength(1);
      const response = toolResults[0]?.message?.parts?.[0]?.functionResponse
        ?.response as Record<string, unknown> | undefined;
      expect(response?.['executionStatus']).toBe('unknown');
      expect(String(response?.['error'])).toContain('could not be observed');
      // The durable settle discharged the carry; it must not outlive the
      // Turn.
      const carried = (
        session as unknown as { recoveryUnobserved?: Map<string, Set<string>> }
      ).recoveryUnobserved;
      expect(carried?.has(inputId) ?? false).toBe(false);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('forgets a carried id a later pass positively witnesses settled', async () => {
    // R10-1 (round 12): the carry write-back must delete a pruned-to-empty
    // entry — an upsert-only write leaves the previous pass's stale set
    // behind, and the next pass journals a positively witnessed stop as
    // unobservable.
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
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      // Pass 1 faults the pre-cancel read, counting the id; pass 2
      // positively witnesses the stop (pruning the carry empty) but its
      // settle cannot verify the park; pass 3 reads the reclaimed record.
      let blockSettleReads = false;
      const reads: Array<() => Promise<{ state: string } | undefined>> = [
        () =>
          Promise.reject(new TypeError('Runtime Broker status lost to a 503')),
        () => {
          blockSettleReads = true;
          return Promise.resolve({ state: 'settled' });
        },
        () => Promise.resolve(undefined),
      ];
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        () => (reads.shift() ?? (() => Promise.resolve(undefined)))() as never,
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
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
      const drive = () =>
        settleCrashedWakeTurnAftermath({
          session,
          sessionId: SESSION_ID,
          cwd: state.root,
          brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
          turnId: inputId,
        });
      const carry = () =>
        (
          session as unknown as {
            recoveryUnobserved?: Map<string, Set<string>>;
          }
        ).recoveryUnobserved;
      expect(await drive()).toBe('pending');
      expect([...(carry()?.get(inputId) ?? [])]).toEqual(['ex-wake-1']);
      expect(await drive()).toBe('pending');
      // The positive witness pruned the carry; the session entry must be
      // gone with it — an upsert-only write-back keeps the stale id.
      expect(carry()?.has(inputId) ?? false).toBe(false);
      blockSettleReads = false;
      expect(await drive()).toBe('settled');
      const toolResults = (await managed.sink.project()).filter(
        (entry) =>
          entry.daemonPromptId === inputId && entry.type === 'tool_result',
      );
      expect(toolResults).toHaveLength(1);
      const response = toolResults[0]?.message?.parts?.[0]?.functionResponse
        ?.response as Record<string, unknown> | undefined;
      expect(response?.['executionStatus']).toBe('cancelled');
      expect(String(response?.['error'])).toContain('cancelled with its owner');
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('refuses a prompt retriably when the wake park probe read nothing', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    const kick = vi
      .spyOn(HostedMonitorWakeScheduler.prototype, 'kick')
      .mockImplementation(() => {});
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    // Only the route's checkpoint probe takes this spy: an erased verdict
    // must not answer "no park" over state nobody read.
    const checkpointRead = vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'harnessRunAuthorization')
      .mockResolvedValue({
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
          event.payload['source'] === 'hosted-harness',
      ),
    ).toBe(false);
    repair.unlatch();
    // Drain the parked settle before teardown: an unsettled park keeps the
    // wake pump retrying past this test's end, and its settle failures land
    // in later tests' stderr spies. The pump's own view is the journal —
    // watch the consume, not a route.
    checkpointRead.mockRestore();
    kick.mockRestore();
    capturedWakeSession().monitorWake!.kick();
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
              event.payload['turnId'] === inputId,
          ),
        ).toBe(true);
      },
      { timeout: 15_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);

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
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
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
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
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
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
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

  it("has a reconcile wait out the pump's own aftermath, then report the run it settled", async () => {
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
    // The pump's own aftermath is mid-flight: the route waits the pass out
    // instead of competing for the checkpoint (#14538), then reports the
    // run the pass settled.
    const during = reconcile().then((response) => response);
    expect(
      await Promise.race([
        during.then(() => 'answered'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
      ]),
    ).toBe('waiting');
    releaseConsume();
    const after = await during;
    expect(after.status).toBe(202);
    expect(after.body.repaired).toBe(false);
    expect(after.body.run.state).toBe('failed');
    expect(after.body.run.execution).toBe('outcome_unknown');
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

  it('has the reconcile route itself repair a crash the pump left blocked', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    // The pump's one aftermath pass loses its lease release, which leaves
    // the Session blocked with the crashed input pending. From then on the
    // test parks every kick (a live pump would retry), so only the route's
    // own repair branch can finish the aftermath. In 'has a reconcile wait
    // out the pump's own aftermath, then report the run it settled' the
    // pump settles it instead, and the route only reports.
    let brokerDown = true;
    let pumpLive = true;
    let parkedKicks = 0;
    const releases: string[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
      async () => {
        releases.push(brokerDown ? 'refused' : 'released');
        if (brokerDown) {
          pumpLive = false;
          throw new TypeError('Runtime Broker release lost to a 503');
        }
      },
    );
    const kick = HostedMonitorWakeScheduler.prototype.kick;
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      function (this: HostedMonitorWakeScheduler) {
        if (pumpLive) kick.call(this);
        else parkedKicks += 1;
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const status = async () =>
      (await authorize(supertest(server).get(`/session/${SESSION_ID}/status`)))
        .body as { recoveryBlocked: boolean; hasActivePrompt: boolean };
    const settledTurns = async () =>
      (
        await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        })
      ).events.filter(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === inputId,
      ).length;
    const reconcile = () =>
      authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({
        operationId: randomUUID(),
        kind: 'reconcile_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey: AUTOMATION_SLOT,
      });
    await vi.waitFor(
      async () => {
        expect(releases).toEqual(['refused']);
        expect((await status()).recoveryBlocked).toBe(true);
        // The pump arms its retry only after the pass's settle-verify
        // read: a parked retry kick means that pass is over.
        expect(parkedKicks).toBeGreaterThan(0);
      },
      { timeout: 15_000 },
    );
    expect(await settledTurns()).toBe(0);
    // A route pass that loses its release too repairs nothing: the block
    // and the input stay. The run already failed in the pump's pass.
    const refused = await reconcile();
    expect(refused.status).toBe(202);
    expect(refused.body.repaired).toBe(false);
    expect(refused.body.run).toMatchObject({
      state: 'failed',
      execution: 'outcome_unknown',
    });
    expect(releases).toEqual(['refused', 'refused']);
    expect((await status()).recoveryBlocked).toBe(true);
    expect(await settledTurns()).toBe(0);
    brokerDown = false;
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
    const repairing = reconcile().then((response) => response);
    // A route that skips the repair answers without ever consuming.
    expect(
      await Promise.race([
        entered.then(() => 'consuming'),
        repairing.then(() => 'answered'),
      ]),
    ).toBe('consuming');
    // Mid-repair the route holds the turn slot, which a live pump would
    // read as busy.
    expect((await status()).hasActivePrompt).toBe(true);
    releaseConsume();
    const repaired = await repairing;
    expect(repaired.status).toBe(202);
    expect(repaired.body.repaired).toBe(true);
    expect(releases).toEqual(['refused', 'refused', 'released']);
    expect(await status()).toMatchObject({
      recoveryBlocked: false,
      hasActivePrompt: false,
    });
    expect(await settledTurns()).toBe(1);
    // Consumed: a further reconcile only reports the settled run.
    const reported = await reconcile();
    expect(reported.status).toBe(202);
    expect(reported.body.repaired).toBe(false);
    expect(reported.body.run).toMatchObject({
      state: 'failed',
      execution: 'outcome_unknown',
    });
    expect(releases).toEqual(['refused', 'refused', 'released']);
    expect(await settledTurns()).toBe(1);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

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

  async function loadCrashedWake(inputId: string) {
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    return {
      server,
      authorize,
      status: async () =>
        (
          await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          )
        ).body as { recoveryBlocked: boolean; hasActivePrompt: boolean },
      settledTurns: async () =>
        (
          await LocalJsonlManagedSessionJournalStore.read({
            transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
            runtimeBaseDir: state.root,
            sessionKey: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              sessionId: SESSION_ID,
            },
          })
        ).events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ).length,
      reconcile: () =>
        authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        )
          .send({
            operationId: randomUUID(),
            kind: 'reconcile_run',
            scheduleId: AUTOMATION_ID,
            occurrenceKey: AUTOMATION_SLOT,
          })
          .then((response) => response),
    };
  }

  // Resolves 'waiting' unless `answer` lands first: the route cannot
  // answer while the pass it waits for is held, so this only ever gives a
  // route that skips the wait the time to show it.
  const stillWaiting = (answer: Promise<unknown>) =>
    Promise.race([
      answer.then(() => 'answered'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
    ]);

  it.each(['input read', 'transcript projection'] as const)(
    'has a reconcile wait out the load pass held at its %s, then report the run it settled',
    async (at) => {
      const inputId = await prewriteAutomationParkedWakeSession();
      mockBrokerBroker();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'settled',
      } as never);
      vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      const pass = holdWakePass(at);
      const { server, status, settledTurns, reconcile } =
        await loadCrashedWake(inputId);
      await vi.waitFor(() => expect(pass.held()).toBe(true), {
        timeout: 15_000,
      });
      const answer = reconcile();
      expect(await stillWaiting(answer)).toBe('waiting');
      expect(await settledTurns()).toBe(0);
      pass.open();
      // The pass settled the crash itself: the route repairs nothing, and
      // the failed run is what resolves the occurrence.
      const reported = await answer;
      expect(reported.status).toBe(202);
      expect(reported.body.repaired).toBe(false);
      expect(reported.body.run).toMatchObject({
        state: 'failed',
        execution: 'outcome_unknown',
      });
      expect((await status()).recoveryBlocked).toBe(false);
      expect(await settledTurns()).toBe(1);
      expect(
        (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
          .status,
      ).toBe(204);
    },
    45_000,
  );

  it('has a reconcile wait out a load pass whose aftermath failed, then repair what it left blocked', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    let brokerDown = true;
    const releases: string[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
      async () => {
        releases.push(brokerDown ? 'refused' : 'released');
        if (brokerDown)
          throw new TypeError('Runtime Broker release lost to a 503');
      },
    );
    // After its aftermath lost the release, the pass's next input read is
    // its settle-verify read.
    const pass = holdWakePass('input read', () => releases.length === 1);
    const { server, status, settledTurns, reconcile } =
      await loadCrashedWake(inputId);
    await vi.waitFor(() => expect(pass.held()).toBe(true), {
      timeout: 15_000,
    });
    expect((await status()).recoveryBlocked).toBe(true);
    brokerDown = false;
    const answer = reconcile();
    expect(await stillWaiting(answer)).toBe('waiting');
    expect(releases).toEqual(['refused']);
    pass.open();
    // The pass ends blocked and hands the pump to the waiting route before
    // its own retry fires: the route's repair is the one that settles.
    const repaired = await answer;
    expect(repaired.status).toBe(202);
    expect(repaired.body.repaired).toBe(true);
    expect(repaired.body.run).toMatchObject({
      state: 'failed',
      execution: 'outcome_unknown',
    });
    expect(releases).toEqual(['refused', 'released']);
    expect((await status()).recoveryBlocked).toBe(false);
    expect(await settledTurns()).toBe(1);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('has a reconcile report without settling when the load pass outlasts its wait', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    } as never);
    vi.spyOn(HostedWorkspaceBroker.prototype, 'cancel').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    // The route's wait, cut from its production bound.
    const exclusive = HostedMonitorWakeScheduler.prototype.exclusive;
    vi.spyOn(
      HostedMonitorWakeScheduler.prototype,
      'exclusive',
    ).mockImplementation(function (this: HostedMonitorWakeScheduler, work) {
      return exclusive.call(this, work, 200);
    });
    const pass = holdWakePass('transcript projection');
    const { server, status, settledTurns, reconcile } =
      await loadCrashedWake(inputId);
    await vi.waitFor(() => expect(pass.held()).toBe(true), {
      timeout: 15_000,
    });
    // The pass has not classified the crash yet, so the run still reads
    // as dispatched, and the route leaves the input to the pass.
    const reported = await reconcile();
    expect(reported.status).toBe(202);
    expect(reported.body.repaired).toBe(false);
    expect(reported.body.run).toMatchObject({
      state: 'running',
      execution: 'dispatch_started',
    });
    expect(await settledTurns()).toBe(0);
    pass.open();
    await vi.waitFor(
      async () => {
        expect((await status()).recoveryBlocked).toBe(false);
        expect(await settledTurns()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
  }, 45_000);

  it('has a reconcile that waited leave the turn slot to a prompt admitted meanwhile', async () => {
    // A crash with no Runtime park: a public prompt is admitted while the
    // load's pass is still reading the crashed input.
    const inputId = await prewriteAutomationCrashedTurnSession();
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
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
    const pass = holdWakePass('input read');
    const { server, authorize, status, settledTurns, reconcile } =
      await loadCrashedWake(inputId);
    await vi.waitFor(() => expect(pass.held()).toBe(true), {
      timeout: 15_000,
    });
    const answer = reconcile();
    expect(await stillWaiting(answer)).toBe('waiting');
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
    // The re-check after the wait finds the prompt's claim: the route
    // repairs nothing, and the prompt keeps its slot.
    const reported = await answer;
    expect(reported.status).toBe(202);
    expect(reported.body.repaired).toBe(false);
    expect((await status()).hasActivePrompt).toBe(true);
    expect(await settledTurns()).toBe(0);
    openModel();
    // Once the prompt ends, the pump settles the crash itself.
    await vi.waitFor(
      async () => {
        expect(await status()).toMatchObject({
          recoveryBlocked: false,
          hasActivePrompt: false,
        });
        expect(await settledTurns()).toBe(1);
      },
      { timeout: 15_000 },
    );
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
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
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
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

  it('reports a reconcile against a live wake turn without settling its run', async () => {
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
    expect(
      (
        await operations({
          kind: 'define_schedule',
          scheduleId: AUTOMATION_ID,
          definition: automationDefinition,
        })
      ).status,
    ).toBe(202);
    const inputId = `${automationRunId(AUTOMATION_ID, AUTOMATION_SLOT)}:input`;
    // The live turn's user record is durable before its model call: the
    // aftermath's crash test reads any record of the turn (here that user
    // record) as a prior attempt, so only the turn's hold on the slot
    // tells it apart from a turn that died there.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let userRecordWritten = false;
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      async function (this: ManagedSessionRecordSink, record) {
        await originalWrite.call(this, record);
        if (record.type === 'user' && record.daemonPromptId === inputId) {
          userRecordWritten = true;
        }
      },
    );
    let releaseModel!: () => void;
    let modelEntered = false;
    const modelHeld = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    state.model.mockImplementationOnce(async () => {
      modelEntered = true;
      await modelHeld;
      return { text: 'hello back', model: 'test-model' };
    });
    try {
      const fired = await operations(fireBody());
      expect(fired.status).toBe(202);
      expect(fired.body.inputId).toBe(inputId);
      await vi.waitFor(
        () => {
          expect(modelEntered).toBe(true);
          expect(userRecordWritten).toBe(true);
        },
        { timeout: settleTimeoutMs() },
      );
      // An overlap `skip` slot's reconcile while the turn runs: no
      // aftermath is in flight, so only the slot guard keeps the route
      // from classifying the live turn as crashed.
      const reconciled = await operations({
        kind: 'reconcile_run',
        scheduleId: AUTOMATION_ID,
        occurrenceKey: AUTOMATION_SLOT,
      }).timeout(10_000);
      expect(reconciled.status).toBe(202);
      expect(reconciled.body.repaired).toBe(false);
      expect(reconciled.body.run).toMatchObject({
        state: 'running',
        execution: 'dispatch_started',
      });
      const status = await authorize(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      );
      expect(status.body.hasActivePrompt).toBe(true);
    } finally {
      releaseModel();
      // A failed assertion must not leave the turn running into the
      // teardown, whose close refuses an active turn.
      // Cleanup, not proof: keep it short so a wedged turn still leaves the
      // assertion above inside this test's `}, 45_000);` ceiling.
      await vi
        .waitFor(
          async () => {
            const idle = await authorize(
              supertest(server).get(`/session/${SESSION_ID}/status`),
            );
            expect(idle.body.hasActivePrompt).toBe(false);
          },
          { timeout: 10_000 },
        )
        .catch(() => undefined);
    }
    // The turn the reconcile left alone settles its run itself.
    await vi.waitFor(
      async () => {
        const replayed = await operations(fireBody());
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('settled');
        expect(replayed.body.run.execution).toBe('settled');
      },
      { timeout: settleTimeoutMs(), interval: 50 },
    );
    expect(state.model).toHaveBeenCalledTimes(1);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const settled = journal.events.filter(
      (event) =>
        event.kind === 'turn.settled' && event.payload['turnId'] === inputId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload['outcome']).toBe('completed');
  }, 45_000);

  it('refuses a prompt while a wake park is still unsettled, retriably', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
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
          event.payload['source'] === 'hosted-harness',
      ),
    ).toBe(false);
    releaseClassify();
    repair.unlatch();
    // Drain the parked settle before teardown: an unsettled park keeps the
    // wake pump retrying past this test's end, and its settle failures land
    // in later tests' stderr spies. The pump's own view is the journal —
    // watch the consume, not a route: a status poll can answer before the
    // hung classification ever latches the block.
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
              event.payload['turnId'] === inputId,
          ),
        ).toBe(true);
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
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
  }, 45_000);

  it('refuses a prompt whose wake-park probe let the pump block the Session', async () => {
    await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    repair.unlatch();
    // Hold the pump itself before load: its first projection can otherwise
    // run before the load response reaches the test, leaving the wrong
    // consumer suspended at the probe below.
    let afterLoad = false;
    let releaseRun!: () => void;
    wakeDeps.runTurnGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
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
    try {
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      afterLoad = true;
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        );
      const prompt = [{ type: 'text', text: 'hello' }];
      const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
      // Promise.resolve dispatches the supertest thenable at once (its
      // request only leaves on .then), so the probe is in flight while
      // the test drives the pump below.
      const prompted = Promise.resolve(
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId: randomUUID(),
            payloadDigest,
          },
        ),
      );
      // The probe is in flight; the pump now classifies the same park,
      // and its aftermath stops, commits the cancelled results and parks
      // at the held release — the block the probe started before.
      await probed;
      releaseRun();
      await releasing;
      releaseProbe();
      const refused = await prompted;
      // The post-probe re-read, not the probe, held the line: the durable
      // session-scope code, while the transient-window one belongs to the
      // probe's own finding (the sibling pin above).
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('hosted_turn_recovery_required');
      expect(refused.body.reason).toBe('turn_blocked');
      // Nothing was admitted.
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
    } finally {
      releaseRun();
      releaseProbe();
      releaseRelease();
    }
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
      timeout: settleTimeoutMs(),
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
      { timeout: settleTimeoutMs(), interval: 50 },
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
      { timeout: settleTimeoutMs(), interval: 50 },
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
      { timeout: settleTimeoutMs(), interval: 50 },
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
      timeout: settleTimeoutMs(),
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

  it.each([false, true])(
    'settles a crashed automation as failed/unknown with durable cancel=%s',
    async (cancel) => {
      const inputId = await prewriteAutomationCrashedTurnSession(cancel);
      mockBrokerBroker();
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
        { timeout: settleTimeoutMs(), interval: 50 },
      );
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
        const settled = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload['outcome']).toBe('error');
      });
      expect(state.model).not.toHaveBeenCalled();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
  );

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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    let journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
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
    journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
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
        await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: key,
        })
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
        await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: key,
        })
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
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
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
      { timeout: settleTimeoutMs(), interval: 50 },
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
      { timeout: settleTimeoutMs(), interval: 50 },
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
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            event.payload['domain'] === 'automation_run' &&
            String(event.payload['operationId']).startsWith(`${runId}:`),
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${runId}:1`, `${runId}:2`]);
    await vi.waitFor(
      async () => {
        expect((await operations(fireBody(1, slot))).body.run.state).toBe(
          'settled',
        );
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
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
      { timeout: settleTimeoutMs(), interval: 50 },
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

  it('preserves the named store failure on session status when turn_result cannot commit', async () => {
    // Admission passes; the turn_result append dies once with a simulated
    // exhausted 503, latching the authority's writer. Every later settlement
    // write then dies with ManagedSessionWritesStoppedError without ever
    // reaching the store again, ending the turn recovery-blocked with the
    // named failure only remembered in memory (#13800 P1).
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    state.model.mockReset();
    state.model.mockResolvedValue({
      text: 'stub reply',
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
    const prompt = [{ type: 'text', text: 'hello' }];
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    try {
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId: randomUUID(), payloadDigest: digest })
        .expect(202);
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
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
    // reached the store; the retry died on the authority's stopped writer
    // without appending again.
    expect(settlementAttempts).toBe(1);
    // The uncertain-write constraint is preserved: the next prompt is still
    // refused on the same block — the named failure only mirrors into memory,
    // it does not claim a persisted terminal state.
    const refused = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({ prompt, promptId: randomUUID(), payloadDigest: digest });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_required');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 60_000);

  it.each([
    { cause: 'the stopped writer', preparationFailure: false },
    { cause: 'an unrelated failure', preparationFailure: true },
  ])(
    'preserves the named store failure when resident model recovery meets $cause',
    async ({ preparationFailure }) => {
      const server = await app();
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
      expect(created.status).toBe(200);
      const clientId = created.body.clientId as string;
      const text = 'recover the interrupted model';
      const prompt = [{ type: 'text', text }];
      state.model.mockReset();
      state.model.mockImplementationOnce(async (input) => {
        const prepare = (
          input as unknown as {
            prepareModel(
              prepared: LlmPreparedRequest,
              round: number,
              pending: boolean,
            ): Promise<
              | import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js').ManagedSessionDurableRef
              | undefined
            >;
          }
        ).prepareModel;
        const ref = await prepare(
          {
            request: {
              model: 'model-b',
              contents: [{ role: 'user', parts: [{ text }] }],
              config: {},
            },
            history: [],
            completedToolCallIds: [],
            routeSelector: 'openai:model-b',
            providerPin: 'a'.repeat(64),
            promptTokensForClamp: 0,
          },
          0,
          false,
        );
        const attempt = await input.modelScope!.beginMainAttempt(
          'model-b',
          ref,
        );
        await attempt(false, []);
        throw new Error('interrupted model');
      });
      const originalAppend =
        LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
      let storeUnavailable = true;
      let settlementAttempts = 0;
      const append = vi
        .spyOn(
          LocalJsonlManagedSessionJournalHandle.prototype,
          'appendTransaction',
        )
        .mockImplementation(async function (
          this: LocalJsonlManagedSessionJournalHandle,
          records: readonly unknown[],
        ) {
          if (
            storeUnavailable &&
            JSON.stringify(records).includes('"turn.settled"')
          ) {
            settlementAttempts += 1;
            throw new ManagedSessionStoreTransportError(
              'terminal write unavailable',
            );
          }
          return originalAppend.call(this, records);
        });
      const stderr = vi
        .spyOn(stdio, 'writeStderrLineSafe')
        .mockImplementation(() => {});
      const status = () =>
        headers(supertest(server).get(`/session/${SESSION_ID}/status`)).set(
          'X-Qwen-Client-Id',
          clientId,
        );
      let preparation: { mockRestore(): void } | undefined;
      try {
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
            const blocked = await status();
            expect(blocked.body.hasActivePrompt).toBe(false);
            expect(blocked.body.recoveryBlocked).toBe(true);
            expect(blocked.body.recoveryReason).toBe(
              'managed_session_store_unavailable',
            );
          },
          { timeout: settleTimeoutMs() },
        );
        expect(settlementAttempts).toBe(1);
        storeUnavailable = false;
        const appended = append.mock.calls.length;
        stderr.mockClear();
        if (preparationFailure)
          preparation = vi
            .spyOn(modelRecovery, 'findHostedCommittedModelOutput')
            .mockRejectedValueOnce(
              new Error('recovery preparation unavailable'),
            );
        const redriven = await headers(
          supertest(server).post(`/session/${SESSION_ID}/load`),
        )
          .set('X-Qwen-Client-Id', clientId)
          .send({ managedSessionStore: store(), driveRuntimeRecovery: true });
        expect(redriven.status).toBe(409);
        expect(redriven.body.code).toBe('hosted_turn_recovery_required');
        await vi.waitFor(
          async () => {
            const blocked = await status();
            expect(blocked.body.hasActivePrompt).toBe(false);
            expect(blocked.body.recoveryBlocked).toBe(true);
            expect(blocked.body.recoveryReason).toBe(
              'managed_session_store_unavailable',
            );
          },
          { timeout: settleTimeoutMs() },
        );
        expect(state.model).toHaveBeenCalledOnce();
        expect(append).toHaveBeenCalledTimes(appended);
        if (preparationFailure) {
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining(
              'Hosted recovery redrive failed: Error: recovery preparation unavailable',
            ),
          );
        } else {
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining(
              'Hosted Harness recovery remained blocked: ManagedSessionWritesStoppedError:',
            ),
          );
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining(
              'Hosted recovery redrive failed: ManagedSessionWritesStoppedError:',
            ),
          );
        }
      } finally {
        append.mockRestore();
        preparation?.mockRestore();
        stderr.mockRestore();
        await headers(supertest(server).delete(`/session/${SESSION_ID}`));
      }
    },
  );

  it('names the store on the block a cancelled turn leaves when its settlement cannot commit', async () => {
    // A cancelled turn keeps 'cancelled' as its outcome, so the prompt
    // route never names its cause for the record — but the block its dead
    // turn.settled write leaves is the store's, and the status surface must
    // say so rather than show a bare boolean (#13800).
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    let finish!: () => void;
    state.model.mockReset();
    state.model.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ text: '', model: 'stub-model' });
        }),
    );
    const originalAppend =
      LocalJsonlManagedSessionJournalHandle.prototype.appendTransaction;
    const failing = vi
      .spyOn(
        LocalJsonlManagedSessionJournalHandle.prototype,
        'appendTransaction',
      )
      .mockImplementation(async function (
        this: LocalJsonlManagedSessionJournalHandle,
        records: readonly unknown[],
      ) {
        if (!JSON.stringify(records).includes('"turn.settled"')) {
          return originalAppend.call(this, records);
        }
        throw new ManagedSessionStoreTransportError('store flap');
      });
    const prompt = [{ type: 'text', text: 'cancel me' }];
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    try {
      await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({ prompt, promptId: randomUUID(), payloadDigest: digest })
        .expect(202);
      await vi.waitFor(() => expect(state.model).toHaveBeenCalledOnce());
      await headers(supertest(server).post(`/session/${SESSION_ID}/cancel`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
      finish();
      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
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
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 60_000);

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

  // The same Session with its child result carried by a workflow record:
  // its notification input rides the workflow source through the wake and
  // close paths the monitor witness exercises for `monitor` (#13803 K2).
  async function prewriteAcceptedWorkflowChildSession(): Promise<string> {
    return prewriteAcceptedChildOfKind('workflow');
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
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
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

  // #13803 (K2): a workflow child's acceptance notification closes through
  // the same wake-owned drain — its source names the record's own kind. The
  // kick is parked so the close, never the live pump, owns this settle: the
  // load witness below exercises the pump; this one exercises the drain.
  it('settles a pending workflow child notification as session_closing when the Session closes', async () => {
    domainEnablement.childRun = true;
    const notificationTurnId = await prewriteAcceptedWorkflowChildSession();
    mockBrokerBroker();
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => {},
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    expect(
      (await headers(supertest(server).delete(`/session/${SESSION_ID}`)))
        .status,
    ).toBe(204);
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
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

  async function loadChannelWakePark(
    interruption: 'runtime' | 'queued' | 'approval' = 'runtime',
  ) {
    const turnId = await prewriteChannelWriteInterruption(
      false,
      undefined,
      interruption,
    );
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    vi.spyOn(HostedMonitorWakeScheduler.prototype, 'kick').mockImplementation(
      () => {},
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
    return {
      turnId,
      server,
      clientId: loaded.body.clientId,
      resident: capturedWakeSession(),
    };
  }

  it('recovers a blocked channel wake through its interruption funnel', async () => {
    const { turnId, server, clientId, resident } = await loadChannelWakePark();
    const scheduler = resident.monitorWake as unknown as {
      deps: { failed(cause: unknown): void; recoverBlocked(): Promise<void> };
    };
    scheduler.deps.failed(new Error('wake pump failure'));
    await scheduler.deps.recoverBlocked();
    expect(resident.blocked).toBe(false);
    const settlements = resident.managed.authority
      .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
      .filter(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
      );
    expect(settlements).toHaveLength(1);
    expect(settlements[0]!.payload).toMatchObject({
      outcome: 'cancelled',
      stopReason: 'harness_interruption',
    });
    expect(
      (await hostedHistory.readHostedFileHistory(resident.managed))
        ?.pendingTurn ?? null,
    ).toBeNull();
    const channels = (resident as unknown as { channels: HostedChannelSession })
      .channels;
    expect(await channels.planReply(turnId)).toBeUndefined();
    await scheduler.deps.recoverBlocked();
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it('never cancels a queued channel input while repairing a blocked wake pump', async () => {
    const { turnId, server, clientId, resident } =
      await loadChannelWakePark('queued');
    const scheduler = resident.monitorWake as unknown as {
      deps: { failed(cause: unknown): void; recoverBlocked(): Promise<void> };
    };
    scheduler.deps.failed(new Error('wake input read failure'));
    await scheduler.deps.recoverBlocked();
    expect(resident.blocked).toBe(true);
    expect(
      resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .filter(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
        ),
    ).toHaveLength(0);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it('keeps channel approval resolvable after a wake pump failure', async () => {
    const { turnId, server, clientId, resident } =
      await loadChannelWakePark('approval');
    const scheduler = resident.monitorWake as unknown as {
      deps: { failed(cause: unknown): void; recoverBlocked(): Promise<void> };
    };
    scheduler.deps.failed(
      new Error('wake pump failed with an approval pending'),
    );
    await scheduler.deps.recoverBlocked();
    expect(resident.blocked).toBe(false);
    expect(
      resident.managed.authority.action('channel-recovery-approval')?.state,
    ).toBe('requested');
    expect(
      resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .some(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
        ),
    ).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
    await headers(
      supertest(server).post(
        `/session/${SESSION_ID}/actions/channel-recovery-approval/resolve`,
      ),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        optionId: 'allow',
        inputRevision: 1,
        policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
      })
      .expect(200);
    expect(
      resident.managed.authority.action('channel-recovery-approval')?.state,
    ).toBe('decided');
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

  it.each(['broker', 'checkpoint'] as const)(
    'retries blocked channel recovery after a %s refusal',
    async (fault) => {
      const { turnId, server, clientId, resident } =
        await loadChannelWakePark();
      const checkpoint =
        fault === 'checkpoint'
          ? vi
              .spyOn(resident.managed.authority, 'harnessRunAuthorization')
              .mockResolvedValue({ status: 'blocked', reason: 'invalid_state' })
          : undefined;
      if (fault === 'broker')
        vi.mocked(HostedWorkspaceBroker.prototype.status).mockRejectedValueOnce(
          new Error('broker unavailable'),
        );
      const scheduler = resident.monitorWake as unknown as {
        deps: { failed(cause: unknown): void; recoverBlocked(): Promise<void> };
      };
      scheduler.deps.failed(new Error('wake pump failure'));
      await scheduler.deps.recoverBlocked();
      expect(resident.blocked).toBe(true);
      expect(
        (await hostedHistory.readHostedFileHistory(resident.managed))
          ?.pendingTurn,
      ).toBe(turnId);
      checkpoint?.mockRestore();
      await scheduler.deps.recoverBlocked();
      expect(resident.blocked).toBe(false);
      const settlements = resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .filter(
          (event) =>
            event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
        );
      expect(settlements).toHaveLength(1);
      expect(settlements[0]!.payload).toMatchObject({
        outcome: 'cancelled',
        stopReason: 'harness_interruption',
      });
      expect(
        (await hostedHistory.readHostedFileHistory(resident.managed))
          ?.pendingTurn ?? null,
      ).toBeNull();
      expect(state.model).not.toHaveBeenCalled();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`))
        .set('X-Qwen-Client-Id', clientId)
        .expect(204);
    },
  );

  it('refuses a fresh prompt while a channel wake holds a Runtime park', async () => {
    const { server, clientId, resident } = await loadChannelWakePark();
    const promptId = randomUUID();
    const prompt = [{ type: 'text', text: 'Wait for channel recovery' }];
    const response = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(409);
    expect(response.body.code).toBe('hosted_turn_recovery_in_progress');
    expect(
      resident.managed.authority
        .eventsInSequenceRange(1, resident.managed.authority.committedSequence)
        .some(
          (event) =>
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === promptId,
        ),
    ).toBe(false);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      clientId,
    );
  });

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
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
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
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
        const settled = journal.events.filter(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === channelTurn,
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]!.payload).toMatchObject({ outcome: 'cancelled' });
      },
      { timeout: settleTimeoutMs() },
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
              event.payload['turnId'] === channelTurn,
          ),
        ).toHaveLength(1);
      },
      { timeout: settleTimeoutMs() },
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

  it('parks an admitted prompt when model request preparation fails', async () => {
    const server = await app();
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      })
      .expect(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', created.body.clientId as string);
    state.model.mockRejectedValueOnce(
      new LlmRequestPreparationError('snapshot durability failed'),
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
        ).expect(200);
        expect(status.body).toMatchObject({
          hasActivePrompt: false,
          recoveryBlocked: true,
        });
      },
      // #14101: the parked chain crosses fsync-backed journal commits; the
      // default 1s waitFor window flaked on a loaded ubuntu-latest runner.
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
    expect(
      journal.events.filter((event) => event.kind === 'input.accepted'),
    ).toHaveLength(1);
    expect(journal.events.some((event) => event.kind === 'turn.settled')).toBe(
      false,
    );
    expect(state.model).toHaveBeenCalledTimes(1);
    await authorize(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
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
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
    const readSettled = async () =>
      (
        await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        })
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
  });

  it('retains cleanup debt after interrupted channel settlement until original-owner release succeeds', async () => {
    const channelTurn = await prewriteChannelWriteInterruption(true);
    mockBrokerBroker();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
      state: 'settled',
    });
    const release = vi.mocked(HostedWorkspaceBroker.prototype.release);
    release.mockRejectedValueOnce(new Error('release unavailable'));
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const readJournal = () =>
      LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
      });
    await vi.waitFor(
      async () => {
        expect(release).toHaveBeenCalledTimes(1);
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).expect(200);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      // #14101: the debt settle crosses fsync-backed journal commits; the
      // default 1s waitFor window flaked on a loaded ubuntu-latest runner.
      { timeout: settleTimeoutMs() },
    );
    const parked = await readJournal();
    const terminals = parked.events.filter(
      (event) => event.kind === 'turn.settled',
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.payload['turnId']).toBe(channelTurn);
    expect(
      parked.events.filter((event) => event.kind === 'hosted.cleanup'),
    ).toHaveLength(1);
    expect(release).toHaveBeenLastCalledWith({
      bindingId: 'binding',
      generation: '1',
    });
    expect(state.model).not.toHaveBeenCalled();
    const nextPrompt = [{ type: 'text', text: 'must remain blocked' }];
    await authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .send({
        prompt: nextPrompt,
        promptId: randomUUID(),
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(nextPrompt)).digest('hex')}`,
      })
      .expect(409);
    expect((await readJournal()).events).toHaveLength(parked.events.length);
    expect(state.model).not.toHaveBeenCalled();
    const redriven = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({
      managedSessionStore: store(),
      passiveManagedRuntimeRecovery: true,
    });
    expect(redriven.status).toBe(200);
    expect(redriven.body.clientId).toBe(loaded.body.clientId);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith({
      bindingId: 'binding',
      generation: '1',
    });
    const status = await authorize(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).expect(200);
    expect(status.body.recoveryBlocked).toBe(false);
    const journal = await readJournal();
    const confirmed = journal.events.filter(
      (event) =>
        event.kind === 'hosted.cleanup' &&
        event.payload['state'] === 'confirmed',
    );
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.sequence).toBeGreaterThan(terminals[0]!.sequence);
    expect(
      journal.events.filter((event) => event.kind === 'turn.settled'),
    ).toHaveLength(1);
    await authorize(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
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
              event.payload['turnId'] === 'chin-f10a',
          ),
        ).toBe(true);
      },
      { timeout: settleTimeoutMs() },
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
      { timeout: settleTimeoutMs() },
    );
  });

  it('accepts claim-fenced channel reconciliation only for an unknown settlement', async () => {
    const server = await app(true);
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      })
      .expect(200);
    const request = (body: Record<string, unknown>) =>
      headers(
        supertest(server).post(`/session/${SESSION_ID}/channels/operations`),
      )
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send(body);
    const operationId = `channel-reconcile:${'a'.repeat(64)}`;
    const body = {
      operationId,
      kind: 'settle_delivery',
      deliveryId: 'missing',
      outcome: 'unknown',
    };
    const settle = vi.spyOn(HostedChannelSession.prototype, 'settle');
    await request({ ...body, operationId: `${operationId}x` }).expect(400);
    await request({ ...body, outcome: 'rejected' }).expect(400);
    await request({ ...body, kind: 'cancel_delivery' }).expect(400);
    expect(settle).not.toHaveBeenCalled();
    await request(body).expect(409);
    expect(settle).toHaveBeenLastCalledWith('missing', 'unknown', operationId);
    await request({ ...body, operationId: randomUUID() }).expect(409);
    expect(settle).toHaveBeenLastCalledWith('missing', 'unknown', undefined);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .expect(204);
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
});
