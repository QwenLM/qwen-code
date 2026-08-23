/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertCompatibleExtension } from './extension-converter.js';
import {
  convertQoderPlugin,
  QODER_PLUGIN_MANIFEST,
} from './qoder-converter.js';

// Hoist a shared mock for QODER_CONVERTER so tests can spy without
// exporting the private logger from qoder-converter.ts. CLAUDE_CONVERTER is
// mocked to the same spy because convertQoderPlugin runs shared conversion
// in buildQwenExtensionFromPlugin (claude-converter.ts), whose warnings
// surface under that namespace and must be observable here.
const { mockQoderDebugLogger } = vi.hoisted(() => ({
  mockQoderDebugLogger: {
    isEnabled: vi.fn().mockReturnValue(false),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: (namespace: string) =>
      namespace === 'QODER_CONVERTER' ||
      namespace === 'CLAUDE_CONVERTER' ||
      namespace === 'Extension:path-confinement'
        ? mockQoderDebugLogger
        : actual.createDebugLogger(namespace),
  };
});

describe('convertQoderPlugin', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-plugin-'));
    fs.mkdirSync(path.join(root, '.qoder-plugin'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(config: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(root, QODER_PLUGIN_MANIFEST),
      JSON.stringify(config),
      'utf-8',
    );
  }

  it('converts metadata, resources, MCP, and root context files', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      version: '2.0.0',
      displayName: 'Sample plugin',
      description: 'A synthetic Qoder plugin',
    });
    fs.writeFileSync(path.join(root, 'QWEN.md'), '# Qwen context', 'utf-8');
    fs.writeFileSync(
      path.join(root, 'system-prompt.md'),
      '# System context',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sample: { type: 'http', url: 'https://example.com/mcp' },
        },
      }),
      'utf-8',
    );
    const skillDir = path.join(root, 'skills', 'sample-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: sample-skill\ndescription: Synthetic skill\n---\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'commands', 'sample.md'),
      '# Sample command',
      'utf-8',
    );
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'agents', 'sample.md'),
      '---\nname: sample\ndescription: Synthetic agent\n---\nPrompt',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'NOTICE.txt'),
      'Synthetic resource',
      'utf-8',
    );
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });

    const result = await convertQoderPlugin(root);

    expect(result.config).toMatchObject({
      name: 'sample-qoder-plugin',
      version: '2.0.0',
      displayName: 'Sample plugin',
      description: 'A synthetic Qoder plugin',
      contextFileName: ['QWEN.md', 'system-prompt.md'],
    });
    expect(result.config.mcpServers?.['sample']).toMatchObject({
      httpUrl: 'https://example.com/mcp',
    });
    expect(
      fs.existsSync(
        path.join(result.convertedDir, 'skills', 'sample-skill', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(result.convertedDir, 'commands', 'sample.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(result.convertedDir, 'agents', 'sample.md')),
    ).toBe(true);
    expect(fs.existsSync(path.join(result.convertedDir, 'NOTICE.txt'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(result.convertedDir, '.git'))).toBe(false);

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('defaults the version and reports Qoder as the origin', async () => {
    writeManifest({ name: 'sample-qoder-plugin' });
    fs.writeFileSync(
      path.join(root, 'system-prompt.md'),
      '# System context',
      'utf-8',
    );

    const result = await convertCompatibleExtension(root);

    expect(result.originSource).toBe('Qoder');
    const converted = JSON.parse(
      fs.readFileSync(
        path.join(result.extensionDir, 'qwen-extension.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    expect(converted['version']).toBe('1.0.0');
    expect(converted['contextFileName']).toEqual(['system-prompt.md']);

    fs.rmSync(result.extensionDir, { recursive: true, force: true });
  });

  it('honors an explicit marketplace selection over a root Qoder manifest', async () => {
    writeManifest({ name: 'sample-qoder-plugin', version: '9.9.9' });
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'marketplace.json'),
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
      'utf-8',
    );
    const pluginSourceDir = path.join(root, 'plugin-src');
    fs.mkdirSync(path.join(pluginSourceDir, '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(pluginSourceDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'requested-plugin', version: '2.0.0' }),
      'utf-8',
    );

    const selected = await convertCompatibleExtension(root, 'requested-plugin');
    expect(selected.originSource).toBe('Claude');
    const selectedConfig = JSON.parse(
      fs.readFileSync(
        path.join(selected.extensionDir, 'qwen-extension.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    expect(selectedConfig['name']).toBe('requested-plugin');
    expect(selectedConfig['version']).toBe('2.0.0');
    fs.rmSync(selected.extensionDir, { recursive: true, force: true });

    const unselected = await convertCompatibleExtension(root);
    expect(unselected.originSource).toBe('Qoder');
    const unselectedConfig = JSON.parse(
      fs.readFileSync(
        path.join(unselected.extensionDir, 'qwen-extension.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    expect(unselectedConfig['name']).toBe('sample-qoder-plugin');
    expect(unselectedConfig['version']).toBe('9.9.9');
    fs.rmSync(unselected.extensionDir, { recursive: true, force: true });
  });

  it('omits null optional metadata from the generated config', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      displayName: null,
      description: null,
    });

    const result = await convertQoderPlugin(root);
    const generated = JSON.parse(
      fs.readFileSync(
        path.join(result.convertedDir, 'qwen-extension.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;

    expect(result.config.displayName).toBeUndefined();
    expect(result.config.description).toBeUndefined();
    expect(generated).not.toHaveProperty('displayName');
    expect(generated).not.toHaveProperty('description');
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('merges explicit context with system-prompt.md without duplicates', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      contextFileName: ['custom.md', 42, 'custom.md', './system-prompt.md'],
    });
    fs.writeFileSync(path.join(root, 'QWEN.md'), '# Qwen context', 'utf-8');
    fs.writeFileSync(path.join(root, 'custom.md'), '# Custom', 'utf-8');
    fs.writeFileSync(
      path.join(root, 'system-prompt.md'),
      '# System context',
      'utf-8',
    );

    const result = await convertQoderPlugin(root);

    expect(result.config.contextFileName).toEqual([
      'QWEN.md',
      'custom.md',
      'system-prompt.md',
    ]);
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('loads path-valued MCP config from the standard wrapper', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      mcpServers: '.mcp.json',
    });
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sample: { type: 'http', url: 'https://example.com/mcp' },
        },
      }),
      'utf-8',
    );

    const result = await convertQoderPlugin(root);

    expect(Object.keys(result.config.mcpServers ?? {})).toEqual(['sample']);
    expect(result.config.mcpServers?.['sample']).toMatchObject({
      httpUrl: 'https://example.com/mcp',
    });
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('prefers inline MCP config over the root MCP file', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      mcpServers: {
        inline: { type: 'http', url: 'https://example.com/inline' },
      },
    });
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          root: { type: 'http', url: 'https://example.com/root' },
        },
      }),
      'utf-8',
    );

    const result = await convertQoderPlugin(root);

    expect(Object.keys(result.config.mcpServers ?? {})).toEqual(['inline']);
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('treats null mcpServers as absent and falls back to the root MCP file', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      mcpServers: null,
    });
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sample: { type: 'http', url: 'https://example.com/mcp' },
        },
      }),
      'utf-8',
    );

    const result = await convertQoderPlugin(root);

    expect(Object.keys(result.config.mcpServers ?? {})).toEqual(['sample']);
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('treats null mcpServers without a root MCP file as absent', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      mcpServers: null,
    });

    const result = await convertQoderPlugin(root);

    expect(result.config.mcpServers).toBeUndefined();
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('skips a malformed root MCP config instead of failing', async () => {
    writeManifest({ name: 'sample-qoder-plugin' });
    fs.writeFileSync(path.join(root, '.mcp.json'), '\u001b[31m{', 'utf-8');

    const result = await convertQoderPlugin(root);

    // A malformed subsidiary .mcp.json is tolerated (warned, not thrown).
    expect(result.config.mcpServers).toBeUndefined();
    // The warn surfaces from readExtraJsonFile's parse-error branch
    // (Extension:path-confinement namespace, mocked to the same spy).
    expect(mockQoderDebugLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse .mcp.json'),
    );
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'sanitizes control sequences in MCP server-entry errors',
    async () => {
      const mcpFile = 'mcp\u001b[31m.json';
      writeManifest({ name: 'sample-qoder-plugin', mcpServers: mcpFile });
      fs.writeFileSync(
        path.join(root, mcpFile),
        JSON.stringify({ mcpServers: { invalid: null } }),
        'utf-8',
      );

      // A non-object server entry still fails (normalizeMcpServers), but the
      // control-byte filename must be sanitized out of the error message.
      let rejected: unknown;
      try {
        await convertQoderPlugin(root);
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).message).toMatch(
        /server entries must be JSON objects/,
      );
      expect((rejected as Error).message).not.toContain('\u001b');
    },
  );

  // Pin control-byte sanitization on the throw path. A raw fileRef
  // in the message would re-open the diagnostic-injection class.
  it.skipIf(process.platform === 'win32')(
    'sanitizes control sequences in the qoder mcpServers-object throw',
    async () => {
      const mcpFile = 'no-object\u001b[2J.json';
      writeManifest({ name: 'sample-qoder-plugin', mcpServers: mcpFile });
      // Valid object without mcpServers wrapper → normalizeMcpServers throws.
      fs.writeFileSync(
        path.join(root, mcpFile),
        JSON.stringify({ notServers: 'x' }),
        'utf-8',
      );
      const rejected = await convertQoderPlugin(root).catch((error) => error);
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).message).toMatch(
        /server entries must be JSON objects/,
      );
      expect((rejected as Error).message).not.toContain('\u001b');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'sanitizes control sequences in the readExtraJsonFile non-object throw',
    async () => {
      const mcpFile = 'array\u001b[31m.json';
      writeManifest({ name: 'sample-qoder-plugin', mcpServers: mcpFile });
      // Array body → non-object-body rejection.
      fs.writeFileSync(path.join(root, mcpFile), '[1, 2, 3]', 'utf-8');
      const rejected = await convertQoderPlugin(root).catch((error) => error);
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).message).toMatch(
        /top-level body is not a JSON object/,
      );
      expect((rejected as Error).message).not.toContain('\u001b');
    },
  );

  it.runIf(process.platform !== 'win32')('rejects a manifest symlinked outside the package', async () => {
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-outside.json`,
    );
    fs.writeFileSync(
      outside,
      JSON.stringify({ name: 'evil', version: '1.0.0' }),
      'utf-8',
    );
    fs.symlinkSync(outside, path.join(root, QODER_PLUGIN_MANIFEST));

    // Converter-level guard: the escape must fail the install (not fall back
    // to a misleading "not found" or install past the escape).
    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /resolves through a symlink outside/,
    );
    fs.rmSync(outside, { force: true });
  });

  it('skips an invalid MCP wrapper from a configured path', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      mcpServers: '.mcp.json',
    });
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: null }),
      'utf-8',
    );

    const result = await convertQoderPlugin(root);

    expect(result.config.mcpServers).toBeUndefined();
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it.each(['inline', 'root'] as const)(
    'rejects non-object MCP server entries from %s config',
    async (source) => {
      writeManifest({
        name: 'sample-qoder-plugin',
        ...(source === 'inline'
          ? { mcpServers: { invalid: null } }
          : undefined),
      });
      if (source === 'root') {
        fs.writeFileSync(
          path.join(root, '.mcp.json'),
          JSON.stringify({ mcpServers: { invalid: null } }),
          'utf-8',
        );
      }

      await expect(convertQoderPlugin(root)).rejects.toThrow(
        /server entries must be JSON objects/,
      );
    },
  );

  it.runIf(process.platform !== 'win32')('does not load an escaping root MCP symlink', async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-external-'));
    const externalMcp = path.join(external, '.mcp.json');
    fs.writeFileSync(
      externalMcp,
      JSON.stringify({
        mcpServers: {
          sample: { type: 'http', url: 'https://example.com/mcp' },
        },
      }),
      'utf-8',
    );
    writeManifest({ name: 'sample-qoder-plugin' });
    fs.symlinkSync(externalMcp, path.join(root, '.mcp.json'));

    const result = await convertQoderPlugin(root);

    expect(result.config.mcpServers).toBeUndefined();
    expect(fs.existsSync(path.join(result.convertedDir, '.mcp.json'))).toBe(
      false,
    );
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });

  it('loads QWEN.md with system-prompt.md when context is not configured', async () => {
    writeManifest({ name: 'sample-qoder-plugin', contextFileName: [] });
    fs.writeFileSync(path.join(root, 'QWEN.md'), '# Qwen context', 'utf-8');
    fs.writeFileSync(
      path.join(root, 'system-prompt.md'),
      '# System context',
      'utf-8',
    );

    const result = await convertQoderPlugin(root);

    expect(result.config.contextFileName).toEqual([
      'QWEN.md',
      'system-prompt.md',
    ]);
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('rejects manifests missing or with a non-string name', async () => {
    writeManifest({});
    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /must have name field/,
    );

    writeManifest({ name: 123 });
    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /must have name field/,
    );
  });

  it('throws a precise error when the manifest is absent', async () => {
    // No .qoder-plugin/plugin.json written; readExtensionManifest returns null
    // and loadQoderConfig surfaces a clear not-found error instead of a bare
    // deref or a misleading generic message.
    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /Qoder plugin configuration not found/,
    );
  });

  it.runIf(process.platform !== 'win32')('does not copy escaping symlinks or load unsafe context paths', async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-external-'));
    const externalFile = path.join(external, 'private.txt');
    fs.writeFileSync(externalFile, 'private', 'utf-8');
    writeManifest({
      name: 'sample-qoder-plugin',
      contextFileName: 'leak.md',
    });
    fs.symlinkSync(externalFile, path.join(root, 'leak.md'));
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.symlinkSync(externalFile, path.join(root, 'skills', 'leak.txt'));

    const result = await convertQoderPlugin(root);

    expect(result.config.contextFileName).toBeUndefined();
    expect(
      fs.existsSync(path.join(result.convertedDir, 'skills', 'leak.txt')),
    ).toBe(false);

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });

  it.each(['QWEN.md', 'system-prompt.md'])(
    'does not load an escaping default %s symlink',
    async (contextFile) => {
      const external = fs.mkdtempSync(
        path.join(os.tmpdir(), 'qoder-external-'),
      );
      const externalFile = path.join(external, contextFile);
      fs.writeFileSync(externalFile, 'External context', 'utf-8');
      writeManifest({ name: 'sample-qoder-plugin' });
      fs.symlinkSync(externalFile, path.join(root, contextFile));

      const result = await convertQoderPlugin(root);

      expect(result.config.contextFileName).toBeUndefined();
      expect(fs.existsSync(path.join(result.convertedDir, contextFile))).toBe(
        false,
      );
      fs.rmSync(result.convertedDir, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
    },
  );

  it('drops context files removed during selective resource collection', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      commands: 'commands/kept.md',
      contextFileName: 'commands/removed.md',
    });
    fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(root, 'commands', 'kept.md'), '# Kept');
    fs.writeFileSync(path.join(root, 'commands', 'removed.md'), '# Removed');

    const result = await convertQoderPlugin(root);

    expect(result.config.contextFileName).toBeUndefined();
    expect(
      fs.existsSync(path.join(result.convertedDir, 'commands', 'kept.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(result.convertedDir, 'commands', 'removed.md')),
    ).toBe(false);
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('ignores context paths that resolve to directories', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      contextFileName: 'docs',
    });
    fs.mkdirSync(path.join(root, 'docs'));

    const result = await convertQoderPlugin(root);

    expect(result.config.contextFileName).toBeUndefined();
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  // Pin the precise throw message for each readExtraJsonFile rejection —
  // without these the converter collapses every failure into "file could
  // not be read", and diagnosis requires running the extension by hand.

  it('throws "file does not exist" when explicit mcpServers string points at a missing file', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      mcpServers: 'mcp/does-not-exist.json',
    });

    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /Invalid Qoder MCP configuration at mcp\/does-not-exist\.json: file does not exist/,
    );
  });

  it('throws with JSON parse detail when explicit mcpServers string points at an unparseable file', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      mcpServers: 'mcp/broken.json',
    });
    fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'mcp', 'broken.json'),
      '{invalid',
      'utf-8',
    );

    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /Invalid Qoder MCP configuration at mcp\/broken\.json: JSON parse failed/,
    );
  });

  it('throws "top-level body is not a JSON object" when explicit mcpServers string points at an array body', async () => {
    writeManifest({
      name: 'sample-qoder-plugin',
      mcpServers: 'mcp/array.json',
    });
    fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'mcp', 'array.json'),
      '[1, 2, 3]',
      'utf-8',
    );

    await expect(convertQoderPlugin(root)).rejects.toThrow(
      /Invalid Qoder MCP configuration at mcp\/array\.json: top-level body is not a JSON object/,
    );
  });

  // Win32 skip matches the path-confinement.test.ts convention
  // (dev-mode symlinks need elevated privileges).

  it.runIf(process.platform !== 'win32')(
    'throws "resolves through a symlink outside" when explicit mcpServers absolute path is a symlink escape',
    async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-out-'));
      try {
        const outside = path.join(outsideDir, 'mcp.json');
        fs.writeFileSync(outside, JSON.stringify({ a: 1 }), 'utf-8');
        const inside = path.join(root, 'linked.json');
        fs.symlinkSync(outside, inside);

        writeManifest({
          name: 'sample-qoder-plugin',
          mcpServers: inside,
        });

        await expect(convertQoderPlugin(root)).rejects.toThrow(
          /Invalid Qoder MCP configuration at .+: absolute path resolves through a symlink outside the extension/,
        );
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'throws "absolute path is outside" when explicit mcpServers absolute path is a plain outside file',
    async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-out-'));
      try {
        const outside = path.join(outsideDir, 'mcp.json');
        // Outside target must exist so the assertion hits the absolute-outside branch.
        fs.writeFileSync(outside, JSON.stringify({ a: 1 }), 'utf-8');

        writeManifest({
          name: 'sample-qoder-plugin',
          mcpServers: outside,
        });

        await expect(convertQoderPlugin(root)).rejects.toThrow(
          /Invalid Qoder MCP configuration at .+: absolute path is outside the extension directory/,
        );
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it('throws "escapes the extension" when explicit mcpServers relative path uses ..', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-out-'));
    try {
      // Escape target must exist so the assertion hits the confinement branch.
      fs.writeFileSync(
        path.join(outsideDir, 'mcp.json'),
        JSON.stringify({ a: 1 }),
        'utf-8',
      );

      writeManifest({
        name: 'sample-qoder-plugin',
        // Strict mode `..` → resolvePathWithin throws → caught as
        // confinement-threw → embedded in the explicit-mcp throw message.
        mcpServers: path.join('..', path.basename(outsideDir), 'mcp.json'),
      });

      await expect(convertQoderPlugin(root)).rejects.toThrow(
        /Invalid Qoder MCP configuration at .*: .*escapes the extension directory/,
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('names the extension in the mcpServers validation error', async () => {
    // Top-level mcpServers as a scalar — assertMcpServersContainer should
    // surface the extension name so the user can locate the bad entry.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-scalar-'));
    try {
      fs.mkdirSync(path.join(root, '.qoder-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.qoder-plugin', 'plugin.json'),
        JSON.stringify({ name: 'scalar-mcp-test', mcpServers: 42 }),
      );

      await expect(convertQoderPlugin(root)).rejects.toThrow(
        /Invalid MCP server "scalar-mcp-test"/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
