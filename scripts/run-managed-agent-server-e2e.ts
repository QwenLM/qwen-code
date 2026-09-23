import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  fakeToolCall,
  startFakeOpenAIServer,
} from '../integration-tests/fake-openai-server.js';

const root = process.cwd();
const argumentsList = process.argv.slice(2);
let model = 'moonshot/kimi-k3';
let runtimeDelayMs = 0;
let settingsPath = path.join(homedir(), '.qwen', 'settings.json');
let sessionFailover = false;
let inflightFailover = false;
let continuationFailover = false;

for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  const value = argumentsList[index + 1];
  if (argument === '--model' && value) {
    model = value;
    index += 1;
  } else if (argument === '--runtime-delay-ms' && value) {
    runtimeDelayMs = Number(value);
    index += 1;
  } else if (argument === '--settings' && value) {
    settingsPath = path.resolve(value);
    index += 1;
  } else if (argument === '--session-failover') {
    sessionFailover = true;
  } else if (argument === '--inflight-failover') {
    inflightFailover = true;
  } else if (argument === '--continuation-failover') {
    continuationFailover = true;
  } else {
    throw new Error(
      'Usage: run-managed-agent-server-e2e.ts [--model ID] [--runtime-delay-ms N] [--settings PATH] [--session-failover|--inflight-failover|--continuation-failover]',
    );
  }
}

if (
  [sessionFailover, inflightFailover, continuationFailover].filter(Boolean)
    .length > 1
) {
  throw new Error(
    '--session-failover, --inflight-failover, and --continuation-failover are exclusive',
  );
}

const durableFailover =
  sessionFailover || inflightFailover || continuationFailover;

if (!Number.isSafeInteger(runtimeDelayMs) || runtimeDelayMs < 0) {
  throw new Error('--runtime-delay-ms must be a non-negative integer');
}

const cliBundle = path.join(root, 'dist', 'cli.js');
const runtimeWorker = path.join(root, 'dist', 'managed-runtime-worker.js');
const springJar = path.join(
  root,
  'packages',
  'sdk-java',
  'managed-agent-server',
  'target',
  'qwen-managed-agent-server-0.1.0-alpha.jar',
);
for (const required of [
  cliBundle,
  runtimeWorker,
  springJar,
  ...(durableFailover ? [] : [settingsPath]),
]) {
  if (!existsSync(required)) {
    throw new Error(`Required file is missing: ${required}`);
  }
}

function command(name: string): string {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Required command is missing: ${name}`);
  }
  return realpathSync(result.stdout.trim());
}

const java = command('java');
const mysqld = command('mysqld');
const mysql = command('mysql');
const mysqladmin = command('mysqladmin');
let receivedSignal: NodeJS.Signals | undefined;
const handleSignal = (signal: NodeJS.Signals) => {
  receivedSignal = signal;
};
process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
const temporary = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'managed-agent-server-e2e-')),
);
const workspace = path.join(temporary, 'workspace');
const harnessHome = path.join(temporary, 'harness-home');
const replacementHarnessHome = path.join(temporary, 'replacement-harness-home');
const runtimeHome = path.join(temporary, 'runtime-home');
const replacementRuntimeHome = path.join(temporary, 'replacement-runtime-home');
const runtimeState = path.join(temporary, 'runtime-state');
const mysqlData = path.join(temporary, 'mysql-data');
const mysqlSocket = path.join(temporary, 'mysql.sock');
const mysqlError = path.join(temporary, 'mysql-error.log');
const trustedFolders = path.join(temporary, 'trusted-folders.json');
const delayedNode = path.join(temporary, 'delayed-node');
const sideEffect = path.join(workspace, 'managed-agent-real-e2e.txt');
const sideEffectContent = 'managed agent real model tool execution complete';
const inflightSideEffectScript = path.join(
  workspace,
  'managed-inflight-side-effect.cjs',
);
const inflightSideEffect = path.join(
  workspace,
  'managed-inflight-side-effect.txt',
);
const inflightSideEffectContent = 'MANAGED_INFLIGHT_TOOL_EXECUTED\n';
const workspaceId = createHash('sha256')
  .update(workspace)
  .digest('hex')
  .slice(0, 16);
try {
  for (const directory of [
    workspace,
    path.join(harnessHome, '.qwen'),
    ...(durableFailover
      ? [
          path.join(replacementHarnessHome, '.qwen'),
          path.join(replacementRuntimeHome, '.qwen'),
        ]
      : []),
    path.join(runtimeHome, '.qwen'),
    runtimeState,
    mysqlData,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  if (durableFailover) {
    for (const home of [harnessHome, replacementHarnessHome]) {
      writeFileSync(
        path.join(home, '.qwen', 'settings.json'),
        JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
        { mode: 0o600 },
      );
    }
  } else {
    const sourceSettings = JSON.parse(
      readFileSync(settingsPath, 'utf8'),
    ) as Record<string, unknown>;
    const providerGroups = sourceSettings['modelProviders'] as
      | Record<string, unknown>
      | undefined;
    let selectedProviderGroup: string | undefined;
    let selectedProvider: Record<string, unknown> | undefined;
    for (const [group, entries] of Object.entries(providerGroups ?? {})) {
      const providers = Array.isArray(entries)
        ? entries
        : Object.values((entries ?? {}) as Record<string, unknown>);
      const match = providers.find(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          ((entry as Record<string, unknown>)['id'] === model ||
            (entry as Record<string, unknown>)['name'] === model),
      );
      if (match) {
        selectedProviderGroup = group;
        selectedProvider = match as Record<string, unknown>;
        break;
      }
    }
    if (!selectedProviderGroup || !selectedProvider) {
      throw new Error(
        `Model provider is missing from ${settingsPath}: ${model}`,
      );
    }
    const environmentKey = selectedProvider['envKey'];
    const sourceEnvironment = (sourceSettings['env'] ?? {}) as Record<
      string,
      unknown
    >;
    if (
      typeof environmentKey !== 'string' ||
      typeof (
        sourceEnvironment[environmentKey] ?? process.env[environmentKey]
      ) !== 'string'
    ) {
      throw new Error(`Model credential is missing for ${model}`);
    }
    const harnessSettings = {
      ...(sourceSettings['$version'] === undefined
        ? {}
        : { $version: sourceSettings['$version'] }),
      env: {
        [environmentKey]:
          sourceEnvironment[environmentKey] ?? process.env[environmentKey],
      },
      model: {
        name: model,
        ...(typeof selectedProvider['baseUrl'] === 'string'
          ? { baseUrl: selectedProvider['baseUrl'] }
          : {}),
      },
      modelProviders: { [selectedProviderGroup]: [selectedProvider] },
      ...(sourceSettings['security'] === undefined
        ? {}
        : { security: sourceSettings['security'] }),
      ui: { enableFollowupSuggestions: false },
    };
    writeFileSync(
      path.join(harnessHome, '.qwen', 'settings.json'),
      JSON.stringify(harnessSettings),
      { mode: 0o600 },
    );
  }
  writeFileSync(
    path.join(runtimeHome, '.qwen', 'settings.json'),
    JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
    { mode: 0o600 },
  );
  if (durableFailover) {
    writeFileSync(
      path.join(replacementRuntimeHome, '.qwen', 'settings.json'),
      JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
      { mode: 0o600 },
    );
  }
  writeFileSync(
    trustedFolders,
    JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
    { mode: 0o600 },
  );
  writeFileSync(
    delayedNode,
    `#!/bin/sh\n/bin/sleep ${runtimeDelayMs / 1000}\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    inflightSideEffectScript,
    `const { appendFileSync } = require('node:fs');\nappendFileSync(process.argv[2], ${JSON.stringify(inflightSideEffectContent)}, 'utf8');\nprocess.stdout.write('managed inflight tool complete');\n`,
    { mode: 0o600 },
  );
} catch (error) {
  rmSync(temporary, { recursive: true, force: true });
  throw error;
}

