import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fakeToolCall,
  startFakeOpenAIServer,
} from '../integration-tests/fake-openai-server.js';

// This harness executes the root bundle, which `npm run build` does not refresh.
// Run `npm run build && npm run bundle` from the repository root first.
const root = process.cwd();
const cliBundle = path.join(root, 'dist', 'cli.js');
if (!existsSync(cliBundle)) {
  throw new Error(
    'Java daemon E2E requires dist/cli.js; run `npm run build && npm run bundle` from the repository root first.',
  );
}
const temporary = mkdtempSync(path.join(tmpdir(), 'java-daemon-e2e-'));
const workspace = path.join(temporary, 'workspace');
const testHome = path.join(temporary, 'home');
const expected = 'java daemon e2e complete';
const deadlinePrompt = 'java daemon e2e deadline sentinel';
const cancelPrompt = 'java daemon e2e cancel sentinel';
const teardownPrompt = 'java daemon e2e teardown sentinel';
const directPrompt = 'java daemon e2e direct response';
const token = 'java-daemon-e2e-token';
const javaTestTimeoutMs = 5 * 60_000;
mkdirSync(workspace, { recursive: true });
mkdirSync(path.join(testHome, '.qwen'), { recursive: true });
writeFileSync(
  path.join(testHome, '.qwen', 'settings.json'),
  JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
);

