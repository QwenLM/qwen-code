// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useWorkspace: () => ({
      baseUrl: 'http://127.0.0.1:8080/',
      token: 'test-token',
    }),
  };
});

vi.mock('../../utils/clipboard', () => ({
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
  warnClipboardWriteFailure: vi.fn(),
}));

const { I18nProvider } = await import('../../i18n');
const { LocalControlSettingsCard } = await import('./LocalControlSettingsCard');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function localControlResponse(payload: object, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: () => Promise.resolve(JSON.stringify(payload)),
  } as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <LocalControlSettingsCard />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function buttonWithText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) throw new Error(`button "${text}" not found`);
  return button;
}

describe('LocalControlSettingsCard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
    vi.unstubAllGlobals();
  });

  it('re-posts the daemon-reported active address across a disable/enable round trip (#14136)', async () => {
    // The explicit pick is never an automatic candidate, so the card must
    // retain the committed address itself: reconciling against the (empty)
    // candidate list alone would post `undefined` and the daemon would rebind
    // onto a network the operator explicitly avoided.
    const enableBodies: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: true,
          address: '203.0.113.10',
          interfaceName: 'en0',
          interfaces: [],
        });
      }
      if (url.includes('/workspace/local-control/disable')) {
        return localControlResponse({ active: false, interfaces: [] });
      }
      enableBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return localControlResponse({
        active: true,
        address: '203.0.113.10',
        interfaceName: 'en0',
        interfaces: [],
      });
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    const enable = buttonWithText(container, 'Turn on Local Control');
    expect(enable.disabled).toBe(false);
    act(() => {
      enable.click();
    });
    await flush();

    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).toMatchObject({ address: '203.0.113.10' });
  });

  it('keeps the CLI-granted address when the fresh candidate list omits it (#14140)', async () => {
    // A granted address is never an automatic candidate by construction, so
    // its absence from a fresh list is not evidence of staleness. Dropping it
    // here would enable on a network the operator explicitly avoided and
    // revoke the grant for the daemon's lifetime.
    const enableBodies: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: true,
          address: '10.8.0.2',
          interfaceName: 'utun4',
          interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
          explicitCandidate: { interfaceName: 'utun4', address: '10.8.0.2' },
        });
      }
      if (url.includes('/workspace/local-control/disable')) {
        return localControlResponse({
          active: false,
          interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
        });
      }
      enableBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return localControlResponse({
        active: true,
        address: '10.8.0.2',
        interfaceName: 'utun4',
        interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
      });
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    const enable = buttonWithText(container, 'Turn on Local Control');
    act(() => {
      enable.click();
    });
    await flush();

    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).toMatchObject({ address: '10.8.0.2' });
  });

  it('keeps the CLI-granted pick when the host stopped holding the address before mount (#14140)', async () => {
    // The grant is provenance, not a liveness probe: a VPN drop while the
    // daemon keeps serving the address must not downgrade the retained pick.
    // A card-side latch cannot cover a mount after the drop, so the daemon
    // reports the recorded grant (`grantedAddress`) beside the liveness-gated
    // `explicitCandidate` — and the pick still drops on the daemon's refusal
    // if the address really cannot be bound.
    const enableBodies: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: true,
          address: '10.8.0.2',
          interfaceName: 'utun4',
          interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
          grantedAddress: '10.8.0.2',
        });
      }
      if (url.includes('/workspace/local-control/disable')) {
        return localControlResponse({
          active: false,
          interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
          grantedAddress: '10.8.0.2',
        });
      }
      enableBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return localControlResponse({
        active: true,
        address: '10.8.0.2',
        interfaceName: 'utun4',
        interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
        explicitCandidate: { interfaceName: 'utun4', address: '10.8.0.2' },
        grantedAddress: '10.8.0.2',
      });
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    // The retained row keeps the picker mounted with a lone automatic
    // candidate that would otherwise collapse it.
    expect(container.querySelector('[aria-label="Local network"]')).not.toBe(
      null,
    );
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();

    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).toMatchObject({ address: '10.8.0.2' });
  });

  it('drops the retained pick when the daemon refuses it and recovers from the fresh candidate list', async () => {
    // Stale-DHCP recovery must survive retention: an empty candidate list
    // proves nothing (the pick may live on a filtered tunnel interface), so
    // the card keeps offering it — until the daemon itself refuses the
    // enable, which is the definitive signal that the address is gone.
    const enableBodies: Array<Record<string, unknown>> = [];
    let refuse = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: true,
          address: '10.8.0.2',
          interfaceName: 'utun4',
          interfaces: [],
        });
      }
      if (url.includes('/workspace/local-control/disable')) {
        return localControlResponse({ active: false, interfaces: [] });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      enableBodies.push(body);
      if (refuse) {
        return localControlResponse(
          {
            error:
              '10.8.0.2 is not an IPv4 address this host can expose right now.',
            code: 'unknown_lan_interface',
            interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
          },
          false,
          409,
        );
      }
      return localControlResponse({
        active: true,
        address: String(body['address']),
        interfaceName: 'en0',
        interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
      });
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    // The retained pick is re-posted first — the empty candidate list gave
    // no reason to doubt it.
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).toMatchObject({ address: '10.8.0.2' });
    expect(container.textContent).toContain(
      'is not an IPv4 address this host can expose right now',
    );

    // After the refusal the card follows the fresh candidate list instead of
    // looping on the gone address.
    refuse = false;
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(2);
    expect(enableBodies[1]).toMatchObject({ address: '192.168.1.10' });
  });
});
