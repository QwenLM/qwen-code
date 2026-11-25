/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { McpCursorPager } from './mcp-pagination.js';

describe('McpCursorPager', () => {
  it('rejects a cursor it has already seen', () => {
    const pager = new McpCursorPager();
    pager.next('page-2', 'tools/list');

    expect(() => pager.next('page-2', 'tools/list')).toThrow(/same cursor/);
  });

  it('bounds a server that keeps inventing new cursors', () => {
    const pager = new McpCursorPager();
    for (let page = 0; page < 100; page += 1) {
      pager.next(`page-${page}`, 'tools/list');
    }

    expect(() => pager.next('page-100', 'tools/list')).toThrow(/exceeded/);
  });
});
