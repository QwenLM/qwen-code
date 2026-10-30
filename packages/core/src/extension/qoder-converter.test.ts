/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertCompatibleExtension } from './extension-converter.js';
import {
  convertQoderPlugin,
  QODER_PLUGIN_MANIFEST,
} from './qoder-converter.js';

const NAME = 'sample-qoder-plugin';
const mcpJson = (mcpServers: unknown) => JSON.stringify({ mcpServers });
const SAMPLE_MCP_JSON = mcpJson({
  sample: { type: 'http', url: 'https://example.com/mcp' },
});

const readConfig = (dir: string) =>
  JSON.parse(
    fs.readFileSync(path.join(dir, 'qwen-extension.json'), 'utf-8'),
  ) as Record<string, unknown>;

describe('convertQoderPlugin', () => {
  let root: string;
  // Directories removed after each case: root, converted output, externals.
  let cleanup: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-plugin-'));
    fs.mkdirSync(path.join(root, '.qoder-plugin'), { recursive: true });
    cleanup = [root];
  });

  afterEach(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(config: Record<string, unknown>): void {
    write(QODER_PLUGIN_MANIFEST, JSON.stringify(config));
  }

  /** Writes `content` at `relPath` under the plugin root, creating parents. */
  function write(relPath: string, content: string): void {
    const file = path.join(root, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
  }

  function makeExternalDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-external-'));
    cleanup.push(dir);
    return dir;
  }

  async function convert() {
    const result = await convertQoderPlugin(root);
    cleanup.push(result.convertedDir);
    return result;
  }

  async function expectSanitizedError(pattern: RegExp): Promise<void> {
    const error = await convertQoderPlugin(root).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('\u001b');
    expect((error as Error).message).toMatch(pattern);
  }

  const exists = (dir: string, ...parts: string[]) =>
    fs.existsSync(path.join(dir, ...parts));

  it('converts metadata, resources, MCP, and root context files', async () => {
    writeManifest({
      name: NAME,
      version: '2.0.0',
      displayName: 'Sample plugin',
      description: 'A synthetic Qoder plugin',
    });
    write('QWEN.md', '# Qwen context');
    write('system-prompt.md', '# System context');
    write('.mcp.json', SAMPLE_MCP_JSON);
    write(
      'skills/sample-skill/SKILL.md',
      '---\nname: sample-skill\ndescription: Synthetic skill\n---\n',
    );
    write('commands/sample.md', '# Sample command');
    write(
      'agents/sample.md',
      '---\nname: sample\ndescription: Synthetic agent\n---\nPrompt',
    );
    write('NOTICE.txt', 'Synthetic resource');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });

    const result = await convert();
    const out = result.convertedDir;

    expect(result.config).toMatchObject({
      name: NAME,
      version: '2.0.0',
      displayName: 'Sample plugin',
      description: 'A synthetic Qoder plugin',
      contextFileName: ['QWEN.md', 'system-prompt.md'],
    });
    expect(result.config.mcpServers?.['sample']).toMatchObject({
      httpUrl: 'https://example.com/mcp',
    });
    expect(exists(out, 'skills', 'sample-skill', 'SKILL.md')).toBe(true);
    expect(exists(out, 'commands', 'sample.md')).toBe(true);
    expect(exists(out, 'agents', 'sample.md')).toBe(true);
    expect(exists(out, 'NOTICE.txt')).toBe(true);
    expect(exists(out, '.git')).toBe(false);
  });

  it('defaults the version and reports Qoder as the origin', async () => {
    writeManifest({ name: NAME });
    write('system-prompt.md', '# System context');

    const result = await convertCompatibleExtension(root);
    cleanup.push(result.extensionDir);

    expect(result.originSource).toBe('Qoder');
    const converted = readConfig(result.extensionDir);
    expect(converted['version']).toBe('1.0.0');
    expect(converted['contextFileName']).toEqual(['system-prompt.md']);
  });

  it('honors an explicit marketplace selection over a root Qoder manifest', async () => {
    writeManifest({ name: NAME, version: '9.9.9' });
    write(
      '.claude-plugin/marketplace.json',
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
    write(
      'plugin-src/.claude-plugin/plugin.json',
      JSON.stringify({ name: 'requested-plugin', version: '2.0.0' }),
    );

    const selected = await convertCompatibleExtension(root, 'requested-plugin');
    expect(selected.originSource).toBe('Claude');
    const selectedConfig = readConfig(selected.extensionDir);
    expect(selectedConfig['name']).toBe('requested-plugin');
    expect(selectedConfig['version']).toBe('2.0.0');
    fs.rmSync(selected.extensionDir, { recursive: true, force: true });

    const unselected = await convertCompatibleExtension(root);
    cleanup.push(unselected.extensionDir);
    expect(unselected.originSource).toBe('Qoder');
    const unselectedConfig = readConfig(unselected.extensionDir);
    expect(unselectedConfig['name']).toBe(NAME);
    expect(unselectedConfig['version']).toBe('9.9.9');
  });

  it('omits null optional metadata from the generated config', async () => {
    writeManifest({ name: NAME, displayName: null, description: null });

    const result = await convert();
    const generated = readConfig(result.convertedDir);

    expect(result.config.displayName).toBeUndefined();
    expect(result.config.description).toBeUndefined();
    expect(generated).not.toHaveProperty('displayName');
    expect(generated).not.toHaveProperty('description');
  });

  it('merges explicit context with system-prompt.md without duplicates', async () => {
    writeManifest({
      name: NAME,
      contextFileName: ['custom.md', 42, 'custom.md', './system-prompt.md'],
    });
    write('QWEN.md', '# Qwen context');
    write('custom.md', '# Custom');
    write('system-prompt.md', '# System context');

    const result = await convert();

    expect(result.config.contextFileName).toEqual([
      'QWEN.md',
      'custom.md',
      'system-prompt.md',
    ]);
  });

  it('loads path-valued MCP config from the standard wrapper', async () => {
    writeManifest({ name: NAME, mcpServers: '.mcp.json' });
    write('.mcp.json', SAMPLE_MCP_JSON);

    const result = await convert();

    expect(Object.keys(result.config.mcpServers ?? {})).toEqual(['sample']);
    expect(result.config.mcpServers?.['sample']).toMatchObject({
      httpUrl: 'https://example.com/mcp',
    });
  });

  it('prefers inline MCP config over the root MCP file', async () => {
    writeManifest({
      name: NAME,
      mcpServers: {
        inline: { type: 'http', url: 'https://example.com/inline' },
      },
    });
    write(
      '.mcp.json',
      mcpJson({ root: { type: 'http', url: 'https://example.com/root' } }),
    );

    const result = await convert();

    expect(Object.keys(result.config.mcpServers ?? {})).toEqual(['inline']);
  });

  it('treats null mcpServers as absent and falls back to the root MCP file', async () => {
    writeManifest({ name: NAME, mcpServers: null });
    write('.mcp.json', SAMPLE_MCP_JSON);

    const result = await convert();

    expect(Object.keys(result.config.mcpServers ?? {})).toEqual(['sample']);
  });

  it('treats null mcpServers without a root MCP file as absent', async () => {
    writeManifest({ name: NAME, mcpServers: null });

    const result = await convert();

    expect(result.config.mcpServers).toBeUndefined();
  });

  it('rejects malformed root MCP config', async () => {
    writeManifest({ name: NAME });
    write('.mcp.json', '\u001b[31m{');

    await expectSanitizedError(/Invalid Qoder MCP configuration/);
  });

  it.skipIf(process.platform === 'win32').each([
    ['JSON value', 'null', /expected a JSON object/],
    ['wrapper', mcpJson(null), /expected an "mcpServers" object/],
    [
      'server entry',
      mcpJson({ invalid: null }),
      /server entries must be JSON objects/,
    ],
  ])(
    'sanitizes control sequences in MCP %s errors',
    async (_case, body, errorPattern) => {
      const mcpFile = 'mcp\u001b[31m.json';
      writeManifest({ name: NAME, mcpServers: mcpFile });
      write(mcpFile, body);

      await expectSanitizedError(errorPattern);
    },
  );

  it('rejects an invalid MCP wrapper from a configured path', async () => {
    writeManifest({ name: NAME, mcpServers: '.mcp.json' });
    write('.mcp.json', mcpJson(null));

    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /expected an "mcpServers" object/,
    );
  });

  it.each(['inline', 'root'] as const)(
    'rejects non-object MCP server entries from %s config',
    async (source) => {
      writeManifest({
        name: NAME,
        ...(source === 'inline'
          ? { mcpServers: { invalid: null } }
          : undefined),
      });
      if (source === 'root') write('.mcp.json', mcpJson({ invalid: null }));

      await expect(convertQoderPlugin(root)).rejects.toThrow(
        /server entries must be JSON objects/,
      );
    },
  );

  it('does not load an escaping root MCP symlink', async () => {
    const externalMcp = path.join(makeExternalDir(), '.mcp.json');
    fs.writeFileSync(externalMcp, SAMPLE_MCP_JSON, 'utf-8');
    writeManifest({ name: NAME });
    fs.symlinkSync(externalMcp, path.join(root, '.mcp.json'));

    const result = await convert();

    expect(result.config.mcpServers).toBeUndefined();
    expect(exists(result.convertedDir, '.mcp.json')).toBe(false);
  });

  it('loads QWEN.md with system-prompt.md when context is not configured', async () => {
    writeManifest({ name: NAME, contextFileName: [] });
    write('QWEN.md', '# Qwen context');
    write('system-prompt.md', '# System context');

    const result = await convert();

    expect(result.config.contextFileName).toEqual([
      'QWEN.md',
      'system-prompt.md',
    ]);
  });

  it('rejects invalid manifests and escaping manifest symlinks', async () => {
    write(QODER_PLUGIN_MANIFEST, 'null');
    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /expected a JSON object/,
    );

    writeManifest({});
    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /must have name field/,
    );

    writeManifest({ name: 123 });
    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /must have name field/,
    );

    const externalManifest = path.join(makeExternalDir(), 'plugin.json');
    fs.writeFileSync(
      externalManifest,
      JSON.stringify({ name: 'external-plugin' }),
      'utf-8',
    );
    fs.rmSync(path.join(root, QODER_PLUGIN_MANIFEST));
    fs.symlinkSync(externalManifest, path.join(root, QODER_PLUGIN_MANIFEST));

    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /resolves through a symlink outside/,
    );
  });

  it('sanitizes control sequences from manifest parse errors', async () => {
    write(QODER_PLUGIN_MANIFEST, '\u001b[31minvalid');

    await expectSanitizedError(/Invalid Qoder plugin configuration/);
  });

  it('does not copy escaping symlinks or load unsafe context paths', async () => {
    const externalFile = path.join(makeExternalDir(), 'private.txt');
    fs.writeFileSync(externalFile, 'private', 'utf-8');
    writeManifest({ name: NAME, contextFileName: 'leak.md' });
    fs.symlinkSync(externalFile, path.join(root, 'leak.md'));
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.symlinkSync(externalFile, path.join(root, 'skills', 'leak.txt'));

    const result = await convert();

    expect(result.config.contextFileName).toBeUndefined();
    expect(exists(result.convertedDir, 'skills', 'leak.txt')).toBe(false);
  });

  it.each(['QWEN.md', 'system-prompt.md'])(
    'does not load an escaping default %s symlink',
    async (contextFile) => {
      const externalFile = path.join(makeExternalDir(), contextFile);
      fs.writeFileSync(externalFile, 'External context', 'utf-8');
      writeManifest({ name: NAME });
      fs.symlinkSync(externalFile, path.join(root, contextFile));

      const result = await convert();

      expect(result.config.contextFileName).toBeUndefined();
      expect(exists(result.convertedDir, contextFile)).toBe(false);
    },
  );

  it('drops context files removed during selective resource collection', async () => {
    writeManifest({
      name: NAME,
      commands: 'commands/kept.md',
      contextFileName: 'commands/removed.md',
    });
    write('commands/kept.md', '# Kept');
    write('commands/removed.md', '# Removed');

    const result = await convert();

    expect(result.config.contextFileName).toBeUndefined();
    expect(exists(result.convertedDir, 'commands', 'kept.md')).toBe(true);
    expect(exists(result.convertedDir, 'commands', 'removed.md')).toBe(false);
  });

  it('ignores context paths that resolve to directories', async () => {
    writeManifest({ name: NAME, contextFileName: 'docs' });
    fs.mkdirSync(path.join(root, 'docs'));

    const result = await convert();

    expect(result.config.contextFileName).toBeUndefined();
  });
});
