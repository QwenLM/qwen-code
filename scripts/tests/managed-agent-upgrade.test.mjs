/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, statSync, writeFileSync, writeSync } from 'node:fs';
import fsPromises, {
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
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
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
  fetchRefusal,
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
  withoutCredentials,
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

test('refuses only the URLs fetch refuses', async () => {
  for (const url of [
    'http://127.0.0.1:8080',
    'https://[::1]:8443/manage',
    'HTTP://Example.test',
    'http://127.0.0.1:80',
    'http://127.0.0.1:4170',
  ]) {
    assert.equal(fetchRefusal(url), undefined, url);
  }
  assert.equal(
    fetchRefusal('http://[fe80::1%eth0]:8080'),
    'is not a URL: a URL cannot carry an IPv6 zone',
  );
  assert.equal(fetchRefusal('http://127.0.0.1:70000'), 'is not a URL');
  // A percent outside the brackets is no zone.
  assert.equal(fetchRefusal('http://127.0.0.1:70000/%'), 'is not a URL');
  assert.equal(fetchRefusal('proxy.test:8443'), 'is not an http or https URL');
  for (const url of [
    'http://admin@127.0.0.1:8080',
    'http://:secret@127.0.0.1:8080',
  ]) {
    assert.equal(
      fetchRefusal(url),
      'carries a user name or password, so fetch refuses it',
      url,
    );
  }
  assert.equal(
    fetchRefusal('https://127.0.0.1:6000'),
    'is on port 6000, so fetch refuses to dial it',
  );
  // A refusal prints the URL with its user information masked, whether or
  // not it parses, and a URL without any comes back as it was.
  for (const [url, shown] of [
    ['http://admin:secret@127.0.0.1:18080', 'http://***@127.0.0.1:18080/'],
    ['http://:secret@127.0.0.1:8080/x', 'http://***@127.0.0.1:8080/x'],
    ['http://a:p%40ss@[::1]:1', 'http://***@[::1]:1/'],
    // A token in the user-name position, as a personal access token goes.
    [
      'https://ghp_abc123@cp.example.com:8443',
      'https://***@cp.example.com:8443/',
    ],
    // Values the parser rejects, or reads without an authority.
    ['http://admin:secret@127.0.0.1:70000', 'http://***@127.0.0.1:70000'],
    [
      'http://admin:s3cret@[fe80::1%eth0]:8080',
      'http://***@[fe80::1%eth0]:8080',
    ],
    ['ops:secret@127.0.0.1:8080', 'ops:***@127.0.0.1:8080'],
    ['ghp_abc123@127.0.0.1:8080', '***@127.0.0.1:8080'],
    // A password with a / ? or # ends the authority early, so the value does
    // not parse, and nor does one without a scheme: all up to the last @ goes.
    [
      'https://svc:Pa?ss@cp.example.com:8443',
      'https://***@cp.example.com:8443',
    ],
    [
      'https://svc:Pa/ss@cp.example.com:8443',
      'https://***@cp.example.com:8443',
    ],
    [
      'https://svc:s3#ret@cp.example.com:8443',
      'https://***@cp.example.com:8443',
    ],
    ['//svc:s3cret@cp.example.com:8443', '//***@cp.example.com:8443'],
    ['http://a:b@c@127.0.0.1:70000/x', 'http://***@127.0.0.1:70000/x'],
    // A password that starts with digits does parse, as a port, with the
    // rest of it in the path, the query or the fragment.
    [
      'http://svc:2024#s3cret@harness.internal:4170',
      'http://***@harness.internal:4170',
    ],
    [
      'https://svc:12/s3cret@cp.example.com:8443',
      'https://***@cp.example.com:8443',
    ],
    [
      'http://svc:2024?s3cret@cp.example.com:8443/x',
      'http://***@cp.example.com:8443/x',
    ],
    // So an @ anywhere hides all before it, an empty user name's too.
    ['http://@127.0.0.1:4170', 'http://***@127.0.0.1:4170'],
    ['http://127.0.0.1:8080/a@b?c=d@e', 'http://***@e'],
    ['http://127.0.0.1:6000', 'http://127.0.0.1:6000'],
    ['proxy.test:8443', 'proxy.test:8443'],
    ['http://[fe80::1%eth0]:8080', 'http://[fe80::1%eth0]:8080'],
  ]) {
    assert.equal(withoutCredentials(url), shown, url);
  }

  // Each URL it refuses, the runtime's fetch rejects before it dials: a port
  // it blocks, a scheme it does not fetch, or credentials.
  const refused = [
    'proxy.test:8443',
    'ftp://127.0.0.1:2121',
    'http://admin:secret@127.0.0.1:18080',
    'http://:secret@127.0.0.1:18080',
  ];
  for (let port = 1; port <= 65535; port++) {
    if (fetchRefusal(`http://127.0.0.1:${port}`)) {
      refused.push(`http://127.0.0.1:${port}`);
    }
  }
  assert.equal(refused.length, 4 + 82);
  for (const url of refused) {
    await assert.rejects(
      fetch(`${url}/actuator/health`, { signal: AbortSignal.timeout(1000) }),
      (error) =>
        error instanceof TypeError &&
        (/credentials/.test(error.message) ||
          ['bad port', 'unknown scheme'].includes(error.cause?.message)),
      url,
    );
  }
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
  // An entry may name its method, and carry an extra field in its local
  // header only, as archivers that add timestamps or alignment do.
  for (const [index, [name, text, forced, extra = '']] of entries.entries()) {
    const data = Buffer.from(text);
    // Alternate the two methods a jar uses, unless the entry names one.
    const method = forced ?? (index % 2 === 0 ? 8 : 0);
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const extraBytes = Buffer.from(extra);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extraBytes.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, extraBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + extraBytes.length + body.length;
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

// A jar whose scripts live in the nested jar of a module, stored as Spring
// Boot stores one, as the server ships them since its split into modules.
function moduleJar(scripts) {
  return zip([
    ['BOOT-INF/classes/application.yml', 'server: {}\n'],
    ['BOOT-INF/lib/qwencode-sdk.jar', zip([['A.class', 'x']]), 0],
    [
      'BOOT-INF/lib/qwen-managed-agent-persistence.jar',
      zip(Object.entries(scripts)),
      0,
    ],
  ]);
}

async function writeDistribution(
  root,
  { version, scripts = BASELINE, files = {}, nested = false },
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
    'lib/server.jar': nested
      ? moduleJar(scripts)
      : zip([
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
    nested: overrides.installedNested,
  });
  await writeFile(path.join(current, 'config/application.yml'), 'key: x\n', {
    mode: 0o600,
  });
  await writeDistribution(distribution, {
    version: overrides.version ?? '0.2.0',
    scripts: overrides.scripts,
    files: overrides.files,
    nested: overrides.nested,
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
    // Every host:port a start waited on.
    connections: [],
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
      unit.SubState = unit.ActiveState === 'failed' ? 'failed' : 'dead';
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
    } else if (verb === 'start' || verb === 'restart') {
      Object.assign(unit, {
        ActiveState: 'active',
        SubState: 'running',
        // systemd 257 resets the counter on a manual stop and start.
        NRestarts: host.keepRestarts ? (unit.NRestarts ?? '0') : '0',
      });
      unit.ActiveEnterTimestampMonotonic = String(1000 + host.clock);
      unit.procs = ['30'];
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const system = {
    uid: () => 0,
    euid: () => host.euid ?? process.geteuid(),
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
    connect: async (address, port) => {
      host.connections.push(`${address}:${port}`);
      return true;
    },
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
      // A function may answer later, and reject as fetch does.
      const body =
        typeof response === 'function'
          ? await response(search, init)
          : response;
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
        host.dumpEnvironment = options.env;
        writeSync(options.stdio[1], '-- dump\n');
        host.onDump?.();
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
        host.onService?.(service);
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
          serverUrl: serverBaseUrl(environment),
          healthUrl: `${serverBaseUrl(environment)}/actuator/health`,
          harnessBaseUrl:
            environment.get('QWEN_MANAGED_AGENT_HARNESS_BASE_URL') ??
            'http://127.0.0.1:4170',
          harnessOrigin: 'true',
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
    // The handler the real system runs on SIGINT, SIGTERM or SIGHUP.
    onSignal: (cleanup) => {
      host.signal = cleanup;
      return () => {
        host.signal = undefined;
      };
    },
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

function readdirSyncSorted(directory) {
  return spawnSync('ls', ['-A', directory], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .sort();
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

test('reads the Flyway scripts out of the nested jar of a module', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-upgrade-jar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jar = path.join(root, 'server.jar');
  const module = zip([
    ['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n'],
    ['db/managed-schema/V2__more.sql', 'create table b;\n'],
    ['db/managed-schema/V3__upper.SQL', 'insert;\n'],
    ['db/managed-schema/README.md', 'not a script'],
    // Only the nested jar's root is on the classpath.
    ['BOOT-INF/classes/db/managed-schema/V8__deep.sql', 'ignored'],
  ]);
  await writeFile(
    jar,
    zip([
      ['BOOT-INF/classes/db/managed-schema/V1__base.sql', 'create table a;\n'],
      ['BOOT-INF/lib/qwen-managed-agent-persistence.jar', module, 0],
      ['BOOT-INF/lib/library.jar', zip([['org/A.class', 'x']]), 0],
      // Spring Boot loads no compressed nested jar, and nothing elsewhere.
      [
        'BOOT-INF/lib/deflated.jar',
        zip([['db/managed-schema/V9__deflated.sql', 'ignored']]),
        8,
      ],
      ['lib/other.jar', zip([['db/managed-schema/V10__x.sql', 'ignored']]), 0],
    ]),
  );
  assert.deepEqual(Object.fromEntries(await migrationScripts(jar)), {
    'db/managed-schema/V1__base.sql': sha256('create table a;\n'),
    'db/managed-schema/V2__more.sql': sha256('create table b;\n'),
    'db/managed-schema/V3__upper.SQL': sha256('insert;\n'),
  });

  // A local header may carry an extra field the central directory does not:
  // each entry's data, and a nested jar's start, lie past it.
  const pad = 'UT\u0005\u0000\u0001abcd';
  await writeFile(
    jar,
    zip([
      [
        'BOOT-INF/classes/db/managed-schema/V1__base.sql',
        'create table a;\n',
        8,
        pad,
      ],
      [
        'BOOT-INF/lib/qwen-managed-agent-persistence.jar',
        zip([
          ['db/managed-schema/V2__more.sql', 'create table b;\n', 0, pad],
          ['db/managed-schema/V3__more.sql', 'create table c;\n', 8, pad],
        ]),
        0,
        pad,
      ],
    ]),
  );
  assert.deepEqual(Object.fromEntries(await migrationScripts(jar)), {
    'db/managed-schema/V1__base.sql': sha256('create table a;\n'),
    'db/managed-schema/V2__more.sql': sha256('create table b;\n'),
    'db/managed-schema/V3__more.sql': sha256('create table c;\n'),
  });

  // One path shipped twice is one script when the copies match, and a
  // misread when they do not.
  const twice = (text) =>
    zip([
      ['BOOT-INF/classes/db/managed-schema/V1__base.sql', 'create table a;\n'],
      [
        'BOOT-INF/lib/qwen-managed-agent-persistence.jar',
        zip([['db/managed-schema/V1__base.sql', text]]),
        0,
      ],
    ]);
  await writeFile(jar, twice('create table a;\n'));
  assert.deepEqual(Object.fromEntries(await migrationScripts(jar)), {
    'db/managed-schema/V1__base.sql': sha256('create table a;\n'),
  });
  await writeFile(jar, twice('create table b;\n'));
  await assert.rejects(
    migrationScripts(jar),
    /^Error: .*server\.jar ships two different copies of db\/managed-schema\/V1__base\.sql, in BOOT-INF\/classes and in BOOT-INF\/lib\/qwen-managed-agent-persistence\.jar$/,
  );
  // The same holds for modules, and the error names the module that shipped
  // the path first, past a matching copy in another.
  const inModules = (text) =>
    zip([
      [
        'BOOT-INF/lib/qwen-managed-agent-persistence.jar',
        zip([['db/managed-schema/V1__base.sql', 'create table a;\n']]),
        0,
      ],
      [
        'BOOT-INF/lib/library.jar',
        zip([
          ['org/A.class', 'x'],
          ['db/managed-schema/V1__base.sql', 'create table a;\n'],
        ]),
        0,
      ],
      [
        'BOOT-INF/lib/qwen-managed-agent-adapters.jar',
        zip([
          ['db/managed-schema/V2__more.sql', 'create table b;\n'],
          ['db/managed-schema/V1__base.sql', text, 8],
        ]),
        0,
      ],
    ]);
  await writeFile(jar, inModules('create table a;\n'));
  assert.deepEqual(Object.fromEntries(await migrationScripts(jar)), {
    'db/managed-schema/V1__base.sql': sha256('create table a;\n'),
    'db/managed-schema/V2__more.sql': sha256('create table b;\n'),
  });
  await writeFile(jar, inModules('create table c;\n'));
  await assert.rejects(
    migrationScripts(jar),
    /^Error: .*server\.jar ships two different copies of db\/managed-schema\/V1__base\.sql, in BOOT-INF\/lib\/qwen-managed-agent-persistence\.jar and in BOOT-INF\/lib\/qwen-managed-agent-adapters\.jar$/,
  );

  // A nested jar that is none, or whose directory runs past its end, is a
  // misread, not a module without scripts.
  await writeFile(jar, zip([['BOOT-INF/lib/broken.jar', 'not a jar', 0]]));
  await assert.rejects(
    migrationScripts(jar),
    /^Error: BOOT-INF\/lib\/broken\.jar in .*server\.jar is not a zip archive$/,
  );
  const past = Buffer.from(module);
  past.writeUInt32LE(past.length, past.length - 22 + 16);
  await writeFile(
    jar,
    zip([['BOOT-INF/lib/qwen-managed-agent-persistence.jar', past, 0]]),
  );
  await assert.rejects(
    migrationScripts(jar),
    /^Error: BOOT-INF\/lib\/qwen-managed-agent-persistence\.jar in .*server\.jar ends early$/,
  );
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

test('check does not tell a newer Harness to go back', async (t) => {
  const host = await rig(t);
  host.qwen = '1.2.10';
  assert.equal(await host.check(), 0);
  assert.match(
    rowsOf(host.output)['qwen-code'],
    /^WARN .* is 1\.2\.10, newer than the 1\.2\.3 this release is built for$/,
  );
  assert.ok(
    host.output.some((line) =>
      line.endsWith(
        'Keep Qwen Code 1.2.10 for the Harness only if you have tested it with this release; otherwise, after stop, install 1.2.3 (manual).',
      ),
    ),
  );
  // An older one, or one that names no version, gets the release's.
  for (const qwen of ['1.2.3-rc.1', 'a local build']) {
    host.qwen = qwen;
    assert.equal(await host.check(), 0);
    assert.match(
      rowsOf(host.output)['qwen-code'],
      new RegExp(`^WARN .* is ${qwen}; this release is built for 1\\.2\\.3$`),
    );
    assert.ok(
      host.output.some((line) =>
        line.endsWith(
          'After stop, install Qwen Code 1.2.3 for the Harness (manual).',
        ),
      ),
    );
  }
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
    // Since the server's split into modules its scripts ship in the nested
    // jar of one: moved there unchanged, they are the scripts the database ran.
    [
      { nested: true },
      'database',
      /^PASS the 1 Flyway script\(s\) did not change$/,
    ],
    [
      {
        installedNested: true,
        nested: true,
        scripts: { ...BASELINE, 'db/managed-schema/V2__more.sql': 'b;\n' },
      },
      'database',
      /^WARN start applies V2__more.sql; only the database backup undoes it/,
    ],
    [
      {
        installedNested: true,
        nested: true,
        scripts: { 'db/managed-schema/V1__managed_schema.sql': 'changed;\n' },
      },
      'database',
      /^FAIL this release changed or removed V1__managed_schema.sql/,
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
  // Only the option file it wrote: root's ~/.my.cnf would come after it.
  assert.ok(dump[1].startsWith('--defaults-file='));
  assert.equal(
    path.dirname(host.dumpEnvironment.MYSQL_TEST_LOGIN_FILE),
    path.dirname(host.dumpCredentialsFile),
  );
  assert.equal(host.dumpEnvironment.PATH, process.env.PATH);
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

test('a signal during backup removes what a failure would', async (t) => {
  const host = await rig(t);
  await host.stop();
  const backup = (to) =>
    host.upgrade(
      'backup',
      '--to',
      to,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    );
  for (const made of [false, true]) {
    const to = path.join(host.root, made ? 'made' : 'fresh');
    if (made) {
      await mkdir(to);
    }
    let seen;
    // What the real handler does before the process exits as the signal
    // would have, skipping every finally block. In a given directory the
    // first file it removes cannot go, which must not keep the option file.
    const database = path.join(to, 'database.sql');
    const { rmSync: original } = fs;
    t.after(() => {
      fs.rmSync = original;
      syncBuiltinESMExports();
    });
    host.onDump = () => {
      fs.rmSync = (file, options) => {
        if (made && file === database) {
          throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' });
        }
        return original(file, options);
      };
      syncBuiltinESMExports();
      host.signal('SIGTERM');
      fs.rmSync = original;
      syncBuiltinESMExports();
      seen = {
        credentials: existsSync(path.dirname(host.dumpCredentialsFile)),
        to: existsSync(to) && readdirSyncSorted(to),
      };
      host.mysqldumpStatus = 1;
    };
    t.after(() => {
      host.onDump = undefined;
      host.mysqldumpStatus = 0;
    });
    assert.equal(await backup(to), 1);
    assert.ok(host.output.includes('backup stopped by SIGTERM'));
    assert.deepEqual(
      host.output.filter((line) => line.includes(' is left: ')),
      made ? [`${database} is left: EBUSY: injected`] : [],
    );
    assert.deepEqual(seen, {
      credentials: false,
      // A directory the backup made goes; one it was given stays, empty
      // but for the file that could not go.
      to: made ? ['database.sql'] : false,
    });
    assert.equal(host.signal, undefined);
    host.onDump = undefined;
    host.mysqldumpStatus = 0;
  }
});

test('a signal removes the scratch files and the partial copy', async (t) => {
  const { host, target } = await backedUp(t);
  // The environment files a resolver run reads, Environment= secrets among them.
  // Checked before the throw, since the real process exits without running
  // the finally blocks that would remove it too.
  let scratch;
  let left;
  host.onService = (service) => {
    scratch = path.dirname(service.files[0].file);
    host.onService = undefined;
    host.signal('SIGINT');
    left = existsSync(scratch);
    throw new Error('the process has exited');
  };
  await assert.rejects(host.check(), { message: 'the process has exited' });
  assert.ok(host.output.includes('check stopped by SIGINT'));
  assert.equal(left, false, scratch);

  // A copy of the release that a signal ends halfway.
  const { cp: original } = fsPromises;
  t.after(() => {
    fsPromises.cp = original;
    syncBuiltinESMExports();
  });
  let partial;
  let copied;
  fsPromises.cp = async (from, to, options) => {
    await original(from, to, options);
    partial = to;
    host.signal('SIGTERM');
    copied = existsSync(partial);
    throw new Error('the process has exited');
  };
  syncBuiltinESMExports();
  await assert.rejects(host.upgrade('install', '--backup', target), {
    message: 'the process has exited',
  });
  assert.ok(host.output.includes('install stopped by SIGTERM'));
  assert.match(path.basename(partial), /^\.0\.2\.0\.partial-[0-9a-f]{8}$/);
  assert.equal(copied, false);
});

test('backup refuses a directory another account owns', async (t) => {
  const host = await rig(t);
  await host.stop();
  const to = path.join(host.root, 'shared');
  await mkdir(to);
  const backup = () =>
    host.upgrade(
      'backup',
      '--to',
      to,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    );
  const owner = (await stat(to)).uid;
  host.euid = owner + 1;
  assert.equal(await backup(), 1);
  assert.equal(
    host.output.at(-1),
    `backup refused: ${to} belongs to uid ${owner}, not to this account; choose a new directory.`,
  );
  assert.deepEqual(await readdir(to), []);
  host.euid = undefined;
  assert.equal(await backup(), 0);
});

test('backup archives what a linked configuration file names', async (t) => {
  const host = await rig(t);
  await host.stop();
  const env = path.join(host.root, 'etc/server.env');
  const secrets = path.join(host.root, 'secrets');
  await mkdir(secrets);
  await rename(env, path.join(secrets, 'server.env'));
  await symlink(path.join(secrets, 'server.env'), env);
  const to = path.join(host.root, 'backup');
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      to,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    ),
    0,
  );
  const listed = spawnSync(
    'tar',
    ['-tvf', path.join(to, 'configuration.tar')],
    {
      encoding: 'utf8',
    },
  ).stdout;
  const named = (file) =>
    listed
      .split('\n')
      .find(
        (line) =>
          line.endsWith(` ${file.slice(1)}`) ||
          line.includes(` ${file.slice(1)} -> `),
      );
  assert.match(named(env), /^l/);
  const real = path.join(await realpath(secrets), 'server.env');
  assert.match(named(real), /^-/);
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

async function modesOf(root, names) {
  return Promise.all(
    names.map(async (name) => (await stat(path.join(root, name))).mode & 0o777),
  );
}

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
  // A directory only root reads, and a file no release lists, such as one an
  // operator put there, which keeps its mode.
  await chmod(path.join(host.distribution, 'lib'), 0o700);
  await chmod(
    path.join(host.distribution, 'bin/qwen-managed-agent-server'),
    0o700,
  );
  await writeFile(path.join(host.distribution, 'config/extra.yml'), 'k: v\n', {
    mode: 0o600,
  });
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
  // The service account reads the copy of what root extracted 0600.
  assert.equal(
    (await stat(path.join(releases, '0.2.0/lib/server.jar'))).mode & 0o777,
    0o644,
  );
  assert.equal(
    (await stat(path.join(releases, '0.2.0/lib'))).mode & 0o777,
    0o755,
  );
  assert.equal(
    (await stat(path.join(releases, '0.2.0/bin/qwen-managed-agent-server')))
      .mode & 0o777,
    0o755,
  );
  assert.equal(
    (await stat(path.join(releases, '0.2.0/config/extra.yml'))).mode & 0o777,
    0o600,
  );

  // A second run, as after an interrupted session, finds the release
  // installed and points at start, not at another backup.
  assert.equal(await host.upgrade('install', '--backup', target), 1);
  assert.equal(
    host.output.at(-1),
    `install refused: 0.2.0 is already installed at ${host.current}; run start or verify for this release.`,
  );
  // Nor would a backup now be of the release to roll back to.
  const late = path.join(host.root, 'late');
  assert.equal(
    await host.upgrade(
      'backup',
      '--to',
      late,
      '--mysqldump',
      path.join(host.tools, 'mysqldump'),
    ),
    1,
  );
  assert.equal(
    host.output.at(-1),
    `backup refused: 0.2.0 is already installed at ${host.current}; roll back with the backup install was given.`,
  );
  await assert.rejects(stat(late), { code: 'ENOENT' });
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
  host.calls = [];
  assert.equal(await host.upgrade('start'), 0);
  assert.equal(host.units[SERVER].ActiveState, 'active');
  // The Harness the failed preflight left running reads what was fixed.
  assert.deepEqual(
    host.calls.filter(
      ([command, verb]) => command === 'systemctl' && verb !== 'show',
    ),
    [
      ['systemctl', 'restart', HARNESS],
      ['systemctl', 'start', SERVER],
    ],
  );
  assert.ok(
    host.output.includes(
      `Restarting ${HARNESS}, which an earlier start left running`,
    ),
  );
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
    /did not report UP at http:\/\/127.0.0.1:18080\/actuator\/health within 5s \(the last answer: HTTP 200, status DOWN\) and keeps running; .* run stop to start it again/,
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
    /qwen-managed-agent-server exited before it reported UP at .*, and is stopped now; see journalctl -u qwen-managed-agent-server, then run start again/,
  );

  // The shipped units restart a server that exits, so it never shows as
  // failed: waiting to run again, or already run again.
  for (const exited of [
    { ActiveState: 'activating', SubState: 'auto-restart' },
    { ActiveState: 'active', SubState: 'running', NRestarts: '1' },
  ]) {
    host.responses['GET /actuator/health'] = () => {
      Object.assign(host.units[SERVER], exited);
      return { status: 'DOWN' };
    };
    const before = host.clock;
    host.calls = [];
    assert.equal(await host.upgrade('start', '--timeout', '300'), 1);
    assert.match(
      host.output.at(-1),
      /exited before it reported UP at .*, and is stopped now/,
    );
    assert.ok(host.clock - before < 60, `${host.clock - before}s`);
    assert.ok(
      host.calls.some(
        ([command, verb, unit]) =>
          command === 'systemctl' && verb === 'stop' && unit === SERVER,
      ),
    );
    assert.equal(host.units[SERVER].ActiveState, 'inactive');
  }

  // One exit is enough, though the restart RestartSec=5s brings would come
  // up: start polls every second, so it sees the wait and does not take it.
  let probes = 0;
  host.responses['GET /actuator/health'] = () => {
    probes += 1;
    if (probes === 1) {
      Object.assign(host.units[SERVER], {
        ActiveState: 'activating',
        SubState: 'auto-restart',
      });
    } else if (probes > 5) {
      Object.assign(host.units[SERVER], {
        ActiveState: 'active',
        SubState: 'running',
        NRestarts: '1',
      });
      return { status: 'UP' };
    }
    return { status: 'DOWN' };
  };
  assert.equal(await host.upgrade('start', '--timeout', '300'), 1);
  assert.match(
    host.output.at(-1),
    /exited before it reported UP at .*, and is stopped now/,
  );
  assert.equal(host.units[SERVER].ActiveState, 'inactive');
});

test('start counts the restarts from its own start', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  // A counter that a manual start leaves as it was, from earlier exits.
  host.keepRestarts = true;
  host.units[SERVER].NRestarts = '7';
  host.units[HARNESS].NRestarts = '3';
  host.responses['GET /actuator/health'] = { status: 'UP' };
  host.calls = [];
  host.requests = [];
  assert.equal(await host.upgrade('start'), 0, host.output.join('\n'));
  assert.ok(host.requests.some(({ url }) => url.endsWith('/actuator/health')));
  assert.ok(
    !host.calls.some(
      ([command, verb]) => command === 'systemctl' && verb === 'stop',
    ),
  );

  // One more than the start left is still an exit.
  assert.equal(await host.upgrade('stop'), 0);
  host.responses['GET /actuator/health'] = () => {
    host.units[SERVER].NRestarts = '8';
    return { status: 'DOWN' };
  };
  assert.equal(await host.upgrade('start', '--timeout', '300'), 1);
  assert.match(
    host.output.at(-1),
    /exited before it reported UP at .*, and is stopped now/,
  );
});

test('a health probe that never answers ends at the timeout', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.hang = true;
  const started = Date.now();
  assert.equal(await host.upgrade('start', '--timeout', '1'), 1);
  assert.ok(Date.now() - started < 4000, `${Date.now() - started}ms`);
  assert.match(
    host.output.join('\n'),
    /within 1s \(the last answer: The operation was aborted due to timeout\) and keeps running/,
  );
  assert.ok(host.requests.every(({ init }) => init.signal));
});

test('start names what the endpoint answered, not a probe the deadline cut short', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  // An endpoint that takes 50 ms to answer, on the real clock: the last
  // probe, which the deadline leaves 1 ms, times out before it does.
  const timedOut = [];
  host.requests = [];
  host.responses['GET /actuator/health'] = (search, { signal }) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(answer);
        timedOut.push(host.requests.length);
        reject(signal.reason);
      };
      const answer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve({ status: 'DOWN' });
      }, 50);
      signal.addEventListener('abort', abort);
    });
  assert.equal(await host.upgrade('start', '--timeout', '3'), 1);
  assert.equal(host.requests.length, 4);
  assert.deepEqual(timedOut, [4]);
  assert.match(
    host.output.at(-1),
    /within 3s \(the last answer: HTTP 200, status DOWN\) and keeps running/,
  );

  // One that answered and then stopped: a probe that runs out of its own
  // 5 s, not the deadline's, says so.
  assert.equal(await host.upgrade('stop'), 0);
  host.requests = [];
  host.responses['GET /actuator/health'] = async () => {
    if (host.requests.length === 1) {
      return { status: 'DOWN' };
    }
    host.clock += 5;
    throw new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
  };
  assert.equal(await host.upgrade('start', '--timeout', '6'), 1);
  assert.equal(host.requests.length, 2);
  assert.match(
    host.output.at(-1),
    /within 6s \(the last answer: The operation was aborted due to timeout\) and keeps running/,
  );

  // On real sockets. A body that stalls after its headers is cut short as
  // well: the second probe reads 200, then nothing until the deadline.
  let served = 0;
  const stalls = http.createServer((request, response) => {
    served += 1;
    if (served === 1) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"status":"DOWN"}');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"status":');
    }
  });
  await new Promise((resolve) => stalls.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    stalls.closeAllConnections();
    stalls.close();
  });
  host.system.fetch = fetch;
  assert.equal(await host.upgrade('stop'), 0);
  assert.equal(
    await host.upgrade(
      'start',
      '--server-url',
      `http://127.0.0.1:${stalls.address().port}`,
      '--timeout',
      '2',
    ),
    1,
  );
  assert.ok(served >= 2, `${served} requests`);
  assert.match(
    host.output.at(-1),
    /within 2s \(the last answer: HTTP 503, status DOWN\) and keeps running/,
  );

  // A refused connection after an answer is what the endpoint says now,
  // though the deadline cut that probe's time too.
  const closes = http.createServer((request, response) => {
    closes.close();
    response.writeHead(503, {
      'content-type': 'application/json',
      connection: 'close',
    });
    response.end('{"status":"DOWN"}');
  });
  await new Promise((resolve) => closes.listen(0, '127.0.0.1', resolve));
  // The handler closes the server itself once a request lands; tear it down
  // here too so an assertion that fails before any request does not leave the
  // listener open and hang node --test to the job's 45-minute ceiling.
  t.after(() => {
    closes.closeAllConnections();
    if (closes.listening) closes.close();
  });
  const { port } = closes.address();
  assert.equal(await host.upgrade('stop'), 0);
  assert.equal(
    await host.upgrade(
      'start',
      '--server-url',
      `http://127.0.0.1:${port}`,
      '--timeout',
      '3',
    ),
    1,
  );
  assert.match(
    host.output.at(-1),
    new RegExp(
      `within 3s \\(the last answer: connect ECONNREFUSED 127\\.0\\.0\\.1:${port}\\) and keeps running`,
    ),
  );
});

