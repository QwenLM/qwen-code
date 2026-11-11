/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_PLUGIN_META_DIR } from '../../config/brand.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPluginFromDirectory } from '../pluginLoader.js';
import { collectPluginResources } from './pluginResourceCollector.js';
import type { LoadedPlugin } from '../types.js';
import { runLogger } from '../../utils/runLogger.js';
import { drainSkillLoadErrors } from '@qwen-code/resource';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  drainSkillLoadErrors();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makePlugin(
  name: string,
  overrides: Partial<LoadedPlugin> = {},
): LoadedPlugin {
  return {
    name,
    manifest: { name, version: '1.0.0' } as never,
    path: `/plugins/${name}`,
    source: 'test',
    repository: 'test',
    ...overrides,
  };
}

describe('collectPluginResources', () => {
  it('collects Plugin Skill metadata through the canonical loader', async () => {
    const pluginDir = await mkdtemp(
      join(tmpdir(), 'plugin-skill-resource-collector-test-'),
    );
    tempDirs.push(pluginDir);
    await mkdir(join(pluginDir, BRAND_PLUGIN_META_DIR), { recursive: true });
    await mkdir(join(pluginDir, 'skills', 'repro-skill'), { recursive: true });
    await writeFile(
      join(pluginDir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
      JSON.stringify({
        name: 'plugin-skill-frontmatter-repro',
        version: '1.0.0',
      }),
    );
    await writeFile(
      join(pluginDir, 'skills', 'repro-skill', 'SKILL.md'),
      [
        '---',
        'name: repro-skill',
        'description: Demonstrates extended Skill metadata collection',
        'argument-hint: "[file]"',
        '---',
        '',
        '# Reproduction Skill',
      ].join('\n'),
    );

    const loaded = await loadPluginFromDirectory(
      pluginDir,
      'local',
      'test',
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    drainSkillLoadErrors();
    const resources = await collectPluginResources(loaded.plugin);

    expect(resources.skills).toEqual([
      {
        name: 'repro-skill',
        description: 'Demonstrates extended Skill metadata collection',
        argumentHint: '[file]',
      },
    ]);
    expect(drainSkillLoadErrors()).toEqual([]);
  });

  it('collects an Agent declared as a single Markdown file', async () => {
    const pluginDir = await mkdtemp(
      join(tmpdir(), 'plugin-resource-collector-test-'),
    );
    tempDirs.push(pluginDir);
    await mkdir(join(pluginDir, BRAND_PLUGIN_META_DIR), { recursive: true });
    await mkdir(join(pluginDir, 'agents'), { recursive: true });
    await writeFile(
      join(pluginDir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
      JSON.stringify({
        name: 'single-file-plugin',
        version: '1.0.0',
        description: 'Plugin with an explicit agent file',
        agents: './agents/reviewer.md',
      }),
    );
    await writeFile(
      join(pluginDir, 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\ncolor: blue\n---\nReview carefully.',
    );

    const loaded = await loadPluginFromDirectory(
      pluginDir,
      'test',
      'test',
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const resources = await collectPluginResources(loaded.plugin);

    expect(resources.agents).toEqual([
      {
        name: 'single-file-plugin:reviewer',
        description: 'Reviews code',
        color: 'blue',
      },
    ]);
  });

  it('keeps every plugin when one has a malformed hook definition', async () => {
    const healthyPlugin = makePlugin('healthy-plugin', {
      hooksConfig: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'echo healthy' }],
          },
        ],
      },
    } as Partial<LoadedPlugin>);
    const malformedPlugin = makePlugin('malformed-plugin', {
      hooksConfig: {
        PreToolUse: [
          { matcher: 'Write', hooks: { type: 'command' } },
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'echo valid' }],
          },
        ],
      },
    } as unknown as Partial<LoadedPlugin>);

    const plugins = await Promise.all(
      [healthyPlugin, malformedPlugin].map(async (plugin) => ({
        name: plugin.name,
        resources: await collectPluginResources(plugin),
      })),
    );

    expect(plugins.map((plugin) => plugin.name)).toEqual([
      'healthy-plugin',
      'malformed-plugin',
    ]);
    expect(plugins[0].resources.hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Read', type: 'command' },
    ]);
    expect(plugins[1].resources.hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Read', type: 'command' },
    ]);
  });

  it('keeps healthy resources when one component collector throws', async () => {
    const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    const plugin = makePlugin('partial-plugin', {
      hooksConfig: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'echo healthy' }],
          },
        ],
      },
    } as Partial<LoadedPlugin>);
    Object.defineProperty(plugin, 'mcpServers', {
      get() {
        throw new Error('broken MCP projection');
      },
    });

    const resources = await collectPluginResources(plugin);

    expect(resources.mcpServers).toEqual([]);
    expect(resources.hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Read', type: 'command' },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Plugin Resource Collector] Failed to collect mcpServers for plugin "partial-plugin": broken MCP projection',
    );
  });
});
