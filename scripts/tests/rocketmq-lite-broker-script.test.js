/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// scripts/rocketmq-lite-broker.sh manages processes on a developer's machine
// as well as on CI: it must never stop a process it did not start, and a
// start that fails part way must not leave what it did start behind. These
// cases drive the real script against stand-in components — a NameServer,
// broker and proxy that bind the ports from the generated configuration, run
// as the launcher's grandchild like the real JVMs, and print the real ready
// lines — plus a stand-in mqadmin, so no RocketMQ download is needed.

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/rocketmq-lite-broker.sh');
const chooser = resolve('.github/scripts/choose-rocketmq-ports.mjs');
const version = '5.5.1';
const portLookup =
  spawnSync('sh', ['-c', 'command -v lsof || command -v ss']).status === 0;

const component = `
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
const [kind, , conf] = process.argv.slice(2);
const text = readFileSync(conf, 'utf8');
const ports = kind === 'proxy'
  ? [/"grpcServerPort": (\\d+)/, /"remotingListenPort": (\\d+)/]
      .map((pattern) => Number(pattern.exec(text)[1]))
  : [Number(/^listenPort=(\\d+)$/m.exec(text)[1])];
const listen = (port) => new Promise((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(port, '127.0.0.1', () => done(server));
});
try {
  for (const port of ports) await listen(port);
} catch (error) {
  console.log('bind failed ' + error.code);
  process.exit(1);
}
console.log(kind === 'proxy' ? 'The proxy startup successfully' : 'The ' + kind + ' boot success');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

// Answers like mqadmin: " success." and the configuration it echoes, unless
// the named group is to be refused, which mqadmin reports with exit code 0.
const admin = `#!/usr/bin/env bash
if [ -n "\${FAKE_ADMIN_REFUSE:-}" ] && [[ " $* " == *" \${FAKE_ADMIN_REFUSE} "* ]]; then
  echo "[error] refused"
  exit 0
fi
topic=""
previous=""
for arg in "$@"; do
  [ "\${previous}" != "-t" ] || topic="\${arg}"
  previous="\${arg}"
done
echo "create success."
echo "topicName=\${topic} $*"
`;

async function freePorts(count) {
  const servers = [];
  for (let i = 0; i < count; i++) {
    const server = createServer();
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
  }
  const ports = servers.map((server) => server.address().port);
  await Promise.all(
    servers.map((server) => new Promise((done) => server.close(done))),
  );
  return ports;
}

async function isFree(port) {
  const server = createServer();
  return new Promise((done) => {
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

// The holder binds 0.0.0.0, and a bind probe on 127.0.0.1 still succeeds
// against a wildcard listener (macOS lets the specific address through), so
// freeing a held port has to be checked the way the script checks it: by the
// port's listener. A killed holder also closes its socket when it exits, not
// when the kill returns.
const listenerOf = (port) =>
  spawnSync(
    'sh',
    [
      '-c',
      `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2> /dev/null || ` +
        `ss -ltnpH "sport = :${port}" 2> /dev/null | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'`,
    ],
    { encoding: 'utf8' },
  ).stdout.trim();

async function waitForNoListener(port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!listenerOf(port)) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return false;
}

// A listener this test owns, in a process of its own like any other user's.
async function foreignListener(port) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:net').createServer().listen(${port}, '127.0.0.1', () => console.log('listening'))`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise((done, fail) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) done();
    });
    child.once('exit', () => fail(new Error('the foreign listener exited')));
  });
  return child;
}

