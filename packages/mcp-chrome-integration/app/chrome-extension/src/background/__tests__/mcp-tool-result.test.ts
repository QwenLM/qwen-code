import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toCallToolResult,
  toErrorCallToolResult,
  normalizeImageDataUrl,
} from '../mcp-tool-result';

test('normalizeImageDataUrl extracts base64 and mimeType', () => {
  const dataUrl = 'data:image/png;base64,QUJDRA==';
  const result = normalizeImageDataUrl(dataUrl);
  assert.deepEqual(result, { data: 'QUJDRA==', mimeType: 'image/png' });
});

test('toCallToolResult formats image content from data URL', () => {
  const imageResult = {
    type: 'image',
    data: 'data:image/png;base64,QUJDRA==',
    mimeType: 'image/png',
  };

  const callToolResult = toCallToolResult(imageResult);

  assert.equal(callToolResult.content.length, 1);
  assert.deepEqual(callToolResult.content[0], {
    type: 'image',
    data: 'QUJDRA==',
    mimeType: 'image/png',
  });
  assert.deepEqual(callToolResult.structuredContent, {
    type: 'image',
    data: 'QUJDRA==',
    mimeType: 'image/png',
  });
});

test('toCallToolResult formats objects as text + structuredContent', () => {
  const payload = { ok: true, value: 42 };
  const callToolResult = toCallToolResult(payload);

  assert.equal(callToolResult.content[0].type, 'text');
  assert.match(callToolResult.content[0].text, /"ok": true/);
  assert.deepEqual(callToolResult.structuredContent, payload);
});

test('toCallToolResult formats strings as text only', () => {
  const callToolResult = toCallToolResult('hello');

  assert.deepEqual(callToolResult.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(callToolResult.structuredContent, undefined);
});

test('toErrorCallToolResult marks error', () => {
  const result = toErrorCallToolResult(new Error('boom'));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom/);
});
