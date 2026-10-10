/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { IdeClient } from '../ide/ide-client.js';
import type { ToolCallConfirmationDetails } from '../tools/tools.js';
import { CoreToolScheduler } from './coreToolScheduler.js';

describe('execution environment IDE boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])(
    'opens host IDE diffs only for local execution (container=%s)',
    async (contained) => {
      const openDiff = vi.fn().mockResolvedValue({ status: 'rejected' });
      vi.spyOn(IdeClient, 'getInstance').mockResolvedValue({
        isDiffingEnabled: () => true,
        openDiff,
      } as unknown as IdeClient);
      const scheduler = new CoreToolScheduler({
        config: {
          getToolRegistry: () => undefined,
          getIdeMode: () => true,
          getExecutionEnvironment: () => (contained ? {} : undefined),
        } as unknown as Config,
        onAllToolCallsComplete: vi.fn(),
        onToolCallsUpdate: vi.fn(),
        getPreferredEditor: () => 'vscode',
        onEditorClose: vi.fn(),
      });
      const details: ToolCallConfirmationDetails = {
        type: 'edit',
        title: 'Worker edit',
        fileName: 'hosts',
        filePath: '/etc/hosts',
        fileDiff: 'worker diff',
        originalContent: 'worker original',
        newContent: 'worker updated',
        onConfirm: vi.fn(),
      };
      await (
        scheduler as unknown as {
          openIdeDiffIfEnabled(
            details: ToolCallConfirmationDetails,
            callId: string,
            signal: AbortSignal,
          ): Promise<void>;
        }
      ).openIdeDiffIfEnabled(
        details,
        'worker-call',
        new AbortController().signal,
      );
      if (contained) {
        expect(IdeClient.getInstance).not.toHaveBeenCalled();
        expect(openDiff).not.toHaveBeenCalled();
      } else {
        expect(openDiff).toHaveBeenCalledWith('/etc/hosts', 'worker updated');
      }
    },
  );
});
