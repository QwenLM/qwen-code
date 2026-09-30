/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  applyContainerSandboxNoProxy,
  fakeServerHostOptions,
  TestRig,
} from '../test-helper.js';
import {
  ABOUT_FIELD,
  InteractiveSession,
  sendAboutUntilRendered,
} from './interactive-session.js';

describe('Command output visibility', () => {
  let rig: TestRig;
  let server: FakeOpenAIServer | undefined;
  let session: InteractiveSession | undefined;
  let restoreNoProxy: () => void;

  beforeEach(() => {
    rig = new TestRig();
    restoreNoProxy = applyContainerSandboxNoProxy();
  });

  afterEach(async () => {
    await session?.close();
    session = undefined;
    await server?.close();
    server = undefined;
    restoreNoProxy();
    await rig.cleanup();
  });

  it('puts a slash command transcript row on screen', async () => {
    await rig.setup('command-output-visibility', {
      settings: {
        memory: {
          enableManagedAutoMemory: false,
          enableManagedAutoDream: false,
        },
        ui: {
          enableFollowupSuggestions: false,
        },
        security: {
          auth: {
            selectedType: 'openai',
          },
        },
      },
    });
    server = await startFakeOpenAIServer(
      () => ({ content: 'VISIBILITY_UNEXPECTED_REQUEST' }),
      fakeServerHostOptions(),
    );
    session = await InteractiveSession.start({
      cwd: rig.testDir!,
      // The readiness string and the field label below are English UI strings,
      // and the session spawns from `process.env` with no per-run override.
      env: { QWEN_CODE_LANG: 'en' },
      args: [
        '--auth-type',
        'openai',
        '--openai-api-key',
        'fake-key',
        '--openai-base-url',
        server.baseUrl,
        '--model',
        'fake-model',
      ],
    });

    // Differential half: without it the wait below could be satisfied by boot
    // output and would prove nothing about the command.
    expect(await session.screen()).not.toContain(ABOUT_FIELD);

    await sendAboutUntilRendered(session);

    // The row came from the command, not from a model turn echoing it.
    expect(server.requests).toHaveLength(0);
  });
});
