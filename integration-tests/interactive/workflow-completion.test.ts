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
import {
  InteractiveSession,
  sendAboutUntilRendered,
} from './interactive-session.js';

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
        source: 'slash',
        status: 'completed',
        // Exceeds the wire cap while keeping interactive rendering bounded.
        script:
          'return { marker: "WORKFLOW_LARGE_RESULT_12176", rows: "&".repeat(30_000), failed: ["fr"] };',
        marker: 'WORKFLOW_LARGE_RESULT_12176',
        largeResult: true,
      },
      {
        source: 'model',
        status: 'completed',
        script:
          'return { marker: "WORKFLOW_MODEL_RESULT_12176", error: new Error("MODEL_ERROR_REASON_12176") };',
        marker: 'WORKFLOW_MODEL_RESULT_12176',
        resultDetails: ['Error: MODEL_ERROR_REASON_12176'],
      },
      {
        source: 'slash',
        status: 'completed',
        script:
          'const error = new Error("WORKFLOW_VM_ERROR_12176"); return { marker: "WORKFLOW_ERROR_RESULT_12176", failed: ["fr"], errors: [error, new Error("AGENT_B_TIMEOUT_12176"), new Error("AGENT_C_OOM_12176")], error };',
        marker: 'WORKFLOW_ERROR_RESULT_12176',
        reportedError: 'WORKFLOW_VM_ERROR_12176',
        resultDetails: [
          'Error: AGENT_B_TIMEOUT_12176',
          'Error: AGENT_C_OOM_12176',
        ],
      },
      {
        source: 'slash',
        status: 'completed',
        script:
          'return { marker: "WORKFLOW_COLLECTION_RESULT_12176", failed: ["fr"], errors: new Map([["agent-map", new Error("MAP_RATE_LIMIT_12176")]]), error: new Set(["SET_TIMEOUT_12176"]) };',
        marker: 'WORKFLOW_COLLECTION_RESULT_12176',
        resultDetails: [
          'agent-map',
          'Error: MAP_RATE_LIMIT_12176',
          'SET_TIMEOUT_12176',
        ],
      },
    ])('delivers $marker once', async (testCase) => {
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

      await sendAboutUntilRendered(session);
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

      let screen = await session.screen();
      if (testCase.largeResult) {
        // Ink's virtualized history only exposes the current viewport, not
        // terminal scrollback. Read preceding pages of the long completion.
        for (
          let page = 0;
          page < 20 &&
          (!screen.includes(testCase.marker) ||
            !screen.includes('Run ID: wf_') ||
            !screen.includes('Reported failed: ["fr"]'));
          page++
        ) {
          session.pressKey('\x1b[5~'); // PageUp
          await session.idle(500);
          screen += `\n${await session.screen()}`;
        }
        session.pressKey('\x1b[1;5F'); // Ctrl+End
        await session.idle(500);
      }
      expect(screen).not.toContain('started in the background');
      expect(screen).toContain(testCase.marker);
      for (const detail of testCase.resultDetails ?? []) {
        expect(screen).toContain(detail);
      }
      if (isSlash) expect(screen).toContain('Run ID: wf_');
      if (isSlash && testCase.status === 'completed') {
        expect(screen).toContain('Reported failed: ["fr"]');
      }
      if (testCase.reportedError) {
        expect(screen).toContain(
          `Reported error: Error: ${testCase.reportedError}`,
        );
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
      if (testCase.reportedError) {
        const reported = messages.match(
          /<reported-failures>([\s\S]*?)<\/reported-failures>/,
        )?.[1];
        expect(reported).toContain(
          `Reported error: Error: ${testCase.reportedError}`,
        );
        expect(reported).not.toContain(' at ');
        expect(reported).not.toContain('Reported errors: [{}]');
      }
      for (const detail of testCase.resultDetails ?? []) {
        const payload = isSlash
          ? messages.match(
              /<reported-failures>([\s\S]*?)<\/reported-failures>/,
            )?.[1]
          : messages;
        expect(payload).toContain(detail);
      }
      if (testCase.largeResult) {
        expect(
          messages.match(/<result>([\s\S]*?)<\/result>/)?.[1].length,
        ).toBeLessThanOrEqual(25_000);
        expect(messages).toContain('<result-truncated>');
        expect(messages).toMatch(/[/\\]workflows[/\\]+wf_[a-f0-9]+\.json/);
        expect(messages).toContain(
          '<reported-failures>Reported failed: [\\"fr\\"]</reported-failures>',
        );
        expect(messages.match(/<result>([\s\S]*?)<\/result>/)?.[1]).not.toMatch(
          /&[^;]*$/,
        );
      } else if (isSlash && testCase.status === 'completed') {
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
      for (const detail of testCase.resultDetails ?? []) {
        const payload = isSlash
          ? followUp.match(
              /<reported-failures>([\s\S]*?)<\/reported-failures>/,
            )?.[1]
          : followUp;
        expect(payload).toContain(detail);
      }
      if (testCase.reportedError) {
        expect(
          followUp.match(
            /<reported-failures>([\s\S]*?)<\/reported-failures>/,
          )?.[1],
        ).toContain(testCase.reportedError);
      }
      if (testCase.largeResult) {
        expect(followUp).toContain('<result-truncated>');
        expect(followUp).toContain(
          '<reported-failures>Reported failed: [\\"fr\\"]</reported-failures>',
        );
      }
      expect(followUp.match(/<kind>workflow<\/kind>/g) ?? []).toHaveLength(
        isSlash ? 1 : 0,
      );
    });
  },
);
