/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import type { ModelStreamTool } from '../../provider/modelStreamRequest.js';
import { sanitizeToolName } from '../../utils/tool-name-utils.js';
import { isRecord } from '../../utils/markdownUtils.js';

/** 从宿主工具注册表生成标准模型工具声明，不创建协议包装。 */
export function buildModelStreamTools(
  declarations: readonly FunctionDeclaration[],
): ModelStreamTool[] {
  return declarations.map((fd) => ({
    name: sanitizeToolName(fd.name ?? ''),
    description: fd.description ?? '',
    parameters: readParametersJsonSchema(fd.parametersJsonSchema),
  }));
}

function readParametersJsonSchema(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  return { type: 'object', properties: {} };
}
