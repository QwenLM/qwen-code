/**
 * DingTalk markdown normalization.
 *
 * DingTalk's markdown renderer is a limited subset with quirks:
 * - Max message length ~3800 chars — split into chunks
 * - Code fences must be closed/reopened across chunk boundaries
 */

export const DINGTALK_CHUNK_LIMIT = 3800;

// --- Chunk splitting ---

function safeUtf16SliceEnd(value: string, end: number): number {
  if (end <= 0 || end >= value.length) return end;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
    ? end - 1
    : end;
}

export function splitChunks(
  text: string,
  chunkLimit = DINGTALK_CHUNK_LIMIT,
): string[] {
  if (!text || text.length <= chunkLimit) {
    return [text];
  }

  const chunks: string[] = [];
  let buf = '';
  const lines = text.split('\n');
  let inCode = false;

  const flush = (keepCodeOpen = inCode) => {
    if (keepCodeOpen) {
      buf += '\n```';
    }
    chunks.push(buf);
    buf = keepCodeOpen ? '```' : '';
  };

  const appendLine = (
    line: string,
    needsLineBreak: boolean,
    closesCodeFence: boolean,
    leavesCodeFenceOpen: boolean,
  ) => {
    let remaining = line;
    let prefixPending = needsLineBreak;
    let lineOpenedFenceInBuffer = false;

    while (remaining.length > 0 || prefixPending) {
      const prefix = prefixPending ? '\n' : '';
      const fitsAsFinalPiece =
        remaining.length <= chunkLimit - buf.length - prefix.length;
      const closeFenceOverhead =
        (inCode && !(closesCodeFence && fitsAsFinalPiece)) ||
        (!inCode && leavesCodeFenceOpen)
          ? '\n```'.length
          : 0;
      const available =
        chunkLimit - closeFenceOverhead - buf.length - prefix.length;

      if (available <= 0) {
        flush(inCode || lineOpenedFenceInBuffer);
        continue;
      }

      let pieceLength = Math.min(available, remaining.length);
      if (pieceLength < remaining.length) {
        for (
          let fenceStart = Math.max(0, pieceLength - 2);
          fenceStart < pieceLength;
          fenceStart++
        ) {
          if (
            remaining.slice(fenceStart, fenceStart + 3) === '```' &&
            pieceLength < fenceStart + 3
          ) {
            pieceLength = fenceStart;
            break;
          }
        }
      }
      pieceLength = safeUtf16SliceEnd(remaining, pieceLength);

      if (pieceLength === 0 && remaining.length > 0) {
        if (!buf) {
          throw new RangeError(
            'chunk limit cannot contain one Unicode character',
          );
        }
        flush(inCode || lineOpenedFenceInBuffer);
        continue;
      }

      const piece = remaining.slice(0, pieceLength);
      const appendedText = prefix + piece;
      buf += appendedText;
      remaining = remaining.slice(piece.length);
      prefixPending = false;
      lineOpenedFenceInBuffer ||=
        !inCode && leavesCodeFenceOpen && appendedText.includes('```');

      if (remaining.length > 0) {
        const keepCodeOpen = inCode || lineOpenedFenceInBuffer;
        flush(keepCodeOpen);
        prefixPending = keepCodeOpen;
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    const fenceCount = (line.match(/```/g) || []).length;
    const togglesCodeFence = fenceCount % 2 === 1;
    appendLine(
      line,
      i > 0,
      inCode && togglesCodeFence,
      inCode !== togglesCodeFence,
    );

    if (togglesCodeFence) {
      inCode = !inCode;
    }
  }

  if (buf) {
    chunks.push(buf);
  }

  return chunks;
}

/** Extract a short title from the first line of markdown for the webhook payload. */
export function extractTitle(text: string): string {
  const firstLine = text.split('\n')[0] || '';
  const cleaned = firstLine.replace(/^[#*\s\->]+/, '').slice(0, 20);
  return cleaned || 'Reply';
}

/** Split long Markdown messages without changing their formatting. */
export function normalizeDingTalkMarkdown(
  text: string,
  chunkLimit = DINGTALK_CHUNK_LIMIT,
): string[] {
  return splitChunks(text, chunkLimit);
}
