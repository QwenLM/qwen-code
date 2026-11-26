/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  ManagedMcpResource,
  ManagedResourcesProvider,
} from './managedResources.js';
import {
  Config,
  MCPServerConfig,
  type ConfigParameters,
} from '../config/config.js';
import { stripScope, stripScopeFromServer } from './mcpServerScope.js';
import { PermissionManager } from '../permissions/manager/permission-manager.js';
import type { AskHandler } from '../permissions/manager/decision/index.js';
import type { ToolPermissionReason } from '../tools/tool-checkers/checker-reasons.js';
import type { SessionMcpManager } from '../mcp/sessionMcpManager/sessionMcpManager.js';
import { parseMcpToolName } from '../mcp/tools/mcp-names.js';

const baseParams: ConfigParameters = {
  loadedSettings: createEmptyLoadedSettings(),
  cwd: '/tmp',
  embeddingModel: 'embedding',
  targetDir: '/tmp',
  debugMode: false,
  question: '',
  userMemory: '',
  sessionId: 'mcp-source-test',
  model: 'qwen-max',
};

describe('Config MCP source buckets', () => {
  it('allows settings-backed sources by default and can disable them', () => {
    expect(new Config(baseParams).getMcpSettingsSourcesEnabled()).toBe(true);
    expect(
      new Config({
        ...baseParams,
        mcpSettingsSourcesEnabled: false,
      }).getMcpSettingsSourcesEnabled(),
    ).toBe(false);
  });

  it('getMcpServers returns the merged effective view (disk ∪ dynamic, dynamic wins)', () => {
    const config = new Config({
      ...baseParams,
      mcpServers: {
        'on-disk': new MCPServerConfig('disk-cmd'),
        shared: new MCPServerConfig('disk-shared'),
      },
    });

    config.setDynamicMcpServers({
      injected: new MCPServerConfig('dynamic-cmd'),
      shared: new MCPServerConfig('dynamic-shared'),
    });

    const merged = config.getMcpServers();
    expect(Object.keys(merged ?? {}).sort()).toEqual([
      'injected',
      'on-disk',
      'shared',
    ]);
    expect(merged?.['shared'].command).toBe('dynamic-shared');
    expect(merged?.['injected'].scope).toBe('dynamic');
    expect(merged?.['on-disk'].scope).toBeUndefined();
  });

  it('preserves hostEndpoint across disk and dynamic source tagging', () => {
    const config = new Config({
      ...baseParams,
      mcpServers: {
        disk: Object.assign(
          {
            command: 'disk-command',
          },
          {
            hostEndpoint: 'https://gateway.example/mcp/disk',
          },
        ),
      },
    });
    config.setDynamicMcpServers({
      dynamic: Object.assign(
        {
          url: 'https://provider.example/mcp',
        },
        {
          hostEndpoint: 'https://gateway.example/mcp/dynamic',
        },
      ),
    });

    expect(Reflect.get(config.getMcpServers()!['disk'], 'hostEndpoint')).toBe(
      'https://gateway.example/mcp/disk',
    );
    expect(config.getMcpServers()?.['dynamic']).toMatchObject({
      hostEndpoint: 'https://gateway.example/mcp/dynamic',
      scope: 'dynamic',
    });
    expect(stripScope(config.getDynamicMcpServers())['dynamic']).toEqual({
      url: 'https://provider.example/mcp',
      hostEndpoint: 'https://gateway.example/mcp/dynamic',
    });
  });

  it('getDiskMcpServers / getDynamicMcpServers are independently addressable', () => {
    const config = new Config({
      ...baseParams,
      mcpServers: { disk: new MCPServerConfig('disk-cmd') },
    });
    config.setDynamicMcpServers({ dyn: new MCPServerConfig('dyn-cmd') });

    expect(Object.keys(config.getDiskMcpServers() ?? {})).toEqual(['disk']);
    expect(Object.keys(config.getDynamicMcpServers())).toEqual(['dyn']);
  });

  it('setDiskMcpServers leaves the dynamic bucket untouched', () => {
    const config = new Config(baseParams);
    config.setDynamicMcpServers({ keepme: new MCPServerConfig('keep') });

    config.setDiskMcpServers({ ondisk: new MCPServerConfig('odisk') });
    expect(Object.keys(config.getDynamicMcpServers())).toEqual(['keepme']);
    expect(Object.keys(config.getDiskMcpServers() ?? {})).toEqual(['ondisk']);
  });

  it('setDynamicMcpServers stamps scope="dynamic" on every entry', () => {
    const config = new Config(baseParams);
    config.setDynamicMcpServers({
      a: new MCPServerConfig('a'),
      b: new MCPServerConfig('b'),
    });
    const dyn = config.getDynamicMcpServers();
    expect(dyn['a'].scope).toBe('dynamic');
    expect(dyn['b'].scope).toBe('dynamic');
  });

  it('returns undefined from getMcpServers when both buckets are empty', () => {
    const config = new Config(baseParams);
    expect(config.getMcpServers()).toBeUndefined();
  });
});