test('verify says what the health endpoint answered instead of UP', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  const fake = host.system.fetch;
  for (const [answer, health] of [
    [
      'HTTP 404',
      () => {
        delete host.responses['GET /actuator/health'];
        return fake;
      },
    ],
    // UP counts only with a success status.
    [
      'HTTP 503, status UP',
      () => async () => ({
        ok: false,
        status: 503,
        json: async () => ({ status: 'UP' }),
      }),
    ],
    // A proxy's error page, and a body that breaks off after a success.
    [
      'HTTP 502',
      () => async () => ({
        ok: false,
        status: 502,
        json: async () => JSON.parse('<html>Bad Gateway</html>'),
      }),
    ],
    [
      'HTTP 200, terminated',
      () => async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new TypeError('terminated');
        },
      }),
    ],
    // The parser's message quotes the body, control bytes and all.
    [
      `HTTP 200, Unexpected token 'x', "x\uFFFD[2K\uFFFD]52;c;" is not valid JSON`,
      () => async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse('x\u001b[2K\u001b]52;c;'),
      }),
    ],
    // fetch words every failure as "fetch failed"; its cause says why.
    [
      'self-signed certificate',
      () => async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('self-signed certificate'), {
            code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
          }),
        });
      },
    ],
    // A refused connection on each address of a name has only its code.
    [
      'ECONNREFUSED',
      () => async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new AggregateError([], ''), {
            code: 'ECONNREFUSED',
          }),
        });
      },
    ],
  ]) {
    host.system.fetch = health();
    assert.equal(await host.upgrade('verify'), 1);
    assert.equal(
      rowsOf(host.output).health,
      `FAIL http://127.0.0.1:18080/actuator/health is not UP: ${answer}`,
    );
  }

  // The runtime's own fetch, at a port nothing listens on.
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  host.resolved = {
    serverUrl: `http://127.0.0.1:${port}`,
    healthUrl: `http://127.0.0.1:${port}/actuator/health`,
  };
  host.system.fetch = fetch;
  assert.equal(await host.upgrade('verify'), 1);
  assert.equal(
    rowsOf(host.output).health,
    `FAIL http://127.0.0.1:${port}/actuator/health is not UP: connect ECONNREFUSED 127.0.0.1:${port}`,
  );
  host.system.fetch = fake;
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

  // A sequence written as a string moves the cursor all the same.
  polls = 0;
  host.responses['GET /v1/agents/sessions/s2/events'] = () => {
    polls += 1;
    return polls === 1
      ? { data: [{ sequence: '4', type: 'turn.started' }] }
      : { data: [{ sequence: '5', type: 'turn.completed', terminal: true }] };
  };
  host.requests = [];
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 0);
  assert.ok(
    host.requests.some(({ url }) =>
      url.endsWith('/v1/agents/sessions/s2/events?after=4&limit=100'),
    ),
  );
  // Nothing but a whole number moves it, and only forward: not text Number()
  // reads as one, nor the Infinity a JSON 1e400 parses to, nor a fraction,
  // nor an object, nor an earlier sequence after a later one.
  polls = 0;
  host.responses['GET /v1/agents/sessions/s2/events'] = () => {
    polls += 1;
    return polls === 1
      ? {
          data: [
            { sequence: '4', type: 'turn.started' },
            ...[
              'Infinity',
              '0x10',
              ' 9 ',
              '1e3',
              Infinity,
              12.5,
              { toString: 1 },
              3,
            ].map((sequence) => ({ sequence, type: 'turn.delta' })),
          ],
        }
      : { data: [{ sequence: 5, type: 'turn.completed', terminal: true }] };
  };
  host.requests = [];
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 0);
  assert.deepEqual(
    host.requests
      .map(({ url }) => /\/s2\/events\?after=([^&]*)/.exec(url)?.[1])
      .filter(Boolean),
    ['0', '4'],
  );
});

