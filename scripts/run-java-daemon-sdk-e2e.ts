import { spawn } from 'node:child_process';
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
const daemonClosed = new Promise<void>((resolve) => {
  daemon.once('close', () => resolve());
});

let stderr = '';
let succeeded = false;
daemon.stderr?.on('data', (chunk) => {
  stderr += chunk.toString();
});

async function stopDaemon(): Promise<void> {
  if (daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM');
  }
  const forceTimer = setTimeout(() => daemon.kill('SIGKILL'), 5_000);
  try {
    await daemonClosed;
  } finally {
    clearTimeout(forceTimer);
  }
}

try {
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`daemon startup timed out\n${stderr}`)),
      15_000,
    );
    let output = '';
    daemon.stdout?.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    daemon.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    daemon.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited with ${code}\n${stderr}`));
    });
  });

  const javaTest = spawn(
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
  const result = await new Promise<number | null>((resolve, reject) => {
    javaTest.once('error', reject);
    javaTest.once('exit', resolve);
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
} finally {
  await stopDaemon();
  await fake.close();
  if (succeeded) {
    rmSync(temporary, { recursive: true, force: true });
  } else {
    console.error(`Retained Java daemon E2E state at ${temporary}`);
  }
}
