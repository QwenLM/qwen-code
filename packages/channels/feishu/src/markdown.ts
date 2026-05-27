/**
 * Feishu markdown / rich text helpers.
 *
 * Feishu supports Markdown in interactive cards but has quirks:
 * - Tables render only in card messages (not in plain text messages)
 * - Max message content ~4000 chars — split into chunks
 * - Code fences must be closed/reopened across chunk boundaries
 */

const CHUNK_LIMIT = 4000;

/**
 * Split markdown into segments so that each segment contains at most one table.
 * This avoids Feishu card rendering issues when a single markdown element
 * contains a table followed by other content.
 */
function splitByTables(text: string): string[] {
  const lines = text.split('\n');
  const segments: string[] = [];
  let current: string[] = [];
  let inTable = false;
  let inCode = false;

  for (const line of lines) {
    // Track code fences (parity-based to handle inline code on same line)
    if ((line.match(/```/g) || []).length % 2 === 1) {
      inCode = !inCode;
      current.push(line);
      continue;
    }

    if (inCode) {
      current.push(line);
      continue;
    }

    const isTableLine =
      line.trim().startsWith('|') && line.trim().endsWith('|');

    if (isTableLine && !inTable) {
      // Entering a table — if there's content before, flush it
      if (current.length > 0 && current.some((l) => l.trim())) {
        segments.push(current.join('\n'));
        current = [];
      }
      inTable = true;
      current.push(line);
    } else if (!isTableLine && inTable) {
      // Leaving a table — flush the table segment
      inTable = false;
      segments.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    segments.push(current.join('\n'));
  }

  return segments.filter((s) => s.trim());
}

/**
 * Build a Feishu interactive card JSON structure with markdown content.
 * Uses a clean design with header, streaming indicator, and optional stop button.
 */
export function buildCardContent(
  markdown: string,
  options?: {
    title?: string;
    showStopButton?: boolean;
    isStreaming?: boolean;
    collapsible?: boolean;
    collapsibleThreshold?: number;
  },
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  // Main content + streaming indicator in one markdown block
  const contentMd = options?.isStreaming
    ? markdown + '\n\n---\n*生成中...*'
    : markdown;

  const threshold = options?.collapsibleThreshold || 500;

  // For long content, use collapsible panel if enabled
  if (
    options?.collapsible &&
    !options?.isStreaming &&
    markdown.length > threshold
  ) {
    // Find a split point near position 200 that doesn't break code fences
    const previewEnd = markdown.indexOf('\n', 200);
    const rawSplit = previewEnd > 0 ? previewEnd : 200;
    const safeSplit = markdown.lastIndexOf(' ', rawSplit);
    let splitAt = safeSplit > 100 ? safeSplit : rawSplit;
    // Verify fence parity at split point — if preview has odd fences,
    // move split to the nearest newline before/after where fences balance
    const previewCandidate = markdown.slice(0, splitAt);
    let fenceCount = 0;
    for (const line of previewCandidate.split('\n')) {
      if ((line.match(/```/g) || []).length % 2 === 1) fenceCount++;
    }
    if (fenceCount % 2 === 1) {
      // Inside a code block — find the closing fence and split after it
      const fenceStart = markdown.indexOf('\n```', splitAt);
      if (fenceStart > 0 && fenceStart < rawSplit + 500) {
        const fenceLineEnd = markdown.indexOf('\n', fenceStart + 1);
        splitAt = fenceLineEnd > 0 ? fenceLineEnd : fenceStart + 4;
      }
      // else: no nearby closing fence, accept the split as-is
    }
    const preview = markdown.slice(0, splitAt);
    const rest = markdown.slice(splitAt);

    elements.push({
      tag: 'markdown',
      content: preview,
    });
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      background_color: 'default',
      header: {
        title: {
          tag: 'plain_text',
          content: '查看更多',
        },
      },
      elements: [
        {
          tag: 'markdown',
          content: rest,
        },
      ],
    });
  } else if (options?.isStreaming) {
    // During streaming, keep a single markdown element to avoid structure flicker
    elements.push({
      tag: 'markdown',
      content: contentMd,
    });
  } else {
    // Final render: split by tables to avoid rendering issues
    const segments = splitByTables(contentMd);
    for (const segment of segments) {
      elements.push({
        tag: 'markdown',
        content: segment,
      });
    }
  }

  // Stop button
  if (options?.showStopButton) {
    elements.push({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: '停止',
      },
      type: 'danger',
      value: { action: 'stop' },
    });
  }

  // Header
  const header = options?.title
    ? {
        title: {
          tag: 'plain_text',
          content: options.isStreaming ? `${options.title} ...` : options.title,
        },
        template: options.isStreaming ? 'blue' : 'green',
      }
    : undefined;

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      summary: { content: markdown.slice(0, 3500) },
    },
    header,
    body: { elements },
  };
}

/** Extract a short title from the first line of markdown. */
export function extractTitle(text: string): string {
  const firstLine = text.split('\n')[0] || '';
  const cleaned = firstLine.replace(/^[#*\s\->]+/, '').slice(0, 20);
  return cleaned || 'Qwen Code';
}

/**
 * Split long text into chunks that fit within Feishu's message size limit.
 * Handles code fence boundaries across chunks.
 */
export function splitChunks(text: string): string[] {
  if (!text || text.length <= CHUNK_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let buf = '';
  const lines = text.split('\n');
  let inCode = false;
  let fenceLine = '```';

  for (const line of lines) {
    const fenceCount = (line.match(/```/g) || []).length;

    // Reserve space for closing fence when inside a code block
    const reserve = inCode ? fenceLine.length + 1 : 0;
    if (
      buf.length + line.length + 1 + reserve > CHUNK_LIMIT &&
      buf.length > 0
    ) {
      if (inCode) {
        buf += '\n```';
      }
      chunks.push(buf);
      buf = inCode ? fenceLine + '\n' : '';
    }

    buf += (buf ? '\n' : '') + line;

    // Hard-split oversized lines that exceed the limit on their own
    while (buf.length > CHUNK_LIMIT) {
      let piece = buf.slice(0, CHUNK_LIMIT);
      buf = buf.slice(CHUNK_LIMIT);
      if (inCode) {
        piece += '\n```';
        buf = fenceLine + '\n' + buf;
      }
      chunks.push(piece);
    }

    if (fenceCount % 2 === 1) {
      if (!inCode) {
        fenceLine = line.trim();
      }
      inCode = !inCode;
    }
  }

  if (buf) {
    chunks.push(buf);
  }

  return chunks;
}
