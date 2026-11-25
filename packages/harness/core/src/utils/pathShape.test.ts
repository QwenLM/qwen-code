/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  classifyPathShape,
  isFsTouchUnsafePath,
  isLocallySuspiciousPath,
  isNetworkShapedPath,
  stripLocalDevicePrefix,
} from './pathShape.js';

describe('pathShape', () => {
  // ==========================================================================
  // Module invariant
  // ==========================================================================

  it('must have no imports so every layer can depend on it', () => {
    const source = readFileSync(
      new URL('./pathShape.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  // ==========================================================================
  // Axis 1: network
  //
  // Every case is asserted in BOTH sigils: windowsPathToPosixPath flips
  // `\\srv\share` to `//srv/share` at different points in different pipelines,
  // so the classifier must be spelling-agnostic.
  // ==========================================================================

  describe('network axis', () => {
    it.each([
      ['backslash UNC', '\\\\server\\share\\file.txt'],
      ['slash UNC', '//server/share/file.txt'],
      ['bare backslash host', '\\\\server'],
      ['bare slash host', '//server'],
      ['IPv4 host', '\\\\10.0.0.1\\share'],
      ['IPv4 host, slash', '//10.0.0.1/share'],
      ['IPv6 host', '\\\\[fe80::1]\\share'],
      ['loopback is NOT exempt', '\\\\127.0.0.1\\share'],
      ['loopback name is NOT exempt', '//localhost/share'],
      ['triple separator', '///server/share'],
      ['four separators', '\\\\\\\\server'],
      ['mixed sigil', '/\\server\\share'],
    ])('treats %s as network', (_label, input) => {
      expect(isNetworkShapedPath(input)).toBe(true);
    });

    it.each([
      ['extended UNC', '\\\\?\\UNC\\server\\share\\file.txt'],
      ['extended UNC, slash', '//?/UNC/server/share/file.txt'],
      ['extended UNC via device dot', '\\\\.\\UNC\\server\\share'],
    ])('treats %s as network despite the local device prefix', (_l, input) => {
      const shape = classifyPathShape(input);
      expect(shape.network).toMatchObject({ kind: 'network', via: 'uncDevice' });
      expect(shape.network.kind === 'network' && shape.network.host).toBe(
        'server',
      );
    });

    it.each([
      ['@SSL@ port', '\\\\host@SSL@443\\DavWWWRoot\\x'],
      ['@port@SSL', '//host@443@SSL/x'],
      ['DavWWWRoot marker', '\\\\host\\DavWWWRoot\\x'],
    ])('flags %s as WebDAV', (_label, input) => {
      const shape = classifyPathShape(input);
      expect(shape.network).toMatchObject({ kind: 'network', via: 'webdav' });
    });

    it.each([
      ['/net automount', '/net/fileserver/export/x'],
      ['/net host only', '/net/fileserver'],
    ])('flags %s as automount', (_label, input) => {
      const shape = classifyPathShape(input);
      expect(shape.network).toMatchObject({
        kind: 'network',
        via: 'automount',
        host: 'fileserver',
      });
    });

    it('normalizes the host for identity comparison', () => {
      // Windows ignores a trailing dot, so both spellings reach the same host.
      const dotted = classifyPathShape('\\\\Evil.COM.\\share');
      const plain = classifyPathShape('//evil.com/share');
      expect(dotted.network.kind === 'network' && dotted.network.host).toBe(
        'evil.com',
      );
      expect(plain.network.kind === 'network' && plain.network.host).toBe(
        'evil.com',
      );
    });

    it.each([
      ['plain relative', 'src/index.ts'],
      ['posix absolute', '/home/user/project/file.ts'],
      ['windows absolute', 'C:\\Users\\me\\file.ts'],
      ['single leading separator', '/tmp/data'],
      ['a directory merely named net', '/var/net/host/x'],
      ['cygdrive is single-separator', '/cygdrive/c/Users/me'],
      ['macOS volume is single-separator', '/Volumes/Data/x'],
    ])('treats %s as local', (_label, input) => {
      expect(isNetworkShapedPath(input)).toBe(false);
    });
  });

  // ==========================================================================
  // Local-mount exemptions
  // ==========================================================================

  describe('local mount exemptions', () => {
    it.each([
      ['wsl$ backslash', '\\\\wsl$\\Ubuntu\\home\\me', 'wsl'],
      ['wsl$ slash', '//wsl$/Ubuntu/home/me', 'wsl'],
      ['wsl.localhost backslash', '\\\\wsl.localhost\\Ubuntu\\home', 'wsl'],
      ['wsl.localhost slash', '//wsl.localhost/Ubuntu/home', 'wsl'],
      ['extended drive', '\\\\?\\C:\\project\\file.ts', 'devicePath'],
      ['extended drive, slash', '//?/C:/project/file.ts', 'devicePath'],
      [
        'volume GUID',
        '\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\x',
        'volumeGuid',
      ],
    ])('treats %s as a local mount', (_label, input, mount) => {
      const shape = classifyPathShape(input);
      expect(shape.network).toEqual({ kind: 'localMount', mount });
      expect(shape.local.kind).toBe('clean');
    });

    it('does not exempt a host that merely starts with the wsl sentinel', () => {
      // `\\wsl$evil\share` has no separator after the sentinel, so it is a host.
      expect(isNetworkShapedPath('\\\\wsl$evil\\share')).toBe(true);
      expect(isNetworkShapedPath('\\\\wsl.localhost.evil\\share')).toBe(true);
    });
  });

  // ==========================================================================
  // Axis 2: local suspicion
  // ==========================================================================

  describe('local suspicion axis', () => {
    it.each([
      ['alternate data stream', 'file.txt:Zone.Identifier', 'alternateDataStream'],
      ['ADS on an absolute path', 'C:\\x\\file.txt:hidden', 'alternateDataStream'],
      ['8.3 short name', 'C:\\PROGRA~1\\app.exe', 'shortName83'],
      ['device path', '\\\\.\\COM1', 'devicePath'],
      ['device path, unknown target', '\\\\?\\GLOBALROOT\\Device\\x', 'devicePath'],
      ['NT object prefix', '\\??\\C:\\x', 'ntObjectPath'],
      ['trailing dot', 'C:\\repo\\.git.', 'trailingDot'],
      ['trailing space', 'C:\\repo\\secret ', 'trailingDot'],
      ['three consecutive dots', 'C:\\a\\...\\b', 'consecutiveDots'],
      ['reserved device name', 'C:\\temp\\NUL', 'reservedDeviceName'],
      ['reserved name with extension', 'C:\\temp\\con.txt', 'reservedDeviceName'],
    ])('flags %s', (_label, input, reason) => {
      const shape = classifyPathShape(input);
      expect(shape.local.kind).toBe('suspicious');
      expect(
        shape.local.kind === 'suspicious' ? shape.local.reasons : [],
      ).toContain(reason);
    });

    it.each([
      ['plain relative', 'src/index.ts'],
      ['drive absolute', 'C:\\Users\\me\\file.ts'],
      ['relative dot segment', './src/index.ts'],
      ['parent segment', '../sibling/file.ts'],
      ['spread syntax in a filename', 'app/routes/[...slug]/page.tsx'],
      ['dotfile', '/home/me/.bashrc'],
      ['tilde without a digit', 'C:\\a\\backup~\\x'],
    ])('leaves %s clean', (_label, input) => {
      expect(isLocallySuspiciousPath(input)).toBe(false);
    });

    it('collects every reason instead of stopping at the first', () => {
      // Regression: the previous implementation returned on the first hit, so
      // the device-path branch was unreachable for `\\?\` inputs.
      const shape = classifyPathShape('\\\\?\\GLOBALROOT\\a\\file.txt:hidden');
      const reasons =
        shape.local.kind === 'suspicious' ? shape.local.reasons : [];
      expect(reasons).toContain('devicePath');
      expect(reasons).toContain('alternateDataStream');
    });
  });

  // ==========================================================================
  // The two axes must agree on overlapping prefixes
  // ==========================================================================

  describe('the two axes agree on overlapping prefixes', () => {
    it('extended UNC is network, not merely suspicious', () => {
      const shape = classifyPathShape('\\\\?\\UNC\\server\\share');
      expect(shape.network.kind).toBe('network');
      expect(shape.local.kind).toBe('clean');
    });

    it('extended local drive is neither network nor suspicious', () => {
      const shape = classifyPathShape('\\\\?\\C:\\project\\file.ts');
      expect(shape.network).toEqual({
        kind: 'localMount',
        mount: 'devicePath',
      });
      expect(shape.local.kind).toBe('clean');
    });

    it('an unvouched device path is local but suspicious', () => {
      const shape = classifyPathShape('\\\\.\\COM1');
      expect(shape.network.kind).toBe('local');
      expect(shape.local.kind).toBe('suspicious');
    });

    it('judges ADS on the canonical form, not the raw prefix', () => {
      // `\\?\C:\x` contains a colon at index 5; judging the raw string would
      // report a bogus alternate data stream.
      const shape = classifyPathShape('\\\\?\\C:\\x');
      expect(shape.canonical).toBe('C:\\x');
      expect(shape.local.kind).toBe('clean');
    });
  });

  // ==========================================================================
  // canonical / stripLocalDevicePrefix
  // ==========================================================================

  describe('stripLocalDevicePrefix', () => {
    it.each([
      ['\\\\?\\C:\\x', 'C:\\x'],
      ['//?/C:/x', 'C:/x'],
      ['\\\\?\\UNC\\srv\\share', '\\\\srv\\share'],
      ['//?/UNC/srv/share', '\\\\srv/share'],
      ['C:\\x', 'C:\\x'],
      ['/home/me/x', '/home/me/x'],
      ['\\\\srv\\share', '\\\\srv\\share'],
    ])('maps %s to %s', (input, expected) => {
      expect(stripLocalDevicePrefix(input)).toBe(expected);
    });

    it('leaves a volume GUID path intact', () => {
      // Stripping the prefix would yield a string that is not a usable path.
      const input = '\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\x';
      expect(stripLocalDevicePrefix(input)).toBe(input);
      expect(classifyPathShape(input).canonical).toBe(input);
    });
  });

  // ==========================================================================
  // isFsTouchUnsafePath
  // ==========================================================================

  describe('isFsTouchUnsafePath', () => {
    it.each([
      ['UNC', '\\\\server\\share'],
      ['UNC, slash', '//server/share'],
      ['extended UNC', '\\\\?\\UNC\\server\\share'],
      ['automount', '/net/host/x'],
      ['device path', '\\\\.\\COM1'],
      ['NT object path', '\\??\\C:\\x'],
    ])('refuses to touch %s', (_label, input) => {
      expect(isFsTouchUnsafePath(input)).toBe(true);
    });

    it.each([
      ['plain path', '/home/me/x'],
      ['drive path', 'C:\\x'],
      ['extended local drive', '\\\\?\\C:\\x'],
      ['wsl mount', '\\\\wsl$\\Ubuntu\\home'],
      // Comparison-defeating spellings are safe to stat: the risk is that a
      // name check is fooled, not that the call itself leaks.
      ['alternate data stream', 'file.txt:hidden'],
      ['short name', 'C:\\PROGRA~1\\x'],
    ])('allows touching %s', (_label, input) => {
      expect(isFsTouchUnsafePath(input)).toBe(false);
    });
  });

  // ==========================================================================
  // Sigil
  // ==========================================================================

  describe('sigil', () => {
    it.each([
      ['\\\\server\\share', 'backslash'],
      ['//server/share', 'slash'],
      ['/\\server\\share', 'mixed'],
      ['C:\\x', 'backslash'],
      ['/home/me', 'slash'],
      ['C:/mixed\\path', 'mixed'],
      ['filename.txt', 'none'],
    ])('reports %s as %s', (input, expected) => {
      expect(classifyPathShape(input).sigil).toBe(expected);
    });
  });
});
