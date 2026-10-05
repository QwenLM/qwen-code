/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  buildTrajectorySearchIndex,
  filterTrajectory,
  type TrajectoryFilter,
} from './filterTrajectory';
import type { Trajectory, TrajectoryRow, TrajectoryToolRow } from './types';

const base = {
  clientReceivedAt: 0,
  createdAt: 0,
  updatedAt: 0,
  sourceRecordIds: [],
};

function text(key: string, value: string, kind: 'user' | 'message' = 'user') {
  const block: DaemonTextTranscriptBlock = {
    ...base,
    id: key,
    kind: kind === 'user' ? 'user' : 'thought',
    text: value,
    segmentId: key,
  };
  return {
    key,
    turnIndex: 1,
    depth: 0,
    ...(kind === 'user'
      ? { kind: 'user' as const, block }
      : { kind: 'message' as const, block, thought: true }),
  };
}

function tool(
  key: string,
  over: Partial<DaemonToolTranscriptBlock> = {},
): TrajectoryToolRow {
  return {
    key,
    kind: 'tool',
    depth: 0,
    turnIndex: 1,
    block: {
      ...base,
      id: key,
      kind: 'tool',
      toolCallId: key,
      title: '',
      toolName: 'read_file',
      status: 'completed',
      preview: { kind: 'file_read', path: 'note.txt' },
      ...over,
    },
  };
}

function trajectory(rows: TrajectoryRow[]): Trajectory {
  return {
    rows,
    turns: [],
    rowIndexByKey: new Map(rows.map((row, i) => [row.key, i])),
  };
}

function matches(rows: TrajectoryRow[], over: Partial<TrajectoryFilter> = {}) {
  return filterTrajectory(buildTrajectorySearchIndex(trajectory(rows)), {
    query: '',
    type: 'all',
    status: 'all',
    ...over,
  });
}

const fixture: TrajectoryRow[] = [
  text('U1', '检查配置'),
  {
    key: 'R1',
    kind: 'request',
    turnIndex: 1,
    depth: 0,
    status: 'ok',
    model: 'qwen-A',
    timing: { startedAt: 0, durationMs: 1000 },
  },
  tool('T1', { status: 'failed', rawOutput: '配置损坏' }),
  tool('T2', { status: 'cancelled', toolName: 'run_shell' }),
  text('M1', '配置已记录', 'message'),
  text('U2', '复核'),
  {
    key: 'R2',
    kind: 'request',
    turnIndex: 2,
    depth: 0,
    status: 'error',
    model: 'qwen-B',
    timing: { startedAt: 4000, durationMs: 500 },
  },
  { ...tool('T3'), timing: { durationMs: 300 } },
];

