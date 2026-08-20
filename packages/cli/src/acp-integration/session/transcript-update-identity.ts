/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

export class TranscriptUpdateIdentityProjector {
  private promptId?: string;
  private activeLane?: string;
  private activeSegmentId?: string;
  private predecessorId?: string;

  project(update: SessionUpdate, promptId: string | undefined): SessionUpdate {
    const existingSegmentId = readSegmentId(update);
    if (!promptId) return update;

    if (this.promptId !== promptId) {
      this.promptId = promptId;
      this.activeLane = undefined;
      this.activeSegmentId = undefined;
      this.predecessorId = `prompt:${promptId}`;
    }

    const lane = readTextLane(update);
    if (existingSegmentId) {
      if (lane) {
        this.activeLane = lane;
        this.activeSegmentId = existingSegmentId;
        this.predecessorId = existingSegmentId;
      }
      return update;
    }
    if (!lane) {
      const boundaryId = readBoundaryId(update);
      if (boundaryId) {
        this.predecessorId = hashIdentity([
          this.predecessorId ?? `prompt:${promptId}`,
          boundaryId,
        ]);
        this.activeLane = undefined;
        this.activeSegmentId = undefined;
      }
      return update;
    }

    if (
      this.activeLane !== lane ||
      !this.activeSegmentId ||
      isDiscreteMessage(update)
    ) {
      this.activeSegmentId = `live:${hashIdentity([
        promptId,
        this.predecessorId ?? `prompt:${promptId}`,
        lane,
      ])}`;
      this.activeLane = lane;
      this.predecessorId = this.activeSegmentId;
    }

    return withSegmentId(update, this.activeSegmentId);
  }
}

function isDiscreteMessage(update: SessionUpdate): boolean {
  const record = update as unknown as Record<string, unknown>;
  const meta = isRecord(record['_meta']) ? record['_meta'] : undefined;
  return meta?.['qwenDiscreteMessage'] === true;
}

function readTextLane(update: SessionUpdate): string | undefined {
  const record = update as unknown as Record<string, unknown>;
  const kind = record['sessionUpdate'];
  if (
    kind !== 'user_message_chunk' &&
    kind !== 'agent_message_chunk' &&
    kind !== 'agent_thought_chunk'
  ) {
    return undefined;
  }
  const content = isRecord(record['content']) ? record['content'] : undefined;
  if (
    content?.['type'] !== 'text' ||
    typeof content['text'] !== 'string' ||
    content['text'].length === 0
  ) {
    return undefined;
  }
  const meta = isRecord(record['_meta']) ? record['_meta'] : undefined;
  const parentToolCallId = readString(meta, 'parentToolCallId');
  return `${kind}:${parentToolCallId ?? 'root'}`;
}

function readBoundaryId(update: SessionUpdate): string | undefined {
  const record = update as unknown as Record<string, unknown>;
  const toolCallId = readString(record, 'toolCallId');
  if (toolCallId) return `tool:${toolCallId}`;

  const meta = isRecord(record['_meta']) ? record['_meta'] : undefined;
  const transcript = isRecord(meta?.['qwenTranscript'])
    ? meta['qwenTranscript']
    : undefined;
  const planToolCallId = readString(transcript, 'planToolCallId');
  if (planToolCallId) return `plan:${planToolCallId}`;

  return undefined;
}

function readSegmentId(update: SessionUpdate): string | undefined {
  const record = update as unknown as Record<string, unknown>;
  const meta = isRecord(record['_meta']) ? record['_meta'] : undefined;
  const transcript = isRecord(meta?.['qwenTranscript'])
    ? meta['qwenTranscript']
    : undefined;
  return readString(transcript, 'segmentId');
}

function withSegmentId(
  update: SessionUpdate,
  segmentId: string,
): SessionUpdate {
  const record = update as unknown as Record<string, unknown>;
  const meta = isRecord(record['_meta']) ? record['_meta'] : undefined;
  const transcript = isRecord(meta?.['qwenTranscript'])
    ? meta['qwenTranscript']
    : undefined;
  return {
    ...record,
    _meta: {
      ...(meta ?? {}),
      qwenTranscript: {
        ...(transcript ?? {}),
        segmentId,
      },
    },
  } as unknown as SessionUpdate;
}

function hashIdentity(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, 'utf8')));
    hash.update(':');
    hash.update(part);
  }
  return hash.digest('hex').slice(0, 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined;
}
