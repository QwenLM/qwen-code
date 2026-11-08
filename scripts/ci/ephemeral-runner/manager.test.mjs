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
import {
  backoffDelay,
  command as runCommand,
  createManager,
} from './manager.mjs';

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
  let failDelete = false;
  let deleteStatus = 422;
  let jitFailure = null;
  let listFailure = null;
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
        if (jitFailure) throw jitFailure();
        if (loseJit) throw new Error('network failure');
        return JSON.stringify({ runner, encoded_jit_config: 'jit-secret' });
      }
      if (args.includes('DELETE')) {
        if (failDelete) {
          const error = new Error(`gh failed (exit 1, HTTP ${deleteStatus})`);
          error.status = deleteStatus;
          throw error;
        }
        runner = undefined;
        return '';
      }
      if (listFailure) throw listFailure();
      return JSON.stringify(runner ? [runner] : []);
    }
    if (args[0] === 'inspect') {
      const entry = containers.get(args[args.length - 1]);
      return `${entry?.labels['qwen.instance'] ?? ''}\n`;
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
      if (args.some((value) => String(value).includes('qwen.instance')))
        return `${entry?.labels['qwen.instance'] ?? ''}\n`;
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
    setFailDelete: (v, status = 422) => {
      failDelete = v;
      deleteStatus = status;
    },
    setJitStatus: (status) => {
      jitFailure = () =>
        Object.assign(new Error('gh failed (exit 1)'), {
          status,
        });
    },
    setListStatus: (status) => {
      listFailure = () =>
        Object.assign(new Error('gh failed (exit 1)'), {
          status,
        });
    },
    setRunner: (value) => {
      runner = value;
    },
    addOrphanContainer(labels) {
      const id = `container-orphan-${containers.size}`;
      containers.set(id, { labels });
      return id;
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
  const registeredNames = requests.map((c) => JSON.parse(c.options.input).name);
  assert.ok(
    registeredNames.every((name) =>
      /^ecs-qwen-trial-01-[0-9a-f]{8}$/.test(name),
    ),
  );
  assert.notEqual(registeredNames[0], registeredNames[1]);
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

test('passes proxy configuration to container environment', async (t) => {
  const f = await fixture(t);
  f.config.proxy = {
    http: 'http://172.27.32.1:7890',
    https: 'http://172.27.32.1:7890',
    noProxy: 'localhost,127.0.0.1,100.100.100.200',
  };
  const manager = createManager(f.config, { command: f.command });
  await manager.cycle(1);
  const creates = f.calls.filter(
    (c) => c.program === 'docker' && c.args[0] === 'create',
  );
  assert.equal(creates.length, 1);
  const args = creates[0].args;
  // Proxy values are passed via the docker CLI env whitelist, not argv,
  // so they do not appear in `ps` output.
  const envPairs = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '--env') envPairs.push(args[i + 1]);
  }
  assert.ok(envPairs.includes('HTTP_PROXY'));
  assert.ok(envPairs.includes('HTTPS_PROXY'));
  assert.ok(envPairs.includes('NO_PROXY'));
  assert.ok(!args.some((a) => a.includes('HTTP_PROXY=')));
  assert.equal(creates[0].options.env.HTTP_PROXY, 'http://172.27.32.1:7890');
  assert.equal(creates[0].options.env.HTTPS_PROXY, 'http://172.27.32.1:7890');
  assert.equal(
    creates[0].options.env.NO_PROXY,
    'localhost,127.0.0.1,100.100.100.200',
  );
});

test('omits proxy env when proxy is not configured', async (t) => {
  const f = await fixture(t);
  const manager = createManager(f.config, { command: f.command });
  await manager.cycle(1);
  const creates = f.calls.filter(
    (c) => c.program === 'docker' && c.args[0] === 'create',
  );
  assert.equal(creates.length, 1);
  assert.ok(!creates[0].args.includes('HTTP_PROXY'));
  assert.ok(!creates[0].options.env.HTTP_PROXY);
  assert.ok(!creates[0].options.env.HTTPS_PROXY);
  assert.ok(!creates[0].options.env.NO_PROXY);
});

