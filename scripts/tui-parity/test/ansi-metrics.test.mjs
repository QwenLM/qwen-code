import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeAnsi } from '../lib/ansi-metrics.mjs';

const ESC = '\x1b';

test('counts full-screen clear opcodes', () => {
  const m = analyzeAnsi(`${ESC}[2J${ESC}[3J${ESC}[3J${ESC}c${ESC}[J${ESC}[1J`);
  assert.equal(m.fullScreenClears.csi2J, 1);
  assert.equal(m.fullScreenClears.csi3J, 2);
  assert.equal(m.fullScreenClears.ris, 1);
  assert.equal(m.fullScreenClears.total, 4);
  assert.equal(m.partialScreenErases, 2);
});

test('counts line erase modes', () => {
  const m = analyzeAnsi(`${ESC}[K${ESC}[0K${ESC}[1K${ESC}[2K`);
  assert.equal(m.lineErases.toEnd, 2);
  assert.equal(m.lineErases.toStart, 1);
  assert.equal(m.lineErases.whole, 1);
  assert.equal(m.lineErases.total, 4);
});

test('tracks balanced DEC 2026 pairs', () => {
  const m = analyzeAnsi(
    `${ESC}[?2026hframe${ESC}[?2026l${ESC}[?2026hframe${ESC}[?2026l`,
  );
  assert.equal(m.dec2026.begin, 2);
  assert.equal(m.dec2026.end, 2);
  assert.equal(m.dec2026.unbalanced, 0);
});

test('tracks unbalanced DEC 2026 pairs', () => {
  const unclosed = analyzeAnsi(`${ESC}[?2026hframe`);
  assert.equal(unclosed.dec2026.unbalanced, 1);
  const strayEnd = analyzeAnsi(`${ESC}[?2026lframe`);
  assert.equal(strayEnd.dec2026.unbalanced, 1);
  const endThenBegin = analyzeAnsi(`${ESC}[?2026l${ESC}[?2026h`);
  assert.equal(endThenBegin.dec2026.unbalanced, 2);
});

test('counts duplicate event markers', () => {
  const raw =
    `${ESC}]697;live-line;1\x07` +
    `${ESC}]697;live-line;2\x07` +
    `${ESC}]697;live-line;1\x07` +
    `${ESC}]697;live-line;2\x07`;
  const m = analyzeAnsi(raw);
  assert.equal(m.events.total, 4);
  assert.equal(m.events.unique, 2);
  assert.equal(m.events.duplicates, 2);
  assert.equal(m.events.markersPresent, true);
});

test('reports absent event markers', () => {
  const m = analyzeAnsi('hello world');
  assert.equal(m.events.markersPresent, false);
  assert.equal(m.events.duplicates, 0);
});

test('accepts OSC terminated by ESC backslash', () => {
  const m = analyzeAnsi(`${ESC}]697;tok;9${ESC}\\tail`);
  assert.equal(m.events.total, 1);
  assert.equal(m.events.unique, 1);
  assert.equal(m.printableChars, 4);
});

test('accounts control and printable characters', () => {
  const m = analyzeAnsi('ab\r\nc\x07\td\b');
  assert.equal(m.printableChars, 4);
  assert.equal(m.controlChars.cr, 1);
  assert.equal(m.controlChars.lf, 1);
  assert.equal(m.controlChars.bel, 1);
  assert.equal(m.controlChars.tab, 1);
  assert.equal(m.controlChars.bs, 1);
});

test('counts cursor moves and SGR sequences', () => {
  const m = analyzeAnsi(`${ESC}[1;1H${ESC}[12;40H${ESC}[31m${ESC}[0m`);
  assert.equal(m.cursorMoves, 2);
  assert.equal(m.sgrChanges, 2);
});
