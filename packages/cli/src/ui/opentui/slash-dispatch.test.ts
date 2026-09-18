/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies OpenTUI interactive command loading: the built-in registry produced
 * by the original loader stack, and the model-invocable provider/executor
 * registration on the config. Command dispatch is covered in
 * `commands-dispatch.test.ts` (the `OpenTuiSlashDispatcher` path).
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { loadInteractiveCommands } from './slash-dispatch.js';
import { HELP_DOCS_URL, formatHelpText } from './help-content.js';

describe('original built-in registry', () => {
  it('loads built-in commands without a config (BuiltinCommandLoader)', async () => {
    const commands = await loadInteractiveCommands(null);
    const names = commands.map((cmd) => cmd.name);
    expect(names).toContain('help');
    expect(names).toContain('quit');
    expect(names).toContain('clear');
    expect(names).toContain('stats');
    // every interactive command is user-invocable and visible
    for (const cmd of commands) {
      expect(cmd.hidden).toBeFalsy();
      expect(cmd.userInvocable).not.toBe(false);
    }
  }, 30000);

  it('help output matches the original dialog content', async () => {
    const commands = await loadInteractiveCommands(null);
    const text = formatHelpText(commands);
    expect(text).toContain('Qwen Code');
    expect(text).toContain('Shortcuts');
    expect(text).toContain('↑/↓');
    expect(text).toContain('Browse built-in commands:');
    expect(text).toContain('Built-in Commands');
    expect(text).toContain('/help');
    expect(text).toContain('/quit');
    expect(text).toContain(HELP_DOCS_URL);
  }, 30000);
});

describe('model-invocable commands registration (ink loader-effect parity)', () => {
  type InvocableProvider = () => ReadonlyArray<{
    name: string;
    description: string;
  }>;
  type InvocableExecutor = (
    name: string,
    args?: string,
  ) => Promise<string | { error: string } | null>;

  // Minimal config stub: registration methods are captured while every
  // dynamic loader (skills, file commands, MCP prompts) stays on its empty
  // path, so the provider lists nothing but stays well-formed.
  function createConfigStub(
    onProvider?: (provider: InvocableProvider) => void,
    onExecutor?: (executor: InvocableExecutor) => void,
  ): Config {
    return {
      initialize: async () => {},
      getDisabledSlashCommands: () => [],
      setModelInvocableCommandsProvider: (provider: InvocableProvider) =>
        onProvider?.(provider),
      setModelInvocableCommandsExecutor: (executor: InvocableExecutor) =>
        onExecutor?.(executor),
      getBareMode: () => true,
      isWorkflowsEnabled: () => false,
      isManagedMemoryAvailable: () => false,
      getFolderTrust: () => false,
      getFolderTrustFeature: () => false,
      getFileCheckpointingEnabled: () => false,
      isLspEnabled: () => false,
      isCronEnabled: () => false,
      getMcpServers: () => ({}),
      getSkillManager: () => undefined,
      getDisabledSkillNames: () => new Set<string>(),
      getPermissionManager: () => undefined,
      getModel: () => undefined,
      getCliVersion: () => undefined,
      getProjectRoot: () => '/nonexistent-opentui-test-root',
    } as unknown as Config;
  }

  it('registers the provider and executor on the config', async () => {
    const providerSpy = vi.fn();
    const executorSpy = vi.fn();
    const config = createConfigStub(providerSpy, executorSpy);
    await loadInteractiveCommands(config);
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(executorSpy).toHaveBeenCalledTimes(1);
  }, 30000);

  it('provider() returns a {name, description} listing', async () => {
    let provider: InvocableProvider | undefined;
    await loadInteractiveCommands(
      createConfigStub((p) => {
        provider = p;
      }),
    );
    expect(provider).toBeTypeOf('function');
    if (!provider) return;
    // Built-ins are forced modelInvocable:false and the stub keeps every
    // dynamic loader empty, so the listing is empty but well-formed.
    expect(provider()).toEqual([]);
  }, 30000);

  it('executor() returns null for names the model cannot invoke', async () => {
    let executor: InvocableExecutor | undefined;
    await loadInteractiveCommands(
      createConfigStub(undefined, (e) => {
        executor = e;
      }),
    );
    expect(executor).toBeTypeOf('function');
    if (!executor) return;
    // built-ins are never model-invocable, and unknown names miss entirely
    await expect(executor('help')).resolves.toBeNull();
    await expect(executor('definitely-not-a-command')).resolves.toBeNull();
  }, 30000);
});
