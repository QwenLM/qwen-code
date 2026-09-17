/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const output = process.argv[2];
const bun = process.env.QWEN_SANDBOX_TEST_BUN;
assert.equal(process.platform, 'linux', 'Real Linux is required; no skip');
assert.ok(
  output && path.isAbsolute(output),
  'Supply a new absolute evidence directory',
);
assert.ok(
  bun && path.isAbsolute(bun),
  'Set QWEN_SANDBOX_TEST_BUN to an absolute Bun executable',
);
await fs.mkdir(output);
const logs = path.join(output, 'logs');
const reports = path.join(output, 'reports');
const installations = path.join(output, 'installations');
const fixtures = path.join(output, 'fixtures');
const home = path.join(output, 'home');
await Promise.all(
  [logs, reports, installations, fixtures, home].map((dir) => fs.mkdir(dir)),
);
const env = {
  PATH: `${path.dirname(process.execPath)}:${path.dirname(bun)}:/usr/bin:/bin`,
  HOME: home,
  TMPDIR: fixtures,
  LANG: 'C.UTF-8',
  CI: 'true',
  QWEN_SANDBOX_TEST_BUN: bun,
};
const record = async (name, value) =>
  fs.writeFile(path.join(reports, name), JSON.stringify(value, null, 2) + '\n');
const sha = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const active = new Set();
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    for (const child of active) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* Already exited. */
      }
    }
    process.exit(code);
  });
}
async function run(name, command, args, extraEnv = {}) {
  const log = createWriteStream(path.join(logs, `${name}.log`));
  const child = spawn(command, args, {
    cwd: root,
    env: { ...env, ...extraEnv },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  active.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => {
      log.write(data);
      process.stdout.write(data);
    });
  }
  let timedOut = false;
  let escalation;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
    escalation = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }, 5000);
  }, 10 * 60_000);
  let result;
  try {
    result = await new Promise((resolve) => {
      child.once('error', (error) =>
        resolve({ code: null, error: error.message }),
      );
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    active.delete(child);
    await new Promise((resolve) => log.end(resolve));
  }
  return { ...result, timedOut };
}
async function hashes(dir, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const key = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(file, key));
    else if (entry.isFile()) result[key] = await sha(file);
  }
  return result;
}
const summary = { environment: {}, suites: [], passed: false };
try {
  const readSysctl = async (name) =>
    fs.readFile(`/proc/sys/${name}`, 'utf8').then(
      (value) => value.trim(),
      () => null,
    );
  summary.environment = {
    kernel: os.release(),
    arch: os.arch(),
    node: process.version,
    nodePath: process.execPath,
    bun: execFileSync(bun, ['--version'], { env, encoding: 'utf8' }).trim(),
    bwrap: execFileSync('/usr/bin/bwrap', ['--version'], {
      env,
      encoding: 'utf8',
    }).trim(),
    usernsClone: await readSysctl('kernel/unprivileged_userns_clone'),
    maxUserNamespaces: await readSysctl('user/max_user_namespaces'),
    apparmorUsernsRestriction: await readSysctl(
      'kernel/apparmor_restrict_unprivileged_userns',
    ),
  };
  await record('environment.json', summary.environment);
  const hostNamespaces = await Promise.all(
    ['pid', 'net'].map((name) => fs.readlink(`/proc/self/ns/${name}`)),
  );
  const namespaces = execFileSync(
    '/usr/bin/bwrap',
    [
      '--die-with-parent',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-net',
      '--ro-bind',
      '/',
      '/',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--',
      '/bin/sh',
      '-c',
      'readlink /proc/self/ns/pid; readlink /proc/self/ns/net',
    ],
    { env, encoding: 'utf8', timeout: 10_000 },
  )
    .trim()
    .split('\n');
  assert.equal(
    namespaces.length,
    2,
    'Namespace preflight did not report both identities',
  );
  for (const [index, namespace] of namespaces.entries()) {
    assert.match(namespace, /^(pid|net):\[\d+\]$/);
    assert.notEqual(
      namespace,
      hostNamespaces[index],
      'Namespace preflight must enter a distinct namespace',
    );
  }
  await record('preflight.json', { hostNamespaces, namespaces });
  const publicInstall = path.join(installations, 'public');
  await fs.cp(path.join(root, 'dist'), publicInstall, { recursive: true });
  await fs.copyFile(
    path.join(root, 'package.json'),
    path.join(publicInstall, 'package.json'),
  );
  await fs.copyFile(
    path.join(root, 'scripts/sandbox-public/verify.mjs'),
    path.join(publicInstall, 'verify.mjs'),
  );
  const builds = [
    ['runtime', 'scripts/sandbox-runtime/build.mjs'],
    ['adapter', 'scripts/sandbox-prototype/build.mjs'],
  ];
  for (const [name, script] of builds) {
    const result = await run(`build-${name}`, process.execPath, [
      script,
      path.join(installations, name),
    ]);
    assert.equal(result.code, 0, `${name} harness build failed; see logs`);
  }
  const before = {};
  for (const name of ['public', 'runtime', 'adapter']) {
    const install = path.join(installations, name);
    await fs.symlink(
      path.join(root, 'node_modules'),
      path.join(install, 'node_modules'),
      'dir',
    );
    before[name] = await hashes(install);
  }
  const dependencyHashes = async () => ({
    bun: await sha(bun),
    ptyLoader: await hashes(path.join(root, 'node_modules/@lydell/node-pty')),
    ptyNative: await hashes(
      path.join(root, `node_modules/@lydell/node-pty-linux-${process.arch}`),
    ),
  });
  before.dependencies = await dependencyHashes();
  await record('artifacts-before.json', before);
  await record('inputs.json', {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    lockfile: await sha(path.join(root, 'package-lock.json')),
    runner: await sha(fileURLToPath(import.meta.url)),
  });
  for (const [name, expected] of [
    ['public', 62],
    ['runtime', 31],
    ['adapter', 34],
  ]) {
    const install = path.join(installations, name);
    const report = path.join(reports, `${name}.json`);
    const args = [
      path.join(install, 'verify.mjs'),
      ...(name === 'adapter' ? [] : [install, report]),
    ];
    const execution = await run(name, process.execPath, args, {
      QWEN_SANDBOX_TEST_REPORT: report,
    });
    let detail;
    try {
      const data = JSON.parse(await fs.readFile(report, 'utf8'));
      assert.equal(
        data.results.length,
        expected,
        `${name} expected ${expected} cases`,
      );
      assert.ok(
        data.results.every((result) => result.passed === true),
        `${name} has failed cases`,
      );
      assert.equal(execution.code, 0, `${name} process failed`);
      assert.equal(execution.timedOut, false, `${name} timed out`);
      detail = { name, expected, passed: true, execution };
    } catch (error) {
      detail = { name, expected, passed: false, execution, error: error.stack };
    }
    summary.suites.push(detail);
    await record('summary.json', summary);
  }
  const after = {};
  for (const name of ['public', 'runtime', 'adapter'])
    after[name] = await hashes(path.join(installations, name));
  after.dependencies = await dependencyHashes();
  await record('artifacts-after.json', after);
  assert.deepEqual(after, before, 'Tested artifacts changed during acceptance');
  summary.passed = summary.suites.every((suite) => suite.passed);
} catch (error) {
  summary.error = error.stack;
} finally {
  await record('summary.json', summary);
}
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.passed ? 0 : 1;
