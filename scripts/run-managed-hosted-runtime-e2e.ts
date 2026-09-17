import { fork, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  fakeToolCall,
  startFakeOpenAIServer,
} from '../integration-tests/fake-openai-server.js';

const root = process.cwd();
const argumentsList = process.argv.slice(2);
if (
  argumentsList.some(
    (argument) =>
      argument !== '--cancel-before-ready' &&
      argument !== '--cancel-after-start' &&
      argument !== '--two-sessions',
  ) ||
  argumentsList.length > 1
) {
  throw new Error(
    'Usage: run-managed-hosted-runtime-e2e.ts [--cancel-before-ready|--cancel-after-start|--two-sessions]',
  );
}
const cancelBeforeReady = argumentsList.includes('--cancel-before-ready');
const cancelAfterStart = argumentsList.includes('--cancel-after-start');
const twoSessions = argumentsList.includes('--two-sessions');
const cliBundle = path.join(root, 'dist', 'cli.js');
const runtimeWorker = path.join(root, 'dist', 'managed-runtime-worker.js');
if (!existsSync(cliBundle) || !existsSync(runtimeWorker)) {
  throw new Error(
    'Managed Hosted Runtime E2E requires dist/cli.js and dist/managed-runtime-worker.js; run `npm run build && npm run bundle` first.',
  );
}

const temporary = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'managed-hosted-e2e-')),
);
const workspace = path.join(temporary, 'workspace');
const harnessHome = path.join(temporary, 'harness-home');
const runtimeHome = path.join(temporary, 'runtime-home');
const runtimeOutput = path.join(temporary, 'runtime-output');
const trustedFolders = path.join(temporary, 'trusted-folders.json');
const activeCancelScript = path.join(workspace, 'active-cancel.cjs');
const activeCancelStarted = path.join(workspace, 'active-cancel-started.json');
const activeCancelDelayedWrite = path.join(
  workspace,
  'active-cancel-delayed.txt',
);
const workspaceId = createHash('sha256')
  .update(workspace)
  .digest('hex')
  .slice(0, 16);
const firstChunk = 'model output before Runtime readiness';
const finalText = 'managed hosted runtime e2e complete';
const runtimeFileContent = 'written after cold Runtime readiness';
const runtimeDelayMs = cancelAfterStart || twoSessions ? 0 : 15_000;
const harnessToken = 'managed-hosted-harness-token';
const brokerToken = 'managed-hosted-broker-token';
const controlToken = 'managed-hosted-control-token';
const runtimeToken = 'managed-hosted-runtime-token';
const leaseId = 'managed-hosted-lease';
mkdirSync(workspace, { recursive: true });
mkdirSync(path.join(harnessHome, '.qwen'), { recursive: true });
mkdirSync(path.join(runtimeHome, '.qwen'), { recursive: true });
mkdirSync(runtimeOutput, { recursive: true });
writeFileSync(
  activeCancelScript,
  `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const [startedPath, delayedPath] = process.argv.slice(2);
const childProgram = "const { writeFileSync } = require('node:fs'); setTimeout(() => writeFileSync(process.argv[1], 'late write'), 4000); setInterval(() => {}, 1000);";
const child = spawn(process.execPath, ['-e', childProgram, delayedPath], { stdio: 'ignore' });
if (!child.pid) throw new Error('child process did not start');
writeFileSync(startedPath, JSON.stringify({ rootPid: process.pid, childPid: child.pid, startedAtEpochMillis: Date.now() }));
setInterval(() => {}, 1000);
`,
);
writeFileSync(
  path.join(harnessHome, '.qwen', 'settings.json'),
  JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
);
writeFileSync(
  path.join(runtimeHome, '.qwen', 'settings.json'),
  JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
);
writeFileSync(trustedFolders, JSON.stringify({ [workspace]: 'TRUST_FOLDER' }));

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
const commonEnvironment = {
  ...cleanEnvironment,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const children: Array<{ child: ChildProcess; name: string }> = [];
let receivedSignal: NodeJS.Signals | undefined;
let rejectSignal: (error: Error) => void = () => {};
const signalFailure = new Promise<never>((_resolve, reject) => {
  rejectSignal = reject;
});
const handleSignal = (signal: NodeJS.Signals) => {
  if (receivedSignal !== undefined) return;
  receivedSignal = signal;
  rejectSignal(
    new Error(`Managed Hosted Runtime E2E interrupted by ${signal}`),
  );
};
const handleSigint = () => handleSignal('SIGINT');
const handleSigterm = () => handleSignal('SIGTERM');
process.once('SIGINT', handleSigint);
process.once('SIGTERM', handleSigterm);

function register(child: ChildProcess, name: string): ChildProcess {
  children.push({ child, name });
  return child;
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

async function waitForProcessTreeExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processTreeExists(child)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function stopChild(child: ChildProcess, name: string): Promise<void> {
  if (!processTreeExists(child)) return;
  signalProcessTree(child, 'SIGTERM');
  if (await waitForProcessTreeExit(child, 5_000)) return;
  signalProcessTree(child, 'SIGKILL');
  if (!(await waitForProcessTreeExit(child, 5_000))) {
    throw new Error(`${name} process tree did not exit after SIGKILL`);
  }
}

async function waitForOutput(
  child: ChildProcess,
  name: string,
  pattern: RegExp,
  stderr: () => string,
  timeoutMs = 30_000,
): Promise<RegExpMatchArray> {
  return Promise.race([
    new Promise<RegExpMatchArray>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        reject(new Error(`${name} startup timed out\n${stderr()}`));
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(pattern);
        if (!match) return;
        clearTimeout(timer);
        resolve(match);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`${name} exited with ${code}\n${stderr()}`));
      });
    }),
    signalFailure,
  ]);
}

