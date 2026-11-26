/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DateChangeAttachment } from '../models/system-attachments.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentToolUseContext } from '../types.js';
import { getDateChangeAttachments } from './system-generators.js';
import type { Config } from '../../config/config.js';
import { createAttachmentMessage } from '../factory.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('getDateChangeAttachments', () => {
  function createContext(startupDate?: string): AttachmentToolUseContext {
    const ctx = {} as AttachmentToolUseContext;
    if (startupDate) {
      ctx.config = {
        getMemoryContextManager: () => ({
          getStartupDate: () => startupDate,
        }),
      } as unknown as Config;
    }
    return ctx;
  }

  it('does not duplicate the date already present in startup context', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 10, 12, 0, 0));

    const ctx = createContext('2026-09-10');

    await expect(getDateChangeAttachments(ctx)).resolves.toEqual([]);
  });

  it('emits on the first turn when a long-lived context has a stale startup date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));

    const ctx = createContext('2026-09-03');

    const attachments = await getDateChangeAttachments(ctx);
    expect(attachments).toEqual([
      { type: 'date_change', newDate: '2026-09-15' },
    ]);
    await expect(
      getDateChangeAttachments(ctx, attachments.map(createAttachmentMessage)),
    ).resolves.toEqual([]);
  });

  it('does not repeat a date present in model-visible history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));

    const ctx = createContext('2026-09-03');
    const messages = [
      createAttachmentMessage(
        new DateChangeAttachment({
          type: 'date_change',
          newDate: '2026-09-15',
        }),
      ),
    ];

    await expect(getDateChangeAttachments(ctx, messages)).resolves.toEqual([]);
  });

  it('re-emits when compaction discarded the visible date attachment', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));

    const ctx = createContext('2026-09-03');
    ctx.lastDateSeen = '2026-09-15';

    await expect(getDateChangeAttachments(ctx, [])).resolves.toEqual([
      { type: 'date_change', newDate: '2026-09-15' },
    ]);
  });

  it('emits one date change after the local calendar crosses midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 10, 23, 59, 59));
    const ctx = createContext('2026-09-10');

    await expect(getDateChangeAttachments(ctx)).resolves.toEqual([]);

    vi.setSystemTime(new Date(2026, 8, 11, 0, 0, 0));
    const attachments = await getDateChangeAttachments(ctx);
    expect(attachments).toEqual([
      { type: 'date_change', newDate: '2026-09-11' },
    ]);
    await expect(
      getDateChangeAttachments(ctx, attachments.map(createAttachmentMessage)),
    ).resolves.toEqual([]);
  });

  it('preserves first-turn behavior when startup context is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 10, 23, 59, 59));
    const ctx = createContext();

    await expect(getDateChangeAttachments(ctx)).resolves.toEqual([]);

    vi.setSystemTime(new Date(2026, 8, 11, 0, 0, 0));
    await expect(getDateChangeAttachments(ctx)).resolves.toEqual([
      { type: 'date_change', newDate: '2026-09-11' },
    ]);
  });
});
