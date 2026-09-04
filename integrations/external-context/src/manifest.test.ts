/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('extension manifest', () => {
  it('exposes only the retrieval tool', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../qwen-extension.json', import.meta.url),
        'utf8',
      ),
    );

    expect(manifest.mcpServers?.['external-context']?.includeTools).toEqual([
      'context_search',
    ]);
    expect(manifest.hooks).toBeUndefined();
  });

  it('keeps the remote provider Extension OAuth-only and retrieval-only', async () => {
    const manifest = await readJson(
      '../examples/provider-extension-remote/qwen-extension.json',
    );
    const server = manifest.mcpServers?.['provider-context-remote-example'];

    expect(Object.keys(manifest.mcpServers ?? {})).toEqual([
      'provider-context-remote-example',
    ]);
    expect(server).toEqual({
      httpUrl: 'https://context.example.com/mcp',
      timeout: 8000,
      includeTools: ['context_search'],
      oauth: {
        enabled: true,
        scopes: ['context.read'],
        audiences: ['https://context.example.com/mcp'],
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(
      /authorization|token|secret|api.?key|trust/i,
    );
  });

  it('keeps the local provider Extension self-contained and retrieval-only', async () => {
    const manifest = await readJson(
      '../examples/provider-extension-local/qwen-extension.json',
    );
    const server = manifest.mcpServers?.['provider-context-local-example'];
    const packageJson = await readJson(
      '../examples/provider-extension-local/package.json',
    );

    expect(Object.keys(manifest.mcpServers ?? {})).toEqual([
      'provider-context-local-example',
    ]);
    expect(server).toEqual({
      command: 'node',
      args: ['${extensionPath}${/}dist${/}main.js'],
      cwd: '${extensionPath}',
      env: {
        PROVIDER_CONTEXT_BASE_URL: '${PROVIDER_CONTEXT_BASE_URL}',
        PROVIDER_CONTEXT_TOKEN: '${PROVIDER_CONTEXT_TOKEN}',
      },
      timeout: 8000,
      includeTools: ['context_search'],
    });
    expect(manifest.settings).toBeUndefined();
    expect(server?.trust).toBeUndefined();
    expect(packageJson.scripts?.build).toContain('--bundle');
    expect(packageJson.dependencies).toBeUndefined();
  });

  it.each([
    {
      platform: 'posix',
      command:
        "exec '/absolute/path/to/node' '/administrator/path/to/qwen-code/integrations/external-context/dist/auto-recall.js'",
      shell: undefined,
    },
    {
      platform: 'windows',
      command:
        "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\administrator\\qwen-code\\integrations\\external-context\\dist\\auto-recall.js'",
      shell: 'powershell',
    },
  ])(
    'keeps the managed auto-recall $platform profile Hook-only',
    async ({ platform, command, shell }) => {
      const settings = await readJson(
        `../examples/managed-auto-recall-user-settings-${platform}.json`,
      );
      const events = Object.keys(settings.hooks ?? {});
      const groups = settings.hooks?.UserPromptSubmit ?? [];
      const group = groups[0];
      const hooks = group?.hooks ?? [];
      const hook = hooks[0];

      expect(settings.$version).toBe(4);
      expect(settings.mcpServers).toBeUndefined();
      expect(events).toEqual(['UserPromptSubmit']);
      expect(groups).toHaveLength(1);
      expect(group?.matcher).toBe('*');
      expect(hooks).toHaveLength(1);
      expect(hook).toEqual({
        type: 'command',
        command,
        ...(shell === undefined ? {} : { shell }),
        timeout: 8000,
        name: 'external-context-auto-recall',
        statusMessage: 'Retrieving external context',
      });
    },
  );

  it.each(['generic-http', 'mem0'])(
    'uses v2 for the managed auto-recall %s provider',
    async (provider) => {
      const config = await readJson(`../examples/auto-recall-${provider}.json`);

      expect(config).toMatchObject({
        version: 2,
        autoRecall: {
          repositoryRoot: '/absolute/path/to/repository',
          timeoutMs: 1500,
        },
      });
    },
  );

  it('disables local persistence and native memory in the auto profile', async () => {
    const settings = await readJson(
      '../examples/managed-auto-recall-system-settings.json',
    );

    expect(settings).toMatchObject({
      $version: 4,
      disableAllHooks: false,
      general: { chatRecording: false },
      ui: { enableSpeculation: false },
      memory: {
        enableManagedAutoMemory: false,
        enableManagedAutoDream: false,
        enableTeamMemory: false,
        enableTeamMemorySync: false,
        enableAutoSkill: false,
      },
      tools: { approvalMode: 'default', autoAccept: false },
      privacy: { usageStatisticsEnabled: false },
      telemetry: {
        enabled: false,
        logPrompts: false,
        includeSensitiveSpanAttributes: false,
      },
    });
    expect(settings.slashCommands?.disabled).toEqual(
      expect.arrayContaining(['memory', 'remember', 'forget', 'dream', 'cd']),
    );
    expect(settings.hooks).toBeUndefined();
  });

  it.each([
    {
      platform: 'posix',
      command:
        "exec '/absolute/path/to/node' '/administrator/path/to/qwen-code/integrations/external-context/dist/write-confirmation.js'",
      shell: undefined,
    },
    {
      platform: 'windows',
      command:
        "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\administrator\\qwen-code\\integrations\\external-context\\dist\\write-confirmation.js'",
      shell: 'powershell',
    },
  ])(
    'pins the managed Mem0 write $platform confirmation Hook',
    async ({ platform, command, shell }) => {
      const settings = await readJson(
        `../examples/managed-mem0-write-user-settings-${platform}.json`,
      );
      const events = Object.keys(settings.hooks ?? {});
      const groups = settings.hooks?.PreToolUse ?? [];
      const group = groups[0];
      const hooks = group?.hooks ?? [];
      const hook = hooks[0];

      expect(settings.$version).toBe(4);
      expect(events).toEqual(['PreToolUse']);
      expect(groups).toHaveLength(1);
      expect(group?.matcher).toBe('mcp__external-context__context_remember');
      expect(hooks).toHaveLength(1);
      expect(hook).toEqual({
        type: 'command',
        command,
        ...(shell === undefined ? {} : { shell }),
        timeout: 8000,
        name: 'external-context-memory-write-confirmation',
        statusMessage: 'Confirming external memory write',
      });
    },
  );

  it('keeps the managed Mem0 write MCP surface narrow', async () => {
    const mcp = await readJson('../examples/managed-mem0-write-mcp.json');
    const server = mcp.mcpServers?.['external-context'];

    expect(Object.keys(mcp.mcpServers ?? {})).toEqual(['external-context']);
    expect(server).toEqual({
      command: '/absolute/path/to/node',
      args: [
        '/administrator/path/to/qwen-code/integrations/external-context/dist/main.js',
      ],
      cwd: '/administrator/path/to/qwen-code/integrations/external-context',
      includeTools: ['context_search', 'context_remember'],
    });
  });

  it('uses strict v1 Mem0 configuration for managed writes', async () => {
    const config = await readJson('../examples/mem0-write.json');

    expect(config).toEqual({
      version: 1,
      timeoutMs: 5000,
      write: { enabled: true },
      provider: {
        type: 'mem0-platform-v3',
        apiKeyEnv: 'MEM0_API_KEY',
        appId: 'repository-memory',
      },
    });
  });

  it('pins write confirmation and disables local persistence', async () => {
    const settings = await readJson(
      '../examples/managed-mem0-write-system-settings.json',
    );

    expect(settings).toMatchObject({
      $version: 4,
      disableAllHooks: false,
      general: { chatRecording: false },
      ui: { enableSpeculation: false },
      memory: {
        enableManagedAutoMemory: false,
        enableManagedAutoDream: false,
        enableTeamMemory: false,
        enableTeamMemorySync: false,
        enableAutoSkill: false,
      },
      tools: { approvalMode: 'default', autoAccept: false },
      permissions: {
        allow: ['mcp__external-context__context_search'],
        ask: ['mcp__external-context__context_remember'],
      },
      privacy: { usageStatisticsEnabled: false },
      telemetry: {
        enabled: false,
        logPrompts: false,
        includeSensitiveSpanAttributes: false,
      },
    });
    expect(settings.slashCommands?.disabled).toEqual(
      expect.arrayContaining(['memory', 'remember', 'forget', 'dream', 'cd']),
    );
    expect(settings.hooks).toBeUndefined();
  });
});

async function readJson(relativePath: string) {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), 'utf8'),
  );
}
