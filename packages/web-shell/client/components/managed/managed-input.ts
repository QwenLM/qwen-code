import type { PromptFile, PromptImage } from '../../adapters/promptTypes';
import type { ManagedInputBlock } from './managed-agent-provider';
import type { EditorHandle } from '../../hooks/useComposerCore';

const MAX_INPUT_BYTES = 48 * 1024;
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'log',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'java',
  'sql',
  'sh',
  'bash',
  'rs',
  'go',
  'c',
  'h',
  'cpp',
  'toml',
  'ini',
  'properties',
  'svg',
]);
const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
  'image/svg+xml',
]);

function privateBlock(block: ManagedInputBlock) {
  if (block.type === 'input_file')
    return {
      type: 'resource',
      resource: {
        uri: `managed-input:///${encodeURIComponent(block.name).replace(/[!'()~]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        mimeType: block.mime_type,
        text: block.text,
      },
    };
  if (block.type === 'input_image')
    return { type: 'image', data: block.data, mimeType: block.mime_type };
  return { type: 'text', text: block.text };
}

export function isManagedInput(value: unknown): value is ManagedInputBlock[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  try {
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        return false;
      const block = item as Record<string, unknown>;
      if (block['type'] === 'input_text' || block['type'] === 'text') {
        if (
          Object.keys(block).length !== 2 ||
          typeof block['text'] !== 'string' ||
          !block['text']
        )
          return false;
      } else if (block['type'] === 'input_file') {
        const name = block['name'];
        const mime = block['mime_type'];
        if (
          Object.keys(block).length !== 4 ||
          typeof name !== 'string' ||
          !name.trim() ||
          name.length > 255 ||
          name === '.' ||
          name === '..' ||
          /[/\\\p{Cc}]/u.test(name) ||
          typeof mime !== 'string' ||
          !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(mime) ||
          !(
            mime.startsWith('text/') ||
            TEXT_MIMES.has(mime) ||
            (mime === 'application/octet-stream' &&
              TEXT_EXTENSIONS.has(name.split('.').at(-1)!.toLowerCase()))
          ) ||
          typeof block['text'] !== 'string' ||
          !block['text'] ||
          block['text'].includes('\0')
        )
          return false;
      } else if (block['type'] === 'input_image') {
        if (
          Object.keys(block).length !== 3 ||
          typeof block['data'] !== 'string' ||
          !block['data'] ||
          block['data'].length > MAX_INPUT_BYTES
        )
          return false;
        const bytes = atob(block['data']);
        if (btoa(bytes) !== block['data']) return false;
        const valid =
          block['mime_type'] === 'image/png'
            ? bytes.startsWith('\x89PNG\r\n\x1a\n')
            : block['mime_type'] === 'image/jpeg'
              ? bytes.startsWith('\xff\xd8\xff')
              : block['mime_type'] === 'image/webp' &&
                bytes.startsWith('RIFF') &&
                bytes.slice(8, 12) === 'WEBP';
        if (!valid) return false;
      } else return false;
    }
    return (
      !value.some(
        (block) => block.type === 'input_file' || block.type === 'input_image',
      ) ||
      new TextEncoder().encode(JSON.stringify(value.map(privateBlock)))
        .length <= MAX_INPUT_BYTES
    );
  } catch {
    return false;
  }
}

export async function encodeManagedInput(
  text: string,
  images: readonly PromptImage[] = [],
  files: readonly PromptFile[] = [],
): Promise<ManagedInputBlock[]> {
  const blocks: ManagedInputBlock[] = text
    ? [{ type: 'input_text', text }]
    : [];
  for (const file of files) {
    if (file.data && file.data.size > MAX_INPUT_BYTES)
      throw new Error(
        'Attachments and text together must fit within 48 KiB of encoded input.',
      );
    let contents = file.text;
    if (contents === undefined && file.data) {
      try {
        contents = new TextDecoder('utf-8', { fatal: true }).decode(
          await file.data.arrayBuffer(),
        );
      } catch {
        throw new Error(
          'This file is not valid UTF-8 text. PDF, Office, audio and video files are not supported.',
        );
      }
    }
    blocks.push({
      type: 'input_file',
      name: file.name,
      mime_type:
        file.media_type.split(';')[0]?.trim().toLowerCase() ||
        'application/octet-stream',
      text: contents ?? '',
    });
  }
  for (const image of images) {
    const mime = image.media_type;
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp')
      throw new Error('Only PNG, JPEG and WebP images are supported.');
    blocks.push({
      type: 'input_image',
      data: image.data,
      mime_type: mime,
    });
  }
  if (!isManagedInput(blocks))
    throw new Error(
      'Use a nonempty UTF-8 text file or a valid PNG, JPEG or WebP image. Attachments and text together must fit within 48 KiB of encoded input.',
    );
  return blocks;
}

export function managedInputText(input: readonly ManagedInputBlock[]): string {
  return input
    .flatMap((block) =>
      block.type === 'input_text' || block.type === 'text' ? [block.text] : [],
    )
    .join('\n');
}

export function restoreManagedAttachments(
  editor: EditorHandle | null,
  input?: readonly ManagedInputBlock[],
): void {
  if (
    !editor ||
    !input?.some(
      (block) => block.type === 'input_image' || block.type === 'input_file',
    ) ||
    editor.hasAttachments()
  )
    return;
  editor.restoreImages(
    input.flatMap((block) =>
      block.type === 'input_image'
        ? [{ data: block.data, media_type: block.mime_type }]
        : [],
    ),
  );
  editor.restoreFiles(
    input.flatMap((block) =>
      block.type === 'input_file'
        ? [{ name: block.name, media_type: block.mime_type, text: block.text }]
        : [],
    ),
  );
}
