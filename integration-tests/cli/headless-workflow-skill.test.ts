/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
  IS_CONTAINER_SANDBOX,
  TestRig,
} from '../test-helper.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

const EXTENSION_NAME = 'workflow-entry-test';
const WORKFLOW_NAME = `${EXTENSION_NAME}:analyze`;
const WHEN_TO_USE = 'When asked to analyze the local sample';
const WORKFLOW_ARGS = { question: 'Inspect the local sample' };
const CALL_ID = 'call-workflow-skill';

type Message = {
  role?: string;
  tool_call_id?: string;
  content?: string | Array<{ text?: string }>;
};

function messageText(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : (message.content?.map((part) => part.text ?? '').join('\n') ?? '');
}

describe('headless extension workflow Skill entry', () => {
  let rig: TestRig;
  let fakeServer: FakeOpenAIServer;

  afterEach(async () => {
    await fakeServer?.close();
    await rig?.cleanup();
    vi.unstubAllEnvs();
  });

  it.each(['text', 'json', 'stream-json'])(
    'exposes and expands a workflow Skill on the first natural-language turn (%s)',
    async (outputFormat) => {
      rig = new TestRig();
      await rig.setup(`headless-workflow-skill-${outputFormat}`);

      const qwenHome = join(rig.testDir!, '.qwen-home');
      const extensionDir = join(qwenHome, 'extensions', EXTENSION_NAME);
      mkdirSync(join(extensionDir, 'workflows'), { recursive: true });
      // workflow 开关仅接受用户等可信设置层，项目设置会被过滤。
      writeFileSync(
        join(qwenHome, 'settings.json'),
        JSON.stringify({
          tools: { workflowsEnabled: true },
          skills: { disabledLevels: ['user', 'project'] },
        }),
      );
      writeFileSync(
        join(extensionDir, 'qwen-extension.json'),
        JSON.stringify({ name: EXTENSION_NAME, version: '1.0.0' }),
      );
      writeFileSync(
        join(extensionDir, 'workflows', 'analyze.js'),
        `export const meta = ${JSON.stringify({
          name: 'analyze',
          description: 'Analyze a local sample',
          whenToUse: WHEN_TO_USE,
        })};\nreturn args;\n`,
      );

      let streamingRequestIndex = 0;
      fakeServer = await startFakeOpenAIServer(({ body }) => {
        if (body['stream'] !== true) {
          return { content: '{"selected_memories":[]}' };
        }
        if (streamingRequestIndex++ === 0) {
          return {
            toolCalls: [
              fakeToolCall(
                'skill',
                { skill: WORKFLOW_NAME, args: JSON.stringify(WORKFLOW_ARGS) },
                CALL_ID,
              ),
            ],
          };
        }
        return { content: 'WORKFLOW_SKILL_PROBE_DONE' };
      }, fakeServerHostOptions());

      const noProxy = IS_CONTAINER_SANDBOX
        ? CONTAINER_SANDBOX_NO_PROXY
        : '127.0.0.1,localhost';
      vi.stubEnv('NO_PROXY', noProxy);
      vi.stubEnv('no_proxy', noProxy);
      vi.stubEnv('QWEN_HOME', qwenHome);
      vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, '.runtime'));
      vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '0');
      vi.stubEnv('OPENAI_API_KEY', 'fake-key');
      vi.stubEnv('OPENAI_BASE_URL', fakeServer.baseUrl);
      vi.stubEnv('OPENAI_MODEL', 'fake-model');
      vi.stubEnv('QWEN_MODEL', 'fake-model');

      // 不预先执行 slash 命令或查询 supported_commands，直接验证自然语言首轮。
      const output = await rig.run(
        'Please analyze the local sample.',
        '--output-format',
        outputFormat,
        '--auth-type',
        'openai',
        '--model',
        'fake-model',
        '--openai-base-url',
        fakeServer.baseUrl,
        '--openai-api-key',
        'fake-key',
        '--max-session-turns',
        '3',
      );

      expect(output).toContain('WORKFLOW_SKILL_PROBE_DONE');
      if (outputFormat !== 'text') {
        const outputMessages = (
          outputFormat === 'json'
            ? JSON.parse(output)
            : output
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
        ) as Array<{
          type: string;
          tools?: string[];
          slash_commands?: string[];
        }>;
        const init = outputMessages.find(
          (message) => message.type === 'system',
        );
        expect(init?.tools).toContain('workflow');
        expect(init?.slash_commands).toContain(WORKFLOW_NAME);
      }
      const requests = fakeServer.requests.filter(
        ({ body }) => body['stream'] === true,
      );
      expect(requests).toHaveLength(2);

      const firstMessages = requests[0].body['messages'] as Message[];
      const availableSkills = firstMessages
        .map(messageText)
        .join('\n')
        .match(/<available_skills>[\s\S]*?<\/available_skills>/g)
        ?.join('\n');
      expect(availableSkills).toContain(WORKFLOW_NAME);
      expect(availableSkills).toContain(WHEN_TO_USE);

      const secondMessages = requests[1].body['messages'] as Message[];
      const skillResult = secondMessages.find(
        (message) =>
          message.role === 'tool' && message.tool_call_id === CALL_ID,
      );
      expect(skillResult).toBeDefined();
      expect(messageText(skillResult!)).toContain(
        `Invoke: Workflow({ name: "${WORKFLOW_NAME}", args: ${JSON.stringify(WORKFLOW_ARGS)} })`,
      );
      expect(messageText(skillResult!)).not.toContain('not found');
    },
    60_000,
  );
});