test('rejects invalid proxy configuration', async (t) => {
  const f = await fixture(t);
  f.config.proxy = { http: 123 };
  assert.throws(
    () => createManager(f.config, { command: f.command }),
    /Invalid proxy\.http/,
  );
  f.config.proxy = 'not-an-object';
  assert.throws(
    () => createManager(f.config, { command: f.command }),
    /Invalid proxy configuration/,
  );
  f.config.proxy = ['not-an-object'];
  assert.throws(
    () => createManager(f.config, { command: f.command }),
    /Invalid proxy configuration/,
  );
  f.config.proxy = { http: '' };
  assert.throws(
    () => createManager(f.config, { command: f.command }),
    /Invalid proxy\.http/,
  );
  f.config.proxy = { http: 'http://user:pass@proxy.example:7890' };
  assert.throws(
    () => createManager(f.config, { command: f.command }),
    /Invalid proxy\.http/,
  );
  f.config.proxy = { https: 'http://user@proxy.example:7890' };
  assert.throws(
    () => createManager(f.config, { command: f.command }),
    /Invalid proxy\.https/,
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
    runnerName: 'ecs-qwen-trial-01-deadbeef',
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

test('backoffDelay escalates exponentially within jittered bounds', (t) => {
  const assertBounds = (failures, isRateLimited, ceiling) => {
    const delay = backoffDelay(failures, isRateLimited);
    assert.ok(
      delay >= ceiling / 2 && delay <= ceiling,
      `${delay} outside [${ceiling / 2}, ${ceiling}]`,
    );
  };
  // Rate-limited: 30s base, 300s cap
  assertBounds(1, true, 30000);
  assertBounds(2, true, 60000);
  assertBounds(3, true, 120000);
  assertBounds(4, true, 240000);
  assertBounds(5, true, 300000);
  assertBounds(6, true, 300000);
  assertBounds(100, true, 300000);
  // Non-rate-limited: 10s base, 60s cap
  assertBounds(1, false, 10000);
  assertBounds(2, false, 20000);
  assertBounds(3, false, 40000);
  assertBounds(4, false, 60000);
  assertBounds(5, false, 60000);
  // Jitter spreads simultaneous sleepers instead of waking them in lockstep.
  t.mock.method(Math, 'random', () => 0);
  assert.equal(backoffDelay(1, true), 15000);
  t.mock.method(Math, 'random', () => 0.999999);
  assert.ok(backoffDelay(1, true) > 29990);
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
      label: 'malformed name suffix',
      state: {
        name: validName,
        runnerName: 'ecs-qwen-trial-01-not-hex!',
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

test('loads the bare runnerName that main wrote before the suffix', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.config.stateDir, 'slot-1.json'),
    JSON.stringify({
      name: 'qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      runnerName: 'ecs-qwen-trial-01',
      runnerId: 42,
      uncertain: false,
    }),
  );
  f.setRunner({ id: 42, name: 'ecs-qwen-trial-01' });
  await createManager(f.config, { command: f.command }).cycle(1);
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/42'),
    ),
    'the legacy registration is deleted, not wedged by validation',
  );
  const request = f.calls.find(
    (c) =>
      c.program === 'gh' &&
      c.args.includes('/repos/owner/repo/actions/runners/generate-jitconfig'),
  );
  assert.match(
    JSON.parse(request.options.input).name,
    /^ecs-qwen-trial-01-[0-9a-f]{8}$/,
    'the replacement registers under a suffixed name',
  );
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
  // The 1 s poll that races `docker wait` also goes through the injected
  // sleep; the replenishment backoff is a run of sixty 1 s slices ending
  // the log, and it must stay sliced so stop() can interrupt it.
  assert.equal(sleeps.filter((ms) => ms === 60000).length, 0);
  assert.deepEqual(sleeps.slice(-60), Array(60).fill(1000));
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

test('an orphaned container is reclaimed from its instance label', async (t) => {
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  const manager = createManager(f.config, { command: f.command });
  await manager.cycle(1);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
    'replenishes instead of wedging on the orphan',
  );
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'docker' &&
        c.args[0] === 'rm' &&
        c.args.includes('container-orphan-0'),
    ),
  );
});

test('an orphaned container with an unidentifiable label still blocks replacement', async (t) => {
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-other-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1), /manual reconciliation/);
  await assert.rejects(manager.cycle(1), /manual reconciliation/);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    0,
  );
});

