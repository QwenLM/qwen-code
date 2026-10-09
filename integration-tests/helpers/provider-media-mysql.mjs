/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import console from 'node:console';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stopFixtureProcess } from './provider-media-process-cleanup.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const maven = process.env['MAVEN_EXECUTABLE'] ?? 'mvn';
const settings = process.env['MAVEN_SETTINGS'];
const prepareOnly = process.argv[2] === '--prepare-only';
if (!prepareOnly) {
  assert.equal(
    process.argv[2],
    '--bundle-ready',
    'Requires the parent bundle-ready confirmation and SHA-256',
  );
  const hash = createHash('sha256')
    .update(await readFile(path.join(root, 'dist/cli.js')))
    .digest('hex');
  assert.equal(process.argv[3], hash, 'The confirmed packaged CLI has changed');
  console.log(`M4_BUNDLE_SHA256 ${hash}`);
}
const temporary = await mkdtemp(
  path.join(tmpdir(), 'qwen-e2e-home-provider-media-mysql-'),
);
const datadir = path.join(temporary, 'data');
const socket = path.join(temporary, 'mysql.sock');
let mysql;
let mysqlFailure;
let verification;
try {
  await chmod(temporary, 0o700);
  await mkdir(datadir);
  const listener = createServer();
  let port;
  try {
    await new Promise((resolve, reject) =>
      listener.once('error', reject).listen(0, '127.0.0.1', resolve),
    );
    port = listener.address().port;
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
  execFileSync(
    'mysqld',
    [
      '--no-defaults',
      '--initialize-insecure',
      `--datadir=${datadir}`,
      `--log-error=${temporary}/mysql.log`,
    ],
    { stdio: 'pipe', timeout: 30_000, killSignal: 'SIGKILL' },
  );
  mysql = spawn(
    'mysqld',
    [
      '--no-defaults',
      `--datadir=${datadir}`,
      `--socket=${socket}`,
      '--bind-address=127.0.0.1',
      `--port=${port}`,
      '--mysqlx=OFF',
      `--pid-file=${temporary}/mysql.pid`,
      `--log-error=${temporary}/mysql.log`,
    ],
    { stdio: 'ignore' },
  );
  mysql.on('error', (cause) => {
    mysqlFailure = cause;
  });
  const startupDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      execFileSync(
        'mysqladmin',
        ['--no-defaults', `--socket=${socket}`, '-u', 'root', 'ping'],
        { stdio: 'pipe', timeout: 1000, killSignal: 'SIGKILL' },
      );
      break;
    } catch {
      assert(
        Date.now() < startupDeadline &&
          mysql.exitCode === null &&
          mysql.signalCode === null &&
          mysqlFailure === undefined,
        'Isolated MySQL failed to start',
      );
      await delay(100);
    }
  }
  execFileSync(
    'mysql',
    [
      '--no-defaults',
      `--socket=${socket}`,
      '-u',
      'root',
      '-e',
      'CREATE DATABASE provider_media_m4',
    ],
    { stdio: 'pipe', timeout: 30_000, killSignal: 'SIGKILL' },
  );
  console.log(
    'M4_ISOLATED_MYSQL ' +
      execFileSync(
        'mysql',
        [
          '--no-defaults',
          `--socket=${socket}`,
          '-u',
          'root',
          '-N',
          '-e',
          'SELECT VERSION()',
        ],
        { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' },
      ).trim(),
  );
  if (!prepareOnly) {
    verification = spawn(
      maven,
      [
        '-q',
        ...(settings ? ['-s', settings] : []),
        '-f',
        'packages/sdk-java/managed-agent-server/pom.xml',
        '-Phosted-workspace-tools',
        '-Dit.test=HostedWorkspaceToolTurnIT#providerMediaReachesModelAndSurvivesReplyLossAndBrokerRestartOnMySql',
        '-Dqwen.provider.media.bundle-ready=true',
        `-Dnode.executable=${process.execPath}`,
        `-Dqwen.cli.entry=${root}/dist/cli.js`,
        `-Dmysql.url=jdbc:mysql://127.0.0.1:${port}/provider_media_m4?allowPublicKeyRetrieval=true&useSSL=false`,
        '-Dmysql.user=root',
        'test-compile',
        'failsafe:integration-test',
        'failsafe:verify',
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          QWEN_HOME: temporary,
          QWEN_RUNTIME_DIR: `${temporary}/qwen-runtime`,
        },
      },
    );
    let code;
    try {
      [code] = await once(verification, 'exit');
    } catch {
      throw new Error('Maven failed to start. Check MAVEN_EXECUTABLE.');
    }
    assert.equal(code, 0, 'M4 real MySQL provider gate failed');
    const finalHash = createHash('sha256')
      .update(await readFile(path.join(root, 'dist/cli.js')))
      .digest('hex');
    assert.equal(
      finalHash,
      process.argv[3],
      'Packaged CLI changed during M4 acceptance',
    );
  }
} finally {
  await stopFixtureProcess(verification);
  await stopFixtureProcess(mysql, () => {
    try {
      execFileSync(
        'mysqladmin',
        ['--no-defaults', `--socket=${socket}`, '-u', 'root', 'shutdown'],
        { stdio: 'pipe', timeout: 1000, killSignal: 'SIGKILL' },
      );
    } catch {
      mysql.kill('SIGKILL');
    }
  });
  await rm(temporary, { recursive: true, force: true });
  console.log('M4_ISOLATED_MYSQL_CLEANED');
}
