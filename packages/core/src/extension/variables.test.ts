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
import { HookType, type HookDefinition } from '../hooks/types.js';
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
  const commandHook = (command: string) => ({
    type: HookType.Command as const,
    command,
  });

  /** The command of hook `hook` in definition `def` under `event`. */
  function commandAt(result: unknown, event: string, def = 0, hook = 0) {
    const defs = (result as Record<string, HookDefinition[]>)[event]!;
    return (defs[def].hooks![hook] as { command: string }).command;
  }

  it('should substitute ${CLAUDE_PLUGIN_ROOT} with the actual path in hooks', () => {
    const hooks = {
      PreToolUse: [
        {
          description: 'Setup before start',
          hooks: [commandHook('${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh')],
        },
      ],
    };

    const result = substituteHookVariables(hooks, '/path/to/plugin');

    expect(result).toBeDefined();
    expect(result!['PreToolUse']).toHaveLength(1);
    expect(commandAt(result, 'PreToolUse')).toBe(
      '/path/to/plugin/scripts/setup.sh',
    );
  });

  it('should handle multiple hooks with variables', () => {
    const hooks = {
      PostToolUse: [
        {
          description: 'Post install hook 1',
          hooks: [commandHook('${CLAUDE_PLUGIN_ROOT}/bin/init.sh')],
        },
        {
          description: 'Post install hook 2',
          hooks: [
            commandHook('chmod +x ${CLAUDE_PLUGIN_ROOT}/bin/executable.sh'),
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, '/project/plugins/my-plugin');

    expect(result).toBeDefined();
    expect(result!['PostToolUse']).toHaveLength(2);
    expect(commandAt(result, 'PostToolUse', 0)).toBe(
      '/project/plugins/my-plugin/bin/init.sh',
    );
    expect(commandAt(result, 'PostToolUse', 1)).toBe(
      'chmod +x /project/plugins/my-plugin/bin/executable.sh',
    );
  });

  it('should handle multiple event types with hooks', () => {
    const hooks = {
      PreToolUse: [
        {
          matcher: 'test-matcher',
          sequential: true,
          hooks: [commandHook('${CLAUDE_PLUGIN_ROOT}/scripts/pre-start.sh')],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: 'another-matcher',
          sequential: false,
          hooks: [commandHook('${CLAUDE_PLUGIN_ROOT}/setup/install.py')],
        },
      ],
    };

    const result = substituteHookVariables(
      hooks,
      '/home/user/.qwen/extensions/my-extension',
    );

    expect(result).toBeDefined();
    expect(result!['PreToolUse']).toHaveLength(1);
    expect(commandAt(result, 'PreToolUse')).toBe(
      '/home/user/.qwen/extensions/my-extension/scripts/pre-start.sh',
    );
    expect(result!['UserPromptSubmit']).toHaveLength(1);
    expect(commandAt(result, 'UserPromptSubmit')).toBe(
      '/home/user/.qwen/extensions/my-extension/setup/install.py',
    );
  });

  it('should not modify non-command hooks', () => {
    const hooks = {
      SessionStart: [
        {
          matcher: 'test-matcher',
          sequential: true,
          hooks: [
            commandHook('${CLAUDE_PLUGIN_ROOT}/scripts/run.sh'),
            {
              type: 'non-command' as HookType.Command,
              command: '${CLAUDE_PLUGIN_ROOT}/not-affected',
            },
          ],
        },
      ],
    };

    const result = substituteHookVariables(hooks, '/path/to/extension');

    expect(result).toBeDefined();
    expect(result!['SessionStart']).toHaveLength(1);
    expect(commandAt(result, 'SessionStart', 0, 0)).toBe(
      '/path/to/extension/scripts/run.sh',
    );
    // Non-command type won't be processed
    expect(commandAt(result, 'SessionStart', 0, 1)).toBe(
      '${CLAUDE_PLUGIN_ROOT}/not-affected',
    );
  });

  it('should return undefined when hooks is undefined', () => {
    const result = substituteHookVariables(undefined, '/some/path');
    expect(result).toBeUndefined();
  });

  it('should return original hooks when no ${CLAUDE_PLUGIN_ROOT} found', () => {
    const hooks = {
      Stop: [
        {
          matcher: 'test-matcher',
          sequential: true,
          hooks: [commandHook('echo "hello world"')],
        },
      ],
    };

    const result = substituteHookVariables(hooks, '/path/to/plugin');

    expect(result).toBeDefined();
    expect(result).toEqual(hooks); // Should be equal but not the same object (deep clone)
    expect(commandAt(result, 'Stop')).toBe('echo "hello world"');
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

  /** Writes `files` (relative path to content) into `testDir/<dir>`. */
  function writeExt(files: Record<string, string>, dir = 'ext'): string {
    const extDir = path.join(testDir, dir);
    fs.mkdirSync(extDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(extDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(extDir, rel), content, 'utf-8');
    }
    return extDir;
  }

  /** Writes `files`, runs the replacement, and returns a reader for them. */
  function replaceIn(
    files: Record<string, string>,
    { dir = 'ext', installedDir }: { dir?: string; installedDir?: string } = {},
  ) {
    const extDir = writeExt(files, dir);
    performVariableReplacement(extDir, installedDir);
    const read = (rel: string) =>
      fs.readFileSync(path.join(extDir, rel), 'utf-8');
    return { extDir, read };
  }

  it('should replace ${CLAUDE_PLUGIN_ROOT} in markdown files', () => {
    const mdContent = [
      '# README',
      '',
      'Configuration file is at `${CLAUDE_PLUGIN_ROOT}/config.json`.',
      'Run `${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh` to initialize.',
    ].join('\n');
    const { extDir, read } = replaceIn({ 'README.md': mdContent });

    const result = read('README.md');
    expect(result).toContain(`${extDir}/config.json`);
    expect(result).toContain(`${extDir}/scripts/setup.sh`);
    expect(result).not.toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('should edit a staging directory using a separate installed path', () => {
    const installedDir = path.join(testDir, 'installed');
    const { read } = replaceIn(
      { 'README.md': '${CLAUDE_PLUGIN_ROOT}/config.json' },
      { dir: 'staging', installedDir },
    );

    expect(read('README.md')).toBe(`${installedDir}/config.json`);
  });

  it('should preserve replacement metacharacters in the installed path', () => {
    const installedDir = path.join(testDir, "installed-$&-$`-$'");
    const { read } = replaceIn(
      { 'README.md': '${CLAUDE_PLUGIN_ROOT}/config.json' },
      { dir: 'staging', installedDir },
    );

    expect(read('README.md')).toBe(`${installedDir}/config.json`);
  });

  it('should convert ```! syntax to !{} in markdown files', () => {
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
    const { read } = replaceIn({ 'guide.md': mdContent });

    const result = read('guide.md');
    expect(result).toContain('!{');
    expect(result).toContain('npm install');
    expect(result).toContain('npm run build');
    expect(result).not.toContain('```!');
  });

  it('should replace .claude with .qwen in markdown files', () => {
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
    const { read } = replaceIn({ 'cancel.md': mdContent });

    const result = read('cancel.md');
    expect(result).toContain('.qwen/loop.local.md');
    expect(result).toContain('rm .qwen/loop.local.md');
    expect(result).toContain('$HOME/.qwen/cache');
    expect(result).toContain('./.qwen/local');
    expect(result).not.toContain('.claude/');
  });

  it('should replace "role":"assistant" with "type":"assistant" in shell scripts', () => {
    const shContent = `#!/bin/bash
      # Process response
      echo '{"role":"assistant","content":"Hello"}'
      echo '{"role":"user","content":"Hi"}'
      echo '{"role":"assistant","content":"How can I help?"}'
      `;
    const { read } = replaceIn({ 'process.sh': shContent });

    const result = read('process.sh');
    expect(result).toContain('"type":"assistant"');
    expect(result).not.toContain('"role":"assistant"');
    // Should not affect other roles
    expect(result).toContain('"role":"user"');
  });

  it('should update transcript parsing in shell scripts', () => {
    const shContent = `#!/bin/bash
      # Parse transcript
      jq '.message.content | map(select(.type == "text"))' <<< "$response"
      `;
    const { read } = replaceIn({ 'parse.sh': shContent });

    const result = read('parse.sh');
    expect(result).toContain('.message.parts | map(select(has("text")))');
    expect(result).not.toContain('.message.content');
  });

  it('should replace .claude with .qwen in shell scripts', () => {
    const shContent = [
      '#!/bin/bash',
      'HOME_CLAUDE="$HOME/.claude"',
      'CACHE_DIR="~/.claude/cache"',
      'LOCAL_DIR="./.claude/local"',
      'CONFIG="${CLAUDE_PLUGIN_ROOT}/.claude/config"',
      '# Not replaced: https://example.com/.claude/page',
    ].join('\n');
    const { read } = replaceIn({ 'setup.sh': shContent });

    const result = read('setup.sh');
    expect(result).toContain('$HOME/.claude');
    expect(result).toContain('~/.qwen/cache');
    expect(result).toContain('./.qwen/local');
    expect(result).toContain('.qwen/config');
    // Note: URLs are also being replaced in current implementation
    expect(result).toContain('https://example.com/.qwen/page');
  });

  it('should handle multiple markdown files', () => {
    const { extDir, read } = replaceIn({
      'README.md': 'Path: `${CLAUDE_PLUGIN_ROOT}/readme`',
      'docs/guide.md': 'Path: `${CLAUDE_PLUGIN_ROOT}/docs/guide`',
    });

    expect(read('README.md')).toContain(`${extDir}/readme`);
    expect(read('docs/guide.md')).toContain(`${extDir}/docs/guide`);
  });

  it('should handle multiple shell script files', () => {
    const { read } = replaceIn({
      'setup.sh': 'echo "${CLAUDE_PLUGIN_ROOT}/setup"',
      'scripts/helper.sh': 'echo "${CLAUDE_PLUGIN_ROOT}/scripts/helper"',
    });

    expect(read('setup.sh')).toContain('${CLAUDE_PLUGIN_ROOT}/setup');
    expect(read('scripts/helper.sh')).toContain(
      '${CLAUDE_PLUGIN_ROOT}/scripts/helper',
    );
  });

  it('should handle empty directories gracefully', () => {
    const extDir = writeExt({}, 'empty-ext');

    expect(() => performVariableReplacement(extDir)).not.toThrow();
  });

  it('should handle directories with no matching files', () => {
    const extDir = writeExt({
      'file.txt': 'content',
      'script.py': 'print("hello")',
    });

    expect(() => performVariableReplacement(extDir)).not.toThrow();
    // Files should remain unchanged
    expect(fs.readFileSync(path.join(extDir, 'file.txt'), 'utf-8')).toBe(
      'content',
    );
  });

  // performVariableReplacement only processes .md files, so these all use one.
  describe('regex boundary cases', () => {
    it('should not replace incomplete variable syntax (missing brace) in markdown', () => {
      const { read } = replaceIn(
        { 'test.md': 'Path: $CLAUDE_PLUGIN_ROOT/config.json' },
        { dir: 'ext-incomplete' },
      );

      // Should remain unchanged (no braces)
      expect(read('test.md')).toBe('Path: $CLAUDE_PLUGIN_ROOT/config.json');
    });

    it('should replace double dollar sign but keep first dollar', () => {
      // The regex matches ${CLAUDE_PLUGIN_ROOT}, leaving first $ intact
      const { extDir, read } = replaceIn(
        { 'test.md': 'Path: $${CLAUDE_PLUGIN_ROOT}/config.json' },
        { dir: 'ext-double-dollar' },
      );

      expect(read('test.md')).toBe(`Path: $${extDir}/config.json`);
    });

    it('should replace variable in markdown comments', () => {
      const { extDir, read } = replaceIn(
        { 'test.md': '# TODO: Update ${CLAUDE_PLUGIN_ROOT} later' },
        { dir: 'ext-comment' },
      );

      // Should be replaced (comments in markdown are still processed)
      const result = read('test.md');
      expect(result).toContain(extDir);
      expect(result).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    });
  });
});
