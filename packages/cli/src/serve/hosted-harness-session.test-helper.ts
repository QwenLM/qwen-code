/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { getApiHistoryPromptId } from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';
import { CompressionStatus } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  filterHostedTurnHistory,
  normalizeHostedTurnRecords,
} from './hosted-turn-history.js';
import { buildSessionHistoryFromConversation } from '@qwen-code/qwen-code-core/services/session-api-history.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { SseAdmissionCaps } from './daemon-status.js';
import supertest from 'supertest';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import {
  type LocalJsonlManagedSessionJournalHandle,
  LocalJsonlManagedSessionJournalStore,
} from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import type {
  ManagedMcpControl,
  ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import {
  HostedToolRecoveryRequiredError,
  type HostedWorkspaceToolTurn,
} from './hosted-workspace-tool-turn.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import { createSettleTimeout } from '../test-utils/settle-timeout.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import type {
  ManagedHookCatalog,
  ManagedHookControl,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';

// Import this fixture before Harness modules so Vitest installs its mocks first.

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
  wakeDispatch: false,
  actionParking: false,
  runtimeObservation: false,
  backgroundActionParking: false,
  wakeActionParking: false,
  wakeStamps: [] as unknown[],
  assertWritable: vi.fn(async () => undefined),
  toolResults: null as DurableToolResultResourceStore | null,
  publicationRequest: vi.fn(),
  storeOptions: [] as Array<Record<string, unknown>>,
  ownershipReleases: [] as Array<Record<string, unknown>>,
  writerRenewalStops: 0,
  setLifecycleAuthority: vi.fn(),
  modelConfig: vi.fn(),
  memory: vi.fn(),
  authorizeLifecycle: vi.fn(async () => undefined),
  authorizeOrdinary: vi.fn(async (_kind?: 'legacy-close') => undefined),
  approvalSelections: new Map<
    string,
    { mode: 'default' | 'auto-edit' | 'yolo'; revision: number }
  >(),
  approvalQueries: [] as string[],
  appendFault: undefined as
    | ((
        journal: LocalJsonlManagedSessionJournalHandle,
        records: readonly unknown[],
        append: (records: readonly unknown[]) => Promise<void>,
      ) => Promise<boolean | void>)
    | undefined,
  automationCreates: [] as Array<{
    definition: Record<string, unknown>;
    idempotencyKey: string;
  }>,
  automationRetires: [] as Array<{
    automationId: string;
    idempotencyKey: string;
  }>,
  model: vi.fn(
    async (_input: {
      signal: AbortSignal;
      toolTurn?: HostedWorkspaceToolTurn;
      skills?: import('./hosted-skill-catalog.js').HostedSkillCatalog;
      hooks?: import('./hosted-hook-session.js').HostedHookSession;
      promptId?: string;
      modelScope?: import('@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js').ManagedHookModelScope;
      resumeFromToolResults?: readonly unknown[];
      textDeltas?: import('./hosted-text-deltas.js').HostedTextDeltaStream;
      workspaceContext?: { read(): string | undefined };
      modelSelection?: { modelId: string; revision: number };
      modelConfig?: import('./hosted-model-config.js').HostedModelConfigReader;
      memory?: import('./hosted-memory-session.js').HostedMemorySession;
      userPrompt?: boolean;
      setLoopClassifier?: (
        classify:
          | import('./hosted-loop-session.js').HostedLoopClassifier
          | undefined,
      ) => void;
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
      journalStore.open = async (request) => {
        const opened = await openJournal(request);
        journal = opened;
        // Dispatch through the prototype at call time so a test's prototype
        // spy still intercepts; a pre-bound copy would shadow it.
        const proto = Object.getPrototypeOf(opened) as {
          appendTransaction: (records: readonly unknown[]) => Promise<void>;
          seal: typeof opened.seal;
        };
        const append = (records: readonly unknown[]) =>
          proto.appendTransaction.call(opened, records);
        opened.appendTransaction = async (records) => {
          if (state.appendFault) {
            const consumed = await state.appendFault(opened, records, append);
            if (consumed) return;
          }
          return append(records);
        };
        opened.seal = (
          commit: Parameters<typeof opened.seal>[0],
          wake?: unknown,
        ) => {
          if (wake) state.wakeStamps.push(wake);
          return proto.seal.call(opened, commit);
        };
        return opened;
      };
      return {
        supportsWakeDispatch: () => state.wakeDispatch,
        supportsActionParking: () => state.actionParking,
        supportsRuntimeObservation: () => state.runtimeObservation,
        supportsBackgroundActionParking: () => state.backgroundActionParking,
        supportsWakeActionParking: () => state.wakeActionParking,
        journalStore,
        resourceStore,
        toolResultResources: state.toolResults ?? resourceStore,
        assertWritable: state.assertWritable,
        claimUserMessages: async () => [],
        setLifecycleAuthority: state.setLifecycleAuthority,
        modelConfig: state.modelConfig,
        memory: state.memory,
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
        stopWriterRenewal: () => {
          state.writerRenewalStops += 1;
        },
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
        automationsCreate: async (
          definition: Record<string, unknown>,
          idempotencyKey: string,
        ) => {
          state.automationCreates.push({ definition, idempotencyKey });
          return {
            automation: {
              id: 'asch_cron_1',
              sessionId: options.sessionKey.sessionId,
              cron: definition['cron'],
              timezone: definition['timezone'] ?? 'UTC',
              goal: definition['goal'] ?? null,
              state: 'live',
              enabled: true,
            },
            replayed: false,
          };
        },
        automationsList: async () => ({
          data: [],
          hasMore: false,
          nextCursor: null,
        }),
        automationsRetire: async (
          automationId: string,
          idempotencyKey: string,
        ) => {
          state.automationRetires.push({ automationId, idempotencyKey });
          return {
            automation: {
              id: automationId,
              sessionId: options.sessionKey.sessionId,
              cron: '*/5 * * * *',
              timezone: 'UTC',
              goal: null,
              state: 'retired',
              enabled: true,
            },
            replayed: false,
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
  state.appendFault = undefined;
  state.writerRenewalStops = 0;
  state.automationCreates.length = 0;
  state.automationRetires.length = 0;
  state.modelConfig.mockReset();
  state.memory.mockReset();
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
  suspensionOptions?: {
    idleSuspendMs?: number;
    suspendRetryBaseMs?: number;
    suspendRetryCap?: number;
    suspendReconcileMs?: number;
    coldOpenLimit?: number;
  },
  caps?: SseAdmissionCaps,
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
  const registration = registerHostedHarnessSessionRoutes(
    result,
    contract,
    state.root,
    withBroker ? { baseUrl: 'http://127.0.0.1:1', token: 'test' } : undefined,
    { ...suspensionOptions, sseAdmissionCaps: caps },
  );
  const listener = createServer(result);
  (
    listener as Server & { harnessRegistration?: typeof registration }
  ).harnessRegistration = registration;
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
  extra: Record<string, unknown> = {},
  suspensionOptions?: Parameters<typeof app>[3],
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
  const server = await app(true, undefined, true, suspensionOptions);
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
    ...extra,
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

async function writeSettledToolHistory(
  managed: ManagedSession,
  promptId: string,
  outcome: 'completed' | 'cancelled' | 'error',
  stopReason: string,
) {
  const content = Buffer.from(
    JSON.stringify([{ type: 'text', text: 'review X then fix findings' }]),
  );
  await managed.authority.submitInput(
    {
      operation: 'submitInput',
      commandId: promptId,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
      contentDigest: createHash('sha256').update(content).digest('hex'),
    },
    {
      inputId: promptId,
      turnId: promptId,
      source: 'hosted-harness',
      contentRef: await managed.resources.publish('managed-input', content),
      admissionRef: await managed.resources.publish(
        'managed-admission',
        Buffer.from('{}'),
      ),
      deadline: null,
      wakeReason: 'input',
    },
  );
  await createManagedHarnessHandle(managed).ensureRunnable();
  const messages: Array<Pick<ChatRecord, 'type' | 'message'>> = [
    {
      type: 'user',
      message: {
        role: 'user',
        parts: [{ text: 'review X then fix findings' }],
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: `${promptId}:background-agent`,
              name: 'agent',
              args: {},
            },
          },
        ],
      },
    },
    {
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: `${promptId}:background-agent`,
              name: 'agent',
              response: { output: 'Child agent started in the background' },
            },
          },
        ],
      },
    },
  ];
  let parentUuid: string | null = null;
  for (const message of messages) {
    const uuid = randomUUID();
    await managed.sink.write({
      uuid,
      parentUuid,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      cwd: state.root,
      version: 'hosted-harness/1',
      daemonPromptId: promptId,
      ...message,
    } as ChatRecord);
    parentUuid = uuid;
  }
  await managed.sink.write({
    uuid: randomUUID(),
    parentUuid,
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    type: 'system',
    subtype: 'turn_result',
    cwd: state.root,
    version: 'hosted-harness/1',
    daemonPromptId: promptId,
    systemPayload: {
      promptId,
      state: outcome,
      stopReason,
      endedAt: Date.now(),
    },
  } as ChatRecord);
}

/** A settled cancelled group beside a completed one, covered by an old-format
 * compression snapshot whose promptIds are legacy rewind marks (not journal
 * turn ids). Returns the snapshot record's uuid. */
async function writeCancelledGroupWithLegacySnapshot(
  managed: ManagedSession,
): Promise<string> {
  await writeSettledToolHistory(
    managed,
    'prior-cancel',
    'cancelled',
    'cancelled',
  );
  await writeSettledToolHistory(
    managed,
    'prior-complete',
    'completed',
    'end_turn',
  );
  const projected = await managed.sink.projectModelHistory();
  const savedIds = projected.apiHistory.map(
    (entry) => getApiHistoryPromptId(entry) ?? null,
  );
  const snapshotId = randomUUID();
  await managed.sink.write({
    uuid: snapshotId,
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    cwd: state.root,
    version: 'hosted-harness/1',
    type: 'system',
    subtype: 'chat_compression',
    systemPayload: {
      info: {
        compressionStatus: CompressionStatus.COMPRESSED,
        originalTokenCount: 100,
        newTokenCount: 50,
      },
      compressedHistory: projected.apiHistory,
      promptIds: savedIds,
      summaryPrefixLength: 0,
    },
  });
  return snapshotId;
}

/** Rebuilds the api history the real runner would hand the model from the
 * mocked runner's input (hosted-harness-model.ts initialMessages pipeline), so
 * a witness can inspect the actual request rather than the raw record list. */
function runnerApiHistory(input: {
  history?: ChatRecord[];
  excludedPromptIds?: ReadonlySet<string>;
}) {
  return filterHostedTurnHistory(
    buildSessionHistoryFromConversation({
      messages: normalizeHostedTurnRecords(
        input.history ?? [],
        input.excludedPromptIds,
      ),
    }).apiHistory,
    input.excludedPromptIds,
  );
}

async function setupHostedTextSession() {
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
}

function useHostedTextSession() {
  beforeEach(setupHostedTextSession);
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
}

export {
  BOOT_ID,
  PROMPT_ID,
  SESSION_ID,
  app,
  domainEnablement,
  enforceInlineResourceLimit,
  expectFullStreamedAnswer,
  headers,
  hookApp,
  hookPin,
  listeners,
  mcpApp,
  neverStartedReconcile,
  parkBlockedTextTurn,
  runnerApiHistory,
  settleTimeoutMs,
  state,
  store,
  wakeDeps,
  writeCancelledGroupWithLegacySnapshot,
  writeSettledToolHistory,
  setupHostedTextSession,
  useHostedTextSession,
};
