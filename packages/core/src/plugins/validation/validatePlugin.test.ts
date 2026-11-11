/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_PLUGIN_META_DIR } from '../../config/brand.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validatePlugin, validatePluginManifest } from './validatePlugin.js';

const tmpDirs: string[] = [];

async function makeManifest(content: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'test-validate-test-'));
  tmpDirs.push(dir);
  const filePath = join(dir, 'plugin.json');
  await writeFile(filePath, JSON.stringify(content));
  return filePath;
}

async function makePlugin(manifest?: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'test-plugin-report-test-'));
  tmpDirs.push(dir);
  if (manifest) {
    const metaDir = join(dir, BRAND_PLUGIN_META_DIR);
    await mkdir(metaDir, { recursive: true });
    await writeFile(join(metaDir, 'plugin.json'), JSON.stringify(manifest));
  }
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('validatePluginManifest — recognized-but-unimplemented fields', () => {
  it('produces a warning for lspServers, not an error', async () => {
    const filePath = await makeManifest({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test',
      lspServers: { ts: { command: 'tsserver' } },
    });

    const result = await validatePluginManifest(filePath);

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    const lspWarning = result.warnings.find((w) => w.path === 'lspServers');
    expect(lspWarning).toBeDefined();
    expect(lspWarning?.message).toMatch(/not yet implemented/);
  });

  it('produces a warning for channels, not an error', async () => {
    const filePath = await makeManifest({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test',
      channels: [{ server: 'x' }],
    });

    const result = await validatePluginManifest(filePath);

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    const channelsWarning = result.warnings.find((w) => w.path === 'channels');
    expect(channelsWarning).toBeDefined();
  });

  it('produces two warnings when both fields are present', async () => {
    const filePath = await makeManifest({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test',
      lspServers: { ts: 'value' },
      channels: [{ server: 'y' }],
    });

    const result = await validatePluginManifest(filePath);

    expect(result.success).toBe(true);
    expect(
      result.warnings.filter(
        (w) => w.path === 'lspServers' || w.path === 'channels',
      ),
    ).toHaveLength(2);
  });

  it('surfaces unknown fields as warnings because runtime ignores them', async () => {
    const filePath = await makeManifest({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test',
      lspServers: { ts: 'value' },
      bogus: 1,
    });

    const result = await validatePluginManifest(filePath);

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(
      result.warnings.find(
        (warning) =>
          warning.path === 'bogus' &&
          warning.code === 'plugin.manifest.unknown_field',
      ),
    ).toBeDefined();
    expect(result.warnings.find((w) => w.path === 'lspServers')).toBeDefined();
  });
});

describe('validatePluginManifest — displayName', () => {
  it('accepts displayName in strict mode without error or warning', async () => {
    const filePath = await makeManifest({
      name: 'test-plugin',
      version: '1.0.0',
      displayName: 'Test Plugin',
    });

    const result = await validatePluginManifest(filePath);

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(
      result.warnings.find((w) => w.path === 'displayName'),
    ).toBeUndefined();
  });
});

