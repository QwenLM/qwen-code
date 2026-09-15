export interface FeishuResource {
  type: 'image' | 'file' | 'audio' | 'video';
  key: string;
  fileName?: string;
}

export interface FeishuContent {
  text: string;
  resources: FeishuResource[];
  userAuthoredText: boolean;
  /**
   * True when `text` is entirely adapter-synthesized placeholder output —
   * '(image)', '(media)', '(file: …)', '(card message — not supported)' — and
   * carries nothing a member typed. The quote wrapper gates on this: a
   * placeholder is never another user's original message.
   */
  synthesizedText: boolean;
  /** Resource references dropped by the per-message cap, for reporting. */
  droppedResourceCount: number;
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
 * Container prefixes before a block fence: blockquote `>` markers (each
 * preceded by up to 3 spaces) plus the content indentation of an open list
 * item. A fence closes only on a fence-run-only line carrying the opener's
 * exact container prefix, and auto-closes where the container ends (a line
 * without the prefix) — CommonMark's container boundary rule.
 */
const BQ_PREFIX_RE = /^(?: {0,3}> ?)+/;

interface FenceState {
  char: string;
  length: number;
  prefix: string;
}

/** Blockquote markers compare canonically: the spaces around `>` are
 *  insignificant in CommonMark, so `>```` is the same container as `> `. */
const canonicalBq = (prefix: string) => prefix.replace(/ *> ?/g, '>');

/**
 * Line-based code-fence scan with container state. A fence opens when a line
 * — after its blockquote markers and open-list indentation are stripped —
 * starts with at most 3 spaces then 3+ backticks or tildes. It closes on a
 * fence-run-only line with the same character, at least the opener's length,
 * and the opener's container prefix (compared canonically), with trailing
 * spaces or tabs allowed; it auto-closes at a container boundary. A bare
 * blank line ends a blockquote container and whatever it held, but not a
 * top-level list item; a blank carrying the quote marker is inside the
 * quote. An unclosed fence consumes the rest of its container only. A line
 * indented 4+ columns (tabs advance to the next multiple of 4) beyond its
 * blockquote-free container is an indented code block and is never harvested
 * either. Linear in the input — no backreference rescans.
 *
 * Inline backtick runs are deliberately NOT stripped: a stray backtick is
 * common in chat text, and pairing it with a later one would silently delete
 * a real image reference between them. A genuine inline code sample that
 * mentions an `img_` key degrades to a failed-download marker instead.
 */
function scanFenceLines(
  text: string,
  onKeptLine?: (line: string) => void,
): FenceState | undefined {
  let fence: FenceState | undefined;
  // Open list items as a stack of content-indent widths (markers nest), plus
  // the blockquote prefix of the context they opened in.
  const listStack: number[] = [];
  let listIndent = 0;
  let listBq = '';
  // Line endings are normalized first: CommonMark admits CR and CRLF, and a
  // fence line terminated by `\r` must still read as a fence line.
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    let prefix = '';
    let rest = line;
    const bq = BQ_PREFIX_RE.exec(rest);
    if (bq) {
      prefix = bq[0];
      rest = rest.slice(prefix.length);
    }
    const bqPrefix = prefix;
    if (/^[\t ]*$/.test(rest)) {
      if (bqPrefix === '') {
        // A bare blank line ends a blockquote container (CommonMark), and
        // with it a fence or list held inside one — resetting a LIST fence
        // here would tear it in half, but a quote's fence really closes.
        if (fence && canonicalBq(fence.prefix).includes('>')) fence = undefined;
        if (listBq) {
          listStack.length = 0;
          listIndent = 0;
          listBq = '';
        }
        if (!fence) onKeptLine?.(line);
        continue;
      }
      // A blank line carrying the quote marker sits inside the blockquote.
      if (!fence) onKeptLine?.(line);
      continue;
    }
    // Pop list levels until the line carries the remaining content indent;
    // the innermost list ending ends a fence it held, an outer list may not.
    while (listIndent > 0 && !rest.startsWith(' '.repeat(listIndent))) {
      listStack.pop();
      listIndent = listStack.reduce((sum, width) => sum + width, 0);
      if (listIndent === 0) {
        listBq = '';
        fence = undefined;
      }
    }
    if (listIndent > 0) {
      prefix += ' '.repeat(listIndent);
      rest = rest.slice(listIndent);
    }

    if (fence) {
      const fenceContainer = canonicalBq(fence.prefix);
      const lineContainer = canonicalBq(prefix);
      if (!lineContainer.startsWith(fenceContainer)) {
        // Container boundary: the fence auto-closes and this line is outside.
        fence = undefined;
      } else {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest);
        if (
          close &&
          lineContainer === fenceContainer &&
          close[1]!.charAt(0) === fence.char &&
          close[1]!.length >= fence.length
        ) {
          fence = undefined;
        }
        continue;
      }
    }

