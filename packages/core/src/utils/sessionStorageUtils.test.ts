/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractJsonStringField,
  extractLastJsonStringField,
  extractLastJsonStringFields,
  LITE_READ_BUF_SIZE,
  extractJsonStringFieldFromLastMatchingLine,
  readLastMatchingLineFieldSync,
  readLastJsonStringFieldSync,
  readLastJsonStringFieldsSync,
  unescapeJsonString,
  type MatchingRecordFieldReader,
} from './sessionStorageUtils.js';

// A custom_title record, with titleSource only when given.
const rec = (title: string, source?: string) =>
  `{"subtype":"custom_title","customTitle":"${title}"${source === undefined ? '' : `,"titleSource":"${source}"`}}`;
const userMsg = (n: number, ch = 'x') =>
  `{"type":"user","message":"${ch.repeat(n)}"}`;
const padTo = (label: string, byteCount: number) =>
  `${label}\n${userMsg(Math.max(0, byteCount - 30))}\n`;
// `line` with LITE_READ_BUF_SIZE + 16KB of filler on each side: it falls in
// neither the head nor the tail window.
const buried = (line: string) =>
  padTo('{"type":"user"}', LITE_READ_BUF_SIZE + 16 * 1024) +
  `${line}\n` +
  padTo('{"type":"user"}', LITE_READ_BUF_SIZE + 16 * 1024);
const pair = (customTitle?: string, titleSource?: string) => ({
  customTitle,
  titleSource,
});
const hit = (value?: string) => ({ matched: true, value });

// Per-test temp dir for the enclosing describe (mocks restored after each
// test). The returned fn gives a path in it, writing `content` when given.
function useTmpFiles(prefix: string) {
  let tmpDir = '';
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  return (name: string, content?: string) => {
    const p = path.join(tmpDir, name);
    if (content !== undefined) fs.writeFileSync(p, content);
    return p;
  };
}

// Appends `line` to `p` during the first fs.readSync: the file grows while
// the reader is mid-scan.
function appendOnFirstRead(p: string, line: string) {
  const originalReadSync = fs.readSync;
  let readCount = 0;
  vi.spyOn(fs, 'readSync').mockImplementation(((
    ...args: Parameters<typeof fs.readSync>
  ) => {
    readCount++;
    if (readCount === 1) fs.appendFileSync(p, line);
    return originalReadSync(...args);
  }) as typeof fs.readSync);
}

