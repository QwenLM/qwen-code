/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
  TestRig,
  type,
} from '../test-helper.js';

type JsonObject = Record<string, unknown>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toolNames(body: JsonObject): string[] {
  const tools = body['tools'];
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (typeof tool !== 'object' || tool === null) return [];
    const fn = (tool as JsonObject)['function'];
    if (typeof fn !== 'object' || fn === null) return [];
    const name = (fn as JsonObject)['name'];
    return typeof name === 'string' ? [name] : [];
  });
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null) return '';
      const record = part as JsonObject;
      return typeof record['text'] === 'string' ? record['text'] : '';
    })
    .join('\n');
}

function allMessageText(body: JsonObject): string {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return '';
  return messages
    .map((message) =>
      typeof message === 'object' && message !== null
        ? textFromContent((message as JsonObject)['content'])
        : '',
    )
    .join('\n');
}

async function setupAdvisorRig(rig: TestRig, baseUrl: string): Promise<void> {
  await rig.setup('interactive-advisor-command', {
    settings: {
      modelProviders: {
        openai: [
          {
            id: 'request-model',
            name: 'Request Model',
            baseUrl,
            envKey: 'OPENAI_API_KEY',
          },
          {
            id: 'advisor-model',
            name: 'Advisor Model',
            baseUrl,
            envKey: 'OPENAI_API_KEY',
          },
        ],
      },
      security: { auth: { selectedType: 'openai' } },
      advisorModel: '',
      memory: {
        enableManagedAutoMemory: false,
        enableManagedAutoDream: false,
      },
      ui: { enableFollowupSuggestions: false },
    },
  });
  vi.stubEnv('HOME', rig.testDir!);
  vi.stubEnv('QWEN_HOME', join(rig.testDir!, '.qwen'));
  vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.qwen'));
  vi.stubEnv('QWEN_CODE_NO_RELAUNCH', '1');
  vi.stubEnv('QWEN_CODE_SKIP_UPDATE_CHECK_ONCE', 'true');
}

