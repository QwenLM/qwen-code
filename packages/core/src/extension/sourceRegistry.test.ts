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
import {
  loadMarketplaceConfigFromSource,
  parseSourceAndPluginName,
} from './marketplace.js';
import type { ClaudeMarketplaceConfig } from './claude-converter.js';
import { convertCompatibleExtension } from './extension-converter.js';
import { QODER_PLUGIN_MANIFEST } from './qoder-converter.js';

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
    ['HTTPS://github.com/owner/repo', 'github'],
    ['git@github.com:owner/repo.git', 'git'],
    ['sso://team/repo', 'git'],
    ['https://example.com/marketplace.json', 'http'],
    ['HTTPS://example.com/marketplace.json', 'http'],
    ['HTTP://example.com/marketplace.json', 'http'],
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

  it('quarantines a corrupt registry (parse error) to a .corrupted sibling', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '[ not valid json');

    expect(store.read()).toEqual([]);

    // The unparseable file is moved aside so the next add/remove can't clobber
    // a recoverable (e.g. truncated) source list with the empty default.
    expect(fs.existsSync(`${filePath}.corrupted`)).toBe(true);
    expect(fs.readFileSync(`${filePath}.corrupted`, 'utf-8')).toBe(
      '[ not valid json',
    );
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('does NOT quarantine on a transient read error, but warns on stderr', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    // A path that exists but momentarily can't be read as a file (here a
    // directory → EISDIR; same class as EACCES/EMFILE) must NOT be moved aside:
    // only a genuine JSON parse failure quarantines.
    fs.mkdirSync(filePath, { recursive: true });

    expect(store.read()).toEqual([]);

    expect(fs.existsSync(`${filePath}.corrupted`)).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });
});

