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
    expect(manifest.hooks).toBeUndefined();
    expect(server?.['env']).toBeUndefined();
    expect(server?.['trust']).toBeUndefined();
    expect(packageJson.scripts?.['build']).toContain('--bundle');
    expect(packageJson.files).toContain('dist/main.js');
    expect(packageJson.files).toContain('dist/auto-recall.js');
    expect(packageJson.files).toContain('dist/write-main.js');
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

  it('ships only the runtime, schemas, examples, manifest, and documentation', async () => {
    const packageJson = await readJson('../package.json');

    expect(packageJson.files).toEqual([
      'dist/main.js',
      'dist/auto-recall.js',
      'dist/write-main.js',
      'dist/delete-main.js',
      'schemas',
      'examples',
      'qwen-extension.json',
      'README.md',
    ]);
  });

  it.each([
    {
      platform: 'posix',
      command:
        "exec '/absolute/path/to/node' '/administrator/path/to/external-context-mem0/dist/auto-recall.js'",
      shell: undefined,
    },
    {
      platform: 'windows',
      command:
        "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\administrator\\external-context-mem0\\dist\\auto-recall.js'",
      shell: 'powershell',
    },
  ])(
    'keeps the managed Auto Recall $platform profile Hook-only',
    async ({ platform, command, shell }) => {
      const settings = await readJson(
        `../examples/managed-auto-recall-user-settings-${platform}.json`,
      );
      const groups = settings.hooks?.['UserPromptSubmit'] ?? [];
      const group = groups[0];
      const hooks = group?.hooks ?? [];

      expect(settings.$version).toBe(4);
      expect(settings.mcpServers).toBeUndefined();
      expect(Object.keys(settings.hooks ?? {})).toEqual(['UserPromptSubmit']);
      expect(groups).toHaveLength(1);
      expect(group?.matcher).toBe('*');
      expect(hooks).toEqual([
        {
          type: 'command',
          command,
          ...(shell === undefined ? {} : { shell }),
          timeout: 8000,
          name: 'external-context-mem0-auto-recall',
          statusMessage: 'Retrieving external context',
        },
      ]);
    },
  );
});

interface Manifest {
  $version?: number;
  version?: string;
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks?: Array<Record<string, unknown>>;
    }>
  >;
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
