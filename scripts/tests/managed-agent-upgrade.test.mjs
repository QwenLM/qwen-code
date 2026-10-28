/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  compareVersions,
  configurationFiles,
  environmentFileEntry,
  execStartPath,
  javaFeatureVersion,
  meetsMinimum,
  migrationScripts,
  parseEnvironmentAssignments,
  parseEnvironmentFile,
  parseMysqlJdbcUrl,
  parseShow,
  runUpgrade,
  serverBaseUrl,
  verifyChecksums,
} from '../../packages/managed-agent-server/distribution/bin/qwen-managed-agent-upgrade.mjs';

const SERVER = 'qwen-managed-agent-server';
const HARNESS = 'qwen-hosted-harness';

test('reads environment files the way systemd does', () => {
  const values = parseEnvironmentFile(
    [
      '# comment',
      '; also a comment',
      'PLAIN=value  ',
      "SINGLE='a b'",
      'DOUBLE="say \\"hi\\""',
      'CONTINUED=one\\',
      'two',
      '  INDENTED = spaced',
      'not a line',
      'BAD-KEY=x',
      '',
    ].join('\n'),
  );
  assert.deepEqual(Object.fromEntries(values), {
    PLAIN: 'value',
    SINGLE: 'a b',
    DOUBLE: 'say "hi"',
    CONTINUED: 'onetwo',
    INDENTED: 'spaced',
  });
});

test('reads the unit properties systemctl show prints', () => {
  const properties = parseShow(
    'EnvironmentFiles=/a.env (ignore_errors=no)\nEnvironmentFiles=/b.env (ignore_errors=yes)\nUser=svc\n',
  );
  assert.deepEqual(
    properties.get('EnvironmentFiles').map(environmentFileEntry),
    [
      { path: '/a.env', optional: false },
      { path: '/b.env', optional: true },
    ],
  );
  assert.equal(
    execStartPath(
      '{ path=/opt/q/bin/qwen-managed-agent-server ; argv[]=/opt/q/bin/qwen-managed-agent-server --x ; ignore_errors=no }',
    ),
    '/opt/q/bin/qwen-managed-agent-server',
  );
  assert.deepEqual(
    Object.fromEntries(
      parseEnvironmentAssignments('"A=1 2" B=x C=\\x41\\x20z D=a\\"b'),
    ),
    { A: '1 2', B: 'x', C: 'A z', D: 'a"b' },
  );
  assert.equal(parseEnvironmentAssignments('').size, 0);
});

test('orders release versions', () => {
  for (const [lower, higher] of [
    ['0.1.0-alpha.96', '0.1.0-alpha.97'],
    ['0.1.0-alpha.9', '0.1.0-alpha.10'],
    ['0.1.0-alpha.1', '0.1.0-beta'],
    ['0.1.0-alpha', '0.1.0-alpha.1'],
    ['0.1.0-1', '0.1.0-alpha'],
    ['0.9.9', '0.10.0'],
    ['1.0.0-rc.1', '1.0.0'],
  ]) {
    assert.equal(compareVersions(lower, higher), -1, `${lower} < ${higher}`);
    assert.equal(compareVersions(higher, lower), 1, `${higher} > ${lower}`);
  }
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
  assert.throws(() => compareVersions('1.0', '1.0.0'), /not a semantic/);
});

test('reads the tool versions a release requires', () => {
  assert.equal(javaFeatureVersion('openjdk version "21.0.2" 2024-01-16'), '21');
  assert.equal(javaFeatureVersion('java version "1.8.0_391"'), '8');
  assert.equal(javaFeatureVersion('openjdk version "25" 2025-09-16'), '25');
  assert.equal(javaFeatureVersion('nothing'), undefined);
  assert.equal(meetsMinimum('>=21', '21'), true);
  assert.equal(meetsMinimum('>=21', '17'), false);
  assert.equal(meetsMinimum('>=22.0.0', 'v22.22.2'), true);
  assert.equal(meetsMinimum('>=22.12.0', 'v22.9.0'), false);
  assert.equal(meetsMinimum('^22', 'v22.1.0'), undefined);
});

