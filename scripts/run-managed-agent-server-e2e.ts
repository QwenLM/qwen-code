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
import { isDeepStrictEqual } from 'node:util';

const root = process.cwd();
const verificationMode = process.env['G3_VERIFY_MODE'];
if (
  verificationMode &&
  !['allow', 'deny', 'cancel', 'expiry', 'continuation'].includes(
    verificationMode,
  )
) {
  throw new Error(
    'G3_VERIFY_MODE must be allow, deny, cancel, expiry or continuation',
  );
}
const approvalRecovery =
  !!verificationMode && verificationMode !== 'continuation';
const verificationDirectory = path.resolve(
  root,
  process.env['G3_VERIFY_REPORT_DIR'] ??
    `.qwen/investigations/g3-step3-implementation/packaged-${verificationMode}-${Date.now()}`,
);
if (verificationMode) mkdirSync(verificationDirectory, { recursive: true });
const reliefMarker = 'G3_STEP3_RELIEF_TURN';
const reliefResponse = 'G3_STEP3_RELIEF_COMPLETED';
let originalApprovalId: string | undefined;
interface SavedApprovalOptions {
  v: number;
  policyRevision: string;
  continuationRef: { resourceId: string };
}
interface SavedApprovalPlan {
  calls: { prepareKey: string; requestDigest: string }[];
  actionId: string;
  stage: string;
  batchId: string;
  runtime: {
    runtimeSessionId: string;
    bindingId: string;
    generation: string;
    workspaceGeneration: string;
  };
}
let originalApprovalOptions: SavedApprovalOptions | undefined;
let originalApprovalPlan: SavedApprovalPlan | undefined;
let verifiedOriginalTerminal: string | undefined;
function saveEvidence(name: string, body: unknown): void {
  if (!verificationMode) return;
  writeFileSync(
    path.join(verificationDirectory, name),
    JSON.stringify(body, null, 2) + '\n',
  );
}

const argumentsList = process.argv.slice(2);
let model = 'moonshot/kimi-k3';
let runtimeDelayMs = 0;
let settingsPath = path.join(homedir(), '.qwen', 'settings.json');
let sessionFailover = false;
let inflightFailover = false;
let continuationFailover = false;
let bigOutput = false;
let harnessOnly = false;
let freeze = false;

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
  } else if (argument === '--big-output') {
    bigOutput = true;
  } else if (argument === '--continuation-failover') {
    continuationFailover = true;
  } else if (argument === '--harness-only') {
    harnessOnly = true;
  } else if (argument === '--freeze') {
    freeze = true;
  } else {
    throw new Error(
      'Usage: run-managed-agent-server-e2e.ts [--model ID] [--runtime-delay-ms N] [--settings PATH] [--session-failover|--inflight-failover|--continuation-failover|--big-output] [--harness-only] [--freeze]',
    );
  }
}

if (
  [sessionFailover, inflightFailover, continuationFailover, bigOutput].filter(
    Boolean,
  ).length > 1
) {
  throw new Error('The deterministic E2E modes are exclusive');
}
if (
  harnessOnly &&
  !(sessionFailover || inflightFailover || continuationFailover)
) {
  throw new Error('--harness-only requires one of the failover modes');
}
if (freeze && (!continuationFailover || harnessOnly)) {
  throw new Error(
    '--freeze requires --continuation-failover without --harness-only',
  );
}

if (verificationMode && (!continuationFailover || !harnessOnly || freeze)) {
  throw new Error(
    'This isolated Step 3 probe requires --continuation-failover --harness-only',
  );
}

const durableFailover =
  sessionFailover || inflightFailover || continuationFailover || bigOutput;
const runtimeTakeover = inflightFailover || continuationFailover;
const workspaceTurns = runtimeTakeover || bigOutput;
// The tool-driven modes take over a dead Runtime binding, which needs the
// durable local-Worker reclaim from the W0e line — Linux-only today. With
// --harness-only the Spring and its Broker stay alive, the worker is never
// orphaned, and no reclaim is needed.
if (runtimeTakeover && !harnessOnly && process.platform !== 'linux') {
  throw new Error(
    `${inflightFailover ? '--inflight-failover' : '--continuation-failover'} requires Linux: the replacement owner must retire the dead worker's Runtime binding through the durable local-Worker reclaim (#12380 W0e), which only runs on Linux. Run the mode in the Hosted MySQL CI job or a Linux container.`,
  );
}
// The Stage A acceptance criterion names a 15-second Runtime delay; the
// real-provider TTFT margin under it is unrecorded (tracked in #12941).
const modelBeforeRuntimeAssertionDelayMs = 15_000;
// The frozen-arm teardown wakes the former writer by this registry key, so
// the start name and the wake-up lookup must share it (a rename drift
// would leave a stopped child wedged on the runner).
const hostedHarnessLabel = 'Hosted Harness';

if (!Number.isSafeInteger(runtimeDelayMs) || runtimeDelayMs < 0) {
  throw new Error('--runtime-delay-ms must be a non-negative integer');
}

