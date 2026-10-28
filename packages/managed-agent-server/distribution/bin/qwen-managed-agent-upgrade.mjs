#!/usr/bin/env node
/* global AbortSignal, Buffer, URL, console, fetch, process, setTimeout */

/**
 * Upgrades a systemd deployment of the reference distribution in phases.
 *
 * Run every phase as root from the extracted new distribution, in order:
 * check, stop, backup, install, start and verify. Each phase reads the units,
 * their environment and the installed release again, and refuses unless the
 * previous phase left the deployment as it expects, so an interrupted upgrade
 * resumes at the phase that failed. Stopping ingress and installing Qwen Code
 * stay with the operator; check prints where they fall.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, createReadStream, realpathSync } from 'node:fs';
import {
  access,
  chmod,
  chown,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inflateRawSync } from 'node:zlib';

export const PHASES = ['check', 'stop', 'backup', 'install', 'start', 'verify'];
const SERVER_UNIT = 'qwen-managed-agent-server';
const HARNESS_UNIT = 'qwen-hosted-harness';
const SERVER_LAUNCHER = 'bin/qwen-managed-agent-server';
// The units name their templates' files whatever the installed unit is called.
const UNIT_TEMPLATES = {
  server: 'systemd/qwen-managed-agent-server.service',
  harness: 'systemd/qwen-hosted-harness.service',
};
// What a system service gets when its unit sets no PATH.
const SYSTEMD_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const BACKUP_FILE = 'backup.json';
const DEFAULT_TIMEOUT_SECONDS = { stop: 60, start: 300, verify: 300 };
const SHOW_PROPERTIES = [
  'LoadState',
  'ActiveState',
  'ExecStart',
  'EnvironmentFiles',
  'Environment',
  'User',
  'WorkingDirectory',
  'ControlGroup',
  'FragmentPath',
  'DropInPaths',
  'ActiveEnterTimestampMonotonic',
  'InactiveEnterTimestampMonotonic',
];

const USAGE = `Usage: qwen-managed-agent-upgrade <phase> [options]

Run each phase as root from the new distribution, in this order:
  check                    compare this distribution with the installed one
  stop                     stop the control plane, its Runtime workers and the Harness
  backup --to <dir>        dump MySQL and archive the Runtime state and configuration
  install --backup <dir>   install this release and switch the distribution link
  start                    start the Harness, run --check, start the control plane
  verify [--tenant <id>] [--turn]
                           run --check --online and read the API

Options:
  --server-unit <name>     control-plane unit (default ${SERVER_UNIT})
  --harness-unit <name>    Hosted Harness unit (default ${HARNESS_UNIT})
  --releases <dir>         release directory (default <distribution link>-releases)
  --mysqldump <path>       check, backup: mysqldump to run (default mysqldump)
  --skip-database          check, backup: the database is backed up another way
  --runtime-state <dir>    check, backup: the Runtime state directory, when not
                           only QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY sets it
  --server-url <url>       start, verify: control-plane URL (default from server.env)
  --timeout <seconds>      stop, start, verify: how long to wait
  --turn                   verify: create a Session and run one Turn, which calls the model`;

class Refusal extends Error {}

// ---------------------------------------------------------------------------
// Parsing

const WHITESPACE = ' \t\n\r';
const NEWLINE = '\n\r';
// Inside double quotes a backslash escapes only these; before any other
// character it stays, as in the shell.
const DOUBLE_QUOTE_ESCAPES = '"\\`$';

/**
 * Reads a systemd EnvironmentFile with systemd's own grammar, the state
 * machine of parse_env_file_internal() in src/basic/env-file.c.
 */
export function parseEnvironmentFile(text) {
  const values = new Map();
  let state = 'pre-key';
  let key = '';
  let value = '';
  // Where trailing whitespace starts, or -1.
  let keyEnd = -1;
  let valueEnd = -1;
  const push = (chomp) => {
    const name = keyEnd >= 0 ? key.slice(0, keyEnd) : key;
    const content = chomp && valueEnd >= 0 ? value.slice(0, valueEnd) : value;
    // systemd skips, with a warning, a name a shell could not export.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      values.set(name, content);
    }
    key = '';
    value = '';
  };
  for (const character of text) {
    switch (state) {
      case 'pre-key':
        if (character === '#' || character === ';') {
          state = 'comment';
        } else if (!WHITESPACE.includes(character)) {
          state = 'key';
          key = character;
          keyEnd = -1;
        }
        break;
      case 'key':
        if (NEWLINE.includes(character)) {
          state = 'pre-key';
          key = '';
        } else if (character === '=') {
          state = 'pre-value';
          value = '';
          valueEnd = -1;
        } else {
          if (!WHITESPACE.includes(character)) {
            keyEnd = -1;
          } else if (keyEnd < 0) {
            keyEnd = key.length;
          }
          key += character;
        }
        break;
      case 'pre-value':
        if (NEWLINE.includes(character)) {
          state = 'pre-key';
          push(false);
        } else if (character === "'") {
          state = 'single-quote';
        } else if (character === '"') {
          state = 'double-quote';
        } else if (character === '\\') {
          state = 'value-escape';
        } else if (!WHITESPACE.includes(character)) {
          state = 'value';
          value += character;
        }
        break;
      case 'value':
        if (NEWLINE.includes(character)) {
          state = 'pre-key';
          push(true);
        } else if (character === '\\') {
          state = 'value-escape';
          valueEnd = -1;
        } else {
          if (!WHITESPACE.includes(character)) {
            valueEnd = -1;
          } else if (valueEnd < 0) {
            valueEnd = value.length;
          }
          value += character;
        }
        break;
      case 'value-escape':
        // An escaped newline continues the line.
        state = 'value';
        if (!NEWLINE.includes(character)) {
          value += character;
        }
        break;
      case 'single-quote':
        if (character === "'") {
          state = 'pre-value';
        } else {
          value += character;
        }
        break;
      case 'double-quote':
        if (character === '"') {
          state = 'pre-value';
        } else if (character === '\\') {
          state = 'double-quote-escape';
        } else {
          value += character;
        }
        break;
      case 'double-quote-escape':
        state = 'double-quote';
        if (DOUBLE_QUOTE_ESCAPES.includes(character)) {
          value += character;
        } else if (character !== '\n') {
          value += `\\${character}`;
        }
        break;
      case 'comment':
        if (character === '\\') {
          state = 'comment-escape';
        } else if (NEWLINE.includes(character)) {
          state = 'pre-key';
        }
        break;
      case 'comment-escape':
        state = NEWLINE.includes(character) ? 'pre-key' : 'comment';
        break;
      default:
        throw new Error(`unknown state ${state}`);
    }
  }
  // The last assignment needs no newline, and an open quote runs to the end.
  if (!['pre-key', 'key', 'comment', 'comment-escape'].includes(state)) {
    push(state === 'value');
  }
  return values;
}

/** Splits `systemctl show` output; a property listed more than once keeps every value. */
export function parseShow(text) {
  const properties = new Map();
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const values = properties.get(key) ?? [];
    values.push(line.slice(separator + 1));
    properties.set(key, values);
  }
  return properties;
}

export function execStartPath(value) {
  return /(?:^|[{;]\s*)path=([^\s;]+)/.exec(value ?? '')?.[1];
}

/** `/etc/x.env (ignore_errors=no)` → { path, optional } */
export function environmentFileEntry(value) {
  const match = /^(.*) \(ignore_errors=(yes|no)\)$/.exec(value);
  return match
    ? { path: match[1], optional: match[2] === 'yes' }
    : { path: value, optional: false };
}

/** Splits `Environment=` as `systemctl show` prints it: `"A=1 2" B=x`. */
export function parseEnvironmentAssignments(value) {
  const values = new Map();
  let current = '';
  let quoted = false;
  let started = false;
  const flush = () => {
    const separator = current.indexOf('=');
    if (started && separator > 0) {
      values.set(current.slice(0, separator), current.slice(separator + 1));
    }
    current = '';
    started = false;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length) {
      const next = value[index + 1];
      if (
        next === 'x' &&
        /^[0-9a-fA-F]{2}$/.test(value.slice(index + 2, index + 4))
      ) {
        current += String.fromCharCode(
          parseInt(value.slice(index + 2, index + 4), 16),
        );
        index += 3;
      } else {
        current += next;
        index += 1;
      }
      started = true;
    } else if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(character) && !quoted) {
      flush();
    } else {
      current += character;
      started = true;
    }
  }
  flush();
  return values;
}

