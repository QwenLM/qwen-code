/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import { createHostedHarnessContract } from './hosted-harness-contract.js';
import {
  resolveHostedHarnessWorkUrl,
  startHostedHarnessWorkPoll,
} from './hosted-harness-work-poll.js';

vi.mock('../utils/stdioHelpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/stdioHelpers.js')>()),
  writeStderrLineSafe: vi.fn(),
}));

const BOOT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const contract = {
  ...createHostedHarnessContract(
    `sha256:${'a'.repeat(64)}`,
    BOOT_ID,
    [],
    'pod-a',
    true,
  ),
  instanceId: 'pod-a',
};
const claim = {
  tenantId: 'tenant-a',
  sessionId: SESSION_ID,
  placementEpoch: 2,
  reservedUntil: 1_764_260_000_000,
  load: { passiveManagedRuntimeRecovery: true, harnessPlacement: { x: 1 } },
};

type Reply = { status: number; body: unknown } | undefined;

const servers = new Set<Server>();
const stops = new Set<() => Promise<void>>();

afterEach(async () => {
  await Promise.all([...stops].map((stop) => stop()));
  stops.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  servers.clear();
  vi.mocked(writeStderrLineSafe).mockClear();
});

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Answers poll n with answer(n); undefined holds it open. */
async function controlPlane(answer: (poll: number) => Reply) {
  const polls: Array<{
    authorization?: string;
    body: Record<string, unknown>;
    at: number;
  }> = [];
  const app = express();
  app.use(express.json());
  app.post('/internal/managed-harness-work/v1/poll', (req, res) => {
    polls.push({
      authorization: req.get('authorization'),
      body: req.body as Record<string, unknown>,
      at: Date.now(),
    });
    const reply = answer(polls.length);
    if (reply) res.status(reply.status).json(reply.body);
  });
  return { url: new URL(await listen(app)), polls };
}

async function harness(status = 200) {
  const loads: Array<{
    path: string;
    headers: Record<string, string | undefined>;
    body: unknown;
  }> = [];
  const app = express();
  app.use(express.json());
  app.post('/session/:id/load', (req, res) => {
    loads.push({
      path: req.path,
      headers: {
        authorization: req.get('authorization'),
        protocol: req.get('x-qwen-harness-protocol-version'),
        bootId: req.get('x-qwen-harness-boot-id'),
      },
      body: req.body,
    });
    res.status(status).json(status === 200 ? {} : { code: 'load_refused' });
  });
  const url = await listen(app);
  return { selfUrl: () => url, loads };
}

function start(
  workUrl: URL,
  selfUrl: () => string,
  freeSlots: () => number = () => 3,
  delays: { pauseMs?: number; refusedMs?: number } = {},
) {
  const stop = startHostedHarnessWorkPoll({
    workUrl,
    selfUrl,
    token: 'harness-secret',
    contract,
    freeSlots,
    pauseMs: 20,
    ...delays,
  });
  stops.add(stop);
  return stop;
}

function logged(): string[] {
  return vi.mocked(writeStderrLineSafe).mock.calls.map(([line]) => line);
}

