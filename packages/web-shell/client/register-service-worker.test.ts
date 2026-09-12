// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './register-service-worker';

describe('standalone service worker registration', () => {
  const register = vi.fn().mockResolvedValue({});

  beforeEach(() => {
    vi.stubEnv('PROD', true);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { serviceWorker: { register } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    register.mockReset().mockResolvedValue({});
  });

  it('uses a stable root URL and bypasses the HTTP cache for updates', () => {
    window.history.replaceState(
      {},
      '',
      '/session/test?workspace=test#token=secret',
    );
    registerServiceWorker();
    expect(register).toHaveBeenCalledExactlyOnceWith('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  });

  it('does not register during development', () => {
    vi.stubEnv('PROD', false);
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
  });

  it('does not register on insecure origins', () => {
    vi.stubGlobal('isSecureContext', false);
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
  });

  it('does not register in a frame', () => {
    vi.stubGlobal('top', {});
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
  });

  it('works when the browser has no service worker API', () => {
    vi.stubGlobal('navigator', {});
    expect(registerServiceWorker).not.toThrow();
    expect(register).not.toHaveBeenCalled();
  });

  it('handles a rejected registration without breaking boot', async () => {
    const error = new Error('storage unavailable');
    register.mockRejectedValueOnce(error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerServiceWorker();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      'Web Shell service worker registration failed:',
      error,
    );
  });
});
