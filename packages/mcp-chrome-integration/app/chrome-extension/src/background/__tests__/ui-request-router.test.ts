import test from 'node:test';
import assert from 'node:assert/strict';

import { isUiRequest, routeUiRequest } from '../ui-request-router';

test('isUiRequest identifies supported types', () => {
  assert.equal(isUiRequest({ type: 'GET_STATUS' }), true);
  assert.equal(isUiRequest({ type: 'CONNECT' }), true);
  assert.equal(isUiRequest({ type: 'sendMessage' }), true);
  assert.equal(isUiRequest({ type: 'cancelStreaming' }), true);
  assert.equal(isUiRequest({ type: 'unknown' }), false);
});

test('routeUiRequest GET_STATUS maps connection state', async () => {
  const result = await routeUiRequest(
    { type: 'GET_STATUS' },
    { getStatus: () => ({ connected: true }) },
  );

  assert.equal(result.handled, true);
  assert.deepEqual(result.response, {
    status: 'connected',
    connected: true,
    permissions: [],
  });
});

test('routeUiRequest CONNECT returns success when connected', async () => {
  const result = await routeUiRequest(
    { type: 'CONNECT' },
    { connect: () => true },
  );

  assert.equal(result.handled, true);
  assert.deepEqual(result.response, {
    success: true,
    connected: true,
    status: 'connected',
  });
});

test('routeUiRequest sendMessage triggers migration action', async () => {
  const result = await routeUiRequest({ type: 'sendMessage' }, {});
  assert.equal(result.handled, true);
  assert.equal(result.action, 'sendMigrationNotice');
  assert.deepEqual(result.response, { success: true });
});

test('routeUiRequest cancelStreaming triggers cancel action', async () => {
  const result = await routeUiRequest({ type: 'cancelStreaming' }, {});
  assert.equal(result.handled, true);
  assert.equal(result.action, 'cancelStreaming');
  assert.deepEqual(result.response, { success: true, cancelled: true });
});
