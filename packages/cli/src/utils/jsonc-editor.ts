/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type ModificationOptions,
  type Node as JsoncNode,
  type ParseError,
} from 'jsonc-parser';
import { writeStderrLine } from './stdioHelpers.js';
import { writeWithBackupSync } from './writeWithBackup.js';

const PARSE_OPTIONS = { allowTrailingComma: true } as const;

/**
 * Updates a JSON file while preserving comments and formatting.
 *
 * In merge mode (default), updates are deep-merged into the existing file,
 * preserving keys not mentioned in the updates object.
 * A replacePath can be provided for a single updated subtree that should be
 * replaced exactly instead of deep-merged.
 *
 * In sync mode (sync=true), the file is synchronized to match the updates
 * object exactly — keys present in the original but not in updates are
 * removed, preventing zombie keys after migrations.
 *
 * Uses writeWithBackupSync internally for atomic temp-file + rename writes,
 * preventing file corruption if the process crashes mid-write.
 *
 * @returns true if the file was successfully written, false if the write
 * was refused (e.g. the result would not be valid JSON or file not parseable).
 */
export function updateSettingsFilePreservingFormat(
  filePath: string,
  updates: Record<string, unknown>,
  sync = false,
  replacePath: readonly string[] = [],
): boolean {
  if (!fs.existsSync(filePath)) {
    const content = JSON.stringify(updates, null, 2);
    writeWithBackupSync(filePath, content);
    return true;
  }

  const originalContent = fs.readFileSync(filePath, 'utf-8');

  try {
    parseJsoncObject(originalContent);
  } catch (_error) {
    writeStderrLine('Error parsing settings file.');
    writeStderrLine(
      `Settings file may be corrupted: ${_error instanceof Error ? _error.message : String(_error)}`,
    );
    return false;
  }

  let updatedContent: string;
  try {
    updatedContent = updateJsoncContent(
      originalContent,
      updates,
      sync,
      replacePath,
    );
  } catch (validationError) {
    writeStderrLine(
      'Error: Refusing to write settings file — the result would not be valid JSON.',
    );
    writeStderrLine(
      validationError instanceof Error
        ? validationError.message
        : String(validationError),
    );
    return false;
  }

  writeWithBackupSync(filePath, updatedContent);
  return true;
}

export function parseJsoncObject(content: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const root = parseTree(stripBom(content), errors, PARSE_OPTIONS);
  if (errors.length > 0) {
    const error = errors[0];
    throw new Error(
      `${printParseErrorCode(error.error)} at offset ${error.offset}`,
    );
  }
  if (root?.type !== 'object') {
    throw new Error('JSONC document root is not a JSON object.');
  }
  return JSON.parse(JSON.stringify(getNodeValue(root))) as Record<
    string,
    unknown
  >;
}

export function updateJsoncContent(
  content: string,
  updates: Record<string, unknown>,
  sync = false,
  replacePath: readonly string[] = [],
): string {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const editableContent = stripBom(content);
  const parsed = parseJsoncObject(editableContent);
  const targetWithUndefined = applyUpdates(
    structuredClone(parsed),
    updates,
    sync,
    replacePath,
  );
  const target = JSON.parse(JSON.stringify(targetWithUndefined)) as Record<
    string,
    unknown
  >;
  const options: ModificationOptions = {
    formattingOptions: detectFormattingOptions(editableContent),
  };
  let updated = normalizeDuplicateProperties(editableContent, options);
  const current = parseJsoncObject(updated);

  for (const operation of collectOperations(current, target)) {
    if (operation.value === undefined) {
      updated = removeTrailingInlineComment(updated, operation.path);
    }
    updated = applyEdits(
      updated,
      modify(updated, operation.path, operation.value, options),
    );
  }

  const reparsed = parseJsoncObject(updated);
  if (!isDeepStrictEqual(reparsed, target)) {
    throw new Error('Edited JSONC does not match the intended settings.');
  }
  return bom + updated;
}

