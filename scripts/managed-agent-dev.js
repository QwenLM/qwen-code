#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-shot development launcher for the Managed Agent dual-path Web Shell.
 *
 * Starts, from TypeScript source, with each stage serialized:
 *   - an ordinary `qwen serve` daemon (existing WebShell panels),
 *   - a private Hosted Harness (`--profile hosted-harness`),
 * then waits for the Spring Managed Agent Server (started separately with
 * Maven — see the env file it writes) and finally opens the Web Shell Vite
 * dev server with the Managed panel selected.
 *
 * Usage: npm run dev:managed-agent -- [--daemon-port N] [--harness-port N]
 *        [--java-url URL] [--tenant ID] [--workspace PATH] [--skip-java-wait]
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform, tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const args = process.argv.slice(2);
const isWin = platform() === 'win32';

const HOST = '127.0.0.1';
// Vite binds 'localhost' (IPv6-first hosts resolve it to ::1 only), and the
// web banner must spell the same host Vite bound.
const WEB_HOST = 'localhost';
const DEFAULT_DAEMON_PORT = 4170;
const DEFAULT_HARNESS_PORT = 4270;
const DEFAULT_WEB_PORT = 5174;
const DEFAULT_JAVA_URL = 'http://127.0.0.1:8080';
const DEFAULT_TENANT = 'local-java-demo';
const MAX_PORT_ATTEMPTS = 10;
// Identical to TenantContextFilter.java TENANT_PATTERN — the value becomes
// the X-Qwen-Tenant-Id header, which Spring rejects with 400 invalid_tenant.
const TENANT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
// Since #12754 the Hosted Harness answers 400 invalid_managed_session_store to
// any POST /session without a managedSessionStore descriptor, and Spring only
// sends one when its HTTP Session Store is enabled — without it every Managed
// Turn fails with hosted_harness_rejected. The Harness calls the Store back on
// the Spring URL, i.e. the same --java-url the web proxy uses.
const DEV_WORKSPACE_ID = 'local-dev-workspace';

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ps1Quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const VALUE_OPTIONS = new Set([
  '--daemon-port',
  '--harness-port',
  '--java-url',
  '--tenant',
  '--workspace',
]);
const FLAG_OPTIONS = new Set(['--skip-java-wait']);

const OPTION_KEYS = {
  '--daemon-port': 'daemonPort',
  '--harness-port': 'harnessPort',
  '--java-url': 'javaUrl',
  '--tenant': 'tenant',
  '--workspace': 'workspace',
  '--skip-java-wait': 'skipJavaWait',
};

function parsePortOption(name, raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${name} must be an integer 1–65535 (0 is not supported; the launcher needs a fixed port to poll for health), got "${raw}".`,
    );
  }
  return port;
}

export function parseLauncherArgs(argv) {
  const result = {
    daemonPort: undefined,
    harnessPort: undefined,
    javaUrl: DEFAULT_JAVA_URL,
    tenant: DEFAULT_TENANT,
    workspace: undefined,
    skipJavaWait: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // First `=` only: values themselves may contain `=` (e.g. a workspace
    // path), which split('=', 2) would silently truncate.
    const eqIndex = arg.indexOf('=');
    const name = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    if (FLAG_OPTIONS.has(name)) {
      if (arg !== name) {
        throw new Error(`${name} does not take a value.`);
      }
      result[OPTION_KEYS[name]] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      throw new Error(`Unsupported managed-agent-dev option: ${arg}`);
    }
    let value;
    if (eqIndex !== -1) {
      value = arg.slice(eqIndex + 1);
      if (!value) throw new Error(`${name} requires a value.`);
    } else {
      value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value.`);
      }
      i += 1;
    }
    if (name === '--tenant' && !TENANT_PATTERN.test(value)) {
      throw new Error(
        `--tenant must match ^[A-Za-z0-9._:-]{1,128}$ (Spring rejects anything else with invalid_tenant), got "${value}".`,
      );
    }
    const key = OPTION_KEYS[name];
    result[key] =
      name === '--daemon-port' || name === '--harness-port'
        ? parsePortOption(name, value)
        : value;
  }
  if (
    result.daemonPort !== undefined &&
    result.daemonPort === result.harnessPort
  ) {
    throw new Error('--daemon-port and --harness-port must differ.');
  }
  let javaUrl;
  try {
    result.javaUrl = result.javaUrl.trim();
    javaUrl = new URL(result.javaUrl);
  } catch {
    throw new Error(`--java-url must be a valid URL, got "${result.javaUrl}".`);
  }
  if (javaUrl.protocol !== 'http:' && javaUrl.protocol !== 'https:') {
    throw new Error(
      `--java-url must be an http(s) URL, got "${result.javaUrl}".`,
    );
  }
  // Health checks append '/actuator/health'; a trailing slash would double it.
  result.javaUrl = result.javaUrl.replace(/\/+$/, '');
  return result;
}

