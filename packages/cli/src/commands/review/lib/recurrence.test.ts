/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The pre-scan that feeds the performance agent's accumulation lens. The
// properties that matter: the high-precision patterns hit, the obvious noise
// (function-locals, test files, counters) does not, the line numbers are
// NEW-FILE line numbers (that is what the agent opens), and the output is
// capped so the weld cannot drown its own adjudication contract.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanAccumulationCandidates,
  planRecurrenceField,
  findDownstream,
  MAX_CANDIDATES,
} from './recurrence.js';

// A realistic multi-file unified diff. New-side line numbers are asserted
// below, so the hunk headers and context lines here are load-bearing.
const FIXTURE = [
  'diff --git a/packages/core/src/chat/session.ts b/packages/core/src/chat/session.ts',
  'index 1111111..2222222 100644',
  '--- a/packages/core/src/chat/session.ts',
  '+++ b/packages/core/src/chat/session.ts',
  '@@ -10,4 +10,8 @@ export class Session {',
  '   record(entry: Entry) {', // new line 10
  '-    stale(entry);',
  '+    this.turns.push(entry);', // new line 11
  '+    this.cache.set(entry.id, entry);', // new line 12
  '+    this.transcript += render(entry);', // new line 13
  '+    this.tokensUsed += 1;', // new line 14 — a counter, not a container
  '+    this.bus.on("tick", this.onTick);', // new line 15
  '     finish(entry);', // new line 16
  '   }', // new line 17
  'diff --git a/packages/cli/src/state.ts b/packages/cli/src/state.ts',
  '--- a/packages/cli/src/state.ts',
  '+++ b/packages/cli/src/state.ts',
  '@@ -1,2 +1,7 @@',
  " import { messagesRef } from './ref.js';", // new line 1
  '+const registry = new Map<string, Entry>();', // new line 2 — module-level
  '+export function remember(id: string, entry: Entry) {', // new line 3
  '+  registry.set(id, entry);', // new line 4
  '+  messagesRef.current.push(entry);', // new line 5
  '+}', // new line 6
  ' export {};', // new line 7
  'diff --git a/packages/cli/src/render.ts b/packages/cli/src/render.ts',
  '--- a/packages/cli/src/render.ts',
  '+++ b/packages/cli/src/render.ts',
  '@@ -3,3 +3,5 @@ export function render(items: Item[]) {',
  '   const parts: string[] = [];', // new line 3 — an INDENTED local
  '+  parts.push(header());', // new line 4 — write to that local
  '+  history.push(entries);', // new line 5 — named like long-lived state
  '   return parts.join("");', // new line 6
  ' }', // new line 7
  'diff --git a/packages/cli/src/render.test.ts b/packages/cli/src/render.test.ts',
  '--- a/packages/cli/src/render.test.ts',
  '+++ b/packages/cli/src/render.test.ts',
  '@@ -1,1 +1,2 @@',
  " describe('render', () => {});",
  '+history.push(sample);', // a hit-shaped line, but in a test file
  '',
].join('\n');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scanAccumulationCandidates — the patterns and their exclusions', () => {
  const candidates = scanAccumulationCandidates(FIXTURE);

  it('finds each long-lived write, with new-file line numbers', () => {
    expect(candidates).toEqual([
      {
        file: 'packages/core/src/chat/session.ts',
        line: 11,
        snippet: 'this.turns.push(entry);',
        receiver: 'this.turns',
        kind: 'push',
      },
      {
        file: 'packages/core/src/chat/session.ts',
        line: 12,
        snippet: 'this.cache.set(entry.id, entry);',
        receiver: 'this.cache',
        kind: 'map-set',
      },
      {
        file: 'packages/core/src/chat/session.ts',
        line: 13,
        snippet: 'this.transcript += render(entry);',
        receiver: 'this.transcript',
        kind: 'append',
      },
      {
        file: 'packages/core/src/chat/session.ts',
        line: 15,
        snippet: 'this.bus.on("tick", this.onTick);',
        receiver: 'this.bus',
        kind: 'listener',
      },
      {
        file: 'packages/cli/src/state.ts',
        line: 4,
        snippet: 'registry.set(id, entry);',
        receiver: 'registry',
        kind: 'map-set',
      },
      {
        file: 'packages/cli/src/state.ts',
        line: 5,
        snippet: 'messagesRef.current.push(entry);',
        receiver: 'messagesRef.current',
        kind: 'push',
      },
      {
        file: 'packages/cli/src/render.ts',
        line: 5,
        snippet: 'history.push(entries);',
        receiver: 'history',
        kind: 'push',
      },
    ]);
  });

  it('excludes a push to a local the hunk itself declares', () => {
    // `const parts: string[] = []` is indented — a function-local, gone when
    // the call returns. Its push is the dominant noise shape.
    expect(candidates.some((c) => c.receiver === 'parts')).toBe(false);
  });

  it('excludes a numeric counter accumulation', () => {
    // `this.tokensUsed += 1` grows a number, not a container.
    expect(candidates.some((c) => c.receiver === 'this.tokensUsed')).toBe(
      false,
    );
  });

  it('excludes test files entirely', () => {
    expect(candidates.some((c) => c.file.endsWith('.test.ts'))).toBe(false);
  });

  it('treats a column-0 declaration as module-level, not local', () => {
    // `const registry = new Map()` at column 0 IS the long-lived container the
    // scan exists to surface; only an indented declaration marks a local.
    expect(candidates.some((c) => c.receiver === 'registry')).toBe(true);
  });
});