export function applyUpdates(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
  sync = false,
  replacePath: readonly string[] = [],
  currentPath: readonly string[] = [],
): Record<string, unknown> {
  const result = current;

  if (sync) {
    // Sync mode: remove keys from current that are not present in updates,
    // then recursively apply updates. This prevents nested zombie keys
    // from persisting after migrations that restructure nested objects.
    const keysToRemove = Object.keys(result).filter(
      (key) => !Object.hasOwn(updates, key),
    );
    for (const key of keysToRemove) {
      delete result[key];
    }
  }

  for (const key of Object.getOwnPropertyNames(updates)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }

    const value = updates[key];
    const nextPath = [...currentPath, key];
    const valueIsObject =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0;
    if (pathsEqual(nextPath, replacePath)) {
      result[key] = valueIsObject
        ? applyUpdates({}, value as Record<string, unknown>)
        : value;
      continue;
    }

    if (
      valueIsObject &&
      (typeof result[key] !== 'object' ||
        result[key] === null ||
        Array.isArray(result[key]))
    ) {
      result[key] = applyUpdates(
        {},
        value as Record<string, unknown>,
        sync,
        replacePath,
        nextPath,
      );
    } else if (
      valueIsObject &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = applyUpdates(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
        sync,
        replacePath,
        nextPath,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

function stripBom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detectFormattingOptions(content: string): FormattingOptions {
  const root = parseTree(content, [], PARSE_OPTIONS);
  const firstKey = root?.children?.[0]?.children?.[0];
  const lineStart =
    firstKey === undefined
      ? -1
      : content.lastIndexOf('\n', firstKey.offset - 1);
  const candidate =
    firstKey === undefined
      ? undefined
      : content.slice(lineStart + 1, firstKey.offset);
  const indentation =
    candidate !== undefined && /^[ \t]*$/.test(candidate) ? candidate : '  ';
  return {
    eol: content.includes('\r\n') ? '\r\n' : '\n',
    insertSpaces: !indentation.startsWith('\t'),
    tabSize: indentation.startsWith('\t') ? 1 : indentation.length,
    insertFinalNewline: content.endsWith('\n'),
  };
}

interface UpdateOperation {
  path: string[];
  value: unknown;
}

function collectOperations(
  current: Record<string, unknown>,
  target: Record<string, unknown>,
  path: readonly string[] = [],
  operations: UpdateOperation[] = [],
): UpdateOperation[] {
  for (const key of Object.keys(current)) {
    if (!Object.hasOwn(target, key)) {
      operations.push({ path: [...path, key], value: undefined });
    }
  }

  for (const key of Object.keys(target)) {
    const nextPath = [...path, key];
    if (!Object.hasOwn(current, key)) {
      operations.push({ path: nextPath, value: target[key] });
    } else if (isRecord(current[key]) && isRecord(target[key])) {
      collectOperations(current[key], target[key], nextPath, operations);
    } else if (!isDeepStrictEqual(current[key], target[key])) {
      operations.push({ path: nextPath, value: target[key] });
    }
  }
  return operations;
}

interface DuplicateProperty {
  objectPath: string[];
  keyNode: JsoncNode;
  propertyNames: Set<string>;
}

function findDuplicateProperty(
  node: JsoncNode,
  path: readonly string[] = [],
): DuplicateProperty | undefined {
  if (node.type !== 'object' || node.children === undefined) {
    return undefined;
  }

  const properties = new Map<string, JsoncNode>();
  for (const property of node.children) {
    const keyNode = property.children?.[0];
    const key = keyNode?.value;
    if (typeof key !== 'string' || keyNode === undefined) {
      continue;
    }
    const previous = properties.get(key);
    if (previous !== undefined) {
      return {
        objectPath: [...path],
        keyNode: previous,
        propertyNames: new Set(properties.keys()),
      };
    }
    properties.set(key, keyNode);
  }

  for (const property of node.children) {
    const key = property.children?.[0]?.value;
    const valueNode = property.children?.[1];
    if (typeof key !== 'string' || valueNode === undefined) {
      continue;
    }
    const duplicate = findDuplicateProperty(valueNode, [...path, key]);
    if (duplicate !== undefined) {
      return duplicate;
    }
  }
  return undefined;
}

function normalizeDuplicateProperties(
  content: string,
  options: ModificationOptions,
): string {
  let normalized = content;
  let duplicateIndex = 0;

  while (true) {
    const root = parseTree(normalized, [], PARSE_OPTIONS);
    if (root === undefined) {
      return normalized;
    }
    const duplicate = findDuplicateProperty(root);
    if (duplicate === undefined) {
      return normalized;
    }

    let temporaryKey: string;
    do {
      temporaryKey = `__qwen_duplicate_${duplicateIndex}`;
      duplicateIndex += 1;
    } while (duplicate.propertyNames.has(temporaryKey));

    let renamed =
      normalized.slice(0, duplicate.keyNode.offset) +
      JSON.stringify(temporaryKey) +
      normalized.slice(duplicate.keyNode.offset + duplicate.keyNode.length);
    renamed = removeTrailingInlineComment(renamed, [
      ...duplicate.objectPath,
      temporaryKey,
    ]);
    normalized = applyEdits(
      renamed,
      modify(
        renamed,
        [...duplicate.objectPath, temporaryKey],
        undefined,
        options,
      ),
    );
  }
}

function removeTrailingInlineComment(
  content: string,
  path: readonly string[],
): string {
  const root = parseTree(content, [], PARSE_OPTIONS);
  if (root === undefined) {
    return content;
  }
  const node = findNodeAtLocation(root, [...path]);
  if (node === undefined) {
    return content;
  }

  const tail = content.slice(node.offset + node.length);
  const match = tail.match(
    /^[ \t]*(?:,[ \t]*)?(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/,
  );
  const comment = match?.[1];
  if (comment === undefined || match === null) {
    return content;
  }

  const commentOffset = node.offset + node.length + match[0].indexOf(comment);
  return (
    content.slice(0, commentOffset) +
    content.slice(commentOffset + comment.length)
  );
}

function pathsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}
