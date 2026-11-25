/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_PLUGIN_META_DIR } from '../config/brand.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  findManifestPath,
  loadPluginFromDirectory,
  loadAllPlugins,
  looksLikePluginRoot,
} from './pluginLoader.js';
import { createHookConfigurationRef, getPluginHookRef } from '../hooks/hookConfigurationRef.js';
import { runLogger } from '../utils/runLogger.js';

describe('pluginLoader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'plugin-loader-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it.each(['.qwen-plugin', '.claude-plugin'])(
    'loads identity and declared resources from %s/plugin.json',
    async (metaDir) => {
      const dir = join(tmpDir, '中文 空格', 'test-plugin');
      const manifestPath = join(dir, metaDir, 'plugin.json');
      const manifest = {
        name: 'p0-test-plugin',
        version: '1.0.0',
        description: 'Manifest description',
        commands: { hello: { content: 'Hello from manifest' } },
      };
      await mkdir(join(dir, metaDir), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(manifest));

      expect(await findManifestPath(dir)).toBe(manifestPath);
      expect(await looksLikePluginRoot(dir)).toBe(true);
      const loaded = await loadPluginFromDirectory(dir, 'local', 'local');
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error('Plugin failed to load');
      expect(loaded.plugin.name).toBe(manifest.name);
      expect(loaded.plugin.manifest).toMatchObject(manifest);
    },
  );

  it('prefers the Qwen manifest when compatibility manifests also exist', async () => {
    const dir = await createPlugin('test-plugin');
    await mkdir(join(dir, '.claude-plugin'));
    await writeFile(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'legacy-name', version: '0.1.0' }),
    );
    await mkdir(join(dir, '.qwen-plugin'));
    await writeFile(
      join(dir, '.qwen-plugin', 'plugin.json'),
      JSON.stringify({ name: 'qwen-name', version: '1.0.0' }),
    );
    const loaded = await loadPluginFromDirectory(dir, 'local', 'local');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Plugin failed to load');
    expect(loaded.plugin.name).toBe('qwen-name');
    expect(loaded.plugin.manifest.version).toBe('1.0.0');
  });

  it('reports a malformed Qwen manifest instead of falling back', async () => {
    const dir = await createPlugin('test-plugin', {
      dirs: ['skills'],
    });
    await mkdir(join(dir, '.claude-plugin'));
    await writeFile(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'legacy-name' }),
    );
    await mkdir(join(dir, '.qwen-plugin'));
    await writeFile(join(dir, '.qwen-plugin', 'plugin.json'), '{invalid');
    const loaded = await loadPluginFromDirectory(dir, 'local', 'local');
    expect(loaded).toMatchObject({
      ok: false,
      error: {
        type: 'manifest-parse-error',
        manifestPath: join(dir, '.qwen-plugin', 'plugin.json'),
      },
    });
  });

  it('preserves declaration positions across merged hook files and inline declarations', async () => {
    const hook = { type: 'command', command: '' };
    const config = { PreToolUse: [{ hooks: [hook] }] };
    const root = await createPlugin('refs', { manifest: { name: 'refs', hooks: ['./first.json', './second.json', config] } });
    await writeFile(join(root, 'first.json'), JSON.stringify({ hooks: config }));
    await writeFile(join(root, 'second.json'), JSON.stringify(config));
    const loaded = await loadPluginFromDirectory(root, 'local', 'local');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('load failed');
    const groups = loaded.plugin.hooksConfig!.PreToolUse!;
    const sources = [`plugin:${join(root, 'first.json')}`, `plugin:${join(root, 'second.json')}`, `plugin:${join(root, `${BRAND_PLUGIN_META_DIR}/plugin.json`)}#manifest.hooks[2]`];
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => getPluginHookRef(group, 0))).toEqual(sources.map((source) => createHookConfigurationRef(source, 'PreToolUse', 0, 0, hook)));
  });

  // Helper to create a plugin directory with optional manifest and convention dirs
  async function createPlugin(
    name: string,
    opts: {
      manifest?: Record<string, unknown>;
      dirs?: string[];
      hooksJson?: Record<string, unknown>;
      mcpJson?: Record<string, unknown>;
      /** Same shape as `mcpJson` but written to `mcp.json` (no leading dot). */
      mcpJsonFlat?: Record<string, unknown>;
      /** Raw string overrides — useful for testing malformed JSON. */
      mcpJsonRaw?: string;
      mcpJsonFlatRaw?: string;
    } = {},
  ) {
    const pluginDir = join(tmpDir, name);
    await mkdir(pluginDir, { recursive: true });

    if (opts.manifest) {
      await mkdir(join(pluginDir, BRAND_PLUGIN_META_DIR), { recursive: true });
      await writeFile(
        join(pluginDir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
        JSON.stringify(opts.manifest),
      );
    }

    for (const dir of opts.dirs ?? []) {
      await mkdir(join(pluginDir, dir), { recursive: true });
    }

    if (opts.hooksJson) {
      await mkdir(join(pluginDir, 'hooks'), { recursive: true });
      await writeFile(
        join(pluginDir, 'hooks', 'hooks.json'),
        JSON.stringify(opts.hooksJson),
      );
    }

    if (opts.mcpJson) {
      await writeFile(
        join(pluginDir, '.mcp.json'),
        JSON.stringify(opts.mcpJson),
      );
    } else if (opts.mcpJsonRaw !== undefined) {
      await writeFile(join(pluginDir, '.mcp.json'), opts.mcpJsonRaw);
    }

    if (opts.mcpJsonFlat) {
      await writeFile(
        join(pluginDir, 'mcp.json'),
        JSON.stringify(opts.mcpJsonFlat),
      );
    } else if (opts.mcpJsonFlatRaw !== undefined) {
      await writeFile(join(pluginDir, 'mcp.json'), opts.mcpJsonFlatRaw);
    }

    return pluginDir;
  }

  describe('manifest vs convention mutual exclusion', () => {
    it('uses convention dirs when no manifest exists', async () => {
      const dir = await createPlugin('my-plugin', {
        dirs: [
          'commands',
          'agents',
          'skills',
          'output-styles',
          'workflows',
          'bin',
        ],
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.name).toBe('my-plugin');
      expect(result.plugin.commandsPath).toBe(join(dir, 'commands'));
      expect(result.plugin.agentsPath).toBe(join(dir, 'agents'));
      expect(result.plugin.skillsPath).toBe(join(dir, 'skills'));
      expect(result.plugin.outputStylesPath).toBe(join(dir, 'output-styles'));
      expect(result.plugin.workflowsPath).toBe(join(dir, 'workflows'));
      expect(result.plugin.binPath).toBe(join(dir, 'bin'));
      // No manifest-declared paths
      expect(result.plugin.commandsPaths).toBeUndefined();
      expect(result.plugin.agentsPaths).toBeUndefined();
      expect(result.plugin.skillsPaths).toBeUndefined();
      expect(result.plugin.outputStylesPaths).toBeUndefined();
      expect(result.plugin.workflowsPaths).toBeUndefined();
    });

    it('skips convention dir when manifest declares the field', async () => {
      // Create skills/ convention dir AND declare skills in manifest
      const skillsExtra = join(tmpDir, 'extra-skills');
      await mkdir(skillsExtra, { recursive: true });

      const dir = await createPlugin('my-plugin', {
        manifest: {
          name: 'my-plugin',
          skills: [`./${skillsExtra.split('/').pop()}`],
        },
        dirs: ['skills', 'commands'], // both exist on disk
      });

      // Create the manifest-declared skills path relative to plugin dir
      const manifestSkillsDir = join(dir, 'manifest-skills');
      await mkdir(manifestSkillsDir, { recursive: true });

      // Re-create with correct relative path
      await writeFile(
        join(dir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
        JSON.stringify({
          name: 'my-plugin',
          skills: ['./manifest-skills'],
        }),
      );

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // skills/ convention dir should be ignored (manifest declares skills)
      expect(result.plugin.skillsPath).toBeUndefined();
      // Manifest-declared path should be used
      expect(result.plugin.skillsPaths).toEqual([manifestSkillsDir]);
      // commands/ convention dir should still work (manifest doesn't declare commands)
      expect(result.plugin.commandsPath).toBe(join(dir, 'commands'));
    });

    it('partial exclusion: manifest declares skills but not commands', async () => {
      const dir = await createPlugin('partial', {
        dirs: ['commands', 'skills', 'manifest-skills'],
        manifest: {
          name: 'partial',
          skills: ['./manifest-skills'],
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // commands: convention used (not declared in manifest)
      expect(result.plugin.commandsPath).toBe(join(dir, 'commands'));
      expect(result.plugin.commandsPaths).toBeUndefined();
      // skills: manifest used (declared in manifest)
      expect(result.plugin.skillsPath).toBeUndefined();
      expect(result.plugin.skillsPaths).toEqual([join(dir, 'manifest-skills')]);
    });
  });

  describe('bin/ convention directory', () => {
    it('leaves binPath undefined when bin/ does not exist', async () => {
      const dir = await createPlugin('my-plugin', { dirs: ['skills'] });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.binPath).toBeUndefined();
    });

    it('sets binPath when bin/ directory exists', async () => {
      const dir = await createPlugin('my-plugin', { dirs: ['bin'] });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.binPath).toBe(join(dir, 'bin'));
    });

    it('detects bin/ even when manifest declares other component fields', async () => {
      // Manifest declares `skills` but bin/ has no manifest field — should still be detected.
      const skillsExtra = join(tmpDir, 'extra-skills');
      await mkdir(skillsExtra, { recursive: true });
      const dir = await createPlugin('my-plugin', {
        manifest: {
          name: 'my-plugin',
          skills: [`./${skillsExtra.split('/').pop()}`],
        },
        dirs: ['bin'],
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.binPath).toBe(join(dir, 'bin'));
    });
  });

  describe('manifest.name takes effect without feature flag', () => {
    it('uses manifest.name when manifest exists', async () => {
      const dir = await createPlugin('folder-name', {
        manifest: { name: 'manifest-name', version: '2.0.0' },
        dirs: ['skills'],
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.name).toBe('manifest-name');
    });

    it('nameOverride takes highest priority', async () => {
      const dir = await createPlugin('folder-name', {
        manifest: { name: 'manifest-name' },
        dirs: ['skills'],
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test', {
        nameOverride: 'override-name',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.name).toBe('override-name');
    });

    it('falls back to folder name when no manifest', async () => {
      const dir = await createPlugin('my-folder', {
        dirs: ['skills'],
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.name).toBe('my-folder');
    });
  });

  it.each([false, true])('preserves Hook parser errors and clears them after repair (manifest=%s)', async (manifestHooks) => {
    const dir = await createPlugin('hook-errors', {
      manifest: {
        name: 'hook-errors',
        ...(manifestHooks ? { hooks: './hooks/hooks.json' } : {}),
      },
      dirs: ['hooks'],
    });
    const hookPath = join(dir, 'hooks', 'hooks.json');
    await writeFile(hookPath, '{ invalid json');
    const broken = await loadAllPlugins([dir], 'test', 'test');
    expect(broken.enabled).toHaveLength(1);
    expect(broken.errors).toEqual([
      expect.objectContaining({ type: 'hook-load-failed', hookPath }),
    ]);
    await writeFile(hookPath, JSON.stringify({ hooks: {} }));
    const repaired = await loadAllPlugins([dir], 'test', 'test');
    expect(repaired.enabled).toHaveLength(1);
    expect(repaired.errors).toEqual([]);
  });

  describe('path-not-found warnings', () => {
    it('reports path-not-found when manifest declares non-existent path', async () => {
      const dir = await createPlugin('warn-plugin', {
        manifest: {
          name: 'warn-plugin',
          skills: ['./nonexistent-dir'],
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.warnings).toBeDefined();
      expect(result.plugin.warnings).toHaveLength(1);
      expect(result.plugin.warnings![0]).toMatchObject({
        type: 'path-not-found',
        plugin: 'warn-plugin',
        component: 'skills',
      });
      // Plugin still loads successfully
      expect(result.plugin.skillsPaths).toBeUndefined();
    });

    it('loadAllPlugins surfaces warnings in errors array', async () => {
      const dir = await createPlugin('warn-plugin2', {
        manifest: {
          name: 'warn-plugin2',
          skills: ['./missing-skills'],
        },
      });

      const result = await loadAllPlugins([dir], 'test', 'test');
      expect(result.enabled).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        type: 'path-not-found',
        component: 'skills',
      });
    });
  });

  describe('manifest path containment', () => {
    it('rejects an existing manifest path outside the plugin root', async () => {
      const outsideSkills = join(tmpDir, 'outside-skills');
      await mkdir(outsideSkills, { recursive: true });
      const dir = await createPlugin('escape-plugin', {
        manifest: {
          name: 'escape-plugin',
          skills: './../outside-skills',
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.skillsPaths).toBeUndefined();
      expect(result.plugin.warnings).toHaveLength(1);
      expect(result.plugin.warnings![0]).toMatchObject({
        type: 'component-load-failed',
        plugin: 'escape-plugin',
        component: 'skills',
        reason: 'Path resolves outside the plugin root',
      });
    });

    it('accepts an in-plugin manifest path symlinked outside', async () => {
      const outsideSkills = join(tmpDir, 'outside-symlink-skills');
      await mkdir(outsideSkills, { recursive: true });
      const dir = await createPlugin('symlink-escape-plugin', {
        manifest: {
          name: 'symlink-escape-plugin',
          skills: './linked-skills',
        },
      });
      await symlink(outsideSkills, join(dir, 'linked-skills'), 'dir');

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.skillsPaths).toEqual([join(dir, 'linked-skills')]);
      expect(result.plugin.warnings ?? []).toEqual([]);
    });
  });

  describe('manifest path existence-only validation', () => {
    it('accepts a single .md file declared in commands', async () => {
      const dir = await createPlugin('single-file-cmd', {
        manifest: {
          name: 'single-file-cmd',
          commands: './extra/cmd.md',
        },
      });
      await mkdir(join(dir, 'extra'), { recursive: true });
      await writeFile(
        join(dir, 'extra', 'cmd.md'),
        '---\ndescription: standalone\n---\nbody',
      );

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.warnings ?? []).toHaveLength(0);
      expect(result.plugin.commandsPaths).toEqual([
        join(dir, 'extra', 'cmd.md'),
      ]);
    });

    it('accepts workflow paths declared in workflowsPath and workflowsPaths', async () => {
      const dir = await createPlugin('workflow-plugin', {
        manifest: {
          name: 'workflow-plugin',
          workflowsPath: './workflow-pack',
          workflowsPaths: ['./single.js'],
        },
        dirs: ['workflows'],
      });
      await mkdir(join(dir, 'workflow-pack'), { recursive: true });
      await writeFile(join(dir, 'single.js'), 'export const meta = {};');

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.workflowsPath).toBeUndefined();
      expect(result.plugin.workflowsPaths).toEqual([
        join(dir, 'workflow-pack'),
        join(dir, 'single.js'),
      ]);
    });

    it('accepts a single .md file declared in output-styles', async () => {
      const dir = await createPlugin('single-file-style', {
        manifest: {
          name: 'single-file-style',
          outputStyles: './extra/style.md',
        },
      });
      await mkdir(join(dir, 'extra'), { recursive: true });
      await writeFile(
        join(dir, 'extra', 'style.md'),
        '---\nname: extra-style\n---\nbody',
      );

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.warnings ?? []).toHaveLength(0);
      expect(result.plugin.outputStylesPaths).toEqual([
        join(dir, 'extra', 'style.md'),
      ]);
    });
  });

  describe('settings allowlist', () => {
    it('only keeps allowlisted keys from manifest.settings', async () => {
      const dir = await createPlugin('settings-plugin', {
        manifest: {
          name: 'settings-plugin',
          settings: {
            agent: { model: 'fast' },
            foo: 'bar',
            baz: 123,
          },
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.settings).toEqual({ agent: { model: 'fast' } });
    });

    it('sets settings to undefined when no allowlisted keys', async () => {
      const dir = await createPlugin('no-settings', {
        manifest: {
          name: 'no-settings',
          settings: { foo: 'bar', baz: 123 },
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.settings).toBeUndefined();
    });
  });

  describe('hooks mutual exclusion', () => {
    it('loads convention hooks/hooks.json when manifest does not declare hooks', async () => {
      const dir = await createPlugin('hook-convention', {
        manifest: { name: 'hook-convention' },
        hooksJson: {
          description: 'test hooks',
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo hi' }],
              },
            ],
          },
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.hooksConfig).toBeDefined();
      expect(result.plugin.hooksConfig!['PreToolUse']).toHaveLength(1);
    });

    it('does NOT load convention hooks when manifest declares hooks', async () => {
      const dir = await createPlugin('hook-manifest', {
        manifest: {
          name: 'hook-manifest',
          hooks: {
            PostToolUse: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: 'echo post' }],
              },
            ],
          },
        },
        hooksJson: {
          description: 'should be ignored',
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo pre' }],
              },
            ],
          },
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Convention hooks (PreToolUse) should NOT be loaded
      expect(result.plugin.hooksConfig?.['PreToolUse']).toBeUndefined();
      // Manifest hooks (PostToolUse) should be loaded
      expect(result.plugin.hooksConfig?.['PostToolUse']).toHaveLength(1);
    });

    it('preserves exec-form { command, args } fields from hooks.json', async () => {
      const dir = await createPlugin('hook-exec-form', {
        manifest: { name: 'hook-exec-form' },
        hooksJson: {
          description: 'exec form hook',
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: '/usr/bin/python3',
                    args: ['${QWEN_PLUGIN_ROOT}/scripts/check.py', '--strict'],
                  },
                ],
              },
            ],
          },
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const preHooks = result.plugin.hooksConfig?.['PreToolUse'];
      expect(preHooks).toHaveLength(1);
      const handler = preHooks![0].hooks[0] as {
        command: string;
        args?: string[];
      };
      expect(handler.command).toBe('/usr/bin/python3');
      expect(handler.args).toEqual([
        '${QWEN_PLUGIN_ROOT}/scripts/check.py',
        '--strict',
      ]);
    });
  });

  describe('commandsMetadata from manifest', () => {
    it('extracts command metadata from object-mapping format', async () => {
      const dir = await createPlugin('cmd-plugin', {
        manifest: {
          name: 'cmd-plugin',
          commands: {
            deploy: {
              content: '# Deploy\nDeploy the app',
              description: 'Deploy',
            },
          },
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.plugin.commandsMetadata).toBeDefined();
      expect(result.plugin.commandsMetadata!['deploy']).toMatchObject({
        content: '# Deploy\nDeploy the app',
        description: 'Deploy',
      });
      // Convention commands/ should be skipped since manifest declares commands
      expect(result.plugin.commandsPath).toBeUndefined();
    });
  });

  describe('manifest parse error', () => {
    it('returns error for invalid manifest', async () => {
      const dir = await createPlugin('bad-manifest', {});
      await mkdir(join(dir, BRAND_PLUGIN_META_DIR), { recursive: true });
      await writeFile(
        join(dir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
        '{ invalid json }',
      );

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.type).toBe('manifest-parse-error');
    });

    it('returns error for manifest missing required name field', async () => {
      const dir = await createPlugin('no-name', {});
      await mkdir(join(dir, BRAND_PLUGIN_META_DIR), { recursive: true });
      await writeFile(
        join(dir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
        JSON.stringify({ version: '1.0.0' }),
      );

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.type).toBe('manifest-parse-error');
    });
  });

  describe('mcp.json convention fallback (no leading dot)', () => {
    it('a flat plugin whose only convention file is `mcp.json` is recognized and loads its servers', async () => {
      // No manifest, no commands/, no .mcp.json — only `mcp.json`. The
      // PLUGIN_CONVENTION_ENTRIES entry must make this dir count as a plugin
      // so loadAllPlugins's discovery logic picks it up.
      const dir = await createPlugin('mcp-only', {
        mcpJsonFlat: { mcpServers: { foo: { command: 'foo-cmd' } } },
      });

      const result = await loadAllPlugins([dir], 'test', 'test');
      expect(result.enabled).toHaveLength(1);
      const plugin = result.enabled[0];
      expect(plugin.mcpServers).toBeDefined();
      expect(plugin.mcpServers?.['foo']).toMatchObject({ command: 'foo-cmd' });
    });

    it('when both `.mcp.json` and `mcp.json` exist, .mcp.json wins (never merged)', async () => {
      const dir = await createPlugin('both', {
        manifest: { name: 'both', version: '1.0.0' },
        mcpJson: { mcpServers: { 'from-dot': { command: 'wins' } } },
        mcpJsonFlat: {
          mcpServers: { 'from-flat': { command: 'should-be-ignored' } },
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.plugin.mcpServers ?? {})).toEqual(['from-dot']);
      expect(result.plugin.mcpServers?.['from-flat']).toBeUndefined();
    });

    it('manifest.mcpServers still takes precedence over convention on key conflict', async () => {
      // Both files declare a server named `s`; manifest's wins. Convention's
      // unique-key servers should still be retained (existing merge semantics).
      const dir = await createPlugin('manifest-wins', {
        manifest: {
          name: 'manifest-wins',
          version: '1.0.0',
          mcpServers: {
            s: { command: 'manifest-impl' },
            extra: { command: 'manifest-only' },
          },
        },
        mcpJsonFlat: {
          mcpServers: {
            s: { command: 'convention-impl' },
            conv: { command: 'convention-only' },
          },
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const servers = result.plugin.mcpServers ?? {};
      expect(servers['s']).toMatchObject({ command: 'manifest-impl' });
      expect(servers['extra']).toMatchObject({ command: 'manifest-only' });
      expect(servers['conv']).toMatchObject({ command: 'convention-only' });
    });

    it('malformed `mcp.json` does NOT block plugin load (servers fall back to manifest only)', async () => {
      const dir = await createPlugin('malformed', {
        manifest: {
          name: 'malformed',
          version: '1.0.0',
          mcpServers: { ok: { command: 'still-loads' } },
        },
        mcpJsonFlatRaw: '{ not: valid json',
      });

      const result = await loadPluginFromDirectory(dir, 'test', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plugin.mcpServers?.['ok']).toMatchObject({
        command: 'still-loads',
      });
      expect(result.plugin.warnings ?? []).toHaveLength(0);

      const validationResult = await loadPluginFromDirectory(
        dir,
        'test',
        'test',
        { collectValidationWarnings: true },
      );
      expect(validationResult.ok).toBe(true);
      if (!validationResult.ok) return;
      expect(validationResult.plugin.warnings).toEqual([
        expect.objectContaining({
          type: 'component-load-failed',
          component: 'mcp-servers',
        }),
      ]);
    });
  });

  describe('recognized-but-unimplemented manifest fields', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('logs a warning when manifest contains lspServers and still loads', async () => {
      const dir = await createPlugin('with-lsp', {
        manifest: {
          name: 'with-lsp',
          version: '1.0.0',
          lspServers: { ts: { command: 'tsserver' } },
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test-source', 'test');
      expect(result.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/lspServers/);
    });

    it('logs a warning when manifest contains channels', async () => {
      const dir = await createPlugin('with-channels', {
        manifest: {
          name: 'with-channels',
          version: '1.0.0',
          channels: [{ server: 'chat-x' }],
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test-source', 'test');
      expect(result.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/channels/);
    });

    it('does not log a warning when neither field is present', async () => {
      const dir = await createPlugin('plain', {
        manifest: { name: 'plain', version: '1.0.0' },
      });

      const result = await loadPluginFromDirectory(dir, 'test-source', 'test');
      expect(result.ok).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not surface lspServers/channels on the LoadedPlugin', async () => {
      const dir = await createPlugin('with-foreign', {
        manifest: {
          name: 'with-foreign',
          version: '1.0.0',
          lspServers: { rust: { command: 'rust-analyzer' } },
          channels: [{ server: 'team' }],
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test-source', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Guard against future refactors that spread `manifest` into the plugin object
      const asRecord = result.plugin as unknown as Record<string, unknown>;
      expect(asRecord['lspServers']).toBeUndefined();
      expect(asRecord['channels']).toBeUndefined();
    });
  });

  describe('manifest displayName field', () => {
    it('copies displayName from manifest to LoadedPlugin', async () => {
      const dir = await createPlugin('with-display', {
        manifest: {
          name: 'with-display',
          version: '1.0.0',
          displayName: 'With Display',
        },
      });

      const result = await loadPluginFromDirectory(dir, 'test-source', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plugin.displayName).toBe('With Display');
    });

    it('leaves displayName undefined when manifest omits it', async () => {
      const dir = await createPlugin('no-display', {
        manifest: { name: 'no-display', version: '1.0.0' },
      });

      const result = await loadPluginFromDirectory(dir, 'test-source', 'test');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plugin.displayName).toBeUndefined();
    });
  });
});