describe('scanAccumulationCandidates — splice insertions', () => {
  it('finds a multi-line splice insertion on a receiver the hunk does not declare', () => {
    // The measured miss: the dogfooded blocker's write site was a splice whose
    // arguments span four lines. The pattern must hit the CALL-OPENING line,
    // and a receiver declared far outside the hunk must stay eligible.
    const diff = [
      'diff --git a/packages/core/src/core/client.ts b/packages/core/src/core/client.ts',
      '--- a/packages/core/src/core/client.ts',
      '+++ b/packages/core/src/core/client.ts',
      '@@ -100,2 +100,8 @@ export class Client {',
      '   prepare() {', // new line 100
      '+    if (reminder) {', // new line 101
      '+      requestToSend.splice(', // new line 102 — the call opens here
      '+        insertAt,',
      '+        0,',
      '+        reminder,',
      '+      );',
      '+    }',
      ' }',
      '',
    ].join('\n');

    const candidates = scanAccumulationCandidates(diff);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      file: 'packages/core/src/core/client.ts',
      line: 102,
      receiver: 'requestToSend',
      kind: 'push',
    });
  });
});

describe('findDownstream — where a staging local flows', () => {
  const FILE = [
    'export class Client {', // 1
    '  async send(msg: string) {', // 2
    '    const requestToSend = buildParts(msg);', // 3 — declaration, not a flow
    '    requestToSend.splice(0, 0, reminder);', // 4 — the write itself
    '    log(requestToSend.length);', // 5 — a read via dot: write-shaped, skip
    '    await this.chat.sendMessageStream(model, requestToSend);', // 6 — flow
    '    stash = requestToSend;', // 7 — alias flow
    '    return requestToSend;', // 8 — return flow
    '  }', // 9
    '}', // 10
  ].join('\n');

  it('hands over argument, alias, and return sites — never the declaration or the write', () => {
    const sites = findDownstream(FILE, 'requestToSend', 4);
    expect(sites.map((s) => s.line)).toEqual([6, 7, 8]);
    expect(sites[0].snippet).toContain('sendMessageStream');
  });

  it('prefers sites after the write and caps the list', () => {
    const many = [
      'const q = [];', // 1
      'q.push(item);', // 2 — the write
      'a(q);', // 3
      'b(q);', // 4
      'c(q);', // 5
      'd(q);', // 6
    ].join('\n');
    const sites = findDownstream(many, 'q', 2);
    expect(sites).toHaveLength(3);
    expect(sites.map((s) => s.line)).toEqual([3, 4, 5]);
  });
});

