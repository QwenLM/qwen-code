/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

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
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.name).toBe('@qwen-code/external-context-mem0');
    expect(packageJson.version).toBe(manifest.version);
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/QwenLM/qwen-code.git',
      directory: 'integrations/external-context-mem0',
    });
  });

  it('ships only the runtime, schemas, manifest, and documentation', async () => {
    const packageJson = await readJson('../package.json');

    expect(packageJson.files).toEqual([
      'dist/main.js',
      'schemas',
      'qwen-extension.json',
      'README.md',
    ]);
  });
});

interface Manifest {
  version?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
  settings?: unknown;
}

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  repository?: {
    type?: string;
    url?: string;
    directory?: string;
  };
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
}

async function readJson(relativePath: string): Promise<Manifest & PackageJson> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), 'utf8'),
  ) as Manifest & PackageJson;
}
