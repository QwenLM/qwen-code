/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  didWriteProjectContextFile,
  refreshMemoryAfterManagedWrite,
  refreshMemoryInstruction,
} from '@qwen-code/qwen-code-core/memory/refresh.js';
import type { CompletedToolCall } from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';

export async function observeInteractiveModTool(
  config: Config,
  call: CompletedToolCall,
  refreshContextFilesOnWrite: boolean,
): Promise<void> {
  if (call.request.isClientInitiated) return;
  const succeeded = call.response.executionStatus === 'success';
  // Native attempts can be retried or withheld by the Mod. Only the final
  // submitted result may contribute experience; local skill writes still protect.
  config
    .getLlmClient()
    ?.recordCompletedToolCall(call.request.name, call.request.args, {
      ...call.response,
      status: call.status,
      modelFacing: false,
    });
  const candidates = [
    {
      toolName: call.request.name,
      args: call.request.args,
      status: succeeded ? ('success' as const) : ('error' as const),
    },
  ];
  const refreshed = await refreshMemoryAfterManagedWrite(config, candidates, {
    logContext: 'interactive Mod native attempt',
  });
  if (
    !refreshed &&
    succeeded &&
    (call.request.name === 'save_memory' ||
      (refreshContextFilesOnWrite &&
        didWriteProjectContextFile(candidates, config.getProjectRoot())))
  ) {
    await refreshMemoryInstruction(config, {
      logContext: 'interactive Mod native attempt',
    });
  }
}