describe('Config managed MCP snapshots', () => {
  const resource: ManagedMcpResource = {
    id: 'connector-a',
    name: 'enterprise_a',
    originalName: 'docs',
    displayName: 'Docs',
    sourceId: 'identity-a',
    config: { command: 'enterprise-docs' },
    userVisible: true,
    userCanDisable: true,
    disabled: false,
  };
  function provider(
    resources: readonly ManagedMcpResource[],
  ): ManagedResourcesProvider {
    return {
      readSkills: vi.fn(async () => []),
      readMcpServers: vi.fn(async () => resources),
      setSkillEnabled: vi.fn(async () => {}),
      setMcpServerEnabled: vi.fn(async () => {}),
    };
  }

  it('suppresses ordinary original names without removing either source and restores them on withdrawal', async () => {
    const managed = provider([
      resource,
      { ...resource, id: 'connector-b', name: 'enterprise_b' },
    ]);
    const config = new Config({
      ...baseParams,
      managedResourcesProvider: managed,
      mcpServers: { docs: { command: 'disk-docs', disabled: true } },
    });
    config.setDynamicMcpServers({ docs: { command: 'dynamic-docs' } });
    await config.reloadManagedMcpServers();
    expect(Object.keys(config.getMcpServers()!)).toEqual([
      'enterprise_a',
      'enterprise_b',
    ]);
    expect(config.getDiskMcpServers()?.['docs'].disabled).toBe(true);
    expect(config.getDynamicMcpServers()['docs'].command).toBe('dynamic-docs');
    expect(config.getMcpServerPermissionAliases('enterprise_a')).toEqual([
      'enterprise_a',
      'docs',
    ]);
    vi.mocked(managed.readMcpServers).mockResolvedValue([]);
    await config.reloadManagedMcpServers();
    expect(config.getMcpServers()?.['docs'].command).toBe('dynamic-docs');
    expect(config.getMcpServerPermissionAliases('enterprise_a')).toEqual([
      'enterprise_a',
    ]);
  });

  it('does not read ambient enterprise MCP in strict mode', async () => {
    const managed = provider([resource]);
    const config = new Config({
      ...baseParams,
      managedResourcesProvider: managed,
      mcpSettingsSourcesEnabled: false,
    });
    config.setDynamicMcpServers({ explicit: { command: 'host-mcp' } });
    await config.reloadManagedMcpServers();
    expect(managed.readMcpServers).not.toHaveBeenCalled();
    expect(Object.keys(config.getMcpServers()!)).toEqual(['explicit']);
  });

  it('rejects reserved dynamic names without replacing the previous dynamic bucket', () => {
    const config = new Config(baseParams);
    config.setDynamicMcpServers({ keep: { command: 'keep' } });
    expect(() =>
      config.setDynamicMcpServers({ enterprise_forged: { command: 'fake' } }),
    ).toThrow();
    expect(Object.keys(config.getDynamicMcpServers())).toEqual(['keep']);
  });

  it('applies persistent preference and lock policy without overriding administrative disable', async () => {
    const managed = provider([{ ...resource, disabled: true }]);
    const config = new Config({
      ...baseParams,
      managedResourcesProvider: managed,
    });
    await config.reloadManagedMcpServers();
    expect(config.isServerEnabled(resource.name)).toBe(false);
    vi.mocked(managed.readMcpServers).mockResolvedValue([
      { ...resource, disabled: true, userCanDisable: false },
    ]);
    await config.reloadManagedMcpServers();
    expect(config.isServerEnabled(resource.name)).toBe(true);
    vi.mocked(managed.readMcpServers).mockResolvedValue([
      {
        ...resource,
        userCanDisable: false,
        config: { command: 'docs', disabled: true },
      },
    ]);
    await config.reloadManagedMcpServers();
    expect(config.isServerEnabled(resource.name)).toBe(false);
  });

  it.each([{ excludeTools: [] }, { excludeTools: ['Read'] }])(
    'skips MCP alias lookups without MCP exclusions: $excludeTools',
    ({ excludeTools }) => {
      const config = new Config({ ...baseParams, excludeTools });
      const aliases = vi.spyOn(config, 'getMcpServerPermissionAliases');
      expect(
        config.getExcludeTools(
          undefined,
          new Set(['mcp__enterprise_a__search', 'Read']),
        ),
      ).toEqual(new Set(excludeTools));
      expect(aliases).not.toHaveBeenCalled();
    },
  );

  it('expands original-name catalog exclusions using the current managed mapping', async () => {
    const managed = provider([
      resource,
      { ...resource, id: 'connector-b', name: 'enterprise_b' },
    ]);
    const config = new Config({
      ...baseParams,
      managedResourcesProvider: managed,
      excludeTools: ['mcp__docs__search'],
    });
    await config.reloadManagedMcpServers();
    const names = new Set([
      'mcp__enterprise_a__search',
      'mcp__enterprise_b__search',
      'mcp__enterprise_a__read',
    ]);
    expect(config.getExcludeTools(undefined, names)).toEqual(
      new Set([
        'mcp__docs__search',
        'mcp__enterprise_a__search',
        'mcp__enterprise_b__search',
      ]),
    );
    vi.mocked(managed.readMcpServers).mockResolvedValue([]);
    await config.reloadManagedMcpServers();
    expect(config.getExcludeTools(undefined, names)).toEqual(
      new Set(['mcp__docs__search']),
    );
  });
});

