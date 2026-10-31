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

// jsdom implements pointer events but not pointer capture; Radix Select's
// trigger checks it on pointerdown.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

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

function click(element: HTMLElement): void {
  element.dispatchEvent(
    new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

  it('offers the CLI-granted pick on a cold mount after the host lost the address (#14140)', async () => {
    // Nothing was retained in this card yet: the active branch needs a live
    // listener and the explicitCandidate branch needs the liveness probe. A
    // mount that only reports `grantedAddress` must still offer the grant, or
    // the single automatic candidate auto-fills and one click binds the
    // network the operator explicitly avoided.
    const enableBodies: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
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
        interfaceName: 'en0',
        interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
        grantedAddress: '10.8.0.2',
      });
    });

    const container = mount();
    await flush();

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
        address:
          typeof body['address'] === 'string'
            ? body['address']
            : '192.168.1.10',
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
    // looping on the gone address — but the lone surviving candidate is an
    // auto-fill, not a named choice, so the retry leaves the daemon to pick
    // it (posting it by name would revoke a standing grant, #14140).
    refuse = false;
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(2);
    expect(enableBodies[1]).not.toHaveProperty('address');
  });

  it('does not turn a refused CLI grant into a named fallback choice (#14140)', async () => {
    // Dropping the refused grant leaves one automatic candidate, but the card
    // must not post it as a named address: the daemon reads a named address as
    // the operator's later choice and revokes the daemon-start grant for the
    // rest of its lifetime. The address-less enable auto-picks the fallback
    // without superseding the grant.
    const enableBodies: Array<Record<string, unknown>> = [];
    let refuse = true;
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
        address: '192.168.1.10',
        interfaceName: 'en0',
        interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
        grantedAddress: '10.8.0.2',
      });
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).toMatchObject({ address: '10.8.0.2' });

    refuse = false;
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(2);
    expect(enableBodies[1]).not.toHaveProperty('address');

    // The daemon kept the grant while the address-less retry bound the
    // fallback. A second ordinary Disable→Enable must keep leaving that
    // fallback unnamed: the card retained the auto-picked address, but it is
    // not a choice the operator made, and naming it would supersede the
    // still-standing grant.
    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(3);
    expect(enableBodies[2]).not.toHaveProperty('address');
  });

  it('keeps a refused grant from becoming a named fallback when a second candidate appears (#14140)', async () => {
    // The refusal recovered onto the lone fallback while the grant still
    // stood. A second candidate then makes an address-less enable ambiguous —
    // but naming the fallback would revoke the grant for the daemon's
    // lifetime. The grant is the one address the daemon keeps, so the card
    // must name it and let the daemon refuse it if the host still lacks it.
    const enableBodies: Array<Record<string, unknown>> = [];
    const fallback = { interfaceName: 'en0', address: '192.168.1.10' };
    const twoCandidates = [
      fallback,
      { interfaceName: 'en1', address: '192.168.1.20' },
    ];
    let refuse = true;
    let disables = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: true,
          address: '10.8.0.2',
          interfaceName: 'utun4',
          interfaces: [fallback],
          grantedAddress: '10.8.0.2',
        });
      }
      if (url.includes('/workspace/local-control/disable')) {
        disables += 1;
        return localControlResponse({
          active: false,
          interfaces: disables === 1 ? [fallback] : twoCandidates,
          grantedAddress: '10.8.0.2',
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      enableBodies.push(body);
      if (refuse) {
        return localControlResponse(
          {
            error:
              '10.8.0.2 is not an IPv4 address this host can expose right now.',
            code: 'unknown_lan_interface',
            interfaces: disables === 1 ? [fallback] : twoCandidates,
          },
          false,
          409,
        );
      }
      return localControlResponse({
        active: true,
        address: '192.168.1.10',
        interfaceName: 'en0',
        interfaces: [fallback],
        grantedAddress: '10.8.0.2',
      });
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).toMatchObject({ address: '10.8.0.2' });

    // The refusal drops the grant pick and the address-less retry binds the
    // fallback without superseding the grant.
    refuse = false;
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(2);
    expect(enableBodies[1]).not.toHaveProperty('address');

    // A second candidate shows up, so address-less is now ambiguous. Naming
    // the fallback would revoke the grant; the card names the grant instead
    // and the daemon refuses it as still-unbindable.
    refuse = true;
    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(3);
    expect(enableBodies[2]).toMatchObject({ address: '10.8.0.2' });
  });

  it('returns a latched fallback to unnamed when the candidates shrink to one (#14140)', async () => {
    // Mounting active with two candidates names the auto-picked fallback,
    // because an address-less enable would be ambiguous. When the list shrinks
    // back to that one candidate the enable is unambiguous again, so the latch
    // must be recomputed: posting the fallback by name would supersede the
    // standing grant for the daemon's lifetime.
    const enableBodies: Array<Record<string, unknown>> = [];
    const fallback = { interfaceName: 'en0', address: '192.168.1.10' };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: true,
          address: '192.168.1.10',
          interfaceName: 'en0',
          interfaces: [
            fallback,
            { interfaceName: 'en1', address: '192.168.1.20' },
          ],
          grantedAddress: '10.8.0.2',
        });
      }
      if (url.includes('/workspace/local-control/disable')) {
        return localControlResponse({
          active: false,
          interfaces: [fallback],
          grantedAddress: '10.8.0.2',
        });
      }
      enableBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return localControlResponse({
        active: true,
        address: '192.168.1.10',
        interfaceName: 'en0',
        interfaces: [fallback],
        grantedAddress: '10.8.0.2',
      });
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();

    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).not.toHaveProperty('address');
  });

  it('does not name the auto-picked fallback on a cold mount while a grant stands (#14140)', async () => {
    // The daemon rebound to a fallback after losing the granted address; a
    // card mounted now sees only the fallback as a candidate. Disable→Enable
    // must leave it unnamed, or the card would supersede the standing grant
    // with a choice nobody made.
    const enableBodies: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: true,
          address: '192.168.1.10',
          interfaceName: 'en0',
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
        address: '192.168.1.10',
        interfaceName: 'en0',
        interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
        grantedAddress: '10.8.0.2',
      });
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();

    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).not.toHaveProperty('address');
  });

  it('keeps a granted address from becoming a named fallback on a cold mount with two candidates (#14140)', async () => {
    // Same state as above, but two candidates make an address-less enable
    // ambiguous. The card must name the standing grant — naming the
    // auto-picked fallback would revoke it, and an address-less enable would
    // loop on ambiguity 409s. The host still lacks the grant, so the daemon
    // refuses it and the card recovers to an explicit pick.
    const enableBodies: Array<Record<string, unknown>> = [];
    const candidates = [
      { interfaceName: 'en0', address: '192.168.1.10' },
      { interfaceName: 'en1', address: '192.168.1.20' },
    ];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: true,
          address: '192.168.1.10',
          interfaceName: 'en0',
          interfaces: candidates,
          grantedAddress: '10.8.0.2',
        });
      }
      if (url.includes('/workspace/local-control/disable')) {
        return localControlResponse({
          active: false,
          interfaces: candidates,
          grantedAddress: '10.8.0.2',
        });
      }
      enableBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return localControlResponse(
        {
          error:
            '10.8.0.2 is not an IPv4 address this host can expose right now.',
          code: 'unknown_lan_interface',
          interfaces: candidates,
        },
        false,
        409,
      );
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Disconnect phone access').click();
    });
    await flush();

    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();

    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).toMatchObject({ address: '10.8.0.2' });
    // The refusal recovers to a visible pick instead of wedging the card on
    // an address-less enable into two candidates.
    expect(buttonWithText(container, 'Turn on Local Control').disabled).toBe(
      true,
    );
  });

  it('names the standing grant when a refused pick meets a second candidate (#14140)', async () => {
    // A CLI grant the host does not hold is refused on the first enable. The
    // card recovers onto the lone automatic candidate, but the grant still
    // stands in the daemon. When a second candidate makes an address-less
    // enable ambiguous, naming the auto-fill would revoke that grant — the
    // card must name the grant instead and let the daemon refuse it again.
    const enableBodies: Array<Record<string, unknown>> = [];
    const fallback = { interfaceName: 'en0', address: '192.168.1.10' };
    const twoCandidates = [
      fallback,
      { interfaceName: 'en1', address: '192.168.1.20' },
    ];
    let enables = 0;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: false,
          interfaces: [fallback],
          grantedAddress: '10.8.0.2',
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      enableBodies.push(body);
      enables += 1;
      if (enables === 1) {
        return localControlResponse(
          {
            error:
              '10.8.0.2 is not an IPv4 address this host can expose right now.',
            code: 'unknown_lan_interface',
            interfaces: [fallback],
          },
          false,
          409,
        );
      }
      if (enables === 2) {
        return localControlResponse(
          {
            error:
              'Multiple local networks are available; choose which one to expose: en0 (192.168.1.10), en1 (192.168.1.20)',
            code: 'ambiguous_lan_interface',
            interfaces: twoCandidates,
          },
          false,
          409,
        );
      }
      return localControlResponse({
        active: true,
        address: '10.8.0.2',
        interfaceName: 'utun4',
        interfaces: twoCandidates,
        grantedAddress: '10.8.0.2',
      });
    });

    const container = mount();
    await flush();

    // The grant is pre-selected by name; the daemon refuses it because the
    // host does not hold that address.
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).toMatchObject({ address: '10.8.0.2' });

    // The recovery leaves the lone candidate unnamed, so the next enable
    // reaches the daemon's (now stale) candidate list address-less.
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(2);
    expect(enableBodies[1]).not.toHaveProperty('address');

    // A second candidate makes address-less ambiguous. Naming the auto-fill
    // would revoke the grant, so the card names the grant instead.
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(3);
    expect(enableBodies[2]).toMatchObject({ address: '10.8.0.2' });
  });

  it('promotes the displayed auto-fill when a 409 makes the choice ambiguous (#14140)', async () => {
    // A lone candidate auto-fills without a picker. If a second interface
    // appears before the click, an address-less enable is ambiguous — and
    // clicking the row the picker now shows fires no change event, so the
    // displayed auto-fill itself must start being posted by name.
    const enableBodies: Array<Record<string, unknown>> = [];
    let refuse = true;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: false,
          interfaces: [{ interfaceName: 'en0', address: '192.168.1.10' }],
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      enableBodies.push(body);
      if (refuse) {
        return localControlResponse(
          {
            error:
              'Multiple local networks are available; choose which one to expose: en0 (192.168.1.10), en1 (192.168.1.20)',
            code: 'ambiguous_lan_interface',
            interfaces: [
              { interfaceName: 'en0', address: '192.168.1.10' },
              { interfaceName: 'en1', address: '192.168.1.20' },
            ],
          },
          false,
          409,
        );
      }
      return localControlResponse({
        active: true,
        address: '192.168.1.10',
        interfaceName: 'en0',
        interfaces: [
          { interfaceName: 'en0', address: '192.168.1.10' },
          { interfaceName: 'en1', address: '192.168.1.20' },
        ],
      });
    });

    const container = mount();
    await flush();

    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).not.toHaveProperty('address');
    expect(container.querySelector('[aria-label="Local network"]')).not.toBe(
      null,
    );

    refuse = false;
    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();
    expect(enableBodies).toHaveLength(2);
    expect(enableBodies[1]).toMatchObject({ address: '192.168.1.10' });
  });

  it('posts the operator-chosen candidate by name (#14140)', async () => {
    // An explicit pick is a named choice, so it must still be posted as
    // `address` even though a lone auto-fill must not be.
    const enableBodies: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return localControlResponse({
          active: false,
          interfaces: [
            { interfaceName: 'en0', address: '192.168.1.10' },
            { interfaceName: 'wlan0', address: '192.168.1.20' },
          ],
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      enableBodies.push(body);
      return localControlResponse({
        active: true,
        address: '192.168.1.20',
        interfaceName: 'wlan0',
        interfaces: [
          { interfaceName: 'en0', address: '192.168.1.10' },
          { interfaceName: 'wlan0', address: '192.168.1.20' },
        ],
      });
    });

    const container = mount();
    await flush();

    const trigger = container.querySelector<HTMLElement>(
      '[aria-label="Local network"]',
    );
    if (!trigger) throw new Error('network picker was not rendered');
    await act(async () => {
      click(trigger);
      await Promise.resolve();
    });
    const option = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((candidate) => candidate.textContent?.includes('192.168.1.20'));
    if (!option) throw new Error('candidate option was not rendered');
    await act(async () => {
      click(option);
      await Promise.resolve();
    });

    act(() => {
      buttonWithText(container, 'Turn on Local Control').click();
    });
    await flush();

    expect(enableBodies).toHaveLength(1);
    expect(enableBodies[0]).toMatchObject({ address: '192.168.1.20' });
  });
});