// SERVER_PORT follows the Java URL when that URL is a plain-http loopback
// one — otherwise Spring binds 8080 no matter what --java-url said, and the
// launcher waits on a port nothing serves. Skipped for https (TLS lives at
// the ingress, not in this env file) and for non-loopback hosts.
export function loopbackHttpPort(javaUrl) {
  try {
    const parsed = new URL(javaUrl);
    if (parsed.protocol !== 'http:') return undefined;
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      return undefined;
    }
    return parsed.port || '80';
  } catch {
    return undefined;
  }
}

export function renderSpringEnv({
  harnessPort,
  harnessToken,
  capabilityDigest,
  javaUrl = DEFAULT_JAVA_URL,
}) {
  const serverPort = loopbackHttpPort(javaUrl);
  return [
    '# Generated by scripts/managed-agent-dev.js on launch. The harness token',
    '# and capability digest rotate on every run: start Spring with this file,',
    '# and restart Spring whenever the launcher restarts.',
    `export QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'`,
    `export QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://${HOST}:${harnessPort}'`,
    `export QWEN_MANAGED_AGENT_HARNESS_TOKEN='${harnessToken}'`,
    `export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='${capabilityDigest}'`,
    `export QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED='true'`,
    `export QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL=${shellQuote(javaUrl)}`,
    `export QWEN_MANAGED_AGENT_WORKSPACE_ID='${DEV_WORKSPACE_ID}'`,
    ...(serverPort === undefined
      ? []
      : [`export SERVER_PORT=${shellQuote(serverPort)}`]),
    '',
  ].join('\n');
}

// PowerShell sibling for Windows developers: `source` and bash `export` do
// not exist there, while Windows CI does build this stack.
export function renderSpringPs1Env({
  harnessPort,
  harnessToken,
  capabilityDigest,
  javaUrl = DEFAULT_JAVA_URL,
}) {
  const serverPort = loopbackHttpPort(javaUrl);
  return [
    '# Generated by scripts/managed-agent-dev.js on launch. The harness token',
    '# and capability digest rotate on every run: start Spring with this file,',
    '# and restart Spring whenever the launcher restarts.',
    `$env:QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'`,
    `$env:QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://${HOST}:${harnessPort}'`,
    `$env:QWEN_MANAGED_AGENT_HARNESS_TOKEN='${harnessToken}'`,
    `$env:QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='${capabilityDigest}'`,
    `$env:QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED='true'`,
    `$env:QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL=${ps1Quote(javaUrl)}`,
    `$env:QWEN_MANAGED_AGENT_WORKSPACE_ID='${DEV_WORKSPACE_ID}'`,
    ...(serverPort === undefined
      ? []
      : [`$env:SERVER_PORT=${ps1Quote(serverPort)}`]),
    '',
  ].join('\n');
}

function currentUid() {
  return typeof process.getuid === 'function'
    ? String(process.getuid())
    : 'nouid';
}

// Outside any served workspace (the ordinary daemon exposes workspace files,
// including .gitignored ones, through its file routes) and keyed by owner +
// checkout: a fixed host-global name would let a local user pre-plant the
// path, and two worktrees would truncate each other's credentials. The path
// must stay stable across runs of the same checkout, or R1-12's
// stale-Spring reuse warning (existsSync before write) never fires.
export function springEnvDir(rootPath) {
  const checkoutHash = crypto
    .createHash('sha256')
    .update(rootPath)
    .digest('hex')
    .slice(0, 8);
  return join(
    tmpdir(),
    `qwen-managed-agent-dev-${currentUid()}-${checkoutHash}`,
  );
}

export function springEnvFilePath(rootPath) {
  return join(springEnvDir(rootPath), 'spring.env');
}

export function springEnvPs1FilePath(rootPath) {
  return join(springEnvDir(rootPath), 'spring.env.ps1');
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return null;
    throw err;
  }
}

// Thrown messages carry no `[managed-agent-dev]` prefix: every catch site in
// main() prepends it once, and a prefixed throw would print it twice.
function refuseUnlessOwned(path, stat) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(
      `${path} is owned by another user — refusing to write credentials over it`,
    );
  }
}

