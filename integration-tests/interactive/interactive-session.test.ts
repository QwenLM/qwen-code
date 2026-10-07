/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractiveSession } from './interactive-session.js';

// #13552's CI failure was the ready-prompt wait in InteractiveSession.start
// dying at 30s while the sandbox:docker leg's container was still booting —
// `Timeout (30000ms) waiting for text: "Type your message"` on all three
// retries. A stub CLI whose first prompt output lands past the old cap pins
// the widened self-hosted budget.
const PROMPT_DELAY_MS = 35_000;
const DELAYED_PROMPT_SCRIPT = `setTimeout(
  () => console.log('Type your message'),
  ${PROMPT_DELAY_MS},
);
setTimeout(() => {}, 120_000);`;

const delayedPromptCommand = {
  bin: process.execPath,
  args: ['-e', DELAYED_PROMPT_SCRIPT],
};

describe('InteractiveSession.start ready-prompt budget', () => {
  let session: InteractiveSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.unstubAllEnvs();
  });

  it('lets a self-hosted runner wait past the old 30s cap', async () => {
    vi.stubEnv('RUNNER_ENVIRONMENT', 'self-hosted');
    session = await InteractiveSession.start({
      command: delayedPromptCommand,
    });
    expect(session).toBeInstanceOf(InteractiveSession);
  });

  it('keeps the tight 30s signal everywhere else', async () => {
    vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted');
    // Capture through a side variable: an unexpected resolve must not put the
    // session object itself into the assertion error — it does not survive
    // vitest's RPC serialization — but the leaked session still needs close().
    let started: InteractiveSession | undefined;
    await expect(
      InteractiveSession.start({ command: delayedPromptCommand }).then((s) => {
        started = s;
      }),
    ).rejects.toThrow(
      'Timeout (30000ms) waiting for text: "Type your message"',
    );
    session = started;
  });
});
