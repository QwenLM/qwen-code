/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// parse-review-stream.cjs is CommonJS (the file ext is .cjs because the
// repo's root package.json sets "type": "module"). Vitest's ESM<->CJS
// interop allows `import` from a .cjs module — the named exports surface
// as properties of the default import object.
import { describe, it, expect } from 'vitest';
import {
  extractSegmentFromEvent,
  accumulateSegments,
  buildOutput,
  stripPreamble,
  isRepetitiveStalling,
} from '../parse-review-stream.cjs';

function jsonl(...events) {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

describe('extractSegmentFromEvent', () => {
  it('returns text for an assistant event with content parts', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' world' },
        ],
      },
    };
    expect(extractSegmentFromEvent(ev)).toBe('Hello world');
  });

  it('returns text for a `message` typed event too', () => {
    const ev = {
      type: 'message',
      message: { content: [{ type: 'text', text: 'final' }] },
    };
    expect(extractSegmentFromEvent(ev)).toBe('final');
  });

  it('returns null for non-assistant event types', () => {
    expect(extractSegmentFromEvent({ type: 'stream_event' })).toBeNull();
    expect(extractSegmentFromEvent({ type: 'system' })).toBeNull();
    expect(extractSegmentFromEvent({ type: 'result' })).toBeNull();
  });

  it('returns null when content is missing or not an array', () => {
    expect(
      extractSegmentFromEvent({ type: 'assistant', message: {} }),
    ).toBeNull();
    expect(
      extractSegmentFromEvent({
        type: 'assistant',
        message: { content: 'oops' },
      }),
    ).toBeNull();
  });

  it('filters out non-text parts (thinking)', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'visible' },
        ],
      },
    };
    expect(extractSegmentFromEvent(ev)).toBe('visible');
  });

  it('returns null when content contains tool_use (pre-tool preamble)', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me verify this...' },
          { type: 'tool_use', id: 'x', name: 'Read', input: {} },
        ],
      },
    };
    expect(extractSegmentFromEvent(ev)).toBeNull();
  });

  it('survives null / undefined / non-object input', () => {
    expect(extractSegmentFromEvent(null)).toBeNull();
    expect(extractSegmentFromEvent(undefined)).toBeNull();
    expect(extractSegmentFromEvent('string')).toBeNull();
  });
});

describe('accumulateSegments', () => {
  it('collects multiple assistant segments in order', () => {
    const raw = jsonl(
      { type: 'system' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first' }] },
      },
      { type: 'stream_event', event: {} },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second' }] },
      },
    );
    expect(accumulateSegments(raw)).toEqual(['first', 'second']);
  });

  it('skips malformed JSON lines (truncated-stream case)', () => {
    const valid = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }] },
    });
    // Append a truncated last line (no closing brace) — exactly the
    // shape produced when `timeout` kills qwen mid-write.
    const raw = `${valid}\n{"type":"assistant","message":{"content":[{"typ`;
    expect(accumulateSegments(raw)).toEqual(['ok']);
  });

  it('rejects whitespace-only text segments', () => {
    const raw = jsonl(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '   ' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '\n\n' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'real' }] },
      },
    );
    expect(accumulateSegments(raw)).toEqual(['real']);
  });

  it('returns [] for empty input', () => {
    expect(accumulateSegments('')).toEqual([]);
    expect(accumulateSegments('\n\n\n')).toEqual([]);
  });

  it('returns [] for non-string input (defensive)', () => {
    expect(accumulateSegments(null)).toEqual([]);
    expect(accumulateSegments(undefined)).toEqual([]);
    expect(accumulateSegments(42)).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const raw =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'a' }] },
      }) +
      '\r\n' +
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'b' }] },
      });
    expect(accumulateSegments(raw)).toEqual(['a', 'b']);
  });

});

