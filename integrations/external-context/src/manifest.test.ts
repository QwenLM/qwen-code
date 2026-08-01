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
});

async function readJson(relativePath: string) {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), 'utf8'),
  );
}
