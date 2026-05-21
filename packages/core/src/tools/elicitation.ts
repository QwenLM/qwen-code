/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ElicitationCompleteNotificationSchema,
  type ElicitRequestParams,
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MCP_ELICITATION');
let fallbackRequestId = 0;

export type ElicitationMode = 'form' | 'url';

export interface ElicitationRequestEvent {
  serverName: string;
  requestId: string | number;
  params: ElicitRequestParams;
  signal: AbortSignal;
}

export type ElicitationHandler = (
  event: ElicitationRequestEvent,
) => Promise<ElicitResult>;

export type ElicitationHookStage = 'before' | 'after';

export interface ElicitationHookEvent extends ElicitationRequestEvent {
  stage: ElicitationHookStage;
  result?: ElicitResult;
}

export type ElicitationHookHandler = (
  event: ElicitationHookEvent,
) => Promise<ElicitResult | undefined | void> | ElicitResult | undefined | void;

export interface ElicitationCompletionEvent {
  serverName: string;
  elicitationId: string;
}

export type ElicitationCompletionHandler = (
  event: ElicitationCompletionEvent,
) => void;

export function getElicitationMode(
  params: ElicitRequestParams,
): ElicitationMode {
  return params.mode === 'url' ? 'url' : 'form';
}

export function registerDefaultElicitationHandler(client: Client): void {
  try {
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: 'cancel' as const,
    }));
  } catch (error) {
    debugLogger.warn(
      `Failed to register default MCP elicitation handler: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function registerElicitationCompletionHandler(
  client: Client,
  serverName: string,
  config: Config,
): void {
  try {
    client.setNotificationHandler(
      ElicitationCompleteNotificationSchema,
      (notification) => {
        config.notifyElicitationCompletion({
          serverName,
          elicitationId: notification.params.elicitationId,
        });
      },
    );
  } catch (error) {
    debugLogger.warn(
      `Failed to register elicitation completion handler for MCP server '${serverName}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function registerElicitationHandler(
  client: Client,
  serverName: string,
  config: Config,
): void {
  try {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const event: ElicitationRequestEvent = {
        serverName,
        requestId:
          extra.requestId ?? `${serverName}:elicitation:${++fallbackRequestId}`,
        params: request.params,
        signal: extra.signal,
      };
      const hookHandler = config.getElicitationHookHandler?.();
      if (hookHandler) {
        try {
          const hookResult = await hookHandler({
            ...event,
            stage: 'before',
          });
          if (hookResult) {
            return hookResult;
          }
        } catch (error) {
          debugLogger.warn(
            `Elicitation before-hook failed for MCP server '${serverName}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const handler = config.getElicitationHandler();
      if (!handler) {
        debugLogger.debug(
          `MCP server '${serverName}' requested elicitation but no UI handler is registered`,
        );
        return { action: 'cancel' as const };
      }

      try {
        const result = await handler(event);
        if (!hookHandler) {
          return result;
        }
        try {
          const hookResult = await hookHandler({
            ...event,
            stage: 'after',
            result,
          });
          return hookResult ?? result;
        } catch (error) {
          debugLogger.warn(
            `Elicitation after-hook failed for MCP server '${serverName}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return result;
        }
      } catch (error) {
        debugLogger.warn(
          `Elicitation handler failed for MCP server '${serverName}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { action: 'cancel' as const };
      }
    });
  } catch (error) {
    debugLogger.warn(
      `Failed to register elicitation handler for MCP server '${serverName}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export type PrimitiveElicitationSchema = {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
  format?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  enum?: unknown;
  oneOf?: unknown;
  items?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
};

export interface ElicitationValidationResult {
  isValid: boolean;
  value?: string | number | boolean | string[];
  error?: string;
}

export function isSingleSelectSchema(
  schema: PrimitiveElicitationSchema,
): boolean {
  return (
    schema.type === 'string' &&
    (Array.isArray(schema.enum) || Array.isArray(schema.oneOf))
  );
}

export function isMultiSelectSchema(
  schema: PrimitiveElicitationSchema,
): boolean {
  if (
    schema.type !== 'array' ||
    typeof schema.items !== 'object' ||
    schema.items === null
  ) {
    return false;
  }
  const items = schema.items as PrimitiveElicitationSchema & {
    anyOf?: unknown;
  };
  return Array.isArray(items.enum) || Array.isArray(items.anyOf);
}

export function getEnumOptions(
  schema: PrimitiveElicitationSchema,
): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .filter(
        (item): item is { const: unknown; title?: unknown } =>
          typeof item === 'object' && item !== null && 'const' in item,
      )
      .map((item) => ({
        value: String(item.const),
        label: typeof item.title === 'string' ? item.title : String(item.const),
      }));
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => ({
      value: String(value),
      label: String(value),
    }));
  }
  return [];
}

export function getMultiSelectOptions(
  schema: PrimitiveElicitationSchema,
): Array<{ value: string; label: string }> {
  const items =
    typeof schema.items === 'object' && schema.items !== null
      ? (schema.items as PrimitiveElicitationSchema & { anyOf?: unknown })
      : {};
  if (Array.isArray(items.anyOf)) {
    return items.anyOf
      .filter(
        (item): item is { const: unknown; title?: unknown } =>
          typeof item === 'object' && item !== null && 'const' in item,
      )
      .map((item) => ({
        value: String(item.const),
        label: typeof item.title === 'string' ? item.title : String(item.const),
      }));
  }
  if (Array.isArray(items.enum)) {
    return items.enum.map((value) => ({
      value: String(value),
      label: String(value),
    }));
  }
  return [];
}

export function validateElicitationInput(
  rawValue: string | boolean | string[],
  schema: PrimitiveElicitationSchema,
): ElicitationValidationResult {
  if (isMultiSelectSchema(schema)) {
    const values = Array.isArray(rawValue) ? rawValue : [];
    const minItems =
      typeof schema.minItems === 'number' ? schema.minItems : undefined;
    const maxItems =
      typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
    if (minItems !== undefined && values.length < minItems) {
      return { isValid: false, error: `Select at least ${minItems}` };
    }
    if (maxItems !== undefined && values.length > maxItems) {
      return { isValid: false, error: `Select at most ${maxItems}` };
    }
    return { isValid: true, value: values };
  }

  const type = schema.type;
  if (type === 'boolean') {
    return { isValid: true, value: Boolean(rawValue) };
  }

  const stringValue = String(rawValue ?? '');
  if (isSingleSelectSchema(schema)) {
    const values = getEnumOptions(schema).map((option) => option.value);
    if (!values.includes(stringValue)) {
      return { isValid: false, error: 'Select one of the available options' };
    }
    return { isValid: true, value: stringValue };
  }

  if (type === 'number' || type === 'integer') {
    const numberValue =
      type === 'integer'
        ? Number.parseInt(stringValue, 10)
        : Number.parseFloat(stringValue);
    if (
      !Number.isFinite(numberValue) ||
      (type === 'integer' && !Number.isInteger(numberValue))
    ) {
      return {
        isValid: false,
        error: type === 'integer' ? 'Enter an integer' : 'Enter a number',
      };
    }
    if (typeof schema.minimum === 'number' && numberValue < schema.minimum) {
      return { isValid: false, error: `Must be >= ${schema.minimum}` };
    }
    if (typeof schema.maximum === 'number' && numberValue > schema.maximum) {
      return { isValid: false, error: `Must be <= ${schema.maximum}` };
    }
    return { isValid: true, value: numberValue };
  }

  if (
    typeof schema.minLength === 'number' &&
    stringValue.length < schema.minLength
  ) {
    return {
      isValid: false,
      error: `Must be at least ${schema.minLength} characters`,
    };
  }
  if (
    typeof schema.maxLength === 'number' &&
    stringValue.length > schema.maxLength
  ) {
    return {
      isValid: false,
      error: `Must be at most ${schema.maxLength} characters`,
    };
  }
  if (
    typeof schema.pattern === 'string' &&
    !new RegExp(schema.pattern).test(stringValue)
  ) {
    return { isValid: false, error: 'Does not match the required pattern' };
  }
  if (
    schema.format === 'email' &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stringValue)
  ) {
    return { isValid: false, error: 'Enter a valid email address' };
  }
  if (schema.format === 'uri') {
    try {
      new URL(stringValue);
    } catch {
      return { isValid: false, error: 'Enter a valid URI' };
    }
  }
  if (schema.format === 'date' && Number.isNaN(Date.parse(stringValue))) {
    return { isValid: false, error: 'Enter a valid date' };
  }
  if (schema.format === 'date-time' && Number.isNaN(Date.parse(stringValue))) {
    return { isValid: false, error: 'Enter a valid date-time' };
  }

  return { isValid: true, value: stringValue };
}
