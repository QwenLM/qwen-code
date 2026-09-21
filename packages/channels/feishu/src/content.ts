import MarkdownIt from 'markdown-it';

export interface FeishuResource {
  type: 'image' | 'file' | 'audio' | 'video';
  key: string;
  fileName?: string;
}

export interface FeishuContent {
  text: string;
  /**
   * `text` rendered without the adapter's media placeholders, for command
   * classification. The parser knows which spans it synthesized while it
   * renders them, so the placeholder-free form is produced here rather than
   * recovered from `text` afterwards. Same rows as `text`, links as their
   * label alone.
   */
  commandText: string;
  /**
   * The post as the command classifier read it before this parser existed —
   * its title, then the legacy `content` rows' text, link labels and mention
   * names, and nothing else — when that reads differently from `commandText`.
   * Tried first: a command these rows spell is dispatched exactly as it
   * always was, with no Markdown, code block or rule in or ahead of it.
   * `commandText` answers only where they cannot: a command after a Markdown
   * mention tag, which they spell as a display name no mention key resolves.
   * A command's arguments are therefore the legacy rows' text, as they always
   * were: a code block or link target beside a command is not part of them.
   */
  legacyCommandText?: string;
  resources: FeishuResource[];
  userAuthoredText: boolean;
  /**
   * True when `text` is entirely adapter-synthesized placeholder output —
   * '(image)', '(media)', '(file: …)', '(card message — not supported)' — and
   * carries nothing a member typed. The quote wrapper gates on this: a
   * placeholder is never another user's original message.
   */
  synthesizedText: boolean;
  /** Distinct resources dropped by the per-message cap, for reporting. */
  droppedResourceCount: number;
}

/**
 * Bound on resources harvested from one message, so a rich-text post cannot
 * fan out into unbounded authenticated platform fetches. Kept in document
 * order; the tail is dropped, never reordered.
 */
const MAX_RESOURCES_PER_MESSAGE = 8;

/**
 * Bound on the `md` text handed to the Markdown parser. Far above any post
 * the platform delivers; the parser is linear on the inputs measured, and
 * this keeps one message's synchronous parse bounded regardless.
 */
const MD_ANALYSIS_MAX_CHARS = 100_000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A code fence no run inside `text` can close: one backtick longer than the
 * longest backtick run, and never shorter than three. The census runs on the
 * text without its square brackets: the group-path sanitizer deletes
 * start-of-line bracket pairs, which joins the runs on either side of one,
 * and a fence sized for the text as written would be matched by a run that
 * only exists after the peel. Deleting every bracket bounds whatever subset
 * the peel deletes. Reduced by hand, never spread — an input-sized census
 * overflows the call stack via Math.max(...runs).
 */