test('reads the datasource, configuration and listener settings', () => {
  assert.deepEqual(
    parseMysqlJdbcUrl(
      'jdbc:mysql://127.0.0.1:3307/qwen_managed_agent?useSSL=false',
    ),
    { host: '127.0.0.1', port: '3307', database: 'qwen_managed_agent' },
  );
  assert.deepEqual(parseMysqlJdbcUrl('jdbc:mysql://[::1]/db'), {
    host: '::1',
    port: '3306',
    database: 'db',
  });
  assert.equal(parseMysqlJdbcUrl('jdbc:mysql://a:1,b:2/db'), undefined);
  assert.equal(parseMysqlJdbcUrl('jdbc:postgresql://a/db'), undefined);
  assert.deepEqual(
    configurationFiles(
      'file:/etc/q/application.yml, optional:file:/etc/q/extra.yml,classpath:x.yml,file:/etc/q/',
    ),
    ['/etc/q/application.yml', '/etc/q/extra.yml'],
  );
  assert.equal(serverBaseUrl(new Map()), 'http://127.0.0.1:8080');
  assert.equal(
    serverBaseUrl(
      new Map([
        ['QWEN_MANAGED_AGENT_SERVER_ADDRESS', '::'],
        ['SERVER_PORT', '9090'],
      ]),
    ),
    'http://[::1]:9090',
  );
  assert.equal(
    serverBaseUrl(new Map([['QWEN_MANAGED_AGENT_SERVER_ADDRESS', '0.0.0.0']])),
    'http://127.0.0.1:8080',
  );
});

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const BASELINE = {
  'db/managed-schema/V1__managed_schema.sql': 'create table a;\n',
};

