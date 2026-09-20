import { describe, expect, it } from 'vitest';
import { isModelSetupCommand, resolveModelManagement } from './modelManagement';

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
  it.each(['/auth', ' /AUTH ', '/auth custom', '/auth\ncustom'])(
    'recognizes setup command %s',
    (text) => {
      expect(isModelSetupCommand(text)).toBe(true);
    },
  );
  it.each([
    '/authenticate',
    '/auth/path',
    'explain /auth',
    '/model',
    '/delete',
  ])('preserves non-setup input %s', (text) => {
    expect(isModelSetupCommand(text)).toBe(false);
  });
});
