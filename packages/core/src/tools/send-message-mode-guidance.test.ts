/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { SendMessageTool } from './send-message.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import { SHARED_RECORD_SLOT } from '../services/session-registry.js';
import type { Config } from '../config/config.js';

vi.mock('../ipc/peer-send.js', () => ({
  sendToPeer: vi.fn(async () => ({ kind: 'disabled' })),
}));

const settingExplanation = 'this session publishes no peer inbox address';

function makeConfig(mode: string, hasTeam: boolean): Config {
  return {
    getTeamManager: () =>
      hasTeam
        ? {
            getTeamFile: () => ({ members: [{ name: 'alice' }] }),
            sendMessage: vi
              .fn()
              .mockRejectedValue(new Error('Teammate "docs-cd" not found.')),
          }
        : null,
    getBackgroundTaskRegistry: () => new BackgroundTaskRegistry(),
    getApprovalMode: () => 'default',
    getSessionRegistrySlot: () => SHARED_RECORD_SLOT,
    getToolRegistry: () => ({ getAllToolNames: () => [] }),
    isSafeMode: () => mode === 'safe-mode',
  } as unknown as Config;
}

describe.each([false, true])(
  'disabled peer messaging with team=%s',
  (hasTeam) => {
    it.each(['safe-mode'])(
      'explains %s suppression when the target cannot be reached',
      async (mode) => {
        const result = await new SendMessageTool(makeConfig(mode, hasTeam))
          .build({ to: 'docs-cd', message: 'hello' })
          .execute(new AbortController().signal);
        expect(result.error).toBeDefined();
        expect(result.llmContent).toContain(`--${mode}`);
        expect(result.llmContent).toContain('QWEN_CODE_SAFE_MODE');
        expect(result.llmContent).toContain(
          'agents.crossSessionMessaging may also be off',
        );
        expect(result.llmContent).not.toContain(settingExplanation);
        expect(result.llmContent).toContain(
          hasTeam ? 'Teammate "docs-cd" not found.' : 'No active team',
        );
      },
    );

    it('reports the absent inbox without inventing a disabled setting', async () => {
      const result = await new SendMessageTool(makeConfig('normal', hasTeam))
        .build({ to: 'docs-cd', message: 'hello' })
        .execute(new AbortController().signal);
      expect(result.error).toBeDefined();
      expect(result.llmContent).toContain(settingExplanation);
      expect(result.llmContent).not.toContain(
        'agents.crossSessionMessaging is off',
      );
      expect(result.llmContent).not.toContain('inbox did not start');
      expect(result.llmContent).not.toContain('no peer inbox is bound');
      expect(result.llmContent).not.toContain('--safe-mode');
      expect(result.llmContent).not.toContain('--bare');
    });
  },
);
