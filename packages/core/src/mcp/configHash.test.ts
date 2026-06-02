/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { MCPServerConfig } from '../config/config.js';
import { hashMcpServerConfig } from './configHash.js';

describe('hashMcpServerConfig', () => {
  it('returns a stable 16-char hex digest', () => {
    const hash = hashMcpServerConfig({ command: 'node', args: ['server.js'] });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical configs', () => {
    const config: MCPServerConfig = {
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'abc' },
    };
    expect(hashMcpServerConfig(config)).toBe(
      hashMcpServerConfig({ ...config }),
    );
  });

  it('is independent of object key order (top level and nested)', () => {
    const a = hashMcpServerConfig({
      command: 'node',
      env: { A: '1', B: '2' },
      headers: { X: 'x', Y: 'y' },
    });
    const b = hashMcpServerConfig({
      headers: { Y: 'y', X: 'x' },
      env: { B: '2', A: '1' },
      command: 'node',
    });
    expect(a).toBe(b);
  });

  it('treats an absent field and an explicit-undefined field the same', () => {
    const a = hashMcpServerConfig({ command: 'node' });
    const b = hashMcpServerConfig({ command: 'node', url: undefined });
    expect(a).toBe(b);
  });

  describe('provenance / cosmetic fields are excluded', () => {
    const base: MCPServerConfig = { command: 'node', args: ['server.js'] };

    it.each(['scope', 'extensionName', 'description'] as const)(
      'ignores changes to %s',
      (field) => {
        const withField = hashMcpServerConfig({
          ...base,
          [field]: 'something',
        } as MCPServerConfig);
        expect(withField).toBe(hashMcpServerConfig(base));
      },
    );

    it('still hashes a nested user key named "description" inside env', () => {
      const a = hashMcpServerConfig({
        command: 'node',
        env: { description: 'one' },
      });
      const b = hashMcpServerConfig({
        command: 'node',
        env: { description: 'two' },
      });
      expect(a).not.toBe(b);
    });
  });

  describe('behavioral changes change the hash', () => {
    const base: MCPServerConfig = {
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'abc' },
    };
    const baseHash = hashMcpServerConfig(base);

    it('command', () => {
      expect(hashMcpServerConfig({ ...base, command: 'python' })).not.toBe(
        baseHash,
      );
    });

    it('args value', () => {
      expect(hashMcpServerConfig({ ...base, args: ['other.js'] })).not.toBe(
        baseHash,
      );
    });

    it('args order (order is behavioral)', () => {
      const x = hashMcpServerConfig({ command: 'node', args: ['a', 'b'] });
      const y = hashMcpServerConfig({ command: 'node', args: ['b', 'a'] });
      expect(x).not.toBe(y);
    });

    it('env value', () => {
      expect(hashMcpServerConfig({ ...base, env: { TOKEN: 'xyz' } })).not.toBe(
        baseHash,
      );
    });

    it('trust flag', () => {
      expect(hashMcpServerConfig({ ...base, trust: true })).not.toBe(baseHash);
    });

    it('remote url', () => {
      expect(hashMcpServerConfig({ url: 'https://a.example' })).not.toBe(
        hashMcpServerConfig({ url: 'https://b.example' }),
      );
    });

    it('headers', () => {
      expect(
        hashMcpServerConfig({
          httpUrl: 'https://a.example',
          headers: { Authorization: 'one' },
        }),
      ).not.toBe(
        hashMcpServerConfig({
          httpUrl: 'https://a.example',
          headers: { Authorization: 'two' },
        }),
      );
    });
  });
});