describe('stripPreamble', () => {
  it('strips thinking text before a ## heading', () => {
    const input =
      'Let me read the files first.\n\nI see — I should use the diff.\n\n## Qwen Code Review (STANDARD)\n\n**What this PR does**: fixes a bug.';
    expect(stripPreamble(input)).toBe(
      '## Qwen Code Review (STANDARD)\n\n**What this PR does**: fixes a bug.',
    );
  });

  it('strips thinking text before a ### heading', () => {
    const input =
      'I need to examine the code.\n\n### Correctness / Security\n\n- P1 bug.';
    expect(stripPreamble(input)).toBe(
      '### Correctness / Security\n\n- P1 bug.',
    );
  });

  it('strips thinking text before a findings list', () => {
    const input =
      'Let me check.\n\n- **P1 `file.ts:42`** — off-by-one error.';
    expect(stripPreamble(input)).toBe(
      '- **P1 `file.ts:42`** — off-by-one error.',
    );
  });

  it('strips text before "No correctness..." verdict', () => {
    const input =
      'Reviewing the diff carefully.\n\nNo correctness or security issues found.';
    expect(stripPreamble(input)).toBe(
      'No correctness or security issues found.',
    );
  });

  it('returns text unchanged when it starts with review content', () => {
    const input = '## Review\n\n- P2 finding.';
    expect(stripPreamble(input)).toBe(input);
  });

  it('returns text unchanged when no review markers found', () => {
    const input = 'Some random text without any markers.';
    expect(stripPreamble(input)).toBe(input);
  });

  it('returns empty string for repetitive stalling text', () => {
    const lines = Array(20).fill(
      'Let me read the source to verify the char comparison:',
    );
    const input = lines.join('\n');
    expect(stripPreamble(input)).toBe('');
  });

  it('keeps non-repetitive long text without markers', () => {
    const input = Array(10)
      .fill(null)
      .map((_, i) => `Unique sentence number ${i} about something different.`)
      .join('\n');
    expect(stripPreamble(input)).toBe(input);
  });
});

describe('isRepetitiveStalling', () => {
  it('detects repeated lines', () => {
    const text = Array(10)
      .fill('Let me read the source to verify.')
      .join('\n');
    expect(isRepetitiveStalling(text)).toBe(true);
  });

  it('rejects short text', () => {
    expect(isRepetitiveStalling('a\na\na')).toBe(false);
  });

  it('rejects text with unique lines', () => {
    const text = Array(10)
      .fill(null)
      .map((_, i) => `Line ${i} is unique.`)
      .join('\n');
    expect(isRepetitiveStalling(text)).toBe(false);
  });
});

describe('buildOutput', () => {
  it('joins multi-segment body with blank lines for single-shot tiers', () => {
    const out = buildOutput(['s1', 's2'], 'STANDARD', 'complete');
    expect(out.header).toBe(
      '<!-- tier=STANDARD; status=complete; segments=2; emitted=2 -->\n',
    );
    // Assert `emitted` directly, not only via the header string: main()
    // destructures `{ emitted }` for its stderr log, so a refactor that
    // drops the property while keeping the header computation must fail
    // a test rather than silently log `undefined`.
    expect(out.emitted).toBe(2);
    expect(out.body).toBe('s1\n\ns2');
    expect(out.full).toBe(
      '<!-- tier=STANDARD; status=complete; segments=2; emitted=2 -->\ns1\n\ns2',
    );
  });

  it('DEEP joins all segments in stream order', () => {
    const segmentA = '## Qwen Code Review (DEEP)';
    const segmentB =
      '### P1 - High\n\n' +
      '1. A real consolidated review finding from the stream.';
    const segmentC = '## Validation Evidence\n\nPRESENT';
    const out = buildOutput([segmentA, segmentB, segmentC], 'DEEP', 'complete');
    expect(out.body).toBe(`${segmentA}\n\n${segmentB}\n\n${segmentC}`);
    expect(out.emitted).toBe(3);
    expect(out.header).toBe(
      '<!-- tier=DEEP; status=complete; segments=3; emitted=3 -->\n',
    );
  });

  it('DEEP with a single segment keeps it as-is', () => {
    const out = buildOutput(['only one'], 'DEEP', 'complete');
    expect(out.body).toBe('only one');
    expect(out.emitted).toBe(1);
    expect(out.header).toContain('emitted=1');
  });

  it('DEEP with 0 segments falls back to the placeholder', () => {
    const out = buildOutput([], 'DEEP', 'timeout');
    expect(out.header).toContain('segments=0');
    expect(out.header).toContain('emitted=0');
    expect(out.emitted).toBe(0);
    expect(out.body).toContain('no assistant text parsed');
  });

  it('writes placeholder body when no segments parsed', () => {
    const out = buildOutput([], 'LIGHT', 'timeout');
    expect(out.header).toContain('segments=0');
    expect(out.header).toContain('emitted=0');
    expect(out.body).toBe(
      '(no assistant text parsed; see the raw stream in the job log)',
    );
    expect(out.full).toContain('(no assistant text parsed');
  });

  it('embeds the provided tier and status verbatim', () => {
    const out = buildOutput(['x'], 'ULTRA_LIGHT', 'error');
    expect(out.header).toBe(
      '<!-- tier=ULTRA_LIGHT; status=error; segments=1; emitted=1 -->\n',
    );
  });
});
