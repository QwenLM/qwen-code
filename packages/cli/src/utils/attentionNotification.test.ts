/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  notifyTerminalAttention,
  AttentionNotificationReason,
} from './attentionNotification.js';

describe('notifyTerminalAttention', () => {
  let stream: { write: ReturnType<typeof vi.fn>; isTTY: boolean };

  beforeEach(() => {
    stream = { write: vi.fn().mockReturnValue(true), isTTY: true };
  });

  it('emits terminal bell character', () => {
    const result = notifyTerminalAttention(
      AttentionNotificationReason.ToolApproval,
      {
        stream,
      },
    );

    expect(result).toBe(true);
    expect(stream.write).toHaveBeenCalledWith('\u0007');
  });

  it('returns false when not running inside a tty', () => {
    stream.isTTY = false;

    const result = notifyTerminalAttention(
      AttentionNotificationReason.ToolApproval,
      { stream },
    );

    expect(result).toBe(false);
    expect(stream.write).not.toHaveBeenCalled();
  });

  it('returns false when stream write fails', () => {
    stream.write = vi.fn().mockImplementation(() => {
      throw new Error('Write failed');
    });

    const result = notifyTerminalAttention(
      AttentionNotificationReason.ToolApproval,
      { stream },
    );

    expect(result).toBe(false);
  });

  it('works with different notification reasons', () => {
    const reasons = [
      AttentionNotificationReason.ToolApproval,
      AttentionNotificationReason.LongTaskComplete,
    ];

    reasons.forEach((reason) => {
      stream.write.mockClear();

      const result = notifyTerminalAttention(reason, { stream });

      expect(result).toBe(true);
      expect(stream.write).toHaveBeenCalledWith('\u0007');
    });
  });
});
