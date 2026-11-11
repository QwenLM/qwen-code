/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_TASK_OUTPUT_BYTES_DISPLAY } from '../utils/task/diskOutput.js';
import type { BackgroundReason } from '../services/executionLifecycleService.js';
import {
  prependShellExitStatus,
  type ShellExitStatusFields,
} from './shell-exit-status.js';
import {
  TOOL_OUTPUTS_DIR,
  formatFileSize,
  sanitizeFilenamePart,
} from '../utils/fileUtils.js';
import {
  SHELL_OUTPUT_PREVIEW_MAX_BYTES,
  SHELL_INLINE_OUTPUT_MAX_BYTES,
  SHELL_PERSISTED_OUTPUT_MAX_BYTES,
  SHELL_PERSISTED_PREVIEW_CHARS,
} from '../utils/shellOutputPolicy.js';

export {
  SHELL_INLINE_OUTPUT_MAX_BYTES,
  SHELL_OUTPUT_PREVIEW_MAX_BYTES,
  SHELL_PERSISTED_OUTPUT_MAX_BYTES,
  SHELL_PERSISTED_PREVIEW_CHARS,
  SHELL_PROGRESS_THRESHOLD_MS,
} from '../utils/shellOutputPolicy.js';

export interface ShellProgressMetrics {
  totalLines?: number;
  totalBytes?: number;
}

export interface PersistedShellOutput extends Record<string, unknown> {
  path: string;
  originalSizeBytes: number;
  savedSizeBytes: number;
  truncated: boolean;
  preview: string;
  /** Independent desktop tail preview; the model preview retains both ends. */
  tailPreview?: string;
}

interface ShellToolExecutionBase
  extends ShellProgressMetrics,
    Record<string, unknown> {
  persistedOutput?: PersistedShellOutput;
}

export interface CompletedShellToolExecutionData
  extends ShellToolExecutionBase,
    ShellExitStatusFields {
  kind: 'completed';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: number | null;
  errorMessage?: string;
  /** Files changed by this command that should be re-read before editing. */
  staleReadFileStateHint?: string;
  /** Compatibility fields consumed by existing transcript renderers. */
  interrupted?: false;
  isImage?: false;
  noOutputExpected?: false;
}

export interface CancelledShellToolExecutionData
  extends ShellToolExecutionBase {
  kind: 'cancelled';
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs?: number;
  outputLimitExceeded?: boolean;
  isError?: true;
}

/** Deterministic failure reason shared by model content and shell displays. */
export function formatShellTerminationReason(data: {
  timedOut?: boolean;
  timeoutMs?: number;
  outputLimitExceeded?: boolean;
}): string {
  if (data.outputLimitExceeded) {
    return `Command killed: output file exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY}.`;
  }
  if (data.timedOut) {
    const duration =
      data.timeoutMs === undefined
        ? ''
        : data.timeoutMs < 1000
          ? ` after ${data.timeoutMs}ms`
          : ` after ${data.timeoutMs / 1000}s`;
    return `Command timed out${duration} and was terminated.`;
  }
  return '';
}

export interface BackgroundedShellToolExecutionData
  extends ShellToolExecutionBase {
  kind: 'backgrounded';
  pid: number;
  taskId: string;
  outputFile?: string;
  command: string;
  /** Compatibility summary used by existing structured renderers. */
  stdout?: string;
  initialOutput: string;
  backgroundReason?: BackgroundReason;
}

export type ShellToolExecutionData =
  | CompletedShellToolExecutionData
  | CancelledShellToolExecutionData
  | BackgroundedShellToolExecutionData;

export interface UserShellProgress extends ShellProgressMetrics {
  output: string;
}

interface UserShellCommandOutcomeBase {
  command: string;
  displayOutput: string;
  modelOutput: {
    stdout: string;
    stderr: string;
  };
  progress?: ShellProgressMetrics;
}

export type UserShellCommandOutcome =
  | (UserShellCommandOutcomeBase & {
      kind: 'completed';
      exitCode: number | null;
      signal: number | null;
      errorMessage?: string;
    })
  | (UserShellCommandOutcomeBase & {
      kind: 'cancelled';
      timedOut: boolean;
    })
  | (UserShellCommandOutcomeBase & {
      kind: 'backgrounded';
      pid: number;
    });

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

