import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
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
  let failNetworkCreate = false;
  let keepContainerAfterRemove = false;
  let loseJit = false;
  let failDelete = false;
  let deleteStatus = 422;
  let extraRunners = [];
  let rejectFirstDelete = false;
  let jitFailure = null;
  let listFailure = null;
  const layerlessContainers = new Set();
  const goneContainers = new Set();
  const dockerError = (message, stderr) =>
    Object.assign(new Error(message), { exitCode: 1, status: 0, stderr });
  const storageFailure = (id) => {
    if (goneContainers.has(id))
      return dockerError(
        'docker failed (exit 1)',
        `Error response from daemon: No such container: ${id}`,
      );
    if (layerlessContainers.has(id))
      return dockerError(
        'docker failed (exit 1)',
        `Error response from daemon: RWLayer of container ${id} is unexpectedly nil`,
      );
    return null;
  };
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
        if (rejectFirstDelete) {
          rejectFirstDelete = false;
          const error = new Error(`gh failed (exit 1, HTTP ${deleteStatus})`);
          error.status = deleteStatus;
          throw error;
        }
        if (failDelete) {
          const error = new Error(`gh failed (exit 1, HTTP ${deleteStatus})`);
          error.status = deleteStatus;
          throw error;
        }
        const id = Number(path.split('/').pop());
        if (runner?.id === id) runner = undefined;
        extraRunners = extraRunners.filter((entry) => entry.id !== id);
        return '';
      }
      if (listFailure) throw listFailure();
      return JSON.stringify(runner ? [runner, ...extraRunners] : extraRunners);
    }
    if (args[0] === 'inspect') {
      if (args.includes('{{json .State}}'))
        return JSON.stringify({ Status: 'running', ExitCode: 0 });
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
      if (failNetworkCreate) throw new Error('network creation failed');
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
    if (args[0] === 'logs') {
      const failure = storageFailure(args[args.length - 1]);
      if (failure) throw failure;
      return 'runner log';
    }
    if (args[0] === 'cp') {
      const failure = storageFailure(String(args[1]).split(':')[0]);
      if (failure) throw failure;
      return '';
    }
    if (args[0] === 'rm') {
      const failure = storageFailure(args[args.length - 1]);
      if (failure) {
        // A daemon-dropped container also disappears from later ps calls.
        if (goneContainers.has(args[args.length - 1]))
          containers.delete(args[args.length - 1]);
        throw failure;
      }
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
    setFailNetworkCreate: (v) => {
      failNetworkCreate = v;
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
      runner =
        'status' in value
          ? { busy: false, ...value }
          : { status: 'offline', busy: false, ...value };
    },
    setExtraRunners: (values) => {
      extraRunners = values.map((value) => ({
        status: 'offline',
        busy: false,
        ...value,
      }));
    },
    runnerList: () => [...(runner ? [runner] : []), ...extraRunners],
    setRejectFirstDelete: (status = 422) => {
      rejectFirstDelete = true;
      deleteStatus = status;
    },
    addOrphanContainer(labels) {
      const id = `container-orphan-${containers.size}`;
      containers.set(id, { labels });
      return id;
    },
    setLayerless: (id) => {
      layerlessContainers.add(id);
    },
    setGone: (id) => {
      goneContainers.add(id);
    },
    removeContainerRecord: (id) => {
      containers.delete(id);
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

test('age checks retain healthy idle, busy and unreachable runners until the container exits', async (t) => {
  for (const health of ['idle', 'busy', 'offline', 'unavailable']) {
    await t.test(health, async (t) => {
      const f = await fixture(t);
      let now = 0;
      let finish;
      let registration;
      let exited = false;
      let checks = 0;
      const alerts = [];
      t.mock.method(console, 'log', (message) => {
        if (message.includes('WATCHDOG ALERT')) alerts.push(message);
      });
      t.mock.method(Date, 'now', () => now);
      const command = async (program, args, options) => {
        if (program === 'docker' && args[0] === 'wait') {
          assert.equal(options.timeout, 0);
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        if (program === 'docker' && args[0] === 'rm')
          assert.ok(
            exited,
            'age or health must never force-remove a live container',
          );
        if (
          program === 'gh' &&
          args.includes('/repos/owner/repo/actions/runners/1') &&
          !args.includes('DELETE')
        ) {
          checks += 1;
          if (health === 'unavailable') throw new Error('GitHub unavailable');
          return JSON.stringify({
            ...registration,
            status: health === 'offline' ? 'offline' : 'online',
            busy: health === 'busy',
          });
        }
        const result = await f.command(program, args, options);
        if (
          program === 'gh' &&
          args.includes('/repos/owner/repo/actions/runners/generate-jitconfig')
        )
          registration = JSON.parse(result).runner;
        return result;
      };
      await createManager(f.config, {
        command,
        sleep: async (ms) => {
          now += ms;
          if (now >= 6000) {
            exited = true;
            finish('0\n');
          }
        },
      }).cycle(1);
      assert.equal(
        checks,
        1,
        'health checks must be bounded, not run every second',
      );
      assert.equal(
        alerts.length,
        ['offline', 'unavailable'].includes(health) ? 1 : 0,
      );
      assert.equal(
        f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm')
          .length,
        1,
      );
    });
  }
});

test('an unbounded command can be cancelled without leaving its client running', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(
      runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeout: 0,
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
  } finally {
    clearTimeout(timer);
  }
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

test('multi-identity orphan pile without slot state self-heals instead of stalling', async (t) => {
  // hz4 incident: address-pool exhaustion left several `Created`
  // containers per slot, each with a different qwen.instance, and no
  // slot state. recoverIdentity refuses to pick one — but with no state
  // every leftover is an orphan, so the cycle must sweep them all and
  // replenish instead of failing identically forever.
  const f = await fixture(t);
  const pool = { 'qwen.pool': 'trial', 'qwen.slot': '1' };
  const orphanA = f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  const orphanB = f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  });
  const orphanNetwork = f.addForeignNetwork({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-cccccccc-cccc-4ccc-cccc-cccccccccccc',
  });
  // A registration orphaned by one of the swept containers, under this
  // slot's suffixed naming scheme.
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-deadbeef', busy: true });
  const manager = createManager(f.config, { command: f.command });
  await manager.cycle(1);
  const removedOrphans = f.calls.filter(
    (c) =>
      c.program === 'docker' &&
      c.args[0] === 'rm' &&
      (c.args.includes(orphanA) || c.args.includes(orphanB)),
  );
  assert.equal(removedOrphans.length, 2, 'both orphan containers removed');
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'docker' &&
        c.args[0] === 'network' &&
        c.args[1] === 'rm' &&
        c.args.includes(orphanNetwork),
    ),
    'orphan network removed',
  );
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ),
    'orphaned registration swept by the slot naming scheme',
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
    'slot replenished in the same cycle',
  );
});

