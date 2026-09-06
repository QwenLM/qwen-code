// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolveSessionDetailsCollisionBoundary } from './sessionDetailsCollisionBoundary';

describe('resolveSessionDetailsCollisionBoundary', () => {
  it('resolves the closest WebShell root', () => {
    const webShellRoot = document.createElement('div');
    webShellRoot.dataset.webShellRoot = '';
    const nestedContainer = document.createElement('div');
    const sidebar = document.createElement('aside');
    webShellRoot.append(nestedContainer);
    nestedContainer.append(sidebar);

    expect(resolveSessionDetailsCollisionBoundary(sidebar)).toBe(webShellRoot);
  });

  it('falls back to the sidebar when no WebShell root is present', () => {
    const sidebar = document.createElement('aside');

    expect(resolveSessionDetailsCollisionBoundary(sidebar)).toBe(sidebar);
    expect(resolveSessionDetailsCollisionBoundary(null)).toBeNull();
  });
});
