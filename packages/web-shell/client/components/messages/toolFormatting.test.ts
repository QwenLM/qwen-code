import { describe, expect, it } from 'vitest';
import type { ACPToolCall } from '../../adapters/types';
import {
  formatToolDisplayName,
  getToolDescription,
  getToolResultSummary,
} from './toolFormatting';

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
});
