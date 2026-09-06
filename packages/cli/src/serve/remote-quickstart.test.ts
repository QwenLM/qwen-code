/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  printRemoteQuickstart,
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

it('advertises only the private LAN population for wildcard binds', () => {
  // docker0/br-*/utun4 are software networks, the public IPv6 and fe80:: are
  // not dialable-from-phone material: none may become a URL or the QR.
  expect(
    remoteQuickstartAddresses('0.0.0.0', 43210, false, interfaces),
  ).toEqual([
    { label: 'Local', url: 'http://127.0.0.1:43210' },
    { label: 'Network (en0)', url: 'http://192.168.1.7:43210' },
  ]);
  expect(remoteQuickstartAddresses('::', 43210, false, interfaces)).toEqual([
    { label: 'Local', url: 'http://[::1]:43210' },
    { label: 'Network (en0)', url: 'http://192.168.1.7:43210' },
    { label: 'Network (en0)', url: 'http://[fd12:3456::1]:43210' },
  ]);
});

it('canonicalises wildcard spellings before enumerating', () => {
  const ipv4Shape = remoteQuickstartAddresses('0.0.0.0', 43210, false, {
    en0: [iface('192.168.1.7', 'IPv4')],
  });
  expect(
    remoteQuickstartAddresses('::ffff:0.0.0.0', 43210, false, {
      en0: [iface('192.168.1.7', 'IPv4')],
    }),
  ).toEqual(ipv4Shape);
  expect(
    remoteQuickstartAddresses(' 0.0.0.0 ', 43210, false, {
      en0: [iface('192.168.1.7', 'IPv4')],
    }),
  ).toEqual(ipv4Shape);
});

it('picks the loopback the :: listener actually answers on', () => {
  const noV6Loopback = { en0: [iface('192.168.1.7', 'IPv4')] };
  expect(remoteQuickstartAddresses('::', 43210, false, noV6Loopback)).toEqual([
    { label: 'Local', url: 'http://127.0.0.1:43210' },
    { label: 'Network (en0)', url: 'http://192.168.1.7:43210' },
  ]);
});

it('uses concrete TLS IPv6 authorities and the actual bound port', () => {
  expect(remoteQuickstartAddresses('2001:db8::2', 43210, true, {})).toEqual([
    { label: 'Address', url: 'https://[2001:db8::2]:43210' },
  ]);
});

it('stays quiet about zone-scoped explicit binds and empty fixtures', () => {
  expect(remoteQuickstartAddresses('fe80::1%en0', 43210, false, {})).toEqual(
    [],
  );
  expect(remoteQuickstartAddresses('0.0.0.0', 43210, false, {})).toEqual([
    { label: 'Local', url: 'http://127.0.0.1:43210' },
  ]);
});

it('encodes credentials only in deliberate QR output, not address lines', async () => {
  stubIsTTY(undefined);
  mocks.generate.mockImplementationOnce(
    (_url: string, _options: unknown, callback: (code: string) => void) =>
      callback('QR-SENTINEL\n'),
  );
  await printRemoteQuickstart({
    bind: '192.168.1.2',
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

it('never QRs a stable operator token into captured stdout', async () => {
  stubIsTTY(undefined);
  await printRemoteQuickstart({
    bind: '192.168.1.2',
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
    port: 4170,
    tls: false,
    token: 'secret',
    generated: true,
    web: true,
  });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.line).toHaveBeenCalledWith(
    'QR unavailable; open an address above and enter the bearer token.',
  );
});

it('survives a throwing stdout writer', async () => {
  mocks.line.mockImplementation(() => {
    throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  });
  await expect(
    printRemoteQuickstart({
      bind: '192.168.1.2',
      port: 4170,
      tls: false,
      token: 'secret',
      generated: true,
      web: true,
    }),
  ).resolves.toBeUndefined();
});
