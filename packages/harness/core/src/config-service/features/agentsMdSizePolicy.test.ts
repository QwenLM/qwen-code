/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  subscribeConfigValue: vi.fn(),
}));
vi.mock('../index.js', () => mocks);
import {
  parseAgentsMdSizePolicy,
  getAgentsMdSizePolicy,
  registerAgentsMdSizePolicyFeature,
  onAgentsMdSizePolicyChanged,
} from './agentsMdSizePolicy.js';
describe('agents_md_size_policy', () => {
  it.each([
    undefined,
    null,
    [],
    {},
    'bad',
    { project_doc_max_bytes: 0 },
    { project_doc_max_bytes: -1 },
    { project_doc_max_bytes: 1.5 },
    { project_doc_max_bytes: '32768' },
    { project_doc_max_bytes: Infinity },
  ])('falls back safely: %#', (value) => {
    expect(parseAgentsMdSizePolicy(value)).toEqual({
      projectDocMaxBytes: 32_768,
      source: 'default',
    });
  });
  it('accepts semantic JSON and object payloads', () => {
    mocks.getConfigValue.mockReturnValue('{"project_doc_max_bytes":65536}');
    expect(getAgentsMdSizePolicy()).toEqual({
      projectDocMaxBytes: 65_536,
      source: 'qcs',
    });
    expect(parseAgentsMdSizePolicy({ project_doc_max_bytes: 1024 })).toEqual({
      projectDocMaxBytes: 1024,
      source: 'qcs',
    });
  });
  it('forwards QCS notifications without adding warning dedup and unsubscribes', () => {
    registerAgentsMdSizePolicyFeature();
    const notify = mocks.subscribeConfigValue.mock.calls.at(-1)![1];
    const listener = vi.fn();
    const dispose = onAgentsMdSizePolicyChanged(listener);
    notify({ project_doc_max_bytes: 100 });
    notify({ project_doc_max_bytes: 100 });
    expect(listener).toHaveBeenCalledTimes(2);
    dispose();
    notify(undefined);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