test('the identity-less sweep never deletes an online registration', async (t) => {
  const f = await fixture(t);
  const pool = { 'qwen.pool': 'trial', 'qwen.slot': '1' };
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  });
  f.setRunner({
    id: 77,
    name: 'ecs-qwen-trial-01-deadbeef',
    status: 'online',
    busy: true,
  });
  await createManager(f.config, { command: f.command }).cycle(1);
  assert.ok(
    !f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ),
    'an online registration may belong to a live runner elsewhere',
  );
});

test('the identity-less sweep keeps the HTTP status of a rejected deletion', async (t) => {
  // A 403/429 on the sweep's DELETE must escape with .status intact so the
  // retry loop can pick the rate-limit backoff ladder; a bare rewrap would
  // classify a rate-limit storm as an ordinary failure.
  const f = await fixture(t);
  const pool = { 'qwen.pool': 'trial', 'qwen.slot': '1' };
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-deadbeef' });
  f.setFailDelete(true, 429);
  await assert.rejects(
    createManager(f.config, { command: f.command }).cycle(1),
    (error) =>
      error.status === 429 && /deletion was rejected/.test(error.message),
  );
});

test('a rejected sweep deletion is retried on the next cycle before the pile is gone', async (t) => {
  // The sweep runs while the leftovers still exist: a rejected DELETE
  // must stay reachable next cycle. Sweeping after removal leaked the
  // registration forever — no state and no leftovers means cleanup()
  // never runs again.
  const f = await fixture(t);
  const pool = { 'qwen.pool': 'trial', 'qwen.slot': '1' };
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-deadbeef', busy: true });
  f.setRejectFirstDelete(422);
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1), /deletion was rejected/);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    0,
    'no replacement while the rejected registration survives',
  );
  await manager.cycle(1);
  assert.equal(
    f.calls.filter(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ).length,
    2,
    'the next cycle retries the same registration',
  );
  assert.deepEqual(
    f.runnerList().map((entry) => entry.id),
    [],
    'the rejected registration is gone after the retry',
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
    'slot replenishes in the retry cycle',
  );
});

test('a 429-rejected sweep deletion promises the retry and the next cycle completes it', async (t) => {
  // Two-cycle probe. Cycle 1 has its DELETE refused while the orphan pile is
  // still on disk, so the error must name the retry and the registration must
  // survive; cycle 2 must actually delete it. Sweeping after the pile was
  // removed left the slot with neither state nor leftovers, so cleanup() never
  // ran again and the registration leaked.
  const f = await fixture(t);
  const pool = { 'qwen.pool': 'trial', 'qwen.slot': '1' };
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-deadbeef' });
  f.setRejectFirstDelete(429);
  const manager = createManager(f.config, { command: f.command });
  const deletedIds = () =>
    f.calls
      .filter((c) => c.program === 'gh' && c.args.includes('DELETE'))
      .map((c) =>
        c.args.find((v) => v.startsWith('/repos/owner/repo/actions/runners/')),
      )
      .filter(Boolean)
      .map((v) => Number(v.split('/').pop()));
  const creates = () =>
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length;

  await assert.rejects(
    manager.cycle(1),
    /Runner 77 deletion was rejected \(HTTP 429\); retrying on the next cycle/,
  );
  assert.deepEqual(deletedIds(), [77], 'cycle 1 attempted exactly this slot');
  assert.deepEqual(
    f.runnerList().map((entry) => entry.id),
    [77],
    'the rejected registration survives cycle 1',
  );
  assert.equal(creates(), 0, 'no replacement while the rejection stands');

  await manager.cycle(1);
  // Cycle 2 also deletes the runner it just created for the job, so count only
  // the registration under test.
  assert.deepEqual(
    deletedIds().filter((id) => id === 77),
    [77, 77],
    'cycle 2 retries the same runner',
  );
  assert.deepEqual(
    f
      .runnerList()
      .map((entry) => entry.id)
      .filter((id) => id === 77),
    [],
    'the registration is gone after the retry',
  );
});

