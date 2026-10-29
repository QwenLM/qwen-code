/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync, writeSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
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
  execStartArguments,
  execStartPath,
  formatEnvironmentFile,
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
const RESOLVER =
  '-Dloader.main=com.alibaba.qwen.code.managedagent.preflight.ResolvedConfiguration';

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
  // systemd.exec(5): inside double quotes only \" \\ \` \$ and
  // backslash-newline are escapes; outside quotes a backslash escapes any
  // character. Each value below was read back from systemd 257.
  assert.deepEqual(
    Object.fromEntries(
      parseEnvironmentFile(
        [
          'PASSWORD="p@ss\\word"',
          'BARE=C:\\temp',
          'HEX="p\\x41ss"',
          "RAW='a\\b'",
          'JOINED="a"\'b\'c',
          'SPACED="x  " ',
          'MULTI="one',
          'two"',
          'FOLDED="one\\',
          'two"',
          '# a comment ending in a backslash \\',
          'AFTER=1',
          'OPEN="runs to the end',
        ].join('\n'),
      ),
    ),
    {
      PASSWORD: 'p@ss\\word',
      BARE: 'C:temp',
      HEX: 'p\\x41ss',
      RAW: 'a\\b',
      JOINED: 'abc',
      SPACED: 'x  ',
      MULTI: 'one\ntwo',
      FOLDED: 'onetwo',
      AFTER: '1',
      OPEN: 'runs to the end',
    },
  );
});

