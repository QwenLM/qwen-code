/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  convertCompatibleExtension,
  detectManifest,
} from './extension-converter.js';
import {
  AGENT_PLUGIN_SCHEMA,
  AGENT_PLUGIN_SCHEMA_PREFIX,
} from './agent-plugins-v1/index.js';
import { QODER_PLUGIN_MANIFEST } from './qoder-converter.js';
import { AGENT_PLUGIN_MANIFEST } from './agent-plugins-v1/manifest.js';
import { convertGeminiExtensionPackage } from './gemini-converter.js';
import * as claudeConverter from './claude-converter.js';

describe('Agent Plugins extension conversion', () => {
  let pluginRoot: string;

  beforeEach(() => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-'));
  });

  afterEach(() => {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  });

  it('selects a supported Agent Plugin without converting it', async () => {
    const manifest = JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: 'portable-plugin',
    });
    fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), manifest);

    await expect(convertCompatibleExtension(pluginRoot)).resolves.toEqual({
      extensionDir: pluginRoot,
      originSource: 'AgentPlugins',
      externalContent: false,
    });
    expect(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')).toBe(
      manifest,
    );
    expect(fs.existsSync(path.join(pluginRoot, 'qwen-extension.json'))).toBe(
      false,
    );
  });

  it('gives an unsupported Agent Plugins schema priority over Qwen format', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: `${AGENT_PLUGIN_SCHEMA_PREFIX}2.0.0/plugin.schema.json`,
        name: 'future-plugin',
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'qwen-extension.json'),
      JSON.stringify({ name: 'qwen-fallback', version: '1.0.0' }),
    );

    await expect(convertCompatibleExtension(pluginRoot)).rejects.toThrow(
      'Unsupported Agent Plugins schema',
    );
  });

  it('leaves an unrelated plugin.json out of format detection', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({ $schema: 'https://example.com/plugin.schema.json' }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'qwen-extension.json'),
      JSON.stringify({ name: 'qwen-extension', version: '1.0.0' }),
    );

    await expect(convertCompatibleExtension(pluginRoot)).resolves.toEqual({
      extensionDir: pluginRoot,
      originSource: 'QwenCode',
      externalContent: false,
    });
  });

  it('honors an explicit marketplace selection over a root Agent Plugin manifest', async () => {
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'root-agent-plugin',
      }),
    );
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'sample-marketplace',
        owner: { name: 'Test Owner', email: 'owner@example.com' },
        plugins: [
          {
            name: 'requested-plugin',
            version: '2.0.0',
            source: './plugin-src',
          },
        ],
      }),
    );
    const selectedRoot = path.join(pluginRoot, 'plugin-src');
    fs.mkdirSync(path.join(selectedRoot, '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(selectedRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'requested-plugin', version: '2.0.0' }),
    );
    fs.writeFileSync(
      path.join(selectedRoot, 'plugin.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'carried-agent-plugin',
      }),
    );

    const selected = await convertCompatibleExtension(
      pluginRoot,
      'requested-plugin',
    );
    expect(selected.originSource).toBe('Claude');
    const selectedConfig = JSON.parse(
      fs.readFileSync(
        path.join(selected.extensionDir, 'qwen-extension.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(selectedConfig['name']).toBe('requested-plugin');
    expect(fs.existsSync(path.join(selected.extensionDir, 'plugin.json'))).toBe(
      false,
    );
    fs.rmSync(selected.extensionDir, { recursive: true, force: true });

    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: `${AGENT_PLUGIN_SCHEMA_PREFIX}2.0.0/plugin.schema.json`,
        name: 'future-root-agent-plugin',
      }),
    );
    fs.writeFileSync(
      path.join(selectedRoot, 'plugin.json'),
      JSON.stringify({
        $schema: `${AGENT_PLUGIN_SCHEMA_PREFIX}2.0.0/plugin.schema.json`,
        name: 'future-carried-agent-plugin',
      }),
    );
    const selectedWithFutureRoot = await convertCompatibleExtension(
      pluginRoot,
      'requested-plugin',
    );
    expect(selectedWithFutureRoot.originSource).toBe('Claude');
    expect(
      fs.existsSync(
        path.join(selectedWithFutureRoot.extensionDir, 'plugin.json'),
      ),
    ).toBe(false);
    fs.rmSync(selectedWithFutureRoot.extensionDir, {
      recursive: true,
      force: true,
    });
  });
});