describe('Config lazy MCP global permission chain', () => {
  const resource: ManagedMcpResource = {
    id: 'connector-a',
    name: 'enterprise_a',
    originalName: 'docs',
    displayName: 'Docs',
    sourceId: 'identity-a',
    config: { command: 'enterprise-docs' },
    userVisible: true,
    userCanDisable: true,
    disabled: false,
  };
  const target = 'mcp__enterprise_a__echo';
  const otherTarget = 'mcp__enterprise_b__echo';

  async function setup(
    manager: PermissionManager,
    resources: readonly ManagedMcpResource[],
    rules: { allow: string[]; deny?: string[]; ask?: string[] },
  ) {
    const managed: ManagedResourcesProvider = {
      readSkills: vi.fn(async () => []),
      readMcpServers: vi.fn(async () => resources),
      setSkillEnabled: vi.fn(async () => {}),
      setMcpServerEnabled: vi.fn(async () => {}),
    };
    const config = new Config({
      ...baseParams,
      sessionId: resources[0]?.sourceId ?? 'ordinary-mcp-session',
      permissionManager: manager,
      managedResourcesProvider: managed,
      allowedTools: rules.allow,
      disallowedTools: rules.deny,
      mcpServers: { ordinary: { command: 'ordinary-docs' } },
      mcpLazyLoad: true,
    });
    await config.reloadManagedMcpServers();
    config.initPermission();
    const permission = config.permission!;
    if (rules.ask) {
      permission.setRules({
        allow: { cliArg: rules.allow },
        deny: { cliArg: rules.deny ?? [] },
        ask: { userSettings: rules.ask },
      });
    }
    permission.setSessionMcpManager({
      getLazyDiscoveredMcpToolByQualifiedName: (name: string) => {
        const parsed = parseMcpToolName(name);
        return parsed.serverName &&
          parsed.toolName === 'echo' &&
          config.getMcpServers()?.[parsed.serverName]
          ? { qualifiedName: name }
          : undefined;
      },
      onToolListChange: () => () => {},
      getInjectedMcpTools: () => ({ tools: [] }),
    } as unknown as SessionMcpManager);
    return {
      config,
      managed,
      permission,
      check: (name = target) =>
        permission.check({
          toolName: 'mcp_call',
          input: { toolName: name, arguments: {} },
          toolUseId: `lazy-${name}`,
        }),
    };
  }

  it.each(['mcp__docs__echo', 'mcp__docs__*'])(
    'original-name deny %s overrides canonical allow for both same-name connectors',
    async (rule) => {
      const manager = new PermissionManager();
      manager.initialize();
      const s = await setup(
        manager,
        [resource, { ...resource, id: 'connector-b', name: 'enterprise_b' }],
        {
          allow: [target, otherTarget],
          deny: [rule],
          ask: ['mcp__docs__*'],
        },
      );
      const handler = vi.fn<AskHandler<ToolPermissionReason>>(async () => ({
        kind: 'approved',
      }));
      s.permission.setAskHandler(handler);
      try {
        expect((await s.check()).kind).toBe('deny');
        expect((await s.check(otherTarget)).kind).toBe('deny');
        expect(handler).not.toHaveBeenCalled();
      } finally {
        await s.config.dispose();
        manager.dispose();
      }
    },
  );

  it.each(['mcp__docs__echo', 'mcp__docs__*'])(
    'original-name ask %s overrides canonical allow and identifies the canonical target',
    async (rule) => {
      const manager = new PermissionManager();
      manager.initialize();
      const s = await setup(manager, [resource], {
        allow: [target],
        ask: [rule],
      });
      const handler = vi.fn<AskHandler<ToolPermissionReason>>(async () => ({
        kind: 'approved',
      }));
      s.permission.setAskHandler(handler);
      try {
        expect((await s.check()).kind).toBe('allow');
        expect(handler).toHaveBeenCalledOnce();
        expect(handler.mock.calls[0][0].toolCheckResult).toMatchObject({
          kind: 'ask',
          reason: { message: expect.stringContaining(target) },
        });
      } finally {
        await s.config.dispose();
        manager.dispose();
      }
    },
  );

  it.each(['deny', 'ask'] as const)(
    'canonical %s still overrides original-name allow',
    async (behavior) => {
      const manager = new PermissionManager();
      manager.initialize();
      const s = await setup(manager, [resource], {
        allow: ['mcp__docs__*'],
        [behavior]: [target],
      });
      const handler = vi.fn<AskHandler<ToolPermissionReason>>(async () => ({
        kind: 'approved',
      }));
      s.permission.setAskHandler(handler);
      try {
        expect((await s.check()).kind).toBe(
          behavior === 'deny' ? 'deny' : 'allow',
        );
        expect(handler).toHaveBeenCalledTimes(behavior === 'deny' ? 0 : 1);
      } finally {
        await s.config.dispose();
        manager.dispose();
      }
    },
  );

  it('reads each session mapping independently from the same global checker table', async () => {
    const manager = new PermissionManager();
    manager.initialize();
    const rules = { allow: [target], deny: ['mcp__docs__*'] };
    const a = await setup(manager, [resource], rules);
    const b = await setup(
      manager,
      [{ ...resource, originalName: 'search', sourceId: 'identity-b' }],
      rules,
    );
    try {
      expect((await a.check()).kind).toBe('deny');
      expect((await b.check()).kind).toBe('allow');
      expect((await a.check()).kind).toBe('deny');
    } finally {
      await a.config.dispose();
      await b.config.dispose();
      manager.dispose();
    }
  });

  it('does not expand one canonical connector grant to another with the same original name', async () => {
    const manager = new PermissionManager();
    manager.initialize();
    const s = await setup(
      manager,
      [resource, { ...resource, id: 'connector-b', name: 'enterprise_b' }],
      { allow: [target] },
    );
    const handler = vi.fn<AskHandler<ToolPermissionReason>>(async () => ({
      kind: 'rejected',
    }));
    s.permission.setAskHandler(handler);
    try {
      expect((await s.check()).kind).toBe('allow');
      expect(handler).not.toHaveBeenCalled();
      expect((await s.check(otherTarget)).kind).toBe('deny');
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].toolCheckResult).toMatchObject({
        kind: 'ask',
        suggestions: [
          expect.objectContaining({ rules: [{ toolName: otherTarget }] }),
          expect.objectContaining({
            rules: [{ toolName: 'mcp__enterprise_b__*' }],
          }),
        ],
      });
    } finally {
      await s.config.dispose();
      manager.dispose();
    }
  });

  it('uses reloaded mappings and refuses withdrawn targets without affecting ordinary MCP', async () => {
    const manager = new PermissionManager();
    manager.initialize();
    const s = await setup(manager, [resource], {
      allow: ['mcp__*'],
      deny: ['mcp__docs__*'],
    });
    try {
      expect((await s.check()).kind).toBe('deny');
      vi.mocked(s.managed.readMcpServers).mockResolvedValue([
        { ...resource, name: 'enterprise_c', originalName: 'search' },
      ]);
      await s.config.reloadManagedMcpServers();
      expect((await s.check()).kind).toBe('deny');
      expect((await s.check('mcp__enterprise_c__echo')).kind).toBe('allow');
      expect((await s.check('mcp__ordinary__echo')).kind).toBe('allow');
      vi.mocked(s.managed.readMcpServers).mockResolvedValue([]);
      await s.config.reloadManagedMcpServers();
      expect((await s.check('mcp__enterprise_c__echo')).kind).toBe('deny');
      expect((await s.check('mcp__ordinary__echo')).kind).toBe('allow');
    } finally {
      await s.config.dispose();
      manager.dispose();
    }
  });
});

