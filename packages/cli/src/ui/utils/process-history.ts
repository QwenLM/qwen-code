/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolCallStatus, type HistoryItem } from '../types.js';
import { isCollapsibleTool } from './tool-group-summary.js';
import { ToolDisplayNames } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import { SHELL_COMMAND_NAME } from '../constants.js';
import { isShellResultDisplay } from '@qwen-code/qwen-code-core/utils/shell-result.js';

export interface ProcessHistoryItem {
  type: 'process';
  id: number;
  members: HistoryItem[];
}

export function isProcessToolGroup(item: HistoryItem): boolean {
  return (
    item.type === 'tool_group' &&
    !item.isUserInitiated &&
    item.tools.length > 0 &&
    item.tools.every(
      (tool) =>
        tool.status === ToolCallStatus.Success &&
        !tool.confirmationDetails &&
        !tool.images?.length &&
        !tool.omittedImageCount &&
        !tool.visionBridgeNotice &&
        !tool.isMemoryOp &&
        (isCollapsibleTool(tool.name) ||
          tool.name === ToolDisplayNames.SHELL ||
          tool.name === SHELL_COMMAND_NAME) &&
        (tool.resultDisplay == null ||
          typeof tool.resultDisplay === 'string' ||
          'ansiOutput' in tool.resultDisplay ||
          (isShellResultDisplay(tool.resultDisplay) &&
            tool.resultDisplay.outcome === 'completed' &&
            tool.resultDisplay.exitCode === 0 &&
            !tool.resultDisplay.error &&
            tool.resultDisplay.notices.length === 0 &&
            !tool.resultDisplay.truncated &&
            tool.resultDisplay.outputFiles.length === 0)),
    )
  );
}

/** A display projection only; member references and canonical history survive. */
export function projectProcessHistory(
  items: HistoryItem[],
): Array<HistoryItem | ProcessHistoryItem> {
  const projected: Array<HistoryItem | ProcessHistoryItem> = [];
  let run: HistoryItem[] = [];
  const flush = () => {
    let lastTool = run.findLastIndex(isProcessToolGroup);
    // Thoughts after the last operation still belong to its process. Text
    // after it is the answer until a subsequent tool establishes otherwise.
    while (
      lastTool >= 0 &&
      (run[lastTool + 1]?.type === 'gemini_thought' ||
        run[lastTool + 1]?.type === 'gemini_thought_content')
    ) {
      lastTool++;
    }
    if (lastTool > 0) {
      projected.push({
        type: 'process',
        id: run[0].id,
        members: run.slice(0, lastTool + 1),
      });
      projected.push(...run.slice(lastTool + 1));
    } else {
      projected.push(...run);
    }
    run = [];
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.id > 0 && item.type === 'gemini') {
      const textBlock: Array<
        Extract<HistoryItem, { type: 'gemini' | 'gemini_content' }>
      > = [item];
      let end = index + 1;
      let continuation = items[end];
      while (continuation?.id > 0 && continuation.type === 'gemini_content') {
        textBlock.push(continuation);
        end++;
        continuation = items[end];
      }
      if (
        textBlock.every(
          (part) => !part.images?.length && !part.omittedImageCount,
        )
      ) {
        run.push(...textBlock);
      } else {
        flush();
        projected.push(...textBlock);
      }
      index = end - 1;
    } else if (
      item.id > 0 &&
      (isProcessToolGroup(item) ||
        ((item.type === 'gemini_thought' ||
          item.type === 'gemini_thought_content') &&
          !item.isStreaming))
    ) {
      run.push(item);
    } else {
      flush();
      projected.push(item);
    }
  }
  flush();
  return projected;
}
