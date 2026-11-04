/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createWorkspaceGenerationGuard,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  registerAgentHostRemoteConnectRoute,
  registerAgentHostRuntimeRoutes,
} from './agent-host-connection.js';

const {
  issueEnrollment,
  writeStderrLine,
  startConnection,
  stopConnection,
  saveConnection,
  removeConnection,
  findConnection,
  findConnectionChecked,
} = vi.hoisted(() => ({
  issueEnrollment: vi.fn(),
  writeStderrLine: vi.fn(),
  startConnection: vi.fn(),
  stopConnection: vi.fn(),
  saveConnection: vi.fn(),
  removeConnection: vi.fn(),
  findConnection: vi.fn(),
  findConnectionChecked: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/agents/workspace-agents/store.js', () => ({
  issueAgentHostEnrollment: issueEnrollment,
}));
vi.mock('../../utils/stdioHelpers.js', () => ({ writeStderrLine }));
vi.mock('../agent-host-client.js', () => ({
  startAgentHostConnection: startConnection,
  stopAgentHostConnection: stopConnection,
  normalizeServerUrl: (value: string) => value.replace(/\/$/, ''),
}));
vi.mock('../agent-host-connections.js', () => ({
  saveAgentHostConnection: saveConnection,
  removeAgentHostConnection: removeConnection,
  findAgentHostConnection: findConnection,
  findAgentHostConnectionChecked: findConnectionChecked,
}));
vi.mock('../agent-host-programs.js', () => ({
  getHostProgramProbe: async () => [
    { program: 'qwen', available: true },
    { program: 'claude', available: true, version: '2.1.0' },
    { program: 'codex', available: false, reason: 'not installed' },
  ],
  availablePrograms: (probes: Array<{ program: string; available: boolean }>) =>
    probes.filter((probe) => probe.available).map((probe) => probe.program),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it.each(['service', 'enrollment'] as const)(
  'stops remote connect when the selected runtime changes during %s',
  async (stage) => {
    const original = {
      workspaceId: 'workspace',
      workspaceCwd: '/selected',
      generationGuard: createWorkspaceGenerationGuard(),
    } as WorkspaceRuntime;
    let current = original;
    const fetch = vi.fn(async () => {
      if (stage === 'service') current = { ...original };
      return new Response(JSON.stringify({ protocol: 2, providers: ['qwen'] }));
    });
    vi.stubGlobal('fetch', fetch);
    issueEnrollment.mockImplementation(async () => {
      current = { ...original };
      return { token: 'must-not-leave-this-runtime' };
    });
    const app = express();
    app.use(express.json());
    registerAgentHostRemoteConnectRoute(
      app,
      '/agent',
      () => current,
      () => (_req, _res, next) => next(),
    );
    const response = await request(app)
      .post('/agent/hosts/remote-connect')
      .send({
        remoteUrl: 'https://worker.example',
        serverUrl: 'https://coordinator.example',
        remoteCwd: '/remote',
        remoteToken: 'remote-token',
        provider: 'qwen',
      });
    expect(response.status).toBe(409);
    expect(fetch).toHaveBeenCalledOnce();
    expect(issueEnrollment).toHaveBeenCalledTimes(stage === 'service' ? 0 : 1);
  },
);

it.each([
  [
    'an http remote',
    'http://192.168.1.20:4170',
    'https://coordinator.example',
    true,
  ],
  [
    'an http callback',
    'https://worker.example',
    'http://192.168.1.10:4170',
    true,
  ],
  ['loopback http', 'http://127.0.0.1:4171', 'http://localhost:4170', false],
  ['https', 'https://worker.example', 'https://coordinator.example', false],
] as const)(
  'warns before issuing an enrollment token over %s only when cleartext leaves the machine',
  async (_label, remoteUrl, serverUrl, warns) => {
    const runtime = {
      workspaceId: 'workspace',
      workspaceCwd: '/selected',
      generationGuard: createWorkspaceGenerationGuard(),
    } as WorkspaceRuntime;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              protocol: 2,
              providers: ['qwen'],
              connected: true,
            }),
          ),
      ),
    );
    issueEnrollment.mockImplementation(async () => {
      expect(writeStderrLine).toHaveBeenCalledTimes(warns ? 1 : 0);
      return { token: 'enrollment-token' };
    });
    const app = express();
    app.use(express.json());
    registerAgentHostRemoteConnectRoute(
      app,
      '/agent',
      () => runtime,
      () => (_req, _res, next) => next(),
    );

    const response = await request(app)
      .post('/agent/hosts/remote-connect')
      .send({
        remoteUrl,
        serverUrl,
        remoteCwd: '/remote',
        remoteToken: 'remote-token',
        provider: 'qwen',
        allowHttp: true,
      });

    expect(response.status).toBe(200);
    expect(issueEnrollment).toHaveBeenCalledOnce();
    if (warns)
      expect(writeStderrLine).toHaveBeenCalledWith(
        expect.stringContaining('enrollment token'),
      );
    else expect(writeStderrLine).not.toHaveBeenCalled();
  },
);

