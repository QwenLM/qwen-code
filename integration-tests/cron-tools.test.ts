/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestRig, printDebugInfo, validateModelOutput } from './test-helper.js';

describe('cron-tools', () => {
  let rig: TestRig;

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
    // Clean up env var if set by disable test
    delete process.env['QWEN_CODE_DISABLE_CRON'];
  });

  it('should have cron tools registered', async () => {
    rig = new TestRig();
    await rig.setup('cron-tools-registered');

    const result = await rig.run(
      'Do you have access to tools called cron_create, cron_list, and cron_delete? Reply with just "yes" or "no".',
    );

    validateModelOutput(result, null, 'cron tools registered');
    expect(result.toLowerCase()).toContain('yes');
  });

  it('should create, list, and delete a cron job in a single turn', async () => {
    rig = new TestRig();
    await rig.setup('cron-create-list-delete');

    const result = await rig.run(
      'Call cron_create with cron_expression "*/5 * * * *", prompt "test ping", recurring true. Then call cron_list. Then delete that job using cron_delete. Then call cron_list again. How many jobs remain? Reply with just the number.',
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
    await rig.setup('cron-one-shot');

    const result = await rig.run(
      'Do these steps: (1) Call cron_create with cron_expression "*/5 * * * *", prompt "one-shot test", recurring false. (2) Call cron_list. Is the job marked as recurring or one-shot? Remember the answer. (3) Delete all cron jobs. Reply with just "recurring" or "one-shot".',
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

  it('should not have cron tools when QWEN_CODE_DISABLE_CRON=1', async () => {
    rig = new TestRig();
    await rig.setup('cron-disable-flag');

    process.env['QWEN_CODE_DISABLE_CRON'] = '1';

    const result = await rig.run(
      'Do you have access to a tool called cron_create? Reply with just "yes" or "no".',
    );

    validateModelOutput(result, null, 'cron disable flag');
    expect(result.toLowerCase()).toContain('no');
  });

  it('should exit normally in -p mode when no cron jobs are created', async () => {
    rig = new TestRig();
    await rig.setup('cron-no-jobs-exit');

    // A normal -p call without cron should still exit quickly
    const result = await rig.run('What is 2+2? Reply with just the number.');

    validateModelOutput(result, '4', 'no cron exit');
  });
});
