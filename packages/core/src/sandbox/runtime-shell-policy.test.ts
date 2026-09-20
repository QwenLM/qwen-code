/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigParameters } from '../config/config.js';
import {
  admitShellSandbox,
  assertShellSandboxCwd,
  probeShellSandbox,
} from './runtime-shell-policy.js';

const executeBwrap = vi.hoisted(() => vi.fn());
vi.mock('./bwrap-execution.js', () => ({ executeBwrap }));

describe('runtime shell policy admission', () => {
  let root: string;
  let params: ConfigParameters;
  beforeEach(() => {
    vi.clearAllMocks();
    for (const name of [
      'SANDBOX',
      'QWEN_SANDBOX',
      'QWEN_SANDBOX_NET',
      'QWEN_SANDBOX_PROXY_COMMAND',
    ])
      vi.stubEnv(name, undefined);
    root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'qwen-policy-test-')),
    );
    for (const name of [
      'workspace',
      'outside',
      'installation',
      'state',
      'runtime',
      'config',
    ])
      mkdirSync(path.join(root, name));
    params = {
      targetDir: path.join(root, 'workspace'),
      cwd: path.join(root, 'workspace'),
      debugMode: false,
      bareMode: true,
      interactive: false,
      shellExecutionSandbox: {
        workspace: path.join(root, 'workspace'),
        installation: path.join(root, 'installation'),
        state: path.join(root, 'state'),
        filesystem: 'workspace-write',
        network: 'closed',
      },
    } as ConfigParameters;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });
  const admit = (params: ConfigParameters, root: string) =>
    admitShellSandbox(
      params,
      path.join(root, 'runtime'),
      path.join(root, 'config'),
    );

  it('snapshots the canonical policy and both host state roots', () => {
    const workspaceAlias = path.join(root, 'workspace-alias');
    const installationAlias = path.join(root, 'installation-alias');
    const stateAlias = path.join(root, 'state-alias');
    for (const [target, alias] of [
      [path.join(root, 'workspace'), workspaceAlias],
      [path.join(root, 'installation'), installationAlias],
      [path.join(root, 'state'), stateAlias],
    ])
      symlinkSync(
        target,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    params.shellExecutionSandbox = {
      ...params.shellExecutionSandbox!,
      workspace: workspaceAlias,
      installation: installationAlias,
      state: stateAlias,
      bwrapPath: path.join(root, 'installation', 'bwrap'),
    };
    const policy = admit(params, root)!;
    params.shellExecutionSandbox = {
      ...params.shellExecutionSandbox!,
      workspace: path.join(root, 'outside'),
      network: 'open',
    };
    expect(policy.workspace).toBe(path.join(root, 'workspace'));
    expect(policy.installation).toBe(path.join(root, 'installation'));
    expect(policy.state).toBe(path.join(root, 'state'));
    expect(policy.bwrapPath).toBe(path.join(root, 'installation', 'bwrap'));
    expect(policy.network).toBe('closed');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy).not.toHaveProperty('protectedRoots');
  });

  it('canonicalizes workspace-local masks and rejects masks outside it', () => {
    params.shellExecutionSandbox = {
      ...params.shellExecutionSandbox!,
      maskedPaths: [path.join(root, 'workspace', '.qwen', 'review-leases')],
    };
    const policy = admit(params, root)!;
    expect(policy.maskedPaths).toEqual([
      path.join(root, 'workspace', '.qwen', 'review-leases'),
    ]);
    expect(Object.isFrozen(policy.maskedPaths)).toBe(true);
    params.shellExecutionSandbox = {
      ...params.shellExecutionSandbox,
      maskedPaths: [path.join(root, 'outside')],
    };
    expect(() => admit(params, root)).toThrow('inside the workspace');
  });

  it('keeps frontend mode outside core policy admission', () => {
    expect(
      admit({ ...params, bareMode: false, interactive: true }, root),
    ).toBeDefined();
  });

  it('preserves whole-CLI bwrap when the new policy is absent', () => {
    expect(
      admit(
        {
          ...params,
          shellExecutionSandbox: undefined,
          sandbox: { command: 'bwrap' },
        },
        root,
      ),
    ).toBeUndefined();
  });

  it.each([
    'SANDBOX',
    'QWEN_SANDBOX',
    'QWEN_SANDBOX_NET',
    'QWEN_SANDBOX_PROXY_COMMAND',
  ])('rejects legacy %s environment', (name) => {
    vi.stubEnv(name, 'bwrap');
    expect(() => admit(params, root)).toThrow('legacy sandbox environment');
  });

  it.each(['SANDBOX', 'QWEN_SANDBOX_NET', 'QWEN_SANDBOX_PROXY_COMMAND'])(
    'ignores empty legacy %s environment',
    (name) => {
      vi.stubEnv(name, '  ');
      expect(() => admit(params, root)).not.toThrow();
    },
  );

  it.each(['false', '0'])('accepts disabled QWEN_SANDBOX=%s', (value) => {
    vi.stubEnv('QWEN_SANDBOX', value);
    expect(() => admit(params, root)).not.toThrow();
  });

  it('rejects a distinct cwd outside the admitted workspace', () => {
    expect(() =>
      admit({ ...params, cwd: path.join(root, 'outside') }, root),
    ).toThrow('admitted workspace');
  });

  it('rejects cwd symlinks into another workspace', () => {
    symlinkSync(
      path.join(root, 'outside'),
      path.join(root, 'workspace', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const policy = admit(params, root)!;
    expect(() =>
      assertShellSandboxCwd(policy, path.join(root, 'workspace', 'link')),
    ).toThrow('admitted workspace');
    expect(() =>
      assertShellSandboxCwd(policy, path.join(root, 'workspace')),
    ).not.toThrow();
  });

  it.each(['runtime', 'config', 'state', 'installation'])(
    'rejects workspace overlap with %s',
    (name) => {
      params.targetDir = path.join(root, name);
      params.shellExecutionSandbox = {
        ...params.shellExecutionSandbox!,
        workspace: params.targetDir,
      };
      expect(() => admit(params, root)).toThrow('overlaps protected');
    },
  );

  it('rejects workspace ancestors and descendants of protected roots', () => {
    params.targetDir = root;
    params.cwd = root;
    params.shellExecutionSandbox = {
      ...params.shellExecutionSandbox!,
      workspace: root,
    };
    expect(() => admit(params, root)).toThrow('overlaps protected');

    const nested = path.join(root, 'runtime', 'nested');
    mkdirSync(nested);
    params.targetDir = nested;
    params.cwd = nested;
    params.shellExecutionSandbox = {
      ...params.shellExecutionSandbox,
      workspace: nested,
    };
    expect(() => admit(params, root)).toThrow('overlaps protected');
  });

  it.each([[['']], [['none']], [[' NONE ']]])(
    'accepts the no-extension override %j',
    (overrideExtensions) => {
      expect(() =>
        admit({ ...params, overrideExtensions }, root),
      ).not.toThrow();
    },
  );

  it.each<Partial<ConfigParameters>>([
    { provisionalWorkspace: true },
    { sdkMode: true },
    { experimentalZedIntegration: true },
    { overrideExtensions: ['extension'] },
    { mcpServers: { x: { command: 'node' } } },
    { topTierMcpServers: { x: { command: 'node' } } },
    { toolDiscoveryCommand: 'node' },
    { toolCallCommand: 'node' },
    { mcpServerCommand: 'node' },
    { lsp: { enabled: true } },
    { sandbox: { command: 'docker' } },
    { agentExecutionBackend: 'container' },
    { executionEnvironmentFactory: vi.fn() },
  ])('rejects unsupported startup inputs %j', (overrides) => {
    expect(() => admit({ ...params, ...overrides }, root)).toThrow(
      'does not support',
    );
  });
  it('probes a fixed command and requires a confirmed zero exit receipt', async () => {
    vi.stubGlobal(
      'process',
      Object.create(process, { platform: { value: 'linux' } }),
    );
    executeBwrap.mockResolvedValue({
      result: Promise.resolve({
        sandboxStatus: { state: 'confirmed', exitCode: 0 },
      }),
    });
    await probeShellSandbox(admit(params, root)!);
    expect(executeBwrap).toHaveBeenCalledWith(
      expect.anything(),
      {
        executable: '/bin/bash',
        args: ['-c', 'true'],
        cwd: params.targetDir,
        env: { PATH: '/usr/bin:/bin' },
      },
      expect.any(Function),
      expect.any(AbortSignal),
    );
    executeBwrap.mockResolvedValue({
      result: Promise.resolve({ sandboxStatus: { state: 'unconfirmed' } }),
    });
    await expect(probeShellSandbox(admit(params, root)!)).rejects.toThrow(
      'capability probe failed',
    );
    expect(executeBwrap).toHaveBeenCalledTimes(2);
  });

  it('aborts a hung capability probe after ten seconds', async () => {
    vi.stubGlobal(
      'process',
      Object.create(process, { platform: { value: 'linux' } }),
    );
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    executeBwrap.mockImplementation(
      async (_policy, _command, _output, signal: AbortSignal) => {
        started();
        return {
          result: new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () =>
                resolve({
                  sandboxStatus: { state: 'unconfirmed' },
                  aborted: true,
                }),
              { once: true },
            ),
          ),
        };
      },
    );
    try {
      const pending = probeShellSandbox(admit(params, root)!);
      await ready;
      timeout.abort();
      await expect(pending).rejects.toThrow('capability probe failed');
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
