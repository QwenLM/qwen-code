import { describe, expect, it, vi } from 'vitest';
import { WEB_SHELL_SERVICE_WORKER_ROUTE } from '@qwen-code/sdk/daemon';
import { scheduleServiceWorkerRegistration } from './pwa-registration.js';

function registrationHarness({
  production = true,
  unsupported = false,
}: {
  production?: boolean;
  unsupported?: boolean;
} = {}) {
  let loadListener: (() => void) | undefined;
  const register = vi.fn().mockResolvedValue(undefined);
  const addLoadListener = vi.fn((listener: () => void) => {
    loadListener = listener;
  });

  scheduleServiceWorkerRegistration({
    production,
    root: { hasAttribute: () => unsupported },
    serviceWorker: { register },
    addLoadListener,
  });

  return { addLoadListener, register, runLoad: () => loadListener?.() };
}

describe('standalone PWA registration', () => {
  it('registers the shared worker route after load in production', () => {
    const harness = registrationHarness();
    expect(harness.register).not.toHaveBeenCalled();
    harness.runLoad();
    expect(harness.register).toHaveBeenCalledWith(
      WEB_SHELL_SERVICE_WORKER_ROUTE,
      { scope: '/' },
    );
  });

  it('does not register in a browser rejected by the feature gate', () => {
    const harness = registrationHarness({ unsupported: true });
    expect(harness.addLoadListener).not.toHaveBeenCalled();
    harness.runLoad();
    expect(harness.register).not.toHaveBeenCalled();
  });

  it('does not register outside production', () => {
    const harness = registrationHarness({ production: false });
    expect(harness.addLoadListener).not.toHaveBeenCalled();
    expect(harness.register).not.toHaveBeenCalled();
  });
});
