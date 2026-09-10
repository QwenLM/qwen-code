/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Part } from '@google/genai';
import { getToolResponseDisplayText } from '@qwen-code/qwen-code-core/utils/generateContentResponseUtilities.js';
import { isAnyAutoMemPath } from '@qwen-code/qwen-code-core/memory/paths.js';
import { collectInlineImages } from '../utils/inline-image-parts.js';

export interface ToolResultPresentation {
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
  if (
    ['read_file', 'grep_search', 'glob', 'list_directory'].includes(
      request?.name ?? '',
    )
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
    isAnyAutoMemPath(path.resolve(projectRoot, args.file_path), projectRoot)
  ) {
    if (request?.name === 'read_file') result.isMemoryOp = 'read';
    else if (request?.name === 'write_file' || request?.name === 'edit')
      result.isMemoryOp = 'write';
  }
  return result;
}
