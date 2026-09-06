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
        zta4b6c8d: [ipv4('10.147.17.3')],
        'vEthernet (WSL)': [ipv4('172.20.0.1')],
        vethd4a1b2c: [ipv4('172.21.0.2')],
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

  it('rejects VPN adapters regardless of where "vpn" sits in the name', () => {
    // Consumer VPN adapters end in or embed "vpn" without a token boundary
    // (`OpenVPN Wintun`, `vpnkit`); a boundary requirement previously let
    // them through and `selectLanAddress` would auto-advertise a
    // reachable-only-through-VPN address.
    expect(
      listLanCandidates({
        'OpenVPN Wintun': [ipv4('10.8.0.2')],
        'OpenVPN Wintun Adapter': [ipv4('10.8.0.3')],
        NordVPN: [ipv4('10.8.1.2')],
        vpnkit: [ipv4('192.168.65.3')],
        // Corporate SSL-VPN adapters carry no `vpn` substring — the vendor
        // names are listed explicitly so a sole-candidate VPN address is
        // never silently auto-advertised in the QR.
        'Cisco AnyConnect Secure Mobility Client Virtual Adapter': [
          ipv4('10.8.2.2'),
        ],
        GlobalProtect: [ipv4('10.8.3.2')],
        'Pulse Secure Adapter': [ipv4('10.8.4.2')],
        'FortiClient Virtual Adapter': [ipv4('10.8.5.2')],
        'Cloudflare WARP': [ipv4('10.8.6.2')],
        // Post-rename successor products escape an enumerated vendor's old
        // name: Ivanti Connect Secure is Pulse Secure renamed, Cisco Secure
        // Client succeeds AnyConnect (#9106 round-7 review).
        'Ivanti Connect Secure': [ipv4('10.8.7.2')],
        'Ivanti Connect Secure Virtual Adapter': [ipv4('10.8.7.3')],
        'Cisco Secure Client Virtual Adapter': [ipv4('10.8.8.2')],
        'Citrix Gateway WFP Adapter': [ipv4('10.8.9.2')],
        'SonicWall NetExtender Adapter': [ipv4('10.8.10.2')],
        'Ethernet 3': [ipv4('192.168.7.10')],
      }),
    ).toEqual([{ interfaceName: 'Ethernet 3', address: '192.168.7.10' }]);
  });

  it('keeps physical LAN bridges and only rejects virtual bridge shapes', () => {
    // `br0` (libvirt bridged-LAN host) and Windows "Network Bridge" are
    // physical bridges holding the machine's real LAN address; Docker's
    // `br-<hex>` (including IDs that start with a letter) and macOS
    // `bridge<N>` are the virtual shapes to reject.
    expect(
      listLanCandidates({
        br0: [ipv4('192.168.2.50')],
        'Network Bridge': [ipv4('192.168.4.50')],
        'br-123abc': [ipv4('172.18.0.1')],
        'br-fa5c9b9bdc42': [ipv4('172.19.0.1')],
        bridge0: [ipv4('169.254.1.1')],
      }),
    ).toEqual([
      { interfaceName: 'Network Bridge', address: '192.168.4.50' },
      { interfaceName: 'br0', address: '192.168.2.50' },
    ]);
  });
});
