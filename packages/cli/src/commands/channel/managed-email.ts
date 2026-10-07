/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  ManagedEmailAdapter,
  createManagedEmailDeps,
} from '@qwen-code/channel-email';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { HttpManagedChannelControlPlane } from './managed-channel-client.js';
import { loadChannelsConfig, parseConfiguredChannels } from './runtime.js';

// H5b/H5c of #12827: the email reference adapter on the managed path. An
// experimental, explicitly selected entry: `qwen channel start` never picks
// it, and it drives no model — it routes inbound mail into bound Sessions
// through the control plane and sends the receipted replies back.

interface ManagedEmailArgs {
  name: string;
  'control-plane': string;
  tenant: string;
  actor: string;
  workspace: string;
  'channel-id'?: string;
  'cwd-relative': string;
}

export const managedEmailCommand: CommandModule<unknown, ManagedEmailArgs> = {
  command: 'managed-email <name>',
  describe: false,
  builder: (yargs) =>
    yargs
      .positional('name', {
        type: 'string',
        demandOption: true,
        describe: 'The configured email channel to run on the managed path',
      })
      .option('control-plane', {
        type: 'string',
        demandOption: true,
        description: 'Internal listener base URL of the managed control plane',
      })
      .option('tenant', {
        type: 'string',
        demandOption: true,
        description: 'Tenant the channel belongs to',
      })
      .option('actor', {
        type: 'string',
        demandOption: true,
        description: 'Actor that owns the Sessions the channel creates',
      })
      .option('workspace', {
        type: 'string',
        demandOption: true,
        description: 'Registered Workspace the channel Sessions bind to',
      })
      .option('channel-id', {
        type: 'string',
        description: 'Channel instance id (defaults to the channel name)',
      })
      .option('cwd-relative', {
        type: 'string',
        default: '.',
        description: 'Relative directory inside the Workspace',
      }),
  handler: async (argv) => {
    const [channel] = await parseConfiguredChannels(loadChannelsConfig(), [
      argv.name,
    ]);
    if (channel?.config['type'] !== 'email') {
      throw new Error(
        `Channel "${argv.name}" is not an email channel; the managed path serves email only.`,
      );
    }
    const controlPlane = new HttpManagedChannelControlPlane({
      baseUrl: argv['control-plane'],
      tenantId: argv.tenant,
      channelId: argv['channel-id'] ?? argv.name,
      actorId: argv.actor,
      workspaceId: argv.workspace,
      cwdRelative: argv['cwd-relative'],
    });
    const adapter = new ManagedEmailAdapter({
      name: channel.name,
      cwd: channel.config.cwd,
      config: channel.config,
      controlPlane,
      deps: createManagedEmailDeps(),
    });
    await adapter.connect();
    writeStderrLine(
      `Managed email channel "${channel.name}" is running (generation ${adapter.generation}).`,
    );
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    await adapter.disconnect();
  },
};