test('a foreign or missing identity blocks sweeping even this slot offline registration', async (t) => {
  // The naming scheme assumes poolId is unique per host, so a pile whose
  // instance labels are not all this slot's means the resources may belong to
  // another pool sharing the host. Nothing may be swept by name then — not
  // even this slot's own offline registration — and the slot must not be
  // replenished while the pile blocks it. Another slot's registration and an
  // online one are never candidates in any case.
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-other-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.addOrphanContainer({ 'qwen.pool': 'trial', 'qwen.slot': '1' });
  f.setRunner({ id: 88, name: 'ecs-qwen-trial-01-cafe1234' });
  f.setExtraRunners([
    { id: 55, name: 'ecs-qwen-trial-02-abcdef12' },
    { id: 99, name: 'ecs-qwen-trial-01-beef9999', status: 'online' },
  ]);
  const manager = createManager(f.config, { command: f.command });

  await assert.rejects(
    manager.cycle(1),
    /Orphaned resources carry no unambiguous slot identity; manual reconciliation required/,
  );
  assert.deepEqual(
    f.calls.filter((c) => c.program === 'gh' && c.args.includes('DELETE')),
    [],
    'no registration DELETE at all on a foreign or missing identity',
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    0,
    'the slot is not replenished while the pile blocks it',
  );
  assert.deepEqual(
    f.runnerList().map((entry) => entry.id),
    [88, 55, 99],
    'this slot offline, the other slot, and the online registration all survive',
  );
});

test('the identity-less sweep never deletes a registration without a status', async (t) => {
  const f = await fixture(t);
  const pool = { 'qwen.pool': 'trial', 'qwen.slot': '1' };
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  });
  f.setRunner({
    id: 77,
    name: 'ecs-qwen-trial-01-deadbeef',
    status: undefined,
  });
  await createManager(f.config, { command: f.command }).cycle(1);
  assert.ok(
    !f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ),
    'only registrations GitHub explicitly reports offline may be swept',
  );
});

test('the identity-less sweep only deletes registrations under the slot naming scheme', async (t) => {
  const f = await fixture(t);
  const pool = { 'qwen.pool': 'trial', 'qwen.slot': '1' };
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-deadbeef' });
  f.setExtraRunners([
    { id: 78, name: 'ecs-qwen-trial-01-scratch' },
    { id: 79, name: 'ecs-qwen-trial-02-abcdef12' },
    { id: 80, name: 'shared-linux-runner' },
  ]);
  await createManager(f.config, { command: f.command }).cycle(1);
  const deleted = f.calls
    .filter((c) => c.program === 'gh' && c.args.includes('DELETE'))
    .map((c) =>
      c.args
        .find((v) => v.startsWith('/'))
        .split('/')
        .pop(),
    )
    .filter((id) => ['77', '78', '79', '80'].includes(id));
  assert.deepEqual(
    deleted,
    ['77'],
    'prefix siblings, other slots, and unrelated runners are never swept',
  );
  assert.deepEqual(
    f.runnerList().map((entry) => entry.id),
    [78, 79, 80],
  );
});

test('orphan log archives stay prunable by the log pruner', async (t) => {
  const f = await fixture(t);
  const pool = { 'qwen.pool': 'trial', 'qwen.slot': '1' };
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.addOrphanContainer({
    ...pool,
    'qwen.instance': 'ecs-qwen-trial-1-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  });
  const manager = createManager(f.config, { command: f.command });
  await manager.cycle(1);
  const orphanLogs = (await readdir(f.config.logDir)).filter((name) =>
    name.includes('-orphan-'),
  );
  assert.ok(orphanLogs.length >= 1, 'orphan logs are archived');
  for (const name of orphanLogs) {
    const past = new Date(Date.now() - 8 * 86400000);
    await utimes(join(f.config.logDir, name), past, past);
  }
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '2',
    'qwen.instance': 'ecs-qwen-trial-2-cccccccc-cccc-4ccc-cccc-cccccccccccc',
  });
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '2',
    'qwen.instance': 'ecs-qwen-trial-2-dddddddd-dddd-4ddd-dddd-dddddddddddd',
  });
  await manager.cycle(2);
  const remaining = await readdir(f.config.logDir);
  for (const name of orphanLogs)
    assert.ok(
      !remaining.includes(name),
      `aged orphan archive ${name} is recognized and pruned`,
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

test('a failed wait client or unavailable Docker never proves that a container exited', async (t) => {
  const f = await fixture(t);
  let waits = 0;
  let exited = false;
  let inspectFailed = false;
  let listFailed = false;
  const command = async (program, args, options) => {
    if (program === 'docker' && args[0] === 'wait') {
      waits += 1;
      if (waits < 3) throw new Error('Docker disconnected');
      exited = true;
      return '0\n';
    }
    if (
      program === 'docker' &&
      args[0] === 'inspect' &&
      args.includes('{{json .State}}') &&
      !inspectFailed
    ) {
      inspectFailed = true;
      throw new Error('Docker disconnected');
    }
    if (
      program === 'docker' &&
      args[0] === 'ps' &&
      inspectFailed &&
      !listFailed
    ) {
      listFailed = true;
      throw new Error('Docker disconnected');
    }
    if (program === 'docker' && args[0] === 'rm')
      assert.ok(
        exited,
        'a wait/inspect/list failure must not force-remove the container',
      );
    return f.command(program, args, options);
  };
  const result = await createManager(f.config, {
    command,
    sleep: async () => {},
  }).cycle(1);
  assert.equal(result.earlyExit, false);
  assert.equal(waits, 3);
  assert.ok(inspectFailed && listFailed);
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

test('a foreign-labeled orphan is removed but registration sweeping stays blocked', async (t) => {
  const f = await fixture(t);
  const foreign = f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-other-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-cafe1234' });
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1), /manual reconciliation/);
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'docker' &&
        c.args[0] === 'rm' &&
        c.args.includes(foreign),
    ),
    'the foreign-labeled resource in our slot namespace is still removed',
  );
  assert.ok(
    !f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ),
    'registrations are never swept by name on a foreign identity',
  );
  await manager.cycle(1);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
    'replenishes on the next cycle once the foreign resource is gone',
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

