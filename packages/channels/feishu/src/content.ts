export interface FeishuResource {
  type: 'image' | 'file' | 'audio' | 'video';
  key: string;
  fileName?: string;
}

export interface FeishuContent {
  text: string;
  resources: FeishuResource[];
  mentionNames: string[];
  userAuthoredText: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseFeishuContent(type: string, json: string): FeishuContent {
  const result: FeishuContent = {
    text: '',
    resources: [],
    mentionNames: [],
    userAuthoredText: false,
  };
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(json));
  } catch {
    return result;
  }
  const add = (
    type: FeishuResource['type'],
    key: unknown,
    fileName?: unknown,
  ) => {
    if (typeof key !== 'string' || !key) return;
    if (result.resources.some((r) => r.key === key && r.type === type)) return;
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
  if (string(body['title'])) {
    lines.push(string(body['title']));
    result.userAuthoredText = true;
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
        const name = string(node['user_name']);
        if (name) result.mentionNames.push(name);
        return name ? `@${name}` : '';
      }
      case 'img':
        add('image', node['image_key']);
        return '(image)';
      case 'media':
        add('video', node['file_key']);
        return '(video)';
      case 'code_block': {
        if (text.trim()) result.userAuthoredText = true;
        const fences = text.match(/`+/g) ?? [];
        const fence = '`'.repeat(
          Math.max(3, ...fences.map((f) => f.length + 1)),
        );
        return `${fence}${string(node['language'])}\n${text}\n${fence}`;
      }
      case 'md': {
        // Code examples are not resource references. Remote URLs are never fetched.
        const prose = text.replace(
          /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|(`+)[\s\S]*?\2/g,
          '',
        );
        const withoutImages = prose.replace(
          /!\[[^\]\n]*\]\((img_[A-Za-z0-9_-]+)\)/g,
          (_match, key: string) => {
            add('image', key);
            return '';
          },
        );
        const withoutMentions = withoutImages.replace(
          /<at\s+user_id=["'][^"']+["']\s*>[\s\S]*?<\/at>/g,
          '',
        );
        if (withoutMentions.trim() || prose !== text)
          result.userAuthoredText = true;
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
  // syntax outside the simple inline image form above.
  if (rows === v2 && Array.isArray(body['content'])) {
    for (const row of body['content']) {
      if (!Array.isArray(row)) continue;
      for (const value of row) {
        const node = record(value);
        if (node['tag'] === 'img') add('image', node['image_key']);
        if (node['tag'] === 'media') add('video', node['file_key']);
      }
    }
  }
  result.text = lines.join('\n').trim();
  if (!result.text && result.resources.length) result.text = '(media)';
  if (result.text && !result.resources.length) result.userAuthoredText = true;
  return result;
}