    const leadingWhitespace = /^[ \t]*/.exec(rest)![0];
    let leadingColumns = 0;
    for (const ch of leadingWhitespace)
      leadingColumns += ch === '\t' ? 4 - (leadingColumns % 4) : 1;
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(rest);
    if (open && leadingColumns <= 3) {
      fence = { char: open[1]!.charAt(0), length: open[1]!.length, prefix };
      continue;
    }
    if (leadingColumns >= INDENTED_CODE_SPACES && bqPrefix === '') {
      // An indented code block: code, so never harvested. The check keys on
      // the blockquote prefix only — inside a list the content indent is
      // already stripped, so 4 further columns are code there too, while a
      // blockquoted over-indented line is a lazy paragraph continuation and
      // its keys are real references.
      continue;
    }
    onKeptLine?.(line);
    // A list marker outside a fence opens a nested list whose content lines
    // carry the accumulated marker widths as extra indentation.
    const listMarker = /^ {0,3}(?:[-*+]|\d+[.)]) /.exec(rest);
    if (listMarker) {
      listStack.push(listMarker[0].length);
      listIndent += listMarker[0].length;
      listBq = bqPrefix;
    }
  }
  return fence;
}

const INDENTED_CODE_SPACES = 4;

function stripFencedCode(text: string): string {
  const kept: string[] = [];
  scanFenceLines(text, (line) => kept.push(line));
  return kept.join('\n');
}

/**
 * Close a fence left open at end of input (e.g. by a length cap), so text
 * appended after it is not swallowed into another message's code sample. The
 * closer carries the opener's container prefix so it closes rather than
 * opening a fresh top-level fence.
 */
export function closeOpenFence(text: string): string {
  const open = scanFenceLines(text);
  return open
    ? `${text}\n${open.prefix}${open.char.repeat(open.length)}`
    : text;
}

/**
 * Markdown inline image reference to a platform image key: `![alt](key)`,
 * bare or angle-bracket destination, optional quoted title. Alt, key and
 * title are length-bounded so an unbroken `![` run cannot backtrack
 * superlinearly, and the key charset matches the platform id charset
 * (FEISHU_ID_RE also admits `.` and `:`). Reference-style `![alt][ref]`
 * images are not produced by the platform's Markdown export and resolving
 * them would take a second definition pass — out of scope.
 */
const MD_IMAGE_SOURCE = String.raw`!\[[^\]\n]{0,200}\]\(\s*<?(img_[A-Za-z0-9_.:-]{1,200})>?(?:\s+(?:"[^"\n]{0,200}"|'[^'\n]{0,200}'))?\s*\)`;
const mdImageRe = () => new RegExp(MD_IMAGE_SOURCE, 'g');

/** At-mention markup in `md` text; bounded so truncated markup cannot stall. */
export const MD_AT_TAG_SOURCE = String.raw`<at\s+user_id=["'][^"']{1,200}["']\s*>[\s\S]{0,200}?</at>`;

