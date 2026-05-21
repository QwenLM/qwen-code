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
    expect(extractSegmentFromEvent({ type: 'assistant', message: {} })).toBeNull();
    expect(
      extractSegmentFromEvent({ type: 'assistant', message: { content: 'oops' } }),
    ).toBeNull();
  });

  it('filters out non-text parts', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'visible' },
          { type: 'tool_use', name: 'x' },
        ],
      },
    };
    expect(extractSegmentFromEvent(ev)).toBe('visible');
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
      { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'stream_event', event: {} },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
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
      { type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '\n\n' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'real' }] } },
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

describe('buildOutput', () => {
  it('joins multi-segment body with blank lines for single-shot tiers', () => {
    const out = buildOutput(['s1', 's2'], 'STANDARD', 'complete');
    expect(out.header).toBe(
      '<!-- tier=STANDARD; status=complete; segments=2; emitted=2 -->\n',
    );
    expect(out.body).toBe('s1\n\ns2');
    expect(out.full).toBe(
      '<!-- tier=STANDARD; status=complete; segments=2; emitted=2 -->\ns1\n\ns2',
    );
  });

  it('DEEP emits only the largest segment (drops orchestrator narration)', () => {
    // The bundled multi-agent skill streams many short narration
    // segments plus one large segment that is the real review.
    const narrationA = 'Launching all 6 review agents in parallel.';
    const review =
      '# Code Review — PR #1\n\n## Findings\n\n' +
      'A real consolidated review, much longer than any narration line.';
    const narrationB = 'All agents unanimous. Review closed.';
    const out = buildOutput(
      [narrationA, review, narrationB],
      'DEEP',
      'complete',
    );
    expect(out.body).toBe(review);
    expect(out.header).toBe(
      '<!-- tier=DEEP; status=complete; segments=3; emitted=1 -->\n',
    );
  });

  it('DEEP with a single segment keeps it as-is', () => {
    const out = buildOutput(['only one'], 'DEEP', 'complete');
    expect(out.body).toBe('only one');
    expect(out.header).toContain('emitted=1');
  });

  it('DEEP with 0 segments falls back to the placeholder', () => {
    // The `tier === 'DEEP' && segments.length > 1` branch is distinct
    // from the empty-input path — pin it explicitly so a future change
    // to the DEEP guard cannot silently break the 0-segment fallthrough.
    const out = buildOutput([], 'DEEP', 'timeout');
    expect(out.header).toContain('segments=0');
    expect(out.header).toContain('emitted=0');
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