describe('filterTrajectory', () => {
  it.each([
    [{ query: '配置' }, ['U1', 'T1', 'M1']],
    [{ type: 'tool', status: 'error' }, ['T1']],
    [{ status: 'error' }, ['T1', 'R2']],
    [{ query: 'qwen-A' }, ['R1']],
    [{ query: 'read_file' }, ['T1', 'T3']],
    [{ type: 'message' }, ['M1']],
    [{ status: 'cancelled' }, ['T2']],
    [{ query: '   ' }, ['U1', 'R1', 'T1', 'T2', 'M1', 'U2', 'R2', 'T3']],
  ] satisfies Array<[Partial<TrajectoryFilter>, string[]]>)(
    'returns ordered direct matches for %j',
    (filter, expected) => expect(matches(fixture, filter)).toEqual(expected),
  );

  it('matches literal text case-insensitively, keeping internal spaces', () => {
    const rows = [text('a', 'Hello  [world].*')];
    expect(matches(rows, { query: ' HELLO  [WORLD].* ' })).toEqual(['a']);
    expect(matches(rows, { query: 'hello [world]' })).toEqual([]);
    expect(matches(rows, { query: '^hello' })).toEqual([]);
  });

  it('keeps metadata, object keys and scalar fields separate', () => {
    const rows = [
      tool('a', {
        toolName: 'alpha',
        title: 'beta',
        rawInput: { gamma: 'delta', parts: ['epsilon', 'zeta'] },
      }),
    ];
    expect(matches(rows, { query: 'gamma' })).toEqual(['a']);
    for (const query of [
      'alphabeta',
      'alpha beta',
      'gammadelta',
      'epsilonzeta',
    ])
      expect(matches(rows, { query })).toEqual([]);
  });

  it.each([
    ['success', 'success'],
    ['completed', 'success'],
    ['error', 'error'],
    ['failed', 'error'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['pending', 'running'],
    ['in_progress', 'running'],
    ['running', 'running'],
    ['unexpected', 'unknown'],
    ['', 'unknown'],
  ] satisfies Array<[string, TrajectoryFilter['status']]>)(
    'normalizes tool state %s to %s',
    (status, expected) =>
      expect(matches([tool('a', { status })], { status: expected })).toEqual([
        'a',
      ]),
  );

  it('uses timing status over block status and gives only execution rows unknown', () => {
    const row = {
      ...tool('a', { status: 'failed' }),
      toolStatus: 'success' as const,
    };
    expect(matches([row], { status: 'success' })).toEqual(['a']);
    expect(matches([row], { status: 'error' })).toEqual([]);
    expect(
      matches(
        [
          text('b', 'unknown'),
          { ...fixture[1], status: 'unknown' } as TrajectoryRow,
        ],
        {
          status: 'unknown',
        },
      ),
    ).toEqual(['R1']);
  });

  it.each([null, false, 0, ''])(
    'does not fall back from recorded %j output',
    (rawOutput) => {
      const rows = [tool('a', { rawOutput, content: 'fallback-only' })];
      expect(matches(rows, { query: 'fallback-only' })).toEqual([]);
      if (rawOutput !== '') {
        expect(matches(rows, { query: String(rawOutput) })).toEqual(['a']);
      }
    },
  );

  it('falls back from undefined output to content text', () => {
    expect(
      matches([tool('a', { content: 'fallback-only' })], {
        query: 'fallback-only',
      }),
    ).toEqual(['a']);
  });

  it('extracts typed text and safe names, excluding binary/resource bodies', () => {
    const rawOutput = [
      { type: 'content', content: { type: 'text', text: 'visible-text' } },
      { type: 'image', data: 'secret-image', mimeType: 'image/png' },
      { type: 'audio', data: 'secret-audio' },
      {
        type: 'resource',
        name: 'safe-name',
        resource: { text: 'secret-resource' },
      },
      { inlineData: { data: 'secret-inline' } },
      { mimeType: 'image/png', data: 'secret-mime' },
      { base64: 'secret-base64' },
      'data:image/png;base64,secret-data',
      new Uint8Array([115, 101, 99, 114, 101, 116]),
    ];
    const rows = [tool('a', { rawOutput })];
    expect(matches(rows, { query: 'visible-text' })).toEqual(['a']);
    expect(matches(rows, { query: 'safe-name' })).toEqual(['a']);
    for (const query of ['secret', 'image/png', '115'])
      expect(matches(rows, { query })).toEqual([]);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(0);
  });

  it('does not index message attachments or hidden transcript fields', () => {
    const row = text('a', 'hello');
    row.block.images = [{ data: 'secret-image', mimeType: 'image/png' }];
    row.block.files = [
      { name: 'secret-file', mimeType: 'text/plain', text: 'secret-body' },
    ];
    expect(matches([row], { query: 'secret' })).toEqual([]);
  });

  it('indexes only the explicit other-block body whitelist', () => {
    const rows: TrajectoryRow[] = [
      {
        key: 's',
        kind: 'other',
        turnIndex: 1,
        depth: 0,
        block: {
          ...base,
          id: 's',
          kind: 'user_shell',
          command: 'command-needle',
          text: 'output-needle',
          cwd: 'hidden-cwd',
        },
      },
      {
        key: 'p',
        kind: 'other',
        turnIndex: 1,
        depth: 0,
        block: {
          ...base,
          id: 'p',
          kind: 'prompt_cancelled',
          reason: 'reason-needle',
        },
      },
      {
        key: 'd',
        kind: 'other',
        turnIndex: 1,
        depth: 0,
        block: {
          ...base,
          id: 'd',
          kind: 'debug',
          text: 'debug-needle',
          data: { secret: 'hidden-data' },
        },
      },
    ];
    expect(matches(rows, { query: 'needle' })).toEqual(['s', 'p', 'd']);
    expect(matches(rows, { query: 'hidden' })).toEqual([]);
    expect(matches(rows, { type: 'other', status: 'unknown' })).toEqual([]);
  });
});

describe('buildTrajectorySearchIndex budgets', () => {
  it('keeps ordinary JSON fields despite content-like type names', () => {
    const rows = [
      tool('a', { rawInput: { type: 'file', path: '/etc/hosts-needle' } }),
    ];
    expect(matches(rows, { query: 'hosts-needle' })).toEqual(['a']);
    expect(
      matches(
        [
          tool('a', {
            rawOutput: {
              type: 'resource_link',
              uri: 'file:///repo/link-needle',
            },
          }),
        ],
        { query: 'link-needle' },
      ),
    ).toEqual(['a']);
  });

  it('retains prose after SSE data frames and ordinary data prefixes', () => {
    expect(
      matches(
        [tool('a', { rawOutput: 'data: {"event":"ping"}\nerror: oom-needle' })],
        { query: 'oom-needle' },
      ),
    ).toEqual(['a']);
    expect(
      matches([text('u', '  data: the deployment failed with prompt-needle')], {
        query: 'prompt-needle',
      }),
    ).toEqual(['u']);
  });

  it('excludes embedded URI payloads while retaining surrounding prose separately', () => {
    const rows = [
      tool('a', {
        rawOutput:
          'before-needle<img src="data:image/png;base64,' +
          'A'.repeat(9000) +
          '">after-needle',
      }),
    ];
    expect(matches(rows, { query: 'after-needle' })).toEqual(['a']);
    expect(matches(rows, { query: 'before-needle' })).toEqual(['a']);
    expect(matches(rows, { query: 'AAAA' })).toEqual([]);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(0);
    expect(
      matches(
        [tool('a', { rawOutput: 'before data:image/png;base64,AAAA after' })],
        { query: 'before  after' },
      ),
    ).toEqual([]);
  });

  it('excludes non-base64 data URI payloads without dropping later text', () => {
    const rows = [
      tool('a', {
        rawOutput: 'data:text/plain,secret-percent%20payload after-needle',
      }),
    ];
    expect(matches(rows, { query: 'secret-percent' })).toEqual([]);
    expect(matches(rows, { query: 'after-needle' })).toEqual(['a']);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(0);
  });

  it('limits source scanning across values, reporting unscanned prose', () => {
    const rows = [
      tool('a', {
        rawOutput:
          'data:image/png;base64,' + 'A'.repeat(100_000) + ' tail-needle',
      }),
    ];
    expect(matches(rows, { query: 'AAAA' })).toEqual([]);
    expect(matches(rows, { query: 'tail-needle' })).toEqual([]);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(1);
  });

  it('preserves structured data values while excluding binary string payloads', () => {
    const rows = [
      tool('a', {
        rawOutput: [
          { data: 'secret-bare' },
          { data: { text: 'structured-needle' } },
          { data: 'A'.repeat(5000), detail: 'after-needle' },
        ],
      }),
    ];
    expect(matches(rows, { query: 'structured-needle' })).toEqual(['a']);
    expect(matches(rows, { query: 'after-needle' })).toEqual(['a']);
    expect(matches(rows, { query: 'secret-bare' })).toEqual([]);
    expect(matches(rows, { query: 'AAAA' })).toEqual([]);
  });

  it('retains call identities before spending metadata on a long title', () => {
    const rows = [
      tool('a', {
        title: 'y'.repeat(3000),
        toolCallId: 'call-needle',
        parentToolCallId: 'parent-needle',
        subagentType: 'code-reviewer',
      }),
    ];
    for (const query of ['call-needle', 'parent-needle', 'code-reviewer'])
      expect(matches(rows, { query })).toEqual(['a']);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(1);
  });

  it('reserves independent command and output slots for user shell records', () => {
    const shell = (command: string, output: string): TrajectoryRow => ({
      key: 's',
      kind: 'other',
      turnIndex: 1,
      depth: 0,
      block: { ...base, id: 's', kind: 'user_shell', command, text: output },
    });
    expect(
      matches([shell('c'.repeat(8192), 'output-needle')], {
        query: 'output-needle',
      }),
    ).toEqual(['s']);
    expect(
      matches([shell('command-needle', 'o'.repeat(8192))], {
        query: 'command-needle',
      }),
    ).toEqual(['s']);
    expect(
      matches([shell('c'.repeat(4096) + 'command-tail', 'short')], {
        query: 'command-tail',
      }),
    ).toEqual([]);
  });

  it('charges short bodies by consumed rather than reserved window allowance', () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      text(`m${i}`, 'short-body'),
    );
    rows.push(text('last', 'window-tail-needle'));
    expect(matches(rows, { query: 'window-tail-needle' })).toEqual(['last']);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(0);
  });

  it('allocates source code units before Unicode lowercase expansion', () => {
    const rows = [text('u', '\u0130'.repeat(8192))];
    const index = buildTrajectorySearchIndex(trajectory(rows));
    expect(index.rows[0].fields[1]).toBe('i\u0307'.repeat(8192));
    expect(index.truncatedCount).toBe(0);
  });

  it('bounds actual array element reads after exhausting node and text budgets', () => {
    for (const value of ['', 'x'.repeat(4096)]) {
      let reads = 0;
      const input = new Proxy(
        Array.from({ length: 10000 }, () => value),
        {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
            return Reflect.get(target, key, receiver);
          },
        },
      );
      const index = buildTrajectorySearchIndex(
        trajectory([tool('a', { rawInput: input })]),
      );
      expect(reads).toBeLessThanOrEqual(value ? 1 : 255);
      expect(index.truncatedCount).toBe(1);
    }
  });

  it('does not let cyclic repeated text starve subsequent sibling fields', () => {
    const cycle: Record<string, unknown> = { text: 'x'.repeat(1000) };
    cycle['self'] = cycle;
    expect(
      matches(
        [tool('a', { rawInput: { payload: cycle, tail: 'tail-needle' } })],
        { query: 'tail-needle' },
      ),
    ).toEqual(['a']);
  });

  it('caps metadata separately, preserving field boundaries', () => {
    const row = tool('a', {
      toolName: 'x'.repeat(2048),
      title: 'metadata-tail',
    });
    const index = buildTrajectorySearchIndex(trajectory([row]));
    expect(index.truncatedCount).toBe(1);
    expect(index.rows[0].fields.join('').length).toBe(2048);
    expect(matches([row], { query: 'metadata-tail' })).toEqual([]);
  });

  it('reserves independent 4096 character slots for tool input and output', () => {
    const rows = [
      tool('a', {
        rawInput: 'x'.repeat(4096) + 'input-tail',
        rawOutput: 'output-present',
      }),
    ];
    expect(matches(rows, { query: 'input-tail' })).toEqual([]);
    expect(matches(rows, { query: 'output-present' })).toEqual(['a']);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(1);
  });

  it('caps text bodies at 8192 code units before lowercasing', () => {
    const rows = [text('a', 'X'.repeat(8192) + 'body-tail')];
    const index = buildTrajectorySearchIndex(trajectory(rows));
    expect(index.rows[0].fields[1]).toBe('x'.repeat(8192));
    expect(index.truncatedCount).toBe(1);
    expect(matches(rows, { query: 'body-tail' })).toEqual([]);
  });

  it('allocates the window body budget in row order, retaining later metadata', () => {
    const rows: TrajectoryRow[] = Array.from({ length: 256 }, (_, i) =>
      text(`m${i}`, 'x'.repeat(8192)),
    );
    rows.push(tool('last', { toolName: 'late-tool', rawOutput: 'late-body' }));
    const index = buildTrajectorySearchIndex(trajectory(rows));
    expect(index.truncatedCount).toBe(1);
    expect(
      filterTrajectory(index, {
        query: 'late-tool',
        type: 'all',
        status: 'all',
      }),
    ).toEqual(['last']);
    expect(
      filterTrajectory(index, {
        query: 'late-body',
        type: 'all',
        status: 'all',
      }),
    ).toEqual([]);
  });

  it('limits input nodes without consuming output nodes', () => {
    const rows = [
      tool('a', {
        rawInput: Array.from({ length: 1000 }, () => ''),
        rawOutput: 'output-present',
      }),
    ];
    expect(matches(rows, { query: 'output-present' })).toEqual(['a']);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(1);
  });

  it('does not access broad-object properties beyond the node budget', () => {
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 127; i++) {
      Object.defineProperty(value, `k${i}`, { enumerable: true, value: '' });
    }
    Object.defineProperty(value, 'unvisited', {
      enumerable: true,
      get: () => {
        throw new Error('unbounded traversal');
      },
    });
    const index = buildTrajectorySearchIndex(
      trajectory([tool('a', { rawInput: value })]),
    );
    expect(index.truncatedCount).toBe(1);
  });

  it('caps traversal depth and handles cycles', () => {
    let value: unknown = 'deep-tail';
    for (let i = 0; i < 9; i++) value = [value];
    const cycle: Record<string, unknown> = { text: 'cycle-front' };
    cycle['self'] = cycle;
    const rows = [
      tool('deep', { rawInput: value }),
      tool('cycle', { rawOutput: cycle }),
    ];
    expect(matches(rows, { query: 'deep-tail' })).toEqual([]);
    expect(matches(rows, { query: 'cycle-front' })).toEqual(['cycle']);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(2);
  });

  it('stops broad-object traversal when the depth limit is reached', () => {
    const leaf: Record<string, unknown> = {};
    Object.defineProperty(leaf, 'unvisited', {
      enumerable: true,
      get: () => {
        throw new Error('depth limit must stop property reads');
      },
    });
    let value: unknown = leaf;
    for (let i = 0; i < 8; i++) value = [value];
    expect(
      buildTrajectorySearchIndex(trajectory([tool('a', { rawInput: value })]))
        .truncatedCount,
    ).toBe(1);
  });

  it('shares the source scanning allowance across all values in a slot', () => {
    const uri = 'data:image/png;base64,' + 'A'.repeat(30_000);
    const rows = [
      tool('a', {
        rawInput: [uri, uri, uri, 'input-tail'],
        rawOutput: 'output-present',
      }),
    ];
    expect(matches(rows, { query: 'input-tail' })).toEqual([]);
    expect(matches(rows, { query: 'output-present' })).toEqual(['a']);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(1);
  });

  it('bounds visits of sparse arrays and preserves output availability', () => {
    const rows = [
      tool('a', {
        rawInput: new Array(1_000_000),
        rawOutput: 'output-present',
      }),
    ];
    expect(matches(rows, { query: 'output-present' })).toEqual(['a']);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(1);
  });

  it('counts multiple limits within one record once and leaves input immutable', () => {
    const rows = [
      tool('a', {
        rawInput: 'x'.repeat(4097),
        rawOutput: 'y'.repeat(4097),
        title: 'z'.repeat(2049),
      }),
    ];
    const before = structuredClone(rows);
    expect(buildTrajectorySearchIndex(trajectory(rows)).truncatedCount).toBe(1);
    expect(rows).toEqual(before);
  });
});