describe('detectManifest', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-manifest-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeClaude = (subpath: string, content: unknown, base = root) => {
    fs.mkdirSync(path.join(base, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(base, '.claude-plugin', subpath),
      JSON.stringify(content),
      'utf-8',
    );
  };

  it('detects a Claude marketplace when pluginName is listed', () => {
    writeClaude('marketplace.json', {
      plugins: [{ name: 'selected', source: './' }],
    });
    writeClaude('plugin.json', { name: 'standalone', version: '1.0.0' });
    expect(detectManifest(root, 'selected')).toEqual({
      source: 'Claude',
      kind: 'marketplace',
    });
  });

  it('detects a Claude standalone plugin without pluginName', () => {
    writeClaude('plugin.json', { name: 'standalone', version: '1.0.0' });
    expect(detectManifest(root)).toEqual({
      source: 'Claude',
      kind: 'standalone',
    });
  });

  it('detects a Gemini extension', () => {
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini', version: '1.0.0' }),
      'utf-8',
    );
    expect(detectManifest(root)).toEqual({ source: 'Gemini' });
  });

  it('detects a Qoder plugin', () => {
    fs.mkdirSync(path.join(root, '.qoder-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, QODER_PLUGIN_MANIFEST),
      JSON.stringify({ name: 'qoder', version: '1.0.0' }),
      'utf-8',
    );
    expect(detectManifest(root)).toEqual({ source: 'Qoder' });
  });

  it('prefers Claude over Gemini and Qoder', () => {
    writeClaude('plugin.json', { name: 'standalone', version: '1.0.0' });
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini', version: '1.0.0' }),
      'utf-8',
    );
    fs.mkdirSync(path.join(root, '.qoder-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, QODER_PLUGIN_MANIFEST),
      JSON.stringify({ name: 'qoder', version: '1.0.0' }),
      'utf-8',
    );
    expect(detectManifest(root)).toEqual({
      source: 'Claude',
      kind: 'standalone',
    });
  });

  it('prefers Gemini over Qoder', () => {
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini', version: '1.0.0' }),
      'utf-8',
    );
    fs.mkdirSync(path.join(root, '.qoder-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, QODER_PLUGIN_MANIFEST),
      JSON.stringify({ name: 'qoder', version: '1.0.0' }),
      'utf-8',
    );
    expect(detectManifest(root)).toEqual({ source: 'Gemini' });
  });

  it('returns null when no manifest applies', () => {
    expect(detectManifest(root)).toBeNull();
  });

  it('ignores an unrelated root plugin.json', () => {
    fs.writeFileSync(
      path.join(root, 'plugin.json'),
      JSON.stringify({ $schema: 'https://example.com/plugin.schema.json' }),
      'utf-8',
    );
    expect(detectManifest(root)).toBeNull();
  });

  it('propagates a detection error when pluginName is specified', () => {
    // A specified pluginName is a hard contract: a defective Claude manifest
    // must surface its own error rather than silently installing a different
    // format the user never asked for.
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      '{',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini', version: '1.0.0' }),
      'utf-8',
    );
    expect(() => detectManifest(root, 'my-plugin')).toThrow(/Invalid/);
  });

  it('falls through to Gemini when Claude detection fails without pluginName', () => {
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      '{',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini', version: '1.0.0' }),
      'utf-8',
    );
    expect(detectManifest(root)).toEqual({ source: 'Gemini' });
  });

  it('falls through to Qoder when both Claude and Gemini detection fail', () => {
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      '{',
      'utf-8',
    );
    fs.writeFileSync(path.join(root, 'gemini-extension.json'), '{', 'utf-8');
    fs.mkdirSync(path.join(root, '.qoder-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, QODER_PLUGIN_MANIFEST),
      JSON.stringify({ name: 'qoder', version: '1.0.0' }),
      'utf-8',
    );
    expect(detectManifest(root)).toEqual({ source: 'Qoder' });
  });

  it('throws the recorded Claude error when nothing matches', () => {
    // Defective Claude + Gemini manifests, no Qoder → the Claude probe error
    // surfaces (??= keeps it first) instead of a generic "not found".
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      '{',
      'utf-8',
    );
    fs.writeFileSync(path.join(root, 'gemini-extension.json'), '{', 'utf-8');
    // Pin the file identity — the Claude error ("Invalid .claude-plugin/…")
    // must surface (??= keeps it first), not the Gemini one; /Invalid/ alone
    // would match both and never notice a precedence flip.
    expect(() => detectManifest(root)).toThrow(
      /\.claude-plugin[\\/]plugin\.json/,
    );
  });

  it('throws the Gemini detection error when Claude returns null', () => {
    // Claude probes clean (no manifest), Gemini is defective, no Qoder —
    // the Gemini-side error recording (converterError ??= error) surfaces.
    fs.writeFileSync(path.join(root, 'gemini-extension.json'), '{', 'utf-8');
    expect(() => detectManifest(root)).toThrow(/Invalid/);
  });
});