test('a rejected label-recovered deletion retries from the retained resources', async (t) => {
  // Nothing about a label-recovered identity is persisted, so a rejected
  // DELETE can only be retried if a labelled resource survives the throw.
  // The CONTAINER is removed even on a retryable refusal — a
  // retained container keeps its own runner heartbeating and the offline
  // gate could then never clear — and the labelled network is the retry
  // anchor. Cycle 2 must retry the same registration from that anchor.
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-cafe1234' });
  f.setFailDelete(true, 422);
  const manager = createManager(f.config, { command: f.command });
  const deletes = () =>
    f.calls.filter(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ).length;
  await assert.rejects(
    manager.cycle(1),
    /Runner 77 deletion was rejected \(HTTP 422\)/,
    'cycle 1 reports the rejected deletion it cannot complete yet',
  );
  assert.equal(deletes(), 1, 'cycle 1 attempted this registration once');
  assert.equal(
    f.runnerList().length,
    1,
    'the rejected registration survives cycle 1',
  );
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'docker' &&
        c.args[0] === 'rm' &&
        c.args.includes('container-orphan-0'),
    ),
    'the container is removed so its runner can actually reach offline',
  );
  assert.ok(
    !f.calls.some(
      (c) =>
        c.program === 'docker' && c.args[0] === 'network' && c.args[1] === 'rm',
    ),
    'the labelled network anchor is retained so the next cycle still reaches the retry',
  );
  f.setFailDelete(false);
  await manager.cycle(1);
  assert.equal(deletes(), 2, 'cycle 2 retries the same registration');
  assert.deepEqual(
    f
      .runnerList()
      .map((entry) => entry.id)
      .filter((id) => id === 77),
    [],
    'the registration is gone once the retry succeeds',
  );
});

test('label recovery never deletes an online or unconfirmed registration', async (t) => {
  // A label-recovered identity is not state-recorded: an online match may
  // belong to a live runner outside this host's view, and a missing, null or
  // unknown status must fail closed. The gate runs before the registration
  // could be deleted; the container is removed so an online match backed by
  // this slot's own leftover runner can actually reach offline, and
  // the labelled network anchor — never a rebuilt pile and never a persisted
  // state file — keeps the next cycle reaching the gate.
  for (const status of ['online', undefined, null, 'busy']) {
    const label = status === undefined ? 'status-less' : `status ${status}`;
    const f = await fixture(t);
    f.addOrphanContainer({
      'qwen.pool': 'trial',
      'qwen.slot': '1',
      'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    });
    f.setRunner({
      id: 77,
      name: 'ecs-qwen-trial-01-cafe1234',
      status,
    });
    const manager = createManager(f.config, { command: f.command });
    await assert.rejects(
      manager.cycle(1),
      /not reported offline/,
      `cycle 1 refuses to delete a ${label} registration`,
    );
    await assert.rejects(
      manager.cycle(1),
      /not reported offline/,
      `cycle 2 reaches the gate again with no pile rebuilt (${label})`,
    );
    assert.ok(
      !f.calls.some(
        (c) =>
          c.program === 'gh' &&
          c.args.includes('DELETE') &&
          c.args.includes('/repos/owner/repo/actions/runners/77'),
      ),
      `a ${label} registration is never deleted`,
    );
    assert.equal(
      f.calls.filter(
        (c) =>
          c.program === 'gh' &&
          c.args.includes(
            '/repos/owner/repo/actions/runners/generate-jitconfig',
          ),
      ).length,
      0,
      `no JIT request while a ${label} registration survives`,
    );
    assert.equal(
      f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
        .length,
      0,
      `no replacement while a ${label} registration survives`,
    );
    assert.ok(
      f.calls.some(
        (c) =>
          c.program === 'docker' &&
          c.args[0] === 'rm' &&
          c.args.includes('container-orphan-0'),
      ),
      `the orphan container is removed so its runner can reach offline (${label})`,
    );
    assert.ok(
      !f.calls.some(
        (c) =>
          c.program === 'docker' &&
          c.args[0] === 'network' &&
          c.args[1] === 'rm',
      ),
      `the labelled network anchor survives the refusal (${label})`,
    );
    // The refusing cycle still exports the container's diagnostics —
    // the one artefact an operator of a wedged slot must inspect.
    const exported = await readdir(f.config.logDir);
    assert.ok(
      exported.some(
        (name) => name.includes('container-or') && name.endsWith('.log'),
      ),
      `container logs are captured before the refusal (${label})`,
    );
    assert.ok(
      exported.some(
        (name) => name.includes('container-or') && name.endsWith('.tar'),
      ),
      `the _diag archive is captured before the refusal (${label})`,
    );
    await assert.rejects(
      readFile(join(f.config.stateDir, 'slot-1.json')),
      { code: 'ENOENT' },
      `no slot state is persisted to carry a ${label} identity`,
    );
  }
});

test('an online registration backed by the own orphan container self-heals', async (t) => {
  // A retained container kept its runner heartbeating, so the
  // offline gate threw identically every cycle and the slot never
  // recovered. Removing the container lets the runner reach offline; the
  // labelled network keeps the retry anchored, and the next cycle deletes
  // the registration and replenishes the slot.
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.setRunner({
    id: 77,
    name: 'ecs-qwen-trial-01-cafe1234',
    status: 'online',
  });
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1), /not reported offline/);
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'docker' &&
        c.args[0] === 'rm' &&
        c.args.includes('container-orphan-0'),
    ),
    'cycle 1 removes the container whose heartbeat sustains the refusal',
  );
  // The container is gone, so the real runner stops heartbeating and GitHub
  // reports it offline.
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-cafe1234' });
  await manager.cycle(1);
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ),
    'cycle 2 deletes the now-offline registration',
  );
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('/repos/owner/repo/actions/runners/generate-jitconfig'),
    ),
    'cycle 2 replenishes the slot',
  );
});

