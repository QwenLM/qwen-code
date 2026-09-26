/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config, deriveConfig } from './config.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type { ManagedToolSession } from '../tools/managed-tool-session.js';
import { RuntimeBackedTool } from '../tools/runtime-backed-tool.js';
import { ToolNames } from '../tools/tool-names.js';
import { canUseRipgrep } from '../utils/ripgrepUtils.js';

const localConstruct = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Gateway constructed a local tool');
  }),
);
vi.mock('../tools/read-file.js', () => ({ ReadFileTool: localConstruct }));
vi.mock('../tools/write-file.js', () => ({ WriteFileTool: localConstruct }));
vi.mock('../tools/notebook-edit.js', () => ({
  NotebookEditTool: localConstruct,
}));
vi.mock('../tools/edit.js', () => ({ EditTool: localConstruct }));
vi.mock('../tools/shell.js', () => ({ ShellTool: localConstruct }));
vi.mock('../tools/glob.js', () => ({ GlobTool: localConstruct }));
vi.mock('../tools/ls.js', () => ({ LSTool: localConstruct }));
vi.mock('../tools/grep.js', () => ({ GrepTool: localConstruct }));
vi.mock('../tools/ripGrep.js', () => ({ RipGrepTool: localConstruct }));
vi.mock('../utils/ripgrepUtils.js', () => ({ canUseRipgrep: vi.fn() }));

const names = [
  ToolNames.READ_FILE,
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
  ToolNames.SHELL,
  ToolNames.GLOB,
  ToolNames.GREP,
];

