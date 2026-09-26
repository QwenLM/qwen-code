/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { SessionEndReason } from '@qwen-code/qwen-code-core/hooks/types.js';
import { PRIVATE_ACP_CAPABILITY_ENV } from '@qwen-code/qwen-code-core/utils/invocation-context.js';
import type { ShellConfiguration } from '@qwen-code/qwen-code-core/utils/shell-utils.js';
import {
  createInMemoryChannel,
  type AcpChannel,
  type ChannelFactory,
} from '@qwen-code/acp-bridge';
import { AcpChannelTeardownError } from '@qwen-code/acp-bridge/channel';
import {
  markChannelFactoryForwardsChildEnv,
  scrubChildEnv,
} from '@qwen-code/acp-bridge/spawnChannel';
import {
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
  EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE,
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV,
} from '@qwen-code/acp-bridge/externalToolGuard';
import {
  AcpAgentHostStartupCleanupError,
  createAcpAgentHost,
  type AcpAgentHost,
} from '../acp-integration/acpAgent.js';
import {
  buildDisabledSkillNamesProvider,
  loadCliConfig,
  type CliArgs,
} from '../config/config.js';
import { readSettingsSnapshot } from '../config/settings.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';
import type { ManagedRuntimeProvider } from './managed-runtime-provider.js';
import { createManagedToolSessionFactory } from './managed-tool-session.js';

const HOST_PRIVATE_ENV_KEYS = new Set([
  'QWEN_SERVER_TOKEN',
  'QWEN_RUNTIME_BROKER_TOKEN',
  'QWEN_CODE_SIMPLE',
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  PRIVATE_ACP_CAPABILITY_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV,
]);

export interface ManagedAgentChannelFactoryOptions {
  workspaceCwd: string;
  sessionRuntimeBaseDir: string;
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
  workspaceTrusted: boolean;
  generationGuard: WorkspaceGenerationGuard;
  argv: CliArgs;
  toolRuntime?: {
    resolveProvider: () => ManagedRuntimeProvider | undefined;
    tenantId: string;
    workspaceId: string;
    shellConfiguration: ShellConfiguration;
    platform: NodeJS.Platform;
  };
}

