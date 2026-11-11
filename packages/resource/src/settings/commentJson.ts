/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';

/**
 * Type representing an object that may contain Symbol keys for comments.
 */
export type CommentedRecord = Record<string | symbol, unknown>;
export type CommentJsonPath = string | readonly string[];

function pathSegments(path: CommentJsonPath): string[] {
  return typeof path === 'string' ? path.split('.') : [...path];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function setOwnProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

/**
 * 将 comment-json 对象转换为普通 JSON 值，不把注释 Symbol 泄漏到运行时设置。
 */
export function toPlainJsonValue<T = unknown>(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): T {
  if (typeof value !== 'object' || value === null) return value as T;
  if (ancestors.has(value)) {
    throw new TypeError('Settings values must not contain circular references');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => toPlainJsonValue(entry, ancestors)) as T;
    }
    if (Object.prototype.toString.call(value) !== '[object Object]') {
      throw new TypeError('Settings values must contain only JSON objects');
    }

    return Object.fromEntries(
      Object.getOwnPropertyNames(value).map((key) => [
        key,
        toPlainJsonValue((value as Record<string, unknown>)[key], ancestors),
      ]),
    ) as T;
  } finally {
    ancestors.delete(value);
  }
}

export function getCommentJsonProperty(
  root: Record<string, unknown>,
  path: CommentJsonPath,
): unknown {
  const keys = pathSegments(path);
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current) || !hasOwnProperty(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * When deleting a property from a comment-json parsed object, relocate any
 * leading/trailing comments that were attached to that property so they are not lost.
 *
 * This function re-attaches comments to the next sibling's leading comments if
 * available, otherwise to the previous sibling's trailing comments, otherwise
 * to the container's leading/trailing comments.
 */
function preserveCommentsOnPropertyDeletion(
  container: Record<string, unknown>,
  propName: string,
): void {
  const target = container as CommentedRecord;
  const beforeSym = Symbol.for(`before:${propName}`);
  const afterSym = Symbol.for(`after:${propName}`);

  const beforeComments = target[beforeSym] as unknown[] | undefined;
  const afterComments = target[afterSym] as unknown[] | undefined;

  if (!beforeComments && !afterComments) return;

  const keys = Object.getOwnPropertyNames(container);
  const idx = keys.indexOf(propName);
  const nextKey = idx >= 0 && idx + 1 < keys.length ? keys[idx + 1] : undefined;
  const prevKey = idx > 0 ? keys[idx - 1] : undefined;

  function appendToSymbol(destSym: symbol, comments: unknown[]) {
    if (!comments || comments.length === 0) return;
    const existing = target[destSym];
    target[destSym] = Array.isArray(existing)
      ? existing.concat(comments)
      : comments;
  }

  if (beforeComments && beforeComments.length > 0) {
    if (nextKey) {
      appendToSymbol(Symbol.for(`before:${nextKey}`), beforeComments);
    } else if (prevKey) {
      appendToSymbol(Symbol.for(`after:${prevKey}`), beforeComments);
    } else {
      appendToSymbol(Symbol.for('before'), beforeComments);
    }
    delete target[beforeSym];
  }

  if (afterComments && afterComments.length > 0) {
    if (nextKey) {
      appendToSymbol(Symbol.for(`before:${nextKey}`), afterComments);
    } else if (prevKey) {
      appendToSymbol(Symbol.for(`after:${prevKey}`), afterComments);
    } else {
      appendToSymbol(Symbol.for('after'), afterComments);
    }
    delete target[afterSym];
  }
}

/**
 * 按路径设置一个 JSONC 值，并保留未触碰字段及其注释。
 */
export function setCommentJsonProperty(
  root: Record<string, unknown>,
  path: CommentJsonPath,
  value: unknown,
): boolean {
  const keys = pathSegments(path);
  const lastKey = keys.pop();
  if (!lastKey) return false;

  let current = root;
  for (const key of keys) {
    const next = hasOwnProperty(current, key) ? current[key] : undefined;
    if (!isRecord(next)) {
      setOwnProperty(current, key, {});
    }
    current = current[key] as Record<string, unknown>;
  }

  if (
    hasOwnProperty(current, lastKey) &&
    isDeepStrictEqual(toPlainJsonValue(current[lastKey]), value)
  ) {
    return false;
  }

  const currentValue = hasOwnProperty(current, lastKey)
    ? current[lastKey]
    : undefined;
  const plainValue = toPlainJsonValue(value);
  if (isRecord(currentValue) && isRecord(plainValue)) {
    applyKeyDiff(currentValue, plainValue);
  } else if (Array.isArray(currentValue) && Array.isArray(plainValue)) {
    currentValue.length = 0;
    currentValue.push(...structuredClone(plainValue));
  } else {
    setOwnProperty(current, lastKey, structuredClone(plainValue));
  }
  return true;
}

/**
 * 按路径显式删除一个 JSONC 值，并迁移挂在该属性上的相邻注释。
 */
export function deleteCommentJsonProperty(
  root: Record<string, unknown>,
  path: CommentJsonPath,
): boolean {
  const keys = pathSegments(path);
  const lastKey = keys.pop();
  if (!lastKey) return false;

  let current = root;
  for (const key of keys) {
    if (!hasOwnProperty(current, key)) return false;
    const next = current[key];
    if (!isRecord(next)) return false;
    current = next;
  }
  if (!hasOwnProperty(current, lastKey)) return false;

  preserveCommentsOnPropertyDeletion(current, lastKey);
  delete current[lastKey];
  return true;
}

/**
 * Applies sync-by-omission semantics: synchronizes base to match desired.
 * - Adds/updates keys from desired
 * - Removes keys from base that are not in desired
 * - Recursively applies to nested objects
 * - Preserves comments when deleting keys
 */
function applyKeyDiff(
  base: Record<string, unknown>,
  desired: Record<string, unknown>,
): void {
  for (const existingKey of Object.getOwnPropertyNames(base)) {
    if (!Object.prototype.hasOwnProperty.call(desired, existingKey)) {
      preserveCommentsOnPropertyDeletion(base, existingKey);
      delete base[existingKey];
    }
  }

  for (const nextKey of Object.getOwnPropertyNames(desired)) {
    const nextVal = desired[nextKey];
    const baseVal = hasOwnProperty(base, nextKey) ? base[nextKey] : undefined;

    const isObj =
      typeof nextVal === 'object' &&
      nextVal !== null &&
      !Array.isArray(nextVal);
    const isBaseObj =
      typeof baseVal === 'object' &&
      baseVal !== null &&
      !Array.isArray(baseVal);
    const isArr = Array.isArray(nextVal);
    const isBaseArr = Array.isArray(baseVal);

    if (isObj && isBaseObj) {
      applyKeyDiff(
        baseVal as Record<string, unknown>,
        nextVal as Record<string, unknown>,
      );
    } else if (isArr && isBaseArr) {
      // In-place mutate arrays to preserve array-level comments on CommentArray
      const baseArr = baseVal as unknown[];
      const desiredArr = nextVal as unknown[];
      baseArr.length = 0;
      for (const el of desiredArr) {
        baseArr.push(el);
      }
    } else {
      setOwnProperty(base, nextKey, nextVal);
    }
  }
}