test('a failed refusal-anchor creation keeps the containers and leaks nothing', async (t) => {
  // The refusal path removes the containers and relies on a labelled
  // network to bring the next cycle back. A container-only pile needs that
  // anchor created first: if the creation fails AFTER the removal, the slot
  // would find nothing to clean up, replenish, and leak the registration.
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-cafe1234', status: 'online' });
  f.setFailNetworkCreate(true);
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1));
  assert.ok(
    !f.calls.some(
      (c) =>
        c.program === 'docker' &&
        c.args[0] === 'rm' &&
        c.args.includes('container-orphan-0'),
    ),
    'the container survives a failed anchor creation as the retry anchor',
  );
  assert.equal(
    f.calls.filter(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('/repos/owner/repo/actions/runners/generate-jitconfig'),
    ).length,
    0,
    'no replenishment while the registration is unreconciled',
  );
  f.setFailNetworkCreate(false);
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-cafe1234' });
  await manager.cycle(1);
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ),
    'the next cycle still reaches the registration and deletes it once offline',
  );
});

test('a permanent identity refusal reclaims the container and keeps blocking', async (t) => {
  // An ambiguous identity is permanent — no retry clears it — so the
  // container must not be pinned behind it. Cycle 1 removes the container
  // and keeps the labelled network anchor; cycle 2 still fails on the same
  // ambiguity, deletes neither registration, and a manual fix (one
  // registration left) lets the slot replenish.
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-cafe1234' });
  f.setExtraRunners([{ id: 78, name: 'ecs-qwen-trial-01-beef5678' }]);
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1), /Ambiguous runner identity/);
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'docker' &&
        c.args[0] === 'rm' &&
        c.args.includes('container-orphan-0'),
    ),
    'cycle 1 reclaims the container instead of pinning it',
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'gh' && c.args.includes('DELETE'))
      .length,
    0,
    'the ambiguity deletes neither registration',
  );
  await assert.rejects(manager.cycle(1), /Ambiguous runner identity/);
  assert.equal(
    f.calls.filter(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('/repos/owner/repo/actions/runners/generate-jitconfig'),
    ).length,
    0,
    'the slot stays blocked on the persisted ambiguity',
  );
  // Manual reconciliation removes one registration; the slot recovers.
  f.setExtraRunners([]);
  await manager.cycle(1);
  assert.ok(
    f.calls.some(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('/repos/owner/repo/actions/runners/generate-jitconfig'),
    ),
    'the slot replenishes once the ambiguity is resolved',
  );
});

test('the call-site split reconciles each identity exactly once, at its own point', async (t) => {
  // A label-recovered identity is reconciled BEFORE the container is
  // removed (its only anchor), a state-anchored one only AFTER — deleting a
  // still-connected runner's registration hits GitHub's "runner is busy"
  // rejection on every watchdog kill. Widening the early flag to
  // `Boolean(state?.name)` must turn the second half red.
  const f = await fixture(t);
  f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.setRunner({ id: 77, name: 'ecs-qwen-trial-01-cafe1234' });
  const manager = createManager(f.config, { command: f.command });
  await manager.cycle(1);
  const deleteAt = f.calls.findIndex(
    (c) =>
      c.program === 'gh' &&
      c.args.includes('DELETE') &&
      c.args.includes('/repos/owner/repo/actions/runners/77'),
  );
  const removeAt = f.calls.findIndex(
    (c) =>
      c.program === 'docker' &&
      c.args[0] === 'rm' &&
      c.args.includes('container-orphan-0'),
  );
  assert.ok(deleteAt !== -1 && removeAt !== -1);
  assert.equal(
    f.calls.filter(
      (c) =>
        c.program === 'gh' &&
        c.args.includes('DELETE') &&
        c.args.includes('/repos/owner/repo/actions/runners/77'),
    ).length,
    1,
    'the label-recovered identity is reconciled exactly once',
  );
  assert.ok(
    deleteAt < removeAt,
    'a label-recovered identity is reconciled before its anchor is removed',
  );
  // A state-anchored identity: the DELETE must come AFTER the docker rm.
  const g = await fixture(t);
  const anchored = createManager(g.config, { command: g.command });
  await anchored.cycle(1);
  const anchoredDeleteAt = g.calls.findIndex(
    (c) => c.program === 'gh' && c.args.includes('DELETE'),
  );
  const anchoredRemoveAt = g.calls.findIndex(
    (c) => c.program === 'docker' && c.args[0] === 'rm',
  );
  assert.ok(anchoredDeleteAt !== -1 && anchoredRemoveAt !== -1);
  assert.ok(
    anchoredRemoveAt < anchoredDeleteAt,
    'a state-anchored identity is reconciled only after the container is removed',
  );
  assert.equal(
    g.calls.filter((c) => c.program === 'gh' && c.args.includes('DELETE'))
      .length,
    1,
    'the state-anchored identity is reconciled exactly once',
  );
});

