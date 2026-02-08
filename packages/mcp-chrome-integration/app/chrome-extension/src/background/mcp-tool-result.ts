/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function normalizeImageDataUrl(dataUrl, fallbackMimeType = 'image/png') {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw new Error('Invalid image data');
  }

  if (!dataUrl.startsWith('data:')) {
    return { data: dataUrl, mimeType: fallbackMimeType };
  }

  const match = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl);
  if (!match) {
    throw new Error('Invalid image data URL');
  }

  return { data: match[2], mimeType: match[1] || fallbackMimeType };
}

export function toCallToolResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result;
  }

  if (result && typeof result === 'object' && result.type === 'image') {
    const { data, mimeType } = normalizeImageDataUrl(
      result.data,
      result.mimeType || 'image/png',
    );
    return {
      content: [{ type: 'image', data, mimeType }],
      structuredContent: { ...result, data, mimeType },
    };
  }

  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }

  if (result === undefined) {
    return { content: [{ type: 'text', text: '' }] };
  }

  const text = JSON.stringify(result, null, 2);
  const structuredContent =
    result && typeof result === 'object' ? result : { value: result };

  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

export function toErrorCallToolResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
