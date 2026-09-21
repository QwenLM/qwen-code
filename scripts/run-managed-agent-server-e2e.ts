import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const argumentsList = process.argv.slice(2);
let model = 'moonshot/kimi-k3';
let runtimeDelayMs = 0;
let settingsPath = path.join(homedir(), '.qwen', 'settings.json');

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
  } else {
    throw new Error(
      'Usage: run-managed-agent-server-e2e.ts [--model ID] [--runtime-delay-ms N] [--settings PATH]',
    );
  }
}

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
for (const required of [cliBundle, runtimeWorker, springJar, settingsPath]) {
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
const runtimeHome = path.join(temporary, 'runtime-home');
const runtimeState = path.join(temporary, 'runtime-state');
const mysqlData = path.join(temporary, 'mysql-data');
const mysqlSocket = path.join(temporary, 'mysql.sock');
const mysqlError = path.join(temporary, 'mysql-error.log');
const trustedFolders = path.join(temporary, 'trusted-folders.json');
const delayedNode = path.join(temporary, 'delayed-node');
const sideEffect = path.join(workspace, 'managed-agent-real-e2e.txt');
const sideEffectContent = 'managed agent real model tool execution complete';
try {
  for (const directory of [
    workspace,
    path.join(harnessHome, '.qwen'),
    path.join(runtimeHome, '.qwen'),
    runtimeState,
    mysqlData,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
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
    throw new Error(`Model provider is missing from ${settingsPath}: ${model}`);
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
  writeFileSync(
    path.join(runtimeHome, '.qwen', 'settings.json'),
    JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
    { mode: 0o600 },
  );
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
}

interface PublicList<T> {
  data: T[];
}

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
        QWEN_RUNTIME_BROKER_TOKEN: brokerToken,
        QWEN_RUNTIME_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
        QWEN_SERVER_TOKEN: harnessToken,
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
  if (durable.length !== 3 || durable[0] !== durable[1] || durable[2] !== '1') {
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
} catch (error) {
  failure = error;
  console.error(error);
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
  rmSync(temporary, { recursive: true, force: true });
  process.removeListener('SIGINT', handleSignal);
  process.removeListener('SIGTERM', handleSignal);
}

if (failure) throw failure;
