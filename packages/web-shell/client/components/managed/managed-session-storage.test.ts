// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  getManagedClientId,
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
});
