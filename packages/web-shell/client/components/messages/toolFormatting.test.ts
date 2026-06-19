import { describe, expect, it } from 'vitest';
import type { ACPToolCall } from '../../adapters/types';
import {
  formatToolDisplayName,
  getAgentCurrentToolHint,
  getToolDescription,
  getToolResultSummary,
  localizeToolDisplayName,
  TOOL_DISPLAY_NAMES,
} from './toolFormatting';
import { getTranslator } from '../../i18n';

function tool(overrides: Partial<ACPToolCall>): ACPToolCall {
  return {
    callId: 'call-1',
    toolName: 'read_file',
    status: 'completed',
    ...overrides,
  };
}

describe('toolFormatting', () => {
  it('matches CLI-style user shell command display names', () => {
    expect(formatToolDisplayName('shell')).toBe('Shell Command');
    expect(formatToolDisplayName('run_shell_command')).toBe('Shell');
  });

  it('does not show the cwd for user shell commands', () => {
    expect(
      getToolDescription(
        tool({
          toolName: 'shell',
          args: { command: 'pwd', directory: '/workspace/project' },
        }),
        '/workspace/project',
      ),
    ).toBe('pwd');
  });

  it('uses the daemon title description when present', () => {
    expect(
      getToolDescription(
        tool({
          title: 'ReadFile: README.md',
          args: { file_path: '/workspace/project/README.md' },
        }),
        '/workspace/project',
      ),
    ).toBe('README.md');
  });

  it('normalizes absolute paths from daemon title descriptions', () => {
    expect(
      getToolDescription(
        tool({
          title: 'ReadFile  /workspace/project/README.md',
          args: { file_path: '/workspace/project/README.md' },
        }),
        '/workspace/project',
      ),
    ).toBe('README.md');
  });

  it('falls back to a workspace-relative file path', () => {
    expect(
      getToolDescription(
        tool({ args: { file_path: '/workspace/project/src/index.ts' } }),
        '/workspace/project',
      ),
    ).toBe('src/index.ts');
  });

  it('falls back to the basename when workspace cwd does not match', () => {
    expect(
      getToolDescription(
        tool({
          args: {
            file_path:
              '/Users/ytahdn/Documents/Codes/alishu/qwen-code/README.md',
          },
        }),
        '/Users/ytahdn/Documents/Codes/qwen/qwen-code',
      ),
    ).toBe('README.md');
  });

  it('normalizes absolute paths embedded in title descriptions', () => {
    expect(
      getToolDescription(
        tool({
          title: 'WriteFile: Writing to /workspace/project/src/index.ts',
          toolName: 'write_file',
        }),
        '/workspace/project',
      ),
    ).toBe('Writing to src/index.ts');
  });

  it('matches CLI-style grep fallback descriptions', () => {
    expect(
      getToolDescription(
        tool({
          toolName: 'grep_search',
          args: {
            pattern: 'TODO',
            path: '/workspace/project/src',
            glob: '*.ts',
          },
        }),
        '/workspace/project',
      ),
    ).toBe("'TODO' in path '/workspace/project/src' (filter: '*.ts')");
  });

  it('matches CLI-style glob fallback descriptions', () => {
    expect(
      getToolDescription(
        tool({
          toolName: 'glob',
          args: { pattern: '**/*.ts', path: '/Users/ytahdn/.qwen' },
        }),
        '/workspace/project',
      ),
    ).toBe("'**/*.ts' in path '/Users/ytahdn/.qwen'");
  });

  it('matches CLI-style glob result summaries', () => {
    expect(
      getToolResultSummary(
        tool({
          toolName: 'glob',
          rawOutput: '/Users/ytahdn/.qwen/settings.json\n',
        }),
      ),
    ).toBe('Found 1 matching file(s)');
  });

  it('matches CLI-style grep_search result summaries', () => {
    expect(
      getToolResultSummary(
        tool({
          toolName: 'grep_search',
          rawOutput: 'src/a.ts:1:TODO\nsrc/b.ts:2:TODO\n',
        }),
      ),
    ).toBe('2 result(s)');
  });

  it('keeps grep_search returnDisplay summaries unchanged', () => {
    expect(
      getToolResultSummary(
        tool({
          toolName: 'grep_search',
          rawOutput: 'Found 2 matches',
        }),
      ),
    ).toBe('Found 2 matches');

    expect(
      getToolResultSummary(
        tool({
          toolName: 'grep_search',
          rawOutput: 'Found 1 match',
        }),
      ),
    ).toBe('Found 1 match');
  });

  it('keeps truncated grep_search returnDisplay summaries unchanged', () => {
    expect(
      getToolResultSummary(
        tool({
          toolName: 'grep_search',
          rawOutput: 'Found 12 matches (truncated)',
        }),
      ),
    ).toBe('Found 12 matches (truncated)');
  });

  it('keeps empty grep_search returnDisplay summaries unchanged', () => {
    expect(
      getToolResultSummary(
        tool({
          toolName: 'grep_search',
          rawOutput: 'No matches found',
        }),
      ),
    ).toBe('No matches found');
  });

  it('prefers grep_search returnDisplay when content is also present', () => {
    expect(
      getToolResultSummary(
        tool({
          toolName: 'grep_search',
          rawOutput: 'Found 2 matches',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'Found 2 matches for pattern "TODO" in path "./":\n---\nsrc/a.ts:1:TODO\nsrc/b.ts:2:TODO',
              },
            },
          ],
        }),
      ),
    ).toBe('Found 2 matches');
  });

  it('prefers empty grep_search returnDisplay when content is also present', () => {
    expect(
      getToolResultSummary(
        tool({
          toolName: 'grep_search',
          rawOutput: 'No matches found',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'No matches found for pattern "TODO" in path "./".',
              },
            },
          ],
        }),
      ),
    ).toBe('No matches found');
  });

  it('matches CLI-style shell fallback descriptions', () => {
    expect(
      getToolDescription(
        tool({
          toolName: 'run_shell_command',
          args: {
            command: 'npm test',
            directory: '/workspace/project/packages/web-shell',
            timeout: 1000,
          },
        }),
        '/workspace/project',
      ),
    ).toBe('npm test [in packages/web-shell] [timeout: 1000ms]');
  });

  it('includes shell descriptions in fallback descriptions', () => {
    expect(
      getToolDescription(
        tool({
          toolName: 'run_shell_command',
          args: {
            command: 'cat ~/.qwen/settings.json',
            description: '查看 ~/.qwen/settings.json 文件内容',
          },
        }),
      ),
    ).toBe('cat ~/.qwen/settings.json (查看 ~/.qwen/settings.json 文件内容)');
  });

  it('summarizes read_file rawOutput by line count', () => {
    expect(
      getToolResultSummary(
        tool({
          rawOutput: '# Title\n\nBody',
        }),
      ),
    ).toBe('3 line(s)');
  });

  it('keeps long shell commands in full instead of capping at one line', () => {
    const command = `echo ${'a'.repeat(200)}`;
    expect(
      getToolDescription(
        tool({ toolName: 'run_shell_command', args: { command } }),
      ),
    ).toBe(command);
  });

  it('still bounds a pathologically long description', () => {
    const result = getToolDescription(
      tool({
        toolName: 'run_shell_command',
        args: { command: 'x'.repeat(5000) },
      }),
    );
    expect(result.length).toBeLessThan(5000);
    expect(result.endsWith('...')).toBe(true);
  });

  describe('localizeToolDisplayName', () => {
    it('translates known tool names in Chinese', () => {
      const t = getTranslator('zh-CN');
      expect(localizeToolDisplayName('todo_write', t)).toBe('任务清单');
      expect(localizeToolDisplayName('run_shell_command', t)).toBe('运行命令');
      expect(localizeToolDisplayName('read_file', t)).toBe('读取文件');
    });

    it('keeps proper tool names / acronyms in English', () => {
      const t = getTranslator('zh-CN');
      expect(localizeToolDisplayName('agent', t)).toBe('Agent');
      expect(localizeToolDisplayName('grep_search', t)).toBe('Grep');
      expect(localizeToolDisplayName('glob', t)).toBe('Glob');
      expect(localizeToolDisplayName('lsp', t)).toBe('LSP');
    });

    it('falls back to the English display name when the locale has no entry', () => {
      const t = getTranslator('en');
      expect(localizeToolDisplayName('todo_write', t)).toBe('TodoList');
      expect(localizeToolDisplayName('grep_search', t)).toBe('Grep');
    });

    it('falls back to the raw wire name for unknown tools', () => {
      expect(
        localizeToolDisplayName('mystery_tool', getTranslator('zh-CN')),
      ).toBe('mystery_tool');
    });

    it('has a zh translation for every tool in the display-name map', () => {
      const tZh = getTranslator('zh-CN');
      // Tools intentionally shown in English (proper names / acronyms).
      const keepEnglish = new Set(['agent', 'grep_search', 'glob', 'search']);
      const untranslated = Object.keys(TOOL_DISPLAY_NAMES).filter(
        (wire) =>
          !keepEnglish.has(wire) &&
          localizeToolDisplayName(wire, tZh) === formatToolDisplayName(wire),
      );
      expect(untranslated).toEqual([]);
    });

    it('localizes the tool name in the agent activity hint', () => {
      const agent = tool({
        toolName: 'agent',
        status: 'in_progress',
        subTools: [
          tool({ toolName: 'run_shell_command', status: 'in_progress' }),
        ],
      });
      expect(getAgentCurrentToolHint(agent, getTranslator('zh-CN'))).toContain(
        '运行命令',
      );
      expect(getAgentCurrentToolHint(agent, getTranslator('en'))).toContain(
        'Shell',
      );
    });
  });
});
