import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
    labels: ['self-hosted', 'ecs-qwen-ephemeral'],
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
  const containers = new Map();
  const networks = new Map();
  let runner;
  let counter = 0;
  let foreignCounter = 0;
  let failRemove = false;
  let failNetworkRemove = false;
  let keepContainerAfterRemove = false;
  let loseJit = false;
  const labelsFromArgs = (args) => {
    const labels = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== '--label' || typeof args[i + 1] !== 'string') continue;
      const at = args[i + 1].indexOf('=');
      if (at > 0) labels[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1);
    }
    return labels;
  };
  const filtersFromArgs = (args) => {
    const filters = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--filter' && typeof args[i + 1] === 'string')
        filters.push(args[i + 1].replace(/^label=/, ''));
    }
    return filters;
  };
  const matchesFilters = (entry, args) =>
    filtersFromArgs(args).every((filter) => {
      const at = filter.indexOf('=');
      if (at < 0) return true;
      return entry.labels[filter.slice(0, at)] === filter.slice(at + 1);
    });
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
    if (args[0] === 'ps') {
      const matched = [...containers.entries()].filter(([, entry]) =>
        matchesFilters(entry, args),
      );
      if (!matched.length) return '';
      if (args.includes('--format'))
        return `${matched.map(([, entry]) => entry.labels['qwen.slot'] ?? '').join('\n')}\n`;
      return `${matched.map(([id]) => id).join('\n')}\n`;
    }
    if (args[0] === 'network' && args[1] === 'ls') {
      const matched = [...networks.entries()].filter(([, entry]) =>
        matchesFilters(entry, args),
      );
      return matched.length ? `${matched.map(([id]) => id).join('\n')}\n` : '';
    }
    if (args[0] === 'network' && args[1] === 'create') {
      const id = `network-${counter}`;
      networks.set(id, { labels: labelsFromArgs(args) });
      return id;
    }
    if (args[0] === 'network' && args[1] === 'rm') {
      if (failNetworkRemove) throw new Error('network removal failed');
      networks.delete(args[args.length - 1]);
      return '';
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      const entry = networks.get(args[args.length - 1]);
      return `${entry?.labels['qwen.slot'] ?? ''}\n`;
    }
    if (args[0] === 'info') return `${dir}\n`;
    if (args[0] === 'create') {
      const id = `container-${counter}`;
      containers.set(id, { labels: labelsFromArgs(args) });
      return id;
    }
    if (args[0] === 'logs') return 'runner log';
    if (args[0] === 'rm') {
      if (failRemove) throw new Error('docker unavailable');
      if (!keepContainerAfterRemove) containers.delete(args[args.length - 1]);
      return '';
    }
    if (args[0] === 'wait') return '0\n';
    if (args[0] === 'start') return '';
    return '';
  }
  return {
    config,
    calls,
    command,
    sleep: async () => {},
    addForeignNetwork(labels) {
      const id = `network-foreign-${++foreignCounter}`;
      networks.set(id, { labels });
      return id;
    },
    networkIds: () => [...networks.keys()],
    setFailRemove: (v) => {
      failRemove = v;
    },
    setLoseJit: (v) => {
      loseJit = v;
    },
    setFailNetworkRemove: (v) => {
      failNetworkRemove = v;
    },
    setKeepContainerAfterRemove: (v) => {
      keepContainerAfterRemove = v;
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
  assert.deepEqual(
    f.calls
      .filter((c) => c.program === 'gh' && c.args.includes('DELETE'))
      .map((c) => c.args.find((arg) => arg.startsWith('/'))),
    [
      '/repos/owner/repo/actions/runners/1',
      '/repos/owner/repo/actions/runners/2',
    ],
  );
  assert.equal(JSON.parse(requests[0].options.input).name, 'ecs-qwen-trial-01');
  assert.equal(JSON.parse(requests[1].options.input).name, 'ecs-qwen-trial-01');
  assert.notEqual(
    creates[0].args.find((arg) => arg.startsWith('qwen.instance=')),
    creates[1].args.find((arg) => arg.startsWith('qwen.instance=')),
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
  await createManager(f.config, { command: f.command }).cycle(1);
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
    runnerName: 'ecs-qwen-trial-01',
    runnerId: 42,
    uncertain: false,
  };
  await writeFile(
    join(f.config.stateDir, 'slot-1.json'),
    JSON.stringify(state),
  );
  const command = (program, args, options) => {
    if (program === 'gh' && args.includes('--paginate'))
      return Promise.resolve(
        JSON.stringify([{ name: state.runnerName, id: 43 }]),
      );
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
  assert.doesNotThrow(() => createManager({ ...f.config, slots: 30 }));
  assert.throws(
    () => createManager({ ...f.config, slots: 65 }),
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

test('passes only the docker environment allowlist and the JIT config by name', async (t) => {
  const sentinels = {
    AWS_SECRET_ACCESS_KEY: 'sentinel-secret',
    SOME_DEPLOY_TOKEN: 'sentinel-token',
  };
  const previous = {};
  for (const key of Object.keys(sentinels)) {
    previous[key] = process.env[key];
    process.env[key] = sentinels[key];
  }
  t.after(() => {
    for (const key of Object.keys(sentinels)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const f = await fixture(t);
  await createManager(f.config, { command: f.command }).cycle(1);
  const create = f.calls.find(
    (c) => c.program === 'docker' && c.args[0] === 'create',
  );
  const allowed = [
    'DOCKER_CONFIG',
    'DOCKER_HOST',
    'HOME',
    'PATH',
    'RUNNER_JIT_CONFIG',
    'XDG_RUNTIME_DIR',
  ];
  assert.deepEqual(
    Object.keys(create.options.env).filter((key) => !allowed.includes(key)),
    [],
  );
  assert.ok(!JSON.stringify(create.options.env).includes('sentinel'));
  assert.ok(!JSON.stringify(create.args).includes('sentinel'));
  assert.equal(
    create.args[create.args.indexOf('--log-driver') + 1],
    'json-file',
  );
  const at = create.args.indexOf('--env');
  assert.equal(create.args[at + 1], 'RUNNER_JIT_CONFIG');
});

test('labels pool and slot on create and honours recovery filters', async (t) => {
  const f = await fixture(t);
  const foreign = f.addForeignNetwork({
    'qwen.pool': 'other',
    'qwen.slot': '9',
  });
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
  const created = f.calls.find(
    (c) =>
      c.program === 'docker' &&
      c.args[0] === 'network' &&
      c.args[1] === 'create',
  );
  assert.ok(created.args.includes('qwen.pool=trial'));
  assert.ok(created.args.includes('qwen.slot=1'));
  const removed = f.calls
    .filter(
      (c) =>
        c.program === 'docker' && c.args[0] === 'network' && c.args[1] === 'rm',
    )
    .map((c) => c.args[c.args.length - 1]);
  assert.deepEqual(removed, ['network-1']);
  assert.ok(f.networkIds().includes(foreign));
});

test('container cleanup failure blocks replenishment even when docker reports success', async (t) => {
  const f = await fixture(t);
  f.setKeepContainerAfterRemove(true);
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1), /Container cleanup failed/);
  const state = JSON.parse(
    await readFile(join(f.config.stateDir, 'slot-1.json'), 'utf8'),
  );
  assert.ok(state.name);
  assert.equal(state.runnerId, 1);
});

test('rejects corrupted slot state without deleting a runner', async (t) => {
  const validName = 'qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const cases = [
    {
      label: 'foreign prefix',
      state: {
        name: 'qwen-other-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        runnerId: 42,
        uncertain: false,
      },
    },
    {
      label: 'non-UUID suffix',
      state: {
        name: 'qwen-trial-1-not-a-uuid',
        runnerId: 42,
        uncertain: false,
      },
    },
    {
      label: 'non-boolean uncertain',
      state: { name: validName, runnerId: 42, uncertain: 'no' },
    },
    {
      label: 'foreign display name',
      state: {
        name: validName,
        runnerName: 'ecs-qwen-other-01',
        runnerId: 42,
        uncertain: false,
      },
    },
    {
      label: 'zero runner id',
      state: { name: validName, runnerId: 0, uncertain: false },
    },
  ];
  for (const item of cases) {
    const f = await fixture(t);
    await writeFile(
      join(f.config.stateDir, 'slot-1.json'),
      JSON.stringify(item.state),
    );
    await assert.rejects(
      createManager(f.config, { command: f.command }).cycle(1),
      /Invalid slot state/,
      item.label,
    );
    assert.ok(
      !f.calls.some((c) => c.program === 'gh' && c.args.includes('DELETE')),
      item.label,
    );
  }
});

test('backs off on a failed container even after the startup window', async (t) => {
  const f = await fixture(t);
  f.config.ttlSeconds = 120;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'wait') {
      now += 31000;
      return Promise.resolve('126\n');
    }
    return f.command(program, args, options);
  };
  const result = await createManager(f.config, { command }).cycle(1);
  assert.equal(result.earlyExit, true);
});

test('backs off before the next JIT request after a failed container', async (t) => {
  const f = await fixture(t);
  const previousPath = process.env.PATH;
  await writeFile(join(f.config.stateDir, 'flock'), '#!/bin/sh\nexec cat\n', {
    mode: 0o755,
  });
  process.env.PATH = `${f.config.stateDir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const sleeps = [];
  let manager;
  let jitRequests = 0;
  const command = async (program, args, options) => {
    if (
      program === 'gh' &&
      args.includes('/repos/owner/repo/actions/runners/generate-jitconfig')
    ) {
      jitRequests += 1;
      if (jitRequests > 1) manager.stop();
    }
    if (program === 'docker' && args[0] === 'wait') return '127\n';
    return f.command(program, args, options);
  };
  manager = createManager(f.config, {
    command,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await manager.start();
  // The 1 s poll that races `docker wait` also goes through the injected sleep;
  // the replenishment backoff is the 60 s entry.
  assert.equal(sleeps.filter((ms) => ms === 60000).length, 1);
  assert.equal(sleeps.at(-1), 60000);
  assert.equal(jitRequests, 2);
});

test('does not penalize a fast successful container', async (t) => {
  const f = await fixture(t);
  const result = await createManager(f.config, { command: f.command }).cycle(1);
  assert.equal(result.earlyExit, false);
});

test('backs off when docker wait cannot determine container status', async (t) => {
  const f = await fixture(t);
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'wait')
      return Promise.reject(new Error('Docker disconnected'));
    return f.command(program, args, options);
  };
  const result = await createManager(f.config, { command }).cycle(1);
  assert.equal(result.earlyExit, true);
});

test('starts through a symlink and reports invalid configuration', async (t) => {
  const f = await fixture(t);
  const link = join(f.config.stateDir, 'manager.mjs');
  await symlink(new URL('./manager.mjs', import.meta.url), link);
  const result = spawnSync(
    process.execPath,
    [link, join(f.config.stateDir, 'missing.json')],
    {
      env: { ...process.env, GH_TOKEN: 'test-only' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^manager: /);
});
