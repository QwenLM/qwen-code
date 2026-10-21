// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  DaemonAvailability,
  DaemonUnavailableError,
  createDaemonClient,
  registerDaemonAvailability,
} from '../../daemon/availability.js';
import { DaemonAvailabilityContext } from '../../daemon/availability-context.js';
import { I18nProvider } from '../../i18n';
import { LocalControlSettingsCard } from './LocalControlSettingsCard';

const fixture = vi.hoisted(() => ({
  workspace: {} as Record<string, unknown>,
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => fixture.workspace,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it.each([false, true])(
  'loads cached active=%s after an offline mount and reloads on recovery without replaying writes',
  async (active) => {
    vi.useFakeTimers();
    const baseUrl = 'https://local-control.example';
    let healthy = false;
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!healthy) throw new TypeError('offline');
      const path = new URL(String(input)).pathname;
      if (path === '/health') return Response.json({ status: 'ok' });
      if (path === '/capabilities') return Response.json({ features: [] });
      if (path === '/workspace/local-control') {
        return Response.json({ active, interfaces: [] });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const availability = new DaemonAvailability(
      baseUrl,
      undefined,
      nativeFetch,
    );
    const unregister = registerDaemonAvailability(
      baseUrl,
      undefined,
      availability,
    );
    const client = createDaemonClient(
      { baseUrl, fetch: nativeFetch },
      availability,
    );
    const request = vi.spyOn(client, 'requestRest');
    fixture.workspace = { baseUrl, client };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await availability.check(true);
      await act(async () => {
        root.render(
          <DaemonAvailabilityContext.Provider value={availability}>
            <I18nProvider language="en">
              <LocalControlSettingsCard />
            </I18nProvider>
          </DaemonAvailabilityContext.Provider>,
        );
      });
      expect(container.querySelector('button')?.disabled).toBe(true);
      expect(request).not.toHaveBeenCalled();

      healthy = true;
      await act(async () => availability.check(true));
      expect(container.querySelector('button')?.disabled).toBe(false);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);

      healthy = false;
      await act(async () => availability.check(true));
      expect(container.querySelector('button')?.disabled).toBe(true);
      await act(async () => container.querySelector('button')?.click());
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(request).toHaveBeenCalledTimes(1);
      healthy = true;
      await act(async () => availability.check(true));
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        request.mock.calls.every(
          ([path, init]) =>
            path === '/workspace/local-control' && init?.method === 'GET',
        ),
      ).toBe(true);
      expect(container.querySelector('button')?.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      unregister();
      availability.dispose();
      client.dispose();
      vi.useRealTimers();
    }
  },
);

it.each(['GET', 'POST'] as const)(
  'localizes a %s gate rejection in Chinese',
  async (method) => {
    const client = createDaemonClient({
      baseUrl: 'https://local-control-rejection.example',
      fetch: vi.fn(),
    });
    const request = vi
      .spyOn(client, 'requestRest')
      .mockResolvedValue(Response.json({ active: false, interfaces: [] }));
    if (method === 'GET')
      request.mockRejectedValueOnce(new DaemonUnavailableError());
    fixture.workspace = {
      baseUrl: 'https://local-control-rejection.example',
      client,
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <I18nProvider language="zh-CN">
            <LocalControlSettingsCard />
          </I18nProvider>,
        ),
      );
      if (method === 'POST') {
        expect(container.querySelector('button')?.disabled).toBe(false);
        request.mockRejectedValueOnce(new DaemonUnavailableError());
        await act(async () => container.querySelector('button')?.click());
      }
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        '无法连接服务。',
      );
    } finally {
      await act(async () => root.unmount());
      client.dispose();
    }
  },
);