test('disagreeing labels keep reporting while Docker refuses removals', async (t) => {
  const f = await fixture(t);
  const manager = createManager(f.config, { command: f.command });
  // While Docker refuses removals the pile cannot be swept, so an
  // ambiguous identity must delete nothing and keep reporting.
  f.setFailRemove(true);
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
  await assert.rejects(manager.cycle(1), /docker unavailable/);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    0,
    'no replacement while the ambiguous pile survives',
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
  const { f, alerts, clock, messages } = await stallHarness(t);
  // The threshold is wall-clock, so drive the clock through the injected
  // sleep. Jitter is pinned to its floor: delays 5+10+20+40 s carry the
  // fifth identical failure past a 60 s threshold, and the alert fires
  // when that failure is observed.
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
        clock.now += ms;
      },
    },
  );
  await manager.start();
  // The episode alerts once; the recovery cycle then resets the clock (a
  // later identical stall would be a new episode with its own alert).
  assert.equal(alerts().length, 1);
  assert.match(
    alerts()[0],
    /slot 1: .*for \d+s across 5 consecutive identical failures/,
  );
  assert.match(alerts()[0], /docker unavailable/);
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
  const { f, clock, messages } = await stallHarness(t, { random: 0.5 });
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
        clock.now += ms;
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
// The stall tests all need the same harness: a fixture, the flock shim on
// PATH, captured logs, and a pinned clock they advance through the injected
// sleep. Per-test behaviour — which commands fail, when to stop — stays in the
// test itself.
async function stallHarness(t, { random = 0 } = {}) {
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
  const clock = { now: 1_000_000 };
  t.mock.method(Date, 'now', () => clock.now);
  t.mock.method(Math, 'random', () => random);
  return {
    f,
    clock,
    messages,
    alerts: () => messages.filter((message) => message.includes('STALL ALERT')),
  };
}

async function stallThresholdRun(t, { rateLimited, config }) {
  const { f, alerts, clock, messages } = await stallHarness(t);
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
      clock.now += ms;
      if (messages.some((message) => message.includes('STALL ALERT')))
        manager.stop();
    },
  });
  await manager.start();
  const found = alerts();
  assert.equal(found.length, 1, 'one alert per stall episode');
  return {
    alerts: found,
    failures,
    durationSeconds: Number(/for (\d+)s across/.exec(found[0])[1]),
    failureCount: Number(/across (\d+) consecutive/.exec(found[0])[1]),
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

test('rejects an invalid drain window', async (t) => {
  const f = await fixture(t);
  for (const drainTimeoutSeconds of [-1, '60', Number.NaN, Infinity])
    assert.throws(
      () => createManager({ ...f.config, drainTimeoutSeconds }),
      /Invalid manager configuration/,
    );
});

async function drainHarness(t) {
  const f = await fixture(t);
  await writeFile(join(f.config.stateDir, 'flock'), '#!/bin/sh\nexec cat\n', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${f.config.stateDir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const clock = { now: 1_000_000 };
  t.mock.method(Date, 'now', () => clock.now);
  return { f, clock };
}

test('drain stops an idle runner instead of waiting out the window', async (t) => {
  const { f, clock } = await drainHarness(t);
  f.config.drainTimeoutSeconds = 600;
  let manager;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'start') manager.stop();
    // An idle ephemeral runner never exits on its own, so the drain has to
    // decide; the wait stays pending for the whole test.
    if (program === 'docker' && args[0] === 'wait')
      return new Promise(() => {});
    if (program === 'docker' && args[0] === 'top') return 'sh\n';
    return f.command(program, args, options);
  };
  manager = createManager(f.config, {
    command,
    sleep: async (ms) => {
      clock.now += ms;
      if (clock.now > 1_060_000)
        throw new Error('an idle slot waited out the drain window');
    },
  });
  await manager.start();
  assert.ok(
    clock.now - 1_000_000 <= 15_000,
    `idle drain took ${clock.now - 1_000_000}ms`,
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm').length,
    1,
  );
});

test('drain keeps draining when GitHub refuses the registration retirement', async (t) => {
  const { f, clock } = await drainHarness(t);
  f.config.drainTimeoutSeconds = 600;
  // 422 (busy) and 404 (hidden resource) are the same decision: neither
  // confirms the gate, so the container must keep draining and the job that
  // may already be assigned must still run and exit on its own.
  for (const status of [422, 404]) {
    f.setRejectFirstDelete(status);
    const callStart = f.calls.length;
    const jobStartsAt = clock.now + 10_000;
    const jobEndsAt = clock.now + 20_000;
    let workerSeen = false;
    let removedBeforeWorker = 0;
    let releaseWait;
    let manager;
    const command = (program, args, options) => {
      if (program === 'docker' && args[0] === 'start') manager.stop();
      if (program === 'docker' && args[0] === 'wait')
        return new Promise((resolveWait) => {
          releaseWait = () => resolveWait('0\n');
        });
      if (program === 'docker' && args[0] === 'top') {
        if (clock.now < jobStartsAt) return '';
        workerSeen = true;
        return 'Runner.Worker\n';
      }
      if (program === 'docker' && args[0] === 'rm' && !workerSeen)
        removedBeforeWorker += 1;
      return f.command(program, args, options);
    };
    manager = createManager(f.config, {
      command,
      sleep: async (ms) => {
        clock.now += ms;
        if (clock.now >= jobEndsAt) releaseWait?.();
      },
    });
    await manager.start();
    const calls = f.calls.slice(callStart);
    assert.equal(
      workerSeen,
      true,
      `the job assigned after a ${status} refusal must keep running`,
    );
    assert.equal(
      removedBeforeWorker,
      0,
      `a ${status} refusal must not remove the container before the job runs`,
    );
    assert.equal(
      calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm').length,
      1,
      `a ${status} refusal must still remove the container exactly once, after the job exits`,
    );
    assert.equal(
      calls.filter((c) => c.program === 'gh' && c.args.includes('DELETE'))
        .length,
      2,
      `a ${status} refusal must be retried by cleanup after the job exits`,
    );
    assert.deepEqual(
      f.runnerList(),
      [],
      `the registration must end up deleted after the ${status} episode`,
    );
  }
});

test('drain retires the registration before removing the container', async (t) => {
  const { f, clock } = await drainHarness(t);
  f.config.drainTimeoutSeconds = 600;
  const order = [];
  let deletes = 0;
  let manager;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'start') manager.stop();
    if (program === 'docker' && args[0] === 'wait')
      return new Promise(() => {});
    if (program === 'docker' && args[0] === 'top') return 'sh\n';
    if (program === 'docker' && args[0] === 'rm') order.push('rm');
    if (program === 'gh' && args.includes('DELETE')) {
      deletes += 1;
      if (deletes === 1) {
        order.push('delete-gate');
        // The gate is accepted; the registration stays listed (GitHub's
        // listing lag), so cleanup's delete hits 404 and must be tolerated
        // rather than failing the cycle after the container is already gone.
        return '';
      }
      order.push('delete-cleanup');
      const error = Object.assign(new Error('gh failed (exit 1, HTTP 404)'), {
        status: 404,
      });
      return Promise.reject(error);
    }
    return f.command(program, args, options);
  };
  manager = createManager(f.config, {
    command,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  await manager.start();
  assert.ok(
    order.indexOf('delete-gate') < order.indexOf('rm'),
    'the registration must be retired before the container is removed',
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm').length,
    1,
    'the container must be removed exactly once',
  );
  assert.ok(
    order.includes('delete-gate') && order.includes('delete-cleanup'),
    'cleanup must retry the registration and tolerate its 404',
  );
});

test('a rate-limited retirement backs off instead of polling every five seconds', async (t) => {
  const { f, clock } = await drainHarness(t);
  f.config.drainTimeoutSeconds = 600;
  f.setRejectFirstDelete(429);
  const deleteTimes = [];
  let manager;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'start') manager.stop();
    if (program === 'docker' && args[0] === 'wait')
      return new Promise(() => {});
    if (program === 'docker' && args[0] === 'top') return '';
    if (program === 'gh' && args.includes('DELETE'))
      deleteTimes.push(clock.now);
    return f.command(program, args, options);
  };
  manager = createManager(f.config, {
    command,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  await manager.start();
  assert.equal(deleteTimes.length, 2, 'the gate is retried after the refusal');
  // The 429 pushes the next drain decision onto the rate-limit ladder
  // (15-30 s), plus the fresh two-poll idle window, so it cannot come back at
  // the five-second poll cadence.
  const gap = deleteTimes[1] - deleteTimes[0];
  assert.ok(
    gap >= 20_000,
    `a rate-limited retirement must back off, but retried after ${gap}ms`,
  );
});

test('drain lets an assigned job exit before stopping the runner', async (t) => {
  const { f, clock } = await drainHarness(t);
  f.config.drainTimeoutSeconds = 600;
  const jobEndsAt = clock.now + 120_000;
  let releaseWait;
  let manager;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'start') manager.stop();
    if (program === 'docker' && args[0] === 'wait')
      return new Promise((resolveWait) => {
        releaseWait = () => resolveWait('0\n');
      });
    if (program === 'docker' && args[0] === 'top')
      return clock.now < jobEndsAt ? 'Runner.Worker\n' : '';
    return f.command(program, args, options);
  };
  manager = createManager(f.config, {
    command,
    sleep: async (ms) => {
      clock.now += ms;
      if (clock.now >= jobEndsAt) releaseWait?.();
    },
  });
  await manager.start();
  assert.ok(
    clock.now - 1_000_000 <= 125_000,
    `drain stopped a running job early at ${clock.now - 1_000_000}ms`,
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm').length,
    1,
  );
});