export function fenceFor(text: string): string {
  let maxRun = 0;
  for (const match of text.replace(/[[\]]/g, '').matchAll(/`+/g)) {
    if (match[0].length > maxRun) maxRun = match[0].length;
  }
  return '`'.repeat(Math.max(3, maxRun + 1));
}

/**
 * At-mention markup in `md` text, one grammar in three parts: the parser
 * reads the opener and closer as inline HTML tokens and the name between
 * them, the adapter deletes the whole tag from quoted text. Bounded so
 * truncated markup cannot stall and a member cannot pass a paragraph off as
 * a display name; and a name holds no `<`, so the deletion never runs across
 * a second opener and takes the prose between them with it.
 */
const MD_AT_OPEN_SOURCE = String.raw`<at\s+user_id=["'][^"']{1,200}["']\s*>`;
const MD_AT_NAME_MAX_CHARS = 200;
export const MD_AT_TAG_SOURCE = `${MD_AT_OPEN_SOURCE}[^<]{0,${MD_AT_NAME_MAX_CHARS}}</at>`;
const MD_AT_OPEN_RE = new RegExp(`^${MD_AT_OPEN_SOURCE}$`);
const MD_AT_CLOSE_RE = /^<\/at>$/;

/** A Markdown image destination that is a platform image key. */
const IMAGE_KEY_RE = /^img_[A-Za-z0-9_.:-]{1,200}$/;

/**
 * Block and inline structure of `md` text comes from a CommonMark parser,
 * never from expressions over the rendered text: which `![alt](key)` is an
 * image and which is a code sample is a question about fences, code spans,
 * indentation, containers, reference definitions and HTML blocks, and only a
 * full parser answers it the way the text renders.
 */
const markdown = new MarkdownIt('commonmark');
const NESTING_LIMIT: number = markdown.options.maxNesting ?? 20;

interface MarkdownFacts {
  /** Platform image keys the text renders as images, in document order. */
  imageKeys: string[];
  /** The text carries prose, code or a link the member typed. */
  authored: boolean;
  /** The text carries anything beyond image references and bare mentions. */
  substantive: boolean;
}

/**
 * One parse answers every question asked of an `md` node — harvest and both
 * authorship flags — so the answers cannot disagree about what the text is.
 */
function analyzeMarkdown(
  text: string,
  onParseError?: (err: unknown) => void,
): MarkdownFacts {
  const imageKeys = new Set<string>();
  let authored = false;
  let substantive = false;
  const visit = (tokens: ReturnType<typeof markdown.parse>): void => {
    // A mention's display name is not message prose; it sits between the
    // platform's own <at …> … </at> inline tags. Text is a name only once
    // its </at> arrives: an opener that never closes must not turn the rest
    // of the paragraph into one.
    let inMention = false;
    let nameChars = 0;
    const endMention = (closed: boolean): void => {
      if (!closed && nameChars > 0) authored = true;
      inMention = false;
      nameChars = 0;
    };
    for (const token of tokens) {
      // The parser stops descending at its nesting limit and drops what
      // lies below without a word. An opener at the limit therefore means
      // content this walk never sees: it counts as typed rather than as
      // absent, so a deeply nested message is not taken for a placeholder.
      if (token.nesting === 1 && token.level >= NESTING_LIMIT - 1) {
        authored = substantive = true;
      }
      switch (token.type) {
        case 'image': {
          // The alt text belongs to the reference, not to the prose.
          const src = String(token.attrGet('src') ?? '');
          if (IMAGE_KEY_RE.test(src)) imageKeys.add(src);
          else authored = substantive = true;
          break;
        }
        case 'html_inline':
          if (MD_AT_OPEN_RE.test(token.content)) {
            endMention(false);
            inMention = true;
          } else if (inMention && MD_AT_CLOSE_RE.test(token.content)) {
            endMention(nameChars <= MD_AT_NAME_MAX_CHARS);
          } else {
            authored = substantive = true;
          }
          break;
        case 'html_block':
          if (token.content.trim()) authored = substantive = true;
          break;
        case 'text':
        case 'code_inline':
          if (token.content.trim()) {
            substantive = true;
            // A display name holds no `<` (the adapter's deletion of mention
            // markup from quoted text stops at one); text that does is prose
            // behind an opener that names nobody.
            if (inMention && token.content.includes('<')) endMention(false);
            if (inMention) nameChars += token.content.length;
            else authored = true;
          }
          break;
        case 'fence':
        case 'code_block':
          if (token.content.trim() || token.info.trim()) authored = true;
          substantive = true;
          break;
        case 'link_open':
          if (token.attrGet('href')) authored = substantive = true;
          break;
        case 'hr':
          substantive = true;
          break;
        default:
          if (token.children) visit(token.children);
      }
    }
    endMention(false);
  };
  try {
    visit(markdown.parse(text.slice(0, MD_ANALYSIS_MAX_CHARS), {}));
  } catch (err) {
    // A parser failure costs this node its harvest, never the message: the
    // text still renders and counts as typed, and the legacy mirror still
    // carries the post's media.
    onParseError?.(err);
    return { imageKeys: [], authored: true, substantive: true };
  }
  if (text.slice(MD_ANALYSIS_MAX_CHARS).trim()) authored = substantive = true;
  return { imageKeys: [...imageKeys], authored, substantive };
}

export function parseFeishuContent(
  type: string,
  json: string,
  onParseError?: (err: unknown) => void,
): FeishuContent {
  const empty = (): FeishuContent => ({
    text: '',
    commandText: '',
    resources: [],
    userAuthoredText: false,
    synthesizedText: false,
    droppedResourceCount: 0,
  });
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(json));
  } catch (err) {
    onParseError?.(err);
    return empty();
  }
  const single = (
    type: FeishuResource['type'],
    key: unknown,
    fileName?: unknown,
  ): FeishuResource[] =>
    typeof key === 'string' && key
      ? [
          {
            type,
            key,
            ...(string(fileName) ? { fileName: string(fileName) } : {}),
          },
        ]
      : [];
  if (type === 'text') {
    const text = string(body['text']);
    return { ...empty(), text, commandText: text, userAuthoredText: true };
  }
  if (type === 'image') {
    return {
      ...empty(),
      text: '(image)',
      resources: single('image', body['image_key']),
      synthesizedText: true,
    };
  }
  if (type === 'file' || type === 'audio' || type === 'media') {
    const kind = type === 'media' ? 'video' : type;
    return {
      ...empty(),
      text:
        type === 'file'
          ? `(file: ${
              // A sender-chosen name may not carry newlines into the
              // single-line placeholder. The metadata keeps the raw name.
              string(body['file_name'])
                .replace(/[\r\n]+/g, ' ')
                .trim() || 'file'
            })`
          : `(${kind})`,
      resources: single(kind, body['file_key'], body['file_name']),
      synthesizedText: true,
    };
  }
  if (type === 'interactive') {
    return {
      ...empty(),
      text: '(card message — not supported)',
      synthesizedText: true,
    };
  }
  if (type !== 'post') return empty();

  // The render phase runs on unbounded remote text. A throw here is reported
  // through the same sink a JSON failure uses and yields an empty result,
  // which the adapter drops as an empty message. The Markdown parser — the
  // one step that runs third-party code over that text — is guarded on its
  // own inside analyzeMarkdown and costs a node its harvest, not the message.
  try {
    return parsePostContent(body, onParseError);
  } catch (err) {
    onParseError?.(err);
    return empty();
  }
}

