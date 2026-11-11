/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  PluginIdSchema,
  InstalledPluginsFileSchemaV2,
  PluginManifestSchema,
  PluginMarketplaceSchema,
  RECOGNIZED_BUT_UNIMPLEMENTED_FIELDS,
} from './schemas.js';

describe('PluginIdSchema', () => {
  it('accepts plain plugin@marketplace ids', () => {
    expect(PluginIdSchema.safeParse('my-plugin@my-marketplace').success).toBe(
      true,
    );
  });

  it("rejects marketplace segments containing '/'", () => {
    expect(
      PluginIdSchema.safeParse('claude-mem@thedotmack/claude-mem').success,
    ).toBe(false);
  });

  it('rejects malformed ids', () => {
    expect(PluginIdSchema.safeParse('no-marketplace').success).toBe(false);
    expect(PluginIdSchema.safeParse('@marketplace-only').success).toBe(false);
    expect(PluginIdSchema.safeParse('has space@mp').success).toBe(false);
    expect(PluginIdSchema.safeParse('plugin@/leading-slash').success).toBe(
      false,
    );
    expect(PluginIdSchema.safeParse('plugin@trailing/').success).toBe(false);
  });
});

describe('InstalledPluginsFileSchemaV2 legacy read compatibility', () => {
  it('accepts a source-shaped marketplace alias only in persisted state', () => {
    expect(
      InstalledPluginsFileSchemaV2.safeParse({
        version: 2,
        plugins: {
          'claude-mem@thedotmack/claude-mem': [
            {
              scope: 'user',
              installPath: '/cache/claude-mem',
              version: '1.0.0',
            },
          ],
        },
      }).success,
    ).toBe(true);
  });
});

describe('RECOGNIZED_BUT_UNIMPLEMENTED_FIELDS', () => {
  it('contains lspServers and channels', () => {
    expect(RECOGNIZED_BUT_UNIMPLEMENTED_FIELDS.has('lspServers')).toBe(true);
    expect(RECOGNIZED_BUT_UNIMPLEMENTED_FIELDS.has('channels')).toBe(true);
  });
});

describe('PluginManifestSchema — recognized but unimplemented fields', () => {
  it('accepts and preserves lspServers as unknown shape', () => {
    const parsed = PluginManifestSchema.parse({
      name: 'test-plugin',
      lspServers: { ts: { command: 'tsserver', args: ['--stdio'] } },
    });
    expect(parsed['lspServers']).toEqual({
      ts: { command: 'tsserver', args: ['--stdio'] },
    });
  });

  it('accepts and preserves channels as unknown shape', () => {
    const parsed = PluginManifestSchema.parse({
      name: 'test-plugin',
      channels: [{ server: 'chat-server', displayName: 'Chat' }],
    });
    expect(parsed['channels']).toEqual([
      { server: 'chat-server', displayName: 'Chat' },
    ]);
  });

  it('accepts both fields together', () => {
    const parsed = PluginManifestSchema.parse({
      name: 'test-plugin',
      lspServers: { foo: 'bar' },
      channels: [{ server: 'x' }],
    });
    expect(parsed['lspServers']).toEqual({ foo: 'bar' });
    expect(parsed['channels']).toEqual([{ server: 'x' }]);
  });

  it('accepts manifests without these fields (no false positives)', () => {
    const parsed = PluginManifestSchema.parse({
      name: 'test-plugin',
      version: '1.0.0',
    });
    expect(parsed['lspServers']).toBeUndefined();
    expect(parsed['channels']).toBeUndefined();
  });
});

describe('PluginMarketplaceSchema — recognized but unimplemented fields in entries', () => {
  it('accepts marketplace entries containing lspServers and channels', () => {
    const parsed = PluginMarketplaceSchema.parse({
      name: 'test-marketplace',
      owner: { name: 'Test' },
      plugins: [
        {
          name: 'p1',
          source: './p1',
          lspServers: { rust: { command: 'rust-analyzer' } },
          channels: [{ server: 'team-chat' }],
        },
      ],
    });
    const entry = parsed.plugins[0] as Record<string, unknown>;
    expect(entry['lspServers']).toEqual({
      rust: { command: 'rust-analyzer' },
    });
    expect(entry['channels']).toEqual([{ server: 'team-chat' }]);
  });
});

describe('PluginManifestSchema — displayName', () => {
  it('parses displayName as an optional top-level field', () => {
    const parsed = PluginManifestSchema.parse({
      name: 'test-plugin',
      version: '1.0.0',
      displayName: 'Test Plugin',
    });
    expect(parsed.displayName).toBe('Test Plugin');
  });

  it('leaves displayName undefined when not provided', () => {
    const parsed = PluginManifestSchema.parse({
      name: 'test-plugin',
      version: '1.0.0',
    });
    expect(parsed.displayName).toBeUndefined();
  });

  it('surfaces displayName on marketplace entries via inherited fields', () => {
    const parsed = PluginMarketplaceSchema.parse({
      name: 'test-marketplace',
      owner: { name: 'Test' },
      plugins: [
        {
          name: 'p1',
          source: './p1',
          displayName: 'Fancy P1',
        },
      ],
    });
    expect(parsed.plugins[0].displayName).toBe('Fancy P1');
  });
});
