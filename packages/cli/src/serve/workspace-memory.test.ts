/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import { createMutationGate } from './auth.js';
import {
  InvalidClientIdError,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import type { BridgeEvent } from './event-bus.js';
import { mountWorkspaceMemoryRoutes } from './workspace-memory.js';

type RecordedEvent = Omit<BridgeEvent, 'id' | 'v'>;

function buildBridgeStub(
  opts: {
    knownIds?: Iterable<string>;
  } = {},
): AcpSessionBridge & { events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  const known = new Set<string>(opts.knownIds ?? []);
  return {
    events,
    publishWorkspaceEvent(event: RecordedEvent) {
      events.push(event);
    },
    knownClientIds() {
      return new Set(known);
    },
    // Methods below are not used by the memory routes; throw to keep
    // unrelated tests from accidentally relying on them.
    spawnOrAttach: () => {
      throw new Error('not implemented');
    },
    loadSession: () => {
      throw new Error('not implemented');
    },
    resumeSession: () => {
      throw new Error('not implemented');
    },
    sendPrompt: () => {
      throw new Error('not implemented');
    },
    cancelSession: () => {
      throw new Error('not implemented');
    },
    subscribeEvents: () => {
      throw new Error('not implemented');
    },
    closeSession: () => {
      throw new Error('not implemented');
    },
    updateSessionMetadata: () => {
      throw new Error('not implemented');
    },
    respondToPermission: () => {
      throw new Error('not implemented');
    },
    respondToSessionPermission: () => {
      throw new Error('not implemented');
    },
    listWorkspaceSessions: () => {
      throw new Error('not implemented');
    },
    recordHeartbeat: () => {
      throw new Error('not implemented');
    },
    getHeartbeatState: () => undefined,
    getWorkspaceMcpStatus: async () => {
      throw new Error('not implemented');
    },
    getWorkspaceSkillsStatus: async () => {
      throw new Error('not implemented');
    },
    getWorkspaceProvidersStatus: async () => {
      throw new Error('not implemented');
    },
    getSessionContextStatus: async () => {
      throw new Error('not implemented');
    },
    getSessionSupportedCommandsStatus: async () => {
      throw new Error('not implemented');
    },
    setSessionModel: async () => {
      throw new Error('not implemented');
    },
    killSession: async () => {},
    detachClient: async () => {},
    sessionCount: 0,
    pendingPermissionCount: 0,
    killAllSync: () => {},
    shutdown: async () => {},
    preheat: async () => {},
  } as unknown as AcpSessionBridge & { events: RecordedEvent[] };
}

function buildApp(opts: {
  bridge: AcpSessionBridge;
  boundWorkspace: string;
  strictNoToken?: boolean;
}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const mutate = createMutationGate({
    tokenConfigured: !opts.strictNoToken,
    requireAuth: false,
  });
  mountWorkspaceMemoryRoutes(app, {
    bridge: opts.bridge,
    boundWorkspace: opts.boundWorkspace,
    mutate,
    parseClientId: (req, res) => {
      const raw = req.get('x-qwen-client-id');
      if (raw === undefined || raw === '') return undefined;
      if (raw.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(raw)) {
        res.status(400).json({
          error: '`X-Qwen-Client-Id` must be a non-empty token',
          code: 'invalid_client_id',
        });
        return null;
      }
      return raw;
    },
    safeBody: (req) => {
      const raw = req.body;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return Object.create(null) as Record<string, unknown>;
      }
      const out = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
          continue;
        }
        out[k] = v;
      }
      return out;
    },
  });
  return app;
}

