import { expect, it } from 'vitest';
import { plugin } from './index.js';

it('exposes only credentials and interactive cards in channel management', () => {
  expect(plugin.requiredConfigFields).toEqual(['clientId', 'clientSecret']);
  expect(plugin.management?.fields.map((field) => field.key)).toEqual([
    'clientId',
    'clientSecret',
    'interactiveCards',
  ]);
});
