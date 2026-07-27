import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { buildHostWebSocketUrl, readDiscoveryFile } from '../discovery.ts';
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
});
