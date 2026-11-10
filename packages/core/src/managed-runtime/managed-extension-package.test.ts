/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parseManagedExtensionApplyCommand,
  parseManagedExtensionPin,
  parseManagedExtensionPins,
} from './managed-extension-package.js';

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
        ...Array.from({ length: 192 }, (_, index) =>
          server(32 + index, 'removed'),
        ),
      ]),
    );
    expect(atTotal.mcpChange?.servers).toHaveLength(224);
    expect(() =>
      parseManagedExtensionApplyCommand(
        mcpChangeFor([
          ...Array.from({ length: 32 }, (_, index) =>
            server(index, 'disabled'),
          ),
          ...Array.from({ length: 193 }, (_, index) =>
            server(32 + index, 'removed'),
          ),
        ]),
      ),
    ).toThrow(/MCP selection/);
  });
});