function refuseUnlessOwnedRegularFile(path, stat) {
  if (!stat.isFile()) {
    throw new Error(
      `${path} exists and is not a regular file — refusing to write credentials over it`,
    );
  }
  refuseUnlessOwned(path, stat);
}

// Fail-closed credential write. Nothing in it resolves through symlinks:
// stat() and existsSync() would follow a planted link at the directory or at
// a (possibly dangling) target, so every check reads lstat and refuses the
// link itself, never follows it. The directory must be ours and 0700, each
// target absent or a regular file we own, and 0600 is applied by chmod so it
// also holds on the overwrite path where writeFileSync's mode is a no-op.
// Mode/chmod enforcement is POSIX-only: on Windows stat().mode masks
// privilege bits from ACLs and chmod 0600 sets the read-only attribute;
// NTFS already scopes the per-user TEMP directory by ACL.
export function writeSpringEnvFiles({
  directory,
  springEnv,
  springPs1Env,
  isWinPlatform,
}) {
  const dirLstat = lstatOrNull(directory);
  if (dirLstat && dirLstat.isSymbolicLink()) {
    throw new Error(
      `${directory} is a symlink — refusing to write credentials through it`,
    );
  }
  if (dirLstat === null) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const dirStat = dirLstat ?? lstatSync(directory);
  refuseUnlessOwned(directory, dirStat);
  if (!isWinPlatform && (dirStat.mode & 0o077) !== 0) {
    throw new Error(
      `${directory} must be 0700 (found ${(dirStat.mode & 0o777).toString(8)})`,
    );
  }
  const writeOne = (filePath, content, applyChmod) => {
    const targetLstat = lstatOrNull(filePath);
    if (targetLstat !== null) {
      refuseUnlessOwnedRegularFile(filePath, targetLstat);
    }
    writeFileSync(filePath, content, { mode: 0o600 });
    if (applyChmod) chmodSync(filePath, 0o600);
  };
  writeOne(join(directory, 'spring.env'), springEnv, !isWinPlatform);
  if (isWinPlatform) {
    writeOne(join(directory, 'spring.env.ps1'), springPs1Env, false);
  }
}

export function springEnvReuseWarning(existed) {
  return existed
    ? '[managed-agent-dev] spring.env already existed: a Spring started from a previous run still holds the old harness token and capability digest — restart it (source the new file first).'
    : null;
}

export function buildSpringRecipeLines({
  isWinPlatform,
  springEnvPath,
  springPs1Path,
}) {
  const lines = [
    `  # one-time DB/user: mysql -u root -e "CREATE DATABASE qwen_managed_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER 'qwen'@'localhost' IDENTIFIED BY 'replace-me'; CREATE USER 'qwen'@'127.0.0.1' IDENTIFIED BY 'replace-me'; GRANT ALL ON qwen_managed_agent.* TO 'qwen'@'localhost'; GRANT ALL ON qwen_managed_agent.* TO 'qwen'@'127.0.0.1';"`,
    `  # (official MySQL images enable skip-name-resolve, so 'qwen'@'localhost' alone never matches TCP clients; a containerized MySQL sees the gateway address — grant at 'qwen'@'%' or the container-visible host instead)`,
    '  # once per clone, and re-run after pulling changes to qwencode/runtime-broker (~12 s):',
    '  #           mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install',
    '  #           mvn -f packages/sdk-java/runtime-broker/pom.xml -DskipTests install',
  ];
  if (isWinPlatform) {
    // `#` starts a comment in PowerShell too, so actionable lines must not
    // carry that prefix; dot-sourcing a .ps1 also needs the process-scoped
    // policy bypass under Windows PowerShell's default Restricted policy.
    lines.push(
      `  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; . "${springPs1Path}"`,
      "  $env:SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'",
      "  $env:SPRING_DATASOURCE_USERNAME='qwen'",
      "  $env:SPRING_DATASOURCE_PASSWORD='replace-me'",
      '  Set-Location packages\\sdk-java\\managed-agent-server; mvn spring-boot:run',
    );
  } else {
    lines.push(
      `  source "${springEnvPath}"`,
      "  export SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'",
      "  export SPRING_DATASOURCE_USERNAME='qwen'",
      "  export SPRING_DATASOURCE_PASSWORD='replace-me'",
      '  cd packages/sdk-java/managed-agent-server && mvn spring-boot:run',
    );
  }
  return lines;
}