test('label recovery deletes the orphaned suffixed registration', async (t) => {
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-cafe1234' });
  await createManager(f.config, { command: f.command }).cycle(1);
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ),
    'the registration is deleted even though its display name is suffixed',
  );
});

test('disagreeing resource labels are reported as ambiguous, not missing', async (t) => {
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  });
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1), /labels disagree/);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm').length,
    0,
    'an ambiguous identity still deletes nothing',
  );
});

test('a rejected runner deletion keeps slot state so the next cycle retries it', async (t) => {
  const f = await fixture(t);
  const manager = createManager(f.config, { command: f.command });
  f.setFailDelete(true);
  await assert.rejects(manager.cycle(1), /deletion was rejected/);
  const state = JSON.parse(
    await readFile(join(f.config.stateDir, 'slot-1.json'), 'utf8'),
  );
  assert.equal(state.runnerId, 1, 'retains the identity that must be deleted');
  await assert.rejects(manager.cycle(1), /deletion was rejected/);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
    'does not register a replacement while the old registration survives',
  );
  f.setFailDelete(false);
  await manager.cycle(1);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    2,
  );
});

test('a rejected JIT request reconciles a leftover registration instead of orphaning it', async (t) => {
  const f = await fixture(t);
  let rejectedName;
  let rejected = false;
  const command = (program, args, options) => {
    if (
      program === 'gh' &&
      args.includes('/repos/owner/repo/actions/runners/generate-jitconfig') &&
      !rejected
    ) {
      rejected = true;
      rejectedName = JSON.parse(options.input).name;
      f.setRunner({ id: 77, name: rejectedName });
      const error = new Error('gh failed (exit 1, HTTP 422)');
      error.status = 422;
      return Promise.reject(error);
    }
    return f.command(program, args, options);
  };
  const manager = createManager(f.config, { command });
  await assert.rejects(manager.cycle(1), (error) => error.status === 422);
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ),
    'deletes the registration that would reject every later request',
  );
  await manager.cycle(1);
});

test('a registration retry uses a fresh unique name untouched by a leftover', async (t) => {
  const f = await fixture(t);
  const names = [];
  let rejections = 0;
  const command = (program, args, options) => {
    if (
      program === 'gh' &&
      args.includes('/repos/owner/repo/actions/runners/generate-jitconfig')
    ) {
      const name = JSON.parse(options.input).name;
      names.push(name);
      if (rejections === 0) {
        rejections += 1;
        // A leftover registration still owns the previous display name; the
        // rejected request cannot delete it, so it stays on GitHub.
        f.setRunner({ id: 77, name });
        const error = new Error('gh failed (exit 1, HTTP 422)');
        error.status = 422;
        return Promise.reject(error);
      }
    }
    return f.command(program, args, options);
  };
  const manager = createManager(f.config, { command });
  await assert.rejects(manager.cycle(1), (error) => error.status === 422);
  await manager.cycle(1);
  assert.equal(names.length, 2);
  assert.ok(
    names.every((name) => /^ecs-qwen-trial-01-[0-9a-f]{8}$/.test(name)),
  );
  assert.notEqual(
    names[0],
    names[1],
    'retry must not reuse the name a leftover registration still owns',
  );
});

test('identical failures past the time threshold raise one stall alert; recovery resets it', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.config.stateDir, 'flock'), '#!/bin/sh\nexec cat\n', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${f.config.stateDir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const messages = [];
  const previousLog = console.log;
  console.log = (message) => messages.push(String(message));
  t.after(() => {
    console.log = previousLog;
  });
  // The threshold is wall-clock, so drive the clock through the injected
  // sleep. Jitter is pinned to its floor: delays 5+10+20+40 s carry the
  // fifth identical failure past a 60 s threshold, and the alert fires
  // when that failure is observed.
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  let failures = 0;
  let recovered = false;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'info' && failures < 5) {
      failures += 1;
      return Promise.reject(new Error('docker unavailable'));
    }
    // The recovery cycle's own 1 s polls also advance the mock clock; stop
    // once it is actually replenishing so the run cannot loop forever.
    if (
      program === 'gh' &&
      args.includes('/repos/owner/repo/actions/runners/generate-jitconfig')
    ) {
      if (recovered) manager.stop();
      recovered = true;
    }
    return f.command(program, args, options);
  };
  const manager = createManager(
    { ...f.config, stallAlertSeconds: 60 },
    {
      command,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  await manager.start();
  const alerts = messages.filter((message) => message.includes('STALL ALERT'));
  // The episode alerts once; the recovery cycle then resets the clock (a
  // later identical stall would be a new episode with its own alert).
  assert.equal(alerts.length, 1);
  assert.match(
    alerts[0],
    /slot 1: .*for \d+s across 5 consecutive identical failures/,
  );
  assert.match(alerts[0], /docker unavailable/);
  assert.ok(
    messages.some(
      (message) =>
        message.includes('started runner') &&
        messages.indexOf(message) >
          messages.findIndex((m) => m.includes('STALL ALERT')),
    ),
    'the slot recovers after the alert',
  );
});

