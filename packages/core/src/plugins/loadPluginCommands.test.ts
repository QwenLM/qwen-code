/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPluginCommands } from './loadPluginCommands.js';
import type { LoadedPlugin } from './types.js';

function makePlugin(
  root: string,
  overrides: Partial<LoadedPlugin> & { name: string },
): LoadedPlugin {
  return {
    manifest: { name: overrides.name, version: '1.0.0' } as never,
    path: root,
    source: 'local',
    repository: 'local',
    commandsPath: join(root, 'commands'),
    ...overrides,
  } as LoadedPlugin;
}

describe('loadPluginCommands - path-derived identity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-cmds-'));
    mkdirSync(join(root, 'commands'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('derives top-level commands with plugin prefix', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\n---\nbody',
    );
    const cmds = loadPluginCommands(makePlugin(root, { name: 'foo' }));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('foo:cmd');
  });

  it('uses : as the namespace separator for nested commands', () => {
    mkdirSync(join(root, 'commands', 'foo'), { recursive: true });
    writeFileSync(
      join(root, 'commands', 'foo', 'bar.md'),
      '---\ndescription: d\n---\nbody',
    );
    const cmds = loadPluginCommands(makePlugin(root, { name: 'plugA' }));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('plugA:foo:bar');
  });

  it('treats SKILL.md as the parent directory name and suppresses siblings', () => {
    mkdirSync(join(root, 'commands', 'foo'), { recursive: true });
    writeFileSync(
      join(root, 'commands', 'foo', 'SKILL.md'),
      '---\ndescription: d\n---\nbody',
    );
    writeFileSync(
      join(root, 'commands', 'foo', 'notes.md'),
      '---\ndescription: should be suppressed\n---\nnotes',
    );
    const cmds = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('plug:foo');
  });

  it('keeps subdirectory commands independent of sibling SKILL.md', () => {
    mkdirSync(join(root, 'commands', 'foo', 'sub'), { recursive: true });
    writeFileSync(
      join(root, 'commands', 'foo', 'SKILL.md'),
      '---\ndescription: d\n---\nbody',
    );
    writeFileSync(
      join(root, 'commands', 'foo', 'sub', 'cmd.md'),
      '---\ndescription: d\n---\nbody',
    );
    const cmds = loadPluginCommands(makePlugin(root, { name: 'plug' })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    expect(cmds.map((c) => c.name)).toEqual([
      'plug:foo',
      'plug:foo:sub:cmd',
    ]);
  });

  it('writes frontmatter.name into displayName, never identity', () => {
    mkdirSync(join(root, 'commands', 'foo'), { recursive: true });
    writeFileSync(
      join(root, 'commands', 'foo', 'bar.md'),
      '---\nname: Pretty Name\ndescription: d\n---\nbody',
    );
    const cmds = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmds[0].name).toBe('plug:foo:bar');
    expect(cmds[0].displayName).toBe('Pretty Name');
  });

  it('does not double-prefix plugin name when subdirectories collide with it', () => {
    mkdirSync(join(root, 'commands', 'plug'), { recursive: true });
    writeFileSync(
      join(root, 'commands', 'plug', 'inner.md'),
      '---\ndescription: d\n---\nbody',
    );
    const cmds = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmds[0].name).toBe('plug:plug:inner');
  });

  it('preserves namespace segments containing whitespace verbatim', () => {
    mkdirSync(join(root, 'commands', 'foo bar'), { recursive: true });
    writeFileSync(
      join(root, 'commands', 'foo bar', 'baz.md'),
      '---\ndescription: d\n---\nbody',
    );
    const cmds = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmds[0].name).toBe('plug:foo bar:baz');
  });

  it('preserves non-ASCII leaf names verbatim', () => {
    mkdirSync(join(root, 'commands', 'foo'), { recursive: true });
    writeFileSync(
      join(root, 'commands', 'foo', '中文.md'),
      '---\ndescription: d\n---\nbody',
    );
    const cmds = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('plug:foo:中文');
  });

  it('rejects empty plugin names', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\n---\nbody',
    );
    const cmds = loadPluginCommands(makePlugin(root, { name: '' }));
    expect(cmds).toHaveLength(0);
  });
});