describe('sessionStorageUtils', () => {
  const GOAL = '"subtype":"goal_state"';
  const create = (objective: string) =>
    `{"type":"system","subtype":"goal_state","systemPayload":{"snapshot":{"goal":{"objective":"${objective}"}}}}`;

  describe('unescapeJsonString', () => {
    it('should return string as-is when no escapes', () => {
      expect(unescapeJsonString('hello world')).toBe('hello world');
    });

    it('should unescape JSON escape sequences', () => {
      expect(unescapeJsonString('hello\\nworld')).toBe('hello\nworld');
      expect(unescapeJsonString('tab\\there')).toBe('tab\there');
      expect(unescapeJsonString('quote\\"here')).toBe('quote"here');
    });

    it('should handle backslash', () => {
      expect(unescapeJsonString('path\\\\to\\\\file')).toBe('path\\to\\file');
    });
  });

  describe('extractJsonStringField', () => {
    const field = (text: string) => extractJsonStringField(text, 'customTitle');

    it('should extract field without space after colon', () => {
      expect(field('{"customTitle":"my-feature"}')).toBe('my-feature');
    });

    it('should extract field with space after colon', () => {
      expect(field('{"customTitle": "my-feature"}')).toBe('my-feature');
    });

    it('should extract field with same-line whitespace around colon', () => {
      expect(field('{"customTitle" \t: \t"my-feature"}')).toBe('my-feature');
    });

    it('should return first match', () => {
      const text = '{"customTitle":"first"}\n{"customTitle":"second"}';
      expect(field(text)).toBe('first');
    });

    it('should return undefined when field not found', () => {
      expect(field('{"type":"user","message":"hello"}')).toBeUndefined();
    });

    it('should handle escaped characters in value', () => {
      expect(field('{"customTitle":"hello\\nworld"}')).toBe('hello\nworld');
    });

    it('should handle escaped quotes in value', () => {
      expect(field('{"customTitle":"say \\"hi\\""}')).toBe('say "hi"');
    });

    it('should work on truncated/partial lines', () => {
      // Simulates reading from middle of a file where first line is cut
      const text = 'tle":"partial"}\n{"customTitle":"complete"}';
      expect(field(text)).toBe('complete');
    });
  });

  describe('extractLastJsonStringField', () => {
    const last = (text: string, ...lineContains: [string?]) =>
      extractLastJsonStringField(text, 'customTitle', ...lineContains);

    it('should return last occurrence', () => {
      const text = '{"customTitle":"old-name"}\n{"customTitle":"new-name"}';
      expect(last(text)).toBe('new-name');
    });

    it('should handle single occurrence', () => {
      expect(last('{"customTitle":"only-one"}')).toBe('only-one');
    });

    it('should return undefined when not found', () => {
      expect(last('{"type":"user"}')).toBeUndefined();
    });

    it('should handle mixed spacing styles', () => {
      const text = '{"customTitle":"no-space"}\n{"customTitle": "with-space"}';
      expect(last(text)).toBe('with-space');
    });

    it('should return the latest match when the last field has whitespace around colon', () => {
      const text = `${rec('old')}\n{"subtype":"custom_title","customTitle" : "new"}`;
      expect(last(text, '"subtype":"custom_title"')).toBe('new');
    });

    it('should return globally last match when mixed patterns interleave', () => {
      // Bug fix: previously returned "middle" because the second pattern
      // ("key": "value") scan overwrote the result from the first pattern.
      const text =
        '{"customTitle":"old"}\n{"customTitle": "middle"}\n{"customTitle":"newest"}';
      expect(last(text)).toBe('newest');
    });

    it('should filter by lineContains when provided', () => {
      const text = [
        '{"type":"user","content":"I set customTitle to \\"customTitle\\":\\"fake\\""}',
        rec('real-title'),
      ].join('\n');
      expect(last(text, 'custom_title')).toBe('real-title');
    });

    it('should not close a truncated value on the next JSONL record', () => {
      const text = `{"subtype":"custom_title","customTitle":"partial\n${rec('complete')}`;
      expect(last(text, 'custom_title')).toBe('complete');
    });

    it('should not skip a newline after a dangling escape', () => {
      const text =
        '{"subtype":"custom_title","customTitle":"partial\\\n{"type":"assistant","content":"hi"}';
      expect(last(text, 'custom_title')).toBeUndefined();
    });

    it('should ignore matches on lines without lineContains marker', () => {
      const text = `{"role":"assistant","customTitle":"spoofed"}\n${rec('legit')}`;
      expect(last(text, 'custom_title')).toBe('legit');
    });

    it('should return undefined when lineContains excludes all matches', () => {
      expect(
        last('{"customTitle":"no-subtype-here"}', 'custom_title'),
      ).toBeUndefined();
    });

    it('should not confuse different field names', () => {
      const text = '{"otherField":"other-value"}\n{"customTitle":"user-name"}';
      expect(last(text)).toBe('user-name');
      expect(extractLastJsonStringField(text, 'otherField')).toBe(
        'other-value',
      );
    });

    it('should handle many occurrences', () => {
      const lines = Array.from(
        { length: 10 },
        (_, i) => `{"customTitle":"title-${i}"}`,
      ).join('\n');
      expect(last(lines)).toBe('title-9');
    });
  });

  describe('extractJsonStringFieldFromLastMatchingLine', () => {
    const isGoalStateRecord = (record: unknown) =>
      typeof record === 'object' &&
      record !== null &&
      (record as Record<string, unknown>)['type'] === 'system' &&
      (record as Record<string, unknown>)['subtype'] === 'goal_state';
    const readGoalStateObjective = (record: unknown) => {
      if (!isGoalStateRecord(record)) {
        return { matched: false, value: undefined };
      }
      const payload = (record as Record<string, unknown>)['systemPayload'];
      return {
        matched: true,
        value:
          typeof payload === 'object' && payload !== null
            ? extractJsonStringField(JSON.stringify(payload), 'objective')
            : undefined,
      };
    };
    const nestedGoal = {
      type: 'system',
      subtype: 'goal_state',
      systemPayload: {
        snapshot: { goal: { objective: 'injected' } },
      },
    };
    const nestedMarkerLine = JSON.stringify({
      type: 'assistant',
      functionCall: { args: nestedGoal },
    });
    // `containing` cut right after its embedded nestedGoal.
    const tornAfterNested = (containing: string) => {
      const nestedJson = JSON.stringify(nestedGoal);
      return containing.slice(
        0,
        containing.indexOf(nestedJson) + nestedJson.length,
      );
    };
    // `/goal clear` writes `goal: null` and a `clearedGoal` order — the line
    // carries no `objective` at all.
    const clear =
      '{"type":"system","subtype":"goal_state","systemPayload":{"snapshot":{"goal":null,"clearedGoal":{"goalId":"g1"}}}}';
    const MISS = { matched: false, value: undefined };
    const scan = (
      text: string,
      ...opts: [
        boolean?,
        ((record: unknown) => boolean)?,
        MatchingRecordFieldReader?,
      ]
    ) =>
      extractJsonStringFieldFromLastMatchingLine(
        text,
        GOAL,
        'objective',
        ...opts,
      );
    const scanRead = (text: string) =>
      scan(text, true, undefined, readGoalStateObjective);

    it('reads the field from the last matching line', () => {
      const text = [create('first'), create('second')].join('\n');
      expect(scan(text, true)).toEqual(hit('second'));
    });

    it('reports a matched line that omits the field, rather than an older value', () => {
      expect(scan([create('first'), clear].join('\n'), true)).toEqual(hit());
    });

    it('reports no match when no line carries the marker', () => {
      expect(scan('{"type":"user","message":"hi"}', true)).toEqual(MISS);
    });

    it('uses a complete suffix record after an earlier torn record', () => {
      const torn = '{"type":"system","subtype":"note","text":"torn';
      expect(scan(`${create('old')}${torn}${clear}`, true)).toEqual(hit());
    });

    it('rejects a nested marker when the containing record does not match', () => {
      expect(scan(nestedMarkerLine, true, isGoalStateRecord)).toEqual(MISS);
    });

    it('rejects a nested marker at the end of a torn containing record', () => {
      const torn = tornAfterNested(nestedMarkerLine);
      expect(scan(torn, true, isGoalStateRecord)).toEqual(MISS);
    });

    it('does not read a goal-shaped array element from a torn containing record', () => {
      const containing = JSON.stringify({
        type: 'assistant',
        parts: [nestedGoal],
      });
      expect(scanRead(tornAfterNested(containing))).toEqual(hit());
    });

    it('does not read a comma-positioned goal-shaped array element from a torn record', () => {
      const containing = JSON.stringify({
        type: 'assistant',
        parts: [{ type: 'text', text: 'before' }, nestedGoal],
      });
      expect(scanRead(tornAfterNested(containing))).toEqual(hit());
    });

    it('uses the newest value-returning Goal record on a glued line', () => {
      expect(scanRead(`${create('old')}${create('real')}`)).toEqual(
        hit('real'),
      );
    });

    it('re-attributes a rejected nested marker to an earlier glued Goal record', () => {
      expect(scanRead(`${create('real')}${nestedMarkerLine}`)).toEqual(
        hit('real'),
      );
    });

    it('does not recover an older value when the newest marker cannot be attributed', () => {
      const torn = '{"type":"system","subtype":"note","systemPayload":';
      expect(scanRead(`${create('old')}${torn}${clear}`)).toEqual(hit());
    });

    it('continues past a rejected marker to an older matching record', () => {
      const text = [create('real'), nestedMarkerLine].join('\n');
      expect(scan(text, true, isGoalStateRecord)).toEqual(hit('real'));
    });

    it('ignores a leading partial line unless told the text starts on a boundary', () => {
      // A tail-window read starts mid-record: the marker is in view but the
      // fields that precede it are not.
      const partial = `"goal":{"objective":"cut off"}}}\n${create('whole')}`;
      expect(scan(`{"subtype":"goal_state","x":${partial}`)).toEqual(
        hit('whole'),
      );
      expect(scan('{"snapshot":{}},"subtype":"goal_state"}\n')).toEqual(MISS);
    });
  });

  describe('readLastMatchingLineFieldSync', () => {
    const files = useTmpFiles('sst-lastline-');
    const writeLines = (name: string, lines: string[]) =>
      files(name, lines.join('\n') + '\n');
    const readGoal = (p: string) =>
      readLastMatchingLineFieldSync(p, GOAL, 'objective');
    const miss = (reason: string) => ({ matched: false, reason });
    const clear =
      '{"type":"system","subtype":"goal_state","systemPayload":{"snapshot":{"goal":null}}}';
    const truncated =
      '{"type":"system","subtype":"goal_state","objective":"partial';
    const filler = (bytes: number) =>
      Array.from(
        { length: Math.ceil(bytes / 100) },
        (_, i) => `{"type":"user","message":"${'x'.repeat(80)}-${i}"}`,
      ).join('\n');
    // Makes the first size-probing fstat report `initialSize`. Where
    // O_NOFOLLOW is unavailable (Windows), opening the file performs one extra
    // fstat for the symlink identity check before any tail read; that fstat is
    // not a size probe and must not consume the stale-size injection.
    function staleFirstSize(initialSize: number) {
      const originalFstatSync = fs.fstatSync;
      const oNofollow: number | undefined = fs.constants?.O_NOFOLLOW;
      const identityFstats = oNofollow === undefined ? 1 : 0;
      let fstatCalls = 0;
      vi.spyOn(fs, 'fstatSync').mockImplementation(((
        ...args: Parameters<typeof fs.fstatSync>
      ) => {
        const stats = originalFstatSync(...args);
        if (fstatCalls++ === identityFstats) stats.size = initialSize;
        return stats;
      }) as typeof fs.fstatSync);
    }

    it('returns the objective of the only goal record', () => {
      const p = writeLines('small.jsonl', [create('Ship it')]);
      expect(readGoal(p)).toEqual(hit('Ship it'));
    });

    it('does not resurrect a cleared objective from an earlier record', () => {
      const p = writeLines('cleared.jsonl', [
        create('Write the release notes'),
        clear,
      ]);
      expect(readGoal(p)).toEqual(hit());
    });

    it('uses the newest goal record on a glued physical line', () => {
      const p = writeLines('glued.jsonl', [
        `${create('Write the release notes')}${clear}`,
      ]);
      expect(readGoal(p)).toEqual(hit());
    });

    it('recovers a clear glued after a torn goal record', () => {
      const p = writeLines('torn-glued.jsonl', [`${truncated}${clear}`]);
      expect(readGoal(p)).toEqual(hit());
    });

    it('skips a crash-truncated objective record', () => {
      const p = writeLines('truncated.jsonl', [create('Ship it'), truncated]);
      expect(readGoal(p)).toEqual(hit('Ship it'));
    });

    it('keeps a clear authoritative before a crash-truncated record', () => {
      const p = writeLines('cleared-then-truncated.jsonl', [
        create('Ship it'),
        clear,
        truncated,
      ]);
      expect(readGoal(p)).toEqual(hit());
    });

    it('reads the clear record when it sits at EOF of a long transcript', () => {
      const p = writeLines('long-cleared.jsonl', [
        create('Write the migration guide'),
        filler(LITE_READ_BUF_SIZE * 3),
        clear,
      ]);
      expect(readGoal(p)).toEqual(hit());
    });

    it('does not fall back to the head window when the goal record is out of reach', () => {
      // The clear record fell out of the tail window along with the create
      // record. A head-window hit would resurrect the long-cleared objective.
      const p = writeLines('out-of-reach.jsonl', [
        create('Write the migration guide'),
        clear,
        filler(LITE_READ_BUF_SIZE * 3),
      ]);
      expect(readGoal(p)).toEqual(miss('out-of-window'));
    });

    it('reports an absent record for a file with no goal line', () => {
      const p = writeLines('none.jsonl', ['{"type":"user","message":"hi"}']);
      expect(readGoal(p)).toEqual(miss('absent'));
    });

    it('re-reads a clear appended during the first tail read', () => {
      const legacy = '{"type":"system","subtype":"slash_command"}';
      const p = writeLines('grows-with-clear.jsonl', [legacy, clear]);
      staleFirstSize(Buffer.byteLength(`${legacy}\n`));
      expect(readGoal(p)).toEqual(hit());
    });

    it('reports absent when contiguous growth crosses the tail threshold', () => {
      const initial = `${'x'.repeat(60 * 1024 - 1)}\n`;
      const p = files(
        'grows-past-window.jsonl',
        initial + 'y'.repeat(6 * 1024),
      );
      staleFirstSize(Buffer.byteLength(initial));
      expect(readGoal(p)).toEqual(miss('absent'));
    });

    it('reports an unreadable file rather than an absent record', () => {
      expect(readGoal(files('nope.jsonl'))).toEqual(miss('unreadable'));
    });

    it('treats an empty file as an absent record', () => {
      expect(readGoal(files('empty.jsonl', ''))).toEqual(miss('absent'));
    });
  });

  describe('readLastJsonStringFieldSync', () => {
    const files = useTmpFiles('sst-readlast-');
    const readTitle = (p: string, ...scratch: [Buffer?]) =>
      readLastJsonStringFieldSync(p, 'customTitle', 'custom_title', ...scratch);

    it('returns undefined for a missing file', () => {
      expect(readTitle(files('does-not-exist.jsonl'))).toBeUndefined();
    });

    it('returns undefined for an empty file', () => {
      expect(readTitle(files('empty.jsonl', ''))).toBeUndefined();
    });

    it('returns the only match for a small file', () => {
      const p = files('small.jsonl', `{"type":"user"}\n${rec('only')}\n`);
      expect(readTitle(p)).toBe('only');
    });

    it('returns the last match when the tail contains the field', () => {
      const p = files('tail-hit.jsonl', `${rec('old')}\n${rec('new')}\n`);
      expect(readTitle(p)).toBe('new');
    });

    it('falls back to head window when tail has no match', () => {
      // Tail-first + head-fallback: the title record sits in the first 64KB
      // but filler pushes it out of the last 64KB. The head scan resolves it
      // without touching the middle of the file (bounded I/O). Modern sessions
      // don't reach this branch — the ChatRecordingService re-anchor invariant
      // keeps the title in the tail; this is the legacy safety net.
      const filler = userMsg(256);
      // ~4x the tail window, guaranteed to push the title line out of tail.
      const fillerCount = Math.ceil((LITE_READ_BUF_SIZE * 4) / filler.length);
      const content =
        rec('in-head-window') +
        '\n' +
        Array.from({ length: fillerCount }, () => filler).join('\n') +
        '\n';

      const p = files('head-fallback.jsonl', content);
      expect(fs.statSync(p).size).toBeGreaterThan(LITE_READ_BUF_SIZE * 3);
      expect(readTitle(p)).toBe('in-head-window');
    });

    it('returns undefined when title is buried beyond both head and tail windows', () => {
      // Anti-test for the previous Phase-2 full-file scan: a title stranded in
      // the middle of a >2x tail-window file is intentionally NOT found.
      // Listing latency is bounded to 2 x LITE_READ_BUF_SIZE per file, at the
      // cost of legacy sessions whose writer never re-anchored the title;
      // callers downgrade to firstPrompt.
      const p = files('buried.jsonl', buried(rec('buried-out-of-reach')));
      expect(readTitle(p)).toBeUndefined();
    });

    it('respects the lineContains filter when scanning', () => {
      const p = files(
        'filter.jsonl',
        `{"type":"user","customTitle":"spoofed-in-user-content"}\n${rec('legit')}\n`,
      );
      expect(readTitle(p)).toBe('legit');
    });

    it('returns undefined when neither head nor tail contains the field', () => {
      // Legacy "no title anywhere": a long stream of user records with no
      // metadata. Both windows scan in vain; we return undefined cheaply
      // instead of paying for a full-file scan.
      const line = userMsg(512);
      const lineCount = Math.ceil((LITE_READ_BUF_SIZE * 3) / line.length);
      const content =
        Array.from({ length: lineCount }, () => line).join('\n') + '\n';
      expect(readTitle(files('no-title.jsonl', content))).toBeUndefined();
    });

    it('handles a final line without a trailing newline', () => {
      const p = files(
        'no-trailing-newline.jsonl',
        `{"type":"user"}\n${rec('last')}`,
      );
      expect(readTitle(p)).toBe('last');
    });

    it('does not pick up a customTitle from a partial trailing line in the head window', () => {
      // The fixed 64KB head buffer can end mid-record. Untrimmed, the
      // extractor would take a partial line whose `customTitle` value closes
      // within the buffer as the latest match, returning a value from a record
      // we never saw end. The fix drops everything past the final newline, so
      // only complete lines vote. Layout: line1 is a complete custom_title
      // record; line2 shows `"customTitle":"phantom"` and the marker in the
      // head window but its `\n` lies past it; the tail filler pushes the file
      // past 2x LITE_READ_BUF_SIZE so head fallback runs (tail has no match).
      const line1 =
        '{"type":"system","subtype":"custom_title","customTitle":"complete"}\n';
      const line2 =
        '{"type":"system","subtype":"custom_title","customTitle":"phantom","filler":"' +
        'x'.repeat(LITE_READ_BUF_SIZE + 8 * 1024) +
        '"}\n';
      const tailFiller = userMsg(LITE_READ_BUF_SIZE + 4 * 1024, 'a') + '\n';
      const p = files('partial-line-head.jsonl', line1 + line2 + tailFiller);
      // Without the fix, "phantom" would win by being later in the buffer.
      expect(readTitle(p)).toBe('complete');
    });

    it('reuses a caller-provided scratch buffer across tail and head reads', () => {
      // Buffer-pool plumbing (listSessions passes a scratch buffer per page):
      // results must match the no-buffer path, and one buffer backing tail
      // and head reads on files of different sizes must not leak bytes
      // between reads — bytesRead bounds the decode, never buffer capacity.
      const big = files('big.jsonl', `${rec('big-file')}\n`);
      const small = files('small.jsonl', `${rec('x')}\n`);
      const scratch = Buffer.alloc(LITE_READ_BUF_SIZE);
      // Sentinel fill: a decode reading past `bytesRead` corrupts the result.
      scratch.fill(0x55);

      expect(readTitle(big, scratch)).toBe('big-file');
      expect(readTitle(small, scratch)).toBe('x');
    });

    it('re-reads the latest tail once when the file grows during a tail miss', () => {
      const p = files(
        'grows-during-tail-miss.jsonl',
        `${rec('old')}\n${'x'.repeat(LITE_READ_BUF_SIZE + 16 * 1024)}\n`,
      );
      appendOnFirstRead(p, `${rec('new')}\n`);
      expect(readTitle(p)).toBe('new');
    });
  });

  describe('extractLastJsonStringFields', () => {
    const fields = (text: string) =>
      extractLastJsonStringFields(
        text,
        'customTitle',
        ['titleSource'],
        'custom_title',
      );

    it('returns undefined for every key when primary is absent', () => {
      expect(fields('{"type":"user","message":"hi"}')).toEqual(pair());
    });

    it('extracts secondary field from the same line as the primary', () => {
      expect(fields(`${rec('A', 'auto')}\n`)).toEqual(pair('A', 'auto'));
    });

    it('extracts fields with same-line whitespace around colons', () => {
      const text =
        '{"subtype":"custom_title","customTitle" : "A","titleSource"\t:\t"auto"}\n';
      expect(fields(text)).toEqual(pair('A', 'auto'));
    });

    it('when primary appears on multiple lines, picks the latest and its own secondary', () => {
      const text = `${rec('A', 'manual')}\n${rec('B', 'auto')}\n`;
      expect(fields(text)).toEqual(pair('B', 'auto'));
    });

    it('returns secondary=undefined when the winning line lacks it (legacy record)', () => {
      expect(fields(`${rec('legacy')}\n`)).toEqual(pair('legacy'));
    });

    it('never lets titleSource from an OLDER line leak into a NEWER primary match', () => {
      // Older record has both fields; newer record (wins) has only customTitle.
      // Two separate scans would leak titleSource from the older line — the
      // single-pass contract forbids this.
      const text = `${rec('old', 'auto')}\n${rec('new')}\n`;
      expect(fields(text)).toEqual(pair('new'));
    });

    it('respects lineContains — matches on non-tagged lines are ignored', () => {
      // A user message contains a customTitle substring, but the line lacks
      // "custom_title" so it's filtered out.
      const text = `{"type":"user","message":"I want customTitle: \\"fake\\""}\n${rec('real', 'manual')}\n`;
      expect(fields(text)).toEqual(pair('real', 'manual'));
    });

    it('rejects a crash-truncated trailing record with no closing quote', () => {
      // A naive implementation would pick the truncated partial write as
      // "latest" and return titleSource=undefined (its source never got
      // written). We require both fields from the last VALID record.
      const text = `${rec('A', 'auto')}\n{"subtype":"custom_title","customTitle":"B`;
      expect(fields(text)).toEqual(pair('A', 'auto'));
    });

    it('rejects a truncated record with a dangling escape before newline', () => {
      const text =
        `${rec('A', 'auto')}\n` +
        '{"subtype":"custom_title","customTitle":"B\\\n{"type":"assistant","titleSource":"manual"}';
      expect(fields(text)).toEqual(pair('A', 'auto'));
    });

    it('handles escaped quotes inside the primary value', () => {
      expect(fields(`${rec('He said \\"hi\\"', 'manual')}\n`)).toEqual(
        pair('He said "hi"', 'manual'),
      );
    });
  });

  describe('readLastJsonStringFieldsSync', () => {
    const files = useTmpFiles('sst-readfields-');
    const readPair = (p: string, ...scratch: [Buffer?]) =>
      readLastJsonStringFieldsSync(
        p,
        'customTitle',
        ['titleSource'],
        'custom_title',
        ...scratch,
      );
    // A title pair at the start, pushed out of the tail by a big user record.
    const headOnly = (title: string, ch: string) =>
      `${rec(title, 'auto')}\n${userMsg(LITE_READ_BUF_SIZE, ch)}\n`;

    it('returns all-undefined for a missing file', () => {
      expect(readPair(files('nope.jsonl'))).toEqual(pair());
    });

    it('returns the atomic pair when tail contains the match', () => {
      const p = files('tail.jsonl', `${rec('A', 'auto')}\n`);
      expect(readPair(p)).toEqual(pair('A', 'auto'));
    });

    it('falls through to head window when tail has no match and finds the pair', () => {
      // The head window catches the pair atomically — both fields come from
      // the same line, the whole point of the multi-field variant.
      const p = files('head-fallback.jsonl', headOnly('X', 'x'));
      expect(readPair(p)).toEqual(pair('X', 'auto'));
    });

    it('returns all-undefined when the pair is buried beyond both head and tail windows', () => {
      // Anti-test mirroring the single-field variant: only the head and tail
      // windows are scanned, so a record stranded in the middle of a >2x
      // window file is not found and every field keeps the empty shape.
      const p = files('buried-pair.jsonl', buried(rec('buried', 'auto')));
      expect(readPair(p)).toEqual(pair());
    });

    it('does not let a truncated trailing partial record win', () => {
      const p = files(
        'truncated.jsonl',
        `${rec('A', 'auto')}\n{"subtype":"custom_title","customTitle":"B`,
      );
      expect(readPair(p)).toEqual(pair('A', 'auto'));
    });

    it('reuses a caller-provided scratch buffer across tail and head reads', () => {
      // Mirror of the single-field pool test: one buffer runs tail-then-head,
      // so a decode ignoring `bytesRead` would see sentinel bytes left from
      // the previous (larger) read and corrupt a field. Drive a tail hit, then
      // a head fallback on a smaller file, sharing the buffer.
      const tailHit = files('tail-pair.jsonl', `${rec('big', 'manual')}\n`);
      const headFallback = files('head-pair.jsonl', headOnly('x', 'y'));
      const scratch = Buffer.alloc(LITE_READ_BUF_SIZE);
      scratch.fill(0x55);

      expect(readPair(tailHit, scratch)).toEqual(pair('big', 'manual'));
      expect(readPair(headFallback, scratch)).toEqual(pair('x', 'auto'));
    });

    it('re-reads the latest tail once when the file grows during a tail miss', () => {
      const p = files(
        'grows-during-tail-miss-pair.jsonl',
        `${rec('old', 'manual')}\n${'x'.repeat(LITE_READ_BUF_SIZE + 16 * 1024)}\n`,
      );
      appendOnFirstRead(p, `${rec('new', 'auto')}\n`);
      expect(readPair(p)).toEqual(pair('new', 'auto'));
    });
  });
});

