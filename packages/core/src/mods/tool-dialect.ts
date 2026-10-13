/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '../tools/tool-names.js';
import { record, type ModEvent, type ModInput } from './dispatch.js';
import { MOD_TOOL_RESERVED } from './tool-events.js';
import type { ModToolDialect } from './types.js';

const contracts: Record<string, { tool: string; fields: string[] }> = {
  [ToolNames.SHELL]: { tool: 'Bash', fields: ['command'] },
  [ToolNames.EDIT]: {
    tool: 'Edit',
    fields: ['file_path', 'old_string', 'new_string', 'replace_all'],
  },
  [ToolNames.WRITE_FILE]: { tool: 'Write', fields: ['file_path', 'content'] },
};

const pick = (value: ModInput, keys: readonly string[]): ModInput =>
  Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );

export function modToolInputView(
  event: ModEvent,
  input: ModInput,
  dialect?: ModToolDialect,
  builtinTool?: string,
):
  | { input: ModInput; toNativeInput: (value: ModInput) => ModInput }
  | undefined {
  if (dialect !== 'claude' || (event !== 'tool.call' && event !== 'tool.check'))
    return { input, toNativeInput: (value) => value };
  const tool = input['tool'];
  if (
    typeof tool !== 'string' ||
    tool !== builtinTool ||
    !Object.hasOwn(contracts, tool)
  )
    return undefined;
  const contract = contracts[tool];
  if (event === 'tool.check') {
    if (!record(input['input'])) return undefined;
    return {
      input: {
        ...input,
        tool: contract.tool,
        input: pick(input['input'], contract.fields),
      },
      toNativeInput: () => input,
    };
  }
  const keys = [...MOD_TOOL_RESERVED, ...contract.fields];
  return {
    input: { ...pick(input, keys), tool: contract.tool },
    toNativeInput: (value) => {
      const unsupported = Object.keys(value).find((key) => !keys.includes(key));
      if (unsupported !== undefined)
        throw new Error(
          `Unsupported Claude tool.call field for ${contract.tool}: ${unsupported.slice(0, 64)}.`,
        );
      const native = { ...input };
      for (const key of contract.fields) delete native[key];
      return { ...native, ...pick(value, contract.fields) };
    },
  };
}