const cliBundle = path.join(root, 'dist', 'cli.js');
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
const mysqldUserArguments = process.getuid?.() === 0 ? ['--user=root'] : [];
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
const sideEffectName = 'managed-agent-real-e2e.txt';
const sideEffectContent = 'managed agent real model tool execution complete';
const workspaceMount = path.join(temporary, 'workspace-mount');
const sideEffect = path.join(workspaceMount, sideEffectName);
const boundWorkspaceId = 'e2e-workspace';
const boundStorageId = 'e2e-storage';
const trustedActorHeader = 'x-qwen-e2e-trusted-actor';
const trustedActor = 'e2e-actor';
const inflightSideEffectName = 'managed-inflight-side-effect.txt';
const inflightSideEffect = path.join(workspaceMount, inflightSideEffectName);
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
    workspaceMount,
    path.join(runtimeHome, '.qwen'),
    runtimeState,
    mysqlData,
  ]) {
    // The durable local-Runtime store refuses a directory not private to its
    // owner, so the state directory gets owner-only permissions.
    mkdirSync(directory, {
      recursive: true,
      ...(directory === runtimeState && workspaceTurns ? { mode: 0o700 } : {}),
    });
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

const allocatedPorts = new Set<number>();

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
  if (allocatedPorts.has(address.port)) return freePort();
  allocatedPorts.add(address.port);
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
      observations.push(`${method} ${target.pathname} received`);
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
  const port = await freePort();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
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
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`MySQL command failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function assertStoredAnswer(
  port: number,
  tenant: string,
  sessionId: string,
  expected: string,
): void {
  const rows = runMysql(
    port,
    `SELECT resource_id, kind, byte_length, sha256, HEX(inline_bytes) FROM qwen_managed_agent.qwen_managed_session_resource WHERE tenant_id=${sqlString(tenant)} AND session_id=${sqlString(sessionId)} AND kind IN ('managed-message', 'managed-message-chunks', 'managed-message-part')`,
  ).split('\n');
  const bodies = new Map<string, { kind: string; bytes: Buffer }>();
  for (const row of rows) {
    const [id, kind, length, digest, hex] = row.split('\t');
    const bytes = Buffer.from(hex ?? '', 'hex');
    const actualDigest = createHash('sha256').update(bytes).digest('hex');
    let reason: string | undefined;
    if (!id) reason = 'missing resource id';
    else if (!kind) reason = 'missing resource kind';
    else if (!hex || hex === 'NULL') reason = 'missing inline bytes';
    else if (bytes.length !== Number(length))
      reason = `byte_length=${length} actual=${bytes.length}`;
    else if (actualDigest !== digest)
      reason = `sha256=${digest} actual=${actualDigest}`;
    else if (bytes.length > 65_536)
      reason = `inline body ${bytes.length}B exceeds 65536B`;
    if (reason) {
      throw new Error(
        `Stored message resource failed validation: kind=${kind ?? 'unknown'} id=${id ?? 'unknown'} ${reason}`,
      );
    }
    bodies.set(id, { kind, bytes });
  }
  const records = [...bodies.entries()]
    .filter(([, { kind }]) => kind !== 'managed-message-part')
    .map(([id, { kind, bytes }]) => {
      if (kind === 'managed-message-chunks') {
        let manifest: { parts: Array<{ resourceId: string }> };
        try {
          manifest = JSON.parse(bytes.toString('utf8')) as typeof manifest;
        } catch {
          throw new Error(
            `Stored message manifest is invalid JSON: kind=${kind} id=${id}`,
          );
        }
        bytes = Buffer.concat(
          manifest.parts.map((part) => {
            const stored = bodies.get(part.resourceId);
            if (stored?.kind !== 'managed-message-part')
              throw new Error(
                `Stored message part is missing: kind=managed-message-part id=${part.resourceId} manifest=${id}`,
              );
            return stored.bytes;
          }),
        );
      }
      try {
        return JSON.parse(bytes.toString('utf8')) as {
          type: string;
          uuid: string;
          parentUuid: string;
          message?: { parts?: Array<{ text?: string }> };
        };
      } catch {
        throw new Error(
          `Stored message ${kind === 'managed-message-chunks' ? 'joined-chunk' : 'inline'} record is invalid JSON: kind=${kind} id=${id}`,
        );
      }
    });
  const answers = records.filter(
    (record) =>
      record.type === 'assistant' &&
      record.message?.parts?.map((part) => part.text ?? '').join('') ===
        expected,
  );
  if (answers.length !== 1 || !answers[0].uuid || !answers[0].parentUuid)
    throw new Error('Stored answer is incomplete or duplicated');
  const manifests = [...bodies.values()].filter(
    ({ kind }) => kind === 'managed-message-chunks',
  );
  if (manifests.length !== 1)
    throw new Error(
      `Expected exactly one managed-message-chunks manifest, found ${manifests.length}`,
    );
}

function assertPublicAnswer(events: PublicEvent[], expected: string): void {
  const terminal = events.filter((event) => event.terminal);
  const text = events
    .filter((event) => event.type === 'item.output_text.delta')
    .map(eventText)
    .join('');
  if (
    terminal.length !== 1 ||
    terminal[0].type !== 'turn.completed' ||
    text !== expected
  ) {
    throw new Error(
      `Long-answer integrity failed: terminal=${terminal.map((event) => event.type)} expectedChars=${expected.length} actualChars=${text.length}`,
    );
  }
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

function tenantHeaders(tenant: string): Record<string, string> {
  return {
    'x-qwen-tenant-id': tenant,
    [trustedActorHeader]: trustedActor,
  };
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
        { headers: tenantHeaders(tenant) },
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
const bigOutputSource = 'abcdefghijklmnopqrstu长😀'.repeat(
  bigOutput ? 8_000 : 0,
);
const failoverFirstResponse = bigOutput
  ? Array.from({ length: 48 }, (_, index) => {
      // Distinct prefixes keep the provider's cumulative-stream detection out
      // of this storage regression without changing its character/byte sizes.
      return (
        String(index).padStart(4, '0') +
        bigOutputSource.slice(index * 4_000 + 4, (index + 1) * 4_000)
      );
    }).join('')
  : 'FIRST_TURN_DURABLY_COMMITTED';
const failoverSecondResponse = bigOutput
  ? 'CONTROL_ANSWER__'.repeat(500)
  : 'SECOND_TURN_RESTORED_CONTEXT';
const failoverMissingResponse = 'SECOND_TURN_CONTEXT_MISSING';
const inflightMarker = 'MANAGED_SESSION_INFLIGHT_FAILOVER';
const inflightResponse = 'INFLIGHT_TURN_RECOVERED';
const continuationMarker = 'MANAGED_SESSION_CONTINUATION_FAILOVER';
const continuationPartial = 'CONTINUATION_PARTIAL';
const continuationResponse = 'CONTINUATION_TURN_RECOVERED';
let acceptReplacementContinuation = false;
let releaseContinuationHold = () => {};
const continuationHold = new Promise<void>((resolve) => {
  releaseContinuationHold = resolve;
});

let fake: Awaited<ReturnType<typeof startFakeOpenAIServer>> | undefined;
let heldStartProxy: HeldExecutionStartProxy | undefined;
let replacementBrokerProxy: HeldExecutionStartProxy | undefined;
let failure: unknown;
let dumpPort: number | undefined;
try {
  const harnessToken = randomBytes(24).toString('base64url');
  const brokerToken = randomBytes(24).toString('base64url');
  const credentialKey = randomBytes(32).toString('base64');
  const capabilityDigest = `sha256:${randomBytes(32).toString('hex')}`;
  const tenant = continuationFailover
    ? 'managed-continuation-failover-e2e'
    : inflightFailover
      ? 'managed-inflight-failover-e2e'
      : bigOutput
        ? 'managed-big-output-e2e'
        : sessionFailover
          ? 'managed-session-failover-e2e'
          : 'real-model-e2e';
  const springArguments = ['-jar', springJar];
  springArguments.push(
    `--qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=${tenant}`,
    `--qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=${boundStorageId}`,
    `--qwen.managed-agent.runtime-broker.workspace-mounts[0].root=${workspaceMount}`,
  );

  if (durableFailover) {
    fake = await startFakeOpenAIServer(({ body }) => {
      const messages = Array.isArray(body['messages']) ? body['messages'] : [];
      const serialized = JSON.stringify(messages);
      // Match the new current input before any marker from restored history.
      if (serialized.includes(reliefMarker)) return { content: reliefResponse };

      if (continuationFailover && serialized.includes(continuationMarker)) {
        if (!serialized.includes('"role":"tool"')) {
          return {
            toolCalls: [
              fakeToolCall(
                'write_file',
                {
                  file_path: inflightSideEffectName,
                  content: inflightSideEffectContent,
                },
                'call_managed_continuation_failover',
              ),
            ],
          };
        }
        if (approvalRecovery) return { content: continuationResponse };
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
                'write_file',
                {
                  file_path: inflightSideEffectName,
                  content: inflightSideEffectContent,
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
        return bigOutput
          ? {
              contentChunks: Array.from({ length: 48 }, (_, index) =>
                failoverFirstResponse.slice(index * 4_000, (index + 1) * 4_000),
              ),
            }
          : { content: failoverFirstResponse };
      }
      return { content: 'UNEXPECTED_FAILOVER_PROMPT' };
    });
  }
  const fakeBaseUrl = fake?.baseUrl;
  if (durableFailover && fakeBaseUrl === undefined) {
    throw new Error('Fake model server did not start');
  }

  const mysqlPort = await freePort();
  dumpPort = mysqlPort;
  const springPort = await freePort();
  const harnessPort = await freePort();
  const brokerPort = await freePort();

  const initialized = spawnSync(
    mysqld,
    [
      '--no-defaults',
      ...mysqldUserArguments,
      '--initialize-insecure',
      `--datadir=${mysqlData}`,
    ],
    { encoding: 'utf8' },
  );
  if (initialized.status !== 0) {
    throw new Error(`MySQL initialization failed: ${initialized.stderr}`);
  }
  const mysqlServer = start(
    mysqld,
    [
      '--no-defaults',
      ...mysqldUserArguments,
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
    springArguments,
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
        QWEN_MANAGED_AGENT_APPROVAL_MODE: approvalRecovery ? 'default' : 'yolo',
        QWEN_MANAGED_AGENT_APPROVAL_TIMEOUT:
          verificationMode === 'expiry' ? '30s' : '5m',
        QWEN_MANAGED_AGENT_CAPABILITY_DIGEST: capabilityDigest,
        QWEN_MANAGED_AGENT_HARNESS_BASE_URL: `http://127.0.0.1:${harnessPort}`,
        QWEN_MANAGED_AGENT_HARNESS_ENABLED: 'true',
        QWEN_MANAGED_AGENT_HARNESS_REQUEST_TIMEOUT: '120s',
        QWEN_MANAGED_AGENT_HARNESS_TOKEN: harnessToken,
        // Trusted reboot recovery stays pinned off in every runner mode;
        // durable local process follows runtimeTakeover. Both pins keep each
        // mode's previously verified behavior and keep the runner starting
        // off Linux.
        QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY: 'false',
        QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER: trustedActorHeader,
        QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED: 'true',
        ...(runtimeTakeover
          ? {
              QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS:
                process.platform === 'linux' ? 'true' : 'false',
            }
          : {
              QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS: 'false',
            }),
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
              QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY: cliBundle,
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
              QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY: cliBundle,
              QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL: `http://127.0.0.1:${springPort}`,
              QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED: 'true',
              QWEN_MANAGED_AGENT_SESSION_STORE_WRITER_LEASE_DURATION: '60s',
              QWEN_MANAGED_AGENT_WORKSPACE_ID: workspaceId,
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
  runMysql(
    mysqlPort,
    `INSERT INTO qwen_managed_agent.managed_workspace_registry (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state) VALUES (${sqlString(tenant)}, ${sqlString(boundWorkspaceId)}, 1, ${sqlString(boundStorageId)}, 'E2E', 'managed-runtime-tools/1', 'preapproved-workspace-tools/1', 'ACTIVE')`,
  );
  runMysql(
    mysqlPort,
    `INSERT INTO qwen_managed_agent.managed_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (${sqlString(tenant)}, ${sqlString(boundWorkspaceId)}, ${sqlString(trustedActor)}, 'OPERATOR')`,
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
      '--managed-runtime-broker-url',
      heldStartProxy?.baseUrl ?? `http://127.0.0.1:${brokerPort}`,
      // Joined form: a base64url token can start with '-', which argv
      // would otherwise parse as another flag.
      `--managed-runtime-broker-token=${brokerToken}`,
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
    hostedHarnessLabel,
  );
  await waitUntil(
    'Hosted Harness',
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${harnessPort}/health?deep=1`,
        {
          headers: { authorization: `Bearer ${harnessToken}` },
        },
      );
      return response.ok;
    },
    60_000,
    harness,
  );

  if (durableFailover) {
    const createResponse = await fetch(`${springUrl}/v1/agents/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `failover-create-${Date.now()}`,
        ...tenantHeaders(tenant),
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
                : bigOutput
                  ? `${failoverFirstMarker}. Produce the configured long answer.`
                  : `${failoverFirstMarker}. Reply exactly ${failoverFirstResponse}.`,
          },
        ],
        ...(workspaceTurns
          ? { workspace: { workspace_id: boundWorkspaceId } }
          : {}),
        metadata: {
          title: continuationFailover
            ? 'Managed continuation owner failover E2E'
            : inflightFailover
              ? 'Managed in-flight owner failover E2E'
              : bigOutput
                ? 'Managed long-answer persistence E2E'
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
    let originalRuntimeSessionId: string | undefined;
    // The runtime_session_id column is written once at INSERT and never
    // rewritten, so an equality pin cannot fail. The harness-only arms
    // therefore also compare the row's own liveness metric before and
    // after the crash: a surviving worker's re-attach renews it.
    function runtimeSessionHeartbeat(
      runtimeSessionId: string,
    ): [string, number] {
      const row = runMysql(
        mysqlPort,
        `SELECT last_active_at, record_version FROM qwen_managed_agent.qwen_runtime_session WHERE runtime_session_id = ${sqlString(runtimeSessionId)}`,
      ).split('\t');
      if (row.length !== 2 || row[1].length === 0)
        throw new Error(`Runtime session row missing (${runtimeSessionId})`);
      return [row[0], Number(row[1])];
    }
    let firstRuntimeHeartbeat: [string, number] | undefined;
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
    } else if (approvalRecovery) {
      await waitUntil(
        'Original requested approval',
        async () => {
          const page = await fetchJson<PublicList<Record<string, unknown>>>(
            `${springUrl}/v1/agents/sessions/${session.id}/actions?limit=100`,
            { headers: tenantHeaders(tenant) },
          );
          const requested = page.data.filter(
            (action) => action.state === 'requested',
          );
          if (requested.length !== 1) return false;
          originalApprovalId = String(requested[0].id);
          return originalApprovalId.startsWith('tool_approval_');
        },
        120_000,
        harness,
      );
      const actionFilter = `tenant_id=${sqlString(tenant)} AND session_id=${sqlString(session.id)} AND action_id=${sqlString(originalApprovalId!)}`;
      originalApprovalOptions = JSON.parse(
        runMysql(
          mysqlPort,
          `SELECT options_json FROM qwen_managed_agent.managed_agent_action WHERE ${actionFilter}`,
        ),
      );
      if (
        originalApprovalOptions?.v !== 3 ||
        !originalApprovalOptions.continuationRef
      ) {
        throw new Error(
          `New approval omitted the recovery continuation: version=${originalApprovalOptions?.v}`,
        );
      }
      originalApprovalPlan = JSON.parse(
        runMysql(
          mysqlPort,
          `SELECT CONVERT(inline_bytes USING utf8mb4) FROM qwen_managed_agent.qwen_managed_session_resource WHERE tenant_id=${sqlString(tenant)} AND session_id=${sqlString(session.id)} AND resource_id=${sqlString(originalApprovalOptions.continuationRef.resourceId)}`,
        ),
      );
      if (
        !originalApprovalPlan ||
        originalApprovalPlan.calls?.length !== 1 ||
        originalApprovalPlan.actionId !== originalApprovalId ||
        originalApprovalPlan.stage !== 'approval'
      ) {
        throw new Error(
          'Original saved approval plan does not identify exactly one original call',
        );
      }
      originalRuntimeSessionId = originalApprovalPlan.runtime.runtimeSessionId;
      const runtime = runMysql(
        mysqlPort,
        `SELECT binding_id, runtime_generation, workspace_generation, session_state FROM qwen_managed_agent.qwen_runtime_session WHERE runtime_session_id=${sqlString(originalRuntimeSessionId!)}`,
      ).split('\t');
      if (
        runtime[0] !== originalApprovalPlan.runtime.bindingId ||
        runtime[1] !== originalApprovalPlan.runtime.generation ||
        runtime[2] !== originalApprovalPlan.runtime.workspaceGeneration ||
        runtime[3] !== 'READY'
      ) {
        throw new Error(
          `Saved approval Runtime binding differs from the real Broker: ${runtime.join(',')}`,
        );
      }
      firstRuntimeHeartbeat = runtimeSessionHeartbeat(
        originalRuntimeSessionId!,
      );
      await waitUntil(
        'Original durable await_action checkpoint',
        () => {
          const id = runMysql(
            mysqlPort,
            `SELECT latest_checkpoint_resource_id FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE tenant_id=${sqlString(tenant)} AND session_id=${sqlString(session.id)}`,
          );
          if (!id) return false;
          const bytes = runMysql(
            mysqlPort,
            `SELECT CONVERT(inline_bytes USING utf8mb4) FROM qwen_managed_agent.qwen_managed_session_resource WHERE tenant_id=${sqlString(tenant)} AND session_id=${sqlString(session.id)} AND resource_id=${sqlString(id)}`,
          );
          if (!bytes) return false;
          const checkpoint = JSON.parse(bytes);
          return (
            checkpoint.continuation?.phase === 'await_action' &&
            checkpoint.approval?.requestId === originalApprovalId
          );
        },
        10_000,
        harness,
      );
      const privateHead = runMysql(
        mysqlPort,
        `SELECT storage_version, latest_checkpoint_resource_id FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE tenant_id=${sqlString(tenant)} AND session_id=${sqlString(session.id)}`,
      ).split('\t');
      const checkpoint = JSON.parse(
        runMysql(
          mysqlPort,
          `SELECT CONVERT(inline_bytes USING utf8mb4) FROM qwen_managed_agent.qwen_managed_session_resource WHERE tenant_id=${sqlString(tenant)} AND session_id=${sqlString(session.id)} AND resource_id=${sqlString(privateHead[1])}`,
        ),
      );
      if (
        privateHead[0] !== '2' ||
        checkpoint.continuation?.phase !== 'await_action' ||
        checkpoint.approval?.requestId !== originalApprovalId
      ) {
        throw new Error(
          'Approval snapshot was not committed before the crash barrier',
        );
      }
      const executionCount = Number(
        runMysql(
          mysqlPort,
          'SELECT COUNT(*) FROM qwen_managed_agent.qwen_tool_execution',
        ),
      );
      if (executionCount !== 0 || existsSync(inflightSideEffect))
        throw new Error('Tool ran before the original approval');
      saveEvidence('original-approval.json', {
        actionId: originalApprovalId,
        options: originalApprovalOptions,
        plan: originalApprovalPlan,
        originalRuntime: runtime,
        storageVersion: Number(privateHead[0]),
        checkpointPhase: checkpoint.continuation.phase,
        executionCount,
        physicalFileExists: existsSync(inflightSideEffect),
      });
    } else if (continuationFailover) {
      await waitUntil(
        'Continuation partial text',
        async () => {
          const page = await fetchJson<PublicList<PublicEvent>>(
            `${springUrl}/v1/agents/sessions/${session.id}/events?after=0&limit=100`,
            { headers: tenantHeaders(tenant) },
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
        'SELECT execution_call_id, execution_state, dispatch_generation, runtime_session_id FROM qwen_managed_agent.qwen_tool_execution',
      ).split('\t');
      const sideEffectBytes = existsSync(inflightSideEffect)
        ? readFileSync(inflightSideEffect, 'utf8')
        : '';
      if (
        execution.length !== 4 ||
        execution[0]?.length === 0 ||
        execution[1] !== 'SETTLED' ||
        execution[2] !== '1' ||
        execution[3]?.length === 0 ||
        sideEffectBytes !== inflightSideEffectContent
      ) {
        throw new Error(
          `Continuation boundary was not durable: execution=${execution.join(',')} sideEffect=${JSON.stringify(sideEffectBytes)}`,
        );
      }
      originalExecutionCallId = execution[0];
      originalRuntimeSessionId = execution[3];
      if (harnessOnly)
        firstRuntimeHeartbeat = runtimeSessionHeartbeat(
          originalRuntimeSessionId,
        );
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
      if (bigOutput) {
        const modelRequests = fake?.requests.filter(
          ({ body }) => body['stream'] === true,
        );
        if (modelRequests?.length !== 1)
          throw new Error('The long answer must complete without model retry');
        assertStoredAnswer(
          mysqlPort,
          tenant,
          session.id,
          failoverFirstResponse,
        );
        assertPublicAnswer(firstTurn.events, failoverFirstResponse);
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
      originalRuntimeSessionId = execution[3];
      if (harnessOnly)
        firstRuntimeHeartbeat = runtimeSessionHeartbeat(
          originalRuntimeSessionId,
        );
    }

    if (freeze) {
      // Freeze the writer side only: stopping the original Harness (the
      // lease holder) fences it against mutation on wake. Assert liveness
      // first — a setup that already died would make the freeze a no-op
      // and every later wake assertion vacuous.
      if (!processTreeExists(harness.child)) {
        throw new Error(
          'The original Harness died before the freeze: cannot freeze a dead owner',
        );
      }
      // The original Spring must actually die — reclaiming its workspace
      // binding requires death evidence from /proc liveness, and a
      // SIGSTOPped JVM still reads as alive there.
      await signalProcessTree(harness.child, 'SIGSTOP');
      await crashProcess(
        spring.child,
        'Spring Managed Agent Server (original)',
      );
    } else if (harnessOnly) {
      // Kill only the Harness: a live control plane must adopt the next
      // generation instead of failing every bound Session (G3).
      await crashChild(harness.child, `${hostedHarnessLabel} (original)`);
    } else {
      await Promise.all([
        crashChild(harness.child, `${hostedHarnessLabel} (original)`),
        inflightFailover || continuationFailover
          ? crashProcess(spring.child, 'Spring Managed Agent Server (original)')
          : crashChild(spring.child, 'Spring Managed Agent Server (original)'),
      ]);
    }
    acceptReplacementContinuation = true;
    releaseContinuationHold();
    await heldStartProxy?.close();
    heldStartProxy = undefined;
    if (!freeze) {
      // The frozen Harness keeps its home; the killed Spring's disk is
      // scrapped like any dead owner's.
      rmSync(harnessHome, { recursive: true, force: true });
    }
    if (!harnessOnly) {
      rmSync(runtimeHome, { recursive: true, force: true });
    }
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

    let replacementSpring: typeof spring;
    let replacementSpringUrl: string;
    let replacementHarnessPort: number;
    let replacementBrokerUrl: string;
    if (harnessOnly) {
      // The live Spring keeps its fixed Harness base URL, so the next
      // generation must answer on the same port; the same audit selectors
      // then read the original control plane.
      replacementSpring = spring;
      replacementSpringUrl = springUrl;
      replacementHarnessPort = harnessPort;
      replacementBrokerUrl = `http://127.0.0.1:${brokerPort}`;
    } else {
      // Under --freeze the original Spring is dead, but the frozen Harness
      // still holds the session-store URL the original Spring handed it at
      // load (immutable after load). The replacement must answer on the
      // original Spring port so the woken former writer's store calls meet
      // a live, fencing control plane instead of a dead socket — otherwise
      // every post-wake assertion would hold by disconnection, not fencing.
      const replacementSpringPort = freeze ? springPort : await freePort();
      replacementHarnessPort = await freePort();
      const replacementBrokerPort = await freePort();
      replacementSpringUrl = `http://127.0.0.1:${replacementSpringPort}`;
      replacementSpring = start(
        java,
        springArguments,
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
            QWEN_MANAGED_AGENT_APPROVAL_MODE: approvalRecovery
              ? 'default'
              : 'yolo',
            QWEN_MANAGED_AGENT_APPROVAL_TIMEOUT:
              verificationMode === 'expiry' ? '30s' : '5m',
            QWEN_MANAGED_AGENT_CAPABILITY_DIGEST: capabilityDigest,
            QWEN_MANAGED_AGENT_HARNESS_BASE_URL: `http://127.0.0.1:${replacementHarnessPort}`,
            QWEN_MANAGED_AGENT_HARNESS_ENABLED: 'true',
            QWEN_MANAGED_AGENT_HARNESS_REQUEST_TIMEOUT: '120s',
            QWEN_MANAGED_AGENT_HARNESS_TOKEN: harnessToken,
            QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY: 'false',
            QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER: trustedActorHeader,
            QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED: 'true',
            ...(runtimeTakeover
              ? {
                  QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS:
                    process.platform === 'linux' ? 'true' : 'false',
                }
              : {
                  QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS: 'false',
                }),
            QWEN_MANAGED_AGENT_DISPATCH_LEASE_DURATION: '2s',
            QWEN_MANAGED_AGENT_DISPATCH_LEASE_RENEW_INTERVAL: '500ms',
            QWEN_MANAGED_AGENT_DISPATCH_SCAN_DELAY: '200ms',
            QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL: replacementSpringUrl,
            QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED: 'true',
            QWEN_MANAGED_AGENT_SESSION_STORE_WRITER_LEASE_DURATION: '1s',
            QWEN_MANAGED_AGENT_WORKSPACE_ID: workspaceId,
            QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'true',
            QWEN_MANAGED_AGENT_RUNTIME_BROKER_PORT: String(
              replacementBrokerPort,
            ),
            QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN: brokerToken,
            QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY: credentialKey,
            QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID: 'e2e-local-v1',
            QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY: runtimeState,
            QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY: cliBundle,
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
          const response = await fetch(
            `${replacementSpringUrl}/actuator/health`,
          );
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
      replacementBrokerUrl =
        replacementBrokerProxy?.baseUrl ??
        `http://127.0.0.1:${replacementBrokerPort}`;
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
        // The original harness keeps its broker unconditionally, so the
        // replacement must too — non-workspace failover arms read the same
        // execution store the broker feeds; replacementBrokerUrl already
        // carries the harnessOnly alias and the held-start proxy base.
        '--managed-runtime-broker-url',
        replacementBrokerUrl,
        `--managed-runtime-broker-token=${brokerToken}`,
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
          QWEN_RUNTIME_BROKER_URL: replacementBrokerUrl,
        },
      },
      'Replacement Hosted Harness',
    );
    await waitUntil(
      'Replacement Hosted Harness',
      async () => {
        const response = await fetch(
          `http://127.0.0.1:${replacementHarnessPort}/health?deep=1`,
          { headers: { authorization: `Bearer ${harnessToken}` } },
        );
        return response.ok;
      },
      60_000,
      replacementHarness,
    );

    if (approvalRecovery) {
      await waitUntil(
        'Original approval attached to replacement Harness',
        () => {
          const boot = runMysql(
            mysqlPort,
            `SELECT harness_boot_id FROM qwen_managed_agent.managed_agent_session WHERE ${sessionFilter}`,
          );
          return boot.length > 0 && boot !== firstBootId;
        },
        120_000,
        replacementHarness,
      );
      const actionBeforeResponse = await fetchJson<Record<string, unknown>>(
        `${replacementSpringUrl}/v1/agents/sessions/${session.id}/actions/${originalApprovalId}`,
        { headers: tenantHeaders(tenant) },
      );
      if (
        actionBeforeResponse.id !== originalApprovalId ||
        (verificationMode !== 'expiry' &&
          actionBeforeResponse.state !== 'requested')
      ) {
        throw new Error(
          'Replacement did not preserve the original requested Action',
        );
      }
      let responseOperation: Record<string, unknown> | undefined;
      if (verificationMode === 'allow' || verificationMode === 'deny') {
        const response = await fetch(
          `${replacementSpringUrl}/v1/agents/sessions/${session.id}/actions/${originalApprovalId}/responses`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `g3-answer-${originalApprovalId}`,
              ...tenantHeaders(tenant),
            },
            body: JSON.stringify({
              kind: 'permission',
              input_revision: 1,
              policy_revision: originalApprovalOptions!.policyRevision,
              option_id: verificationMode,
            }),
          },
        );
        if (response.status !== 202)
          throw new Error(
            `Original Action response returned ${response.status}: ${await response.text()}`,
          );
        responseOperation = await response.json();
      } else if (verificationMode === 'cancel') {
        const response = await fetch(
          `${replacementSpringUrl}/v1/agents/sessions/${session.id}/events`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `g3-cancel-${originalApprovalId}`,
              ...tenantHeaders(tenant),
            },
            body: JSON.stringify({
              type: 'agent.session.cancel',
              turn_id: actionBeforeResponse.turn_id,
            }),
          },
        );
        if (response.status !== 202)
          throw new Error(
            `Original Turn cancel returned ${response.status}: ${await response.text()}`,
          );
      }
      const recovered = await waitForTerminal(
        replacementSpringUrl,
        tenant,
        session.id,
        0,
        replacementSpring,
        120_000,
      );
      const terminals = recovered.events.filter((event) => event.terminal);
      const expectedTerminal = ['allow', 'deny'].includes(verificationMode)
        ? 'turn.completed'
        : 'turn.cancelled';
      if (terminals.length !== 1 || terminals[0].type !== expectedTerminal) {
        throw new Error(
          `Original approval terminal differs: expected=${expectedTerminal} actual=${JSON.stringify(terminals)}`,
        );
      }
      verifiedOriginalTerminal = terminals[0].type;
      const rows = runMysql(
        mysqlPort,
        `SELECT execution_call_id, idempotency_key, binding_id, runtime_generation, runtime_session_id, execution_state, dispatch_generation, request_digest FROM qwen_managed_agent.qwen_tool_execution ORDER BY execution_call_id`,
      );
      const executions = rows
        ? rows.split('\n').map((row) => row.split('\t'))
        : [];
      const expectedExecutions = verificationMode === 'allow' ? 1 : 0;
      if (executions.length !== expectedExecutions)
        throw new Error(
          `Approval execution count ${executions.length} differs from ${expectedExecutions}`,
        );
      if (executions.length === 1) {
        const execution = executions[0];
        const plan = originalApprovalPlan!;
        if (
          execution[1] !== plan.calls[0].prepareKey ||
          execution[2] !== plan.runtime.bindingId ||
          execution[3] !== plan.runtime.generation ||
          execution[4] !== plan.runtime.runtimeSessionId ||
          execution[5] !== 'SETTLED' ||
          execution[6] !== '1' ||
          execution[7] !== plan.calls[0].requestDigest
        ) {
          throw new Error(
            `Replacement changed the original prepared execution identity: ${execution.join(',')}`,
          );
        }
      }
      const bytes = existsSync(inflightSideEffect)
        ? readFileSync(inflightSideEffect, 'utf8')
        : '';
      if (
        verificationMode === 'allow'
          ? bytes !== inflightSideEffectContent
          : existsSync(inflightSideEffect)
      ) {
        throw new Error(
          `Approval physical file assertion failed for ${verificationMode}`,
        );
      }
      const actionRows = runMysql(
        mysqlPort,
        `SELECT action_id, state FROM qwen_managed_agent.managed_agent_action WHERE ${sessionFilter}`,
      );
      const expectedActionState =
        verificationMode === 'expiry'
          ? 'expired'
          : verificationMode === 'cancel'
            ? 'cancelled'
            : 'decided';
      if (actionRows !== `${originalApprovalId}\t${expectedActionState}`)
        throw new Error(
          `Original approval identity/state differs: ${actionRows}`,
        );
      const requestBodies = (fake?.requests ?? []).filter((request) =>
        JSON.stringify(request.body.messages).includes(continuationMarker),
      );
      const initialRequests = requestBodies.filter(
        (request) =>
          !JSON.stringify(request.body.messages).includes('"role":"tool"'),
      );
      const modelAfterResults = requestBodies.filter((request) =>
        JSON.stringify(request.body.messages).includes('"role":"tool"'),
      );
      const expectedModelsAfterResults = ['allow', 'deny'].includes(
        verificationMode,
      )
        ? 1
        : 0;
      if (
        initialRequests.length !== 1 ||
        modelAfterResults.length !== expectedModelsAfterResults
      )
        throw new Error(
          `Approval replayed inference or skipped result inference: ${initialRequests.length}+${modelAfterResults.length}`,
        );
      if (responseOperation) {
        await waitUntil(
          'Approval response command completion',
          async () => {
            const operation = await fetchJson<Record<string, unknown>>(
              `${replacementSpringUrl}/v1/agents/sessions/${session.id}/operations/${responseOperation!.id}`,
              { headers: tenantHeaders(tenant) },
            );
            if (operation.status === 'failed')
              throw new Error(
                `Approval response operation failed: ${JSON.stringify(operation)}`,
              );
            return operation.status === 'completed';
          },
          30_000,
          replacementSpring,
        );
      }
      await waitUntil(
        'Original Runtime cleanup confirmed',
        () => {
          const state = runMysql(
            mysqlPort,
            `SELECT session_state FROM qwen_managed_agent.qwen_runtime_session WHERE runtime_session_id=${sqlString(originalRuntimeSessionId!)}`,
          );
          const confirmed = runMysql(
            mysqlPort,
            `SELECT COUNT(*) FROM qwen_managed_agent.qwen_managed_session_journal_tx WHERE ${sessionFilter} AND command_id=${sqlString(`hosted-cleanup:${originalRuntimeSessionId}:${originalRuntimeSessionId}:confirmed`)}`,
          );
          return state === 'RELEASED' && confirmed === '1';
        },
        30_000,
        replacementHarness,
      );
      const runtimeAfter = runMysql(
        mysqlPort,
        `SELECT binding_id, runtime_generation, workspace_generation, session_state FROM qwen_managed_agent.qwen_runtime_session WHERE runtime_session_id=${sqlString(originalRuntimeSessionId!)}`,
      ).split('\t');
      const cleanupConfirmed = Number(
        runMysql(
          mysqlPort,
          `SELECT COUNT(*) FROM qwen_managed_agent.qwen_managed_session_journal_tx WHERE ${sessionFilter} AND command_id=${sqlString(`hosted-cleanup:${originalRuntimeSessionId}:${originalRuntimeSessionId}:confirmed`)}`,
        ),
      );
      if (
        runtimeAfter[0] !== originalApprovalPlan!.runtime.bindingId ||
        runtimeAfter[1] !== originalApprovalPlan!.runtime.generation ||
        runtimeAfter[2] !== originalApprovalPlan!.runtime.workspaceGeneration ||
        runtimeAfter[3] !== 'RELEASED' ||
        cleanupConfirmed !== 1
      )
        throw new Error(
          `Original cleanup did not release the original Runtime: state=${runtimeAfter.join(',')} confirmed=${cleanupConfirmed}`,
        );
      saveEvidence('approval-result.json', {
        mode: verificationMode,
        sessionId: session.id,
        actionId: originalApprovalId,
        replacementActionBeforeResponse: actionBeforeResponse,
        expectedTerminal,
        terminalCount: terminals.length,
        executions,
        physicalFileExists: existsSync(inflightSideEffect),
        physicalFileBytes: bytes,
        modelRequests: initialRequests.length + modelAfterResults.length,
        initialRequests: initialRequests.length,
        modelAfterResults: modelAfterResults.length,
        runtimeAfter,
        cleanupConfirmed,
      });
      console.log(
        JSON.stringify(
          {
            mode: verificationMode,
            originalAction: originalApprovalId,
            originalBatch: originalApprovalPlan!.batchId,
            originalBinding: originalApprovalPlan!.runtime.bindingId,
            executions: executions.length,
            terminal: expectedTerminal,
            cleanupConfirmed,
          },
          null,
          2,
        ),
      );
    } else if (inflightFailover) {
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
        'SELECT execution_call_id, execution_state, dispatch_generation, IF(result_json IS NULL, 0, 1), runtime_session_id FROM qwen_managed_agent.qwen_tool_execution',
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
        recoveredExecution.length !== 5 ||
        recoveredExecution[0] !== originalExecutionCallId ||
        recoveredExecution[1] !== 'SETTLED' ||
        // A replaced Broker bumps the re-dispatch to generation 1; a live
        // Broker re-dispatches on the generation it already owned (0 or 1).
        (harnessOnly
          ? !(recoveredExecution[2] === '0' || recoveredExecution[2] === '1')
          : Number(recoveredExecution[2]) !== 1) ||
        // Under --harness-only the surviving Spring, Broker and durable
        // Worker keep serving the same runtime session; re-provisioning
        // would redefine the arm as a kill-both.
        (harnessOnly && recoveredExecution[4] !== originalRuntimeSessionId) ||
        // The equality above cannot fail (the column settles at INSERT):
        // "kept serving" is witnessed by the row's own liveness moving.
        (harnessOnly &&
          !(
            firstRuntimeHeartbeat !== undefined &&
            (runtimeSessionHeartbeat(recoveredExecution[4])[1] >
              firstRuntimeHeartbeat[1] ||
              runtimeSessionHeartbeat(recoveredExecution[4])[0] >
                firstRuntimeHeartbeat[0])
          )) ||
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
        { headers: tenantHeaders(tenant) },
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
        'SELECT execution_call_id, execution_state, dispatch_generation, IF(result_json IS NULL, 0, 1), runtime_session_id FROM qwen_managed_agent.qwen_tool_execution',
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
      const originalAndReplacementRequests = requests.filter(({ body }) =>
        JSON.stringify(body['messages']).includes('"role":"tool"'),
      );
      if (
        originalAndReplacementRequests.length === 2 &&
        !isDeepStrictEqual(
          originalAndReplacementRequests[0].body,
          originalAndReplacementRequests[1].body,
        )
      ) {
        throw new Error(
          'The replacement model request does not equal the original effective request',
        );
      }
      saveEvidence('model-request-parity.json', {
        requests: originalAndReplacementRequests.map((request) => request.body),
        equal:
          originalAndReplacementRequests.length === 2 &&
          isDeepStrictEqual(
            originalAndReplacementRequests[0].body,
            originalAndReplacementRequests[1].body,
          ),
      });

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
        recoveredExecution.length !== 5 ||
        recoveredExecution[0] !== originalExecutionCallId ||
        recoveredExecution[1] !== 'SETTLED' ||
        // See the in-flight arm: a live Broker keeps the generation it owns.
        (harnessOnly
          ? !(recoveredExecution[2] === '0' || recoveredExecution[2] === '1')
          : Number(recoveredExecution[2]) !== 1) ||
        // See the in-flight arm: the surviving owner keeps the durable
        // runtime session; a new Worker is a kill-both in disguise.
        (harnessOnly && recoveredExecution[4] !== originalRuntimeSessionId) ||
        (harnessOnly &&
          !(
            firstRuntimeHeartbeat !== undefined &&
            (runtimeSessionHeartbeat(recoveredExecution[4])[1] >
              firstRuntimeHeartbeat[1] ||
              runtimeSessionHeartbeat(recoveredExecution[4])[0] >
                firstRuntimeHeartbeat[0])
          )) ||
        recoveredExecution[3] !== '1' ||
        executionCount !== 1 ||
        replacementBootId.length === 0 ||
        replacementBootId === firstBootId ||
        terminalCount !== 1 ||
        initialModelRequests.length !== 1 ||
        continuationRequests.length !== 2 ||
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
            promptReplayed: initialModelRequests.length !== 1,
            physicalToolExecutions: executionCount,
            continuationModelRequests: continuationRequests.length,
            visibleText,
            terminalTurns: terminalCount,
            // The frozen-owner arm keeps the home on purpose (the wake
            // needs it), so one key cannot mean both arms' intent.
            oldHarnessDiskDeleted: !freeze && !existsSync(harnessHome),
            harnessHomeRetainedForWake: freeze && existsSync(harnessHome),
          },
          null,
          2,
        ),
      );

      if (freeze) {
        // Wake the frozen Harness only after the replacement finished: the
        // journal writer fence the takeover installed must hold against a
        // very alive former writer. The Turn is terminal by now, so nothing
        // but a fencing defect could mutate the binding or the journal. The
        // resumed Harness still needs its home, so it must exist too.
        if (!existsSync(harnessHome)) {
          throw new Error(
            'Frozen owner arm lost the Harness home the wake depends on',
          );
        }
        const headBeforeWake = runMysql(
          mysqlPort,
          `SELECT writer_generation, journal_revision, committed_sequence FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE ${sessionFilter}`,
        );
        // The rest of the wake block proves the fence holds; this line
        // proves there IS a fence: the head must sit on the replacement's
        // writer generation, past the frozen owner's.
        if (Number(headBeforeWake.split('\t')[0]) <= firstHead[0]) {
          throw new Error(
            `The takeover did not advance the journal head past the frozen owner's writer generation: head=${headBeforeWake} first=${firstHead.join(',')}`,
          );
        }
        const oldGenerationTxBeforeWake = runMysql(
          mysqlPort,
          `SELECT COUNT(*) FROM qwen_managed_agent.qwen_managed_session_journal_tx WHERE ${sessionFilter} AND writer_generation < (SELECT writer_generation FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE ${sessionFilter})`,
        );
        // Non-vacuity, proven live rather than by signal-existence: the
        // frozen Harness must stop answering /health now and answer it
        // again after SIGCONT, or the wake never happened and every
        // fencing assertion below reports against nothing.
        const frozenSilent = await fetch(
          `http://127.0.0.1:${harnessPort}/health`,
          {
            headers: { authorization: `Bearer ${harnessToken}` },
            signal: AbortSignal.timeout(1_000),
          },
        ).then(
          () => false,
          () => true,
        );
        if (!frozenSilent) {
          throw new Error(
            'Frozen Harness still answers /health before SIGCONT; the freeze did not take effect',
          );
        }
        if (!processTreeExists(harness.child)) {
          throw new Error(
            'Frozen Harness did not survive the freeze: the fencing proof below would be vacuous',
          );
        }
        signalProcessTree(harness.child, 'SIGCONT');
        let resumed = false;
        for (let attempt = 0; attempt < 10 && !resumed; attempt += 1) {
          resumed = await fetch(`http://127.0.0.1:${harnessPort}/health`, {
            headers: { authorization: `Bearer ${harnessToken}` },
            signal: AbortSignal.timeout(1_000),
          }).then(
            (response) => response.ok,
            () => false,
          );
          if (!resumed)
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (!resumed) {
          throw new Error(
            'Frozen Harness never resumed /health after SIGCONT; the wake never happened and the fencing assertions would be vacuous',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const headAfterWake = runMysql(
          mysqlPort,
          `SELECT writer_generation, journal_revision, committed_sequence FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE ${sessionFilter}`,
        );
        const bootAfterWake = runMysql(
          mysqlPort,
          `SELECT harness_boot_id FROM qwen_managed_agent.managed_agent_session WHERE ${sessionFilter}`,
        );
        // The fencing claim the exit check words: no transaction out of
        // the old writer generation after it wakes. Lease renewal touches
        // writer_lease_until only, so the head's revision moves with real
        // commits; identity, not revision, is what a fencing proof may
        // freeze on.
        const oldGenerationTxAfterWake = runMysql(
          mysqlPort,
          `SELECT COUNT(*) FROM qwen_managed_agent.qwen_managed_session_journal_tx WHERE ${sessionFilter} AND writer_generation < (SELECT writer_generation FROM qwen_managed_agent.qwen_managed_session_journal_head WHERE ${sessionFilter})`,
        );
        const awakeEvents = await fetchJson<PublicList<PublicEvent>>(
          `${replacementSpringUrl}/v1/agents/sessions/${session.id}/events?after=0&limit=100`,
          { headers: tenantHeaders(tenant) },
        );
        const awakeText = awakeEvents.data
          .filter((event) => event.type === 'item.output_text.delta')
          .map((event) => eventText(event))
          .join('');
        const awakeTerminalCount = Number(
          runMysql(
            mysqlPort,
            `SELECT COUNT(*) FROM qwen_managed_agent.managed_agent_event WHERE ${sessionFilter} AND terminal=TRUE`,
          ),
        );
        if (
          headAfterWake.split('\t')[0] !== headBeforeWake.split('\t')[0] ||
          oldGenerationTxAfterWake !== oldGenerationTxBeforeWake ||
          bootAfterWake !== replacementBootId ||
          awakeText !== visibleText ||
          awakeTerminalCount !== terminalCount
        ) {
          throw new Error(
            `Frozen former Harness mutated the takeover after waking: head=${headBeforeWake}->${headAfterWake} oldWriterTx=${oldGenerationTxBeforeWake}->${oldGenerationTxAfterWake} boot=${replacementBootId}->${bootAfterWake} text=${JSON.stringify(visibleText)}->${JSON.stringify(awakeText)} terminals=${terminalCount}->${awakeTerminalCount}`,
          );
        }
        console.log(
          JSON.stringify(
            {
              fencedFormerWriter: true,
              journalHead: headAfterWake,
              oldGenerationTx: oldGenerationTxAfterWake,
              harnessBootId: bootAfterWake,
              visibleText: awakeText,
            },
            null,
            2,
          ),
        );
      }
    } else {
      const secondResponse = await fetch(
        `${replacementSpringUrl}/v1/agents/sessions/${session.id}/events`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `failover-second-${Date.now()}`,
            ...tenantHeaders(tenant),
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

      if (bigOutput) {
        assertPublicAnswer(secondTurn.events, failoverSecondResponse);
        assertStoredAnswer(
          mysqlPort,
          tenant,
          session.id,
          failoverFirstResponse,
        );
        assertStoredAnswer(
          mysqlPort,
          tenant,
          session.id,
          failoverSecondResponse,
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
            ...(bigOutput
              ? {
                  expectedCharacters: failoverFirstResponse.length,
                  expectedUtf8Bytes: Buffer.byteLength(failoverFirstResponse),
                  shortControlCharacters: failoverSecondResponse.length,
                  fullTextPreserved: true,
                }
              : {}),
            restoredFirstTurnContext: true,
            oldHarnessDiskDeleted: !existsSync(harnessHome),
          },
          null,
          2,
        ),
      );
    }
    if (verificationMode) {
      // These assertions run after every A/B primary gate, never in place of it.
      await waitUntil(
        'Runtime cleanup before next Turn',
        () => {
          const state = runMysql(
            mysqlPort,
            `SELECT session_state FROM qwen_managed_agent.qwen_runtime_session WHERE runtime_session_id=${sqlString(originalRuntimeSessionId!)}`,
          );
          const confirmed = runMysql(
            mysqlPort,
            `SELECT COUNT(*) FROM qwen_managed_agent.qwen_managed_session_journal_tx WHERE ${sessionFilter} AND command_id=${sqlString(`hosted-cleanup:${originalRuntimeSessionId}:${originalRuntimeSessionId}:confirmed`)}`,
          );
          return state === 'RELEASED' && confirmed === '1';
        },
        30_000,
        replacementHarness,
      );
      const originalPage = await fetchJson<PublicList<PublicEvent>>(
        `${replacementSpringUrl}/v1/agents/sessions/${session.id}/events?after=0&limit=100`,
        { headers: tenantHeaders(tenant) },
      );
      if (originalPage.data.filter((event) => event.terminal).length !== 1)
        throw new Error(
          'Original Turn must have exactly one public terminal before relief',
        );
      const originalCursor = Math.max(
        0,
        ...originalPage.data.map((event) => event.sequence),
      );
      const relief = await fetch(
        `${replacementSpringUrl}/v1/agents/sessions/${session.id}/events`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `g3-relief-${session.id}`,
            ...tenantHeaders(tenant),
          },
          body: JSON.stringify({
            type: 'agent.session.input.message',
            input: [
              {
                type: 'text',
                text: `${reliefMarker}. Reply exactly ${reliefResponse}. Use no tools.`,
              },
            ],
          }),
        },
      );
      if (relief.status !== 202)
        throw new Error(
          `Relief Turn admission returned ${relief.status}: ${await relief.text()}`,
        );
      const reliefTurn = await waitForTerminal(
        replacementSpringUrl,
        tenant,
        session.id,
        originalCursor,
        replacementSpring,
        60_000,
      );
      const reliefTerminals = reliefTurn.events.filter(
        (event) => event.terminal,
      );
      const reliefText = reliefTurn.events
        .filter((event) => event.type === 'item.output_text.delta')
        .map(eventText)
        .join('');
      if (
        reliefTerminals.length !== 1 ||
        reliefTerminals[0].type !== 'turn.completed' ||
        reliefText !== reliefResponse
      )
        throw new Error(
          `Relief Turn did not finish: terminals=${JSON.stringify(reliefTerminals)} text=${JSON.stringify(reliefText)}`,
        );
      const reliefRequests = (fake?.requests ?? []).filter((request) =>
        JSON.stringify(request.body.messages).includes(reliefMarker),
      );
      if (reliefRequests.length !== 1)
        throw new Error(
          `Relief Turn inference count differs: ${reliefRequests.length}`,
        );
      const finalTerminalCount = Number(
        runMysql(
          mysqlPort,
          `SELECT COUNT(*) FROM qwen_managed_agent.managed_agent_event WHERE ${sessionFilter} AND terminal=TRUE`,
        ),
      );
      if (finalTerminalCount !== 2)
        throw new Error(
          `Expected one terminal per original/relief Turn, observed ${finalTerminalCount}`,
        );
      saveEvidence('post-turn-events.json', {
        cursorBeforeRelief: originalCursor,
        original: originalPage.data,
        relief: reliefTurn.events,
        sqlTerminalCount: finalTerminalCount,
      });
      const close = await fetch(
        `${replacementSpringUrl}/v1/agents/sessions/${session.id}/close`,
        {
          method: 'POST',
          headers: {
            'idempotency-key': `g3-close-${session.id}`,
            ...tenantHeaders(tenant),
          },
        },
      );
      if (close.status !== 202)
        throw new Error(
          `Close admission returned ${close.status}: ${await close.text()}`,
        );
      const closeOperation = (await close.json()) as Record<string, unknown>;
      await waitUntil(
        'Reliable close operation completion',
        async () => {
          const operation = await fetchJson<Record<string, unknown>>(
            `${replacementSpringUrl}/v1/agents/sessions/${session.id}/operations/${closeOperation.id}`,
            { headers: tenantHeaders(tenant) },
          );
          if (operation.status === 'failed')
            throw new Error(
              `Close operation failed: ${JSON.stringify(operation)}`,
            );
          return operation.status === 'completed';
        },
        60_000,
        replacementSpring,
      );
      const closedSession = await fetchJson<Record<string, unknown>>(
        `${replacementSpringUrl}/v1/agents/sessions/${session.id}`,
        { headers: tenantHeaders(tenant) },
      );
      if (closedSession.status !== 'closed')
        throw new Error(
          `Reliable close completed with Session status ${closedSession.status}`,
        );
      const summary = {
        mode: verificationMode,
        sessionId: session.id,
        originalRuntimeSessionId,
        originalActionId: originalApprovalId,
        originalTerminal: verifiedOriginalTerminal ?? 'turn.completed',
        nextTurnCompleted: true,
        nextTurnRequests: reliefRequests.length,
        terminalCount: finalTerminalCount,
        closeAdmission: close.status,
        closeCompleted: true,
        oldHarnessHomeDeleted: !existsSync(harnessHome),
      };
      saveEvidence('summary.json', summary);
      console.log(JSON.stringify(summary, null, 2));
    }
  } else {
    const idempotencyKey = `create-${Date.now()}`;
    const prompt = [
      'Before using any tool, emit the visible text MODEL_READY.',
      'Then call write_file exactly once to write the exact text',
      JSON.stringify(sideEffectContent),
      'to the relative path',
      JSON.stringify(sideEffectName),
      'under the session working directory.',
      'Call no other tool before or after it.',
      'After the tool succeeds, reply TOOL_DONE. Do not ask a question.',
    ].join(' ');
    const body = JSON.stringify({
      agent_id: 'qwen-code',
      input: [{ type: 'text', text: prompt }],
      workspace: { workspace_id: boundWorkspaceId },
      metadata: { title: 'Real model cold Runtime E2E' },
    });
    const requestStartedAt = Date.now();
    const createResponse = await fetch(`${springUrl}/v1/agents/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...tenantHeaders(tenant),
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
          { headers: tenantHeaders(tenant) },
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
    const terminal = ordered.find(({ event }) => event.terminal);
    if (!firstModel || !runtimeReady || !terminal) {
      throw new Error(
        `Expected model, Runtime, and terminal events; got ${ordered.map(({ event }) => event.type).join(', ')}`,
      );
    }
    if (terminal.event.type !== 'turn.completed') {
      throw new Error(`Managed Turn ended with ${terminal.event.type}`);
    }
    if (
      runtimeDelayMs >= modelBeforeRuntimeAssertionDelayMs &&
      firstModel.event.sequence >= runtimeReady.event.sequence
    ) {
      throw new Error(
        'First model event did not precede Runtime readiness ' +
          `(firstModelSequence=${firstModel.event.sequence}, ` +
          `runtimeReadySequence=${runtimeReady.event.sequence}, ` +
          `firstModelEventMs=${firstModel.observedAt - requestStartedAt}, ` +
          `runtimeReadyMs=${runtimeReady.observedAt - requestStartedAt}, ` +
          `runtimeDelayMs=${runtimeDelayMs})`,
      );
    }
    if (!existsSync(sideEffect)) {
      throw new Error('Tool side effect file was not created');
    }
    if (readFileSync(sideEffect, 'utf8') !== sideEffectContent) {
      throw new Error('Tool side effect content did not match');
    }
    // Tool calls execute through the Broker worker, which does not publish
    // item.tool_call.* public events without O2 publication; the durable
    // execution record is the public-feed-independent proof.
    const executions = runMysql(
      mysqlPort,
      `SELECT COUNT(*), GROUP_CONCAT(DISTINCT execution_state) FROM qwen_managed_agent.qwen_tool_execution`,
    ).split('\t');
    if (executions[0] !== '1' || executions[1] !== 'SETTLED') {
      // The temporary MySQL data dir is deleted on exit, so the failure
      // message is the only place the offending executions can still be
      // identified: two tool_call_ids mean the model called another tool,
      // one tool_call_id across two rows means a duplicate dispatch.
      const rows = runMysql(
        mysqlPort,
        'SELECT execution_call_id, tool_call_id, execution_state FROM qwen_managed_agent.qwen_tool_execution',
      );
      throw new Error(
        `Tool execution audit failed: ${executions.join(',')}\n${rows}`,
      );
    }

    const replay = await fetch(`${springUrl}/v1/agents/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...tenantHeaders(tenant),
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
    // The probe carries an actor holding a read grant on the Session's
    // Workspace, so its 404 can only come from the tenant scope: without the
    // actor, a bound Session 404s through the grant check and would mask a
    // tenant-scoping leak.
    const crossTenant = await fetch(
      `${springUrl}/v1/agents/sessions/${session.id}`,
      { headers: tenantHeaders('other-tenant') },
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
  if (dumpPort !== undefined) {
    try {
      console.error(
        `\n--- Durable state ---\nturns:\n${runMysql(dumpPort, 'SELECT turn_id, status, error_code, submission_attempted, harness_event_epoch, dispatch_owner, dispatch_lease_until FROM qwen_managed_agent.managed_agent_turn')}\nevents:\n${runMysql(dumpPort, 'SELECT sequence_id, turn_id, event_type, terminal, source_key FROM qwen_managed_agent.managed_agent_event ORDER BY sequence_id')}\nexecutions:\n${runMysql(dumpPort, 'SELECT execution_call_id, execution_state, dispatch_generation FROM qwen_managed_agent.qwen_tool_execution')}\njournal:\n${runMysql(dumpPort, 'SELECT session_id, state, writer_generation, journal_revision, committed_sequence FROM qwen_managed_agent.qwen_managed_session_journal_head')}`,
      );
    } catch (dumpError) {
      console.error(`Durable state dump failed: ${String(dumpError)}`);
    }
  }
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
  // A frozen Harness holds SIGTERM pending from stopChild; wake it before
  // teardown so teardown does not burn the 10-second stall on every path,
  // failure or success. `harness` is try-block scoped, so reach it through
  // the children registry by its start() name — and fail loudly rather
  // than leaving a wedged writer behind when the name drifts.
  if (freeze) {
    let woke = false;
    for (const child of children) {
      if (child.name === hostedHarnessLabel) {
        signalProcessTree(child.child, 'SIGCONT');
        woke = true;
      }
    }
    if (!woke) {
      failure ??= new Error(
        'Frozen-owner arm could not find the Harness child to wake: the registry key drifted',
      );
    }
  }
  for (const child of children.reverse()) {
    await stopChild(child.child);
  }
  await heldStartProxy?.close();
  await replacementBrokerProxy?.close();
  releaseContinuationHold();
  await fake?.close();
  if (failure && process.env['QWEN_MANAGED_E2E_KEEP_TMP'] === '1') {
    console.error(`Keeping temporary directory: ${temporary}`);
  } else {
    rmSync(temporary, { recursive: true, force: true });
  }
  process.removeListener('SIGINT', handleSignal);
  process.removeListener('SIGTERM', handleSignal);
}

if (failure) throw failure;
