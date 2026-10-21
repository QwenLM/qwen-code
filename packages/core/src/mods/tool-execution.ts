/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import type { Config } from '../config/config.js';
import type { CompletedToolCall } from '../core/coreToolScheduler.js';
import type {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '../core/turn.js';
import {
  ToolNames,
  canonicalToolName,
  resolveRegisteredToolName,
} from '../tools/tool-names.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { MOD_MAX_BYTES } from './types.js';
import { record, validateInput } from './dispatch.js';
import {
  MOD_TOOL_RESERVED,
  type ModToolCall,
  type ModToolCallInput,
  type ModToolCheck,
  type ModToolResult,
} from './tool-events.js';

export async function modToolRequest(
  config: Config,
  request: ToolCallRequestInfo,
): Promise<ToolCallRequestInfo | undefined> {
  const name = canonicalToolName(request.name);
  if (
    request.goalContext ||
    name === ToolNames.STRUCTURED_OUTPUT ||
    name === ToolNames.TOOL_SEARCH ||
    name === ToolNames.SEARCH_MEMORY ||
    request.executionOrigin?.kind === 'fixed_policy'
  )
    return undefined;
  if (name !== ToolNames.TOOL_CALL)
    return config.getToolRegistry().getTool(name) ||
      config.getToolRegistry().getAllToolNames().includes(name)
      ? { ...request, name }
      : undefined;
  const targetName = request.args['name'];
  let args = request.args['arguments'];
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (typeof targetName !== 'string' || !record(args)) return undefined;
  const registry = config.getToolRegistry();
  const resolved = resolveRegisteredToolName(
    canonicalToolName(targetName),
    registry.getAllToolNames(),
  );
  if (
    typeof resolved !== 'string' ||
    resolved === ToolNames.TOOL_CALL ||
    resolved === ToolNames.TOOL_SEARCH ||
    resolved === ToolNames.SEARCH_MEMORY
  )
    return undefined;
  let target;
  try {
    target = await registry.ensureTool(resolved);
  } catch {
    return undefined;
  }
  if (
    !target ||
    !registry.isDeferredAndHidden(target.name) ||
    target.name === ToolNames.STRUCTURED_OUTPUT
  )
    return undefined;
  return { ...request, name: target.name, args };
}

export async function executeModTool(
  request: ToolCallRequestInfo,
  execution: ToolCallRequestInfo,
  middleware: ModToolCall,
  execute: (
    request: ToolCallRequestInfo,
    signal: AbortSignal,
    check: ModToolCheck,
  ) => Promise<CompletedToolCall>,
  signal: AbortSignal,
): Promise<{ response: ToolCallResponseInfo; completed?: CompletedToolCall }> {
  const shadowed = Object.fromEntries(
    MOD_TOOL_RESERVED.filter((key) => Object.hasOwn(execution.args, key)).map(
      (key) => [key, execution.args[key]],
    ),
  );
  const input: ModToolCallInput = {
    ...execution.args,
    tool: execution.name,
    tool_use_id: request.callId,
  };
  for (const key of MOD_TOOL_RESERVED) delete input[key];
  input.tool = execution.name;
  input.tool_use_id = request.callId;
  if (Object.keys(shadowed).length) input['$shadowed'] = shadowed;
  const refs = new Map<
    number,
    {
      completed: CompletedToolCall;
      value: Exclude<ModToolResult, { deny: string }>;
    }
  >();
  let latest: CompletedToolCall | undefined;
  let executed: CompletedToolCall | undefined;
  let attempts = 0;
  let answer: ModToolResult;
  try {
    answer = await middleware(
      input,
      async (changed, active, check) => {
        active.throwIfAborted();
        validateInput('tool.call', changed, input);
        if (++attempts > 64)
          throw new Error('Mod tool execution limit exceeded.');
        const args = { ...changed };
        for (const key of MOD_TOOL_RESERVED) delete args[key];
        Object.assign(args, shadowed);
        const nativeRequest =
          canonicalToolName(request.name) === ToolNames.TOOL_CALL
            ? {
                ...request,
                args: { ...request.args, arguments: structuredClone(args) },
              }
            : { ...request, args: structuredClone(args) };
        const completed = await execute(nativeRequest, active, check);
        latest = completed;
        if (
          completed.response.executionStatus === 'success' ||
          (completed.response.executionStatus === 'error' &&
            executed?.response.executionStatus !== 'success')
        )
          executed = completed;
        const response = completed.response;
        let result: unknown =
          response.responseParts.find((part) => part.functionResponse)
            ?.functionResponse?.response ?? {};
        let json = JSON.stringify(result);
        if (Buffer.byteLength(json) > MOD_MAX_BYTES / 2) {
          result = {
            output:
              '[Native tool result exceeds the Mod payload limit; return this reference unchanged to retain it.]',
          };
          json = JSON.stringify(result);
        }
        const value = {
          ref: attempts,
          result: JSON.parse(json) as unknown,
          text: (record(result) && typeof result['output'] === 'string'
            ? result['output']
            : json
          ).slice(0, 16_000),
          ...(response.error ? { isError: true as const } : {}),
        };
        refs.set(attempts, { completed, value });
        return value;
      },
      signal,
    );
  } catch (error) {
    answer = { deny: `Mod tool dispatch failed: ${String(error)}` };
  }
  const referenced =
    !('deny' in answer) && answer.ref !== undefined
      ? refs.get(answer.ref)
      : undefined;
  const selected = referenced?.completed ?? latest;
  const native = selected?.response;
  // A result rewrite cannot turn refusal or cancellation into successful work.
  if (
    latest?.response.error &&
    (latest.response.executionStatus === 'not_started' ||
      latest.response.executionStatus === 'cancelled')
  ) {
    if (!executed) return { response: latest.response, completed: latest };
    const message = `An earlier Mod tool attempt ran. A later attempt failed: ${latest.response.error.message}`;
    return {
      completed: executed,
      response: {
        ...latest.response,
        executionStatus: executed.response.executionStatus,
        error: new Error(message),
        resultDisplay: message,
        contentLength: message.length,
        responseParts: [
          {
            functionResponse: {
              id: request.callId,
              name: request.name,
              response: { error: message },
            },
          },
        ],
      },
    };
  }
  if (
    referenced &&
    !('deny' in answer) &&
    isDeepStrictEqual(answer.result, referenced.value.result)
  ) {
    return {
      response: {
        ...referenced.completed.response,
        executionStatus:
          executed?.response.executionStatus ??
          referenced.completed.response.executionStatus,
      },
      completed: executed ?? referenced.completed,
    };
  }
  const message =
    'deny' in answer
      ? `${executed ? 'The tool ran; a Mod withheld its result. ' : 'Tool denied by Mod. '}${answer.deny}`
      : undefined;
  const result =
    'deny' in answer
      ? { error: message }
      : record(answer.result) &&
          Object.entries(answer.result).every(
            ([key, value]) =>
              (key === 'output' || key === 'error') &&
              typeof value === 'string',
          )
        ? answer.result
        : {
            output:
              typeof answer.result === 'string'
                ? answer.result
                : JSON.stringify(answer.result),
          };
  const text = JSON.stringify(result);
  const error = message
    ? new Error(message)
    : (native?.error ??
      (!('deny' in answer) && answer.isError
        ? new Error('Mod returned an error result.')
        : undefined));
  const response: ToolCallResponseInfo = {
    ...native,
    callId: request.callId,
    responseParts: [
      {
        functionResponse: {
          id: request.callId,
          name: request.name,
          response: result,
        },
      },
    ],
    resultDisplay: text,
    contentLength: text.length,
    executionStatus:
      executed?.response.executionStatus ??
      native?.executionStatus ??
      'not_started',
    error,
    errorType:
      native?.errorType ?? (error ? ToolErrorType.EXECUTION_DENIED : undefined),
  };
  return { response, completed: executed ?? selected };
}
