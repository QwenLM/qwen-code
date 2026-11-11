/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  ChannelConfigFieldDescriptor,
  ChannelConfigFieldKind,
  ChannelConfigNestedFieldDescriptor,
} from '@qwen-code/channel-base';
import type {
  DaemonChannelConfigFieldDescriptor,
  DaemonChannelConfigFieldKind,
  DaemonChannelConfigNestedFieldDescriptor,
  DaemonChannelTypeDescriptor,
} from '@qwen-code/sdk/daemon';
import { supportedChannelCatalog } from './channel-registry.js';
import type { ChannelTypeDescriptor } from './channel-registry.js';

type MirrorMatches<Source, Target> =
  (<T>() => T extends Source ? 1 : 2) extends <T>() => T extends Target ? 1 : 2
    ? true
    : false;

type FieldKindsMatch = MirrorMatches<
  ChannelConfigFieldKind,
  DaemonChannelConfigFieldKind
>;
type FieldDescriptorsMatch = MirrorMatches<
  ChannelConfigFieldDescriptor,
  DaemonChannelConfigFieldDescriptor
>;
type NestedFieldDescriptorsMatch = MirrorMatches<
  ChannelConfigNestedFieldDescriptor,
  DaemonChannelConfigNestedFieldDescriptor
>;
type CatalogEnvelopesMatch = MirrorMatches<
  ChannelTypeDescriptor,
  DaemonChannelTypeDescriptor
>;

const FIELD_KINDS: readonly ChannelConfigFieldKind[] = [
  'string',
  'secret',
  'boolean',
  'number',
  'enum',
  'string-list',
  'record',
  'object',
];

function assertDescriptorWireShape(
  descriptor: ChannelConfigFieldDescriptor,
  nested = false,
): void {
  expect(typeof descriptor.key).toBe('string');
  expect(typeof descriptor.label).toBe('string');
  expect(FIELD_KINDS).toContain(descriptor.kind);
  if (nested) {
    expect(descriptor.kind).not.toBe('secret');
  }
  const allowedKeys = new Set([
    'key',
    'label',
    'kind',
    'required',
    'options',
    'default',
    'description',
  ]);
  if (descriptor.kind === 'object') {
    allowedKeys.add('properties');
    expect(descriptor.required ?? false).toBe(false);
    for (const property of descriptor.properties ?? []) {
      assertDescriptorWireShape(property, true);
    }
  } else {
    if (
      !nested &&
      (descriptor.kind === 'string' || descriptor.kind === 'secret')
    ) {
      allowedKeys.add('envResolvable');
      allowedKeys.add('multiline');
    }
    if (descriptor.kind === 'number') {
      allowedKeys.add('exclusiveMinimum');
      allowedKeys.add('minimum');
      allowedKeys.add('maximum');
    }
    expect((descriptor as { properties?: unknown }).properties).toBeUndefined();
    if (descriptor.kind !== 'number') {
      expect(
        (descriptor as { exclusiveMinimum?: unknown }).exclusiveMinimum,
      ).toBeUndefined();
      expect((descriptor as { minimum?: unknown }).minimum).toBeUndefined();
      expect((descriptor as { maximum?: unknown }).maximum).toBeUndefined();
    }
  }
  for (const key of Object.keys(descriptor)) {
    expect(allowedKeys).toContain(key);
  }
}

describe('channel descriptor SDK mirror', () => {
  it('keeps the SDK descriptor types assignable to the channel-base contract', () => {
    const fieldKindsMatch: FieldKindsMatch = true;
    const fieldDescriptorsMatch: FieldDescriptorsMatch = true;
    const nestedFieldDescriptorsMatch: NestedFieldDescriptorsMatch = true;
    const catalogEnvelopesMatch: CatalogEnvelopesMatch = true;

    expect(
      fieldKindsMatch &&
        fieldDescriptorsMatch &&
        nestedFieldDescriptorsMatch &&
        catalogEnvelopesMatch,
    ).toBe(true);
  });

  it('keeps built-in descriptor values within the daemon wire contract', async () => {
    const catalog = await supportedChannelCatalog();
    const manageable = catalog.filter((entry) => entry.manageable);
    expect(manageable).not.toHaveLength(0);
    const dingtalk = catalog.find((entry) => entry.type === 'dingtalk');
    expect(
      dingtalk?.fields.some(
        (field) =>
          field.kind === 'object' &&
          field.properties !== undefined &&
          field.properties.length > 0,
      ),
    ).toBe(true);
    for (const entry of manageable) {
      expect(Object.keys(entry)).toEqual(
        expect.arrayContaining(['type', 'displayName', 'manageable', 'fields']),
      );
      expect(
        Object.keys(entry).every((key) =>
          [
            'type',
            'displayName',
            'manageable',
            'supportsQrLogin',
            'fields',
            'outboundOnly',
            'defaultDeliveryTarget',
          ].includes(key),
        ),
      ).toBe(true);
      if (entry.outboundOnly !== undefined) {
        expect(typeof entry.outboundOnly).toBe('boolean');
      }
      if (entry.defaultDeliveryTarget !== undefined) {
        expect(['user', 'chat']).toContain(entry.defaultDeliveryTarget.type);
        expect(entry.defaultDeliveryTarget.id.trim()).not.toBe('');
        expect(Object.keys(entry.defaultDeliveryTarget)).toEqual(
          expect.arrayContaining(['type', 'id']),
        );
        expect(
          Object.keys(entry.defaultDeliveryTarget).every((key) =>
            ['type', 'id', 'label'].includes(key),
          ),
        ).toBe(true);
      }
      for (const field of entry.fields) {
        assertDescriptorWireShape(field);
      }
    }
  });
});
