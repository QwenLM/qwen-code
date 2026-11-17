import { describe, expect, it } from 'vitest';
import { createSendArgumentCompleter } from './sendCompletion';
import { getSlashCommandCompletionResult } from './slashCompletion';

const complete = createSendArgumentCompleter({
  workspaces: [
    { value: 'web', label: 'web', cwd: '/work/web' },
    { value: 'backend', label: 'Backend', cwd: '/work/backend' },
    { value: '/work/my repo', label: 'repo', cwd: '/work/my repo' },
  ],
  currentWorkspaceCwd: '/work/web',
  resolveWorkspace: (value) =>
    ['backend', 'backend-id'].includes(value.toLowerCase())
      ? '/work/backend'
      : value,
  sessionsFor: (cwd) =>
    cwd === '/work/backend'
      ? [
          { value: 'kid-1', label: 'Docs pass' },
          { value: 'kid-2', label: 'Fix build' },
        ]
      : cwd === '/work/web'
        ? [{ value: 'own-1', label: 'Here' }]
        : undefined,
  optionDetail: (option) => `about ${option}`,
});

const applies = (line: string) =>
  complete(line)?.items.map((item) => item.apply) ?? null;

describe('send argument completion', () => {
  it('offers the options first, and nothing once the message starts', () => {
    expect(applies('/send ')).toEqual([
      '/send --workspace ',
      '/send --session-id ',
    ]);
    expect(applies('/send --s')).toEqual(['/send --session-id ']);
    expect(complete('/send check the build')).toBeNull();
    expect(complete('/send --workspace web fix it')).toBeNull();
    expect(complete('/sendx')).toBeUndefined();
    expect(complete('/send')).toBeNull();
  });

  it('offers workspaces, quoting a path with spaces', () => {
    expect(applies('/send --workspace ')).toEqual([
      '/send --workspace web ',
      '/send --workspace backend ',
      '/send --workspace "/work/my repo" ',
    ]);
    expect(applies('/send --workspace back')).toEqual([
      '/send --workspace backend ',
    ]);
  });

  it("offers the chosen workspace's sessions, or the current one's", () => {
    expect(applies('/send --workspace Backend --session-id ')).toEqual([
      '/send --workspace Backend --session-id kid-1 ',
      '/send --workspace Backend --session-id kid-2 ',
    ]);
    expect(applies('/send --workspace backend-id --session-id fix')).toEqual([
      '/send --workspace backend-id --session-id kid-2 ',
    ]);
    expect(applies('/send --workspace backend --session-id fix')).toEqual([
      '/send --workspace backend --session-id kid-2 ',
    ]);
    expect(applies('/send --session-id ')).toEqual([
      '/send --session-id own-1 ',
    ]);
    expect(
      complete('/send --workspace backend --session-id kid-1 '),
    ).toBeNull();
    expect(
      complete('/send --workspace "/work/my repo" --session-id '),
    ).toBeNull();
  });

  it('plugs into the slash menu at the right offsets', () => {
    const text = 'first line\n/send --workspace ba';
    const result = getSlashCommandCompletionResult(
      text,
      text.length,
      [],
      [],
      'en',
      (key) => key,
      undefined,
      false,
      complete,
    );
    expect(result).toMatchObject({
      from: 'first line\n'.length,
      to: text.length,
      items: [{ apply: '/send --workspace backend ' }],
    });
  });
});
