/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { StreamingToolCallParser } from './streamingToolCallParser.js';

it('keeps both calls intact when an empty colliding opener has id-less continuations', () => {
  const parser = new StreamingToolCallParser();
  parser.addChunk(0, '{"path":"first.ts"}', 'call_read', 'read_file');
  // An empty opener cannot be recovered by searching for incomplete JSON.
  parser.addChunk(0, '', 'call_search', 'grep_search');
  parser.addChunk(0, '{"pattern":"needle",');
  parser.addChunk(0, '"path":"src"}');

  expect(parser.getCompletedToolCalls()).toEqual([
    {
      id: 'call_read',
      name: 'read_file',
      args: { path: 'first.ts' },
      index: 0,
    },
    {
      id: 'call_search',
      name: 'grep_search',
      args: { pattern: 'needle', path: 'src' },
      index: 1,
    },
  ]);
});
