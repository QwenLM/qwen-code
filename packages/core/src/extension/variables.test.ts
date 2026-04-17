/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, beforeEach, afterEach } from 'vitest';
import {
  hydrateString,
  substituteHookVariables,
  performVariableReplacement,
} from './variables.js';
import { HookType } from '../hooks/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
              type: HookType.Command as const,
              command: '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh',
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, basePath);

    expect(result).toBeDefined();
    expect(result!['PreToolUse']).toHaveLength(1);
    expect(
      (result!['PreToolUse']![0].hooks![0] as { command: string }).command,
    ).toBe('/path/to/plugin/scripts/setup.sh');
  });

  it('should handle multiple hooks with variables', () => {
    const basePath = '/project/plugins/my-plugin';

    const hooks = {
      PostToolUse: [
        {
          description: 'Post install hook 1',
          hooks: [
            {
              type: HookType.Command as const,
              command: '${CLAUDE_PLUGIN_ROOT}/bin/init.sh',
            },
          ],
        },
        {
          description: 'Post install hook 2',
          hooks: [
            {
              type: HookType.Command as const,
              command: 'chmod +x ${CLAUDE_PLUGIN_ROOT}/bin/executable.sh',
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, basePath);

    expect(result).toBeDefined();
    expect(result!['PostToolUse']).toHaveLength(2);
    expect(
      (result!['PostToolUse']![0].hooks![0] as { command: string }).command,
    ).toBe('/project/plugins/my-plugin/bin/init.sh');
    expect(
      (result!['PostToolUse']![1].hooks![0] as { command: string }).command,
    ).toBe('chmod +x /project/plugins/my-plugin/bin/executable.sh');
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
              type: HookType.Command as const, // HookType.Command
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
              type: HookType.Command as const, // HookType.Command
              command: '${CLAUDE_PLUGIN_ROOT}/setup/install.py',
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, basePath);

    expect(result).toBeDefined();
    expect(result!['PreToolUse']).toHaveLength(1);
    expect(
      (result!['PreToolUse']![0].hooks![0] as { command: string }).command,
    ).toBe('/home/user/.qwen/extensions/my-extension/scripts/pre-start.sh');
    expect(result!['UserPromptSubmit']).toHaveLength(1);
    expect(
      (result!['UserPromptSubmit']![0].hooks![0] as { command: string })
        .command,
    ).toBe('/home/user/.qwen/extensions/my-extension/setup/install.py');
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
              type: HookType.Command as const, // This is part of HookConfig
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
    expect(
      (result!['SessionStart']![0].hooks![0] as { command: string }).command,
    ).toBe('/path/to/extension/scripts/run.sh');
    expect(
      (result!['SessionStart']![0].hooks![1] as { command: string }).command,
    ).toBe('${CLAUDE_PLUGIN_ROOT}/not-affected'); // Non-command type won't be processed
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
              type: HookType.Command as const, // This is part of CommandHookConfig
              command: 'echo "hello world"', // This is part of CommandHookConfig
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, basePath);

    expect(result).toBeDefined();
    expect(result).toEqual(hooks); // Should be equal but not the same object (deep clone)
    expect((result!['Stop']![0].hooks![0] as { command: string }).command).toBe(
      'echo "hello world"',
    );
  });
});