describe('interactive Advisor command', () => {
  let rig: TestRig;
  let server: FakeOpenAIServer | undefined;
  let restoreNoProxy: () => void;

  beforeEach(() => {
    rig = new TestRig();
    restoreNoProxy = applyContainerSandboxNoProxy();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server?.close();
    server = undefined;
    restoreNoProxy();
    await rig.cleanup();
  });

  it.skipIf(process.platform === 'win32')(
    'opens the no-arg Advisor picker with Off',
    async () => {
      server = await startFakeOpenAIServer(() => {
        throw new Error('The Advisor picker should not call the model.');
      }, fakeServerHostOptions());

      await setupAdvisorRig(rig, server.baseUrl);

      const { ptyProcess, promise } = rig.runInteractive(
        '--auth-type',
        'openai',
        '--openai-api-key',
        'fake-key',
        '--openai-base-url',
        server.baseUrl,
        '--model',
        'request-model',
      );

      try {
        const ready = await rig.waitForText('YOLO mode', 15000);
        expect(ready, 'CLI did not start in interactive mode').toBe(true);
        await sleep(1000);

        await type(ptyProcess, '/advisor');
        await type(ptyProcess, '\r');

        expect(await rig.waitForText('Select Advisor Model', 10000)).toBe(true);
        expect(await rig.waitForText('Off', 10000)).toBe(true);
        expect(await rig.waitForText('advisor-model', 10000)).toBe(true);

        await type(ptyProcess, '\x1b');
      } finally {
        ptyProcess.kill();
        await promise;
      }

      expect(server.requests).toHaveLength(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'enables, uses, and disables Advisor from the TUI',
    async () => {
      let mainRequestIndex = 0;
      server = await startFakeOpenAIServer(({ body }) => {
        if (body['model'] === 'advisor-model') {
          return {
            content: JSON.stringify({
              verdict: 'Interactive Advisor advice.',
              risks: 'None found',
              missingEvidence: 'None found',
              recommendation: 'Continue with the TUI task.',
            }),
          };
        }

        if (body['stream'] !== true) {
          return { content: '{"selected_memories":[]}' };
        }

        mainRequestIndex += 1;
        if (mainRequestIndex === 1) {
          return {
            content: 'Consulting the interactive Advisor first.',
            toolCalls: [
              fakeToolCall('advisor', {}, 'interactive-advisor-call'),
            ],
          };
        }
        if (mainRequestIndex === 2) {
          return { content: 'Interactive final after Advisor advice.' };
        }
        return { content: 'Interactive final without Advisor.' };
      }, fakeServerHostOptions());

      await setupAdvisorRig(rig, server.baseUrl);

      const { ptyProcess, promise } = rig.runInteractive(
        '--auth-type',
        'openai',
        '--openai-api-key',
        'fake-key',
        '--openai-base-url',
        server.baseUrl,
        '--model',
        'request-model',
      );

      try {
        const ready = await rig.waitForText('YOLO mode', 15000);
        expect(ready, 'CLI did not start in interactive mode').toBe(true);
        await sleep(1000);

        await type(ptyProcess, '/advisor advisor-model');
        await type(ptyProcess, '\r');
        await sleep(300);
        await type(ptyProcess, '\r');
        const enabled = await rig.waitForText(
          'Advisor Model: advisor-model',
          10000,
        );
        expect(enabled, 'Advisor command did not enable the model').toBe(true);

        await type(ptyProcess, 'Use Advisor once, then answer.');
        await type(ptyProcess, '\r');
        expect(await rig.waitForToolCall('advisor', 20000)).toBe(true);
        expect(
          await rig.waitForText(
            'Interactive final after Advisor advice.',
            20000,
          ),
        ).toBe(true);

        await type(ptyProcess, '/advisor off');
        await type(ptyProcess, '\r');
        await sleep(300);
        await type(ptyProcess, '\r');
        expect(await rig.waitForText('Advisor disabled', 10000)).toBe(true);

        await type(ptyProcess, 'Answer after Advisor is disabled.');
        await type(ptyProcess, '\r');
        expect(
          await rig.waitForText('Interactive final without Advisor.', 20000),
        ).toBe(true);
      } finally {
        ptyProcess.kill();
        await promise;
      }

      const mainRequests = server.requests
        .map((request) => request.body)
        .filter(
          (body) =>
            body['stream'] === true && body['model'] === 'request-model',
        );
      const advisorRequests = server.requests
        .map((request) => request.body)
        .filter((body) => body['model'] === 'advisor-model');

      expect(mainRequests).toHaveLength(3);
      expect(advisorRequests).toHaveLength(1);
      expect(toolNames(mainRequests[0]!)).toContain('advisor');
      expect(allMessageText(mainRequests[0]!)).toContain(
        "Call 'advisor' by itself",
      );
      expect(allMessageText(mainRequests[1]!)).toContain(
        'Interactive Advisor advice.',
      );
      expect(toolNames(mainRequests[2]!)).not.toContain('advisor');
      expect(allMessageText(mainRequests[2]!)).not.toContain(
        "Call 'advisor' by itself",
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'runs manual Advisor review without recording it as a normal TUI turn',
    async () => {
      const reviewFocus = 'check interactive review routing';
      let mainRequestIndex = 0;
      server = await startFakeOpenAIServer(({ body }) => {
        if (body['stream'] !== true) {
          return { content: '{"selected_memories":[]}' };
        }

        if (allMessageText(body).includes('You are acting as an ADVISOR')) {
          return {
            content: JSON.stringify({
              verdict: 'Interactive review command was handled.',
              risks: 'None found',
              missingEvidence: 'None found',
              recommendation: 'Continue with the normal turn.',
            }),
          };
        }

        mainRequestIndex += 1;
        if (mainRequestIndex === 1) {
          return { content: 'Primed interactive session.' };
        }
        return { content: 'Normal response after interactive review.' };
      }, fakeServerHostOptions());

      await setupAdvisorRig(rig, server.baseUrl);

      const { ptyProcess, promise } = rig.runInteractive(
        '--auth-type',
        'openai',
        '--openai-api-key',
        'fake-key',
        '--openai-base-url',
        server.baseUrl,
        '--model',
        'request-model',
      );

      try {
        const ready = await rig.waitForText('YOLO mode', 15000);
        expect(ready, 'CLI did not start in interactive mode').toBe(true);

        await type(ptyProcess, 'Prime the TUI session.');
        await type(ptyProcess, '\r');
        expect(
          await rig.waitForText('Primed interactive session.', 20000),
        ).toBe(true);

        await type(ptyProcess, `/advisor review ${reviewFocus}`);
        await type(ptyProcess, '\r');
        expect(await rig.waitForText('Interactive review command', 20000)).toBe(
          true,
        );

        await type(ptyProcess, 'Continue after interactive review.');
        await type(ptyProcess, '\r');
        expect(
          await rig.waitForText(
            'Normal response after interactive review.',
            20000,
          ),
        ).toBe(true);
      } finally {
        ptyProcess.kill();
        await promise;
      }

      const reviewRequests = server.requests
        .map((request) => request.body)
        .filter((body) =>
          allMessageText(body).includes('You are acting as an ADVISOR'),
        );
      const mainRequests = server.requests
        .map((request) => request.body)
        .filter(
          (body) =>
            body['stream'] === true &&
            body['model'] === 'request-model' &&
            !allMessageText(body).includes('You are acting as an ADVISOR'),
        );

      expect(reviewRequests).toHaveLength(1);
      expect(mainRequests).toHaveLength(2);
      expect(allMessageText(mainRequests[1]!)).not.toContain('/advisor review');
      expect(allMessageText(mainRequests[1]!)).not.toContain(reviewFocus);
    },
  );
});
