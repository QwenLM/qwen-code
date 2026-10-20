import { describe, expect, it, vi } from 'vitest';
import {
  createFileProvider,
  createBuiltinProviderCache,
  createComposerTagForItem,
  escapeGlobQuery,
  fileReferenceInsertText,
  fileSearchGlobPattern,
} from './useAtMentionSources';

describe('useAtMentionSources helpers', () => {
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