/** A minimal zip: the reader follows the central directory, as for a jar. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [index, [name, text]] of entries.entries()) {
    const data = Buffer.from(text);
    // Alternate the two methods a jar uses.
    const method = index % 2 === 0 ? 8 : 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function writeDistribution(
  root,
  { version, scripts = BASELINE, files = {} },
) {
  const contents = {
    'manifest.json': `${JSON.stringify(
      {
        schemaVersion: 1,
        name: 'qwen-managed-agent-reference',
        version,
        components: [{ role: 'control-plane', path: 'lib/server.jar' }],
        compatibility: {
          qwenCodeVersion: '1.2.3',
          java: '>=21',
          node: '>=22.0.0',
        },
      },
      null,
      2,
    )}\n`,
    'bin/qwen-managed-agent-server': '#!/usr/bin/env sh\n',
    'config/application.example.yml': 'template\n',
    'lib/server.jar': zip([
      ['BOOT-INF/classes/application.yml', 'server: {}\n'],
      ...Object.entries(scripts).map(([name, text]) => [
        `BOOT-INF/classes/${name}`,
        text,
      ]),
    ]),
    'systemd/qwen-managed-agent-server.service': '[Service]\n',
    'systemd/qwen-hosted-harness.service': '[Service]\n',
    ...files,
  };
  for (const [name, content] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  await writeFile(
    path.join(root, 'SHA256SUMS'),
    Object.entries(contents)
      .map(([name, content]) => `${sha256(content)}  ${name}\n`)
      .sort()
      .join(''),
  );
}

async function executable(file, content = '#!/bin/sh\n') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await chmod(file, 0o755);
}

/** A host with the two units, an installed 0.1.0 and an extracted 0.2.0. */
async function rig(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opt = path.join(root, 'opt');
  const current = path.join(opt, 'qwen-managed-agent');
  const distribution = path.join(root, 'new');
  const etc = path.join(root, 'etc');
  const tools = path.join(root, 'tools');
  const cgroups = path.join(root, 'cgroup');
  const state = path.join(root, 'state');
  await writeDistribution(current, { version: '0.1.0' });
  await writeFile(path.join(current, 'config/application.yml'), 'key: x\n', {
    mode: 0o600,
  });
  await writeDistribution(distribution, {
    version: overrides.version ?? '0.2.0',
    scripts: overrides.scripts,
    files: overrides.files,
  });
  for (const tool of ['java', 'node', 'qwen', 'mysqldump']) {
    await executable(path.join(tools, tool));
  }
  await mkdir(etc, { recursive: true });
  await writeFile(
    path.join(etc, 'server.env'),
    [
      'SPRING_DATASOURCE_URL=jdbc:mysql://127.0.0.1:3306/qwen_managed_agent',
      'SPRING_DATASOURCE_USERNAME=qwen',
      "SPRING_DATASOURCE_PASSWORD='p\"w'",
      `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE=${etc}/harness.env`,
      `QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY=${state}`,
      'SERVER_PORT=18080',
      ...(overrides.serverEnv ?? []),
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(etc, 'harness.env'),
    [
      'QWEN_SERVER_TOKEN=t',
      'QWEN_MANAGED_RUNTIME_BROKER_TOKEN=b',
      ...(overrides.harnessEnv ?? []),
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await mkdir(path.join(state, 'workers'), { recursive: true });
  await writeFile(path.join(state, 'workers/w1.json'), '{}\n');

  const units = {
    [SERVER]: {
      LoadState: 'loaded',
      ActiveState: 'active',
      ExecStart: `{ path=${current}/bin/qwen-managed-agent-server ; argv[]=${current}/bin/qwen-managed-agent-server ; ignore_errors=no }`,
      EnvironmentFiles: [`${etc}/server.env (ignore_errors=no)`],
      Environment: `PATH=${tools}`,
      User: 'svc',
      WorkingDirectory: current,
      ControlGroup: `/system.slice/${SERVER}.service`,
      FragmentPath: `${etc}/${SERVER}.service`,
      DropInPaths: '',
      ActiveEnterTimestampMonotonic: '100',
      InactiveEnterTimestampMonotonic: '50',
      procs: ['10', '11'],
    },
    [HARNESS]: {
      LoadState: 'loaded',
      ActiveState: 'active',
      ExecStart: `{ path=${tools}/qwen ; argv[]=${tools}/qwen serve ; ignore_errors=no }`,
      EnvironmentFiles: [`${etc}/harness.env (ignore_errors=no)`],
      Environment: `PATH=${tools}`,
      User: 'svc',
      WorkingDirectory: '',
      ControlGroup: `/system.slice/${HARNESS}.service`,
      FragmentPath: `${etc}/${HARNESS}.service`,
      DropInPaths: '',
      ActiveEnterTimestampMonotonic: '90',
      InactiveEnterTimestampMonotonic: '40',
      procs: ['20'],
    },
  };
  for (const name of [SERVER, HARNESS]) {
    await writeFile(path.join(etc, `${name}.service`), '[Service]\n');
  }

  const writeCgroups = async () => {
    for (const [name, unit] of Object.entries(units)) {
      const directory = path.join(cgroups, 'system.slice', `${name}.service`);
      await rm(directory, { recursive: true, force: true });
      if (unit.procs.length > 0) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, 'cgroup.procs'),
          unit.procs.map((pid) => `${pid}\n`).join(''),
        );
      }
    }
  };
  await writeCgroups();

  const host = {
    root,
    current,
    distribution,
    etc,
    state,
    tools,
    units,
    calls: [],
    output: [],
    clock: 0,
    java: 'openjdk version "21.0.2" 2024-01-16',
    qwen: '1.2.3',
    mysqldumpStatus: 0,
    preflightStatus: 0,
    // Whether the main process alone stops (KillMode=process) or workers
    // ignore TERM.
    workersIgnoreTerm: false,
    responses: {},
    requests: [],
  };
  const systemctl = (args) => {
    const [verb, ...rest] = args;
    if (verb === 'show') {
      const unit = units[rest[0]];
      const lines = [];
      for (let index = 1; index < rest.length; index += 2) {
        const property = rest[index + 1];
        const value = unit[property];
        if (property === 'ControlGroup') {
          lines.push(
            `ControlGroup=${unit.procs.length > 0 ? unit.ControlGroup : ''}`,
          );
        } else if (Array.isArray(value)) {
          lines.push(...value.map((each) => `${property}=${each}`));
        } else {
          lines.push(`${property}=${value ?? ''}`);
        }
      }
      return { status: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }
    const name = rest.at(-1);
    const unit = units[name];
    host.clock += 1;
    if (verb === 'stop') {
      unit.ActiveState = 'inactive';
      unit.InactiveEnterTimestampMonotonic = String(1000 + host.clock);
      // KillMode=process: the server's workers outlive its main process.
      unit.procs = name === SERVER ? unit.procs.slice(1) : [];
    } else if (verb === 'kill') {
      if (!host.workersIgnoreTerm) {
        unit.procs = [];
      }
    } else if (verb === 'start') {
      unit.ActiveState = 'active';
      unit.ActiveEnterTimestampMonotonic = String(1000 + host.clock);
      unit.procs = ['30'];
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const system = {
    uid: () => 0,
    distribution,
    cgroupRoot: cgroups,
    bootId: async () => 'boot-1',
    now: () => host.clock * 1000,
    sleep: async (milliseconds) => {
      host.clock += milliseconds / 1000;
      await writeCgroups();
    },
    connect: async () => true,
    fetch: async (url, init = {}) => {
      host.requests.push({ url, init });
      const { pathname, search } = new URL(url);
      const response = host.responses[`${init.method ?? 'GET'} ${pathname}`];
      const body =
        typeof response === 'function' ? response(search, init) : response;
      return {
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        statusText: body === undefined ? 'Not Found' : 'OK',
        json: async () => body ?? { error: { message: 'missing' } },
      };
    },
    run: (command, args, options = {}) => {
      const name = path.basename(command);
      host.calls.push([name, ...args]);
      if (name === 'systemctl') {
        const result = systemctl(args);
        return result;
      }
      if (name === 'java') {
        return { status: 0, stdout: '', stderr: host.java };
      }
      if (name === 'node') {
        return { status: 0, stdout: 'v22.1.0\n', stderr: '' };
      }
      if (name === 'qwen') {
        return { status: 0, stdout: `${host.qwen}\n`, stderr: '' };
      }
      if (name === 'mysqldump') {
        if (args[0] === '--version') {
          return { status: 0, stdout: 'mysqldump  Ver 8.4.6\n', stderr: '' };
        }
        host.dumpCredentials = readFileSyncText(args[0].split('=')[1]);
        writeSync(options.stdio[1], '-- dump\n');
        return host.mysqldumpStatus === 0
          ? { status: 0, stdout: '', stderr: '' }
          : { status: host.mysqldumpStatus, stdout: '', stderr: 'denied' };
      }
      if (name === 'tar') {
        return spawnSync('tar', args, { encoding: 'utf8' });
      }
      if (name === 'systemd-run') {
        return { status: host.preflightStatus };
      }
      throw new Error(`unexpected command ${command}`);
    },
    out: (line) => host.output.push(line),
    err: (line) => host.output.push(line),
  };
  host.system = system;
  host.upgrade = async (...argv) => {
    host.output = [];
    return runUpgrade(argv, system);
  };
  host.stop = async () => {
    for (const unit of Object.values(units)) {
      unit.ActiveState = 'inactive';
      unit.procs = [];
    }
    await writeCgroups();
  };
  return host;
}

function readFileSyncText(file) {
  return spawnSync('cat', [file], { encoding: 'utf8' }).stdout;
}

function rowsOf(output) {
  return Object.fromEntries(
    output
      .map((line) => /^(PASS|WARN|FAIL|SKIP)\s+(\S+)\s+(.*)$/.exec(line))
      .filter(Boolean)
      .map(([, status, name, detail]) => [name, `${status} ${detail}`]),
  );
}

test('reads the Flyway scripts out of a jar by content', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-upgrade-jar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jar = path.join(root, 'server.jar');
  // Deflated, then stored: the digests are of the scripts, not their bytes in the jar.
  await writeFile(
    jar,
    zip([
      ['BOOT-INF/classes/db/managed-schema/V1__base.sql', 'create table a;\n'],
      ['BOOT-INF/classes/db/managed-schema/V2__more.sql', 'create table b;\n'],
      ['BOOT-INF/classes/db/managed-schema/README.md', 'not a script'],
      ['BOOT-INF/lib/V3__nested.sql', 'not on the classpath root'],
    ]),
  );
  assert.deepEqual(Object.fromEntries(await migrationScripts(jar)), {
    'db/managed-schema/V1__base.sql': sha256('create table a;\n'),
    'db/managed-schema/V2__more.sql': sha256('create table b;\n'),
  });
});

test('check keeps the releases outside the distribution', async (t) => {
  const host = await rig(t);
  assert.equal(
    await host.upgrade(
      'check',
      '--releases',
      path.join(host.current, 'releases'),
    ),
    1,
  );
  assert.match(
    rowsOf(host.output).layout,
    /^FAIL .* is inside the distribution/,
  );
  // install renames the installed directory into the releases directory,
  // which a rename cannot do across file systems.
  const device = (await stat(path.dirname(host.current))).dev;
  let elsewhere;
  for (const candidate of ['/dev/shm', '/run', os.tmpdir()]) {
    try {
      if ((await stat(candidate)).dev !== device) {
        elsewhere = candidate;
        break;
      }
    } catch {
      // Not on this host.
    }
  }
  if (!elsewhere) {
    t.diagnostic('no second file system to put the releases on');
    return;
  }
  assert.equal(
    await host.upgrade(
      'check',
      '--releases',
      path.join(elsewhere, `qwen-upgrade-releases-${process.pid}`),
    ),
    1,
  );
  assert.match(
    rowsOf(host.output).layout,
    /^FAIL .* is on another file system than/,
  );
});

test('refuses a checksum list that names a path outside the release', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-upgrade-sums-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  const digest = sha256('a\n');
  await writeFile(
    path.join(root, 'SHA256SUMS'),
    `${digest}  a.txt\n${digest}  ../a.txt\n${digest}  /etc/passwd\n`,
  );
  const { listed, failed } = await verifyChecksums(root);
  assert.deepEqual(listed, ['a.txt']);
  assert.deepEqual(failed, [`${digest}  ../a.txt`, `${digest}  /etc/passwd`]);
});

test('check compares the new release with the installed one', async (t) => {
  const host = await rig(t);
  assert.equal(await host.upgrade('check'), 0);
  const rows = rowsOf(host.output);
  assert.match(rows.distribution, /^PASS 6 file\(s\)/);
  assert.match(rows.deployment, /^PASS/);
  assert.equal(rows.version, 'PASS 0.1.0 -> 0.2.0');
  assert.equal(rows.database, 'PASS the 1 Flyway script(s) did not change');
  assert.match(rows.java, /^PASS .* is Java 21, >=21/);
  assert.match(rows.node, /^PASS .* is v22.1.0/);
  assert.match(rows['qwen-code'], /^PASS/);
  assert.match(rows['harness-env'], /^PASS/);
  assert.match(rows.config, /^PASS install copies application.yml/);
  assert.match(rows['unit-files'], /^PASS/);
  assert.match(
    rows.layout,
    new RegExp(
      `^PASS install moves ${host.current} to ${host.current}-releases/0.1.0`,
    ),
  );
  assert.ok(host.output.includes('Plan:'));
  // check never changes a unit.
  assert.ok(
    host.calls.every(
      ([command, verb]) => command !== 'systemctl' || verb === 'show',
    ),
  );
});

test('check refuses what the new release cannot replace', async (t) => {
  const cases = [
    [{ version: '0.1.0' }, 'version', /^FAIL 0.1.0 is already installed/],
    [{ version: '0.0.9' }, 'version', /^FAIL 0.0.9 is older/],
    [
      {
        scripts: {
          'db/managed-schema/V1__managed_schema.sql':
            'create table a (b int);\n',
        },
      },
      'database',
      /^FAIL this release changed or removed V1__managed_schema.sql, which the installed database ran/,
    ],
    [
      { scripts: {} },
      'database',
      /^FAIL this release changed or removed V1__managed_schema.sql/,
    ],
    [
      {
        scripts: {
          ...BASELINE,
          'db/managed-schema/V2__more.sql': 'create table c;\n',
        },
      },
      'database',
      /^WARN start applies V2__more.sql; only the database backup undoes it/,
    ],
    [
      { files: { 'lib/server.jar': 'not a jar' } },
      'database',
      /^WARN cannot compare the Flyway scripts \(.*server.jar is not a zip archive\)/,
    ],
    [
      { harnessEnv: ['QWEN_HOSTED_HARNESS_BROKER_ARGS=--x'] },
      'harness-env',
      /^WARN .* sets QWEN_HOSTED_HARNESS_BROKER_ARGS/,
    ],
    [
      { serverEnv: ['QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN=b'] },
      'harness-env',
      /^WARN both .* set the Broker token/,
    ],
    [
      { files: { 'systemd/qwen-hosted-harness.service': '[Service]\nX=1\n' } },
      'unit-files',
      /^WARN systemd\/qwen-hosted-harness.service changed/,
    ],
  ];
  for (const [overrides, name, expected] of cases) {
    const host = await rig(t, overrides);
    const code = await host.upgrade('check');
    assert.match(rowsOf(host.output)[name], expected, name);
    assert.equal(code, expected.source.startsWith('^FAIL') ? 1 : 0, name);
  }

  const old = await rig(t);
  old.java = 'openjdk version "17.0.9"';
  old.qwen = '1.2.2';
  await writeFile(
    path.join(old.distribution, 'bin/qwen-managed-agent-server'),
    'tampered',
  );
  assert.equal(await old.upgrade('check'), 1);
  assert.ok(
    old.output.includes(
      'stop refuses until the FAIL rows pass. Then the plan is:',
    ),
  );
  const rows = rowsOf(old.output);
  assert.match(rows.java, /^FAIL .* is Java 17; this release needs >=21/);
  assert.match(
    rows['qwen-code'],
    /^WARN .* is 1.2.2; this release is built for 1.2.3/,
  );
  assert.match(
    rows.distribution,
    /^FAIL bin\/qwen-managed-agent-server does not match/,
  );
});

test('the Broker settings change after backup and before start', async (t) => {
  const { host, target } = await backedUp(t, {
    harnessEnv: ['QWEN_HOSTED_HARNESS_BROKER_ARGS=--x'],
    serverEnv: ['QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN=b'],
  });
  assert.equal(await host.upgrade('check'), 0);
  const plan = host.output.slice(host.output.indexOf('Plan:'));
  assert.match(
    plan.join('\n'),
    /install --backup <that directory>\n {2}5\. After backup, replace it with QWEN_MANAGED_RUNTIME_BROKER_URL and QWEN_MANAGED_RUNTIME_BROKER_TOKEN \(manual\)\.\n {2}6\. .* start/,
  );
  // The backup keeps the files the old release reads.
  const listed = spawnSync(
    'tar',
    ['-xOf', path.join(target, 'configuration.tar')],
    {
      encoding: 'utf8',
    },
  ).stdout;
  assert.match(listed, /QWEN_HOSTED_HARNESS_BROKER_ARGS=--x/);
  assert.equal(await host.upgrade('install', '--backup', target), 0);

  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /start refused: .* sets QWEN_HOSTED_HARNESS_BROKER_ARGS, which this release no longer reads; replace it with/,
  );
  await writeFile(
    path.join(host.etc, 'harness.env'),
    'QWEN_MANAGED_RUNTIME_BROKER_URL=http://127.0.0.1:4182\nQWEN_MANAGED_RUNTIME_BROKER_TOKEN=b\n',
  );
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /start refused: both .* set the Broker token/,
  );
  assert.ok(
    host.calls.every(
      ([command, verb]) => command !== 'systemctl' || verb !== 'start',
    ),
  );
});