test('writes environment files systemd reads back as written', () => {
  const values = new Map([
    ['PASSWORD', 'p"w\\x$HOME`id`'],
    ['QUOTE', "it's"],
    ['SPACED', '  a  b  '],
    ['MULTI', 'one\ntwo\\\nthree'],
    ['HASH', '#not a comment'],
    ['EMPTY', ''],
  ]);
  assert.deepEqual(parseEnvironmentFile(formatEnvironmentFile(values)), values);
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
    execStartArguments(
      '{ path=/opt/q/bin/s ; argv[]=/opt/q/bin/s ; ignore_errors=no ; start_time=[n/a] }',
    ),
    [],
  );
  // "a b" and a then b print alike.
  assert.equal(
    execStartArguments(
      '{ path=/opt/q/bin/s ; argv[]=/opt/q/bin/s a b ; ignore_errors=no }',
    ),
    undefined,
  );
  assert.equal(execStartArguments(''), undefined);
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
  // A % that starts no escape is a URL this command cannot read.
  assert.equal(
    parseMysqlJdbcUrl('jdbc:mysql://127.0.0.1/qwen%prod'),
    undefined,
  );
  assert.equal(
    parseMysqlJdbcUrl('jdbc:mysql://127.0.0.1/qwen%25prod').database,
    'qwen%prod',
  );
  assert.equal(parseMysqlJdbcUrl('jdbc:postgresql://a/db'), undefined);
  assert.deepEqual(
    configurationFiles(
      'file:/etc/q/application.yml, optional:file:/etc/q/extra.yml,classpath:x.yml,file:/etc/d/',
    ),
    {
      files: [
        '/etc/q/application.yml',
        '/etc/q/extra.yml',
        '/etc/d/application.properties',
        '/etc/d/application.yaml',
        '/etc/d/application.yml',
      ],
      unread: ['classpath:x.yml'],
    },
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
  await writeDistribution(current, {
    version: '0.1.0',
    scripts: overrides.installedScripts,
  });
  await writeFile(path.join(current, 'config/application.yml'), 'key: x\n', {
    mode: 0o600,
  });
  await writeDistribution(distribution, {
    version: overrides.version ?? '0.2.0',
    scripts: overrides.scripts,
    files: overrides.files,
  });
  // As root extracts it with umask 077.
  await chmod(path.join(distribution, 'lib/server.jar'), 0o600);
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
      ...(overrides.state === null
        ? []
        : [`QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY=${state}`]),
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

  // The unified hierarchy, or with cgroupLayout 'v1' systemd's named one.
  const writeCgroups = async () => {
    const v1 = host.cgroupLayout === 'v1';
    await rm(cgroups, { recursive: true, force: true });
    await mkdir(path.join(cgroups, v1 ? 'systemd' : ''), { recursive: true });
    await writeFile(
      path.join(cgroups, v1 ? 'systemd/cgroup.procs' : 'cgroup.controllers'),
      '',
    );
    for (const [name, unit] of Object.entries(units)) {
      const directory = path.join(
        cgroups,
        v1 ? 'systemd' : '',
        'system.slice',
        `${name}.service`,
      );
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
    mysqldumpVersion: 'mysqldump  Ver 8.4.6',
    preflightStatus: 0,
    // Whether the main process alone stops (KillMode=process) or workers
    // ignore TERM.
    workersIgnoreTerm: false,
    responses: {},
    requests: [],
    // Every systemd-run, with the environment systemd would hand it.
    services: [],
    // What the jar resolves, beyond the documented variables.
    resolved: {},
    resolveFailure: undefined,
    stopFails: false,
    cgroupLayout: 'unified',
    // An errno the next cgroup.procs read fails with.
    cgroupError: undefined,
  };
  await writeCgroups();
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
      unit.ActiveState =
        host.stopFails && name === SERVER ? 'failed' : 'inactive';
      if (host.stopFails && name === SERVER) {
        Object.assign(unit, { Result: 'exit-code', ExecMainStatus: '143' });
      }
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
    readCgroup: async (file) => {
      if (host.cgroupError) {
        throw Object.assign(new Error(host.cgroupError), {
          code: host.cgroupError,
        });
      }
      return readFile(file, 'utf8');
    },
    bootId: async () => 'boot-1',
    now: () => host.clock * 1000,
    sleep: async (milliseconds) => {
      host.clock += milliseconds / 1000;
      await writeCgroups();
    },
    connect: async () => true,
    fetch: async (url, init = {}) => {
      host.requests.push({ url, init });
      if (host.hang) {
        // A listener that accepts and never answers: only the signal ends it.
        return new Promise((resolve, reject) => {
          // The open socket a real fetch holds keeps the process alive;
          // AbortSignal.timeout() alone does not.
          const socket = setInterval(() => {}, 1000);
          init.signal?.addEventListener('abort', () => {
            clearInterval(socket);
            reject(init.signal.reason);
          });
        });
      }
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
          return {
            status: 0,
            stdout: `${host.mysqldumpVersion}\n`,
            stderr: '',
          };
        }
        host.dumpCredentialsFile = args[0].split('=')[1];
        host.dumpCredentials = readFileSyncText(host.dumpCredentialsFile);
        writeSync(options.stdio[1], '-- dump\n');
        return host.mysqldumpStatus === 0
          ? { status: 0, stdout: '', stderr: '' }
          : { status: host.mysqldumpStatus, stdout: '', stderr: 'denied' };
      }
      if (name === 'tar') {
        return spawnSync('tar', args, { encoding: 'utf8' });
      }
      if (name === 'systemd-run') {
        // systemd reads each environment file in turn, then runs the command.
        const environment = new Map();
        const files = [];
        for (const arg of args) {
          const file = /^--property=EnvironmentFile=-?(.*)$/.exec(arg)?.[1];
          if (file) {
            const text = readFileSyncText(file);
            files.push({ file, text });
            for (const [key, value] of parseEnvironmentFile(text)) {
              environment.set(key, value);
            }
          }
        }
        const service = { args, environment, files };
        host.services.push(service);
        if (!args.includes(RESOLVER)) {
          return { status: host.preflightStatus };
        }
        const jar = args[args.indexOf('-cp') + 1];
        service.jar = {
          path: jar,
          mode: statSync(jar).mode & 0o777,
          directoryMode: statSync(path.dirname(jar)).mode & 0o777,
        };
        if (host.resolveFailure) {
          return { status: 1, stdout: '', stderr: host.resolveFailure };
        }
        // A stand-in for Spring that reads the documented variables only.
        const mode = (environment.get('QWEN_MANAGED_AGENT_AUTH_MODE') ?? 'auto')
          .trim()
          .toLowerCase();
        const resolved = {
          runtimeStateDirectory:
            environment.get('QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY') ?? '',
          runtimeStateOrigin: 'QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY',
          authMode: mode === 'auto' ? 'open' : mode,
          trustedActorHeader:
            environment.get('QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER') ?? '',
          ...host.resolved,
        };
        return {
          status: 0,
          stdout: `WARNING: a JVM line\nqwen-managed-agent-configuration ${JSON.stringify(resolved)}\n`,
          stderr: '',
        };
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
  // check with the rig's client, which the host's own PATH may lack.
  host.check = (...argv) =>
    host.upgrade(
      'check',
      '--mysqldump',
      path.join(tools, 'mysqldump'),
      ...argv,
    );
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
      ['BOOT-INF/classes/db/managed-schema/V4__upper.SQL', 'insert;\n'],
      ['BOOT-INF/classes/db/managed-schema/R__view.sql', 'create view;\n'],
      ['BOOT-INF/classes/db/managed-schema/U2__undo.sql', 'drop table b;\n'],
      // The prefixes are case-sensitive.
      ['BOOT-INF/classes/db/managed-schema/v5__lower.sql', 'ignored'],
    ]),
  );
  assert.deepEqual(Object.fromEntries(await migrationScripts(jar)), {
    'db/managed-schema/V1__base.sql': sha256('create table a;\n'),
    'db/managed-schema/V2__more.sql': sha256('create table b;\n'),
    'db/managed-schema/V4__upper.SQL': sha256('insert;\n'),
    'db/managed-schema/R__view.sql': sha256('create view;\n'),
    'db/managed-schema/U2__undo.sql': sha256('drop table b;\n'),
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
  // install copies the new distribution into the releases directory.
  assert.equal(
    await host.check('--releases', path.join(host.distribution, 'releases')),
    1,
  );
  assert.match(
    rowsOf(host.output).layout,
    new RegExp(`^FAIL .* is inside the distribution ${host.distribution}$`),
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
  assert.equal(await host.check(), 0);
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
  assert.match(rows['backup-tools'], /^PASS backup dumps the database with /);
  assert.equal(
    rows['runtime-state'],
    `PASS backup archives ${host.state} (QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY)`,
  );
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
      /^WARN cannot compare the Flyway scripts \(no Flyway script found in .*server.jar\)/,
    ],
    [
      // Flyway reads the suffix in any case.
      {
        scripts: { ...BASELINE, 'db/managed-schema/V2__seed.SQL': 'insert;\n' },
      },
      'database',
      /^WARN start applies V2__seed.SQL; only the database backup undoes it/,
    ],
    [
      // A changed repeatable script runs again; a removed one fails validation.
      {
        installedScripts: { ...BASELINE, 'db/managed-schema/R__view.sql': 'a' },
        scripts: { ...BASELINE, 'db/managed-schema/R__view.sql': 'b' },
      },
      'database',
      /^WARN start applies R__view.sql/,
    ],
    [
      {
        installedScripts: { ...BASELINE, 'db/managed-schema/R__view.sql': 'a' },
        scripts: BASELINE,
      },
      'database',
      /^FAIL this release changed or removed R__view.sql/,
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
    const code = await host.check();
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
  assert.equal(await old.check(), 1);
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
  assert.equal(await host.check(), 0);
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
  const host = await rig(t, { version: '0.0.9' });
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

  // The Harness unit's file and its drop-in are configuration too.
  const dropIn = path.join(host.etc, `${HARNESS}.service.d/override.conf`);
  await mkdir(path.dirname(dropIn), { recursive: true });
  await writeFile(dropIn, '[Service]\nTimeoutStopSec=30\n');
  host.units[HARNESS].DropInPaths = dropIn;
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
    'release-config.tar',
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
  // The option file never sits in the backup, and is gone after the dump.
  assert.ok(!host.dumpCredentialsFile.startsWith(`${target}${path.sep}`));
  await assert.rejects(stat(path.dirname(host.dumpCredentialsFile)), {
    code: 'ENOENT',
  });
  const dump = host.calls.find(
    ([command, first]) => command === 'mysqldump' && first !== '--version',
  );
  assert.ok(dump[1].startsWith('--defaults-extra-file='));
  assert.deepEqual(dump.slice(-2), ['--databases', 'qwen_managed_agent']);
  assert.ok(dump.includes('--set-gtid-purged=OFF'));
  const record = JSON.parse(
    await readFile(path.join(target, 'backup.json'), 'utf8'),
  );
  assert.deepEqual(record.from, {
    version: '0.1.0',
    release: `${host.current}-releases/0.1.0`,
  });
  assert.equal(record.distribution, host.current);
  assert.equal(record.to.version, '0.2.0');
  assert.equal(record.harness.unit, HARNESS);
  assert.equal(record.database, 'database.sql');
  assert.deepEqual(record.datasource, {
    host: '127.0.0.1',
    port: '3306',
    database: 'qwen_managed_agent',
  });
  assert.equal(record.runtimeState, host.state);
  assert.deepEqual(
    record.files.map((file) => file.name),
    [
      'database.sql',
      'runtime-state.tar',
      'configuration.tar',
      'release-config.tar',
    ],
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
    'etc/qwen-hosted-harness.service',
    'etc/qwen-hosted-harness.service.d/override.conf',
  ]) {
    assert.ok(listed.includes(file), file);
  }
  // The installed config/ goes in by its path in the release, which is where
  // the rollback finds it once the distribution path is a link.
  assert.ok(!listed.includes('opt/qwen-managed-agent'));
  assert.deepEqual(
    spawnSync('tar', ['-tf', path.join(target, 'release-config.tar')], {
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .filter(Boolean)
      .sort(),
    ['config/', 'config/application.example.yml', 'config/application.yml'],
  );
  assert.ok(
    host.output.includes(
      `install moves the previous release to ${host.current}-releases/0.1.0.`,
    ),
  );
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
  // A backup of another installed release.
  const stale = path.join(host.root, 'stale');
  await cp(target, stale, { recursive: true });
  const record = JSON.parse(
    await readFile(path.join(stale, 'backup.json'), 'utf8'),
  );
  record.from.version = '0.0.9';
  await writeFile(path.join(stale, 'backup.json'), JSON.stringify(record));
  assert.equal(await host.upgrade('install', '--backup', stale), 1);
  assert.match(
    host.output.join('\n'),
    /the backup is of 0.0.9, but 0.1.0 is installed; run backup again/,
  );
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

  // A second run, as after an interrupted session, finds the release
  // installed and points at start, not at another backup.
  assert.equal(await host.upgrade('install', '--backup', target), 1);
  assert.equal(
    host.output.at(-1),
    `install refused: 0.2.0 is already installed at ${host.current}; run start or verify for this release.`,
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

  // start migrates the database the unit names, which the dump must be of.
  const fourth = await backedUp(t);
  const environment = path.join(fourth.host.etc, 'server.env');
  await writeFile(
    environment,
    (await readFile(environment, 'utf8')).replace(
      '/qwen_managed_agent',
      '/qwen_managed_agent_b',
    ),
  );
  assert.equal(
    await fourth.host.upgrade('install', '--backup', fourth.target),
    1,
  );
  assert.match(
    fourth.host.output.join('\n'),
    /SPRING_DATASOURCE_URL names another database than the backup's; run backup again/,
  );

  // The rollback finds the old release where backup said install puts it.
  const fifth = await backedUp(t);
  assert.equal(
    await fifth.host.upgrade(
      'install',
      '--backup',
      fifth.target,
      '--releases',
      path.join(fifth.host.root, 'elsewhere'),
    ),
    1,
  );
  assert.match(
    fifth.host.output.join('\n'),
    /the backup expects the previous release at .*-releases\/0.1.0, not .*elsewhere\/0.1.0; pass the --releases backup had/,
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
  const preflight = host.services.at(-1);
  assert.ok(preflight.args.includes('--uid=svc'));
  // Environment= reaches it through a file, read before server.env, and
  // never through the command line any local user can read.
  assert.ok(!preflight.args.some((arg) => arg.startsWith('--setenv')));
  assert.deepEqual(
    preflight.files.map(({ file }) => path.basename(file)),
    ['unit.env', 'server.env'],
  );
  assert.equal(preflight.environment.get('PATH'), host.tools);
  assert.equal(preflight.environment.get('SPRING_DATASOURCE_PASSWORD'), 'p"w');
  assert.deepEqual(preflight.args.slice(-2), [
    path.join(host.current, 'bin/qwen-managed-agent-server'),
    '--check',
  ]);
  // The scratch directory goes with the command.
  await assert.rejects(stat(path.dirname(preflight.files[0].file)), {
    code: 'ENOENT',
  });

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
    /did not report UP at http:\/\/127.0.0.1:18080\/actuator\/health within 5s and keeps running; .* run stop to start it again/,
  );
  assert.equal(host.units[SERVER].ActiveState, 'active');
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /already runs; run verify, or run stop to start it again/,
  );

  // The release is installed, and stop still stops it.
  host.calls = [];
  assert.equal(await host.upgrade('stop'), 0);
  assert.deepEqual(
    host.calls.filter(
      ([command, verb]) => command === 'systemctl' && verb !== 'show',
    ),
    [
      ['systemctl', 'stop', SERVER],
      ['systemctl', 'stop', HARNESS],
    ],
  );
  // check keeps refusing to upgrade to what is installed.
  assert.equal(await host.check(), 1);
  assert.match(rowsOf(host.output).version, /^FAIL 0.2.0 is already installed/);

  // A unit that fails is told apart from one that is slow.
  host.responses['GET /actuator/health'] = () => {
    host.units[SERVER].ActiveState = 'failed';
    return { status: 'DOWN' };
  };
  assert.equal(await host.upgrade('start', '--timeout', '5'), 1);
  assert.match(
    host.output.join('\n'),
    /qwen-managed-agent-server failed before it reported UP at .*; see journalctl -u qwen-managed-agent-server, then run start again/,
  );
});

test('a health probe that never answers ends at the timeout', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.hang = true;
  const started = Date.now();
  assert.equal(await host.upgrade('start', '--timeout', '1'), 1);
  assert.ok(Date.now() - started < 4000, `${Date.now() - started}ms`);
  assert.match(host.output.join('\n'), /within 1s and keeps running/);
  assert.ok(host.requests.every(({ init }) => init.signal));
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

test('check reads the options the later phases are given', async (t) => {
  const host = await rig(t);
  const releases = path.join(host.root, 'qwen releases');
  assert.equal(await host.check('--releases', releases), 0);
  const plan = host.output.slice(host.output.indexOf('Plan:')).join('\n');
  const mysqldump = path.join(host.tools, 'mysqldump');
  assert.ok(plan.includes(` stop --releases '${releases}'\n`), plan);
  assert.ok(
    plan.includes(
      ` backup --to <new empty directory> --releases '${releases}' --mysqldump ${mysqldump}\n`,
    ),
    plan,
  );
  assert.ok(
    plan.includes(
      ` install --backup <that directory> --releases '${releases}'\n`,
    ),
    plan,
  );
  // The client the operator named, though it is not on PATH.
  assert.equal(
    rowsOf(host.output)['backup-tools'],
    `PASS backup dumps the database with ${mysqldump}`,
  );

  assert.equal(
    await host.upgrade('check', '--mysqldump', path.join(host.root, 'none')),
    1,
  );
  assert.match(
    rowsOf(host.output)['backup-tools'],
    /^FAIL .*none is not installed/,
  );
  assert.ok(
    host.output.includes(
      'backup refuses until the FAIL rows pass; pass them before stop. Then the plan is:',
    ),
  );
  assert.equal(await host.upgrade('check', '--skip-database'), 0);
  assert.equal(
    rowsOf(host.output)['backup-tools'],
    'SKIP backup dumps no database, as --skip-database asks',
  );
  assert.ok(
    host.output.some((line) =>
      line.endsWith(' backup --to <new empty directory> --skip-database'),
    ),
  );
});

test('backup archives the Runtime state directory the server uses', async (t) => {
  // The server's configuration names another directory than the variable.
  const host = await rig(t);
  const elsewhere = path.join(host.root, 'state-from-yaml');
  await mkdir(path.join(elsewhere, 'workers'), { recursive: true });
  await writeFile(path.join(elsewhere, 'workers/w2.json'), '{}\n');
  host.resolved = {
    runtimeStateDirectory: elsewhere,
    runtimeStateOrigin: 'URL [file:/etc/qwen/runtime.yml] - 4:24',
  };
  assert.equal(await host.check(), 0);
  assert.equal(
    rowsOf(host.output)['runtime-state'],
    `PASS backup archives ${elsewhere} (URL [file:/etc/qwen/runtime.yml] - 4:24)`,
  );
  await host.stop();
  const target = path.join(host.root, 'backup');
  const mysqldump = path.join(host.tools, 'mysqldump');
  assert.equal(
    await host.upgrade('backup', '--to', target, '--mysqldump', mysqldump),
    0,
  );
  const members = spawnSync(
    'tar',
    ['-tf', path.join(target, 'runtime-state.tar')],
    { encoding: 'utf8' },
  ).stdout;
  assert.ok(members.includes('./workers/w2.json'), members);
  assert.ok(!members.includes('./workers/w1.json'), members);
  const record = JSON.parse(
    await readFile(path.join(target, 'backup.json'), 'utf8'),
  );
  assert.equal(record.runtimeState, elsewhere);

  // A configuration the jar cannot resolve is not one with no state.
  host.resolveFailure =
    "WARNING: a JVM line\ncannot resolve the server configuration: Config data resource 'file [/etc/qwen/runtime.yml]' does not exist";
  const again = path.join(host.root, 'backup-2');
  assert.equal(
    await host.upgrade('backup', '--to', again, '--mysqldump', mysqldump),
    1,
  );
  assert.match(
    host.output.join('\n'),
    /backup refused: cannot resolve the Runtime state directory: cannot resolve the server configuration: Config data resource .*; pass --runtime-state <the directory the server uses>, or none when it keeps no Runtime state, to check and backup\./,
  );
  await assert.rejects(stat(again), { code: 'ENOENT' });
  // --runtime-state stands in for the jar, which then does not run.
  const runs = host.services.length;
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      again,
      '--mysqldump',
      mysqldump,
      '--runtime-state',
      elsewhere,
    ),
    0,
  );
  assert.equal(host.services.length, runs);
  assert.equal(
    JSON.parse(await readFile(path.join(again, 'backup.json'), 'utf8'))
      .runtimeState,
    elsewhere,
  );
});

test('check runs the server jar as the unit runs the server', async (t) => {
  const host = await rig(t);
  assert.equal(await host.check(), 0);
  assert.equal(
    rowsOf(host.output)['runtime-state'],
    `PASS backup archives ${host.state} (QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY)`,
  );
  const [service] = host.services;
  assert.ok(service.args.includes('--uid=svc'));
  assert.ok(service.args.includes(`--working-directory=${host.current}`));
  assert.ok(!service.args.some((arg) => arg.startsWith('--setenv')));
  // The launcher's default follows the unit's own files.
  const config = path.join(host.current, 'config/application.yml');
  assert.deepEqual(
    service.files.map(({ file }) => path.basename(file)),
    ['unit.env', 'server.env', 'launcher.env'],
  );
  assert.equal(
    service.environment.get('SPRING_CONFIG_ADDITIONAL_LOCATION'),
    `file:${config}`,
  );
  // This release's jar, copied where the service account can read it, with
  // the unit's java and no further argument.
  const java = service.args.indexOf(path.join(host.tools, 'java'));
  assert.deepEqual(service.args.slice(java + 1), [
    RESOLVER,
    '-cp',
    service.jar.path,
    'org.springframework.boot.loader.launch.PropertiesLauncher',
  ]);
  assert.ok(!service.jar.path.startsWith(host.distribution));
  assert.equal(service.jar.mode, 0o644);
  assert.equal(service.jar.directoryMode, 0o711);
  await assert.rejects(stat(service.jar.path), { code: 'ENOENT' });

  // An empty variable is the launcher's default too; a set one is not.
  for (const [serverEnv, expected] of [
    [['SPRING_CONFIG_ADDITIONAL_LOCATION='], 'default'],
    [
      ['SPRING_CONFIG_ADDITIONAL_LOCATION=file:/etc/qwen/extra.yml'],
      'file:/etc/qwen/extra.yml',
    ],
  ]) {
    const other = await rig(t, { serverEnv });
    assert.equal(await other.check(), 0);
    assert.equal(
      other.services[0].environment.get('SPRING_CONFIG_ADDITIONAL_LOCATION'),
      expected === 'default'
        ? `file:${path.join(other.current, 'config/application.yml')}`
        : expected,
      serverEnv[0],
    );
  }
  await rm(config);
  host.services = [];
  assert.equal(await host.check(), 0);
  assert.ok(
    !host.services[0].files.some(({ file }) => file.endsWith('launcher.env')),
  );

  // Arguments systemctl prints joined cannot be passed on faithfully.
  host.units[SERVER].ExecStart =
    `{ path=${host.current}/bin/qwen-managed-agent-server ; argv[]=${host.current}/bin/qwen-managed-agent-server --spring.profiles.active=edge ; ignore_errors=no }`;
  assert.equal(await host.check(), 1);
  assert.equal(
    rowsOf(host.output)['runtime-state'],
    `FAIL cannot resolve the Runtime state directory: ${SERVER} passes arguments to bin/qwen-managed-agent-server, which systemctl does not print exactly`,
  );
});

test('backup says when it archives no Runtime state', async (t) => {
  const host = await rig(t, { state: null });
  assert.equal(await host.check(), 0);
  assert.equal(
    rowsOf(host.output)['runtime-state'],
    "SKIP the server's configuration names no Runtime state directory, so backup archives none",
  );
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
  assert.ok(!(await readdir(target)).includes('runtime-state.tar'));
  assert.ok(
    host.output.includes(
      "No Runtime state archived: the server's configuration names no Runtime state directory, so backup archives none.",
    ),
  );

  const missing = path.join(host.root, 'gone');
  const other = await rig(t, {
    serverEnv: [`QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY=${missing}`],
  });
  assert.equal(await other.check(), 0);
  assert.equal(
    rowsOf(other.output)['runtime-state'],
    `WARN ${missing} (QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY) does not exist, so backup archives no Runtime state`,
  );
});

test('backup --skip-database runs no client', async (t) => {
  const host = await rig(t);
  await host.stop();
  const target = path.join(host.root, 'backup');
  assert.equal(
    await host.upgrade('backup', '--to', target, '--skip-database'),
    0,
  );
  assert.ok(!(await readdir(target)).includes('database.sql'));
  const record = JSON.parse(
    await readFile(path.join(target, 'backup.json'), 'utf8'),
  );
  assert.equal(record.database, 'skipped');
  assert.ok(!host.calls.some(([command]) => command === 'mysqldump'));
});

test("backup leaves out an option MariaDB's mysqldump lacks", async (t) => {
  const host = await rig(t);
  await host.stop();
  host.mysqldumpVersion = 'mysqldump  Ver 10.19 Distrib 10.11.6-MariaDB';
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      path.join(host.root, 'backup'),
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    ),
    0,
  );
  const dump = host.calls.find(
    ([command, first]) => command === 'mysqldump' && first !== '--version',
  );
  assert.ok(!dump.some((arg) => arg.startsWith('--set-gtid-purged')), dump);
});

