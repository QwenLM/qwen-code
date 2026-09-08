import { describe, expect, it } from 'vitest';
import type {
  DaemonExtensionEntry,
  ExtensionCatalogEntry,
} from '@qwen-code/sdk/daemon';
import {
  filterExtensions,
  extensionSnapshotsCurrent,
  isUninstallNoOpResult,
  mergeExtensionCatalog,
  preserveSelectedExtensionName,
} from './extensions-manager-logic';

function extension(
  name: string,
  displayName?: string,
  description?: string,
): DaemonExtensionEntry {
  return {
    kind: 'extension',
    id: name,
    name,
    displayName,
    description,
    version: '1.0.0',
    isActive: true,
    path: `/tmp/${name}`,
    capabilities: {
      mcpServerCount: 0,
      skillCount: 0,
      agentCount: 0,
      hookCount: 0,
      commandCount: 0,
      contextFileCount: 0,
      channelCount: 0,
      hasSettings: false,
    },
  };
}

describe('extensions manager logic', () => {
  const extensions = [
    extension('gsd-core', 'GSD Core', 'Spec-driven development'),
    extension('browser-tools', 'Browser Tools', 'Browser automation'),
  ];

  it('filters by name, display name, and description', () => {
    expect(filterExtensions(extensions, 'gsd-core')).toEqual([extensions[0]]);
    expect(filterExtensions(extensions, 'Core')).toEqual([extensions[0]]);
    expect(filterExtensions(extensions, 'automation')).toEqual([extensions[1]]);
  });

  it('returns all extensions for an empty query', () => {
    expect(filterExtensions(extensions, '')).toEqual(extensions);
  });

  it('treats only an undefined uninstall result as a completed no-op', () => {
    // DELETE /extensions/:extensionId answers 204 (undefined) when the listed
    // extension has no removable user-store policy — the page must report a
    // finished no-op, never a queued operation that will never be polled.
    expect(isUninstallNoOpResult(undefined, 'uninstall')).toBe(true);
    expect(isUninstallNoOpResult(undefined, 'update')).toBe(false);
    expect(isUninstallNoOpResult(undefined, undefined)).toBe(false);
    expect(isUninstallNoOpResult(null, 'uninstall')).toBe(false);
    expect(
      isUninstallNoOpResult(
        { accepted: true, operationId: 'op-1' },
        'uninstall',
      ),
    ).toBe(false);
  });

  it('keeps a selected extension only while it remains installed', () => {
    expect(preserveSelectedExtensionName('gsd-core', extensions)).toBe(
      'gsd-core',
    );
    expect(preserveSelectedExtensionName('removed', extensions)).toBeNull();
    expect(preserveSelectedExtensionName(null, extensions)).toBeNull();
  });

  it('accepts the original minimal catalog entry shape', () => {
    const configured: ExtensionCatalogEntry = {
      id: 'demo',
      name: 'demo',
      version: '1.0.0',
      defaultActivation: 'enabled',
      workspaceOverrideCount: 0,
    };

    expect(
      mergeExtensionCatalog([configured], null, undefined, undefined),
    ).toMatchObject([configured]);
  });

  it('uses live details only for a converged current runtime epoch', () => {
    const configured = {
      ...extension('demo'),
      isActive: false,
      updateState: 'update available' as const,
      details: {
        mcpServers: [],
        commands: [],
        skills: [],
        agents: [],
        contextFiles: [],
        settings: [],
      },
    };
    const activation = {
      v: 1 as const,
      workspaceId: 'ws-a',
      workspaceCwd: '/work/a',
      trusted: true,
      desiredGeneration: 2,
      appliedGeneration: 2,
      extensions: [
        {
          extensionId: 'demo',
          name: 'demo',
          version: '1.0.0',
          defaultActivation: 'enabled' as const,
          workspaceActivation: null,
          effectiveActivation: 'enabled' as const,
          activationSource: 'default' as const,
        },
      ],
    };
    const runtime = {
      v: 1 as const,
      workspaceCwd: '/work/a',
      initialized: true,
      runtimeEpoch: 4,
      extensions: [
        {
          ...configured,
          isActive: true,
          details: {
            ...configured.details,
            skills: ['runtime-skill'],
          },
        },
      ],
    };
    const coordinator = {
      v: 1 as const,
      workspaceCwd: '/work/a',
      state: 'idle' as const,
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        extensions: {
          state: 'ready' as const,
          revision: 1,
          runtimeEpoch: 4,
          desiredGeneration: 2,
          appliedGeneration: 2,
        },
      },
    };

    expect(
      mergeExtensionCatalog(
        [configured],
        activation,
        runtime,
        coordinator,
        2,
      )[0],
    ).toMatchObject({
      isActive: true,
      updateState: 'update available',
      workspaceActivation: 'inherit',
      details: { skills: ['runtime-skill'] },
    });

    const catalogEntry: ExtensionCatalogEntry = {
      id: configured.id,
      name: configured.name,
      version: configured.version,
      defaultActivation: 'enabled',
      workspaceOverrideCount: 0,
    };
    expect(
      mergeExtensionCatalog(
        [catalogEntry],
        activation,
        runtime,
        coordinator,
        2,
      )[0]?.updateState,
    ).toBe('update available');

    expect(
      mergeExtensionCatalog(
        [configured],
        activation,
        { ...runtime, runtimeEpoch: 3 },
        coordinator,
        2,
      )[0],
    ).toMatchObject({
      isActive: true,
      details: { skills: [] },
    });

    expect(extensionSnapshotsCurrent(1, activation, runtime, coordinator)).toBe(
      false,
    );
    // A lagging projection (appliedGeneration behind the catalog) no longer
    // drops the live rows: the runtime agrees with the coordinator on the
    // current epoch, so its rows are still overlaid; only the projection's
    // own activation terms stay generation-gated.
    expect(
      mergeExtensionCatalog(
        [configured],
        {
          ...activation,
          appliedGeneration: 0,
          extensions: [
            {
              ...activation.extensions[0]!,
              workspaceActivation: 'disabled',
              effectiveActivation: 'disabled',
              activationSource: 'workspace',
            },
          ],
        },
        runtime,
        coordinator,
        2,
      )[0],
    ).toMatchObject({
      isActive: true,
      workspaceActivation: 'disabled',
      details: { skills: ['runtime-skill'] },
    });
    // A catalog a generation behind the projection likewise keeps the live
    // rows; the projection terms drop out because its generation disagrees.
    expect(
      mergeExtensionCatalog(
        [configured],
        activation,
        runtime,
        coordinator,
        1,
      )[0],
    ).toMatchObject({
      isActive: true,
      details: { skills: ['runtime-skill'] },
    });
  });

  it('keeps the live runtime rows when the projection is unavailable', () => {
    const catalogEntry: ExtensionCatalogEntry = {
      id: 'demo',
      name: 'demo',
      version: '1.0.0',
      defaultActivation: 'enabled',
      workspaceOverrideCount: 0,
    };
    const runtimeEntry = {
      ...extension('demo', 'Demo Display Name', 'live runtime description'),
      isActive: false,
      updateState: 'update available' as const,
      details: {
        mcpServers: [],
        commands: [],
        skills: ['runtime-skill'],
        agents: [],
        contextFiles: [],
        settings: [],
      },
    };
    const runtime = {
      v: 1 as const,
      workspaceCwd: '/work/a',
      initialized: true,
      runtimeEpoch: 4,
      extensions: [runtimeEntry],
    };
    const coordinator = {
      v: 1 as const,
      workspaceCwd: '/work/a',
      state: 'idle' as const,
      runtimeLive: true,
      runtimeEpoch: 4,
      capabilities: {
        extensions: {
          state: 'ready' as const,
          revision: 1,
          runtimeEpoch: 4,
          desiredGeneration: 2,
          appliedGeneration: 2,
        },
      },
    };

    // The projection read failed (null): the merge must still keep the
    // runtime's isActive/details/updateState instead of degrading to the
    // bare durable catalog entry.
    expect(
      mergeExtensionCatalog([catalogEntry], null, runtime, coordinator, 2)[0],
    ).toMatchObject({
      isActive: false,
      displayName: 'Demo Display Name',
      updateState: 'update available',
      details: { skills: ['runtime-skill'] },
    });

    // Without a coordinator there is no epoch to agree on, so the live rows
    // stay dropped.
    expect(
      mergeExtensionCatalog([catalogEntry], null, runtime, undefined, 2)[0],
    ).toMatchObject({
      id: 'demo',
      workspaceOverrideCount: 0,
    });
    expect(
      mergeExtensionCatalog([catalogEntry], null, runtime, undefined, 2)[0]
        ?.isActive,
    ).toBeUndefined();
  });
});
