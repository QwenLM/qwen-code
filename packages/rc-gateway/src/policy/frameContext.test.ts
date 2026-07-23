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