export function parseFeishuContent(
  type: string,
  json: string,
  onParseError?: (err: unknown) => void,
): FeishuContent {
  const result: FeishuContent = {
    text: '',
    resources: [],
    userAuthoredText: false,
    synthesizedText: false,
    droppedResourceCount: 0,
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
    if (result.resources.length >= MAX_RESOURCES_PER_MESSAGE) {
      result.droppedResourceCount += 1;
      return;
    }
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
    return { ...result, text: '(image)', synthesizedText: true };
  }
  if (type === 'file' || type === 'audio' || type === 'media') {
    const kind = type === 'media' ? 'video' : type;
    add(kind, body['file_key'], body['file_name']);
    return {
      ...result,
      text:
        type === 'file'
          ? `(file: ${
              // The placeholder is a single line by contract (the command-turn
              // placeholder filter is line-based), so a sender-chosen name may
              // not carry newlines into it. The metadata keeps the raw name.
              string(body['file_name'])
                .replace(/[\r\n]+/g, ' ')
                .trim() || 'file'
            })`
          : `(${kind})`,
      synthesizedText: true,
    };
  }
  if (type === 'interactive') {
    return {
      ...result,
      text: '(card message — not supported)',
      synthesizedText: true,
    };
  }
  if (type !== 'post') return result;

  // The render phase runs on unbounded remote text; a throw here must degrade
  // to an empty result through the same sink a JSON failure uses rather than
  // escape into the adapter's message-level catch, which would strand the
  // dedupe entry and drop the message on every redelivery.
  try {
    return parsePostContent(body, result, add);
  } catch (err) {
    onParseError?.(err);
    return {
      text: '',
      resources: [],
      userAuthoredText: false,
      synthesizedText: false,
      droppedResourceCount: 0,
    };
  }
}