test('start and verify reach the listeners the server resolves', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  // The server port, a management port and the Harness URL set in a
  // configuration file, which server.env does not show.
  host.resolved = {
    serverUrl: 'http://127.0.0.1:9090',
    healthUrl: 'http://127.0.0.1:9091/manage/actuator/health',
    harnessBaseUrl: 'http://127.0.0.1:4171',
  };
  host.responses['GET /manage/actuator/health'] = { status: 'UP' };
  const urls = () => [...new Set(host.requests.map(({ url }) => url))];
  assert.equal(await host.upgrade('start'), 0);
  assert.deepEqual([...new Set(host.connections)], ['127.0.0.1:4171']);
  assert.deepEqual(urls(), ['http://127.0.0.1:9091/manage/actuator/health']);
  assert.ok(
    host.output.includes(
      `${SERVER} is UP at http://127.0.0.1:9091/manage/actuator/health; its API is at http://127.0.0.1:9090. Run verify before reopening ingress.`,
    ),
  );

  host.requests = [];
  host.responses['GET /v1/agents/sessions'] = { data: [{ id: 's1' }] };
  host.responses['GET /v1/agents/sessions/s1'] = { id: 's1' };
  host.responses['GET /v1/agents/sessions/s1/items'] = { data: [] };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 0);
  const rows = rowsOf(host.output);
  assert.equal(
    rows.health,
    'PASS http://127.0.0.1:9091/manage/actuator/health is UP',
  );
  assert.equal(rows.session, 'PASS read Session s1 and 0 item(s)');
  // The health row comes first, and each read needs the one before it.
  assert.deepEqual(urls(), [
    'http://127.0.0.1:9091/manage/actuator/health',
    'http://127.0.0.1:9090/v1/agents/sessions?limit=1',
    'http://127.0.0.1:9090/v1/agents/sessions/s1',
    'http://127.0.0.1:9090/v1/agents/sessions/s1/items?limit=20',
  ]);

  // --server-url names the control plane, and the Harness stays where the
  // configuration puts it. An @ its path holds is written %40, since a bare
  // one cannot be told from the rest of a password, and is dialled as given.
  await host.stop();
  host.connections = [];
  host.requests = [];
  host.responses['GET /prefix%40acme/actuator/health'] = { status: 'UP' };
  assert.equal(
    await host.upgrade(
      'start',
      '--server-url',
      'http://proxy.test:8443/prefix%40acme/',
    ),
    0,
  );
  assert.deepEqual([...new Set(host.connections)], ['127.0.0.1:4171']);
  assert.deepEqual(urls(), [
    'http://proxy.test:8443/prefix%40acme/actuator/health',
  ]);
  host.requests = [];
  host.responses['GET /prefix%40acme/v1/agents/sessions'] = {
    data: [{ id: 's1' }],
  };
  host.responses['GET /prefix%40acme/v1/agents/sessions/s1'] = { id: 's1' };
  host.responses['GET /prefix%40acme/v1/agents/sessions/s1/items'] = {
    data: [],
  };
  assert.equal(
    await host.upgrade(
      'verify',
      '--tenant',
      'acme',
      '--server-url',
      'http://proxy.test:8443/prefix%40acme',
    ),
    0,
  );
  assert.deepEqual(urls(), [
    'http://proxy.test:8443/prefix%40acme/actuator/health',
    'http://proxy.test:8443/prefix%40acme/v1/agents/sessions?limit=1',
    'http://proxy.test:8443/prefix%40acme/v1/agents/sessions/s1',
    'http://proxy.test:8443/prefix%40acme/v1/agents/sessions/s1/items?limit=20',
  ]);
});

