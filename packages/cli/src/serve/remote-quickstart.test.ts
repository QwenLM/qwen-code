/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  printRemoteQuickstart,
  quickstartPrintMode,
  remoteQuickstartAddresses,
} from './remote-quickstart.js';

const mocks = vi.hoisted(() => ({
  line: vi.fn(),
  generate: vi.fn(),
  level: vi.fn(),
}));
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLineSafe: mocks.line,
}));
vi.mock('qrcode-terminal', () => ({
  default: { generate: mocks.generate, setErrorLevel: mocks.level },
}));

const originalIsTTY = process.stdout.isTTY;
function stubIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    configurable: true,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  stubIsTTY(originalIsTTY);
});

function iface(
  address: string,
  family: 'IPv4' | 'IPv6',
  internal = false,
): NetworkInterfaceInfo {
  return family === 'IPv4'
    ? {
        address,
        netmask: '255.255.255.0',
        family,
        mac: '00:00:00:00:00:00',
        internal,
        cidr: null,
      }
    : {
        address,
        netmask: 'ffff:ffff::',
        family,
        mac: '00:00:00:00:00:00',
        internal,
        cidr: null,
        scopeid: 0,
      };
}

const interfaces = {
  lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
  docker0: [iface('172.17.0.1', 'IPv4')],
  'br-1a2b3c': [iface('172.18.0.1', 'IPv4')],
  utun4: [iface('30.170.221.40', 'IPv4')],
  en0: [
    iface('192.168.1.7', 'IPv4'),
    iface('fe80::1', 'IPv6'),
    iface('240e:391::5', 'IPv6'),
    iface('fd12:3456::1', 'IPv6'),
  ],
};

describe('quickstartPrintMode', () => {
  it('prints the full block for every non-loopback bound address', () => {
    for (const bound of ['0.0.0.0', '::', '192.168.1.7', '2001:db8::2']) {
      expect(quickstartPrintMode(bound, true)).toBe('full');
      expect(quickstartPrintMode(bound, false)).toBe('full');
    }
  });

  it('prints only the generated bearer on a loopback bound address', () => {
    for (const bound of ['127.0.0.1', '127.0.0.53', '::1', '[::1]']) {
      expect(quickstartPrintMode(bound, true)).toBe('token-only');
    }
  });

  it('stays silent for an operator token on a loopback bound address', () => {
    for (const bound of ['127.0.0.1', '::1', '[::1]']) {
      expect(quickstartPrintMode(bound, false)).toBe('silent');
    }
  });

  it('keys off the bound address, not the operator spelling', () => {
    // A DNS name that resolves to loopback binds loopback only: its socket
    // reports a loopback bound address, so no undialable LAN list or QR may
    // follow — while a generated bearer still prints (the operator's only
    // way in).
    expect(quickstartPrintMode('127.0.0.1', true)).toBe('token-only');
    expect(quickstartPrintMode('::1', true)).toBe('token-only');
    expect(quickstartPrintMode('127.0.0.1', false)).toBe('silent');
  });
});

it('advertises only the private LAN population for wildcard binds', () => {
  // docker0/br-*/utun4 are software networks, the public IPv6 and fe80:: are
  // not dialable-from-phone material: none may become a URL or the QR.
  expect(
    remoteQuickstartAddresses('0.0.0.0', '0.0.0.0', 43210, false, interfaces),
  ).toEqual([
    { label: 'Local', url: 'http://127.0.0.1:43210' },
    { label: 'Network (en0)', url: 'http://192.168.1.7:43210' },
  ]);
  expect(
    remoteQuickstartAddresses('::', '::', 43210, false, interfaces),
  ).toEqual([
    { label: 'Local', url: 'http://[::1]:43210' },
    { label: 'Network (en0)', url: 'http://192.168.1.7:43210' },
    { label: 'Network (en0)', url: 'http://[fd12:3456::1]:43210' },
  ]);
});

