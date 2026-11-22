/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '@qwen-code/sdk';
import type { DaemonSessionWorkflowTaskStatus } from '@qwen-code/sdk/daemon';
import {
  startFakeOpenAIServer,
  type FakeOpenAIRequest,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { sharedLoopRoundCount } from '../test-helper.js';
import {
  DEFAULT_CLI_BIN,
  spawnDaemon,
  type SpawnedDaemon,
} from './_daemon-harness.js';

const START = 'DWBG_START_PROMPT';
const CHILD = 'DWBG_CHILD_PROMPT';
const RESULT = 'DWBG_WORKFLOW_RESULT';
const STARTED_ACK = 'DWBG_STARTED_ACK';
const NOTIFIED_REPLY = 'DWBG_NOTIFIED_REPLY';
const SECOND = 'DWBG_SECOND_PROMPT';
const THIRD = 'DWBG_THIRD_PROMPT';

function messagesText(request: FakeOpenAIRequest): string {
  return JSON.stringify(request.body['messages'] ?? []);
}

async function workflowTasks(
  daemon: SpawnedDaemon,
  session: DaemonSession,
): Promise<DaemonSessionWorkflowTaskStatus[]> {
  const status = await daemon.client.sessionWorkflowTasks(
    session.sessionId,
    session.clientId,
  );
  return status.tasks.filter(
    (task): task is DaemonSessionWorkflowTaskStatus => task.kind === 'workflow',
  );
}

// The parent conversation carries the user's marker; the workflow's agent()
// conversation carries only its own prompt.
function isParentRequest(request: FakeOpenAIRequest): boolean {
  return messagesText(request).includes(START);
}

// A request that carries the run's settlement as its newest message. Later
// requests repeat it in their history, so they do not count.
function isNotificationRequest(request: FakeOpenAIRequest): boolean {
  const last = lastUserText(request.body);
  return (
    isParentRequest(request) &&
    last !== undefined &&
    last.includes('<kind>workflow</kind>') &&
    last.includes(RESULT)
  );
}

function lastUserText(body: Record<string, unknown>): string | undefined {
  const messages = (body['messages'] ?? []) as Array<{
    role: string;
    content: unknown;
  }>;
  const last = messages.at(-1);
  return last?.role === 'user' ? JSON.stringify(last.content) : undefined;
}

// A model-requested background workflow in a daemon (ACP) session: the tool
// returns a run handle, the prompt turn ends while the run is still working,
// stopping a later turn leaves the run alone, and the settled run comes back
// as exactly one notification turn.
describe.skipIf(process.platform === 'win32').each([false, true])(
  'daemon model-requested background workflow (shared=%s)',
  (shared) => {
    let root: string;
    let server: FakeOpenAIServer;
    let daemon: SpawnedDaemon;
    let session: DaemonSession;
    let releaseChild: () => void = () => {};
    const childReleased = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let releaseSecond: () => void = () => {};
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    beforeAll(async () => {
      root = await fs.realpath(
        await fs.mkdtemp(path.join(tmpdir(), 'dwbg-daemon-')),
      );
      const home = path.join(root, 'home');
      const workspace = path.join(root, 'workspace');
      await Promise.all(
        [home, workspace].map((directory) => fs.mkdir(directory)),
      );
      await fs.writeFile(
        path.join(home, 'settings.json'),
        JSON.stringify({
          tools: { workflowsEnabled: true },
          experimental: { unifiedAgentLoop: shared },
          security: {
            auth: { selectedType: 'openai' },
            folderTrust: { enabled: true },
          },
          memory: {
            enableManagedAutoMemory: false,
            enableManagedAutoDream: false,
          },
          general: { enableAutoUpdate: false },
          ui: { enableFollowupSuggestions: false },
          telemetry: { enabled: false },
          model: { skipNextSpeakerCheck: true, skipWorkflowUsageWarning: true },
        }),
      );
      await fs.writeFile(
        path.join(home, 'trustedFolders.json'),
        JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
      );
      await fs.writeFile(path.join(root, 'system.json'), '{}');
      server = await startFakeOpenAIServer(async ({ body }) => {
        if (body['stream'] !== true) return { content: '{}' };
        const text = JSON.stringify(body['messages'] ?? []);
        if (!text.includes(START)) {
          // The workflow's agent(): held until the prompt turn has ended,
          // so the run is provably still working after the tool returned.
          if (text.includes(CHILD)) {
            await childReleased;
            return { content: 'DWBG_CHILD_ANSWER' };
          }
          return { content: 'DWBG_UNEXPECTED_REQUEST' };
        }
        if (text.includes('<kind>workflow</kind>') && text.includes(RESULT)) {
          return { content: NOTIFIED_REPLY };
        }
        // A later turn, held until the test has stopped it.
        if (lastUserText(body)?.includes(SECOND)) {
          await secondReleased;
          return { content: 'DWBG_SECOND_REPLY' };
        }
        // Any answer to the tool call, so a refused call ends the turn and
        // fails the assertions below instead of looping on the tool call.
        const messages = body['messages'] as Array<{ role: string }>;
        if (messages.some((message) => message.role === 'tool')) {
          return { content: STARTED_ACK };
        }
        return {
          toolCalls: [
            {
              id: 'dwbg-workflow-call',
              type: 'function',
              function: {
                name: 'workflow',
                arguments: JSON.stringify({
                  script: `phase('wait'); const answer = await agent(${JSON.stringify(CHILD)}); return { marker: ${JSON.stringify(RESULT)}, answer };`,
                  run_in_background: true,
                }),
              },
            },
          ],
        };
      });
      daemon = await spawnDaemon({
        cliBin: DEFAULT_CLI_BIN,
        workspaceCwd: workspace,
        bootTimeoutMs: 60_000,
        env: {
          HOME: home,
          USERPROFILE: home,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: path.join(root, 'runtime'),
          QWEN_DEBUG_LOG_FILE: '1',
          QWEN_CLI_ENTRY: DEFAULT_CLI_BIN,
          // The docker E2E leg exports QWEN_SANDBOX=docker; inherited by the
          // daemon's `qwen --acp` children, it puts them in a container with
          // no host-loopback route to the fake model server.
          QWEN_SANDBOX: 'false',
          QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'system.json'),
          QWEN_CODE_TRUSTED_FOLDERS_PATH: path.join(
            home,
            'trustedFolders.json',
          ),
          QWEN_CODE_DISABLE_WORKFLOWS: '0',
          QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP: shared ? '1' : '0',
          QWEN_CODE_DISABLE_CRON: '1',
          OPENAI_API_KEY: 'fake-key',
          OPENAI_BASE_URL: server.baseUrl,
          OPENAI_MODEL: 'fake-model',
          QWEN_MODEL: 'fake-model',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          http_proxy: '',
          https_proxy: '',
        },
      });
      session = await daemon.client.createOrAttachSession({
        workspaceCwd: workspace,
        approvalMode: 'yolo',
        sessionScope: 'thread',
      });
    }, 120_000);

    afterAll(async () => {
      releaseChild();
      releaseSecond();
      await daemon?.dispose();
      await server?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it('ends the turn on the run handle and reports the settled run once', async () => {
      const result = await daemon.client.prompt(
        session.sessionId,
        { prompt: [{ type: 'text', text: START }] },
        AbortSignal.timeout(60_000),
        session.clientId,
      );
      expect(result.stopReason).toBe('end_turn');

      // The turn answered from the run handle while the run kept working.
      const parent = server.requests.filter(isParentRequest);
      expect(messagesText(parent.at(-1)!)).toContain(
        'Workflow started in background.',
      );
      expect(server.requests.filter(isNotificationRequest)).toHaveLength(0);
      const run = (await workflowTasks(daemon, session)).find(
        (task) => task.toolUseId === 'dwbg-workflow-call',
      );
      expect(run).toMatchObject({ kind: 'workflow', status: 'running' });

      // Stopping a later turn does not stop the run the earlier turn started.
      const second = daemon.client.prompt(
        session.sessionId,
        { prompt: [{ type: 'text', text: SECOND }] },
        AbortSignal.timeout(60_000),
        session.clientId,
      );
      await vi.waitFor(
        () =>
          expect(
            server.requests.some(({ body }) =>
              lastUserText(body)?.includes(SECOND),
            ),
          ).toBe(true),
        { timeout: 30_000, interval: 100 },
      );
      await daemon.client.cancel(session.sessionId, session.clientId);
      expect((await second).stopReason).toBe('cancelled');
      releaseSecond();
      expect(
        (await workflowTasks(daemon, session)).find(
          (task) => task.id === run!.id,
        ),
      ).toMatchObject({ status: 'running' });

      // The run settles on its own. Stopping a turn holds background reports
      // until the next prompt (as it does for agents and shells), so nothing
      // reaches the model yet.
      releaseChild();
      await vi.waitFor(
        async () => {
          const settled = await workflowTasks(daemon, session);
          expect(settled.find((task) => task.id === run!.id)).toMatchObject({
            status: 'completed',
          });
        },
        { timeout: 60_000, interval: 200 },
      );
      expect(server.requests.filter(isNotificationRequest)).toHaveLength(0);

      // The next prompt releases the held report: one notification request.
      const third = await daemon.client.prompt(
        session.sessionId,
        { prompt: [{ type: 'text', text: THIRD }] },
        AbortSignal.timeout(60_000),
        session.clientId,
      );
      expect(third.stopReason).toBe('end_turn');
      await vi.waitFor(
        () =>
          expect(server.requests.filter(isNotificationRequest)).toHaveLength(1),
        { timeout: 60_000, interval: 200 },
      );
      // Give a duplicate delivery the chance to show up before counting.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(server.requests.filter(isNotificationRequest)).toHaveLength(1);
      // The arm label must be real: the shared arm runs the shared loop,
      // the legacy arm never calls runModelRound.
      expect(sharedLoopRoundCount(path.join(root, 'runtime')) > 0).toBe(shared);
    }, 180_000);
  },
);