async function waitForExit(
  child: ChildProcess,
  name: string,
  timeoutMs: number,
): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
    signalFailure,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function waitForProvisionStart(
  controlUrl: string,
  token: string,
): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/fixture/status', controlUrl), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `Runtime Broker status returned ${response.status}: ${await response.text()}`,
      );
    }
    const status = (await response.json()) as Record<string, unknown>;
    const startedAt = status['provisionStartedAtEpochMillis'];
    if (typeof startedAt === 'number' && startedAt >= 0) return startedAt;
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 50)),
      signalFailure,
    ]);
  }
  throw new Error('Runtime provisioning did not start within 30 seconds');
}

async function waitUntil(timestamp: number): Promise<void> {
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return;
  await Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, remaining)),
    signalFailure,
  ]);
}

async function startBrokerResponseLossProxy(
  targetOrigin: string,
  dropFirstExecutionResponse: boolean,
): Promise<{
  baseUrl: string;
  didDropExecutionResponse: () => boolean;
  server: Server;
}> {
  let droppedExecutionResponse = false;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const target = new URL(request.url ?? '/', targetOrigin);
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
      const method = request.method ?? 'GET';
      const body = Buffer.concat(chunks);
      const upstream = await fetch(target, {
        method,
        headers,
        ...(['GET', 'HEAD'].includes(method) ? {} : { body }),
      });
      const responseBody = Buffer.from(await upstream.arrayBuffer());
      if (
        dropFirstExecutionResponse &&
        !droppedExecutionResponse &&
        method === 'POST' &&
        target.pathname.endsWith('/executions')
      ) {
        droppedExecutionResponse = true;
        request.socket.destroy();
        return;
      }
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
      response.end(responseBody);
    })().catch((error: unknown) => {
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
    throw new Error('Runtime Broker response-loss proxy omitted its address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    didDropExecutionResponse: () => droppedExecutionResponse,
    server,
  };
}

let fake: Awaited<ReturnType<typeof startFakeOpenAIServer>> | undefined;
let brokerProxy:
  | Awaited<ReturnType<typeof startBrokerResponseLossProxy>>
  | undefined;
let runFailure: unknown;
try {
  fake = await startFakeOpenAIServer(({ body }) => {
    const messages = Array.isArray(body['messages']) ? body['messages'] : [];
    const serializedMessages = JSON.stringify(messages);
    if (twoSessions) {
      const alpha = serializedMessages.includes('managed-session-alpha');
      const beta = serializedMessages.includes('managed-session-beta');
      if (alpha && beta) return { content: 'managed session context leaked' };
      const label = alpha ? 'alpha' : beta ? 'beta' : undefined;
      if (label !== undefined) {
        if (!serializedMessages.includes('"role":"tool"')) {
          return {
            toolCalls: [
              fakeToolCall('write_file', {
                file_path: path.join(workspace, `${label}.txt`),
                content: `${label} isolated content`,
              }),
            ],
          };
        }
        return { content: `managed session ${label} complete` };
      }
    }
    if (!serializedMessages.includes('"role":"tool"')) {
      return {
        contentChunks: [firstChunk],
        toolCalls: [
          cancelAfterStart
            ? fakeToolCall('run_shell_command', {
                command: `${shellQuote(process.execPath)} ${shellQuote(activeCancelScript)} ${shellQuote(activeCancelStarted)} ${shellQuote(activeCancelDelayedWrite)}`,
                is_background: false,
              })
            : fakeToolCall('write_file', {
                file_path: path.join(workspace, 'managed-e2e.txt'),
                content: runtimeFileContent,
              }),
        ],
      };
    }
    return { content: finalText };
  });

  let runtimeStderr = '';
  let brokerStderr = '';
  const broker = register(
    spawn(
      'mvn',
      [
        '--batch-mode',
        '--no-transfer-progress',
        '-Dstyle.color=never',
        '-Dexec.classpathScope=test',
        '-Dexec.mainClass=com.alibaba.qwen.code.runtimebroker.RuntimeBrokerFixtureMain',
        'test-compile',
        'exec:java',
      ],
      {
        cwd: path.join(root, 'packages', 'sdk-java', 'runtime-broker'),
        detached: process.platform !== 'win32',
        env: {
          ...commonEnvironment,
          QWEN_BROKER_FIXTURE_TOKEN: brokerToken,
          QWEN_BROKER_FIXTURE_CONTROL_TOKEN: controlToken,
          QWEN_BROKER_FIXTURE_RUNTIME_TOKEN: runtimeToken,
          QWEN_BROKER_FIXTURE_LEASE_ID: leaseId,
          QWEN_BROKER_FIXTURE_WORKSPACE: workspace,
          QWEN_BROKER_FIXTURE_WORKSPACE_ID: workspaceId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
    'Java Runtime Broker fixture',
  );
  broker.stderr?.on('data', (chunk) => {
    brokerStderr += chunk.toString();
  });
  const brokerMarker = await waitForOutput(
    broker,
    'Java Runtime Broker fixture',
    /QWEN_RUNTIME_BROKER_FIXTURE (\{[^\n]+\})/,
    () => brokerStderr,
    60_000,
  );
  const brokerMarkerJson = brokerMarker[1];
  if (brokerMarkerJson === undefined) {
    throw new Error('Java Runtime Broker fixture emitted an invalid marker');
  }
  const brokerInfo = JSON.parse(brokerMarkerJson) as Record<string, unknown>;
  const brokerUrl = brokerInfo['brokerUrl'];
  const controlUrl = brokerInfo['controlUrl'];
  if (typeof brokerUrl !== 'string' || typeof controlUrl !== 'string') {
    throw new Error('Java Runtime Broker fixture omitted its URLs');
  }
  brokerProxy = await startBrokerResponseLossProxy(
    brokerUrl,
    !cancelBeforeReady && !cancelAfterStart && !twoSessions,
  );

  let harnessStderr = '';
  const harness = register(
    spawn(
      process.execPath,
      [
        cliBundle,
        'serve',
        '--profile',
        'hosted-harness',
        '--port',
        '0',
        '--hostname',
        '127.0.0.1',
        '--require-auth',
        '--no-web',
        '--workspace',
        workspace,
      ],
      {
        cwd: root,
        detached: process.platform !== 'win32',
        env: {
          ...commonEnvironment,
          HOME: harnessHome,
          QWEN_HOME: path.join(harnessHome, '.qwen'),
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFolders,
          OPENAI_API_KEY: 'fake-key',
          OPENAI_BASE_URL: fake.baseUrl,
          OPENAI_MODEL: 'fake-model',
          QWEN_MODEL: 'fake-model',
          QWEN_SERVER_TOKEN: harnessToken,
          QWEN_RUNTIME_BROKER_URL: brokerProxy.baseUrl,
          QWEN_RUNTIME_BROKER_TOKEN: brokerToken,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
    'Hosted Harness',
  );
  harness.stderr?.on('data', (chunk) => {
    harnessStderr += chunk.toString();
  });
  const harnessMarker = await waitForOutput(
    harness,
    'Hosted Harness',
    /listening on http:\/\/127\.0\.0\.1:(\d+)/,
    () => harnessStderr,
  );
  const harnessPort = harnessMarker[1];
  if (harnessPort === undefined) {
    throw new Error('Hosted Harness emitted an invalid listening marker');
  }
  const harnessUrl = `http://127.0.0.1:${Number(harnessPort)}`;

  const javaTest = register(
    spawn(
      'mvn',
      [
        '--batch-mode',
        '--no-transfer-progress',
        '-Dgpg.skip=true',
        '-Dgroups=managed-hosted-integration',
        `-Dtest=ManagedHostedRuntimeE2ETest#${
          cancelBeforeReady
            ? 'cancellationBeforeRuntimeReadinessHasNoPhysicalSideEffect'
            : cancelAfterStart
              ? 'cancellationAfterPhysicalStartStopsProcessTree'
              : twoSessions
                ? 'twoHostedSessionsStayIsolated'
                : 'firstModelEventPrecedesColdRuntimeAndSameTurnContinues'
        }`,
        'test',
      ],
      {
        cwd: path.join(root, 'packages', 'sdk-java', 'qwencode'),
        detached: process.platform !== 'win32',
        env: {
          ...commonEnvironment,
          QWEN_MANAGED_HOSTED_E2E_BASE_URL: harnessUrl,
          QWEN_MANAGED_HOSTED_E2E_TOKEN: harnessToken,
          QWEN_MANAGED_HOSTED_E2E_CONTROL_URL: controlUrl,
          QWEN_MANAGED_HOSTED_E2E_CONTROL_TOKEN: controlToken,
          QWEN_MANAGED_HOSTED_E2E_WORKSPACE: workspace,
          QWEN_MANAGED_HOSTED_E2E_FIRST_CHUNK: firstChunk,
          QWEN_MANAGED_HOSTED_E2E_FINAL_TEXT: finalText,
          QWEN_MANAGED_HOSTED_E2E_DELAY_MS: String(runtimeDelayMs),
          QWEN_MANAGED_HOSTED_E2E_ACTIVE_CANCEL_STARTED: activeCancelStarted,
          QWEN_MANAGED_HOSTED_E2E_ACTIVE_CANCEL_DELAYED:
            activeCancelDelayedWrite,
        },
        stdio: 'inherit',
      },
    ),
    'Managed Hosted Java E2E',
  );
  const coldRuntimeStartup = (async () => {
    const provisionStartedAt = await waitForProvisionStart(
      controlUrl,
      controlToken,
    );
    await waitUntil(provisionStartedAt + runtimeDelayMs);

    const runtime = register(
      fork(runtimeWorker, [], {
        cwd: root,
        detached: process.platform !== 'win32',
        env: {
          ...commonEnvironment,
          HOME: runtimeHome,
          QWEN_HOME: path.join(runtimeHome, '.qwen'),
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFolders,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
      'Managed Runtime worker',
    );
    runtime.stderr?.on('data', (chunk) => {
      runtimeStderr += chunk.toString();
    });
    const runtimeReadyPromise = Promise.race([
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`Managed Runtime startup timed out\n${runtimeStderr}`),
            ),
          30_000,
        );
        runtime.on('message', (message: unknown) => {
          if (
            message &&
            typeof message === 'object' &&
            (message as Record<string, unknown>)['type'] === 'ready'
          ) {
            clearTimeout(timer);
            resolve(message as Record<string, unknown>);
          }
        });
        runtime.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        runtime.once('exit', (code) => {
          clearTimeout(timer);
          reject(
            new Error(`Managed Runtime exited with ${code}\n${runtimeStderr}`),
          );
        });
      }),
      signalFailure,
    ]);
    runtime.send({
      type: 'boot',
      version: 1,
      gatewayIncarnation: randomUUID(),
      leaseId,
      epoch: 1,
      tenantId: 'tenant-e2e',
      workspaceId,
      workspaceCwd: workspace,
      token: runtimeToken,
      outputRoot: runtimeOutput,
      cliEntry: cliBundle,
    });
    const runtimeReady = await runtimeReadyPromise;
    const runtimeUrl = runtimeReady['url'];
    if (typeof runtimeUrl !== 'string') {
      throw new Error('Managed Runtime ready message omitted its URL');
    }
    const response = await fetch(
      new URL('/fixture/runtime-ready', controlUrl),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${controlToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ runtimeUrl }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Runtime Broker ready notification returned ${response.status}: ${await response.text()}`,
      );
    }
  })();
  const [result] = await Promise.all([
    waitForExit(javaTest, 'Managed Hosted Java E2E', 2 * 60_000),
    coldRuntimeStartup,
  ]);
  if (result !== 0) {
    let harnessLog = '';
    try {
      harnessLog = readFileSync(
        path.join(harnessHome, '.qwen', 'debug', 'daemon', 'daemon.log'),
        'utf8',
      );
    } catch {
      harnessLog = '(Harness daemon log unavailable)';
    }
    throw new Error(
      `Managed Hosted Java E2E failed with ${result}; fake requests=${fake.requests.length}\n${harnessStderr}\n${brokerStderr}\n${runtimeStderr}\n${harnessLog}`,
    );
  }
  const minimumModelRequests =
    cancelBeforeReady || cancelAfterStart ? 1 : twoSessions ? 4 : 2;
  if (fake.requests.length < minimumModelRequests) {
    throw new Error(
      `Managed Hosted Java E2E made only ${fake.requests.length} model request(s)`,
    );
  }
  if (
    !cancelBeforeReady &&
    !cancelAfterStart &&
    !twoSessions &&
    !brokerProxy.didDropExecutionResponse()
  ) {
    throw new Error('Managed Hosted Runtime E2E did not drop a response');
  }
  if (twoSessions) {
    console.log(
      `Managed Hosted Runtime two-Session isolation E2E passed with ${fake.requests.length} model requests.`,
    );
  } else if (cancelBeforeReady || cancelAfterStart) {
    console.log(
      `Managed Hosted Runtime ${cancelAfterStart ? 'active ' : ''}cancellation E2E passed with ${fake.requests.length} model request(s).`,
    );
  } else {
    console.log(
      `Managed Hosted Runtime E2E recovered one dropped execution response and passed with ${fake.requests.length} model requests.`,
    );
  }
} catch (error) {
  runFailure = error;
}

const cleanupFailures: unknown[] = [];
for (const { child, name } of children.reverse()) {
  try {
    await stopChild(child, name);
  } catch (error) {
    cleanupFailures.push(error);
  }
}
if (brokerProxy !== undefined) {
  try {
    await new Promise<void>((resolve, reject) => {
      brokerProxy?.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    cleanupFailures.push(error);
  }
}
if (fake !== undefined) {
  try {
    await fake.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
}
process.off('SIGINT', handleSigint);
process.off('SIGTERM', handleSigterm);
if (process.env.QWEN_MANAGED_HOSTED_E2E_KEEP_STATE === '1') {
  console.error(`Retained Managed Hosted Runtime E2E state at ${temporary}`);
} else {
  try {
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
}
if (receivedSignal !== undefined) {
  process.kill(process.pid, receivedSignal);
}
if (runFailure !== undefined && cleanupFailures.length > 0) {
  throw new AggregateError(
    [runFailure, ...cleanupFailures],
    'Managed Hosted Runtime E2E and cleanup both failed',
  );
}
if (runFailure !== undefined) throw runFailure;
if (cleanupFailures.length > 0) {
  throw new AggregateError(
    cleanupFailures,
    'Managed Hosted Runtime E2E cleanup failed',
  );
}
