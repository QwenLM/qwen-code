import { describe, expect, it } from 'vitest';
import {
  isModelCommandSnapshotReady,
  isModelSetupCommand,
  resolveModelManagement,
} from './modelManagement';

describe('model management policy', () => {
  it('defaults omitted and empty options to allowing both actions', () => {
    expect(resolveModelManagement()).toEqual({
      allowAdd: true,
      allowDelete: true,
    });
    expect(resolveModelManagement({})).toEqual(resolveModelManagement());
    expect(resolveModelManagement({ allowAdd: false })).toEqual({
      allowAdd: false,
      allowDelete: true,
    });
    expect(resolveModelManagement({ allowDelete: false })).toEqual({
      allowAdd: true,
      allowDelete: false,
    });
  });
  it.each([
    '/auth',
    '/auth custom',
    '/auth\ncustom',
    // The daemon resolves these to /auth: its altNames, and whitespace it
    // tolerates between the slash and the token.
    '/login',
    '/connect',
    '/ auth',
    '/\tauth',
  ])('recognizes setup command %s', (text) => {
    expect(isModelSetupCommand(text)).toBe(true);
  });
  it.each([
    '/authenticate',
    '/auth/path',
    'explain /auth',
    '/model',
    '/delete',
    // The daemon resolves names case-sensitively, so this reaches it as
    // prose; folding case would discard ordinary text under a policy toast.
    ' /AUTH ',
  ])('preserves non-setup input %s', (text) => {
    expect(isModelSetupCommand(text)).toBe(false);
  });

  const builtinAuth = {
    name: 'auth',
    source: 'builtin-command',
    altNames: ['connect', 'login'],
  };

  it.each(['/auth', '/login', '/connect', '/ auth'])(
    'blocks %s when the snapshot resolves it to the builtin auth command',
    (text) => {
      expect(isModelSetupCommand(text, [builtinAuth])).toBe(true);
    },
  );
  it('keeps a host/project command shadowing a setup name runnable', () => {
    const commands = [
      builtinAuth,
      { name: 'login', source: 'project' },
      { name: 'connect', source: 'user' },
    ];
    expect(isModelSetupCommand('/login staging', commands)).toBe(false);
    expect(isModelSetupCommand('/connect', commands)).toBe(false);
    expect(isModelSetupCommand('/auth', commands)).toBe(true);
  });
  it('keeps a project command named auth runnable when it replaces the builtin', () => {
    const commands = [
      { name: 'clear', source: 'builtin-command' },
      { name: 'auth', source: 'project' },
    ];
    expect(isModelSetupCommand('/auth acme', commands)).toBe(false);
  });
  it('treats a snapshot without builtin entries as still loading', () => {
    expect(
      isModelSetupCommand('/auth', [{ name: 'auth', source: 'project' }]),
    ).toBe(true);
    expect(isModelSetupCommand('/auth', [])).toBe(true);
  });
});

it('recognizes only builtin-marked command snapshots as ready', () => {
  expect(isModelCommandSnapshotReady()).toBe(false);
  expect(isModelCommandSnapshotReady([])).toBe(false);
  expect(
    isModelCommandSnapshotReady([{ name: 'auth', source: 'project' }]),
  ).toBe(false);
  expect(
    isModelCommandSnapshotReady([
      { name: 'clear', source: 'builtin-command' },
      { name: 'auth', source: 'project' },
    ]),
  ).toBe(true);
});