test('start and verify use server.env when the configuration does not resolve', async (t) => {
  const { host, target } = await backedUp(t, {
    serverEnv: ['QWEN_MANAGED_AGENT_HARNESS_BASE_URL=http://127.0.0.1:4172'],
  });
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.resolveFailure = 'cannot resolve the server configuration: refused';
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  assert.ok(
    host.output.includes(
      "Cannot resolve the server's listeners: cannot resolve the server configuration: refused; using the URLs server.env names, or pass --server-url.",
    ),
  );
  assert.deepEqual([...new Set(host.connections)], ['127.0.0.1:4172']);
  assert.deepEqual(
    [...new Set(host.requests.map(({ url }) => url))],
    ['http://127.0.0.1:18080/actuator/health'],
  );
  // --server-url leaves nothing to fall back to but the Harness.
  await host.stop();
  host.connections = [];
  assert.equal(
    await host.upgrade('start', '--server-url', 'http://127.0.0.1:18081'),
    0,
  );
  assert.ok(
    host.output.includes(
      "Cannot resolve the server's listeners: cannot resolve the server configuration: refused; using the Harness URL server.env names.",
    ),
  );
  assert.deepEqual([...new Set(host.connections)], ['127.0.0.1:4172']);
  // An empty one is refused, as check refuses it, rather than dropped.
  assert.equal(await host.upgrade('verify', '--server-url', ''), 1);
  assert.equal(
    host.output.at(-1),
    'verify refused: --server-url "" is not a URL.',
  );
  // verify reaches no Harness, so it has nothing to resolve.
  host.services = [];
  assert.equal(
    await host.upgrade('verify', '--server-url', 'http://127.0.0.1:18081'),
    0,
  );
  assert.ok(!host.output.some((line) => line.startsWith('Cannot resolve')));
  assert.ok(!host.services.some(({ args }) => args.includes(RESOLVER)));
  assert.equal(
    rowsOf(host.output).health,
    'PASS http://127.0.0.1:18081/actuator/health is UP',
  );

  await host.stop();
  assert.equal(await host.upgrade('start', '--server-url', ''), 1);
  assert.equal(
    host.output.at(-1),
    'start refused: --server-url "" is not a URL.',
  );
  assert.ok(!host.output.includes(`Starting ${HARNESS}`));

  // Without the resolver's verdict, start takes only a plain http(s) URL, a
  // rule of its own and narrower than the server's, since a pool would drop
  // every member over a value the server refuses, and leaves the rest to
  // the preflight.
  const env = path.join(host.etc, 'server.env');
  const base = await readFile(env, 'utf8');
  for (const harnessUrl of [
    'http://127.0.0.1:4172/?tenant=acme',
    'http://svc:s3cret@127.0.0.1:4172',
    // java.net.URI reads user information where the URL parser finds none.
    'http://@127.0.0.1:4172',
    'http://:@127.0.0.1:4172',
    ' http:\\\\@127.0.0.1:4172',
    'http://svc:2024#s3cret@127.0.0.1:4172',
    // No host for java.net.URI, an authority it does not read, and a
    // backslash it refuses; systemd reads a backslash in an
    // EnvironmentFile as an escape, so the file doubles it.
    'http://qwen_harness:4172',
    'http:/@127.0.0.1:4172',
    'http://127.0.0.1:4172\\\\@x',
    // What the URL parser fetch uses reads as another address: a number,
    // with or without a final dot or a port, in hex in either case too, or
    // a bare 0x, and an octet with a leading zero, which it reads as octal.
    'http://1234:4172',
    'http://1234.:4172',
    'http://1234/',
    'http://0x1f:4172',
    'http://0X1F:4172',
    'http://0x:4172',
    'http://010.0.0.1:4172',
  ]) {
    await writeFile(
      env,
      `${base}QWEN_MANAGED_AGENT_HARNESS_BASE_URL=${harnessUrl}\n`,
    );
    assert.equal(await host.upgrade('start'), 1, harnessUrl);
    assert.match(
      host.output.at(-1),
      /^start refused: The control plane reaches qwen-hosted-harness at "([^"]*\*\*\*@(127\.0\.0\.1:4172\/?|x)|http:\/\/127\.0\.0\.1:4172\/\?tenant=acme|http:\/\/((qwen_harness|1234\.?|0x1f|0X1F|0x|010\.0\.0\.1):4172|1234\/))", which (carries (a query or a fragment|a user name or password|an @ before its host)|is not a plain http or https URL, a host java.net.URI and fetch read alike with a port of up to five digits and a path of URI characters, which is all start takes while the configuration does not resolve); correct/,
    );
    assert.ok(!host.output.join('\n').includes('s3cret'), harnessUrl);
    assert.ok(!host.output.includes(`Starting ${HARNESS}`), harnessUrl);
  }
  await writeFile(
    env,
    `${base}QWEN_MANAGED_AGENT_HARNESS_BASE_URL=http://127.0.0.1:6000\n`,
  );
  assert.equal(await host.upgrade('start'), 1);
  assert.equal(
    host.output.at(-1),
    'start refused: The control plane reaches qwen-hosted-harness at "http://127.0.0.1:6000", which is on port 6000, so fetch refuses to dial it; correct qwen.managed-agent.harness.base-url.',
  );
  assert.ok(!host.output.includes(`Starting ${HARNESS}`));
  // The rest goes to the preflight, such as a plain URL with an @ in its
  // path, which java.net.URI reads as the path.
  host.preflightStatus = 1;
  for (const [harnessUrl, waited] of [
    ['http://127.0.0.1:4172/@acme/harness', '127.0.0.1:4172'],
    ['http://gateway.example.com/@acme/harness', 'gateway.example.com:80'],
    // An escape, an IPv6 address, one that ends in an IPv4 address, a
    // label that starts with a digit before the last one, and the final dot
    // of a fully qualified name, all of which java.net.URI reads as a host.
    ['http://127.0.0.1:4172/a%20b', '127.0.0.1:4172'],
    ['http://[::1]:4172', '::1:4172'],
    ['http://[::ffff:127.0.0.1]:4172', '::ffff:7f00:1:4172'],
    ['http://1st.harness.internal:4172/', '1st.harness.internal:4172'],
    ['http://harness.internal.:4170/', 'harness.internal.:4170'],
    // One label that starts with a digit, as a container's name may, with
    // or without the final dot, and an empty port, which is the scheme's:
    // fetch reads each as java.net.URI does.
    ['http://4harness:4172', '4harness:4172'],
    ['http://4harness.:4172', '4harness.:4172'],
    ['http://harness.internal:/', 'harness.internal:80'],
    // The top port, and port 0, on which no Harness listens: the
    // preflight fails that one.
    ['http://127.0.0.1:65535', '127.0.0.1:65535'],
    ['http://127.0.0.1:0'],
  ]) {
    await writeFile(
      env,
      `${base}QWEN_MANAGED_AGENT_HARNESS_BASE_URL=${harnessUrl}\n`,
    );
    host.connections = [];
    assert.equal(await host.upgrade('start'), 1, harnessUrl);
    assert.ok(host.output.includes(`Starting ${HARNESS}`), harnessUrl);
    if (waited) {
      assert.deepEqual([...new Set(host.connections)], [waited], harnessUrl);
    }
    assert.equal(
      host.output.at(-1),
      `start refused: The preflight failed, so ${SERVER} stays stopped; fix its FAIL rows and run start again.`,
    );
    await host.stop();
  }
  host.preflightStatus = 0;
  await writeFile(env, base);

  // An address from server.env that no URL can carry is refused as well.
  await host.stop();
  await writeFile(
    path.join(host.etc, 'server.env'),
    'QWEN_MANAGED_AGENT_SERVER_ADDRESS=fe80::1%eth0\n',
    { flag: 'a' },
  );
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /start refused: The server's configuration puts the health endpoint at "http:\/\/\[fe80::1%eth0\]:18080\/actuator\/health", which is not a URL: a URL cannot carry an IPv6 zone\./,
  );
});

test('refusals neutralize the DEL and C1 bytes JSON leaves in a quoted value', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.services = [];
  // eslint-disable-next-line no-control-regex -- detecting surviving control bytes is the assertion
  const control = /[\u0000-\u001F\u007F-\u009F]/;
  // U+009B is an 8-bit CSI introducer, so \u009b2K would erase the row;
  // U+0085 would split it.
  for (const [setup, args, shown] of [
    [
      () => (host.resolved = {}),
      ['--server-url', 'http://127.0.0.1:18080/x\u009b2K\u0085y?q=1'],
      '--server-url "http://127.0.0.1:18080/x\uFFFD2K\uFFFDy?q=1" carries a query',
    ],
    [
      () => (host.resolved = {}),
      ['--server-url', 'http://127.0.0.1:6000/x\u009b2K'],
      '--server-url "http://127.0.0.1:6000/x\uFFFD2K" is on port 6000',
    ],
    [
      () =>
        (host.resolved = {
          healthUrl: 'http://127.0.0.1:6000/x\u009b2K/actuator/health',
        }),
      [],
      'puts the health endpoint at "http://127.0.0.1:6000/x\uFFFD2K/actuator/health", which is on port 6000',
    ],
    [
      () =>
        (host.resolved = {
          harnessBaseUrl: 'http://127.0.0.1:4170/x\u009b2K?q',
          harnessOrigin: 'false',
        }),
      [],
      'reaches qwen-hosted-harness at "http://127.0.0.1:4170/x\uFFFD2K?q", which carries a query or a fragment',
    ],
  ]) {
    setup();
    assert.equal(await host.upgrade('start', ...args), 1, shown);
    assert.ok(host.output.at(-1).includes(shown), host.output.at(-1));
    assert.ok(
      !host.output.some((line) => control.test(line)),
      JSON.stringify(host.output),
    );
  }
});

