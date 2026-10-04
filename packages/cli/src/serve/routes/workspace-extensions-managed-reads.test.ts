/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Response } from 'express';
import { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { ExtensionStore } from '@qwen-code/qwen-code-core/extension/extension-store.js';
import {
  ExtensionSettingScope,
  hasStoredExtensionSecrets,
  updateSetting,
} from '@qwen-code/qwen-code-core/extension/extensionSettings.js';
import { KeychainTokenStorage } from '@qwen-code/qwen-code-core/mcp/token-storage/keychain-token-storage.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { createWorkspaceSkillsStatusProvider } from '../workspace-skills-status.js';
import { createExtensionsController } from './workspace-extensions-controller.js';
import { createServeApp } from '../server.js';
import { createWorkspaceRegistry } from '../workspace-registry.js';
import { createWorkspaceFileSystemFactory } from '../fs/index.js';
import { ClientMcpSenderRegistry } from '../acp-http/client-mcp-sender-registry.js';

async function createManagedEpisode(
  root: string,
  skills: { user?: boolean; managed?: boolean } = {},
) {
  vi.stubEnv('QWEN_HOME', join(root, 'home'));
  vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
  vi.spyOn(KeychainTokenStorage.prototype, 'isAvailable').mockResolvedValue(
    false,
  );
  const managedExtensionsDir = join(root, 'deployment');
  const deployed = join(managedExtensionsDir, 'bundle');
  const workspace = join(root, 'workspace');
  await mkdir(managedExtensionsDir);
  await mkdir(workspace);
  const manifest = {
    name: 'managed-read-safety',
    version: '1.0.0',
    settings: [
      {
        name: 'Token',
        description: 'test token',
        envVar: 'TOKEN',
        sensitive: true,
      },
    ],
  };
  const user = join(Storage.getUserExtensionsDir(), manifest.name);
  const writePackage = async (directory: string) => {
    await mkdir(join(directory, 'skills', 'probe'), { recursive: true });
    await writeFile(
      join(directory, 'qwen-extension.json'),
      JSON.stringify(manifest),
    );
    await writeFile(
      join(directory, 'skills', 'probe', 'SKILL.md'),
      '---\nname: probe\ndescription: Read safety probe\n---\nTest body.\n',
    );
  };
  await writePackage(user);
  const controller = createExtensionsController({
    managedExtensionsDir,
    boundWorkspace: workspace,
    bridge: {} as AcpSessionBridge,
    workspace: {} as DaemonWorkspaceService,
    isWorkspaceTrusted: () => true,
  });
  const manager = controller.createExtensionManager(workspace, true);
  const store = new ExtensionStore();
  await manager.refreshCache();
  const original = manager.getLoadedExtensions()[0]!;
  expect(original.source).toBe('user');
  await store.setDefaultActivation(original, 'disabled');
  if (skills.user !== undefined) {
    await store.setSkillWorkspaceOverrides(
      original,
      workspace,
      { probe: skills.user },
      0,
    );
  }
  await writePackage(deployed);
  await manager.refreshCache();
  const managed = manager.getLoadedExtensions()[0]!;
  expect(managed.source).toBe('managed');
  await store.setDefaultActivation(managed, 'enabled');
  if (skills.managed !== undefined) {
    await store.setSkillWorkspaceOverrides(
      managed,
      workspace,
      { probe: skills.managed },
      0,
    );
  }
  await manager.refreshCache();
  expect(manager.getLoadedExtensions()[0]!.isActive).toBe(true);
  await updateSetting(
    manifest,
    managed.id,
    'TOKEN',
    async () => 'test-only-sentinel',
    ExtensionSettingScope.USER,
  );
  expect(await hasStoredExtensionSecrets(managed.name, managed.id)).toBe(true);
  await rm(deployed, { recursive: true });
  const diskPolicy = () =>
    store
      .readSnapshot()
      .then((snapshot) =>
        Object.values(snapshot.extensions).find(
          (policy) => policy.name === managed.name,
        ),
      );
  expect(await diskPolicy()).toMatchObject({
    managed: true,
    defaultActivation: 'enabled',
    preservedDefaultActivation: 'disabled',
  });
  return {
    managedExtensionsDir,
    workspace,
    user,
    controller,
    manager,
    store,
    managed,
    diskPolicy,
  };
}

describe('workspace managed extension reads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { read: 'status', mutation: 'runtime refresh' },
    { read: 'summary', mutation: 'runtime refresh' },
    { read: 'details', mutation: 'runtime refresh' },
    { read: 'catalog', mutation: 'runtime refresh' },
    { read: 'state', mutation: 'runtime refresh' },
    { read: 'skills', mutation: 'runtime refresh' },
    { read: 'source-revalidation', mutation: 'runtime refresh' },
    { read: 'catalog', mutation: 'controller uninstall' },
  ] as const)(
    'preserves managed secrets and user activation during a $read read before $mutation',
    async ({ read, mutation }) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'qwen-managed-reads-')),
      );
      try {
        const {
          managedExtensionsDir,
          workspace,
          user,
          controller,
          manager,
          store,
          managed,
          diskPolicy,
        } = await createManagedEpisode(root);
        if (read === 'status') {
          const status = await controller.buildLocalExtensionsStatus();
          expect(status.initialized).toBe(true);
          expect.soft(status.extensions).toEqual([
            expect.objectContaining({
              name: managed.name,
              extensionSource: 'user',
              isActive: false,
            }),
          ]);
        } else if (read === 'summary') {
          const status = await controller.buildLocalExtensionSummaries();
          expect(status.initialized).toBe(true);
          expect.soft(status.extensions).toEqual([
            expect.objectContaining({
              name: managed.name,
              extensionSource: 'user',
              isActive: false,
            }),
          ]);
          expect(status.extensions[0]).not.toHaveProperty('details');
        } else if (read === 'details') {
          const details = await controller.buildLocalExtensionDetails(
            managed.name,
          );
          expect.soft(details).toMatchObject({
            name: managed.name,
            extensionSource: 'user',
            isActive: false,
            details: { skills: ['probe'] },
          });
        } else if (read === 'catalog') {
          const catalog = await controller
            .createExtensionManager()
            .refreshCatalogSnapshot();
          expect(catalog.extensions).toEqual([
            expect.objectContaining({ name: managed.name, source: 'user' }),
          ]);
          expect
            .soft(
              store.getActivation(
                catalog.snapshot,
                catalog.extensions[0]!.id,
                managed.name,
                workspace,
              ).effective,
            )
            .toBe('disabled');
        } else if (read === 'state') {
          const stateManager = controller.createExtensionManager();
          await stateManager.refreshCacheWithSnapshot({
            allowManagedHandBack: false,
          });
          expect.soft(stateManager.getLoadedExtensions()).toEqual([
            expect.objectContaining({
              name: managed.name,
              source: 'user',
              isActive: false,
            }),
          ]);
        } else if (read === 'source-revalidation') {
          expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
          expect.soft(manager.getLoadedExtensions()).toEqual([
            expect.objectContaining({
              name: managed.name,
              source: 'user',
              isActive: false,
            }),
          ]);
        } else {
          const status = await createWorkspaceSkillsStatusProvider({
            managedExtensionsDir,
            workspaceTrusted: true,
          })(workspace);
          expect(status.initialized).toBe(true);
          expect.soft(status.skills).toContainEqual(
            expect.objectContaining({
              name: `${managed.name}:probe`,
              extensionName: managed.name,
              status: 'disabled',
              disabledReason: 'inactive_extension',
            }),
          );
        }
        expect
          .soft(await hasStoredExtensionSecrets(managed.name, managed.id))
          .toBe(true);
        expect.soft(await diskPolicy()).toMatchObject({
          managed: true,
          defaultActivation: 'enabled',
          preservedDefaultActivation: 'disabled',
        });
        const runtimeManager =
          mutation === 'controller uninstall'
            ? controller.createExtensionManager()
            : new ExtensionManager({
                managedExtensionsDir,
                workspaceDir: workspace,
                isWorkspaceTrusted: true,
              });
        await runtimeManager.refreshCache();
        expect(runtimeManager.getLoadedExtensions()[0]!.isActive).toBe(false);
        expect(await hasStoredExtensionSecrets(managed.name, managed.id)).toBe(
          false,
        );
        expect(await diskPolicy()).toMatchObject({
          defaultActivation: 'disabled',
        });
        expect(await diskPolicy()).not.toHaveProperty('managed');
        if (mutation === 'controller uninstall') {
          await runtimeManager.uninstallExtensionById(
            runtimeManager.getLoadedExtensions()[0]!.id,
            false,
            workspace,
          );
          await expect(access(user)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await diskPolicy()).toBeUndefined();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['/workspace/extensions/check-updates', '/extensions/check-updates'])(
    'preserves managed credentials and policy during HTTP %s',
    async (route) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'qwen-managed-update-check-')),
      );
      let app: ReturnType<typeof createServeApp> | undefined;
      try {
        const {
          managedExtensionsDir,
          workspace,
          managed,
          diskPolicy,
          manager,
        } = await createManagedEpisode(root);
        const before = await diskPolicy();
        const bridge = {
          permissionPolicy: 'first-responder',
          knownClientIds: () => new Set<string>(['client-1']),
          publishWorkspaceEvent: vi.fn(),
          broadcastExtensionsChanged: vi.fn(),
          listWorkspaceSessions: vi.fn(() => []),
          sessionCount: 0,
          activePromptCount: 0,
          pendingPromptTotal: 0,
          lastActivityAt: null,
        } as unknown as AcpSessionBridge;
        const refreshSessions = vi.fn(async () => ({
          refreshed: 0,
          failed: 0,
        }));
        const workspaceService = {
          invalidateWorkspaceSkillsStatus: vi.fn(),
          refreshExtensionsForAllSessions: refreshSessions,
        } as unknown as DaemonWorkspaceService;
        const registry = createWorkspaceRegistry([
          {
            workspaceId: 'primary-id',
            workspaceCwd: workspace,
            sessionRuntimeBaseDir: join(workspace, '.runtime'),
            primary: true,
            trusted: true,
            env: { mode: 'parent-process', overlayKeys: [] },
            bridge,
            workspaceService,
            routeFileSystemFactory: createWorkspaceFileSystemFactory({
              boundWorkspaces: [workspace],
              trusted: true,
              emit: () => {},
            }),
            clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
          },
        ]);
        app = createServeApp(
          {
            hostname: '127.0.0.1',
            port: 4198,
            mode: 'http-bridge',
            token: 'test-secret',
            workspace,
            managedExtensions: managedExtensionsDir,
          },
          undefined,
          { workspaceRegistry: registry },
        );
        const auth = (pending: request.Test) =>
          pending
            .set('Host', '127.0.0.1:4198')
            .set('Authorization', 'Bearer test-secret')
            .set('X-Qwen-Client-Id', 'client-1');
        const response = await auth(request(app).post(route));
        if (route === '/extensions/check-updates') {
          expect(response.status).toBe(202);
          await vi.waitFor(async () => {
            const operation = await auth(
              request(app!).get(
                `/extensions/operations/${response.body.operationId}`,
              ),
            );
            expect(operation.status).toBe(200);
            expect(operation.body).toMatchObject({
              status: 'succeeded',
              result: {
                status: 'checked',
                states: { [managed.name]: 'not updatable' },
              },
            });
          });
        } else {
          expect(response.status).toBe(200);
          expect(response.body.states).toEqual({
            [managed.name]: 'not updatable',
          });
        }
        expect
          .soft(await hasStoredExtensionSecrets(managed.name, managed.id))
          .toBe(true);
        expect.soft(await diskPolicy()).toEqual(before);
        expect(refreshSessions).not.toHaveBeenCalled();
        await manager.refreshCache();
        expect(await hasStoredExtensionSecrets(managed.name, managed.id)).toBe(
          false,
        );
        expect(await diskPolicy()).toMatchObject({
          defaultActivation: 'disabled',
        });
        expect(await diskPolicy()).not.toHaveProperty('managed');
      } finally {
        (
          app?.locals as
            | { stopExtensionGenerationReconciler?: () => void }
            | undefined
        )?.stopExtensionGenerationReconciler?.();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('allows queued activation to hand back even when runtime refresh is skipped', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'qwen-managed-queued-activation-')),
    );
    try {
      const { controller, managed, diskPolicy } =
        await createManagedEpisode(root);
      const responseBody = vi.fn();
      const response = {
        status: vi.fn().mockReturnThis(),
        location: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        json: responseBody,
      } as unknown as Response;
      controller.runQueuedExtensionMutation(
        'activation',
        { name: managed.name },
        response,
        async (manager) => {
          expect(manager.getLoadedExtensions()).toEqual([
            expect.objectContaining({ name: managed.name, source: 'user' }),
          ]);
          expect(
            await hasStoredExtensionSecrets(managed.name, managed.id),
          ).toBe(false);
          expect(await diskPolicy()).not.toHaveProperty('managed');
          await manager.setExtensionDefaultActivation(
            manager.getLoadedExtensions()[0]!.id,
            'enabled',
          );
          return { status: 'enabled', name: managed.name };
        },
        { skipRefresh: true },
      );
      const operationId = responseBody.mock.calls[0]![0].operationId as string;
      await vi.waitFor(() =>
        expect(controller.getOperation(operationId)).toMatchObject({
          status: 'succeeded',
          result: { status: 'enabled', name: managed.name },
        }),
      );
      expect(await hasStoredExtensionSecrets(managed.name, managed.id)).toBe(
        false,
      );
      expect(await diskPolicy()).toMatchObject({
        defaultActivation: 'enabled',
      });
      expect(await diskPolicy()).not.toHaveProperty('managed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { user: false, managed: true, expected: false },
    { user: undefined, managed: false, expected: null },
  ] as const)(
    'projects the user skill override $expected without consuming the managed override $managed',
    async ({ user, managed: managedOverride, expected }) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'qwen-managed-skill-reads-')),
      );
      try {
        const { controller, manager, workspace, store, managed, diskPolicy } =
          await createManagedEpisode(root, { user, managed: managedOverride });
        const before = await diskPolicy();
        const reader = controller.createExtensionManager();
        const snapshot = await reader.refreshCacheWithSnapshot({
          allowManagedHandBack: false,
        });
        const extension = reader.getLoadedExtensions()[0]!;
        expect
          .soft(
            reader.getExtensionSkillState(extension.id, 'probe', workspace)
              .workspaceEnabled,
          )
          .toBe(expected);
        expect
          .soft(
            store.getSkillWorkspaceOverride(
              snapshot,
              extension.id,
              workspace,
              'probe',
            ),
          )
          .toBe(expected);
        expect.soft(await diskPolicy()).toEqual(before);
        expect(await hasStoredExtensionSecrets(managed.name, managed.id)).toBe(
          true,
        );
        await manager.refreshCache();
        const returned = manager.getLoadedExtensions()[0]!;
        expect(
          manager.getExtensionSkillState(returned.id, 'probe', workspace)
            .workspaceEnabled,
        ).toBe(expected);
        expect(await hasStoredExtensionSecrets(managed.name, managed.id)).toBe(
          false,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
