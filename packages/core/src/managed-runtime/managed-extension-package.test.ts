/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parseManagedExtensionApplyCommand,
  parseManagedExtensionEffectiveBundle,
  parseManagedExtensionPin,
  parseManagedExtensionPins,
} from './managed-extension-package.js';
import { managedSessionInlineResourceBytes } from './http-managed-session-store.js';

const pin = {
  extensionId: 'reviewer',
  packageRevision: 2,
  packageDigest: 'a'.repeat(64),
};

describe('Managed extension pins', () => {
  it('copies and freezes the complete package and settings identity', () => {
    const input = { ...pin, settingsRevision: 3 };
    const parsed = parseManagedExtensionPin(input);
    input.packageRevision = 4;
    expect(parsed).toEqual({ ...pin, settingsRevision: 3 });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    { ...pin, packageRevision: 0 },
    { ...pin, packageRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...pin, packageDigest: 'A'.repeat(64) },
    { ...pin, extensionId: '../other-workspace' },
    { ...pin, settingsRevision: 0 },
    { ...pin, settings: { secret: 'must-not-be-in-a-pin' } },
  ])('rejects an invalid or non-public pin %j', (input) => {
    expect(() => parseManagedExtensionPin(input)).toThrow();
  });

  it('rejects duplicate identities instead of selecting the last version', () => {
    expect(() =>
      parseManagedExtensionPins([pin, { ...pin, packageRevision: 3 }]),
    ).toThrow(/duplicate/u);
    expect(parseManagedExtensionPins([])).toEqual([]);
  });
});

describe('Managed extension apply commands', () => {
  const command = {
    operationId: '11111111-1111-4111-8111-111111111111',
    actorKey: 'b'.repeat(64),
    expectedRevision: 0,
    extensions: [pin],
  };

  it('retains a complete replacement selection, including an empty one', () => {
    expect(parseManagedExtensionApplyCommand(command)).toEqual(command);
    expect(
      parseManagedExtensionApplyCommand({ ...command, extensions: [] })
        .extensions,
    ).toEqual([]);
  });

  it.each([
    { ...command, expectedRevision: -1 },
    { ...command, operationId: 'retry-with-new-operation' },
    { ...command, actorKey: '' },
    { ...command, force: true },
  ])('refuses invalid operation identity or revision %j', (input) => {
    expect(() => parseManagedExtensionApplyCommand(input)).toThrow();
  });

  it('charges only live MCP selections against the 32-entry capacity', () => {
    const server = (index: number, state: string) => ({
      serverId: `server-${index}`,
      serverRevision: 1,
      definitionDigest: 'c'.repeat(64),
      state,
    });
    const mcpChangeFor = (servers: unknown[]) => ({
      ...command,
      mcpChange: {
        action: 'add',
        serverId: 'server-0',
        expectedRevision: 0,
        servers,
      },
    });
    // 32 live + 1 tombstone: the tombstone does not count against the cap.
    const accepted = parseManagedExtensionApplyCommand(
      mcpChangeFor([
        ...Array.from({ length: 32 }, (_, index) => server(index, 'disabled')),
        server(32, 'removed'),
      ]),
    );
    expect(accepted.mcpChange?.servers).toHaveLength(33);
    // 33 live (all disabled, so the 16-enabled quota cannot fire): rejected.
    expect(() =>
      parseManagedExtensionApplyCommand(
        mcpChangeFor(
          Array.from({ length: 33 }, (_, index) => server(index, 'disabled')),
        ),
      ),
    ).toThrow(/MCP selection/);
  });

  it('bounds the retained MCP snapshot including tombstones', () => {
    const server = (index: number, state: string) => ({
      serverId: `server-${index}`,
      serverRevision: 1,
      definitionDigest: 'c'.repeat(64),
      state,
    });
    const mcpChangeFor = (servers: unknown[]) => ({
      ...command,
      mcpChange: {
        action: 'add',
        serverId: 'server-0',
        expectedRevision: 0,
        servers,
      },
    });
    const atTotal = parseManagedExtensionApplyCommand(
      mcpChangeFor([
        ...Array.from({ length: 32 }, (_, index) => server(index, 'disabled')),
        ...Array.from({ length: 64 }, (_, index) =>
          server(32 + index, 'removed'),
        ),
      ]),
    );
    expect(atTotal.mcpChange?.servers).toHaveLength(96);
    expect(() =>
      parseManagedExtensionApplyCommand(
        mcpChangeFor([
          ...Array.from({ length: 32 }, (_, index) =>
            server(index, 'disabled'),
          ),
          ...Array.from({ length: 65 }, (_, index) =>
            server(32 + index, 'removed'),
          ),
        ]),
      ),
    ).toThrow(/MCP selection/);
  });

  it('composes the retained snapshot once, inside the bundle byte limit', () => {
    const widestId = (prefix: string, index: number) =>
      `${prefix}${index}`.padEnd(128, 'x');
    const pin = (serverId: string) => ({
      serverId,
      serverRevision: 9_007_199_254_740_990,
      definitionDigest: 'a'.repeat(64),
    });
    const bundle = parseManagedExtensionEffectiveBundle({
      kind: 'managed-extension-config-bundle',
      formatVersion: 1,
      configRevision: 1,
      executionMode: 'linux-cgroup',
      mcpRevision: 1,
      independentMcpSelections: Array.from({ length: 96 }, (_, index) => ({
        ...pin(widestId(index < 32 ? 'live-' : 'removed-', index)),
        state: index === 0 ? 'enabled' : index < 32 ? 'disabled' : 'removed',
      })),
      baseMcpServers: Array.from({ length: 16 }, (_, index) =>
        pin(widestId('base-', index)),
      ),
      baseHookCatalog: null,
      packages: Array.from({ length: 32 }, (_, index) => ({
        pin: {
          extensionId: widestId('package-', index),
          packageRevision: 9_007_199_254_740_990,
          packageDigest: 'a'.repeat(64),
        },
        assetRoot: `extension://${widestId('package-', index)}/`,
        contributionsRef: {
          resourceId: widestId('contributions-', index),
          kind: 'managed-extension-contributions',
          schemaVersion: 1,
          byteLength: 4096,
          digest: 'a'.repeat(64),
        },
      })),
      mcpServers: Array.from({ length: 32 }, (_, index) =>
        pin(widestId('live-', index)),
      ),
      hookCatalog: null,
    });
    expect(JSON.stringify(bundle)).not.toContain('mcpChange');
    const bytes = Buffer.byteLength(JSON.stringify(bundle));
    expect(bytes).toBeLessThanOrEqual(
      managedSessionInlineResourceBytes('managed-extension-config-bundle'),
    );
  });
});
