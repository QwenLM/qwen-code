import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { displayLiveMessage } from '@qwen-code/qwen-live/i18n';
import { LiveDaemonConnection } from '../daemon-connection.ts';
import {
  LIVE_PROTOCOL_VERSION,
  encodeHostControlMessage,
  parseDaemonControlMessage,
} from '../../shared/protocol.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const status = {
  v: 1,
  available: true,
  state: 'listening',
  shortcut: 'Command+E',
};
function receive(peer: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Missing language action')),
      3000,
    );
    peer.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
}
async function fixture(supports = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const directory = await mkdtemp(join(tmpdir(), 'live-language-host-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'daemon.json');
  await writeFile(
    path,
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      token: 'fixture',
      pid: process.pid,
      instanceNonce: 'abcdefghijklmnop',
      protocolVersion: LIVE_PROTOCOL_VERSION,
    }),
    { mode: 0o600 },
  );
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const peerReady = new Promise<WebSocket>((resolve) =>
    server.once('connection', async (peer) => {
      await receive(peer);
      peer.send(
        JSON.stringify({
          type: 'host.welcome',
          protocolVersion: LIVE_PROTOCOL_VERSION,
          daemonInstanceNonce: 'abcdefghijklmnop',
          heartbeatIntervalMs: 10000,
          epoch: 3,
          status,
          ...(supports ? { uiLanguageV1: { language: 'en' } } : {}),
        }),
      );
      resolve(peer);
    }),
  );
  const connection = new LiveDaemonConnection(
    '0.0.6',
    {
      getReadiness: () => ({
        permissions: {
          microphone: 'granted',
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        selfChecks: {
          audioInput: true,
          audioOutput: true,
          appshot: true,
          globalShortcut: true,
        },
      }),
      onSnapshot: (snapshot) => {
        if (snapshot.phase === 'ready') ready();
      },
      onOutputAudio: () => {},
      onOutputAudioFinished: () => {},
      onClearOutput: () => {},
    },
    path,
  );
  cleanups.push(() => connection.stop());
  connection.start();
  const peer = await peerReady;
  await readiness;
  return { connection, peer };
}
const localized = (expression: RegExp) => (error: Error) =>
  expression.test(displayLiveMessage('en', error.message));

describe('Host language protocol', () => {
  it('validates locale and correlated result shapes without accepting coercion', () => {
    const valid = {
      type: 'host.state',
      epoch: 3,
      status,
      uiLanguageV1: { language: 'zh-CN' },
    };
    assert.deepEqual(parseDaemonControlMessage(JSON.stringify(valid)), valid);
    for (const language of [null, 'zh', 'fr', 1, true]) {
      assert.equal(
        parseDaemonControlMessage(
          JSON.stringify({ ...valid, uiLanguageV1: { language } }),
        ),
        undefined,
      );
      assert.throws(() =>
        encodeHostControlMessage({
          type: 'host.language_action',
          requestId: 'r',
          epoch: 3,
          language,
        } as never),
      );
    }
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.language_result',
          requestId: 'r',
          ok: true,
        }),
      ),
      undefined,
    );
  });

  it('changes language only on matching acknowledgement and rejects duplicate requests', async () => {
    const { connection, peer } = await fixture();
    const frame = receive(peer);
    const result = connection.requestLanguage('zh-CN');
    assert.equal(connection.getSnapshot().uiLanguageV1?.language, 'en');
    await assert.rejects(
      connection.requestLanguage('en'),
      localized(/already in progress/),
    );
    const request = await frame;
    assert.equal(request['epoch'], 3);
    peer.send(
      JSON.stringify({
        type: 'host.language_result',
        requestId: 'not-this-request',
        ok: true,
        uiLanguageV1: { language: 'zh-CN' },
      }),
    );
    peer.send(
      JSON.stringify({
        type: 'host.language_result',
        requestId: request['requestId'],
        ok: true,
        uiLanguageV1: { language: 'zh-CN' },
      }),
    );
    assert.equal(await result, 'zh-CN');
    assert.equal(connection.getSnapshot().uiLanguageV1?.language, 'zh-CN');
  });

  it('keeps confirmed language after failed saves and rejects mismatched success', async () => {
    const { connection, peer } = await fixture();
    for (const wrongSuccess of [false, true]) {
      const frame = receive(peer);
      const result = connection.requestLanguage('zh-CN');
      const rejected = assert.rejects(result);
      const request = await frame;
      peer.send(
        JSON.stringify({
          type: 'host.language_result',
          requestId: request['requestId'],
          ok: wrongSuccess,
          error: 'write refused',
          uiLanguageV1: { language: 'en' },
        }),
      );
      await rejected;
      assert.equal(connection.getSnapshot().uiLanguageV1?.language, 'en');
    }
  });

  it('rejects changes on legacy connections and pending changes on disconnect', async () => {
    const legacy = await fixture(false);
    await assert.rejects(
      legacy.connection.requestLanguage('zh-CN'),
      localized(/unavailable/),
    );
    const { connection, peer } = await fixture();
    const result = connection.requestLanguage('zh-CN');
    const rejected = assert.rejects(result, localized(/disconnected/));
    peer.close();
    await rejected;
  });

  it('fences a pending language change when the call epoch changes', async () => {
    const { connection, peer } = await fixture();
    const frame = receive(peer);
    const result = connection.requestLanguage('zh-CN');
    const rejected = assert.rejects(result, localized(/call changed/));
    const request = await frame;
    peer.send(
      JSON.stringify({
        type: 'host.state',
        epoch: 4,
        status,
        uiLanguageV1: { language: 'en' },
      }),
    );
    peer.send(
      JSON.stringify({
        type: 'host.language_result',
        requestId: request['requestId'],
        ok: true,
        uiLanguageV1: { language: 'zh-CN' },
      }),
    );
    await rejected;
    assert.equal(connection.getSnapshot().uiLanguageV1?.language, 'en');
  });
});
