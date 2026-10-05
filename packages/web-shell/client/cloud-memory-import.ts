export const CLOUD_MEMORY_IMPORT_LIMITS = {
  files: 5,
  fileBytes: 1024 * 1024,
  segmentCharacters: 32_000,
} as const;

type Format = 'json' | 'jsonl' | 'text';

function format(name: string): Format | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jsonl')) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'text';
  return undefined;
}

function turn(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const outer = value as Record<string, unknown>;
  const nested =
    outer['message'] &&
    typeof outer['message'] === 'object' &&
    !Array.isArray(outer['message'])
      ? (outer['message'] as Record<string, unknown>)
      : outer;
  if (nested['role'] !== 'user' && nested['role'] !== 'assistant') return;
  const content = nested['content'];
  const text =
    typeof content === 'string'
      ? content.trim()
      : Array.isArray(content)
        ? content
            .map((part) =>
              part &&
              typeof part === 'object' &&
              !Array.isArray(part) &&
              (part as Record<string, unknown>)['type'] === 'text' &&
              typeof (part as Record<string, unknown>)['text'] === 'string'
                ? ((part as Record<string, unknown>)['text'] as string)
                : '',
            )
            .filter(Boolean)
            .join('\n')
            .trim()
        : '';
  return text ? `${nested['role']}: ${text}` : undefined;
}

function segment(blocks: string[]): string[] {
  const limit = CLOUD_MEMORY_IMPORT_LIMITS.segmentCharacters;
  const output: string[] = [];
  let current = '';
  for (const block of blocks) {
    const pieces = [];
    const points = Array.from(block);
    for (let index = 0; index < points.length; index += limit) {
      pieces.push(points.slice(index, index + limit).join(''));
    }
    for (const piece of pieces) {
      const next = current ? `${current}\n\n${piece}` : piece;
      if (Array.from(next).length > limit) {
        if (current) output.push(current);
        current = piece;
      } else {
        current = next;
      }
    }
  }
  if (current) output.push(current);
  return output;
}

export function parseCloudMemoryImport(name: string, text: string): string[] {
  const kind = format(name);
  if (!kind) throw new Error('Unsupported memory import file type.');
  if (kind === 'text') {
    const body = text.trim();
    if (!body) throw new Error('Memory import file is empty.');
    return segment([body]);
  }
  let records: unknown[];
  if (kind === 'jsonl') {
    records = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown);
  } else {
    const parsed = JSON.parse(text) as unknown;
    const messages =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['messages']
        : parsed;
    if (!Array.isArray(messages)) {
      throw new Error('JSON memory import must contain a messages array.');
    }
    records = messages;
  }
  const blocks = records.map(turn).filter((value): value is string => !!value);
  if (!blocks.length) throw new Error('Memory import contains no chat text.');
  return segment(blocks);
}
