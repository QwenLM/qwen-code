/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { ConversationWorkspace } from './conversation-workspace.js';
import type { ConversationRuntimeOwnership } from './conversation-runtime-ownership.js';
import {
  ConversationRuntimeManager,
  type ConversationRuntimeManagerOptions,
} from './conversation-runtime-manager.js';

const root = {
  configuredRoot: '/work/conversations',
  canonicalRoot: '/work/conversations',
  device: 1,
  inode: 2,
  inodeVerifiable: true,
};

function createBridge(mandatoryLeaseAttested = true) {
  return {
    mandatoryLeaseAttested,
    preheat: vi.fn(async () => undefined),
    setLiveScreenContextCaptureHandler: vi.fn(),
    setLiveTaskToolRequestHandler: vi.fn(),
    setLiveSpeakToUserHandler: vi.fn(),
  } as unknown as AcpSessionBridge;
}

function createRuntime(options: {
  workspaceId: string;
  workspaceCwd: string;
  primary: boolean;
  provenance?: WorkspaceRuntime['provenance'];
  trusted?: boolean;
  removable?: boolean;
  bridge?: AcpSessionBridge;
}): WorkspaceRuntime {
  return {
    workspaceId: options.workspaceId,
    workspaceCwd: options.workspaceCwd,
    sessionRuntimeBaseDir: '/runtime',
    primary: options.primary,
    trusted: options.trusted ?? true,
    ...(options.provenance ? { provenance: options.provenance } : {}),
    ...(options.removable !== undefined
      ? { removable: options.removable }
      : {}),
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: options.bridge ?? createBridge(),
    workspaceService: {} as DaemonWorkspaceService,
    routeFileSystemFactory: {} as WorkspaceFileSystemFactory,
    clientMcpSenderRegistry: {} as WorkspaceRuntime['clientMcpSenderRegistry'],
  };
}

function createRegistry(
  conversationRuntime?: WorkspaceRuntime,
): WorkspaceRegistry {
  return createWorkspaceRegistry([
    createRuntime({
      workspaceId: 'primary',
      workspaceCwd: '/work/primary',
      primary: true,
    }),
    ...(conversationRuntime ? [conversationRuntime] : []),
  ]);
}

function createWorkspace() {
  return {
    revalidate: vi.fn(async () => root),
    assertExactRoot: vi.fn(async (candidate: string) => {
      if (candidate !== root.canonicalRoot) {
        throw new Error('Workspace must be the exact Live conversation root');
      }
      return root;
    }),
  } satisfies Pick<ConversationWorkspace, 'revalidate' | 'assertExactRoot'>;
}

function createOwnedRuntime(bridge = createBridge()): WorkspaceRuntime {
  return createRuntime({
    workspaceId: 'conversations',
    workspaceCwd: root.canonicalRoot,
    primary: false,
    provenance: 'live-conversation',
    trusted: true,
    removable: false,
    bridge,
  });
}

function createManager(
  options: Omit<
    ConversationRuntimeManagerOptions,
    'ownership' | 'quarantineRuntime'
  > & {
    ownership?: ConversationRuntimeOwnership;
    quarantineRuntime?: ConversationRuntimeManagerOptions['quarantineRuntime'];
  },
): ConversationRuntimeManager {
  return new ConversationRuntimeManager({
    ...options,
    quarantineRuntime:
      options.quarantineRuntime ?? vi.fn(async () => undefined),
    ownership: options.ownership ?? {
      acquire: vi.fn(async () => ({ reclaimed: false })),
      release: vi.fn(async () => false),
    },
  });
}

