/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { builtInPresets } from './presets.js';

describe('Mem0 Extension package', () => {
  it('is self-contained and exposes only context_search', async () => {
    const manifest = await readJson('../qwen-extension.json');
    const packageJson = await readJson('../package.json');
    const server = manifest.mcpServers?.['external-context-mem0'];

    expect(Object.keys(manifest.mcpServers ?? {})).toEqual([
      'external-context-mem0',
    ]);
    expect(server).toEqual({
      command: 'node',
      args: ['${extensionPath}${/}dist${/}main.js'],
      cwd: '${extensionPath}',
      includeTools: ['context_search'],
    });
    expect(manifest.settings).toBeUndefined();
    expect(server?.['env']).toBeUndefined();
    expect(server?.['trust']).toBeUndefined();
    expect(packageJson.scripts?.['build']).toContain('--bundle');
    expect(packageJson.files).toContain('dist/main.js');
    expect(packageJson.dependencies).toBeUndefined();
  });

  it('ships no live provider preset in PR1', () => {
    expect([...builtInPresets]).toEqual([]);
  });
});

interface Manifest {
  mcpServers?: Record<string, Record<string, unknown>>;
  settings?: unknown;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
}

async function readJson(relativePath: string): Promise<Manifest & PackageJson> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), 'utf8'),
  ) as Manifest & PackageJson;
}
