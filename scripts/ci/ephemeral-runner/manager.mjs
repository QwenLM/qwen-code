import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export function command(
  program,
  args,
  { env = process.env, input, timeout = 30000, binary = false } = {},
) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = [];
    let outputSize = 0;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize > 4 * 1024 * 1024) child.kill('SIGKILL');
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && outputSize <= 4 * 1024 * 1024)
        resolveCommand(
          binary ? Buffer.concat(output) : Buffer.concat(output).toString(),
        );
      else {
        const status = Number(stderr.match(/HTTP (\d{3})/)?.[1] || 0);
        const error = new Error(
          `${program} failed (exit ${code}${status ? `, HTTP ${status}` : ''})`,
        );
        error.status = status;
        error.exitCode = code;
        reject(error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function validate(c) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(c.repo || '') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,39}$/.test(c.poolId || '') ||
    !/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(
      c.image || '',
    ) ||
    !Number.isInteger(c.slots) ||
    c.slots < 1 ||
    c.slots > 10 ||
    !Number.isInteger(c.runnerGroupId) ||
    c.runnerGroupId < 1 ||
    !Array.isArray(c.labels) ||
    !c.labels.length ||
    !c.labels.every(
      (label) =>
        typeof label === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(label),
    ) ||
    typeof c.stateDir !== 'string' ||
    !isAbsolute(c.stateDir) ||
    typeof c.logDir !== 'string' ||
    !isAbsolute(c.logDir) ||
    (c.dockerSocket !== undefined &&
      (typeof c.dockerSocket !== 'string' ||
        !isAbsolute(c.dockerSocket) ||
        c.dockerSocket.includes('\n'))) ||
    !Number.isFinite(c.cpus) ||
    !(c.cpus > 0) ||
    !/^[1-9]\d*[mMgG]$/.test(c.memory || '') ||
    !Number.isInteger(c.pidsLimit) ||
    c.pidsLimit < 1 ||
    !Number.isFinite(c.ttlSeconds) ||
    !(c.ttlSeconds > 0) ||
    !Number.isFinite(c.shutdownGraceSeconds) ||
    !(c.shutdownGraceSeconds >= 0) ||
    !Number.isSafeInteger(c.minDiskBytes) ||
    c.minDiskBytes < 0
  )
    throw new Error('Invalid manager configuration');
  if (c.proxy !== undefined) {
    if (
      typeof c.proxy !== 'object' ||
      c.proxy === null ||
      Array.isArray(c.proxy)
    )
      throw new Error('Invalid proxy configuration');
    const { http, https, noProxy } = c.proxy;
    // The proxy env reaches untrusted fork jobs, so a URL with embedded
    // credentials would leak them; reject userinfo outright.
    const validProxyUrl = (value) => {
      if (typeof value !== 'string' || !value) return false;
      try {
        const url = new URL(value);
        return !url.username && !url.password;
      } catch {
        return false;
      }
    };
    if (http !== undefined && !validProxyUrl(http))
      throw new Error('Invalid proxy.http');
    if (https !== undefined && !validProxyUrl(https))
      throw new Error('Invalid proxy.https');
    if (noProxy !== undefined && (typeof noProxy !== 'string' || !noProxy))
      throw new Error('Invalid proxy.noProxy');
  }
}

