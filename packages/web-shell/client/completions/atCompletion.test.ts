import { describe, expect, it, vi } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import {
  atCompletionSource,
  type ExtensionCompletionEntry,
  type GlobFn,
  type McpServerCompletionEntry,
} from './atCompletion';

const extensions: ExtensionCompletionEntry[] = [
  {
    name: 'browser',
    displayName: 'Browser',
    description: 'Browser automation',
    isActive: true,
  },
  {
    name: 'review-tools',
    displayName: 'Review Tools',
    description: 'Review code',
    isActive: true,
  },
  {
    name: 'inactive',
    displayName: 'Inactive',
    isActive: false,
  },
];

const mcpServers: McpServerCompletionEntry[] = [
  {
    name: 'dataworks',
    description: 'DataWorks MCP',
  },
  {
    name: 'clickhouse',
    description: 'ClickHouse MCP',
  },
];

function context(doc: string): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), doc.length, true);
}

describe('atCompletionSource', () => {
  it('shows active extensions and files for bare @', async () => {
    const glob = vi.fn<GlobFn>().mockResolvedValue({
      matches: ['README.md', 'src/index.ts'],
    });

    const result = await atCompletionSource(
      context('@'),
      () => glob,
      () => async () => ({ extensions }),
      () => async () => ({ servers: mcpServers }),
    );

    expect(result?.from).toBe(0);
    expect(result?.options.map((option) => option.label)).toEqual([
      '@ext:browser',
      '@ext:review-tools',
      '@README.md',
      '@src/index.ts',
      '@mcp:clickhouse',
      '@mcp:dataworks',
    ]);
    expect(glob).toHaveBeenCalledWith('**/*', { maxResults: 50 });
  });

  it('filters extensions, MCP servers, and files by partial input', async () => {
    const glob = vi.fn<GlobFn>().mockResolvedValue({
      matches: ['browser-test.ts'],
    });

    const result = await atCompletionSource(
      context('@bro'),
      () => glob,
      () => async () => ({ extensions }),
      () => async () => ({
        servers: [
          ...mcpServers,
          { name: 'browser-mcp', description: 'Browser MCP' },
        ],
      }),
    );

    expect(result?.options.map((option) => option.label)).toEqual([
      '@ext:browser',
      '@browser-test.ts',
      '@mcp:browser-mcp',
    ]);
    expect(glob).toHaveBeenCalledWith('bro*', { maxResults: 50 });
  });

  it('shows only extensions for @ext: completion', async () => {
    const glob = vi.fn<GlobFn>().mockResolvedValue({
      matches: ['ext:file.ts'],
    });

    const result = await atCompletionSource(
      context('@ext:rev'),
      () => glob,
      () => async () => ({ extensions }),
    );

    expect(result?.options.map((option) => option.label)).toEqual([
      '@ext:review-tools',
    ]);
    expect(result?.options[0]?.apply).toBe('@ext:review-tools ');
    expect(glob).not.toHaveBeenCalled();
  });

  it('returns file completions when extension status fails', async () => {
    const glob = vi.fn<GlobFn>().mockResolvedValue({
      matches: ['README.md'],
    });

    const result = await atCompletionSource(
      context('@'),
      () => glob,
      () => async () => {
        throw new Error('boom');
      },
    );

    expect(result?.options.map((option) => option.label)).toEqual([
      '@README.md',
    ]);
  });
});