export function isShellToolExecutionData(
  value: unknown,
): value is ShellToolExecutionData {
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return false;
  }

  const data = value as Record<string, unknown>;
  switch (data['kind']) {
    case 'completed':
      return (
        isString(data['stdout']) &&
        isString(data['stderr']) &&
        isNullableNumber(data['exitCode']) &&
        isNullableNumber(data['signal'])
      );
    case 'cancelled':
      return (
        isString(data['stdout']) &&
        isString(data['stderr']) &&
        isBoolean(data['timedOut'])
      );
    case 'backgrounded':
      return (
        isNumber(data['pid']) &&
        isString(data['taskId']) &&
        isString(data['command']) &&
        (data['stdout'] === undefined || isString(data['stdout'])) &&
        isString(data['initialOutput'])
      );
    default:
      return false;
  }
}

function normalizeInlineShellOutput(output: string): string {
  return output.trim() || '(Command produced no output)';
}

export function formatPersistedShellOutput(
  output: PersistedShellOutput,
): string {
  const originalSize = formatFileSize(output.originalSizeBytes);
  const savedDescription = output.truncated
    ? `Output exceeded the ${formatFileSize(SHELL_PERSISTED_OUTPUT_MAX_BYTES)} persist limit; only the first ${formatFileSize(output.savedSizeBytes)} were saved to:`
    : `Output too large (${originalSize}). Full output saved to:`;
  return (
    `${savedDescription}\n${output.path}\n\n` +
    `Preview (head and tail, up to ${SHELL_PERSISTED_PREVIEW_CHARS} characters):\n` +
    (output.preview || '(Command produced no text preview)')
  );
}

/**
 * The command's own output, spill-file rendering included, with empty output
 * left falsy so callers can choose their own placeholder.
 */
export function shellOutputBody(
  data: Exclude<ShellToolExecutionData, { kind: 'backgrounded' }>,
): string {
  return data.persistedOutput
    ? formatPersistedShellOutput(data.persistedOutput)
    : data.stdout;
}

export function formatShellExecutionOutput(
  data: ShellToolExecutionData,
): string {
  if (data.kind === 'backgrounded') {
    return data.initialOutput.trim();
  }
  const body = shellOutputBody(data);
  return data.persistedOutput ? body : normalizeInlineShellOutput(body);
}

/**
 * Prepends the deterministic process status to model-facing content. Also used
 * to restore it after lossy output summarization, hence the `startsWith` guard
 * inside `prependShellExitStatus`.
 */
export function prependCompletedShellFailureStatus(
  content: string,
  data: CompletedShellToolExecutionData,
): string {
  if (!data.isError) return content;
  return prependShellExitStatus(content, data.exitCode, data.signal);
}

export function formatCompletedShellModelContent(
  data: CompletedShellToolExecutionData,
): string {
  // Preserve the shell's merged output verbatim. Process status is a prefix;
  // display labels and process IDs belong to UI/structured metadata, not the
  // model-facing command output. With no output at all, the interpretation is
  // the only thing left to say.
  const body = shellOutputBody(data);
  const parts = body
    ? [body, data.stderr, data.returnCodeInterpretation]
    : [data.returnCodeInterpretation, data.stderr];

  return prependCompletedShellFailureStatus(
    parts.filter(Boolean).join('\n'),
    data,
  );
}