test('a changing error restarts the stall clock instead of alerting early', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.config.stateDir, 'flock'), '#!/bin/sh\nexec cat\n', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${f.config.stateDir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const messages = [];
  const previousLog = console.log;
  console.log = (message) => messages.push(String(message));
  t.after(() => {
    console.log = previousLog;
  });
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0.5);
  let failures = 0;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'info' && failures < 6) {
      failures += 1;
      return Promise.reject(new Error(`docker unavailable ${failures}`));
    }
    return f.command(program, args, options);
  };
  const manager = createManager(
    { ...f.config, stallAlertSeconds: 25 },
    {
      command,
      sleep: async (ms) => {
        now += ms;
        if (failures >= 6) manager.stop();
      },
    },
  );
  await manager.start();
  assert.equal(
    messages.filter((message) => message.includes('STALL ALERT')).length,
    0,
    'no identical failure ever reached the threshold',
  );
});

// Both threshold tests below drive the wall clock through the injected sleep
// (the manager reads Date.now()), pin Math.random to the jitter floor so the
// ladder is exact, and stop as soon as the alert lands.
async function stallThresholdRun(t, { rateLimited, config }) {
  const f = await fixture(t);
  await writeFile(join(f.config.stateDir, 'flock'), '#!/bin/sh\nexec cat\n', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${f.config.stateDir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const messages = [];
  const previousLog = console.log;
  console.log = (message) => messages.push(String(message));
  t.after(() => {
    console.log = previousLog;
  });
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  let failures = 0;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'info') {
      failures += 1;
      const error = new Error('docker unavailable');
      if (rateLimited) error.status = 429;
      return Promise.reject(error);
    }
    return f.command(program, args, options);
  };
  const manager = createManager(config ?? f.config, {
    command,
    sleep: async (ms) => {
      now += ms;
      if (messages.some((message) => message.includes('STALL ALERT')))
        manager.stop();
    },
  });
  await manager.start();
  const alerts = messages.filter((message) => message.includes('STALL ALERT'));
  assert.equal(alerts.length, 1, 'one alert per stall episode');
  return {
    alerts,
    failures,
    durationSeconds: Number(/for (\d+)s across/.exec(alerts[0])[1]),
    failureCount: Number(/across (\d+) consecutive/.exec(alerts[0])[1]),
  };
}

test('the stall alert defaults to a thirty-minute wall-clock threshold', async (t) => {
  // Ordinary ladder at the jitter floor: 5 + 10 + 20 + 30 + 30 … s, so the
  // identical failures land at 0, 5, 15, 35, 65, 95 … and the 63rd is the
  // first one at or past the 1800 s default (1805 s).
  const result = await stallThresholdRun(t, { rateLimited: false });
  assert.equal(result.failureCount, 63);
  assert.equal(result.failures, 63);
  assert.ok(
    result.durationSeconds >= 1800 && result.durationSeconds <= 1830,
    `the default is a 1800 s wall clock, but the alert reported ${result.durationSeconds}s`,
  );
  assert.match(result.alerts[0], /docker unavailable/);
});

test('the stall threshold tracks wall clock, not the retry count', async (t) => {
  // Rate-limited ladder at the jitter floor: 15 + 30 + 60 + 120 + 150 … s, so
  // the identical failures land at 0, 15, 45, 105, 225, 375, 525 … and the
  // 16th is the first past 1800 s (1875 s). Same threshold as the ordinary
  // cadence, a quarter of the retries — that is what wall-clock buys.
  const result = await stallThresholdRun(t, { rateLimited: true });
  assert.equal(result.failureCount, 16);
  assert.ok(
    result.durationSeconds >= 1800 && result.durationSeconds <= 1950,
    `the alert must land on the first failure past 1800 s, got ${result.durationSeconds}s`,
  );
  assert.ok(
    result.failureCount < 20,
    `a count-based threshold would need the same retries at any cadence, got ${result.failureCount}`,
  );
});

