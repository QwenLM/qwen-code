import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command as runCommand, createManager } from './manager.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'runner-manager-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'state'));
  await mkdir(join(dir, 'logs'));
  const config = {
    repo: 'owner/repo',
    poolId: 'trial',
    image: `image@sha256:${'a'.repeat(64)}`,
    slots: 1,
    runnerGroupId: 1,
    labels: ['self-hosted', 'linux', 'ARM64', 'trial-only'],
    cpus: 1,
    memory: '1g',
    pidsLimit: 100,
    ttlSeconds: 2,
    shutdownGraceSeconds: 0,
    minDiskBytes: 0,
    stateDir: join(dir, 'state'),
    logDir: join(dir, 'logs'),
  };
  const calls = [];
  let container = '';
  let network = '';
  let runner;
  let counter = 0;
  let failRemove = false;
  let failNetworkRemove = false;
  let loseJit = false;
  async function command(program, args, options = {}) {
    calls.push({ program, args, options });
    if (program === 'gh') {
      const path = args.find((v) => v.startsWith('/'));
      if (path.includes('generate-jitconfig')) {
        const body = JSON.parse(options.input);
        runner = { id: ++counter, name: body.name };
        if (loseJit) throw new Error('network failure');
        return JSON.stringify({ runner, encoded_jit_config: 'jit-secret' });
      }
      if (args.includes('DELETE')) {
        runner = undefined;
        return '';
      }
      return JSON.stringify(runner ? [runner] : []);
    }
    if (args[0] === 'ps') return container ? `${container}\n` : '';
    if (args[0] === 'network' && args[1] === 'ls')
      return network ? `${network}\n` : '';
    if (args[0] === 'network' && args[1] === 'create') {
      network = `network-${counter}`;
      return network;
    }
    if (args[0] === 'network' && args[1] === 'rm') {
      if (failNetworkRemove) throw new Error('network removal failed');
      network = '';
      return '';
    }
    if (args[0] === 'info') return `${dir}\n`;
    if (args[0] === 'create') {
      container = `container-${counter}`;
      return container;
    }
    if (args[0] === 'logs') return 'runner log';
    if (args[0] === 'rm') {
      if (failRemove) throw new Error('docker unavailable');
      container = '';
    }
    return '';
  }
  return {
    config,
    calls,
    command,
    setFailRemove: (v) => {
      failRemove = v;
    },
    setLoseJit: (v) => {
      loseJit = v;
    },
    setFailNetworkRemove: (v) => {
      failNetworkRemove = v;
    },
  };
}

test('creates a new runner and container per job and keeps GitHub token out of Docker', async (t) => {
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'host-only-pat';
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  const f = await fixture(t);
  const manager = createManager(f.config, { command: f.command });
  await manager.cycle(1);
  await manager.cycle(1);
  const creates = f.calls.filter(
    (c) => c.program === 'docker' && c.args[0] === 'create',
  );
  const requests = f.calls.filter(
    (c) =>
      c.program === 'gh' &&
      c.args.includes('/repos/owner/repo/actions/runners/generate-jitconfig'),
  );
  assert.ok(
    requests.every((c) =>
      JSON.parse(c.options.input).name.startsWith('ecs-qwen-'),
    ),
  );
  assert.ok(requests.every((c) => c.options.env.GH_TOKEN === 'host-only-pat'));
  assert.equal(creates.length, 2);
  assert.notEqual(
    JSON.parse(requests[0].options.input).name,
    JSON.parse(requests[1].options.input).name,
  );
  assert.deepEqual(
    JSON.parse(requests[0].options.input).labels,
    f.config.labels,
  );
  assert.ok(
    creates.every(
      (c) =>
        !c.options.env.GH_TOKEN &&
        c.options.env.RUNNER_JIT_CONFIG === 'jit-secret',
    ),
  );
  assert.deepEqual(
    creates.map((c) => c.args[c.args.indexOf('--network') + 1]),
    ['network-1', 'network-2'],
  );
  const networks = f.calls.filter(
    (c) =>
      c.program === 'docker' &&
      c.args[0] === 'network' &&
      c.args[1] === 'create',
  );
  assert.equal(networks.length, 2);
  assert.ok(
    networks.every((c) =>
      c.args.includes('com.docker.network.bridge.enable_icc=false'),
    ),
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm').length,
    2,
  );
});

test('failed cleanup blocks replacement until recovery cleans the old container', async (t) => {
  const f = await fixture(t);
  const manager = createManager(f.config, { command: f.command });
  f.setFailRemove(true);
  await assert.rejects(manager.cycle(1), /docker unavailable/);
  await assert.rejects(manager.cycle(1), /docker unavailable/);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
  );
  f.setFailRemove(false);
  await manager.cycle(1);
  const ops = f.calls
    .filter((c) => c.program === 'docker')
    .map((c) => c.args[0]);
  assert.ok(ops.lastIndexOf('rm') > ops.lastIndexOf('create'));
  assert.equal(ops.filter((op) => op === 'create').length, 2);
});

