import { describe, expect, it } from 'vitest';
import { WEB_VIEWS } from './views';

describe('WEB_VIEWS', () => {
  it('contains the MVP cockpit sections', () => {
    expect(WEB_VIEWS.map((view) => view.id)).toEqual([
      'chat',
      'sessions',
      'files',
      'artifacts',
      'mcp',
      'tools',
      'skills',
      'memory',
      'settings',
    ]);
  });
});
