/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [input] = process.argv.slice(2);
assert(input, 'usage: node run.mjs fresh-output/fixture.json');
const configFile = fs.realpathSync(input);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
assert.equal(path.dirname(configFile), config.root);
assert.equal(config.workload.synthetic, true);
assert.equal(config.workload.equivalentToPrivateWorkload, false);
const compileCache = path.join(config.tmp, 'node-compile-cache');
for (const file of [
  config.runtime,
  path.join(config.qwenHome, 'tmp'),
  compileCache,
]) {
  assert(!fs.existsSync(file), 'fixture must be unused');
}
fs.writeFileSync(path.join(config.root, '.run-started'), '', { flag: 'wx' });
const sha = (file) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const here = import.meta.dirname;
const packageJson = fileURLToPath(
  new URL('../../../packages/sdk-typescript/package.json', import.meta.url),
);
const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
const sdkEntry = path.resolve(
  path.dirname(packageJson),
  pkg.exports['./daemon'].import,
);
const inputs = [
  configFile,
  packageJson,
  sdkEntry,
  config.cliEntry,
  config.serveModule,
  config.fastPathModule,
  path.join(config.root, 'synthetic-manifest.json'),
  ...['settings.json', 'trustedFolders.json'].map((name) =>
    path.join(config.qwenHome, name),
  ),
  ...['fixture.mjs', 'daemon.mjs', 'run.mjs'].map((name) =>
    path.join(here, name),
  ),
];
const inputHashes = inputs.map((file) => ({ file, sha256: sha(file) }));
const { DaemonClient } = await import(pathToFileURL(sdkEntry));
const host = () => ({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  release: os.release(),
  cpus: os.cpus().length,
  cpuModel: os.cpus()[0]?.model,
  loadAverage: os.loadavg(),
  freeMemory: os.freemem(),
  totalMemory: os.totalmem(),
});
const row = {
  workload: config.workload,
  sdk: { name: pkg.name, version: pkg.version, importOutsideBothClocks: true },
  inputs: inputHashes,
  hostBefore: host(),
  utcStartedAt: new Date().toISOString(),
  events: [],
  requests: [],
  sessions: [],
  metrics: {},
  passed: false,
};
const stamp = () => performance.timeOrigin + performance.now();
const bounded = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
const token = randomUUID();
const started = stamp();
const child = spawn(
  process.execPath,
  [path.join(here, 'daemon.mjs'), configFile],
  {
    cwd: config.workspace,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      HOME: config.home,
      QWEN_HOME: config.qwenHome,
      QWEN_RUNTIME_DIR: config.runtime,
      TMPDIR: config.tmp,
      NODE_COMPILE_CACHE: compileCache,
      QWEN_CLI_ENTRY: config.cliEntry,
      QWEN_SERVER_TOKEN: token,
      CI: '1',
      NO_COLOR: '1',
      OPENAI_API_KEY: 'benchmark-placeholder',
      OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
      OPENAI_MODEL: 'benchmark-model',
      QWEN_CODE_DISABLE_TELEMETRY: '1',
      QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
    },
  },
);
const exited = new Promise((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }));
  child.once('error', (error) =>
    resolve({ code: null, signal: null, error: String(error) }),
  );
});
let stdout = '';
let stderr = '';
let listenerUrl;
let ready;
let resolveReady;
let rejectReady;
let resolveBarrier;
const available = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
const maybeReady = () => {
  if (listenerUrl && ready) resolveReady(listenerUrl);
};
child.on('message', (event) => {
  row.events.push(event);
  if (event.kind === 'daemon-ready') {
    ready = event;
    maybeReady();
  }
  if (event.kind === 'evidence-barrier') resolveBarrier?.();
});
child.on('error', rejectReady);
child.once('exit', () =>
  rejectReady(new Error('daemon exited before readiness')),
);
child.stdout.on('data', (value) => {
  stdout += value;
  const port = stdout.match(/listening on https?:\/\/[^\s:]+:(\d+)/)?.[1];
  if (port && !listenerUrl) {
    row.metrics.spawnToListenerObservedMs = stamp() - started;
    listenerUrl = `http://127.0.0.1:${port}`;
    maybeReady();
  }
});
child.stderr.on('data', (value) => {
  stderr += value;
});
try {
  const baseUrl = await bounded(available, 60_000, 'daemon readiness');
  row.metrics.spawnToRequestBoundaryMs = stamp() - started;
  row.metrics.spawnToRuntimeReadyMs = ready.at - started;
  assert.equal(ready.sessionCount, 0);
  assert.equal(ready.channelLive, false);
  assert.equal(ready.preheatBridge, false);
  const cache = row.events.find((event) => event.kind === 'compile-cache');
  assert(
    [
      constants.compileCacheStatus.ENABLED,
      constants.compileCacheStatus.ALREADY_ENABLED,
    ].includes(cache?.status),
    'Node compile cache must be enabled',
  );
  const cacheRelative = path.relative(
    fs.realpathSync(compileCache),
    fs.realpathSync(cache.directory),
  );
  assert(
    !path.isAbsolute(cacheRelative) &&
      cacheRelative !== '..' &&
      !cacheRelative.startsWith(`..${path.sep}`),
    'Node compile cache escaped its fresh root',
  );
  let phase;
  const observedFetch = async (url, init) => {
    const request = {
      route: new URL(url).pathname,
      method: init?.method ?? 'GET',
      phase,
      before: stamp(),
    };
    row.requests.push(request);
    const response = await fetch(url, init);
    request.headersAt = stamp();
    request.status = response.status;
    const json = response.json.bind(response);
    response.json = async (...args) => {
      try {
        return await json(...args);
      } finally {
        request.end = stamp();
        request.ms = request.end - request.before;
      }
    };
    return response;
  };
  const client = new DaemonClient({
    baseUrl,
    token,
    fetch: observedFetch,
    fetchTimeoutMs: 60_000,
  });
  for (let index = 0; index < 3; index++) {
    phase = `create${index + 1}`;
    const requestedId = randomUUID();
    if (index === 0) assert.equal(row.requests.length, 0);
    const before = stamp();
    const session = await client.createOrAttachSession({
      workspaceCwd: config.workspace,
      sessionScope: 'thread',
      sessionId: requestedId,
    });
    const end = stamp();
    assert.equal(session.sessionId, requestedId);
    assert.equal(session.attached, false);
    row.sessions.push({
      requestedId,
      returnedId: session.sessionId,
      attached: session.attached,
      before,
      end,
    });
    row.metrics[`sdkCreate${index + 1}Ms`] = end - before;
    if (index === 0) {
      const requests = row.requests.filter(
        (request) => request.phase === phase,
      );
      assert.deepEqual(
        requests.map((request) => [request.method, request.route]),
        [
          ['GET', '/capabilities'],
          ['POST', '/session'],
        ],
      );
      assert(
        requests.every(
          (request) =>
            request.status === 200 &&
            request.before >= before &&
            request.end <= end,
        ),
      );
      row.metrics.firstSdkCreateMs = end - before;
      row.metrics.firstCapabilitiesMs = requests[0].ms;
      row.metrics.firstSessionPostMs = requests[1].ms;
      row.metrics.spawnToFirstSdkCompletionMs = end - started;
    }
  }
  assert.equal(
    new Set(row.sessions.map((session) => session.returnedId)).size,
    3,
  );
  row.threeFreshUuidSessions = true;
  phase = 'post-create-status';
  const response = await observedFetch(`${baseUrl}/daemon/status`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.daemon.startup.preheat.status, 'not_scheduled');
  row.preheatNotScheduled = true;
  const barrier = new Promise((resolve) => {
    resolveBarrier = resolve;
  });
  child.send({ kind: 'evidence-barrier' });
  await bounded(barrier, 5_000, 'evidence barrier');
  const first = row.events.find((event) => event.kind === 'first-http');
  assert.equal(first?.method, 'GET');
  assert.equal(first?.route, '/capabilities');
  const acp = row.events.filter(
    (event) => event.kind === 'child-spawn' && event.acp,
  );
  assert(acp.length > 0);
  assert(
    acp.every(
      (event) =>
        Number.isInteger(event.pid) &&
        event.at >= first.at &&
        event.at >= row.sessions[0].before,
    ),
  );
  row.noPrecallAcpSpawn = true;
  row.passed = true;
} catch (error) {
  row.error = String(error.stack ?? error);
} finally {
  try {
    if (child.connected) child.send({ kind: 'close' });
    row.stop = await bounded(exited, 20_000, 'graceful shutdown');
    assert(row.stop.code === 0 && row.stop.signal === null);
    assert.equal(
      row.events.filter((event) => event.kind === 'closed').length,
      1,
    );
    assert(!row.events.some((event) => event.kind === 'close-error'));
    const acp = row.events.filter(
      (event) => event.kind === 'child-spawn' && event.acp,
    );
    assert(acp.length > 0);
    for (const event of acp) {
      assert(
        row.events.some(
          (item) => item.kind === 'acp-exit' && item.pid === event.pid,
        ),
      );
      assert.equal(isAlive(event.pid), false);
    }
    row.gracefulShutdown = true;
  } catch (error) {
    row.passed = false;
    row.shutdownError = String(error.stack ?? error);
    row.forcedShutdown = child.exitCode === null && child.signalCode === null;
    child.kill('SIGKILL');
    row.stop = await bounded(exited, 5_000, 'forced termination').catch(
      (error) => ({ error: String(error) }),
    );
  }
  for (const event of row.events.filter(
    (item) =>
      item.kind === 'child-spawn' && item.acp && Number.isInteger(item.pid),
  )) {
    try {
      assert.equal(
        isAlive(event.pid),
        false,
        'Recorded ACP PID still exists; identity is unverified, so no signal was sent',
      );
    } catch (error) {
      row.passed = false;
      row.cleanupError = String(error.stack ?? error);
    }
  }
  try {
    for (const input of inputHashes)
      assert.equal(sha(input.file), input.sha256);
    row.recordedInputsUnchanged = true;
  } catch (error) {
    row.passed = false;
    row.inputError = String(error.stack ?? error);
  }
  row.hostAfter = host();
  row.utcCompletedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(config.root, 'result.raw.json'),
    `${JSON.stringify(row, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(config.root, 'daemon.stdout.log'), stdout);
  fs.writeFileSync(path.join(config.root, 'daemon.stderr.log'), stderr);
}
const summary = {
  passed: row.passed,
  synthetic: true,
  equivalentToPrivateWorkload: false,
  ...row.metrics,
  fixtureResources: config.workload.resources,
  fixtureSkills: config.workload.skills,
  fixtureResourceFiles: config.workload.resourceFiles,
  fixtureResourceBytes: config.workload.resourceBytes,
  zeroInitialSessions: ready?.sessionCount === 0,
  noInitialChannel: ready?.channelLive === false,
  noPrecallAcpSpawn: row.noPrecallAcpSpawn === true,
  preheatNotScheduled: row.preheatNotScheduled === true,
  threeFreshUuidSessions: row.threeFreshUuidSessions === true,
  gracefulShutdown: row.gracefulShutdown === true,
  forcedCleanup: row.forcedShutdown === true,
  recordedInputsUnchanged: row.recordedInputsUnchanged === true,
};
fs.writeFileSync(
  path.join(config.root, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
if (!row.passed) process.exitCode = 1;