describe('discoverPlugins', () => {
  beforeEach(() => {
    vi.mocked(loadMarketplaceConfigFromSource).mockReset();
  });

  const config = (
    name: string,
    plugins: ClaudeMarketplaceConfig['plugins'],
  ): ClaudeMarketplaceConfig => ({
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
    expect(pdf.pluginSourceKind).toBe('marketplace-entry');
    expect(discovered.find((p) => p.name === 'docx')!.installed).toBe(true);
  });

  it('passes the public network policy to marketplace loading', async () => {
    vi.mocked(loadMarketplaceConfigFromSource).mockResolvedValue(
      config('Skills', []),
    );

    await discoverPlugins(
      [{ name: 'Skills', source: 'anthropics/skills', type: 'github' }],
      new Set(),
      'public',
    );

    expect(loadMarketplaceConfigFromSource).toHaveBeenCalledWith(
      'anthropics/skills',
      'public',
    );
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

  it('strips ANSI/control sequences from untrusted display fields', async () => {
    // Every displayed field renders in the pre-consent Discover view, so a
    // hostile marketplace must not smuggle terminal escapes (cursor moves, line
    // clears, OSC title-injection) through any of them. Payload mirrors the PoC
    // from the PR #4850 verification report.
    const ESC = '\x1b';
    const BEL = '\x07';
    vi.mocked(loadMarketplaceConfigFromSource).mockResolvedValue(
      config(`Hostile${ESC}[2K`, [
        {
          name: `evil${ESC}[31m-plugin${ESC}[2K`,
          version: `9.9.9${ESC}[5m`,
          description: `Totally safe${ESC}[1A${ESC}]0;PWNED${BEL} — trust me${ESC}[7m`,
          author: { name: `mallory${ESC}[0m` },
          homepage: `https://e${ESC}[31mvil.com`,
          category: `tools${BEL}`,
          skills: [`pdf${ESC}]0;t${BEL}-audit`],
          lastUpdated: `Jun 5${ESC}[2K, 2026`,
          source: 'anthropics/skills',
        } as never,
      ]),
    );

    const [plugin] = await discoverPlugins(
      [{ name: 'Skills', source: 'anthropics/skills', type: 'github' }],
      new Set(),
    );

    expect(plugin.marketplaceName).toBe('Hostile');
    expect(plugin.name).toBe('evil-plugin');
    expect(plugin.version).toBe('9.9.9');
    expect(plugin.description).toBe('Totally safe — trust me');
    expect(plugin.author).toBe('mallory');
    expect(plugin.homepage).toBe('https://evil.com');
    expect(plugin.category).toBe('tools');
    expect(plugin.lastUpdated).toBe('Jun 5, 2026');
    expect(plugin.components?.skills).toEqual(['pdf-audit']);

    // Belt-and-braces: no escape/control byte survives in any rendered field.
    const rendered = [
      plugin.marketplaceName,
      plugin.name,
      plugin.version,
      plugin.description,
      plugin.author,
      plugin.homepage,
      plugin.category,
      plugin.lastUpdated,
      ...(plugin.components?.skills ?? []),
    ].join('|');
    expect(rendered).not.toContain(ESC);
    expect(rendered).not.toContain(BEL);
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
        {
          name: 'https-root',
          version: '1.0.0',
          source: 'https://github.com/someone/root-plugin',
        },
        {
          name: 'url-github-root',
          version: '1.0.0',
          source: {
            source: 'url',
            url: 'https://github.com/someone/other-root-plugin',
          },
        },
        {
          name: 'selected-string-plugin',
          version: '1.0.0',
          source: 'someone/repo:selected',
        },
        {
          name: 'selected-url-plugin',
          version: '1.0.0',
          source: {
            source: 'url',
            url: 'https://github.com/someone/repo:selected',
          },
        },
        {
          name: 'port-root',
          version: '1.0.0',
          source: 'https://example.com:8443/root-plugin',
        },
        {
          name: 'port-selected',
          version: '1.0.0',
          source: 'https://example.com:8443/repo:selected',
        },
        {
          name: 'bare-root',
          version: '1.0.0',
          source: 'someone/direct-root',
        },
        {
          name: '2048-game',
          version: '1.0.0',
          source: 'git@github.com:someone/direct-root.git',
        },
        {
          name: '2048-sso',
          version: '1.0.0',
          source: 'sso://team/direct-root',
        },
        {
          name: '2048',
          version: '1.0.0',
          source: 'git@github.com:someone/numeric-root.git',
        },
        {
          name: '4096',
          version: '1.0.0',
          source: { source: 'github', repo: 'someone/numeric-https-root' },
        },
        {
          name: 'embedded-numeric',
          version: '1.0.0',
          source: 'someone/repo:2048',
        },
      ]),
    );

    const discovered = await discoverPlugins(
      [{ name: 'Remote', source: 'https://x/m.json', type: 'http' }],
      new Set(),
    );

    expect(discovered.find((p) => p.name === 'gh-plugin')!.installSource).toBe(
      'https://github.com/someone/repo:gh-plugin',
    );
    expect(
      discovered.find((p) => p.name === 'gh-plugin')!.pluginSourceKind,
    ).toBe('extension-root');
    expect(discovered.find((p) => p.name === 'url-plugin')!.installSource).toBe(
      'https://example.com/p.tgz',
    );
    expect(
      discovered.find((p) => p.name === 'url-plugin')!.pluginSourceKind,
    ).toBe('extension-root');
    expect(discovered.find((p) => p.name === 'https-root')!.installSource).toBe(
      'https://github.com/someone/root-plugin',
    );
    expect(
      discovered.find((p) => p.name === 'https-root')!.pluginSourceKind,
    ).toBe('extension-root');
    expect(
      discovered.find((p) => p.name === 'url-github-root')!.installSource,
    ).toBe('https://github.com/someone/other-root-plugin');
    expect(
      discovered.find((p) => p.name === 'url-github-root')!.pluginSourceKind,
    ).toBe('extension-root');
    expect(
      discovered.find((p) => p.name === 'selected-string-plugin')!
        .installSource,
    ).toBe('https://github.com/someone/repo:selected');
    expect(
      discovered.find((p) => p.name === 'selected-string-plugin')!
        .pluginSourceKind,
    ).toBe('marketplace-entry');
    expect(
      discovered.find((p) => p.name === 'selected-url-plugin')!.installSource,
    ).toBe('https://github.com/someone/repo:selected');
    expect(
      discovered.find((p) => p.name === 'selected-url-plugin')!
        .pluginSourceKind,
    ).toBe('marketplace-entry');
    expect(discovered.find((p) => p.name === 'port-root')!.installSource).toBe(
      'https://example.com:8443/root-plugin',
    );
    expect(
      discovered.find((p) => p.name === 'port-root')!.pluginSourceKind,
    ).toBe('extension-root');
    expect(
      discovered.find((p) => p.name === 'port-selected')!.installSource,
    ).toBe('https://example.com:8443/repo:selected');
    expect(
      discovered.find((p) => p.name === 'port-selected')!.pluginSourceKind,
    ).toBe('marketplace-entry');
    expect(discovered.find((p) => p.name === 'bare-root')).toMatchObject({
      installSource: 'https://github.com/someone/direct-root:bare-root',
      pluginSourceKind: 'extension-root',
    });
    expect(discovered.find((p) => p.name === '2048-game')).toMatchObject({
      installSource: 'git@github.com:someone/direct-root.git:2048-game',
      pluginSourceKind: 'extension-root',
    });
    expect(discovered.find((p) => p.name === '2048-sso')).toMatchObject({
      installSource: 'sso://team/direct-root:2048-sso',
      pluginSourceKind: 'extension-root',
    });
    expect(
      parseSourceAndPluginName(
        discovered.find((p) => p.name === '2048-game')!.installSource,
      ),
    ).toEqual({
      repo: 'git@github.com:someone/direct-root.git',
      pluginName: '2048-game',
    });
    expect(
      parseSourceAndPluginName(
        discovered.find((p) => p.name === '2048-sso')!.installSource,
      ),
    ).toEqual({
      repo: 'sso://team/direct-root',
      pluginName: '2048-sso',
    });
    expect(discovered.find((p) => p.name === '2048')).toMatchObject({
      installSource: 'git@github.com:someone/numeric-root.git:2048',
      pluginSourceKind: 'extension-root',
    });
    expect(
      parseSourceAndPluginName(
        discovered.find((p) => p.name === '2048')!.installSource,
      ),
    ).toEqual({
      repo: 'git@github.com:someone/numeric-root.git',
      pluginName: '2048',
    });
    const numericHttpsRoot = discovered.find((p) => p.name === '4096')!;
    expect(numericHttpsRoot).toMatchObject({
      installSource: 'https://github.com/someone/numeric-https-root:4096',
      pluginSourceKind: 'extension-root',
    });
    expect(parseSourceAndPluginName(numericHttpsRoot.installSource)).toEqual({
      repo: 'https://github.com/someone/numeric-https-root',
      pluginName: '4096',
    });
    const embeddedNumeric = discovered.find(
      (p) => p.name === 'embedded-numeric',
    )!;
    expect(embeddedNumeric).toMatchObject({
      installSource: 'https://github.com/someone/repo:2048',
      pluginSourceKind: 'marketplace-entry',
    });
    expect(parseSourceAndPluginName(embeddedNumeric.installSource)).toEqual({
      repo: 'https://github.com/someone/repo',
      pluginName: '2048',
    });
  });

  it.each([
    ['a structured GitHub source without repo', { source: 'github' }],
    ['a structured URL source without url', { source: 'url' }],
  ])('keeps valid siblings when %s is malformed', async (_, source) => {
    vi.mocked(loadMarketplaceConfigFromSource).mockResolvedValue(
      config('Remote', [
        {
          name: 'malformed',
          version: '1.0.0',
          source: source as never,
        },
        {
          name: 'valid',
          version: '1.0.0',
          source: 'https://example.com/valid.tgz',
        },
      ]),
    );

    const discovered = await discoverPlugins(
      [{ name: 'Remote', source: 'https://x/m.json', type: 'http' }],
      new Set(),
    );

    expect(discovered).toHaveLength(2);
    expect(
      discovered.find((plugin) => plugin.name === 'malformed'),
    ).toMatchObject({
      installSource: '',
      pluginSourceKind: 'extension-root',
    });
    expect(discovered.find((plugin) => plugin.name === 'valid')).toMatchObject({
      installSource: 'https://example.com/valid.tgz',
      pluginSourceKind: 'extension-root',
    });
  });

  it('keeps a structured GitHub Qoder plugin installable as a direct root', async () => {
    vi.mocked(loadMarketplaceConfigFromSource).mockResolvedValue(
      config('Remote', [
        {
          name: 'qoder-alias',
          version: '1.0.0',
          source: { source: 'github', repo: 'someone/qoder-plugin' },
        },
      ]),
    );
    const [plugin] = await discoverPlugins(
      [{ name: 'Remote', source: 'https://x/m.json', type: 'http' }],
      new Set(),
    );
    const parsed = parseSourceAndPluginName(plugin.installSource);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-discovery-'));
    let convertedDir: string | undefined;

    try {
      fs.mkdirSync(path.join(root, '.qoder-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(root, QODER_PLUGIN_MANIFEST),
        JSON.stringify({ name: 'qoder-root', version: '1.2.3' }),
        'utf-8',
      );

      const converted = await convertCompatibleExtension(
        root,
        parsed.pluginName,
        undefined,
        undefined,
        plugin.pluginSourceKind,
      );
      convertedDir = converted.extensionDir;

      expect(plugin).toMatchObject({
        installSource: 'https://github.com/someone/qoder-plugin:qoder-alias',
        pluginSourceKind: 'extension-root',
      });
      expect(converted.originSource).toBe('Qoder');
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(converted.extensionDir, 'qwen-extension.json'),
            'utf-8',
          ),
        ),
      ).toMatchObject({ name: 'qoder-root', version: '1.2.3' });
    } finally {
      if (convertedDir && convertedDir !== root) {
        fs.rmSync(convertedDir, { recursive: true, force: true });
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks a direct-root alias installed by its source identity when names differ', async () => {
    vi.mocked(loadMarketplaceConfigFromSource).mockResolvedValue(
      config('Remote', [
        {
          name: 'catalog-alias',
          version: '1.0.0',
          source: { source: 'github', repo: 'someone/plugin-root' },
        },
      ]),
    );

    const [plugin] = await discoverPlugins(
      [{ name: 'Remote', source: 'https://x/m.json', type: 'http' }],
      new Set([
        JSON.stringify({
          source: 'https://github.com/someone/plugin-root',
          pluginSourceKind: 'extension-root',
        }),
      ]),
    );

    expect(plugin).toMatchObject({
      name: 'catalog-alias',
      installed: true,
      pluginSourceKind: 'extension-root',
    });
  });

  it('rejects local-path sources from a remote (http) marketplace', async () => {
    // A hostile remote marketplace must not be able to point the installer at a
    // local filesystem path through any supported source shape.
    vi.mocked(loadMarketplaceConfigFromSource).mockResolvedValue(
      config('Remote', [
        { name: 'abs', version: '1.0.0', source: '/etc/passwd' },
        { name: 'rel', version: '1.0.0', source: '../../secret' },
        { name: 'home', version: '1.0.0', source: '~/.ssh/id_rsa' },
        {
          name: 'urlabs',
          version: '1.0.0',
          source: { source: 'url', url: '/etc/shadow' },
        },
        {
          name: 'urlrel',
          version: '1.0.0',
          source: { source: 'url', url: '../escape' },
        },
        {
          name: 'githubabs',
          version: '1.0.0',
          source: { source: 'github', repo: '/home/user/secrets' },
        },
        {
          name: 'githubrel',
          version: '1.0.0',
          source: { source: 'github', repo: 'foo/bar/baz' },
        },
        {
          name: 'githubcwd',
          version: '1.0.0',
          source: { source: 'github', repo: 'foo/bar' },
        },
        {
          name: 'urlok',
          version: '1.0.0',
          source: { source: 'url', url: 'https://example.com/p.tgz' },
        },
      ] as never),
    );

    const discovered = await discoverPlugins(
      [{ name: 'Remote', source: 'https://x/m.json', type: 'http' }],
      new Set(),
    );

    const src = (name: string) =>
      discovered.find((p) => p.name === name)!.installSource;
    // Rejected local redirects remain visible but are not installable.
    expect(src('abs')).toBe('');
    expect(src('rel')).toBe('');
    expect(src('home')).toBe('');
    // { source: 'url' } local paths are rejected too (previously bypassed).
    expect(src('urlabs')).toBe('');
    expect(src('urlrel')).toBe('');
    expect(src('githubabs')).toBe('');
    expect(src('githubrel')).toBe('');
    // owner/repo is normalized before it reaches parseInstallSource, whose
    // filesystem-first resolution would otherwise select ./foo/bar.
    expect(src('githubcwd')).toBe('https://github.com/foo/bar:githubcwd');
    // A genuine remote URL is preserved.
    expect(src('urlok')).toBe('https://example.com/p.tgz');
  });

  it('marks a sourceless http entry as non-installable', async () => {
    vi.mocked(loadMarketplaceConfigFromSource).mockResolvedValue(
      config('Remote', [{ name: 'root-plugin', version: '1.0.0' }]),
    );

    const [plugin] = await discoverPlugins(
      [
        {
          name: 'Remote',
          source: 'https://github.com/someone/root-plugin',
          type: 'http',
        },
      ],
      new Set(),
    );
    expect(plugin).toMatchObject({
      installSource: '',
      pluginSourceKind: 'extension-root',
    });
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
