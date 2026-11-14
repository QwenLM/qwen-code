/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { decodeBufferWithEncodingInfoAsync } from '../utils/fileUtils.js';
import { hasVerifiableInode } from '../utils/file-identity.js';
import { readFileHandleBytes } from '../utils/file-read-source.js';
import { unescapePath } from '../utils/paths.js';

export const EDIT_REFERENCE_MAX_BYTES = 1024 * 1024;
export const EDIT_RECOVERY_MAX_BYTES = 16 * 1024;
export const EDIT_RECOVERY_MAX_LINES = 120;
const MAX_REFERENCES = 8;

export interface EditReferenceSnapshot {
  content: string;
  digest: string;
  stats: Stats;
  encoding: string;
  bom: boolean;
}

interface Reference {
  id: string;
  filePath: string;
  digest: string;
  identity: string;
  kind: 'recovery' | 'read';
  start: number;
  text: string;
  startLine: number;
  endLine: number;
  newString?: string;
  recoveryText: string;
  active: boolean;
  bytes: number;
}

interface ReferenceStore {
  scope: string;
  entries: Map<string, Reference>;
}

export interface EditReferenceBinding {
  readonly reference: Reference;
  readonly filePath: string;
  readonly oldString: string;
  readonly start: number;
  readonly end: number;
}

const stores = new WeakMap<Config, ReferenceStore>();
const disabled = new WeakSet<Config>();
const bindings = new WeakMap<
  object,
  { config: Config; binding: EditReferenceBinding }
>();

function scope(config: Config): string {
  return `${config.getSessionId?.() ?? ''}\0${config.getTargetDir()}`;
}

function storeFor(config: Config): ReferenceStore {
  let store = stores.get(config);
  if (!store || store.scope !== scope(config)) {
    store = { scope: scope(config), entries: new Map() };
    stores.set(config, store);
  }
  return store;
}

export function supportsEditReferences(config: Config): boolean {
  return (
    !disabled.has(config) &&
    typeof config.getSessionId?.() === 'string' &&
    config.getSessionId().length > 0 &&
    config.supportsLocalFileReferences?.() === true &&
    !config.getExecutionEnvironment?.() &&
    !config.getShellExecutionSandbox?.() &&
    config.getSessionExecutionEngine?.() !== 'managed' &&
    !config.getFileReadCacheDisabled()
  );
}

export function disableEditReferences(config: Config): void {
  disabled.add(config);
  clearEditReferences(config);
}

function identity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