describe('validatePlugin — unified report', () => {
  it.each(['directory', 'manifest'])(
    'validates a Qwen plugin %s with its declared identity and resources',
    async (target) => {
      const dir = await makePlugin();
      await mkdir(join(dir, '.qwen-plugin'));
      const manifestPath = join(dir, '.qwen-plugin', 'plugin.json');
      await writeFile(
        manifestPath,
        JSON.stringify({
          name: 'qwen-manifest-name',
          version: '1.0.0',
          commands: { hello: { content: 'Hello' } },
        }),
      );
      const report = await validatePlugin(
        target === 'directory' ? dir : manifestPath,
      );
      expect(report.valid).toBe(true);
      expect(report.target.manifestPath).toBe('.qwen-plugin/plugin.json');
      expect(report.plugin).toMatchObject({
        name: 'qwen-manifest-name',
        version: '1.0.0',
      });
      expect(report.resources?.commands).toHaveLength(1);
    },
  );

  it('returns a valid report and resource inventory for a convention plugin', async () => {
    const dir = await makePlugin({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test plugin',
    });
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(
      join(dir, 'commands', 'hello.md'),
      '---\ndescription: Say hello\n---\nHello',
    );

    const report = await validatePlugin(dir);

    expect(report.valid).toBe(true);
    expect(report.schemaVersion).toBe(1);
    expect(report.plugin?.name).toBe('test-plugin');
    expect(report.target.manifestPath).toBe(`${BRAND_PLUGIN_META_DIR}/plugin.json`);
    expect(report.resources?.commands).toHaveLength(1);
    expect(report.summary.errorCount).toBe(0);
  });

  it('returns target errors instead of throwing for a missing path', async () => {
    const report = await validatePlugin(
      join(tmpdir(), 'test-plugin-does-not-exist'),
    );

    expect(report.valid).toBe(false);
    expect(report.diagnostics[0]?.code).toBe('plugin.target.not_found');
  });

  it('accepts a direct manifest path', async () => {
    const dir = await makePlugin({
      name: 'direct-manifest',
      version: '1.0.0',
      description: 'Direct manifest target',
      commands: { hello: { content: 'Hello' } },
    });

    const report = await validatePlugin(
      join(dir, BRAND_PLUGIN_META_DIR, 'plugin.json'),
    );

    expect(report.valid).toBe(true);
    expect(report.plugin?.name).toBe('direct-manifest');
    expect(report.resources?.commands).toHaveLength(1);
  });

  it('reports path traversal in every manifest component family', async () => {
    const dir = await makePlugin({
      name: 'unsafe-plugin',
      version: '1.0.0',
      description: 'Unsafe plugin',
      mcpServers: './../outside.json',
    });

    const report = await validatePlugin(dir);

    expect(report.valid).toBe(false);
    expect(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === 'plugin.path.outside_root',
      ),
    ).toBe(true);
  });

  it('surfaces malformed conventional hooks as an error', async () => {
    const dir = await makePlugin({
      name: 'bad-hooks',
      version: '1.0.0',
      description: 'Bad hooks',
    });
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(join(dir, 'hooks', 'hooks.json'), '{not-json');

    const report = await validatePlugin(dir);

    expect(report.valid).toBe(false);
    expect(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === 'plugin.hooks.invalid',
      ),
    ).toBe(true);
  });

  it('uses the runtime agent parser to surface invalid agent definitions', async () => {
    const dir = await makePlugin({
      name: 'bad-agent',
      version: '1.0.0',
      description: 'Bad agent',
    });
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(
      join(dir, 'agents', 'broken.md'),
      '---\nname: broken\n---\nMissing description',
    );

    const report = await validatePlugin(dir);

    expect(report.valid).toBe(false);
    expect(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === 'plugin.agent.invalid',
      ),
    ).toBe(true);
  });

  it('includes a manifest-declared agent file in the resource inventory', async () => {
    const dir = await makePlugin({
      name: 'explicit-agent-plugin',
      version: '1.0.0',
      description: 'Plugin with an explicit agent file',
      agents: './agents/reviewer.md',
    });
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(
      join(dir, 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\n---\nReview carefully.',
    );

    const report = await validatePlugin(dir);

    expect(report.valid).toBe(true);
    expect(report.resources?.agents).toEqual([
      {
        name: 'explicit-agent-plugin:reviewer',
        description: 'Reviews code',
        color: undefined,
      },
    ]);
    expect(report.summary.componentCount).toBe(1);
  });

  it('does not scan a conventional component symlinked outside the plugin', async () => {
    const dir = await makePlugin({
      name: 'symlink-plugin',
      version: '1.0.0',
      description: 'Symlink escape',
    });
    const outside = await mkdtemp(join(tmpdir(), 'test-plugin-outside-'));
    tmpDirs.push(outside);
    await writeFile(join(outside, 'outside.md'), 'outside');
    await symlink(outside, join(dir, 'commands'), 'dir');

    const report = await validatePlugin(dir);

    expect(report.valid).toBe(false);
    expect(report.resources).toBeUndefined();
    expect(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === 'plugin.path.outside_root',
      ),
    ).toBe(true);
  });

  it('rejects a manifest command source symlinked outside the plugin', async () => {
    const dir = await makePlugin({
      name: 'command-source-symlink',
      version: '1.0.0',
      description: 'Command source escape',
      commands: { escaped: { source: './escaped.md' } },
    });
    const outside = await mkdtemp(join(tmpdir(), 'test-command-outside-'));
    tmpDirs.push(outside);
    const outsideCommand = join(outside, 'outside.md');
    await writeFile(outsideCommand, 'outside');
    await symlink(outsideCommand, join(dir, 'escaped.md'));

    const report = await validatePlugin(dir);

    expect(report.valid).toBe(false);
    expect(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === 'plugin.path.outside_root',
      ),
    ).toBe(true);
  });

  it('reports an empty plugin using the installation readiness policy', async () => {
    const dir = await makePlugin({
      name: 'empty-plugin',
      version: '1.0.0',
      description: 'No resources',
    });

    const report = await validatePlugin(dir);

    expect(report.valid).toBe(false);
    expect(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === 'plugin.installability.no_content',
      ),
    ).toBe(true);
  });
});
