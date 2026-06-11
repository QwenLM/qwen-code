/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  fromClaudeMarketplace,
  fromQwenMarketplace,
  parseMarketplaceDocument,
} from './marketplaceTypes.js';

describe('parseMarketplaceDocument', () => {
  it('detects a qwen manifest by its extensions array', () => {
    const config = parseMarketplaceDocument({
      name: 'qwen-market',
      description: 'desc',
      extensions: [{ name: 'foo', source: './foo' }],
    });
    expect(config).toMatchObject({ format: 'qwen', name: 'qwen-market' });
    expect(config?.entries.map((e) => e.name)).toEqual(['foo']);
  });

  it('detects a claude manifest by its plugins array', () => {
    const config = parseMarketplaceDocument({
      name: 'claude-market',
      owner: { name: 'o', email: 'e' },
      plugins: [{ name: 'bar', version: '1.0.0', source: './bar' }],
    });
    expect(config).toMatchObject({ format: 'claude', name: 'claude-market' });
    expect(config?.entries.map((e) => e.name)).toEqual(['bar']);
  });

  it('passes through an already-unified config (persisted metadata)', () => {
    const unified = {
      format: 'qwen' as const,
      name: 'persisted',
      entries: [{ name: 'foo' }],
    };
    expect(parseMarketplaceDocument(unified)).toBe(unified);
  });

  it('returns null for non-marketplace documents', () => {
    expect(parseMarketplaceDocument(null)).toBeNull();
    expect(parseMarketplaceDocument('text')).toBeNull();
    expect(parseMarketplaceDocument({})).toBeNull();
    expect(parseMarketplaceDocument({ name: 'x' })).toBeNull();
    // A single qwen extension manifest is not a marketplace.
    expect(
      parseMarketplaceDocument({ name: 'ext', version: '1.0.0' }),
    ).toBeNull();
  });
});

describe('fromQwenMarketplace', () => {
  it('maps entry fields into the unified model', () => {
    const config = fromQwenMarketplace({
      name: 'm',
      description: 'marketplace desc',
      version: '2.0.0',
      extensions: [
        {
          name: 'foo',
          source: { type: 'github', repo: 'owner/foo' },
          version: '1.2.3',
          description: 'foo desc',
          author: { name: 'Author' },
          homepage: 'https://example.com',
          category: 'tools',
          tags: ['a'],
          lastUpdated: '2026-06-01',
          installs: 42,
          components: { commands: ['run'], mcpServers: ['srv'] },
        },
      ],
    });
    expect(config.format).toBe('qwen');
    expect(config.description).toBe('marketplace desc');
    expect(config.version).toBe('2.0.0');
    expect(config.entries[0]).toMatchObject({
      name: 'foo',
      version: '1.2.3',
      author: 'Author',
      category: 'tools',
      installs: 42,
      components: { commands: ['run'], mcpServers: ['srv'] },
      source: { type: 'github', repo: 'owner/foo' },
    });
  });

  it('accepts a plain-string author', () => {
    const config = fromQwenMarketplace({
      name: 'm',
      extensions: [{ name: 'foo', source: './foo', author: 'Someone' }],
    });
    expect(config.entries[0].author).toBe('Someone');
  });

  it('skips entries without a name or source', () => {
    const config = fromQwenMarketplace({
      name: 'm',
      extensions: [
        { name: 'ok', source: './ok' },
        { name: '', source: './nameless' },
        { name: 'sourceless' } as never,
      ],
    });
    expect(config.entries.map((e) => e.name)).toEqual(['ok']);
  });
});

describe('fromClaudeMarketplace', () => {
  it('maps marketplace metadata and best-effort plugin fields', () => {
    const config = fromClaudeMarketplace({
      name: 'm',
      owner: { name: 'o', email: 'e' },
      metadata: { description: 'd', version: '3.0.0' },
      plugins: [
        {
          name: 'p',
          version: '1.0.0',
          source: './p',
          author: { name: 'A' },
          skills: ['s1'],
          mcpServers: { srv: { command: 'node' } },
          lastUpdated: 'Jun 5, 2026',
          installs: 7,
        } as never,
      ],
    });
    expect(config).toMatchObject({
      format: 'claude',
      description: 'd',
      version: '3.0.0',
    });
    expect(config.entries[0]).toMatchObject({
      name: 'p',
      author: 'A',
      lastUpdated: 'Jun 5, 2026',
      installs: 7,
      components: { skills: ['s1'], mcpServers: ['srv'] },
    });
  });
});
