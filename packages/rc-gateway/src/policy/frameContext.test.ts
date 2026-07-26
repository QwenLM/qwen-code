import { describe, it, expect } from 'vitest';
import { frameToContext } from './frameContext.js';

/** A REAL permission_request `data` payload (ACP toolCall shape). */
function frame(kind: string, rawInput: Record<string, unknown>) {
  return {
    requestId: 'q1',
    sessionId: 's1',
    toolCall: { toolCallId: 'tc1', title: 'humanized text', kind, rawInput },
    options: [{ optionId: 'ok', kind: 'allow_once' }],
  };
}

describe('frameToContext', () => {
  it('uses the ACP kind as tool and rawInput as args (never the toolCall)', () => {
    const ctx = frameToContext(frame('execute', { command: 'npm test' }), {
      projectRoot: '/proj',
    });
    expect(ctx.tool).toBe('execute');
    expect(ctx.args).toEqual({ command: 'npm test' });
  });

  it('collects path candidates from real parameter keys', () => {
    const ctx = frameToContext(
      frame('edit', { file_path: 'src/a.ts', content: 'x' }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths).toContain('src/a.ts');
  });

  it('collects notebook_path, absolute_path, path, cwd and files[]', () => {
    const ctx = frameToContext(
      frame('edit', {
        notebook_path: 'nb.ipynb',
        absolute_path: '/abs/x',
        path: 'p',
        cwd: '/c',
        files: ['f1', 'f2', 7],
      }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths).toEqual(
      expect.arrayContaining(['nb.ipynb', '/abs/x', 'p', '/c', 'f1', 'f2']),
    );
    expect(ctx.paths).not.toContain(7 as unknown as string);
  });

  it('derives operations from the kind', () => {
    expect(
      frameToContext(frame('read', {}), { projectRoot: '/p' }).operations,
    ).toEqual(['read']);
    expect(
      frameToContext(frame('search', {}), { projectRoot: '/p' }).operations,
    ).toEqual(['read']);
    expect(
      frameToContext(frame('edit', {}), { projectRoot: '/p' }).operations,
    ).toEqual(['write']);
    expect(
      frameToContext(frame('fetch', {}), { projectRoot: '/p' }).operations,
    ).toEqual(['read']);
    expect(
      frameToContext(frame('other', {}), { projectRoot: '/p' }).operations,
    ).toEqual([]);
  });

  it('resolves cwd from the call, falling back to projectRoot', () => {
    expect(
      frameToContext(frame('execute', { command: 'ls', directory: '/d' }), {
        projectRoot: '/proj',
      }).cwd,
    ).toBe('/d');
    expect(
      frameToContext(frame('execute', { command: 'ls' }), {
        projectRoot: '/proj',
      }).cwd,
    ).toBe('/proj');
  });

  it('is fail-closed on malformed frames', () => {
    const ctx = frameToContext(
      { toolCall: 'not-an-object' },
      {
        projectRoot: '/proj',
      },
    );
    expect(ctx.tool).toBe('');
    expect(ctx.args).toEqual({});
    expect(ctx.paths).toEqual([]);
    expect(ctx.operations).toEqual([]);
  });

  it('passes through originScope/sessionTag but never invents them', () => {
    const ctx = frameToContext(frame('read', {}), { projectRoot: '/p' });
    expect(ctx.originScope).toBeUndefined();
    expect(ctx.sessionTag).toBeUndefined();
  });
});

describe('frameToContext — shell enrichment', () => {
  it('adds paths a shell command reads', () => {
    const ctx = frameToContext(frame('execute', { command: 'cat .env' }), {
      projectRoot: '/proj',
    });
    expect(ctx.paths.some((p) => p.endsWith('.env'))).toBe(true);
    expect(ctx.operations).toContain('read');
    expect(ctx.operations).toContain('execute');
  });

  it('splits compound commands and collects every part', () => {
    const ctx = frameToContext(
      frame('execute', { command: 'npm test && cat secrets.txt' }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths.some((p) => p.endsWith('secrets.txt'))).toBe(true);
  });

  it('marks a shell write as a write operation', () => {
    const ctx = frameToContext(
      frame('execute', { command: 'echo hi > out.txt' }),
      { projectRoot: '/proj' },
    );
    expect(ctx.operations).toContain('write');
  });

  it('never throws on an unparseable command (contributes nothing)', () => {
    const ctx = frameToContext(frame('execute', { command: '((((' }), {
      projectRoot: '/proj',
    });
    expect(ctx.tool).toBe('execute');
    expect(ctx.operations).toContain('execute');
  });

  it('does not run shell extraction for non-execute kinds', () => {
    const ctx = frameToContext(
      frame('edit', { file_path: 'a.ts', content: 'cat .env' }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths).toEqual(['a.ts']);
  });

  // Regression: a `cd` in an earlier subcommand must carry forward to the
  // ones that follow. Before the fix, every split subcommand was resolved
  // against the SAME static `directory`, so `cd config && cat
  // secrets/creds.txt` produced `/proj/secrets/creds.txt` as a candidate —
  // never the real path bash touches, `/proj/config/secrets/creds.txt` —
  // which let a `pathGlob:'config/secrets/**'` deny rule silently miss it.
  it('tracks a `cd` across compound subcommands so later relative paths resolve against the post-cd directory', () => {
    const ctx = frameToContext(
      frame('execute', {
        command: 'cd config && cat secrets/creds.txt',
        directory: '/proj',
      }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths).toContain('/proj/config/secrets/creds.txt');
  });

  // Control: a recursive glob pattern matches the file regardless of which
  // directory it resolves under, so this case passes both before and after
  // the fix. It proves the fix doesn't need to hold for this case to matter,
  // and that the cd-tracking change doesn't regress the simple case.
  it('control: `cd sub && cat .env` still yields a path matching **/.env*', () => {
    const ctx = frameToContext(
      frame('execute', {
        command: 'cd sub && cat .env',
        directory: '/proj',
      }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths).toContain('/proj/sub/.env');
    expect(ctx.paths.some((p) => p.endsWith('.env'))).toBe(true);
  });

  // Monotonicity guard: when the `cd` target can't be statically resolved
  // (a shell variable here), the running cwd becomes a best-effort guess
  // rather than the real post-cd directory. The fix must still keep the
  // ORIGINAL static-cwd candidate around so a deny rule that already
  // matched pre-fix (anchored on the static cwd) keeps matching — the
  // enrichment must only ever ADD candidates, never drop one silently.
  it('keeps the static-cwd candidate when the cd target is not statically resolvable (e.g. a shell variable)', () => {
    const ctx = frameToContext(
      frame('execute', {
        command: 'cd $DIR && cat secrets/creds.txt',
        directory: '/proj',
      }),
      { projectRoot: '/proj' },
    );
    expect(ctx.paths).toContain('/proj/secrets/creds.txt');
  });
});