it('reads wildcard-ness from the bound address, not the spelling', () => {
  const ipv4Shape = remoteQuickstartAddresses(
    '0.0.0.0',
    '0.0.0.0',
    43210,
    false,
    { en0: [iface('192.168.1.7', 'IPv4')] },
  );
  // inet_aton abbreviations and IPv6-zero spellings bind to the canonical
  // wildcard, and the IPv4-mapped wildcard plus the whitespace-bearing
  // defensive fallback normalise here.
  for (const spelling of ['0', '0.0', '0.0.0.0', ' 0.0.0.0 ']) {
    expect(
      remoteQuickstartAddresses(spelling, '0.0.0.0', 43210, false, {
        en0: [iface('192.168.1.7', 'IPv4')],
      }),
    ).toEqual(ipv4Shape);
  }
  expect(
    remoteQuickstartAddresses(
      '::ffff:0.0.0.0',
      '::ffff:0.0.0.0',
      43210,
      false,
      {
        en0: [iface('192.168.1.7', 'IPv4')],
      },
    ),
  ).toEqual(ipv4Shape);
  expect(
    remoteQuickstartAddresses('::0', '::', 43210, false, {
      en0: [iface('192.168.1.7', 'IPv4')],
    }),
  ).toEqual([
    { label: 'Local', url: 'http://127.0.0.1:43210' },
    { label: 'Network (en0)', url: 'http://192.168.1.7:43210' },
  ]);
  // The defensive fallback (boot hands opts.hostname over when the socket
  // address is unavailable) can carry whitespace or casing; that
  // normalisation lives in the entries helper and stays exercised here.
  for (const bound of [' 0.0.0.0 ', '::FFFF:0.0.0.0']) {
    expect(
      remoteQuickstartAddresses('0.0.0.0', bound, 43210, false, {
        en0: [iface('192.168.1.7', 'IPv4')],
      }),
    ).toEqual(ipv4Shape);
  }
});

it('picks the loopback the :: listener actually answers on', () => {
  const noV6Loopback = { en0: [iface('192.168.1.7', 'IPv4')] };
  expect(
    remoteQuickstartAddresses('::', '::', 43210, false, noV6Loopback),
  ).toEqual([
    { label: 'Local', url: 'http://127.0.0.1:43210' },
    { label: 'Network (en0)', url: 'http://192.168.1.7:43210' },
  ]);
});

it('prints Local as [::1] when the host assigns the IPv6 loopback', () => {
  expect(
    remoteQuickstartAddresses('::', '::', 43210, false, {
      lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
      en0: [iface('192.168.1.7', 'IPv4')],
    }),
  ).toEqual([
    { label: 'Local', url: 'http://[::1]:43210' },
    { label: 'Network (en0)', url: 'http://192.168.1.7:43210' },
  ]);
});

it('never advertises a ULA parked on a software interface', () => {
  // A VPN/VM adapter can hold a fc00::/7 address; the dual-stack ULA sweep
  // must skip software interfaces exactly like the IPv4 LAN sweep does, or
  // the QR would point at an address only the host can dial.
  expect(
    remoteQuickstartAddresses('::', '::', 43210, false, {
      lo0: [iface('::1', 'IPv6', true)],
      utun4: [iface('fd12:3456::9', 'IPv6')],
      en0: [iface('192.168.1.7', 'IPv4'), iface('fd12:3456::1', 'IPv6')],
    }),
  ).toEqual([
    { label: 'Local', url: 'http://[::1]:43210' },
    { label: 'Network (en0)', url: 'http://192.168.1.7:43210' },
    { label: 'Network (en0)', url: 'http://[fd12:3456::1]:43210' },
  ]);
});

it('uses concrete TLS IPv6 authorities and the actual bound port', () => {
  expect(
    remoteQuickstartAddresses('2001:db8::2', '2001:db8::2', 43210, true, {}),
  ).toEqual([{ label: 'Address', url: 'https://[2001:db8::2]:43210' }]);
});

it('prints the operator spelling for an explicit non-loopback bind', () => {
  // Classification keys off the bound address (not a wildcard here) while the
  // printed URL keeps the operator's own name — a DNS name that resolves
  // public is exactly the shape a named host produces.
  expect(
    remoteQuickstartAddresses('myhost.example', '203.0.113.5', 4170, false, {}),
  ).toEqual([{ label: 'Address', url: 'http://myhost.example:4170' }]);
});

it('stays quiet about zone-scoped explicit binds and empty fixtures', () => {
  expect(
    remoteQuickstartAddresses('fe80::1%en0', 'fe80::1%en0', 43210, false, {}),
  ).toEqual([]);
  expect(
    remoteQuickstartAddresses('0.0.0.0', '0.0.0.0', 43210, false, {}),
  ).toEqual([{ label: 'Local', url: 'http://127.0.0.1:43210' }]);
});

