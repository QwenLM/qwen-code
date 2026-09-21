/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
  TestRig,
} from '../test-helper.js';
import { pickE2eRenderer } from '../renderer-matrix.js';
import { InteractiveSession } from './interactive-session.js';

// OpenTUI's schedule_tool handler is a separate, unwired entry point.
describe.skipIf(pickE2eRenderer() === 'opentui')(
  'saved workflow slash-command completion',
  () => {
    let rig: TestRig;
    let server: FakeOpenAIServer | undefined;
    let session: InteractiveSession | undefined;
    let restoreNoProxy: (() => void) | undefined;

    afterEach(async () => {
      await session?.close();
      session = undefined;
      await server?.close();
      server = undefined;
      restoreNoProxy?.();
      await rig?.cleanup();
    });

    it.each([
      {
        source: 'slash',
        status: 'completed',
        script:
          'return { marker: "WORKFLOW_PARTIAL_RESULT_12176", failed: ["fr"] };',
        marker: 'WORKFLOW_PARTIAL_RESULT_12176',
      },
      {
        source: 'slash',
        status: 'failed',
        script: 'throw new Error("WORKFLOW_RUN_ERROR_12176");',
        marker: 'WORKFLOW_RUN_ERROR_12176',
      },
      {
        source: 'model',
        status: 'completed',
        script: 'return { marker: "WORKFLOW_MODEL_RESULT_12176" };',
        marker: 'WORKFLOW_MODEL_RESULT_12176',
      },
    ])('delivers a $source $status run to the model once', async (testCase) => {
      const isSlash = testCase.source === 'slash';
      rig = new TestRig();
      restoreNoProxy = applyContainerSandboxNoProxy();
      await rig.setup(`workflow-completion-${testCase.status}`, {
        settings: { telemetry: { enabled: false } },
      });
      const qwenHome = join(rig.testDir!, '.qwen-home');
      mkdirSync(qwenHome, { recursive: true });
      writeFileSync(
        join(qwenHome, 'settings.json'),
        JSON.stringify({
          general: { enableAutoUpdate: false },
          tools: { workflowsEnabled: true },
          model: { skipWorkflowUsageWarning: true },
          memory: {
            enableManagedAutoMemory: false,
            enableManagedAutoDream: false,
          },
          ui: { enableFollowupSuggestions: false },
          security: {
            auth: { selectedType: 'openai' },
            folderTrust: { enabled: false },
          },
        }),
      );
      const workflowDir = join(rig.testDir!, '.qwen', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(workflowDir, 'report-probe.js'), testCase.script);

      const reply = `MODEL_RECEIVED_WORKFLOW_${testCase.status.toUpperCase()}`;
      server = await startFakeOpenAIServer(({ body }) => {
        if (body['stream'] !== true) return { content: '{}' };
        const messages = JSON.stringify(body['messages']);
        if (!isSlash && !messages.includes(testCase.marker)) {
          return {
            toolCalls: [
              {
                id: 'model-workflow-call',
                type: 'function',
                function: {
                  name: 'workflow',
                  arguments: JSON.stringify({ name: 'report-probe' }),
                },
              },
            ],
          };
        }
        const expectedReply = messages.includes(
          'What did that workflow return?',
        )
          ? `${reply}_FOLLOWUP`
          : reply;
        return {
          content:
            (!isSlash || messages.includes('<kind>workflow</kind>')) &&
            messages.includes(testCase.marker)
              ? expectedReply
              : 'WORKFLOW_RESULT_MISSING',
        };
      }, fakeServerHostOptions());

      session = await InteractiveSession.start({
        cwd: rig.testDir!,
        env: {
          QWEN_HOME: qwenHome,
          QWEN_RUNTIME_DIR: join(rig.testDir!, '.runtime'),
          QWEN_CODE_LANG: 'en',
          QWEN_CODE_DISABLE_WORKFLOWS: '0',
        },
        args: [
          '--auth-type',
          'openai',
          '--openai-api-key',
          'fake-key',
          '--openai-base-url',
          server.baseUrl,
          '--model',
          'fake-model',
          '--approval-mode',
          'yolo',
        ],
      });

      // The prompt can appear before the async command registry is ready.
      // Probe a read-only command, never retry the workflow invocation itself.
      for (let attempt = 0; attempt < 5; attempt++) {
        await session.idle(500);
        await session.send('/about');
        const screen = await session.waitForScreen(
          (text) =>
            text.includes('Memory Usage') ||
            text.includes('Unknown command: /about'),
          'command registry readiness',
          20_000,
        );
        if (screen.includes('Memory Usage')) break;
      }
      expect(await session.screen()).toContain('Memory Usage');
      expect(
        server.requests.filter(({ body }) => body['stream'] === true),
      ).toHaveLength(0);

      await session.idle(500);
      await session.send(
        isSlash ? '/report-probe' : 'Run the saved report-probe workflow.',
      );
      await session.waitForScreen(
        (screen) => screen.includes(reply),
        'model reply based on the workflow completion, without a follow-up prompt',
        30_000,
      );
      await session.idle(1_000);

      const screen = await session.screen();
      expect(screen).not.toContain('started in the background');
      expect(screen).toContain(testCase.marker);
      if (isSlash) expect(screen).toContain('Run ID: wf_');
      if (isSlash && testCase.status === 'completed') {
        expect(screen).toContain('Reported failed:');
        expect(screen).toContain('fr');
      }
      const requests = server.requests.filter(
        ({ body }) => body['stream'] === true,
      );
      expect(requests).toHaveLength(isSlash ? 1 : 2);
      const messages = JSON.stringify(requests.at(-1)!.body['messages']);
      if (isSlash)
        expect(messages).toContain(`<status>${testCase.status}</status>`);
      expect(messages.match(/<kind>workflow<\/kind>/g) ?? []).toHaveLength(
        isSlash ? 1 : 0,
      );
      expect(messages).toContain(testCase.marker);
      if (isSlash && testCase.status === 'completed') {
        expect(messages).toContain('&quot;failed&quot;:[&quot;fr&quot;]');
      }

      await session.idle(500);
      await session.send('What did that workflow return?');
      await session.waitForScreen(
        (text) => text.includes(`${reply}_FOLLOWUP`),
        'follow-up result',
        30_000,
      );
      await session.idle(1_000);
      const followUpRequests = server.requests.filter(
        ({ body }) => body['stream'] === true,
      );
      expect(followUpRequests).toHaveLength(isSlash ? 2 : 3);
      const followUp = JSON.stringify(
        followUpRequests.at(-1)!.body['messages'],
      );
      expect(followUp).toContain(testCase.marker);
      expect(followUp.match(/<kind>workflow<\/kind>/g) ?? []).toHaveLength(
        isSlash ? 1 : 0,
      );
    });
  },
);