export function buildManagedWebShellPath({ tenant, daemonToken }) {
  const params = new URLSearchParams({
    managed: '1',
    managedProvider: 'java',
    tenant,
    token: daemonToken,
  });
  return `/?${params.toString()}`;
}

// The host is not a parameter: it must always equal Vite's bind host
// (`--host localhost` at spawn), so IPv6-first hosts never get an
// unreachable 127.0.0.1 banner.
export function buildWebShellUrl({ port, webShellPath }) {
  return `http://${WEB_HOST}:${port}${webShellPath}`;
}

export function findAvailablePort(
  startPort,
  excludedPorts = new Set(),
  probeHost = HOST,
) {
  return new Promise((resolveFind, rejectFind) => {
    let attempt = 0;
    const tryNext = () => {
      const port = startPort + attempt;
      if (port > 65535 || attempt >= MAX_PORT_ATTEMPTS) {
        rejectFind(
          new Error(
            `No available port found in range ${startPort}–${Math.min(startPort + MAX_PORT_ATTEMPTS - 1, 65535)}`,
          ),
        );
        return;
      }
      if (excludedPorts.has(port)) {
        // Probing happens before either server binds: a port another child of
        // this launcher already claimed is not free, even though nothing
        // listens on it yet.
        attempt++;
        tryNext();
        return;
      }
      const probe = net.createServer();
      probe.once('error', (err) => {
        probe.close();
        if (err.code === 'EADDRINUSE') {
          console.log(
            `[managed-agent-dev] port ${port} is in use, trying ${port + 1}...`,
          );
          attempt++;
          tryNext();
        } else {
          rejectFind(err);
        }
      });
      probe.listen(port, probeHost, () => {
        probe.close(() => resolveFind(port));
      });
    };
    tryNext();
  });
}

export function findWebPort(excludedPorts) {
  return findAvailablePort(DEFAULT_WEB_PORT, excludedPorts, WEB_HOST);
}

// `qwen serve` retries EADDRINUSE by bumping regardless of whether the port
// was explicitly pinned, so a busy pinned port would leave the launcher
// polling an address the child never bound. Fail fast instead.
export async function ensurePortFree(port, label) {
  const probe = net.createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      probe.once('error', rejectListen);
      probe.listen(port, HOST, resolveListen);
    });
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'EADDRINUSE') {
      throw new Error(
        `${label} ${port} is already in use (qwen serve would silently bump past it; free the port or omit the flag to auto-increment).`,
      );
    }
    throw err;
  } finally {
    probe.close();
  }
}

export function buildKillPlan(isWinPlatform, hasPid) {
  if (isWinPlatform && hasPid) return { kind: 'taskkill' };
  if (!isWinPlatform && hasPid) return { kind: 'process-group' };
  return { kind: 'direct' };
}

// The effectful half of killChild, with the OS touchpoints injectable so a
// test can witness the real argv without signalling any real process.
export function executeKillPlan(plan, pid, child, runners = {}) {
  const taskkill =
    runners.taskkill ??
    ((taskkillArgs) =>
      spawnSync('taskkill', taskkillArgs, { stdio: 'ignore' }));
  const killProcess =
    runners.killProcess ?? ((target, signal) => process.kill(target, signal));
  if (plan.kind === 'taskkill') {
    // dev.js spawns the real serve process as a grandchild and Windows
    // has no process group (detached is false there): a bare child.kill()
    // orphans the credentialed servers. taskkill /T takes the whole tree.
    taskkill(['/pid', String(pid), '/T', '/F']);
    return;
  }
  if (plan.kind === 'process-group') {
    killProcess(-pid, 'SIGTERM');
    return;
  }
  child.kill();
}

export function generateDaemonToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function generateHarnessSecrets() {
  return {
    harnessToken: generateDaemonToken(),
    capabilityDigest: `sha256:${crypto.randomBytes(32).toString('hex')}`,
  };
}

export function buildHarnessWiring({
  harnessPort,
  workspace,
  harnessToken,
  capabilityDigest,
  javaUrl,
}) {
  return {
    harnessPort,
    serveArgs: [
      'scripts/dev.js',
      'serve',
      '--profile',
      'hosted-harness',
      '--hostname',
      HOST,
      '--port',
      String(harnessPort),
      '--require-auth',
      '--no-web',
      '--workspace',
      workspace,
    ],
    extraEnv: {
      QWEN_SERVER_TOKEN: harnessToken,
      QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: capabilityDigest,
    },
    springEnv: renderSpringEnv({
      harnessPort,
      harnessToken,
      capabilityDigest,
      javaUrl,
    }),
    springPs1Env: renderSpringPs1Env({
      harnessPort,
      harnessToken,
      capabilityDigest,
      javaUrl,
    }),
  };
}