it('rejects a Host connection when the runtime has no generation guard', async () => {
  const runtime = {
    workspaceId: 'workspace',
    workspaceCwd: '/selected',
  } as WorkspaceRuntime;
  const app = express();
  app.use(express.json());
  registerAgentHostRuntimeRoutes(
    app,
    '/agent',
    () => runtime,
    () => (_req, _res, next) => next(),
  );

  const response = await request(app).post('/agent/hosts/connect').send({
    serverUrl: 'https://coordinator.example',
    workspaceId: 'workspace',
    enrollmentToken: 'fresh-token',
    provider: 'qwen',
  });

  expect(response.status).toBe(409);
});

function runtimeApp(runtime: WorkspaceRuntime) {
  const app = express();
  app.use(express.json());
  registerAgentHostRuntimeRoutes(
    app,
    '/agent',
    () => runtime,
    () => (_req, _res, next) => next(),
  );
  return app;
}

const selected = () =>
  ({
    workspaceId: 'workspace',
    workspaceCwd: '/selected',
    generationGuard: createWorkspaceGenerationGuard(),
  }) as WorkspaceRuntime;

it('describes this daemon as a v2 Host with its probed programs', async () => {
  const response = await request(runtimeApp(selected())).get(
    '/agent/hosts/service',
  );

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    protocol: 2,
    workspaceCwd: '/selected',
    providers: ['qwen', 'claude'],
  });
  expect(response.body.programs).toHaveLength(3);
});

it('connects without a provider and remembers the connection', async () => {
  startConnection.mockResolvedValue(undefined);
  saveConnection.mockResolvedValue(undefined);

  const response = await request(runtimeApp(selected()))
    .post('/agent/hosts/connect')
    .send({
      serverUrl: 'https://coordinator.example/',
      workspaceId: 'ws_1',
      enrollmentToken: 'fresh-token',
    });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    connected: true,
    saved: true,
    providers: ['qwen', 'claude'],
  });
  expect(response.body).not.toHaveProperty('saveError');
  expect(startConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      serverUrl: 'https://coordinator.example',
      workspaceId: 'ws_1',
      enrollmentToken: 'fresh-token',
      allowHttp: false,
    }),
  );
  expect(saveConnection).toHaveBeenCalledWith({
    serverUrl: 'https://coordinator.example',
    workspaceId: 'ws_1',
    workspaceCwd: '/selected',
    allowHttp: false,
  });
});

const joined = {
  serverUrl: 'https://coordinator.example',
  workspaceId: 'ws_1',
  workspaceCwd: '/selected',
  allowHttp: false,
};

function join() {
  return request(runtimeApp(selected())).post('/agent/hosts/connect').send({
    serverUrl: 'https://coordinator.example',
    workspaceId: 'ws_1',
    enrollmentToken: 'fresh-token',
  });
}

it('reports a join it could not save as connected but not saved', async () => {
  // The token is spent by now, so this must stay a success: a client told
  // the join failed would rerun it with the same token.
  startConnection.mockResolvedValue(undefined);
  saveConnection.mockRejectedValue(
    new Error('Lock file is already being held'),
  );
  findConnection.mockResolvedValue(undefined);

  const response = await join();

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    connected: true,
    saved: false,
    saveError: 'Lock file is already being held',
  });
  expect(writeStderrLine).toHaveBeenCalledWith(
    'qwen serve: could not save the Agent Host connection: Lock file is already being held',
  );
});

