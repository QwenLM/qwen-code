import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFinalScreen } from '../lib/normalize.mjs';

const ESC = '\x1b';
const screen = { rows: 4, columns: 12 };

test('renders plain text', () => {
  assert.equal(renderFinalScreen('hello', screen), 'hello');
});

test('handles CR/LF line structure', () => {
  assert.equal(renderFinalScreen('abc\r\ndef', screen), 'abc\ndef');
});

test('applies cursor addressing', () => {
  assert.equal(renderFinalScreen(`abc${ESC}[2;1HXY`, screen), 'abc\nXY');
});

test('clears the screen with ESC[2J', () => {
  assert.equal(
    renderFinalScreen(`frame-1${ESC}[2J${ESC}[Hframe-2`, screen),
    'frame-2',
  );
});

test('line erase removes trailing cells', () => {
  assert.equal(renderFinalScreen(`abcdefgh${ESC}[1;3H${ESC}[K`, screen), 'ab');
});

test('scrolls when linefeeding at the bottom row', () => {
  assert.equal(
    renderFinalScreen('a\r\nb\r\nc\r\nd\r\ne', screen),
    'b\nc\nd\ne',
  );
});

test('alternate screen restores the main buffer', () => {
  const raw = `main${ESC}[?1049halt-screen${ESC}[?1049l`;
  assert.equal(renderFinalScreen(raw, screen), 'main');
});

test('strips trailing blanks and blank lines', () => {
  assert.equal(
    renderFinalScreen(`abc${ESC}[2;5H   ${ESC}[3;1H   `, screen),
    'abc',
  );
});

test('linefeed keeps the column, CR resets it', () => {
  assert.equal(renderFinalScreen('x\ny\rz', screen), 'x\nzy');
});

test('inserts and deletes lines', () => {
  assert.equal(
    renderFinalScreen(`a\r\nb\r\nc${ESC}[1;1H${ESC}[M`, screen),
    'b\nc',
  );
  assert.equal(
    renderFinalScreen(`a\r\nb\r\nc${ESC}[1;1H${ESC}[LX`, screen),
    'X\na\nb\nc',
  );
});

test('SGR colon sub-parameters are consumed, not printed', () => {
  const raw = `${ESC}[38:2::255:0:0mred${ESC}[0m`;
  assert.equal(renderFinalScreen(raw, screen), 'red');
});

test('charset designation consumes the final byte', () => {
  assert.equal(renderFinalScreen(`${ESC}(Bok`, screen), 'ok');
});

test('string sequence payloads stay out of the grid', () => {
  for (const finalByte of ['P', 'X', '^', '_']) {
    const raw = `${ESC}${finalByte}payload${ESC}\\ok`;
    assert.equal(renderFinalScreen(raw, screen), 'ok', `ESC ${finalByte}`);
  }
});