test('lost JIT response reconciles the recorded name before requesting another', async (t) => {
  const f = await fixture(t);
  const manager = createManager(f.config, { command: f.command });
  f.setLoseJit(true);
  await assert.rejects(manager.cycle(1), /network failure/);
  await assert.rejects(readFile(join(f.config.stateDir, 'slot-1.json')), {
    code: 'ENOENT',
  });
  assert.ok(
    f.calls.some((c) => c.program === 'gh' && c.args.includes('DELETE')),
  );
  f.setLoseJit(false);
  await manager.cycle(1);
});

test('an unconfirmed JIT request blocks replacement when no runner can be found', async (t) => {
  const f = await fixture(t);
  const command = (program, args, options) => {
    if (
      program === 'gh' &&
      args.includes('/repos/owner/repo/actions/runners/generate-jitconfig')
    ) {
      return Promise.reject(new Error('connection lost'));
    }
    return f.command(program, args, options);
  };
  const manager = createManager(f.config, { command });
  await assert.rejects(manager.cycle(1), /manual reconciliation/);
  await assert.rejects(manager.cycle(1), /manual reconciliation/);
  const state = JSON.parse(
    await readFile(join(f.config.stateDir, 'slot-1.json'), 'utf8'),
  );
  assert.equal(state.uncertain, true);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    0,
  );
});

test('a failed container start is cleaned up before another cycle', async (t) => {
  const f = await fixture(t);
  let fail = true;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'start' && fail) {
      fail = false;
      return Promise.reject(new Error('start failed'));
    }
    return f.command(program, args, options);
  };
  const manager = createManager(f.config, { command });
  await assert.rejects(manager.cycle(1), /start failed/);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm').length,
    1,
  );
  await manager.cycle(1);
});

test('watchdog removes a container that does not exit', async (t) => {
  const f = await fixture(t);
  f.config.ttlSeconds = 0.01;
  const command = (program, args, options) =>
    program === 'docker' && args[0] === 'wait'
      ? new Promise(() => {})
      : f.command(program, args, options);
  await createManager(f.config, { command }).cycle(1);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm').length,
    1,
  );
});

test('checks Docker root disk rather than the state directory', async (t) => {
  const f = await fixture(t);
  let checked;
  const manager = createManager(f.config, {
    command: f.command,
    statfs: async (path) => {
      checked = path;
      return { bavail: 0, bsize: 4096 };
    },
  });
  f.config.minDiskBytes = 1;
  await assert.rejects(manager.cycle(1), /Insufficient disk capacity/);
  assert.equal(checked, join(f.config.stateDir, '..'));
  assert.equal(f.calls.filter((c) => c.program === 'gh').length, 0);
  const info = f.calls.find(
    (c) => c.program === 'docker' && c.args[0] === 'info',
  );
  assert.equal(info.options.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
});

test('rejects same-name runner with a different ID without deleting it', async (t) => {
  const f = await fixture(t);
  const state = {
    name: 'qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    runnerId: 42,
    uncertain: false,
  };
  await writeFile(
    join(f.config.stateDir, 'slot-1.json'),
    JSON.stringify(state),
  );
  const command = (program, args, options) => {
    if (program === 'gh' && args.includes('--paginate'))
      return Promise.resolve(JSON.stringify([{ name: state.name, id: 43 }]));
    return f.command(program, args, options);
  };
  await assert.rejects(
    createManager(f.config, { command }).cycle(1),
    /identity mismatch/,
  );
  assert.ok(
    !f.calls.some((c) => c.program === 'gh' && c.args.includes('DELETE')),
  );
  assert.equal(
    JSON.parse(await readFile(join(f.config.stateDir, 'slot-1.json'), 'utf8'))
      .runnerId,
    42,
  );
});

test('reconciles a legacy identity on a later page before registering its replacement', async (t) => {
  const f = await fixture(t);
  const name = 'qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  await writeFile(
    join(f.config.stateDir, 'slot-1.json'),
    JSON.stringify({
      name,
      runnerId: 42,
      uncertain: false,
    }),
  );
  let deleted = false;
  const command = (program, args, options) => {
    if (program === 'gh' && args.includes('--paginate') && !deleted) {
      assert.ok(!args.includes('--slurp'));
      assert.equal(args[args.indexOf('--jq') + 1], '.runners | @json');
      return Promise.resolve('[]\n' + JSON.stringify([{ name, id: 42 }]));
    }
    if (
      program === 'gh' &&
      args.includes('/repos/owner/repo/actions/runners/42')
    ) {
      deleted = true;
    }
    if (
      program === 'gh' &&
      args.includes('/repos/owner/repo/actions/runners/generate-jitconfig')
    ) {
      assert.ok(
        deleted,
        'legacy registration must be removed before replacement',
      );
    }
    return f.command(program, args, options);
  };
  await createManager(f.config, { command }).cycle(1);
  assert.ok(deleted);
});

