/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseJoinLink } from './agent-host-join.js';

describe('parseJoinLink', () => {
  it('splits the coordinator and workspace out of the non-secret link', () => {
    expect(parseJoinLink('https://hub.local:4170/join/ws_1')).toEqual({
      serverUrl: 'https://hub.local:4170',
      workspaceId: 'ws_1',
    });
  });

  it('keeps a path prefix the coordinator is served under', () => {
    expect(parseJoinLink('http://10.0.0.2:4170/qwen/join/ws_1').serverUrl).toBe(
      'http://10.0.0.2:4170/qwen',
    );
  });

  it('refuses anything that is not a join link', () => {
    for (const bad of [
      'not a url',
      'ftp://hub/join/ws_1',
      'https://hub/join/',
      'https://hub/join/ws_1/extra',
      'https://hub/other/ws_1',
      'https://hub/join/ws 1',
    ]) {
      expect(() => parseJoinLink(bad)).toThrow(/--join/);
    }
  });
});