/** Semantic-version precedence, prerelease identifiers included. */
export function compareVersions(left, right) {
  const parse = (version) => {
    const match =
      /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        version,
      );
    if (!match) {
      throw new Error(`${JSON.stringify(version)} is not a semantic version.`);
    }
    return {
      core: match.slice(1, 4).map(BigInt),
      prerelease: match[4] ? match[4].split('.') : [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] < b.core[index] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  for (let index = 0; ; index += 1) {
    if (index === a.prerelease.length || index === b.prerelease.length) {
      return Math.sign(a.prerelease.length - b.prerelease.length);
    }
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    const numeric = [x, y].map((part) => /^\d+$/.test(part));
    if (numeric[0] && numeric[1]) {
      if (BigInt(x) !== BigInt(y)) {
        return BigInt(x) < BigInt(y) ? -1 : 1;
      }
    } else if (numeric[0] !== numeric[1]) {
      return numeric[0] ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
}

/** True, false, or undefined when the range is not a plain `>=` bound. */
export function meetsMinimum(range, version) {
  const bound = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(range ?? '');
  const actual = /(\d+(?:\.\d+){0,2})/.exec(version ?? '');
  if (!bound || !actual) {
    return undefined;
  }
  const wanted = bound[1].split('.').map(Number);
  const have = actual[1].split('.').map(Number);
  for (let index = 0; index < wanted.length; index += 1) {
    if ((have[index] ?? 0) !== wanted[index]) {
      return (have[index] ?? 0) > wanted[index];
    }
  }
  return true;
}

/** `java -version` output → the feature release, reading 1.8 as 8. */
export function javaFeatureVersion(output) {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output ?? '');
  if (!match) {
    return undefined;
  }
  return match[1] === '1' && match[2] ? match[2] : match[1];
}

/** `jdbc:mysql://host[:port]/database[?…]` for one host, or undefined. */
export function parseMysqlJdbcUrl(url) {
  const match =
    /^jdbc:mysql:\/\/(\[[^\]]+\]|[^/:?,@[\]]+)(?::(\d+))?\/([^/?#]+)(?:\?.*)?$/.exec(
      url ?? '',
    );
  if (!match) {
    return undefined;
  }
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: match[2] ?? '3306',
    database: decodeURIComponent(match[3]),
  };
}

function optionFileValue(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * The files Spring reads for SPRING_CONFIG_ADDITIONAL_LOCATION, and the
 * entries that are not files this command can read.
 */
export function configurationFiles(value) {
  const files = [];
  const unread = [];
  for (const entry of (value ?? '').split(',')) {
    const location = entry.trim().replace(/^optional:/, '');
    if (!location) {
      continue;
    }
    if (!location.startsWith('file:')) {
      unread.push(location);
    } else if (location.endsWith('/')) {
      // A directory location: the default names within it.
      files.push(
        ...[
          'application.properties',
          'application.yaml',
          'application.yml',
        ].map((name) => path.join(location.slice('file:'.length), name)),
      );
    } else {
      files.push(location.slice('file:'.length));
    }
  }
  return { files, unread };
}

export function serverBaseUrl(environment) {
  let host =
    environment.get('QWEN_MANAGED_AGENT_SERVER_ADDRESS') || '127.0.0.1';
  if (host === '0.0.0.0') {
    host = '127.0.0.1';
  } else if (host === '::' || host === '[::]') {
    host = '::1';
  }
  if (host.includes(':') && !host.startsWith('[')) {
    host = `[${host}]`;
  }
  return `http://${host}:${environment.get('SERVER_PORT') || '8080'}`;
}

// ---------------------------------------------------------------------------
// Host access

export function createSystem() {
  return {
    uid: () => process.getuid?.(),
    run: (command, args, options = {}) =>
      spawnSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options,
      }),
    fetch: (url, init) => fetch(url, init),
    connect: (host, port) =>
      new Promise((resolve) => {
        const socket = net.connect({ host, port });
        socket.setTimeout(2000);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('error', () => resolve(false));
      }),
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
    bootId: async () =>
      (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    cgroupRoot: '/sys/fs/cgroup',
    // The distribution this script came from: the release being installed.
    distribution: path.dirname(
      path.dirname(realpathSync(fileURLToPath(import.meta.url))),
    ),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

function runChecked(system, command, args, options) {
  const result = system.run(command, args, options);
  if (result.error) {
    throw new Refusal(`${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const reason =
      String(result.stderr ?? '').trim() || `exit ${result.status}`;
    throw new Refusal(`${command} ${args.join(' ')}: ${reason}`);
  }
  return result;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function which(name, searchPath) {
  const candidates = name.includes('/')
    ? [name]
    : (searchPath || SYSTEMD_PATH)
        .split(':')
        .filter(Boolean)
        .map((directory) => path.join(directory, name));
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Files a distribution's SHA256SUMS lists, and the ones that differ. */
export async function verifyChecksums(root) {
  const text = await readFile(path.join(root, 'SHA256SUMS'), 'utf8');
  const listed = [];
  const failed = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (
      !match ||
      path.isAbsolute(match[2]) ||
      match[2].split('/').includes('..')
    ) {
      failed.push(line);
      continue;
    }
    listed.push(match[2]);
    const file = path.join(root, match[2]);
    if (!(await isFile(file)) || (await sha256(file)) !== match[1]) {
      failed.push(match[2]);
    }
  }
  return { listed, failed };
}

// Mirrors the owner and mode, so a 0600 file stays the account's own.
async function copyPreserving(source, destination) {
  const temporary = `${destination}.tmp-${randomBytes(4).toString('hex')}`;
  const { mode, uid, gid } = await stat(source);
  await copyFile(source, temporary, constants.COPYFILE_EXCL);
  try {
    await chown(temporary, uid, gid);
    await chmod(temporary, mode & 0o7777);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The deployment

async function showUnit(system, name) {
  const result = runChecked(system, 'systemctl', [
    'show',
    name,
    ...SHOW_PROPERTIES.flatMap((property) => ['-p', property]),
  ]);
  const properties = parseShow(result.stdout);
  const first = (key) => properties.get(key)?.[0] ?? '';
  return {
    name,
    loaded: first('LoadState') === 'loaded',
    activeState: first('ActiveState'),
    execStart: first('ExecStart'),
    execPath: execStartPath(first('ExecStart')),
    environmentFiles: (properties.get('EnvironmentFiles') ?? [])
      .filter(Boolean)
      .map(environmentFileEntry),
    assignments: parseEnvironmentAssignments(first('Environment')),
    user: first('User'),
    workingDirectory: first('WorkingDirectory'),
    controlGroup: first('ControlGroup'),
    unitFiles: [
      first('FragmentPath'),
      ...first('DropInPaths').split(/\s+/),
    ].filter(Boolean),
    activeEnter: first('ActiveEnterTimestampMonotonic'),
    inactiveEnter: first('InactiveEnterTimestampMonotonic'),
  };
}

// Environment files override Environment=, later files earlier ones.
async function unitEnvironment(unit) {
  const environment = new Map(unit.assignments);
  const missing = [];
  for (const entry of unit.environmentFiles) {
    let text;
    try {
      text = await readFile(entry.path, 'utf8');
    } catch {
      if (!entry.optional) {
        missing.push(entry.path);
      }
      continue;
    }
    for (const [key, value] of parseEnvironmentFile(text)) {
      environment.set(key, value);
    }
  }
  return { environment, missing };
}

async function processesOf(system, unit) {
  if (!unit.controlGroup) {
    return [];
  }
  try {
    const text = await readFile(
      path.join(system.cgroupRoot, unit.controlGroup, 'cgroup.procs'),
      'utf8',
    );
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function readManifest(root) {
  try {
    return await readJson(path.join(root, 'manifest.json'));
  } catch {
    return undefined;
  }
}

// install renames a link over the distribution path; a crash between moving
// a directory away and that rename leaves the link beside the missing path.
async function interruptedInstall(current) {
  const prefix = `${path.basename(current)}.upgrade-`;
  let entries;
  try {
    entries = await readdir(path.dirname(current), { withFileTypes: true });
  } catch {
    return undefined;
  }
  const links = entries.filter(
    (entry) => entry.isSymbolicLink() && entry.name.startsWith(prefix),
  );
  return links.length === 1
    ? path.join(path.dirname(current), links[0].name)
    : undefined;
}

/** Everything a phase reads about the running deployment, read afresh. */
async function inspect(system, options) {
  const { distribution } = system;
  const manifest = await readManifest(distribution);
  const server = await showUnit(system, options.serverUnit);
  const harness = await showUnit(system, options.harnessUnit);
  const deployment = {
    distribution,
    manifest,
    server,
    harness,
    problems: [],
  };
  if (!manifest) {
    deployment.problems.push(`${distribution}/manifest.json is unreadable`);
    deployment.remedy = 'extract the verified archive again';
    return deployment;
  }
  for (const unit of [server, harness]) {
    if (!unit.loaded) {
      deployment.problems.push(`${unit.name} is not a loaded unit`);
    }
  }
  if (!server.execPath?.endsWith(`/${SERVER_LAUNCHER}`)) {
    deployment.problems.push(
      `${server.name} does not start ${SERVER_LAUNCHER} from a distribution`,
    );
    return deployment;
  }
  deployment.current = path.dirname(path.dirname(server.execPath));
  deployment.releases = options.releases ?? `${deployment.current}-releases`;
  try {
    const link = await lstat(deployment.current);
    deployment.currentIsLink = link.isSymbolicLink();
    deployment.currentTarget = await realpath(deployment.current);
  } catch {
    const link = await interruptedInstall(deployment.current);
    if (link) {
      deployment.problems.push(
        `${deployment.current} is missing and ${link} is left from an interrupted install`,
      );
      deployment.remedy = `finish the install with mv -T ${link} ${deployment.current}, then run start`;
    } else {
      deployment.problems.push(`${deployment.current} does not exist`);
    }
    return deployment;
  }
  deployment.installed = await readManifest(deployment.current);
  if (!deployment.installed) {
    deployment.problems.push(
      `${deployment.current}/manifest.json is unreadable`,
    );
  }
  const serverEnvironment = await unitEnvironment(server);
  const harnessEnvironment = await unitEnvironment(harness);
  deployment.serverEnvironment = serverEnvironment.environment;
  deployment.harnessEnvironment = harnessEnvironment.environment;
  for (const file of [
    ...serverEnvironment.missing,
    ...harnessEnvironment.missing,
  ]) {
    deployment.problems.push(`environment file ${file} is unreadable`);
  }
  const credentialsFile = deployment.serverEnvironment.get(
    'QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE',
  );
  if (credentialsFile) {
    deployment.credentialsFile = credentialsFile;
    try {
      deployment.credentials = parseEnvironmentFile(
        await readFile(credentialsFile, 'utf8'),
      );
    } catch {
      deployment.problems.push(
        `credentials file ${credentialsFile} is unreadable`,
      );
    }
  }
  return deployment;
}

/** Operator files in the installed release's config/, which the release itself does not list. */
async function operatorConfigFiles(root) {
  const directory = path.join(root, 'config');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { files: [], others: [] };
  }
  let listed = new Set(['config/application.example.yml']);
  try {
    listed = new Set(
      (await readFile(path.join(root, 'SHA256SUMS'), 'utf8'))
        .split('\n')
        .map((line) => /^[0-9a-f]{64} [ *](.+)$/.exec(line)?.[1])
        .filter(Boolean),
    );
  } catch {
    // An archive without SHA256SUMS: only the template is the release's.
  }
  const files = [];
  const others = [];
  for (const entry of entries) {
    if (listed.has(`config/${entry.name}`)) {
      continue;
    }
    (entry.isFile() ? files : others).push(entry.name);
  }
  return { files: files.sort(), others: others.sort() };
}

// ---------------------------------------------------------------------------
// Rows

const row = (name, status, detail, fix) => ({ name, status, detail, fix });

function printRows(system, title, rows) {
  system.out(title);
  system.out(`${'STATUS'.padEnd(6)} ${'CHECK'.padEnd(14)} DETAIL`);
  for (const { name, status, detail, fix } of rows) {
    system.out(`${status.padEnd(6)} ${name.padEnd(14)} ${detail}`);
    if (fix) {
      system.out(`${''.padEnd(6)} ${''.padEnd(14)} fix: ${fix}`);
    }
  }
  const count = (status) =>
    rows.filter((each) => each.status === status).length;
  system.out(
    `${rows.length} check(s), ${count('WARN')} warning(s), ${count('FAIL')} failure(s)`,
  );
}

const failed = (rows) => rows.some((each) => each.status === 'FAIL');

function versionOutput(system, command, args, searchPath) {
  const result = system.run(command, args, {
    env: { PATH: searchPath || SYSTEMD_PATH },
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

// Flyway's versioned, undo and repeatable prefixes are case-sensitive; its
// suffix is not.
const MIGRATION_SCRIPT = /^BOOT-INF\/classes\/(db\/.+\/[VUR][^/]*__[^/]*)$/;

/** The Flyway scripts in a Spring Boot jar, by path, as SHA-256 digests. */
export async function migrationScripts(jar) {
  const handle = await open(jar, 'r');
  const read = async (length, position) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) {
      throw new Error(`${jar} ends early`);
    }
    return buffer;
  };
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await read(tailLength, size - tailLength);
    const end = tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
    if (end < 0) {
      throw new Error(`${jar} is not a zip archive`);
    }
    const count = tail.readUInt16LE(end + 10);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || offset === 0xffffffff) {
      throw new Error(`${jar} is a ZIP64 archive`);
    }
    const directory = await read(tail.readUInt32LE(end + 12), offset);
    const scripts = new Map();
    for (let at = 0, index = 0; index < count; index += 1) {
      if (directory.readUInt32LE(at) !== 0x02014b50) {
        throw new Error(`${jar} has a damaged central directory`);
      }
      const method = directory.readUInt16LE(at + 10);
      const length = directory.readUInt32LE(at + 20);
      const nameLength = directory.readUInt16LE(at + 28);
      const local = directory.readUInt32LE(at + 42);
      const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
      at +=
        46 +
        nameLength +
        directory.readUInt16LE(at + 30) +
        directory.readUInt16LE(at + 32);
      const script = MIGRATION_SCRIPT.exec(name)?.[1];
      if (!script || !script.toLowerCase().endsWith('.sql')) {
        continue;
      }
      const header = await read(30, local);
      const data = await read(
        length,
        local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28),
      );
      if (method !== 0 && method !== 8) {
        throw new Error(`${name} in ${jar} uses compression method ${method}`);
      }
      const content = method === 8 ? inflateRawSync(data) : data;
      scripts.set(script, createHash('sha256').update(content).digest('hex'));
    }
    return scripts;
  } finally {
    await handle.close();
  }
}

function controlPlaneJar(root, manifest) {
  const component = manifest?.components?.find(
    (each) => each.role === 'control-plane',
  );
  if (!component) {
    throw new Error(`${root}/manifest.json names no control-plane jar`);
  }
  return path.join(root, component.path);
}

// Flyway applies only scripts the database has not seen, and the server
// refuses a schema it no longer matches. Until the first formal release a
// release may rewrite its baseline in place, so the scripts are compared by
// content, not by the version the manifests name.
async function databaseRow({
  currentTarget,
  distribution,
  installed,
  manifest,
}) {
  let before;
  let after;
  try {
    [before, after] = await Promise.all(
      [
        controlPlaneJar(currentTarget, installed),
        controlPlaneJar(distribution, manifest),
      ].map(async (jar) => {
        const scripts = await migrationScripts(jar);
        // No server ships without its schema, so none found is a misread.
        if (scripts.size === 0) {
          throw new Error(`no Flyway script found in ${jar}`);
        }
        return scripts;
      }),
    );
  } catch (error) {
    return row(
      'database',
      'WARN',
      `cannot compare the Flyway scripts (${error.message}); the first start refuses a database this release cannot serve`,
    );
  }
  // Flyway runs a changed repeatable script again; any other change to a
  // script the database ran, or its removal, fails validation.
  const repeatable = (name) => path.posix.basename(name).startsWith('R');
  const name = (each) => path.posix.basename(each);
  const rewritten = [...before.keys()]
    .filter(
      (each) =>
        !after.has(each) ||
        (!repeatable(each) && after.get(each) !== before.get(each)),
    )
    .map(name);
  if (rewritten.length > 0) {
    return row(
      'database',
      'FAIL',
      `this release changed or removed ${rewritten.join(', ')}, which the installed database ran, so it cannot start on that database`,
      'keep the installed release, or deploy this one on a new, empty database',
    );
  }
  const applied = [...after.keys()]
    .filter((each) => before.get(each) !== after.get(each))
    .map(name);
  return applied.length > 0
    ? row(
        'database',
        'WARN',
        `start applies ${applied.join(', ')}; only the database backup undoes it`,
      )
    : row(
        'database',
        'PASS',
        `the ${after.size} Flyway script(s) did not change`,
      );
}

function versionRow({ current, installed, manifest }) {
  if (installed.name !== manifest.name) {
    return row(
      'version',
      'FAIL',
      `${current} holds ${installed.name}, not ${manifest.name}`,
    );
  }
  let order;
  try {
    order = compareVersions(manifest.version, installed.version);
  } catch (error) {
    return row('version', 'FAIL', error.message);
  }
  if (order > 0) {
    return row(
      'version',
      'PASS',
      `${installed.version} -> ${manifest.version}`,
    );
  }
  return order === 0
    ? row(
        'version',
        'FAIL',
        `${manifest.version} is already installed`,
        'run start or verify for this release',
      )
    : row(
        'version',
        'FAIL',
        `${manifest.version} is older than the installed ${installed.version}`,
        'a downgrade restores the backup instead; see docs/deployment.md',
      );
}

// The new release reads the Broker pair from the Harness's environment only.
// The backup must keep the files the old release reads, so this is an edit
// after backup: check warns about it, and start refuses until it is done.
function harnessEnvironmentRow(deployment) {
  const credentials = deployment.credentials ?? deployment.harnessEnvironment;
  const name = deployment.credentialsFile ?? deployment.harness.name;
  if (credentials.has('QWEN_HOSTED_HARNESS_BROKER_ARGS')) {
    return row(
      'harness-env',
      'WARN',
      `${name} sets QWEN_HOSTED_HARNESS_BROKER_ARGS, which this release no longer reads`,
      'after backup, replace it with QWEN_MANAGED_RUNTIME_BROKER_URL and QWEN_MANAGED_RUNTIME_BROKER_TOKEN',
    );
  }
  if (
    deployment.credentials?.has('QWEN_MANAGED_RUNTIME_BROKER_TOKEN') &&
    deployment.serverEnvironment.has('QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN')
  ) {
    return row(
      'harness-env',
      'WARN',
      `both ${name} and ${deployment.server.name} set the Broker token, which this release refuses`,
      `after backup, delete QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN from ${deployment.server.name}'s environment`,
    );
  }
  return row('harness-env', 'PASS', `${name} uses the current Broker settings`);
}

/** The rows that decide whether this distribution can replace the installed one. */
export async function compatibilityRows(system, deployment) {
  const rows = [];
  const { manifest } = deployment;
  const sums = await verifyChecksums(deployment.distribution).catch(() => ({
    listed: [],
    failed: ['SHA256SUMS'],
  }));
  rows.push(
    sums.failed.length === 0 && sums.listed.includes('manifest.json')
      ? row(
          'distribution',
          'PASS',
          `${sums.listed.length} file(s) match SHA256SUMS`,
        )
      : row(
          'distribution',
          'FAIL',
          `${sums.failed.slice(0, 3).join(', ') || 'manifest.json'} does not match SHA256SUMS`,
          'extract the verified archive again',
        ),
  );
  if (deployment.problems.length > 0) {
    rows.push(
      row(
        'deployment',
        'FAIL',
        deployment.problems.join('; '),
        deployment.remedy ??
          'install the units as systemd/README.md shows, or pass --server-unit and --harness-unit',
      ),
    );
    return rows;
  }
  rows.push(
    row(
      'deployment',
      'PASS',
      `${deployment.server.name} runs ${deployment.current}${deployment.currentIsLink ? ` -> ${deployment.currentTarget}` : ''}`,
    ),
  );

  rows.push(versionRow(deployment));

  rows.push(await databaseRow(deployment));

  const javaPath = which('java', deployment.serverEnvironment.get('PATH'));
  const java = javaPath && versionOutput(system, javaPath, ['-version']);
  const javaVersion = javaFeatureVersion(java);
  const javaRange = manifest.compatibility?.java;
  const javaOk = meetsMinimum(javaRange, javaVersion);
  rows.push(
    javaOk
      ? row('java', 'PASS', `${javaPath} is Java ${javaVersion}, ${javaRange}`)
      : row(
          'java',
          javaOk === undefined && javaVersion ? 'WARN' : 'FAIL',
          javaVersion
            ? `${javaPath} is Java ${javaVersion}; this release needs ${javaRange}`
            : `no java on the control plane's PATH`,
          `install a JDK ${javaRange} first`,
        ),
  );

  const harnessPath = deployment.harnessEnvironment.get('PATH');
  const nodePath = which('node', harnessPath);
  const nodeVersion =
    nodePath && versionOutput(system, nodePath, ['--version']);
  const nodeRange = manifest.compatibility?.node;
  const nodeOk = meetsMinimum(nodeRange, nodeVersion);
  rows.push(
    nodeOk
      ? row('node', 'PASS', `${nodePath} is ${nodeVersion}, ${nodeRange}`)
      : row(
          'node',
          nodeOk === undefined && nodeVersion ? 'WARN' : 'FAIL',
          nodeVersion
            ? `${nodePath} is ${nodeVersion}; this release needs ${nodeRange}`
            : `no node on the Harness's PATH`,
          `install Node.js ${nodeRange} first`,
        ),
  );

  const qwenWanted = manifest.compatibility?.qwenCodeVersion;
  const qwen =
    deployment.harness.execPath &&
    versionOutput(
      system,
      deployment.harness.execPath,
      ['--version'],
      harnessPath,
    );
  rows.push(
    qwen === qwenWanted
      ? row('qwen-code', 'PASS', `${deployment.harness.execPath} is ${qwen}`)
      : row(
          'qwen-code',
          'WARN',
          `${deployment.harness.execPath ?? 'the Harness'} is ${qwen ?? 'unknown'}; this release is built for ${qwenWanted}`,
          `after stop, install Qwen Code ${qwenWanted} for the Harness`,
        ),
  );

  rows.push(harnessEnvironmentRow(deployment));

  const config = await operatorConfigFiles(deployment.currentTarget);
  rows.push(
    config.others.length > 0
      ? row(
          'config',
          'FAIL',
          `${deployment.current}/config holds ${config.others.join(', ')}, which is not a file`,
          'move it out of the distribution and point server.env at it',
        )
      : row(
          'config',
          'PASS',
          config.files.length > 0
            ? `install copies ${config.files.join(', ')} into the new release`
            : `no operator file in ${deployment.current}/config`,
        ),
  );

  const changed = [];
  for (const template of Object.values(UNIT_TEMPLATES)) {
    const [before, after] = await Promise.all(
      [deployment.currentTarget, deployment.distribution].map((root) =>
        readFile(path.join(root, template), 'utf8').catch(() => undefined),
      ),
    );
    if (before !== after) {
      changed.push(template);
    }
  }
  rows.push(
    changed.length > 0
      ? row(
          'unit-files',
          'WARN',
          `${changed.join(', ')} changed in this release; the installed units stay as they are`,
          'before start, carry their changes over to the installed units and run systemctl daemon-reload',
        )
      : row('unit-files', 'PASS', 'the unit templates did not change'),
  );

  rows.push(await layoutRow(deployment));
  return rows;
}

async function layoutRow(deployment) {
  const target = path.join(deployment.releases, deployment.manifest.version);
  const inside = (parent) =>
    deployment.releases === parent ||
    deployment.releases.startsWith(`${parent}${path.sep}`);
  // install copies the new distribution into the releases directory.
  for (const root of [
    deployment.current,
    deployment.currentTarget,
    deployment.distribution,
  ]) {
    if (inside(root)) {
      return row(
        'layout',
        'FAIL',
        `${deployment.releases} is inside the distribution ${root}`,
        'pass --releases outside it',
      );
    }
  }
  const parent = path.dirname(deployment.current);
  const releasesParent = (await exists(deployment.releases))
    ? deployment.releases
    : path.dirname(deployment.releases);
  try {
    const [a, b] = await Promise.all([stat(parent), stat(releasesParent)]);
    if (!deployment.currentIsLink && a.dev !== b.dev) {
      return row(
        'layout',
        'FAIL',
        `${deployment.releases} is on another file system than ${deployment.current}, which install moves into it`,
        'pass --releases on the same file system',
      );
    }
  } catch {
    return row(
      'layout',
      'FAIL',
      `${releasesParent} does not exist`,
      'create it or pass --releases',
    );
  }
  return row(
    'layout',
    'PASS',
    deployment.currentIsLink
      ? `install adds ${target} and switches ${deployment.current} to it`
      : `install moves ${deployment.current} to ${path.join(deployment.releases, deployment.installed.version)} and links it to ${target}`,
  );
}

// ---------------------------------------------------------------------------
// Phases

function requireRoot(system) {
  if (system.uid() !== 0) {
    throw new Refusal(
      'Run the upgrade as root: it manages units and reads their credentials.',
    );
  }
}

function refuseUnless(deployment) {
  if (deployment.problems.length > 0) {
    throw new Refusal(
      [...deployment.problems, deployment.remedy].filter(Boolean).join('; '),
    );
  }
}

async function requireStopped(system, deployment, next) {
  const active = [deployment.server, deployment.harness].filter(
    (unit) => !['inactive', 'failed'].includes(unit.activeState),
  );
  if (active.length > 0) {
    throw new Refusal(
      `${active.map((unit) => unit.name).join(' and ')} still ${active.length > 1 ? 'run' : 'runs'}; run stop before ${next}.`,
    );
  }
  const processes = await processesOf(system, deployment.server);
  if (processes.length > 0) {
    throw new Refusal(
      `Runtime workers of ${deployment.server.name} still run (PID ${processes.join(', ')}); run stop before ${next}.`,
    );
  }
}

function requireInstalled(deployment) {
  if (deployment.installed?.version !== deployment.manifest.version) {
    throw new Refusal(
      `${deployment.current} holds ${deployment.installed?.version ?? 'no release'}, not ${deployment.manifest.version}; run install first.`,
    );
  }
}

const STATE_VARIABLE = 'QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY';
// qwen.managed-agent.runtime-broker.state-directory in the spellings Spring's
// relaxed binding accepts.
const STATE_PROPERTY = /state[-_]?directory/i;
const STATE_ENVIRONMENT_NAME = 'qwen.managedagent.runtimebroker.statedirectory';

/** The configuration files the server's launcher hands to Spring. */
function serverConfigurationFiles(deployment) {
  const locations = deployment.serverEnvironment.get(
    'SPRING_CONFIG_ADDITIONAL_LOCATION',
  );
  // The launcher's default when the variable is unset.
  return locations === undefined
    ? {
        files: [path.join(deployment.currentTarget, 'config/application.yml')],
        unread: [],
      }
    : configurationFiles(locations);
}

/**
 * Where the server keeps its Runtime state. The server's application.yml maps
 * the property to QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY; any other source
 * that sets it wins over that variable, and this command reads none of them,
 * so it names them instead of guessing.
 */
export async function runtimeState(deployment, options) {
  if (options.runtimeState) {
    return { directory: options.runtimeState, source: '--runtime-state' };
  }
  const environment = deployment.serverEnvironment;
  const elsewhere = [];
  for (const [name, value] of environment) {
    if (name.toLowerCase().replaceAll('_', '.') === STATE_ENVIRONMENT_NAME) {
      elsewhere.push(name);
    } else if (
      [
        'JAVA_OPTS',
        'JAVA_TOOL_OPTIONS',
        'JDK_JAVA_OPTIONS',
        'SPRING_APPLICATION_JSON',
      ].includes(name) &&
      STATE_PROPERTY.test(value)
    ) {
      elsewhere.push(name);
    } else if (
      [
        'SPRING_CONFIG_LOCATION',
        'SPRING_CONFIG_IMPORT',
        'SPRING_PROFILES_ACTIVE',
      ].includes(name) &&
      value.trim()
    ) {
      elsewhere.push(`the configuration ${name} selects`);
    }
  }
  if (STATE_PROPERTY.test(deployment.server.execStart)) {
    elsewhere.push(`the arguments of ${deployment.server.name}`);
  }
  const { files, unread } = serverConfigurationFiles(deployment);
  elsewhere.push(
    ...unread.map(
      (entry) => `SPRING_CONFIG_ADDITIONAL_LOCATION entry ${entry}`,
    ),
  );
  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const settings = text
      .split('\n')
      .filter((line) => !/^\s*[#!]/.test(line))
      .join('\n');
    if (STATE_PROPERTY.test(settings)) {
      elsewhere.push(file);
    }
  }
  if (elsewhere.length > 0) {
    return { elsewhere };
  }
  const directory = environment.get(STATE_VARIABLE);
  return directory ? { directory, source: STATE_VARIABLE } : {};
}

async function runtimeStateRow(deployment, options) {
  const state = await runtimeState(deployment, options);
  if (state.elsewhere) {
    return row(
      'runtime-state',
      'FAIL',
      `${state.elsewhere.join(', ')} can set the Runtime state directory, which this command reads only from ${STATE_VARIABLE}`,
      'pass --runtime-state <the directory the server uses> to check and backup',
    );
  }
  if (!state.directory) {
    return row(
      'runtime-state',
      'SKIP',
      `no Runtime state directory is configured, so backup archives none`,
    );
  }
  let directory = false;
  try {
    directory = (await stat(state.directory)).isDirectory();
  } catch {
    // Reported below.
  }
  if (directory) {
    return row(
      'runtime-state',
      'PASS',
      `backup archives ${state.directory} (${state.source})`,
    );
  }
  return state.source === '--runtime-state'
    ? row(
        'runtime-state',
        'FAIL',
        `${state.directory} is not a directory`,
        'pass the directory the server keeps its Runtime state in',
      )
    : row(
        'runtime-state',
        'WARN',
        `${state.directory} (${state.source}) does not exist, so backup archives no Runtime state`,
        `correct ${STATE_VARIABLE} if the server keeps its Runtime state elsewhere`,
      );
}

function backupToolsRow(deployment, options) {
  if (options.skipDatabase) {
    return row(
      'backup-tools',
      'SKIP',
      'backup dumps no database, as --skip-database asks',
    );
  }
  if (
    !parseMysqlJdbcUrl(
      deployment.serverEnvironment.get('SPRING_DATASOURCE_URL'),
    )
  ) {
    return row(
      'backup-tools',
      'FAIL',
      'SPRING_DATASOURCE_URL is not a single-host jdbc:mysql URL',
      'back the database up yourself and pass --skip-database',
    );
  }
  const mysqldump = which(options.mysqldump, process.env.PATH);
  return mysqldump
    ? row('backup-tools', 'PASS', `backup dumps the database with ${mysqldump}`)
    : row(
        'backup-tools',
        'FAIL',
        `${options.mysqldump} is not installed`,
        'install a MySQL client or pass --mysqldump <path>; with another database backup, pass --skip-database',
      );
}

/** The rows that decide whether backup can stand for the deployment. */
async function backupRows(deployment, options) {
  return [
    backupToolsRow(deployment, options),
    await runtimeStateRow(deployment, options),
  ];
}

function shellWord(word) {
  return /^[\w@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The options a phase was given that the printed plan must repeat. */
function planFlags(options, names) {
  const flags = {
    'server-unit':
      options.serverUnit !== SERVER_UNIT ? options.serverUnit : undefined,
    'harness-unit':
      options.harnessUnit !== HARNESS_UNIT ? options.harnessUnit : undefined,
    releases: options.releases,
    mysqldump:
      options.mysqldump !== 'mysqldump' ? options.mysqldump : undefined,
    'skip-database': options.skipDatabase || undefined,
    'runtime-state': options.runtimeState,
    'server-url': options.serverUrl,
  };
  return names
    .filter((name) => flags[name] !== undefined)
    .map((name) =>
      flags[name] === true
        ? ` --${name}`
        : ` --${name} ${shellWord(flags[name])}`,
    )
    .join('');
}

async function phaseCheck(system, deployment, options) {
  const rows = await compatibilityRows(system, deployment);
  const backup =
    deployment.problems.length === 0
      ? await backupRows(deployment, options)
      : [];
  printRows(
    system,
    `Managed Agent upgrade check: ${deployment.installed?.version ?? '?'} -> ${deployment.manifest?.version ?? '?'}`,
    [...rows, ...backup],
  );
  const self = shellWord(
    path.join(deployment.distribution, 'bin/qwen-managed-agent-upgrade'),
  );
  // The steps this command leaves to the operator, where they fall.
  const manual = (name) => {
    const found = rows.find((each) => each.name === name);
    return found && found.status !== 'PASS' && found.fix
      ? [`${found.fix[0].toUpperCase()}${found.fix.slice(1)} (manual).`]
      : [];
  };
  const units = ['server-unit', 'harness-unit'];
  const steps = [
    'Stop new ingress and let admitted work settle (manual).',
    `${self} stop${planFlags(options, [...units, 'releases'])}`,
    `${self} backup --to <new empty directory>${planFlags(options, [...units, 'releases', 'mysqldump', 'skip-database', 'runtime-state'])}`,
    `${self} install --backup <that directory>${planFlags(options, [...units, 'releases'])}`,
    ...manual('qwen-code'),
    ...manual('harness-env'),
    ...manual('unit-files'),
    `${self} start${planFlags(options, [...units, 'server-url'])}`,
    `${self} verify --tenant <tenant> [--turn]${planFlags(options, [...units, 'server-url'])}, then reopen ingress (manual).`,
  ];
  system.out('');
  if (failed(rows)) {
    system.out('stop refuses until the FAIL rows pass. Then the plan is:');
  } else if (failed(backup)) {
    system.out(
      'backup refuses until the FAIL rows pass; pass them before stop. Then the plan is:',
    );
  } else {
    system.out('Plan:');
  }
  steps.forEach((step, index) => system.out(`  ${index + 1}. ${step}`));
  return failed(rows) || failed(backup) ? 1 : 0;
}

async function phaseStop(system, deployment, options) {
  refuseUnless(deployment);
  // Once this release is installed, stop is how a failed start is undone,
  // and the comparison it guards has already been made.
  if (deployment.installed?.version !== deployment.manifest.version) {
    const rows = await compatibilityRows(system, deployment);
    if (failed(rows)) {
      printRows(system, 'Managed Agent upgrade stop refused', rows);
      return 1;
    }
  }
  const { server, harness } = deployment;
  system.out(`Stopping ${server.name}`);
  runChecked(system, 'systemctl', ['stop', server.name]);
  // KillMode=process leaves the Runtime workers in the stopped unit's cgroup.
  let stopped = await showUnit(system, server.name);
  if ((await processesOf(system, stopped)).length > 0) {
    system.out(`Stopping the Runtime workers of ${server.name}`);
    runChecked(system, 'systemctl', [
      'kill',
      '--kill-whom=all',
      '-s',
      'TERM',
      server.name,
    ]);
  }
  const deadline = system.now() + options.timeout * 1000;
  let remaining = await processesOf(system, stopped);
  while (remaining.length > 0 && system.now() < deadline) {
    await system.sleep(500);
    stopped = await showUnit(system, server.name);
    remaining = await processesOf(system, stopped);
  }
  if (remaining.length > 0) {
    throw new Refusal(
      `Runtime workers still run after ${options.timeout}s (PID ${remaining.join(', ')}); stop them with systemctl kill --kill-whom=all -s KILL ${server.name} and run stop again.`,
    );
  }
  system.out(`Stopping ${harness.name}`);
  runChecked(system, 'systemctl', ['stop', harness.name]);
  system.out(
    `Stopped ${server.name}, its Runtime workers and ${harness.name}.`,
  );
  return 0;
}

async function dumpDatabase(system, deployment, options, directory) {
  const environment = deployment.serverEnvironment;
  const database = parseMysqlJdbcUrl(environment.get('SPRING_DATASOURCE_URL'));
  // Outside the backup, which the operator copies elsewhere: a killed dump
  // must not leave the password in it.
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-agent-upgrade-'),
  );
  const credentials = path.join(scratch, 'mysqldump.cnf');
  let handle;
  try {
    await writeFile(
      credentials,
      [
        '[client]',
        `user=${optionFileValue(environment.get('SPRING_DATASOURCE_USERNAME') ?? '')}`,
        `password=${optionFileValue(environment.get('SPRING_DATASOURCE_PASSWORD') ?? '')}`,
        `host=${optionFileValue(database.host)}`,
        `port=${database.port}`,
        '',
      ].join('\n'),
      { mode: 0o600, flag: 'wx' },
    );
    handle = await open(path.join(directory, 'database.sql'), 'wx', 0o600);
    const version = system.run(options.mysqldump, ['--version']);
    system.out(
      `Dumping ${database.database} from ${database.host}:${database.port}`,
    );
    runChecked(
      system,
      options.mysqldump,
      [
        // mysqldump reads this option only in the first position.
        `--defaults-extra-file=${credentials}`,
        '--protocol=TCP',
        '--single-transaction',
        '--routines',
        '--triggers',
        '--hex-blob',
        '--no-tablespaces',
        // MariaDB's mysqldump has no such option; MySQL's otherwise writes a
        // GTID_PURGED that a restore into the same server refuses.
        ...(/MariaDB/i.test(String(version.stdout ?? ''))
          ? []
          : ['--set-gtid-purged=OFF']),
        '--databases',
        database.database,
      ],
      { stdio: ['ignore', handle.fd, 'pipe'] },
    );
  } finally {
    await handle?.close();
    await rm(scratch, { recursive: true, force: true });
  }
  return 'database.sql';
}

/** What a dump is of, without credentials; a backup holds for that database only. */
function datasourceIdentity(environment) {
  const url = environment.get('SPRING_DATASOURCE_URL') ?? '';
  return (
    parseMysqlJdbcUrl(url) ?? {
      urlSha256: createHash('sha256').update(url).digest('hex'),
    }
  );
}

// Where install leaves the installed release.
function previousRelease(deployment) {
  return deployment.currentIsLink
    ? deployment.currentTarget
    : path.join(deployment.releases, deployment.installed.version);
}

/** Paths below a release root, relative to it, or undefined. */
function releasePath(deployment, file) {
  for (const root of [deployment.current, deployment.currentTarget]) {
    const relative = path.relative(root, file);
    if (
      relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      return relative;
    }
  }
  return undefined;
}

async function phaseBackup(system, deployment, options) {
  refuseUnless(deployment);
  await requireStopped(system, deployment, 'backup');
  if (!options.to) {
    throw new Refusal('backup needs --to <new empty directory>.');
  }
  const preconditions = await backupRows(deployment, options);
  for (const each of preconditions) {
    if (each.status === 'FAIL') {
      throw new Refusal(`${each.detail}; ${each.fix}.`);
    }
  }
  const [, stateRow] = preconditions;
  const state = (await runtimeState(deployment, options)).directory;
  const directory = path.resolve(options.to);
  const created = !(await exists(directory));
  if (!created && (await readdir(directory)).length > 0) {
    throw new Refusal(`${directory} is not empty; choose a new directory.`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const files = [];
  const previous = previousRelease(deployment);
  try {
    if (options.skipDatabase) {
      system.out('Skipping the database, as --skip-database asks.');
    } else {
      files.push('database.sql');
      await dumpDatabase(system, deployment, options, directory);
    }

    if (stateRow.status === 'PASS') {
      system.out(`Archiving ${state}`);
      files.push('runtime-state.tar');
      runChecked(system, 'tar', [
        '--create',
        '--numeric-owner',
        '--file',
        path.join(directory, 'runtime-state.tar'),
        '--directory',
        state,
        '.',
      ]);
    }

    const configuration = new Set([
      ...[deployment.server, deployment.harness].flatMap((unit) => [
        ...unit.unitFiles,
        ...unit.environmentFiles.map((entry) => entry.path),
      ]),
      ...serverConfigurationFiles(deployment).files,
      ...(deployment.credentialsFile ? [deployment.credentialsFile] : []),
      path.join(deployment.currentTarget, 'config'),
    ]);
    // Files under the release go in by their path within it: after install
    // the distribution path is a link to the new release, and the old one is
    // at `previous`.
    const outside = [];
    const inside = [];
    for (const file of configuration) {
      if (await exists(file)) {
        const resolved = path.resolve(file);
        const relative = releasePath(deployment, resolved);
        if (relative === undefined) {
          outside.push(resolved.slice(1));
        } else {
          inside.push(relative);
        }
      }
    }
    const covered = (relative) =>
      inside.some(
        (other) =>
          other !== relative && relative.startsWith(`${other}${path.sep}`),
      );
    const release = [...new Set(inside)].filter((each) => !covered(each));
    system.out(
      `Archiving ${outside.length + release.length} configuration path(s)`,
    );
    for (const [name, root, members] of [
      ['configuration.tar', '/', outside],
      ['release-config.tar', deployment.currentTarget, release],
    ]) {
      if (members.length === 0) {
        continue;
      }
      files.push(name);
      runChecked(system, 'tar', [
        '--create',
        '--numeric-owner',
        '--file',
        path.join(directory, name),
        '--directory',
        root,
        ...members,
      ]);
    }

    const record = {
      schemaVersion: 1,
      createdAt: new Date(system.now()).toISOString(),
      bootId: await system.bootId(),
      distribution: deployment.current,
      from: {
        version: deployment.installed.version,
        release: previous,
      },
      to: { version: deployment.manifest.version },
      server: {
        unit: deployment.server.name,
        activeEnter: deployment.server.activeEnter,
        inactiveEnter: deployment.server.inactiveEnter,
      },
      harness: { unit: deployment.harness.name },
      datasource: datasourceIdentity(deployment.serverEnvironment),
      database: options.skipDatabase ? 'skipped' : 'database.sql',
      runtimeState: state ?? null,
      files: [],
    };
    for (const name of files) {
      const file = path.join(directory, name);
      await chmod(file, 0o600);
      record.files.push({
        name,
        size: (await stat(file)).size,
        sha256: await sha256(file),
      });
    }
    // Written last, so a backup that stopped halfway never looks complete.
    await writeFile(
      path.join(directory, BACKUP_FILE),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    for (const name of files) {
      await rm(path.join(directory, name), { force: true });
    }
    if (created) {
      await rmdir(directory).catch(() => {});
    }
    throw error;
  }
  system.out(`Backed up ${files.join(', ')} to ${directory}.`);
  if (stateRow.status !== 'PASS') {
    system.out(`No Runtime state archived: ${stateRow.detail}.`);
  }
  system.out(
    deployment.currentIsLink
      ? `The previous release stays at ${previous}.`
      : `install moves the previous release to ${previous}.`,
  );
  return 0;
}

/** Why a backup cannot stand for the deployment as it is now, or undefined. */
export async function staleBackup(system, deployment, directory) {
  let record;
  try {
    record = await readJson(path.join(directory, BACKUP_FILE));
  } catch {
    return `${directory} holds no completed backup`;
  }
  const installed = deployment.installed?.version;
  if (record.from?.version !== installed) {
    return `the backup is of ${record.from?.version}, but ${installed} is installed`;
  }
  if (record.to?.version !== deployment.manifest.version) {
    return `the backup was taken for ${record.to?.version}, not ${deployment.manifest.version}`;
  }
  // The rollback restores the old release's files to where install put it.
  if (record.from?.release !== previousRelease(deployment)) {
    return `the backup expects the previous release at ${record.from?.release}, not ${previousRelease(deployment)}; pass the --releases backup had`;
  }
  // A start since the backup could have written to the database.
  if (
    record.bootId !== (await system.bootId()) ||
    record.server?.unit !== deployment.server.name ||
    record.server?.activeEnter !== deployment.server.activeEnter ||
    record.server?.inactiveEnter !== deployment.server.inactiveEnter
  ) {
    return `${deployment.server.name} has started since the backup`;
  }
  // start migrates the database the unit names, which the dump must be of.
  if (
    JSON.stringify(record.datasource) !==
    JSON.stringify(datasourceIdentity(deployment.serverEnvironment))
  ) {
    return `SPRING_DATASOURCE_URL names another database than the backup's`;
  }
  for (const file of record.files ?? []) {
    const location = path.join(directory, file.name);
    if (
      !(await isFile(location)) ||
      (await stat(location)).size !== file.size ||
      (await sha256(location)) !== file.sha256
    ) {
      return `${file.name} in the backup changed`;
    }
  }
  return undefined;
}

async function phaseInstall(system, deployment, options) {
  refuseUnless(deployment);
  await requireStopped(system, deployment, 'install');
  if (!options.backup) {
    throw new Refusal('install needs --backup <directory backup wrote>.');
  }
  const stale = await staleBackup(
    system,
    deployment,
    path.resolve(options.backup),
  );
  if (stale) {
    throw new Refusal(`${stale}; run backup again.`);
  }
  const rows = await compatibilityRows(system, deployment);
  if (failed(rows)) {
    printRows(system, 'Managed Agent upgrade install refused', rows);
    return 1;
  }
  const { version } = deployment.manifest;
  const target = path.join(deployment.releases, version);
  await mkdir(deployment.releases, { recursive: true, mode: 0o755 });

  if (await exists(target)) {
    // An earlier install of this release, or the archive extracted there:
    // the same SHA256SUMS, and files that still match it, make it this build.
    if ((await realpath(target)) !== deployment.distribution) {
      const [ours, theirs] = await Promise.all(
        [deployment.distribution, target].map((root) =>
          readFile(path.join(root, 'SHA256SUMS'), 'utf8').catch(
            () => undefined,
          ),
        ),
      );
      const sums = await verifyChecksums(target).catch(() => ({
        failed: ['SHA256SUMS'],
      }));
      if (theirs === undefined || theirs !== ours || sums.failed.length > 0) {
        throw new Refusal(
          `${target} exists but is not this release; remove it and run install again.`,
        );
      }
    }
    system.out(`Using ${target}`);
  } else {
    const partial = path.join(
      deployment.releases,
      `.${version}.partial-${randomBytes(4).toString('hex')}`,
    );
    system.out(`Copying ${deployment.distribution} to ${target}`);
    try {
      await cp(deployment.distribution, partial, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      const sums = await verifyChecksums(partial);
      if (sums.failed.length > 0) {
        throw new Refusal(
          `The copy at ${partial} does not match SHA256SUMS (${sums.failed.join(', ')}).`,
        );
      }
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      throw error;
    }
  }

  const config = await operatorConfigFiles(deployment.currentTarget);
  for (const name of config.files) {
    const source = path.join(deployment.currentTarget, 'config', name);
    const destination = path.join(target, 'config', name);
    if (await exists(destination)) {
      if ((await sha256(source)) !== (await sha256(destination))) {
        throw new Refusal(
          `${destination} differs from ${source}; reconcile them and run install again.`,
        );
      }
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copyPreserving(source, destination);
    system.out(`Copied config/${name}`);
  }

  const previous = previousRelease(deployment);
  if (!deployment.currentIsLink && (await exists(previous))) {
    throw new Refusal(
      `${previous} exists, so ${deployment.current} cannot move there.`,
    );
  }
  // The link exists before anything moves; rename() over the old link
  // swaps it in one step, and a directory leaves only between two renames.
  // A crash between them leaves the link behind, which inspect reports.
  const link = `${deployment.current}.upgrade-${randomBytes(4).toString('hex')}`;
  await symlink(target, link);
  try {
    if (!deployment.currentIsLink) {
      system.out(`Moving ${deployment.current} to ${previous}`);
      await rename(deployment.current, previous);
    }
    try {
      await rename(link, deployment.current);
    } catch (error) {
      if (!deployment.currentIsLink) {
        await rename(previous, deployment.current);
      }
      throw error;
    }
  } finally {
    await rm(link, { force: true });
  }
  system.out(`${deployment.current} -> ${await readlink(deployment.current)}`);
  system.out(`The previous release stays at ${previous}.`);
  const wanted = deployment.manifest.compatibility?.qwenCodeVersion;
  system.out(
    `Install Qwen Code ${wanted} for the Harness now unless check passed its qwen-code row, then run start.`,
  );
  return 0;
}

/** Runs the installed launcher's preflight as the service account, with the unit's environment. */
function preflight(system, deployment, extra) {
  const { server } = deployment;
  const args = ['--wait', '--pipe', '--collect', '--quiet'];
  if (server.user) {
    args.push(`--uid=${server.user}`);
  }
  if (server.workingDirectory) {
    args.push(`--working-directory=${server.workingDirectory}`);
  }
  for (const [key, value] of server.assignments) {
    args.push(`--setenv=${key}=${value}`);
  }
  for (const entry of server.environmentFiles) {
    args.push(
      `--property=EnvironmentFile=${entry.optional ? '-' : ''}${entry.path}`,
    );
  }
  args.push(
    path.join(deployment.current, SERVER_LAUNCHER),
    '--check',
    ...extra,
  );
  const result = system.run('systemd-run', args, { stdio: 'inherit' });
  return !result.error && result.status === 0;
}

// The probe's own answer, or undefined once the time is up.
async function waitFor(system, timeoutSeconds, probe) {
  const deadline = system.now() + timeoutSeconds * 1000;
  for (;;) {
    const outcome = await probe(Math.max(deadline - system.now(), 1));
    if (outcome !== undefined) {
      return outcome;
    }
    if (system.now() >= deadline) {
      return undefined;
    }
    await system.sleep(1000);
  }
}

// One probe waits at most this long, so a listener that never answers
// cannot hold a phase past its --timeout.
const PROBE_TIMEOUT_MS = 5000;

async function health(system, baseUrl, budgetMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await system.fetch(`${baseUrl}/actuator/health`, {
      signal: AbortSignal.timeout(Math.min(budgetMs, PROBE_TIMEOUT_MS)),
    });
    const body = await response.json();
    return response.ok && body?.status === 'UP';
  } catch {
    return false;
  }
}

async function phaseStart(system, deployment, options) {
  refuseUnless(deployment);
  requireInstalled(deployment);
  const { server, harness } = deployment;
  if (!['inactive', 'failed'].includes(server.activeState)) {
    throw new Refusal(
      `${server.name} already runs; run verify, or run stop to start it again.`,
    );
  }
  const environment = harnessEnvironmentRow(deployment);
  if (environment.status !== 'PASS') {
    throw new Refusal(
      `${environment.detail}; ${environment.fix.replace(/^after backup, /, '')}.`,
    );
  }
  const workers = await processesOf(system, server);
  if (workers.length > 0) {
    throw new Refusal(
      `Runtime workers of ${server.name} still run (PID ${workers.join(', ')}); run stop first.`,
    );
  }

  system.out(`Starting ${harness.name}`);
  runChecked(system, 'systemctl', ['start', harness.name]);
  const harnessUrl = new URL(
    deployment.serverEnvironment.get('QWEN_MANAGED_AGENT_HARNESS_BASE_URL') ??
      'http://127.0.0.1:4170',
  );
  const harnessPort =
    Number(harnessUrl.port) || (harnessUrl.protocol === 'https:' ? 443 : 80);
  const harnessHost = harnessUrl.hostname.replace(/^\[|\]$/g, '');
  const listening = await waitFor(system, options.timeout, async () => {
    if ((await showUnit(system, harness.name)).activeState === 'failed') {
      return false;
    }
    return (await system.connect(harnessHost, harnessPort)) ? true : undefined;
  });
  if (listening === false) {
    throw new Refusal(
      `${harness.name} failed before it listened on ${harnessUrl.host}; see journalctl -u ${harness.name}.`,
    );
  }
  if (!listening) {
    throw new Refusal(
      `${harness.name} is not listening on ${harnessUrl.host} after ${options.timeout}s; see journalctl -u ${harness.name}.`,
    );
  }

  system.out(`Running ${SERVER_LAUNCHER} --check as ${server.user || 'root'}`);
  if (!preflight(system, deployment, [])) {
    throw new Refusal(
      `The preflight failed, so ${server.name} stays stopped; fix its FAIL rows and run start again.`,
    );
  }

  system.out(`Starting ${server.name}`);
  runChecked(system, 'systemctl', ['start', server.name]);
  const baseUrl =
    options.serverUrl ?? serverBaseUrl(deployment.serverEnvironment);
  const healthy = await waitFor(system, options.timeout, async (budget) => {
    if ((await showUnit(system, server.name)).activeState === 'failed') {
      return false;
    }
    return (await health(system, baseUrl, budget)) ? true : undefined;
  });
  if (healthy === false) {
    throw new Refusal(
      `${server.name} failed before it reported UP at ${baseUrl}/actuator/health; see journalctl -u ${server.name}, then run start again.`,
    );
  }
  if (!healthy) {
    // Left running: the journal may show a start that is merely slow.
    throw new Refusal(
      `${server.name} did not report UP at ${baseUrl}/actuator/health within ${options.timeout}s and keeps running; see journalctl -u ${server.name}, then run verify, or run stop to start it again.`,
    );
  }
  system.out(
    `${server.name} is UP at ${baseUrl}. Run verify before reopening ingress.`,
  );
  return 0;
}

async function api(system, baseUrl, tenant, route, init = {}) {
  const response = await system.fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      'X-Qwen-Tenant-Id': tenant,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const reason = body?.error?.message ?? body?.message ?? response.statusText;
    throw new Error(
      `${init.method ?? 'GET'} ${route}: ${response.status} ${reason}`,
    );
  }
  return body;
}

async function sessionRow(system, baseUrl, tenant) {
  try {
    const list = await api(
      system,
      baseUrl,
      tenant,
      '/v1/agents/sessions?limit=1',
    );
    const session = list?.data?.[0];
    if (!session) {
      return row(
        'session',
        'WARN',
        `tenant ${tenant} has no Session to read`,
        'pass a tenant that has one',
      );
    }
    const id = encodeURIComponent(session.id);
    await api(system, baseUrl, tenant, `/v1/agents/sessions/${id}`);
    const items = await api(
      system,
      baseUrl,
      tenant,
      `/v1/agents/sessions/${id}/items?limit=20`,
    );
    return row(
      'session',
      'PASS',
      `read Session ${session.id} and ${items?.data?.length ?? 0} item(s)`,
    );
  } catch (error) {
    return row('session', 'FAIL', error.message);
  }
}

async function turnRow(system, baseUrl, tenant, timeout) {
  let session;
  try {
    session = await api(system, baseUrl, tenant, '/v1/agents/sessions', {
      method: 'POST',
      headers: {
        'Idempotency-Key': `upgrade-verify-${randomBytes(8).toString('hex')}`,
      },
      body: JSON.stringify({
        agent_id: 'qwen-code',
        metadata: { title: 'qwen-managed-agent-upgrade verify' },
        input: [{ type: 'input_text', text: 'Reply with the single word OK.' }],
      }),
    });
    const id = encodeURIComponent(session.id);
    let after = 0;
    const terminal = await waitFor(system, timeout, async () => {
      const page = await api(
        system,
        baseUrl,
        tenant,
        `/v1/agents/sessions/${id}/events?after=${after}&limit=100`,
      );
      for (const event of page?.data ?? []) {
        after = Math.max(after, Number(event.sequence) || after);
        if (event.terminal) {
          return event;
        }
      }
      return undefined;
    });
    if (!terminal) {
      return row(
        'turn',
        'FAIL',
        `Session ${session.id}: no terminal event within ${timeout}s`,
      );
    }
    return /fail|error|cancel/i.test(terminal.type)
      ? row('turn', 'FAIL', `Session ${session.id} ended with ${terminal.type}`)
      : row(
          'turn',
          'PASS',
          `Session ${session.id} ended with ${terminal.type}; archive it when done`,
        );
  } catch (error) {
    return row(
      'turn',
      'FAIL',
      `${session ? `Session ${session.id}: ` : ''}${error.message}`,
    );
  }
}

async function phaseVerify(system, deployment, options) {
  refuseUnless(deployment);
  requireInstalled(deployment);
  const { server, harness } = deployment;
  const down = [server, harness].filter(
    (unit) => unit.activeState !== 'active',
  );
  if (down.length > 0) {
    throw new Refusal(
      `${down.map((unit) => unit.name).join(' and ')} not running; run start first.`,
    );
  }
  const rows = [];
  system.out(
    `Running ${SERVER_LAUNCHER} --check --online as ${server.user || 'root'}`,
  );
  rows.push(
    preflight(system, deployment, ['--online'])
      ? row('preflight', 'PASS', '--check --online passed')
      : row(
          'preflight',
          'FAIL',
          '--check --online failed',
          'read its FAIL rows above',
        ),
  );
  const baseUrl =
    options.serverUrl ?? serverBaseUrl(deployment.serverEnvironment);
  rows.push(
    (await health(system, baseUrl, options.timeout * 1000))
      ? row('health', 'PASS', `${baseUrl}/actuator/health is UP`)
      : row('health', 'FAIL', `${baseUrl}/actuator/health is not UP`),
  );
  const signed =
    (deployment.serverEnvironment.get('QWEN_MANAGED_AGENT_AUTH_MODE') ??
      'auto') === 'signed';
  if (signed) {
    rows.push(
      row(
        'session',
        'SKIP',
        'the API takes signed requests only',
        'read a Session through the ingress',
      ),
    );
  } else if (!options.tenant) {
    rows.push(
      row(
        'session',
        'SKIP',
        'no --tenant',
        'pass --tenant <id> to read an existing Session',
      ),
    );
  } else {
    rows.push(await sessionRow(system, baseUrl, options.tenant));
    if (options.turn) {
      rows.push(
        await turnRow(system, baseUrl, options.tenant, options.timeout),
      );
    }
  }
  printRows(
    system,
    `Managed Agent upgrade verify: ${deployment.manifest.version}`,
    rows,
  );
  return failed(rows) ? 1 : 0;
}

const RUNNERS = {
  check: phaseCheck,
  stop: phaseStop,
  backup: phaseBackup,
  install: phaseInstall,
  start: phaseStart,
  verify: phaseVerify,
};

export async function runUpgrade(argv, system = createSystem()) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'server-unit': { type: 'string', default: SERVER_UNIT },
        'harness-unit': { type: 'string', default: HARNESS_UNIT },
        releases: { type: 'string' },
        to: { type: 'string' },
        backup: { type: 'string' },
        mysqldump: { type: 'string', default: 'mysqldump' },
        'skip-database': { type: 'boolean', default: false },
        'runtime-state': { type: 'string' },
        'server-url': { type: 'string' },
        timeout: { type: 'string' },
        tenant: { type: 'string' },
        turn: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    system.err(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [phase] = positionals;
  if (values.help || positionals.length !== 1 || !PHASES.includes(phase)) {
    (values.help ? system.out : system.err)(USAGE);
    return values.help ? 0 : 2;
  }
  const timeout =
    values.timeout === undefined
      ? DEFAULT_TIMEOUT_SECONDS[phase]
      : Number(values.timeout);
  if (
    values.timeout !== undefined &&
    !(Number.isInteger(timeout) && timeout > 0)
  ) {
    system.err('--timeout takes a positive number of seconds.');
    return 2;
  }
  if (values.turn && !values.tenant) {
    system.err('--turn needs --tenant.');
    return 2;
  }
  const options = {
    serverUnit: values['server-unit'],
    harnessUnit: values['harness-unit'],
    releases: values.releases && path.resolve(values.releases),
    to: values.to,
    backup: values.backup,
    mysqldump: values.mysqldump,
    skipDatabase: values['skip-database'],
    runtimeState:
      values['runtime-state'] && path.resolve(values['runtime-state']),
    serverUrl: values['server-url']?.replace(/\/+$/, ''),
    timeout,
    tenant: values.tenant,
    turn: values.turn,
  };
  try {
    requireRoot(system);
    const deployment = await inspect(system, options);
    return await RUNNERS[phase](system, deployment, options);
  } catch (error) {
    if (error instanceof Refusal) {
      system.err(`${phase} refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function invokedAsMain() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  runUpgrade(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