describe('ConversationRuntimeManager', () => {
  it('acquires ownership before touching the root or registry', async () => {
    const workspace = createWorkspace();
    const registry = createRegistry();
    const publishRuntime = vi.fn();
    const ownershipError = new Error('owner unavailable');
    const ownership = {
      acquire: vi.fn(async () => Promise.reject(ownershipError)),
      release: vi.fn(async () => false),
    };
    const manager = createManager({
      workspace,
      registry,
      publishRuntime,
      ownership,
    });

    await expect(manager.ensure()).rejects.toBe(ownershipError);
    expect(workspace.revalidate).not.toHaveBeenCalled();
    expect(workspace.assertExactRoot).not.toHaveBeenCalled();
    expect(publishRuntime).not.toHaveBeenCalled();
    expect(
      registry.getManagedEntryByWorkspaceCwd(root.canonicalRoot),
    ).toBeUndefined();
  });

  it('one-flights publication and revalidates cached reuse without preheating or binding Live', async () => {
    const workspace = createWorkspace();
    const registry = createRegistry();
    const bridge = createBridge();
    const candidate = createOwnedRuntime(bridge);
    let releasePublication: (() => void) | undefined;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publishRuntime = vi.fn(async (_cwd, validate) => {
      await publicationGate;
      await validate(candidate);
      registry.add(candidate);
      return candidate;
    });
    const manager = createManager({
      workspace,
      registry,
      publishRuntime,
    });

    const first = manager.ensure();
    const second = manager.ensure();
    expect(second).toBe(first);
    releasePublication?.();
    await expect(first).resolves.toBe(candidate);
    await expect(manager.ensure()).resolves.toBe(candidate);

    expect(publishRuntime).toHaveBeenCalledOnce();
    expect(workspace.revalidate).toHaveBeenCalledTimes(2);
    expect(workspace.assertExactRoot).toHaveBeenCalledTimes(2);
    expect(workspace.assertExactRoot).toHaveBeenCalledWith(root.canonicalRoot);
    expect(bridge.preheat).not.toHaveBeenCalled();
    expect(bridge.setLiveScreenContextCaptureHandler).not.toHaveBeenCalled();
    expect(bridge.setLiveTaskToolRequestHandler).not.toHaveBeenCalled();
    expect(bridge.setLiveSpeakToUserHandler).not.toHaveBeenCalled();
  });

  it('adopts an active owned runtime without publishing another one', async () => {
    const candidate = createOwnedRuntime();
    const registry = createRegistry(candidate);
    const workspace = createWorkspace();
    const publishRuntime = vi.fn();
    const manager = createManager({
      workspace,
      registry,
      publishRuntime,
    });

    await expect(manager.ensure()).resolves.toBe(candidate);
    expect(publishRuntime).not.toHaveBeenCalled();
    expect(workspace.assertExactRoot).toHaveBeenCalledWith(root.canonicalRoot);
  });

  it('asserts the cached current generation without root I/O', async () => {
    const candidate = createOwnedRuntime();
    const registry = createRegistry(candidate);
    const workspace = createWorkspace();
    const manager = createManager({
      workspace,
      registry,
      publishRuntime: vi.fn(),
    });
    await manager.ensure();
    workspace.revalidate.mockClear();
    workspace.assertExactRoot.mockClear();

    expect(manager.assertCurrent(candidate)).toBe(candidate);
    expect(workspace.revalidate).not.toHaveBeenCalled();
    expect(workspace.assertExactRoot).not.toHaveBeenCalled();
  });

  it('rejects a stale expected runtime generation without root I/O', async () => {
    const candidate = createOwnedRuntime();
    const replacement = createOwnedRuntime();
    const registry = createRegistry(candidate);
    const workspace = createWorkspace();
    const manager = createManager({
      workspace,
      registry,
      publishRuntime: vi.fn(),
    });
    await manager.ensure();
    const entry = registry.getManagedEntryByWorkspaceCwd(root.canonicalRoot)!;
    registry.beginReplacement(entry, 'replacement');
    registry.activateReplacement(entry, replacement, 'replacement');
    workspace.revalidate.mockClear();
    workspace.assertExactRoot.mockClear();

    let error: unknown;
    try {
      manager.assertCurrent(candidate);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'conversation_runtime_unavailable',
      retryable: true,
    });
    expect(workspace.revalidate).not.toHaveBeenCalled();
    expect(workspace.assertExactRoot).not.toHaveBeenCalled();
  });

  it('terminally quarantines the current runtime with one disposal', async () => {
    const candidate = createOwnedRuntime();
    const registry = createRegistry(candidate);
    let releaseQuarantine!: () => void;
    const quarantineGate = new Promise<void>((resolve) => {
      releaseQuarantine = resolve;
    });
    const quarantineRuntime = vi.fn(() => quarantineGate);
    const onTerminalQuarantine = vi.fn();
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime: vi.fn(),
      quarantineRuntime,
      onTerminalQuarantine,
    });
    await manager.ensure();

    const first = manager.quarantine(
      candidate,
      'standalone_session_containment_failed',
    );
    const second = manager.quarantine(
      candidate,
      'standalone_session_containment_failed',
    );

    expect(second).toBe(first);
    expect(onTerminalQuarantine).toHaveBeenCalledOnce();
    expect(() => manager.assertCurrent(candidate)).toThrowError(
      expect.objectContaining({ code: 'conversation_runtime_unavailable' }),
    );
    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
    });
    await vi.waitFor(() => expect(quarantineRuntime).toHaveBeenCalledOnce());
    releaseQuarantine();
    await expect(first).resolves.toBeUndefined();
  });

  it('does not terminalize for a stale quarantine target', async () => {
    const candidate = createOwnedRuntime();
    const stale = createOwnedRuntime();
    const registry = createRegistry(candidate);
    const quarantineRuntime = vi.fn(async () => undefined);
    const onTerminalQuarantine = vi.fn();
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime: vi.fn(),
      quarantineRuntime,
      onTerminalQuarantine,
    });
    await manager.ensure();

    expect(() =>
      manager.quarantine(stale, 'standalone_session_containment_failed'),
    ).toThrowError(
      expect.objectContaining({ code: 'conversation_runtime_unavailable' }),
    );
    expect(manager.assertCurrent(candidate)).toBe(candidate);
    expect(onTerminalQuarantine).not.toHaveBeenCalled();
    expect(quarantineRuntime).not.toHaveBeenCalled();
  });

  it('keeps quarantine terminal when its observer or disposal fails', async () => {
    const candidate = createOwnedRuntime();
    const registry = createRegistry(candidate);
    const disposalError = new Error('dispose failed');
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime: vi.fn(),
      onTerminalQuarantine: () => {
        throw new Error('observer failed');
      },
      quarantineRuntime: vi.fn(async () => Promise.reject(disposalError)),
    });
    await manager.ensure();

    await expect(
      manager.quarantine(candidate, 'standalone_session_containment_failed'),
    ).rejects.toBe(disposalError);
    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
    });
  });

  it('rejects an adopted runtime marked as primary', async () => {
    const candidate = createRuntime({
      workspaceId: 'conversations',
      workspaceCwd: root.canonicalRoot,
      primary: true,
      provenance: 'live-conversation',
      trusted: true,
      removable: false,
    });
    const registry = createRegistry();
    registry.add(candidate);
    const publishRuntime = vi.fn();
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime,
    });

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_root_compromised',
      retryable: false,
    });
    expect(publishRuntime).not.toHaveBeenCalled();
  });

  it('rejects an adopted runtime that stops being active during validation', async () => {
    const candidate = createOwnedRuntime();
    const registry = createRegistry(candidate);
    const workspace = createWorkspace();
    workspace.assertExactRoot.mockImplementationOnce(async () => {
      registry.beginDrain(candidate);
      return root;
    });
    const publishRuntime = vi.fn();
    const manager = createManager({
      workspace,
      registry,
      publishRuntime,
    });

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
      retryable: true,
    });
    expect(publishRuntime).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'provenance',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        provenance: 'existing',
        trusted: true,
        removable: false,
      }),
    },
    {
      name: 'trust',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        provenance: 'live-conversation',
        trusted: false,
        removable: false,
      }),
    },
    {
      name: 'removability',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        provenance: 'live-conversation',
        trusted: true,
        removable: true,
      }),
    },
    {
      name: 'missing provenance',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        trusted: true,
        removable: false,
      }),
    },
    {
      name: 'missing removability',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        provenance: 'live-conversation',
        trusted: true,
      }),
    },
  ])('rejects an existing runtime with invalid $name', async ({ runtime }) => {
    const publishRuntime = vi.fn();
    const manager = createManager({
      workspace: createWorkspace(),
      registry: createRegistry(runtime),
      publishRuntime,
    });

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_root_compromised',
      retryable: false,
    });
    expect(publishRuntime).not.toHaveBeenCalled();
  });

  it('rejects and does not publish a candidate missing the mandatory-lease attestation', async () => {
    const candidate = createOwnedRuntime(createBridge(false));
    const registry = createRegistry();
    const publishRuntime = vi.fn(
      async (_cwd: string, validate: (runtime: WorkspaceRuntime) => void) => {
        await validate(candidate);
        throw new Error('unreachable: validation must reject the candidate');
      },
    );
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime,
    });

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_root_compromised',
      retryable: false,
    });
    expect(publishRuntime).toHaveBeenCalledOnce();
    expect(
      registry.getManagedEntryByWorkspaceCwd(root.canonicalRoot),
    ).toBeUndefined();
  });

  it('terminally quarantines a registered runtime missing the mandatory-lease attestation', async () => {
    const candidate = createOwnedRuntime(createBridge(false));
    const registry = createRegistry(candidate);
    const quarantineRuntime = vi.fn(async () => undefined);
    const onTerminalQuarantine = vi.fn();
    const publishRuntime = vi.fn();
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime,
      quarantineRuntime,
      onTerminalQuarantine,
    });

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_root_compromised',
      retryable: false,
    });
    expect(quarantineRuntime).toHaveBeenCalledWith(
      candidate,
      'missing_mandatory_lease_attestation',
    );
    expect(publishRuntime).not.toHaveBeenCalled();
    // The static contract violation keeps its non-retryable classification on
    // every later access instead of degrading to retryable
    // `conversation_runtime_unavailable`.
    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_root_compromised',
      retryable: false,
    });
    expect(() => manager.assertCurrent(candidate)).toThrowError(
      expect.objectContaining({ code: 'conversation_root_compromised' }),
    );
  });

  it.each(['draining', 'blocked'] as const)(
    'rejects an existing %s entry without publishing a replacement',
    async (state) => {
      const candidate = createOwnedRuntime();
      const registry = createRegistry(candidate);
      const entry = registry.getManagedEntryByWorkspaceCwd(root.canonicalRoot)!;
      if (state === 'draining') {
        registry.beginDrain(candidate);
      } else {
        registry.beginReplacement(entry, 'next');
        registry.blockReplacement(entry, 'blocked');
      }
      const publishRuntime = vi.fn();
      const manager = createManager({
        workspace: createWorkspace(),
        registry,
        publishRuntime,
      });

      await expect(manager.ensure()).rejects.toMatchObject({
        code: 'conversation_runtime_unavailable',
        retryable: true,
      });
      expect(publishRuntime).not.toHaveBeenCalled();
    },
  );

  it('rejects a cached runtime after it is removed without publishing a replacement', async () => {
    const candidate = createOwnedRuntime();
    const registry = createRegistry(candidate);
    const publishRuntime = vi.fn();
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime,
    });
    await manager.ensure();
    registry.beginDrain(candidate);
    registry.completeDrain(candidate);

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
      retryable: true,
    });
    expect(publishRuntime).not.toHaveBeenCalled();
  });

  it('rejects a published cached runtime after it is removed without republishing', async () => {
    const candidate = createOwnedRuntime();
    const registry = createRegistry();
    const publishRuntime = vi.fn(async (_cwd, validate) => {
      await validate(candidate);
      registry.add(candidate);
      return candidate;
    });
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime,
    });
    await manager.ensure();
    registry.beginDrain(candidate);
    registry.completeDrain(candidate);

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
      retryable: true,
    });
    expect(publishRuntime).toHaveBeenCalledOnce();
  });

  it('rejects a cached runtime replaced by another active generation', async () => {
    const candidate = createOwnedRuntime();
    const replacement = createOwnedRuntime();
    const registry = createRegistry(candidate);
    const publishRuntime = vi.fn();
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime,
    });
    await manager.ensure();
    const entry = registry.getManagedEntryByWorkspaceCwd(root.canonicalRoot)!;
    registry.beginReplacement(entry, 'next');
    registry.activateReplacement(entry, replacement, 'next');

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
      retryable: true,
    });
    expect(publishRuntime).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'primary status',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: true,
        provenance: 'live-conversation',
        trusted: true,
        removable: false,
      }),
    },
    {
      name: 'provenance',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        provenance: 'existing',
        trusted: true,
        removable: false,
      }),
    },
    {
      name: 'trust',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        provenance: 'live-conversation',
        trusted: false,
        removable: false,
      }),
    },
    {
      name: 'removability',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        provenance: 'live-conversation',
        trusted: true,
        removable: true,
      }),
    },
    {
      name: 'missing provenance',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        trusted: true,
        removable: false,
      }),
    },
    {
      name: 'missing removability',
      runtime: createRuntime({
        workspaceId: 'conversations',
        workspaceCwd: root.canonicalRoot,
        primary: false,
        provenance: 'live-conversation',
        trusted: true,
      }),
    },
  ])(
    'rejects a publication candidate with invalid $name',
    async ({ runtime }) => {
      const registry = createRegistry();
      const manager = createManager({
        workspace: createWorkspace(),
        registry,
        publishRuntime: async (_cwd, validate) => {
          await validate(runtime);
          return runtime;
        },
      });

      await expect(manager.ensure()).rejects.toMatchObject({
        code: 'conversation_root_compromised',
        retryable: false,
      });
      expect(registry.getByWorkspaceCwd(root.canonicalRoot)).toBeUndefined();
    },
  );

  it('retries after rejecting a publication candidate outside the exact root', async () => {
    const registry = createRegistry();
    const workspace = createWorkspace();
    const wrongRuntime = createRuntime({
      workspaceId: 'wrong',
      workspaceCwd: '/work/wrong',
      primary: false,
      provenance: 'live-conversation',
      trusted: true,
      removable: false,
    });
    const candidate = createOwnedRuntime();
    const publishRuntime = vi
      .fn()
      .mockImplementationOnce(async (_cwd, validate) => {
        await validate(wrongRuntime);
        return wrongRuntime;
      })
      .mockImplementationOnce(async (_cwd, validate) => {
        await validate(candidate);
        registry.add(candidate);
        return candidate;
      });
    const manager = createManager({
      workspace,
      registry,
      publishRuntime,
    });

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_root_compromised',
      retryable: false,
    });
    await expect(manager.ensure()).resolves.toBe(candidate);
    expect(registry.getByWorkspaceCwd('/work/wrong')).toBeUndefined();
    expect(publishRuntime).toHaveBeenCalledTimes(2);
  });

  it('publishes with the revalidated canonical root', async () => {
    const canonicalRoot = '/canonical/conversations';
    const revalidatedRoot = {
      ...root,
      configuredRoot: '/configured/conversations',
      canonicalRoot,
    };
    const workspace = {
      revalidate: vi.fn(async () => revalidatedRoot),
      assertExactRoot: vi.fn(async () => revalidatedRoot),
    } satisfies Pick<ConversationWorkspace, 'revalidate' | 'assertExactRoot'>;
    const registry = createRegistry();
    const candidate = createRuntime({
      workspaceId: 'conversations',
      workspaceCwd: canonicalRoot,
      primary: false,
      provenance: 'live-conversation',
      trusted: true,
      removable: false,
    });
    const publishRuntime = vi.fn(async (_cwd, validate) => {
      await validate(candidate);
      registry.add(candidate);
      return candidate;
    });
    const manager = createManager({
      workspace,
      registry,
      publishRuntime,
    });

    await expect(manager.ensure()).resolves.toBe(candidate);
    expect(publishRuntime).toHaveBeenCalledWith(
      canonicalRoot,
      expect.any(Function),
    );
  });

  it('retries after a published runtime stops being active before publication returns', async () => {
    const registry = createRegistry();
    const first = createOwnedRuntime();
    const second = createOwnedRuntime();
    const publishRuntime = vi
      .fn()
      .mockImplementationOnce(async (_cwd, validate) => {
        await validate(first);
        registry.add(first);
        registry.beginDrain(first);
        return first;
      })
      .mockImplementationOnce(async (_cwd, validate) => {
        await validate(second);
        registry.add(second);
        return second;
      });
    const manager = createManager({
      workspace: createWorkspace(),
      registry,
      publishRuntime,
    });

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
      retryable: true,
    });
    registry.completeDrain(first);
    await expect(manager.ensure()).resolves.toBe(second);
    expect(publishRuntime).toHaveBeenCalledTimes(2);
  });

  it('retries root revalidation and publication failures', async () => {
    const workspace = createWorkspace();
    workspace.revalidate
      .mockRejectedValueOnce(new Error('root unavailable'))
      .mockResolvedValue(root);
    const registry = createRegistry();
    const candidate = createOwnedRuntime();
    const publishRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error('publication unavailable'))
      .mockImplementationOnce(async (_cwd, validate) => {
        await validate(candidate);
        registry.add(candidate);
        return candidate;
      });
    const manager = createManager({
      workspace,
      registry,
      publishRuntime,
    });

    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_root_compromised',
      retryable: false,
    });
    await expect(manager.ensure()).rejects.toMatchObject({
      code: 'conversation_runtime_unavailable',
      retryable: true,
    });
    await expect(manager.ensure()).resolves.toBe(candidate);
    expect(publishRuntime).toHaveBeenCalledTimes(2);
  });
});
