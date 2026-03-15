/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpTestRig } from './test-helper.js';
import type {
  AvailableCommand,
  AvailableCommandsUpdate,
} from '@agentclientprotocol/sdk';
import { setTimeout as delay } from 'node:timers/promises';

describe('slash commands', () => {
  let rig: AcpTestRig;

  beforeEach(async () => {
    rig = new AcpTestRig();
  });

  afterEach(async () => {
    await rig.disconnect();
    await rig.cleanup();
  });

  describe('available commands', () => {
    it('should receive available_commands_update after session creation', async () => {
      await rig.setup('slash-commands-available', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Wait for available_commands_update to be received
      await delay(1000);

      // Check session updates for available_commands_update
      const commandsUpdate = rig.sessionUpdates.find(
        (update) =>
          update.update?.sessionUpdate === 'available_commands_update',
      );

      expect(commandsUpdate).toBeDefined();
      const updateData = commandsUpdate?.update as
        | AvailableCommandsUpdate
        | undefined;
      expect(updateData?.availableCommands).toBeDefined();
      expect(Array.isArray(updateData?.availableCommands)).toBe(true);
    });

    it('should include init command in available commands', async () => {
      await rig.setup('slash-command-init', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await delay(1000);

      const commandsUpdate = rig.sessionUpdates.find(
        (update) =>
          update.update?.sessionUpdate === 'available_commands_update',
      );

      const updateData = commandsUpdate?.update as
        | AvailableCommandsUpdate
        | undefined;
      const initCommand = updateData?.availableCommands?.find(
        (cmd: AvailableCommand) => cmd.name === 'init',
      );

      expect(initCommand).toBeDefined();
      expect(initCommand?.description).toBeTruthy();
    });

    it('should wait for commands update using waitForSessionUpdate', async () => {
      await rig.setup('slash-commands-wait', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      const update = await rig.waitForSessionUpdate(
        'available_commands_update',
        5000,
      );

      expect(update).toBeDefined();
      const updateData = update.update as AvailableCommandsUpdate | undefined;
      expect(updateData?.availableCommands).toBeDefined();
    });
  });
});