test('every phase but check needs root and a known phase', async (t) => {
  const host = await rig(t);
  assert.equal(await host.upgrade('upgrade'), 2);
  assert.equal(await host.upgrade('verify', '--turn'), 2);
  assert.equal(await host.upgrade('start', '--timeout', '0'), 2);
  host.system.uid = () => 1000;
  assert.equal(await host.upgrade('check'), 1);
  assert.match(
    host.output.join('\n'),
    /check refused: Run the upgrade as root/,
  );
});

test('stop stops the control plane, reaps its workers, then the Harness', async (t) => {
  const host = await rig(t);
  assert.equal(await host.upgrade('stop'), 0);
  const changes = host.calls.filter(
    ([command, verb]) => command === 'systemctl' && verb !== 'show',
  );
  assert.deepEqual(changes, [
    ['systemctl', 'stop', SERVER],
    ['systemctl', 'kill', '--kill-whom=all', '-s', 'TERM', SERVER],
    ['systemctl', 'stop', HARNESS],
  ]);
  assert.deepEqual(host.units[SERVER].procs, []);
});

test('stop leaves the Harness running while workers outlive the timeout', async (t) => {
  const host = await rig(t);
  host.workersIgnoreTerm = true;
  assert.equal(await host.upgrade('stop', '--timeout', '3'), 1);
  assert.match(
    host.output.join('\n'),
    /Runtime workers still run after 3s \(PID 11\).*-s KILL qwen-managed-agent-server/,
  );
  assert.equal(host.units[HARNESS].ActiveState, 'active');
});

