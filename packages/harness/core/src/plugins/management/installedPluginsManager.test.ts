/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_PLUGIN_CACHE_DIR } from "../../config/brand.js";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runLogger } from '../../utils/runLogger.js';

import {
  addPluginInstallation,
  invalidateInstalledPluginsCache,
  loadInstalledPluginsFromDisk,
  removeAllPluginsForMarketplace,
  removePluginInstallation,
} from './installedPluginsManager.js';

// `pluginDirectories.getPluginsDirectory()` reads ENV_PLUGIN_CACHE_DIR
// before falling back to ~/.qwen/plugins; override it per-test so we never
// touch the real home dir.


let workspaceRoot: string;
let pluginsDir: string;
const originalCacheDir = process.env[ENV_PLUGIN_CACHE_DIR];

function legacyPath(): string {
  return join(pluginsDir, 'installed_plugins.json');
}
function v2Path(): string {
  return join(pluginsDir, 'installed_plugins_v2.json');
}

function canStillRead(path: string): boolean {
  try {
    readFileSync(path, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function seedLegacy(plugins: Record<string, unknown>): void {
  writeFileSync(legacyPath(), JSON.stringify({ version: 1, plugins }));
}

function seedV2(plugins: Record<string, unknown[]>): void {
  writeFileSync(v2Path(), JSON.stringify({ version: 2, plugins }));
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'iplugins-mgr-'));
  // pluginDirectories: getPluginsDirectory() returns env override directly.
  pluginsDir = workspaceRoot;
  process.env[ENV_PLUGIN_CACHE_DIR] = pluginsDir;
  mkdirSync(pluginsDir, { recursive: true });
  invalidateInstalledPluginsCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateInstalledPluginsCache();
  if (originalCacheDir === undefined) {
    delete process.env[ENV_PLUGIN_CACHE_DIR];
  } else {
    process.env[ENV_PLUGIN_CACHE_DIR] = originalCacheDir;
  }
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('installedPluginsManager — V2 file split protocol', () => {
  it('migrates only array-shaped entries from legacy installed_plugins.json; leaves object entries alone', () => {
    // Legacy file with mixed shapes (sibling IDE writes V1 objects; an
    // older CLI build wrote V2 arrays).
    seedLegacy({
      'cli-array@mp': [
        {
          scope: 'user',
          installPath: '/tmp/cli-array/1.0.0',
          version: '1.0.0',
        },
      ],
      'ide-object@mp': {
        scope: 'user',
        installPath: '/tmp/ide-object/1.0.0',
        version: '1.0.0',
        // IDE-specific fields the CLI wouldn't write — proof we didn't
        // misclassify by examining content.
        ideOnlyField: 'whatever',
      },
    });

    const state = loadInstalledPluginsFromDisk();

    // Only the array entry was migrated.
    expect(Object.keys(state.plugins)).toEqual(['cli-array@mp']);
    expect(state.plugins['cli-array@mp']).toHaveLength(1);

    // V2 file was written with just the array entries.
    const v2Content = readJson(v2Path()) as {
      version: number;
      plugins: Record<string, unknown[]>;
    };
    expect(v2Content.version).toBe(2);
    expect(Object.keys(v2Content.plugins)).toEqual(['cli-array@mp']);

    // Legacy file is bytewise untouched — IDE's object entry is intact.
    const legacy = readJson(legacyPath()) as {
      plugins: Record<string, unknown>;
    };
    expect(legacy.plugins['ide-object@mp']).toMatchObject({
      ideOnlyField: 'whatever',
      installPath: '/tmp/ide-object/1.0.0',
    });
    // Legacy file still has the array entry too — we did NOT delete it from
    // the legacy file; only mirrored it into V2. This is intentional: the
    // legacy file is read-only from CLI's perspective.
    expect(Array.isArray(legacy.plugins['cli-array@mp'])).toBe(true);
  });

  it('add/remove/update only writes to V2; never touches legacy installed_plugins.json', () => {
    seedLegacy({
      'ide@mp': { scope: 'user', installPath: '/ide', version: '1.0.0' },
    });
    const legacyBefore = readFileSync(legacyPath(), 'utf-8');

    addPluginInstallation('foo@mp', {
      scope: 'user',
      installPath: '/tmp/foo/1.0.0',
      version: '1.0.0',
    });

    expect(existsSync(v2Path())).toBe(true);
    const v2 = readJson(v2Path()) as {
      plugins: Record<string, unknown[]>;
    };
    expect(v2.plugins['foo@mp']).toBeDefined();

    // Remove + assert legacy unchanged.
    removePluginInstallation('foo@mp', 'user');
    const legacyAfter = readFileSync(legacyPath(), 'utf-8');
    expect(legacyAfter).toBe(legacyBefore);
  });

  it('persists, refreshes and clears a regular plugin display name without changing other metadata', async () => {
    const { refreshPluginDisplayName } = await import('./installedPluginsManager.js');
    addPluginInstallation('demo@mp', {
      scope: 'user', installPath: '/demo', version: '1', displayName: '旧名称',
    });
    refreshPluginDisplayName('demo@mp', '/demo', '新名称');
    expect((readJson(v2Path()) as { plugins: Record<string, unknown[]> }).plugins['demo@mp'][0]).toMatchObject({
      version: '1', displayName: '新名称',
    });
    refreshPluginDisplayName('demo@mp', '/different-version', '错误名称');
    expect(loadInstalledPluginsFromDisk().plugins['demo@mp'][0].displayName).toBe('新名称');
    refreshPluginDisplayName('demo@mp', '/demo', undefined);
    expect((readJson(v2Path()) as { plugins: Record<string, unknown[]> }).plugins['demo@mp'][0]).not.toHaveProperty('displayName');
  });

  it('writes managed (enterprise) entries to V2 file, not legacy', () => {
    addPluginInstallation('p@qoder-enterprise-acme', {
      scope: 'managed',
      installPath: '/cache/p/1.0.0',
      version: '1.0.0',
      orgId: 'acme',
      userVisible: true,
      userCanDisable: false,
      fileHash: 'sha256:abc',
      fileSize: 1,
    });

    const v2 = readJson(v2Path()) as {
      plugins: Record<string, unknown[]>;
    };
    expect(v2.plugins['p@qoder-enterprise-acme']).toBeDefined();
    expect(existsSync(legacyPath())).toBe(false);
  });

  it('once V2 exists, never re-reads legacy installed_plugins.json (even if it changes)', () => {
    seedV2({
      'only-v2@mp': [
        { scope: 'user', installPath: '/v2/path', version: '1.0.0' },
      ],
    });
    // Put a totally different array entry in the legacy file.
    seedLegacy({
      'leaked-from-legacy@mp': [
        { scope: 'user', installPath: '/legacy/path', version: '1.0.0' },
      ],
    });

    const state = loadInstalledPluginsFromDisk();
    expect(Object.keys(state.plugins)).toEqual(['only-v2@mp']);
    expect(state.plugins['leaked-from-legacy@mp']).toBeUndefined();
  });

  it('skips legacy entries with unexpected value shapes (null, string, number)', () => {
    seedLegacy({
      'good@mp': [
        { scope: 'user', installPath: '/good/1.0.0', version: '1.0.0' },
      ],
      'string-junk@mp': 'oops',
      'number-junk@mp': 42,
      'null-junk@mp': null,
    });

    const state = loadInstalledPluginsFromDisk();
    expect(Object.keys(state.plugins)).toEqual(['good@mp']);
  });

  it('skips array entries that fail V2 schema (malformed)', () => {
    seedLegacy({
      'good@mp': [
        { scope: 'user', installPath: '/good/1.0.0', version: '1.0.0' },
      ],
      // Array, but the entry is missing required installPath → reject.
      'bad@mp': [{ scope: 'user', version: '1.0.0' }],
    });

    const state = loadInstalledPluginsFromDisk();
    expect(state.plugins['good@mp']).toBeDefined();
    expect(state.plugins['bad@mp']).toBeUndefined();
  });

  it('preserves unknown sibling-owned fields (e.g. source) across add/remove rewrites', () => {
    // Sibling IDE wrote entries carrying a `source` marker the CLI doesn't
    // model. These must survive a whole-state rewrite triggered by unrelated
    // install/uninstall operations.
    seedV2({
      'kept@mp': [
        {
          scope: 'user',
          installPath: '/kept/1.0.0',
          version: '1.0.0',
          source: 'marketplace',
        },
      ],
    });

    // Installing a different plugin rewrites the whole V2 file.
    addPluginInstallation('other@mp', {
      scope: 'user',
      installPath: '/other/1.0.0',
      version: '1.0.0',
    });

    let v2 = readJson(v2Path()) as {
      plugins: Record<string, Array<Record<string, unknown>>>;
    };
    expect(v2.plugins['kept@mp'][0]['source']).toBe('marketplace');

    // Uninstalling the unrelated plugin also rewrites the file — source stays.
    invalidateInstalledPluginsCache();
    removePluginInstallation('other@mp', 'user');

    v2 = readJson(v2Path()) as {
      plugins: Record<string, Array<Record<string, unknown>>>;
    };
    expect(v2.plugins['kept@mp'][0]['source']).toBe('marketplace');
  });

  it('preserves manager-excluded records and paths during marketplace-wide removal', () => {
    const owned = [
      {
        scope: 'user',
        installPath: '/host/owned',
        version: '1',
        source: 'host-marker',
      },
    ];
    seedV2({
      'host-owned@mp': owned,
      'ordinary@mp': [
        { scope: 'user', installPath: '/cli/ordinary', version: '1' },
      ],
    });
    const result = removeAllPluginsForMarketplace(
      'mp',
      (id) => id === 'host-owned@mp',
    );
    expect(result).toEqual({
      removedPluginIds: ['ordinary@mp'],
      orphanedPaths: ['/cli/ordinary'],
    });
    expect(readJson(v2Path())).toEqual({
      version: 2,
      plugins: { 'host-owned@mp': owned },
    });
  });

  it('removes every matching record when no product exclusion is supplied', () => {
    seedV2({
      'host-owned@host-market': [
        { scope: 'user', installPath: '/host/owned', version: '1' },
      ],
      'ordinary@host-market': [
        { scope: 'user', installPath: '/cli/ordinary', version: '1' },
      ],
    });
    expect(
      removeAllPluginsForMarketplace('host-market')?.removedPluginIds,
    ).toEqual(['host-owned@host-market', 'ordinary@host-market']);
    expect(loadInstalledPluginsFromDisk().plugins).toEqual({});
  });

  it('returns empty state when neither V2 nor legacy file exists', () => {
    const state = loadInstalledPluginsFromDisk();
    expect(state).toEqual({ version: 2, plugins: {} });
    expect(existsSync(v2Path())).toBe(false);
  });
});

describe('installedPluginsManager — resilient V2 load', () => {
  it("loads legacy QoderCLI ids whose marketplace segment contains '/'", () => {
    // Old marketplace-add flows used the source string as the marketplace
    // identity, before manifest-name normalization was added.
    seedV2({
      'claude-mem@thedotmack/claude-mem': [
        { scope: 'user', installPath: '/cache/claude-mem', version: '1.0.0' },
      ],
      'normal@mp': [
        { scope: 'user', installPath: '/cache/normal', version: '2.0.0' },
      ],
    });

    const state = loadInstalledPluginsFromDisk();

    expect(Object.keys(state.plugins).sort()).toEqual([
      'claude-mem@thedotmack/claude-mem',
      'normal@mp',
    ]);
    expect(state.plugins['claude-mem@thedotmack/claude-mem']).toHaveLength(1);
  });

  it('salvages valid entries when a single key is invalid, instead of starting fresh', () => {
    seedV2({
      'good@mp': [
        { scope: 'user', installPath: '/cache/good', version: '1.0.0' },
      ],
      // Space in the plugin name → rejected by PluginIdSchema.
      'bad id@mp': [
        { scope: 'user', installPath: '/cache/bad', version: '1.0.0' },
      ],
    });
    const rawBefore = readFileSync(v2Path(), 'utf-8');

    const state = loadInstalledPluginsFromDisk();

    // Valid entry survives; only the offending key is skipped.
    expect(Object.keys(state.plugins)).toEqual(['good@mp']);
    // Load never rewrites the file — the invalid key stays on disk.
    expect(readFileSync(v2Path(), 'utf-8')).toBe(rawBefore);
  });

  it('salvages valid keys when another key has a malformed entry value', () => {
    seedV2({
      'good@mp': [
        { scope: 'user', installPath: '/cache/good', version: '1.0.0' },
      ],
      // Missing required installPath → entry schema rejects.
      'broken-entry@mp': [{ scope: 'user', version: '1.0.0' }],
    });

    const state = loadInstalledPluginsFromDisk();
    expect(Object.keys(state.plugins)).toEqual(['good@mp']);
  });

  it('still starts fresh when the V2 root shape is not a v2 state', () => {
    writeFileSync(
      v2Path(),
      JSON.stringify({ version: 3, plugins: { 'x@mp': [] } }),
    );
    const state = loadInstalledPluginsFromDisk();
    expect(state).toEqual({ version: 2, plugins: {} });
  });
});

describe('installedPluginsManager — concurrent write safety', () => {
  it('does not resurrect an entry another process removed', () => {
    seedV2({
      'keeper@mp': [
        { scope: 'user', installPath: '/cache/keeper/1.0.0', version: '1.0.0' },
      ],
      'removed-elsewhere@mp': [
        { scope: 'user', installPath: '/cache/removed/1.0.0', version: '1.0.0' },
      ],
    });

    // Pull both entries into this process's cache, the way any read-only
    // listing would.
    expect(
      Object.keys(loadInstalledPluginsFromDisk().plugins).sort(),
    ).toEqual(['keeper@mp', 'removed-elsewhere@mp']);

    // Another process uninstalls one of them.
    seedV2({
      'keeper@mp': [
        { scope: 'user', installPath: '/cache/keeper/1.0.0', version: '1.0.0' },
      ],
    });

    // A write in this process must not carry the stale snapshot back to disk.
    addPluginInstallation('newcomer@mp', {
      scope: 'user',
      installPath: '/cache/newcomer/1.0.0',
      version: '1.0.0',
    });

    const onDisk = readJson(v2Path()) as {
      plugins: Record<string, unknown[]>;
    };
    expect(Object.keys(onDisk.plugins).sort()).toEqual([
      'keeper@mp',
      'newcomer@mp',
    ]);
  });

  it('removal targets the current on-disk state, not a cached snapshot', () => {
    seedV2({
      'a@mp': [
        { scope: 'user', installPath: '/cache/a/1.0.0', version: '1.0.0' },
      ],
    });
    loadInstalledPluginsFromDisk();

    // Another process installs something new.
    seedV2({
      'a@mp': [
        { scope: 'user', installPath: '/cache/a/1.0.0', version: '1.0.0' },
      ],
      'b@mp': [
        { scope: 'user', installPath: '/cache/b/2.0.0', version: '2.0.0' },
      ],
    });

    expect(removePluginInstallation('a@mp', 'user')).toBe(true);

    const onDisk = readJson(v2Path()) as {
      plugins: Record<string, unknown[]>;
    };
    expect(Object.keys(onDisk.plugins)).toEqual(['b@mp']);
  });

  it('preserves enterprise metadata when rewriting a managed entry', () => {
    seedV2({
      'ent@qoder-enterprise-acme': [
        {
          scope: 'managed',
          installPath: '/cache/ent/1.0.0',
          version: '1.0.0',
          orgId: 'acme',
          userVisible: true,
          userCanDisable: false,
          fileHash: 'sha256:abc',
          fileSize: 42,
        },
      ],
    });

    addPluginInstallation('other@mp', {
      scope: 'user',
      installPath: '/cache/other/1.0.0',
      version: '1.0.0',
    });

    const onDisk = readJson(v2Path()) as {
      plugins: Record<string, Array<Record<string, unknown>>>;
    };
    expect(onDisk.plugins['ent@qoder-enterprise-acme'][0]).toMatchObject({
      scope: 'managed',
      orgId: 'acme',
      userVisible: true,
      userCanDisable: false,
      fileHash: 'sha256:abc',
      fileSize: 42,
    });
  });
});

describe('installedPluginsManager — unreadable state file', () => {
  it('abandons the write instead of erasing every record', () => {
    seedV2({
      'a@mp': [
        { scope: 'user', installPath: '/cache/a/1.0.0', version: '1.0.0' },
      ],
      'b@mp': [
        { scope: 'user', installPath: '/cache/b/1.0.0', version: '1.0.0' },
      ],
    });

    // Unreadable, but the parent dir stays writable — an atomic
    // write-then-rename would happily replace the file it could not read.
    chmodSync(v2Path(), 0o000);
    if (canStillRead(v2Path())) return; // running as root; nothing to assert

    addPluginInstallation('c@mp', {
      scope: 'user',
      installPath: '/cache/c/1.0.0',
      version: '1.0.0',
    });
    expect(removePluginInstallation('a@mp', 'user')).toBe(false);

    chmodSync(v2Path(), 0o600);
    invalidateInstalledPluginsCache();
    expect(Object.keys(loadInstalledPluginsFromDisk().plugins).sort()).toEqual([
      'a@mp',
      'b@mp',
    ]);
  });

  it('reports the failure instead of pretending the write landed', () => {
    seedV2({
      'a@mp': [
        { scope: 'user', installPath: '/cache/a/1.0.0', version: '1.0.0' },
      ],
    });
    chmodSync(v2Path(), 0o000);
    if (canStillRead(v2Path())) return; // running as root; nothing to assert

    expect(
      addPluginInstallation('c@mp', {
        scope: 'user',
        installPath: '/cache/c/1.0.0',
        version: '1.0.0',
      }),
    ).toBe(false);
    // null, not an empty result: callers must not read this as "no plugins".
    expect(removeAllPluginsForMarketplace('mp')).toBeNull();

    chmodSync(v2Path(), 0o600);
  });
});

describe('installedPluginsManager — corrupt JSON', () => {
  it('still lets a write through when the file cannot be parsed at all', () => {
    writeFileSync(v2Path(), '{ this is not json');

    addPluginInstallation('fresh@mp', {
      scope: 'user',
      installPath: '/cache/fresh/1.0.0',
      version: '1.0.0',
    });

    const onDisk = readJson(v2Path()) as {
      plugins: Record<string, unknown[]>;
    };
    expect(Object.keys(onDisk.plugins)).toEqual(['fresh@mp']);
  });
});

describe('安装登记诊断', () => {
  it('安装与卸载日志记录原因和本地执行身份，不包含插件身份或路径', () => {
    const log = vi.spyOn(runLogger, 'log');
    addPluginInstallation('private-plugin@private-market', {
      scope: 'user',
      installPath: join(workspaceRoot, 'private-content'),
      version: '1.0',
    });
    removePluginInstallation('private-plugin@private-market', 'user');
    const writes = log.mock.calls.filter(
      ([message]) => message === '[InstalledPlugins] State write',
    );
    expect(writes).toContainEqual([
      '[InstalledPlugins] State write',
      expect.objectContaining({
        event: 'begin',
        reason: 'plugin-install',
        pid: expect.any(Number),
        threadId: expect.any(Number),
      }),
    ]);
    expect(writes).toContainEqual([
      '[InstalledPlugins] State write',
      expect.objectContaining({
        event: 'complete',
        reason: 'plugin-uninstall',
      }),
    ]);
    expect(JSON.stringify(writes)).not.toContain('private-plugin');
    expect(JSON.stringify(writes)).not.toContain(workspaceRoot);
  });

  it('空文件与不完整 JSON 的读取诊断保持原有空状态降级', () => {
    const warn = vi.spyOn(runLogger, 'warn');
    for (const content of ['', '{"version":2,']) {
      writeFileSync(v2Path(), content);
      invalidateInstalledPluginsCache();
      expect(loadInstalledPluginsFromDisk()).toEqual({
        version: 2,
        plugins: {},
      });
      expect(warn).toHaveBeenCalledWith(
        '[InstalledPlugins] State read failed',
        expect.objectContaining({
          errorCode: 'JSON_INVALID',
          readByteLength: Buffer.byteLength(content),
          empty: content.length === 0,
          mtimeMs: expect.any(Number),
        }),
      );
    }
  });
});

describe('installedPluginsManager — cross-process cache freshness', () => {
  // daemon 常驻进程里，installed_plugins_v2.json 的写者可以在别的进程（app main
  // 插件事务、sibling IDE）。它们没有通道调 invalidateInstalledPluginsCache()，
  // 读侧指纹自校验是唯一的失效通道：下列用例全程不显式 invalidate。
  it('external V2 rewrite invalidates the cache without an explicit invalidate', () => {
    seedV2({ 'a@mp': [{ scope: 'user', installPath: '/cache/a/1.0.0' }] });
    expect(Object.keys(loadInstalledPluginsFromDisk().plugins)).toEqual([
      'a@mp',
    ]);

    seedV2({
      'a@mp': [{ scope: 'user', installPath: '/cache/a/1.0.0' }],
      'b@mp': [{ scope: 'user', installPath: '/cache/b/1.0.0' }],
    });

    expect(
      Object.keys(loadInstalledPluginsFromDisk().plugins).sort(),
    ).toEqual(['a@mp', 'b@mp']);
  });

  it('external V2 creation invalidates a cached empty state', () => {
    expect(loadInstalledPluginsFromDisk().plugins).toEqual({});

    seedV2({ 'a@mp': [{ scope: 'user', installPath: '/cache/a/1.0.0' }] });

    expect(Object.keys(loadInstalledPluginsFromDisk().plugins)).toEqual([
      'a@mp',
    ]);
  });

  it('external legacy write is picked up while V2 is still absent', () => {
    expect(loadInstalledPluginsFromDisk().plugins).toEqual({});

    seedLegacy({ 'a@mp': [{ scope: 'user', installPath: '/cache/a/1.0.0' }] });

    expect(Object.keys(loadInstalledPluginsFromDisk().plugins)).toEqual([
      'a@mp',
    ]);
  });

  it('keeps the cached snapshot while both protocol files are untouched', () => {
    seedV2({ 'a@mp': [{ scope: 'user', installPath: '/cache/a/1.0.0' }] });
    const first = loadInstalledPluginsFromDisk();
    const second = loadInstalledPluginsFromDisk();
    expect(second).toBe(first);
  });
});