test('check refuses a directory in the installed config', async (t) => {
  const host = await rig(t);
  await mkdir(path.join(host.current, 'config/certs'));
  assert.equal(await host.check(), 1);
  assert.equal(
    rowsOf(host.output).config,
    `FAIL ${host.current}/config holds certs, which is not a file`,
  );
});

test('check reports an incomplete extraction as a row', async (t) => {
  const host = await rig(t);
  await rm(path.join(host.distribution, 'manifest.json'));
  assert.equal(await host.check(), 1);
  assert.equal(
    rowsOf(host.output).distribution,
    'FAIL manifest.json does not match SHA256SUMS',
  );
  assert.equal(
    rowsOf(host.output).deployment,
    `FAIL ${host.distribution}/manifest.json is unreadable`,
  );
  assert.ok(
    host.output.includes(
      `${''.padEnd(21)} fix: extract the verified archive again`,
    ),
  );
  await host.stop();
  assert.equal(
    await host.upgrade('backup', '--to', path.join(host.root, 'backup')),
    1,
  );
  assert.match(
    host.output.join('\n'),
    /backup refused: .*manifest.json is unreadable; extract the verified archive again/,
  );
});

test('install uses an existing release directory only when it is this build', async (t) => {
  const { host, target } = await backedUp(t);
  const releases = `${host.current}-releases`;
  const release = path.join(releases, '0.2.0');
  // Another build of 0.2.0 that matches its own SHA256SUMS.
  await writeDistribution(release, {
    version: '0.2.0',
    files: { 'bin/qwen-managed-agent-server': '#!/bin/sh\n# another build\n' },
  });
  assert.equal(await host.upgrade('install', '--backup', target), 1);
  assert.match(
    host.output.join('\n'),
    /0.2.0 exists but is not this release; remove it and run install again/,
  );
  assert.ok((await lstat(host.current)).isDirectory());

  // The copy an interrupted install left is this build, and is used.
  await rm(release, { recursive: true });
  await cp(host.distribution, release, { recursive: true });
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  assert.ok(host.output.includes(`Using ${release}`));
  assert.equal(await readlink(host.current), release);
});

