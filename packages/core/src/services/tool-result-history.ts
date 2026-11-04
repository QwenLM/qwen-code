/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import type { Content, Part } from '@google/genai';
import type {
  ChatRecordingService,
  RecordedToolResultAdmission,
} from './chatRecordingService.js';
import { SessionTranscriptChangedError } from './session-writer-lease.js';
import { buildSyntheticToolResponseParts } from '../core/turn-interruption.js';

export function matchToolResultParts(
  recordPackets: ReadonlyArray<readonly Part[]>,
  submitted: readonly Part[],
): Part[][] {
  const packets = recordPackets.map((parts, recordIndex) => {
    const anchor = parts.findIndex((part) => part.functionResponse);
    if (anchor < 0) throw new SessionTranscriptChangedError();
    const starts = submitted.flatMap((part, index) => {
      const start = index - anchor;
      return start >= 0 &&
        isDeepStrictEqual(part, parts[anchor]) &&
        parts.every((original, offset) =>
          isDeepStrictEqual(original, submitted[start + offset]),
        )
        ? [start]
        : [];
    });
    if (starts.length !== 1) throw new SessionTranscriptChangedError();
    return { parts, start: starts[0], recordIndex };
  });
  const consumed = new Set<number>();
  const matches: Part[][] = [];
  for (const { parts, start, recordIndex } of packets.sort(
    (a, b) => a.start - b.start,
  )) {
    matches[recordIndex] = parts.map((_part, offset) => {
      const index = start + offset;
      if (consumed.has(index)) throw new SessionTranscriptChangedError();
      consumed.add(index);
      return submitted[index];
    });
  }
  return matches;
}

export async function settleToolResultHistory(
  recorder: Pick<ChatRecordingService, 'recordToolResultAdmission'> | undefined,
  message: Content,
  toolOutput: readonly Part[],
  withheldReason?: string,
): Promise<Content> {
  const admissions =
    (await recorder?.recordToolResultAdmission?.(toolOutput, withheldReason)) ??
    [];
  return projectToolResultHistory(
    message,
    toolOutput,
    admissions,
    withheldReason,
  );
}

export function projectToolResultHistory(
  message: Content,
  toolOutput: readonly Part[],
  admissions: readonly RecordedToolResultAdmission[],
  withheldReason?: string,
): Content {
  const decisions = new Map<number, RecordedToolResultAdmission['decision']>();
  // The recorder has already validated these exact submitted occurrences.
  for (const admission of admissions) {
    const start = toolOutput.findIndex((_part, index) =>
      admission.parts.every(
        (original, offset) => original === toolOutput[index + offset],
      ),
    );
    admission.parts.forEach((_part, offset) => {
      decisions.set(start + offset, admission.decision);
    });
  }
  const consumed = new Set<number>();
  return {
    ...message,
    parts: (message.parts ?? []).flatMap((part) => {
      const index = toolOutput.findIndex(
        (original, occurrence) =>
          original === part && !consumed.has(occurrence),
      );
      if (index < 0) return [part];
      consumed.add(index);
      const decision = decisions.get(index);
      if (decision === 'admitted') return [part];
      const reason =
        typeof decision === 'object' ? decision.withheld : withheldReason;
      if (reason === undefined) return [part];
      if (part.functionResponse?.id) {
        return buildSyntheticToolResponseParts(
          [
            {
              callId: part.functionResponse.id,
              name: part.functionResponse.name ?? '',
            },
          ],
          reason,
        );
      }
      return [];
    }),
  };
}
