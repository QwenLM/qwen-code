import { describe, expect, it } from 'vitest';
import { isSidebarToggleShortcut } from './sidebarToggleShortcut';

const key = (
  overrides: Partial<Parameters<typeof isSidebarToggleShortcut>[0]>,
) => ({
  key: 'b',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe('isSidebarToggleShortcut', () => {
  it('matches Cmd+B and Ctrl+B, including uppercase', () => {
    expect(isSidebarToggleShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSidebarToggleShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isSidebarToggleShortcut(key({ ctrlKey: true, key: 'B' }))).toBe(
      true,
    );
  });

  it('ignores a bare B keypress (typing in the composer)', () => {
    expect(isSidebarToggleShortcut(key({}))).toBe(false);
  });

  it('ignores other keys with the modifier held', () => {
    expect(isSidebarToggleShortcut(key({ metaKey: true, key: 'k' }))).toBe(
      false,
    );
  });

  it('leaves Shift/Alt variants to the browser and other bindings', () => {
    expect(
      isSidebarToggleShortcut(key({ metaKey: true, shiftKey: true })),
    ).toBe(false);
    expect(isSidebarToggleShortcut(key({ ctrlKey: true, altKey: true }))).toBe(
      false,
    );
  });

  it('rejects the ambiguous Cmd+Ctrl combination', () => {
    expect(isSidebarToggleShortcut(key({ metaKey: true, ctrlKey: true }))).toBe(
      false,
    );
  });
});