describe('loadPluginCommands - manifest commandsMetadata', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-mf-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves manifest key verbatim', () => {
    const plugin: LoadedPlugin = {
      name: 'plug',
      manifest: { name: 'plug', version: '1.0.0' } as never,
      path: root,
      source: 'local',
      repository: 'local',
      commandsMetadata: {
        'a:b': { content: 'hello' },
      },
    } as LoadedPlugin;
    const cmds = loadPluginCommands(plugin);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('plug:a:b');
  });

  it('keeps the first-wins entry on literal duplicate keys', () => {
    // JS object literal cannot have duplicate keys, but we simulate the
    // first-wins guard by constructing one entry that matches a literal
    // computed name from a separate source.
    const plugin: LoadedPlugin = {
      name: 'plug',
      manifest: { name: 'plug', version: '1.0.0' } as never,
      path: root,
      source: 'local',
      repository: 'local',
      commandsMetadata: {
        first: { content: 'first' },
      },
    } as LoadedPlugin;
    const cmds = loadPluginCommands(plugin);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('plug:first');
    expect(cmds[0].content).toBe('first');
  });

  it('preserves manifest keys with special characters verbatim', () => {
    const plugin: LoadedPlugin = {
      name: 'plug',
      manifest: { name: 'plug', version: '1.0.0' } as never,
      path: root,
      source: 'local',
      repository: 'local',
      commandsMetadata: {
        'foo bar': { content: 'with space' },
      },
    } as LoadedPlugin;
    const cmds = loadPluginCommands(plugin);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('plug:foo bar');
  });
});

describe('loadPluginCommands - CC-aligned frontmatter parsing', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-fm-'));
    mkdirSync(join(root, 'commands'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('defaults context to inline when frontmatter omits it', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\n---\nbody',
    );
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmd.context).toBe('inline');
  });

  it('parses kebab-case allowed-tools as YAML list', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\nallowed-tools:\n  - Edit\n  - Write\n---\nbody',
    );
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmd.allowedTools).toEqual(['Edit', 'Write']);
  });

  it('parses inline-array allowed-tools', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\nallowed-tools: [Edit, Write, Bash]\n---\nbody',
    );
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmd.allowedTools).toEqual(['Edit', 'Write', 'Bash']);
  });

  it('parses comma-separated allowed-tools string', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\nallowed-tools: Edit, Write, Bash\n---\nbody',
    );
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmd.allowedTools).toEqual(['Edit', 'Write', 'Bash']);
  });

  it('parses kebab-case argument-hint and arguments list', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\nargument-hint: <ticket>\narguments:\n  - ticket\n  - assignee\n---\nbody',
    );
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmd.argumentHint).toBe('<ticket>');
    expect(cmd.argNames).toEqual(['ticket', 'assignee']);
  });

  it('parses kebab-case context: fork override', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\ncontext: fork\n---\nbody',
    );
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmd.context).toBe('fork');
  });

  it('parses disable-model-invocation and user-invocable booleans', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody',
    );
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmd.disableModelInvocation).toBe(true);
    expect(cmd.userInvocable).toBe(false);
  });

  it('parses kebab-case when-to-use', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\nwhen-to-use: when picking a thing\n---\nbody',
    );
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmd.whenToUse).toBe('when picking a thing');
  });

  it('accepts camelCase frontmatter as a fallback', () => {
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: d\nwhenToUse: explain context\ndisableModelInvocation: yes\nuserInvocable: no\n---\nbody',
    );
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'plug' }));
    expect(cmd.whenToUse).toBe('explain context');
    expect(cmd.disableModelInvocation).toBe(true);
    expect(cmd.userInvocable).toBe(false);
  });

  it('merges manifest commandsMetadata over file frontmatter while inheriting unspecified fields', () => {
    mkdirSync(join(root, 'commands'), { recursive: true });
    writeFileSync(
      join(root, 'commands', 'cmd.md'),
      '---\ndescription: from-file\nallowed-tools: [Edit]\nargument-hint: <x>\n---\nbody from file',
    );
    const plugin: LoadedPlugin = {
      name: 'plug',
      manifest: { name: 'plug', version: '1.0.0' } as never,
      path: root,
      source: 'local',
      repository: 'local',
      commandsPath: join(root, 'commands'),
      commandsMetadata: {
        cmd: {
          description: 'from-manifest',
          source: 'commands/cmd.md',
          context: 'fork',
        },
      },
    } as LoadedPlugin;
    const [cmd] = loadPluginCommands(plugin);
    expect(cmd.description).toBe('from-manifest');
    expect(cmd.context).toBe('fork');
    expect(cmd.allowedTools).toEqual(['Edit']);
    expect(cmd.argumentHint).toBe('<x>');
    expect(cmd.content).toContain('body from file');
  });
});

