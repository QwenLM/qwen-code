/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import {
  managedLocalJavaEnvironment,
  runManagedLocalServe,
} from './managed-local-serve.js';
import type { ManagedLocalState } from './managed-local-state.js';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  openState: vi.fn(),
  startWeb: vi.fn(),
  stdout: vi.fn(),
  loadModels: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./managed-local-runtime.js', () => ({
  resolveManagedLocalRuntime: async () => ({
    java: '/package/jre/bin/java',
    serverJar: '/package/server.jar',
    cliEntry: '/package/cli.js',
  }),
}));
vi.mock('./managed-local-state.js', () => ({
  openManagedLocalState: mocks.openState,
}));
vi.mock('./managed-local-web.js', () => ({
  signedManagedHeaders: () => ({}),
}));
vi.mock('./managed-local-models.js', () => ({
  loadManagedLocalModels: mocks.loadModels,
}));
vi.mock('./run-qwen-serve.js', () => ({
  runQwenServe: mocks.startWeb,
}));
vi.mock('./web-shell-resolver.js', () => ({
  resolveWebShellDir: () => '/package/web-shell',
}));
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.stdout,
  writeStderrLine: vi.fn(),
}));

describe('Managed local service environment', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('pins local boundaries and keeps independent durable credentials out of argv', () => {
    vi.stubEnv('SPRING_DATASOURCE_URL', 'jdbc:mysql://foreign/database');
    vi.stubEnv('QWEN_MANAGED_AGENT_AUTH_MODE', 'off');
    vi.stubEnv('QWEN_MANAGED_AGENT_RUNTIME_SSH_ENABLED', 'true');
    vi.stubEnv('QWEN_SERVER_TOKEN', 'foreign-token');
    const state: ManagedLocalState = {
      schemaVersion: 1,
      installationId: 'local-id',
      publicToken: 'public',
      harnessToken: 'harness',
      brokerToken: 'broker',
      signingKey: 'signing',
      writerBindingKey: 'writer',
      runtimeCredentialKey: 'runtime-key',
      capabilityDigest: 'sha256:digest',
      javaPort: 5011,
      harnessPort: 5012,
      brokerPort: 5013,
    };
    const models = [{ modelId: 'a,comma-model', label: 'Local model' }];
    const environment = managedLocalJavaEnvironment(
      state,
      '/private/data',
      {
        java: '/package/jre/bin/java',
        serverJar: '/package/server.jar',
        cliEntry: '/package/cli.js',
      },
      models,
    );
    expect(JSON.parse(environment['SPRING_APPLICATION_JSON']!)).toEqual({
      'qwen.managed-agent.runtime-broker.session-worktrees-enabled':
        process.platform !== 'win32',
      'qwen.managed-agent.model-catalog': models,
      'qwen.managed-agent.definition-models': ['a,comma-model'],
      'qwen.managed-agent.definition-tool-profiles': [
        'hosted-workspace-shell/1',
      ],
    });
    expect(environment['SPRING_DATASOURCE_URL']).toBeUndefined();
    expect(
      environment['QWEN_MANAGED_AGENT_RUNTIME_SSH_ENABLED'],
    ).toBeUndefined();
    expect(environment['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(environment['SPRING_PROFILES_ACTIVE']).toBe('managed-local');
    expect(environment['QWEN_MANAGED_AGENT_AUTH_MODE']).toBe('signed');
    expect(environment['QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY']).toBe('signing');
    expect(
      environment['QWEN_MANAGED_AGENT_LOCAL_DIRECTORY_IMPORT_ENABLED'],
    ).toBe('true');
    expect(environment['QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY']).toBe(
      'writer',
    );
    expect(environment['QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN']).toBe(
      'broker',
    );
    expect(environment['QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY']).toBe(
      'runtime-key',
    );
    expect(environment['QWEN_MANAGED_AGENT_HARNESS_TOKEN']).toBe('harness');
    expect(
      environment['QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY'],
    ).toBe('false');
    expect(environment['QWEN_MANAGED_AGENT_APPROVAL_MODE']).toBe('default');
    expect(environment['QWEN_HOME']).toBe(
      path.join('/private/data', 'worker-home'),
    );
    expect(environment['QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY']).toBe(
      '/package/cli.js',
    );
  });
});

describe('Managed local startup supervision', () => {
  it.each([
    {
      interruption: 'child exit',
      defaultModelId: undefined,
      lifecycle: undefined,
    },
    {
      interruption: 'termination signal',
      defaultModelId: 'model-b',
      lifecycle: '',
    },
    {
      interruption: 'child exit',
      defaultModelId: 'model-b',
      lifecycle: 'hosted-workspace-mcp/1',
    },
  ])(
    'closes a listener created after $interruption with lifecycle=$lifecycle',
    async ({ interruption, defaultModelId, lifecycle }) => {
      vi.stubEnv('QWEN_HOSTED_LIFECYCLE_V2_PROFILES', lifecycle);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-start-'));
      const release = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const children: ChildProcess[] = [];
      const state = {
        installationId: 'installation',
        publicToken: 'public',
        harnessToken: 'harness',
        signingKey: 'signing',
        capabilityDigest: `sha256:${'a'.repeat(64)}`,
        javaPort: 5011,
        harnessPort: 5012,
        brokerPort: 5013,
      };
      const models = [{ modelId: 'model-b', label: 'Model B' }];
      const modelPresets = [
        { agentId: 'qwen-code', modelId: 'model-b', label: 'Model B' },
      ];
      mocks.loadModels.mockReturnValue({ models, defaultModelId });
      await mkdir(path.join(directory, 'logs'));
      mocks.stdout.mockClear();
      mocks.openState.mockResolvedValue({ state, directory, release });
      mocks.spawn.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          pid: 123_456 + children.length,
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
          kill: vi.fn(() => {
            Object.assign(child, { signalCode: 'SIGTERM' });
            child.emit('exit', null, 'SIGTERM');
            return true;
          }),
        }) as unknown as ChildProcess;
        children.push(child);
        return child;
      });
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                hostedHarness: {
                  capabilityDigest: state.capabilityDigest,
                  lifecycleV2Profiles: (lifecycle ?? 'hosted-workspace-shell/1')
                    .split(',')
                    .filter(Boolean),
                },
              }),
            ),
          )
          .mockResolvedValueOnce(new Response('ready'))
          .mockResolvedValueOnce(new Response('{}')),
      );
      mocks.startWeb.mockImplementation(async () => {
        if (interruption === 'child exit') {
          Object.assign(children[1], { exitCode: 1 });
          children[1].emit('exit', 1, null);
        } else {
          process.emit('SIGTERM');
        }
        return {
          url: 'http://127.0.0.1:9000',
          server: new EventEmitter(),
          close,
        };
      });
      try {
        await expect(runManagedLocalServe({ port: 0 })).rejects.toThrow(
          /server exited|startup interrupted/u,
        );
        expect(close).toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(mocks.startWeb).toHaveBeenCalledWith(
          expect.objectContaining({
            workspace: process.cwd(),
            requireAuth: true,
            token: state.publicToken,
            requireWebShell: true,
          }),
          expect.objectContaining({
            installSignalHandlers: false,
            preheatBridge: false,
            managedLocalWeb: expect.objectContaining({
              javaUrl: 'http://127.0.0.1:5011',
              productScope: 'local:installation',
              modelPresets: defaultModelId
                ? modelPresets
                : [
                    { agentId: 'qwen-code', label: 'Server default model' },
                    ...modelPresets,
                  ],
            }),
          }),
        );
        expect(
          JSON.parse(mocks.spawn.mock.calls[1]![2].env.SPRING_APPLICATION_JSON)[
            'qwen.managed-agent.model-catalog'
          ],
        ).toEqual(models);
        expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
        expect(mocks.stdout.mock.calls.flat().join('\n')).not.toContain(
          'WebShell:',
        );
      } finally {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
