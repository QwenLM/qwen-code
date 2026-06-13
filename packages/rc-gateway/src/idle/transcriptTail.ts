/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidSessionId } from '../sessions/chatsPath.js';
import { recordText, type TranscriptRecord } from '../search/transcripts.js';
import type { TurnText } from './suggester.js';

/**
 * Reads the most recent user/assistant turns of a session transcript to feed the
 * idle suggester (proposal `add-idle-suggestions`, slice 2). A BOUNDED TAIL scan
 * — the same EOF-window technique as `readSessionTitle` — because a transcript
 * can be many MB and a single tool_result record can itself be enormous; the
 * suggester needs only the last few conversational turns, never the whole file.
 *
 * Bounds (all defaulted, all defensive):
 *  - `maxBytes` (default 256 KiB): only the last N bytes are read. A turn pushed
 *    out of the window by large intervening tool output is simply not seen
 *    (graceful: fewer turns, never a crash or unbounded read).
 *  - `maxTurns` (default 8): the LAST N qualifying turns (newest-biased).
 *  - `maxTextLen` (default 2000): each turn's text is whitespace-collapsed and
 *    ellipsis-truncated, so one verbose turn can't dominate the model context.
 *
 * Only `type === 'user' | 'assistant'` records with non-empty searchable text
 * are kept (tool_result/system/title records are skipped); `recordText` is reused
 * verbatim so the suggester sees the SAME text the search index/scanner do.
 *
 * Title-reading is enrichment, so this NEVER throws: an invalid id, ENOENT, any
 * open/read/parse error, or an empty file all yield `[]`, and the handle is
 * always closed.
 */
export async function readRecentTurns(
  chatsDir: string,
  sessionId: string,
  opts: { maxBytes?: number; maxTurns?: number; maxTextLen?: number } = {},
): Promise<TurnText[]> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const maxTurns = opts.maxTurns ?? 8;
  const maxTextLen = opts.maxTextLen ?? 2000;

  // Never path-join an unvalidated id (defense-in-depth; the pump passes a
  // daemon-trusted id, but this module is independently reusable).
  if (!isValidSessionId(sessionId)) return [];

  let handle;
  try {
    handle = await open(join(chatsDir, `${sessionId}.jsonl`), 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return [];
    const readBytes = Math.min(size, maxBytes);
    const start = size - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    let off = 0;
    while (off < readBytes) {
      const { bytesRead } = await handle.read(
        buf,
        off,
        readBytes - off,
        start + off,
      );
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    const lines = buf.subarray(0, off).toString('utf8').split('\n');
    // When the window did not start at byte 0, its first line may be a partial
    // record — drop it so JSON.parse only ever sees complete lines.
    if (start > 0) lines.shift();

    const turns: TurnText[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let rec: TranscriptRecord;
      try {
        rec = JSON.parse(line) as TranscriptRecord;
      } catch {
        continue; // partial / non-JSON line → skip.
      }
      if (rec.type !== 'user' && rec.type !== 'assistant') continue;
      const collapsed = recordText(rec).replace(/\s+/g, ' ').trim();
      if (!collapsed) continue;
      const text =
        collapsed.length > maxTextLen
          ? collapsed.slice(0, maxTextLen - 1) + '…'
          : collapsed;
      turns.push({ role: rec.type, text });
    }
    // Newest-biased: keep the LAST maxTurns in original (chronological) order.
    return turns.length > maxTurns
      ? turns.slice(turns.length - maxTurns)
      : turns;
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
}
