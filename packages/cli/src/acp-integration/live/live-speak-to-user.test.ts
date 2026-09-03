/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  SPEAK_TO_USER_TOOL_NAME,
  SpeakToUserTool,
} from './live-speak-to-user.js';

describe('SpeakToUserTool', () => {
  it('uses the trusted Live permission path and forwards exact speech', async () => {
    const speak = vi.fn(async () => undefined);
    const tool = new SpeakToUserTool(speak);
    const invocation = tool.build({ message: '原样说出这句话。' });

    expect(tool.name).toBe(SPEAK_TO_USER_TOOL_NAME);
    expect(tool.description).toContain(
      'Automatic backend Qwen Code text is silent context',
    );
    await expect(invocation.getDefaultPermission()).resolves.toBe('allow');
    await expect(
      invocation.execute(new AbortController().signal),
    ).resolves.toMatchObject({ returnDisplay: 'Spoke to user' });
    expect(speak).toHaveBeenCalledWith('原样说出这句话。');
  });
});