test('stop() interrupts a long backoff sleep instead of waiting it out', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.config.stateDir, 'flock'), '#!/bin/sh\nexec cat\n', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${f.config.stateDir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  t.mock.method(Math, 'random', () => 0.999999);
  const sleeps = [];
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'info') {
      const error = new Error('gh failed (exit 1, HTTP 403)');
      error.status = 403;
      return Promise.reject(error);
    }
    return f.command(program, args, options);
  };
  const manager = createManager(f.config, {
    command,
    sleep: async (ms) => {
      sleeps.push(ms);
      manager.stop();
    },
  });
  await manager.start();
  // Exactly one slice: stop() fires inside the first 1 s chunk, and the
  // guard must cut the wait there. >= 1 would also pass on a vacuous
  // empty array if the loop never ran a slice at all.
  assert.equal(sleeps.length, 1);
  assert.ok(
    sleeps.every((ms) => ms <= 1000),
    `backoff slept in unsliced chunks: ${sleeps.join(', ')}`,
  );
});

test('rejects an invalid stall alert threshold', async (t) => {
  const f = await fixture(t);
  for (const stallAlertSeconds of [0, -1, '3', 0.5, 1e-9])
    assert.throws(
      () => createManager({ ...f.config, stallAlertSeconds }),
      /Invalid manager configuration/,
    );
});

test('a rate-limited runner deletion backs off on the 15-300 s ladder', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.config.stateDir, 'flock'), '#!/bin/sh\nexec cat\n', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${f.config.stateDir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  // A persisted slot makes the preflight cleanup the first and only failure:
  // no JIT request is issued before the DELETE is rejected, which is the shape
  // wenshao measured as 5, 10, 20 … s before the status was preserved.
  const persisted = `ecs-qwen-trial-01-${'a'.repeat(8)}`;
  await writeFile(
    join(f.config.stateDir, 'slot-1.json'),
    JSON.stringify({
      name: 'qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      runnerName: persisted,
      createdAt: new Date().toISOString(),
      runnerId: 7,
      uncertain: false,
    }),
  );
  f.setRunner({ id: 7, name: persisted });
  f.setFailDelete(true, 403);
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const deletions = [];
  const command = (program, args, options) => {
    if (program === 'gh' && args.includes('DELETE')) deletions.push(now);
    return f.command(program, args, options);
  };
  const manager = createManager(f.config, {
    command,
    sleep: async (ms) => {
      now += ms;
      if (deletions.length >= 4) manager.stop();
    },
  });
  await manager.start();
  const intervals = deletions
    .slice(1)
    .map((stamp, index) => (stamp - deletions[index]) / 1000);
  assert.deepEqual(
    intervals.slice(0, 3),
    [15, 30, 60],
    `a rate-limited deletion must back off on the 15-300 s ladder, got ${intervals.join(', ')}`,
  );
});

test('a rate-limited JIT failure keeps its status when cleanup fails too', async (t) => {
  const f = await fixture(t);
  f.setJitStatus(403);
  // The cleanup that follows the rejected JIT fails for a different reason, so
  // its status must not replace the rate-limit signal of the original error.
  f.setListStatus(500);
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1), (error) => error.status === 403);
});

test('the shipped example config pins the documented stall threshold', async () => {
  // config.example.json is what an operator copies to
  // /etc/qwen-ephemeral-runner/config.json, and an explicit value there
  // overrides the code default — so a stale example quietly replaces the
  // threshold the docs promise. The default lives in manager.mjs as
  // `config.stallAlertSeconds ?? 1800`; change one, change both.
  const example = JSON.parse(
    await readFile(new URL('./config.example.json', import.meta.url), 'utf8'),
  );
  assert.equal(example.stallAlertSeconds, 1800);
  // The example is also the only config most operators ever load, so it has to
  // keep passing the manager's own validation.
  assert.doesNotThrow(() => createManager(example));
});
