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

const pin = {
  extensionId: 'reviewer',
  packageRevision: 2,
  packageDigest: 'a'.repeat(64),
};
const authBinding = {
  serverId: 'reviewer:tools',
  credentialId: 'mcred_11111111-1111-4111-8111-111111111111',
  credentialGeneration: 2,
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

  it('copies and freezes v2 personal references while permitting explicit removal', () => {
    const input = {
      ...command,
      selectionVersion: 2,
      mcpAuthBindings: [{ ...authBinding }],
    };
    const parsed = parseManagedExtensionApplyCommand(input);
    input.mcpAuthBindings[0].credentialGeneration = 3;
    input.mcpAuthBindings.length = 0;
    expect(parsed).toEqual({
      ...command,
      selectionVersion: 2,
      mcpAuthBindings: [authBinding],
    });
    expect(Object.isFrozen(parsed.mcpAuthBindings)).toBe(true);
    expect(Object.isFrozen(parsed.mcpAuthBindings![0])).toBe(true);
    expect(
      parseManagedExtensionApplyCommand({
        ...command,
        selectionVersion: 2,
        mcpAuthBindings: [],
      }).mcpAuthBindings,
    ).toEqual([]);
  });

  it.each([
    { mcpAuthBindings: [authBinding] },
    { selectionVersion: 1, mcpAuthBindings: [authBinding] },
    { selectionVersion: 2 },
    { selectionVersion: 3, mcpAuthBindings: [] },
  ])('refuses unversioned or incomplete personal selections %j', (fields) => {
    expect(() =>
      parseManagedExtensionApplyCommand({ ...command, ...fields }),
    ).toThrow();
  });

  it.each([
    { ...authBinding, credentialGeneration: 0 },
    { ...authBinding, credentialGeneration: -1 },
    { ...authBinding, credentialGeneration: 1.5 },
    { ...authBinding, credentialGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...authBinding, credentialId: 'another-credential-format' },
    { ...authBinding, serverId: '../another-workspace' },
    { ...authBinding, accessToken: 'must-never-enter-a-selection' },
  ])('rejects invalid or secret-bearing personal references %j', (binding) => {
    expect(() =>
      parseManagedExtensionApplyCommand({
        ...command,
        selectionVersion: 2,
        mcpAuthBindings: [binding],
      }),
    ).toThrow();
  });

  it('rejects duplicate server bindings and malformed v2 execution actors', () => {
    const personal = {
      ...command,
      selectionVersion: 2,
      mcpAuthBindings: [authBinding],
    };
    expect(() =>
      parseManagedExtensionApplyCommand({
        ...personal,
        mcpAuthBindings: [
          authBinding,
          { ...authBinding, credentialGeneration: 3 },
        ],
      }),
    ).toThrow();
    for (const actorKey of ['actor', 'A'.repeat(64), 'b'.repeat(63)]) {
      expect(() =>
        parseManagedExtensionApplyCommand({ ...personal, actorKey }),
      ).toThrow();
    }
  });

  it.each([
    { ...command, expectedRevision: -1 },
    { ...command, operationId: 'retry-with-new-operation' },
    { ...command, actorKey: '' },
    { ...command, force: true },
  ])('refuses invalid operation identity or revision %j', (input) => {
    expect(() => parseManagedExtensionApplyCommand(input)).toThrow();
  });
});

describe('Managed extension effective bundle versions', () => {
  const bundle = {
    kind: 'managed-extension-config-bundle',
    formatVersion: 1,
    configRevision: 1,
    executionMode: 'linux-cgroup',
    mcpRevision: 0,
    independentMcpSelections: [],
    baseMcpServers: [],
    baseHookCatalog: null,
    packages: [],
    mcpServers: [],
    hookCatalog: null,
  };

  it('reads legacy bundles and refuses personal fields without v2', () => {
    expect(parseManagedExtensionEffectiveBundle(bundle)).toEqual(bundle);
    for (const fields of [
      { mcpAuthBindings: [] },
      { executionActorKey: null },
      { mcpAuthBindings: [authBinding], executionActorKey: 'b'.repeat(64) },
    ]) {
      expect(() =>
        parseManagedExtensionEffectiveBundle({ ...bundle, ...fields }),
      ).toThrow();
    }
  });

  it('retains immutable personal references and the actor across serialization', () => {
    const input = {
      ...bundle,
      formatVersion: 2,
      mcpAuthBindings: [{ ...authBinding }],
      executionActorKey: 'b'.repeat(64),
    };
    const parsed = parseManagedExtensionEffectiveBundle(input);
    input.mcpAuthBindings[0].credentialGeneration++;
    input.executionActorKey = 'c'.repeat(64);
    expect(parsed.mcpAuthBindings).toEqual([authBinding]);
    expect(parsed.executionActorKey).toBe('b'.repeat(64));
    expect(Object.isFrozen(parsed.mcpAuthBindings![0])).toBe(true);
    expect(
      parseManagedExtensionEffectiveBundle(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
    expect(
      parseManagedExtensionEffectiveBundle({
        ...bundle,
        formatVersion: 2,
        mcpAuthBindings: [],
        executionActorKey: null,
      }).executionActorKey,
    ).toBeNull();
  });

  it.each([
    { mcpAuthBindings: [], executionActorKey: 'b'.repeat(64) },
    { mcpAuthBindings: [authBinding], executionActorKey: null },
    { mcpAuthBindings: [authBinding], executionActorKey: 'actor' },
    {
      mcpAuthBindings: [{ ...authBinding, credentialGeneration: 0 }],
      executionActorKey: 'b'.repeat(64),
    },
    { executionActorKey: null },
  ])('rejects inconsistent v2 ownership or generation %j', (fields) => {
    expect(() =>
      parseManagedExtensionEffectiveBundle({
        ...bundle,
        formatVersion: 2,
        ...fields,
      }),
    ).toThrow();
  });
});