export function buildServeStages({
  workspace,
  daemonPort,
  daemonToken,
  serveEnv,
  harnessWiring,
  pinnedDaemonPort,
  pinnedHarnessPort,
}) {
  const daemonUrl = `http://${HOST}:${daemonPort}`;
  const harnessUrl = `http://${HOST}:${harnessWiring.harnessPort}`;
  const capabilityDigest =
    harnessWiring.extraEnv.QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST;
  return [
    {
      label: 'daemon',
      args: [
        'scripts/dev.js',
        'serve',
        '--hostname',
        HOST,
        '--port',
        String(daemonPort),
        '--workspace',
        workspace,
      ],
      env: { ...serveEnv, QWEN_SERVER_TOKEN: daemonToken },
      health: {
        url: `${daemonUrl}/capabilities`,
        token: daemonToken,
        // The ordinary daemon must not answer as a hosted harness: a harness
        // on this port means the two serves are cross-wired, which a bare
        // 200 from the pre-auth /health cannot see.
        expectBody: (body) =>
          body !== null &&
          typeof body === 'object' &&
          !('hostedHarness' in body)
            ? true
            : 'expected an ordinary daemon (no hostedHarness section)',
      },
      ...(pinnedDaemonPort === undefined
        ? {}
        : { pinnedPort: pinnedDaemonPort, pinnedLabel: '--daemon-port' }),
    },
    {
      label: 'harness',
      args: harnessWiring.serveArgs,
      env: { ...serveEnv, ...harnessWiring.extraEnv },
      health: {
        url: `${harnessUrl}/capabilities`,
        token: harnessWiring.extraEnv.QWEN_SERVER_TOKEN,
        expectBody: (body) => {
          if (
            body !== null &&
            typeof body === 'object' &&
            'hostedHarness' in body
          ) {
            return body.hostedHarness?.capabilityDigest === capabilityDigest
              ? true
              : 'capabilityDigest mismatch — a different harness owns this port';
          }
          return 'not a hosted-harness responder';
        },
      },
      ...(pinnedHarnessPort === undefined
        ? {}
        : { pinnedPort: pinnedHarnessPort, pinnedLabel: '--harness-port' }),
    },
  ];
}

// Spawns and health-gates each stage in turn. The serialized interleaving
// matters: dev.js does a destructive re-stage (rmSync + cpSync) of the
// shared browser-use runtime directory on every boot, so two concurrent
// children race and majority-silently tear the tree. preflightStage runs
// immediately before the stage's own spawn — a pinned port is re-checked
// there, not minutes earlier before an older sibling stage's boot.
export async function runServeStages(
  stages,
  { preflightStage, spawnStage, waitStage },
) {
  for (const stage of stages) {
    if (typeof preflightStage === 'function') await preflightStage(stage);
    spawnStage(stage);
    await waitStage(stage);
    console.log(`[${stage.label}] healthy`);
  }
}

// Java gate handling, exported so the teardown-interrupted path stays
// test-reachable: a child dying (or Ctrl-C/SIGHUP/SIGQUIT arriving) during
// the wait must print NOTHING beyond the error — the "daemon and harness
// stay up" continuation line is the misleading one on precisely that path.
// A genuine Spring timeout still prints both warnings and lets the launch
// proceed (Spring is external; its failure must never tear down children
// the launcher owns). Outcomes: 'skipped' | 'continue' | 'teardown'.
export async function runJavaGate({
  skipJavaWait,
  javaHealthUrl,
  isShuttingDownNow,
  reuseWarning,
  healthWait = waitForHttpOk,
}) {
  if (skipJavaWait) {
    console.log(
      '[java] skipping /actuator/health wait (--skip-java-wait); the Managed panel will fail until Spring is up',
    );
    return 'skipped';
  }
  console.log(
    `[java] waiting for ${javaHealthUrl} (up to 10 min; start Spring now, or pass --skip-java-wait to bypass)...`,
  );
  try {
    await healthWait(javaHealthUrl, {
      timeoutMs: 600_000,
      intervalMs: 1_000,
      expectBody: springHealthExpectBody,
    });
    console.log('[java] healthy');
    if (reuseWarning) console.warn(reuseWarning);
    return 'continue';
  } catch (err) {
    if (isShuttingDownNow()) return 'teardown';
    console.warn(`[java] ${err instanceof Error ? err.message : String(err)}`);
    console.warn(
      '[java] continuing anyway — the daemon and harness stay up; the Managed panel needs Spring (same end state as --skip-java-wait).',
    );
    return 'continue';
  }
}

