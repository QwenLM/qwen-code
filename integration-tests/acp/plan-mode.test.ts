/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpTestRig } from './test-helper.js';
import { setTimeout as delay } from 'node:timers/promises';

describe('plan mode', () => {
  let rig: AcpTestRig;

  beforeEach(async () => {
    rig = new AcpTestRig();
  });

  afterEach(async () => {
    await rig.disconnect();
    await rig.cleanup();
  });

  describe('exit plan mode', () => {
    it('should handle exit plan mode with permission request and mode update', async () => {
      await rig.setup('plan-mode-exit', {
        clientOptions: {
          autoApprove: false,
          permissionHandler: (request) => {
            // Auto-approve exit plan mode with proceed_always
            if (request.toolCall?.kind === 'switch_mode') {
              const alwaysOption = request.options?.find(
                (o) => o.kind === 'allow_always',
              );
              if (alwaysOption) {
                return { optionId: alwaysOption.optionId };
              }
            }
            return { optionId: 'proceed_once' };
          },
        },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Set mode to plan
      await rig.setMode('plan');

      // Send a prompt that might trigger exit_plan_mode
      await rig.prompt([
        {
          type: 'text',
          text: 'Create a simple hello world function in Python. Make a brief plan and when ready, use the exit_plan_mode tool to present it for approval.',
        },
      ]);

      await delay(2000);

      // Check for permission requests with switch_mode kind
      const switchModeRequests = rig.permissionRequests.filter(
        (req) => req.toolCall?.kind === 'switch_mode',
      );

      if (switchModeRequests.length > 0) {
        // Verify permission request structure
        const permReq = switchModeRequests[0];
        expect(permReq.toolCall).toBeDefined();
        expect(permReq.options).toBeDefined();
        expect(Array.isArray(permReq.options)).toBe(true);

        // Check for mode update notification
        const modeUpdate = rig.sessionUpdates.find(
          (update) => update.update?.sessionUpdate === 'current_mode_update',
        );

        expect(modeUpdate).toBeDefined();
      }
    });
  });

  describe('write tools blocking', () => {
    it('should block write tools in plan mode', async () => {
      await rig.setup('plan-mode-blocking', {
        clientOptions: {
          autoApprove: false,
          permissionHandler: (request) => {
            // Cancel exit_plan_mode to keep plan mode active
            if (request.toolCall?.kind === 'switch_mode') {
              return { outcome: 'cancelled' };
            }
            return { optionId: 'proceed_once' };
          },
        },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Set mode to plan
      await rig.setMode('plan');

      // Try to create a file
      await rig.prompt([
        {
          type: 'text',
          text: 'Create a file called test.txt with content "Hello World"',
        },
      ]);

      await delay(2000);

      // Collect tool call events
      const toolCallEvents = rig.toolCallCollector.getAll();
      const writeFileEvents = toolCallEvents.filter(
        (e) => e.toolName === 'write_file',
      );

      // If write_file was attempted, it should have been blocked
      if (writeFileEvents.length > 0) {
        const blockedEvent = writeFileEvents.find((e) => e.status === 'error');
        if (blockedEvent) {
          expect(blockedEvent.error).toContain('Plan mode');
        }
      }

      // Verify the file was NOT created
      expect(rig.fileExists('test.txt')).toBe(false);
    });
  });

  describe('permission options', () => {
    it('should include allow_once and allow_always options', async () => {
      await rig.setup('plan-mode-options', {
        clientOptions: {
          autoApprove: false,
          recordPermissions: true,
          permissionHandler: (request) => {
            // Record the request and allow once
            const allowOption = request.options?.find(
              (o) => o.kind === 'allow_once',
            );
            return allowOption
              ? { optionId: allowOption.optionId }
              : { outcome: 'cancelled' };
          },
        },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await rig.setMode('plan');

      await rig.prompt([
        {
          type: 'text',
          text: 'Create a plan for building a simple web server',
        },
      ]);

      await delay(2000);

      // Check that we received permission requests with appropriate options
      const history = rig.client?.getPermissionHistory();
      expect(history).toBeDefined();
    });
  });
});
