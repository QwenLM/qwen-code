import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { LiveDaemonConnection } from '../daemon-connection.ts';
import {
  LIVE_PROTOCOL_VERSION,
  parseDaemonControlMessage,
} from '../../shared/protocol.ts';
import type { SubagentsSnapshot } from '@qwen-code/qwen-live/subagents';

const snapshot = (revision: number): SubagentsSnapshot => ({
  revision,
  counts: {
    running: 0,
    completed: 0,
    needsAttention: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  },
  tasks: [],
  omitted: 0,
});
it('publishes standalone task revisions without republishing media state and ignores stale updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-subagent-connection-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let connection: LiveDaemonConnection | undefined;
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const discovery = join(directory, 'daemon.json');
    await writeFile(
      discovery,
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        token: 'fixture',
        protocolVersion: LIVE_PROTOCOL_VERSION,
        pid: process.pid,
        instanceNonce: 'abcdefghijklmnop',
      }),
      { mode: 0o600 },
    );
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let changed!: () => void;
    const changedPromise = new Promise<void>((resolve) => {
      changed = resolve;
    });
    let stateCount = 0;
    const updates: SubagentsSnapshot[] = [];
    const peerPromise = new Promise<WebSocket>((resolve) =>
      server.once('connection', (peer) => {
        peer.once('message', () => {
          peer.send(
            JSON.stringify({
              type: 'host.welcome',
              protocolVersion: LIVE_PROTOCOL_VERSION,
              daemonInstanceNonce: 'abcdefghijklmnop',
              heartbeatIntervalMs: 10000,
              epoch: 0,
              status: {
                v: 1,
                available: true,
                state: 'idle',
                shortcut: 'Command+E',
              },
              subagentsV1: snapshot(0),
            }),
          );
          resolve(peer);
        });
      }),
    );
    connection = new LiveDaemonConnection(
      '0.0.6',
      {
        getReadiness: () => ({
          permissions: {
            microphone: 'denied',
            camera: 'denied',
            accessibility: 'denied',
            screenRecording: 'denied',
          },
          selfChecks: {
            audioInput: false,
            audioOutput: false,
            appshot: false,
            globalShortcut: false,
          },
        }),
        onSnapshot: (state) => {
          stateCount++;
          if (state.phase === 'ready') ready();
        },
        onSubagents: (value) => {
          updates.push(value);
          changed();
        },
        onOutputAudio: () => {},
        onOutputAudioFinished: () => {},
        onClearOutput: () => {},
      },
      discovery,
    );
    connection.start();
    const peer = await peerPromise;
    await readyPromise;
    const before = stateCount;
    peer.send(
      JSON.stringify({ type: 'host.subagents', subagentsV1: snapshot(1) }),
    );
    await changedPromise;
    assert.equal(stateCount, before);
    assert.equal(updates.length, 1);
    assert.equal(connection.getSnapshot().subagentsV1?.revision, 1);
    peer.send(
      JSON.stringify({ type: 'host.subagents', subagentsV1: snapshot(0) }),
    );
    const barrier = new Promise<void>((resolve) =>
      peer.once('message', () => resolve()),
    );
    peer.send(JSON.stringify({ type: 'host.ping', pingId: 'barrier' }));
    await barrier;
    assert.equal(updates.length, 1);
    assert.equal(stateCount, before);
  } finally {
    connection?.stop();
    for (const peer of server.clients) peer.terminate();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('validates standalone task messages and rejects unbounded or malformed snapshots', () => {
  assert.deepEqual(
    parseDaemonControlMessage(
      JSON.stringify({ type: 'host.subagents', subagentsV1: snapshot(1) }),
    ),
    { type: 'host.subagents', subagentsV1: snapshot(1) },
  );
  for (const bad of [
    { ...snapshot(1), revision: -1 },
    { ...snapshot(1), counts: { running: '2' } },
    { ...snapshot(1), tasks: [{ id: 'unsafe' }] },
    { ...snapshot(1), extra: 'x'.repeat(260 * 1024) },
  ]) {
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({ type: 'host.subagents', subagentsV1: bad }),
      ),
      undefined,
    );
  }
});