it('encodes credentials only in deliberate QR output, not address lines', async () => {
  stubIsTTY(undefined);
  mocks.generate.mockImplementationOnce(
    (_url: string, _options: unknown, callback: (code: string) => void) =>
      callback('QR-SENTINEL\n'),
  );
  await printRemoteQuickstart({
    bind: '192.168.1.2',
    boundAddress: '192.168.1.2',
    port: 4170,
    tls: false,
    token: 'a+b/c',
    generated: true,
    web: true,
  });
  expect(mocks.generate).toHaveBeenCalledWith(
    'http://192.168.1.2:4170/#token=a%2Bb%2Fc',
    { small: true },
    expect.any(Function),
  );
  expect(mocks.line).toHaveBeenCalledWith('Address: http://192.168.1.2:4170');
  expect(mocks.line).toHaveBeenCalledWith(
    'Scan to open Web Shell: http://192.168.1.2:4170 (Address)',
  );
  expect(mocks.line).toHaveBeenCalledWith(
    'SECRET QR: grants daemon access. Do not share.',
  );
  expect(mocks.line).toHaveBeenCalledWith('QR-SENTINEL');
  // The generated-token line is the credential's deliberate delivery channel;
  // every OTHER line must stay token-free in both raw and URL-encoded form.
  const incidental = mocks.line.mock.calls
    .flat()
    .filter((line: string) => !line.startsWith('Generated bearer token'))
    .join('\n');
  expect(incidental).not.toContain('a+b/c');
  expect(incidental).not.toMatch(/token=/);
  expect(
    mocks.line.mock.calls.filter((call: string[]) =>
      call[0].startsWith('Generated bearer token'),
    ),
  ).toHaveLength(1);
});

it('prints https authorities and omits the plaintext warning under TLS', async () => {
  stubIsTTY(true);
  mocks.generate.mockImplementationOnce(
    (_url: string, _options: unknown, callback: (code: string) => void) =>
      callback('QR\n'),
  );
  await printRemoteQuickstart({
    bind: '192.168.1.2',
    boundAddress: '192.168.1.2',
    port: 4170,
    tls: true,
    token: 'gen-token-tls',
    generated: true,
    web: true,
  });
  expect(mocks.line).toHaveBeenCalledWith('Address: https://192.168.1.2:4170');
  expect(mocks.generate).toHaveBeenCalledWith(
    'https://192.168.1.2:4170/#token=gen-token-tls',
    { small: true },
    expect.any(Function),
  );
  expect(mocks.line.mock.calls.flat().join('\n')).not.toContain(
    'HTTP is unencrypted',
  );
});

it('prints the generated bearer line verbatim, exactly once', async () => {
  await printRemoteQuickstart({
    bind: '192.168.1.2',
    boundAddress: '192.168.1.2',
    port: 4170,
    tls: false,
    token: 'gen-token-abc',
    generated: true,
    web: false,
  });
  expect(mocks.line).toHaveBeenCalledWith(
    'Generated bearer token (secret; changes on restart): gen-token-abc',
  );
  expect(
    mocks.line.mock.calls.filter((call: string[]) =>
      call[0].includes('gen-token-abc'),
    ),
  ).toHaveLength(1);
  // Positive direction of the TLS mirror above: the plaintext warning is
  // printed on a non-TLS bind, not merely absent under TLS.
  expect(mocks.line).toHaveBeenCalledWith(
    expect.stringContaining('HTTP is unencrypted'),
  );
});

it('prints only the bearer and the loopback note on a loopback bind', async () => {
  await printRemoteQuickstart({
    bind: 'localhost',
    boundAddress: '127.0.0.1',
    port: 4170,
    tls: false,
    token: 'gen-token-abc',
    generated: true,
    web: true,
  });
  expect(mocks.line.mock.calls.flat()).toEqual([
    'Generated bearer token (secret; changes on restart): gen-token-abc',
    'The listener bound loopback, so no network address or QR is printed; ' +
      'local clients must present this bearer.',
  ]);
  expect(mocks.generate).not.toHaveBeenCalled();
});

it('prints nothing for an operator token on a loopback bind', async () => {
  await printRemoteQuickstart({
    bind: 'localhost',
    boundAddress: '::1',
    port: 4170,
    tls: false,
    token: 'stable-secret',
    generated: false,
    web: true,
  });
  expect(mocks.line).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
});

it('never QRs a stable operator token into captured stdout', async () => {
  stubIsTTY(undefined);
  await printRemoteQuickstart({
    bind: '192.168.1.2',
    boundAddress: '192.168.1.2',
    port: 4170,
    tls: false,
    token: 'stable-secret',
    generated: false,
    web: true,
  });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.line).toHaveBeenCalledWith('Address: http://192.168.1.2:4170');
  expect(mocks.line.mock.calls.flat().join('\n')).not.toContain(
    'stable-secret',
  );
});

