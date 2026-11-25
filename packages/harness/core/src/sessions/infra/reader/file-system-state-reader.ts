/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { SessionWriterStateSnapshot } from '../../domain/impl/writer/session-writer-state.js';
import type { SessionWriterStateReader } from './session-writer-state-reader.js';
import { decodeTranscriptLine } from '../codec/transcript-entry-codec.js';
import { isTranscriptMessageEntry } from '../entry/transcript-entry.js';

/**
 * Reads an existing transcript file to rebuild the writer's in-memory state.
 *
 * This is a deliberately simplified replacement for the legacy full graph
 * resolver: it collects message UUIDs (for deduplication) and the latest
 * metadata values without reconstructing the entire DAG.
 *
 * It returns the raw final message cursor (`mainParentUuid`) and any explicit
 * active-leaf cursor (`activeLeafUuid`) exactly as they appear in the file;
 * the caller (the writer) is responsible for choosing which one to use as the
 * effective parent for subsequent writes.
 */
export class FileSystemSessionWriterStateReader
  implements SessionWriterStateReader
{
  async load(
    filePath: string,
    sessionId: string,
  ): Promise<SessionWriterStateSnapshot> {
    void sessionId;
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch (error) {
      if (isENOENT(error)) {
        return { messageUuids: [], fileExisted: false };
      }
      throw error;
    }

    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);

    const messageUuids: string[] = [];
    let mainParentUuid: string | null | undefined;
    let customTitle: string | undefined;
    let lastPrompt: string | undefined;
    let tag: string | undefined;
    let workspaceDirectories: string[] | undefined;
    let activeLeafUuid: string | null | undefined;

    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      const decoded = decodeTranscriptLine(line);
      if (decoded.kind !== 'entry') {
        continue;
      }
      const entry = decoded.entry;

      if (isTranscriptMessageEntry(entry)) {
        messageUuids.push(entry.uuid);
        mainParentUuid = entry.uuid;
        continue;
      }

      switch (entry.type) {
        case 'custom-title':
          customTitle = entry.customTitle;
          break;
        case 'last-prompt':
          lastPrompt = entry.lastPrompt;
          break;
        case 'tag':
          tag = entry.tag;
          break;
        case 'workspace-directories':
          workspaceDirectories = [...entry.directories];
          break;
        case 'active-leaf':
          activeLeafUuid = entry.leafUuid;
          break;
        default:
          break;
      }
    }

    return {
      messageUuids,
      mainParentUuid,
      activeLeafUuid,
      fileExisted: true,
      ...(customTitle ? { customTitle } : {}),
      ...(lastPrompt ? { lastPrompt } : {}),
      ...(tag ? { tag } : {}),
      ...(workspaceDirectories
        ? { workspaceDirectories: [...workspaceDirectories] }
        : {}),
    };
  }
}

function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