const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(https?|all)_proxy$/i.test(key) &&
      !/^(qwen|dashscope|openai|anthropic|google|gemini|azure|aws|vertex)_/i.test(
        key,
      ) &&
      !/(api_?key|token|secret|password|credentials?)$/i.test(key),
  ),
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type Child = { child: ChildProcess; log: () => string; name: string };
const children: Child[] = [];

function start(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  name: string,
): Child {
  let output = '';
  const child = spawn(executable, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 32_768) output = output.slice(-32_768);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const registered = { child, log: () => output, name };
  children.push(registered);
  return registered;
}

function processTreeExists(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!processTreeExists(child)) return;
  signalProcessTree(child, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (processTreeExists(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processTreeExists(child)) {
    signalProcessTree(child, 'SIGKILL');
    const killDeadline = Date.now() + 5_000;
    while (processTreeExists(child) && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function crashChild(child: ChildProcess, name: string): Promise<void> {
  if (!processTreeExists(child)) {
    throw new Error(`${name} exited before the crash was injected`);
  }
  signalProcessTree(child, 'SIGKILL');
  const deadline = Date.now() + 5_000;
  while (processTreeExists(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processTreeExists(child)) {
    throw new Error(`${name} process tree survived SIGKILL`);
  }
}

async function crashProcess(child: ChildProcess, name: string): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) {
    throw new Error(`${name} exited before the crash was injected`);
  }
  process.kill(child.pid, 'SIGKILL');
  const deadline = Date.now() + 5_000;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`${name} survived SIGKILL`);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a loopback port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

type HeldExecutionStartProxy = {
  baseUrl: string;
  close: () => Promise<void>;
  heldPath: () => string | undefined;
  observations: () => string[];
};

async function startHeldExecutionStartProxy(
  targetOrigin: string,
  holdExecutionStart = true,
): Promise<HeldExecutionStartProxy> {
  let heldPath: string | undefined;
  const observations: string[] = [];
  let closed = false;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const target = new URL(request.url ?? '/', targetOrigin);
      const method = request.method ?? 'GET';
      if (
        holdExecutionStart &&
        method === 'POST' &&
        target.pathname.includes('/executions/') &&
        target.pathname.endsWith(':start')
      ) {
        heldPath ??= target.pathname;
        observations.push(`${method} ${target.pathname} held`);
        request.socket.once('close', () => response.destroy());
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value === undefined ||
          [
            'connection',
            'content-length',
            'host',
            'transfer-encoding',
          ].includes(name)
        ) {
          continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const body = Buffer.concat(chunks);
      const upstream = await fetch(target, {
        method,
        headers,
        ...(['GET', 'HEAD'].includes(method) ? {} : { body }),
      });
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      observations.push(
        `${method} ${target.pathname}${target.search} ${upstream.status}${
          upstream.ok ? '' : ` ${upstreamBody.toString('utf8').slice(0, 500)}`
        }`,
      );
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (
          ![
            'connection',
            'content-encoding',
            'content-length',
            'transfer-encoding',
          ].includes(name)
        ) {
          responseHeaders[name] = value;
        }
      });
      response.writeHead(upstream.status, responseHeaders);
      response.end(upstreamBody);
    })().catch((error: unknown) => {
      if (response.destroyed) return;
      if (!response.headersSent) response.writeHead(502);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Held Runtime Broker proxy omitted its address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    heldPath: () => heldPath,
    observations: () => [...observations],
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function waitUntil(
  name: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  child?: Child,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (receivedSignal) throw new Error(`Interrupted by ${receivedSignal}`);
    if (
      child &&
      (child.child.exitCode !== null || child.child.signalCode !== null)
    ) {
      throw new Error(`${name} exited early\n${child.log()}`);
    }
    try {
      if (await predicate()) return;
    } catch {
      // The dependency is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${name} did not become ready\n${child?.log() ?? ''}`);
}

function runMysql(port: number, sql: string): string {
  const result = spawnSync(
    mysql,
    [
      '--protocol=tcp',
      '--host=127.0.0.1',
      `--port=${port}`,
      '--user=root',
      '--batch',
      '--skip-column-names',
      '--execute',
      sql,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`MySQL command failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

interface PublicSession {
  id: string;
  last_event_id: number;
  status: string;
}

interface PublicEvent {
  sequence: number;
  terminal: boolean;
  type: string;
  data?: unknown;
}

function eventText(event: PublicEvent): string {
  const data = event.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    'text' in data &&
    typeof data.text === 'string'
  ) {
    return data.text;
  }
  return '';
}

interface PublicList<T> {
  data: T[];
}

async function waitForTerminal(
  springUrl: string,
  tenant: string,
  sessionId: string,
  after: number,
  child: Child,
  timeoutMs = 120_000,
): Promise<{ events: PublicEvent[]; lastSequence: number }> {
  const events: PublicEvent[] = [];
  let cursor = after;
  await waitUntil(
    'Managed Turn terminal event',
    async () => {
      const page = await fetchJson<PublicList<PublicEvent>>(
        `${springUrl}/v1/agents/sessions/${sessionId}/events?after=${cursor}&limit=100`,
        { headers: { 'x-qwen-tenant-id': tenant } },
      );
      for (const event of page.data) {
        events.push(event);
        cursor = Math.max(cursor, event.sequence);
      }
      return page.data.some((event) => event.terminal);
    },
    timeoutMs,
    child,
  );
  return { events, lastSequence: cursor };
}

const failoverFirstMarker = 'MANAGED_SESSION_FAILOVER_FIRST_TURN';
const failoverSecondMarker = 'MANAGED_SESSION_FAILOVER_SECOND_TURN';
const failoverFirstResponse = 'FIRST_TURN_DURABLY_COMMITTED';
const failoverSecondResponse = 'SECOND_TURN_RESTORED_CONTEXT';
const failoverMissingResponse = 'SECOND_TURN_CONTEXT_MISSING';
const inflightMarker = 'MANAGED_SESSION_INFLIGHT_FAILOVER';
const inflightResponse = 'INFLIGHT_TURN_RECOVERED';
const continuationMarker = 'MANAGED_SESSION_CONTINUATION_FAILOVER';
const continuationPartial = 'CONTINUATION_PARTIAL';
const continuationResponse = 'CONTINUATION_TURN_RECOVERED';
let continuationModelRequests = 0;
let acceptReplacementContinuation = false;
let releaseContinuationHold = () => {};
const continuationHold = new Promise<void>((resolve) => {
  releaseContinuationHold = resolve;
});

let fake: Awaited<ReturnType<typeof startFakeOpenAIServer>> | undefined;
let heldStartProxy: HeldExecutionStartProxy | undefined;
let replacementBrokerProxy: HeldExecutionStartProxy | undefined;
let failure: unknown;
try {
  const mysqlPort = await freePort();
  const springPort = await freePort();
  const harnessPort = await freePort();
  const brokerPort = await freePort();
  const harnessToken = randomBytes(24).toString('base64url');
  const brokerToken = randomBytes(24).toString('base64url');
  const credentialKey = randomBytes(32).toString('base64');
  const capabilityDigest = `sha256:${randomBytes(32).toString('hex')}`;

  if (durableFailover) {
    fake = await startFakeOpenAIServer(({ body }) => {
      const messages = Array.isArray(body['messages']) ? body['messages'] : [];
      const serialized = JSON.stringify(messages);
      if (continuationFailover && serialized.includes(continuationMarker)) {
        if (!serialized.includes('"role":"tool"')) {
          return {
            toolCalls: [
              fakeToolCall(
                'run_shell_command',
                {
                  command: `${shellQuote(process.execPath)} ${shellQuote(inflightSideEffectScript)} ${shellQuote(inflightSideEffect)}`,
                  is_background: false,
                },
                'call_managed_continuation_failover',
              ),
            ],
          };
        }
        continuationModelRequests += 1;
        if (!acceptReplacementContinuation) {
          return {
            contentChunks: [continuationPartial],
            holdAfterChunks: 1,
            holdUntil: continuationHold,
          };
        }
        return { content: continuationResponse };
      }
      if (inflightFailover && serialized.includes(inflightMarker)) {
        if (!serialized.includes('"role":"tool"')) {
          return {
            toolCalls: [
              fakeToolCall(
                'run_shell_command',
                {
                  command: `${shellQuote(process.execPath)} ${shellQuote(inflightSideEffectScript)} ${shellQuote(inflightSideEffect)}`,
                  is_background: false,
                },
                'call_managed_inflight_failover',
              ),
            ],
          };
        }
        return { content: inflightResponse };
      }
      if (serialized.includes(failoverSecondMarker)) {
        const restored =
          serialized.includes(failoverFirstMarker) &&
          serialized.includes(failoverFirstResponse);
        return {
          content: restored ? failoverSecondResponse : failoverMissingResponse,
        };
      }
      if (serialized.includes(failoverFirstMarker)) {
        return { content: failoverFirstResponse };
      }
      return { content: 'UNEXPECTED_FAILOVER_PROMPT' };
    });
  }
  const fakeBaseUrl = fake?.baseUrl;
  if (durableFailover && fakeBaseUrl === undefined) {
    throw new Error('Fake model server did not start');
  }

  const initialized = spawnSync(
    mysqld,
    ['--no-defaults', '--initialize-insecure', `--datadir=${mysqlData}`],
    { encoding: 'utf8' },
  );
  if (initialized.status !== 0) {
    throw new Error(`MySQL initialization failed: ${initialized.stderr}`);
  }
  const mysqlServer = start(
    mysqld,
    [
      '--no-defaults',
      `--datadir=${mysqlData}`,
      `--socket=${mysqlSocket}`,
      `--port=${mysqlPort}`,
      '--bind-address=127.0.0.1',
      '--mysqlx=0',
      `--pid-file=${path.join(temporary, 'mysql.pid')}`,
      `--log-error=${mysqlError}`,
    ],
    {},
    'MySQL',
  );
  await waitUntil(
    'MySQL',
    () =>
      spawnSync(
        mysqladmin,
        [
          '--protocol=tcp',
          '--host=127.0.0.1',
          `--port=${mysqlPort}`,
          '--user=root',
          'ping',
        ],
        { stdio: 'ignore' },
      ).status === 0,
    60_000,
    mysqlServer,
  );
  runMysql(
    mysqlPort,
    'CREATE DATABASE qwen_managed_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
  );

  const spring = start(
    java,
    ['-jar', springJar],
    {
      env: {
        ...cleanEnvironment,
        HOME: runtimeHome,
        LANG: process.env['LANG'] ?? 'C',
        LC_ALL: process.env['LC_ALL'] ?? 'C',
        NO_PROXY: '127.0.0.1,localhost',
        QWEN_HOME: path.join(runtimeHome, '.qwen'),
        TMPDIR: temporary,
        no_proxy: '127.0.0.1,localhost',
        SERVER_PORT: String(springPort),
        SPRING_DATASOURCE_PASSWORD: '',
        SPRING_DATASOURCE_URL: `jdbc:mysql://127.0.0.1:${mysqlPort}/qwen_managed_agent?useSSL=false&allowPublicKeyRetrieval=true`,
        SPRING_DATASOURCE_USERNAME: 'root',
        QWEN_MANAGED_AGENT_APPROVAL_MODE: 'yolo',
        QWEN_MANAGED_AGENT_CAPABILITY_DIGEST: capabilityDigest,
        QWEN_MANAGED_AGENT_HARNESS_BASE_URL: `http://127.0.0.1:${harnessPort}`,
        QWEN_MANAGED_AGENT_HARNESS_ENABLED: 'true',
        QWEN_MANAGED_AGENT_HARNESS_REQUEST_TIMEOUT: '120s',
        QWEN_MANAGED_AGENT_HARNESS_TOKEN: harnessToken,
        ...(durableFailover
          ? {
              QWEN_MANAGED_AGENT_DISPATCH_LEASE_DURATION: '2s',
              QWEN_MANAGED_AGENT_DISPATCH_LEASE_RENEW_INTERVAL: '500ms',
              QWEN_MANAGED_AGENT_DISPATCH_SCAN_DELAY: '200ms',
              QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL: `http://127.0.0.1:${springPort}`,
              QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED: 'true',
              QWEN_MANAGED_AGENT_SESSION_STORE_WRITER_LEASE_DURATION: '1s',
              QWEN_MANAGED_AGENT_WORKSPACE_ID: workspaceId,
              QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'true',
              QWEN_MANAGED_AGENT_RUNTIME_BROKER_PORT: String(brokerPort),
              QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN: brokerToken,
              QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY: credentialKey,
              QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID: 'e2e-local-v1',
              QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY: runtimeState,
              QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY: runtimeWorker,
              QWEN_MANAGED_AGENT_NODE_EXECUTABLE: process.execPath,
              QWEN_MANAGED_AGENT_CLI_ENTRY: cliBundle,
              QWEN_MANAGED_AGENT_WORKSPACE_CWD: workspace,
            }
          : {
              QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'true',
              QWEN_MANAGED_AGENT_RUNTIME_BROKER_PORT: String(brokerPort),
              QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN: brokerToken,
              QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY: credentialKey,
              QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID: 'e2e-local-v1',
              QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY: runtimeState,
              QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY: runtimeWorker,
              QWEN_MANAGED_AGENT_NODE_EXECUTABLE:
                runtimeDelayMs === 0 ? process.execPath : delayedNode,
              QWEN_MANAGED_AGENT_CLI_ENTRY: cliBundle,
              QWEN_MANAGED_AGENT_WORKSPACE_CWD: workspace,
            }),
      },
    },
    'Spring Managed Agent Server',
  );
  const springUrl = `http://127.0.0.1:${springPort}`;
  await waitUntil(
    'Spring Managed Agent Server',
    async () => {
      const response = await fetch(`${springUrl}/actuator/health`);
      return response.ok;
    },
    60_000,
    spring,
  );
  if (inflightFailover) {
    heldStartProxy = await startHeldExecutionStartProxy(
      `http://127.0.0.1:${brokerPort}`,
    );
  }

  const harness = start(
    process.execPath,
    [
      cliBundle,
      'serve',
      '--profile',
      'hosted-harness',
      '--port',
      String(harnessPort),
      '--hostname',
      '127.0.0.1',
      '--require-auth',
      '--no-web',
      '--workspace',
      workspace,
    ],
    {
      env: {
        ...cleanEnvironment,
        HOME: harnessHome,
        LANG: process.env['LANG'] ?? 'C',
        LC_ALL: process.env['LC_ALL'] ?? 'C',
        QWEN_HOME: path.join(harnessHome, '.qwen'),
        QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFolders,
        QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: capabilityDigest,
        QWEN_SERVER_TOKEN: harnessToken,
        ...(durableFailover
          ? {
              OPENAI_API_KEY: 'fake-key',
              OPENAI_BASE_URL: fakeBaseUrl,
              OPENAI_MODEL: 'fake-model',
              QWEN_MODEL: 'fake-model',
            }
          : {}),
        QWEN_RUNTIME_BROKER_TOKEN: brokerToken,
        QWEN_RUNTIME_BROKER_URL:
          heldStartProxy?.baseUrl ?? `http://127.0.0.1:${brokerPort}`,
      },
    },
    'Hosted Harness',
  );
  await waitUntil(
    'Hosted Harness',
    async () => {
      const response = await fetch(`http://127.0.0.1:${harnessPort}/health`, {
        headers: { authorization: `Bearer ${harnessToken}` },
      });
      return response.ok;
    },
    60_000,
    harness,
  );

  if (durableFailover) {
    const tenant = continuationFailover
      ? 'managed-continuation-failover-e2e'
      : inflightFailover
        ? 'managed-inflight-failover-e2e'
        : 'managed-session-failover-e2e';
    const createResponse = await fetch(`${springUrl}/v1/agents/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `failover-create-${Date.now()}`,
        'x-qwen-tenant-id': tenant,
      },
      body: JSON.stringify({
        agent_id: 'qwen-code',
        input: [
          {
            type: 'text',
            text: continuationFailover
              ? `${continuationMarker}. Execute the requested tool once and reply exactly ${continuationResponse}.`
              : inflightFailover
                ? `${inflightMarker}. Execute the requested tool once and reply exactly ${inflightResponse}.`
                : `${failoverFirstMarker}. Reply exactly ${failoverFirstResponse}.`,
          },
        ],
        metadata: {
          title: continuationFailover
            ? 'Managed continuation owner failover E2E'
            : inflightFailover
              ? 'Managed in-flight owner failover E2E'
              : 'Managed Session owner failover E2E',
        },
      }),
    });
    if (createResponse.status !== 202) {
      throw new Error(
        `Failover Session create returned ${createResponse.status}: ${await createResponse.text()}`,
      );
    }
    const session = (await createResponse.json()) as PublicSession;
    let firstTurnLastSequence = 0;
    let heldExecutionStartPath: string | undefined;
    let originalExecutionCallId: string | undefined;
    if (inflightFailover) {
      if (heldStartProxy === undefined) {
        throw new Error('In-flight failover did not start its Broker proxy');
      }
      try {
        await waitUntil(
          'Runtime execution start boundary',
          () => {
            const observations = heldStartProxy?.observations() ?? [];
            return (
              heldStartProxy?.heldPath() !== undefined ||
              observations.some((observation) =>
                / [45]\d\d(?: |$)/.test(observation),
              )
            );
          },
          120_000,
          harness,
        );
      } catch (error) {
        throw new Error(
          `Runtime execution start boundary failed; proxy=${heldStartProxy.observations().join(' | ') || 'no requests'}`,
          { cause: error },
        );
      }
      heldExecutionStartPath = heldStartProxy.heldPath();
      if (heldExecutionStartPath === undefined) {
        throw new Error(
          `Runtime execution start boundary failed; proxy=${heldStartProxy.observations().join(' | ') || 'no requests'}`,
        );
      }
    } else if (continuationFailover) {
      await waitUntil(
        'Continuation partial text',
        async () => {
          const page = await fetchJson<PublicList<PublicEvent>>(
            `${springUrl}/v1/agents/sessions/${session.id}/events?after=0&limit=100`,
            { headers: { 'x-qwen-tenant-id': tenant } },
          );
          return page.data.some(
            (event) =>
              event.type === 'item.output_text.delta' &&
              eventText(event).includes(continuationPartial),
          );
        },
        120_000,
        harness,
      );
      const execution = runMysql(
        mysqlPort,
        'SELECT execution_call_id, execution_state, dispatch_generation FROM qwen_managed_agent.qwen_tool_execution',
      ).split('\t');
      const sideEffectBytes = existsSync(inflightSideEffect)
        ? readFileSync(inflightSideEffect, 'utf8')
        : '';
      if (
        execution.length !== 3 ||
        execution[0]?.length === 0 ||
        execution[1] !== 'SETTLED' ||
        execution[2] !== '1' ||
        sideEffectBytes !== inflightSideEffectContent
      ) {
        throw new Error(
          `Continuation boundary was not durable: execution=${execution.join(',')} sideEffect=${JSON.stringify(sideEffectBytes)}`,
        );
      }
      originalExecutionCallId = execution[0];
    } else {
      const firstTurn = await waitForTerminal(
        springUrl,
        tenant,
        session.id,
        0,
        spring,
      );
      firstTurnLastSequence = firstTurn.lastSequence;
      const firstTerminal = firstTurn.events.find((event) => event.terminal);
      if (firstTerminal?.type !== 'turn.completed') {
        const storeHead = runMysql(
          mysqlPort,
          `SELECT state, writer_generation, writer_id, writer_lease_until, NOW(6), journal_revision, committed_sequence FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE tenant_id=${sqlString(tenant)} AND session_id=${sqlString(session.id)}`,
        );
        throw new Error(
          `First failover Turn ended with ${firstTerminal?.type ?? 'no terminal event'}; store head=${storeHead || 'missing'}`,
        );
      }
    }

    const sessionFilter = `tenant_id=${sqlString(tenant)} AND session_id=${sqlString(session.id)}`;
    const firstBootId = runMysql(
      mysqlPort,
      `SELECT harness_boot_id FROM qwen_managed_agent.managed_agent_session WHERE ${sessionFilter}`,
    );
    const firstHead = runMysql(
      mysqlPort,
      `SELECT writer_generation, journal_revision, committed_sequence FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE ${sessionFilter}`,
    )
      .split('\t')
      .map(Number);
    if (
      firstBootId.length === 0 ||
      firstHead.length !== 3 ||
      firstHead.some((value) => !Number.isSafeInteger(value) || value < 1)
    ) {
      throw new Error(
        `First owner did not commit a durable private Session: boot=${firstBootId} head=${firstHead.join(',')}`,
      );
    }
    if (inflightFailover) {
      const execution = runMysql(
        mysqlPort,
        'SELECT execution_call_id, execution_state, dispatch_generation, runtime_session_id FROM qwen_managed_agent.qwen_tool_execution',
      ).split('\t');
      const latestCheckpoint = runMysql(
        mysqlPort,
        `SELECT latest_checkpoint_resource_id FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE ${sessionFilter}`,
      );
      if (
        execution.length !== 4 ||
        execution[0]?.length === 0 ||
        execution[1] !== 'PREPARED' ||
        execution[2] !== '0' ||
        execution[3]?.length === 0 ||
        latestCheckpoint.length === 0 ||
        !heldExecutionStartPath?.includes(
          encodeURIComponent(execution[0] ?? ''),
        ) ||
        existsSync(inflightSideEffect)
      ) {
        throw new Error(
          `In-flight boundary was not durable before start: execution=${execution.join(',')} checkpoint=${latestCheckpoint || 'missing'} sideEffect=${existsSync(inflightSideEffect)}`,
        );
      }
      originalExecutionCallId = execution[0];
    }

    await Promise.all([
      crashChild(harness.child, 'Hosted Harness A'),
      inflightFailover || continuationFailover
        ? crashProcess(spring.child, 'Spring Managed Agent Server A')
        : crashChild(spring.child, 'Spring Managed Agent Server A'),
    ]);
    acceptReplacementContinuation = true;
    releaseContinuationHold();
    await heldStartProxy?.close();
    heldStartProxy = undefined;
    rmSync(harnessHome, { recursive: true, force: true });
    rmSync(runtimeHome, { recursive: true, force: true });
    await waitUntil(
      'Managed Session writer lease expiry',
      () =>
        runMysql(
          mysqlPort,
          `SELECT IF(writer_lease_until IS NULL OR writer_lease_until < CURRENT_TIMESTAMP(6), 1, 0) FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE ${sessionFilter}`,
        ) === '1',
      10_000,
    );
    if (inflightFailover || continuationFailover) {
      await waitUntil(
        'Managed Turn dispatch lease expiry',
        () =>
          runMysql(
            mysqlPort,
            `SELECT IF(dispatch_lease_until IS NULL OR dispatch_lease_until < UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000, 1, 0) FROM qwen_managed_agent.managed_agent_turn WHERE ${sessionFilter}`,
          ) === '1',
        10_000,
      );
    }

    const replacementSpringPort = await freePort();
    const replacementHarnessPort = await freePort();
    const replacementBrokerPort = await freePort();
    const replacementSpringUrl = `http://127.0.0.1:${replacementSpringPort}`;
    const replacementSpring = start(
      java,
      ['-jar', springJar],
      {
        env: {
          ...cleanEnvironment,
          HOME: replacementRuntimeHome,
          LANG: process.env['LANG'] ?? 'C',
          LC_ALL: process.env['LC_ALL'] ?? 'C',
          NO_PROXY: '127.0.0.1,localhost',
          QWEN_HOME: path.join(replacementRuntimeHome, '.qwen'),
          TMPDIR: temporary,
          no_proxy: '127.0.0.1,localhost',
          SERVER_PORT: String(replacementSpringPort),
          SPRING_DATASOURCE_PASSWORD: '',
          SPRING_DATASOURCE_URL: `jdbc:mysql://127.0.0.1:${mysqlPort}/qwen_managed_agent?useSSL=false&allowPublicKeyRetrieval=true`,
          SPRING_DATASOURCE_USERNAME: 'root',
          QWEN_MANAGED_AGENT_APPROVAL_MODE: 'yolo',
          QWEN_MANAGED_AGENT_CAPABILITY_DIGEST: capabilityDigest,
          QWEN_MANAGED_AGENT_HARNESS_BASE_URL: `http://127.0.0.1:${replacementHarnessPort}`,
          QWEN_MANAGED_AGENT_HARNESS_ENABLED: 'true',
          QWEN_MANAGED_AGENT_HARNESS_REQUEST_TIMEOUT: '120s',
          QWEN_MANAGED_AGENT_HARNESS_TOKEN: harnessToken,
          QWEN_MANAGED_AGENT_DISPATCH_LEASE_DURATION: '2s',
          QWEN_MANAGED_AGENT_DISPATCH_LEASE_RENEW_INTERVAL: '500ms',
          QWEN_MANAGED_AGENT_DISPATCH_SCAN_DELAY: '200ms',
          QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL: replacementSpringUrl,
          QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED: 'true',
          QWEN_MANAGED_AGENT_SESSION_STORE_WRITER_LEASE_DURATION: '1s',
          QWEN_MANAGED_AGENT_WORKSPACE_ID: workspaceId,
          QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'true',
          QWEN_MANAGED_AGENT_RUNTIME_BROKER_PORT: String(replacementBrokerPort),
          QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN: brokerToken,
          QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY: credentialKey,
          QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID: 'e2e-local-v1',
          QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY: runtimeState,
          QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY: runtimeWorker,
          QWEN_MANAGED_AGENT_NODE_EXECUTABLE: process.execPath,
          QWEN_MANAGED_AGENT_CLI_ENTRY: cliBundle,
          QWEN_MANAGED_AGENT_WORKSPACE_CWD: workspace,
        },
      },
      'Replacement Spring Managed Agent Server',
    );
    await waitUntil(
      'Replacement Spring Managed Agent Server',
      async () => {
        const response = await fetch(`${replacementSpringUrl}/actuator/health`);
        return response.ok;
      },
      60_000,
      replacementSpring,
    );

    if (inflightFailover) {
      replacementBrokerProxy = await startHeldExecutionStartProxy(
        `http://127.0.0.1:${replacementBrokerPort}`,
        false,
      );
    }

    const replacementHarness = start(
      process.execPath,
      [
        cliBundle,
        'serve',
        '--profile',
        'hosted-harness',
        '--port',
        String(replacementHarnessPort),
        '--hostname',
        '127.0.0.1',
        '--require-auth',
        '--no-web',
        '--workspace',
        workspace,
      ],
      {
        env: {
          ...cleanEnvironment,
          HOME: replacementHarnessHome,
          LANG: process.env['LANG'] ?? 'C',
          LC_ALL: process.env['LC_ALL'] ?? 'C',
          QWEN_HOME: path.join(replacementHarnessHome, '.qwen'),
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFolders,
          QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: capabilityDigest,
          QWEN_SERVER_TOKEN: harnessToken,
          OPENAI_API_KEY: 'fake-key',
          OPENAI_BASE_URL: fakeBaseUrl,
          OPENAI_MODEL: 'fake-model',
          QWEN_MODEL: 'fake-model',
          QWEN_RUNTIME_BROKER_TOKEN: brokerToken,
          QWEN_RUNTIME_BROKER_URL:
            replacementBrokerProxy?.baseUrl ??
            `http://127.0.0.1:${replacementBrokerPort}`,
        },
      },
      'Replacement Hosted Harness',
    );
    await waitUntil(
      'Replacement Hosted Harness',
      async () => {
        const response = await fetch(
          `http://127.0.0.1:${replacementHarnessPort}/health`,
          { headers: { authorization: `Bearer ${harnessToken}` } },
        );
        return response.ok;
      },
      60_000,
      replacementHarness,
    );

    if (inflightFailover) {
      const recoveredTurn = await waitForTerminal(
        replacementSpringUrl,
        tenant,
        session.id,
        0,
        replacementSpring,
        30_000,
      );
      const recoveredTerminal = recoveredTurn.events.find(
        (event) => event.terminal,
      );
      const recoveredExecution = runMysql(
        mysqlPort,
        'SELECT execution_call_id, execution_state, dispatch_generation, IF(result_json IS NULL, 0, 1) FROM qwen_managed_agent.qwen_tool_execution',
      ).split('\t');
      const executionCount = Number(
        runMysql(
          mysqlPort,
          'SELECT COUNT(*) FROM qwen_managed_agent.qwen_tool_execution',
        ),
      );
      const replacementBootId = runMysql(
        mysqlPort,
        `SELECT harness_boot_id FROM qwen_managed_agent.managed_agent_session WHERE ${sessionFilter}`,
      );
      const replacementHead = runMysql(
        mysqlPort,
        `SELECT writer_generation, journal_revision, committed_sequence FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE ${sessionFilter}`,
      )
        .split('\t')
        .map(Number);
      const terminalCount = Number(
        runMysql(
          mysqlPort,
          `SELECT COUNT(*) FROM qwen_managed_agent.managed_agent_event WHERE ${sessionFilter} AND terminal=TRUE`,
        ),
      );
      const requests = (fake?.requests ?? []).filter(({ body }) =>
        JSON.stringify(body['messages']).includes(inflightMarker),
      );
      const initialModelRequests = requests.filter(
        ({ body }) =>
          !JSON.stringify(body['messages']).includes('"role":"tool"'),
      );
      const continuationRequests = requests.filter(({ body }) =>
        JSON.stringify(body['messages']).includes('"role":"tool"'),
      );
      const sideEffectBytes = existsSync(inflightSideEffect)
        ? readFileSync(inflightSideEffect, 'utf8')
        : '';
      if (
        recoveredTerminal?.type !== 'turn.completed' ||
        recoveredExecution.length !== 4 ||
        recoveredExecution[0] !== originalExecutionCallId ||
        recoveredExecution[1] !== 'SETTLED' ||
        Number(recoveredExecution[2]) !== 1 ||
        recoveredExecution[3] !== '1' ||
        executionCount !== 1 ||
        replacementBootId.length === 0 ||
        replacementBootId === firstBootId ||
        replacementHead.length !== 3 ||
        replacementHead[0] <= firstHead[0] ||
        replacementHead[1] <= firstHead[1] ||
        replacementHead[2] <= firstHead[2] ||
        terminalCount !== 1 ||
        initialModelRequests.length !== 1 ||
        continuationRequests.length !== 1 ||
        sideEffectBytes !== inflightSideEffectContent
      ) {
        throw new Error(
          `In-flight failover audit failed: terminal=${recoveredTerminal?.type ?? 'missing'} terminalData=${JSON.stringify(recoveredTerminal?.data)} execution=${recoveredExecution.join(',')} rows=${executionCount} boot=${firstBootId}->${replacementBootId} head=${firstHead.join(',')}->${replacementHead.join(',')} terminals=${terminalCount} model=${initialModelRequests.length}+${continuationRequests.length} sideEffect=${JSON.stringify(sideEffectBytes)}`,
        );
      }

      console.log(
        JSON.stringify(
          {
            sessionId: session.id,
            executionCallId: originalExecutionCallId,
            executionState: recoveredExecution[1],
            dispatchGeneration: Number(recoveredExecution[2]),
            firstHarnessBootId: firstBootId,
            replacementHarnessBootId: replacementBootId,
            writerGeneration: `${firstHead[0]} -> ${replacementHead[0]}`,
            journalRevision: `${firstHead[1]} -> ${replacementHead[1]}`,
            committedSequence: `${firstHead[2]} -> ${replacementHead[2]}`,
            promptReplayed: false,
            physicalToolExecutions: 1,
            terminalTurns: terminalCount,
            oldHarnessDiskDeleted: !existsSync(harnessHome),
          },
          null,
          2,
        ),
      );
    } else if (continuationFailover) {
      await waitForTerminal(
        replacementSpringUrl,
        tenant,
        session.id,
        0,
        replacementSpring,
        120_000,
      );
      const finalEvents = await fetchJson<PublicList<PublicEvent>>(
        `${replacementSpringUrl}/v1/agents/sessions/${session.id}/events?after=0&limit=100`,
        { headers: { 'x-qwen-tenant-id': tenant } },
      );
      const recoveredTerminal = finalEvents.data.find(
        (event) => event.terminal,
      );
      const textDeltas = finalEvents.data.filter(
        (event) => event.type === 'item.output_text.delta',
      );
      const visibleText = textDeltas.map((event) => eventText(event)).join('');
      const recoveredExecution = runMysql(
        mysqlPort,
        'SELECT execution_call_id, execution_state, dispatch_generation, IF(result_json IS NULL, 0, 1) FROM qwen_managed_agent.qwen_tool_execution',
      ).split('\t');
      const executionCount = Number(
        runMysql(
          mysqlPort,
          'SELECT COUNT(*) FROM qwen_managed_agent.qwen_tool_execution',
        ),
      );
      const replacementBootId = runMysql(
        mysqlPort,
        `SELECT harness_boot_id FROM qwen_managed_agent.managed_agent_session WHERE ${sessionFilter}`,
      );
      const terminalCount = Number(
        runMysql(
          mysqlPort,
          `SELECT COUNT(*) FROM qwen_managed_agent.managed_agent_event WHERE ${sessionFilter} AND terminal=TRUE`,
        ),
      );
      const requests = (fake?.requests ?? []).filter(({ body }) =>
        JSON.stringify(body['messages']).includes(continuationMarker),
      );
      const initialModelRequests = requests.filter(
        ({ body }) =>
          !JSON.stringify(body['messages']).includes('"role":"tool"'),
      );
      const continuationRequests = requests.filter(({ body }) =>
        JSON.stringify(body['messages']).includes('"role":"tool"'),
      );
      const sideEffectBytes = existsSync(inflightSideEffect)
        ? readFileSync(inflightSideEffect, 'utf8')
        : '';
      if (
        recoveredTerminal?.type !== 'turn.completed' ||
        visibleText !== continuationResponse ||
        visibleText.includes(continuationPartial) ||
        recoveredExecution.length !== 4 ||
        recoveredExecution[0] !== originalExecutionCallId ||
        recoveredExecution[1] !== 'SETTLED' ||
        Number(recoveredExecution[2]) !== 1 ||
        recoveredExecution[3] !== '1' ||
        executionCount !== 1 ||
        replacementBootId.length === 0 ||
        replacementBootId === firstBootId ||
        terminalCount !== 1 ||
        initialModelRequests.length !== 1 ||
        continuationRequests.length < 2 ||
        sideEffectBytes !== inflightSideEffectContent
      ) {
        throw new Error(
          `Continuation failover audit failed: terminal=${recoveredTerminal?.type ?? 'missing'} text=${JSON.stringify(visibleText)} deltas=${JSON.stringify(textDeltas)} execution=${recoveredExecution.join(',')} rows=${executionCount} boot=${firstBootId}->${replacementBootId} terminals=${terminalCount} model=${initialModelRequests.length}+${continuationRequests.length} sideEffect=${JSON.stringify(sideEffectBytes)}`,
        );
      }
      console.log(
        JSON.stringify(
          {
            sessionId: session.id,
            executionCallId: originalExecutionCallId,
            firstHarnessBootId: firstBootId,
            replacementHarnessBootId: replacementBootId,
            promptReplayed: false,
            physicalToolExecutions: 1,
            continuationModelRequests: continuationRequests.length,
            visibleText,
            terminalTurns: terminalCount,
            oldHarnessDiskDeleted: !existsSync(harnessHome),
          },
          null,
          2,
        ),
      );
    } else {
      const secondResponse = await fetch(
        `${replacementSpringUrl}/v1/agents/sessions/${session.id}/events`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `failover-second-${Date.now()}`,
            'x-qwen-tenant-id': tenant,
          },
          body: JSON.stringify({
            type: 'agent.session.input.message',
            input: [
              {
                type: 'text',
                text: `${failoverSecondMarker}. Use the prior conversation and reply exactly ${failoverSecondResponse}.`,
              },
            ],
          }),
        },
      );
      if (secondResponse.status !== 202) {
        throw new Error(
          `Second failover Turn returned ${secondResponse.status}: ${await secondResponse.text()}`,
        );
      }
      const secondTurn = await waitForTerminal(
        replacementSpringUrl,
        tenant,
        session.id,
        firstTurnLastSequence,
        replacementSpring,
      );
      const secondTerminal = secondTurn.events.find((event) => event.terminal);
      if (secondTerminal?.type !== 'turn.completed') {
        throw new Error(
          `Second failover Turn ended with ${secondTerminal?.type ?? 'no terminal event'}`,
        );
      }

      const secondRequest = [...(fake?.requests ?? [])]
        .reverse()
        .find(({ body }) =>
          JSON.stringify(body['messages']).includes(failoverSecondMarker),
        );
      const restoredMessages = JSON.stringify(
        secondRequest?.body['messages'] ?? [],
      );
      if (
        !restoredMessages.includes(failoverFirstMarker) ||
        !restoredMessages.includes(failoverFirstResponse) ||
        restoredMessages.includes(failoverMissingResponse)
      ) {
        throw new Error(
          'Replacement Harness did not restore first-Turn context',
        );
      }

      const secondBootId = runMysql(
        mysqlPort,
        `SELECT harness_boot_id FROM qwen_managed_agent.managed_agent_session WHERE ${sessionFilter}`,
      );
      const secondHead = runMysql(
        mysqlPort,
        `SELECT writer_generation, journal_revision, committed_sequence FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE ${sessionFilter}`,
      )
        .split('\t')
        .map(Number);
      const terminalCount = Number(
        runMysql(
          mysqlPort,
          `SELECT COUNT(*) FROM qwen_managed_agent.managed_agent_event WHERE ${sessionFilter} AND terminal=TRUE`,
        ),
      );
      if (
        secondBootId.length === 0 ||
        secondBootId === firstBootId ||
        secondHead.length !== 3 ||
        secondHead[0] <= firstHead[0] ||
        secondHead[1] <= firstHead[1] ||
        secondHead[2] <= firstHead[2] ||
        terminalCount !== 2
      ) {
        throw new Error(
          `Failover audit failed: boot=${firstBootId}->${secondBootId} head=${firstHead.join(',')}->${secondHead.join(',')} terminals=${terminalCount}`,
        );
      }

      console.log(
        JSON.stringify(
          {
            sessionId: session.id,
            firstHarnessBootId: firstBootId,
            replacementHarnessBootId: secondBootId,
            writerGeneration: `${firstHead[0]} -> ${secondHead[0]}`,
            journalRevision: `${firstHead[1]} -> ${secondHead[1]}`,
            committedSequence: `${firstHead[2]} -> ${secondHead[2]}`,
            terminalTurns: terminalCount,
            restoredFirstTurnContext: true,
            oldHarnessDiskDeleted: !existsSync(harnessHome),
          },
          null,
          2,
        ),
      );
    }
  } else {
    const tenant = 'real-model-e2e';
    const idempotencyKey = `create-${Date.now()}`;
    const prompt = [
      'Before using any tool, emit the visible text MODEL_READY.',
      'Then call write_file exactly once to write the exact text',
      JSON.stringify(sideEffectContent),
      'to this absolute path:',
      JSON.stringify(sideEffect),
      'After the tool succeeds, reply TOOL_DONE. Do not ask a question.',
    ].join(' ');
    const body = JSON.stringify({
      agent_id: 'qwen-code',
      input: [{ type: 'text', text: prompt }],
      metadata: { title: 'Real model cold Runtime E2E' },
    });
    const requestStartedAt = Date.now();
    const createResponse = await fetch(`${springUrl}/v1/agents/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-qwen-tenant-id': tenant,
      },
      body,
    });
    if (createResponse.status !== 202) {
      throw new Error(
        `Session create returned ${createResponse.status}: ${await createResponse.text()}`,
      );
    }
    const createdAt = Date.now();
    const session = (await createResponse.json()) as PublicSession;
    const observed = new Map<
      number,
      { event: PublicEvent; observedAt: number }
    >();
    let after = 0;
    await waitUntil(
      'Managed Turn terminal event',
      async () => {
        const page = await fetchJson<PublicList<PublicEvent>>(
          `${springUrl}/v1/agents/sessions/${session.id}/events?after=${after}&limit=100`,
          { headers: { 'x-qwen-tenant-id': tenant } },
        );
        const now = Date.now();
        for (const event of page.data) {
          observed.set(event.sequence, { event, observedAt: now });
          after = Math.max(after, event.sequence);
        }
        return page.data.some((event) => event.terminal);
      },
      180_000,
      spring,
    );

    const ordered = [...observed.values()].sort(
      (left, right) => left.event.sequence - right.event.sequence,
    );
    const firstModel = ordered.find(({ event }) =>
      ['item.output_text.delta', 'item.reasoning.delta'].includes(event.type),
    );
    const runtimeReady = ordered.find(
      ({ event }) => event.type === 'environment.ready',
    );
    const tool = ordered.find(
      ({ event }) => event.type === 'item.tool_call.updated',
    );
    const terminal = ordered.find(({ event }) => event.terminal);
    if (!firstModel || !runtimeReady || !tool || !terminal) {
      throw new Error(
        `Expected model, Runtime, tool, and terminal events; got ${ordered.map(({ event }) => event.type).join(', ')}`,
      );
    }
    if (terminal.event.type !== 'turn.completed') {
      throw new Error(`Managed Turn ended with ${terminal.event.type}`);
    }
    if (
      runtimeDelayMs > 0 &&
      firstModel.event.sequence >= runtimeReady.event.sequence
    ) {
      throw new Error('First model event did not precede Runtime readiness');
    }
    if (!existsSync(sideEffect)) {
      throw new Error('Tool side effect file was not created');
    }
    if (readFileSync(sideEffect, 'utf8') !== sideEffectContent) {
      throw new Error('Tool side effect content did not match');
    }

    const replay = await fetch(`${springUrl}/v1/agents/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-qwen-tenant-id': tenant,
      },
      body,
    });
    const replaySession = (await replay.json()) as PublicSession;
    if (
      replay.status !== 202 ||
      replaySession.id !== session.id ||
      replay.headers.get('x-qwen-idempotent-replay') !== 'true'
    ) {
      throw new Error('Idempotent create replay did not return the Session');
    }
    const crossTenant = await fetch(
      `${springUrl}/v1/agents/sessions/${session.id}`,
      { headers: { 'x-qwen-tenant-id': 'other-tenant' } },
    );
    if (crossTenant.status !== 404) {
      throw new Error(`Cross-tenant lookup returned ${crossTenant.status}`);
    }
    const durable = runMysql(
      mysqlPort,
      `SELECT COUNT(*), COUNT(DISTINCT sequence_id), SUM(terminal) FROM qwen_managed_agent.managed_agent_event WHERE tenant_id='${tenant}' AND session_id='${session.id}'`,
    ).split('\t');
    if (
      durable.length !== 3 ||
      durable[0] !== durable[1] ||
      durable[2] !== '1'
    ) {
      throw new Error(`Durable event audit failed: ${durable.join(',')}`);
    }

    console.log(
      JSON.stringify(
        {
          model,
          sessionId: session.id,
          createAdmissionMs: createdAt - requestStartedAt,
          firstModelEventMs: firstModel.observedAt - requestStartedAt,
          runtimeReadyMs: runtimeReady.observedAt - requestStartedAt,
          terminalMs: terminal.observedAt - requestStartedAt,
          modelBeforeRuntimeReady:
            firstModel.event.sequence < runtimeReady.event.sequence,
          toolSideEffect: true,
          idempotentReplay: true,
          crossTenantStatus: crossTenant.status,
          durableEventCount: Number(durable[0]),
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  failure = error;
  console.error(error);
  if (replacementBrokerProxy !== undefined) {
    console.error(
      `\n--- Replacement Runtime Broker requests ---\n${replacementBrokerProxy.observations().join('\n')}`,
    );
  }
  for (const child of children) {
    console.error(`\n--- ${child.name} tail ---\n${child.log()}`);
  }
  if (existsSync(mysqlError)) {
    console.error(
      `\n--- MySQL error tail ---\n${readFileSync(mysqlError, 'utf8').slice(-16_384)}`,
    );
  }
} finally {
  for (const child of children.reverse()) {
    await stopChild(child.child);
  }
  await heldStartProxy?.close();
  await replacementBrokerProxy?.close();
  releaseContinuationHold();
  await fake?.close();
  rmSync(temporary, { recursive: true, force: true });
  process.removeListener('SIGINT', handleSignal);
  process.removeListener('SIGTERM', handleSignal);
}

if (failure) throw failure;