const fake = await startFakeOpenAIServer(({ body }) => {
  const messageList = Array.isArray(body['messages']) ? body['messages'] : [];
  const latestUser = [...messageList]
    .reverse()
    .find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>)['role'] === 'user',
    );
  const latestUserText = JSON.stringify(latestUser ?? {});
  if (latestUserText.includes(directPrompt)) {
    return { content: expected };
  }
  if (latestUserText.includes(teardownPrompt)) {
    return {
      toolCalls: [
        fakeToolCall('write_file', {
          file_path: path.join(workspace, 'teardown.txt'),
          content: 'must not be written',
        }),
      ],
    };
  }
  if (
    latestUserText.includes(deadlinePrompt) ||
    latestUserText.includes(cancelPrompt)
  ) {
    return new Promise<never>(() => {});
  }
  const messages = JSON.stringify(messageList);
  if (!messages.includes('"role":"tool"')) {
    return {
      toolCalls: [
        fakeToolCall('write_file', {
          file_path: path.join(workspace, 'created.txt'),
          content: 'created by Java daemon E2E',
        }),
      ],
    };
  }
  return { content: expected };
});

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
const daemon = spawn(
  process.execPath,
  [
    cliBundle,
    'serve',
    '--port',
    '0',
    '--hostname',
    '127.0.0.1',
    '--require-auth',
    '--prompt-deadline-ms',
    '60000',
    '--workspace',
    workspace,
  ],
  {
    cwd: root,
    detached: process.platform !== 'win32',
    env: {
      ...cleanEnvironment,
      HOME: testHome,
      QWEN_HOME: path.join(testHome, '.qwen'),
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: fake.baseUrl,
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
      QWEN_SERVER_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let stderr = '';
let javaTest: ChildProcess | undefined;
let receivedSignal: NodeJS.Signals | undefined;
let succeeded = false;
daemon.stderr?.on('data', (chunk) => {
  stderr += chunk.toString();
});

let rejectSignal: (error: Error) => void = () => {};
const signalFailure = new Promise<never>((_resolve, reject) => {
  rejectSignal = reject;
});
const handleSignal = (signal: NodeJS.Signals) => {
  if (receivedSignal === undefined) {
    receivedSignal = signal;
    rejectSignal(new Error(`Java daemon E2E interrupted by ${signal}`));
  }
};
const handleSigint = () => handleSignal('SIGINT');
const handleSigterm = () => handleSignal('SIGTERM');
process.once('SIGINT', handleSigint);
process.once('SIGTERM', handleSigterm);

async function stopChild(child: ChildProcess, name: string): Promise<void> {
  if (!processTreeExists(child)) return;
  signalProcessTree(child, 'SIGTERM');
  if (await waitForProcessTreeExit(child, 5_000)) return;
  signalProcessTree(child, 'SIGKILL');
  if (!(await waitForProcessTreeExit(child, 5_000))) {
    throw new Error(`${name} process tree did not exit after SIGKILL`);
  }
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

let runFailure: unknown;
try {
  const port = await Promise.race([
    new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`daemon startup timed out\n${stderr}`)),
        15_000,
      );
      let output = '';
      daemon.stdout?.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (!match) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      daemon.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      daemon.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`daemon exited with ${code}\n${stderr}`));
      });
    }),
    signalFailure,
  ]);

  javaTest = spawn(
    'mvn',
    [
      '--batch-mode',
      '--no-transfer-progress',
      '-Dgpg.skip=true',
      '-Dgroups=daemon-integration',
      '-Dtest=DaemonServeE2ETest',
      'test',
    ],
    {
      cwd: path.join(root, 'packages', 'sdk-java', 'qwencode'),
      detached: process.platform !== 'win32',
      env: {
        ...cleanEnvironment,
        QWEN_DAEMON_E2E_BASE_URL: `http://127.0.0.1:${port}`,
        QWEN_DAEMON_E2E_TOKEN: token,
        QWEN_DAEMON_E2E_WORKSPACE: workspace,
        QWEN_DAEMON_E2E_EXPECTED_TEXT: expected,
        QWEN_DAEMON_E2E_DEADLINE_PROMPT: deadlinePrompt,
        QWEN_DAEMON_E2E_CANCEL_PROMPT: cancelPrompt,
        QWEN_DAEMON_E2E_TEARDOWN_PROMPT: teardownPrompt,
        QWEN_DAEMON_E2E_DIRECT_PROMPT: directPrompt,
      },
      stdio: 'inherit',
    },
  );
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    new Promise<number | null>((resolve, reject) => {
      javaTest?.once('error', reject);
      javaTest?.once('exit', resolve);
    }),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `Java daemon E2E Maven test timed out after ${javaTestTimeoutMs}ms`,
            ),
          ),
        javaTestTimeoutMs,
      );
    }),
    signalFailure,
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
  if (result !== 0) {
    const logPath = path.join(
      testHome,
      '.qwen',
      'debug',
      'daemon',
      'daemon.log',
    );
    let daemonLog = '';
    try {
      daemonLog = readFileSync(logPath, 'utf8');
    } catch {
      daemonLog = '(daemon log unavailable)';
    }
    throw new Error(
      `Java E2E failed with ${result}; fake requests=${fake.requests.length}\n${stderr}\n${daemonLog}`,
    );
  }
  if (fake.requests.length === 0) {
    throw new Error(
      'Java E2E completed without exercising the daemon model path; the integration tests may have been skipped',
    );
  }
  succeeded = true;
} catch (error) {
  runFailure = error;
}

const cleanupFailures: unknown[] = [];
if (javaTest !== undefined) {
  try {
    await stopChild(javaTest, 'Maven test');
  } catch (error) {
    cleanupFailures.push(error);
  }
}
try {
  await stopChild(daemon, 'daemon');
} catch (error) {
  cleanupFailures.push(error);
}
try {
  await fake.close();
} catch (error) {
  cleanupFailures.push(error);
}
process.off('SIGINT', handleSigint);
process.off('SIGTERM', handleSigterm);
if (succeeded && cleanupFailures.length === 0) {
  rmSync(temporary, { recursive: true, force: true });
} else {
  console.error(`Retained Java daemon E2E state at ${temporary}`);
}
if (receivedSignal !== undefined) {
  process.kill(process.pid, receivedSignal);
}
if (runFailure !== undefined && cleanupFailures.length > 0) {
  throw new AggregateError(
    [runFailure, ...cleanupFailures],
    'Java daemon E2E and cleanup both failed',
  );
}
if (runFailure !== undefined) {
  throw runFailure;
}
if (cleanupFailures.length > 0) {
  throw new AggregateError(cleanupFailures, 'Java daemon E2E cleanup failed');
}
