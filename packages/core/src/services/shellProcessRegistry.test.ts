/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ShellProcessRegistry } from './shellProcessRegistry.js';

describe('ShellProcessRegistry', () => {
  beforeEach(() => {
    ShellProcessRegistry.resetInstance();
  });

  describe('register', () => {
    it('should auto-assign sequential IDs', () => {
      const registry = ShellProcessRegistry.getInstance();
      const p1 = registry.register({
        id: '',
        command: 'npm run dev',
        pid: 100,
        workingDirectory: '/project',
      });
      const p2 = registry.register({
        id: '',
        command: 'tail -f logs',
        pid: 200,
        workingDirectory: '/project',
      });
      expect(p1.id).toBe('shell_1');
      expect(p2.id).toBe('shell_2');
    });

    it('should set initial status to running', () => {
      const registry = ShellProcessRegistry.getInstance();
      const p = registry.register({
        id: '',
        command: 'test',
        pid: 1,
        workingDirectory: '/',
      });
      expect(p.status).toBe('running');
    });
  });

  describe('getProcess', () => {
    it('should return undefined for non-existent process', () => {
      const registry = ShellProcessRegistry.getInstance();
      expect(registry.getProcess('shell_999')).toBeUndefined();
    });

    it('should return registered process', () => {
      const registry = ShellProcessRegistry.getInstance();
      const p = registry.register({
        id: '',
        command: 'test',
        pid: 1,
        workingDirectory: '/',
      });
      expect(registry.getProcess(p.id)).toBe(p);
    });
  });

  describe('listProcesses', () => {
    it('should return all processes', () => {
      const registry = ShellProcessRegistry.getInstance();
      registry.register({
        id: '',
        command: 'a',
        pid: 1,
        workingDirectory: '/',
      });
      registry.register({
        id: '',
        command: 'b',
        pid: 2,
        workingDirectory: '/',
      });
      expect(registry.listProcesses()).toHaveLength(2);
    });

    it('should filter by status', () => {
      const registry = ShellProcessRegistry.getInstance();
      registry.register({
        id: '',
        command: 'a',
        pid: 1,
        workingDirectory: '/',
      });
      registry.register({
        id: '',
        command: 'b',
        pid: 2,
        workingDirectory: '/',
      });
      expect(registry.listProcesses(['running'])).toHaveLength(2);
    });
  });

  describe('updateOutput', () => {
    it('should append output', () => {
      const registry = ShellProcessRegistry.getInstance();
      const p = registry.register({
        id: '',
        command: 'test',
        pid: 1,
        workingDirectory: '/',
      });
      registry.updateOutput(p.id, 'line1\n');
      registry.updateOutput(p.id, 'line2\n');
      expect(registry.getProcess(p.id)!.output).toContain('line1');
      expect(registry.getProcess(p.id)!.output).toContain('line2');
    });

    it('should trim output exceeding 1MB', () => {
      const registry = ShellProcessRegistry.getInstance();
      const p = registry.register({
        id: '',
        command: 'test',
        pid: 1,
        workingDirectory: '/',
      });
      const largeOutput = 'A'.repeat(1_000_001);
      registry.updateOutput(p.id, largeOutput);
      expect(registry.getProcess(p.id)!.output.length).toBeLessThanOrEqual(
        1_000_000,
      );
    });
  });

  describe('killProcess', () => {
    it('should return false for non-existent process', async () => {
      const registry = ShellProcessRegistry.getInstance();
      expect(await registry.killProcess('shell_999')).toBe(false);
    });

    it('should return false for already killed process', async () => {
      const registry = ShellProcessRegistry.getInstance();
      const p = registry.register({
        id: '',
        command: 'test',
        pid: undefined, // No PID — should mark as killed immediately
        workingDirectory: '/',
      });
      expect(await registry.killProcess(p.id)).toBe(true);
      expect(await registry.killProcess(p.id)).toBe(false);
    });
  });

  describe('getRecentOutput', () => {
    it('should return last N lines', () => {
      const registry = ShellProcessRegistry.getInstance();
      const p = registry.register({
        id: '',
        command: 'test',
        pid: 1,
        workingDirectory: '/',
      });
      registry.updateOutput(p.id, 'a\nb\nc\nd\ne\n');
      expect(registry.getRecentOutput(p.id, 2)).toBe('d\ne');
    });

    it('should return empty string for non-existent process', () => {
      const registry = ShellProcessRegistry.getInstance();
      expect(registry.getRecentOutput('shell_999')).toBe('');
    });
  });

  describe('formatRuntime', () => {
    it('should return undefined for non-existent process', () => {
      const registry = ShellProcessRegistry.getInstance();
      expect(registry.formatRuntime('shell_999')).toBeUndefined();
    });

    it('should return formatted time', () => {
      const registry = ShellProcessRegistry.getInstance();
      registry.register({
        id: '',
        command: 'test',
        pid: 1,
        workingDirectory: '/',
      });
      const runtime = registry.formatRuntime('shell_1');
      expect(runtime).toBeDefined();
      expect(runtime).toMatch(/\d+s/);
    });
  });

  describe('getStats', () => {
    it('should return accurate counts', () => {
      const registry = ShellProcessRegistry.getInstance();
      registry.register({
        id: '',
        command: 'a',
        pid: 1,
        workingDirectory: '/',
      });
      registry.register({
        id: '',
        command: 'b',
        pid: 2,
        workingDirectory: '/',
      });
      const stats = registry.getStats();
      expect(stats.total).toBe(2);
      expect(stats.running).toBe(2);
      expect(stats.killed).toBe(0);
    });
  });

  describe('test environment isolation', () => {
    it('should reset instance between tests', () => {
      const r1 = ShellProcessRegistry.getInstance();
      r1.register({ id: '', command: 'a', pid: 1, workingDirectory: '/' });
      // In test env, getInstance() should reset, so a fresh call sees empty state
      const r2 = ShellProcessRegistry.getInstance();
      expect(r2.listProcesses()).toHaveLength(0);
    });
  });
});