test('install leaves no partial copy, and an interrupted one is reported', async (t) => {
  const { host, target } = await backedUp(t);
  const releases = `${host.current}-releases`;
  // A copy that fails halfway: fs.cp refuses a FIFO.
  const pipe = path.join(host.distribution, 'pipe');
  if (spawnSync('mkfifo', [pipe]).status !== 0) {
    t.diagnostic('no mkfifo on this host');
    return;
  }
  await assert.rejects(host.upgrade('install', '--backup', target), {
    code: 'ERR_FS_CP_FIFO_PIPE',
  });
  assert.deepEqual(await readdir(releases), []);
  assert.ok((await lstat(host.current)).isDirectory());
  await rm(pipe);

  // A crash between moving the directory and renaming the link over it.
  await cp(host.distribution, path.join(releases, '0.2.0'), {
    recursive: true,
  });
  await rename(host.current, path.join(releases, '0.1.0'));
  const link = `${host.current}.upgrade-0000abcd`;
  await symlink(path.join(releases, '0.2.0'), link);
  assert.equal(await host.check(), 1);
  assert.equal(
    rowsOf(host.output).deployment,
    `FAIL ${host.current} is missing and ${link} is left from an interrupted install`,
  );
  assert.ok(
    host.output.some((line) =>
      line.endsWith(
        `fix: finish the install with mv -T ${link} ${host.current}, then run start`,
      ),
    ),
  );
  assert.equal(await host.upgrade('install', '--backup', target), 1);
  assert.match(
    host.output.join('\n'),
    /install refused: .*finish the install with mv -T/,
  );
});

