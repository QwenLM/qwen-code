import { describe, expect, it } from 'vitest';
import type { TurnOutputFileChange } from './TurnOutputs';
import {
  filterWorkspaceFileChanges,
  fileChangeOwnerSessionId,
  workspaceRelativeChangePath,
  loadGitIgnoredChangePaths,
} from './workspace-file-changes';

describe('workspace file changes', () => {
  it('keeps earlier ignored verdicts when a later batch fails', async () => {
    const paths = [
      'known.log',
      ...Array.from({ length: 256 }, (_, index) => `file-${index}.ts`),
    ];
    let calls = 0;
    const ignored = await loadGitIgnoredChangePaths(paths, async () => {
      if (++calls > 1) throw new Error('offline');
      return { ignoredPaths: ['known.log'] };
    });
    expect(calls).toBe(2);
    expect([...ignored]).toEqual(['known.log']);
  });

  it('resolves a virtual child to the real parent and rejects malformed encodings', () => {
    expect(fileChangeOwnerSessionId('parent-session')).toBe('parent-session');
    expect(
      fileChangeOwnerSessionId(
        `subagent.${btoa('parent-session').replace(/=+$/, '')}.YWdlbnQ`,
      ),
    ).toBe('parent-session');
    expect(fileChangeOwnerSessionId('subagent.invalid')).toBeUndefined();
    expect(
      fileChangeOwnerSessionId(
        `subagent.${btoa('../parent').replace(/=+$/, '')}.YWdlbnQ`,
      ),
    ).toBeUndefined();
  });
  it.each([
    ['/project/src/a.ts', '/project', 'src/a.ts'],
    ['src/../a.ts', '/project', 'a.ts'],
    ['/project-other/a.ts', '/project', undefined],
    ['/project/../outside/a.ts', '/project', undefined],
    ['../outside/a.ts', '/project', undefined],
    ['/global/memory/a.md', '/project', undefined],
    ['C:\\project\\src\\a.ts', 'C:\\project', 'src/a.ts'],
    ['C:\\outside\\a.ts', 'C:\\project', undefined],
    ['C:\\project\\..\\..\\outside.ts', 'C:\\project', undefined],
    ['C:/../../outside.ts', 'C:/project', undefined],
    ['C:/project/../source.ts', 'C:/', 'source.ts'],
    ['/src/a.ts', '/', 'src/a.ts'],
    ['src/a.ts', '', undefined],
    ['~/secrets/a.ts', '/project', undefined],
    ['release:2026-11-03.md', '/project', 'release:2026-11-03.md'],
    ['~', '/project', undefined],
  ])('resolves %s inside %s', (file, cwd, expected) => {
    expect(workspaceRelativeChangePath(file, cwd)).toBe(expected);
  });

  it('excludes ignored and external changes without mutating transcript-derived inputs', () => {
    const change = (path: string): TurnOutputFileChange => ({
      path,
      status: 'created',
      toolCallId: path,
      isArtifact: false,
      diffs: [],
    });
    const changes = [
      change('/project/src/a.ts'),
      change('temporary.py'),
      change('/project/ignored.log'),
      change('/global/memory.md'),
    ];
    const input = new Map([
      ['turn', changes],
      ['noise', [change('../external')]],
    ]);
    const result = filterWorkspaceFileChanges(
      input,
      '/project',
      new Set(['ignored.log']),
    );
    expect(result.get('turn')).toEqual(changes.slice(0, 2));
    expect(result.has('noise')).toBe(false);
    expect(changes).toHaveLength(4);
  });
});
