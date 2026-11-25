import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk';
import type { DaemonScheduledTask } from '@qwen-code/web-shell/daemon-react-sdk';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  runScheduledTaskManually,
  type ScheduledTaskRunPrompt,
} from '../../packages/web-shell/client/utils/scheduledTaskManualRun.js';
import type { TranslateFn } from '../../packages/web-shell/client/components/dialogs/scheduledTasksSchedule.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'dist/cli.js');
const HOME = join(tmpdir(), `qwen-real-session-scheduled-${process.pid}`);
const WORKSPACE = HOME;
const TOKEN = 'integration-session-scheduled-task-token';
const MANUAL_MARKER = 'REAL_BOUND_SESSION_MANUAL_RUN_7742';
let server: ChildProcessWithoutNullStreams;
let fake: FakeOpenAIServer;
let client: DaemonClient;
let baseUrl = '';

/** Launch the real built daemon. All HTTP and ACP subprocess traffic in this
 * test uses real sockets; only LLM responses are deterministic. */
async function startDaemon(): Promise<void> {
  mkdirSync(HOME, { recursive: true });
  let stdoutContent = '';
  // Never inherit the host session's selected provider/model credentials.
  // The previous spread of process.env could route prompts to the real user
  // model even when a fake OpenAI endpoint was supplied.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME,
    TMPDIR: HOME,
    QWEN_RUNTIME_DIR: join(HOME, 'runtime'),
    DEBUG: '1',
    OPENAI_API_KEY: 'fake-key',
    OPENAI_BASE_URL: fake.baseUrl,
    OPENAI_MODEL: 'fake-model',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };

  server = spawn(
    process.execPath,
    [
      CLI,
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--token',
      TOKEN,
      '--workspace',
      WORKSPACE,
      '--initialize-timeout-ms',
      '60000',
    ],
    { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const [stderrFile, stdoutFile] = [
    join(HOME, 'daemon.stderr.log'),
    join(HOME, 'daemon.stdout.log'),
  ];
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (d) => {
    void appendFile(stderrFile, d);
  });
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (d) => {
    stdoutContent += d;
    void appendFile(stdoutFile, d);
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const endpoint = stdoutContent.match(
      /qwen serve listening on (https?:\/\/\S+)/,
    );
    if (endpoint?.[1]) {
      baseUrl = endpoint[1];
      client = new DaemonClient({ baseUrl, token: TOKEN });
      return;
    }
    if (server.exitCode !== null) {
      throw new Error(
        `serve exited with code ${server.exitCode}: ${await readFile(stderrFile, 'utf-8')}`,
      );
    }
    await sleep(100);
  }
  throw new Error('daemon failed to start within 60s');
}

async function stopDaemon(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => {
    server.once('exit', () => resolve());
    setTimeout(() => resolve(), 10_000);
  });
  server.kill('SIGTERM');
  await closed;
  if (server.exitCode === null) server.kill('SIGKILL');
}

function latestUserText(body: string): string {
  const messages = (
    JSON.parse(body) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    }
  ).messages;
  const last = messages?.[messages.length - 1];
  if (last?.role !== 'user') return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