test('drain deadline stops a job that outlives the window', async (t) => {
  const { f, clock } = await drainHarness(t);
  f.config.drainTimeoutSeconds = 60;
  f.config.shutdownGraceSeconds = 30;
  const messages = [];
  const previousLog = console.log;
  console.log = (message) => messages.push(String(message));
  t.after(() => {
    console.log = previousLog;
  });
  let manager;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'start') manager.stop();
    if (program === 'docker' && args[0] === 'wait')
      return new Promise(() => {});
    if (program === 'docker' && args[0] === 'top') return 'Runner.Worker\n';
    return f.command(program, args, options);
  };
  manager = createManager(f.config, {
    command,
    sleep: async (ms) => {
      clock.now += ms;
      if (clock.now > 1_300_000)
        throw new Error('the drain window never expired');
    },
  });
  await manager.start();
  const elapsed = clock.now - 1_000_000;
  assert.ok(
    elapsed >= 90_000 && elapsed <= 95_000,
    `drain deadline fired at ${elapsed}ms`,
  );
  assert.ok(
    messages.some((message) => message.includes('drain window elapsed')),
    'the forced stop must be visible in the journal',
  );
});

test('the shipped unit allows the example drain window to finish', async () => {
  const example = JSON.parse(
    await readFile(new URL('./config.example.json', import.meta.url), 'utf8'),
  );
  const unit = await readFile(
    new URL('./qwen-ephemeral-runner.service', import.meta.url),
    'utf8',
  );
  const timeout = Number(unit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]);
  assert.ok(
    Number.isFinite(timeout),
    'the shipped unit must set a numeric TimeoutStopSec',
  );
  const budget = example.drainTimeoutSeconds + example.shutdownGraceSeconds;
  assert.ok(
    budget < timeout,
    `drain + grace (${budget}s) must finish before TimeoutStopSec (${timeout}s)`,
  );
});

