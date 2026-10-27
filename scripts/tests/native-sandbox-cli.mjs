/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fakeToolCall,
  startFakeOpenAIServer,
} from '../../integration-tests/fake-openai-server.ts';

const mode = process.argv[2];
assert(['--smoke', '--linux'].includes(mode), 'Use --smoke or --linux');
if (mode === '--linux') {
  assert.equal(process.platform, 'linux', 'Native Linux is required');
  assert.notEqual(
    process.getuid(),
    0,
    'Run as the actual unprivileged runner UID',
  );
}
const bundle = path.resolve(process.argv[3] ?? 'dist/cli.js');
const reportPath = path.resolve(
  process.argv[4] ??
    `.qwen/e2e-tests/issue-12417-native-cli-${mode.slice(2)}.json`,
);
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), 'issue-12417-native-cli-'),
);
const report = {
  mode,
  platform: process.platform,
  arch: process.arch,
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  kernel: os.release(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  bundle,
  bundleSha256: createHash('sha256')
    .update(await fs.readFile(bundle))
    .digest('hex'),
  scriptSha256: createHash('sha256')
    .update(await fs.readFile(fileURLToPath(import.meta.url)))
    .digest('hex'),
  fixtureRoot: root,
  authenticatedSession: false,
  scope:
    mode === '--smoke'
      ? 'unsandboxed fake-provider smoke only'
      : 'public CLI native boundary with fake provider',
  cases: [],
};
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const ns = async (name) =>
  fs.readlink(`/proc/self/ns/${name}`).catch(() => null);
const host = { pid: await ns('pid'), net: await ns('net') };

async function fixture(name, policy) {
  const base = path.join(root, name);
  const dirs = Object.fromEntries(
    ['workspace', 'home', 'runtime', 'scratch'].map((key) => [
      key,
      path.join(base, key),
    ]),
  );
  await Promise.all(
    Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  const globalDir = path.join(dirs.home, '.qwen');
  await fs.mkdir(globalDir);
  await fs.writeFile(
    path.join(globalDir, 'settings.json'),
    JSON.stringify({
      $version: 4,
      ...(policy ? { tools: { executionSandbox: policy } } : {}),
      memory: { enableManagedAutoMemory: false },
      ui: { enableFollowupSuggestions: false },
      telemetry: { enabled: false },
      privacy: { usageStatisticsEnabled: false },
    }),
  );
  const system = path.join(dirs.home, 'system.json');
  const defaults = path.join(dirs.home, 'defaults.json');
  await Promise.all(
    [system, defaults].map((file) => fs.writeFile(file, '{"$version":4}')),
  );
  return {
    name,
    ...dirs,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dirs.home,
      QWEN_HOME: globalDir,
      QWEN_RUNTIME_DIR: dirs.runtime,
      QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
      TMPDIR: dirs.scratch,
      LANG: 'C.UTF-8',
      TERM: 'dumb',
      CI: 'true',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
  };
}

async function run(f, args) {
  const started = Date.now();
  const child = spawn(process.execPath, [bundle, ...args], {
    cwd: f.workspace,
    env: f.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '',
    stderr = '',
    timedOut = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let timer, grace;
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', (error) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The process group may have exited before cancellation.
          }
        }
        reject(error);
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The process group may have exited before cancellation.
        }
        grace = setTimeout(() => {
          child.unref();
          resolve({ code: null, signal: 'SIGKILL', outputComplete: false });
        }, 5_000);
      }, 45_000);
    });
    return {
      args,
      ...exit,
      timedOut,
      durationMs: Date.now() - started,
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

async function record(name, callback) {
  const item = { name, passed: false };
  report.cases.push(item);
  try {
    await callback(item);
    item.passed = true;
  } catch (error) {
    item.error = error.stack;
  }
  process.stderr.write(`${item.passed ? 'PASS' : 'FAIL'} ${name}\n`);
}

async function agentCase(name, policy) {
  await record(name, async (item) => {
    const f = await fixture(name, policy);
    const nonce = randomUUID();
    const marker = `NATIVE_CLI_PROBE_${nonce} `;
    const inside = path.join(f.workspace, 'inside-marker');
    const outside = path.join(f.scratch, 'outside-marker');
    await fs.writeFile(outside, 'unchanged');
    const connections = [];
    const sockets = new Set();
    const listener = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (chunk) => connections.push(chunk.toString()));
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    const program = `
      const fs = require('node:fs'), net = require('node:net');
      const write = (file, flag) => { try { fs.writeFileSync(file, ${JSON.stringify(nonce)}, {flag}); return 'allowed'; } catch (error) { return error.code; } };
      const namespace = (name) => { try { return fs.readlinkSync('/proc/self/ns/' + name); } catch { return null; } };
      (async () => {
        const inside = write(${JSON.stringify(inside)}, 'wx');
        const outside = write(${JSON.stringify(outside)}, 'w');
        const connection = await new Promise((resolve) => {
          const socket = net.connect(${port}, '127.0.0.1');
          socket.setTimeout(1000);
          socket.once('connect', () => { socket.end(${JSON.stringify(nonce)}, () => resolve('allowed')); });
          socket.once('error', (error) => { socket.destroy(); resolve(error.code); });
          socket.once('timeout', () => { socket.destroy(); resolve('TIMEOUT'); });
        });
        console.log(${JSON.stringify(marker)} + JSON.stringify({inside, outside, connection, pid: namespace('pid'), net: namespace('net')}));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const callId = `call_${nonce}`;
    let received;
    let issued = 0;
    let server;
    try {
      server = await startFakeOpenAIServer(({ body }) => {
        const result = body.messages?.find(
          (message) =>
            message.role === 'tool' && message.tool_call_id === callId,
        );
        if (result) {
          received = result;
          return { content: `COMPLETE_${nonce}` };
        }
        if (
          body.stream === true &&
          body.tools?.some(
            (tool) => tool.function?.name === 'run_shell_command',
          )
        ) {
          issued++;
          return {
            toolCalls: [
              fakeToolCall(
                'run_shell_command',
                {
                  command: `${quote(process.execPath)} -e ${quote(program)}`,
                  is_background: false,
                  timeout: 10_000,
                },
                callId,
              ),
            ],
          };
        }
        return { content: '{"selected_memories":[]}' };
      });
      item.policy = policy ?? null;
      item.run = await run(f, [
        '--auth-type',
        'openai',
        '--model',
        'fake-model',
        '--openai-base-url',
        server.baseUrl,
        '--openai-api-key',
        'fake-key',
        '--approval-mode',
        'yolo',
        '--output-format',
        'json',
        '--no-chat-recording',
        '-p',
        `Execute the one requested shell probe for ${nonce}, then finish.`,
      ]);
      item.requests = server.requests.map(({ body }) => ({
        stream: body.stream,
        toolResults: body.messages?.filter(
          (message) => message.role === 'tool',
        ),
      }));
      item.issuedToolCalls = issued;
      item.receivedToolResult = received ?? null;
      assert.equal(item.run.code, 0, item.run.stderr);
      assert.equal(item.run.timedOut, false);
      assert.equal(issued, 1, 'Exactly one real shell invocation is expected');
      assert(
        received,
        'CLI must return the shell tool result to the fake provider',
      );
      const text =
        typeof received.content === 'string'
          ? received.content
          : received.content.map((part) => part.text ?? '').join('\n');
      const output = text
        .split('\n')
        .find((line) => line.startsWith(`Output: ${marker}`));
      assert(
        output,
        'Tool result must contain the actual payload output, not the echoed command',
      );
      const observed = JSON.parse(output.slice(`Output: ${marker}`.length));
      const messages = JSON.parse(item.run.stdout);
      assert(
        messages.some(
          (message) =>
            message.type === 'user' &&
            message.message?.content?.some(
              (part) =>
                part.type === 'tool_result' &&
                part.tool_use_id === callId &&
                part.is_error === false,
            ),
        ),
        'CLI must emit a successful actual shell result',
      );
      item.observed = observed;
      item.hostNamespaces = host;
      const denied = policy?.backend === 'landlock' ? 'EACCES' : 'EROFS';
      const canWrite = !policy || policy.filesystem === 'workspace-write';
      assert.equal(observed.inside, canWrite ? 'allowed' : denied);
      assert.equal(observed.outside, policy ? denied : 'allowed');
      assert.equal(
        await fs.readFile(outside, 'utf8'),
        policy ? 'unchanged' : nonce,
      );
      if (canWrite) assert.equal(await fs.readFile(inside, 'utf8'), nonce);
      else
        assert.equal(
          await fs.access(inside).then(
            () => true,
            () => false,
          ),
          false,
        );
      if (policy?.network === 'closed') {
        assert(
          [
            'ECONNREFUSED',
            'ENETUNREACH',
            'EHOSTUNREACH',
            'EACCES',
            'EPERM',
          ].includes(observed.connection),
          `Unexpected connection result: ${observed.connection}`,
        );
        assert.equal(connections.join(''), '');
      } else {
        assert.equal(observed.connection, 'allowed');
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(connections.join(''), nonce);
      }
      if (policy) {
        assert(host.pid && host.net && observed.pid && observed.net);
        if (policy.backend === 'bwrap') assert.notEqual(observed.pid, host.pid);
        else assert.equal(observed.pid, host.pid);
        if (policy.network === 'closed')
          assert.notEqual(observed.net, host.net);
        else assert.equal(observed.net, host.net);
      }
    } finally {
      try {
        await server?.close();
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => listener.close(resolve));
      }
    }
  });
}

if (mode === '--smoke') {
  await agentCase('unsandboxed-fake-provider-smoke');
} else {
  for (const backend of ['bwrap', 'landlock']) {
    for (const filesystem of ['workspace-write', 'read-only']) {
      for (const network of backend === 'bwrap'
        ? ['open', 'closed']
        : ['open']) {
        const name = `verify-${backend}-${filesystem}-${network}`;
        await record(name, async (item) => {
          const policy = { backend, filesystem, network };
          const f = await fixture(name, policy);
          item.policy = policy;
          item.run = await run(f, ['sandbox', '--verify']);
          assert.equal(item.run.code, 0, item.run.stderr);
          assert.equal(item.run.timedOut, false);
          assert(item.run.stdout.includes(`backend: ${backend} → ${backend}`));
          assert.equal((item.run.stdout.match(/^PASS /gm) ?? []).length, 4);
          assert(!/^FAIL /m.test(item.run.stdout));
          assert(item.run.stdout.includes('Confinement verified (4 checks).'));
        });
      }
    }
  }
  for (const backend of ['bwrap', 'landlock']) {
    for (const filesystem of ['workspace-write', 'read-only']) {
      await agentCase(`agent-${backend}-${filesystem}`, {
        backend,
        filesystem,
        network: backend === 'bwrap' ? 'closed' : 'open',
      });
    }
  }
  const policy = {
    backend: 'bwrap',
    filesystem: 'workspace-write',
    network: 'closed',
  };
  await record('invalid-TMPDIR-diagnostic', async (item) => {
    const f = await fixture(item.name, policy);
    f.env.TMPDIR = path.join(f.scratch, 'not-a-directory');
    await fs.writeFile(f.env.TMPDIR, 'ordinary file');
    item.run = await run(f, ['sandbox', '--verify']);
    assert.equal(item.run.code, 1);
    assert.equal(item.run.timedOut, false);
    assert(!item.run.stdout.includes('Backend probe: passed'));
    assert(
      item.run.stderr.includes(
        'Cannot create verification fixture in host temporary directory',
      ),
    );
    assert(item.run.stderr.includes('Check TMPDIR and its permissions'));
    assert(
      item.run.stderr.includes(
        'this failure does not test the sandbox boundary',
      ),
    );
    assert(!item.run.stdout.includes('Confinement verified'));
  });
  await record('linked-worktree-common-metadata-read-only', async (item) => {
    const f = await fixture(item.name, policy);
    const main = path.join(f.scratch, 'main-repo');
    const git = (args) =>
      execFileSync('git', args, {
        env: f.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    git(['init', main]);
    git([
      '-C',
      main,
      '-c',
      'user.name=probe',
      '-c',
      'user.email=probe@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    git(['-C', main, 'worktree', 'add', '-b', 'probe', f.workspace]);
    const common = path.resolve(
      f.workspace,
      git(['-C', f.workspace, 'rev-parse', '--git-common-dir']).trim(),
    );
    assert(!common.startsWith(f.workspace + path.sep));
    const config = path.join(common, 'config');
    const original = await fs.readFile(config);
    item.commonDirectory = common;
    item.read = await run(f, ['sandbox', '--', 'git', 'status', '--porcelain']);
    assert.equal(item.read.code, 0, item.read.stderr);
    item.write = await run(f, [
      'sandbox',
      '--',
      'git',
      'config',
      '--local',
      'probe.nativeCli',
      'must-not-persist',
    ]);
    assert.notEqual(item.write.code, 0);
    assert.equal(item.write.timedOut, false);
    assert(/Read-only file system|Permission denied/.test(item.write.stderr));
    assert.deepEqual(await fs.readFile(config), original);
    assert.equal(
      await fs.access(config + '.lock').then(
        () => true,
        () => false,
      ),
      false,
    );
  });
}
report.passed = report.cases.every((item) => item.passed);
report.fixtureDisposition = report.passed
  ? 'removed'
  : 'retained for investigation';
if (report.passed) await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`${reportPath}\n`);
process.exitCode = report.passed ? 0 : 1;
