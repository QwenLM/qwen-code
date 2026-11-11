/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SessionEnd closeout 窗口的取值语义：
 *
 * - 缺省 10s（与宿主门禁的静态超时同量级）；
 * - 配置了 SessionEnd hook 超时的会话按配置对齐（worker cleanup 同源预算），只升不降；
 * - windowMs 支持延迟求值——构造 closeout 时 Config 还没装配。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createSessionEndCloseout,
  DEFAULT_SESSION_END_CLOSEOUT_WINDOW_MS,
} from './sessionEndCloseout.js';

async function settle(): Promise<void> {
  await Promise.resolve();
}

describe('createSessionEndCloseout 窗口取值', () => {
  it('缺省窗口是 10s', async () => {
    vi.useFakeTimers();
    try {
      const closeout = createSessionEndCloseout({ sessionId: 's' });
      const opened = closeout.run(() => new Promise<void>(() => {}));
      await settle();
      vi.advanceTimersByTime(DEFAULT_SESSION_END_CLOSEOUT_WINDOW_MS - 1);
      expect(closeout.view()).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(closeout.view()).toBeNull();
      await settle();
      void opened;
    } finally {
      vi.useRealTimers();
    }
  });

  it('延迟求值的 windowMs 在开窗时解析，且不低于缺省窗口', async () => {
    vi.useFakeTimers();
    try {
      let configured = 30_000;
      const closeout = createSessionEndCloseout({
        sessionId: 's',
        windowMs: () => configured,
      });
      const task = closeout.run(() => new Promise<void>(() => {}));
      await settle();
      vi.advanceTimersByTime(30_000 - 1);
      expect(closeout.view()).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(closeout.view()).toBeNull();
      await settle();
      void task;

      // 配置值低于缺省时不降档。
      configured = 100;
      const small = createSessionEndCloseout({
        sessionId: 's2',
        windowMs: () => configured,
      });
      const smallTask = small.run(() => new Promise<void>(() => {}));
      await settle();
      vi.advanceTimersByTime(DEFAULT_SESSION_END_CLOSEOUT_WINDOW_MS - 1);
      expect(small.view()).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(small.view()).toBeNull();
      await settle();
      void smallTask;
    } finally {
      vi.useRealTimers();
    }
  });

  it('windowMs 返回 undefined 时用缺省 10s', async () => {
    vi.useFakeTimers();
    try {
      const closeout = createSessionEndCloseout({
        sessionId: 's',
        windowMs: () => undefined,
      });
      const task = closeout.run(() => new Promise<void>(() => {}));
      await settle();
      vi.advanceTimersByTime(DEFAULT_SESSION_END_CLOSEOUT_WINDOW_MS - 1);
      expect(closeout.view()).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(closeout.view()).toBeNull();
      await settle();
      void task;
    } finally {
      vi.useRealTimers();
    }
  });

  it('任务完成即关窗，不等窗口到点', async () => {
    vi.useFakeTimers();
    try {
      const closeout = createSessionEndCloseout({
        sessionId: 's',
        windowMs: () => 30_000,
      });
      const result = await closeout.run(async () => 'done');
      expect(result).toBe('done');
      expect(closeout.view()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
