/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SchemaValidator } from '../utils/schemaValidator.js';
import type { ToolResult } from '../tools/tools.js';
import { partToString } from '../utils/partUtils.js';
import { truncateString } from '../utils/textUtils.js';
import { isRecord } from '../utils/markdownUtils.js';
import { sanitizeUnicode } from '../mcp/mcpContentProcessing.js';
import type { JsonObject, JsonValue, ProgrammaticContract } from './types.js';
import { SCRIPT_IMAGE_TYPES } from './types.js';

const string = { type: 'string' };
const count = { type: 'integer', minimum: 0 };
const boolean = { type: 'boolean' };
const strings = { type: 'array', items: string };
const isString = (value: unknown): value is string =>
  typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number';
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a structured tool result');
  return value;
}
function contract(
  properties: Record<string, unknown>,
  required: string[],
  project?: (value: Record<string, unknown>) => unknown,
  notice?: (
    value: Record<string, unknown>,
    args: JsonObject,
  ) => string | undefined,
): ProgrammaticContract {
  const fields = Object.keys(properties);
  const projectValue =
    project ?? ((value: Record<string, unknown>) => pick(value, fields));
  return {
    outputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    project: (result) =>
      projectValue(object(result.toolUseResult)) as JsonValue,
    ...(notice
      ? {
          notice: (value: JsonValue, args: JsonObject) =>
            notice(object(value), args),
        }
      : {}),
  };
}
/**
 * Drops `_meta` and strips the characters the model path strips in mcp-tool;
 * mcpResult carries the pre-normalization envelope.
 */
