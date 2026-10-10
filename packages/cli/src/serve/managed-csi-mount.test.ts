/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ManagedCsiMount, parseManagedCsiMount } from './managed-csi-mount.js';

const qualified =
  '2194 2176 259:8 / /workspace rw,relatime - ext4 /dev/nvme2n1 rw\n';
const parent = '2176 2000 0:50 / / rw,relatime - overlay overlay rw\n';

describe('ACK Disk mount profile', () => {
  it('parses the retained ACK kernel observation without inferring a CSI handle', () => {
    expect(parseManagedCsiMount(parent + qualified, '/workspace')).toEqual({
      mountId: '2194',
      device: '259:8',
      source: '/dev/nvme2n1',
    });
    expect(
      parseManagedCsiMount(
        qualified.replace('/workspace', '/work\\040space'),
        '/work space',
      ),
    ).toEqual(parseManagedCsiMount(qualified, '/workspace'));
  });

  it.each([
    qualified.replace(' rw,relatime ', ' ro,relatime '),
    qualified.replace('nvme2n1 rw', 'nvme2n1 ro'),
    qualified.replace('ext4', 'overlay'),
    qualified.replace('/dev/nvme2n1', '/dev/nvme2n1p1'),
    qualified.replace('/dev/nvme2n1', '/dev/vda'),
    qualified.replace(' / /workspace', ' /subdir /workspace'),
    qualified.replace('259:8', '../259:8'),
    qualified.replace('2194 ', '+2194 '),
    qualified + qualified,
    qualified + '2195 2194 0:1 / /workspace/covered rw - tmpfs tmpfs rw\n',
    qualified.replace('/workspace', '/another'),
    qualified.replace('/workspace', '/work\\777space'),
    qualified.replace(' - ', ' '),
    qualified.trim() + ' extra',
    parent,
    `${qualified}\0`,
  ])(
    'refuses an unavailable, ambiguous or different filesystem mount',
    (input) => {
      expect(() => parseManagedCsiMount(input, '/workspace')).toThrow(
        'Managed CSI mount is unavailable.',
      );
    },
  );

  it.each([
    '/',
    '/workspace/',
    '/work//space',
    '/work/../space',
    '/work/./space',
    'workspace',
  ])('refuses noncanonical mount root %s', (root) =>
    expect(() => parseManagedCsiMount(qualified, root)).toThrow(),
  );

  it('rejects invalid serial input without opening a mount', () => {
    expect(() => new ManagedCsiMount('/workspace', 'serial\n')).toThrow();
    expect(() => new ManagedCsiMount('/workspace', '../serial')).toThrow();
  });

  it.runIf(process.platform !== 'linux')(
    'permanently fences an unsupported host',
    async () => {
      const mount = new ManagedCsiMount('/workspace', '2zehn959sand8iuw2gyd');
      await expect(mount.observe()).rejects.toThrow(
        'Managed CSI mount is unavailable.',
      );
      expect(mount.isAvailable).toBe(false);
      expect(await mount.resolve('')).toBeUndefined();
    },
  );
});
