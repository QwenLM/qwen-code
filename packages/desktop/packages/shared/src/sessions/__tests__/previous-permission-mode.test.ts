import { describe, expect, it } from 'bun:test';
import { SESSION_PERSISTENT_FIELDS } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: previousPermissionMode', () => {
  it('does not include approval-mode fields in SESSION_PERSISTENT_FIELDS', () => {
    expect(SESSION_PERSISTENT_FIELDS).not.toContain('permissionMode');
    expect(SESSION_PERSISTENT_FIELDS).not.toContain('previousPermissionMode');
  });

  it('pickSessionFields omits approval-mode fields when present', () => {
    const source = {
      id: 's1',
      workspaceRootPath: '/tmp/ws',
      permissionMode: 'allow-all',
      previousPermissionMode: 'safe',
      createdAt: 1,
      lastUsedAt: 2,
      ignoredRuntimeField: 'nope',
    } as const;

    const picked = pickSessionFields(source);
    expect(picked.permissionMode).toBeUndefined();
    expect(picked.previousPermissionMode).toBeUndefined();
    expect((picked as Record<string, unknown>).ignoredRuntimeField).toBeUndefined();
  });
});
