/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  renameSync,
  statSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const self = fileURLToPath(import.meta.url);
const installation = path.dirname(self);
const cleanEnv = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: os.homedir(),
  LANG: 'C.UTF-8',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  ...(process.env.QWEN_SANDBOX_TEST_REPORT
    ? { QWEN_SANDBOX_TEST_REPORT: process.env.QWEN_SANDBOX_TEST_REPORT }
    : {}),
};
if (process.platform !== 'linux')
  throw new Error('Real Linux is required; no skip.');
if (!['--clean', '--parent-driver'].includes(process.argv[2])) {
  if (process.env.QWEN_SANDBOX_TEST_REPORT)
    rmSync(process.env.QWEN_SANDBOX_TEST_REPORT, { force: true });
  const child = spawnSync(process.execPath, [self, '--clean'], {
    env: cleanEnv,
    stdio: 'inherit',
    timeout: 180_000,
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const {
  ShellExecutionService: service,
  executeBwrap,
  writeSandboxFile,
  getSandboxFileVersion,
  encodeSandboxWriteRequest,
  sandboxAsset,
} = await import('./shell-service.mjs');
const makeCommand = (script) =>
  `${quote(process.execPath)} -e ${quote(script)}`;
const bounded = async (promise, label, ms = 8000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const until = async (predicate, label) => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`);
    await delay(25);
  }
};
const waitForFile = async (
  file,
  label,
  predicate = (value) => value !== '',
) => {
  let content = '';
  await until(() => {
    try {
      const candidate = readFileSync(file, 'utf8');
      if (!predicate(candidate)) return false;
      content = candidate;
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }, label);
  return content;
};
const identity = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
};
const namespaceMembers = (namespace) => {
  const members = new Map();
  for (const name of readdirSync('/proc').filter((name) =>
    /^\d+$/.test(name),
  )) {
    try {
      if (readlinkSync(`/proc/${name}/ns/pid`) === namespace) {
        const start = identity(name);
        if (start) members.set(Number(name), start);
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code))
        throw error;
    }
  }
  return members;
};
const longPayload = (namespaceFile) =>
  makeCommand(`
  const fs = require('node:fs');
  const child = require('node:child_process').spawn('/usr/bin/setsid', ['/bin/sleep', '60'], {stdio:'ignore'});
  child.on('spawn', () => {
    fs.writeFileSync(${JSON.stringify(namespaceFile)}, fs.readlinkSync('/proc/self/ns/pid'));
    console.log('READY');
  });
  setInterval(() => {}, 1000);
`);
if (process.argv[2] === '--parent-driver') {
  const fixture = JSON.parse(process.argv[3]);
  const handle = await executeBwrap(
    {
      ...fixture,
      installation,
      filesystem: 'workspace-write',
      network: 'closed',
    },
    {
      executable: '/bin/bash',
      args: ['-c', longPayload(fixture.namespaceFile)],
      cwd: fixture.workspace,
      env: cleanEnv,
    },
    () => {},
    new AbortController().signal,
  );
  const relayArgs = readFileSync(`/proc/${handle.pid}/cmdline`, 'utf8').split(
    '\0',
  );
  const scratchIndex = relayArgs.findIndex(
    (arg, index) => arg === 'TMPDIR' && relayArgs[index - 1] === '--setenv',
  );
  assert.ok(scratchIndex > 0);
  writeFileSync(fixture.scratchRecord, relayArgs[scratchIndex + 1], {
    flag: 'wx',
  });
  setInterval(() => {}, 1000);
} else {
  await verify();
}

async function verify() {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'qwen-tool-prototype-'));
  const workspace = path.join(fixture, 'workspace');
  const state = path.join(fixture, 'state');
  const outside = path.join(fixture, 'outside.txt');
  for (const directory of [workspace, state]) mkdirSync(directory);
  writeFileSync(outside, 'original');
  const manifest = JSON.parse(
    readFileSync(path.join(installation, 'manifest.json'), 'utf8'),
  );
  const hashArtifacts = () => {
    const hashes = {};
    const errors = [];
    for (const file of Object.keys(manifest.artifacts)) {
      try {
        hashes[file] = createHash('sha256')
          .update(readFileSync(path.join(installation, file)))
          .digest('hex');
      } catch (error) {
        errors.push(`${file}: ${error.message}`);
      }
    }
    return { hashes, errors };
  };
  const artifactsBefore = hashArtifacts();
  for (const [file, hash] of Object.entries(manifest.artifacts)) {
    assert.equal(artifactsBefore.hashes[file], hash, file);
  }
  const results = [];
  const owned = new Map();
  const ownedScratch = new Set();
  let artifactsAfter = { hashes: {}, errors: [] };
  const remember = (pid) => {
    if (pid) {
      const start = identity(pid);
      if (start) owned.set(pid, start);
    }
  };
  const rememberNamespace = (namespace) => {
    assert.match(namespace, /^pid:\[\d+\]$/);
    assert.notEqual(
      namespace,
      readlinkSync('/proc/self/ns/pid'),
      'Refuse to track the host PID namespace.',
    );
    const members = namespaceMembers(namespace);
    for (const [pid, start] of members) owned.set(pid, start);
    return members;
  };
  const check = async (name, run) => {
    try {
      const evidence = await run();
      results.push({ name, passed: true, evidence });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.stack });
      console.error(`FAIL ${name}: ${error.message}`);
    }
  };
  const plan = (command, options = {}) => ({
    policy: {
      workspace,
      installation,
      state,
      filesystem: 'workspace-write',
      network: 'closed',
      ...options,
    },
    payload: {
      executable: '/bin/bash',
      args: ['-c', command],
      cwd: workspace,
      env: cleanEnv,
    },
  });
  const start = async (command, pty = false, options = {}) => {
    const controller = new AbortController();
    const launch = options.launch ?? plan(command, options.policy);
    const handle = await executeBwrap(
      launch.policy,
      launch.payload,
      () => {},
      options.signal ?? controller.signal,
      pty,
      { terminalWidth: 80, terminalHeight: 24 },
      { streamStdout: !!options.postPromote, postPromote: options.postPromote },
    );
    remember(handle.pid);
    return { ...handle, controller };
  };
  const finish = async (handle, pty, exitCode = 0) => {
    const result = await bounded(handle.result, 'command result');
    assert.equal(
      result.executionMethod,
      pty ? 'lydell-node-pty' : 'child_process',
      result.output,
    );
    if (exitCode !== null) {
      assert.equal(result.exitCode, exitCode, result.output);
      assert.equal(result.signal, null, result.output);
      assert.equal(result.error, null, result.output);
      assert.deepEqual(result.sandboxStatus, { state: 'confirmed', exitCode });
    }
    return result;
  };
  const run = async (command, pty = false, options = {}) =>
    finish(await start(command, pty, options), pty);
  const server = createServer((_, response) =>
    response.end('host-model-fixture'),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const fetchCommand = makeCommand(
    `fetch(${JSON.stringify(url)}, {signal:AbortSignal.timeout(700)}).then(async r=>console.log(await r.text()), ()=>process.exit(17))`,
  );
  try {
    await check(
      'cleanup refuses host or invalid PID namespace before tracking',
      async () => {
        const previous = new Map(owned);
        try {
          assert.throws(
            () => rememberNamespace(readlinkSync('/proc/self/ns/pid')),
            /Refuse to track/,
          );
          assert.throws(() => rememberNamespace('invalid-namespace'));
          assert.deepEqual(owned, previous);
        } finally {
          owned.clear();
          for (const [pid, stamp] of previous) owned.set(pid, stamp);
        }
      },
    );
    for (const pty of [false, true]) {
      const transport = pty ? 'PTY' : 'pipes';
      await check(`${transport}: namespaces and filesystem`, async () => {
        const hostNs = readlinkSync('/proc/self/ns/pid');
        const target = path.join(workspace, `write-${transport}`);
        const command = `set -e; readlink /proc/self/ns/pid; readlink /proc/1/ns/pid; printf 'SCRATCH:%s\\n' "$TMPDIR"; test ! -e /proc/${process.pid}/root; printf allowed > ${quote(target)}; if printf changed > ${quote(outside)}; then exit 42; fi`;
        const result = await run(command, pty);
        const namespaces = result.output.match(/pid:\[\d+\]/g);
        const scratch = result.output.match(/SCRATCH:([^\r\n]+)/)?.[1];
        assert.equal(namespaces?.length, 2, result.output);
        assert.ok(scratch, result.output);
        assert.notEqual(namespaces[0], hostNs);
        assert.equal(namespaces[0], namespaces[1]);
        assert.equal(readFileSync(target, 'utf8'), 'allowed');
        assert.equal(readFileSync(outside, 'utf8'), 'original');
        assert.equal(existsSync(scratch), false, scratch);
        return {
          hostNs,
          namespace: namespaces[0],
          scratch,
          executionMethod: result.executionMethod,
        };
      });
      await check(
        `${transport}: host communication with closed tool network`,
        async () => {
          const task = await start(fetchCommand, pty);
          assert.equal(await (await fetch(url)).text(), 'host-model-fixture');
          writeFileSync(
            path.join(state, 'session.json'),
            JSON.stringify({ persisted: true }),
          );
          await finish(task, pty, 17);
          const open = await run(fetchCommand, pty, {
            policy: { network: 'open' },
          });
          assert.match(open.output, /host-model-fixture/);
        },
      );
      for (const mode of ['cancel', 'timeout']) {
        await check(
          `${transport}: ${mode} cleans namespace descendants`,
          async () => {
            const nsFile = path.join(workspace, `${transport}-${mode}-ns`);
            const task = await start(
              longPayload(nsFile),
              pty,
              mode === 'timeout' ? { signal: AbortSignal.timeout(1000) } : {},
            );
            const namespace = await waitForFile(
              nsFile,
              'payload ready',
              (value) => /^pid:\[\d+\]$/.test(value),
            );
            let members;
            await until(() => {
              members = rememberNamespace(namespace);
              return members.size >= 3;
            }, 'payload plus detached descendant');
            assert.ok(!members.has(process.pid));
            if (mode === 'cancel') task.controller.abort({ kind: 'cancel' });
            const result = await finish(task, pty, null);
            assert.equal(result.aborted, true);
            assert.equal(result.sandboxStatus.state, 'interrupted');
            await until(
              () =>
                [...members].every(([pid, stamp]) => identity(pid) !== stamp),
              'descendants terminated',
            );
            return { namespace, hostPids: [...members.keys()] };
          },
        );
      }
      await check(
        `${transport}: background retains restrictions and settles once`,
        async () => {
          const gate = path.join(workspace, `gate-${transport}`);
          const ready = path.join(workspace, `ready-${transport}`);
          let settle;
          let settleCount = 0;
          let later = '';
          const settled = new Promise((resolve) => {
            settle = resolve;
          });
          const command = makeCommand(`
          const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); console.log('READY');
          const timer=setInterval(async()=>{
            if(!fs.existsSync(${JSON.stringify(gate)})) return; clearInterval(timer);
            try {fs.writeFileSync(${JSON.stringify(outside)},'changed'); process.exit(42);} catch {}
            try {await fetch(${JSON.stringify(url)}, {signal:AbortSignal.timeout(700)}); process.exit(43);} catch {}
            fs.writeFileSync(${JSON.stringify(path.join(workspace, `background-${transport}`))},'done');
            console.log('LATE');
          },25);
        `);
          const task = await start(command, pty, {
            postPromote: {
              onData: (event) => {
                if (event.type === 'data') later += event.chunk;
              },
              onSettle: (value) => {
                settleCount++;
                settle(value);
              },
            },
          });
          await until(() => existsSync(ready), 'ready before promotion');
          task.controller.abort({
            kind: 'background',
            shellId: `prototype-${transport}`,
          });
          const promoted = await finish(task, pty, null);
          assert.equal(promoted.promoted, true);
          assert.equal(promoted.sandboxStatus.state, 'running');
          const controlDirs = readdirSync(state).filter((name) =>
            name.startsWith('sandbox-control-'),
          );
          assert.equal(controlDirs.length, 1);
          assert.ok(
            existsSync(path.join(state, controlDirs[0], 'status.json')),
          );
          assert.equal(promoted.aborted, false);
          assert.ok(identity(task.pid));
          writeFileSync(gate, 'continue');
          const final = await bounded(settled, 'background settlement');
          assert.equal(final.exitCode, 0);
          assert.equal(final.signal, null);
          assert.equal(final.error, undefined);
          assert.match(later, /LATE/);
          assert.equal(settleCount, 1);
          assert.deepEqual(await task.settled, {
            state: 'confirmed',
            exitCode: 0,
          });
          assert.ok(!existsSync(path.join(state, controlDirs[0])));
          assert.equal(readFileSync(outside, 'utf8'), 'original');
          assert.equal(
            readFileSync(
              path.join(workspace, `background-${transport}`),
              'utf8',
            ),
            'done',
          );
        },
      );
      await check(
        `${transport}: setup failures and command failure do not replay`,
        async () => {
          const marker = path.join(workspace, `never-${transport}`);
          for (const kind of ['missing', 'exec']) {
            const launch = plan(`printf started > ${quote(marker)}`);
            if (kind === 'missing')
              launch.policy.bwrapPath = '/usr/bin/qwen-missing-bwrap';
            else launch.payload.executable = '/usr/bin/qwen-missing-payload';
            const failed = await finish(
              await start('', pty, { launch }),
              pty,
              null,
            );
            assert.notEqual(failed.exitCode, 0, failed.output);
            assert.equal(failed.sandboxStatus.state, 'unconfirmed');
            assert.equal(existsSync(marker), false);
          }
          const once = path.join(workspace, `once-${transport}`);
          const failed = await start(
            `printf x >> ${quote(once)}; exit 23`,
            pty,
          );
          await finish(failed, pty, 23);
          assert.equal(readFileSync(once, 'utf8'), 'x');
        },
      );
    }
    await check(
      'pipes: promoted settlement waits for inherited stdio to close',
      async () => {
        const gate = path.join(workspace, 'promoted-drain-gate');
        const exiting = path.join(workspace, 'promoted-parent-exiting');
        let settle;
        let settledEarly = false;
        const settled = new Promise((resolve) => {
          settle = resolve;
        }).then((value) => {
          settledEarly = true;
          return value;
        });
        const command = makeCommand(`
          const fs=require('node:fs'), cp=require('node:child_process');
          const timer=setInterval(()=>{
            if(!fs.existsSync(${JSON.stringify(gate)})) return;
            clearInterval(timer);
            cp.spawn('/bin/sleep',['2'],{stdio:'inherit',detached:true}).unref();
            fs.writeFileSync(${JSON.stringify(exiting)},'exiting');
          },25);
        `);
        const task = await start(command, false, {
          postPromote: { onSettle: (value) => settle(value) },
        });
        task.controller.abort({
          kind: 'background',
          shellId: 'prototype-drain',
        });
        const promoted = await finish(task, false, null);
        assert.equal(promoted.promoted, true);
        writeFileSync(gate, 'continue');
        await waitForFile(exiting, 'promoted parent exit');
        await delay(100);
        assert.equal(settledEarly, false);
        const final = await bounded(settled, 'inherited stdio settlement');
        assert.equal(final.exitCode, 0);
        assert.deepEqual(await task.settled, {
          state: 'confirmed',
          exitCode: 0,
        });
      },
    );
    for (const pty of [false, true]) {
      await check(
        `${pty ? 'PTY' : 'pipes'}: trusted receipt resists stdout, file and FD spoofing`,
        async () => {
          const command = makeCommand(`
          const fs=require('node:fs'), path=require('node:path');
          const dir=fs.readdirSync(${JSON.stringify(state)}).find(n=>n.startsWith('sandbox-control-'));
          try { fs.writeFileSync(path.join(${JSON.stringify(state)},dir,'status.json'),'FORGED'); process.exit(91); } catch(e) { if(e.code!=='EROFS') throw e; }
          try { fs.writeSync(3,'{ "exit-code": 0 }\\n'); process.exit(92); } catch {}
          console.log('{ "exit-code": 0 }'); process.exit(42);
        `);
          const result = await finish(await start(command, pty), pty, 42);
          assert.deepEqual(result.sandboxStatus, {
            state: 'confirmed',
            exitCode: 42,
          });
        },
      );
      await check(
        `${pty ? 'PTY' : 'pipes'}: literal argv and protected bootstrap environment`,
        async () => {
          const preload = path.join(workspace, 'preload.cjs');
          const marker = path.join(workspace, 'preload-ran');
          writeFileSync(
            preload,
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`,
          );
          const old = process.env.NODE_OPTIONS;
          process.env.NODE_OPTIONS = `--require=${preload}`;
          try {
            const launch = plan('');
            const literals = ['two words', "quote'", '$(touch bad); *', ''];
            launch.payload = {
              executable: process.execPath,
              args: [
                '-e',
                'console.log(JSON.stringify(process.argv.slice(1)))',
                ...literals,
              ],
              cwd: workspace,
              env: cleanEnv,
            };
            const result = await finish(await start('', pty, { launch }), pty);
            assert.deepEqual(JSON.parse(result.output.trim()), literals);
            assert.ok(!existsSync(marker));
          } finally {
            if (old === undefined) delete process.env.NODE_OPTIONS;
            else process.env.NODE_OPTIONS = old;
          }
        },
      );
    }
    await check(
      'file worker client uses confined stdin and validates result',
      async () => {
        const policy = plan('').policy;
        const request = {
          operation: 'write',
          destination: path.join(workspace, 'client.txt'),
          content: Buffer.from('hello\n世界'),
          expected: null,
        };
        await writeSandboxFile(policy, request, new AbortController().signal);
        assert.deepEqual(readFileSync(request.destination), request.content);
        await assert.rejects(
          () =>
            writeSandboxFile(
              { ...policy, filesystem: 'read-only' },
              {
                ...request,
                content: Buffer.from('no'),
                expected: getSandboxFileVersion(request.destination),
              },
              new AbortController().signal,
            ),
          /read-only sandbox policy/,
        );
        const largeContent = Buffer.alloc(2 * 1024 * 1024, 0xff);
        await writeSandboxFile(
          policy,
          {
            ...request,
            content: largeContent,
            expected: getSandboxFileVersion(request.destination),
          },
          new AbortController().signal,
        );
        assert.deepEqual(readFileSync(request.destination), largeContent);
      },
    );
    await check(
      'structured launch passes exact env and binary stdin until EOF',
      async () => {
        const input = Buffer.from([0, 255, 1, 10, 13]);
        const handle = await service.executeLaunch(
          {
            executable: process.execPath,
            args: [
              '-e',
              'const chunks=[]; process.stdin.on("data",c=>chunks.push(c)); process.stdin.on("end",()=>console.log(JSON.stringify({env:process.env,hex:Buffer.concat(chunks).toString("hex")})))',
            ],
            cwd: workspace,
            env: { ONLY: 'literal' },
            stdin: input,
          },
          () => {},
          new AbortController().signal,
          false,
          {},
        );
        const result = await handle.result;
        assert.equal(result.exitCode, 0, result.output);
        assert.deepEqual(JSON.parse(result.output.trim()), {
          env: { ONLY: 'literal' },
          hex: input.toString('hex'),
        });
      },
    );
    await check(
      'mount setup failure has no exec receipt or payload effects',
      async () => {
        const control = mkdtempSync(path.join(state, 'raw-status-'));
        const statusPath = path.join(control, 'receipt.json');
        const marker = path.join(workspace, 'invalid-mount-payload');
        const handle = await service.executeLaunch(
          {
            executable: process.execPath,
            args: [
              sandboxAsset('bwrap-relay'),
              String(process.pid),
              statusPath,
              '/usr/bin/bwrap',
              '--ro-bind',
              '/',
              '/',
              '--unshare-pid',
              '--proc',
              '/proc',
              '--die-with-parent',
              '--bind',
              workspace,
              workspace,
              '--ro-bind',
              path.join(fixture, 'missing-mount'),
              '/missing',
              '--',
              '/bin/sh',
              '-c',
              `printf x > ${quote(marker)}`,
            ],
            cwd: workspace,
            env: { ...cleanEnv, TERM: 'xterm-256color', PWD: workspace },
          },
          () => {},
          new AbortController().signal,
          true,
          {},
        );
        const result = await handle.result;
        assert.equal(result.executionMethod, 'lydell-node-pty');
        assert.notEqual(result.exitCode, 0);
        assert.deepEqual(JSON.parse(readFileSync(statusPath, 'utf8')), {
          state: 'unconfirmed',
          // bwrap forked (child-pid on the wire) but the mount setup failed
          // before exec, so there is no exit-code record — a positive
          // no-exec attestation (PR #12067 review, round 2).
          payloadExitObserved: false,
        });
        assert.ok(!existsSync(marker));
        rmSync(control, { recursive: true });
      },
    );
    await check(
      'supervisor killed after exec never means payload did not run',
      async () => {
        const nsFile = path.join(workspace, 'killed-supervisor-ns');
        const task = await start(longPayload(nsFile));
        const namespace = await waitForFile(
          nsFile,
          'executed payload',
          (value) => /^pid:\[\d+\]$/.test(value),
        );
        let members;
        await until(() => {
          members = rememberNamespace(namespace);
          return members.size >= 3;
        }, 'supervisor descendants ready');
        const children = readFileSync(
          `/proc/${task.pid}/task/${task.pid}/children`,
          'utf8',
        )
          .trim()
          .split(/\s+/);
        assert.equal(children.length, 1);
        const supervisor = Number(children[0]);
        assert.ok(Number.isSafeInteger(supervisor) && supervisor > 1);
        remember(supervisor);
        process.kill(supervisor, 'SIGKILL');
        const result = await finish(task, false, null);
        assert.equal(result.sandboxStatus.state, 'interrupted');
        await until(
          () => [...members].every(([pid, stamp]) => identity(pid) !== stamp),
          'supervisor death cleanup',
        );
        return { namespace, hostPids: [...members.keys()], supervisor };
      },
    );
    await check('PTY: input and resize', async () => {
      const ready = path.join(workspace, 'pty-ready');
      const task = await start(
        `stty size; touch ${quote(ready)}; read -r value; printf 'INPUT:%s\n' "$value"; stty size`,
        true,
      );
      await until(() => existsSync(ready), 'PTY ready');
      service.resizePty(task.pid, 101, 37);
      service.writeToPty(task.pid, 'hello-prototype\n');
      const result = await finish(task, true);
      assert.match(result.output, /24 80/);
      assert.match(result.output, /INPUT:hello-prototype/);
      assert.match(result.output, /37 101/);
    });
    await check(
      'PTY: terminal Ctrl+C reports SIGINT and cleans descendants',
      async () => {
        const nsFile = path.join(workspace, 'ctrl-c-ns');
        const task = await start(longPayload(nsFile), true);
        const namespace = await waitForFile(nsFile, 'Ctrl+C ready', (value) =>
          /^pid:\[\d+\]$/.test(value),
        );
        let members;
        await until(() => {
          members = rememberNamespace(namespace);
          return members.size >= 3;
        }, 'Ctrl+C descendants ready');
        service.writeToPty(task.pid, '\x03');
        const result = await finish(task, true, null);
        assert.equal(result.signal, 2);
        await until(
          () => [...members].every(([pid, stamp]) => identity(pid) !== stamp),
          'Ctrl+C cleanup',
        );
        return {
          exitCode: result.exitCode,
          signal: result.signal,
          namespace,
          hostPids: [...members.keys()],
        };
      },
    );
    await check('read-only workspace and protected roots', async () => {
      const target = path.join(workspace, 'readonly-denied');
      const task = await start(`printf changed > ${quote(target)}`, false, {
        policy: { filesystem: 'read-only' },
      });
      assert.notEqual((await finish(task, false, null)).exitCode, 0);
      assert.equal(existsSync(target), false);
      for (const root of [os.homedir(), '/', state, installation, '/proc']) {
        await assert.rejects(
          () => start('true', false, { policy: { workspace: root } }),
          /forbidden|protected/,
        );
      }
      const special = path.join(state, '..private');
      mkdirSync(special);
      await assert.rejects(
        () => start('true', false, { policy: { workspace: special } }),
        /protected/,
      );
    });
    await check(
      'missing PTY dependency falls back to confined pipes',
      async () => {
        const bareInstall = path.join(state, 'without-pty');
        mkdirSync(bareInstall);
        copyFileSync(
          path.join(installation, 'shell-service.mjs'),
          path.join(bareInstall, 'shell-service.mjs'),
        );
        for (const name of [
          'sandboxBwrapRelay.js',
          'sandboxFileWorker.js',
          'package.json',
        ])
          copyFileSync(
            path.join(installation, name),
            path.join(bareInstall, name),
          );
        const launch = plan(
          `readlink /proc/self/ns/pid; if printf changed > ${quote(outside)}; then exit 42; fi`,
        );
        const script = `
        import { executeBwrap } from './shell-service.mjs';
        const handle=await executeBwrap(${JSON.stringify(launch.policy)},${JSON.stringify(launch.payload)},()=>{},new AbortController().signal,true,{});
        const result=await handle.result;
        console.log(JSON.stringify({method:result.executionMethod,code:result.exitCode,output:result.output}));
      `;
        writeFileSync(path.join(bareInstall, 'driver.mjs'), script);
        const result = JSON.parse(
          execFileSync(
            process.execPath,
            [path.join(bareInstall, 'driver.mjs')],
            { env: cleanEnv, encoding: 'utf8', timeout: 8000 },
          ),
        );
        assert.equal(result.method, 'child_process');
        assert.equal(result.code, 0, result.output);
        const namespace = result.output.match(/pid:\[\d+\]/)?.[0];
        assert.ok(namespace, result.output);
        assert.notEqual(namespace, readlinkSync('/proc/self/ns/pid'));
        assert.equal(readFileSync(outside, 'utf8'), 'original');
      },
    );
    const worker = async (request) => {
      const launch = plan('');
      launch.payload = {
        executable: process.execPath,
        args: [sandboxAsset('file-worker')],
        cwd: workspace,
        env: cleanEnv,
        stdin:
          typeof request === 'string'
            ? request
            : encodeSandboxWriteRequest(request),
      };
      const handle = await start('', false, { launch });
      const result = await bounded(handle.result, 'file worker');
      assert.equal(result.sandboxStatus.state, 'confirmed');
      return {
        code: result.exitCode,
        output: result.output,
      };
    };
    await check(
      'file worker: mkdir, atomic replacement, stale-version denial',
      async () => {
        const destination = path.join(workspace, 'nested', 'note.txt');
        const request = {
          operation: 'write',
          destination,
          content: Buffer.from('first'),
          expected: null,
        };
        assert.equal((await worker(request)).code, 0);
        assert.equal(readFileSync(destination, 'utf8'), 'first');
        const firstVersion = getSandboxFileVersion(destination);
        assert.equal(
          (
            await worker({
              ...request,
              content: Buffer.from('second'),
              expected: firstVersion,
            })
          ).code,
          0,
        );
        const conflict = await worker({
          ...request,
          content: Buffer.from('wrong'),
          expected: firstVersion,
        });
        assert.equal(conflict.code, 1);
        assert.match(conflict.output, /File changed since/);
        assert.equal(readFileSync(destination, 'utf8'), 'second');
        assert.deepEqual(readdirSync(path.dirname(destination)), ['note.txt']);
      },
    );
    await check(
      'file worker: empty content preserves mode and leaf symlink',
      async () => {
        const destination = path.join(workspace, 'worker-mode.txt');
        const link = path.join(workspace, 'worker-link');
        writeFileSync(destination, 'original');
        chmodSync(destination, 0o751);
        symlinkSync('worker-mode.txt', link);
        const result = await worker({
          operation: 'write',
          destination: link,
          content: Buffer.alloc(0),
          expected: getSandboxFileVersion(link),
        });
        assert.equal(result.code, 0, result.output);
        assert.equal(readFileSync(destination).length, 0);
        assert.equal(statSync(destination).mode & 0o7777, 0o751);
        assert.equal(readlinkSync(link), 'worker-mode.txt');
      },
    );
    await check(
      'file worker: replaced, removed and appeared versions fail without side effects',
      async () => {
        for (const change of ['replaced', 'removed', 'appeared']) {
          const directory = path.join(workspace, 'version-' + change);
          mkdirSync(directory);
          const destination = path.join(directory, 'file');
          if (change !== 'appeared') writeFileSync(destination, 'original');
          const expected = getSandboxFileVersion(destination);
          if (change === 'replaced') {
            const replacement = path.join(directory, 'replacement');
            writeFileSync(replacement, 'external');
            renameSync(replacement, destination);
          } else if (change === 'removed') rmSync(destination);
          else writeFileSync(destination, 'external');
          const result = await worker({
            operation: 'write',
            destination,
            content: Buffer.from('bad'),
            expected,
          });
          assert.equal(result.code, 1, result.output);
          assert.equal(JSON.parse(result.output).code, 'ESTALE');
          assert.deepEqual(
            readdirSync(directory),
            change === 'removed' ? [] : ['file'],
          );
          if (change !== 'removed')
            assert.equal(readFileSync(destination, 'utf8'), 'external');
        }
      },
    );
    await check(
      'file worker: special files rejected without opening them',
      async () => {
        const destination = path.join(workspace, 'worker-fifo');
        execFileSync('/usr/bin/mkfifo', [destination]);
        const result = await worker({
          operation: 'write',
          destination,
          content: Buffer.from('bad'),
          expected: null,
        });
        assert.equal(result.code, 1, result.output);
        assert.equal(JSON.parse(result.output).code, 'EINVAL');
        assert.ok(statSync(destination).isFIFO());
        assert.ok(
          !readdirSync(workspace).some(
            (name) => name.startsWith('worker-fifo.') && name.endsWith('.tmp'),
          ),
        );
      },
    );
    await check('file worker: outside and symlink escape denied', async () => {
      const request = {
        operation: 'write',
        destination: outside,
        content: Buffer.from('changed'),
        expected: getSandboxFileVersion(outside),
      };
      assert.equal((await worker(request)).code, 1);
      symlinkSync(fixture, path.join(workspace, 'escape'));
      assert.equal(
        (
          await worker({
            ...request,
            destination: path.join(workspace, 'escape', 'outside.txt'),
          })
        ).code,
        1,
      );
      assert.equal(readFileSync(outside, 'utf8'), 'original');
      assert.ok(
        !readdirSync(fixture).some(
          (name) => name.startsWith('outside.txt.') && name.endsWith('.tmp'),
        ),
      );
    });
    await check('file worker: bounded metadata header', async () => {
      const result = await worker('x'.repeat(16 * 1024 + 1));
      assert.equal(result.code, 1);
      assert.match(result.output, /exceeds 16 KiB/);
    });
    await check('parent death terminates the private namespace', async () => {
      const namespaceFile = path.join(workspace, 'parent-death-ns');
      const scratchRecord = path.join(state, 'parent-scratch');
      const driver = spawn(
        process.execPath,
        [
          self,
          '--parent-driver',
          JSON.stringify({ workspace, state, namespaceFile, scratchRecord }),
        ],
        { env: cleanEnv, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      remember(driver.pid);
      let driverStderr = '';
      driver.stderr.on('data', (chunk) => {
        driverStderr = (driverStderr + chunk.toString('utf8')).slice(-16384);
      });
      const exit = new Promise((resolve) =>
        driver.on('exit', (code, signal) => resolve({ code, signal })),
      );
      const ready = Promise.all([
        waitForFile(scratchRecord, 'driver scratch ready', path.isAbsolute),
        waitForFile(namespaceFile, 'driver namespace ready', (value) =>
          /^pid:\[\d+\]$/.test(value),
        ),
      ]);
      const [scratch, namespace] = await Promise.race([
        ready,
        exit.then(({ code, signal }) => {
          throw new Error(
            `Parent driver exited before readiness (code=${code}, signal=${signal}): ${driverStderr || 'no stderr'}`,
          );
        }),
      ]);
      assert.equal(path.dirname(scratch), realpathSync(os.tmpdir()));
      assert.match(path.basename(scratch), /^qwen-sandbox-[A-Za-z0-9]+$/);
      assert.equal(realpathSync(scratch), scratch);
      ownedScratch.add(scratch);
      let members;
      await until(() => {
        members = rememberNamespace(namespace);
        return members.size >= 3;
      }, 'driver descendants ready');
      driver.kill('SIGKILL');
      await bounded(exit, 'driver exit');
      await until(
        () => [...members].every(([pid, stamp]) => identity(pid) !== stamp),
        'parent-death cleanup',
      );
      return { namespace, hostPids: [...members.keys()] };
    });
    await check(
      'negative controls detect missing filesystem/network confinement',
      async () => {
        writeFileSync(outside, 'unconfined');
        assert.throws(() =>
          assert.equal(readFileSync(outside, 'utf8'), 'original'),
        );
        const reachable = await (await fetch(url)).text();
        assert.throws(() => assert.notEqual(reachable, 'host-model-fixture'));
        writeFileSync(outside, 'original');
        return {
          outsideDenyPredicateFailed: true,
          networkDenyPredicateFailed: true,
        };
      },
    );
  } finally {
    service.cleanup();
    const cleanupErrors = [];
    for (const [pid, stamp] of owned) {
      if (identity(pid) === stamp) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') cleanupErrors.push(error.message);
        }
      }
    }
    await until(
      () => [...owned].every(([pid, stamp]) => identity(pid) !== stamp),
      'final cleanup',
    ).catch((error) => cleanupErrors.push(error.message));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (
      cleanupErrors.length === 0 &&
      results.every((result) => result.passed)
    ) {
      for (const scratch of ownedScratch)
        rmSync(scratch, { recursive: true, force: true });
      rmSync(fixture, { recursive: true });
    }
    results.push({
      name: 'fixture cleanup',
      passed: cleanupErrors.length === 0,
      errors: cleanupErrors,
    });
    artifactsAfter = hashArtifacts();
    const artifactErrors = [...artifactsAfter.errors];
    for (const [file, expected] of Object.entries(manifest.artifacts)) {
      if (artifactsAfter.hashes[file] !== expected)
        artifactErrors.push(`${file}: hash changed during verification`);
    }
    results.push({
      name: 'artifact integrity after verification',
      passed: artifactErrors.length === 0,
      errors: artifactErrors,
    });
  }
  let bwrapVersion;
  try {
    bwrapVersion = execFileSync('/usr/bin/bwrap', ['--version'], {
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    bwrapVersion = `unavailable: ${error.code ?? error.message}`;
  }
  const report = {
    revision: manifest.revision,
    dirty: manifest.dirty,
    inputs: manifest.inputs,
    artifacts: {
      expected: manifest.artifacts,
      before: artifactsBefore.hashes,
      after: artifactsAfter.hashes,
    },
    environment: {
      kernel: os.release(),
      arch: os.arch(),
      node: process.version,
      bwrap: bwrapVersion,
    },
    fixture,
    results,
    limitations: [
      'Developer harness, not a CLI/model turn',
      'No production configuration or tool wiring',
      'Final exec receipt only; no realtime ready event',
      'No Landlock implementation',
      'No full encoding/binary compatibility',
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.QWEN_SANDBOX_TEST_REPORT)
    writeFileSync(
      process.env.QWEN_SANDBOX_TEST_REPORT,
      JSON.stringify(report, null, 2),
    );
  assert.equal(results.length, 36, 'Unexpected adapter case count');
  process.exitCode = results.every((result) => result.passed) ? 0 : 1;
}
