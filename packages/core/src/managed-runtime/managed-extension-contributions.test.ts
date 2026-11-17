/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import {
  publishManagedExtensionContributions,
  readManagedExtensionContributions,
} from './managed-extension-contributions.js';

function store() {
  const data = new Map<string, Buffer>();
  return {
    data,
    async publish(
      kind: string,
      bytes: Buffer,
    ): Promise<ManagedSessionDurableRef> {
      const resourceId = `resource-${data.size}`;
      data.set(resourceId, bytes);
      return {
        resourceId,
        kind,
        schemaVersion: 1,
        byteLength: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    async read(ref: ManagedSessionDurableRef) {
      return data.get(ref.resourceId)!;
    },
  };
}

describe('Managed extension contribution resource closure', () => {
  it('preserves UTF-8 bodies across 64 KiB parts', async () => {
    const resources = store();
    const contributions = {
      skills: [],
      commands: [],
      agents: [],
      context: [{ path: 'QWEN.md', body: '文'.repeat(60_000) }],
      mcpServers: {},
      hooks: {},
      settings: [],
    };
    const ref = await publishManagedExtensionContributions(
      resources,
      contributions,
    );
    expect(
      [...resources.data.values()].every((bytes) => bytes.length <= 64 * 1024),
    ).toBe(true);
    expect(await readManagedExtensionContributions(resources, ref)).toEqual(
      contributions,
    );
  });

  it('rejects a part whose stored bytes changed', async () => {
    const resources = store();
    const ref = await publishManagedExtensionContributions(resources, {
      skills: [],
      commands: [],
      agents: [],
      context: [],
      mcpServers: {},
      hooks: {},
      settings: [],
    });
    resources.data.set('resource-0', Buffer.from('changed'));
    await expect(
      readManagedExtensionContributions(resources, ref),
    ).rejects.toThrow('part does not match');
  });
});
