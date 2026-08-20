import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildHostWebSocketUrl,
  buildWebShellSessionUrl,
  DiscoveryMonitor,
  readDiscoveryFile,
  type DiscoveryResult,
} from '../discovery.ts';
import { LIVE_PROTOCOL_VERSION } from '../../shared/protocol.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function discoveryFile(mode = 0o600): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-discovery-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'daemon.json');
  await writeFile(
    path,
    JSON.stringify({
      url: 'http://127.0.0.1:9527',
      token: 'secret-not-logged',
      protocolVersion: LIVE_PROTOCOL_VERSION,
      pid: process.pid,
      instanceNonce: 'abcdefghijklmnop',
    }),
    { mode },
  );
  await chmod(path, mode);
  return path;
}

describe('Live daemon discovery', () => {
  it('accepts only a private regular discovery record', async () => {
    const result = await readDiscoveryFile(await discoveryFile());
    assert.equal(result.kind, 'ready');
    if (result.kind === 'ready') {
      assert.equal(result.record.protocolVersion, LIVE_PROTOCOL_VERSION);
      assert.equal(result.record.token, 'secret-not-logged');
    }
  });

  it('rejects group-readable discovery records', async () => {
    assert.deepEqual(await readDiscoveryFile(await discoveryFile(0o640)), {
      kind: 'invalid',
      reason: 'discovery_permissions',
    });
  });

  it('forces the fixed host route and rejects non-loopback URLs', () => {
    assert.equal(
      buildHostWebSocketUrl('http://127.0.0.1:9527/private?token=nope'),
      'ws://127.0.0.1:9527/live/host',
    );
    assert.equal(
      buildHostWebSocketUrl('http://127.23.45.67:9527'),
      'ws://127.23.45.67:9527/live/host',
    );
    assert.throws(() => buildHostWebSocketUrl('https://localhost.example.com'));
  });

  it('builds a scoped WebShell link without putting auth in the query', () => {
    const url = new URL(
      buildWebShellSessionUrl(
        {
          url: 'http://127.0.0.1:9527/ignored?old=value',
          token: 'secret-not-logged',
          protocolVersion: LIVE_PROTOCOL_VERSION,
          pid: process.pid,
          instanceNonce: 'abcdefghijklmnop',
        },
        {
          workspaceId: 'conversations/workspace',
          sessionId: 'live/session',
        },
      ),
    );

    assert.equal(url.pathname, '/session/live%2Fsession');
    assert.equal(url.searchParams.get('workspace'), 'conversations/workspace');
    assert.equal(url.searchParams.has('token'), false);
    assert.equal(
      new URLSearchParams(url.hash.slice(1)).get('token'),
      'secret-not-logged',
    );
  });

  it('coalesces overlapping polls so an older read cannot win', async () => {
    let resolveRead: ((result: DiscoveryResult) => void) | undefined;
    let reads = 0;
    const observed: DiscoveryResult[] = [];
    const monitor = new DiscoveryMonitor(
      '/unused',
      (result) => observed.push(result),
      1_000,
      async () => {
        reads += 1;
        return await new Promise<DiscoveryResult>((resolve) => {
          resolveRead = resolve;
        });
      },
    );

    const first = monitor.poll();
    const overlapping = monitor.poll();
    assert.equal(reads, 1);
    resolveRead?.({ kind: 'missing' });
    await Promise.all([first, overlapping]);

    assert.deepEqual(observed, [{ kind: 'missing' }]);
    assert.equal(reads, 1);
  });

  it('suppresses an in-flight result after the monitor stops', async () => {
    let resolveRead: ((result: DiscoveryResult) => void) | undefined;
    const observed: DiscoveryResult[] = [];
    const monitor = new DiscoveryMonitor(
      '/unused',
      (result) => observed.push(result),
      60_000,
      async () =>
        await new Promise<DiscoveryResult>((resolve) => {
          resolveRead = resolve;
        }),
    );

    monitor.start();
    monitor.stop();
    resolveRead?.({ kind: 'missing' });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(observed, []);
  });
});
