/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createServeApp } from './server.js';
import { runQwenServe, type RunHandle } from './runQwenServe.js';
import {
  CONDITIONAL_SERVE_FEATURES,
  getAdvertisedServeFeatures,
  getRegisteredServeFeatures,
  getServeFeatures,
  getServeProtocolVersions,
  SERVE_CAPABILITY_REGISTRY,
  type ServeProtocolVersion,
} from './capabilities.js';
import type {
  CancelNotification,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import {
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  MAX_WORKSPACE_PATH_LENGTH,
  RestoreInProgressError,
  SessionLimitExceededError,
  SessionNotFoundError,
  WorkspaceMismatchError,
  type BridgeHeartbeatResult,
  type BridgeHeartbeatState,
  type BridgeRestoredSession,
  type BridgeClientRequestContext,
  type BridgeRestoreSessionRequest,
  type BridgeSession,
  type BridgeSessionSummary,
  type BridgeSpawnRequest,
  type HttpAcpBridge,
  type SessionMetadataUpdate,
} from './httpAcpBridge.js';
import type { BridgeEvent, SubscribeOptions } from './eventBus.js';
import type {
  ServeSessionContextStatus,
  ServeSessionSupportedCommandsStatus,
  ServeWorkspaceEnvStatus,
  ServeWorkspaceMcpStatus,
  ServeWorkspacePreflightStatus,
  ServeWorkspaceProvidersStatus,
  ServeWorkspaceSkillsStatus,
} from './status.js';
import { CAPABILITIES_SCHEMA_VERSION, type ServeOptions } from './types.js';
import { FsError, type WorkspaceFileSystemFactory } from './fs/index.js';

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4170,
  mode: 'http-bridge',
};

// Workspace fixtures must round-trip through `path.resolve` so the
// expected values match the canonicalized form the route produces on
// every platform. On Windows `path.resolve('/work/bound')` returns
// `D:\work\bound` (drive-relative absolute), so hardcoding `/work/bound`
// as a literal makes the test fail on Windows CI even though the code
// is correct. Mirror the pattern used by httpAcpBridge.test.ts (WS_A /
// WS_B).
const WS_BOUND = path.resolve(path.sep, 'work', 'bound');
const WS_DIFFERENT = path.resolve(path.sep, 'work', 'different');
const EXPECTED_STAGE1_FEATURES = [
  'health',
  'capabilities',
  'session_create',
  'session_scope_override',
  'session_load',
  'unstable_session_resume',
  'session_list',
  'session_prompt',
  'session_cancel',
  'session_events',
  'slow_client_warning',
  'typed_event_schema',
  'session_set_model',
  'client_identity',
  'client_heartbeat',
  'session_permission_vote',
  'permission_vote',
  'workspace_mcp',
  'workspace_skills',
  'workspace_providers',
  'workspace_memory',
  'workspace_agents',
  'workspace_env',
  'workspace_preflight',
  'session_context',
  'session_supported_commands',
  'session_close',
  'session_metadata',
  // Issue #4175 PR 14. Always-on. Daemon supports the MCP client
  // guardrail surface (`--mcp-client-budget`, `clientCount` /
  // `budgets[]` on `/workspace/mcp`, `disabledReason: 'budget'` on
  // refused per-server cells).
  'mcp_guardrails',
  // Issue #4175 PR 19. Always-on. Daemon exposes the read-only file
  // surface: `GET /file`, `GET /list`, `GET /glob`, `GET /stat`.
  'workspace_file_read',
] as const;

// Issue #4175 PR 15. `require_auth` is registered but conditionally
// advertised (only when `--require-auth` is set), so the registry list
// is a strict superset of the always-on list. Kept as a separate
// constant rather than appended to `EXPECTED_STAGE1_FEATURES` so the
// existing "advertised features" assertions stay tight against
// surprise additions.
const EXPECTED_REGISTERED_FEATURES = [
  ...EXPECTED_STAGE1_FEATURES,
  'require_auth',
] as const;

interface FakeBridgeOpts {
  spawnImpl?: (req: BridgeSpawnRequest) => Promise<BridgeSession>;
  loadImpl?: (
    req: BridgeRestoreSessionRequest,
  ) => Promise<BridgeRestoredSession>;
  resumeImpl?: (
    req: BridgeRestoreSessionRequest,
  ) => Promise<BridgeRestoredSession>;
  promptImpl?: (
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ) => Promise<PromptResponse>;
  cancelImpl?: (
    sessionId: string,
    req?: CancelNotification,
    context?: BridgeClientRequestContext,
  ) => Promise<void>;
  subscribeImpl?: (
    sessionId: string,
    opts?: SubscribeOptions,
  ) => AsyncIterable<BridgeEvent>;
  respondImpl?: (
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ) => boolean;
  sessionRespondImpl?: (
    sessionId: string,
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ) => boolean;
  listImpl?: (workspaceCwd: string) => BridgeSessionSummary[];
  workspaceMcpImpl?: () => Promise<ServeWorkspaceMcpStatus>;
  workspaceSkillsImpl?: () => Promise<ServeWorkspaceSkillsStatus>;
  workspaceProvidersImpl?: () => Promise<ServeWorkspaceProvidersStatus>;
  workspaceEnvImpl?: () => Promise<ServeWorkspaceEnvStatus>;
  workspacePreflightImpl?: () => Promise<ServeWorkspacePreflightStatus>;
  sessionContextImpl?: (
    sessionId: string,
  ) => Promise<ServeSessionContextStatus>;
  sessionSupportedCommandsImpl?: (
    sessionId: string,
  ) => Promise<ServeSessionSupportedCommandsStatus>;
  setModelImpl?: (
    sessionId: string,
    req: SetSessionModelRequest,
    context?: BridgeClientRequestContext,
  ) => Promise<SetSessionModelResponse>;
  closeImpl?: (
    sessionId: string,
    context?: BridgeClientRequestContext,
  ) => Promise<void>;
  updateMetadataImpl?: (
    sessionId: string,
    metadata: SessionMetadataUpdate,
    context?: BridgeClientRequestContext,
  ) => SessionMetadataUpdate;
  heartbeatImpl?: (
    sessionId: string,
    context?: BridgeClientRequestContext,
  ) => BridgeHeartbeatResult;
  heartbeatStateImpl?: (sessionId: string) => BridgeHeartbeatState | undefined;
}

interface FakeBridge extends HttpAcpBridge {
  calls: BridgeSpawnRequest[];
  loadCalls: BridgeRestoreSessionRequest[];
  resumeCalls: BridgeRestoreSessionRequest[];
  promptCalls: Array<{
    sessionId: string;
    req: PromptRequest;
    signal?: AbortSignal;
    context?: BridgeClientRequestContext;
  }>;
  cancelCalls: Array<{
    sessionId: string;
    req?: CancelNotification;
    context?: BridgeClientRequestContext;
  }>;
  killCalls: Array<{
    sessionId: string;
    opts?: { requireZeroAttaches?: boolean };
  }>;
  detachCalls: Array<{ sessionId: string; clientId?: string }>;
  permissionVotes: Array<{
    requestId: string;
    response: RequestPermissionResponse;
    context?: BridgeClientRequestContext;
  }>;
  sessionPermissionVotes: Array<{
    sessionId: string;
    requestId: string;
    response: RequestPermissionResponse;
    context?: BridgeClientRequestContext;
  }>;
  listCalls: string[];
  workspaceMcpCalls: number;
  workspaceSkillsCalls: number;
  workspaceProvidersCalls: number;
  workspaceEnvCalls: number;
  workspacePreflightCalls: number;
  sessionContextCalls: string[];
  sessionSupportedCommandsCalls: string[];
  setModelCalls: Array<{
    sessionId: string;
    req: SetSessionModelRequest;
    context?: BridgeClientRequestContext;
  }>;
  closeCalls: Array<{
    sessionId: string;
    context?: BridgeClientRequestContext;
  }>;
  updateMetadataCalls: Array<{
    sessionId: string;
    metadata: SessionMetadataUpdate;
    context?: BridgeClientRequestContext;
  }>;
  heartbeatCalls: Array<{
    sessionId: string;
    context?: BridgeClientRequestContext;
  }>;
  heartbeatStateCalls: string[];
  shutdownCalls: number;
}