test('stop changes nothing when check fails', async (t) => {
  const host = await rig(t, { version: '0.1.0' });
  assert.equal(await host.upgrade('stop'), 1);
  assert.ok(
    host.calls.every(
      ([command, verb]) => command !== 'systemctl' || verb === 'show',
    ),
  );
});

test('backup records the database, Runtime state and configuration', async (t) => {
  const host = await rig(t);
  const target = path.join(host.root, 'backup');
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      target,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    ),
    1,
  );
  assert.match(host.output.join('\n'), /still run; run stop before backup/);

  await host.stop();
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      target,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    ),
    0,
  );
  assert.deepEqual((await readdir(target)).sort(), [
    'backup.json',
    'configuration.tar',
    'database.sql',
    'runtime-state.tar',
  ]);
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  for (const name of await readdir(target)) {
    assert.equal(
      (await stat(path.join(target, name))).mode & 0o777,
      0o600,
      name,
    );
  }
  assert.match(host.dumpCredentials, /^password="p\\"w"$/m);
  const dump = host.calls.find(
    ([command, first]) => command === 'mysqldump' && first !== '--version',
  );
  assert.ok(dump[1].startsWith('--defaults-extra-file='));
  assert.deepEqual(dump.slice(-2), ['--databases', 'qwen_managed_agent']);
  assert.ok(dump.includes('--set-gtid-purged=OFF'));
  const record = JSON.parse(
    await readFile(path.join(target, 'backup.json'), 'utf8'),
  );
  assert.equal(record.from.version, '0.1.0');
  assert.equal(record.to.version, '0.2.0');
  assert.equal(record.database, 'database.sql');
  assert.deepEqual(
    record.files.map((file) => file.name),
    ['database.sql', 'runtime-state.tar', 'configuration.tar'],
  );
  const listed = spawnSync(
    'tar',
    ['-tf', path.join(target, 'configuration.tar')],
    { encoding: 'utf8' },
  ).stdout;
  for (const file of [
    'etc/server.env',
    'etc/harness.env',
    'etc/qwen-managed-agent-server.service',
    'opt/qwen-managed-agent/config/application.yml',
  ]) {
    assert.ok(listed.includes(file), file);
  }
  assert.ok(
    spawnSync('tar', ['-tf', path.join(target, 'runtime-state.tar')], {
      encoding: 'utf8',
    }).stdout.includes('./workers/w1.json'),
  );
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      target,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    ),
    1,
  );
  assert.match(host.output.join('\n'), /is not empty/);
});

