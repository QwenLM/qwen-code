/**
 * DingTalk markdown normalization.
 *
 * DingTalk's markdown renderer is a limited subset with quirks:
 * - Tables don't render — convert to pipe-separated plain text
 * - Max message length ~3800 chars — split into chunks
 * - Code fences must be closed/reopened across chunk boundaries
 */

const CHUNK_LIMIT = 3800;

// --- Table conversion ---

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && !trimmed.startsWith('```');
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function renderTable(lines: string[]): string {
  const rows = lines.map(parseTableRow).filter((cells) => cells.length > 0);
  return rows.map((cells) => cells.join(' | ')).join('  \n');
}

export function convertTables(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let i = 0;
  let inCode = false;

  while (i < lines.length) {
    const line = lines[i] || '';
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      output.push(line);
      i++;
      continue;
    }

    if (
      !inCode &&
      i + 1 < lines.length &&
      isTableRow(line) &&
      isTableSeparator(lines[i + 1] || '')
    ) {
      const tableLines = [line];
      i += 2; // skip header + separator
      while (i < lines.length && isTableRow(lines[i] || '')) {
        tableLines.push(lines[i] || '');
        i++;
      }
      output.push(renderTable(tableLines));
      continue;
    }

    output.push(line);
    i++;
  }

  return output.join('\n');
}

// --- Chunk splitting ---

export function splitChunks(text: string): string[] {
  if (!text || text.length <= CHUNK_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let buf = '';
  const lines = text.split('\n');
  let inCode = false;

  for (const line of lines) {
    const fenceCount = (line.match(/```/g) || []).length;

    if (buf.length + line.length + 1 > CHUNK_LIMIT && buf.length > 0) {
      if (inCode) {
        buf += '\n```';
      }
      chunks.push(buf);
      buf = inCode ? '```\n' : '';
    }

    buf += (buf ? '\n' : '') + line;

    if (fenceCount % 2 === 1) {
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

/** Full normalization pipeline: tables → chunks. */
export function normalizeDingTalkMarkdown(text: string): string[] {
  const converted = convertTables(text);
  return splitChunks(converted);
}