test('start refuses listeners it cannot reach before it starts anything', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.services = [];
  host.resolved = { serverUrl: '', healthUrl: '' };
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /start refused: The server's configuration gives the health endpoint no fixed port: 0 picks one at start, and a negative one opens none\. Pass --server-url <a URL that serves the API and \/actuator\/health>\./,
  );
  // management.server.port -1 or 0, with the server on a fixed port.
  host.resolved = { healthUrl: '' };
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /gives the health endpoint no fixed port/,
  );
  host.resolved = { harnessBaseUrl: '' };
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /start refused: The control plane reaches qwen-hosted-harness at "", which is not a URL; correct qwen\.managed-agent\.harness\.base-url\./,
  );
  host.resolved = { harnessBaseUrl: 'proxy.test:4170' };
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /start refused: The control plane reaches qwen-hosted-harness at "proxy\.test:4170", which is not an http or https URL; correct qwen\.managed-agent\.harness\.base-url\./,
  );
  // The Harness URL gets the same zone explanation --server-url gets: a
  // link-local address that still looks well formed must say why it is refused.
  host.resolved = { harnessBaseUrl: 'http://[fe80::1%eth0]:4170' };
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /start refused: The control plane reaches qwen-hosted-harness at "http:\/\/\[fe80::1%eth0\]:4170", which is not a URL: a URL cannot carry an IPv6 zone; correct qwen\.managed-agent\.harness\.base-url\./,
  );
  // The preflight takes only an http(s) origin, so whatever else it would
  // fail after the Harness restarts is refused first, credentials masked:
  // the resolver passes on its verdict, and the refusal words it.
  for (const [harnessBaseUrl, shown, reason] of [
    [
      'http://127.0.0.1:4170/?tenant=acme',
      'http://127.0.0.1:4170/?tenant=acme',
      'carries a query or a fragment',
    ],
    [
      'http://127.0.0.1:4170/?',
      'http://127.0.0.1:4170/?',
      'carries a query or a fragment',
    ],
    [
      'http://127.0.0.1:4170#x',
      'http://127.0.0.1:4170#x',
      'carries a query or a fragment',
    ],
    [
      'http://svc:s3cret@127.0.0.1:4170',
      'http://***@127.0.0.1:4170/',
      'carries a user name or password',
    ],
    [
      'http://@127.0.0.1:4170',
      'http://***@127.0.0.1:4170',
      'carries an @ before its host',
    ],
    // java.net.URI reads the padding untrimmed, so it reads no authority
    // there; nor in http:/@…, whose @ follows a single slash. The refusal
    // then says only that the server does not take the value.
    [
      ' http://@127.0.0.1:4170',
      '***@127.0.0.1:4170',
      'the server does not take as an http or https base URL, reading it untrimmed as java.net.URI does',
    ],
    [
      'http:/@127.0.0.1:4170',
      'http:***@127.0.0.1:4170',
      'the server does not take as an http or https base URL, reading it untrimmed as java.net.URI does',
    ],
    [
      'http://svc:2024#s3cret@127.0.0.1:4170',
      'http://***@127.0.0.1:4170',
      'carries a query or a fragment',
    ],
    [
      'ftp://deploy:s3cret@harness.internal:4170',
      'ftp://***@harness.internal:4170/',
      'is not an http or https URL',
    ],
  ]) {
    host.resolved = { harnessBaseUrl, harnessOrigin: 'false' };
    assert.equal(await host.upgrade('start'), 1, harnessBaseUrl);
    assert.equal(
      host.output.at(-1),
      `start refused: The control plane reaches qwen-hosted-harness at ${JSON.stringify(shown)}, which ${reason}; correct qwen.managed-agent.harness.base-url.`,
    );
    // Each run prints afresh, so each is searched for the password.
    assert.ok(!host.output.join('\n').includes('s3cret'), harnessBaseUrl);
  }
  // Without a verdict, the plain-URL rule refuses before the Harness
  // restarts what the URL parser would repair: the tabs it drops, and a
  // backslash it reads as a slash, which java.net.URI refuses.
  for (const harnessBaseUrl of [
    'http:/\t/\t@127.0.0.1:4170',
    'http://h\\@x',
    'http:/@127.0.0.1:4170',
    // A space java.net.URI refuses in a path, and a malformed escape.
    'http://127.0.0.1:4170/a b',
    'http://127.0.0.1:4170/a%zz',
    // Hosts java.net.URI reads no host in: an empty label, a label that
    // ends in a hyphen, and a last label that starts with a digit, of a name
    // of more than one.
    'http://harness..internal:4170',
    'http://harness-.internal:4170',
    'http://1.2.3:4170',
    'http://harness.1b:4170',
    // Fetch reads these as 0.0.4.210 and 8.0.0.1 respectively.
    'http://1234:4170',
    'http://010.0.0.1:4170',
  ]) {
    host.resolved = { harnessBaseUrl, harnessOrigin: undefined };
    assert.equal(
      await host.upgrade('start'),
      1,
      JSON.stringify(harnessBaseUrl),
    );
    assert.match(
      host.output.at(-1),
      /, which is not a plain http or https URL, a host java.net.URI and fetch read alike with a port of up to five digits and a path of URI characters, which is all start takes while the configuration does not resolve; correct qwen\.managed-agent\.harness\.base-url\.$/,
    );
    assert.ok(!host.output.includes(`Starting ${HARNESS}`));
  }
  // Past those, the preflight's own verdict, which the resolver passes on:
  // java.net.URI reads no host in a name with an underscore, and padding
  // fails there too. A Harness an earlier start left running is not
  // restarted for a URL the preflight would fail.
  Object.assign(host.units[HARNESS], {
    ActiveState: 'active',
    SubState: 'running',
  });
  const entered = host.units[HARNESS].ActiveEnterTimestampMonotonic;
  for (const harnessBaseUrl of [
    'http://qwen_harness:4170',
    // The resolver prints the value as the server parses it, padding and all.
    ' http://127.0.0.1:4170 ',
  ]) {
    host.resolved = { harnessBaseUrl, harnessOrigin: 'false' };
    assert.equal(await host.upgrade('start'), 1, harnessBaseUrl);
    assert.equal(
      host.output.at(-1),
      `start refused: The control plane reaches qwen-hosted-harness at ${JSON.stringify(harnessBaseUrl)}, which the server does not take as an http or https base URL, reading it untrimmed as java.net.URI does; correct qwen.managed-agent.harness.base-url.`,
    );
    assert.ok(!host.output.some((line) => line.startsWith('Restarting')));
  }
  assert.equal(host.units[HARNESS].ActiveEnterTimestampMonotonic, entered);
  Object.assign(host.units[HARNESS], {
    ActiveState: 'inactive',
    SubState: 'dead',
  });
  // A link-local listener keeps its zone, which no URL can carry.
  const zoned = 'http://[fe80:0:0:0:0:0:0:1%1]';
  host.resolved = {
    serverUrl: `${zoned}:8080`,
    healthUrl: `${zoned}:8080/actuator/health`,
  };
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /start refused: The server's configuration puts the health endpoint at "http:\/\/\[fe80:0:0:0:0:0:0:1%1\]:8080\/actuator\/health", which is not a URL: a URL cannot carry an IPv6 zone\. Bind it where fetch can reach it, or pass --server-url <a URL that serves the API and \/actuator\/health>\./,
  );
  host.resolved = { healthUrl: `${zoned}:9091/actuator/health` };
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /puts the health endpoint at "http:\/\/\[fe80:0:0:0:0:0:0:1%1\]:9091\/actuator\/health", which is not a URL: a URL/,
  );
  host.resolved = {
    serverUrl: 'http://127.0.0.1:70000',
    healthUrl: 'http://127.0.0.1:70000/actuator/health',
  };
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /puts the health endpoint at "http:\/\/127\.0\.0\.1:70000\/actuator\/health", which is not a URL\. Bind it/,
  );
  host.resolved = {};
  assert.equal(
    await host.upgrade('start', '--server-url', 'http://[fe80::1%eth0]:8080'),
    1,
  );
  assert.match(
    host.output.join('\n'),
    /start refused: --server-url "http:\/\/\[fe80::1%eth0\]:8080" is not a URL: a URL cannot carry an IPv6 zone\./,
  );
  // fetch would refuse each probe: a port it blocks, a URL without a scheme
  // and credentials, which the health endpoint never needs.
  host.resolved = {
    serverUrl: 'http://127.0.0.1:6000',
    healthUrl: 'http://127.0.0.1:6000/actuator/health',
  };
  assert.equal(await host.upgrade('start'), 1);
  assert.match(
    host.output.join('\n'),
    /puts the health endpoint at "http:\/\/127\.0\.0\.1:6000\/actuator\/health", which is on port 6000, so fetch refuses to dial it\. Bind it where fetch can reach it, or pass --server-url/,
  );
  host.resolved = {};
  host.responses['GET /actuator/health'] = { status: 'UP' };
  host.requests = [];
  for (const [serverUrl, refusal, shown = serverUrl.replace(/\/$/, '')] of [
    ['', 'is not a URL'],
    ['proxy.test:8443', 'is not an http or https URL'],
    [
      'http://admin:secret@127.0.0.1:18080',
      'carries a user name or password, so fetch refuses it',
      'http://***@127.0.0.1:18080/',
    ],
    [
      'http://admin:secret@127.0.0.1:70000',
      'is not a URL',
      'http://***@127.0.0.1:70000',
    ],
    [
      'https://svc:secret@[fe80::1%eth0]:8080',
      'is not a URL: a URL cannot carry an IPv6 zone',
      'https://***@[fe80::1%eth0]:8080',
    ],
    [
      'http://127.0.0.1:10080/',
      'is on port 10080, so fetch refuses to dial it',
    ],
    // The paths are appended to it, so they would land in either.
    [
      'http://proxy.test:8443/?tenant=acme',
      'carries a query or a fragment, where the /actuator/health and API paths appended to it would land',
    ],
    [
      'http://proxy.test:8443/?',
      'carries a query or a fragment, where the /actuator/health and API paths appended to it would land',
      'http://proxy.test:8443/?',
    ],
    [
      'http://proxy.test:8443#ingress',
      'carries a query or a fragment, where the /actuator/health and API paths appended to it would land',
    ],
    // A password that starts with digits parses as a port, with the rest of
    // it in the fragment.
    [
      'http://admin:2024#secret@127.0.0.1:18080',
      'carries a query or a fragment, where the /actuator/health and API paths appended to it would land',
      'http://***@127.0.0.1:18080',
    ],
  ]) {
    assert.equal(await host.upgrade('start', '--server-url', serverUrl), 1);
    assert.ok(
      host.output.includes(
        `start refused: --server-url ${JSON.stringify(shown)} ${refusal}.`,
      ),
      host.output.join('\n'),
    );
    // The password the operator typed stays out of what each run prints.
    assert.ok(
      !host.output.join('\n').includes('secret'),
      host.output.join('\n'),
    );
  }
  assert.deepEqual(host.requests, []);
  assert.equal(host.units[HARNESS].ActiveState, 'inactive');
  assert.equal(host.units[SERVER].ActiveState, 'inactive');
  assert.ok(host.services.every(({ args }) => args.includes(RESOLVER)));

  host.resolved = { healthUrl: '' };
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(
    await host.upgrade('start', '--server-url', 'http://127.0.0.1:18080'),
    0,
  );
  host.resolved = { serverUrl: '', healthUrl: '' };
  assert.equal(await host.upgrade('verify'), 1);
  assert.match(
    host.output.join('\n'),
    /verify refused: The server's configuration gives the health endpoint no fixed port/,
  );
});

test('start asks nothing of a Harness URL the server does not read', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  // Disabled, the Harness row skips before it reads the value, and the server
  // never dials it; start still waits for the Harness there.
  for (const [harnessBaseUrl, address] of [
    [' http://127.0.0.1:4170 ', '127.0.0.1:4170'],
    ['http://qwen_harness:4170', 'qwen_harness:4170'],
    ['http://127.0.0.1:4170/?tenant=acme', '127.0.0.1:4170'],
    ['http://svc:s3cret@127.0.0.1:4170', '127.0.0.1:4170'],
  ]) {
    await host.stop();
    host.connections = [];
    host.resolved = { harnessBaseUrl, harnessOrigin: 'skip' };
    assert.equal(await host.upgrade('start'), 0, harnessBaseUrl);
    assert.ok(host.output.includes(`Starting ${HARNESS}`), harnessBaseUrl);
    assert.deepEqual([...new Set(host.connections)], [address]);
    assert.ok(!host.output.join('\n').includes('s3cret'), harnessBaseUrl);
  }
  // It has to name a host start can wait on all the same.
  await host.stop();
  host.resolved = { harnessBaseUrl: 'proxy.test:4170', harnessOrigin: 'skip' };
  assert.equal(await host.upgrade('start'), 1);
  assert.equal(
    host.output.at(-1),
    'start refused: The control plane reaches qwen-hosted-harness at "proxy.test:4170", which is not an http or https URL; correct qwen.managed-agent.harness.base-url.',
  );
  assert.equal(host.units[HARNESS].ActiveState, 'inactive');
});