test('backup leaves no partial backup when the dump fails', async (t) => {
  const host = await rig(t);
  await host.stop();
  host.mysqldumpStatus = 2;
  const target = path.join(host.root, 'backup');
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      target,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    ),
    1,
  );
  assert.match(host.output.join('\n'), /denied/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      target,
      '--mysqldump',
      path.join(host.root, 'none'),
    ),
    1,
  );
  assert.match(host.output.join('\n'), /is not installed/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

async function backedUp(t, overrides) {
  const host = await rig(t, overrides);
  await host.stop();
  const target = path.join(host.root, 'backup');
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      target,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    ),
    0,
  );
  return { host, target };
}

test('install switches the distribution link and keeps the old release', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install'), 1);
  assert.match(host.output.join('\n'), /install needs --backup/);
  assert.equal(await host.upgrade('install', '--backup', target), 0);

  const releases = `${host.current}-releases`;
  assert.ok((await lstat(host.current)).isSymbolicLink());
  assert.equal(await readlink(host.current), path.join(releases, '0.2.0'));
  const previous = path.join(releases, '0.1.0');
  assert.match(
    await readFile(path.join(previous, 'manifest.json'), 'utf8'),
    /"0.1.0"/,
  );
  const copied = path.join(releases, '0.2.0/config/application.yml');
  assert.equal(await readFile(copied, 'utf8'), 'key: x\n');
  assert.equal((await stat(copied)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(releases)).sort(), ['0.1.0', '0.2.0']);

  // A second run finds the release installed and the backup spent.
  assert.equal(await host.upgrade('install', '--backup', target), 1);
  assert.match(
    host.output.join('\n'),
    /the backup is of 0.1.0, but 0.2.0 is installed/,
  );
});

