import { describe, expect, it, vi } from 'vitest';
import {
  createFileProvider,
  createBuiltinProviderCache,
  createComposerTagForItem,
  createMcpResourcesProvider,
  escapeGlobQuery,
  fileReferenceInsertText,
  fileSearchGlobPattern,
  type AtMentionWorkspaceActions,
} from './useAtMentionSources';

function globProvider(
  globWorkspace: AtMentionWorkspaceActions['globWorkspace'],
) {
  const cache = createBuiltinProviderCache();
  return createFileProvider(
    () => ({ globWorkspace }),
    () => '.',
    () => cache,
    'Files',
    '',
    () => null,
  );
}

describe('useAtMentionSources helpers', () => {
  it('restarts an aborted glob lookup without losing its replacement cache', async () => {
    const firstRequest =
      Promise.withResolvers<
        Awaited<
          ReturnType<NonNullable<AtMentionWorkspaceActions['globWorkspace']>>
        >
      >();
    const globWorkspace = vi
      .fn<NonNullable<AtMentionWorkspaceActions['globWorkspace']>>()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValue({ matches: ['package.json'] });
    const provider = globProvider(globWorkspace);
    const first = new AbortController();
    const second = new AbortController();
    const stale = provider.search({ query: 'pack', signal: first.signal });
    first.abort();
    const current = provider.search({ query: 'pack', signal: second.signal });
    const settled = Promise.allSettled([stale, current]);

    firstRequest.reject(new DOMException('Aborted', 'AbortError'));
    expect(await settled).toMatchObject([
      { status: 'rejected', reason: { name: 'AbortError' } },
      { status: 'fulfilled', value: [{ label: 'package.json' }] },
    ]);
    second.abort();
    expect(
      await provider.search({
        query: 'pack',
        signal: new AbortController().signal,
      }),
    ).toMatchObject([{ label: 'package.json' }]);
    expect(globWorkspace).toHaveBeenCalledTimes(2);
  });

  it('keeps completed glob results cached after their query is aborted', async () => {
    const globWorkspace = vi
      .fn()
      .mockResolvedValue({ matches: ['package.json'] });
    const provider = globProvider(globWorkspace);
    const first = new AbortController();
    expect(
      await provider.search({ query: 'pack', signal: first.signal }),
    ).toMatchObject([{ label: 'package.json' }]);
    first.abort();
    expect(
      await provider.search({
        query: 'pack',
        signal: new AbortController().signal,
      }),
    ).toMatchObject([{ label: 'package.json' }]);
    expect(globWorkspace).toHaveBeenCalledTimes(1);
  });
  it('keeps MCP servers referenceable without a resource-reading action', async () => {
    const loadMcpStatus = vi.fn().mockResolvedValue({
      servers: [
        {
          kind: 'mcp_server',
          name: 'docs team',
          disabled: false,
          resourceCount: 2,
          description: 'Catalog snapshot: partial tools, stale resources',
        },
      ],
    });
    const cache = createBuiltinProviderCache();
    const resources = vi.fn();
    let readResources = false;
    const provider = createMcpResourcesProvider(
      () => ({
        loadMcpStatus,
        ...(readResources ? { loadMcpResources: resources } : {}),
      }),
      () => cache,
      'MCP',
      '',
      (count) => `${count} resources`,
    );
    const request = { query: '', signal: new AbortController().signal };
    expect(await provider.search(request)).toMatchObject([
      {
        kind: 'insert',
        insertText: '@mcp:docs\\ team ',
        description: 'Catalog snapshot: partial tools, stale resources',
      },
    ]);
    readResources = true;
    expect(await provider.search(request)).toMatchObject([
      {
        kind: 'mcp-server',
        serverName: 'docs team',
        description: '2 resources',
      },
    ]);
    expect(resources).not.toHaveBeenCalled();
  });

  it('escapes glob metacharacters and folds letters into case-insensitive classes', () => {
    expect(escapeGlobQuery('a*b?')).toBe('[aA]\\*[bB]\\?');
    expect(escapeGlobQuery('')).toBe('');
  });

  it('builds a **/*<escaped>* pattern and strips a leading ./', () => {
    expect(fileSearchGlobPattern('')).toBe('**/*');
    expect(fileSearchGlobPattern('./src/foo')).toBe(
      '**/*[sS][rR][cC]/[fF][oO][oO]*',
    );
  });

  it('produces an @-prefixed, trailing-space file reference insert', () => {
    expect(fileReferenceInsertText('a/b c.txt')).toBe('@a/b\\ c.txt ');
  });
  it('keeps Managed file-only actions scoped and preserves unsanitized paths in selection metadata', async () => {
    const actions = {
      filesOnly: true,
      listDirectory: vi.fn(async () => ({
        kind: 'list' as const,
        path: '.',
        entries: [{ name: 'a  b.ts', kind: 'file' as const, ignored: false }],
        truncated: false,
      })),
      searchWorkspaceFiles: vi.fn(async () => ['nested/a  b.ts']),
    };
    const cache = createBuiltinProviderCache();
    const provider = createFileProvider(
      () => actions,
      () => '.',
      () => cache,
      'files',
      'files',
      () => null,
      true,
    );
    const signal = new AbortController().signal;
    const listing = await provider.search({ query: '', signal });
    expect(listing).toHaveLength(1);
    expect(
      createComposerTagForItem('files', listing[0]!, listing[0]!.insertText!),
    ).toMatchObject({ metadata: { filePath: 'a  b.ts', fileKind: 'file' } });
    const results = await provider.search({ query: 'a  b', signal });
    expect(actions.searchWorkspaceFiles).toHaveBeenCalledWith('a  b', signal);
    expect(results[0]).toMatchObject({ targetPath: 'nested/a  b.ts' });
  });
});