function cleanMcpBlock(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const clean = pick(
    value,
    Object.keys(value).filter((key) => key !== '_meta'),
  );
  if (isString(clean['text'])) clean['text'] = sanitizeUnicode(clean['text']);
  return clean;
}
function pick(
  value: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

export const readContract: ProgrammaticContract = {
  note: 'Text files only; show an image file with await image({path}).',
  ...contract(
  {
    filePath: string,
    content: string,
    startLine: { type: 'integer', minimum: 1 },
    numLines: count,
    totalLines: count,
    complete: {
      ...boolean,
      description: 'True only when this result covers the entire file.',
    },
  },
  ['filePath', 'content', 'startLine', 'numLines', 'totalLines', 'complete'],
  (value) => {
    if (value['type'] !== 'text')
      throw new Error('Programmatic Read supports text files only');
    const file = object(value['file']);
    return {
      ...pick(file, [
        'filePath',
        'content',
        'startLine',
        'numLines',
        'totalLines',
      ]),
      complete:
        file['startLine'] === 1 && file['numLines'] === file['totalLines'],
    };
  },
  (value, args) => {
    if (value['complete']) return undefined;
    const start = Number(value['startLine']);
    const lines = Number(value['numLines']);
    const total = Number(value['totalLines']);
    // A range the script asked for is expected; report only reads the tool cut short.
    const limit = isNumber(args['limit']) ? args['limit'] : undefined;
    const requested = args['offset'] !== undefined || limit !== undefined;
    const reachedEnd = start + lines - 1 >= total;
    if (requested && (reachedEnd || (limit !== undefined && lines >= limit)))
      return undefined;
    return `Partial file: startLine=${start}, numLines=${lines}, totalLines=${total}`;
  },
  ),
};
/** Host-only projection of a Read on an image file, for image({path}); scripts never call it directly. Its `type` lets the scope count the image as shown. */
export const readImageContract: ProgrammaticContract = {
  outputSchema: {
    type: 'object',
    properties: {
      type: { const: 'image' },
      mimeType: { enum: SCRIPT_IMAGE_TYPES },
      data: string,
    },
    required: ['type', 'mimeType', 'data'],
    additionalProperties: false,
  },
  project: (result) => {
    const value = result.toolUseResult;
    // A vision gate answers with text only; the script sees that explanation.
    if (!isRecord(value))
      throw new Error(programmaticErrorMessage(undefined, result));
    if (value['type'] !== 'image')
      throw new Error(
        'Not an image file; image({path}) shows PNG, JPEG, GIF and WebP files',
      );
    const file = object(value['file']);
    if (!isString(file['base64']) || !isString(file['type']))
      throw new Error('Image data is unavailable');
    return { type: 'image', mimeType: file['type'], data: file['base64'] };
  },
};
export const globContract = contract(
  {
    filenames: strings,
    numFiles: count,
    truncated: boolean,
    totalMatches: count,
    countIsComplete: boolean,
  },
  ['filenames', 'numFiles', 'truncated', 'totalMatches', 'countIsComplete'],
  undefined,
  (value) =>
    value['truncated'] || !value['countIsComplete']
      ? `Partial search: ${value['numFiles']} files returned, ${value['totalMatches']} matches${value['countIsComplete'] ? '' : ' (lower bound; search incomplete)'}`
      : undefined,
);

export const grepContract = contract(
  {
    mode: { enum: ['content', 'files_with_matches', 'count'] },
    filenames: strings,
    numFiles: count,
    content: string,
    numLines: count,
    numMatches: count,
    totalFiles: count,
    totalLines: count,
    appliedLimit: count,
    appliedOffset: count,
    truncated: boolean,
  },
  ['mode', 'filenames', 'numFiles', 'truncated'],
  undefined,
  (value, args) =>
    value['truncated'] ||
    (Number(value['appliedOffset']) > 0 && args['offset'] === undefined)
      ? `Partial search: mode=${value['mode']}, offset=${value['appliedOffset'] ?? 0}${value['appliedLimit'] !== undefined ? `, limit=${value['appliedLimit']}` : ''}, truncated=${value['truncated']}`
      : undefined,
);

export const editContract = contract(
  {
    filePath: string,
    oldString: string,
    newString: string,
    userModified: boolean,
    replaceAll: boolean,
  },
  ['filePath', 'oldString', 'newString', 'userModified', 'replaceAll'],
);
/** Tools without a structured result: scripts receive the text the model would see. */
export const textContract: ProgrammaticContract = {
  outputSchema: {
    type: 'object',
    properties: { text: string },
    required: ['text'],
    additionalProperties: false,
  },
  project: (result) => ({ text: partToString(result.llmContent) }),
};
export const imageGenContract = contract(
  { filePath: string, requestId: string },
  ['filePath', 'requestId'],
);
export const writeContract = contract(
  {
    type: { enum: ['create', 'update'] },
    filePath: string,
    content: string,
  },
  ['type', 'filePath', 'content'],
);

function isNormalShellExit(value: Record<string, unknown>): boolean {
  return (
    value['kind'] === 'completed' &&
    value['signal'] === null &&
    value['interrupted'] !== true &&
    !value['errorMessage']
  );
}

export const shellContract: ProgrammaticContract = {
  note: 'Foreground only; run_in_background is unavailable.',
  ...contract(
    {
      output: string,
      stderr: string,
      exitCode: { type: 'integer' },
      returnCodeInterpretation: string,
      truncated: boolean,
      persistedOutput: {
        type: 'object',
        properties: {
          path: string,
          originalSizeBytes: count,
          savedSizeBytes: count,
          truncated: boolean,
        },
        required: ['path', 'originalSizeBytes', 'savedSizeBytes', 'truncated'],
        additionalProperties: false,
      },
      staleReadFileStateHint: string,
    },
    ['output', 'stderr', 'exitCode', 'truncated'],
    (value) => {
      if (!isNormalShellExit(value)) {
        throw new Error(
          value['kind'] === 'backgrounded'
            ? `Bash moved to background (task ${value['taskId']}); it may still be running`
            : value['timedOut']
              ? 'Bash command timed out'
              : 'Bash command did not complete normally',
        );
      }
      const persisted = value['persistedOutput'];
      return {
        output: value['stdout'],
        ...pick(value, [
          'stderr',
          'exitCode',
          'returnCodeInterpretation',
          'staleReadFileStateHint',
        ]),
        truncated:
          persisted !== undefined ||
          (isString(value['stdout']) &&
            isNumber(value['totalBytes']) &&
            value['totalBytes'] > Buffer.byteLength(value['stdout'])),
        ...(persisted !== undefined
          ? {
              persistedOutput: pick(object(persisted), [
                'path',
                'originalSizeBytes',
                'savedSizeBytes',
                'truncated',
              ]),
            }
          : {}),
      };
    },
  ),
  acceptsErrorResult: (result) => {
    const value = result.toolUseResult;
    if (!isRecord(value)) return false;
    return (
      !result.error &&
      isNormalShellExit(value) &&
      isNumber(value['exitCode']) &&
      Number.isInteger(value['exitCode']) &&
      value['exitCode'] !== 0
    );
  },
  errorMessage: (result) => {
    const value = result.toolUseResult;
    return isRecord(value) &&
      isNormalShellExit(value) &&
      Number.isInteger(value['exitCode'])
      ? `Bash exited with code ${value['exitCode']}`
      : undefined;
  },
  notice: (result) => {
    const value = object(result);
    const notices: string[] = [];
    if (value['exitCode'] !== 0) {
      notices.push(`Bash exited with code ${value['exitCode']}`);
      const diagnostic =
        value['returnCodeInterpretation'] || value['stderr'] || value['output'];
      if (isString(diagnostic) && diagnostic.trim())
        notices.push(truncateString(diagnostic.trim(), 800, '…'));
    }
    if (value['truncated']) {
      const persisted = value['persistedOutput'];
      notices.push(
        isRecord(persisted)
          ? `Output truncated; saved output: ${persisted['path']}${persisted['truncated'] ? ' (saved output is also incomplete)' : ''}`
          : 'Output truncated; no saved output',
      );
    }
    if (isString(value['staleReadFileStateHint']))
      notices.push(value['staleReadFileStateHint']);
    return notices.length ? notices.join('; ') : undefined;
  },
};

/** Keep protocol content and structured data together; never project private metadata. */
export const mcpContract: ProgrammaticContract = {
  outputSchema: {
    type: 'object',
    properties: {
      content: { type: 'array', items: { type: 'object' } },
      structuredContent: { type: 'object' },
      isError: boolean,
    },
    required: ['content', 'isError'],
    additionalProperties: false,
  },
  acceptsErrorResult: (result) => !result.error,
  project: (result): JsonValue => {
    // Output replacement hooks invalidate mcpResult. Do not fall back to mcpMeta:
    // it may retain the original structuredContent for persistence/UI consumers.
    const value = result.mcpResult ?? result.toolUseResult;
    if (typeof value !== 'string' && !Array.isArray(value) && !isRecord(value))
      throw new Error(
        partToString(result.llmContent).slice(0, 2000) ||
          'MCP call returned no result',
      );
    const envelope =
      isRecord(value) && ('content' in value || 'structuredContent' in value)
        ? value
        : undefined;
    const content = envelope
      ? (envelope['content'] ?? [])
      : typeof value === 'string'
        ? [{ type: 'text', text: value }]
        : Array.isArray(value)
          ? value
          : [];
    if (!Array.isArray(content))
      throw new Error('MCP content must be an array');
    const structured =
      envelope?.['structuredContent'] ??
      (!envelope && isRecord(value) ? value : undefined);
    return {
      content: content.map((block: unknown) => {
        const item = object(block);
        const clean = cleanMcpBlock(item);
        if (item['type'] === 'resource' && isRecord(item['resource']))
          clean['resource'] = cleanMcpBlock(item['resource']);
        return clean as JsonObject;
      }),
      ...(structured !== undefined
        ? { structuredContent: object(structured) as JsonObject }
        : {}),
      isError: result.isError === true || envelope?.['isError'] === true,
    };
  },
  notice: (result) => {
    const value = object(result);
    if (!value['isError']) return undefined;
    const content = value['content'] as Array<Record<string, unknown>>;
    const diagnostic = content
      .filter((block) => block['type'] === 'text')
      .map((block) => block['text'])
      .join('\n');
    return `MCP returned isError=true${diagnostic ? `: ${truncateString(diagnostic, 800, '…')}` : '; inspect structuredContent'}`;
  },
};

/** Failure diagnostics use only the final result; never fall back to pre-hook data. */
export function programmaticErrorMessage(
  contract: ProgrammaticContract | undefined,
  result: ToolResult | undefined,
): string {
  return (
    result?.error?.message ||
    (result && contract?.errorMessage?.(result)) ||
    (result && partToString(result.llmContent)) ||
    'Tool call did not succeed'
  ).slice(0, 4000);
}

/** Called after result hooks, with no fallback to pre-hook or model content. */
export function projectProgrammaticResult(
  contract: ProgrammaticContract,
  result: ToolResult,
): JsonValue {
  const value = contract.project(result);
  const error = SchemaValidator.validateStrict(contract.outputSchema, value);
  if (error) throw new Error(`Programmatic result contract failed: ${error}`);
  // A strict JSON check catches functions, undefined, NaN and cyclic projections.
  const seen = new Set<object>();
  const visit = (item: JsonValue): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item))
      throw new Error('Programmatic result is not JSON');
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error('Programmatic result is not a plain JSON object');
    seen.add(item);
    for (const child of Object.values(item as JsonObject)) visit(child);
    seen.delete(item);
  };
  visit(value);
  return value;
}