/**
 * How a post renders. `model` is what the agent reads: media placeholders,
 * links with their targets. `command` is the same rows for the command
 * classifier: media as nothing, links as their label. `legacy` is the
 * rendering the classifier read before this parser existed — text, link
 * labels and mention names, every other node as nothing — so a command the
 * legacy rows spell is dispatched exactly as it always was.
 */
type Rendering = 'model' | 'command' | 'legacy';

/**
 * Render one post node to text. Pure: resources and authorship are collected
 * separately, so the same node renders in any of the three ways.
 */
function renderNode(value: unknown, rendering: Rendering): string {
  const node = record(value);
  const text = string(node['text']);
  switch (node['tag']) {
    case 'text':
      return text;
    case 'a': {
      const href = string(node['href']);
      if (rendering !== 'model') return text;
      return href ? `[${text || href}](${href})` : text;
    }
    case 'at': {
      const name = string(node['user_name']);
      return name ? `@${name}` : '';
    }
    default:
  }
  if (rendering === 'legacy') return '';
  switch (node['tag']) {
    case 'img':
      return rendering === 'model' ? '(image)' : '';
    case 'media':
      return rendering === 'model' ? '(video)' : '';
    case 'code_block': {
      // The language tag is user-controlled and interpolated next to the
      // fence — strip characters that could break the fence line.
      const language = string(node['language'])
        .replace(/[\r\n`~]/g, '')
        .trim();
      const fence = fenceFor(text);
      // Own-lined so a block sharing a row with sibling nodes still opens
      // and closes on its own lines.
      return `\n${fence}${language}\n${text}\n${fence}\n`;
    }
    case 'md':
      return text;
    case 'hr':
      return '---';
    default:
      return '';
  }
}

function renderRows(
  rows: unknown,
  title: string,
  rendering: Rendering,
): string {
  const lines: string[] = title ? [title] : [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      lines.push(row.map((node) => renderNode(node, rendering)).join(''));
    }
  }
  return lines.join('\n').trim();
}

function parsePostContent(
  bodyArg: Record<string, unknown>,
  onParseError?: (err: unknown) => void,
): FeishuContent {
  let body = bodyArg;
  if (!('content' in body) && !('content_v2' in body) && !('title' in body)) {
    body = record(body['zh_cn'] ?? body['en_us'] ?? Object.values(body)[0]);
  }
  const v2 = body['content_v2'];
  const legacy = body['content'];
  const usesV2 = Array.isArray(v2) && v2.length > 0;
  const rows = usesV2 ? v2 : legacy;
  const title = string(body['title']);

  let userAuthoredText = Boolean(title.trim());
  // Whether any node contributed real (non-placeholder) content: title prose,
  // text/link/mention/code/markdown — anything but an img/media placeholder.
  let hasNonPlaceholderContent = userAuthoredText;
  // Every distinct resource in document order — the order the rows render
  // them, with an `md` node's images in the order the parser reads them. The
  // cap applies once, below, over the whole list.
  const found: FeishuResource[] = [];
  const seen = new Set<string>();
  const add = (type: FeishuResource['type'], key: unknown): void => {
    if (typeof key !== 'string' || !key || seen.has(`${type}:${key}`)) return;
    seen.add(`${type}:${key}`);
    found.push({ type, key });
  };
  const collectMedia = (node: Record<string, unknown>): void => {
    if (node['tag'] === 'img') add('image', node['image_key']);
    else if (node['tag'] === 'media') add('video', node['file_key']);
  };
  const eachNode = (
    source: unknown,
    visit: (node: Record<string, unknown>) => void,
  ): void => {
    if (!Array.isArray(source)) return;
    for (const row of source) {
      if (Array.isArray(row)) for (const value of row) visit(record(value));
    }
  };

  eachNode(rows, (node) => {
    const text = string(node['text']);
    switch (node['tag']) {
      case 'text':
      case 'a':
        if (text.trim() || string(node['href'])) {
          userAuthoredText = true;
          hasNonPlaceholderContent = true;
        }
        break;
      case 'at':
        // A mention display name is not message prose: media-only posts must
        // keep userAuthoredText false so their synthesized placeholder is
        // never recorded into group history as something a member typed.
        if (string(node['user_name'])) hasNonPlaceholderContent = true;
        break;
      case 'code_block':
        if (
          text.trim() ||
          string(node['language'])
            .replace(/[\r\n`~]/g, '')
            .trim()
        )
          userAuthoredText = true;
        hasNonPlaceholderContent = true;
        break;
      case 'md': {
        // Remote URLs are never fetched: only platform image keys the parser
        // reads as rendered images become resources.
        const facts = analyzeMarkdown(text, onParseError);
        for (const key of facts.imageKeys) add('image', key);
        if (facts.authored) userAuthoredText = true;
        if (facts.substantive) hasNonPlaceholderContent = true;
        break;
      }
      case 'hr':
        hasNonPlaceholderContent = true;
        break;
      default:
        collectMedia(node);
    }
  });
  // The legacy representation mirrors the same document with typed img/media
  // nodes, the platform's own statement of what the post carries. A key it
  // names that `content_v2` did not yield joins after the ones that did, in
  // legacy node order: `content_v2` gives it no position to sort by.
  if (usesV2) eachNode(legacy, collectMedia);

  const resources = found.slice(0, MAX_RESOURCES_PER_MESSAGE);
  const text = renderRows(rows, title, 'model');
  const commandText = renderRows(rows, title, 'command');
  const legacyCommandText = renderRows(legacy, title, 'legacy');
  return {
    text: text || (resources.length ? '(media)' : ''),
    commandText,
    ...(legacyCommandText && legacyCommandText !== commandText
      ? { legacyCommandText }
      : {}),
    resources,
    userAuthoredText,
    // The text is adapter-synthesized when every rendered span is a media
    // placeholder (or there were none and the fallback produced one). Such
    // text is never wrapped as another user's quoted message.
    synthesizedText: !hasNonPlaceholderContent,
    droppedResourceCount: found.length - resources.length,
  };
}
