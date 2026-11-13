/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { matchesWorkspaceQuery } from './workspaceFilter';

describe('matchesWorkspaceQuery', () => {
  it('matches a case-insensitive substring', () => {
    expect(matchesWorkspaceQuery(['/home/dev/Projects'], 'projects')).toBe(
      true,
    );
    expect(matchesWorkspaceQuery(['Setup-Qwencode'], 'SETUP')).toBe(true);
  });

  it('matches any candidate, including a missing displayName', () => {
    expect(matchesWorkspaceQuery([undefined, '/tmp/app'], 'app')).toBe(true);
    expect(matchesWorkspaceQuery([undefined, undefined], 'app')).toBe(false);
    expect(matchesWorkspaceQuery([], 'app')).toBe(false);
  });

  it('matches nothing when no candidate contains the query', () => {
    expect(matchesWorkspaceQuery(['/tmp/app', 'Backend'], 'front')).toBe(false);
  });

  it('treats an empty or whitespace-only query as a full match', () => {
    expect(matchesWorkspaceQuery(['/tmp/app'], '')).toBe(true);
    expect(matchesWorkspaceQuery(['/tmp/app'], '   ')).toBe(true);
    expect(matchesWorkspaceQuery([], '')).toBe(true);
  });

  it('trims the query before matching', () => {
    expect(matchesWorkspaceQuery(['/tmp/App Store'], '  app store  ')).toBe(
      true,
    );
  });
});
