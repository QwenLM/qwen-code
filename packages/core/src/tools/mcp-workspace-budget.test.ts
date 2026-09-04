/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { McpBudgetEvent } from './mcp-client-manager.js';
import { WorkspaceMcpBudget } from './mcp-workspace-budget.js';

describe('WorkspaceMcpBudget', () => {
  describe('tryReserve', () => {
    it('returns reserved on first acquire of a name', () => {
      const budget = new WorkspaceMcpBudget({
        clientBudget: 3,
        mode: 'enforce',
      });
      expect(budget.tryReserve('foo')).toBe('reserved');
      expect(budget.getReservedCount()).toBe(1);
    });

    it('returns already_held on second acquire of same name', () => {
      const budget = new WorkspaceMcpBudget({
        clientBudget: 3,
        mode: 'enforce',
      });
      budget.tryReserve('foo');
      expect(budget.tryReserve('foo')).toBe('already_held');
      expect(budget.getReservedCount()).toBe(1);
    });

    it('returns refused under enforce mode when cap is full', () => {
      const budget = new WorkspaceMcpBudget({
        clientBudget: 2,
        mode: 'enforce',
      });
      expect(budget.tryReserve('a')).toBe('reserved');
      expect(budget.tryReserve('b')).toBe('reserved');
      expect(budget.tryReserve('c')).toBe('refused');
      expect(budget.getReservedCount()).toBe(2);
    });

    it('still reserves under warn mode past cap (measure-only)', () => {
      const budget = new WorkspaceMcpBudget({ clientBudget: 2, mode: 'warn' });
      budget.tryReserve('a');
      budget.tryReserve('b');
      expect(budget.tryReserve('c')).toBe('reserved');
      expect(budget.getReservedCount()).toBe(3);
    });

    it('off mode is a no-op (no slot tracked)', () => {
      const budget = new WorkspaceMcpBudget({ clientBudget: 1, mode: 'off' });
      expect(budget.tryReserve('a')).toBe('reserved');
      expect(budget.getReservedCount()).toBe(0);
    });
  });

  describe('release', () => {
    it('clears the slot and returns true if held', () => {
      const budget = new WorkspaceMcpBudget({
        clientBudget: 2,
        mode: 'enforce',
      });
      budget.tryReserve('foo');
      expect(budget.release('foo')).toBe(true);
      expect(budget.getReservedCount()).toBe(0);
    });

    it('returns false if not held (idempotent)', () => {
      const budget = new WorkspaceMcpBudget({
        clientBudget: 2,
        mode: 'enforce',
      });
      expect(budget.release('never-reserved')).toBe(false);
    });

    it('frees capacity for a fresh reservation', () => {
      const budget = new WorkspaceMcpBudget({
        clientBudget: 2,
        mode: 'enforce',
      });
      budget.tryReserve('a');
      budget.tryReserve('b');
      expect(budget.tryReserve('c')).toBe('refused');
      budget.release('a');
      expect(budget.tryReserve('c')).toBe('reserved');
    });
  });

  describe('hysteresis warning', () => {
    it('fires once on upward 75% crossing', () => {
      const onEvent = vi.fn();
      const budget = new WorkspaceMcpBudget({
        clientBudget: 4,
        mode: 'enforce',
        onEvent,
      });
      budget.tryReserve('a'); // 25% — no fire
      budget.tryReserve('b'); // 50% — no fire
      expect(onEvent).not.toHaveBeenCalled();
      budget.tryReserve('c'); // 75% — fires
      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
        kind: 'budget_warning',
        reservedCount: 3,
        budget: 4,
        thresholdRatio: 0.75,
      });
    });

    it('does not re-fire while above threshold', () => {
      const onEvent = vi.fn();
      const budget = new WorkspaceMcpBudget({
        clientBudget: 4,
        mode: 'enforce',
        onEvent,
      });
      budget.tryReserve('a');
      budget.tryReserve('b');
      budget.tryReserve('c'); // 75% — fires once
      budget.tryReserve('d'); // 100% — no fire
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('re-arms only after dropping below 37.5%', () => {
      const onEvent = vi.fn();
      const budget = new WorkspaceMcpBudget({
        clientBudget: 4,
        mode: 'enforce',
        onEvent,
      });
      budget.tryReserve('a');
      budget.tryReserve('b');
      budget.tryReserve('c'); // 75% — fires
      budget.release('a'); // 50% — still over 37.5%, doesn't re-arm
      budget.release('b'); // 25% — drops below 37.5%, re-arms
      budget.tryReserve('a'); // 50% — armed but below 75%, no fire
      budget.tryReserve('b'); // 75% — fires again
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('off mode is a hard no-op (no events ever)', () => {
      const onEvent = vi.fn();
      const budget = new WorkspaceMcpBudget({
        clientBudget: 1,
        mode: 'off',
        onEvent,
      });
      budget.tryReserve('a');
      budget.tryReserve('b');
      budget.tryReserve('c');
      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe('refused batch coalescing', () => {
    it('coalesces per-pass refusals into one refused_batch event', () => {
      const onEvent = vi.fn();
      const budget = new WorkspaceMcpBudget({
        clientBudget: 1,
        mode: 'enforce',
        onEvent,
      });
      budget.beginBulkPass();
      budget.tryReserve('a'); // reserved
      onEvent.mockClear(); // ignore the warning event from a's reservation
      budget.tryReserve('b'); // refused
      budget.recordRefusal('b', 'stdio');
      budget.tryReserve('c'); // refused
      budget.recordRefusal('c', 'sse');
      budget.tryReserve('d'); // refused
      budget.recordRefusal('d', 'stdio');
      // No event yet — bulk pass open.
      expect(onEvent).not.toHaveBeenCalled();
      budget.endBulkPass();
      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
        kind: 'refused_batch',
        budget: 1,
        mode: 'enforce',
      });
      const batchEvent = onEvent.mock.calls[0]?.[0] as McpBudgetEvent & {
        refusedServers: Array<{ name: string; transport: string }>;
      };
      expect(batchEvent.refusedServers.map((r) => r.name)).toEqual([
        'b',
        'c',
        'd',
      ]);
    });

    it('exposes refused names via getRefusedServerNames', () => {
      const budget = new WorkspaceMcpBudget({
        clientBudget: 1,
        mode: 'enforce',
      });
      budget.beginBulkPass();
      budget.tryReserve('a');
      budget.recordRefusal('b', 'stdio');
      budget.recordRefusal('c', 'stdio');
      budget.endBulkPass();
      expect(budget.getRefusedServerNames()).toEqual(['b', 'c']);
    });

    it('clears refused names at start of next bulk pass', () => {
      const budget = new WorkspaceMcpBudget({
        clientBudget: 1,
        mode: 'enforce',
      });
      budget.beginBulkPass();
      budget.tryReserve('a');
      budget.recordRefusal('b', 'stdio');
      budget.endBulkPass();
      expect(budget.getRefusedServerNames()).toEqual(['b']);
      budget.beginBulkPass();
      // Snapshot path between begin and end should see empty.
      expect(budget.getRefusedServerNames()).toEqual([]);
      budget.endBulkPass();
    });
  });

  describe('getters', () => {
    it('reports configured mode + budget unchanged', () => {
      const budget = new WorkspaceMcpBudget({ clientBudget: 5, mode: 'warn' });
      expect(budget.getMode()).toBe('warn');
      expect(budget.getBudget()).toBe(5);
    });

    it('returns fresh array from getReservedSlots', () => {
      const budget = new WorkspaceMcpBudget({
        clientBudget: 3,
        mode: 'enforce',
      });
      budget.tryReserve('a');
      budget.tryReserve('b');
      const snap = budget.getReservedSlots();
      snap.push('mutate-me');
      expect(budget.getReservedSlots()).toEqual(['a', 'b']);
    });
  });
});
