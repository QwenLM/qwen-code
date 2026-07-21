/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E test for the Ctrl+F model toggle hotkey.
 *
 * Sends a raw Ctrl+F byte (0x06) through the PTY — the same byte
 * a non-kitty PTY would send for Ctrl+F — and asserts the "Switched
 * to" message appears in the TUI output.
 *
 * NOTE: PTY-based interactive tests don't work on Windows (node-pty
 * limitation). Skipped via IS_WINDOWS guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig } from '../test-helper.js';

const IS_WINDOWS = process.platform === 'win32';

(IS_WINDOWS ? describe.skip : describe)('model toggle hotkey', () => {
  let rig: TestRig;
  let savedLang: string | undefined;

  beforeEach(async () => {
    // Save original value so afterEach can restore it.
    savedLang = process.env['QWEN_CODE_LANG'];
    // Pre-seed locale so waitForText('Type your message') is stable
    // regardless of the host's locale settings.
    process.env['QWEN_CODE_LANG'] = 'en';

    rig = new TestRig();
    await rig.setup('model-toggle-hotkey-e2e', {
      settings: {
        generation: {
          authType: 'gemini',
          apiKey: 'test-api-key',
        },
        model: {
          name: 'model-a',
          toggleModel: 'model-b',
        },
        modelProviders: {
          gemini: [{ id: 'model-a' }, { id: 'model-b' }],
        },
      },
    });
  });

  afterEach(async () => {
    // Restore original value instead of blindly deleting.
    if (savedLang !== undefined) {
      process.env['QWEN_CODE_LANG'] = savedLang;
    } else {
      delete process.env['QWEN_CODE_LANG'];
    }
    await rig.cleanup();
  });

  it('should toggle model on Ctrl+F and show Switched to message', async () => {
    const { ptyProcess, promise } = rig.runInteractive();

    let output = '';
    ptyProcess.onData((data) => {
      output += data;
    });

    // If the CLI exits early (crash, OOM), surface the exit code in the
    // failure message instead of a generic waitForText timeout.
    let earlyExit: string | null = null;
    void promise.then(({ exitCode, output: exitOutput }) => {
      earlyExit = `CLI exited with code ${exitCode}. Last output:\n${exitOutput.slice(-500)}`;
    });

    // Wait for CLI to be ready
    const isReady = await rig.waitForText('Type your message', 30000);
    expect(isReady, earlyExit ?? 'CLI did not start in interactive mode').toBe(
      true,
    );

    // Raw Ctrl+F byte (0x06). In a PTY without kitty-protocol
    // negotiation this is what the terminal sends for Ctrl+F;
    // Ink decodes it as Key({ctrl: true, name: 'f'}).
    const CTRL_F = '\x06';

    // Toggle to toggleModel (model-b) and wait for the info message
    ptyProcess.write(CTRL_F);
    const switchedToModelB = await rig.waitForText(
      'Switched to model-b',
      10000,
    );
    expect(
      switchedToModelB,
      earlyExit ??
        `Expected 'Switched to model-b' after first toggle. Output:\n${output}`,
    ).toBe(true);

    // Toggle back to original model (model-a)
    ptyProcess.write(CTRL_F);
    const switchedToModelA = await rig.waitForText(
      'Switched to model-a',
      10000,
    );
    expect(
      switchedToModelA,
      earlyExit ??
        `Expected 'Switched to model-a' after second toggle. Output:\n${output}`,
    ).toBe(true);
  });
});