test('--runtime-state none backs up a deployment that keeps no state', async (t) => {
  // The jar cannot resolve the configuration, and the operator knows better.
  const host = await rig(t, { state: null });
  host.resolveFailure = 'cannot resolve the server configuration: refused';
  assert.equal(await host.check(), 1);
  assert.equal(await host.check('--runtime-state', 'none'), 0);
  assert.equal(
    rowsOf(host.output)['runtime-state'],
    'SKIP backup archives no Runtime state, as --runtime-state none asks',
  );
  assert.ok(
    host.output.some((line) =>
      line.endsWith(
        ` backup --to <new empty directory> --mysqldump ${path.join(host.tools, 'mysqldump')} --runtime-state none`,
      ),
    ),
  );
  await host.stop();
  const target = path.join(host.root, 'backup');
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      target,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
      '--runtime-state',
      'none',
    ),
    0,
  );
  assert.ok(!(await readdir(target)).includes('runtime-state.tar'));
  assert.equal(
    JSON.parse(await readFile(path.join(target, 'backup.json'), 'utf8'))
      .runtimeState,
    null,
  );
});

test('stop counts the workers in either cgroup hierarchy and refuses an unreadable one', async (t) => {
  // cgroup v1 and the hybrid layout: systemd's named hierarchy.
  const host = await rig(t);
  host.cgroupLayout = 'v1';
  await host.system.sleep(0);
  host.workersIgnoreTerm = true;
  assert.equal(await host.upgrade('stop', '--timeout', '2'), 1);
  assert.match(
    host.output.join('\n'),
    /Runtime workers still run after 2s \(PID 11\)/,
  );

  // A procs file that cannot be read is no proof that nothing runs.
  const other = await rig(t);
  const procs = path.join(
    other.root,
    'cgroup/system.slice',
    `${SERVER}.service`,
    'cgroup.procs',
  );
  other.system.sleep = async () => {
    other.clock += 1;
  };
  await rm(procs);
  await mkdir(procs);
  assert.equal(await other.upgrade('stop'), 1);
  assert.equal(
    other.output.at(-1),
    `stop refused: cannot read ${procs} (EISDIR), so the Runtime workers of ${SERVER} cannot be counted.`,
  );
  assert.equal(other.units[HARNESS].ActiveState, 'active');

  // A cgroup that systemd is removing after the kill answers ENODEV.
  const dying = await rig(t);
  const kill = dying.system.run;
  dying.system.run = (command, args, options) => {
    const result = kill(command, args, options);
    if (command === 'systemctl' && args[0] === 'kill') {
      dying.cgroupError = 'ENODEV';
    }
    return result;
  };
  assert.equal(await dying.upgrade('stop'), 0);
  assert.equal(dying.units[HARNESS].ActiveState, 'inactive');
  // Any other error is no proof that a worker that outlived stop is gone.
  dying.units[SERVER].procs = ['12'];
  await dying.system.sleep(0);
  dying.cgroupError = 'EACCES';
  assert.equal(
    await dying.upgrade('backup', '--to', path.join(dying.root, 'b')),
    1,
  );
  assert.match(dying.output.at(-1), /cannot read .*cgroup\.procs \(EACCES\)/);

  const bare = await rig(t);
  bare.system.sleep = async () => {
    bare.clock += 1;
  };
  await rm(path.join(bare.root, 'cgroup'), { recursive: true });
  await mkdir(path.join(bare.root, 'cgroup'));
  assert.equal(await bare.upgrade('stop'), 1);
  assert.match(
    bare.output.at(-1),
    /holds neither the unified cgroup hierarchy nor systemd's/,
  );
  assert.equal(bare.units[HARNESS].ActiveState, 'active');
});

