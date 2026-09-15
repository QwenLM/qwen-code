/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { FakeAgent } from '@qwen-code/acp-bridge/internal/testUtils';
import { createAcpSessionBridge } from '@qwen-code/acp-bridge/bridge';
import { AcpChannelTeardownError } from '@qwen-code/acp-bridge/channel';
import { channelFactoryForwardsChildEnv } from '@qwen-code/acp-bridge/spawnChannel';
import {
  PRIVATE_ACP_CAPABILITY_ENV,
  Storage,
  type Config,
} from '@qwen-code/qwen-code-core';
import {
  EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV,
} from '@qwen-code/acp-bridge/externalToolGuard';
import { createAcpAgentHost } from '../acp-integration/acpAgent.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import {
  readSettingsSnapshot,
  type LoadedSettings,
} from '../config/settings.js';
import {
  createManagedAgentChannelFactory,
  type ManagedAgentChannelFactoryOptions,
} from './managed-agent-channel.js';
import type { ManagedRuntimeProvider } from './managed-runtime-provider.js';
import { createWorkspaceGenerationGuard } from './workspace-registry.js';

vi.mock('../acp-integration/acpAgent.js', () => ({
  createAcpAgentHost: vi.fn(),
  AcpAgentHostStartupCleanupError: class extends AggregateError {},
}));
vi.mock('../config/config.js', () => ({
  loadCliConfig: vi.fn(),
  buildDisabledSkillNamesProvider: vi.fn(() => () => new Set()),
}));
vi.mock('../config/settings.js', () => ({ readSettingsSnapshot: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('managed Agent channel', () => {
  let root: string;
  let cwd: string;
  let guard: ReturnType<typeof createWorkspaceGenerationGuard>;
  let closed: ReturnType<typeof deferred<void>>;
  let provider: ManagedRuntimeProvider;
  let toolRuntime: NonNullable<
    ManagedAgentChannelFactoryOptions['toolRuntime']
  >;
  const shutdown = vi.fn<Config['shutdown']>();
  const dispose =
    vi.fn<Awaited<ReturnType<typeof createAcpAgentHost>>['dispose']>();
  const config = { shutdown } as unknown as Config;
  const privateOverrides = {
    [PRIVATE_ACP_CAPABILITY_ENV]: 'synthetic-private-parent',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    shutdown.mockResolvedValue(undefined);
    dispose.mockResolvedValue(undefined);
    root = await realpath(await mkdtemp(join(tmpdir(), 'managed-channel-')));
    cwd = join(root, 'workspace');
    await mkdir(cwd);
    guard = createWorkspaceGenerationGuard();
    closed = deferred<void>();
    provider = {
      getToolV2Client: vi.fn(),
      prepare: vi.fn(),
      cancel: vi.fn(),
      release: vi.fn().mockResolvedValue(true),
      dispose: vi.fn(),
    };
    toolRuntime = {
      resolveProvider: vi.fn(() => provider),
      tenantId: 'tenant',
      workspaceId: 'workspace',
      shellConfiguration: {
        executable: 'bash',
        argsPrefix: ['-c'],
        shell: 'bash',
      },
      platform: 'darwin',
    };
    vi.mocked(readSettingsSnapshot).mockReturnValue({
      merged: {},
      getUserHooks: () => ({}),
      getProjectHooks: () => ({}),
    } as LoadedSettings);
    vi.mocked(loadCliConfig).mockResolvedValue(config);
    vi.mocked(createAcpAgentHost).mockImplementation(
      async (_config, _settings, _argv, createStream) => {
        createStream();
        return {
          connection: { closed: closed.promise } as AgentSideConnection,
          dispose,
          getActiveSessions: () => [],
          isTrustedManagedParent: () => true,
        };
      },
    );
  });

  afterEach(async () => {
    guard.close();
    await rm(root, { recursive: true, force: true });
  });

  function factory(
    environment: NodeJS.ProcessEnv = {},
    argv = {} as CliArgs,
    toolRuntime?: ManagedAgentChannelFactoryOptions['toolRuntime'],
  ) {
    return createManagedAgentChannelFactory({
      workspaceCwd: cwd,
      sessionRuntimeBaseDir: join(root, 'output'),
      runtimeEnvironment: environment,
      workspaceTrusted: false,
      generationGuard: guard,
      argv,
      toolRuntime,
    });
  }

  it('attests that Managed factories forward child env overrides', () => {
    expect(channelFactoryForwardsChildEnv(factory())).toBe(true);
  });

  it('passes the same lazy tool Session producer to bootstrap and actual Session hosts', async () => {
    let availableProvider: ManagedRuntimeProvider | undefined = undefined;
    const resolveProvider = vi.fn(() => availableProvider);
    toolRuntime.resolveProvider = resolveProvider;
    const create = factory({}, {} as CliArgs, toolRuntime);
    expect(resolveProvider).not.toHaveBeenCalled();
    availableProvider = provider;
    toolRuntime.resolveProvider = () => undefined;
    toolRuntime.shellConfiguration.executable = 'changed';
    toolRuntime.shellConfiguration.argsPrefix.push('changed');
    toolRuntime.platform = 'linux';
    const channel = await create(cwd, privateOverrides);
    expect(resolveProvider).toHaveBeenCalledOnce();
    const bootstrap =
      vi.mocked(loadCliConfig).mock.calls[0][9]?.managedToolSessionFactory;
    expect(
      vi.mocked(loadCliConfig).mock.calls[0][0].experimental
        ?.sessionWriterLease,
    ).toBe(true);
    const host =
      vi.mocked(createAcpAgentHost).mock.calls[0][4]?.managedToolSessionFactory;
    expect(bootstrap).toBeTypeOf('function');
    expect(host).toBe(bootstrap);
    const session = host!({
      getTargetDir: () => cwd,
      getWorkspaceContext: () => ({ getDirectories: () => [cwd] }),
      getMemoryBaseDir: () => join(root, 'output'),
      getFileFilteringOptions: () => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
      }),
      isLsToolEnabled: () => false,
      getUseRipgrep: () => true,
      getUseBuiltinRipgrep: () => true,
      getTruncateToolOutputThreshold: () => 25000,
      getTruncateToolOutputLines: () => 1000,
      isTruncateToolOutputThresholdExplicit: () => false,
    } as unknown as Config);
    expect(session.shellConfiguration).toEqual({
      executable: 'bash',
      argsPrefix: ['-c'],
      shell: 'bash',
    });
    expect(session.platform).toBe('darwin');
    await session.close();
    expect(provider.getToolV2Client).not.toHaveBeenCalled();
    await channel.kill();
    await channel.exited;
  });

  it.each(['unavailable', 'incompatible', 'throws'] as const)(
    'refuses a %s Runtime before Config loading and permits retry',
    async (failure) => {
      const resolveProvider = vi.mocked(toolRuntime.resolveProvider);
      if (failure === 'unavailable')
        resolveProvider.mockReturnValueOnce(undefined);
      if (failure === 'incompatible') {
        resolveProvider.mockReturnValueOnce({
          ...provider,
          getToolV2Client: undefined,
        });
      }
      if (failure === 'throws') {
        resolveProvider.mockImplementationOnce(() => {
          throw new Error('Runtime lookup failed.');
        });
      }
      const addListener = vi.spyOn(guard.signal, 'addEventListener');
      const removeListener = vi.spyOn(guard.signal, 'removeEventListener');
      const create = factory({}, {} as CliArgs, toolRuntime);
      await expect(create(cwd, privateOverrides)).rejects.toThrow(
        failure === 'throws' ? 'Runtime lookup failed' : 'tool Runtime',
      );
      expect(loadCliConfig).not.toHaveBeenCalled();
      expect(createAcpAgentHost).not.toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith(
        'abort',
        addListener.mock.calls[0][1],
      );
      const channel = await create(cwd, privateOverrides);
      expect(resolveProvider).toHaveBeenCalledTimes(2);
      expect(createAcpAgentHost).toHaveBeenCalledOnce();
      await channel.kill();
      await channel.exited;
    },
  );

  it('resolves a replacement Runtime only after prior host disposal', async () => {
    const cleanup = deferred<void>();
    dispose.mockReturnValueOnce(cleanup.promise);
    const create = factory({}, {} as CliArgs, toolRuntime);
    const first = await create(cwd, privateOverrides);
    const stopping = first.kill();
    const next = create(cwd, privateOverrides);
    await first.transportFailed;
    expect(toolRuntime.resolveProvider).toHaveBeenCalledOnce();
    const replacementClient = vi.fn();
    const readReplacementClient = vi.fn(() => replacementClient);
    provider = {
      ...provider,
      get getToolV2Client() {
        return readReplacementClient();
      },
    };
    cleanup.resolve();
    await stopping;
    const second = await next;
    expect(toolRuntime.resolveProvider).toHaveBeenCalledTimes(2);
    expect(readReplacementClient).toHaveBeenCalled();
    expect(replacementClient).not.toHaveBeenCalled();
    await second.kill();
    await second.exited;
  });

  it('does not resolve a queued Runtime after generation closure', async () => {
    const cleanup = deferred<void>();
    dispose.mockReturnValueOnce(cleanup.promise);
    const create = factory({}, {} as CliArgs, toolRuntime);
    const first = await create(cwd, privateOverrides);
    const next = create(cwd, privateOverrides);
    void next.catch(() => {});
    guard.close();
    cleanup.resolve();
    await first.exited;
    await expect(next).rejects.toThrow('no longer active');
    expect(toolRuntime.resolveProvider).toHaveBeenCalledOnce();
    expect(createAcpAgentHost).toHaveBeenCalledOnce();
  });

  it('pins copied settings, argv, environment and output while consuming private markers', async () => {
    const ambient = { ...process.env };
    const env = {
      MODEL_KEY: 'workspace-key',
      DROP_KEY: 'old',
      [PRIVATE_ACP_CAPABILITY_ENV]: 'ambient-capability',
      QWEN_SERVER_TOKEN: 'daemon-token',
      [EXTERNAL_TOOL_GUARD_TOKEN_ENV]: 'guard-token',
      QWEN_CODE_SIMPLE: '1',
    };
    const argv = { extensions: ['original'], insecure: true } as CliArgs;
    const create = factory(env, argv);
    env.MODEL_KEY = 'changed';
    argv.extensions!.push('changed');
    let outputRoot: string | undefined;
    vi.mocked(loadCliConfig).mockImplementation(async () => {
      outputRoot = Storage.getRuntimeBaseDir();
      return config;
    });
    const channel = await create(cwd, {
      ...privateOverrides,
      DROP_KEY: undefined,
      QWEN_SERVER_TOKEN: 'cannot-reintroduce',
      [PRIVATE_EXTERNAL_TOOL_GUARD_ENV]: EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
      [PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV]:
        EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE,
    });
    const policy = vi.mocked(loadCliConfig).mock.calls[0][9]!;
    expect(outputRoot).toBe(join(root, 'output'));
    expect(policy.workspaceTrusted).toBe(false);
    expect(policy.runtimeEnvironment).toEqual({
      MODEL_KEY: 'workspace-key',
      QWEN_CODE_SERVE: '1',
      QWEN_CODE_NO_RELAUNCH: 'true',
      QWEN_TLS_INSECURE: '1',
    });
    expect(readSettingsSnapshot).toHaveBeenCalledWith(cwd, {
      runtimeEnvironment: policy.runtimeEnvironment,
      workspaceTrusted: false,
    });
    const hostArgs = vi.mocked(createAcpAgentHost).mock.calls[0];
    expect(hostArgs[2]).toMatchObject({ extensions: ['original'], acp: true });
    expect(hostArgs[4]).toEqual({
      runtimeEnvironment: policy.runtimeEnvironment,
      privateParentCapability: 'synthetic-private-parent',
      externalToolGuardRequired: true,
      externalToolGuardProviderAttached: true,
    });
    expect(process.env).toEqual(ambient);
    await channel.kill();
  });

  it('rejects another workspace and missing private parent before config creation', async () => {
    const other = join(root, 'other');
    await mkdir(other);
    const create = factory({}, {} as CliArgs, toolRuntime);
    await expect(create(other, privateOverrides)).rejects.toThrow('workspace');
    await expect(create(cwd)).rejects.toThrow('private ACP parent');
    expect(loadCliConfig).not.toHaveBeenCalled();
    expect(toolRuntime.resolveProvider).not.toHaveBeenCalled();
  });

  it('rejects a closed generation before config creation', async () => {
    const create = factory({}, {} as CliArgs, toolRuntime);
    guard.close();
    await expect(create(cwd, privateOverrides)).rejects.toThrow(
      'no longer active',
    );
    expect(loadCliConfig).not.toHaveBeenCalled();
    expect(toolRuntime.resolveProvider).not.toHaveBeenCalled();
  });

  it('rejects unreadable settings before creating a Config or ACP host', async () => {
    vi.mocked(readSettingsSnapshot).mockImplementation(() => {
      throw new Error('Settings file contains invalid JSON.');
    });
    await expect(
      factory({}, {} as CliArgs, toolRuntime)(cwd, privateOverrides),
    ).rejects.toThrow('Settings file contains invalid JSON.');
    expect(loadCliConfig).not.toHaveBeenCalled();
    expect(createAcpAgentHost).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(toolRuntime.resolveProvider).not.toHaveBeenCalled();
  });

  it('cleans a Config that finishes loading after generation closure', async () => {
    const loading = deferred<Config>();
    vi.mocked(loadCliConfig).mockReturnValue(loading.promise);
    const pending = factory()(cwd, privateOverrides);
    void pending.catch(() => {});
    await vi.waitFor(() => expect(loadCliConfig).toHaveBeenCalledOnce());
    guard.close();
    loading.resolve(config);
    await expect(pending).rejects.toThrow('no longer active');
    expect(createAcpAgentHost).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledWith({
      shutdownTelemetry: false,
      strictResourceCleanup: true,
    });
  });

  it('retains cleanup failure when generation closes during Config loading', async () => {
    const loading = deferred<Config>();
    vi.mocked(loadCliConfig).mockReturnValue(loading.promise);
    shutdown.mockRejectedValueOnce(new Error('resource still alive'));
    const pending = factory()(cwd, privateOverrides);
    void pending.catch(() => {});
    await vi.waitFor(() => expect(loadCliConfig).toHaveBeenCalledOnce());
    guard.close();
    loading.resolve(config);
    await expect(pending).rejects.toMatchObject({
      cause: {
        errors: [expect.any(Error), new Error('resource still alive')],
      },
    });
  });

  it('keeps factory startup cleanup failure visible to Bridge shutdown', async () => {
    const loading = deferred<Config>();
    vi.mocked(loadCliConfig).mockReturnValue(loading.promise);
    shutdown.mockRejectedValueOnce(new Error('startup resource still alive'));
    const bridge = createAcpSessionBridge({
      boundWorkspace: cwd,
      channelFactory: factory(),
      channelIdleTimeoutMs: 0,
    });
    const starting = bridge.preheat();
    void starting.catch(() => {});
    await vi.waitFor(() => expect(loadCliConfig).toHaveBeenCalledOnce());
    guard.close();
    const stopping = bridge.shutdown();
    void stopping.catch(() => {});
    loading.resolve(config);
    await expect(starting).rejects.toBeInstanceOf(AcpChannelTeardownError);
    await expect(stopping).rejects.toBeInstanceOf(AcpChannelTeardownError);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(createAcpAgentHost).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'awaits a host born during Bridge shutdown, cleanup failure=%s',
    async (fails) => {
      const loading = deferred<Config>();
      vi.mocked(loadCliConfig).mockReturnValue(loading.promise);
      vi.mocked(createAcpAgentHost).mockImplementationOnce(
        async (_config, _settings, _argv, createStream) => ({
          connection: new AgentSideConnection(
            () => new FakeAgent(),
            createStream(),
          ),
          dispose,
          getActiveSessions: () => [],
          isTrustedManagedParent: () => true,
        }),
      );
      if (fails)
        dispose.mockRejectedValueOnce(new Error('late host still alive'));
      const bridge = createAcpSessionBridge({
        boundWorkspace: cwd,
        channelFactory: factory(),
        channelIdleTimeoutMs: 0,
      });
      const starting = bridge.preheat();
      void starting.catch(() => {});
      await vi.waitFor(() => expect(loadCliConfig).toHaveBeenCalledOnce());
      const stopping = bridge.shutdown();
      void stopping.catch(() => {});
      loading.resolve(config);
      if (fails) {
        await expect(starting).rejects.toBeInstanceOf(AcpChannelTeardownError);
        await expect(stopping).rejects.toBeInstanceOf(AcpChannelTeardownError);
      } else {
        await expect(starting).rejects.toThrow('shutting down');
        await stopping;
      }
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    'gates the next host on prior disposal, failure=%s',
    async (fails) => {
      const cleanup = deferred<void>();
      dispose.mockReturnValueOnce(cleanup.promise);
      const create = factory();
      const first = await create(cwd, privateOverrides);
      const stopping = first.kill();
      const stopOutcome = stopping.then(
        () => 'stopped',
        () => 'failed',
      );
      const next = create(cwd, privateOverrides);
      const nextOutcome = next.then(
        (channel) => ({ channel }),
        (error: unknown) => ({ error }),
      );
      await first.transportFailed;
      await Promise.resolve();
      expect(loadCliConfig).toHaveBeenCalledOnce();
      if (fails) cleanup.reject(new Error('old host still alive'));
      else cleanup.resolve();
      await stopOutcome;
      const result = await nextOutcome;
      if (fails) {
        expect('error' in result).toBe(true);
        if (!('error' in result)) throw new Error('Expected teardown failure');
        expect(result.error).toBeInstanceOf(AcpChannelTeardownError);
        await expect(create(cwd, privateOverrides)).rejects.toBe(result.error);
        expect(loadCliConfig).toHaveBeenCalledOnce();
      } else {
        expect(loadCliConfig).toHaveBeenCalledTimes(2);
        if (!('channel' in result)) throw result.error;
        await result.channel.kill();
      }
    },
  );

  it('waits for disposal instead of publishing a host born after closure', async () => {
    const original = vi.mocked(createAcpAgentHost).getMockImplementation()!;
    const initialized = deferred<void>();
    const release = deferred<void>();
    const cleanup = deferred<void>();
    dispose.mockReturnValueOnce(cleanup.promise);
    vi.mocked(createAcpAgentHost).mockImplementationOnce(async (...args) => {
      const host = await original(...args);
      initialized.resolve();
      await release.promise;
      return host;
    });
    const pending = factory()(cwd, privateOverrides);
    const settled = vi.fn();
    void pending.then(settled, settled);
    void pending.catch(() => {});
    await initialized.promise;
    guard.close();
    release.resolve();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    cleanup.resolve();
    await expect(pending).rejects.toThrow('no longer active');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it.each(['kill', 'killSync', 'eof', 'generation'] as const)(
    '%s aborts transport immediately and reports exit only after one disposal',
    async (cause) => {
      const cleanup = deferred<void>();
      dispose.mockReturnValueOnce(cleanup.promise);
      const channel = await factory()(cwd, privateOverrides);
      const exit = vi.fn();
      void channel.exited.then(exit);
      const reader = channel.stream.readable.getReader();
      const pendingRead = reader.read();
      if (cause === 'kill') void channel.kill();
      if (cause === 'killSync') channel.killSync();
      if (cause === 'eof') closed.resolve();
      if (cause === 'generation') guard.close();
      await channel.transportFailed;
      expect(await pendingRead).toMatchObject({ done: true });
      expect(dispose).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      const first = channel.kill();
      expect(channel.kill()).toBe(first);
      cleanup.resolve();
      await first;
      await channel.exited;
      expect(exit).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      reader.releaseLock();
    },
  );

  it('does not report exit when host disposal fails', async () => {
    dispose.mockRejectedValueOnce(new Error('uncontained tool'));
    const channel = await factory()(cwd, privateOverrides);
    const exit = vi.fn();
    void channel.exited.then(exit);
    await expect(channel.kill()).rejects.toThrow('uncontained tool');
    await channel.transportFailed;
    await expect(channel.kill()).rejects.toThrow('uncontained tool');
    expect(exit).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