/** 读取原始日志最后 4 KiB，边界处不拆开 UTF-8 字符。 */
async function readUtf8TailPreview(sourcePath: string): Promise<string> {
  const handle = await fsPromises.open(sourcePath, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, SHELL_OUTPUT_PREVIEW_MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    let start = 0;
    while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
    return buffer.subarray(start, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
}

async function copyFilePrefixAtomically(
  sourcePath: string,
  destinationPath: string,
  maxBytes: number,
): Promise<void> {
  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${randomUUID()}`;
  const source = await fsPromises.open(sourcePath, 'r');
  let destination: fsPromises.FileHandle | undefined;
  let sourceClosed = false;

  try {
    destination = await fsPromises.open(temporaryPath, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < maxBytes) {
      const length = Math.min(buffer.length, maxBytes - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      await destination.writeFile(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await destination.sync();
    await destination.close();
    destination = undefined;
    // Windows cannot unlink an open source file. Close it before publishing
    // the destination and performing best-effort source cleanup.
    await source.close();
    sourceClosed = true;

    // link() is an exclusive, atomic publication step and fails if a target
    // unexpectedly already exists.
    await fsPromises.link(temporaryPath, destinationPath);
    await fsPromises.unlink(temporaryPath).catch(() => undefined);
    await fsPromises.unlink(sourcePath).catch(() => undefined);
  } catch (error) {
    await destination?.close().catch(() => undefined);
    await fsPromises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    if (!sourceClosed) await source.close();
  }
}

export interface PersistShellOutputOptions {
  sourcePath: string;
  originalSizeBytes: number;
  projectTempDir: string;
  sessionId: string;
  /** Initial bounded, decoded Bash output, used for the preview's head. */
  output: string;
}

/**
 * Promote a foreground task output file into session-managed tool output.
 * Persistence errors are deliberately left to the caller: command execution
 * has already completed and must not be converted into an execution failure.
 */
export async function persistShellOutput(
  options: PersistShellOutputOptions,
): Promise<PersistedShellOutput> {
  const { sourcePath, originalSizeBytes, projectTempDir, sessionId, output } = options;
  const safeSession = sanitizeFilenamePart(sessionId);
  const toolOutputDir = path.join(
    projectTempDir,
    TOOL_OUTPUTS_DIR,
    `session-${safeSession}`,
  );
  await fsPromises.mkdir(toolOutputDir, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(toolOutputDir, 0o700);

  const sourceBaseName = path.basename(sourcePath);
  const sourceExtension = path
    .extname(sourceBaseName)
    .replace(/[^a-zA-Z0-9.]/g, '');
  const sourceStem = sanitizeFilenamePart(
    path.basename(sourceBaseName, path.extname(sourceBaseName)),
  );
  const baseName = `${sourceStem || 'shell-output'}${sourceExtension || '.output'}`;
  const destinationPath = path.join(toolOutputDir, baseName);
  let preview = output;
  const tailPreview = await readUtf8TailPreview(sourcePath);
  // The foreground read is bounded in bytes. Trimming can leave a short or
  // empty head even when the unread portion contains useful trailing output.
  if (originalSizeBytes > SHELL_INLINE_OUTPUT_MAX_BYTES ||
      output.length > SHELL_PERSISTED_PREVIEW_CHARS) {
    const marker = '\n… middle omitted …\n';
    const headBudget = Math.floor(
      (SHELL_PERSISTED_PREVIEW_CHARS - marker.length) / 2,
    );
    const tailBudget = SHELL_PERSISTED_PREVIEW_CHARS - marker.length - headBudget;
    let headEnd = headBudget;
    const headLast = output.charCodeAt(headEnd - 1);
    if (headLast >= 0xd800 && headLast <= 0xdbff) headEnd--;
    let tailStart = Math.max(0, tailPreview.length - tailBudget);
    const tailFirst = tailPreview.charCodeAt(tailStart);
    if (tailFirst >= 0xdc00 && tailFirst <= 0xdfff) tailStart++;
    preview = output.slice(0, headEnd) + marker + tailPreview.slice(tailStart);
  }
  const savedSizeBytes = Math.min(
    originalSizeBytes,
    SHELL_PERSISTED_OUTPUT_MAX_BYTES,
  );
  const truncated = originalSizeBytes > SHELL_PERSISTED_OUTPUT_MAX_BYTES;

  if (!truncated) {
    try {
      // Hard-link publication is atomic, does not overwrite, and avoids a
      // second full-size disk copy on the common same-filesystem path.
      await fsPromises.link(sourcePath, destinationPath);
      await fsPromises.unlink(sourcePath).catch(() => undefined);
    } catch (error) {
      if (
        !new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP']).has(
          errorCode(error) ?? '',
        )
      ) {
        throw error;
      }
      await copyFilePrefixAtomically(
        sourcePath,
        destinationPath,
        savedSizeBytes,
      );
    }
  } else {
    await copyFilePrefixAtomically(
      sourcePath,
      destinationPath,
      SHELL_PERSISTED_OUTPUT_MAX_BYTES,
    );
  }

  await fsPromises.chmod(destinationPath, 0o600);
  return {
    path: destinationPath,
    originalSizeBytes,
    savedSizeBytes,
    truncated,
    preview,
    tailPreview,
  };
}
