import { describe, expect, it } from 'vitest';
import { hasAnsi, parseAnsi } from './ansi';

const ESC = '\x1b[';

describe('parseAnsi', () => {
  it('applies basic and bright colors, bold and dim', () => {
    expect(parseAnsi(`${ESC}32mok`)).toEqual([
      { text: 'ok', color: '#48bb78', bold: false, dim: false },
    ]);
    expect(parseAnsi(`${ESC}1;91mhot`)).toEqual([
      { text: 'hot', color: '#feb2b2', bold: true, dim: false },
    ]);
    expect(parseAnsi(`${ESC}2mfaint`)).toEqual([
      { text: 'faint', color: undefined, bold: false, dim: true },
    ]);
  });

  it('resets state on 0, 22 and 39', () => {
    expect(parseAnsi(`${ESC}1;31ma${ESC}0mb`)).toEqual([
      { text: 'a', color: '#fc8181', bold: true, dim: false },
      { text: 'b', color: undefined, bold: false, dim: false },
    ]);
    expect(parseAnsi(`${ESC}1;2;31ma${ESC}22mb`)).toEqual([
      { text: 'a', color: '#fc8181', bold: true, dim: true },
      { text: 'b', color: '#fc8181', bold: false, dim: false },
    ]);
    expect(parseAnsi(`${ESC}31ma${ESC}39mb`)[1]!.color).toBeUndefined();
  });

  // The arguments of 38/48/58 are not SGR codes. Reading them as codes is what
  // made `38;5;2` set dim (from the color index) instead of a color.
  it('does not read 256-color arguments as SGR codes', () => {
    expect(parseAnsi(`${ESC}38;5;2mgreen`)).toEqual([
      { text: 'green', color: '#48bb78', bold: false, dim: false },
    ]);
    expect(parseAnsi(`${ESC}38;5;1mred`)[0]!.color).toBe('#fc8181');
    // Bright half of the standard range maps onto the 90-97 palette.
    expect(parseAnsi(`${ESC}38;5;9mbright`)[0]!.color).toBe('#feb2b2');
    // 6x6x6 cube: 208 -> (5, 2, 0) -> #ff8700.
    expect(parseAnsi(`${ESC}38;5;208morange`)[0]!.color).toBe('#ff8700');
    // Cube corners.
    expect(parseAnsi(`${ESC}38;5;16ma`)[0]!.color).toBe('#000000');
    expect(parseAnsi(`${ESC}38;5;231ma`)[0]!.color).toBe('#ffffff');
    // Grayscale ramp: 232 -> 8, 255 -> 238.
    expect(parseAnsi(`${ESC}38;5;232ma`)[0]!.color).toBe('#080808');
    expect(parseAnsi(`${ESC}38;5;255ma`)[0]!.color).toBe('#eeeeee');
  });

  it('does not let truecolor channels reset the style', () => {
    expect(parseAnsi(`${ESC}38;2;255;0;0mred`)).toEqual([
      { text: 'red', color: '#ff0000', bold: false, dim: false },
    ]);
    // A zero channel used to hit the `code === 0` reset, clearing the bold
    // that was already set; two more channels are 128 and 255, neither of
    // which is an SGR code at all.
    expect(parseAnsi(`${ESC}1m${ESC}38;2;0;128;255mblue`)).toEqual([
      { text: 'blue', color: '#0080ff', bold: true, dim: false },
    ]);
  });

  it('keeps background and underline color out of the code stream', () => {
    // 48;5;22 used to feed `22` to the reset-intensity branch, so setting a
    // background silently un-bolded the text.
    expect(parseAnsi(`${ESC}1m${ESC}48;5;22mtext`)).toEqual([
      { text: 'text', color: undefined, bold: true, dim: false },
    ]);
    // Foreground survives a background change on the same sequence, and the
    // trailing 1 is still read as bold once the 48 arguments are consumed.
    expect(parseAnsi(`${ESC}31;48;2;0;0;0;1mtext`)).toEqual([
      { text: 'text', color: '#fc8181', bold: true, dim: false },
    ]);
    expect(parseAnsi(`${ESC}1m${ESC}58;5;2mtext`)[0]!.bold).toBe(true);
  });

  it('drops malformed extended-color sequences without corrupting state', () => {
    // Out-of-range index and truncated argument lists yield no color rather
    // than a bogus one, and never fall through to the plain-code branches.
    for (const seq of ['38;5;300', '38;5', '38;2;1;2', '38;7;1', '38']) {
      expect(parseAnsi(`${ESC}1m${ESC}${seq}mtext`)).toEqual([
        { text: 'text', color: undefined, bold: true, dim: false },
      ]);
    }
  });

  it('splits text around sequences and keeps the trailing run', () => {
    expect(parseAnsi(`plain${ESC}1mbold${ESC}0mtail`)).toEqual([
      { text: 'plain', color: undefined, bold: false, dim: false },
      { text: 'bold', color: undefined, bold: true, dim: false },
      { text: 'tail', color: undefined, bold: false, dim: false },
    ]);
    expect(parseAnsi('no escapes')).toEqual([
      { text: 'no escapes', color: undefined, bold: false, dim: false },
    ]);
    // `ESC[m` is shorthand for `ESC[0m`.
    expect(parseAnsi(`${ESC}1ma${ESC}mb`)[1]!.bold).toBe(false);
  });
});

describe('hasAnsi', () => {
  it('detects a CSI introducer', () => {
    expect(hasAnsi(`${ESC}0mx`)).toBe(true);
    expect(hasAnsi('plain text')).toBe(false);
  });
});