describe('convertCompatibleExtension', () => {
  let root: string;

  // Real converters write a fresh mkdtemp directory per call; track them so
  // afterEach can clean up instead of leaking one temp dir per test run.
  const convertedDirs = new Set<string>();
  const trackConvertedDir = (result: { extensionDir: string }): void => {
    if (result.extensionDir !== root) {
      convertedDirs.add(result.extensionDir);
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-extension-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const dir of convertedDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    convertedDirs.clear();
  });

  it('returns a native extension without conversion', async () => {
    fs.writeFileSync(
      path.join(root, 'qwen-extension.json'),
      JSON.stringify({ name: 'native', version: '1.0.0' }),
      'utf-8',
    );
    await expect(convertCompatibleExtension(root)).resolves.toEqual({
      extensionDir: root,
      originSource: 'QwenCode',
      externalContent: false,
    });
  });

  // Pin the documented "Native Qwen extension wins" contract. A
  // directory that ships both `qwen-extension.json` and a Claude/Gemini
  // manifest must load natively, not be converted. Without this, a
  // regression that runs `detectManifest` before the native `existsSync`
  // check would install different config than the author shipped.
  it('native qwen-extension.json wins over a co-shipped Claude manifest', async () => {
    fs.writeFileSync(
      path.join(root, 'qwen-extension.json'),
      JSON.stringify({ name: 'native', version: '1.0.0' }),
      'utf-8',
    );
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'should-not-be-used', version: '1.0.0' }),
      'utf-8',
    );
    await expect(convertCompatibleExtension(root)).resolves.toEqual({
      extensionDir: root,
      originSource: 'QwenCode',
      externalContent: false,
    });
  });

  it('native qwen-extension.json wins over a co-shipped Gemini manifest', async () => {
    fs.writeFileSync(
      path.join(root, 'qwen-extension.json'),
      JSON.stringify({ name: 'native', version: '1.0.0' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini-shadow', version: '1.0.0' }),
      'utf-8',
    );
    await expect(convertCompatibleExtension(root)).resolves.toEqual({
      extensionDir: root,
      originSource: 'QwenCode',
      externalContent: false,
    });
  });

  // pluginName is a hard contract at the ROUTING layer too: a defective
  // Claude manifest propagates here, never falling through to a co-shipped
  // Gemini manifest the user didn't ask for.
  it('propagates an explicit pluginName detection error through convertCompatibleExtension', async () => {
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      '{',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini', version: '1.0.0' }),
      'utf-8',
    );
    await expect(convertCompatibleExtension(root, 'my-plugin')).rejects.toThrow(
      /Invalid/,
    );
  });

  it('returns the directory unchanged when no manifest matches', async () => {
    await expect(convertCompatibleExtension(root)).resolves.toEqual({
      extensionDir: root,
      originSource: 'QwenCode',
      externalContent: false,
    });
  });

  it('keeps hooks from the Claude manifest when both Claude and Gemini declare one', async () => {
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'claude-hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'claude-hooks', 'hooks.json'),
      '{}',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'dual',
        version: '1.0.0',
        hooks: './claude-hooks/hooks.json',
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini', version: '1.0.0' }),
      'utf-8',
    );
    const result = await convertCompatibleExtension(root);
    expect(result.originSource).toBe('Claude');
    const converted = JSON.parse(
      fs.readFileSync(
        path.join(result.extensionDir, 'qwen-extension.json'),
        'utf-8',
      ),
    );
    expect(converted.hooks).toBe('./claude-hooks/hooks.json');
    trackConvertedDir(result);
  });

  it('converts a Claude standalone plugin', async () => {
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'standalone', version: '1.0.0' }),
      'utf-8',
    );
    const result = await convertCompatibleExtension(root);
    expect(result.originSource).toBe('Claude');
    expect(result.externalContent).toBe(false);
    expect(
      fs.existsSync(path.join(result.extensionDir, 'qwen-extension.json')),
    ).toBe(true);
    trackConvertedDir(result);
  });

  it('converts a detected Gemini extension', async () => {
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini', version: '1.0.0' }),
      'utf-8',
    );
    const result = await convertCompatibleExtension(root);
    expect(result.originSource).toBe('Gemini');
    expect(
      fs.existsSync(path.join(result.extensionDir, 'qwen-extension.json')),
    ).toBe(true);
    trackConvertedDir(result);
  });

  it('drops a root agent-plugins plugin.json from a converted Gemini package', async () => {
    fs.writeFileSync(
      path.join(root, 'gemini-extension.json'),
      JSON.stringify({ name: 'gemini', version: '1.0.0' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, AGENT_PLUGIN_MANIFEST),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: 'carried-agent-plugin',
      }),
      'utf-8',
    );

    const result = await convertGeminiExtensionPackage(root);

    expect(
      fs.existsSync(path.join(result.convertedDir, AGENT_PLUGIN_MANIFEST)),
    ).toBe(false);
    trackConvertedDir({ extensionDir: result.convertedDir });
  });

  it('converts a detected Qoder plugin', async () => {
    fs.mkdirSync(path.join(root, '.qoder-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, QODER_PLUGIN_MANIFEST),
      JSON.stringify({ name: 'qoder', version: '1.0.0' }),
      'utf-8',
    );
    const result = await convertCompatibleExtension(root);
    expect(result.originSource).toBe('Qoder');
    expect(
      fs.existsSync(path.join(result.extensionDir, 'qwen-extension.json')),
    ).toBe(true);
    trackConvertedDir(result);
  });

  it('forwards networkPolicy and AbortSignal to the marketplace converter', async () => {
    // Pins the argument order: a swap would put an AbortSignal in the
    // network-policy slot, and both are optional so the mistake would go
    // unnoticed.
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        plugins: [{ name: 'selected', source: './plugin-src' }],
      }),
      'utf-8',
    );
    const pluginSrc = path.join(root, 'plugin-src');
    fs.mkdirSync(path.join(pluginSrc, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginSrc, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'selected', version: '1.0.0' }),
      'utf-8',
    );
    const spy = vi.spyOn(claudeConverter, 'convertClaudePluginPackage');
    const policy = 'public' as const;
    const signal = new AbortController().signal;

    const result = await convertCompatibleExtension(
      root,
      'selected',
      policy,
      signal,
    );

    expect(spy).toHaveBeenCalledWith(root, 'selected', policy, signal);
    spy.mockRestore();
    // The spy wraps without replacing the implementation, so the real
    // conversion ran and wrote a temp dir — clean it up too. capture the
    // awaited result (with the actual `extensionDir` field from
    // convertCompatibleExtension) rather than reading from the spy:
    // spy.mockRestore() clears mock.results, and the spy wraps an async
    // function so results[0].value is a Promise that resolves to
    // { extensionDir, originSource, externalContent }.
    trackConvertedDir(result);
  });
});
