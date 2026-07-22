import { describe, expect, it } from 'bun:test';
import {
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser';

describe('route-parser: goals route', () => {
  it('parses goals as its own navigator', () => {
    expect(parseCompoundRoute('goals')).toEqual({
      navigator: 'goals',
      details: null,
    });
    expect(parseRouteToNavigationState('goals')).toEqual({
      navigator: 'goals',
    });
  });

  it('roundtrips the Goals navigation state', () => {
    expect(buildRouteFromNavigationState({ navigator: 'goals' })).toBe('goals');
  });
});
