import { describe, expect, it } from 'vitest';
import { matchMessageRoute } from './message-routes.js';

describe('matchMessageRoute', () => {
  const routes = new Map([
    ['/review', 'Review changes.'],
    ['/review deep', 'Review thoroughly.'],
    ['/QA', 'Answer questions.'],
  ]);

  it('selects the longest matching prefix and strips leading mentions', () => {
    expect(matchMessageRoute('@one <@two> /review deep 123', routes)).toEqual({
      prefix: '/review deep',
      instructions: 'Review thoroughly.',
      text: '123',
    });
  });

  it.each(['/reviewer 123', '/qa question', '/review', '/review   ', 'hello'])(
    'filters %s without a default',
    (text) => {
      expect(matchMessageRoute(text, routes)).toBeUndefined();
    },
  );

  it('preserves ordinary text when falling back to the configured default', () => {
    expect(matchMessageRoute(' hello ', routes, '/QA')).toEqual({
      prefix: '/QA',
      instructions: 'Answer questions.',
      text: ' hello ',
    });
    expect(matchMessageRoute('/review 123', routes, '/QA')?.prefix).toBe(
      '/review',
    );
  });
});