test('a rate-limited runner deletion backs off on the 15-300 s ladder', async (t) => {
  const { f, clock } = await stallHarness(t);
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
  const deletions = [];
  const command = (program, args, options) => {
    if (program === 'gh' && args.includes('DELETE')) deletions.push(clock.now);
    return f.command(program, args, options);
  };
  const manager = createManager(f.config, {
    command,
    sleep: async (ms) => {
      clock.now += ms;
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

test('a slot that keeps stalling after the alert never alerts again', async (t) => {
  const { f, alerts, clock } = await stallHarness(t);
  let cycles = 0;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'info') {
      cycles += 1;
      return Promise.reject(new Error('docker unavailable'));
    }
    return f.command(program, args, options);
  };
  const manager = createManager(
    { ...f.config, stallAlertSeconds: 20 },
    {
      command,
      sleep: async (ms) => {
        clock.now += ms;
        // Stay wedged for ten minutes: far past the alert, so a per-cycle
        // alert would fire many times before the slot is stopped.
        if (clock.now >= 1_000_000 + 600_000) manager.stop();
      },
    },
  );
  await manager.start();
  const found = alerts();
  assert.equal(
    found.length,
    1,
    `a slot that stays stalled alerted ${found.length} times instead of once`,
  );
  assert.ok(
    cycles >= 10,
    `only ${cycles} failing cycles ran; the scenario needs a sustained stall`,
  );
  assert.match(found[0], /across \d+ consecutive identical failures/);
});

test('a recovered slot that stalls again raises a second alert', async (t) => {
  const { f, alerts, clock } = await stallHarness(t);
  // Six failing cycles carry the first episode past the alert, the seventh
  // completes so the slot recovers, and every later cycle fails again.
  const RECOVER_AT = 7;
  let cycles = 0;
  let failing = true;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'info') {
      cycles += 1;
      failing = cycles !== RECOVER_AT;
    }
    if (failing && program === 'docker' && args[0] === 'info') {
      return Promise.reject(new Error('docker unavailable'));
    }
    return f.command(program, args, options);
  };
  const manager = createManager(
    { ...f.config, stallAlertSeconds: 20 },
    {
      command,
      sleep: async (ms) => {
        clock.now += ms;
        // Stop on the second alert, or after an hour of simulated time so a
        // missing re-arm fails the assertion instead of looping forever.
        if (alerts().length >= 2 || clock.now >= 1_000_000 + 3_600_000)
          manager.stop();
      },
    },
  );
  await manager.start();
  const found = alerts();
  assert.equal(
    found.length,
    2,
    `a slot that recovered and stalled again raised ${found.length} alerts instead of 2`,
  );
  assert.ok(
    cycles >= RECOVER_AT + 4,
    `only ${cycles} cycles ran; the scenario needs a second stall past the threshold`,
  );
  // Both episodes alert from their own clock, so the recovered slot must not
  // inherit the failures counted before it recovered. Compare the two counts
  // rather than a literal: the number itself is backoff-ladder arithmetic, and
  // only their independence is the claim under test.
  const countedFailures = (message) =>
    Number(/across (\d+) consecutive identical failures/.exec(message)[1]);
  assert.equal(
    countedFailures(found[0]),
    countedFailures(found[1]),
    'each episode counts its own failures instead of inheriting the previous run',
  );
});

test('a changed failure message re-arms the stall alert for the new episode', async (t) => {
  const { f, alerts, clock } = await stallHarness(t);
  // The slot never recovers: it alerts on one failure message, the message
  // changes, and the new episode has to alert again on its own clock. Only the
  // new-episode reset clears the latch here, so this is the case that pins it.
  let switched = false;
  const command = (program, args, options) => {
    if (program === 'docker' && args[0] === 'info') {
      if (alerts().length >= 1) switched = true;
      return Promise.reject(
        new Error(switched ? 'network unreachable' : 'docker unavailable'),
      );
    }
    return f.command(program, args, options);
  };
  const manager = createManager(
    { ...f.config, stallAlertSeconds: 20 },
    {
      command,
      sleep: async (ms) => {
        clock.now += ms;
        if (alerts().length >= 2 || clock.now >= 1_000_000 + 3_600_000)
          manager.stop();
      },
    },
  );
  await manager.start();
  const found = alerts();
  assert.equal(
    found.length,
    2,
    `a changed failure message raised ${found.length} alerts instead of 2`,
  );
  assert.match(found[0], /docker unavailable/);
  assert.match(found[1], /network unreachable/);
});

test('a layerless container skips diagnostics and defers removal with a clear reason', async (t) => {
  // hz4 incident: after a dockerd restart some containers lost their
  // RWLayer, so logs/cp/rm all failed with the same opaque `docker failed
  // (exit 1)` every cycle. Cleanup must not waste the diagnostic calls on
  // a container that can never yield them, and the retry message must
  // name the real condition instead of a bare exit code.
  const f = await fixture(t);
  const orphan = f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.setLayerless(orphan);
  await assert.rejects(
    createManager(f.config, { command: f.command }).cycle(1),
    /has no storage layer; removal deferred/,
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'cp').length,
    0,
    'the _diag archive is not attempted once the layer is known lost',
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'rm').length,
    1,
    'removal is still attempted once per cycle',
  );
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    0,
    'no replacement while the wedged record remains',
  );
});

test('a layerless container self-heals once Docker drops the record', async (t) => {
  const f = await fixture(t);
  const orphan = f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  f.setLayerless(orphan);
  const manager = createManager(f.config, { command: f.command });
  await assert.rejects(manager.cycle(1), /has no storage layer/);
  // containerd finishes the task deletion and dockerd drops the record.
  f.removeContainerRecord(orphan);
  await manager.cycle(1);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
    'slot replenished once the wedged record is gone',
  );
});

test('a container the daemon already dropped is treated as removed, not a failure', async (t) => {
  const f = await fixture(t);
  const orphan = f.addOrphanContainer({
    'qwen.pool': 'trial',
    'qwen.slot': '1',
    'qwen.instance': 'ecs-qwen-trial-1-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  });
  // A stale ps listing: every follow-up call reports the container gone.
  f.setGone(orphan);
  await createManager(f.config, { command: f.command }).cycle(1);
  assert.equal(
    f.calls.filter((c) => c.program === 'docker' && c.args[0] === 'create')
      .length,
    1,
    'slot replenished in the same cycle',
  );
});