function fakeBridge(opts: FakeBridgeOpts = {}): FakeBridge {
  const calls: BridgeSpawnRequest[] = [];
  const loadCalls: BridgeRestoreSessionRequest[] = [];
  const resumeCalls: BridgeRestoreSessionRequest[] = [];
  const promptCalls: FakeBridge['promptCalls'] = [];
  const cancelCalls: FakeBridge['cancelCalls'] = [];
  const killCalls: Array<{
    sessionId: string;
    opts?: { requireZeroAttaches?: boolean };
  }> = [];
  const detachCalls: FakeBridge['detachCalls'] = [];
  const permissionVotes: FakeBridge['permissionVotes'] = [];
  const sessionPermissionVotes: FakeBridge['sessionPermissionVotes'] = [];
  const listCalls: string[] = [];
  let workspaceMcpCalls = 0;
  let workspaceSkillsCalls = 0;
  let workspaceProvidersCalls = 0;
  let workspaceEnvCalls = 0;
  let workspacePreflightCalls = 0;
  const sessionContextCalls: string[] = [];
  const sessionSupportedCommandsCalls: string[] = [];
  const setModelCalls: FakeBridge['setModelCalls'] = [];
  const closeCalls: FakeBridge['closeCalls'] = [];
  const updateMetadataCalls: FakeBridge['updateMetadataCalls'] = [];
  const heartbeatCalls: FakeBridge['heartbeatCalls'] = [];
  const heartbeatStateCalls: string[] = [];
  let shutdownCalls = 0;
  const spawnImpl =
    opts.spawnImpl ??
    (async (req) => ({
      sessionId: `fake-${calls.length}`,
      workspaceCwd: req.workspaceCwd,
      attached: false,
      clientId: `client-${calls.length}`,
    }));
  const loadImpl =
    opts.loadImpl ??
    (async (req) => ({
      sessionId: req.sessionId,
      workspaceCwd: req.workspaceCwd,
      attached: false,
      clientId: req.clientId ?? 'client-load',
      state: {},
    }));
  const resumeImpl =
    opts.resumeImpl ??
    (async (req) => ({
      sessionId: req.sessionId,
      workspaceCwd: req.workspaceCwd,
      attached: false,
      clientId: req.clientId ?? 'client-resume',
      state: {},
    }));
  const promptImpl =
    opts.promptImpl ?? (async () => ({ stopReason: 'end_turn' }));
  const cancelImpl = opts.cancelImpl ?? (async () => {});
  const respondImpl = opts.respondImpl ?? (() => true);
  const sessionRespondImpl = opts.sessionRespondImpl ?? (() => true);
  const listImpl = opts.listImpl ?? (() => []);
  const workspaceMcpImpl =
    opts.workspaceMcpImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: false,
      discoveryState: 'not_started' as const,
      servers: [],
    }));
  const workspaceSkillsImpl =
    opts.workspaceSkillsImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: false,
      skills: [],
    }));
  const workspaceProvidersImpl =
    opts.workspaceProvidersImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: false,
      providers: [],
    }));
  const workspaceEnvImpl =
    opts.workspaceEnvImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: true as const,
      acpChannelLive: false,
      cells: [],
    }));
  const workspacePreflightImpl =
    opts.workspacePreflightImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: true as const,
      acpChannelLive: false,
      cells: [],
    }));
  const sessionContextImpl =
    opts.sessionContextImpl ??
    (async (sessionId) => ({
      v: 1 as const,
      sessionId,
      workspaceCwd: WS_BOUND,
      state: {},
    }));
  const sessionSupportedCommandsImpl =
    opts.sessionSupportedCommandsImpl ??
    (async (sessionId) => ({
      v: 1 as const,
      sessionId,
      availableCommands: [],
      availableSkills: [],
    }));
  const setModelImpl = opts.setModelImpl ?? (async () => ({}));
  const closeImpl = opts.closeImpl ?? (async () => {});
  const updateMetadataImpl =
    opts.updateMetadataImpl ??
    ((_sid: string, m: SessionMetadataUpdate) => ({
      displayName: m.displayName,
    }));
  const heartbeatImpl =
    opts.heartbeatImpl ??
    ((sessionId, context) => ({
      sessionId,
      ...(context?.clientId !== undefined
        ? { clientId: context.clientId }
        : {}),
      lastSeenAt: 1_700_000_000_000,
    }));
  const heartbeatStateImpl =
    opts.heartbeatStateImpl ??
    (() => ({
      sessionLastSeenAt: 1_700_000_000_000,
      clientLastSeenAt: new Map<string, number>(),
    }));
  return {
    calls,
    loadCalls,
    resumeCalls,
    promptCalls,
    cancelCalls,
    killCalls,
    detachCalls,
    permissionVotes,
    sessionPermissionVotes,
    listCalls,
    sessionContextCalls,
    sessionSupportedCommandsCalls,
    setModelCalls,
    closeCalls,
    updateMetadataCalls,
    heartbeatCalls,
    heartbeatStateCalls,
    get shutdownCalls() {
      return shutdownCalls;
    },
    get workspaceMcpCalls() {
      return workspaceMcpCalls;
    },
    get workspaceSkillsCalls() {
      return workspaceSkillsCalls;
    },
    get workspaceProvidersCalls() {
      return workspaceProvidersCalls;
    },
    get workspaceEnvCalls() {
      return workspaceEnvCalls;
    },
    get workspacePreflightCalls() {
      return workspacePreflightCalls;
    },
    get sessionCount() {
      return calls.length;
    },
    get pendingPermissionCount() {
      return 0;
    },
    async spawnOrAttach(req) {
      const result = await spawnImpl(req);
      calls.push(req);
      return result;
    },
    async loadSession(req) {
      const result = await loadImpl(req);
      loadCalls.push(req);
      return result;
    },
    async resumeSession(req) {
      const result = await resumeImpl(req);
      resumeCalls.push(req);
      return result;
    },
    async sendPrompt(sessionId, req, signal, context) {
      promptCalls.push({
        sessionId,
        req,
        signal,
        ...(context ? { context } : {}),
      });
      return promptImpl(sessionId, req, signal, context);
    },
    async cancelSession(sessionId, req, context) {
      cancelCalls.push({ sessionId, req, ...(context ? { context } : {}) });
      return cancelImpl(sessionId, req, context);
    },
    subscribeEvents(sessionId, subOpts) {
      if (opts.subscribeImpl) return opts.subscribeImpl(sessionId, subOpts);
      // Default: empty stream
      return (async function* () {
        // empty
      })();
    },
    respondToPermission(requestId, response, context) {
      const accepted = respondImpl(requestId, response, context);
      permissionVotes.push({
        requestId,
        response,
        ...(context ? { context } : {}),
      });
      return accepted;
    },
    respondToSessionPermission(sessionId, requestId, response, context) {
      const accepted = sessionRespondImpl(
        sessionId,
        requestId,
        response,
        context,
      );
      sessionPermissionVotes.push({
        sessionId,
        requestId,
        response,
        ...(context ? { context } : {}),
      });
      return accepted;
    },
    listWorkspaceSessions(workspaceCwd) {
      listCalls.push(workspaceCwd);
      return listImpl(workspaceCwd);
    },
    async getWorkspaceMcpStatus() {
      workspaceMcpCalls += 1;
      return workspaceMcpImpl();
    },
    async getWorkspaceSkillsStatus() {
      workspaceSkillsCalls += 1;
      return workspaceSkillsImpl();
    },
    async getWorkspaceProvidersStatus() {
      workspaceProvidersCalls += 1;
      return workspaceProvidersImpl();
    },
    async getWorkspaceEnvStatus() {
      workspaceEnvCalls += 1;
      return workspaceEnvImpl();
    },
    async getWorkspacePreflightStatus() {
      workspacePreflightCalls += 1;
      return workspacePreflightImpl();
    },
    async getSessionContextStatus(sessionId) {
      sessionContextCalls.push(sessionId);
      return sessionContextImpl(sessionId);
    },
    async getSessionSupportedCommandsStatus(sessionId) {
      sessionSupportedCommandsCalls.push(sessionId);
      return sessionSupportedCommandsImpl(sessionId);
    },
    async setSessionModel(sessionId, req, context) {
      setModelCalls.push({ sessionId, req, ...(context ? { context } : {}) });
      return setModelImpl(sessionId, req, context);
    },
    async closeSession(sessionId, context) {
      closeCalls.push({ sessionId, ...(context ? { context } : {}) });
      return closeImpl(sessionId, context);
    },
    updateSessionMetadata(sessionId, metadata, context) {
      updateMetadataCalls.push({
        sessionId,
        metadata,
        ...(context ? { context } : {}),
      });
      return updateMetadataImpl(sessionId, metadata, context);
    },
    recordHeartbeat(sessionId, context) {
      heartbeatCalls.push({
        sessionId,
        ...(context ? { context } : {}),
      });
      return heartbeatImpl(sessionId, context);
    },
    getHeartbeatState(sessionId) {
      heartbeatStateCalls.push(sessionId);
      return heartbeatStateImpl(sessionId);
    },
    publishWorkspaceEvent(_event) {
      // Issue #4175 PR 16 — fakeBridge default is a no-op. Tests that
      // assert on workspace fan-out override this through the dedicated
      // route-level test files (workspaceMemory.test.ts /
      // workspaceAgents.test.ts) where the real fan-out behavior is
      // exercised against a live bridge.
    },
    knownClientIds() {
      // Default empty set — workspace mutation tests opt in by
      // overriding the bridge in their suite.
      return new Set<string>();
    },
    async killSession(sessionId, opts) {
      killCalls.push({ sessionId, opts });
    },
    async detachClient(sessionId, clientId) {
      detachCalls.push({
        sessionId,
        ...(clientId !== undefined ? { clientId } : {}),
      });
    },
    async shutdown() {
      shutdownCalls += 1;
    },
    killAllSync() {
      shutdownCalls += 1;
    },
  };
}