it('QRs a stable token only at an interactive terminal', async () => {
  stubIsTTY(true);
  mocks.generate.mockImplementationOnce(
    (_url: string, _options: unknown, callback: (code: string) => void) =>
      callback('QR\n'),
  );
  await printRemoteQuickstart({
    bind: '192.168.1.2',
    boundAddress: '192.168.1.2',
    port: 4170,
    tls: false,
    token: 'stable-secret',
    generated: false,
    web: true,
  });
  expect(mocks.generate).toHaveBeenCalledOnce();
  expect(mocks.line).toHaveBeenCalledWith('QR');
});

it('prints generated API credentials but never QR for no-web', async () => {
  stubIsTTY(true);
  await printRemoteQuickstart({
    bind: '192.168.1.2',
    boundAddress: '192.168.1.2',
    port: 4170,
    tls: false,
    token: 'secret',
    generated: true,
    web: false,
  });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(
    mocks.line.mock.calls
      .flat()
      .filter((line: string) => line.includes('secret')),
  ).toHaveLength(1);
});

it('prints the QR fallback when no candidate address exists', async () => {
  await printRemoteQuickstart({
    bind: 'fe80::1%en0',
    boundAddress: 'fe80::1%en0',
    port: 4170,
    tls: false,
    token: 'secret',
    generated: true,
    web: true,
  });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.line).toHaveBeenCalledWith(
    'QR unavailable; enter the bearer token at the daemon address.',
  );
});

it('survives a throwing stdout writer', async () => {
  mocks.line.mockImplementation(() => {
    throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  });
  try {
    await expect(
      printRemoteQuickstart({
        bind: '192.168.1.2',
        boundAddress: '192.168.1.2',
        port: 4170,
        tls: false,
        token: 'secret',
        generated: true,
        web: true,
      }),
    ).resolves.toBeUndefined();
  } finally {
    // mockImplementation survives clearAllMocks; restore the no-op or every
    // later print in this file would be swallowed by the outer catch.
    mocks.line.mockImplementation(() => undefined);
  }
});

describe('wildcard enumeration and QR candidate', () => {
  afterEach(() => stubIsTTY(undefined));

  it('drops scoped ULA addresses on dual-stack wildcards', () => {
    expect(
      remoteQuickstartAddresses('::', '::', 4170, false, {
        en0: [iface('fd12::1%en0', 'IPv6'), iface('fd12::2', 'IPv6')],
      }),
    ).toEqual([
      { label: 'Local', url: 'http://127.0.0.1:4170' },
      { label: 'Network (en0)', url: 'http://[fd12::2]:4170' },
    ]);
  });

  it('QRs the routable private address, not a link-local one', async () => {
    mocks.generate.mockImplementationOnce(
      (_url: string, _options: unknown, callback: (code: string) => void) =>
        callback('QR\n'),
    );
    await printRemoteQuickstart({
      bind: '0.0.0.0',
      boundAddress: '0.0.0.0',
      port: 4170,
      tls: false,
      token: 'generated-token-000000',
      generated: true,
      web: true,
      interfaces: {
        en0: [iface('169.254.9.9', 'IPv4'), iface('192.168.1.7', 'IPv4')],
      },
    });
    expect(mocks.generate).toHaveBeenCalledWith(
      'http://192.168.1.7:4170/#token=generated-token-000000',
      { small: true },
      expect.any(Function),
    );
  });

  it('falls back to a link-local address when nothing else exists', async () => {
    mocks.generate.mockImplementationOnce(
      (_url: string, _options: unknown, callback: (code: string) => void) =>
        callback('QR\n'),
    );
    await printRemoteQuickstart({
      bind: '0.0.0.0',
      boundAddress: '0.0.0.0',
      port: 4170,
      tls: false,
      token: 'generated-token-000000',
      generated: true,
      web: true,
      interfaces: { en0: [iface('169.254.9.9', 'IPv4')] },
    });
    expect(mocks.generate).toHaveBeenCalledWith(
      'http://169.254.9.9:4170/#token=generated-token-000000',
      { small: true },
      expect.any(Function),
    );
  });

  it('says so when a wildcard bind has interfaces but no dialable candidate', async () => {
    // A stable operator token at a captured stdout: the fallback line must
    // come from the missing-candidate guard, not from the QR suppression
    // path — deleting the guard would return silently here.
    await printRemoteQuickstart({
      bind: '0.0.0.0',
      boundAddress: '0.0.0.0',
      port: 4170,
      tls: false,
      token: 'stable-secret',
      generated: false,
      web: true,
      interfaces: {
        lo0: [iface('127.0.0.1', 'IPv4', true)],
        docker0: [iface('172.17.0.1', 'IPv4')],
        en0: [iface('203.0.113.7', 'IPv4')],
      },
    });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.line).toHaveBeenCalledWith(
      'QR unavailable; enter the bearer token at the daemon address.',
    );
  });
});