test('install refuses a backup the control plane has run past', async (t) => {
  const { host, target } = await backedUp(t);
  host.units[SERVER].ActiveEnterTimestampMonotonic = '5000';
  assert.equal(await host.upgrade('install', '--backup', target), 1);
  assert.match(
    host.output.join('\n'),
    /has started since the backup; run backup again/,
  );

  const second = await backedUp(t);
  // Same size, other bytes: only the checksum tells them apart.
  const dump = path.join(second.target, 'database.sql');
  const original = await readFile(dump, 'utf8');
  await writeFile(dump, original.replace('-- dump', '-- DUMP'));
  assert.equal(
    await second.host.upgrade('install', '--backup', second.target),
    1,
  );
  assert.match(
    second.host.output.join('\n'),
    /database.sql in the backup changed/,
  );
  assert.equal((await lstat(second.host.current)).isDirectory(), true);

  // A reboot restarts the monotonic clock, so the boot ID ties the
  // timestamps to the boot they were read in.
  const third = await backedUp(t);
  third.host.system.bootId = async () => 'boot-2';
  assert.equal(
    await third.host.upgrade('install', '--backup', third.target),
    1,
  );
  assert.match(
    third.host.output.join('\n'),
    /has started since the backup; run backup again/,
  );
});

test('install replaces an existing link in one step', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  // The next release, installed over the link the first one created.
  const next = path.join(host.root, 'next');
  await writeDistribution(next, { version: '0.3.0' });
  host.system.distribution = next;
  const second = path.join(host.root, 'backup-2');
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      second,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    ),
    0,
  );
  assert.equal(await host.upgrade('install', '--backup', second), 0);
  assert.equal(await readlink(host.current), `${host.current}-releases/0.3.0`);
  assert.equal(
    await readFile(path.join(host.current, 'config/application.yml'), 'utf8'),
    'key: x\n',
  );
});

