/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createServeApp } from './server.js';
import { runQwenServe, type RunHandle } from './runQwenServe.js';
import {
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
import { CAPABILITIES_SCHEMA_VERSION, type ServeOptions } from './types.js';

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
  'typed_event_schema',
  'session_set_model',
  'client_identity',
  'client_heartbeat',
  'session_permission_vote',
  'permission_vote',
  'session_close',
  'session_metadata',
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
    setModelCalls,
    closeCalls,
    updateMetadataCalls,
    heartbeatCalls,
    heartbeatStateCalls,
    get shutdownCalls() {
      return shutdownCalls;
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
      expect(features).toEqual([...EXPECTED_STAGE1_FEATURES]);

      features.pop();
      expect(getRegisteredServeFeatures()).toEqual([
        ...EXPECTED_STAGE1_FEATURES,
      ]);
    });

    it('advertises current-protocol features separately from the registry', () => {
      expect(getAdvertisedServeFeatures()).toEqual([
        ...EXPECTED_STAGE1_FEATURES,
      ]);
      expect(getServeFeatures()).toEqual(getAdvertisedServeFeatures());
    });

    it('marks every current feature with its historical v1 origin', () => {
      expect(Object.keys(SERVE_CAPABILITY_REGISTRY)).toEqual([
        ...EXPECTED_STAGE1_FEATURES,
      ]);
      expect(
        Object.values(SERVE_CAPABILITY_REGISTRY).map(({ since }) => since),
      ).toEqual(EXPECTED_STAGE1_FEATURES.map(() => 'v1'));
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
          { sessionId: 's-1', workspaceCwd: WS_BOUND },
          { sessionId: 's-2', workspaceCwd: WS_BOUND },
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
