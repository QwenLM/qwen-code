/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
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

describe('DW03: headless prompts remain unknown', () => {
  let rig: TestRig;
  let server: FakeOpenAIServer;
  let restoreProxy: () => void;

  beforeEach(async () => {
    restoreProxy = applyContainerSandboxNoProxy();
    rig = new TestRig();
    await rig.setup('dw03-headless');
    rig.mkdir('home');
    rig.createFile(
      'home/settings.json',
      JSON.stringify({
        tools: { workflowsEnabled: true },
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
    server = await startFakeOpenAIServer(
      () => ({ content: 'DW03_HEADLESS_DONE' }),
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

  const assertNoNotice = () => {
    const requests = server.requests.filter(
      ({ body }) => body['stream'] === true,
    );
    expect(requests).toHaveLength(1);
    const body = JSON.stringify(requests[0].body['messages']);
    expect(body).toContain('workflow ultracode');
    expect(body).not.toContain("The user's message includes the");
    expect(JSON.stringify(requests[0].body['tools'])).toContain('workflow');
  };

  it.each(['text', 'json', 'stream-json'])(
    'does not infer human from -p or output format %s',
    async (format) => {
      const output = await rig.run(
        'workflow ultracode: inspect',
        '--output-format',
        format,
        '--auth-type',
        'openai',
        '--model',
        'fake-model',
      );
      expect(output).toContain('DW03_HEADLESS_DONE');
      assertNoNotice();
    },
    45_000,
  );

  it('does not infer human from plain stdin', async () => {
    const output = await rig.run(
      { stdin: 'workflow ultracode: inspect\n' },
      '--auth-type',
      'openai',
      '--model',
      'fake-model',
    );
    expect(output).toContain('DW03_HEADLESS_DONE');
    assertNoNotice();
  }, 45_000);
});
