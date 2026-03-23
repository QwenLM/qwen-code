/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpTestRig } from './test-helper.js';

describe('acp flag backward compatibility', () => {
  let rig: AcpTestRig;

  beforeEach(async () => {
    rig = new AcpTestRig();
  });

  afterEach(async () => {
    await rig.disconnect();
    await rig.cleanup();
  });

  it('should work with deprecated --experimental-acp flag and show warning', async () => {
    await rig.setup('compat-old-flag', {
      clientOptions: { autoApprove: true },
    });
    await rig.connect({ useNewFlag: false });

    const initResult = await rig.initialize({
      fs: { readTextFile: true, writeTextFile: true },
    });
    expect(initResult).toBeDefined();

    // Verify deprecation warning is shown
    const stderrOutput = rig.getStderr();
    expect(stderrOutput).toContain('--experimental-acp is deprecated');
    expect(stderrOutput).toContain('Please use --acp instead');

    await rig.authenticate('openai');

    const newSession = await rig.newSession();
    expect(newSession.sessionId).toBeTruthy();

    // Verify functionality still works
    const promptResult = await rig.prompt([
      {
        type: 'text',
        text: 'Say hello.',
      },
    ]);
    expect(promptResult).toBeDefined();
  });

  it('should work with new --acp flag without warnings', async () => {
    await rig.setup('compat-new-flag', {
      clientOptions: { autoApprove: true },
    });
    await rig.connect({ useNewFlag: true });

    const initResult = await rig.initialize({
      fs: { readTextFile: true, writeTextFile: true },
    });
    expect(initResult).toBeDefined();

    // Verify no deprecation warning is shown
    const stderrOutput = rig.getStderr();
    expect(stderrOutput).not.toContain('--experimental-acp is deprecated');

    await rig.authenticate('openai');

    const newSession = await rig.newSession();
    expect(newSession.sessionId).toBeTruthy();

    // Verify functionality works
    const promptResult = await rig.prompt([
      {
        type: 'text',
        text: 'Say hello.',
      },
    ]);
    expect(promptResult).toBeDefined();
  });
});
