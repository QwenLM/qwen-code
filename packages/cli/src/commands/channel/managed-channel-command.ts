/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { HttpManagedChannelControlPlane } from './managed-channel-client.js';
import {
  loadChannelsConfig,
  parseConfiguredChannels,
  type ParsedChannel,
} from './runtime.js';

// #17173 R1-16: the managed email and DingTalk commands were near-verbatim
// copies. This holds the shared argument surface, control-plane wiring and
// connect → wait-for-signal → disconnect lifecycle; each provider supplies only
// its adapter factory and its user-facing strings.

export interface ManagedChannelArgs {
  name: string;
  'control-plane': string;
  tenant: string;
  actor: string;
  workspace: string;
  'channel-id'?: string;
  'cwd-relative': string;
  cwd: string;
}

/** The lifecycle surface every managed adapter exposes to the command. */
export interface ManagedChannelRuntime {
  readonly generation: number | undefined;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ManagedChannelCommandSpec {
  /** The yargs command string, e.g. 'managed-dingtalk <name>'. */
  command: string;
  /** The configured channel type this command serves. */
  adapterType: 'email' | 'dingtalk' | 'github';
  /** Display label used in the type-refusal and running messages. */
  label: string;
  nameDescribe: string;
  cwdDescribe: string;
  /**
   * Builds the provider adapter. `cwd` is the raw `--cwd` argument (the proxy
   * resolution reads it), distinct from the resolved `channel.config.cwd`.
   */
  createAdapter: (
    channel: ParsedChannel,
    controlPlane: HttpManagedChannelControlPlane,
    cwd: string,
  ) => ManagedChannelRuntime;
}

export function createManagedChannelCommand(
  spec: ManagedChannelCommandSpec,
): CommandModule<unknown, ManagedChannelArgs> {
  return {
    command: spec.command,
    describe: false,
    builder: (yargs) =>
      yargs
        .positional('name', {
          type: 'string',
          demandOption: true,
          describe: spec.nameDescribe,
        })
        .option('control-plane', {
          type: 'string',
          demandOption: true,
          description:
            'Internal listener base URL of the managed control plane',
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
        })
        .option('cwd', {
          type: 'string',
          default: process.cwd(),
          description: spec.cwdDescribe,
        }),
    handler: async (argv) => {
      const [channel] = await parseConfiguredChannels(
        loadChannelsConfig(argv.cwd),
        [argv.name],
        { defaultCwd: argv.cwd },
      );
      if (channel?.config['type'] !== spec.adapterType) {
        const article = /^[aeiou]/i.test(spec.label) ? 'an' : 'a';
        throw new Error(
          `Channel "${argv.name}" is not ${article} ${spec.label} channel; the managed path serves ${spec.label} only.`,
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
      const adapter = spec.createAdapter(channel, controlPlane, argv.cwd);
      await adapter.connect();
      writeStderrLine(
        `Managed ${spec.label} channel "${channel.name}" is running (generation ${adapter.generation}).`,
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
}