test('start runs the preflight between the Harness and the control plane', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /holds 0.1.0, not 0.2.0; run install first/,
  );
  assert.equal(await host.upgrade('install', '--backup', target), 0);

  // A worker left in the stopped server's cgroup would race the new one.
  host.units[SERVER].procs = ['40'];
  await host.system.sleep(0);
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /Runtime workers of qwen-managed-agent-server still run \(PID 40\); run stop first/,
  );
  assert.equal(host.units[HARNESS].ActiveState, 'inactive');
  host.units[SERVER].procs = [];
  await host.system.sleep(0);

  host.preflightStatus = 1;
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /preflight failed, so qwen-managed-agent-server stays stopped/,
  );
  assert.equal(host.units[HARNESS].ActiveState, 'active');
  assert.equal(host.units[SERVER].ActiveState, 'inactive');
  const preflight = host.calls.find(([command]) => command === 'systemd-run');
  assert.ok(preflight.includes('--uid=svc'));
  assert.ok(preflight.includes(`--setenv=PATH=${host.tools}`));
  assert.ok(
    preflight.includes(`--property=EnvironmentFile=${host.etc}/server.env`),
  );
  assert.deepEqual(preflight.slice(-2), [
    path.join(host.current, 'bin/qwen-managed-agent-server'),
    '--check',
  ]);

  host.preflightStatus = 0;
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  assert.equal(host.units[SERVER].ActiveState, 'active');
  assert.ok(
    host.requests.some(
      ({ url }) => url === 'http://127.0.0.1:18080/actuator/health',
    ),
  );
});

test('start gives up when the control plane never reports UP', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'DOWN' };
  assert.equal(await host.upgrade('start', '--timeout', '5'), 1);
  assert.match(
    host.output.join('\n'),
    /did not report UP at http:\/\/127.0.0.1:18080\/actuator\/health/,
  );
});

test('verify runs the online preflight and reads the API', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  assert.equal(await host.upgrade('verify'), 1);
  assert.match(host.output.join('\n'), /not running; run start first/);

  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  assert.equal(await host.upgrade('verify'), 0);
  assert.match(rowsOf(host.output).session, /^SKIP no --tenant/);
  assert.deepEqual(
    host.calls
      .filter(([command]) => command === 'systemd-run')
      .at(-1)
      .slice(-2),
    ['--check', '--online'],
  );

  host.responses['GET /v1/agents/sessions'] = { data: [{ id: 's/1' }] };
  host.responses['GET /v1/agents/sessions/s%2F1'] = { id: 's/1' };
  host.responses['GET /v1/agents/sessions/s%2F1/items'] = { data: [{}, {}] };
  host.responses['POST /v1/agents/sessions'] = { id: 's2' };
  let polls = 0;
  host.responses['GET /v1/agents/sessions/s2/events'] = (search) => {
    polls += 1;
    return polls === 1
      ? { data: [{ sequence: 1, type: 'turn.started' }] }
      : {
          data: [
            { sequence: 2, type: 'turn.completed', terminal: true, search },
          ],
        };
  };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 0);
  const rows = rowsOf(host.output);
  assert.equal(rows.session, 'PASS read Session s/1 and 2 item(s)');
  assert.match(rows.turn, /^PASS Session s2 ended with turn.completed/);
  const create = host.requests.find(({ init }) => init.method === 'POST');
  assert.equal(create.init.headers['X-Qwen-Tenant-Id'], 'acme');
  assert.match(create.init.headers['Idempotency-Key'], /^upgrade-verify-/);
  // The public API keeps no other metadata yet; the title names the Session.
  assert.deepEqual(JSON.parse(create.init.body), {
    agent_id: 'qwen-code',
    metadata: { title: 'qwen-managed-agent-upgrade verify' },
    input: [{ type: 'input_text', text: 'Reply with the single word OK.' }],
  });
  assert.ok(
    host.requests.some(({ url }) =>
      url.endsWith('/v1/agents/sessions/s2/events?after=1&limit=100'),
    ),
  );

  polls = 0;
  host.responses['GET /v1/agents/sessions/s2/events'] = () => ({
    data: [{ sequence: 3, type: 'turn.failed', terminal: true }],
  });
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 1);
  assert.match(
    rowsOf(host.output).turn,
    /^FAIL Session s2 ended with turn.failed/,
  );
});

test('verify leaves signed APIs to the ingress', async (t) => {
  const { host, target } = await backedUp(t, {
    serverEnv: ['QWEN_MANAGED_AGENT_AUTH_MODE=signed'],
  });
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 0);
  assert.match(
    rowsOf(host.output).session,
    /^SKIP the API takes signed requests only/,
  );
  assert.ok(!host.requests.some(({ url }) => url.includes('/v1/')));
});
