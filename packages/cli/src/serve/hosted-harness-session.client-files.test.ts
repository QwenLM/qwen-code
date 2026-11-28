/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  settleTimeoutMs,
  state,
  store,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';

describe('client files registration route', () => {
  // This describe is top-level, so it does not inherit the no-tool-session
  // fixture's fresh runtime root; give each test its own so a fixed session id
  // never lands on a prior test's journal.
  beforeEach(async () => {
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
  });
  afterEach(async () => {
    await rm(state.root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  function relayPeerServer(
    tools: Array<{
      name: string;
      description: string;
      inputSchema: { type: string };
    }>,
  ) {
    return createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(req.method === 'DELETE' ? 200 : 405);
        res.end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const message = JSON.parse(body) as { id?: unknown; method?: string };
        if (message.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'relay', version: '1.0.0' },
              }
            : message.method === 'tools/list'
              ? { tools }
              : { content: [{ type: 'text', text: 'ok' }] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
    });
  }

  async function relayPeer() {
    const peer = relayPeerServer([
      {
        name: 'read_file',
        description: 'Read a client file',
        inputSchema: { type: 'object' },
      },
    ]);
    await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve));
    const port = (peer.address() as { port: number }).port;
    return { peer, url: `http://127.0.0.1:${port}/mcp` };
  }

  async function sessionWithClient() {
    const sessionId = randomUUID();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    return {
      server,
      sessionId,
      clientId: created.body.clientId as string,
    };
  }

  it('refuses register for a foregroundOnly Session that never declares client-files', async () => {
    // A foregroundOnly Session's Turns drop the client-files lane, so a relay
    // client would be held for tools no Turn hands out. Register must refuse
    // (409) while unregister stays admitted. Removing the guard turns this red.
    const { peer, url } = await relayPeer();
    const sessionId = randomUUID();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      foregroundOnly: true,
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    try {
      const dispatch = JSON.parse(
        await readFile(
          new URL(
            '../../../managed-agent-server/verification/src/test/resources/clientfiles/dispatch-register.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const registered = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ ...dispatch, url });
      expect(registered.status).toBe(409);
      expect(registered.body.code).toBe(
        'hosted_client_files_profile_unsupported',
      );
      const unregistered = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ action: 'unregister' });
      expect(unregistered.status).toBe(200);
    } finally {
      await headers(supertest(server).delete(`/session/${sessionId}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      await new Promise<void>((resolve) => {
        peer.close(() => resolve());
        peer.closeAllConnections();
      });
    }
  });

  it('refuses register for a memory-only Session that never declares client-files', async () => {
    // A memory-only Session (no toolProfile) returns before the client-files
    // declaration push, so register must refuse (409) while unregister stays
    // admitted. Removing the !toolProfile half of the guard turns this red.
    const { peer, url } = await relayPeer();
    const sessionId = randomUUID();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    try {
      const dispatch = JSON.parse(
        await readFile(
          new URL(
            '../../../managed-agent-server/verification/src/test/resources/clientfiles/dispatch-register.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const registered = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ ...dispatch, url });
      expect(registered.status).toBe(409);
      expect(registered.body.code).toBe(
        'hosted_client_files_profile_unsupported',
      );
      const unregistered = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ action: 'unregister' });
      expect(unregistered.status).toBe(200);
    } finally {
      await headers(supertest(server).delete(`/session/${sessionId}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      await new Promise<void>((resolve) => {
        peer.close(() => resolve());
        peer.closeAllConnections();
      });
    }
  });

  it('refuses register for an external-Shell Session that never declares client-files', async () => {
    // The external-Shell branch of declarations() returns its own tool list
    // without ever calling clientFilesDeclarations(), and the profile's create
    // path does not require foregroundOnly — so register must refuse (409)
    // while unregister stays admitted. Removing the external predicate from
    // the register guard turns this red.
    const { peer, url } = await relayPeer();
    const sessionId = randomUUID();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-external-shell/1',
      captureBytes: 4096,
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    try {
      const dispatch = JSON.parse(
        await readFile(
          new URL(
            '../../../managed-agent-server/verification/src/test/resources/clientfiles/dispatch-register.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const registered = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ ...dispatch, url });
      expect(registered.status).toBe(409);
      expect(registered.body.code).toBe(
        'hosted_client_files_profile_unsupported',
      );
      const unregistered = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ action: 'unregister' });
      expect(unregistered.status).toBe(200);
    } finally {
      await headers(supertest(server).delete(`/session/${sessionId}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      await new Promise<void>((resolve) => {
        peer.close(() => resolve());
        peer.closeAllConnections();
      });
    }
  });

  it('registers a relay, reports the tool count, and unregisters', async () => {
    const { peer, url } = await relayPeer();
    const { server, sessionId, clientId } = await sessionWithClient();
    try {
      // The Java relay service test asserts its dispatch against this same
      // fixture; only the live peer URL is substituted here.
      const dispatch = JSON.parse(
        await readFile(
          new URL(
            '../../../managed-agent-server/verification/src/test/resources/clientfiles/dispatch-register.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const registered = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ ...dispatch, url });
      expect(registered.status).toBe(200);
      expect(registered.body).toMatchObject({
        registered: true,
        generation: 1,
        toolCount: 1,
      });
      const unregistered = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ action: 'unregister' });
      expect(unregistered.status).toBe(200);
      expect(unregistered.body.registered).toBe(false);
    } finally {
      await headers(supertest(server).delete(`/session/${sessionId}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      await new Promise<void>((resolve) => {
        peer.close(() => resolve());
        peer.closeAllConnections();
      });
    }
  });

  it('a stale unregister does not drop a newer registration catalog', async () => {
    // The two relay peers advertise different tool counts, so the catalog a
    // registration leaves installed is observable through the toolCount a
    // later lower-generation register reports: a no-op downgrade returns the
    // current catalog's count, while a fresh install returns the new peer's.
    const toolsPeer = (toolCount: number) =>
      relayPeerServer(
        Array.from({ length: toolCount }, (_, i) => ({
          name: `read_file_${i}`,
          description: 'Read a client file',
          inputSchema: { type: 'object' },
        })),
      );
    const peerOne = toolsPeer(1);
    const peerTwo = toolsPeer(2);
    await new Promise<void>((resolve) =>
      peerOne.listen(0, '127.0.0.1', resolve),
    );
    await new Promise<void>((resolve) =>
      peerTwo.listen(0, '127.0.0.1', resolve),
    );
    const urlOne = `http://127.0.0.1:${(peerOne.address() as { port: number }).port}/mcp`;
    const urlTwo = `http://127.0.0.1:${(peerTwo.address() as { port: number }).port}/mcp`;
    const { server, sessionId, clientId } = await sessionWithClient();
    try {
      const dispatch = JSON.parse(
        await readFile(
          new URL(
            '../../../managed-agent-server/verification/src/test/resources/clientfiles/dispatch-register.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const register = (generation: number, url: string) =>
        headers(supertest(server).post(`/session/${sessionId}/client-files`))
          .set('X-Qwen-Client-Id', clientId)
          .send({ ...dispatch, url, generation });
      expect((await register(1, urlOne)).body.toolCount).toBe(1);
      expect((await register(2, urlTwo)).body.toolCount).toBe(2);
      // A stale teardown for generation 1 must not drop the generation-2
      // catalog. Re-registering generation 1 stays a no-op and reports the
      // still-installed generation-2 catalog (2 tools), not peer one's single
      // tool — which is what a wrongly cleared catalog would reinstall.
      const stale = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ action: 'unregister', generation: 1 });
      expect(stale.status).toBe(200);
      expect((await register(1, urlOne)).body.toolCount).toBe(2);
      // The matching teardown clears the catalog, so a later generation-1
      // registration installs peer one's single tool again.
      const current = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ action: 'unregister', generation: 2 });
      expect(current.status).toBe(200);
      expect((await register(1, urlOne)).body.toolCount).toBe(1);
    } finally {
      await headers(supertest(server).delete(`/session/${sessionId}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      await new Promise<void>((resolve) => {
        peerOne.close(() => resolve());
        peerOne.closeAllConnections();
      });
      await new Promise<void>((resolve) => {
        peerTwo.close(() => resolve());
        peerTwo.closeAllConnections();
      });
    }
  });

  it('refuses an invalid registration payload', async () => {
    const { server, sessionId, clientId } = await sessionWithClient();
    try {
      const bad = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          action: 'register',
          serverId: 'local-files',
          generation: 0,
          url: 'http://127.0.0.1:1/mcp',
          token: 't',
        });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('invalid_client_files_registration');
    } finally {
      await headers(supertest(server).delete(`/session/${sessionId}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('refuses a registration whose relay cannot be reached', async () => {
    const { server, sessionId, clientId } = await sessionWithClient();
    try {
      const unreachable = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({
          action: 'register',
          serverId: 'local-files',
          generation: 1,
          url: 'http://127.0.0.1:1/mcp',
          token: 't',
        });
      expect(unreachable.status).toBe(503);
      expect(unreachable.body.code).toBe('client_files_relay_unavailable');
    } finally {
      await headers(supertest(server).delete(`/session/${sessionId}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('refuses an unknown session and a wrong client id', async () => {
    const { server, sessionId, clientId } = await sessionWithClient();
    try {
      const unknown = await headers(
        supertest(server).post(
          '/session/99999999-9999-4999-8999-999999999999/client-files',
        ),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ action: 'unregister' });
      expect(unknown.status).toBe(404);
      const wrongClient = await headers(
        supertest(server).post(`/session/${sessionId}/client-files`),
      )
        .set('X-Qwen-Client-Id', '99999999-9999-4999-8999-999999999999')
        .send({ action: 'unregister' });
      expect(wrongClient.status).toBe(404);
    } finally {
      await headers(supertest(server).delete(`/session/${sessionId}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('admits unregister during a blocked Turn but still refuses register', async () => {
    const { peer, url } = await relayPeer();
    const server = await app(true);
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
    });
    expect(created.status).toBe(200);
    const clientId = created.body.clientId as string;
    try {
      const dispatch = JSON.parse(
        await readFile(
          new URL(
            '../../../managed-agent-server/verification/src/test/resources/clientfiles/dispatch-register.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const registered = await headers(
        supertest(server).post(`/session/${SESSION_ID}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ ...dispatch, url });
      expect(registered.status).toBe(200);

      // Park a Turn so the Session is blocked (an active Turn would gate
      // register); unregister must still be admitted so the catalog does not
      // outlive the binding.
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
        },
        { timeout: settleTimeoutMs() },
      );

      const blockedRegister = await headers(
        supertest(server).post(`/session/${SESSION_ID}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ ...dispatch, url, generation: 2 });
      expect(blockedRegister.status).toBe(409);
      expect(blockedRegister.body.code).toBe('hosted_turn_active');

      const unregistered = await headers(
        supertest(server).post(`/session/${SESSION_ID}/client-files`),
      )
        .set('X-Qwen-Client-Id', clientId)
        .send({ action: 'unregister' });
      expect(unregistered.status).toBe(200);
      expect(unregistered.body.registered).toBe(false);
    } finally {
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
      await new Promise<void>((resolve) => {
        peer.close(() => resolve());
        peer.closeAllConnections();
      });
    }
  });
});
