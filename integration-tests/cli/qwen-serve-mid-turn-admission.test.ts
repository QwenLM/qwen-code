/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
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
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import { isNonBlockingAccepted } from '@qwen-code/sdk/daemon';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { spawnDaemon } from './_daemon-harness.js';

const STEERING = 'STEERING_MESSAGE';
const DRAFT = `  ${STEERING}  `;
const HOOK_CONTEXT = 'STEERING_HOOK_CONTEXT';

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(
  process.platform === 'win32' ||
    Boolean(
      process.env['QWEN_SANDBOX'] && process.env['QWEN_SANDBOX'] !== 'false',
    ),
)('ACP steering admission across daemon and child', () => {
  it.each(['cancel', 'commit'] as const)(
    'settles steering at the host commit boundary (%s)',
    async (outcome) => {
      const root = realpathSync(
        mkdtempSync(path.join(tmpdir(), 'qwen-steer-admission-')),
      );
      const workspace = path.join(root, 'workspace');
      const qwenHome = path.join(root, 'config');
      const runtime = path.join(root, 'runtime');
      const hook = path.join(root, 'submit.cjs');
      const hookLog = path.join(root, 'hook-log');
      const releaseHook = path.join(root, 'release-hook');
      const holdTool = gate();
      const holdContinuation = gate();
      mkdirSync(qwenHome);
      mkdirSync(workspace);
      const sample = path.join(workspace, 'sample.txt');
      writeFileSync(sample, 'tool output');
      if (outcome === 'commit') writeFileSync(releaseHook, '');
      writeFileSync(
        hook,
        `const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (input.prompt.includes(${JSON.stringify(STEERING)})) {
  fs.appendFileSync(${JSON.stringify(hookLog)}, 'steer\\n');
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(releaseHook)})) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit', additionalContext: ${JSON.stringify(HOOK_CONTEXT)}
    }}));
  }, 10);
}
`,
      );
      writeFileSync(
        path.join(qwenHome, 'settings.json'),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`,
                    timeout: 30,
                  },
                ],
              },
            ],
          },
        }),
      );
      const fake = await startFakeOpenAIServer(async ({ requestIndex }) => {
        if (requestIndex === 0) {
          await holdTool.promise;
          return {
            toolCalls: [fakeToolCall('read_file', { file_path: sample })],
          };
        }
        if (requestIndex === 1 && outcome === 'commit')
          await holdContinuation.promise;
        return { content: 'done' };
      });
      let daemon: Awaited<ReturnType<typeof spawnDaemon>> | undefined;
      try {
        daemon = await spawnDaemon({
          workspaceCwd: workspace,
          cliBin: process.env['TEST_GLOBAL_QWEN_ENTRY'],
          extraArgs: ['--no-web', '--chat-recording'],
          envDrop: [/^QWEN_/, /^OPENAI_/, /^(https?|all)_proxy$/i],
          env: {
            QWEN_HOME: qwenHome,
            QWEN_RUNTIME_DIR: runtime,
            OPENAI_API_KEY: 'fake-key',
            OPENAI_BASE_URL: fake.baseUrl,
            OPENAI_MODEL: 'fake-model',
          },
        });
        const { client } = daemon;
        const { sessionId, clientId } = await vi.waitFor(
          () =>
            client.createOrAttachSession({
              workspaceCwd: workspace,
              sessionScope: 'thread',
            }),
          { timeout: 15_000, interval: 250 },
        );
        const prompt = await client.promptNonBlocking(
          sessionId,
          { prompt: [{ type: 'text', text: 'initial request' }] },
          undefined,
          clientId,
        );
        expect(isNonBlockingAccepted(prompt)).toBe(true);
        await expect
          .poll(() => fake.requests.length, { timeout: 20_000 })
          .toBe(1);
        const initial = await client.getMidTurnMessages(sessionId, {
          clientId,
        });
        if (!process.env['TEST_GLOBAL_QWEN_ENTRY']) {
          expect(initial.target).toBeDefined();
        }
        const messageId = randomUUID();
        expect(
          await client.enqueueMidTurnMessage(sessionId, STEERING, {
            clientId,
            messageId,
            target: initial.target,
            draftText: DRAFT,
          }),
        ).toMatchObject({ accepted: true, messageId });
        holdTool.resolve();
        await expect
          .poll(() => existsSync(hookLog), { timeout: 15_000 })
          .toBe(true);
        const snapshot = () =>
          client.getMidTurnMessages(sessionId, { clientId, messageId });
        if (outcome === 'commit') {
          await expect
            .poll(() => fake.requests.length, { timeout: 15_000 })
            .toBe(2);
        } else {
          expect((await snapshot()).settledMessageIds).not.toContain(messageId);
        }

        await client.cancel(sessionId, clientId);
        const transcript = path.join(
          new Storage(workspace, runtime).getProjectDir(),
          'chats',
          `${sessionId}.jsonl`,
        );
        if (outcome === 'cancel') {
          await expect
            .poll(async () => (await snapshot()).recoveries)
            .toEqual([expect.objectContaining({ messageId, text: DRAFT })]);
          expect(
            (await client.getMidTurnMessages(sessionId)).recoveries ?? [],
          ).toEqual([]);
          expect(
            await client.enqueueMidTurnMessage(sessionId, 'late after cancel', {
              clientId,
              messageId: randomUUID(),
              target: initial.target,
            }),
          ).toMatchObject({ accepted: false, reason: 'turn_cancelled' });
          await client.consumeMidTurnRecovery(sessionId, [messageId], {
            clientId,
          });
          expect((await snapshot()).recoveries ?? []).toEqual([]);
          expect((await snapshot()).disposition).toBe('owned');
          expect(readFileSync(transcript, 'utf8')).not.toContain(STEERING);
          expect(fake.requests).toHaveLength(1);
          await client.promptNonBlocking(
            sessionId,
            { prompt: [{ type: 'text', text: 'new independent request' }] },
            undefined,
            clientId,
          );
          await expect
            .poll(() => fake.requests.length, { timeout: 15_000 })
            .toBe(2);
          expect(
            JSON.stringify(fake.requests[1]?.body['messages']),
          ).not.toContain(STEERING);
        } else {
          const restored = readFileSync(transcript, 'utf8');
          expect(
            restored.split('\n').filter((line) => line.includes(messageId)),
          ).toHaveLength(1);
          expect(restored).toContain(HOOK_CONTEXT);
          expect(JSON.stringify(fake.requests[1]?.body['messages'])).toContain(
            STEERING,
          );
          expect(JSON.stringify(fake.requests[1]?.body['messages'])).toContain(
            HOOK_CONTEXT,
          );
          expect((await snapshot()).recoveries ?? []).toEqual([]);
        }
        expect(readFileSync(hookLog, 'utf8')).toBe('steer\n');
      } finally {
        holdContinuation.resolve();
        holdTool.resolve();
        await daemon?.dispose();
        await fake.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    75_000,
  );
});
