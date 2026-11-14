// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  getManagedClientId,
  hasManagedLocalTarget,
  managedSelectionFromRoute,
  managedSelectionFromUrl,
  saveManagedSelection,
} from './managed-session-storage';

describe('Managed session browser identity', () => {
  it('persists stable correlation per daemon and normalizes trailing slashes', () => {
    const id = getManagedClientId('http://one');
    expect(getManagedClientId('http://one/')).toBe(id);
    expect(getManagedClientId('http://two')).not.toBe(id);
    expect(localStorage.getItem('qwen-managed-client:http://one')).toBe(id);
  });

  it('restores only the Managed selection and preserves unrelated URL fields', () => {
    window.history.replaceState(
      { host: true },
      '',
      '/session/runtime?workspace=w&host=x',
    );
    saveManagedSelection(true, 'gateway-id');
    expect(managedSelectionFromUrl()).toEqual({
      open: true,
      sessionId: 'gateway-id',
    });
    expect(window.location.pathname).toBe('/session/runtime');
    expect(new URLSearchParams(window.location.search).get('host')).toBe('x');
    expect(window.history.state).toEqual({ host: true });
    saveManagedSelection(false);
    expect(managedSelectionFromUrl()).toEqual({
      open: false,
      sessionId: undefined,
    });
    expect(new URLSearchParams(window.location.search).get('workspace')).toBe(
      'w',
    );
  });

  it('defaults a configured home to Managed but preserves an explicit Local selection and its history target', () => {
    window.history.replaceState(null, '', '/?managedProvider=java&tenant=a');
    expect(managedSelectionFromUrl(true).open).toBe(true);
    expect(managedSelectionFromUrl().open).toBe(false);
    saveManagedSelection(false, 'managed-history');
    expect(managedSelectionFromUrl(true)).toEqual({
      open: false,
      sessionId: 'managed-history',
    });
    expect(new URLSearchParams(window.location.search).get('managed')).toBe(
      '0',
    );
    expect(new URLSearchParams(window.location.search).get('tenant')).toBe('a');
    saveManagedSelection(true, 'managed-history');
    expect(managedSelectionFromUrl()).toEqual({
      open: true,
      sessionId: 'managed-history',
    });
  });
});

describe('managedSelectionFromRoute', () => {
  it('opens the managed view for a chat route without a session target', () => {
    window.history.replaceState(null, '', '/');
    expect(managedSelectionFromRoute({ page: 'chat' })).toEqual({
      open: true,
      sessionId: undefined,
    });
    expect(managedSelectionFromRoute({ page: 'settings' })).toEqual({
      open: true,
      sessionId: undefined,
    });
  });

  it('keeps the daemon view for a chat route with an explicit session', () => {
    window.history.replaceState(null, '', '/session/s1');
    expect(
      managedSelectionFromRoute({ page: 'chat', sessionId: 's1' }),
    ).toEqual({ open: false, sessionId: undefined });
  });

  it('classifies a route-less host by its own local target', () => {
    window.history.replaceState(null, '', '/');
    // No route and no local target: the host defaults to the managed home.
    expect(managedSelectionFromRoute(undefined, false)).toEqual({
      open: true,
      sessionId: undefined,
    });
    // An explicit local target keeps the daemon view even without a route.
    expect(managedSelectionFromRoute(undefined, true)).toEqual({
      open: false,
      sessionId: undefined,
    });
  });
});

describe('hasManagedLocalTarget', () => {
  it('treats any explicit session, workspace, or context as a local target', () => {
    expect(hasManagedLocalTarget({})).toBe(false);
    expect(hasManagedLocalTarget({ sessionId: 's1' })).toBe(true);
    expect(hasManagedLocalTarget({ workspaceId: 'ws-a' })).toBe(true);
    expect(hasManagedLocalTarget({ workspaceCwd: '/work/a' })).toBe(true);
    expect(
      hasManagedLocalTarget({ sessionContext: { kind: 'standalone' } }),
    ).toBe(true);
  });
});