test('start dials only the health endpoint, and verify reads the API only with --tenant', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  // The API on a port fetch refuses, the health endpoint on its own
  // management port: start never dials the API, so it does not refuse it.
  host.resolved = {
    serverUrl: 'http://127.0.0.1:6000',
    healthUrl: 'http://127.0.0.1:9091/actuator/health',
  };
  host.responses['GET /actuator/health'] = { status: 'UP' };
  host.requests = [];
  assert.equal(await host.upgrade('start'), 0, host.output.join('\n'));
  assert.deepEqual(
    [...new Set(host.requests.map(({ url }) => url))],
    ['http://127.0.0.1:9091/actuator/health'],
  );
  // Nor does verify without --tenant, which reads no API.
  assert.equal(await host.upgrade('verify'), 0, host.output.join('\n'));
  assert.equal(
    rowsOf(host.output).health,
    'PASS http://127.0.0.1:9091/actuator/health is UP',
  );
  // verify --tenant reads it, so it says why it cannot, before any probe.
  host.requests = [];
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  assert.equal(
    host.output.at(-1),
    'verify refused: The server\'s configuration puts the control plane at "http://127.0.0.1:6000", which is on port 6000, so fetch refuses to dial it. Bind it where fetch can reach it, or pass --server-url <a URL that serves the API and /actuator/health>.',
  );
  assert.deepEqual(host.requests, []);
  // --actor without a trusted actor header reads no API either: its session
  // row fails, and the API URL is not checked.
  host.resolved.trustedActorHeader = '';
  assert.equal(
    await host.upgrade('verify', '--tenant', 'acme', '--actor', 'alice'),
    1,
  );
  assert.match(
    rowsOf(host.output).session,
    /^FAIL --actor needs a trusted actor header/,
  );
  assert.ok(!host.output.some((line) => line.startsWith('verify refused')));
  delete host.resolved.trustedActorHeader;
  // An API port picked at start, the same way.
  host.resolved = {
    serverUrl: '',
    healthUrl: 'http://127.0.0.1:9091/actuator/health',
  };
  assert.equal(await host.upgrade('verify'), 0, host.output.join('\n'));
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  assert.match(
    host.output.at(-1),
    /^verify refused: The server's configuration gives the control plane no fixed port/,
  );
  assert.equal(await host.upgrade('stop'), 0);
  assert.equal(await host.upgrade('start'), 0, host.output.join('\n'));
  assert.equal(
    host.output.at(-1),
    'qwen-managed-agent-server is UP at http://127.0.0.1:9091/actuator/health. Run verify before reopening ingress.',
  );
});

test('health reports neutralize terminal control bytes from the endpoint', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  // A queryable endpoint must not drive the terminal that reports it: cursor
  // moves that repaint a FAIL verdict as PASS, a newline that splits the row,
  // and an OSC-52 clipboard write all ride in the status field as control bytes.
  const malicious =
    'DOWN\u001b[1A\u001b[2K\u001b[32mPASS\u001b[0m\nsplit\u001b]52;c;SGVsbG8=\u0007';
  host.responses['GET /actuator/health'] = { status: malicious };
  assert.equal(await host.upgrade('verify'), 1);
  const row = rowsOf(host.output).health;
  assert.ok(
    row.startsWith(
      'FAIL http://127.0.0.1:18080/actuator/health is not UP: HTTP 200, status DOWN',
    ),
    row,
  );
  assert.ok(
    // eslint-disable-next-line no-control-regex -- detecting surviving control bytes is the assertion
    !/[\u0000-\u001F\u007F-\u009F]/.test(row),
    `a control byte survived: ${JSON.stringify(row)}`,
  );
  assert.ok(row.includes('\uFFFD'), row);
  assert.ok(
    row.includes('PASS') && row.includes('split'),
    `readable text stays: ${row}`,
  );

  // A status that is valid JSON and no string, one String() throws on, is
  // shown as its JSON: verify still prints its row, and start keeps probing.
  host.responses['GET /actuator/health'] = { status: { toString: 1 } };
  assert.equal(await host.upgrade('verify'), 1);
  assert.equal(
    rowsOf(host.output).health,
    'FAIL http://127.0.0.1:18080/actuator/health is not UP: HTTP 200, status {"toString":1}',
  );
  assert.equal(await host.upgrade('stop'), 0);
  assert.equal(await host.upgrade('start', '--timeout', '3'), 1);
  assert.match(
    host.output.at(-1),
    /within 3s \(the last answer: HTTP 200, status \{"toString":1\}\) and keeps running/,
  );

  // One nested deeper than JSON.stringify() recurses parses all the same,
  // and is shown as unprintable rather than ending the report.
  host.responses['GET /actuator/health'] = {
    status: JSON.parse('['.repeat(20000) + ']'.repeat(20000)),
  };
  assert.equal(await host.upgrade('stop'), 0);
  assert.equal(await host.upgrade('start', '--timeout', '3'), 1);
  assert.match(
    host.output.at(-1),
    /within 3s \(the last answer: HTTP 200, status \[unprintable\]\) and keeps running/,
  );
  assert.equal(await host.upgrade('verify'), 1);
  assert.equal(
    rowsOf(host.output).health,
    'FAIL http://127.0.0.1:18080/actuator/health is not UP: HTTP 200, status [unprintable]',
  );

  // Nor can the endpoint scroll the report away with a long one: the text
  // stops at 200 code points, never inside a surrogate pair, and says how
  // long it was.
  host.responses['GET /actuator/health'] = {
    status: `${'😀'.repeat(150)}${'A'.repeat(99850)}`,
  };
  assert.equal(await host.upgrade('verify'), 1);
  assert.equal(
    rowsOf(host.output).health,
    `FAIL http://127.0.0.1:18080/actuator/health is not UP: HTTP 200, status ${'😀'.repeat(150)}${'A'.repeat(50)}… (100000 characters)`,
  );
  assert.ok(host.output.join('\n').length < 2000);
  // Text of exactly the bound shows whole, a control byte counted as one.
  host.responses['GET /actuator/health'] = {
    status: `${'😀'.repeat(150)}\u001b${'A'.repeat(49)}`,
  };
  assert.equal(await host.upgrade('verify'), 1);
  assert.equal(
    rowsOf(host.output).health,
    `FAIL http://127.0.0.1:18080/actuator/health is not UP: HTTP 200, status ${'😀'.repeat(150)}\uFFFD${'A'.repeat(49)}`,
  );
  host.responses['GET /actuator/health'] = {
    status: `${'😀'.repeat(150)}${'A'.repeat(99850)}`,
  };
  assert.equal(await host.upgrade('stop'), 0);
  assert.equal(await host.upgrade('start', '--timeout', '2'), 1);
  assert.ok([...host.output.at(-1)].length < 600, host.output.at(-1));
  assert.match(
    host.output.at(-1),
    /… \(100000 characters\)\) and keeps running/,
  );

  // A status of 0, false or an empty string is a status all the same, which
  // a test of its truth would drop; a null one, like none, names nothing.
  for (const [status, shown] of [
    [0, ', status 0'],
    [false, ', status false'],
    ['', ', status ""'],
    [null, ''],
  ]) {
    host.responses['GET /actuator/health'] = { status };
    assert.equal(await host.upgrade('verify'), 1);
    assert.equal(
      rowsOf(host.output).health,
      `FAIL http://127.0.0.1:18080/actuator/health is not UP: HTTP 200${shown}`,
      JSON.stringify(status),
    );
  }

  // The health URL comes from the configuration or the command line, not
  // the endpoint, but a control byte in it would split the row all the same.
  assert.equal(
    await host.upgrade(
      'verify',
      '--server-url',
      'http://127.0.0.1:18080/x\u001b[2K\u0085y',
    ),
    1,
  );
  const shown = rowsOf(host.output).health;
  assert.ok(
    shown.startsWith(
      'FAIL http://127.0.0.1:18080/x\uFFFD[2K\uFFFDy/actuator/health is not UP: ',
    ),
    shown,
  );
  // eslint-disable-next-line no-control-regex -- detecting surviving control bytes is the assertion
  const control = /[\u0000-\u001F\u007F-\u009F]/;
  assert.ok(
    !host.output.some((line) => control.test(line)),
    JSON.stringify(host.output),
  );
  // start prints it in each of its outcomes.
  const steered = 'http://127.0.0.1:18080/x\u001b[2K\u0085y';
  const flat = 'http:\\/\\/127\\.0\\.0\\.1:18080\\/x\uFFFD\\[2K\uFFFDy';
  for (const [answer, outcome] of [
    [
      { status: 'UP' },
      `is UP at ${flat}\\/actuator\\/health; its API is at ${flat}\\. Run verify`,
    ],
    [
      { status: 'DOWN' },
      `did not report UP at ${flat}\\/actuator\\/health within 2s`,
    ],
    [
      () => {
        host.units[SERVER].ActiveState = 'failed';
        return { status: 'DOWN' };
      },
      `exited before it reported UP at ${flat}\\/actuator\\/health, and is stopped now`,
    ],
  ]) {
    assert.equal(await host.upgrade('stop'), 0);
    host.responses[`GET ${new URL(`${steered}/actuator/health`).pathname}`] =
      answer;
    await host.upgrade('start', '--server-url', steered, '--timeout', '2');
    assert.match(host.output.at(-1), new RegExp(outcome));
    assert.ok(
      !host.output.some((line) => control.test(line)),
      JSON.stringify(host.output),
    );
  }
});

test('no report prints a password a URL carries', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  // An @ the configuration puts in the path: every outcome masks up to it.
  host.resolved = {
    serverUrl: 'http://127.0.0.1:18080/s3cret@b',
    healthUrl: 'http://127.0.0.1:18080/s3cret@b/actuator/health',
  };
  for (const [answer, outcome] of [
    [
      { status: 'UP' },
      'is UP at http://***@b/actuator/health; its API is at http://***@b. Run verify',
    ],
    [
      { status: 'DOWN' },
      'did not report UP at http://***@b/actuator/health within 2s',
    ],
    [
      () => {
        host.units[SERVER].ActiveState = 'failed';
        return { status: 'DOWN' };
      },
      'exited before it reported UP at http://***@b/actuator/health, and is stopped now',
    ],
  ]) {
    await host.upgrade('stop');
    host.responses['GET /s3cret@b/actuator/health'] = answer;
    await host.upgrade('start', '--timeout', '2');
    assert.ok(host.output.at(-1).includes(outcome), host.output.at(-1));
    assert.ok(
      !host.output.join('\n').includes('s3cret'),
      JSON.stringify(host.output),
    );
  }
  await host.upgrade('stop');
  host.responses['GET /s3cret@b/actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start', '--timeout', '2'), 0);
  assert.equal(await host.upgrade('verify'), 0);
  assert.equal(
    rowsOf(host.output).health,
    'PASS http://***@b/actuator/health is UP',
  );
  host.responses['GET /s3cret@b/actuator/health'] = { status: 'DOWN' };
  assert.equal(await host.upgrade('verify'), 1);
  assert.equal(
    rowsOf(host.output).health,
    'FAIL http://***@b/actuator/health is not UP: HTTP 200, status DOWN',
  );
  // A --server-url with an @ left after the URL parser has read no user
  // information is the rest of a password that starts with digits: the
  // parser reads host svc, port 12, so the phase would dial the wrong host
  // and print the password. Each phase refuses it before it dials.
  host.resolved = {};
  for (const phase of ['verify', 'start']) {
    if (phase === 'start') {
      await host.upgrade('stop');
    }
    assert.equal(
      await host.upgrade(
        phase,
        '--server-url',
        'https://svc:12/s3cret@cp.example.com:8443',
      ),
      1,
    );
    assert.equal(
      host.output.at(-1),
      `${phase} refused: --server-url "https://***@cp.example.com:8443" carries an @, as a user name or password would before its host; write an @ in a path as %40.`,
    );
    assert.ok(!host.output.join('\n').includes('s3cret'), phase);
    assert.equal(
      host.requests.filter((request) => request.url.includes('svc')).length,
      0,
    );
  }
});