describe('planRecurrenceField — the downstream attachment', () => {
  it('attaches flow sites read from the post-diff file for non-this receivers', () => {
    // The measured miss this closes: the adjudicating agent traced a staging
    // local to its declaration, called it bounded, and cleared a real
    // unbounded-growth blocker. The scanner now hands over the next hand-off.
    const dir = mkdtempSync(join(tmpdir(), 'recurrence-flow-'));
    try {
      mkdirSync(join(dir, 'packages/core/src/core'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/core/src/core/client.ts'),
        [
          'const requestToSend = build();', // 1
          'if (reminder) {', // 2
          '  requestToSend.splice(', // 3 — the candidate line
          '    0,',
          '    0,',
          '    reminder,',
          '  );',
          '}',
          'await sendMessageStream(model, requestToSend);', // 9 — the hand-off
        ].join('\n'),
        'utf8',
      );
      const diff = [
        'diff --git a/packages/core/src/core/client.ts b/packages/core/src/core/client.ts',
        '--- a/packages/core/src/core/client.ts',
        '+++ b/packages/core/src/core/client.ts',
        '@@ -1,1 +1,4 @@',
        ' const requestToSend = build();', // context — declaration outside added lines? line 1
        '+if (reminder) {', // 2
        '+  requestToSend.splice(', // 3
        '+    0,',
        '',
      ].join('\n');

      const field = planRecurrenceField(diff, dir);
      const c = field.recurrenceCandidates?.[0];
      expect(c).toBeDefined();
      expect(c?.downstream?.[0]).toMatchObject({ line: 9 });
      expect(c?.downstream?.[0].snippet).toContain('sendMessageStream');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yields no downstream when the file is unreadable, and still lands the candidate', () => {
    const diff = [
      'diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts',
      '--- a/packages/x/src/a.ts',
      '+++ b/packages/x/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+queue.push(item);',
      '',
    ].join('\n');
    const field = planRecurrenceField(diff, '/nonexistent-root');
    expect(field.recurrenceCandidates).toHaveLength(1);
    expect(field.recurrenceCandidates?.[0].downstream).toBeUndefined();
  });
});

describe('scanAccumulationCandidates — the cap', () => {
  it(`keeps the earliest ${MAX_CANDIDATES} candidates`, () => {
    const many = [
      'diff --git a/src/big.ts b/src/big.ts',
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      '@@ -1,0 +1,15 @@',
      ...Array.from({ length: 15 }, (_, i) => `+    this.q${i}.push(x${i});`),
      '',
    ].join('\n');

    const capped = scanAccumulationCandidates(many);
    expect(capped).toHaveLength(MAX_CANDIDATES);
    expect(capped[0]).toMatchObject({ line: 1, receiver: 'this.q0' });
    expect(capped[MAX_CANDIDATES - 1]).toMatchObject({
      line: MAX_CANDIDATES,
      receiver: `this.q${MAX_CANDIDATES - 1}`,
    });
  });
});

describe('planRecurrenceField — the plan shape', () => {
  it('is `{}` when the scan finds nothing, so the field stays absent', () => {
    const diff = [
      'diff --git a/src/pay.ts b/src/pay.ts',
      '--- a/src/pay.ts',
      '+++ b/src/pay.ts',
      '@@ -0,0 +1,1 @@',
      '+export function pay() {}',
      '',
    ].join('\n');
    expect(planRecurrenceField(diff)).toEqual({});
  });

  it('carries the candidates when the scan finds any', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const field = planRecurrenceField(FIXTURE);
    expect(field.recurrenceCandidates).toHaveLength(7);
  });
});
