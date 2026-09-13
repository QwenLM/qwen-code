export interface FeishuResource {
  type: 'image' | 'file' | 'audio' | 'video';
  key: string;
  fileName?: string;
}

export interface FeishuContent {
  text: string;
  resources: FeishuResource[];
  userAuthoredText: boolean;
}

/**
 * Bound on resources harvested from one message, so a rich-text post cannot
 * fan out into unbounded authenticated platform fetches. Kept in document
 * order; the tail is dropped, never reordered.
 */
const MAX_RESOURCES_PER_MESSAGE = 8;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Line-based code-fence scan (the CommonMark block rule): a fence opens on a
 * line starting with up to 3 spaces then 3+ backticks or tildes, and closes on
 * a line holding only the same character repeated at least as many times. An
 * unclosed fence consumes the rest of the input. Linear in the input — no
 * backreference rescans.
 *
 * Inline backtick runs are deliberately NOT stripped: a stray backtick is
 * common in chat text, and pairing it with a later one would silently delete
 * a real image reference between them. A genuine inline code sample that
 * mentions an `img_` key degrades to a failed-download marker instead.
 */
function scanFenceLines(
  text: string,
  onKeptLine?: (line: string) => void,
): { fenceChar: string; fenceLength: number } | undefined {
  let fenceChar = '';
  let fenceLength = 0;
  for (const line of text.split('\n')) {
    if (fenceLength === 0) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        fenceChar = open[1]!.charAt(0);
        fenceLength = open[1]!.length;
        continue;
      }
      onKeptLine?.(line);
    } else {
      const close = /^ {0,3}(`{3,}|~{3,}) *$/.exec(line);
      if (
        close &&
        close[1]!.charAt(0) === fenceChar &&
        close[1]!.length >= fenceLength
      ) {
        fenceChar = '';
        fenceLength = 0;
      }
    }
  }
  return fenceLength ? { fenceChar, fenceLength } : undefined;
}

function stripFencedCode(text: string): string {
  const kept: string[] = [];
  scanFenceLines(text, (line) => kept.push(line));
  return kept.join('\n');
}

/**
 * Close a fence left open at end of input (e.g. by a length cap), so text
 * appended after it is not swallowed into another message's code sample.
 */
export function closeOpenFence(text: string): string {
  const open = scanFenceLines(text);
  return open ? `${text}\n${open.fenceChar.repeat(open.fenceLength)}` : text;
}

export function parseFeishuContent(
  type: string,
  json: string,
  onParseError?: (err: unknown) => void,
): FeishuContent {
  const result: FeishuContent = {
    text: '',
    resources: [],
    userAuthoredText: false,
  };
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(json));
  } catch (err) {
    onParseError?.(err);
    return result;
  }
  const add = (
    type: FeishuResource['type'],
    key: unknown,
    fileName?: unknown,
  ) => {
    if (typeof key !== 'string' || !key) return;
    if (result.resources.some((r) => r.key === key && r.type === type)) return;
    if (result.resources.length >= MAX_RESOURCES_PER_MESSAGE) return;
    result.resources.push({
      type,
      key,
      ...(string(fileName) ? { fileName: string(fileName) } : {}),
    });
  };
  if (type === 'text') {
    return { ...result, text: string(body['text']), userAuthoredText: true };
  }
  if (type === 'image') {
    add('image', body['image_key']);
    return { ...result, text: '(image)' };
  }
  if (type === 'file' || type === 'audio' || type === 'media') {
    const kind = type === 'media' ? 'video' : type;
    add(kind, body['file_key'], body['file_name']);
    return {
      ...result,
      text:
        type === 'file'
          ? `(file: ${string(body['file_name']) || 'file'})`
          : `(${kind})`,
    };
  }
  if (type === 'interactive') {
    return { ...result, text: '(card message — not supported)' };
  }
  if (type !== 'post') return result;

  if (!('content' in body) && !('content_v2' in body) && !('title' in body)) {
    body = record(body['zh_cn'] ?? body['en_us'] ?? Object.values(body)[0]);
  }
  const v2 = body['content_v2'];
  const rows = Array.isArray(v2) && v2.length > 0 ? v2 : body['content'];
  const lines: string[] = [];
  const title = string(body['title']);
  if (title) {
    lines.push(title);
    if (title.trim()) result.userAuthoredText = true;
  }
  const render = (value: unknown): string => {
    const node = record(value);
    const text = string(node['text']);
    switch (node['tag']) {
      case 'text':
      case 'a': {
        if (text.trim() || string(node['href'])) result.userAuthoredText = true;
        return node['tag'] === 'a' && string(node['href'])
          ? `[${text || string(node['href'])}](${string(node['href'])})`
          : text;
      }
      case 'at': {
        // A mention display name is not message prose: media-only posts must
        // keep userAuthoredText false so their synthesized placeholder is
        // never recorded into group history as something a member typed.
        const name = string(node['user_name']);
        return name ? `@${name}` : '';
      }
      case 'img':
        add('image', node['image_key']);
        return '(image)';
      case 'media':
        add('video', node['file_key']);
        return '(video)';
      case 'code_block': {
        // The language tag is user-controlled and interpolated next to the
        // fence — strip characters that could break the fence line — and it
        // counts as authored content either way.
        const language = string(node['language'])
          .replace(/[\r\n`~]/g, '')
          .trim();
        if (text.trim() || language) result.userAuthoredText = true;
        const fences = text.match(/`+/g) ?? [];
        const fence = '`'.repeat(
          Math.max(3, ...fences.map((f) => f.length + 1)),
        );
        // Own-lined so a block sharing a row with sibling nodes still opens
        // and closes on its own lines.
        return `\n${fence}${language}\n${text}\n${fence}\n`;
      }
      case 'md': {
        // Code examples are not resource references, so keys are harvested
        // from fence-stripped prose. Remote URLs are never fetched.
        const prose = stripFencedCode(text);
        for (const match of prose.matchAll(
          /!\[[^\]\n]*\]\((img_[A-Za-z0-9_-]+)\)/g,
        )) {
          add('image', match[1]);
        }
        // Authorship is judged on the RETURNED text (minus image references
        // and at-tags), not on the harvest-stripped variant.
        const visible = text
          .replace(/<at\s+user_id=["'][^"']+["']\s*>[\s\S]*?<\/at>/g, '')
          .replace(/!\[[^\]\n]*\]\((img_[A-Za-z0-9_-]+)\)/g, '');
        if (visible.trim()) result.userAuthoredText = true;
        return text;
      }
      case 'hr':
        return '---';
      default:
        return '';
    }
  };
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (Array.isArray(row)) lines.push(row.map(render).join(''));
    }
  }
  // The legacy representation carries image nodes even when Markdown uses
  // syntax outside the simple inline image form above. It mirrors the same
  // document, so rescued keys are merged at their document position — never
  // appended after the v2 harvest, which would invert the media order the
  // text establishes.
  if (rows === v2 && Array.isArray(body['content'])) {
    const legacyKeys: Array<{ type: FeishuResource['type']; key: string }> = [];
    for (const row of body['content']) {
      if (!Array.isArray(row)) continue;
      for (const value of row) {
        const node = record(value);
        const key =
          node['tag'] === 'img'
            ? node['image_key']
            : node['tag'] === 'media'
              ? node['file_key']
              : undefined;
        const type = node['tag'] === 'img' ? 'image' : 'video';
        if (typeof key === 'string' && key) legacyKeys.push({ type, key });
      }
    }
    if (legacyKeys.length) {
      const harvested = new Map(
        result.resources.map((r) => [`${r.type}:${r.key}`, r]),
      );
      const ordered: FeishuResource[] = [];
      const seen = new Set<string>();
      for (const { type, key } of legacyKeys) {
        const id = `${type}:${key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const existing = harvested.get(id);
        if (existing) {
          ordered.push(existing);
          harvested.delete(id);
        } else {
          ordered.push({ type, key });
        }
      }
      // Keys only the v2 render carries (no legacy node) keep harvest order.
      for (const resource of harvested.values()) ordered.push(resource);
      result.resources = ordered.slice(0, MAX_RESOURCES_PER_MESSAGE);
    }
  }
  result.text = lines.join('\n').trim();
  if (!result.text && result.resources.length) result.text = '(media)';
  return result;
}
