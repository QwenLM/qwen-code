/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TestRig,
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
} from '../test-helper.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

describe.each([
  { loop: 'legacy', shared: false },
  { loop: 'shared', shared: true },
])('DW04: persistent headless Workflow mode ($loop)', ({ shared }) => {
  let rig: TestRig;
  let server: FakeOpenAIServer;
  let restoreProxy: () => void;

  beforeEach(async () => {
    restoreProxy = applyContainerSandboxNoProxy();
    rig = new TestRig();
    await rig.setup('dw04-headless');
    rig.mkdir('home');
    rig.createFile(
      'home/settings.json',
      JSON.stringify({
        tools: { workflowsEnabled: true },
        experimental: { unifiedAgentLoop: shared },
        security: { auth: { selectedType: 'openai' } },
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
        model: { skipNextSpeakerCheck: true },
        general: { enableAutoUpdate: false },
        telemetry: { enabled: false },
      }),
    );
    rig.createFile('system.json', '{}');
    vi.stubEnv('QWEN_HOME', join(rig.testDir!, 'home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(rig.testDir!, 'runtime'));
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_SETTINGS_PATH',
      join(rig.testDir!, 'system.json'),
    );
    vi.stubEnv(
      'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
      join(rig.testDir!, 'system.json'),
    );
    vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '0');
    vi.stubEnv('QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP', '0');
    server = await startFakeOpenAIServer(
      () => ({ content: 'DW04_HEADLESS_DONE' }),
      fakeServerHostOptions(),
    );
    vi.stubEnv('OPENAI_API_KEY', 'fake-key');
    vi.stubEnv('OPENAI_BASE_URL', server.baseUrl);
    vi.stubEnv('OPENAI_MODEL', 'fake-model');
    vi.stubEnv('QWEN_MODEL', 'fake-model');
  });

  afterEach(async () => {
    await server?.close();
    await rig?.cleanup();
    vi.unstubAllEnvs();
    restoreProxy();
  });

  const current = () => {
    const requests = server.requests.filter(
      ({ body }) => body['stream'] === true,
    );
    expect(requests).toHaveLength(1);
    const messages = requests[0].body['messages'] as Array<{
      role: string;
      content: unknown;
    }>;
    return JSON.stringify(
      messages.filter((message) => message.role === 'user').at(-1)?.content,
    );
  };
  const args = [
    '--auth-type',
    'openai',
    '--model',
    'fake-model',
    '--chat-recording',
  ];

  it('persists on, resumes it, overrides with off, and resumes saved off', async () => {
    const id = randomUUID();
    await rig.run(
      'DW04_START ordinary input',
      ...args,
      '--session-id',
      id,
      '--workflow-mode',
      'on',
    );
    expect(current()).toContain('Workflow mode is enabled for this session.');
    expect(current()).not.toContain("The user's message includes the");
    server.requests.splice(0);
    await rig.run('DW04_RESUME ordinary input', ...args, '--resume', id);
    expect(current()).toContain('Workflow mode is enabled for this session.');
    server.requests.splice(0);
    await rig.run(
      'DW04_OFF ordinary input',
      ...args,
      '--resume',
      id,
      '--workflow-mode',
      'off',
    );
    expect(current()).toContain('Workflow mode is off for this session.');
    server.requests.splice(0);
    await rig.run('DW04_OFF_RESUME ordinary input', ...args, '--resume', id);
    expect(current()).toContain('Workflow mode is off for this session.');
  }, 150_000);

  it('leaves absent mode off without inventing keyword provenance', async () => {
    await rig.run('DW04_DEFAULT workflow ultracode: inspect', ...args);
    expect(current()).not.toContain('Workflow mode is');
    expect(current()).not.toContain("The user's message includes the");
  }, 45_000);

  it('applies explicit mode to stdin without human provenance', async () => {
    await rig.run(
      { stdin: 'DW04_STDIN inspect\n' },
      ...args,
      '--workflow-mode',
      'on',
    );
    expect(current()).toContain('Workflow mode is enabled for this session.');
  }, 45_000);

  it('rejects unavailable on before any provider request', async () => {
    vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '1');
    await expect(
      rig.run('DW04_UNAVAILABLE inspect', ...args, '--workflow-mode', 'on'),
    ).rejects.toThrow(/unavailable/i);
    expect(server.requests).toHaveLength(0);
  }, 45_000);
});
