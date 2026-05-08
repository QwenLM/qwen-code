/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { toCodePoints } from './textUtils.js';

const FINGERPRINT_TAIL_CHARS = 2000;
const STREAM_DELTA_OVERLAP_MAX_SCAN_CHARS = 4000;
const STREAM_DELTA_OVERLAP_MIN_BYTES = 6;
const STREAM_DELTA_STRUCTURAL_OVERLAP_MIN_BYTES = 4;

export interface TextRepeatDiagnostics {
  fingerprint: string;
  tailFingerprint: string;
  chars: number;
  lines: number;
  maxLineRepeatCount: number;
  maxLineRepeatFingerprint: string | null;
  maxConsecutiveLineRepeatCount: number;
  maxConsecutiveLineRepeatFingerprint: string | null;
}

export interface StreamDeltaNormalizationResult {
  text: string;
  action: 'unchanged' | 'overlap-suffix' | 'contained-prefix-suffix' | 'stale';
  suppressedPrefixChars: number;
  overlapChars: number;
  overlapBytes: number;
}

let directLogPath: string | null = null;
const loggerByScope = new Map<string, ReturnType<typeof createDebugLogger>>();

export function isTuiStreamDebugEnabled(): boolean {
  const value =
    process.env['QWEN_TUI_STREAM_DEBUG'] ?? process.env['QWEN_STREAM_DEBUG'];
  if (!value) {
    return false;
  }

  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

export function createTuiStreamDebugLogger(scope: string) {
  return createDebugLogger(scope);
}

function getLogger(scope: string): ReturnType<typeof createDebugLogger> {
  let logger = loggerByScope.get(scope);
  if (!logger) {
    logger = createTuiStreamDebugLogger(scope);
    loggerByScope.set(scope, logger);
  }
  return logger;
}

function getDirectLogPath(): string {
  if (!directLogPath) {
    const runtimeDir = process.env['QWEN_RUNTIME_DIR'];
    const baseDir = runtimeDir
      ? path.resolve(runtimeDir.replace(/^~(?=$|[/\\])/, homedir()))
      : path.join(homedir() || tmpdir(), '.qwen');
    const debugDir = path.join(baseDir, 'debug');
    mkdirSync(debugDir, { recursive: true });
    directLogPath = `${debugDir}/tui-stream-${process.pid}.jsonl`;
  }
  return directLogPath;
}

export function logTuiStreamMetric(
  scope: string,
  metric: string,
  payload: Record<string, unknown>,
): void {
  if (!isTuiStreamDebugEnabled()) {
    return;
  }

  // The normal debug logger depends on a process-wide Config session. During
  // local TUI repros it is easy to start from a path that has not refreshed the
  // `latest` symlink yet, so keep a small direct JSONL trail as the source of
  // truth for stream diagnostics.
  try {
    appendFileSync(
      getDirectLogPath(),
      `${JSON.stringify({
        time: new Date().toISOString(),
        pid: process.pid,
        scope,
        metric,
        payload,
      })}\n`,
      'utf8',
    );
  } catch {
    // Diagnostics must never affect rendering.
  }

  try {
    getLogger(scope).debug(metric, payload);
  } catch {
    // Diagnostics must never affect rendering.
  }
}

export function fingerprintText(text: string): string {
  let hash = 2166136261;
  for (const char of toCodePoints(text)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

export function fingerprintTail(text: string): string {
  return fingerprintText(
    text.length > FINGERPRINT_TAIL_CHARS
      ? text.slice(-FINGERPRINT_TAIL_CHARS)
      : text,
  );
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isSignificantOverlap(overlap: string): boolean {
  const overlapBytes = byteLength(overlap);
  const hasMarkdownStructure = /[#|`\n]/.test(overlap);
  return (
    overlapBytes >= STREAM_DELTA_OVERLAP_MIN_BYTES ||
    (hasMarkdownStructure &&
      overlapBytes >= STREAM_DELTA_STRUCTURAL_OVERLAP_MIN_BYTES)
  );
}

function findContainedPrefixReplayLength(
  priorText: string,
  incomingText: string,
): number {
  const priorTail =
    priorText.length > STREAM_DELTA_OVERLAP_MAX_SCAN_CHARS
      ? priorText.slice(-STREAM_DELTA_OVERLAP_MAX_SCAN_CHARS)
      : priorText;
  const maxPrefix = Math.min(
    priorTail.length,
    incomingText.length,
    STREAM_DELTA_OVERLAP_MAX_SCAN_CHARS,
  );

  for (let length = maxPrefix; length > 0; length -= 1) {
    const prefix = incomingText.slice(0, length);
    if (isSignificantOverlap(prefix) && priorTail.includes(prefix)) {
      return length;
    }
  }

  return 0;
}

export function normalizeOverlappingStreamDelta(
  priorText: string,
  incomingText: string,
): StreamDeltaNormalizationResult {
  if (priorText.length === 0 || incomingText.length === 0) {
    return {
      text: incomingText,
      action: 'unchanged',
      suppressedPrefixChars: 0,
      overlapChars: 0,
      overlapBytes: 0,
    };
  }

  const maxOverlap = Math.min(
    priorText.length,
    incomingText.length,
    STREAM_DELTA_OVERLAP_MAX_SCAN_CHARS,
  );

  if (priorText.endsWith(incomingText) && isSignificantOverlap(incomingText)) {
    return {
      text: '',
      action: 'stale',
      suppressedPrefixChars: incomingText.length,
      overlapChars: incomingText.length,
      overlapBytes: byteLength(incomingText),
    };
  }

  for (let length = maxOverlap; length > 0; length -= 1) {
    const overlap = incomingText.slice(0, length);
    if (isSignificantOverlap(overlap) && priorText.endsWith(overlap)) {
      return {
        text: incomingText.slice(length),
        action: 'overlap-suffix',
        suppressedPrefixChars: length,
        overlapChars: length,
        overlapBytes: byteLength(overlap),
      };
    }
  }

  // Recovery continuations often restart from a short anchor near the tail of
  // the previous response instead of byte-for-byte continuing at the exact end.
  // Treat a leading prefix that already exists in the previous tail as replayed
  // continuation context. This path is only used by continuation recovery in
  // the UI, so it does not rewrite normal incremental provider deltas.
  const containedPrefixLength = findContainedPrefixReplayLength(
    priorText,
    incomingText,
  );
  if (containedPrefixLength > 0) {
    const replayedPrefix = incomingText.slice(0, containedPrefixLength);
    let suffix = incomingText.slice(containedPrefixLength);
    if (
      suffix.length > 0 &&
      replayedPrefix.endsWith('\n') &&
      !priorText.endsWith('\n') &&
      !suffix.startsWith('\n')
    ) {
      suffix = `\n${suffix}`;
    }
    return {
      text: suffix,
      action: suffix.length > 0 ? 'contained-prefix-suffix' : 'stale',
      suppressedPrefixChars: containedPrefixLength,
      overlapChars: containedPrefixLength,
      overlapBytes: byteLength(replayedPrefix),
    };
  }

  return {
    text: incomingText,
    action: 'unchanged',
    suppressedPrefixChars: 0,
    overlapChars: 0,
    overlapBytes: 0,
  };
}

export function normalizeSuffixOverlappingStreamDelta(
  priorText: string,
  incomingText: string,
): StreamDeltaNormalizationResult {
  if (priorText.length === 0 || incomingText.length === 0) {
    return {
      text: incomingText,
      action: 'unchanged',
      suppressedPrefixChars: 0,
      overlapChars: 0,
      overlapBytes: 0,
    };
  }

  if (priorText.endsWith(incomingText) && isSignificantOverlap(incomingText)) {
    return {
      text: '',
      action: 'stale',
      suppressedPrefixChars: incomingText.length,
      overlapChars: incomingText.length,
      overlapBytes: byteLength(incomingText),
    };
  }

  const maxOverlap = Math.min(
    priorText.length,
    incomingText.length,
    STREAM_DELTA_OVERLAP_MAX_SCAN_CHARS,
  );

  for (let length = maxOverlap; length > 0; length -= 1) {
    const overlap = incomingText.slice(0, length);
    if (isSignificantOverlap(overlap) && priorText.endsWith(overlap)) {
      return {
        text: incomingText.slice(length),
        action: incomingText.length === length ? 'stale' : 'overlap-suffix',
        suppressedPrefixChars: length,
        overlapChars: length,
        overlapBytes: byteLength(overlap),
      };
    }
  }

  return {
    text: incomingText,
    action: 'unchanged',
    suppressedPrefixChars: 0,
    overlapChars: 0,
    overlapBytes: 0,
  };
}

export function countTextLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

export function getTextRepeatDiagnostics(text: string): TextRepeatDiagnostics {
  const counts = new Map<string, number>();
  let maxLine = '';
  let maxLineRepeatCount = 0;
  let previousLine: string | null = null;
  let currentConsecutiveLine = '';
  let currentConsecutiveCount = 0;
  let maxConsecutiveLine = '';
  let maxConsecutiveLineRepeatCount = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      previousLine = null;
      currentConsecutiveLine = '';
      currentConsecutiveCount = 0;
      continue;
    }

    const count = (counts.get(line) ?? 0) + 1;
    counts.set(line, count);
    if (count > maxLineRepeatCount) {
      maxLine = line;
      maxLineRepeatCount = count;
    }

    if (line === previousLine) {
      currentConsecutiveCount += 1;
    } else {
      currentConsecutiveLine = line;
      currentConsecutiveCount = 1;
      previousLine = line;
    }

    if (currentConsecutiveCount > maxConsecutiveLineRepeatCount) {
      maxConsecutiveLine = currentConsecutiveLine;
      maxConsecutiveLineRepeatCount = currentConsecutiveCount;
    }
  }

  return {
    fingerprint: fingerprintText(text),
    tailFingerprint: fingerprintTail(text),
    chars: text.length,
    lines: countTextLines(text),
    maxLineRepeatCount,
    maxLineRepeatFingerprint:
      maxLineRepeatCount > 1 ? fingerprintText(maxLine) : null,
    maxConsecutiveLineRepeatCount,
    maxConsecutiveLineRepeatFingerprint:
      maxConsecutiveLineRepeatCount > 1
        ? fingerprintText(maxConsecutiveLine)
        : null,
  };
}