describe('sessionStorageUtils when O_NOFOLLOW is unavailable (Windows flag set)', () => {
  // Windows has no O_NOFOLLOW; the constant is `undefined` there and flag
  // expressions like `(O_RDONLY | (O_NOFOLLOW ?? 0))` silently collapse to a
  // plain open that follows symlinks (#8227). Stub the constant away to run
  // that exact path on Linux CI and pin the compensating refusal.
  const itNoSymlink = process.platform === 'win32' ? it.skip : it;

  // Imports sessionStorageUtils afresh with the stub, then runs `check` on a
  // session.jsonl symlinked to a secret.jsonl holding `secret`.
  async function withSymlinkedSession(
    prefix: string,
    secret: string,
    check: (
      mod: typeof import('./sessionStorageUtils.js'),
      sessionPath: string,
    ) => void,
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      // sessionStorageUtils uses a DEFAULT import of node:fs, so the
      // `default` property must carry the stubbed constants too.
      const modified = {
        ...actual,
        constants: { ...actual.constants, O_NOFOLLOW: undefined },
      };
      return { ...modified, default: modified };
    });

    try {
      const secretPath = path.join(dir, 'secret.jsonl');
      const sessionPath = path.join(dir, 'session.jsonl');
      fs.writeFileSync(secretPath, secret);
      fs.symlinkSync(secretPath, sessionPath);
      check(await import('./sessionStorageUtils.js'), sessionPath);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  itNoSymlink(
    'does not read session metadata through a symlinked session file',
    () =>
      withSymlinkedSession(
        'session-storage-nofollow-',
        `${rec('leaked-secret')}\n`,
        (mod, sessionPath) =>
          expect(
            mod.readLastJsonStringFieldSync(
              sessionPath,
              'customTitle',
              'custom_title',
            ),
          ).toBeUndefined(),
      ),
  );

  itNoSymlink(
    'does not read session metadata through a symlinked session file (multi-field)',
    // Mirror for the plural variant, rerouted through the same helper in the
    // same pass: a symlink planted over the session file must not leak
    // customTitle / titleSource through readLastJsonStringFieldsSync either.
    () =>
      withSymlinkedSession(
        'session-storage-nofollow-fields-',
        `${rec('leaked-secret', 'auto')}\n`,
        (mod, sessionPath) =>
          expect(
            mod.readLastJsonStringFieldsSync(
              sessionPath,
              'customTitle',
              ['titleSource'],
              'custom_title',
            ),
          ).toEqual(pair()),
      ),
  );
});