describe('workspace memory routes', () => {
  let tmp: string;
  let workspace: string;
  let globalDir: string;
  let getGlobalQwenDirSpy: MockInstance<() => string>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-serve-memory-'));
    workspace = path.join(tmp, 'workspace');
    globalDir = path.join(tmp, 'global');
    await fs.mkdir(workspace, { recursive: true });
    getGlobalQwenDirSpy = vi
      .spyOn(Storage, 'getGlobalQwenDir')
      .mockReturnValue(globalDir);
  });

  afterEach(async () => {
    getGlobalQwenDirSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  describe('GET /workspace/memory', () => {
    it('returns idle status when no QWEN.md or AGENTS.md exists anywhere', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app).get('/workspace/memory');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        v: 1,
        workspaceCwd: workspace,
        initialized: false,
        files: [],
        totalBytes: 0,
        fileCount: 0,
        ruleCount: 0,
      });
    });

    it('reports workspace and global QWEN.md files with byte counts', async () => {
      const wsFile = path.join(workspace, 'QWEN.md');
      const wsContent = 'workspace memory\n';
      await fs.writeFile(wsFile, wsContent, 'utf8');

      await fs.mkdir(globalDir, { recursive: true });
      const globalFile = path.join(globalDir, 'QWEN.md');
      const globalContent = 'global memory\n';
      await fs.writeFile(globalFile, globalContent, 'utf8');

      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app).get('/workspace/memory');

      expect(res.status).toBe(200);
      expect(res.body.initialized).toBe(true);
      expect(res.body.fileCount).toBe(2);
      expect(res.body.ruleCount).toBe(0);
      expect(res.body.totalBytes).toBe(
        Buffer.byteLength(wsContent) + Buffer.byteLength(globalContent),
      );
      const paths = (res.body.files as Array<{ path: string }>).map(
        (f) => f.path,
      );
      expect(paths).toEqual(expect.arrayContaining([wsFile, globalFile]));
    });
  });

  describe('POST /workspace/memory', () => {
    it('appends to workspace QWEN.md and emits memory_changed', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'workspace', mode: 'append', content: '- entry one' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.mode).toBe('append');
      expect(res.body.filePath).toBe(path.join(workspace, 'QWEN.md'));

      const written = await fs.readFile(
        path.join(workspace, 'QWEN.md'),
        'utf8',
      );
      expect(written).toContain('- entry one');

      const events = (bridge as unknown as { events: RecordedEvent[] }).events;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('memory_changed');
      const data = events[0]?.data as Record<string, unknown>;
      expect(data['scope']).toBe('workspace');
      expect(data['mode']).toBe('append');
      expect(data['filePath']).toBe(path.join(workspace, 'QWEN.md'));
    });

    it('replaces workspace QWEN.md when mode=replace', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const filePath = path.join(workspace, 'QWEN.md');
      await fs.writeFile(filePath, 'old\n', 'utf8');

      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'workspace', mode: 'replace', content: 'new\n' });

      expect(res.status).toBe(200);
      const written = await fs.readFile(filePath, 'utf8');
      expect(written).toBe('new\n');
    });

    it('writes to the global ~/.qwen directory when scope=global', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'global', mode: 'append', content: '- global note' });

      expect(res.status).toBe(200);
      expect(res.body.filePath).toBe(path.join(globalDir, 'QWEN.md'));
      const written = await fs.readFile(
        path.join(globalDir, 'QWEN.md'),
        'utf8',
      );
      expect(written).toContain('- global note');
    });

    it('rejects 400 invalid_scope on unknown scope value', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'all', content: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_scope');
    });

    it('rejects 400 invalid_mode on unknown mode value', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'workspace', mode: 'merge', content: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_mode');
    });

    it('rejects 400 invalid_content for non-string content', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'workspace', content: 123 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_content');
    });

    it('rejects 400 content_too_large above the 1 MB limit', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const big = 'x'.repeat(1024 * 1024 + 1);
      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'workspace', content: big });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('content_too_large');
    });

    it('returns 401 token_required when strict gate fires on no-token loopback', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({
        bridge,
        boundWorkspace: workspace,
        strictNoToken: true,
      });
      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'workspace', content: '- x' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('token_required');
    });

    it('rejects 400 invalid_client_id when X-Qwen-Client-Id is unknown', async () => {
      const bridge = buildBridgeStub({ knownIds: ['client_known'] });
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app)
        .post('/workspace/memory')
        .set('X-Qwen-Client-Id', 'client_unknown')
        .send({ scope: 'workspace', content: '- x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_client_id');
    });

    it('suppresses memory_changed event when append content is whitespace only', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'workspace', mode: 'append', content: '\n\n  \n' });
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(false);
      const events = (bridge as unknown as { events: RecordedEvent[] }).events;
      expect(events).toHaveLength(0);
    });

    it('returns 413 memory_file_too_large when existing QWEN.md exceeds the 16 MB cap', async () => {
      // Write a 17 MB existing QWEN.md, then attempt append. The
      // helper's pre-read `fs.stat` must refuse with the typed
      // error → the route maps it to 413.
      const filePath = path.join(workspace, 'QWEN.md');
      // 17 MB of `x` characters. Bypass the helper's mutex / cap by
      // writing directly via fs (simulating an externally-grown file
      // outside the daemon's control).
      const big = 'x'.repeat(17 * 1024 * 1024);
      await fs.writeFile(filePath, big, 'utf8');

      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app)
        .post('/workspace/memory')
        .send({ scope: 'workspace', mode: 'append', content: '- entry' });

      expect(res.status).toBe(413);
      expect(res.body.code).toBe('memory_file_too_large');
      expect(res.body.scope).toBe('workspace');
      expect(res.body.mode).toBe('append');
      expect(res.body.bytes).toBe(17 * 1024 * 1024);
      expect(res.body.limit).toBe(16 * 1024 * 1024);
      // Default response: no filePath, no path-embedding error message.
      expect(res.body.filePath).toBeUndefined();
      expect(res.body.error).not.toContain(filePath);
    });

    it('omits errorMessage + filePath in 500/413 responses unless QWEN_SERVE_DEBUG is on', async () => {
      // Windows ignores Unix-style permission bits passed to
      // `fs.chmod` — the directory stays writable, the POST succeeds
      // with 200, and the EACCES path this test exercises is
      // unreachable. The route logic itself is platform-agnostic; the
      // Ubuntu + macOS runs cover it. Mirrors the
      // `process.platform === 'win32'` early-return idiom already used
      // in `customBanner.test.ts:232`.
      if (process.platform === 'win32') return;

      // Default: production response carries no `errorMessage` or
      // `filePath` fields — operators read the daemon stderr log
      // for the path. Setting QWEN_SERVE_DEBUG=1 enables both.
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });

      // Force a 500 by making the workspace QWEN.md unwritable. We
      // chmod the WORKSPACE directory (not the file) so `mkdir` and
      // `writeFile` will fail with EACCES.
      const before = await fs.stat(workspace);
      await fs.chmod(workspace, 0o555);
      const prevDebug = process.env['QWEN_SERVE_DEBUG'];
      try {
        delete process.env['QWEN_SERVE_DEBUG'];
        const res = await request(app).post('/workspace/memory').send({
          scope: 'workspace',
          mode: 'append',
          content: '- entry',
        });
        expect(res.status).toBe(500);
        expect(res.body.code).toBe('file_error');
        expect(res.body.scope).toBe('workspace');
        expect(res.body.mode).toBe('append');
        // Default response: no errorMessage, no filePath.
        expect(res.body.errorMessage).toBeUndefined();
        expect(res.body.filePath).toBeUndefined();

        // Toggle debug back on; the same payload now carries the
        // detail.
        process.env['QWEN_SERVE_DEBUG'] = '1';
        const debugRes = await request(app).post('/workspace/memory').send({
          scope: 'workspace',
          mode: 'append',
          content: '- entry',
        });
        expect(debugRes.status).toBe(500);
        expect(typeof debugRes.body.errorMessage).toBe('string');
      } finally {
        if (prevDebug === undefined) delete process.env['QWEN_SERVE_DEBUG'];
        else process.env['QWEN_SERVE_DEBUG'] = prevDebug;
        await fs.chmod(workspace, before.mode);
      }
    });

    it('returns 500 memory_discovery_failed when GET helper throws unexpectedly', async () => {
      const bridge = buildBridgeStub();
      const app = buildApp({ bridge, boundWorkspace: workspace });
      // Force the helper to throw by spying on `Storage.getGlobalQwenDir`
      // — every call site of the discovery walk uses it.
      const failGlobal = vi
        .spyOn(Storage, 'getGlobalQwenDir')
        .mockImplementation(() => {
          throw new Error('boom');
        });
      try {
        const res = await request(app).get('/workspace/memory');
        expect(res.status).toBe(500);
        expect(res.body.code).toBe('memory_discovery_failed');
      } finally {
        failGlobal.mockRestore();
      }
    });

    it('stamps originatorClientId on the memory_changed event for known clients', async () => {
      const bridge = buildBridgeStub({ knownIds: ['client_a'] });
      const app = buildApp({ bridge, boundWorkspace: workspace });
      const res = await request(app)
        .post('/workspace/memory')
        .set('X-Qwen-Client-Id', 'client_a')
        .send({ scope: 'workspace', mode: 'append', content: '- x' });
      expect(res.status).toBe(200);
      const events = (bridge as unknown as { events: RecordedEvent[] }).events;
      expect(events[0]?.originatorClientId).toBe('client_a');
    });

    // Reference InvalidClientIdError in case future refactors rename
    // it — keeps the import non-tree-shakeable surface a real symbol.
    it('exposes InvalidClientIdError from the bridge module', () => {
      expect(typeof InvalidClientIdError).toBe('function');
    });
  });
});