export function springHealthExpectBody(body) {
  return body !== null &&
    typeof body === 'object' &&
    typeof body.status === 'string'
    ? true
    : 'not a Spring Boot actuator health response';
}

export function buildWebShellLaunch({
  webShellPath,
  webPort,
  daemonUrl,
  javaUrl,
}) {
  return {
    command: 'npm',
    // The open path carries the daemon token, so it travels by environment
    // rather than npm's argv, which npm echoes to its inherited stdio and
    // which is world-readable in /proc/<pid>/cmdline. Vite consumes it via
    // server.open in packages/web-shell/vite.config.ts. Caveat: when Vite
    // opens the tab, the full token-bearing URL rides the BROWSER launcher's
    // argv (a world-readable spawn argument on POSIX) — this transport
    // removes only the npm hop's echo; it does not make the token invisible
    // locally. --strictPort keeps Vite fail-closed on a taken port instead
    // of silently relocating past the probed value; --host pins the same
    // bind family the probe used.
    args: [
      'run',
      'dev',
      '--workspace=packages/web-shell',
      '--',
      '--port',
      String(webPort),
      '--host',
      WEB_HOST,
      '--strictPort',
    ],
    env: {
      ...process.env,
      QWEN_DAEMON_URL: daemonUrl,
      QWEN_MANAGED_AGENT_JAVA_URL: javaUrl,
      QWEN_WEB_SHELL_OPEN_PATH: webShellPath,
    },
  };
}

// Resolves the web port at the last moment — before the Java wait ends a
// squatter in that (up to 12-minute) window would otherwise win the probed
// port and --strictPort would turn the loss into a full teardown. Returns
// false without touching anything once teardown has begun.
export async function launchWebShell({
  isShuttingDownNow,
  isTTY,
  webShellPath,
  daemonUrl,
  javaUrl,
  excludedPorts,
  resolveWebPort = findWebPort,
  spawnShell,
}) {
  if (isShuttingDownNow()) return false;
  const webPort = await resolveWebPort(excludedPorts);
  if (isShuttingDownNow()) return false;
  if (isTTY) {
    console.log(
      `web-shell: ${buildWebShellUrl({ port: webPort, webShellPath })}`,
    );
    console.log('  (the URL contains the daemon token — treat it as secret)');
  }
  spawnShell(
    buildWebShellLaunch({ webShellPath, webPort, daemonUrl, javaUrl }),
  );
  return true;
}