async function scheduledTaskRequest(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

const english: TranslateFn = ((key: string) => {
  if (key === 'scheduledTasks.error.runFailed') return 'Run failed';
  if (key === 'scheduledTasks.error.oneShotConsumedButFailed') {
    return 'Task consumed before run';
  }
  return key;
}) as TranslateFn;

beforeAll(async () => {
  fake = await startFakeOpenAIServer(({ body }) => {
    const last = latestUserText(JSON.stringify(body));
    if (last.includes('CREATE_SESSION_CRON_')) {
      return {
        toolCalls: [
          fakeToolCall('cron_create', {
            cron: '0 0 * * *',
            prompt: 'A session-only cron audit',
            recurring: true,
          }),
        ],
      };
    }
    if (last.includes('CREATE_LOOP_WAKEUP_')) {
      return {
        toolCalls: [
          fakeToolCall('loop_wakeup', {
            delaySeconds: 3600,
            prompt: 'A pending self-paced loop audit',
          }),
        ],
      };
    }
    if (last === 'SESSION_CRON_CREATED') {
      return { content: 'Created session cron.' };
    }
    if (last.includes(CREATE_MANUAL_PROMPT)) {
      return { content: `Received manual prompt: ${MANUAL_MARKER}` };
    }
    return { content: 'Acknowledged.' };
  });
  await startDaemon();
}, 90_000);

afterAll(async () => {
  await stopDaemon();
  await fake.close();
});

const CREATE_MANUAL_PROMPT = 'RUN_BOUND_SESSION_MANUALLY';
let sessionId: string;
let boundPersistentTaskId: string;

describe('real daemon session scheduled tasks', () => {
  it('enumerates and cancels session cron/jobs and preserves durable tasks', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: HOME,
      approvalMode: 'yolo',
    });
    sessionId = session.sessionId;
    await client.prompt(sessionId, {
      prompt: [{ type: 'text', text: 'CREATE_SESSION_CRON_1' }],
    });
    // Required fixture witness: this protocol test is valid only when the
    // actual ACP subprocess reaches the deterministic local model server.
    expect(fake.requests.length).toBeGreaterThan(0);

    await vi.waitFor(async () => {
      const snapshot = await client.sessionTasks(sessionId);
      expect(snapshot.scheduledTasks).toEqual([
        expect.objectContaining({
          source: 'cron',
          cronExpr: '0 0 * * *',
          recurring: true,
          prompt: 'A session-only cron audit',
          nextRunAt: expect.any(Number),
        }),
      ]);
    });
    const cronId = client
      ? (await client.sessionTasks(sessionId)).scheduledTasks![0]!.id
      : '';
    expect(await client.sessionTaskCancel(sessionId, cronId, 'cron')).toEqual({
      cancelled: true,
    });
    await vi.waitFor(async () => {
      expect(
        (await client.sessionTasks(sessionId)).scheduledTasks ?? [],
      ).toEqual([]);
    });

    const route = await scheduledTaskRequest('/scheduled-tasks');
    expect(route).toMatchObject({ tasks: [] });
  }, 60_000);

  it('requires a genuine bound-session prompt for manual runs, not a record-only /run call', async () => {
    const manualSession = await client.createOrAttachSession({
      workspaceCwd: HOME,
      approvalMode: 'yolo',
    });
    sessionId = manualSession.sessionId;
    const created = (await scheduledTaskRequest('/scheduled-tasks', {
      method: 'POST',
      body: {
        cron: '0 0 * * *',
        prompt: CREATE_MANUAL_PROMPT,
        recurring: true,
        sessionId,
        sessionMode: 'persistent',
      },
    })) as DaemonScheduledTask;
    boundPersistentTaskId = created.id;

    // Negative control: previous environment-panel behavior, a bare /run
    // POST, records but cannot ever send this bound-session prompt. Freeze
    // both the request count and prompt bytes at this call's boundary.
    const requestsBeforeBareRun = fake.requests.length;
    const bareRun = (await scheduledTaskRequest(
      `/scheduled-tasks/${created.id}/run`,
      { method: 'POST' },
    )) as DaemonScheduledTask;
    expect(fake.requests).toHaveLength(requestsBeforeBareRun);
    await client.prompt(sessionId, {
      prompt: [{ type: 'text', text: 'POST_BARE_RUN_QUIESCENCE' }],
    });
    expect(JSON.stringify(fake.requests)).not.toContain(CREATE_MANUAL_PROMPT);
    expect(bareRun.runs.filter((run) => run.kind === 'manual')).toHaveLength(
      (created.runs ?? []).filter((run) => run.kind === 'manual').length + 1,
    );

    const order: string[] = [];
    const onRunPrompt: ScheduledTaskRunPrompt = async (
      prompt,
      boundSessionId,
      workspaceCwd,
    ) => {
      expect(prompt).toBe(CREATE_MANUAL_PROMPT);
      expect(boundSessionId).toBe(sessionId);
      expect(workspaceCwd).toBeUndefined();
      order.push('enqueue');
      await client.prompt(sessionId, {
        prompt: [{ type: 'text', text: prompt }],
      });
    };
    await runScheduledTaskManually(
      created,
      {
        assertScheduledTaskOwnerSelection: async (ownerSessionId) => {
          expect(ownerSessionId).toBe(sessionId);
          order.push('assert-owner');
        },
        listScheduledTasks: async (workspaceId) => {
          order.push('fresh');
          expect(workspaceId).toBeUndefined();
          const response = (await scheduledTaskRequest('/scheduled-tasks')) as {
            tasks: DaemonScheduledTask[];
          };
          return response.tasks;
        },
        runScheduledTask: async (id, workspaceId) => {
          order.push('record');
          return (await scheduledTaskRequest(`/scheduled-tasks/${id}/run`, {
            method: 'POST',
            body: { workspaceCwd: workspaceId },
          })) as DaemonScheduledTask;
        },
      },
      onRunPrompt,
      english,
      {
        reload: () => undefined,
        onError: (error) => {
          throw error;
        },
      },
    );
    expect(order).toEqual(['fresh', 'assert-owner', 'enqueue', 'record']);

    const transcript = await client.getSessionTranscriptPage(sessionId);
    expect(JSON.stringify(transcript)).toContain(
      `Received manual prompt: ${MANUAL_MARKER}`,
    );
    const after = (await scheduledTaskRequest('/scheduled-tasks')) as {
      tasks: DaemonScheduledTask[];
    };
    const actualRun = after.tasks.find((task) => task.id === created.id)!;
    expect(actualRun).toMatchObject({
      id: created.id,
      enabled: true,
      recurring: true,
      sessionId,
    });
    expect(actualRun.runs.filter((run) => run.kind === 'manual')).toHaveLength(
      bareRun.runs.filter((run) => run.kind === 'manual').length + 1,
    );
    expect(actualRun.lastFiredAt).toBeGreaterThanOrEqual(
      bareRun.lastFiredAt ?? 0,
    );

    // The control and actual run both recorded, yet only the shared manual
    // flow reached the ACP session/model and returned visible output.
    const snapshots = await client.sessionTasks(sessionId);
    expect(snapshots.sessionId).toBe(sessionId);
  }, 60_000);

  it('does not let the cron task cancel route cancel a durable task', async () => {
    const tasks = await scheduledTaskRequest('/scheduled-tasks');
    const durable = (tasks as { tasks: DaemonScheduledTask[] }).tasks.find(
      (task) => task.id === boundPersistentTaskId,
    )!;
    expect(durable).toBeDefined();
    expect(durable.sessionId).toBe(sessionId);
    const result = (await scheduledTaskRequest(
      `/session/${sessionId}/tasks/${durable.id}/cancel`,
      { method: 'POST', body: { kind: 'cron' } },
    )) as { cancelled: boolean; reason?: string };
    expect(result).toMatchObject({
      cancelled: false,
      reason: 'not_session_scoped',
    });
    expect(
      (
        (await scheduledTaskRequest('/scheduled-tasks')) as {
          tasks: DaemonScheduledTask[];
        }
      ).tasks.some((task) => task.id === durable.id),
    ).toBe(true);
  }, 30_000);

  it('lists and cancels a pending loop wakeup over the real daemon', async () => {
    const loopSession = await client.createOrAttachSession({
      workspaceCwd: HOME,
    });
    await client.promptNonBlocking(loopSession.sessionId, {
      prompt: [{ type: 'text', text: 'CREATE_LOOP_WAKEUP_1' }],
    });
    await vi.waitFor(async () => {
      const snapshot = await client.sessionTasks(loopSession.sessionId);
      expect(snapshot.scheduledTasks).toEqual([
        expect.objectContaining({ source: 'wakeup', recurring: false }),
      ]);
    });
    const id = (await client.sessionTasks(loopSession.sessionId))
      .scheduledTasks![0]!.id;
    await client.sessionTaskCancel(loopSession.sessionId, id, 'cron');
    await vi.waitFor(async () => {
      expect(
        (await client.sessionTasks(loopSession.sessionId)).scheduledTasks ?? [],
      ).toEqual([]);
    });
  }, 45_000);
});
