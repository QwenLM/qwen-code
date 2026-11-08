import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { LiveDaemonConnection } from '../daemon-connection.ts';
import {
  LIVE_PROTOCOL_VERSION,
  MAX_CONTROL_FRAME_BYTES,
  MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES,
  parseDaemonControlMessage,
} from '../../shared/protocol.ts';

describe('Host incoming frame limits', () => {
  it('accepts control frames above the audio limit while retaining the binary audio limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'live-control-limit-'));
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let connection: LiveDaemonConnection | undefined;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      assert(address && typeof address === 'object');
      const discovery = join(directory, 'daemon.json');
      await writeFile(
        discovery,
        JSON.stringify({
          url: `http://127.0.0.1:${address.port}`,
          token: 'fixture-token',
          protocolVersion: LIVE_PROTOCOL_VERSION,
          pid: process.pid,
          instanceNonce: 'fixture_nonce_2026',
        }),
        { mode: 0o600 },
      );
      const large = JSON.stringify({
        type: 'host.state',
        epoch: 1,
        memory: {
          enabled: true,
          visualEnabled: false,
          locked: false,
          libraryId: 'default',
          model: 'fixture',
          libraries: Array.from({ length: 2800 }, (_, index) => ({
            id: `library_${index}`,
            name: 'x'.repeat(80),
          })),
        },
        status: { v: 1, available: true, state: 'idle', shortcut: 'Command+E' },
      });
      assert(Buffer.byteLength(large) > MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES);
      assert(Buffer.byteLength(large) < MAX_CONTROL_FRAME_BYTES);
      assert(parseDaemonControlMessage(large));
      let memoryReceived = false;
      let resolveClose: (code: number) => void = () => {};
      const closed = new Promise<number>((resolve, reject) => {
        resolveClose = resolve;
        timeout = setTimeout(
          () => reject(new Error('Connection did not close')),
          3000,
        );
      });
      server.once('connection', (peer) => {
        peer.once('message', () => {
          peer.send(
            JSON.stringify({
              type: 'host.welcome',
              epoch: 1,
              protocolVersion: LIVE_PROTOCOL_VERSION,
              daemonInstanceNonce: 'fixture_nonce_2026',
              heartbeatIntervalMs: 10000,
              status: {
                v: 1,
                available: true,
                state: 'idle',
                shortcut: 'Command+E',
              },
            }),
          );
          peer.send(large);
          peer.send(Buffer.alloc(MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES + 2));
        });
        peer.once('close', resolveClose);
      });
      connection = new LiveDaemonConnection(
        'fixture',
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
              globalShortcut: false,
              appshot: false,
            },
          }),
          onSnapshot: (snapshot) => {
            if (snapshot.memory?.libraries.length === 2800)
              memoryReceived = true;
          },
          onOutputAudio: () => assert.fail('Oversized audio was accepted'),
          onOutputAudioFinished() {},
          onClearOutput() {},
        },
        discovery,
      );
      connection.start();
      assert.equal(await closed, 1009);
      assert.equal(memoryReceived, true);
    } finally {
      clearTimeout(timeout);
      connection?.stop();
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
