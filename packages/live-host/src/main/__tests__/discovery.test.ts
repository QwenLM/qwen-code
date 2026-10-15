import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function discoveryFile(
  mode = 0o600,
  configPath?: unknown,
): Promise<string> {
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
      ...(configPath !== undefined ? { configPath } : {}),
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
      assert.equal(result.record.configPath, undefined);
    }
  });

  it('accepts a custom absolute config.json path, including spaces and Unicode', async () => {
    const configPath = join(tmpdir(), 'Live config 中文', 'config.json');
    const result = await readDiscoveryFile(
      await discoveryFile(0o600, configPath),
    );
    assert.equal(result.kind, 'ready');
    if (result.kind === 'ready')
      assert.equal(result.record.configPath, configPath);
  });

  it('rejects malformed, relative, non-config and unbounded config paths', async () => {
    for (const configPath of [
      null,
      1,
      true,
      {},
      [],
      '',
      'relative/config.json',
      '~/config.json',
      'file:///tmp/config.json',
      join(tmpdir(), 'config.toml'),
      join(tmpdir(), 'config.json.exe'),
      join(tmpdir(), 'bad\0', 'config.json'),
      join(tmpdir(), 'x'.repeat(4_096), 'config.json'),
    ]) {
      assert.deepEqual(
        await readDiscoveryFile(await discoveryFile(0o600, configPath)),
        { kind: 'invalid', reason: 'discovery_shape' },
      );
    }
  });

  it('notifies discovery consumers when only the configuration path changes', async () => {
    const firstPath = join(tmpdir(), 'live-one', 'config.json');
    const nextPath = join(tmpdir(), 'live-two', 'config.json');
    const path = await discoveryFile(0o600, firstPath);
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    const observed: DiscoveryResult[] = [];
    const monitor = new DiscoveryMonitor(path, (result) =>
      observed.push(result),
    );

    await monitor.poll();
    await writeFile(path, JSON.stringify({ ...record, configPath: nextPath }));
    await monitor.poll();
    await monitor.poll();

    assert.equal(observed.length, 2);
    const [first, next] = observed;
    assert(first?.kind === 'ready' && next?.kind === 'ready');
    assert.notEqual(first.signature, next.signature);
    assert.equal(first.record.configPath, firstPath);
    assert.equal(next.record.configPath, nextPath);
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