test('stop says why the control plane shows as failed', async (t) => {
  const host = await rig(t);
  host.stopFails = true;
  assert.equal(await host.upgrade('stop'), 0);
  assert.equal(
    host.output.at(-1),
    `${SERVER} shows as failed: its unit counts the exit status 143 of a stopped JVM as a failure. This release's unit template adds SuccessExitStatus=143; carry it over before start, then systemctl reset-failed ${SERVER} clears the state.`,
  );
  // Any other failure points at the journal.
  const other = await rig(t);
  other.stopFails = true;
  const stop = other.system.run;
  other.system.run = (command, args, options) => {
    const result = stop(command, args, options);
    if (command === 'systemctl' && args[0] === 'stop') {
      other.units[SERVER].ExecMainStatus = '1';
    }
    return result;
  };
  assert.equal(await other.upgrade('stop'), 0);
  assert.equal(
    other.output.at(-1),
    `${SERVER} shows as failed (exit-code, status 1); see journalctl -u ${SERVER}. start runs it again.`,
  );
});

test('check refuses a new script Flyway would not run', async (t) => {
  const installedScripts = {
    'db/migration/V1__managed_schema.sql': 'CREATE TABLE a (id INT);\n',
    'db/migration/V2__more.sql': 'CREATE TABLE b (id INT);\n',
  };
  for (const [added, expected] of [
    [
      'V1.5__backport.sql',
      /^FAIL this release adds V1.5__backport.sql, which does not sort after V2__more.sql, the newest script the installed database ran, so Flyway refuses it/,
    ],
    [
      'V2__again.sql',
      /^FAIL this release adds V2__again.sql, which does not sort after V2__more.sql/,
    ],
    ['V1_10__later.sql', /^FAIL this release adds V1_10__later.sql/],
    [
      'V3__later.sql',
      /^WARN start applies V3__later.sql; only the database backup undoes it/,
    ],
    ['V2_1__later.sql', /^WARN start applies V2_1__later.sql/],
  ]) {
    const host = await rig(t, {
      installedScripts,
      scripts: {
        ...installedScripts,
        [`db/migration/${added}`]: 'SELECT 1;\n',
      },
    });
    assert.equal(
      await host.check(),
      expected.source.startsWith('^FAIL') ? 1 : 0,
      added,
    );
    assert.match(rowsOf(host.output).database, expected, added);
  }
});