describe('Hosted Harness work poll', () => {
  it('polls as this process and loads a new claim through its own load route', async () => {
    const java = await controlPlane((poll) =>
      poll === 1 ? { status: 200, body: { claims: [claim] } } : undefined,
    );
    const self = await harness();
    start(java.url, self.selfUrl);

    await vi.waitFor(() => expect(self.loads).toHaveLength(1));
    expect(java.polls[0]).toMatchObject({
      authorization: 'Bearer harness-secret',
      body: {
        instanceId: 'pod-a',
        bootId: BOOT_ID,
        capabilityDigest: contract.capabilityDigest,
        features: contract.features,
        freeSlots: 3,
        waitMillis: 20_000,
      },
    });
    expect(contract.features).toContain('work-pull/1');
    expect(self.loads[0]).toEqual({
      path: `/session/${SESSION_ID}/load`,
      headers: {
        authorization: 'Bearer harness-secret',
        protocol: '1',
        bootId: BOOT_ID,
      },
      body: claim.load,
    });
  });

  it('loads a re-offered claim once, leaves a failed load to lapse, and paces the re-offers', async () => {
    const java = await controlPlane(() => ({
      status: 200,
      body: { claims: [claim] },
    }));
    const self = await harness(409);
    start(java.url, self.selfUrl, () => 3, { pauseMs: 50 });

    await vi.waitFor(() => {
      expect(java.polls.length).toBeGreaterThan(4);
      expect(logged()).toContain(
        `qwen serve: claimed Session ${SESSION_ID} at placement 2 did not load: 409 load_refused`,
      );
    });
    expect(self.loads).toHaveLength(1);
    // The first reply carried a new claim, so the second poll followed at
    // once; every later reply only re-offered it.
    for (let index = 2; index < 5; index += 1)
      expect(
        java.polls[index]!.at - java.polls[index - 1]!.at,
      ).toBeGreaterThanOrEqual(40);
  });

  it('keeps a failed claim lapsed across an empty reply but loads a new placement epoch', async () => {
    const next = {
      ...claim,
      placementEpoch: 3,
      load: { ...claim.load, harnessPlacement: { x: 3 } },
    };
    // An empty reply can be a deadline that passed while a reservation was
    // still live, so the failed claim is re-offered after it.
    const java = await controlPlane((poll) =>
      poll === 1
        ? { status: 200, body: { claims: [claim] } }
        : poll === 2
          ? { status: 200, body: { claims: [] } }
          : poll === 3
            ? { status: 200, body: { claims: [claim, next] } }
            : undefined,
    );
    const self = await harness(409);
    start(java.url, self.selfUrl);

    await vi.waitFor(() =>
      expect(self.loads.map((load) => load.body)).toContainEqual(next.load),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(self.loads.map((load) => load.body)).toEqual([
      claim.load,
      next.load,
    ]);
  });

  it('polls only while a cold-open slot is free', async () => {
    const java = await controlPlane(() => undefined);
    const self = await harness();
    let slots = 0;
    start(java.url, self.selfUrl, () => slots, { pauseMs: 10 });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(java.polls).toHaveLength(0);
    slots = 2;
    await vi.waitFor(() => expect(java.polls).toHaveLength(1));
    expect(java.polls[0]!.body['freeSlots']).toBe(2);
  });

  it('backs off longer after a refusal than after a failure, logging each change once', async () => {
    const java = await controlPlane((poll) =>
      poll === 1
        ? { status: 403, body: { code: 'harness_work_poller_refused' } }
        : poll === 2 || poll === 3
          ? { status: 503, body: {} }
          : poll === 4
            ? { status: 200, body: { claims: [{ sessionId: 7 }] } }
            : poll === 5
              ? { status: 200, body: { claims: [] } }
              : undefined,
    );
    const self = await harness();
    start(java.url, self.selfUrl, () => 3, { pauseMs: 10, refusedMs: 300 });

    await vi.waitFor(() => expect(java.polls).toHaveLength(6), {
      timeout: 3_000,
    });
    expect(java.polls[1]!.at - java.polls[0]!.at).toBeGreaterThanOrEqual(290);
    expect(java.polls[2]!.at - java.polls[1]!.at).toBeLessThan(290);
    expect(self.loads).toHaveLength(0);
    expect(logged()).toEqual([
      'qwen serve: Harness work poll failed: 403 harness_work_poller_refused',
      'qwen serve: Harness work poll failed: 503',
      'qwen serve: Harness work poll failed: invalid reply',
      'qwen serve: Harness work poll recovered',
    ]);
  });

  it('retries a control plane it cannot reach', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const self = await harness();
    start(new URL(`http://127.0.0.1:${port}`), self.selfUrl, () => 3, {
      pauseMs: 10,
    });

    await vi.waitFor(() =>
      expect(logged()[0]).toMatch(
        /^qwen serve: Harness work poll failed: .*ECONNREFUSED/u,
      ),
    );
  });

  it('stops a held poll at once', async () => {
    const java = await controlPlane(() => undefined);
    const self = await harness();
    const stop = start(java.url, self.selfUrl);
    await vi.waitFor(() => expect(java.polls).toHaveLength(1));

    const started = Date.now();
    await stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('accepts only an HTTP(S) origin, with plain HTTP on loopback alone', () => {
    expect(resolveHostedHarnessWorkUrl('http://127.0.0.1:8081').href).toBe(
      'http://127.0.0.1:8081/',
    );
    expect(
      resolveHostedHarnessWorkUrl('https://managed-agent.internal').href,
    ).toBe('https://managed-agent.internal/');
    for (const invalid of [
      'not a url',
      'ftp://127.0.0.1',
      'http://127.0.0.1:8081/internal',
      'http://user:pass@127.0.0.1:8081',
      'http://127.0.0.1:8081/?x=1',
    ])
      expect(() => resolveHostedHarnessWorkUrl(invalid)).toThrow(
        'QWEN_MANAGED_HARNESS_WORK_URL must be an HTTP(S) origin.',
      );
    expect(() =>
      resolveHostedHarnessWorkUrl('http://managed-agent.internal'),
    ).toThrow('must use HTTPS outside the loopback interface');
  });
});
