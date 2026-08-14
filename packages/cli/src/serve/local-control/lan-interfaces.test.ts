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
        'br-123abc': [ipv4('172.18.0.1')],
        virbr0: [ipv4('192.168.122.1')],
        zt7nnig26: [ipv4('10.147.17.2')],
        'vEthernet (WSL)': [ipv4('172.20.0.1')],
        'VirtualBox Host-Only Network': [ipv4('192.168.56.1')],
        podman0: [ipv4('10.88.0.1')],
        'cni-podman0': [ipv4('10.89.0.1')],
        cni0: [ipv4('10.90.0.1')],
        lxcbr0: [ipv4('10.91.0.1')],
        lxdbr0: [ipv4('10.92.0.1')],
        'flannel.1': [ipv4('10.93.0.1')],
        Ethernet: [ipv4('192.168.2.10')],
        'Ethernet 2': [ipv4('192.168.3.10')],
      }),
    ).toEqual([
      { interfaceName: 'Ethernet 2', address: '192.168.3.10' },
      { interfaceName: 'Ethernet', address: '192.168.2.10' },
      { interfaceName: 'en0', address: '192.168.1.10' },
      { interfaceName: 'wlan0', address: '10.0.0.10' },
    ]);
  });
});
