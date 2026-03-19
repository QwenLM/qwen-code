/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it } from 'vitest';
import { hydrateString, substituteHookVariables } from './variables.js';
import { HookType } from '../hooks/types.js';

describe('hydrateString', () => {
  it('should replace a single variable', () => {
    const context = {
      extensionPath: 'path/my-extension',
    };
    const result = hydrateString('Hello, ${extensionPath}!', context);
    expect(result).toBe('Hello, path/my-extension!');
  });
});

describe('substituteHookVariables', () => {
  it('should substitute ${CLAUDE_PLUGIN_ROOT} with the actual path in hooks', () => {
    const basePath = '/path/to/plugin';

    const hooks = {
      PreToolUse: [
        {
          description: 'Setup before start',
          hooks: [
            {
              type: HookType.Command,
              command: '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh',
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, basePath);

    expect(result).toBeDefined();
    expect(result!['PreToolUse']).toHaveLength(1);
    expect(result!['PreToolUse']![0].hooks![0].command).toBe(
      '/path/to/plugin/scripts/setup.sh',
    );
  });

  it('should handle multiple hooks with variables', () => {
    const basePath = '/project/plugins/my-plugin';

    const hooks = {
      PostToolUse: [
        {
          description: 'Post install hook 1',
          hooks: [
            {
              type: HookType.Command,
              command: '${CLAUDE_PLUGIN_ROOT}/bin/init.sh',
            },
          ],
        },
        {
          description: 'Post install hook 2',
          hooks: [
            {
              type: HookType.Command,
              command: 'chmod +x ${CLAUDE_PLUGIN_ROOT}/bin/executable.sh',
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, basePath);

    expect(result).toBeDefined();
    expect(result!['PostToolUse']).toHaveLength(2);
    expect(result!['PostToolUse']![0].hooks![0].command).toBe(
      '/project/plugins/my-plugin/bin/init.sh',
    );
    expect(result!['PostToolUse']![1].hooks![0].command).toBe(
      'chmod +x /project/plugins/my-plugin/bin/executable.sh',
    );
  });

  it('should handle multiple event types with hooks', () => {
    const basePath = '/home/user/.qwen/extensions/my-extension';

    const hooks = {
      PreToolUse: [
        {
          matcher: 'test-matcher', // Part of HookDefinition
          sequential: true, // Part of HookDefinition
          hooks: [
            // HookConfig[] array inside HookDefinition
            {
              type: HookType.Command, // HookType.Command
              command: '${CLAUDE_PLUGIN_ROOT}/scripts/pre-start.sh',
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: 'another-matcher', // Part of HookDefinition
          sequential: false, // Part of HookDefinition
          hooks: [
            // HookConfig[] array inside HookDefinition
            {
              type: HookType.Command, // HookType.Command
              command: '${CLAUDE_PLUGIN_ROOT}/setup/install.py',
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, basePath);

    expect(result).toBeDefined();
    expect(result!['PreToolUse']).toHaveLength(1);
    expect(result!['PreToolUse']![0].hooks![0].command).toBe(
      '/home/user/.qwen/extensions/my-extension/scripts/pre-start.sh',
    );
    expect(result!['UserPromptSubmit']).toHaveLength(1);
    expect(result!['UserPromptSubmit']![0].hooks![0].command).toBe(
      '/home/user/.qwen/extensions/my-extension/setup/install.py',
    );
  });

  it('should not modify non-command hooks', () => {
    const basePath = '/path/to/extension';

    const hooks = {
      SessionStart: [
        {
          matcher: 'test-matcher', // This is part of HookDefinition
          sequential: true, // This is part of HookDefinition
          hooks: [
            // This is the HookConfig[] array inside HookDefinition
            {
              type: HookType.Command, // This is part of HookConfig
              command: '${CLAUDE_PLUGIN_ROOT}/scripts/run.sh', // This is part of HookConfig
            },
            {
              type: 'non-command' as HookType.Command, // Non-command type won't be processed
              command: '${CLAUDE_PLUGIN_ROOT}/not-affected', // Should not be modified
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, basePath);

    expect(result).toBeDefined();
    expect(result!['SessionStart']).toHaveLength(1);
    expect(result!['SessionStart']![0].hooks![0].command).toBe(
      '/path/to/extension/scripts/run.sh',
    );
    expect(result!['SessionStart']![0].hooks![1].command).toBe(
      '${CLAUDE_PLUGIN_ROOT}/not-affected',
    ); // Non-command type won't be processed
  });

  it('should return undefined when hooks is undefined', () => {
    const result = substituteHookVariables(undefined, '/some/path');
    expect(result).toBeUndefined();
  });

  it('should return original hooks when no ${CLAUDE_PLUGIN_ROOT} found', () => {
    const basePath = '/path/to/plugin';

    const hooks = {
      Stop: [
        {
          matcher: 'test-matcher', // This is part of HookDefinition
          sequential: true, // This is part of HookDefinition
          hooks: [
            // This is the HookConfig[] array inside HookDefinition
            {
              type: HookType.Command, // This is part of CommandHookConfig
              command: 'echo "hello world"', // This is part of CommandHookConfig
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, basePath);

    expect(result).toBeDefined();
    expect(result).toEqual(hooks); // Should be equal but not the same object (deep clone)
    expect(result!['Stop']![0].hooks![0].command).toBe('echo "hello world"');
  });
});