function version(stats: Stats): string {
  return `${identity(stats)}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
}

export function sameEditReferenceStats(a: Stats, b: Stats): boolean {
  return (
    identity(a) === identity(b) &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

export async function readEditReferenceSnapshot(
  filePath: string,
  signal?: AbortSignal,
): Promise<EditReferenceSnapshot | undefined> {
  signal?.throwIfAborted();
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY,
  );
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      !hasVerifiableInode(stats.ino) ||
      stats.size > EDIT_REFERENCE_MAX_BYTES
    )
      return undefined;
    const bytes = await readFileHandleBytes(handle, stats.size, signal);
    if (
      bytes.length !== stats.size ||
      !sameEditReferenceStats(stats, await handle.stat())
    )
      return undefined;
    const decoded = await decodeBufferWithEncodingInfoAsync(bytes);
    signal?.throwIfAborted();
    return {
      ...decoded,
      digest: createHash('sha256').update(bytes).digest('hex'),
      stats,
    };
  } finally {
    await handle.close();
  }
}

function normalizedPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = unescapePath(value.trim());
  return path.isAbsolute(result) ? path.resolve(result) : undefined;
}

function remember(
  config: Config,
  entry: Omit<Reference, 'active' | 'bytes'>,
): { id: string; recoveryText: string } | undefined {
  const bytes = Buffer.byteLength(
    entry.text + (entry.newString ?? '') + entry.recoveryText,
  );
  if (
    !supportsEditReferences(config) ||
    bytes > EDIT_REFERENCE_MAX_BYTES ||
    Buffer.byteLength(entry.recoveryText) > EDIT_RECOVERY_MAX_BYTES ||
    entry.endLine - entry.startLine + 1 > EDIT_RECOVERY_MAX_LINES
  )
    return undefined;
  const store = storeFor(config);
  while (
    store.entries.size >= MAX_REFERENCES ||
    [...store.entries.values()].reduce((sum, item) => sum + item.bytes, 0) +
      bytes >
      EDIT_REFERENCE_MAX_BYTES
  ) {
    const first = store.entries.keys().next().value;
    if (first === undefined) break;
    store.entries.delete(first);
  }
  store.entries.set(entry.id, { ...entry, bytes, active: false });
  return { id: entry.id, recoveryText: entry.recoveryText };
}

export function prepareRecoveryReference(
  config: Config,
  input: {
    filePath: string;
    snapshot: EditReferenceSnapshot;
    start: number;
    end: number;
    startLine: number;
    endLine: number;
    newString: string;
    diagnostic: string;
  },
): { id: string; recoveryText: string } | undefined {
  const content = input.snapshot.content.replace(/\r\n/g, '\n');
  const text = content.slice(input.start, input.end);
  if (!text || content.indexOf(text) !== content.lastIndexOf(text))
    return undefined;
  const id = `er_${randomUUID()}`;
  const recoveryText = `${input.diagnostic}\nCurrent target, lines ${input.startLine}-${input.endLine}:\n<current_edit_target>\n${text}\n</current_edit_target>\nrecovery_id: ${JSON.stringify(id)}\nTo retry this exact target, call edit with file_path and recovery_id. Omit new_string to reuse the previous replacement, or supply a corrected new_string. Review the current target before retrying. No changes were made.`;
  return remember(config, {
    id,
    filePath: path.resolve(input.filePath),
    digest: input.snapshot.digest,
    identity: version(input.snapshot.stats),
    kind: 'recovery',
    start: input.start,
    text,
    startLine: input.startLine,
    endLine: input.endLine,
    newString: input.newString,
    recoveryText,
  });
}

export function editReferenceLineRange(
  content: string,
  startLine: number,
  endLine: number,
): { start: number; end: number; text: string } | undefined {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  )
    return undefined;
  const start = lines.slice(0, startLine - 1).join('').length;
  const text = lines.slice(startLine - 1, endLine).join('');
  return { start, end: start + text.length, text };
}

export function prepareReadReference(
  config: Config,
  input: {
    filePath: string;
    snapshot: EditReferenceSnapshot;
    startLine: number;
    endLine: number;
  },
): { id: string; recoveryText: string } | undefined {
  const range = editReferenceLineRange(
    input.snapshot.content.replace(/\r\n/g, '\n'),
    input.startLine,
    input.endLine,
  );
  if (!range) return undefined;
  const id = `rd_${randomUUID()}`;
  const recoveryText = `Read snapshot: lines ${input.startLine}-${input.endLine} (inclusive) of ${input.filePath}.\n<read_file_content>\n${range.text}\n</read_file_content>\nread_id: ${JSON.stringify(id)}\nTo replace whole lines from this snapshot, call edit with file_path, read_id, start_line, end_line, and new_string. Only the complete lines above are addressable. A replacement of a newline-terminated range keeps its final newline unless it deletes the range.`;
  return remember(config, {
    id,
    filePath: path.resolve(input.filePath),
    digest: input.snapshot.digest,
    identity: version(input.snapshot.stats),
    kind: 'read',
    start: range.start,
    text: range.text,
    startLine: input.startLine,
    endLine: input.endLine,
    recoveryText,
  });
}

export function normalizeEditReference(
  config: Config,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (getEditReferenceBinding(config, args)) {
    if (args['replace_all'] !== undefined)
      throw new Error('Edit references cannot be combined with replace_all.');
    return args;
  }
  const recoveryId = args['recovery_id'];
  const readId = args['read_id'];
  if (recoveryId === undefined && readId === undefined) {
    if (args['start_line'] !== undefined || args['end_line'] !== undefined)
      throw new Error('Line ranges require read_id.');
    return args;
  }
  const fields = new Set([
    'file_path',
    'recovery_id',
    'read_id',
    'start_line',
    'end_line',
    'new_string',
    'record_as_artifact',
  ]);
  if (Object.keys(args).some((key) => !fields.has(key)))
    throw new Error('Unsupported edit reference argument.');
  if (
    !supportsEditReferences(config) ||
    (recoveryId !== undefined && readId !== undefined) ||
    args['old_string'] !== undefined ||
    args['replace_all'] !== undefined
  )
    throw new Error(
      'Use either ordinary edit strings or one supported edit reference. References do not support replace_all.',
    );
  const id = recoveryId ?? readId;
  const entry =
    typeof id === 'string' ? storeFor(config).entries.get(id) : undefined;
  if (
    !entry?.active ||
    entry.kind !== (recoveryId === undefined ? 'read' : 'recovery')
  )
    throw new Error(
      'Edit reference is unavailable or has not been delivered. Read the current file and retry.',
    );
  const filePath = normalizedPath(args['file_path']);
  if (filePath !== entry.filePath)
    throw new Error('Edit reference belongs to a different file.');
  let start = entry.start;
  let oldString = entry.text;
  if (entry.kind === 'read') {
    const startLine = args['start_line'];
    const endLine = args['end_line'];
    if (
      typeof startLine !== 'number' ||
      typeof endLine !== 'number' ||
      startLine < entry.startLine ||
      endLine > entry.endLine
    )
      throw new Error(
        'Edit range must be completely covered by the delivered read snapshot.',
      );
    const range = editReferenceLineRange(
      entry.text,
      startLine - entry.startLine + 1,
      endLine - entry.startLine + 1,
    );
    if (!range) throw new Error('Invalid inclusive edit line range.');
    start += range.start;
    oldString = range.text;
  } else if (
    args['start_line'] !== undefined ||
    args['end_line'] !== undefined
  ) {
    throw new Error('Line ranges require read_id.');
  }
  const suppliedNewString =
    args['new_string'] === undefined ? entry.newString : args['new_string'];
  if (typeof suppliedNewString !== 'string')
    throw new Error('new_string is required for a read reference.');
  let newString = suppliedNewString.replace(/\r\n/g, '\n');
  if (
    entry.kind === 'read' &&
    oldString.endsWith('\n') &&
    newString &&
    !newString.endsWith('\n')
  )
    newString += '\n';
  const resolved: Record<string, unknown> = {
    file_path: filePath,
    old_string: oldString,
    new_string: newString,
    ...(args['record_as_artifact'] === undefined
      ? {}
      : { record_as_artifact: args['record_as_artifact'] }),
  };
  bindings.set(resolved, {
    config,
    binding: {
      reference: entry,
      filePath,
      oldString,
      start,
      end: start + oldString.length,
    },
  });
  return resolved;
}

export function getEditReferenceBinding(
  config: Config,
  args: object,
): EditReferenceBinding | undefined {
  const entry = bindings.get(args);
  return entry?.config === config ? entry.binding : undefined;
}

export function copyEditReferenceBinding(
  config: Config,
  from: object,
  to: object,
): void {
  const binding = getEditReferenceBinding(config, from);
  const params = to as Record<string, unknown>;
  if (
    binding &&
    normalizedPath(params['file_path']) === binding.filePath &&
    params['old_string'] === binding.oldString
  )
    bindings.set(to, { config, binding });
  else bindings.delete(to);
}

export function validateEditReferenceSnapshot(
  config: Config,
  params: object,
  snapshot: EditReferenceSnapshot | undefined,
): boolean {
  const binding = getEditReferenceBinding(config, params);
  if (!binding || !snapshot) return false;
  const entry = binding.reference;
  const args = params as Record<string, unknown>;
  return (
    supportsEditReferences(config) &&
    storeFor(config).entries.get(entry.id) === entry &&
    entry.active &&
    normalizedPath(args['file_path']) === binding.filePath &&
    args['old_string'] === binding.oldString &&
    snapshot.digest === entry.digest &&
    version(snapshot.stats) === entry.identity &&
    snapshot.content
      .replace(/\r\n/g, '\n')
      .slice(binding.start, binding.end) === binding.oldString
  );
}

export function consumeEditReference(config: Config, params: object): void {
  const binding = getEditReferenceBinding(config, params);
  if (binding) storeFor(config).entries.delete(binding.reference.id);
}

export function syncEditReferenceDelivery(
  config: Config,
  deliveredToolResultTexts: readonly string[],
): void {
  const store = stores.get(config);
  if (!store) return;
  if (store.scope !== scope(config) || !supportsEditReferences(config)) {
    stores.delete(config);
    return;
  }
  for (const [id, entry] of store.entries) {
    const delivered = deliveredToolResultTexts.some((text) =>
      text.includes(entry.recoveryText),
    );
    if (delivered) entry.active = true;
    else if (entry.active) store.entries.delete(id);
  }
}

export function invalidateDeliveredEditReferences(config: Config): void {
  const store = stores.get(config);
  if (!store) return;
  for (const [id, entry] of store.entries)
    if (entry.active) store.entries.delete(id);
}

export function clearEditReferences(config: Config): void {
  stores.delete(config);
}