export function createManager(config, dependencies = {}) {
  validate(config);
  const runnerName = (slot) =>
    `ecs-qwen-${config.poolId}-${String(slot).padStart(2, '0')}`;
  const execute = dependencies.command || command;
  const run = (program, args, options = {}) => {
    if (program !== 'docker') return execute(program, args, options);
    const source = options.env || process.env;
    const env = {};
    for (const key of ['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR']) {
      if (source[key] !== undefined) env[key] = source[key];
    }
    env.DOCKER_HOST = `unix://${config.dockerSocket || '/var/run/docker.sock'}`;
    if (args[0] === 'create' && options.env?.RUNNER_JIT_CONFIG)
      env.RUNNER_JIT_CONFIG = options.env.RUNNER_JIT_CONFIG;
    if (args[0] === 'create' && config.proxy) {
      if (config.proxy.http) env.HTTP_PROXY = config.proxy.http;
      if (config.proxy.https) env.HTTPS_PROXY = config.proxy.https;
      if (config.proxy.noProxy) env.NO_PROXY = config.proxy.noProxy;
    }
    return execute(program, args, { ...options, env });
  };
  const wait = dependencies.sleep || sleep;
  const diskStats = dependencies.statfs || statfs;
  let stopping = false;
  let stopAt = Infinity;
  const stateDir = resolve(config.stateDir);
  const logDir = resolve(config.logDir);
  const lockPath = join(stateDir, 'manager.lock');
  const slotPath = (slot) => join(stateDir, `slot-${slot}.json`);
  const log = (message) => console.log(`[${config.poolId}] ${message}`);
  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Invalid JSON response from GitHub');
    }
  }

  async function gh(args, input) {
    return run('gh', ['api', ...args, ...(input ? ['--input', '-'] : [])], {
      env: process.env,
      input: input && JSON.stringify(input),
    });
  }

  async function save(slot, state) {
    const path = slotPath(slot);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, path);
  }

  async function load(slot) {
    try {
      const raw = await readFile(slotPath(slot), 'utf8');
      let state;
      try {
        state = JSON.parse(raw);
      } catch {
        throw new Error('Invalid slot state; manual reconciliation required');
      }
      // Reconcile identities created before the ECS-compatible name prefix.
      const name =
        typeof state?.name === 'string' ? state.name.replace(/^ecs-/, '') : '';
      const prefix = `qwen-${config.poolId}-${slot}-`;
      if (
        !name.startsWith(prefix) ||
        !/^[0-9a-f-]{36}$/.test(name.slice(prefix.length)) ||
        (state.runnerName !== undefined &&
          state.runnerName !== runnerName(slot)) ||
        typeof state.uncertain !== 'boolean' ||
        (!state.uncertain &&
          (!Number.isSafeInteger(state.runnerId) || state.runnerId < 1)) ||
        (state.runnerId !== undefined &&
          (!Number.isSafeInteger(state.runnerId) || state.runnerId < 1))
      )
        throw new Error('Invalid slot state; manual reconciliation required');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function listContainers(slot) {
    const output = await run('docker', [
      'ps',
      '-aq',
      '--no-trunc',
      '--filter',
      `label=qwen.pool=${config.poolId}`,
      '--filter',
      `label=qwen.slot=${slot}`,
    ]);
    return output.trim().split('\n').filter(Boolean);
  }

  async function listNetworks(slot) {
    const args = [
      'network',
      'ls',
      '-q',
      '--no-trunc',
      '--filter',
      `label=qwen.pool=${config.poolId}`,
    ];
    if (slot !== undefined) args.push('--filter', `label=qwen.slot=${slot}`);
    return (await run('docker', args)).trim().split('\n').filter(Boolean);
  }

  async function listRunners() {
    const output = await gh([
      '--paginate',
      '--jq',
      '.runners | @json',
      `/repos/${config.repo}/actions/runners?per_page=100`,
    ]);
    const pages = output.trim().split('\n').map(parseJson);
    if (
      !pages.every(
        (runners) =>
          Array.isArray(runners) &&
          runners.every(
            (runner) =>
              typeof runner?.name === 'string' &&
              Number.isSafeInteger(runner.id) &&
              runner.id > 0,
          ),
      )
    )
      throw new Error('Invalid GitHub runner list');
    return pages.flat();
  }

  async function pruneLogs() {
    const files = [];
    for (const entry of await readdir(logDir, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !entry.name.replace(/^ecs-/, '').startsWith(`qwen-${config.poolId}-`) ||
        !/\.(log|tar)$/.test(entry.name)
      )
        continue;
      const path = join(logDir, entry.name);
      const info = await lstat(path);
      files.push({ path, size: info.size, time: info.mtimeMs });
    }
    files.sort((a, b) => b.time - a.time);
    let size = 0;
    for (const file of files) {
      size += file.size;
      if (file.time < Date.now() - 7 * 86400000 || size > 100 * 1024 * 1024)
        await rm(file.path, { force: true });
    }
  }

  async function cleanup(slot, state) {
    const containers = await listContainers(slot);
    const networks = await listNetworks(slot);
    if ((containers.length || networks.length) && !state?.name)
      throw new Error(
        'Container has no recorded runner identity; manual reconciliation required',
      );
    for (const id of containers) {
      try {
        const logs = await run('docker', ['logs', '--tail', '10000', id]);
        await writeFile(
          join(
            logDir,
            `${state?.name || `slot-${slot}`}-${id.slice(0, 12)}.log`,
          ),
          logs.slice(-1024 * 1024),
          { mode: 0o600 },
        );
        await pruneLogs();
      } catch {
        log(`slot ${slot}: container logs unavailable`);
      }
      try {
        const archive = await run(
          'docker',
          ['cp', `${id}:/home/node/actions-runner/_diag`, '-'],
          { binary: true },
        );
        await writeFile(
          join(logDir, `${state.name}-${id.slice(0, 12)}.tar`),
          archive,
          { mode: 0o600 },
        );
        await pruneLogs();
      } catch {
        log(
          `slot ${slot}: runner diagnostics unavailable or larger than 4 MiB`,
        );
      }
      await run('docker', ['rm', '-f', '-v', id]);
    }
    if ((await listContainers(slot)).length)
      throw new Error('Container cleanup failed');
    for (const id of networks) await run('docker', ['network', 'rm', id]);
    if ((await listNetworks(slot)).length)
      throw new Error('Network cleanup failed');
    if (state?.name) {
      const name = state.runnerName ?? state.name;
      const all = await listRunners();
      const runners = all.filter((runner) => runner.name === name);
      if (
        state.runnerId &&
        (runners.some((runner) => runner.id !== state.runnerId) ||
          all.some(
            (runner) => runner.id === state.runnerId && runner.name !== name,
          ))
      )
        throw new Error(
          'Runner identity mismatch; manual reconciliation required',
        );
      if (
        runners.length > 1 ||
        runners.some(
          (runner) => !Number.isSafeInteger(runner.id) || runner.id < 1,
        )
      )
        throw new Error(
          'Ambiguous runner identity; manual reconciliation required',
        );
      if (state.uncertain && !runners.length)
        throw new Error(
          'JIT response was lost; runner not found, manual reconciliation required',
        );
      for (const runner of runners) {
        try {
          await gh([
            '-X',
            'DELETE',
            `/repos/${config.repo}/actions/runners/${runner.id}`,
          ]);
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    }
    await rm(slotPath(slot), { force: true });
    log(`slot ${slot}: cleaned`);
  }

  async function cycle(slot) {
    let earlyExit = false;
    let state = await load(slot);
    if (
      state ||
      (await listContainers(slot)).length ||
      (await listNetworks(slot)).length
    )
      await cleanup(slot, state);
    if (stopping) return;
    const dockerRoot = (
      await run('docker', ['info', '--format', '{{.DockerRootDir}}'])
    ).trim();
    if (!isAbsolute(dockerRoot) || dockerRoot.includes('\n'))
      throw new Error('Invalid Docker Root Dir');
    const disk = await diskStats(dockerRoot);
    if (disk.bavail * disk.bsize < config.minDiskBytes)
      throw new Error(
        `Insufficient disk capacity on Docker Root Dir ${dockerRoot}`,
      );
    state = {
      name: `ecs-qwen-${config.poolId}-${slot}-${randomUUID()}`,
      runnerName: runnerName(slot),
      createdAt: new Date().toISOString(),
      uncertain: true,
    };
    await save(slot, state);
    let result;
    try {
      result = parseJson(
        await gh(
          [
            '-X',
            'POST',
            `/repos/${config.repo}/actions/runners/generate-jitconfig`,
          ],
          {
            name: state.runnerName,
            runner_group_id: config.runnerGroupId,
            labels: config.labels,
            work_folder: '_work',
          },
        ),
      );
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 408) {
        await rm(slotPath(slot), { force: true });
      } else {
        await cleanup(slot, state);
      }
      throw error;
    }
    try {
      if (
        result?.runner?.name !== state.runnerName ||
        !Number.isSafeInteger(result.runner.id) ||
        result.runner.id < 1
      )
        throw new Error('Invalid JIT runner identity');
      state.runnerId = result.runner.id;
      state.uncertain = false;
      await save(slot, state);
      if (!result.encoded_jit_config)
        throw new Error('GitHub returned no JIT configuration');
      const networkId = (
        await run('docker', [
          'network',
          'create',
          '--driver',
          'bridge',
          '--opt',
          'com.docker.network.bridge.enable_icc=false',
          '--label',
          `qwen.pool=${config.poolId}`,
          '--label',
          `qwen.slot=${slot}`,
          '--label',
          `qwen.instance=${state.name}`,
          state.name,
        ])
      ).trim();
      if (!networkId) throw new Error('Docker returned no network ID');
      state.networkId = networkId;
      await save(slot, state);
      const env = {
        ...process.env,
        RUNNER_JIT_CONFIG: result.encoded_jit_config,
      };
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      const id = (
        await run(
          'docker',
          [
            'create',
            '--init',
            '--network',
            networkId,
            '--label',
            `qwen.pool=${config.poolId}`,
            '--label',
            `qwen.slot=${slot}`,
            '--label',
            `qwen.instance=${state.name}`,
            '--cpus',
            String(config.cpus),
            '--memory',
            config.memory,
            '--pids-limit',
            String(config.pidsLimit),
            '--log-driver',
            'json-file',
            '--log-opt',
            'max-size=10m',
            '--log-opt',
            'max-file=3',
            '--env',
            'RUNNER_JIT_CONFIG',
            ...(config.proxy?.http ? ['--env', 'HTTP_PROXY'] : []),
            ...(config.proxy?.https ? ['--env', 'HTTPS_PROXY'] : []),
            ...(config.proxy?.noProxy ? ['--env', 'NO_PROXY'] : []),
            config.image,
          ],
          { env },
        )
      ).trim();
      state.containerId = id;
      await save(slot, state);
      if (!id) throw new Error('Docker returned no container ID');
      if (!stopping) {
        await run('docker', ['start', id]);
        log(
          `slot ${slot}: started runner ${state.runnerName}, id ${state.runnerId}, container ${id}`,
        );
        const deadline = Date.now() + config.ttlSeconds * 1000;
        let exitCode;
        const watching = run('docker', ['wait', id], {
          timeout: (config.ttlSeconds + 10) * 1000,
        }).then(
          (output) => {
            const status = output.trim();
            exitCode =
              /^\d+$/.test(status) && Number(status) <= 255
                ? Number(status)
                : null;
            return true;
          },
          () => {
            exitCode = null;
            return true;
          },
        );
        while (Date.now() < Math.min(deadline, stopAt)) {
          if (await Promise.race([watching, wait(1000).then(() => false)]))
            break;
        }
        if (exitCode !== undefined && exitCode !== 0) {
          earlyExit = true;
          log(
            `slot ${slot}: runner exit status ${exitCode ?? 'unknown'}; next JIT request is delayed`,
          );
        }
      }
    } finally {
      await cleanup(slot, state);
    }
    return { earlyExit };
  }

  async function acquireLock() {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const child = spawn('flock', ['-n', lockPath, 'cat'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    await new Promise((resolveLock, reject) => {
      child.once('error', reject);
      child.once('exit', () =>
        reject(new Error('Could not acquire manager lock')),
      );
      child.stdout.once('data', resolveLock);
      child.stdin.on('error', () => {});
      child.stdin.write('locked\n');
    });
    return child;
  }

  async function start() {
    const lock = await acquireLock();
    try {
      const slots = (
        await run('docker', [
          'ps',
          '-a',
          '--filter',
          `label=qwen.pool=${config.poolId}`,
          '--format',
          '{{.Label "qwen.slot"}}',
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const states = (await readdir(stateDir))
        .map((name) => name.match(/^slot-(\d+)\.json$/)?.[1])
        .filter(Boolean);
      const networkSlots = await Promise.all(
        (await listNetworks()).map(async (id) =>
          (
            await run('docker', [
              'network',
              'inspect',
              '--format',
              '{{index .Labels "qwen.slot"}}',
              id,
            ])
          ).trim(),
        ),
      );
      if (
        [...slots, ...states, ...networkSlots].some(
          (slot) =>
            !/^\d+$/.test(slot) ||
            Number(slot) < 1 ||
            Number(slot) > config.slots,
        )
      ) {
        throw new Error(
          'Pool contains resources outside configured slots; reconcile before starting',
        );
      }
      await Promise.all(
        Array.from({ length: config.slots }, async (_, i) => {
          const slot = i + 1;
          while (!stopping) {
            try {
              const result = await cycle(slot);
              if (result?.earlyExit && !stopping) {
                log(`slot ${slot}: backing off 60 s before replenishing`);
                await wait(60000);
              }
            } catch (error) {
              log(
                `slot ${slot}: ${error.message}; retrying without replenishing`,
              );
              await wait(10000);
            }
          }
        }),
      );
    } finally {
      lock.stdin.end();
    }
  }
  function stop() {
    stopping = true;
    stopAt = Math.min(stopAt, Date.now() + config.shutdownGraceSeconds * 1000);
  }
  return { start, stop, cycle, cleanup };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (!process.env.GH_TOKEN?.trim()) throw new Error('GH_TOKEN is required');
    const config = JSON.parse(
      await readFile(resolve(process.argv[2] || ''), 'utf8'),
    );
    const manager = createManager(config);
    process.on('SIGTERM', manager.stop);
    process.on('SIGINT', manager.stop);
    await manager.start();
  } catch (error) {
    console.error(`manager: ${error.message}`);
    process.exitCode = 1;
  }
}
