/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SourceRegistryStore,
  parseExtensionSourceType,
  discoverPlugins,
  type ExtensionSource,
} from './sourceRegistry.js';
import { loadMarketplaceConfigFromSource } from './marketplace.js';
import type { ClaudeMarketplaceConfig } from './claude-converter.js';
import {
  fromClaudeMarketplace,
  type MarketplaceConfig,
} from './marketplaceTypes.js';

vi.mock('./marketplace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./marketplace.js')>();
  return {
    ...actual,
    loadMarketplaceConfigFromSource: vi.fn(),
  };
});

describe('parseExtensionSourceType', () => {
  it.each([
    ['anthropics/skills', 'github'],
    ['https://github.com/owner/repo', 'github'],
    ['git@github.com:owner/repo.git', 'git'],
    ['sso://team/repo', 'git'],
    ['https://example.com/marketplace.json', 'http'],
    ['./local/marketplace', 'local'],
    ['/abs/path/marketplace', 'local'],
  ] as const)('classifies %s as %s', (input, expected) => {
    expect(parseExtensionSourceType(input)).toBe(expected);
  });
});

describe('SourceRegistryStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: SourceRegistryStore;

  const make = (name: string, source: string): ExtensionSource => ({
    name,
    source,
    type: 'github',
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-reg-'));
    filePath = path.join(tmpDir, 'nested', 'marketplaces.json');
    store = new SourceRegistryStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty list when no file exists', () => {
    expect(store.read()).toEqual([]);
  });

  it('adds and persists sources', () => {
    store.add(make('Skills', 'anthropics/skills'));
    expect(store.read()).toHaveLength(1);

    const reopened = new SourceRegistryStore(filePath);
    expect(reopened.read()[0].name).toBe('Skills');
  });

  it('replaces an entry with the same name or source instead of duplicating', () => {
    store.add(make('Skills', 'anthropics/skills'));
    store.add(make('Skills', 'anthropics/skills-v2'));
    store.add(make('Other', 'anthropics/skills-v2'));
    const all = store.read();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Other');
    expect(all[0].source).toBe('anthropics/skills-v2');
  });

  it('removes by name', () => {
    store.add(make('A', 'a/a'));
    store.add(make('B', 'b/b'));
    expect(store.remove('A')).toBe(true);
    expect(store.read().map((s) => s.name)).toEqual(['B']);
    expect(store.remove('missing')).toBe(false);
  });
});

describe('discoverPlugins', () => {
  beforeEach(() => {
    vi.mocked(loadMarketplaceConfigFromSource).mockReset();
  });

  // Fixtures stay in the raw Claude shape so the test also covers the
  // claude -> unified normalization used by the real loaders.
  const config = (
    name: string,
    plugins: ClaudeMarketplaceConfig['plugins'],
  ): MarketplaceConfig =>
    fromClaudeMarketplace({
      name,
      owner: { name: 'o', email: 'e' },
      plugins,
    });

  it('flattens plugins across sources and marks installed ones', async () => {
    vi.mocked(loadMarketplaceConfigFromSource).mockImplementation(
      async (source: string) => {
        if (source === 'anthropics/skills') {
          return config('Skills', [
            {
              name: 'pdf',
              version: '1.0.0',
              description: 'PDF tools',
              homepage: 'https://example.com/pdf',
              source: 'anthropics/skills',
            },
            {
              name: 'docx',
              version: '1.0.0',
              source: 'anthropics/skills',
            },
          ]);
        }
        return config('Other', [
          { name: 'xlsx', version: '2.0.0', source: 'me/other' },
        ]);
      },
    );

    const sources: ExtensionSource[] = [
      { name: 'Skills', source: 'anthropics/skills', type: 'github' },
      { name: 'Other', source: 'me/other', type: 'github' },
    ];

    const discovered = await discoverPlugins(sources, new Set(['docx']));

    expect(discovered).toHaveLength(3);
    const pdf = discovered.find((p) => p.name === 'pdf')!;
    expect(pdf.installed).toBe(false);
    expect(pdf.homepage).toBe('https://example.com/pdf');
    expect(pdf.installSource).toBe('anthropics/skills:pdf');
    expect(discovered.find((p) => p.name === 'docx')!.installed).toBe(true);
  });

  it('surfaces declared components and lastUpdated for the detail view', async () => {
    vi.mocked(loadMarketplaceConfigFromSource).mockResolvedValue(
      config('Skills', [
        {
          name: 'pdf',
          version: '1.0.0',
          source: 'anthropics/skills',
          skills: ['pdf-audit', 'pdf-scan'],
          mcpServers: { 'pdf-server': { command: 'node' } },
          // Arbitrary marketplace metadata field, read best-effort.
          lastUpdated: 'Jun 5, 2026',
        } as never,
      ]),
    );

    const [plugin] = await discoverPlugins(
      [{ name: 'Skills', source: 'anthropics/skills', type: 'github' }],
      new Set(),
    );

    expect(plugin.components?.skills).toEqual(['pdf-audit', 'pdf-scan']);
    expect(plugin.components?.mcpServers).toEqual(['pdf-server']);
    expect(plugin.components?.commands).toBeUndefined();
    expect(plugin.lastUpdated).toBe('Jun 5, 2026');
  });

  it('derives install source from per-plugin source for http sources', async () => {
    vi.mocked(loadMarketplaceConfigFromSource).mockResolvedValue(
      config('Remote', [
        {
          name: 'gh-plugin',
          version: '1.0.0',
          source: { source: 'github', repo: 'someone/repo' },
        },
        {
          name: 'url-plugin',
          version: '1.0.0',
          source: { source: 'url', url: 'https://example.com/p.tgz' },
        },
      ]),
    );

    const discovered = await discoverPlugins(
      [{ name: 'Remote', source: 'https://x/m.json', type: 'http' }],
      new Set(),
    );

    expect(discovered.find((p) => p.name === 'gh-plugin')!.installSource).toBe(
      'someone/repo:gh-plugin',
    );
    expect(discovered.find((p) => p.name === 'url-plugin')!.installSource).toBe(
      'https://example.com/p.tgz',
    );
  });

  it('skips sources that fail to load without throwing', async () => {
    vi.mocked(loadMarketplaceConfigFromSource).mockImplementation(
      async (source: string) => {
        if (source === 'good/repo') {
          return config('Good', [
            { name: 'ok', version: '1.0.0', source: 'good/repo' },
          ]);
        }
        throw new Error('network down');
      },
    );

    const discovered = await discoverPlugins(
      [
        { name: 'Bad', source: 'bad/repo', type: 'github' },
        { name: 'Good', source: 'good/repo', type: 'github' },
      ],
      new Set(),
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0].name).toBe('ok');
  });
});