function parsePostContent(
  bodyArg: Record<string, unknown>,
  result: FeishuContent,
  add: (type: FeishuResource['type'], key: unknown, fileName?: unknown) => void,
): FeishuContent {
  let body = bodyArg;
  if (!('content' in body) && !('content_v2' in body) && !('title' in body)) {
    body = record(body['zh_cn'] ?? body['en_us'] ?? Object.values(body)[0]);
  }
  const v2 = body['content_v2'];
  const rows = Array.isArray(v2) && v2.length > 0 ? v2 : body['content'];
  const lines: string[] = [];
  // Whether any node contributed real (non-placeholder) content: title prose,
  // text/link/mention/code/markdown — anything but an img/media placeholder.
  let hasNonPlaceholderContent = false;
  // Document position of every referenced key, harvested or legacy-rescued,
  // in ONE space both sides compute the same way: node ordinal times a
  // stride, plus the key's ordinal within its node. A message cannot carry
  // anywhere near STRIDE key references in one node (each reference is a
  // dozen-plus characters of platform-bounded text), so the spaces never
  // overlap. The merge sorts on these so attachment order follows the order
  // the rendered text cites each key.
  const POSITION_STRIDE = 1 << 16;
  const positions = new Map<string, number>();
  const resourceById = new Map<string, FeishuResource>();
  let nodeIndex = -1;
  let intraKey = 0;
  const addAtPosition = (
    type: FeishuResource['type'],
    key: unknown,
    fileName?: unknown,
  ) => {
    if (typeof key === 'string' && key) {
      const id = `${type}:${key}`;
      if (!positions.has(id)) {
        positions.set(id, nodeIndex * POSITION_STRIDE + intraKey);
        intraKey += 1;
        resourceById.set(id, {
          type,
          key,
          ...(string(fileName) ? { fileName: string(fileName) } : {}),
        });
      }
    }
    add(type, key, fileName);
  };
  const title = string(body['title']);
  if (title) {
    lines.push(title);
    if (title.trim()) {
      result.userAuthoredText = true;
      hasNonPlaceholderContent = true;
    }
  }
  const render = (value: unknown): string => {
    nodeIndex += 1;
    intraKey = 0;
    const node = record(value);
    const text = string(node['text']);
    switch (node['tag']) {
      case 'text':
      case 'a': {
        if (text.trim() || string(node['href'])) {
          result.userAuthoredText = true;
          hasNonPlaceholderContent = true;
        }
        return node['tag'] === 'a' && string(node['href'])
          ? `[${text || string(node['href'])}](${string(node['href'])})`
          : text;
      }
      case 'at': {
        // A mention display name is not message prose: media-only posts must
        // keep userAuthoredText false so their synthesized placeholder is
        // never recorded into group history as something a member typed.
        const name = string(node['user_name']);
        if (name) hasNonPlaceholderContent = true;
        return name ? `@${name}` : '';
      }
      case 'img':
        addAtPosition('image', node['image_key']);
        return '(image)';
      case 'media':
        addAtPosition('video', node['file_key']);
        return '(video)';
      case 'code_block': {
        // The language tag is user-controlled and interpolated next to the
        // fence — strip characters that could break the fence line — and it
        // counts as authored content either way.
        const language = string(node['language'])
          .replace(/[\r\n`~]/g, '')
          .trim();
        if (text.trim() || language) result.userAuthoredText = true;
        hasNonPlaceholderContent = true;
        // Reduce by hand, never spread: an input-sized backtick census
        // overflows the call stack via Math.max(...runs).
        let maxRun = 0;
        for (const match of text.matchAll(/`+/g)) {
          if (match[0].length > maxRun) maxRun = match[0].length;
        }
        const fence = '`'.repeat(Math.max(3, maxRun + 1));
        // Own-lined so a block sharing a row with sibling nodes still opens
        // and closes on its own lines.
        return `\n${fence}${language}\n${text}\n${fence}\n`;
      }
      case 'md': {
        // Code examples are not resource references, so keys are harvested
        // from fence-stripped prose. Remote URLs are never fetched.
        const prose = stripFencedCode(text);
        for (const match of prose.matchAll(mdImageRe())) {
          addAtPosition('image', match[1]);
        }
        // Authorship is judged on the RETURNED text (minus image references
        // and at-tags), not on the harvest-stripped variant.
        const visible = text
          .replace(new RegExp(MD_AT_TAG_SOURCE, 'g'), '')
          .replace(mdImageRe(), '');
        if (visible.trim()) result.userAuthoredText = true;
        if (text.trim()) hasNonPlaceholderContent = true;
        return text;
      }
      case 'hr':
        hasNonPlaceholderContent = true;
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
  // document, so rescued keys join the merge at the position the legacy
  // sweep computes; keys both representations carry keep the v2 citation
  // position, and the cap applies once over the position-sorted union.
  if (rows === v2 && Array.isArray(body['content'])) {
    let legacyNodeIndex = -1;
    for (const row of body['content']) {
      if (!Array.isArray(row)) continue;
      for (const value of row) {
        legacyNodeIndex += 1;
        const node = record(value);
        const key =
          node['tag'] === 'img'
            ? node['image_key']
            : node['tag'] === 'media'
              ? node['file_key']
              : undefined;
        if (typeof key !== 'string' || !key) continue;
        const type: FeishuResource['type'] =
          node['tag'] === 'img' ? 'image' : 'video';
        const id = `${type}:${key}`;
        if (positions.has(id)) continue;
        // Same formula the v2 side uses: a legacy resource at node index j
        // gets the position the v2 render would give a key at node j.
        positions.set(id, legacyNodeIndex * POSITION_STRIDE);
        resourceById.set(id, { type, key });
      }
    }
    const ordered = [...resourceById.values()].sort(
      (a, b) =>
        positions.get(`${a.type}:${a.key}`)! -
        positions.get(`${b.type}:${b.key}`)!,
    );
    const kept = ordered.slice(0, MAX_RESOURCES_PER_MESSAGE);
    result.resources = kept;
    result.droppedResourceCount = ordered.length - kept.length;
  }
  result.text = lines.join('\n').trim();
  if (!result.text && result.resources.length) result.text = '(media)';
  // The text is adapter-synthesized when every rendered line is a media
  // placeholder (or there were none and the fallback produced one). Such text
  // is never wrapped as another user's quoted message.
  result.synthesizedText = !hasNonPlaceholderContent;
  return result;
}