describe('sourcePath + loadAllPluginCommandsAsForkSkills', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-fork-skills-'));
    mkdirSync(join(root, 'commands'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('records sourcePath for file-backed commands', () => {
    const filePath = join(root, 'commands', 'cmd.md');
    writeFileSync(filePath, '---\ndescription: d\n---\nbody');
    const [cmd] = loadPluginCommands(makePlugin(root, { name: 'foo' }));
    expect(cmd.sourcePath).toBe(filePath);
  });

  it('leaves sourcePath undefined for manifest content-only commands', () => {
    const plugin: LoadedPlugin = {
      name: 'plug',
      manifest: { name: 'plug', version: '1.0.0' } as never,
      path: root,
      source: 'local',
      repository: 'local',
      commandsPath: join(root, 'commands'),
      commandsMetadata: {
        cmd: { description: 'inline', content: 'body', context: 'fork' },
      },
    } as LoadedPlugin;
    const [cmd] = loadPluginCommands(plugin);
    expect(cmd.sourcePath).toBeUndefined();
  });

  it('only emits fork-context commands and stamps kind: plugin-command', async () => {
    const { loadAllPluginCommandsAsForkSkills } = await import(
      './loadPluginCommands.js'
    );

    writeFileSync(
      join(root, 'commands', 'inline-cmd.md'),
      '---\ndescription: inline\n---\nbody',
    );
    writeFileSync(
      join(root, 'commands', 'forked-cmd.md'),
      [
        '---',
        'description: forked',
        'context: fork',
        'allowed-tools: [Edit]',
        'agent: code-reviewer',
        'effort: high',
        'argument-hint: <file>',
        'arguments: target',
        '---',
        'do ${QWEN_PLUGIN_ROOT} for $target',
      ].join('\n'),
    );

    const plugins = [makePlugin(root, { name: 'demo' })];
    const skills = loadAllPluginCommandsAsForkSkills(plugins);

    expect(skills).toHaveLength(1);
    const [skill] = skills;
    expect(skill.name).toBe('demo:forked-cmd');
    expect(skill.kind).toBe('plugin-command');
    expect(skill.context).toBe('fork');
    expect(skill.allowedTools).toEqual(['Edit']);
    expect(skill.agent).toBe('code-reviewer');
    expect(skill.effort).toBe('high');
    expect(skill.arguments).toEqual([{ name: 'target' }]);
    expect(skill.source).toBe('plugin');
    expect(skill.pluginName).toBe('demo');
    expect(skill.pluginPath).toBe(root);
    expect(skill.skillRoot).toBe(root);
    expect(skill.location).toBe(join(root, 'commands', 'forked-cmd.md'));
  });

  it('synthesizes a sensible location when the fork command is manifest-inline', async () => {
    const { loadAllPluginCommandsAsForkSkills } = await import(
      './loadPluginCommands.js'
    );
    const plugin: LoadedPlugin = {
      name: 'inline',
      manifest: { name: 'inline', version: '1.0.0' } as never,
      path: root,
      source: 'local',
      repository: 'local',
      commandsPath: join(root, 'commands'),
      commandsMetadata: {
        forked: {
          description: 'd',
          content: 'body',
          context: 'fork',
        },
      },
    } as LoadedPlugin;
    const [skill] = loadAllPluginCommandsAsForkSkills([plugin]);
    expect(skill.location).toBe(join(root, 'commands', '__inline__'));
    expect(skill.pluginPath).toBe(root);
    expect(skill.skillRoot).toBe(root);
    expect(skill.kind).toBe('plugin-command');
  });
});