describe('stripScope', () => {
  it('removes the scope field without mutating the input or other fields', () => {
    const tagged = {
      a: { command: 'a', scope: 'project' } as MCPServerConfig,
      b: { command: 'b', scope: 'dynamic' } as MCPServerConfig,
    };

    const stripped = stripScope(tagged);
    expect(stripped['a']).toEqual({ command: 'a' });
    expect(stripped['b']).toEqual({ command: 'b' });
    // input untouched
    expect(tagged['a'].scope).toBe('project');
  });

  it('stripScopeFromServer is a no-op when scope is absent', () => {
    const cfg = { command: 'a' } as MCPServerConfig;
    expect(stripScopeFromServer(cfg)).toBe(cfg);
  });
});


describe('managed MCP targeted refresh and ordering', () => {
  const a: ManagedMcpResource = {
    id: 'a', name: 'enterprise_a', sourceId: 'org-user-a', originalName: 'docs', displayName: 'Docs',
    config: { command: 'v1' }, userVisible: true, userCanDisable: true, disabled: false,
  };
  const b = { ...a, id: 'b', name: 'enterprise_b', sourceId: 'org-user-b', originalName: 'search' };
  function setup(initial: readonly ManagedMcpResource[] = [a, b]) {
    let generation = 'org-user:1';
    let read = async () => initial;
    const provider: ManagedResourcesProvider = {
      getIdentityGeneration: () => generation, readSkills: async () => [], readMcpServers: () => read(),
      setMcpServerEnabled: async () => {}, setSkillEnabled: async () => {},
    };
    const config = new Config({ ...baseParams, managedResourcesProvider: provider, mcpServers: { docs: { command: 'ordinary' } } });
    return { config, setRead: (next: typeof read) => { read = next; }, generation: (next: string) => { generation = next; } };
  }
  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  it('discards every previous-identity resource on a targeted refresh', async () => {
    const s = setup();
    s.config.setDiskMcpServers({ docs: { command: 'ordinary-docs' }, search: { command: 'ordinary-search' } });
    await s.config.reloadManagedMcpServers();
    s.generation('org-other-user:2');
    const nextA = { ...a, sourceId: 'org-other-user-a', config: { command: 'new-account' } };
    s.setRead(async () => [nextA]);
    const scope = await s.config.reloadManagedMcpServers({ managedTargets: [nextA] });
    expect(scope).toEqual(expect.arrayContaining([a.name, b.name, 'docs', 'search']));
    expect(s.config.getManagedMcpServers()).toEqual([nextA]);
    expect(s.config.getMcpServers()?.['search'].command).toBe('ordinary-search');
    expect(s.config.getMcpServerPermissionAliases(b.name)).toEqual([b.name]);
    await s.config.dispose();
  });

  it('updates only A and its permission aliases when independent A and B both change', async () => {
    const s = setup();
    await s.config.reloadManagedMcpServers();
    s.setRead(async () => [{ ...a, config: { command: 'v2' } }, { ...b, config: { command: 'v2' }, disabled: true, originalName: 'renamed' }]);
    const targets = await s.config.reloadManagedMcpServers({ serverNames: [a.name] });
    expect(targets).toEqual([a.name, a.originalName]);
    expect(s.config.getManagedMcpServer(a.name)?.config.command).toBe('v2');
    expect(s.config.getManagedMcpServer(b.name)).toBe(b);
    expect(s.config.getMcpServerPermissionAliases(b.name)).toEqual([b.name, b.originalName]);
    await s.config.dispose();
  });

  it('supports unseen additions and withdrawal, restores ordinary names, and skips unrelated sessions', async () => {
    const s = setup([]);
    await s.config.reloadManagedMcpServers();
    s.setRead(async () => [a]);
    expect(await s.config.reloadManagedMcpServers({ managedTargets: [a] })).toEqual([a.name, a.originalName]);
    expect(s.config.getMcpServers()?.['docs']).toBeUndefined();
    s.setRead(async () => []);
    expect(await s.config.reloadManagedMcpServers({ managedTargets: [a] })).toEqual([a.name, a.originalName]);
    expect(s.config.getMcpServers()?.['docs'].command).toBe('ordinary');
    const untouched = vi.fn(async () => {});
    expect(await s.config.reloadManagedMcpServers({ managedTargets: [a], beforeReload: untouched })).toEqual([]);
    expect(untouched).not.toHaveBeenCalled();
    await s.config.dispose();
  });

  it('keeps ordinary MCP shadowed when another enterprise item still covers the same name', async () => {
    const other = { ...b, originalName: 'docs' };
    const s = setup([a, other]); await s.config.reloadManagedMcpServers();
    s.setRead(async () => [other]);
    expect(await s.config.reloadManagedMcpServers({ managedTargets: [a] })).toEqual([a.name, 'docs', b.name]);
    expect(s.config.getMcpServers()?.['docs']).toBeUndefined();
    expect(s.config.getManagedMcpServer(b.name)).toBe(other);
    await s.config.dispose();
  });

  it('queues candidate reads until the previous refresh actually finishes', async () => {
    const s = setup(); await s.config.reloadManagedMcpServers();
    const entered = barrier(); const blocked = barrier(); let reads = 0;
    s.setRead(async () => { reads++; if (reads === 1) { entered.release(); await blocked.promise; return [{ ...a, config: { command: 'v2' } }]; } return [{ ...a, config: { command: 'v3' } }]; });
    const first = s.config.reloadManagedMcpServers({ managedTargets: [a] }); await entered.promise;
    const second = s.config.reloadManagedMcpServers({ serverNames: [a.name] });
    await Promise.resolve(); expect(reads).toBe(1);
    blocked.release(); await Promise.all([first, second]);
    expect(s.config.getManagedMcpServer(a.name)?.config.command).toBe('v3');
    await s.config.dispose();
  });

  it('does not commit an in-flight stale identity or poison subsequent refreshes', async () => {
    const s = setup(); await s.config.reloadManagedMcpServers();
    const entered = barrier(); const blocked = barrier();
    s.setRead(async () => { entered.release(); await blocked.promise; return [{ ...a, config: { command: 'stale' } }]; });
    const first = s.config.reloadManagedMcpServers({ managedTargets: [a] }); await entered.promise;
    s.generation('org-user:2'); blocked.release();
    await expect(first).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
    expect(s.config.getManagedMcpServer(a.name)).toBe(a);
    s.setRead(async () => []); await s.config.reloadManagedMcpServers();
    expect(s.config.getManagedMcpServers()).toEqual([]);
    await s.config.dispose();
  });
});