it('reports a join as saved when an earlier record for it still stands', async () => {
  // A rejoin whose save failed still reconnects after a restart, from the
  // record the previous join left.
  startConnection.mockResolvedValue(undefined);
  saveConnection.mockRejectedValue(new Error('disk full'));
  findConnection.mockResolvedValue({ ...joined, allowHttp: true });

  const response = await join();

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ connected: true, saved: true });
  expect(response.body).not.toHaveProperty('saveError');
  expect(findConnection).toHaveBeenCalledWith(joined);
  expect(writeStderrLine).toHaveBeenCalledWith(
    'qwen serve: could not save the Agent Host connection: disk full',
  );
});

it('saves nothing for a join that fails', async () => {
  startConnection.mockRejectedValue(
    new Error('Invalid or expired Agent Host enrollment token.'),
  );

  const response = await join();

  expect(response.status).toBe(400);
  expect(response.body).toEqual({
    error: 'Invalid or expired Agent Host enrollment token.',
  });
  expect(saveConnection).not.toHaveBeenCalled();
});

it('passes on, unchanged, a remote join that could not be saved', async () => {
  const runtime = selected();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            protocol: 2,
            providers: ['qwen'],
            connected: true,
            saved: false,
            saveError: 'disk full',
          }),
        ),
    ),
  );
  issueEnrollment.mockResolvedValue({ token: 'enrollment-token' });
  const app = express();
  app.use(express.json());
  registerAgentHostRemoteConnectRoute(
    app,
    '/agent',
    () => runtime,
    () => (_req, _res, next) => next(),
  );

  const response = await request(app).post('/agent/hosts/remote-connect').send({
    remoteUrl: 'https://worker.example',
    serverUrl: 'https://coordinator.example',
    remoteCwd: '/remote',
    remoteToken: 'remote-token',
  });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    connected: true,
    saved: false,
    saveError: 'disk full',
  });
});

it('gives the remote join longer than the service probe, so a spent token is not reported as failed', async () => {
  // The remote's join is program probes, enrollment and heartbeats (up to
  // 10 s each) and a save that can wait about 13.5 s for its lock.
  const runtime = selected();
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ protocol: 2, providers: ['qwen'], connected: true }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  issueEnrollment.mockResolvedValue({ token: 'enrollment-token' });
  const app = express();
  app.use(express.json());
  registerAgentHostRemoteConnectRoute(
    app,
    '/agent',
    () => runtime,
    () => (_req, _res, next) => next(),
  );

  try {
    const response = await request(app)
      .post('/agent/hosts/remote-connect')
      .send({
        remoteUrl: 'https://worker.example',
        serverUrl: 'https://coordinator.example',
        remoteCwd: '/remote',
        remoteToken: 'remote-token',
      });

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([20_000, 90_000]);
  } finally {
    timeout.mockRestore();
  }
});

it('disconnects and forgets a saved connection', async () => {
  stopConnection.mockReturnValue(false);
  removeConnection.mockResolvedValue(true);

  const response = await request(runtimeApp(selected()))
    .delete('/agent/hosts/connect')
    .send({ serverUrl: 'https://coordinator.example', workspaceId: 'ws_1' });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ disconnected: true });
  expect(removeConnection).toHaveBeenCalledWith(joined);
  expect(stopConnection).toHaveBeenCalledWith(joined);
  // Forgotten before it is stopped (see the next case).
  expect(removeConnection.mock.invocationCallOrder[0]).toBeLessThan(
    stopConnection.mock.invocationCallOrder[0]!,
  );
});

function disconnect() {
  return request(runtimeApp(selected()))
    .delete('/agent/hosts/connect')
    .send({ serverUrl: 'https://coordinator.example', workspaceId: 'ws_1' });
}

it('answers busy, and stops nothing, when the saved connections are locked', async () => {
  // A held lock clears soon; the file is not read past it, since another
  // writer may be about to change it.
  removeConnection.mockRejectedValue(
    Object.assign(new Error('Lock file is already being held'), {
      code: 'ELOCKED',
    }),
  );

  const response = await disconnect();

  expect(response.status).toBe(503);
  expect(response.body).toEqual({
    error:
      'The saved Agent Host connections are busy, so nothing was stopped. Retry the request.',
  });
  expect(stopConnection).not.toHaveBeenCalled();
  expect(findConnectionChecked).not.toHaveBeenCalled();
});

