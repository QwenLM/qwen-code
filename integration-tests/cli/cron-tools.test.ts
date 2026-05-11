/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  TestRig,
  printDebugInfo,
  validateModelOutput,
} from '../test-helper.js';

const IS_SANDBOX =
  process.env['QWEN_SANDBOX'] &&
  process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false';

describe('cron-tools', () => {
  let rig: TestRig;

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
    // Clean up env vars
    delete process.env['QWEN_CODE_ENABLE_CRON'];
  });

  it('should have cron tools registered when enabled via settings', async () => {
    rig = new TestRig();
    await rig.setup('cron-tools-registered', {
      settings: { experimental: { cron: true } },
    });

    const result = await rig.run(
      'Do you have access to tools called cron_create, cron_list, and cron_delete? Reply with just "yes" or "no".',
    );

    validateModelOutput(result, null, 'cron tools registered');
    expect(result.toLowerCase()).toContain('yes');
  });

  // Env vars set in the test process are not forwarded into Docker containers,
  // so this test cannot pass in sandbox mode.
  (IS_SANDBOX ? it.skip : it)(
    'should have cron tools registered when enabled via env var',
    async () => {
      rig = new TestRig();
      await rig.setup('cron-tools-env-var');

      process.env['QWEN_CODE_ENABLE_CRON'] = '1';

      const result = await rig.run(
        'Do you have access to tools called cron_create, cron_list, and cron_delete? Reply with just "yes" or "no".',
      );

      validateModelOutput(result, null, 'cron tools via env var');
      expect(result.toLowerCase()).toContain('yes');
    },
  );

  it('should NOT have cron tools by default', async () => {
    rig = new TestRig();
    await rig.setup('cron-tools-disabled-by-default');

    const result = await rig.run(
      'Try to create a cron job with cron_create using cron "*/5 * * * *", prompt "disabled test", and recurring true. If you cannot call that tool, say so briefly.',
    );

    validateModelOutput(result, null, 'cron disabled by default');
    const toolLogs = rig.readToolLogs();
    expect(
      toolLogs.some((log) => log.toolRequest.name === 'cron_create'),
      'cron_create should not be callable when cron is disabled',
    ).toBe(false);
  });

  it('should create, list, and delete a cron job in a single turn', async () => {
    rig = new TestRig();
    await rig.setup('cron-create-list-delete', {
      settings: { experimental: { cron: true } },
    });

    const result = await rig.run(
      'Call cron_create with cron "*/5 * * * *", prompt "test ping", recurring true. Then call cron_list. Then delete that job using cron_delete. Then call cron_list again. How many jobs remain? Reply with just the number.',
    );

    const foundCreate = await rig.waitForToolCall('cron_create');
    const foundList = await rig.waitForToolCall('cron_list');
    const foundDelete = await rig.waitForToolCall('cron_delete');

    if (!foundCreate || !foundList || !foundDelete) {
      printDebugInfo(rig, result, {
        'cron_create found': foundCreate,
        'cron_list found': foundList,
        'cron_delete found': foundDelete,
      });
    }

    expect(foundCreate, 'Expected cron_create tool call').toBeTruthy();
    expect(foundList, 'Expected cron_list tool call').toBeTruthy();
    expect(foundDelete, 'Expected cron_delete tool call').toBeTruthy();

    validateModelOutput(result, '0', 'cron create-list-delete');
  });

  it('should create a one-shot (non-recurring) job', async () => {
    rig = new TestRig();
    await rig.setup('cron-one-shot', {
      settings: { experimental: { cron: true } },
    });

    const result = await rig.run(
      'Do these steps: (1) Call cron_create with cron "*/5 * * * *", prompt "one-shot test", recurring false. (2) Call cron_list. Is the job marked as recurring or one-shot? Remember the answer. (3) Delete all cron jobs. Reply with just "recurring" or "one-shot".',
    );

    const foundCreate = await rig.waitForToolCall('cron_create');
    const foundList = await rig.waitForToolCall('cron_list');

    if (!foundCreate || !foundList) {
      printDebugInfo(rig, result, {
        'cron_create found': foundCreate,
        'cron_list found': foundList,
      });
    }

    expect(foundCreate, 'Expected cron_create tool call').toBeTruthy();
    expect(foundList, 'Expected cron_list tool call').toBeTruthy();

    validateModelOutput(result, 'one-shot', 'cron one-shot');
  });

  it('should exit normally in -p mode when no cron jobs are created', async () => {
    rig = new TestRig();
    await rig.setup('cron-no-jobs-exit', {
      settings: { experimental: { cron: true } },
    });

    // A normal -p call without cron should still exit quickly
    const result = await rig.run('What is 2+2? Reply with just the number.');

    validateModelOutput(result, '4', 'no cron exit');
  });
});
