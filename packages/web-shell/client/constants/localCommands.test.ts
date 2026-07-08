import { describe, expect, it } from 'vitest';
import type { CommandInfo } from '../adapters/types';
import { getTranslator } from '../i18n';
import { mergeCommands } from '../hooks/daemonSessionMappers';
import {
  getLocalCommands,
  localizeBuiltinDescriptions,
  skillDescriptionKey,
} from './localCommands';

const zh = getTranslator('zh-CN');
const en = getTranslator('en');

describe('getLocalCommands', () => {
  it('translates fallback command descriptions to the active language', () => {
    const byName = new Map(getLocalCommands(zh).map((c) => [c.name, c]));
    expect(byName.get('status')?.description).toBe('查看版本信息');
    expect(byName.get('help')?.description).toBe('查看帮助和可用命令');
    expect(
      getLocalCommands(en).every((c) => c.source === 'builtin-command'),
    ).toBe(true);
  });
});

describe('localizeBuiltinDescriptions (commands)', () => {
  it('re-localizes a built-in the daemon advertised in another language', () => {
    const commands: CommandInfo[] = [
      {
        name: 'bug',
        description: 'submit a bug report',
        source: 'builtin-command',
      },
    ];
    expect(localizeBuiltinDescriptions(commands, zh)[0].description).toBe(
      '提交错误报告',
    );
    expect(localizeBuiltinDescriptions(commands, en)[0].description).toBe(
      'Submit a bug report',
    );
  });

  it('leaves a custom command that shadows a built-in name untouched', () => {
    const commands: CommandInfo[] = [
      { name: 'export', description: 'my project exporter' },
    ];
    expect(localizeBuiltinDescriptions(commands, zh)[0].description).toBe(
      'my project exporter',
    );
  });

  it('does not touch built-ins that are not in the map', () => {
    const commands: CommandInfo[] = [
      {
        name: 'clear',
        description: 'Clear the screen',
        source: 'builtin-command',
      },
    ];
    expect(localizeBuiltinDescriptions(commands, zh)[0].description).toBe(
      'Clear the screen',
    );
  });

  it('does not localize skills (that happens in the skill-tagging step)', () => {
    const commands: CommandInfo[] = [
      {
        name: 'dataviz',
        description: 'Design guidance for charts…',
        source: 'bundled-skill',
      },
    ];
    expect(localizeBuiltinDescriptions(commands, zh)[0].description).toBe(
      'Design guidance for charts…',
    );
  });

  it('preserves the other command fields while replacing the description', () => {
    const commands: CommandInfo[] = [
      {
        name: 'lsp',
        description: 'Show LSP server status. Usage: /lsp [status]',
        source: 'builtin-command',
        argumentHint: '[status]',
      },
    ];
    const [out] = localizeBuiltinDescriptions(commands, zh);
    expect(out.description).toBe('显示 LSP 服务器状态');
    expect(out.argumentHint).toBe('[status]');
    expect(out.name).toBe('lsp');
  });
});

describe('skillDescriptionKey', () => {
  it('maps bundled and project skills to i18n keys', () => {
    expect(skillDescriptionKey('dataviz')).toBe('skilldesc.dataviz');
    expect(skillDescriptionKey('bugfix')).toBe('skilldesc.bugfix');
    expect(zh(skillDescriptionKey('dataviz')!)).toBe(
      '图表与数据可视化设计指南',
    );
    expect(zh(skillDescriptionKey('bugfix')!)).toBe(
      '按先复现流程修复 GitHub issue 中的 bug',
    );
  });

  it('returns undefined for an unknown (user) skill', () => {
    expect(skillDescriptionKey('my-personal-skill')).toBeUndefined();
  });
});

describe('App command pipeline', () => {
  // Mirrors App.tsx: merge -> localize commands -> tag skills (which localizes
  // known skills by name, session-independently).
  function pipeline(daemon: CommandInfo[], skills: string[]) {
    const skillNames = new Set(skills);
    return localizeBuiltinDescriptions(
      mergeCommands(daemon, getLocalCommands(zh)),
      zh,
    ).map((command) => {
      if (!skillNames.has(command.name)) return command;
      const key = skillDescriptionKey(command.name);
      return {
        ...command,
        description: key ? zh(key) : command.description || 'run',
      };
    });
  }

  it('localizes commands and both bundled + project skills, no session needed', () => {
    const daemon: CommandInfo[] = [
      {
        name: 'bug',
        description: 'submit a bug report',
        source: 'builtin-command',
      },
      {
        name: 'status',
        description: 'show version info',
        source: 'builtin-command',
      },
      // Skills advertised with NO source (welcome screen, pre-session).
      { name: 'dataviz', description: 'Design guidance for charts…' },
      { name: 'bugfix', description: 'Fix a bug from a GitHub issue…' },
      // An unknown user skill keeps its authored description.
      { name: 'my-skill', description: 'my custom skill' },
      // A plain custom command.
      { name: 'deploy', description: 'ship it', source: 'project-command' },
    ];
    const byName = new Map(
      pipeline(daemon, ['dataviz', 'bugfix', 'my-skill']).map((c) => [
        c.name,
        c.description,
      ]),
    );
    expect(byName.get('bug')).toBe('提交错误报告');
    expect(byName.get('status')).toBe('查看版本信息');
    expect(byName.get('dataviz')).toBe('图表与数据可视化设计指南'); // bundled skill
    expect(byName.get('bugfix')).toBe('按先复现流程修复 GitHub issue 中的 bug'); // project skill
    expect(byName.get('my-skill')).toBe('my custom skill'); // unknown skill untouched
    expect(byName.get('deploy')).toBe('ship it'); // custom command untouched
  });
});
