/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Part } from '@google/genai';
import { getToolResponseDisplayText } from '@qwen-code/qwen-code-core/utils/generateContentResponseUtilities.js';
import { isAnyAutoMemPath } from '@qwen-code/qwen-code-core/memory/paths.js';
import { canonicalToolName } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import { isVisionBridgeNoticeDisplay } from '@qwen-code/qwen-code-core/services/visionBridge/vision-bridge-service.js';
import { collectInlineImages } from '../utils/inline-image-parts.js';

export interface ToolResultPresentation {
  hasNotice?: boolean;
  detailedDisplay?: string;
  imageMimeTypes?: string[];
  omittedImageCount?: number;
  isSubagent?: boolean;
  isMemoryOp?: 'read' | 'write';
}

export function toolResultPresentation(
  resultDisplay: unknown,
  responseParts?: Part[],
  request?: { name?: string; args?: unknown },
  projectRoot?: string,
  isError = false,
): ToolResultPresentation {
  const result: ToolResultPresentation = {};
  if (isVisionBridgeNoticeDisplay(resultDisplay)) result.hasNotice = true;
  const canonicalName = canonicalToolName(request?.name ?? '');
  const name =
    typeof canonicalName === 'string' ? canonicalName : request?.name;
  if (
    ['read_file', 'grep_search', 'glob', 'list_directory'].includes(name ?? '')
  ) {
    const detailed = getToolResponseDisplayText(responseParts);
    if (detailed) result.detailedDisplay = detailed;
  }
  const images = collectInlineImages(responseParts);
  if (images.images.length)
    result.imageMimeTypes = images.images.map((image) => image.mimeType);
  if (images.omittedImageCount)
    result.omittedImageCount = images.omittedImageCount;
  if (
    resultDisplay &&
    typeof resultDisplay === 'object' &&
    'type' in resultDisplay &&
    resultDisplay.type === 'task_execution'
  )
    result.isSubagent = true;
  const args = request?.args;
  if (
    !isError &&
    projectRoot &&
    args &&
    typeof args === 'object' &&
    'file_path' in args &&
    typeof args.file_path === 'string' &&
    isAnyAutoMemPath(path.resolve(args.file_path), projectRoot)
  ) {
    if (name === 'read_file') result.isMemoryOp = 'read';
    else if (name === 'write_file' || name === 'edit')
      result.isMemoryOp = 'write';
  }
  return result;
}