test('startup reclaims a live container before replenishing after a crash', async (t) => {
  const f = await fixture(t);
  const previousPath = process.env.PATH;
  await writeFile(join(f.config.stateDir, 'flock'), '#!/bin/sh\nexec cat\n', {
    mode: 0o755,
  });
  process.env.PATH = `${f.config.stateDir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  await writeFile(
    join(f.config.stateDir, 'slot-1.json'),
    JSON.stringify({
      name: 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      runnerId: 42,
      uncertain: false,
    }),
  );
  let oldContainer = true;
  let manager;
  const command = async (program, args, options) => {
    if (program === 'docker' && args[0] === 'ps') {
      if (args.includes('--format')) {
        // Docker quiet mode overrides --format, as on the trial host.
        return oldContainer
          ? args.includes('-aq')
            ? 'old-container'
            : '1'
          : '';
      }
      if (oldContainer) return 'old-container';
    }
    if (
      program === 'docker' &&
      args[0] === 'rm' &&
      args.includes('old-container')
    ) {
      oldContainer = false;
      return '';
    }
    if (
      program === 'gh' &&
      args.includes('/repos/owner/repo/actions/runners/generate-jitconfig')
    ) {
      assert.equal(
        oldContainer,
        false,
        'remove old container before registration',
      );
    }
    if (program === 'docker' && args[0] === 'start') manager.stop();
    return f.command(program, args, options);
  };
  manager = createManager(f.config, { command });
  await manager.start();
  assert.equal(oldContainer, false);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
  );
});

test('accepts immutable local image IDs and rejects mutable tags and invalid configuration', async (t) => {
  const f = await fixture(t);
  assert.doesNotThrow(() =>
    createManager({ ...f.config, image: `sha256:${'b'.repeat(64)}` }),
  );
  assert.throws(
    () => createManager({ ...f.config, image: 'image:latest' }),
    /Invalid manager configuration/,
  );
  assert.throws(
    () =>
      createManager({ ...f.config, dockerSocket: 'tcp://example.com:2375' }),
    /Invalid manager configuration/,
  );
  assert.throws(
    () => createManager({ ...f.config, cpus: Infinity }),
    /Invalid manager configuration/,
  );
});

test('does not expose malformed GitHub responses in errors', async (t) => {
  const f = await fixture(t);
  const command = (program, args, options) => {
    if (
      program === 'gh' &&
      args.some((arg) => arg.includes('generate-jitconfig'))
    ) {
      return f
        .command(program, args, options)
        .then(() => 'malformed-secret-token');
    }
    return f.command(program, args, options);
  };
  await assert.rejects(
    createManager(f.config, { command }).cycle(1),
    (error) => {
      assert.match(error.message, /Invalid JSON response/);
      assert.doesNotMatch(error.message, /malformed-secret-token/);
      return true;
    },
  );
});

test('HTTP 429 rejection does not leave uncertain state and the next cycle can retry', async (t) => {
  const f = await fixture(t);
  const fakeGh = join(f.config.stateDir, 'gh');
  await writeFile(
    fakeGh,
    '#!/bin/sh\necho "gh: API rate limit exceeded (HTTP 429)" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  let rejected = false;
  const command = (program, args, options) => {
    if (
      program === 'gh' &&
      args.includes('/repos/owner/repo/actions/runners/generate-jitconfig') &&
      !rejected
    ) {
      rejected = true;
      return runCommand(fakeGh, [], { env: {} });
    }
    return f.command(program, args, options);
  };
  const manager = createManager(f.config, { command });
  await assert.rejects(manager.cycle(1), (error) => error.status === 429);
  await assert.rejects(readFile(join(f.config.stateDir, 'slot-1.json')), {
    code: 'ENOENT',
  });
  await manager.cycle(1);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
  );
});

test('network cleanup failure prevents new runner and is reconciled on the next cycle', async (t) => {
  const f = await fixture(t);
  const manager = createManager(f.config, { command: f.command });
  f.setFailNetworkRemove(true);
  await assert.rejects(manager.cycle(1), /network removal failed/);
  await assert.rejects(manager.cycle(1), /network removal failed/);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
  );
  f.setFailNetworkRemove(false);
  await manager.cycle(1);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    2,
  );
});

test('a lost network create response is recovered using labels', async (t) => {
  const f = await fixture(t);
  const command = async (program, args, options) => {
    const result = await f.command(program, args, options);
    if (program === 'docker' && args[0] === 'network' && args[1] === 'create')
      throw new Error('network create response lost');
    return result;
  };
  await assert.rejects(
    createManager(f.config, { command }).cycle(1),
    /network create response lost/,
  );
  assert.equal(
    f.calls.filter(
      (c) =>
        c.program === 'docker' && c.args[0] === 'network' && c.args[1] === 'rm',
    ).length,
    1,
  );
  await assert.rejects(readFile(join(f.config.stateDir, 'slot-1.json')), {
    code: 'ENOENT',
  });
});

test('network deletion is verified even when docker reports success', async (t) => {
  const f = await fixture(t);
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'network' && args[1] === 'rm')
      return Promise.resolve('');
    return f.command(program, args, options);
  };
  const manager = createManager(f.config, { command });
  await assert.rejects(manager.cycle(1), /Network cleanup failed/);
  await assert.rejects(manager.cycle(1), /Network cleanup failed/);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
  );
});
