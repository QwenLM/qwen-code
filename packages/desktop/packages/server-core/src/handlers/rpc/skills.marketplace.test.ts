import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  RPC_CHANNELS,
  type SkillMarketplaceItem,
} from '@craft-agent/shared/protocol';
import type {
  HandlerFn,
  RequestContext,
  RpcServer,
} from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';

const mockGetWorkspaceByNameOrId = mock((workspaceId?: string) => ({
  id: workspaceId ?? 'workspace-1',
  rootPath: `/tmp/${workspaceId ?? 'workspace-1'}`,
}));

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: mockGetWorkspaceByNameOrId,
}));

import { registerSkillsHandlers } from './skills';

function createTestHarness(workspaceId = 'workspace-1') {
  const handlers = new Map<string, HandlerFn>();
  const pushCalls: Array<{
    channel: string;
    target: unknown;
    args: unknown[];
  }> = [];
  const refreshAvailableCommands = mock(async () => ({
    success: true,
    availableCommands: [{ name: 'old:command' }],
    availableSkills: ['old-skill'],
  }));
  const installQwenSkill = mock(async () => ({
    success: true,
    skill: {
      id: 'bailian-cli',
      slug: 'bailian-cli',
      installed: true,
    },
    availableCommands: [{ name: 'old:command' }],
    availableSkills: ['old-skill'],
  }));
  const deleteQwenSkill = mock(async () => ({
    success: true,
    skill: {
      slug: 'bailian-cli',
      deleted: true,
    },
    availableCommands: [{ name: 'old:command' }],
    availableSkills: ['old-skill'],
  }));

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    push(channel, target, ...args) {
      pushCalls.push({ channel, target, args });
    },
    async invokeClient() {
      return undefined;
    },
  };

  const deps: HandlerDeps = {
    sessionManager: {
      refreshAvailableCommands,
      installQwenSkill,
      deleteQwenSkill,
    } as unknown as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  };

  registerSkillsHandlers(server, deps);

  const listMarketplace = handlers.get(RPC_CHANNELS.skills.MARKETPLACE_LIST);
  const installMarketplace = handlers.get(
    RPC_CHANNELS.skills.MARKETPLACE_INSTALL,
  );
  const deleteSkill = handlers.get(RPC_CHANNELS.skills.DELETE);
  if (!listMarketplace || !installMarketplace || !deleteSkill) {
    throw new Error('Marketplace skill handlers not registered');
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId,
    webContentsId: 101,
  };

  return {
    ctx,
    listMarketplace,
    installMarketplace,
    deleteSkill,
    deleteQwenSkill,
    installQwenSkill,
    pushCalls,
    refreshAvailableCommands,
  };
}

describe('registerSkillsHandlers marketplace', () => {
  beforeEach(() => {
    mockGetWorkspaceByNameOrId.mockClear();
  });

  it('keeps an installed marketplace skill marked installed when discovery is stale', async () => {
    const {
      ctx,
      listMarketplace,
      installMarketplace,
      installQwenSkill,
      pushCalls,
    } = createTestHarness('workspace-stale-install');

    const beforeInstall = (await listMarketplace(
      ctx,
      'workspace-stale-install',
      '/tmp/workspace-stale-install',
      'session-1',
    )) as SkillMarketplaceItem[];
    expect(
      beforeInstall.find((skill) => skill.id === 'bailian-cli')?.installed,
    ).toBe(false);

    await installMarketplace(
      ctx,
      'workspace-stale-install',
      'bailian-cli',
      '/tmp/workspace-stale-install',
      'session-1',
    );

    const afterInstall = (await listMarketplace(
      ctx,
      'workspace-stale-install',
      '/tmp/workspace-stale-install',
      'session-1',
    )) as SkillMarketplaceItem[];

    expect(installQwenSkill).toHaveBeenCalled();
    const changed = pushCalls.find(
      (call) => call.channel === RPC_CHANNELS.skills.CHANGED,
    );
    const pushedSkills = changed?.args[1] as
      | Array<{ slug: string }>
      | undefined;
    expect(pushedSkills?.some((skill) => skill.slug === 'bailian-cli')).toBe(
      true,
    );
    expect(
      afterInstall.find((skill) => skill.id === 'bailian-cli')?.installed,
    ).toBe(true);
  });

  it('clears the installed override after deleting the skill', async () => {
    const { ctx, listMarketplace, installMarketplace, deleteSkill } =
      createTestHarness('workspace-delete');

    await installMarketplace(
      ctx,
      'workspace-delete',
      'bailian-cli',
      '/tmp/workspace-delete',
      'session-1',
    );

    await deleteSkill(
      ctx,
      'workspace-delete',
      'bailian-cli',
      '/tmp/workspace-delete',
      'session-1',
    );

    const afterDelete = (await listMarketplace(
      ctx,
      'workspace-delete',
      '/tmp/workspace-delete',
      'session-1',
    )) as SkillMarketplaceItem[];

    expect(
      afterDelete.find((skill) => skill.id === 'bailian-cli')?.installed,
    ).toBe(false);
  });
});