it('answers busy, and stops nothing, when another writer took the lock over', async () => {
  // The removal was refused before it wrote, so a retry can go through.
  removeConnection.mockRejectedValue(
    Object.assign(new Error('Held the lock too long'), {
      code: 'ECOMPROMISED',
    }),
  );

  const response = await disconnect();

  expect(response.status).toBe(503);
  expect(response.body).toEqual({
    error:
      'The saved Agent Host connections are busy, so nothing was stopped. Retry the request.',
  });
  expect(stopConnection).not.toHaveBeenCalled();
  expect(findConnectionChecked).not.toHaveBeenCalled();
});

it('says why, and stops nothing, when a newer version wrote the saved connections', async () => {
  // Retrying cannot help, so the reason is passed on instead of "Retry".
  removeConnection.mockRejectedValue(
    Object.assign(
      new Error(
        'connections.json was written by a newer version of Qwen Code (schema 2); not replacing it.',
      ),
      { code: 'ENEWERSCHEMA' },
    ),
  );

  const response = await disconnect();

  expect(response.status).toBe(400);
  expect(response.body).toEqual({
    error:
      'Could not forget the saved connection, so nothing was stopped: connections.json was written by a newer version of Qwen Code (schema 2); not replacing it. This version does not reconnect from that file, so the connection ends when this daemon stops.',
  });
  expect(stopConnection).not.toHaveBeenCalled();
  expect(findConnectionChecked).not.toHaveBeenCalled();
});

it('leaves the connection as it was when it cannot forget its saved record', async () => {
  // Stopping it would abort its turns, and the restore loop would
  // reconnect the record it still finds saved a few seconds later.
  removeConnection.mockRejectedValue(
    Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
  );
  findConnectionChecked.mockResolvedValue({ kind: 'found', record: joined });

  const response = await disconnect();

  expect(response.status).toBe(400);
  expect(response.body).toEqual({
    error:
      'Could not forget the saved connection, so nothing was stopped: EACCES: permission denied',
  });
  expect(stopConnection).not.toHaveBeenCalled();
});

it.each([true, false])(
  'stops a connection with no saved record even when the file cannot be written (running: %s)',
  async (running) => {
    // Joined at boot, or a join that was not saved: the restore loop has
    // nothing to bring it back from.
    removeConnection.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      }),
    );
    findConnectionChecked.mockResolvedValue({ kind: 'absent' });
    stopConnection.mockReturnValue(running);

    const response = await disconnect();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ disconnected: running });
    expect(findConnectionChecked).toHaveBeenCalledWith(joined);
    expect(stopConnection).toHaveBeenCalledWith(joined);
  },
);

it('refuses to stop when the saved connections cannot be read', async () => {
  // The Critical: an unreadable file (a transient EMFILE/EIO, a mode change)
  // is not "no record". removeAgentHostConnection failed, and the lookup
  // cannot confirm the record is gone, so stopping would abort the turns and
  // the restore loop would reconnect the record still on disk — undoing the
  // disconnect. Refuse instead.
  removeConnection.mockRejectedValue(
    Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }),
  );
  findConnectionChecked.mockResolvedValue({ kind: 'unreadable' });

  const response = await disconnect();

  expect(response.status).toBe(400);
  expect(response.body).toEqual({
    error:
      'Could not read the saved Agent Host connections, so nothing was stopped. Retry the request.',
  });
  expect(stopConnection).not.toHaveBeenCalled();
});

it('stops a connection whose record was already gone', async () => {
  removeConnection.mockResolvedValue(false);
  stopConnection.mockReturnValue(true);

  const response = await disconnect();

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ disconnected: true });
  expect(stopConnection).toHaveBeenCalledWith(joined);
});

it('refuses to pull in a remote that speaks the v1 Host protocol', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ protocol: 1, providers: ['qwen'] })),
    ),
  );
  const runtime = selected();
  const app = express();
  app.use(express.json());
  registerAgentHostRemoteConnectRoute(
    app,
    '/agent',
    () => runtime,
    () => (_req, _res, next) => next(),
  );

  const response = await request(app).post('/agent/hosts/remote-connect').send({
    remoteUrl: 'https://worker.example',
    serverUrl: 'https://coordinator.example',
    remoteCwd: '/remote',
    remoteToken: 'remote-token',
  });

  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/older Agent Host protocol/);
  expect(issueEnrollment).not.toHaveBeenCalled();
});
