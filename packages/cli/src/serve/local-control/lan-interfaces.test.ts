/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { listLanCandidates } from './lan-interfaces.js';

function ipv4(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  };
}

describe('listLanCandidates', () => {
  it('keeps physical private interfaces and rejects software tunnels', () => {
    expect(
      listLanCandidates({
        en0: [ipv4('192.168.1.10')],
        wlan0: [ipv4('10.0.0.10')],
        utun4: [ipv4('10.8.0.2')],
        wg0: [ipv4('10.9.0.2')],
        'Tailscale Tunnel': [ipv4('10.10.0.2')],
        docker0: [ipv4('172.17.0.1')],
      }),
    ).toEqual([
      { interfaceName: 'en0', address: '192.168.1.10' },
      { interfaceName: 'wlan0', address: '10.0.0.10' },
    ]);
  });
});