test('verify bounds every request and retries a poll the restart failed', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  host.responses['GET /v1/agents/sessions'] = { data: [{ id: 's1' }] };
  host.responses['GET /v1/agents/sessions/s1'] = { id: 's1' };
  host.responses['GET /v1/agents/sessions/s1/items'] = { data: [] };
  host.responses['POST /v1/agents/sessions'] = { id: 's2' };
  // A Harness that reconnects answers 503 once.
  const fetch = host.system.fetch;
  let polls = 0;
  host.system.fetch = async (url, init) => {
    if (url.includes('/events')) {
      polls += 1;
      if (polls === 1) {
        host.requests.push({ url, init });
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({ error: { message: 'dependency_unavailable' } }),
        };
      }
      host.responses['GET /v1/agents/sessions/s2/events'] = {
        data: [{ sequence: 1, type: 'turn.completed', terminal: true }],
      };
    }
    return fetch(url, init);
  };
  host.requests = [];
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 0);
  assert.match(
    rowsOf(host.output).turn,
    /^PASS Session s2 ended with turn.completed/,
  );
  assert.equal(polls, 2);
  assert.ok(host.requests.length > 0);
  assert.ok(
    host.requests.every(({ init }) => init.signal),
    'every request is bounded',
  );

  // A 4xx is an answer, not a blip.
  host.system.fetch = fetch;
  delete host.responses['GET /v1/agents/sessions/s2/events'];
  const polled = host.requests.length;
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 1);
  assert.match(
    rowsOf(host.output).turn,
    /^FAIL Session s2: GET .*events.*: 404 missing/,
  );
  assert.equal(
    host.requests.slice(polled).filter(({ url }) => url.includes('/events'))
      .length,
    1,
  );

  // A poll that keeps failing ends at --timeout and names the last failure.
  host.system.fetch = async (url, init) =>
    url.includes('/events')
      ? {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({ error: { message: 'dependency_unavailable' } }),
        }
      : fetch(url, init);
  assert.equal(
    await host.upgrade(
      'verify',
      '--tenant',
      'acme',
      '--turn',
      '--timeout',
      '3',
    ),
    1,
  );
  assert.equal(
    rowsOf(host.output).turn,
    'FAIL Session s2: no terminal event within 3s; the last poll failed: GET /v1/agents/sessions/s2/events?after=0&limit=100: 503 dependency_unavailable',
  );
  host.system.fetch = fetch;

  // A control plane that accepts and never answers ends at --timeout.
  host.hang = true;
  const started = Date.now();
  assert.equal(
    await host.upgrade(
      'verify',
      '--tenant',
      'acme',
      '--turn',
      '--timeout',
      '1',
    ),
    1,
  );
  assert.ok(Date.now() - started < 8000, `${Date.now() - started}ms`);
  const rows = rowsOf(host.output);
  assert.match(rows.health, /^FAIL/);
  assert.match(
    rows.session,
    /^FAIL GET \/v1\/agents\/sessions\?limit=1: .*timeout/i,
  );
});