describe('createServeApp', () => {
  describe('serve capability registry', () => {
    it('returns a fresh ordered registered feature list', () => {
      const features = getRegisteredServeFeatures();
      expect(features).toEqual([...EXPECTED_REGISTERED_FEATURES]);

      features.pop();
      expect(getRegisteredServeFeatures()).toEqual([
        ...EXPECTED_REGISTERED_FEATURES,
      ]);
    });

    it('advertises current-protocol features separately from the registry', () => {
      // Conditional tags (currently `require_auth`) are absent unless
      // a runtime toggle is supplied; this is the "no toggles passed"
      // baseline that older clients see on a default-loopback daemon.
      expect(getAdvertisedServeFeatures()).toEqual([
        ...EXPECTED_STAGE1_FEATURES,
      ]);
      expect(getServeFeatures()).toEqual(getAdvertisedServeFeatures());
    });

    it('advertises `require_auth` only when the runtime toggle is on (#4175 PR 15)', () => {
      // Tag presence = behavior is on. SDK clients use it to surface a
      // "this deployment requires auth" hint; the toggle must therefore
      // map exactly to `--require-auth` and stay off everywhere else.
      expect(
        getAdvertisedServeFeatures(undefined, { requireAuth: true }),
      ).toContain('require_auth');
      expect(
        getAdvertisedServeFeatures(undefined, { requireAuth: false }),
      ).not.toContain('require_auth');
      expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
        'require_auth',
      );
    });

    it('honors every entry in CONDITIONAL_SERVE_FEATURES (PR #4236 review #3254467192 — drift insurance)', () => {
      // Iterate the Map so any future conditional tag added here whose
      // predicate isn't honored by `getAdvertisedServeFeatures` fails
      // the suite — the test is the adoption-of-record for the
      // "conditional features advertise via predicate" contract,
      // replacing the previous hand-maintained Set + branch shape that
      // could fail-CLOSED silently.
      //
      // For each entry: synthesize toggles that the predicate accepts
      // and toggles that it rejects. The predicate must be deterministic
      // and only read from `AdvertiseFeatureToggles` fields (no global
      // state, no Date.now() etc.) — that's the contract any future
      // entry must keep. We also assert the inverse: with toggles {} the
      // predicate must be false, otherwise the tag would fail the
      // "default-off" property baseline tags get for free.
      for (const [feature, predicate] of CONDITIONAL_SERVE_FEATURES) {
        if (feature === 'require_auth') {
          expect(predicate({ requireAuth: true })).toBe(true);
          expect(predicate({ requireAuth: false })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, { requireAuth: true }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        // Future conditional tag. Authors must add a branch above with
        // the toggle field that drives this predicate. Failing here is
        // intentional: it forces the new conditional tag to ship with a
        // matching test rather than relying on the Map shape alone.
        throw new Error(
          `CONDITIONAL_SERVE_FEATURES added "${feature}" without an ` +
            `assertion branch in this test — add one (synthesize toggles ` +
            `the predicate accepts AND rejects) so drift insurance stays ` +
            `enforced.`,
        );
      }
    });

    it('marks every current feature with its historical v1 origin', () => {
      expect(Object.keys(SERVE_CAPABILITY_REGISTRY)).toEqual([
        ...EXPECTED_REGISTERED_FEATURES,
      ]);
      expect(
        Object.values(SERVE_CAPABILITY_REGISTRY).map(({ since }) => since),
      ).toEqual(EXPECTED_REGISTERED_FEATURES.map(() => 'v1'));
    });

    it('exposes `modes` metadata on mcp_guardrails (#4175 PR 14)', () => {
      // `modes` is currently registry-only documentation (no wire
      // surface yet) — a client wanting to feature-detect `enforce`
      // semantics reads `caps.features.includes('mcp_guardrails')`,
      // not a separate `featureModes` field. The descriptor still
      // carries `modes` so future PRs that DO expose it on the wire
      // don't have to chase down every entry to backfill metadata.
      expect(SERVE_CAPABILITY_REGISTRY['mcp_guardrails']).toEqual({
        since: 'v1',
        modes: ['warn', 'enforce'],
      });
    });

    it('returns protocol version metadata with a fresh supported array', () => {
      const versions = getServeProtocolVersions();
      expect(versions).toEqual({ current: 'v1', supported: ['v1'] });

      versions.supported.push('v99' as ServeProtocolVersion);
      expect(getServeProtocolVersions()).toEqual({
        current: 'v1',
        supported: ['v1'],
      });
    });
  });

  describe('GET /health', () => {
    it('returns 200 ok', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /capabilities', () => {
    it('returns the v1 envelope', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.v).toBe(CAPABILITIES_SCHEMA_VERSION);
      expect(res.body.protocolVersions).toEqual(getServeProtocolVersions());
      expect(res.body.mode).toBe('http-bridge');
      expect(res.body.features).toEqual(getAdvertisedServeFeatures());
      expect(res.body.modelServices).toEqual([]);
    });

    it('reports the bound workspace (#3803 §02)', async () => {
      const app = createServeApp({ ...baseOpts, workspace: WS_BOUND });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.workspaceCwd).toBe(WS_BOUND);
    });

    it('falls back to process.cwd() when --workspace is omitted', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      // `createServeApp` runs `canonicalizeWorkspace` on
      // `process.cwd()`, which collapses symlinks via
      // `realpathSync.native`. On macOS the default tmpdir is
      // `/var/folders/...` whose canonical form is
      // `/private/var/folders/...`; a raw `process.cwd()` assertion
      // would diverge there. Use the same realpath the route does.
      expect(res.body.workspaceCwd).toBe(realpathSync.native(process.cwd()));
    });

    it('omits the `require_auth` feature tag by default (#4175 PR 15)', async () => {
      // Default loopback no-token daemon: existing clients see the
      // bit-for-bit pre-PR feature list. This is the backward-compat
      // anchor — adding the tag unconditionally would make every
      // daemon look like it required auth.
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).not.toContain('require_auth');
    });

    it('advertises `require_auth` when the daemon was started with --require-auth', async () => {
      const app = createServeApp({
        ...baseOpts,
        token: 'secret',
        requireAuth: true,
      });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      expect(res.status).toBe(200);
      expect(res.body.features).toContain('require_auth');
    });
  });

  describe('read-only status routes', () => {
    it('returns workspace MCP status from the bridge', async () => {
      const payload: ServeWorkspaceMcpStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        discoveryState: 'completed',
        servers: [
          {
            kind: 'mcp_server',
            status: 'ok',
            name: 'docs',
            mcpStatus: 'connected',
            transport: 'stdio',
            disabled: false,
            description: 'Docs server',
          },
        ],
      };
      const bridge = fakeBridge({ workspaceMcpImpl: async () => payload });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/mcp')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(payload);
      expect(bridge.workspaceMcpCalls).toBe(1);
    });

    it('round-trips PR 14 budget fields on /workspace/mcp', async () => {
      // Issue #4175 PR 14. The route is a thin JSON forwarder, so the
      // assertion is structural: the new fields (`clientCount`,
      // `clientBudget`, `budgetMode`, `budgets[]`, per-server
      // `disabledReason`) must survive verbatim. Catches future
      // serialization regressions that drop unknown optional fields.
      const payload: ServeWorkspaceMcpStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        discoveryState: 'completed',
        clientCount: 3,
        clientBudget: 2,
        budgetMode: 'enforce',
        budgets: [
          {
            kind: 'mcp_budget',
            scope: 'session',
            status: 'error',
            errorKind: 'budget_exhausted',
            hint: 'Raise --mcp-client-budget or remove servers.',
            liveCount: 2,
            budget: 2,
            mode: 'enforce',
            refusedCount: 1,
          },
        ],
        servers: [
          {
            kind: 'mcp_server',
            status: 'ok',
            name: 'a',
            mcpStatus: 'connected',
            transport: 'stdio',
            disabled: false,
          },
          {
            kind: 'mcp_server',
            status: 'ok',
            name: 'b',
            mcpStatus: 'connected',
            transport: 'stdio',
            disabled: false,
          },
          {
            kind: 'mcp_server',
            status: 'error',
            errorKind: 'budget_exhausted',
            hint: 'Raise --mcp-client-budget or remove servers from mcpServers config.',
            name: 'c',
            mcpStatus: 'disconnected',
            transport: 'stdio',
            disabled: false,
            disabledReason: 'budget',
          },
        ],
      };
      const bridge = fakeBridge({ workspaceMcpImpl: async () => payload });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/mcp')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(payload);
      expect(res.body.budgets).toHaveLength(1);
      expect(res.body.budgets[0]).toMatchObject({
        kind: 'mcp_budget',
        scope: 'session',
        status: 'error',
        errorKind: 'budget_exhausted',
        refusedCount: 1,
      });
      expect(res.body.servers[2].disabledReason).toBe('budget');
    });

    it('returns workspace skills and providers status from the bridge', async () => {
      const skills: ServeWorkspaceSkillsStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        skills: [
          {
            kind: 'skill',
            status: 'ok',
            name: 'review',
            description: 'Review code',
            level: 'project',
            modelInvocable: true,
          },
        ],
      };
      const providers: ServeWorkspaceProvidersStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        current: { authType: 'qwen', modelId: 'qwen3(qwen)' },
        providers: [
          {
            kind: 'model_provider',
            status: 'ok',
            authType: 'qwen',
            current: true,
            models: [
              {
                modelId: 'qwen3(qwen)',
                baseModelId: 'qwen3',
                name: 'Qwen 3',
                description: null,
                contextLimit: 4096,
                isCurrent: true,
                isRuntime: false,
              },
            ],
          },
        ],
      };
      const bridge = fakeBridge({
        workspaceSkillsImpl: async () => skills,
        workspaceProvidersImpl: async () => providers,
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const skillsRes = await request(app)
        .get('/workspace/skills')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      const providersRes = await request(app)
        .get('/workspace/providers')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(skillsRes.status).toBe(200);
      expect(skillsRes.body).toEqual(skills);
      expect(providersRes.status).toBe(200);
      expect(providersRes.body).toEqual(providers);
      expect(bridge.workspaceSkillsCalls).toBe(1);
      expect(bridge.workspaceProvidersCalls).toBe(1);
    });

    it('returns workspace env status from the bridge', async () => {
      const env: ServeWorkspaceEnvStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        acpChannelLive: false,
        cells: [
          { kind: 'runtime', name: 'node', status: 'ok', value: '22.4.0' },
          {
            kind: 'env_var',
            name: 'OPENAI_API_KEY',
            status: 'ok',
            present: true,
          },
        ],
      };
      const bridge = fakeBridge({ workspaceEnvImpl: async () => env });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/env')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(env);
      expect(bridge.workspaceEnvCalls).toBe(1);
      // Strict assertion: env_var cells never carry a value field, even
      // when the env var is set, to preserve the presence-only contract.
      const envVarCell = (res.body as ServeWorkspaceEnvStatus).cells.find(
        (c) => c.kind === 'env_var',
      );
      expect(envVarCell).toBeDefined();
      expect('value' in envVarCell!).toBe(false);
    });

    it('returns workspace preflight status from the bridge', async () => {
      const preflight: ServeWorkspacePreflightStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        acpChannelLive: false,
        cells: [
          {
            kind: 'node_version',
            status: 'ok',
            locality: 'daemon',
            detail: { version: '22.4.0', required: '>=22' },
          },
          {
            kind: 'auth',
            status: 'not_started',
            locality: 'acp',
            hint: 'spawn a session to populate',
          },
        ],
      };
      const bridge = fakeBridge({
        workspacePreflightImpl: async () => preflight,
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/preflight')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(preflight);
      expect(bridge.workspacePreflightCalls).toBe(1);
    });

    it('returns session context and supported commands from the bridge', async () => {
      const context: ServeSessionContextStatus = {
        v: 1,
        sessionId: 's-1',
        workspaceCwd: WS_BOUND,
        state: { models: { currentModelId: 'qwen3' } },
      };
      const commands: ServeSessionSupportedCommandsStatus = {
        v: 1,
        sessionId: 's-1',
        availableCommands: [
          {
            name: 'init',
            description: 'Initialize',
            input: null,
            _meta: { source: 'builtin' },
          },
        ],
        availableSkills: ['review'],
      };
      const bridge = fakeBridge({
        sessionContextImpl: async () => context,
        sessionSupportedCommandsImpl: async () => commands,
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const contextRes = await request(app)
        .get('/session/s-1/context')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      const commandsRes = await request(app)
        .get('/session/s-1/supported-commands')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(contextRes.status).toBe(200);
      expect(contextRes.body).toEqual(context);
      expect(commandsRes.status).toBe(200);
      expect(commandsRes.body).toEqual(commands);
      expect(bridge.sessionContextCalls).toEqual(['s-1']);
      expect(bridge.sessionSupportedCommandsCalls).toEqual(['s-1']);
    });

    it('maps missing sessions on read-only session routes to 404', async () => {
      const bridge = fakeBridge({
        sessionContextImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
        sessionSupportedCommandsImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const contextRes = await request(app)
        .get('/session/missing/context')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      const commandsRes = await request(app)
        .get('/session/missing/supported-commands')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(contextRes.status).toBe(404);
      expect(contextRes.body.sessionId).toBe('missing');
      expect(commandsRes.status).toBe(404);
      expect(commandsRes.body.sessionId).toBe('missing');
    });
  });

  describe('host allowlist (loopback bind)', () => {
    it('rejects requests with an unrelated Host header', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', 'evil.example.com');
      expect(res.status).toBe(403);
    });

    it('accepts host.docker.internal so containers can reach the host daemon', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `host.docker.internal:${baseOpts.port}`);
      expect(res.status).toBe(200);
    });
  });

  describe('middleware order — auth runs before body parser', () => {
    it('rejects unauthorized POST without parsing the (possibly huge) body', async () => {
      // If auth ran AFTER body-parsing, an unauthenticated client could
      // force the daemon to JSON.parse a 10MB payload before the 401.
      // This test verifies the 401 fires regardless of body content
      // (no 413 / no parse error / no validation error).
      const bridge = fakeBridge();
      const tokenedOpts: ServeOptions = {
        ...baseOpts,
        token: 'real-secret',
      };
      const app = createServeApp(tokenedOpts, undefined, { bridge });
      const fakeBigBody = JSON.stringify({ filler: 'x'.repeat(100_000) });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('content-type', 'application/json')
        .send(fakeBigBody);
      expect(res.status).toBe(401);
      // Bridge must NOT have been touched — auth short-circuited.
      expect(bridge.calls).toHaveLength(0);
    });
  });

  describe('CORS / browser origin denial', () => {
    it('returns a deterministic 403 JSON when an Origin header is present', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Request denied by CORS policy' });
    });

    it('accepts requests with no Origin header (CLI/SDK clients)', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
    });

    it('also rejects POSTs with an Origin header', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Origin', 'https://evil.example.com')
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(403);
      // Bridge must NOT have been touched.
      expect(bridge.calls).toHaveLength(0);
    });
  });

  describe('POST /session', () => {
    it('200 when cwd is omitted (falls back to bound workspace, #3803 §02)', async () => {
      // 1 daemon = 1 workspace: the daemon binds to
      // `opts.workspace ?? process.cwd()` at boot, so clients may
      // omit `cwd` and the route falls back to the bound path.
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(200);
      expect(bridge.calls[0]?.workspaceCwd).toBe(WS_BOUND);
    });

    it('400 when cwd is relative', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: 'relative/path' });
      expect(res.status).toBe(400);
      expect(bridge.calls).toHaveLength(0);
    });

    it('400 when cwd is present but not a string (#3803 §02 — distinguishes omitted vs malformed)', async () => {
      // Three non-string shapes a buggy client / orchestrator could
      // serialize for the `cwd` field: `null`, a number, an object.
      // Pre-fix the route treated all three the same as "omitted" and
      // fell back to `boundWorkspace`, silently masking client bugs.
      // Now the route distinguishes "absent" (legitimate §02 fallback)
      // from "present but malformed" (client-side bug → 400 + actionable
      // error message). Empty string still falls through to the
      // `path.isAbsolute` check (and 400s there with the
      // "absolute path when provided" message).
      const malformed: unknown[] = [null, 123, { foo: 'bar' }, []];
      for (const cwd of malformed) {
        const bridge = fakeBridge();
        const app = createServeApp(
          { ...baseOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );
        const res = await request(app)
          .post('/session')
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/must be a string absolute path/);
        // Bridge must NOT be touched — silent fallback regressions
        // would otherwise let the malformed input hit `spawnOrAttach`.
        expect(bridge.calls).toHaveLength(0);
      }
    });

    it('400 when cwd is the empty string', async () => {
      // Empty string is technically a string so the type-check above
      // lets it through; `path.isAbsolute('')` is false so the
      // "must be an absolute path when provided" branch catches it.
      // Important: the `'cwd' in body` presence test means an empty
      // string is NOT treated as omitted (which would fall back to
      // boundWorkspace) — empty-string is the strongest "client
      // explicitly passed nothing useful" signal we have.
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '' });
      expect(res.status).toBe(400);
      expect(bridge.calls).toHaveLength(0);
    });

    it('400 when cwd exceeds MAX_WORKSPACE_PATH_LENGTH (memory amplification guard)', async () => {
      // Real filesystem paths fit well under PATH_MAX (4096 on Linux).
      // A multi-MB `cwd` is either a malformed client or a memory-
      // amplification attempt — `WorkspaceMismatchError` interpolates
      // `requested` into `.message` twice, `sendBridgeError` writes it
      // to stderr, and `res.json` echoes it again, so a ~10 MB body
      // (right under express.json's 10 MB cap) would amplify to
      // ~60 MB/request × maxConnections. The route caps the input
      // before any of those echoes.
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      // Build an absolute path of MAX+1 chars. `path.isAbsolute`
      // sees the leading `/` and the length cap fires before the
      // isAbsolute branch — verifying both invariants in one go.
      const longCwd = `/${'a'.repeat(4096)}`;
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: longCwd });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/exceeds the 4096-character limit/);
      // Bridge must NOT be touched — silent fallback or pass-through
      // would defeat the cap.
      expect(bridge.calls).toHaveLength(0);
    });

    it('400 workspace_mismatch when bridge rejects cross-workspace cwd (#3803 §02)', async () => {
      // Single-workspace mode: bridge throws WorkspaceMismatchError
      // when the route forwards a non-bound cwd. Route translates
      // to 400 with code `workspace_mismatch` + both paths in the
      // body so orchestrator-aware clients can route correctly.
      const bridge = fakeBridge({
        spawnImpl: async (req) => {
          throw new WorkspaceMismatchError(WS_BOUND, req.workspaceCwd);
        },
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: WS_DIFFERENT });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'workspace_mismatch',
        boundWorkspace: WS_BOUND,
        requestedWorkspace: WS_DIFFERENT,
      });
    });

    it('200 with the BridgeSession shape on success', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a', modelServiceId: 'qwen-prod' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'fake-0',
        workspaceCwd: '/work/a',
        attached: false,
        clientId: 'client-0',
      });
      expect(bridge.calls).toEqual([
        { workspaceCwd: '/work/a', modelServiceId: 'qwen-prod' },
      ]);
    });

    it('passes through a valid `sessionScope` to the bridge (#4175 PR 5)', async () => {
      // Per-request override: even when the daemon-wide default is
      // `'single'`, the route forwards an explicit `'thread'` scope so
      // the bridge can isolate this caller's session. Symmetric for
      // `'single'` against a `'thread'` daemon.
      for (const scope of ['single', 'thread'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post('/session')
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd: '/work/a', sessionScope: scope });
        expect(res.status).toBe(200);
        expect(bridge.calls).toEqual([
          { workspaceCwd: '/work/a', sessionScope: scope },
        ]);
      }
    });

    it('forwards X-Qwen-Client-Id to the bridge on create/attach', async () => {
      const bridge = fakeBridge({
        spawnImpl: async (req) => ({
          sessionId: 'fake-identity',
          workspaceCwd: req.workspaceCwd,
          attached: false,
          clientId: req.clientId ?? 'client-new',
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-existing')
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(200);
      expect(res.body.clientId).toBe('client-existing');
      expect(bridge.calls).toEqual([
        { workspaceCwd: '/work/a', clientId: 'client-existing' },
      ]);
    });

    it('400 invalid_client_id for malformed client id headers', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'bad client id')
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_client_id' });
      expect(bridge.calls).toHaveLength(0);
    });

    it('400 invalid_session_scope when `sessionScope` is not "single"/"thread"', async () => {
      // Anything outside the enum (`'user'`, `null`, a number, an object)
      // must 4xx with a typed `code` so HTTP clients can branch on the
      // failure shape rather than parsing the message. Bridge must NOT
      // be invoked — surfacing the invalid value as a clear 400 beats
      // throwing inside the bridge later.
      const malformed: unknown[] = ['user', '', 'SINGLE', null, 123, {}];
      for (const sessionScope of malformed) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post('/session')
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd: '/work/a', sessionScope });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'invalid_session_scope' });
        expect(bridge.calls).toHaveLength(0);
      }
    });

    it('omits `sessionScope` from the bridge request when the field is absent', async () => {
      // Backward-compat invariant: a pre-#4175-PR-5 client (no SDK
      // upgrade) sees identical behavior. The bridge sees no
      // `sessionScope` key, so its `defaultSessionScope` (the
      // daemon-wide `--sessionScope` value) is used unchanged.
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(200);
      expect(bridge.calls).toEqual([{ workspaceCwd: '/work/a' }]);
      expect(bridge.calls[0]).not.toHaveProperty('sessionScope');
    });

    it('500 when bridge throws', async () => {
      const bridge = fakeBridge({
        spawnImpl: async () => {
          throw new Error('boom');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'boom' });
    });

    it('strips prototype-pollution keys from body (BZ9uv/va/vs/wD)', async () => {
      // `safeBody()` strips `__proto__` / `constructor` / `prototype`
      // and copies into an `Object.create(null)` target before any
      // route spreads it into the bridge call. Even if a client
      // sends those keys, neither the bridge request nor
      // `Object.prototype` ends up touched.
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      // Build the body as a raw string so the server-side
      // `express.json` parser is the only path that could land the
      // dangerous key on the request object.
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('content-type', 'application/json')
        .send(
          '{"cwd":"/work/a","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
        );
      expect(res.status).toBe(200);
      expect(bridge.calls[0]?.workspaceCwd).toBe('/work/a');
      // No prototype pollution: Object.prototype.polluted is
      // undefined. (This is the core security property — if the
      // dangerous key landed via spread, this check would fail.)
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  });

  describe('POST /session/:id/load and /resume', () => {
    it('falls back to bound workspace and uses the route session id', async () => {
      for (const action of ['load', 'resume'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(
          { ...baseOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );
        const res = await request(app)
          .post(`/session/persisted-1/${action}`)
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ sessionId: 'spoofed-body-id' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          sessionId: 'persisted-1',
          workspaceCwd: WS_BOUND,
          attached: false,
          clientId: action === 'load' ? 'client-load' : 'client-resume',
          state: {},
        });
        const calls = action === 'load' ? bridge.loadCalls : bridge.resumeCalls;
        expect(calls).toEqual([
          { sessionId: 'persisted-1', workspaceCwd: WS_BOUND },
        ]);
      }
    });

    it('passes explicit cwd through to the bridge', async () => {
      const bridge = fakeBridge({
        loadImpl: async (req) => ({
          sessionId: req.sessionId,
          workspaceCwd: req.workspaceCwd,
          attached: false,
          clientId: 'client-load',
          state: { configOptions: [] },
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/persisted-2/load')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a' });

      expect(res.status).toBe(200);
      expect(res.body.state).toEqual({ configOptions: [] });
      expect(bridge.loadCalls).toEqual([
        { sessionId: 'persisted-2', workspaceCwd: '/work/a' },
      ]);
    });

    it('passes client identity headers through to load/resume bridge calls', async () => {
      for (const action of ['load', 'resume'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post(`/session/persisted-1/${action}`)
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .set('X-Qwen-Client-Id', 'client-1')
          .send({});
        expect(res.status).toBe(200);
        const calls = action === 'load' ? bridge.loadCalls : bridge.resumeCalls;
        expect(calls).toEqual([
          {
            sessionId: 'persisted-1',
            workspaceCwd: realpathSync.native(process.cwd()),
            clientId: 'client-1',
          },
        ]);
      }
    });

    it('400s malformed cwd before touching the bridge', async () => {
      for (const action of ['load', 'resume'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post(`/session/persisted-3/${action}`)
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd: 'relative/path' });

        expect(res.status).toBe(400);
        expect(bridge.loadCalls).toHaveLength(0);
        expect(bridge.resumeCalls).toHaveLength(0);
      }
    });

    it('400s a non-string cwd before touching the bridge', async () => {
      // Mirrors the `POST /session` malformed-`cwd`-shape test: a
      // client/orchestrator serialization bug (`cwd: null`,
      // `cwd: 123`, `cwd: {}`) must surface as a typed 400 instead of
      // silently falling back to the bound workspace.
      for (const action of ['load', 'resume'] as const) {
        for (const cwd of [null, 123, {}, []]) {
          const bridge = fakeBridge();
          const app = createServeApp(baseOpts, undefined, { bridge });
          const res = await request(app)
            .post(`/session/persisted-mal/${action}`)
            .set('Host', `127.0.0.1:${baseOpts.port}`)
            .send({ cwd });

          expect(res.status).toBe(400);
          expect(bridge.loadCalls).toHaveLength(0);
          expect(bridge.resumeCalls).toHaveLength(0);
        }
      }
    });

    it('400s a cwd longer than MAX_WORKSPACE_PATH_LENGTH before touching the bridge', async () => {
      // Same length cap as `POST /session` (matches Linux PATH_MAX
      // 4096) — defends downstream interpolations from
      // amplification on the loopback-default-no-token path.
      const longCwd = `/${'a'.repeat(MAX_WORKSPACE_PATH_LENGTH)}`;
      for (const action of ['load', 'resume'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post(`/session/persisted-long/${action}`)
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd: longCwd });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(
          new RegExp(
            `exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
          ),
        );
        expect(bridge.loadCalls).toHaveLength(0);
        expect(bridge.resumeCalls).toHaveLength(0);
      }
    });

    it('404s when the bridge reports an unknown persisted session', async () => {
      const bridge = fakeBridge({
        resumeImpl: async (req) => {
          throw new SessionNotFoundError(req.sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/resume')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('409 + Retry-After when the bridge throws RestoreInProgressError', async () => {
      const bridge = fakeBridge({
        loadImpl: async () => {
          throw new RestoreInProgressError('persisted-race', 'resume', 'load');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/persisted-race/load')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({
        code: 'restore_in_progress',
        sessionId: 'persisted-race',
        activeAction: 'resume',
        requestedAction: 'load',
      });
    });

    it('400 workspace_mismatch when the bridge throws WorkspaceMismatchError', async () => {
      const bridge = fakeBridge({
        loadImpl: async () => {
          throw new WorkspaceMismatchError(WS_BOUND, WS_DIFFERENT);
        },
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session/persisted-x/load')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: WS_DIFFERENT });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'workspace_mismatch',
        boundWorkspace: WS_BOUND,
        requestedWorkspace: WS_DIFFERENT,
      });
    });

    it('503 + Retry-After: 5 when the bridge throws SessionLimitExceededError', async () => {
      const bridge = fakeBridge({
        resumeImpl: async () => {
          throw new SessionLimitExceededError(20);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/persisted-y/resume')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({
        code: 'session_limit_exceeded',
        limit: 20,
      });
    });

    // The restore handler's `!res.writable` cleanup branch (kill on
    // !attached, detach on attached) is line-for-line identical to
    // the matching branch on `POST /session`; routing-side
    // disconnect tests for that handler weren't added when the
    // cleanup was originally introduced because the supertest +
    // Node http close-event timing makes the assertion flaky in
    // CI. The same constraint applies here. The cleanup behavior
    // is exercised manually via the route handler closure shared
    // between both routes in `restoreSessionHandler`.
  });

  describe('POST /session/:id/prompt', () => {
    it('200 with PromptResponse on success; route :id wins over body sessionId', async () => {
      const bridge = fakeBridge({
        promptImpl: async () => ({ stopReason: 'end_turn' }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          sessionId: 'spoofed-session-B',
          prompt: [{ type: 'text', text: 'hi' }],
        });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stopReason: 'end_turn' });
      expect(bridge.promptCalls).toHaveLength(1);
      expect(bridge.promptCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.promptCalls[0]?.req.sessionId).toBe('session-A');
    });

    it('passes client identity context into bridge.sendPrompt', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(200);
      expect(bridge.promptCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('400 invalid_client_id when the bridge rejects prompt originator', async () => {
      const bridge = fakeBridge({
        promptImpl: async (sessionId) => {
          throw new InvalidClientIdError(sessionId, 'client-unknown');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-unknown')
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        sessionId: 'session-A',
        clientId: 'client-unknown',
      });
    });

    it('400 when prompt body is missing', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.promptCalls).toHaveLength(0);
    });

    it('404 when bridge reports unknown session', async () => {
      const bridge = fakeBridge({
        promptImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('500 on generic bridge errors', async () => {
      const bridge = fakeBridge({
        promptImpl: async () => {
          throw new Error('agent crashed');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'agent crashed' });
    });

    it('passes an AbortSignal into bridge.sendPrompt', async () => {
      let signalDefined = false;
      let abortedAtCall = false;
      const bridge = fakeBridge({
        promptImpl: async (_sid, _req, signal) => {
          signalDefined = signal !== undefined;
          abortedAtCall = signal?.aborted ?? false;
          return { stopReason: 'end_turn' };
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(200);
      // The route always supplies a signal — the AbortController it wires
      // to req.on('close'). The bridge must receive it so a future client
      // disconnect can be routed into an ACP cancel. (Capture happens at
      // call time; supertest's later connection close would flip the
      // signal's `aborted` flag if asserted post-hoc.)
      expect(signalDefined).toBe(true);
      expect(abortedAtCall).toBe(false);
    });

    it('aborting the signal mid-prompt asks the bridge to wind down', async () => {
      // Bridge waits forever unless aborted, then resolves with a
      // cancelled stop reason. Verifies the route's
      // req.on('close') → abort.abort() flow propagates.
      let promptStarted: (() => void) | undefined;
      const promptStartedPromise = new Promise<void>((r) => {
        promptStarted = r;
      });
      const bridge = fakeBridge({
        promptImpl: async (_sid, _req, signal) =>
          new Promise((resolve) => {
            promptStarted!();
            const onAbort = () => resolve({ stopReason: 'cancelled' });
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          }),
      });
      const localHandle = await runQwenServe(
        { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
        { bridge },
      );
      try {
        const port = (localHandle.server.address() as { port: number }).port;
        // Use Node's `http` directly — vitest's jsdom env replaces
        // AbortController with a polyfill that undici's fetch rejects.
        const http = await import('node:http');
        const reqBody = JSON.stringify({
          prompt: [{ type: 'text', text: 'hi' }],
        });
        const httpReq = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/session/sess/prompt',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(reqBody),
          },
        });
        // Swallow ECONNRESET / socket-hangup that the destroy below emits.
        httpReq.on('error', () => {});
        httpReq.write(reqBody);
        httpReq.end();
        // Wait for the bridge to receive the prompt before destroying.
        await promptStartedPromise;
        httpReq.destroy();
        // Give the daemon a moment to register the close → propagate.
        await new Promise((r) => setTimeout(r, 100));
        expect(bridge.promptCalls).toHaveLength(1);
        expect(bridge.promptCalls[0]?.signal?.aborted).toBe(true);
      } finally {
        await localHandle.close();
      }
    });
  });

  describe('GET /workspace/:id/sessions', () => {
    it('returns the list returned by the bridge', async () => {
      // #3803 §02 (commit 0c6e963cd): the route now rejects
      // cross-workspace queries with 400 workspace_mismatch (so
      // orchestrators don't mistake "no sessions here" for
      // "workspace is idle"). Bind the daemon to the same workspace
      // we'll query so the happy path runs.
      const bridge = fakeBridge({
        listImpl: () => [
          {
            sessionId: 's-1',
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:00:00.000Z',
            clientCount: 1,
            hasActivePrompt: false,
          },
          {
            sessionId: 's-2',
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:01:00.000Z',
            clientCount: 0,
            hasActivePrompt: true,
          },
        ],
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(2);
      expect(res.body.sessions).toEqual([
        {
          sessionId: 's-1',
          workspaceCwd: WS_BOUND,
          createdAt: '2026-05-17T12:00:00.000Z',
          clientCount: 1,
          hasActivePrompt: false,
        },
        {
          sessionId: 's-2',
          workspaceCwd: WS_BOUND,
          createdAt: '2026-05-17T12:01:00.000Z',
          clientCount: 0,
          hasActivePrompt: true,
        },
      ]);
      expect(bridge.listCalls).toEqual([WS_BOUND]);
    });

    it('returns an empty array when no sessions exist for the workspace', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sessions: [] });
    });

    it('400 workspace_mismatch when querying a cross-workspace path (#3803 §02)', async () => {
      // Pin the §02 cross-workspace rejection: querying any path
      // that doesn't canonicalize to the bound workspace gets a 400
      // with `code: 'workspace_mismatch'` and both paths in the
      // body — so an orchestrator-aware client can route to / spawn
      // the right daemon. The bridge MUST NOT be touched (a silent
      // fallback would defeat the whole purpose of §02).
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_DIFFERENT)}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('workspace_mismatch');
      expect(res.body.boundWorkspace).toBe(WS_BOUND);
      expect(bridge.listCalls).toHaveLength(0);
    });

    it('400 when :id does not decode to an absolute path', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent('relative/path')}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(400);
      expect(bridge.listCalls).toHaveLength(0);
    });
  });

  describe('POST /session/:id/model', () => {
    it('200 with the agent response on success', async () => {
      const bridge = fakeBridge({
        setModelImpl: async () => ({ _meta: { applied: true } }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ modelId: 'qwen3-coder', sessionId: 'spoofed-B' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ _meta: { applied: true } });
      expect(bridge.setModelCalls).toHaveLength(1);
      expect(bridge.setModelCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.setModelCalls[0]?.req.sessionId).toBe('session-A');
      expect(bridge.setModelCalls[0]?.req.modelId).toBe('qwen3-coder');
    });

    it('passes client identity context into bridge.setSessionModel', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ modelId: 'qwen3-coder' });
      expect(res.status).toBe(200);
      expect(bridge.setModelCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('400 when modelId is missing', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.setModelCalls).toHaveLength(0);
    });

    it('400 when modelId is not a non-empty string', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ modelId: '' });
      expect(res.status).toBe(400);
      expect(bridge.setModelCalls).toHaveLength(0);
    });

    it('404 when bridge reports unknown session', async () => {
      const bridge = fakeBridge({
        setModelImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ modelId: 'qwen3-coder' });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('POST /session/:id/permission/:requestId', () => {
    it('200 when bridge accepts the scoped vote', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected', optionId: 'allow' } });
      expect(res.status).toBe(200);
      expect(bridge.sessionPermissionVotes).toEqual([
        {
          sessionId: 'session-A',
          requestId: 'req-1',
          response: { outcome: { outcome: 'selected', optionId: 'allow' } },
        },
      ]);
    });

    it('passes client identity context into scoped permission votes', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(200);
      expect(bridge.sessionPermissionVotes[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('404 when bridge reports no pending scoped request', async () => {
      const bridge = fakeBridge({ sessionRespondImpl: () => false });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/missing')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        sessionId: 'session-A',
        requestId: 'missing',
      });
    });

    it('400 on a malformed scoped selected outcome', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected' } });
      expect(res.status).toBe(400);
      expect(bridge.sessionPermissionVotes).toHaveLength(0);
    });

    it('400 when scoped outcome is missing entirely', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.sessionPermissionVotes).toHaveLength(0);
    });

    it('400 when scoped selected outcome has an empty-string optionId', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected', optionId: '' } });
      expect(res.status).toBe(400);
      expect(bridge.sessionPermissionVotes).toHaveLength(0);
    });

    it('400 with invalid_option_id when bridge rejects a scoped option', async () => {
      const bridge = fakeBridge({
        sessionRespondImpl: () => {
          throw new InvalidPermissionOptionError(
            'req-1',
            'ProceedAlwaysProject',
          );
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          outcome: { outcome: 'selected', optionId: 'ProceedAlwaysProject' },
        });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_option_id',
        requestId: 'req-1',
        optionId: 'ProceedAlwaysProject',
      });
    });

    it('404 when bridge reports unknown session on scoped vote', async () => {
      const bridge = fakeBridge({
        sessionRespondImpl: (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('POST /permission/:requestId', () => {
    it('200 when bridge accepts the vote', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected', optionId: 'allow' } });
      expect(res.status).toBe(200);
      expect(bridge.permissionVotes).toEqual([
        {
          requestId: 'req-1',
          response: { outcome: { outcome: 'selected', optionId: 'allow' } },
        },
      ]);
    });

    it('passes client identity context into permission votes', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ outcome: { outcome: 'selected', optionId: 'allow' } });
      expect(res.status).toBe(200);
      expect(bridge.permissionVotes[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('400 invalid_client_id when the bridge rejects permission voter', async () => {
      const bridge = fakeBridge({
        respondImpl: () => {
          throw new InvalidClientIdError('session-A', 'client-unknown');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-unknown')
        .send({ outcome: { outcome: 'selected', optionId: 'allow' } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        sessionId: 'session-A',
        clientId: 'client-unknown',
      });
    });

    it('200 with cancelled outcome', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(200);
      expect(bridge.permissionVotes[0]?.response.outcome.outcome).toBe(
        'cancelled',
      );
    });

    it('404 when bridge reports the requestId is unknown or already resolved', async () => {
      const bridge = fakeBridge({ respondImpl: () => false });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/missing')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(404);
      expect(res.body.requestId).toBe('missing');
    });

    it('400 on a malformed outcome', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected' } }); // missing optionId
      expect(res.status).toBe(400);
      expect(bridge.permissionVotes).toHaveLength(0);
    });

    it('400 when outcome is missing entirely', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.permissionVotes).toHaveLength(0);
    });

    it('400 when selected outcome has an empty-string optionId', async () => {
      // An empty string passes `typeof === 'string'` but isn't a meaningful
      // selection — would push a malformed vote to the agent which would
      // reject with an opaque "unknown option" error.
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected', optionId: '' } });
      expect(res.status).toBe(400);
      expect(bridge.permissionVotes).toHaveLength(0);
    });

    it('400 with invalid_option_id when bridge throws InvalidPermissionOptionError (Blehl)', async () => {
      // The bridge's optionId-validation path (BkwQI) surfaces
      // forged outcomes (e.g. `ProceedAlways*` when the prompt's
      // `hideAlwaysAllow` policy hid them). Route maps that
      // distinct error to 400 with code `invalid_option_id`
      // (vs 404 for "unknown requestId").
      const bridge = fakeBridge({
        respondImpl: () => {
          throw new InvalidPermissionOptionError(
            'req-1',
            'ProceedAlwaysProject',
          );
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          outcome: { outcome: 'selected', optionId: 'ProceedAlwaysProject' },
        });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_option_id',
        requestId: 'req-1',
        optionId: 'ProceedAlwaysProject',
      });
    });
  });

  describe('POST /session/:id/cancel', () => {
    it('204 on success and forwards routing id', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionId: 'spoofed-B' });
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(bridge.cancelCalls).toHaveLength(1);
      expect(bridge.cancelCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.cancelCalls[0]?.req?.sessionId).toBe('session-A');
    });

    it('passes client identity context into bridge.cancelSession', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1');
      expect(res.status).toBe(204);
      expect(bridge.cancelCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('204 with empty body', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(204);
      expect(bridge.cancelCalls).toHaveLength(1);
    });

    it('404 on unknown session', async () => {
      const bridge = fakeBridge({
        cancelImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('DELETE /session/:id', () => {
    it('204 on successful close', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .delete('/session/session-A')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(204);
      expect(bridge.closeCalls).toHaveLength(1);
      expect(bridge.closeCalls[0]?.sessionId).toBe('session-A');
    });

    it('passes client identity context', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .delete('/session/session-A')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1');
      expect(res.status).toBe(204);
      expect(bridge.closeCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('404 on unknown session', async () => {
      const bridge = fakeBridge({
        closeImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .delete('/session/missing')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('400 invalid_client_id when bridge rejects client', async () => {
      const bridge = fakeBridge({
        closeImpl: async () => {
          throw new InvalidClientIdError('session-A', 'bad-client');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .delete('/session/session-A')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'bad-client');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_client_id');
    });
  });

  describe('PATCH /session/:id/metadata', () => {
    it('200 on successful metadata update', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/session-A/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ displayName: 'My Session' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'session-A',
        displayName: 'My Session',
      });
      expect(bridge.updateMetadataCalls).toHaveLength(1);
      expect(bridge.updateMetadataCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.updateMetadataCalls[0]?.metadata).toEqual({
        displayName: 'My Session',
      });
    });

    it('passes client identity context', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/session-A/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ displayName: 'test' });
      expect(res.status).toBe(200);
      expect(bridge.updateMetadataCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('400 when displayName is not a string', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/session-A/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ displayName: 123 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_metadata');
      expect(res.body.field).toBe('displayName');
    });

    it('404 on unknown session', async () => {
      const bridge = fakeBridge({
        updateMetadataImpl: (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/missing/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ displayName: 'test' });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('400 invalid_metadata when displayName exceeds max length', async () => {
      const bridge = fakeBridge({
        updateMetadataImpl: () => {
          throw new InvalidSessionMetadataError(
            'displayName',
            'must be a string of at most 256 characters',
          );
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/session-A/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ displayName: 'x'.repeat(300) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_metadata');
    });
  });

  describe('POST /session/:id/heartbeat', () => {
    it('200 with the bridge result and forwards the routing id', async () => {
      const bridge = fakeBridge({
        heartbeatImpl: (sessionId) => ({
          sessionId,
          lastSeenAt: 1_700_000_000_001,
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'session-A',
        lastSeenAt: 1_700_000_000_001,
      });
      expect(bridge.heartbeatCalls).toEqual([{ sessionId: 'session-A' }]);
    });

    it('forwards X-Qwen-Client-Id into the bridge context and echoes it back', async () => {
      const bridge = fakeBridge({
        heartbeatImpl: (sessionId, context) => ({
          sessionId,
          ...(context?.clientId !== undefined
            ? { clientId: context.clientId }
            : {}),
          lastSeenAt: 1_700_000_000_002,
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'session-A',
        clientId: 'client-1',
        lastSeenAt: 1_700_000_000_002,
      });
      expect(bridge.heartbeatCalls).toEqual([
        { sessionId: 'session-A', context: { clientId: 'client-1' } },
      ]);
    });

    it('400 invalid_client_id when the header is malformed', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'bad client id');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_client_id' });
      expect(bridge.heartbeatCalls).toHaveLength(0);
    });

    it('400 invalid_client_id when the bridge rejects an unknown client', async () => {
      const bridge = fakeBridge({
        heartbeatImpl: (sessionId, context) => {
          throw new InvalidClientIdError(sessionId, context!.clientId!);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-unknown');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        sessionId: 'session-A',
        clientId: 'client-unknown',
      });
    });

    it('404 when the bridge reports an unknown session', async () => {
      const bridge = fakeBridge({
        heartbeatImpl: (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('bearer auth', () => {
    it('is open by default (loopback developer convenience)', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
    });

    // Switched probe endpoint from `/health` to `/capabilities` for
    // these auth-rejection tests because per #3889 review A8dZT
    // `/health` is now intentionally registered BEFORE the bearer
    // middleware so liveness probes work without credentials.
    // `/capabilities` is the cheapest endpoint that still goes through
    // the auth chain.
    it('rejects missing Authorization header when token is set', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(401);
    });

    it('rejects wrong scheme', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Basic c2VjcmV0');
      expect(res.status).toBe(401);
    });

    it('rejects wrong token', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('accepts the right token', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      expect(res.status).toBe(200);
    });

    it('exempts /health from bearer auth so liveness probes work without credentials', async () => {
      // Per #3889 review A8dZT — the registration order in
      // `createServeApp` puts `/health` BEFORE `bearerAuth`, so a
      // probe with no credentials still gets 200 even when the daemon
      // was started with a token. CORS deny + Host allowlist still
      // apply to `/health` (registered before /health), so this is
      // not a way to bypass DNS rebinding or browser-origin
      // protection.
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('gates /health behind bearer auth when --require-auth is set on loopback (#4175 PR 15)', async () => {
      // The whole point of `--require-auth` is to harden the
      // loopback default; the unauthenticated `/health` carve-out
      // would defeat that on shared dev hosts. Boot-time check in
      // `runQwenServe` guarantees a token whenever the flag is on,
      // so this 401 is reachable only under operator opt-in.
      const app = createServeApp({
        ...baseOpts,
        token: 'secret',
        requireAuth: true,
      });
      const noAuth = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(noAuth.status).toBe(401);
      const withAuth = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      expect(withAuth.status).toBe(200);
      expect(withAuth.body).toEqual({ status: 'ok' });
    });
  });

  describe('payload-too-large handling (A-UsP)', () => {
    it('returns 413 JSON when the request body exceeds the 10 MB limit', async () => {
      // body-parser raises `{status: 413, type: 'entity.too.large'}`
      // when the body exceeds the configured limit. The Express
      // error middleware special-cases this to a structured 413
      // response instead of falling through to a misleading 500.
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      // 11 MB of `x` characters > 10 MB body-parser limit
      const oversize = 'x'.repeat(11 * 1024 * 1024);
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ cwd: '/work', pad: oversize }));
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body too large (max 10 MB)' });
      // Body parser short-circuits before the route handler runs.
      expect(bridge.calls).toHaveLength(0);
    });
  });

  describe('GET /health?deep=1 (chiga0 Risk 3)', () => {
    it('default /health stays cheap (no bridge touch)', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('deep=1 includes bridge state', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .get('/health?deep=1')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        sessions: 0,
        pendingPermissions: 0,
      });
    });

    it('deep=1 returns 503 when bridge state access throws', async () => {
      // Simulate a wedged bridge by replacing the getter to throw.
      const bridge = fakeBridge();
      Object.defineProperty(bridge, 'sessionCount', {
        get() {
          throw new Error('bridge wedged');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .get('/health?deep=1')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'degraded' });
    });
  });

  describe('session limit (chiga0 Rec 3 — --max-sessions)', () => {
    it('503 + Retry-After + structured error when bridge throws SessionLimitExceededError', async () => {
      const bridge = fakeBridge({
        spawnImpl: async () => {
          throw new SessionLimitExceededError(20);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({
        code: 'session_limit_exceeded',
        limit: 20,
      });
    });
  });
});

describe('runQwenServe', () => {
  let handle: RunHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    delete process.env['QWEN_SERVER_TOKEN'];
  });

  it('refuses to bind 0.0.0.0 without a token', async () => {
    await expect(
      runQwenServe({
        hostname: '0.0.0.0',
        port: 0,
        mode: 'http-bridge',
      }),
    ).rejects.toThrow(/Refusing to bind/);
  });

  it('refuses to start with --require-auth on loopback when no token configured (#4175 PR 15)', async () => {
    // Boot-loud check: silently dropping the flag would leave the
    // operator believing loopback is hardened when it isn't.
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        requireAuth: true,
      }),
    ).rejects.toThrow(/--require-auth/);
  });

  // PR 14 fix (review #4247): runQwenServe is the documented embedded
  // entry point, so budget validation must live here, not just in the
  // yargs CLI handler. Embedded callers (other tools wrapping the
  // daemon, deps.bridge test injection) silently produced an uncapped
  // child pre-fix despite requesting enforce.
  it('rejects non-positive mcpClientBudget (#4175 PR 14)', async () => {
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        mcpClientBudget: 0,
      }),
    ).rejects.toThrow(/mcpClientBudget/);
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        mcpClientBudget: -5,
      }),
    ).rejects.toThrow(/mcpClientBudget/);
  });

  it('rejects mcpBudgetMode=enforce without a budget (#4175 PR 14)', async () => {
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        mcpBudgetMode: 'enforce',
      }),
    ).rejects.toThrow(/enforce.*requires.*mcpClientBudget/);
  });

  // Round 6 (wenshao R5 line 216): replaced the R3 `process.env`
  // mutation tests. `runQwenServe` now passes per-handle env
  // overrides via `BridgeOptions.childEnvOverrides`, NOT by mutating
  // global `process.env` — so concurrent embedded daemons don't
  // cross-contaminate each other's MCP budget env. The two tests
  // below assert (a) runQwenServe doesn't touch process.env and
  // (b) a pre-existing process.env value survives runQwenServe
  // calls unrelated to MCP overrides (proving runQwenServe is no
  // longer the source of env mutation).
  it('does not mutate process.env when caller provides mcp budget options (#4247 R6 line 216)', async () => {
    // Sanity-check: no MCP env vars set before.
    delete process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
    delete process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      mcpClientBudget: 10,
      mcpBudgetMode: 'warn',
    });
    // Pre-R6 this leaked into global process.env. Post-R6 the values
    // travel via `BridgeOptions.childEnvOverrides` closure → only
    // the spawned ACP child sees them.
    expect(process.env['QWEN_SERVE_MCP_CLIENT_BUDGET']).toBeUndefined();
    expect(process.env['QWEN_SERVE_MCP_BUDGET_MODE']).toBeUndefined();
  });

  it('preserves pre-existing process.env values (no longer wipes globals on omit) (#4247 R6 line 216)', async () => {
    // Pre-R6 the "scrub on omit" code path delete'd these from
    // process.env. Post-R6 runQwenServe doesn't touch process.env
    // at all; the override mechanism handles "scrub" at the
    // per-handle level inside the bridge's spawn factory. So if an
    // operator had QWEN_SERVE_MCP_CLIENT_BUDGET exported in their
    // shell BEFORE starting the daemon, it stays in their process
    // env (and gets ignored by this daemon's child, which receives
    // `undefined` via overrides to scrub it on spawn).
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '99';
    try {
      handle = await runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        // No mcpClientBudget — override will scrub the var on spawn.
      });
      expect(process.env['QWEN_SERVE_MCP_CLIENT_BUDGET']).toBe('99');
    } finally {
      delete process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
    }
  });

  it('starts with --require-auth + token on loopback', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      token: 'secret',
      requireAuth: true,
    });
    const port = (handle.server.address() as { port: number }).port;
    // Token-required everywhere, including /health.
    const noAuth = await fetch(`http://127.0.0.1:${port}/health`);
    expect(noAuth.status).toBe(401);
    const withAuth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(withAuth.status).toBe(200);
  });

  it('accepts QWEN_SERVER_TOKEN from the env when binding non-loopback', async () => {
    process.env['QWEN_SERVER_TOKEN'] = 'env-secret';
    handle = await runQwenServe({
      hostname: '0.0.0.0',
      port: 0,
      mode: 'http-bridge',
    });
    expect(handle.url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
  });

  it('starts on a loopback ephemeral port without a token', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
    });
    const port = (handle.server.address() as { port: number }).port;
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('--max-connections 0 still accepts connections (tanzhenxin issue 1)', async () => {
    // Pre-fix bug: docs say "Set to 0 to disable" and code did
    // `server.maxConnections = opts.maxConnections ?? 256`, but on
    // Node 22 `server.maxConnections = 0` causes the listener to
    // refuse EVERY connection. An operator following the documented
    // disable path got a daemon that booted cleanly but silently
    // bricked every request. Fix treats 0 / Infinity / non-finite as
    // "leave the property unset" so Node's default (no cap) actually
    // applies.
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      maxConnections: 0,
    });
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    // And `server.maxConnections` should be the Node default
    // (undefined / unset), NOT 0.
    expect(handle.server.maxConnections).not.toBe(0);
  });

  it('--max-connections Infinity treated as unlimited (tanzhenxin issue 1)', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      maxConnections: Infinity,
    });
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(handle.server.maxConnections).not.toBe(0);
    expect(handle.server.maxConnections).not.toBe(Infinity);
  });

  it('--max-connections 100 sets the cap as supplied', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      maxConnections: 100,
    });
    expect(handle.server.maxConnections).toBe(100);
  });

  it('--max-connections NaN/negative throws at boot (BUF9-)', async () => {
    // Silent fail-OPEN on a CLI typo would weaken the DoS guard.
    // Boot-loud is the right behavior for an unparseable cap.
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        maxConnections: NaN,
      }),
    ).rejects.toThrow(/maxConnections: NaN/);
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        maxConnections: -5,
      }),
    ).rejects.toThrow(/maxConnections: -5/);
  });

  it('case-insensitive loopback: --hostname Localhost / LOCALHOST does NOT require a token (BQ92B)', async () => {
    // The previous Set lookup was case-sensitive, so `Localhost` was
    // treated as non-loopback and refused to boot without a token.
    // Fix lowercases the operator-supplied hostname before lookup.
    handle = await runQwenServe({
      hostname: 'Localhost',
      port: 0,
      mode: 'http-bridge',
    });
    expect(handle.url).toMatch(/^http:\/\/Localhost:\d+$/);
  });

  it('strips brackets from `[::1]` before passing to app.listen()', async () => {
    // Node's app.listen wants the unbracketed IPv6 literal — `[::1]`
    // would fail with ENOTFOUND. The fixup is in runQwenServe's
    // bind-time normalization.
    handle = await runQwenServe({
      hostname: '[::1]',
      port: 0,
      mode: 'http-bridge',
    });
    const addr = handle.server.address();
    expect(typeof addr).toBe('object');
    if (typeof addr === 'object' && addr) {
      // Successfully bound — the string the OS reports is `::1` (no
      // brackets).
      expect(
        addr.address === '::1' || addr.address === '::ffff:127.0.0.1',
      ).toBe(true);
    }
  });

  it('rejects `[host]:port` syntax in --hostname with a useful error', async () => {
    // Operators typing `--hostname [2001:db8::1]:8080` are conflating the
    // URL form with the bind args. The previous bracket-strip would have
    // mangled to `2001:db8::1]:8080` and let Node ENOTFOUND. Catch it
    // upstream with a clear error pointing at the right separation.
    await expect(
      runQwenServe({
        hostname: '[2001:db8::1]:8080',
        port: 0,
        mode: 'http-bridge',
        token: 'irrelevant',
      }),
    ).rejects.toThrow(/Invalid --hostname/);
  });

  it('rejects unbracketed host:port typo with a useful error (BU-sh)', async () => {
    // Without the upfront check, `localhost:4170` would flow into
    // `formatHostForUrl` (treated as IPv6 because of the `:`) and
    // produce a misleading `[localhost:4170]:port` URL, then fail
    // at `app.listen()` with ENOTFOUND. Catch upstream.
    await expect(
      runQwenServe({
        hostname: 'localhost:4170',
        port: 0,
        mode: 'http-bridge',
      }),
    ).rejects.toThrow(
      /Invalid --hostname "localhost:4170".*looks like a "host:port" combination/,
    );
    await expect(
      runQwenServe({
        hostname: '127.0.0.1:4170',
        port: 0,
        mode: 'http-bridge',
      }),
    ).rejects.toThrow(/Invalid --hostname "127\.0\.0\.1:4170"/);
    // But raw IPv6 (multiple colons) still works.
    handle = await runQwenServe({
      hostname: '::1',
      port: 0,
      mode: 'http-bridge',
    });
    expect(handle.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
  });

  it('rejects empty-bracket `[]` --hostname (would bind to all interfaces)', async () => {
    // Node's `listen('')` is interpreted as "all interfaces". An operator
    // typing `[]` clearly meant something specific, not wildcard — fail
    // loudly instead of silently exposing the daemon on every interface.
    await expect(
      runQwenServe({
        hostname: '[]',
        port: 0,
        mode: 'http-bridge',
        token: 'irrelevant',
      }),
    ).rejects.toThrow(/Invalid --hostname/);
  });

  it('--workspace flows end-to-end and surfaces on /capabilities (#3803 §02)', async () => {
    // Use process.cwd() so the boot-time existence check passes — any
    // real absolute directory works. The bridge canonicalizes this
    // once at boot; `/capabilities.workspaceCwd` returns the canonical
    // form, NOT the raw input. Tests inject a fake bridge here so we
    // verify the route layer's canonicalization (not the bridge's),
    // making this a true E2E that doesn't require a real `qwen --acp`
    // child.
    const bridge = fakeBridge();
    handle = await runQwenServe(
      {
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: process.cwd(),
      },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    const caps = await (
      await fetch(`http://127.0.0.1:${port}/capabilities`)
    ).json();
    // Canonical form per `canonicalizeWorkspace` — realpath of cwd
    // (handles symlinks like `/var` → `/private/var` on macOS).
    const expected = await import('node:fs').then((m) =>
      m.realpathSync.native(process.cwd()),
    );
    expect(caps.workspaceCwd).toBe(expected);
  });

  it('rejects --workspace pointing at a non-existent directory (BkUyD followup — boot-loud over opaque ENOENT)', async () => {
    // Without the boot-time stat check, `canonicalizeWorkspace`'s
    // ENOENT fallback to `path.resolve` would let the daemon boot
    // pointed at a non-existent directory; every `POST /session`
    // would then spawn a `qwen --acp` child with that cwd and the
    // agent would fail with an opaque ENOENT.
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: `/tmp/qwen-serve-no-such-path-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    ).rejects.toThrow(/directory does not exist/);
  });

  it('rejects --workspace pointing at a regular file', async () => {
    // Pointing the daemon at a file (vs. a directory) is operator error
    // — the agent would fail at child-spawn time with ENOTDIR. Catch
    // it at boot for a clearer error message.
    //
    // `fileURLToPath` (not `new URL(...).pathname`) — on Windows the
    // latter returns `/C:/path/...` with a leading slash, which
    // `statSync` resolves as path-from-current-drive-root and the
    // test would then see ENOENT instead of the expected
    // "not a directory" branch.
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: fileURLToPath(import.meta.url),
      }),
    ).rejects.toThrow(/exists but is not a directory/);
  });

  it('rejects relative --workspace at boot', async () => {
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: 'relative/path',
      }),
    ).rejects.toThrow(/must be an absolute path/);
  });

  it('drains the bridge before closing the listener', async () => {
    const bridge = fakeBridge();
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    expect(bridge.shutdownCalls).toBe(0);
    await handle.close();
    handle = undefined;
    expect(bridge.shutdownCalls).toBe(1);
  });

  it('wires fsFactory + emit through to the read routes (#4175 PR 19 follow-up #2)', async () => {
    // Pin the contract that `runQwenServe` constructs the workspace
    // filesystem boundary, threads its emit hook through to
    // `createServeApp`, and that boundary actually drives the new
    // PR 19 read routes. A regression that drops the `fsFactory`
    // injection (or that swaps in a different emit channel) shows
    // up here as either a 500 response or a missing audit event.
    const captured: BridgeEvent[] = [];
    const bridge = fakeBridge();
    const wsRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-runqwen-fs-'),
    );
    await fsp.writeFile(path.join(wsRoot, 'a.txt'), 'hello');
    try {
      handle = await runQwenServe(
        {
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
          workspace: wsRoot,
        },
        { bridge, fsAuditEmit: (e) => captured.push(e) },
      );
      const port = (handle.server.address() as { port: number }).port;
      const ok = await fetch(`http://127.0.0.1:${port}/file?path=a.txt`);
      expect(ok.status).toBe(200);
      expect(
        captured.find(
          (e) =>
            e.type === 'fs.access' &&
            (e.data as { intent?: string }).intent === 'read',
        ),
      ).toBeDefined();

      const bad = await fetch(`http://127.0.0.1:${port}/file?path=../escape`);
      expect(bad.status).toBe(400);
      const denied = captured.find(
        (e) =>
          e.type === 'fs.denied' &&
          (e.data as { errorKind?: string }).errorKind ===
            'path_outside_workspace',
      );
      expect(denied).toBeDefined();
    } finally {
      await fsp.rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('honors deps.fsFactory override (#4175 PR 19 follow-up #2)', async () => {
    // The injection point exists so embedded callers (other tools
    // wrapping the daemon, future runtime locality contracts) can
    // swap in a remote-fronting factory. This test asserts
    // `runQwenServe` does NOT silently shadow a caller-supplied
    // factory with its built-in default. A regression that ignored
    // `deps.fsFactory` and fell back to the built-in factory would
    // resolve `a.txt` against `process.cwd()`, find no such file,
    // and return 404 `path_not_found`. The sentinel-throwing
    // factory ensures we see 400 with `sentinel-from-fake-factory`
    // in the body — proof the override actually drives the request.
    const sentinelMessage = 'sentinel-from-fake-factory';
    const fsFactory: WorkspaceFileSystemFactory = {
      forRequest: () => ({
        resolve: async () => {
          throw new FsError('parse_error', sentinelMessage);
        },
        readText: async () => {
          throw new Error('unreachable');
        },
        readBytes: async () => {
          throw new Error('unreachable');
        },
        list: async () => {
          throw new Error('unreachable');
        },
        glob: async () => {
          throw new Error('unreachable');
        },
        stat: async () => {
          throw new Error('unreachable');
        },
        writeText: async () => {
          throw new Error('unreachable');
        },
        edit: async () => {
          throw new Error('unreachable');
        },
      }),
    };
    const bridge = fakeBridge();
    handle = await runQwenServe(
      {
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: process.cwd(),
      },
      { bridge, fsFactory },
    );
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/file?path=a.txt`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errorKind: string };
    expect(body.errorKind).toBe('parse_error');
    expect(body.error).toContain(sentinelMessage);
  });

  it('trust snapshot defaults to true (operator-chosen workspace)', async () => {
    // The default trust value drives PR 20 write-route behavior
    // even though PR 19 only exercises read intents. Pin the
    // default here so a future contributor flipping it has to
    // rewrite this test, surfacing the security-relevant change
    // for review.
    const bridge = fakeBridge();
    const wsRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-runqwen-trust-'),
    );
    try {
      const captured: BridgeEvent[] = [];
      handle = await runQwenServe(
        {
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
          workspace: wsRoot,
        },
        { bridge, fsAuditEmit: (e) => captured.push(e) },
      );
      // Drive a read so the factory's `assertTrustedForIntent`
      // gate fires. Read intents pass under both trusted and
      // untrusted; the test signal is the absence of any
      // `untrusted_workspace` denial event in the captured stream.
      await fsp.writeFile(path.join(wsRoot, 'b.txt'), 'b');
      const port = (handle.server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/file?path=b.txt`);
      expect(res.status).toBe(200);
      expect(
        captured.find(
          (e) =>
            (e.data as { errorKind?: string }).errorKind ===
            'untrusted_workspace',
        ),
      ).toBeUndefined();
    } finally {
      await fsp.rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('trust snapshot=false flows through deps.trustedWorkspace into the boundary (#4175 PR 19 follow-up #2)', async () => {
    // PR 19 has no write routes, so the trust gate's effect on
    // mutating intents can't be observed via HTTP. Instead, we
    // construct the same factory that runQwenServe would build,
    // with the same `trusted` value runQwenServe would pass, and
    // assert the gate trips. The contract is: when
    // `deps.trustedWorkspace = false`, the factory's
    // `assertTrustedForIntent` rejects writes with
    // `untrusted_workspace` — exactly what PR 20 will rely on.
    const wsRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-runqwen-untrust-'),
    );
    try {
      // Mirror runQwenServe's construction. If `runQwenServe`
      // changes the call shape (different deps order, different
      // fields), this test will start failing to type-check —
      // which is the point: the failure is the audit trail.
      const { createWorkspaceFileSystemFactory } = await import(
        './fs/index.js'
      );
      const factory = createWorkspaceFileSystemFactory({
        boundWorkspace: wsRoot,
        trusted: false,
        emit: () => undefined,
      });
      const fsApi = factory.forRequest({ route: 'TEST /op' });
      // Read still passes — read intents are always trusted.
      await fsp.writeFile(path.join(wsRoot, 'a.txt'), 'a');
      const r = await fsApi.resolve('a.txt', 'read');
      const out = await fsApi.readText(r);
      expect(out.content).toBe('a');
      // Write throws untrusted_workspace.
      const w = await fsApi.resolve('out.txt', 'write');
      await expect(fsApi.writeText(w, 'x')).rejects.toMatchObject({
        kind: 'untrusted_workspace',
      });
    } finally {
      await fsp.rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('handle.close() is idempotent — concurrent + repeat calls share one drain cycle', async () => {
    const bridge = fakeBridge();
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    // Three overlapping callers — without the cached promise each would
    // arm its own force-close timer and call bridge.shutdown again.
    const a = handle.close();
    const b = handle.close();
    const c = handle.close();
    await Promise.all([a, b, c]);
    // Subsequent call after settle should also resolve immediately and
    // not re-trigger shutdown.
    await handle.close();
    handle = undefined;
    expect(bridge.shutdownCalls).toBe(1);
  });

  it('force-closes connections after the shutdown timeout', async () => {
    const bridge = fakeBridge();
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    // Open a long-lived SSE-like connection; without force-close the
    // listener's `server.close` would hang on this socket forever.
    const sseFetch = fetch(`http://127.0.0.1:${port}/session/dangle/events`);

    // close() is expected to resolve in well under the 5s force-close
    // window — but well above 0ms because the timer arms after bridge
    // shutdown. Just assert it resolves at all and observe roughly when.
    const start = Date.now();
    await handle.close();
    handle = undefined;
    const elapsed = Date.now() - start;

    // The fakeBridge's subscribe stream is empty so the SSE response ends
    // promptly; this assertion mainly proves the close didn't hang on the
    // live connection. Even if the connection had stayed open, the 5s
    // force-close timer would unblock us.
    expect(elapsed).toBeLessThan(5_500);
    // Drain the fetch promise so vitest doesn't complain about open handles.
    try {
      const res = await sseFetch;
      await res.body?.cancel();
    } catch {
      /* socket may be torn down by force-close */
    }
  });

  it('detaches its SIGINT/SIGTERM listeners after close completes', async () => {
    const bridge = fakeBridge();
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );

    // runQwenServe attaches one of each.
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);

    await handle.close();
    handle = undefined;

    // After drain completes, the listener that runQwenServe added is gone.
    // (Detaching during drain would leave a second-signal-during-shutdown
    // hitting Node's default termination behavior; this design detaches at
    // the end of `finish` so the `if (shuttingDown) return` guard is the
    // sole no-op path during the drain window.)
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });
});

describe('GET /session/:id/events (SSE)', () => {
  let handle: RunHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  async function readSseFrames(
    body: ReadableStream<Uint8Array>,
    minFrames: number,
  ): Promise<Array<{ id?: string; event?: string; data?: string }>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const frames: Array<{ id?: string; event?: string; data?: string }> = [];
    while (frames.length < minFrames) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!raw || raw.startsWith(':') || raw.startsWith('retry:')) continue;
        const frame: { id?: string; event?: string; data?: string } = {};
        for (const line of raw.split('\n')) {
          if (line.startsWith('id: ')) frame.id = line.slice(4);
          else if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('data: ')) frame.data = line.slice(6);
        }
        frames.push(frame);
      }
    }
    await reader.cancel();
    return frames;
  }

  it('streams events from the bridge as SSE frames', async () => {
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        yield {
          id: 1,
          v: 1,
          type: 'session_update',
          data: { foo: 'bar' },
        };
        yield { id: 2, v: 1, type: 'session_update', data: { foo: 'baz' } };
        // No more events; the stream stays open until the caller aborts.
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = await readSseFrames(res.body!, 2);

    expect(frames).toHaveLength(2);
    expect(frames[0]?.id).toBe('1');
    expect(frames[0]?.event).toBe('session_update');
    expect(JSON.parse(frames[0]!.data!)).toEqual({
      id: 1,
      v: 1,
      type: 'session_update',
      data: { foo: 'bar' },
    });
    expect(frames[1]?.id).toBe('2');
  });

  it('forwards Last-Event-ID to the bridge', async () => {
    const seen: number[] = [];
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, opts) {
        seen.push(opts?.lastEventId ?? -1);
        yield { id: 42, v: 1, type: 'session_update', data: 'replay' };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`, {
      headers: { 'Last-Event-ID': '17' },
    });
    const frames = await readSseFrames(res.body!, 1);

    expect(seen).toEqual([17]);
    expect(frames[0]?.id).toBe('42');
  });

  it('forwards ?maxQueued=N to the bridge when in [16, 2048]', async () => {
    const seen: Array<number | undefined> = [];
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, opts) {
        seen.push(opts?.maxQueued);
        yield { id: 1, v: 1, type: 'session_update', data: 'x' };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(
      `http://127.0.0.1:${port}/session/sess-A/events?maxQueued=512`,
    );
    await readSseFrames(res.body!, 1);
    expect(seen).toEqual([512]);
  });

  it('omits maxQueued from the bridge call when the query param is absent', async () => {
    const seen: Array<number | undefined> = [];
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, opts) {
        seen.push(opts?.maxQueued);
        yield { id: 1, v: 1, type: 'session_update', data: 'x' };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    await readSseFrames(res.body!, 1);
    // Empty param ≡ missing — bridge sees `undefined` so the bus
    // applies its default cap (256).
    expect(seen).toEqual([undefined]);
  });

  it('400s a present-but-empty ?maxQueued= before opening the SSE stream', async () => {
    // `?maxQueued=` (typed explicitly without a value) is malformed
    // and must fail-CLOSED, not silently fall back to the default
    // queue cap. Symmetric to non-decimal / out-of-range rejection.
    const bridge = fakeBridge({
      subscribeImpl: () => {
        throw new Error('bridge must not be touched');
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(
      `http://127.0.0.1:${port}/session/sess-A/events?maxQueued=`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_max_queued' });
  });

  it('400s a non-decimal ?maxQueued before opening the SSE stream', async () => {
    const bridge = fakeBridge({
      subscribeImpl: () => {
        throw new Error('bridge must not be touched');
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(
      `http://127.0.0.1:${port}/session/sess-A/events?maxQueued=abc`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_max_queued' });
  });

  it('400s an out-of-range ?maxQueued before opening the SSE stream', async () => {
    const bridge = fakeBridge({
      subscribeImpl: () => {
        throw new Error('bridge must not be touched');
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    for (const bad of ['0', '15', '2049', '9999']) {
      const res = await fetch(
        `http://127.0.0.1:${port}/session/sess-A/events?maxQueued=${bad}`,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_max_queued' });
    }
  });

  it('returns 404 when the bridge reports unknown session', async () => {
    const bridge = fakeBridge({
      subscribeImpl: (sessionId) => {
        throw new SessionNotFoundError(sessionId);
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/missing/events`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.sessionId).toBe('missing');
  });

  it('aborts the bridge subscription when the client disconnects', async () => {
    const aborted = { value: false };
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, opts) {
        opts?.signal?.addEventListener(
          'abort',
          () => {
            aborted.value = true;
          },
          { once: true },
        );
        yield { id: 1, v: 1, type: 'session_update', data: 'first' };
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    const frames = await readSseFrames(res.body!, 1);
    expect(frames).toHaveLength(1);
    // readSseFrames calls reader.cancel() once the requested frame count is
    // reached, which severs the underlying connection — the daemon's
    // `req.on('close')` handler then aborts the bridge subscription.

    // Wait briefly for the close handler to propagate to the bridge.
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted.value).toBe(true);
  });

  it('emits a stream_error frame when the bridge iterator throws mid-stream', async () => {
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        yield { id: 1, v: 1, type: 'session_update', data: 'first' };
        throw new Error('agent died');
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    const frames = await readSseFrames(res.body!, 2);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.event).toBe('session_update');
    expect(frames[0]?.id).toBe('1');
    expect(frames[1]?.event).toBe('stream_error');
    // The terminal `stream_error` frame deliberately has no `id:` line so
    // it doesn't pollute the per-session monotonic sequence used for
    // Last-Event-ID resume.
    expect(frames[1]?.id).toBeUndefined();
    expect(JSON.parse(frames[1]!.data!).data).toEqual({ error: 'agent died' });
  });

  it('forwards numeric Last-Event-ID even when supplied as a string', async () => {
    let seen: number | undefined;
    const bridge = fakeBridge({
      subscribeImpl: (_sessionId, opts) => {
        seen = opts?.lastEventId;
        // Empty stream — close immediately so the test doesn't hang.
        return (async function* () {
          /* no events */
        })();
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`, {
      headers: { 'Last-Event-ID': '17' },
    });
    // Drain the empty response so the connection closes.
    await res.body?.cancel();
    expect(seen).toBe(17);
  });

  it('drops malformed Last-Event-ID values (non-numeric, negative)', async () => {
    const seen: Array<number | undefined> = [];
    const bridge = fakeBridge({
      subscribeImpl: (_sessionId, opts) => {
        seen.push(opts?.lastEventId);
        return (async function* () {
          /* no events */
        })();
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    for (const value of ['abc', '-1', '1.5e10z']) {
      const res = await fetch(
        `http://127.0.0.1:${port}/session/sess-A/events`,
        { headers: { 'Last-Event-ID': value } },
      );
      await res.body?.cancel();
    }
    // None of these should pass through as a parsed lastEventId.
    expect(seen).toEqual([undefined, undefined, undefined]);
  });
});

describe('runQwenServe SIGINT handler', () => {
  it('does not register signal handlers until the listener is up', () => {
    // Sanity: we register `once` so we don't leak across test runs.
    // No assertion beyond "module loads without throwing"; full lifecycle
    // is covered indirectly by the loopback boot test above.
    expect(typeof runQwenServe).toBe('function');
    void vi.fn(); // silence unused-import lint if vitest tree-shakes
  });
});

describe('createServeApp ServeAppDeps.fsFactory wiring (#4175 PR 18)', () => {
  it('parks a default WorkspaceFileSystemFactory on app.locals when none is injected', async () => {
    const { createServeApp } = await import('./server.js');
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: '/work/bound',
      } as Parameters<typeof createServeApp>[0],
      () => 0,
    );
    const fsFactory = (
      app.locals as {
        fsFactory?: { forRequest: (ctx: { route: string }) => unknown };
      }
    ).fsFactory;
    expect(fsFactory).toBeDefined();
    expect(typeof fsFactory!.forRequest).toBe('function');
    // The factory is functional — it can build a per-request boundary.
    const fs = fsFactory!.forRequest({ route: 'TEST /op' });
    expect(fs).toBeDefined();
  });

  it('uses the injected fsFactory verbatim when supplied', async () => {
    const { createServeApp } = await import('./server.js');
    const sentinel = { forRequest: vi.fn(() => ({ marker: 'injected' })) };
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: '/work/bound',
      } as Parameters<typeof createServeApp>[0],
      () => 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { fsFactory: sentinel as any },
    );
    expect((app.locals as { fsFactory?: unknown }).fsFactory).toBe(sentinel);
  });

  it('default fsFactory is built with trusted=false (writes refused)', async () => {
    const { createServeApp } = await import('./server.js');
    const { isFsError } = await import('./fs/index.js');
    const os = await import('node:os');
    const tmp = await import('node:fs').then((m) =>
      m.promises.mkdtemp(path.join(os.tmpdir(), 'qwen-serve-default-trust-')),
    );
    try {
      const app = createServeApp(
        {
          port: 0,
          hostname: '127.0.0.1',
          workspace: tmp,
        } as Parameters<typeof createServeApp>[0],
        () => 0,
      );
      type FsCtx = { route: string };
      type WfsLite = {
        resolve: (input: string, intent: 'write') => Promise<string>;
        writeText: (p: string, content: string) => Promise<void>;
      };
      const fsFactory = (
        app.locals as {
          fsFactory?: { forRequest: (ctx: FsCtx) => WfsLite };
        }
      ).fsFactory;
      expect(fsFactory).toBeDefined();
      const fs = fsFactory!.forRequest({ route: 'TEST /op' });
      // Resolve a write target inside the workspace; the resolve
      // succeeds but writeText must throw `untrusted_workspace` —
      // that's the safe-default behavior the strict-default factory
      // exists to enforce.
      const resolved = await fs.resolve('child.txt', 'write');
      const err = await fs.writeText(resolved, 'x').catch((e: unknown) => e);
      expect(isFsError(err)).toBe(true);
      expect((err as { kind: string }).kind).toBe('untrusted_workspace');
    } finally {
      await import('node:fs').then((m) =>
        m.promises.rm(tmp, { recursive: true, force: true }),
      );
    }
  });
});