test('check judges the --server-url its plan repeats', async (t) => {
  const host = await rig(t);
  assert.equal(await host.upgrade('--help'), 0);
  assert.match(
    host.output.join('\n'),
    /--server-url <url>\s+start, verify: control-plane URL \(default: the listener\s+the server's configuration resolves to\); check refuses\s+a URL they would refuse, as its plan repeats it/,
  );
  for (const [serverUrl, shown, reason] of [
    [
      'https://ops:s3cret@cp.example.com',
      'https://***@cp.example.com/',
      'carries a user name or password, so fetch refuses it',
    ],
    [
      'https://svc:12/s3cret@cp.example.com',
      'https://***@cp.example.com',
      'carries an @, as a user name or password would before its host; write an @ in a path as %40',
    ],
    // What --server-url "https://$HOST" leaves with HOST unset, which the
    // option parser strips to https:, though https:/actuator/health parses.
    ['https://', 'https:', 'is not a URL'],
    // And --server-url "$CONTROL_PLANE", which start and verify would
    // otherwise drop for the configured URL.
    ['', '', 'is not a URL'],
  ]) {
    assert.equal(await host.check('--server-url', serverUrl), 1);
    assert.equal(
      host.output.at(-1),
      `check refused: --server-url "${shown}" ${reason}.`,
    );
    assert.ok(!host.output.join('\n').includes('s3cret'), serverUrl);
  }
  assert.equal(
    await host.check('--server-url', 'https://cp.example.com:8443'),
    0,
  );
  const plan = host.output.slice(host.output.indexOf('Plan:')).join('\n');
  assert.ok(
    plan.includes(' start --server-url https://cp.example.com:8443\n'),
    plan,
  );
  // A control character in a value the plan repeats reaches the terminal as
  // an escape, which the shell reads back as the value, a digit after it
  // included, which ksh would read on with a \x escape.
  const releases = `${host.root}/rel\u001b[2K'\u009b\\x\t9b\u001b1`;
  assert.equal(await host.check('--releases', releases), 0);
  const printed = host.output.slice(host.output.indexOf('Plan:')).join('\n');
  assert.ok(
    // eslint-disable-next-line no-control-regex -- matching control bytes is the point
    !/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/.test(printed),
    printed,
  );
  const word = printed.match(/ stop --releases (\S+)/)[1];
  assert.equal(
    word,
    `$'${host.root}/rel\\033[2K\\'\\302\\233\\\\x\\0119b\\0331'`,
  );
  // As each of the shells that read $'...' and are here reads it back.
  for (const shell of ['bash', 'zsh', 'ksh']) {
    const echoed = spawnSync(shell, ['-c', `printf %s ${word}`], {
      encoding: 'utf8',
    });
    if (echoed.error?.code === 'ENOENT' && shell !== 'bash') {
      continue;
    }
    assert.equal(echoed.stdout, releases, shell);
  }
});

test('check layout rows neutralize control bytes without shortening paths', async (t) => {
  const host = await rig(t);
  // eslint-disable-next-line no-control-regex -- detecting surviving control bytes is the assertion
  const control = /[\u0000-\u001F\u007F-\u009F]/;
  const releases = `${host.root}/${'release-'.repeat(30)}\u001b[2K\u009b`;
  assert.ok(releases.length > 200);
  assert.equal(await host.check('--releases', releases), 0);
  assert.ok(
    !host.output.some((line) => control.test(line)),
    JSON.stringify(host.output),
  );
  const shownReleases = releases.split(control).join('\uFFFD');
  assert.equal(
    rowsOf(host.output).layout,
    `PASS install moves ${host.current} to ${path.join(shownReleases, '0.1.0')} and links it to ${path.join(shownReleases, '0.2.0')}`,
  );
});

test('check runtime-state rows neutralize control bytes', async (t) => {
  const host = await rig(t);
  // eslint-disable-next-line no-control-regex -- detecting surviving control bytes is the assertion
  const control = /[\u0000-\u001F\u007F-\u009F]/;
  const runtimeState = `${host.root}/${'state-'.repeat(40)}\u001b[2K\u009b`;
  assert.equal(await host.check('--runtime-state', runtimeState), 1);
  assert.ok(
    !host.output.some((line) => control.test(line)),
    JSON.stringify(host.output),
  );
  assert.equal(
    rowsOf(host.output)['runtime-state'],
    `FAIL ${runtimeState.split(control).join('\uFFFD')} is not a directory`,
  );
});

test('verify sanitizes a malicious health body over a real socket', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  // The same attack over a real socket and the runtime's own fetch, through the
  // real health() -> printable() -> row() -> out() path, not the rig's fake.
  const malicious =
    'DOWN\u001b[1A\u001b[2K\u001b[32mPASS\u001b[0m\nsplit\u001b]52;c;SGVsbG8=\u0007';
  const server = http.createServer((request, response) => {
    if (request.url === '/actuator/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: malicious }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  host.system.fetch = fetch;
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await host.upgrade('verify', '--server-url', url), 1);
  const row = rowsOf(host.output).health;
  assert.ok(
    row.startsWith(
      `FAIL ${url}/actuator/health is not UP: HTTP 200, status DOWN`,
    ),
    row,
  );
  assert.ok(
    // eslint-disable-next-line no-control-regex -- detecting surviving control bytes is the assertion
    !/[\u0000-\u001F\u007F-\u009F]/.test(row),
    `a control byte survived: ${JSON.stringify(row)}`,
  );
  assert.ok(
    row.includes('\uFFFD') && row.includes('PASS') && row.includes('split'),
    row,
  );
});

test('verify says why an API read failed, in text the endpoint cannot steer', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  // fetch words every failure as "fetch failed"; the session row says why,
  // as the health row above it does.
  host.responses['GET /v1/agents/sessions'] = () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(
        new Error('self-signed certificate in certificate chain'),
        { code: 'SELF_SIGNED_CERT_IN_CHAIN' },
      ),
    });
  };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  assert.equal(
    rowsOf(host.output).session,
    'FAIL GET /v1/agents/sessions?limit=1: self-signed certificate in certificate chain',
  );

  // Text the API hands back cannot drive the terminal either: an error
  // reason, a Session ID and an event type.
  const steer = 'x\u001b[2K\u001b[32mPASS\u001b[0m\nsplit\u009b1A';
  // eslint-disable-next-line no-control-regex -- detecting surviving control bytes is the assertion
  const control = /[\u0000-\u001F\u007F-\u009F]/;
  const fake = host.system.fetch;
  host.system.fetch = async (url, init) =>
    url.includes('/v1/agents/sessions?limit=1')
      ? {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ error: { message: steer } }),
        }
      : fake(url, init);
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  const failed = rowsOf(host.output).session;
  assert.ok(failed.startsWith('FAIL GET /v1/agents/sessions?limit=1: 500 x'));
  assert.ok(!control.test(failed), JSON.stringify(failed));
  // An error reason that is no string is shown as its JSON.
  host.system.fetch = async (url, init) =>
    url.includes('/v1/agents/sessions?limit=1')
      ? {
          ok: false,
          status: 500,
          json: async () => ({ error: { message: { toString: 1 } } }),
        }
      : fake(url, init);
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  assert.equal(
    rowsOf(host.output).session,
    'FAIL GET /v1/agents/sessions?limit=1: 500 {"toString":1}',
  );
  // A cause can quote what the peer sent, as a TLS alert or a parser does.
  host.system.fetch = async () => {
    throw new TypeError('fetch failed', { cause: new Error(steer) });
  };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  const caused = rowsOf(host.output);
  for (const name of ['health', 'session']) {
    assert.ok(caused[name].startsWith('FAIL '), caused[name]);
    assert.ok(caused[name].includes('x\uFFFD[2K'), caused[name]);
    assert.ok(!control.test(caused[name]), JSON.stringify(caused[name]));
  }
  // A success whose body is no JSON: the parse error quotes the body.
  host.system.fetch = async (url, init) =>
    url.includes('/v1/agents/sessions?limit=1')
      ? { ok: true, status: 200, json: async () => JSON.parse(steer) }
      : fake(url, init);
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  const unreadable = rowsOf(host.output).session;
  assert.match(
    unreadable,
    /^FAIL .*: 200 with an unreadable body \(.*x\uFFFD\[2K/,
  );
  assert.ok(!control.test(unreadable), JSON.stringify(unreadable));
  host.system.fetch = fake;

  const id = encodeURIComponent(steer);
  host.responses['GET /v1/agents/sessions'] = { data: [{ id: steer }] };
  host.responses[`GET /v1/agents/sessions/${id}`] = { id: steer };
  host.responses[`GET /v1/agents/sessions/${id}/items`] = { data: [{}, {}] };
  host.responses['POST /v1/agents/sessions'] = { id: steer };
  host.responses[`GET /v1/agents/sessions/${id}/events`] = {
    data: [{ sequence: 1, type: `turn.completed${steer}`, terminal: true }],
  };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 0);
  const rows = rowsOf(host.output);
  for (const name of ['session', 'turn']) {
    assert.ok(rows[name].startsWith('PASS '), rows[name]);
    assert.ok(!control.test(rows[name]), JSON.stringify(rows[name]));
    assert.ok(rows[name].includes('\uFFFD') && rows[name].includes('split'));
  }
  host.responses[`GET /v1/agents/sessions/${id}/events`] = {
    data: [{ sequence: 2, type: `turn.failed${steer}`, terminal: true }],
  };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 1);
  const turn = rowsOf(host.output).turn;
  assert.ok(turn.startsWith('FAIL Session x'), turn);
  assert.ok(!control.test(turn), JSON.stringify(turn));
  // An id the API lists and then fails to serve: the request the row names
  // stops at the bound, as the id itself does.
  host.responses['GET /v1/agents/sessions'] = {
    data: [{ id: 'S'.repeat(100000) }],
  };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  const unserved = rowsOf(host.output).session;
  assert.match(
    unserved,
    /^FAIL GET \/v1\/agents\/sessions\/S{180}… \(100020 characters\): 404/,
  );
  assert.ok(unserved.length < 300, unserved.length);

  // A value the API chose is typed before a route or a verdict uses it:
  // coercing an object calls its toString, and an array nested deeper than
  // the stack cannot be joined, so either would throw before the row could
  // say what came back.
  const deep = JSON.parse('['.repeat(20000) + ']'.repeat(20000));
  host.responses['GET /v1/agents/sessions/s1'] = { id: 's1' };
  host.responses['GET /v1/agents/sessions/s1/items'] = { data: [] };
  for (const [value, shown] of [
    [{ toString: 1 }, '{"toString":1}'],
    [deep, '[unprintable]'],
    [7, '7'],
  ]) {
    host.responses['GET /v1/agents/sessions'] = { data: [{ id: value }] };
    host.responses['POST /v1/agents/sessions'] = { id: value };
    assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 1);
    const typed = rowsOf(host.output);
    for (const name of ['session', 'turn']) {
      assert.equal(
        typed[name],
        `FAIL the API answered a Session without a string id (${shown})`,
      );
    }
    // An event's type names no outcome unless it is a string, and a null
    // event is passed over.
    host.responses['GET /v1/agents/sessions'] = { data: [{ id: 's1' }] };
    host.responses['POST /v1/agents/sessions'] = { id: 's1' };
    host.responses['GET /v1/agents/sessions/s1/events'] = {
      data: [null, { sequence: value, type: value, terminal: true }],
    };
    assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 1);
    assert.equal(
      rowsOf(host.output).turn,
      `FAIL Session s1 ended with ${shown}`,
    );
  }
  // A listed entry that is no object is no Session either.
  for (const [entry, shown] of [
    [0, '0'],
    ['', ''],
    [false, 'false'],
    [null, 'null'],
    [{ name: 's1' }, '{"name":"s1"}'],
  ]) {
    host.responses['GET /v1/agents/sessions'] = { data: [entry] };
    assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
    assert.equal(
      rowsOf(host.output).session,
      `FAIL the API answered a Session without a string id (${shown})`,
    );
  }
  // Data that is no list is not read as one: iterating it would throw, or
  // walk a string, and its length would be whatever it holds.
  host.responses['GET /v1/agents/sessions'] = { data: [{ id: 's1' }] };
  for (const [data, shown] of [
    [{ length: 2 }, '{"length":2}'],
    [1, '1'],
    ['abc', 'abc'],
  ]) {
    host.responses['GET /v1/agents/sessions/s1/items'] = { data };
    host.responses['GET /v1/agents/sessions/s1/events'] = { data };
    assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 1);
    const listless = rowsOf(host.output);
    assert.equal(
      listless.session,
      `FAIL GET /v1/agents/sessions/s1/items?limit=20 answered no data list (${shown})`,
    );
    assert.equal(
      listless.turn,
      `FAIL Session s1: GET /v1/agents/sessions/s1/events answered no data list (${shown})`,
    );
    assert.ok(!control.test(listless.session), JSON.stringify(listless));
  }
  // A page without a data list is not an empty one.
  host.responses['GET /v1/agents/sessions/s1/items'] = { data: [] };
  for (const [page, shown] of [
    [[{ id: 's1' }], '[{"id":"s1"}]'],
    [{ data: null }, 'null'],
    ['oops', 'oops'],
    [{}, '{}'],
  ]) {
    host.responses['GET /v1/agents/sessions'] = page;
    assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
    assert.equal(
      rowsOf(host.output).session,
      `FAIL GET /v1/agents/sessions?limit=1 answered no data list (${shown})`,
    );
  }
  // An id a route cannot carry as one segment: fetch resolves the dots, an
  // empty one would read the list, and a lone surrogate has no UTF-8 to
  // percent-encode.
  for (const id of ['', '.', '..', '\uD800', 's\uDFFF1']) {
    host.responses['GET /v1/agents/sessions'] = { data: [{ id }] };
    assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
    assert.equal(
      rowsOf(host.output).session,
      `FAIL the API answered a Session whose id ${JSON.stringify(id)} names no route`,
    );
  }
  // The id is the endpoint's, so its echo is neutralized and bounded as
  // other endpoint text is: JSON escapes the lone surrogate but leaves the
  // CSI introducer U+009B.
  host.responses['GET /v1/agents/sessions'] = {
    data: [{ id: `\u009b2K${'a'.repeat(300)}\uD800` }],
  };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  assert.equal(
    rowsOf(host.output).session,
    `FAIL the API answered a Session whose id "\uFFFD2K${'a'.repeat(196)}… (311 characters) names no route`,
  );
  // An event ends the turn only when the API marks it terminal.
  host.responses['GET /v1/agents/sessions'] = { data: [{ id: 's1' }] };
  host.responses['POST /v1/agents/sessions'] = { id: 's1' };
  host.responses['GET /v1/agents/sessions/s1/events'] = {
    data: [{ sequence: 1, type: 'turn.completed', terminal: 'false' }],
  };
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
    'FAIL Session s1: no terminal event within 3s',
  );
});

