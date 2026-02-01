import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRouter } from '../tool-router';
import { KNOWN_TOOL_NAMES } from '../tool-catalog';

const unsupportedFactory = (name) => async () => ({
  content: [{ type: 'text', text: `Unsupported: ${name}` }],
  isError: true,
});

test('router returns handlers for known tools', async () => {
  const router = createToolRouter(
    {
      chrome_screenshot: async () => 'ok',
    },
    unsupportedFactory,
  );

  const handler = router.get('chrome_screenshot');
  assert.equal(typeof handler, 'function');
  const result = await handler({});
  assert.equal(result, 'ok');

  const fallbackName = KNOWN_TOOL_NAMES.find((name) => name !== 'chrome_screenshot');
  const fallback = router.get(fallbackName);
  assert.equal(typeof fallback, 'function');
  const fallbackResult = await fallback({});
  assert.equal(fallbackResult.isError, true);
  assert.match(fallbackResult.content[0].text, /Unsupported/);
});

test('router returns null for unknown tools', () => {
  const router = createToolRouter({}, unsupportedFactory);
  assert.equal(router.get('unknown_tool'), null);
});