export function createManagedAgentChannelFactory(
  options: ManagedAgentChannelFactoryOptions,
): ChannelFactory {
  const {
    workspaceCwd,
    sessionRuntimeBaseDir,
    workspaceTrusted,
    generationGuard,
  } = options;
  const sourceEnv = Object.freeze({ ...options.runtimeEnvironment });
  const sourceArgv = structuredClone(options.argv);
  const toolRuntime = options.toolRuntime
    ? {
        ...options.toolRuntime,
        shellConfiguration: structuredClone(
          options.toolRuntime.shellConfiguration,
        ),
      }
    : undefined;
  const createManagedTools = () => {
    if (!toolRuntime) return undefined;
    const provider = toolRuntime.resolveProvider();
    if (!provider) {
      throw new Error('Managed Agent channels require a tool Runtime.');
    }
    return createManagedToolSessionFactory({
      ...toolRuntime,
      provider,
      workspaceCwd,
      workspaceTrusted,
      generationGuard,
    });
  };

  const createChannel = async (
    requestedCwd: string,
    childEnvOverrides: Readonly<Record<string, string | undefined>> | undefined,
    resolveTeardown: () => void,
    rejectTeardown: (error: AcpChannelTeardownError) => void,
  ): Promise<AcpChannel> => {
    generationGuard.assertOpen();
    const overrides = { ...childEnvOverrides };
    const privateParentCapability = overrides[PRIVATE_ACP_CAPABILITY_ENV];
    if (!privateParentCapability) {
      throw new Error('Managed Agent channels require a private ACP parent.');
    }
    const [cwd, requested] = await Promise.all([
      realpath(workspaceCwd),
      realpath(requestedCwd),
    ]);
    generationGuard.assertOpen();
    if (requested !== cwd) {
      throw new Error('Managed Agent channel workspace does not match.');
    }
    const argv: CliArgs = {
      ...structuredClone(sourceArgv),
      acp: true,
      sessionId: randomUUID(),
      sessionIdGenerated: true,
      resume: undefined,
      continue: false,
      sandboxSessionId: undefined,
    };
    const runtimeEnvironment = Object.freeze({
      ...scrubChildEnv(sourceEnv, HOST_PRIVATE_ENV_KEYS, overrides),
      QWEN_CODE_SERVE: '1',
      QWEN_CODE_NO_RELAUNCH: 'true',
      ...(argv.insecure ? { QWEN_TLS_INSECURE: '1' } : {}),
    });
    const pair = createInMemoryChannel();
    let host: AcpAgentHost | undefined;
    let cleanup: Promise<void> | undefined;
    let resolveFailure!: (reason: unknown) => void;
    const transportFailed = new Promise<unknown>((resolve) => {
      resolveFailure = resolve;
    });
    let resolveExit!: (value: undefined) => void;
    const exited = new Promise<undefined>((resolve) => {
      resolveExit = resolve;
    });
    const abortTransport = (reason: unknown) => {
      resolveFailure(reason);
      pair.abort(reason);
    };
    const kill = (reason: unknown): Promise<void> => {
      abortTransport(reason);
      generationGuard.signal.removeEventListener('abort', onGenerationClosed);
      cleanup ??= host!.dispose(SessionEndReason.Other).then(
        () => {
          resolveExit(undefined);
          resolveTeardown();
        },
        (error: unknown) => {
          rejectTeardown(new AcpChannelTeardownError(error));
          throw error;
        },
      );
      // Unexpected EOF and synchronous exit cannot await, but shutdown must
      // still observe the original rejection and must not claim an exit.
      void cleanup.catch(() => {});
      return cleanup;
    };
    const onGenerationClosed = () => {
      const reason = generationGuard.signal.reason;
      if (host) void kill(reason);
      else abortTransport(reason);
    };
    generationGuard.signal.addEventListener('abort', onGenerationClosed, {
      once: true,
    });

    return Storage.runWithResolvedRuntimeBaseDir(
      sessionRuntimeBaseDir,
      async () => {
        let config: Config | undefined;
        let hostOwnsConfig = false;
        try {
          generationGuard.assertOpen();
          const settings = readSettingsSnapshot(cwd, {
            runtimeEnvironment,
            workspaceTrusted,
          });
          const managedToolSessionFactory = createManagedTools();
          config = await loadCliConfig(
            managedToolSessionFactory
              ? {
                  ...settings.merged,
                  experimental: {
                    ...settings.merged.experimental,
                    sessionWriterLease: true,
                  },
                }
              : settings.merged,
            argv,
            cwd,
            undefined,
            {
              userHooks: settings.getUserHooks(),
              projectHooks: settings.getProjectHooks(),
            },
            buildDisabledSkillNamesProvider(settings),
            undefined,
            undefined,
            true,
            { runtimeEnvironment, workspaceTrusted, managedToolSessionFactory },
          );
          generationGuard.assertOpen();
          hostOwnsConfig = true;
          host = await createAcpAgentHost(
            config,
            settings,
            argv,
            () => {
              generationGuard.assertOpen();
              return pair.agentStream;
            },
            {
              runtimeEnvironment,
              managedToolSessionFactory,
              privateParentCapability,
              externalToolGuardRequired:
                overrides[PRIVATE_EXTERNAL_TOOL_GUARD_ENV] ===
                EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
              externalToolGuardProviderAttached:
                overrides[PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV] ===
                EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE,
            },
          );
          generationGuard.assertOpen();
          void host.connection.closed.then(() => {
            void kill(new Error('Managed Agent ACP connection closed.'));
          });
          return {
            stream: pair.clientStream,
            transportFailed,
            exited,
            kill: () => kill(new Error('Managed Agent channel stopped.')),
            killSync: () => {
              void kill(new Error('Managed Agent channel force stopped.'));
            },
          } satisfies AcpChannel;
        } catch (error) {
          abortTransport(error);
          generationGuard.signal.removeEventListener(
            'abort',
            onGenerationClosed,
          );
          try {
            if (host) await kill(error);
            else if (config && !hostOwnsConfig) {
              await config.shutdown({
                shutdownTelemetry: false,
                strictResourceCleanup: true,
              });
            }
          } catch (cleanupError) {
            throw new AcpChannelTeardownError(
              new AggregateError(
                [error, cleanupError],
                'Managed Agent channel startup cleanup failed.',
              ),
            );
          }
          if (error instanceof AcpAgentHostStartupCleanupError) {
            throw new AcpChannelTeardownError(error);
          }
          throw error;
        }
      },
    );
  };

  let previousTeardown = Promise.resolve();
  const factory: ChannelFactory = (cwd, overrides) => {
    const environmentOverrides = { ...overrides };
    const previous = previousTeardown;
    let resolveTeardown!: () => void;
    let rejectTeardown!: (error: AcpChannelTeardownError) => void;
    previousTeardown = new Promise<void>((resolve, reject) => {
      resolveTeardown = resolve;
      rejectTeardown = reject;
    });
    void previousTeardown.catch(() => {});
    return previous
      .then(() =>
        createChannel(
          cwd,
          environmentOverrides,
          resolveTeardown,
          rejectTeardown,
        ),
      )
      .catch((error: unknown) => {
        if (error instanceof AcpChannelTeardownError) rejectTeardown(error);
        else resolveTeardown();
        throw error;
      });
  };
  markChannelFactoryForwardsChildEnv(factory);
  return factory;
}