export async function waitForHttpOk(
  url,
  { token, timeoutMs, intervalMs = 250, expectBody } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  let lastDetail;
  let lastError;
  let loggedObservation = false;
  for (;;) {
    if (shuttingDown) {
      throw new Error('shutting down');
    }
    let observation;
    try {
      const response = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(1_000),
      });
      lastError = undefined;
      if (response.ok) {
        if (!expectBody) return;
        const body = await response.json().catch(() => undefined);
        const verdict = expectBody(body);
        if (verdict === true) return;
        lastStatus = response.status;
        lastDetail = typeof verdict === 'string' ? verdict : undefined;
        observation = `HTTP ${response.status}${
          lastDetail ? ` (${lastDetail})` : ''
        }`;
      } else {
        lastStatus = response.status;
        lastDetail = undefined;
        observation = `HTTP ${response.status}`;
      }
    } catch (err) {
      // undici rejects with "fetch failed" and hides the real reason in
      // err.cause.code; and an error always supersedes an older response —
      // neither accumulator may survive a differently-failing attempt.
      const causeCode =
        err instanceof Error &&
        err.cause !== null &&
        typeof err.cause === 'object' &&
        'code' in err.cause &&
        typeof err.cause.code === 'string'
          ? err.cause.code
          : undefined;
      const message = err instanceof Error ? err.message : String(err);
      lastError = causeCode ? `${message} (${causeCode})` : message;
      lastStatus = undefined;
      lastDetail = undefined;
      observation = lastError;
    }
    if (observation !== undefined && !loggedObservation) {
      loggedObservation = true;
      console.log(`[wait] ${url}: ${observation} (still waiting)`);
    }
    if (Date.now() >= deadline) {
      const suffix = lastStatus
        ? ` (last response: HTTP ${lastStatus}${
            lastDetail ? `, ${lastDetail}` : ''
          })`
        : lastError
          ? ` (last error: ${lastError})`
          : '';
      throw new Error(`Timed out waiting for ${url}${suffix}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
}

const children = [];
let shuttingDown = false;

export function isLiveChild(child) {
  return child.exitCode === null && child.signalCode === null;
}

export function spawnDevProcess(label, command, commandArgs, options) {
  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    shell: options.shell ?? false,
    // POSIX children lead their own process group so a negative-pid kill
    // reaps the dev.js grandchild that owns the socket.
    detached: !isWin,
    ...options,
  });

  child.on('error', (err) => {
    console.error(`[${label}] failed to start: ${err.message}`);
    shutdown(1);
  });

  child.on('close', (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      console.error(`[${label}] exited by signal ${signal}`);
      shutdown(1);
      return;
    }
    if (code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
    }
    shutdown(code ?? 0);
  });

  children.push(child);
  return child;
}

function killChild(child) {
  // shutdown() iterates every still-live child and the exit hook reaps the
  // same set. child.killed only tracks child.kill(), so a second pass on
  // the group/taskkill plans is at worst one redundant signal to an
  // already-dying tree, never a new kill of a reused pid.
  if (child.killed) return;
  const plan = buildKillPlan(isWin, Boolean(child.pid));
  try {
    executeKillPlan(plan, child.pid, child);
  } catch {
    child.kill();
  }
}

export function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  let pending = 0;
  for (const child of children) {
    if (!isLiveChild(child)) continue;
    pending += 1;
    child.on('close', () => {
      pending -= 1;
      if (pending <= 0) process.exit(code);
    });
    killChild(child);
  }
  if (pending === 0) process.exit(code);
  // Grace budget for those close events; whoever loses it is force-reaped
  // instead of being left credentialed and orphaned.
  setTimeout(() => {
    forceKillAll(children);
    process.exit(code);
  }, 5_000).unref();
}

export function forceKillAll(childrenList) {
  for (const child of childrenList) {
    if (!isLiveChild(child)) continue;
    if (isWin) {
      try {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      } catch {
        // taskkill /F is already forced; nothing harder to escalate to.
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process is already gone.
        }
      }
    }
  }
}

// SIGHUP is what a closing terminal tab, a dropped SSH session or a killed
// tmux pane delivers, and Ctrl-\ (SIGQUIT) is the standard escalation of a
// hung Ctrl-C; without them the launcher dies via Node's default action and
// the detached children live on, credentialed. POSIX-only by design: on
// Windows the children share the console and get the console-close event
// directly, and there are no POSIX signals to trap.
export const TEARDOWN_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  ...(isWin ? [] : ['SIGHUP', 'SIGQUIT']),
];

export function installTeardownHandlers() {
  for (const signal of TEARDOWN_SIGNALS) {
    process.on(signal, () => shutdown(0));
  }
  // Reaps on any exit path Node can run a handler for. Paths with no
  // handler — an unlisted signal, a V8 abort, SIGKILL itself — cannot be
  // covered from inside this process; the 5-second SIGKILL escalation in
  // shutdown() bounds what a handled path strands, and harder cases belong
  // to a launcher-external supervisor rather than to this script.
  process.on('exit', () => {
    forceKillAll(children);
  });
}

async function main() {
  const options = parseLauncherArgs(args);

  // Fail fast on a busy pinned port before anything rotates credentials or
  // the banner prints: a per-stage recheck alone would only surface this
  // after writeSpringEnvFiles already rotated the Spring wiring (R4-14).
  if (options.daemonPort !== undefined) {
    await ensurePortFree(options.daemonPort, '--daemon-port');
  }
  if (options.harnessPort !== undefined) {
    await ensurePortFree(options.harnessPort, '--harness-port');
  }
  const daemonPort =
    options.daemonPort ??
    (await findAvailablePort(
      DEFAULT_DAEMON_PORT,
      new Set(options.harnessPort !== undefined ? [options.harnessPort] : []),
    ));
  const harnessPort =
    options.harnessPort ??
    (await findAvailablePort(DEFAULT_HARNESS_PORT, new Set([daemonPort])));
  const workspace = resolve(options.workspace ?? process.cwd());
  const daemonToken = generateDaemonToken();
  const secrets = generateHarnessSecrets();
  const harnessWiring = buildHarnessWiring({
    harnessPort,
    workspace,
    harnessToken: secrets.harnessToken,
    capabilityDigest: secrets.capabilityDigest,
    javaUrl: options.javaUrl,
  });

  const envDirectory = springEnvDir(root);
  const springEnvPath = springEnvFilePath(root);
  const springPs1Path = springEnvPs1FilePath(root);
  const envExisted = existsSync(springEnvPath);
  const reuseWarning = springEnvReuseWarning(envExisted);
  if (reuseWarning) console.warn(reuseWarning);
  writeSpringEnvFiles({
    directory: envDirectory,
    springEnv: harnessWiring.springEnv,
    springPs1Env: harnessWiring.springPs1Env,
    isWinPlatform: isWin,
  });

  const daemonUrl = `http://${HOST}:${daemonPort}`;
  const harnessUrl = `http://${HOST}:${harnessPort}`;
  const webShellPath = buildManagedWebShellPath({
    tenant: options.tenant,
    daemonToken,
  });

  const tsxLoaderUrl = pathToFileURL(
    join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
  ).href;
  const nodeOptions = [process.env.NODE_OPTIONS, `--import ${tsxLoaderUrl}`]
    .filter(Boolean)
    .join(' ');

  const serveEnv = {
    ...process.env,
    QWEN_CODE_NO_RELAUNCH: 'true',
    NODE_OPTIONS: nodeOptions,
    // QWEN_CODE_CLI is NOT set here for the same reason as in daemon-dev.js:
    // scripts/dev.js stamps it unconditionally, and honouring an inherited
    // value would re-point subprocesses at an outer session's build.
  };

  console.log('qwen managed-agent dev');
  console.log(`  daemon (ordinary panels): ${daemonUrl}`);
  console.log(`  hosted harness (private): ${harnessUrl}`);
  console.log(`  java url for web proxy:   ${options.javaUrl}`);
  console.log(`  workspace: ${workspace}`);
  console.log(`  tenant:    ${options.tenant}`);
  console.log('');
  console.log(
    'Spring Managed Agent Server runs separately (Java 21 + MySQL 8):',
  );
  for (const line of buildSpringRecipeLines({
    isWinPlatform: isWin,
    springEnvPath,
    springPs1Path,
  })) {
    console.log(line);
  }
  console.log('');

  const stages = buildServeStages({
    workspace,
    daemonPort,
    daemonToken,
    serveEnv,
    harnessWiring,
    pinnedDaemonPort: options.daemonPort,
    pinnedHarnessPort: options.harnessPort,
  });
  try {
    await runServeStages(stages, {
      preflightStage: (stage) => {
        if (stage.pinnedPort !== undefined) {
          return ensurePortFree(stage.pinnedPort, stage.pinnedLabel);
        }
        return undefined;
      },
      spawnStage: (stage) =>
        spawnDevProcess(stage.label, 'node', stage.args, {
          cwd: root,
          env: stage.env,
        }),
      waitStage: (stage) =>
        waitForHttpOk(stage.health.url, {
          token: stage.health.token,
          timeoutMs: 60_000,
          expectBody: stage.health.expectBody,
        }),
    });
  } catch (err) {
    console.error(
      `[managed-agent-dev] ${err instanceof Error ? err.message : String(err)}`,
    );
    shutdown(1);
    return;
  }

  const javaOutcome = await runJavaGate({
    skipJavaWait: options.skipJavaWait,
    javaHealthUrl: `${options.javaUrl}/actuator/health`,
    isShuttingDownNow: () => shuttingDown,
    reuseWarning,
  });
  if (javaOutcome === 'teardown' || shuttingDown) return;

  await launchWebShell({
    isShuttingDownNow: () => shuttingDown,
    isTTY: process.stdout.isTTY,
    webShellPath,
    daemonUrl,
    javaUrl: options.javaUrl,
    excludedPorts: new Set([daemonPort, harnessPort]),
    spawnShell: (launch) =>
      spawnDevProcess('web-shell', launch.command, launch.args, {
        cwd: root,
        env: launch.env,
        // npm is npm.cmd on Windows, which per Node's docs cannot be
        // launched without the shell option. The args carry no '&' (the
        // open path travels by env), so cmd's quote-stripping re-parse is
        // harmless here.
        shell: isWin,
      }),
  });
}

const isMain =
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // Registered here rather than at module top level: importers of the
  // helpers must not inherit these exit-0-on-signal semantics.
  installTeardownHandlers();
  main().catch((err) => {
    console.error(
      `[managed-agent-dev] ${err instanceof Error ? err.message : String(err)}`,
    );
    shutdown(1);
  });
}