test('verify refuses a URL fetch refuses before it probes', async (t) => {
  const { host, target } = await backedUp(t);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  host.responses['GET /actuator/health'] = { status: 'UP' };
  assert.equal(await host.upgrade('start'), 0);
  // verify reaches listeners() with reachesHarness:false; the URL refusal must
  // still run before any probe. Gating that loop on reachesHarness would let
  // verify wait out --timeout and report a health row instead of refusing.
  const probes = host.requests.length;
  assert.equal(
    await host.upgrade(
      'verify',
      '--server-url',
      'http://127.0.0.1:6000',
      '--timeout',
      '9',
    ),
    1,
  );
  assert.match(
    host.output.join('\n'),
    /verify refused: --server-url "http:\/\/127\.0\.0\.1:6000" is on port 6000, so fetch refuses to dial it\./,
  );
  assert.equal(host.requests.length, probes, 'verify refused before probing');
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
  // --turn says it ran no Turn, rather than leaving the row out.
  assert.equal(await host.upgrade('verify', '--tenant', 'acme', '--turn'), 0);
  assert.equal(
    rowsOf(host.output).turn,
    'SKIP no Turn without the Session read above',
  );
  // verify reads no API under signed auth, so an API port fetch would refuse
  // is no reason to refuse it; the health endpoint is checked all the same.
  host.resolved = {
    serverUrl: 'http://127.0.0.1:6000',
    healthUrl: 'http://127.0.0.1:9091/actuator/health',
  };
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 0);
  assert.equal(
    rowsOf(host.output).health,
    'PASS http://127.0.0.1:9091/actuator/health is UP',
  );
  assert.match(
    rowsOf(host.output).session,
    /^SKIP the API takes signed requests only/,
  );
  assert.ok(!host.requests.some(({ url }) => url.includes('/v1/')));
  host.resolved.healthUrl = 'http://127.0.0.1:6000/actuator/health';
  assert.equal(await host.upgrade('verify', '--tenant', 'acme'), 1);
  assert.match(
    host.output.at(-1),
    /^verify refused: The server's configuration puts the health endpoint at "http:\/\/127\.0\.0\.1:6000\/actuator\/health", which is on port 6000/,
  );
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

  // The same build, but its operator file is not the installed one.
  await rm(release, { recursive: true });
  await cp(host.distribution, release, { recursive: true });
  const config = path.join(release, 'config/application.yml');
  await writeFile(config, 'key: y\n');
  assert.equal(await host.upgrade('install', '--backup', target), 1);
  // The paths as the command resolves them, which a symlinked TMPDIR changes.
  assert.match(
    host.output.at(-1),
    /^install refused: \S+-releases\/0\.2\.0\/config\/application\.yml differs from \S+\/qwen-managed-agent\/config\/application\.yml; reconcile them and run install again\.$/,
  );
  assert.ok((await lstat(host.current)).isDirectory());
  assert.equal(await readFile(config, 'utf8'), 'key: y\n');

  // The archive extracted there is this build, and is used. Extracted with
  // modes only root reads, it is made readable as a copy would be, except
  // for a file no release lists.
  await writeFile(config, 'key: x\n');
  await chmod(path.join(release, 'lib'), 0o700);
  await chmod(path.join(release, 'lib/server.jar'), 0o600);
  await chmod(path.join(release, 'bin/qwen-managed-agent-server'), 0o700);
  await writeFile(path.join(release, 'config/extra.yml'), 'k: v\n', {
    mode: 0o600,
  });
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  assert.ok(host.output.includes(`Using ${release}`));
  assert.ok(!host.output.includes('Copied config/application.yml'));
  assert.equal(await readlink(host.current), release);
  assert.deepEqual(
    await modesOf(release, [
      'lib',
      'lib/server.jar',
      'bin/qwen-managed-agent-server',
      'config/extra.yml',
    ]),
    [0o755, 0o644, 0o755, 0o600],
  );
});

test('install lets the service account read a release it runs from', async (t) => {
  const { host, target } = await backedUp(t);
  // Extracted where install puts it, with modes only root reads, and run
  // from there.
  const release = path.join(`${host.current}-releases`, '0.2.0');
  await mkdir(path.dirname(release));
  await cp(host.distribution, release, { recursive: true });
  host.system.distribution = await realpath(release);
  await chmod(path.join(release, 'lib'), 0o700);
  await chmod(path.join(release, 'lib/server.jar'), 0o600);
  await chmod(path.join(release, 'bin/qwen-managed-agent-server'), 0o700);
  assert.equal(await host.upgrade('install', '--backup', target), 0);
  assert.ok(host.output.includes(`Using ${release}`), host.output.join('\n'));
  assert.equal(await readlink(host.current), release);
  assert.deepEqual(
    await modesOf(release, [
      'lib',
      'lib/server.jar',
      'bin/qwen-managed-agent-server',
    ]),
    [0o755, 0o644, 0o755],
  );
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

  // A crash between moving the directory and renaming the link over it,
  // beside an operator's link that install would not have named.
  await cp(host.distribution, path.join(releases, '0.2.0'), {
    recursive: true,
  });
  await rename(host.current, path.join(releases, '0.1.0'));
  const link = `${host.current}.upgrade-0000abcd`;
  await symlink(path.join(releases, '0.2.0'), link);
  await symlink(releases, `${host.current}.upgrade-backup`);
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

test('install refuses a copy that does not match SHA256SUMS', async (t) => {
  const { host, target } = await backedUp(t);
  const releases = `${host.current}-releases`;
  // The extraction changes after check verified it, as on a failing disk.
  const { out } = host.system;
  host.system.out = (line) => {
    out(line);
    if (line.startsWith('Copying ')) {
      writeFileSync(
        path.join(host.distribution, 'bin/qwen-managed-agent-server'),
        'damaged\n',
      );
    }
  };
  assert.equal(await host.upgrade('install', '--backup', target), 1);
  assert.match(
    host.output.at(-1),
    /^install refused: The copy at \S+\/\.0\.2\.0\.partial-[0-9a-f]{8} does not match SHA256SUMS \(bin\/qwen-managed-agent-server\)\.$/,
  );
  assert.deepEqual(await readdir(releases), []);
  assert.ok((await lstat(host.current)).isDirectory());
});

test('install removes what an interrupted install left', async (t) => {
  const { host, target } = await backedUp(t);
  const releases = `${host.current}-releases`;
  const release = path.join(releases, '0.2.0');
  // Copies killed halfway, of this release and of another.
  await mkdir(path.join(releases, '.0.2.0.partial-0000abcd/lib'), {
    recursive: true,
  });
  await mkdir(path.join(releases, '.0.1.9.partial-1111abcd'));
  // A link made before anything moved, beside an operator's file and links
  // named alike.
  await symlink(release, `${host.current}.upgrade-2222abcd`);
  await writeFile(`${host.current}.upgrade-notes`, 'mine\n');
  const theirs = [
    `${host.current}.upgrade-backup`,
    `${host.current}.upgrade-2222abcd.old`,
    `${host.current}.upgrade-2222abcde`,
  ];
  for (const each of theirs) {
    await symlink(releases, each);
  }
  // The release, with a configuration file killed before its rename.
  await cp(host.distribution, release, { recursive: true });
  await writeFile(
    path.join(release, 'config/application.yml.tmp-3333abcd'),
    'key: x\n',
  );
  const left = [
    path.join(releases, '.0.1.9.partial-1111abcd'),
    path.join(releases, '.0.2.0.partial-0000abcd'),
    `${host.current}.upgrade-2222abcd`,
    path.join(release, 'config/application.yml.tmp-3333abcd'),
  ];
  assert.equal(await host.check(), 0);
  assert.ok(
    rowsOf(host.output).layout.endsWith(
      `, after removing what an interrupted install left: ${left.join(', ')}`,
    ),
    rowsOf(host.output).layout,
  );

  assert.equal(await host.upgrade('install', '--backup', target), 0);
  for (const each of left) {
    assert.ok(
      host.output.includes(
        `Removed ${each}, which an interrupted install left`,
      ),
      each,
    );
    await assert.rejects(lstat(each), { code: 'ENOENT' });
  }
  // The link went, not the release it named; the operator's entries stay.
  assert.equal(await readlink(host.current), release);
  assert.equal(
    await readFile(`${host.current}.upgrade-notes`, 'utf8'),
    'mine\n',
  );
  for (const each of theirs) {
    assert.equal(await readlink(each), releases, each);
  }
  assert.deepEqual((await readdir(path.join(release, 'config'))).sort(), [
    'application.example.yml',
    'application.yml',
  ]);
});

test('install keeps the link when it can neither switch nor undo', async (t) => {
  const { host, target } = await backedUp(t);
  const { rename: original } = fsPromises;
  t.after(() => {
    fsPromises.rename = original;
    syncBuiltinESMExports();
  });
  // Moving the directory away works; nothing then renames onto its path.
  fsPromises.rename = async (from, to) => {
    if (to === host.current) {
      throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  assert.equal(await host.upgrade('install', '--backup', target), 1);
  const [, link] = /mv -T (\S+) /.exec(host.output.at(-1));
  assert.match(
    host.output.at(-1),
    /^install refused: \S+\.upgrade-[0-9a-f]{8} did not replace \S+ \(EIO: injected\), and \S+\/0\.1\.0 did not move back \(EIO: injected\); finish the install with mv -T \S+ \S+, or undo it with mv -T \S+ \S+\.$/,
  );
  assert.equal(await readlink(link), `${host.current}-releases/0.2.0`);
  fsPromises.rename = original;
  syncBuiltinESMExports();

  // check finds the link the install left and says the same.
  assert.equal(await host.check(), 1);
  assert.equal(
    rowsOf(host.output).deployment,
    `FAIL ${host.current} is missing and ${link} is left from an interrupted install`,
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
  // A stop that ended an ExecStartPost= command fails with the signal even
  // when the JVM exited 143, as measured on systemd 257.
  const post = await rig(t);
  post.stopFails = true;
  const stopPost = post.system.run;
  post.system.run = (command, args, options) => {
    const result = stopPost(command, args, options);
    if (command === 'systemctl' && args[0] === 'stop') {
      post.units[SERVER].Result = 'signal';
    }
    return result;
  };
  assert.equal(await post.upgrade('stop'), 0);
  assert.equal(
    post.output.at(-1),
    `${SERVER} shows as failed (signal, status 143); see journalctl -u ${SERVER}. start runs it again.`,
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
  assert.match(
    rows.health,
    /^FAIL http:\/\/127\.0\.0\.1:18080\/actuator\/health is not UP: .*timeout/i,
  );
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