describe.skipIf(!portLookup)('rocketmq-lite-broker.sh process handling', () => {
  let work;
  let ports;
  let env;
  let holderDir;
  const holderPids = [];
  const foreign = [];

  beforeEach(async () => {
    holderDir = undefined;
    work = mkdtempSync(join(tmpdir(), 'rmq-lite-script-'));
    const bin = join(work, `rocketmq-all-${version}-bin-release`, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(work, 'component.mjs'), component);
    // The launch scripts start the JVM through a second shell, so the
    // process that binds the port is the launcher's grandchild.
    writeFileSync(
      join(work, 'run.sh'),
      `node "${join(work, 'component.mjs')}" "$@"\n`,
    );
    for (const [name, kind] of [
      ['mqnamesrv', 'namesrv'],
      ['mqbroker', 'broker'],
      ['mqproxy', 'proxy'],
    ]) {
      writeFileSync(
        join(bin, name),
        `#!/usr/bin/env bash\nbash "${join(work, 'run.sh')}" ${kind} "$@"\n`,
      );
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(join(bin, 'mqadmin'), admin);
    chmodSync(join(bin, 'mqadmin'), 0o755);
    ports = await freePorts(4);
    env = {
      ...process.env,
      RMQ_VERSION: version,
      RMQ_WORK_DIR: work,
      RMQ_JAVA_HOME: work,
      RMQ_NAMESRV_PORT: String(ports[0]),
      RMQ_BROKER_PORT: String(ports[1]),
      RMQ_PROXY_GRPC_PORT: String(ports[2]),
      RMQ_PROXY_REMOTING_PORT: String(ports[3]),
      RMQ_EXTRA_GROUPS: 'qwen-script-test-extra',
    };
  });

  afterEach(() => {
    spawnSync('bash', [script, 'stop'], { env, encoding: 'utf8' });
    // A regression that leaks a stand-in leaves it running; its command line
    // names this test's own work dir, so nothing else matches.
    spawnSync('pkill', ['-f', work]);
    for (const child of foreign.splice(0)) child.kill();
    // Holders are tracked by pid, not by their records: a regression that
    // drops the records without killing them would otherwise leave Node
    // processes parked on this machine after a red run.
    for (const pid of holderPids.splice(0)) {
      try {
        process.kill(pid);
      } catch {
        // Holder already gone.
      }
    }
    if (holderDir && existsSync(holderDir)) {
      rmSync(holderDir, { recursive: true, force: true });
    }
    rmSync(work, { recursive: true, force: true });
  });

  const run = (command, extra = {}) =>
    spawnSync('bash', [script, command], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 60_000,
    });
  const pidFiles = () =>
    ['namesrv', 'broker', 'proxy'].filter((name) =>
      existsSync(join(work, `${name}.pid`)),
    );
  // Runs the real chooser the workflow lane runs and returns its NAME=VALUE
  // output, remembering the holder directory so a failed case cannot leak it.
  const choosePorts = () => {
    const picked = spawnSync(process.execPath, [chooser], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(picked.status).toBe(0);
    const chosen = Object.fromEntries(
      picked.stdout
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
    holderDir = chosen.RMQ_HOLDER_DIR;
    for (const file of readdirSync(holderDir)) {
      holderPids.push(Number(readFileSync(join(holderDir, file), 'utf8')));
    }
    return chosen;
  };
  const parkedPorts = (chosen) =>
    [
      'RMQ_NAMESRV_PORT',
      'RMQ_BROKER_PORT',
      'RMQ_PROXY_GRPC_PORT',
      'RMQ_PROXY_REMOTING_PORT',
    ].map((name) => Number(chosen[name]));

  it('stops what a failed start launched and leaves a foreign listener', async () => {
    const holder = await foreignListener(ports[1]);
    foreign.push(holder);

    const result = run('start');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `port ${ports[1]} for the broker is already in use`,
    );
    expect(result.stderr).toContain('stopping what it started: namesrv');
    expect(await isFree(ports[0])).toBe(true);
    expect(holder.exitCode).toBeNull();
    expect(await isFree(ports[1])).toBe(false);
    expect(pidFiles()).toEqual([]);
  }, 200_000);

  it('rolls every component back when provisioning fails', async () => {
    const result = run('start', {
      FAKE_ADMIN_REFUSE: 'qwen-script-test-extra',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'could not create LITE group qwen-script-test-extra',
    );
    expect(result.stderr).toContain(
      'stopping what it started: proxy broker namesrv',
    );
    for (const port of ports) expect(await isFree(port)).toBe(true);
    expect(pidFiles()).toEqual([]);
  }, 200_000);

  it('leaves a running cluster alone when a second start fails, and stop stops it', async () => {
    expect(run('start').status).toBe(0);
    const recorded = readFileSync(join(work, 'proxy.pid'), 'utf8').trim();
    expect(recorded).toMatch(new RegExp(`^\\d+ ${ports[2]}$`));

    const again = run('start');

    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain(
      `port ${ports[0]} for the namesrv is already in use`,
    );
    expect(again.stderr).not.toContain('stopping what it started');
    for (const port of ports) expect(await isFree(port)).toBe(false);

    // stop reads each component's port from its pid file.
    const stopped = run('stop', {
      RMQ_NAMESRV_PORT: '1',
      RMQ_BROKER_PORT: '1',
      RMQ_PROXY_GRPC_PORT: '1',
    });
    expect(stopped.status).toBe(0);
    for (const port of ports) expect(await isFree(port)).toBe(true);
    expect(pidFiles()).toEqual([]);
  }, 200_000);

  it('takes over the ports the chooser parked and releases the rest', async () => {
    const chosen = choosePorts();
    const parked = parkedPorts(chosen);
    expect(existsSync(chosen.RMQ_HOLDER_DIR)).toBe(true);

    // start consumes the chooser's holder records exactly as the workflow
    // lane does; a record its `read` cannot parse aborts the start here.
    const started = run('start', chosen);

    expect(started.status).toBe(0);
    // Every holder this job owned is gone, including the broker companions,
    // and each parked port now belongs to the component that took it over.
    expect(existsSync(chosen.RMQ_HOLDER_DIR)).toBe(false);
    for (const port of parked) expect(await isFree(port)).toBe(false);

    expect(run('stop', chosen).status).toBe(0);
    for (const port of parked) expect(await isFree(port)).toBe(true);
    expect(pidFiles()).toEqual([]);
  }, 200_000);

  it('releases the ports the chooser parked on stop', async () => {
    const chosen = choosePorts();

    // stop reads the same holder records, for the rollback and stop paths the
    // chooser's holders are meant to survive.
    expect(run('stop', chosen).status).toBe(0);

    expect(existsSync(chosen.RMQ_HOLDER_DIR)).toBe(false);
    for (const port of parkedPorts(chosen)) {
      expect(await waitForNoListener(port)).toBe(true);
    }
  }, 200_000);
});
