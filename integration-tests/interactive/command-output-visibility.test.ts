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
import { InteractiveSession } from './interactive-session.js';

/**
 * A field label only `/about` renders, and one both renderers spell the same:
 * they read the same field table, ink lays the label out in its own column and
 * the OpenTUI transcript row prefixes the value with it.
 */
const ABOUT_FIELD = 'Memory Usage';

/** What ink prints when `/about` reaches it before its registry has loaded. */
const ABOUT_UNKNOWN = 'Unknown command: /about';

/**
 * Re-send `/about` until its row reaches the screen.
 *
 * ink loads the slash-command registry asynchronously and gates nothing on it
 * (slashCommandProcessor.ts:759), so a command typed the moment the prompt
 * appears can land on an empty registry and print `ABOUT_UNKNOWN`. OpenTUI
 * reloads the registry and re-parses whenever nothing matched
 * (commands-dispatch.ts:471), so the same send renders the row there — and the
 * ink leg loses the race on every attempt once a parallel spec file is booting
 * a second CLI. The retry keeps this a test of the transcript row rather than
 * of ink's boot ordering.
 *
 * Bounded, so a row that never renders still fails: a projection regression
 * produces neither string, `waitForScreen` throws, and the throw leaves the
 * loop instead of spinning it.
 */
async function sendAboutUntilRendered(
  session: InteractiveSession,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    await session.send('/about');
    const screen = await session.waitForScreen(
      (s) => s.includes(ABOUT_FIELD) || s.includes(ABOUT_UNKNOWN),
      `neither the /about row ("${ABOUT_FIELD}") nor "${ABOUT_UNKNOWN}" reached the screen`,
      20_000,
    );
    if (screen.includes(ABOUT_FIELD)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `the /about transcript row ("${ABOUT_FIELD}") never reached the screen: ` +
          `ink still reported "${ABOUT_UNKNOWN}" at the end of the retry window.\n` +
          `Screen (last 600):\n${screen.slice(-600)}`,
      );
    }
  }
}

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