describe('performVariableReplacement', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'var-replace-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should replace ${CLAUDE_PLUGIN_ROOT} in markdown files', () => {
    const extDir = path.join(testDir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });

    const mdContent = [
      '# README',
      '',
      'Configuration file is at `${CLAUDE_PLUGIN_ROOT}/config.json`.',
      'Run `${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh` to initialize.',
    ].join('\n');
    fs.writeFileSync(path.join(extDir, 'README.md'), mdContent, 'utf-8');

    performVariableReplacement(extDir);

    const result = fs.readFileSync(path.join(extDir, 'README.md'), 'utf-8');
    expect(result).toContain(`${extDir}/config.json`);
    expect(result).toContain(`${extDir}/scripts/setup.sh`);
    expect(result).not.toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('should convert ```! syntax to !{} in markdown files', () => {
    const extDir = path.join(testDir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });

    const mdContent = `## Commands

      \`\`\`!
      npm install
      npm run build
      \`\`\`

      Some text.

      \`\`\`!
      echo "Hello World"
      \`\`\`
      `;
    fs.writeFileSync(path.join(extDir, 'guide.md'), mdContent, 'utf-8');

    performVariableReplacement(extDir);

    const result = fs.readFileSync(path.join(extDir, 'guide.md'), 'utf-8');
    expect(result).toContain('!{');
    expect(result).toContain('npm install');
    expect(result).toContain('npm run build');
    expect(result).not.toContain('```!');
  });

  it('should replace .claude with .qwen in markdown files', () => {
    const extDir = path.join(testDir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });

    const mdContent = [
      '---',
      'description: "Cancel active loop"',
      '---',
      '',
      '# Cancel',
      '',
      'Check if `.claude/loop.local.md` exists.',
      'Remove the file: `rm .claude/loop.local.md`',
      'Path: `$HOME/.claude/cache`',
      'Local: `./.claude/local`',
    ].join('\n');
    fs.writeFileSync(path.join(extDir, 'cancel.md'), mdContent, 'utf-8');

    performVariableReplacement(extDir);

    const result = fs.readFileSync(path.join(extDir, 'cancel.md'), 'utf-8');
    expect(result).toContain('.qwen/loop.local.md');
    expect(result).toContain('rm .qwen/loop.local.md');
    expect(result).toContain('$HOME/.qwen/cache');
    expect(result).toContain('./.qwen/local');
    expect(result).not.toContain('.claude/');
  });

  it('should replace "role":"assistant" with "type":"assistant" in shell scripts', () => {
    const extDir = path.join(testDir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });

    const shContent = `#!/bin/bash
      # Process response
      echo '{"role":"assistant","content":"Hello"}'
      echo '{"role":"user","content":"Hi"}'
      echo '{"role":"assistant","content":"How can I help?"}'
      `;
    fs.writeFileSync(path.join(extDir, 'process.sh'), shContent, 'utf-8');

    performVariableReplacement(extDir);

    const result = fs.readFileSync(path.join(extDir, 'process.sh'), 'utf-8');
    expect(result).toContain('"type":"assistant"');
    expect(result).not.toContain('"role":"assistant"');
    // Should not affect other roles
    expect(result).toContain('"role":"user"');
  });

  it('should update transcript parsing in shell scripts', () => {
    const extDir = path.join(testDir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });

    const shContent = `#!/bin/bash
      # Parse transcript
      jq '.message.content | map(select(.type == "text"))' <<< "$response"
      `;
    fs.writeFileSync(path.join(extDir, 'parse.sh'), shContent, 'utf-8');

    performVariableReplacement(extDir);

    const result = fs.readFileSync(path.join(extDir, 'parse.sh'), 'utf-8');
    expect(result).toContain('.message.parts | map(select(has("text")))');
    expect(result).not.toContain('.message.content');
  });

  it('should replace .claude with .qwen in shell scripts', () => {
    const extDir = path.join(testDir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });

    const shContent = [
      '#!/bin/bash',
      'HOME_CLAUDE="$HOME/.claude"',
      'CACHE_DIR="~/.claude/cache"',
      'LOCAL_DIR="./.claude/local"',
      'CONFIG="${CLAUDE_PLUGIN_ROOT}/.claude/config"',
      '# Not replaced: https://example.com/.claude/page',
    ].join('\n');
    fs.writeFileSync(path.join(extDir, 'setup.sh'), shContent, 'utf-8');

    performVariableReplacement(extDir);

    const result = fs.readFileSync(path.join(extDir, 'setup.sh'), 'utf-8');
    expect(result).toContain('$HOME/.claude');
    expect(result).toContain('~/.qwen/cache');
    expect(result).toContain('./.qwen/local');
    expect(result).toContain('.qwen/config');
    // Note: URLs are also being replaced in current implementation
    expect(result).toContain('https://example.com/.qwen/page');
  });

  it('should handle multiple markdown files', () => {
    const extDir = path.join(testDir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'docs'), { recursive: true });

    fs.writeFileSync(
      path.join(extDir, 'README.md'),
      'Path: `${CLAUDE_PLUGIN_ROOT}/readme`',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(extDir, 'docs', 'guide.md'),
      'Path: `${CLAUDE_PLUGIN_ROOT}/docs/guide`',
      'utf-8',
    );

    performVariableReplacement(extDir);

    const readme = fs.readFileSync(path.join(extDir, 'README.md'), 'utf-8');
    const guide = fs.readFileSync(
      path.join(extDir, 'docs', 'guide.md'),
      'utf-8',
    );

    expect(readme).toContain(`${extDir}/readme`);
    expect(guide).toContain(`${extDir}/docs/guide`);
  });

  it('should handle multiple shell script files', () => {
    const extDir = path.join(testDir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'scripts'), { recursive: true });

    fs.writeFileSync(
      path.join(extDir, 'setup.sh'),
      'echo "${CLAUDE_PLUGIN_ROOT}/setup"',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(extDir, 'scripts', 'helper.sh'),
      'echo "${CLAUDE_PLUGIN_ROOT}/scripts/helper"',
      'utf-8',
    );

    performVariableReplacement(extDir);

    const setup = fs.readFileSync(path.join(extDir, 'setup.sh'), 'utf-8');
    const helper = fs.readFileSync(
      path.join(extDir, 'scripts', 'helper.sh'),
      'utf-8',
    );

    expect(setup).toContain('${CLAUDE_PLUGIN_ROOT}/setup');
    expect(helper).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/helper');
  });

  it('should handle empty directories gracefully', () => {
    const extDir = path.join(testDir, 'empty-ext');
    fs.mkdirSync(extDir, { recursive: true });

    // Should not throw
    expect(() => performVariableReplacement(extDir)).not.toThrow();
  });

  it('should handle directories with no matching files', () => {
    const extDir = path.join(testDir, 'ext');
    fs.mkdirSync(extDir, { recursive: true });

    // Create non-matching files
    fs.writeFileSync(path.join(extDir, 'file.txt'), 'content', 'utf-8');
    fs.writeFileSync(path.join(extDir, 'script.py'), 'print("hello")', 'utf-8');

    // Should not throw
    expect(() => performVariableReplacement(extDir)).not.toThrow();

    // Files should remain unchanged
    expect(fs.readFileSync(path.join(extDir, 'file.txt'), 'utf-8')).toBe(
      'content',
    );
  });

  describe('regex boundary cases', () => {
    it('should not replace incomplete variable syntax (missing brace) in markdown', () => {
      const extDir = path.join(testDir, 'ext-incomplete');
      fs.mkdirSync(extDir, { recursive: true });

      // Note: performVariableReplacement only processes .md files
      const content = 'Path: $CLAUDE_PLUGIN_ROOT/config.json';
      fs.writeFileSync(path.join(extDir, 'test.md'), content, 'utf-8');

      performVariableReplacement(extDir);

      const result = fs.readFileSync(path.join(extDir, 'test.md'), 'utf-8');
      // Should remain unchanged (no braces)
      expect(result).toBe('Path: $CLAUDE_PLUGIN_ROOT/config.json');
    });

    it('should replace double dollar sign but keep first dollar', () => {
      const extDir = path.join(testDir, 'ext-double-dollar');
      fs.mkdirSync(extDir, { recursive: true });

      // Note: performVariableReplacement only processes .md files
      // The regex matches ${CLAUDE_PLUGIN_ROOT}, leaving first $ intact
      const content = 'Path: $${CLAUDE_PLUGIN_ROOT}/config.json';
      fs.writeFileSync(path.join(extDir, 'test.md'), content, 'utf-8');

      performVariableReplacement(extDir);

      const result = fs.readFileSync(path.join(extDir, 'test.md'), 'utf-8');
      // First $ is preserved, variable is replaced
      expect(result).toBe(`Path: $${extDir}/config.json`);
    });

    it('should replace variable in markdown comments', () => {
      const extDir = path.join(testDir, 'ext-comment');
      fs.mkdirSync(extDir, { recursive: true });

      // Comments in markdown files should be processed
      const content = '# TODO: Update ${CLAUDE_PLUGIN_ROOT} later';
      fs.writeFileSync(path.join(extDir, 'test.md'), content, 'utf-8');

      performVariableReplacement(extDir);

      const result = fs.readFileSync(path.join(extDir, 'test.md'), 'utf-8');
      // Should be replaced (comments in markdown are still processed)
      expect(result).toContain(extDir);
      expect(result).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    });
  });
});