describe('Config managed tool registration', () => {
  let root: string;
  let config: Config;
  const getClient = vi.fn<ManagedToolSession['getClient']>();
  const close = vi.fn<ManagedToolSession['close']>();
  const childSessions: ManagedToolSession[] = [];
  let rootSession: ManagedToolSession;
  const status = vi.fn<PermissionManager['getToolRegistrationStatus']>();

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'managed-registry-config-')),
    );
    vi.stubEnv('QWEN_HOME', root);
    vi.stubEnv('QWEN_RUNTIME_DIR', join(root, 'output'));
    getClient.mockReset().mockRejectedValue(new Error('Runtime not ready'));
    close.mockReset().mockResolvedValue(undefined);
    localConstruct.mockClear();
    vi.mocked(canUseRipgrep).mockClear();
    childSessions.length = 0;
    const makeChild = (): ManagedToolSession => {
      const session: ManagedToolSession = {
        ...rootSession,
        sessionId: randomUUID(),
        getClient: vi
          .fn()
          .mockRejectedValue(new Error('Child Runtime not ready')),
        close: vi.fn().mockResolvedValue(undefined),
        createChild: makeChild,
      };
      childSessions.push(session);
      return session;
    };
    rootSession = {
      sessionId: randomUUID(),
      getClient,
      close,
      createChild: makeChild,
      shellConfiguration: {
        shell: 'bash',
        executable: 'bash',
        argsPrefix: ['-c'],
      },
      platform: 'darwin',
    };
    status
      .mockReset()
      .mockImplementation(async (name) =>
        name === ToolNames.LS || names.includes(name as (typeof names)[number])
          ? 'registered'
          : 'disabled',
      );
    config = new Config({
      targetDir: root,
      cwd: root,
      debugMode: false,
      model: 'test',
      telemetry: { enabled: false },
      usageStatisticsEnabled: false,
      useRipgrep: true,
      managedToolSessionFactory: () => rootSession,
    });
    vi.spyOn(config, 'getPermissionManager').mockReturnValue({
      getToolRegistrationStatus: status,
    } as unknown as PermissionManager);
  });
  afterEach(async () => {
    close.mockResolvedValue(undefined);
    await config.shutdown({
      shutdownTelemetry: false,
      strictResourceCleanup: true,
    });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('warms actual lazy factories and exposes schemas without local constructors or Runtime readiness', async () => {
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    await registry.warmAll({ strict: true });
    expect(registry.getAllToolNames().sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(registry.getTool(name)).toBeInstanceOf(RuntimeBackedTool);
      expect(
        registry
          .getFunctionDeclarations()
          .some((schema) => schema.name === name),
      ).toBe(true);
    }
    expect(localConstruct).not.toHaveBeenCalled();
    expect(canUseRipgrep).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    const invocation = registry
      .getTool(ToolNames.READ_FILE)!
      .build({ file_path: join(root, 'file') });
    await expect(
      invocation.managed!.prepare(new AbortController().signal, {
        callId: 'call',
        promptId: 'turn',
      }),
    ).rejects.toThrow('Runtime not ready');
    expect(getClient).toHaveBeenCalledOnce();
    await registry.stop();
  });

  it('registers an explicitly allowlisted LS as a proxy without local construction', async () => {
    vi.spyOn(config, 'getCoreTools').mockReturnValue([ToolNames.LS]);
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    await registry.warmAll({ strict: true });
    expect(registry.getTool(ToolNames.LS)).toBeInstanceOf(RuntimeBackedTool);
    expect(
      registry
        .getFunctionDeclarations()
        .some((schema) => schema.name === ToolNames.LS),
    ).toBe(true);
    expect(localConstruct).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    await registry.stop();
  });

  it('preserves disabled and permission-deferred registration', async () => {
    status.mockImplementation(async (name) =>
      name === ToolNames.READ_FILE ? 'deferred' : 'disabled',
    );
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    await registry.warmAll({ strict: true });
    expect(registry.getAllToolNames()).toEqual([ToolNames.READ_FILE]);
    expect(registry.getTool(ToolNames.READ_FILE)).toBeInstanceOf(
      RuntimeBackedTool,
    );
    expect(registry.getFunctionDeclarations()).toEqual([]);
    expect(getClient).not.toHaveBeenCalled();
    await registry.stop();
  });

  it('awaits and retries remote cleanup even without completing Config initialization', async () => {
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    close.mockRejectedValueOnce(new Error('worker still running'));
    await expect(
      config.shutdown({
        strictResourceCleanup: true,
        shutdownTelemetry: false,
      }),
    ).rejects.toThrow('worker still running');
    await config.shutdown({
      strictResourceCleanup: true,
      shutdownTelemetry: false,
    });
    expect(close).toHaveBeenCalledTimes(2);
    await registry.stop();
  });

  it('keeps ordinary ACP close strict and retains the writer after a failed Runtime release', async () => {
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    const writer = vi.spyOn(config, 'closeSessionWriter');
    close.mockRejectedValueOnce(new Error('release uncertain'));
    await expect(config.shutdown({ shutdownTelemetry: false })).rejects.toThrow(
      'release uncertain',
    );
    expect(writer).not.toHaveBeenCalled();
    await config.shutdown({ shutdownTelemetry: false });
    expect(writer).toHaveBeenCalledOnce();
    await registry.stop();
  });

  it('gives a spawned child its own binding while overlays inherit that binding', async () => {
    const scope = config.createManagedChildExecutionScope();
    const child = deriveConfig(scope.config);
    const registry = await child.createToolRegistry(undefined, {
      skipDiscovery: true,
      forSubAgent: true,
    });
    await registry.warmAll({ strict: true });
    const invocation = registry
      .getTool(ToolNames.READ_FILE)!
      .build({ file_path: join(root, 'file') });
    await expect(
      invocation.managed!.prepare(new AbortController().signal, {
        callId: 'child-call',
        promptId: 'child-turn',
      }),
    ).rejects.toThrow('Child Runtime not ready');
    expect(childSessions[0].getClient).toHaveBeenCalledOnce();
    await scope.close();
    expect(childSessions[0].close).toHaveBeenCalledOnce();
    expect(getClient).not.toHaveBeenCalled();
    expect(localConstruct).not.toHaveBeenCalled();
    await registry.stop();
  });

  it('seals nested children, waits raw execution, and closes writers after Runtime', async () => {
    const events: string[] = [];
    const child = config.createManagedChildExecutionScope();
    const grandchild = child.config.createManagedChildExecutionScope();
    const running = child.run(() =>
      grandchild.run(
        () =>
          new Promise<void>((resolve) => {
            grandchild.signal!.addEventListener('abort', () => {
              events.push('aborted');
              resolve();
            });
          }),
      ),
    );
    vi.mocked(childSessions[0].close).mockImplementation(async () => {
      events.push('runtime');
    });
    child.onClose(async () => {
      events.push('writer');
    });
    await config.closeManagedToolSession();
    await running;
    expect(events).toEqual(['aborted', 'runtime', 'writer']);
    expect(child.signal!.aborted).toBe(true);
    expect(() => config.createManagedChildExecutionScope()).toThrow('closing');
    await expect(
      child.run(async () => {
        throw new Error('started');
      }),
    ).rejects.toThrow('closing');
    expect(close).toHaveBeenCalledOnce();
  });

  it('retains failed child cleanup and parent ownership for a later close', async () => {
    const child = config.createManagedChildExecutionScope();
    const writer = vi
      .fn()
      .mockRejectedValueOnce(new Error('writer busy'))
      .mockResolvedValue(undefined);
    child.onClose(writer);
    await expect(config.closeManagedToolSession()).rejects.toThrow(
      'cleanup failed',
    );
    expect(close).not.toHaveBeenCalled();
    expect(childSessions[0].close).toHaveBeenCalledOnce();
    await config.closeManagedToolSession();
    expect(writer).toHaveBeenCalledTimes(2);
    expect(childSessions[0].close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('delegates a managed parent checkpoint without local snapshot work', async () => {
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    rootSession.beginFileHistoryTurn = checkpoint;
    const local = vi.spyOn(config.getFileHistoryService(), 'makeSnapshot');
    await config.makeFileHistorySnapshot('parent-turn');
    expect(checkpoint).toHaveBeenCalledWith('parent-turn');
    expect(local).not.toHaveBeenCalled();
  });

  it('records the actual local snapshot when no managed history control is supplied', async () => {
    config.enableFileCheckpointing();
    const record = vi.fn();
    vi.spyOn(config, 'getChatRecordingService').mockReturnValue({
      recordFileHistorySnapshot: record,
    } as unknown as ReturnType<Config['getChatRecordingService']>);
    await config.makeFileHistorySnapshot('local-turn');
    expect(
      config
        .getFileHistoryService()
        .getSnapshots()
        .map((snapshot) => snapshot.promptId),
    ).toEqual(['local-turn']);
    expect(record).toHaveBeenCalledWith(
      config.getFileHistoryService().getSnapshots()[0],
    );
  });
});