test('verify waits the whole budget for a slow health answer', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  // Longer than one probe of start's loop may take.
  const fetch = host.system.fetch;
  host.system.fetch = async (url, init) => {
    if (url.endsWith('/actuator/health')) {
      await new Promise((resolve) => setTimeout(resolve, 5300));
      init.signal.throwIfAborted();
    }
    return fetch(url, init);
  };
  assert.equal(await host.upgrade('verify', '--timeout', '30'), 0);
  assert.match(rowsOf(host.output).health, /^PASS/);
});

test('verify reads Sessions as the actor it is given', async (t) => {
  const { host, target } = await backedUp(t, {
    serverEnv: ['QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER=X-Actor'],
  });
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  // Without an actor the API lists Sessions outside Workspaces only.
  host.responses['GET /v1/agents/sessions'] = (search, init) =>
    init.headers['X-Actor'] === 'alice'
      ? { data: [{ id: 'w1' }] }
      : { data: [] };
  host.responses['GET /v1/agents/sessions/w1'] = { id: 'w1' };
  host.responses['GET /v1/agents/sessions/w1/items'] = { data: [{}] };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 0);
  assert.deepEqual(
    [
      rowsOf(host.output).session,
      host.output.find((line) => line.includes('fix: pass --actor'))?.trim(),
    ],
    [
      'WARN tenant acme has no Session that a request without an actor reads',
      'fix: pass --actor <id> to read Workspace Sessions as one of their readers',
    ],
  );
  assert.equal(
    await host.upgrade('verify', '--tenant', 'acme', '--actor', 'alice'),
    0,
  );
  assert.equal(
    rowsOf(host.output).session,
    'PASS read Session w1 and 1 item(s)',
  );
  assert.ok(
    host.requests
      .filter(({ url }) => url.includes('/w1'))
      .every(({ init }) => init.headers['X-Actor'] === 'alice'),
  );
  assert.equal(await host.upgrade('verify', '--actor', 'alice'), 2);

  // A server that names no actor header takes none.
  host.resolved = { trustedActorHeader: '' };
  assert.equal(
    await host.upgrade('verify', '--tenant', 'acme', '--actor', 'alice'),
    1,
  );
  assert.match(
    rowsOf(host.output).session,
    /^FAIL --actor needs a trusted actor header/,
  );
});

test('verify takes the auth mode from the configuration the server resolves', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  // signed in a configuration file, which no variable shows.
  host.resolved = { authMode: 'signed' };
  host.services = [];
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 0);
  assert.match(
    rowsOf(host.output).session,
    /^SKIP the API takes signed requests only/,
  );
  assert.ok(!host.requests.some(({ url }) => url.includes('/v1/')));
  // The installed release is this one, so its own jar runs in place.
  const resolver = host.services.find(({ args }) => args.includes(RESOLVER));
  assert.equal(
    resolver.jar.path,
    path.join(
      await realpath(path.join(`${host.current}-releases`, '0.2.0')),
      'lib/server.jar',
    ),
  );
  host.resolveFailure = 'cannot resolve the server configuration: refused';
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 0);
  assert.equal(
    rowsOf(host.output).session,
    "SKIP cannot resolve the API's auth mode: cannot resolve the server configuration: refused",
  );
  assert.ok(!host.requests.some(({ url }) => url.includes('/v1/')));
});

test('verify fails a read whose body breaks off after a success status', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  host.responses['GET /v1/agents/sessions'] = { data: [{ id: 's1' }] };
  host.responses['GET /v1/agents/sessions/s1'] = { id: 's1' };
  host.responses['GET /v1/agents/sessions/s1/items'] = { data: [{}] };
  host.responses['POST /v1/agents/sessions'] = { id: 's2' };
  host.responses['GET /v1/agents/sessions/s2/events'] = {
    data: [{ sequence: 1, type: 'turn.completed', terminal: true }],
  };
  // The headers arrive with 200, then the body is cut off.
  const fetch = host.system.fetch;
  let breaks = 0;
  const breakOff = (part, times = Infinity) => {
    breaks = 0;
    host.system.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!url.includes(part) || breaks >= times) {
        return response;
      }
      breaks += 1;
      return {
        ...response,
        json: async () => {
          throw Object.assign(new Error('This operation was aborted'), {
            name: 'AbortError',
          });
        },
      };
    };
  };
  breakOff('/items');
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  assert.equal(
    rowsOf(host.output).session,
    'FAIL GET /v1/agents/sessions/s1/items?limit=20: 200 with an unreadable body (This operation was aborted)',
  );
  // A listing that breaks off is a failed read, not a tenant without Sessions.
  breakOff('/v1/agents/sessions?limit=1');
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  assert.match(
    rowsOf(host.output).session,
    /^FAIL GET \/v1\/agents\/sessions\?limit=1: 200 with an unreadable body/,
  );
  // A poll whose body breaks off once is polled again.
  breakOff('/events', 1);
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 0);
  assert.match(
    rowsOf(host.output).turn,
    /^PASS Session s2 ended with turn.completed/,
  );
  assert.equal(breaks, 1);
});
