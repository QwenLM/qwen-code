/**
 * StyledLine — span-based representation of a single line of styled terminal text.
 *
 * Ported from @jrichman/ink@6.6.7 build/styled-line.js to standalone TypeScript.
 * Origin licence: MIT (Copyright (c) Vadym Demedes <vadimdemedes@hey.com>)
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 *
 * Internal representation
 * ───────────────────────
 * • `text`     – concatenated UTF-16 chars for all visible graphemes
 * • `charData` – Uint16Array; each entry encodes the byte-offset of the
 *                corresponding grapheme cluster inside `text` in the low 15
 *                bits (MAX_SAFE_OFFSET = 0x7FFF) and a full-width flag in
 *                bit 15 (0x8000).
 * • `spans`    – run-length encoded style metadata (formatFlags, fgColor,
 *                bgColor, link) shared across consecutive equal-styled chars.
 */

import { FULL_WIDTH_MASK, INVERSE_MASK } from './ansi-constants.js';

const MAX_SAFE_OFFSET = 0x7f_ff;

// ── Public types ─────────────────────────────────────────────────────────────

export interface Span {
  length: number;
  formatFlags: number;
  fgColor?: string;
  bgColor?: string;
  link?: string;
}

export interface StyledChar {
  value: string;
  formatFlags: number;
  fgColor?: string;
  bgColor?: string;
  link?: string;
  fullWidth: boolean;
  hasStyles: boolean;
}

// ── StyledLine class ─────────────────────────────────────────────────────────

export class StyledLine {
  // ── Static cache for empty lines ──────────────────────────────────────────
  private static readonly emptyCache = new Map<number, StyledLine>();

  /** Return a mutable clone of an empty line padded to `length` spaces. */
  static empty(length: number): StyledLine {
    const safeLength = Math.min(length, MAX_SAFE_OFFSET);
    if (safeLength <= 0) return new StyledLine();

    const cached = StyledLine.emptyCache.get(safeLength);
    if (cached) return cached.clone();

    const line = new StyledLine();
    line.length = safeLength;
    line.text = ' '.repeat(safeLength);
    line.charData = new Uint16Array(Math.max(safeLength, 16));
    for (let i = 0; i < safeLength; i++) line.charData[i] = i;
    line.spans = [{ length: safeLength, formatFlags: 0 }];

    if (StyledLine.emptyCache.size > 100) StyledLine.emptyCache.clear();
    Object.freeze(line.spans[0]);
    Object.freeze(line.spans);
    Object.freeze(line);
    StyledLine.emptyCache.set(safeLength, line);
    return line.clone();
  }

  /**
   * Legacy factory used by the old ink API — accepts parallel arrays of
   * grapheme strings and span descriptors.
   */
  static legacyCreateStyledLine(
    values: string[] = [],
    spans: Span[] = [],
  ): StyledLine {
    const line = new StyledLine();
    line.applyValuesAndSpans(values, spans);
    return line;
  }

  // ── Instance fields ────────────────────────────────────────────────────────
  length: number;
  text!: string;
  charData!: Uint16Array;
  spans!: Span[];

  constructor() {
    this.length = 0;
  }

  // ── Per-index accessors ────────────────────────────────────────────────────

  getValue(index: number): string {
    if (this.text === undefined || index < 0 || index >= this.length) return '';
    const start = this.charData[index]! & 0x7f_ff;
    const end =
      index + 1 < this.length
        ? this.charData[index + 1]! & 0x7f_ff
        : this.text.length;
    return this.text.slice(start, end);
  }

  getSpan(index: number): Span | undefined {
    if (this.spans === undefined || index < 0 || index >= this.length)
      return undefined;
    let current = 0;
    for (const span of this.spans) {
      if (index < current + span.length) return span;
      current += span.length;
    }
    return undefined;
  }

  getFullWidth(index: number): boolean {
    if (this.charData === undefined || index < 0 || index >= this.length)
      return false;
    return (this.charData[index]! & 0x80_00) !== 0;
  }

  hasStyles(index: number): boolean {
    const span = this.getSpan(index);
    if (!span) return false;
    return (
      (span.formatFlags & ~FULL_WIDTH_MASK) !== 0 ||
      span.fgColor !== undefined ||
      span.bgColor !== undefined ||
      span.link !== undefined
    );
  }

  getFormatFlags(index: number): number {
    let flags = this.getSpan(index)?.formatFlags ?? 0;
    if (this.getFullWidth(index)) flags |= FULL_WIDTH_MASK;
    return flags;
  }

  getFgColor(index: number): string | undefined {
    return this.getSpan(index)?.fgColor;
  }

  getBgColor(index: number): string | undefined {
    return this.getSpan(index)?.bgColor;
  }

  getLink(index: number): string | undefined {
    return this.getSpan(index)?.link;
  }

  // ── Mutation helpers ───────────────────────────────────────────────────────

  setInverted(index: number, inverted: boolean): void {
    if (index < 0 || index >= this.length) return;
    this.ensureInitialized();
    this.splitSpansAt(index);
    this.splitSpansAt(index + 1);
    let current = 0;
    for (const span of this.spans) {
      if (current === index && span.length === 1) {
        if (inverted) span.formatFlags |= INVERSE_MASK;
        else span.formatFlags &= ~INVERSE_MASK;
        break;
      }
      current += span.length;
    }
    this.mergeSpans();
  }

  setBackgroundColor(index: number, color: string | undefined): void {
    if (index < 0 || index >= this.length) return;
    this.ensureInitialized();
    this.splitSpansAt(index);
    this.splitSpansAt(index + 1);
    let current = 0;
    for (const span of this.spans) {
      if (current === index && span.length === 1) {
        span.bgColor = color;
        break;
      }
      current += span.length;
    }
    this.mergeSpans();
  }

  setForegroundColor(index: number, color: string | undefined): void {
    if (index < 0 || index >= this.length) return;
    this.ensureInitialized();
    this.splitSpansAt(index);
    this.splitSpansAt(index + 1);
    let current = 0;
    for (const span of this.spans) {
      if (current === index && span.length === 1) {
        span.fgColor = color;
        break;
      }
      current += span.length;
    }
    this.mergeSpans();
  }

  // eslint-disable-next-line max-params
  setChar(
    index: number,
    value: string,
    formatFlags: number,
    fgColor: string | undefined,
    bgColor: string | undefined,
    link: string | undefined,
  ): void {
    if (index < 0 || index >= this.length) return;
    this.ensureInitialized();
    const isFullWidth = (formatFlags & FULL_WIDTH_MASK) !== 0;
    const cleanFormatFlags = formatFlags & ~FULL_WIDTH_MASK;
    const start = this.charData[index]! & 0x7f_ff;
    const end =
      index + 1 < this.length
        ? this.charData[index + 1]! & 0x7f_ff
        : this.text.length;
    const oldLen = end - start;
    let newValue = value;
    if (this.text.length - oldLen + value.length > MAX_SAFE_OFFSET) {
      newValue = value.slice(
        0,
        Math.max(0, MAX_SAFE_OFFSET - (this.text.length - oldLen)),
      );
    }
    const newLen = newValue.length;
    this.text = this.text.slice(0, start) + newValue + this.text.slice(end);
    if (oldLen !== newLen) {
      const diff = newLen - oldLen;
      for (let i = index + 1; i < this.length; i++) {
        const data = this.charData[i]!;
        const oldOffset = data & 0x7f_ff;
        const fw = data & 0x80_00;
        this.charData[i] = (oldOffset + diff) | fw;
      }
    }
    this.charData[index] = start | (isFullWidth ? 0x80_00 : 0);
    this.splitSpansAt(index);
    this.splitSpansAt(index + 1);
    let current = 0;
    for (let i = 0; i < this.spans.length; i++) {
      const span = this.spans[i]!;
      if (current === index && span.length === 1) {
        this.spans[i] = {
          length: 1,
          formatFlags: cleanFormatFlags,
          fgColor,
          bgColor,
          link,
        };
        break;
      }
      current += span.length;
    }
    this.mergeSpans();
  }

  // eslint-disable-next-line max-params
  pushChar(
    value: string,
    formatFlags: number,
    fgColor?: string,
    bgColor?: string,
    link?: string,
  ): void {
    this.ensureInitialized();
    const isFullWidth = (formatFlags & FULL_WIDTH_MASK) !== 0;
    const cleanFormatFlags = formatFlags & ~FULL_WIDTH_MASK;
    const offset = this.text.length;
    if (value !== '…' && offset + value.length > MAX_SAFE_OFFSET - 1) {
      if (offset < MAX_SAFE_OFFSET && !this.text.endsWith('…')) {
        this.pushChar('…', formatFlags, fgColor, bgColor, link);
      }
      return;
    }
    if (offset + value.length > MAX_SAFE_OFFSET) return;
    this.text += value;
    if (this.length >= this.charData.length) {
      const newData = new Uint16Array(this.charData.length * 2 || 16);
      newData.set(this.charData);
      this.charData = newData;
    }
    this.charData[this.length] = offset | (isFullWidth ? 0x80_00 : 0);
    const lastSpan = this.spans.at(-1);
    if (
      lastSpan &&
      lastSpan.formatFlags === cleanFormatFlags &&
      lastSpan.fgColor === fgColor &&
      lastSpan.bgColor === bgColor &&
      lastSpan.link === link
    ) {
      lastSpan.length++;
    } else {
      this.spans.push({
        length: 1,
        formatFlags: cleanFormatFlags,
        fgColor,
        bgColor,
        link,
      });
    }
    this.length++;
  }

  // ── Structural operations ──────────────────────────────────────────────────

  clone(): StyledLine {
    if (this.charData === undefined) return new StyledLine();
    const result = new StyledLine();
    result.length = this.length;
    result.text = this.text;
    result.charData = this.charData.slice(0, Math.max(this.length, 16));
    result.spans = this.spans.map((s) => ({ ...s }));
    return result;
  }

  slice(start: number, end?: number): StyledLine {
    if (this.charData === undefined) return new StyledLine();
    const actualStart = Math.max(0, start);
    const actualEnd =
      end === undefined ? this.length : Math.min(this.length, end);
    if (actualStart >= actualEnd) return new StyledLine();
    if (actualStart === 0 && actualEnd === this.length) return this.clone();

    const result = new StyledLine();
    result.length = actualEnd - actualStart;
    result.charData = new Uint16Array(Math.max(result.length, 16));

    const textStart = this.charData[actualStart]! & 0x7f_ff;
    const textEnd =
      actualEnd < this.length
        ? this.charData[actualEnd]! & 0x7f_ff
        : this.text.length;
    result.text = this.text.slice(textStart, textEnd);

    for (let i = 0; i < result.length; i++) {
      const oldData = this.charData[actualStart + i]!;
      const oldOffset = oldData & 0x7f_ff;
      const fw = oldData & 0x80_00;
      result.charData[i] = (oldOffset - textStart) | fw;
    }

    const newSpans: Span[] = [];
    let current = 0;
    for (const span of this.spans) {
      const spanStart = current;
      const spanEnd = current + span.length;
      const intersectStart = Math.max(actualStart, spanStart);
      const intersectEnd = Math.min(actualEnd, spanEnd);
      if (intersectStart < intersectEnd) {
        newSpans.push({ ...span, length: intersectEnd - intersectStart });
      }
      current += span.length;
      if (current >= actualEnd) break;
    }
    result.spans = newSpans;
    result.mergeSpans();
    return result;
  }

  combine(...others: StyledLine[]): StyledLine {
    if (others.length === 0) return this.clone();
    const allLines = [this, ...others].filter((l) => l.length > 0);
    if (allLines.length === 0) return new StyledLine();
    if (allLines.length === 1) return allLines[0]!.clone();

    let totalTextLen = 0;
    let totalChars = 0;
    for (const line of allLines) {
      totalTextLen += line.getText().length;
      totalChars += line.length;
    }

    if (totalTextLen > MAX_SAFE_OFFSET) {
      let result = this.clone();
      for (const other of others) result = result.instanceConcat(other);
      return result;
    }

    const result = new StyledLine();
    result.length = totalChars;
    result.text = allLines.map((l) => l.getText()).join('');
    result.charData = new Uint16Array(Math.max(totalChars, 16));

    let currentChar = 0;
    let currentOffset = 0;
    for (const line of allLines) {
      const lineCharData = line.charData;
      const lineText = line.getText();
      if (lineCharData) {
        for (let i = 0; i < line.length; i++) {
          const data = lineCharData[i]!;
          const offset = data & 0x7f_ff;
          const fw = data & 0x80_00;
          result.charData[currentChar + i] = (currentOffset + offset) | fw;
        }
      } else {
        for (let i = 0; i < line.length; i++) {
          result.charData[currentChar + i] = currentOffset + i;
        }
      }
      currentChar += line.length;
      currentOffset += lineText.length;
    }

    result.spans = allLines.flatMap((l) => l.getSpans().map((s) => ({ ...s })));
    result.mergeSpans();
    return result;
  }

  getTrimmedLength(): number {
    if (this.length === 0) return 0;
    if (this.text === undefined || this.charData === undefined) return 0;
    let currentIdx = this.length - 1;
    if (this.spans) {
      for (let s = this.spans.length - 1; s >= 0; s--) {
        const span = this.spans[s]!;
        const hasStyles =
          (span.formatFlags & ~FULL_WIDTH_MASK) !== 0 ||
          span.fgColor !== undefined ||
          span.bgColor !== undefined ||
          span.link !== undefined;
        if (hasStyles) return currentIdx + 1;
        for (let i = 0; i < span.length; i++) {
          const start = this.charData[currentIdx]! & 0x7f_ff;
          const end =
            currentIdx + 1 < this.length
              ? this.charData[currentIdx + 1]! & 0x7f_ff
              : this.text.length;
          if (end - start !== 1 || this.text[start] !== ' ')
            return currentIdx + 1;
          currentIdx--;
        }
      }
    }
    return 0;
  }

  trimEnd(): StyledLine {
    const trimmedLength = this.getTrimmedLength();
    if (trimmedLength === this.length) return this;
    if (trimmedLength === 0) return new StyledLine();
    return this.slice(0, trimmedLength);
  }

  equals(other: StyledLine): boolean {
    if (this.length !== other.length) return false;
    if (this.length === 0) return true;
    if (this.getText() !== other.getText()) return false;
    const s1 = this.getSpans();
    const s2 = other.getSpans();
    if (s1.length !== s2.length) return false;
    for (let i = 0; i < s1.length; i++) {
      const sp1 = s1[i]!;
      const sp2 = s2[i]!;
      if (
        sp1.length !== sp2.length ||
        sp1.formatFlags !== sp2.formatFlags ||
        sp1.fgColor !== sp2.fgColor ||
        sp1.bgColor !== sp2.bgColor ||
        sp1.link !== sp2.link
      )
        return false;
    }
    const thisCharData = this.charData;
    const otherCharData = other.charData;
    if (thisCharData && otherCharData) {
      for (let i = 0; i < this.length; i++) {
        if (thisCharData[i] !== otherCharData[i]) return false;
      }
    }
    return true;
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  getText(): string {
    return this.text ?? '';
  }

  getSpans(): Span[] {
    return this.spans ?? [];
  }

  getValues(): string[] {
    return Array.from({ length: this.length }, (_, i) => this.getValue(i));
  }

  *[Symbol.iterator](): Generator<StyledChar> {
    if (this.length === 0) return;
    let currentSpanIdx = 0;
    let currentSpanPos = 0;
    const spans = this.getSpans();
    for (let i = 0; i < this.length; i++) {
      const span = spans[currentSpanIdx];
      const formatFlags = span ? span.formatFlags : 0;
      const isFullWidth = this.getFullWidth(i);
      yield {
        value: this.getValue(i),
        formatFlags: formatFlags | (isFullWidth ? FULL_WIDTH_MASK : 0),
        fgColor: span?.fgColor,
        bgColor: span?.bgColor,
        link: span?.link,
        fullWidth: isFullWidth,
        hasStyles:
          (formatFlags & ~FULL_WIDTH_MASK) !== 0 ||
          span?.fgColor !== undefined ||
          span?.bgColor !== undefined ||
          span?.link !== undefined,
      };
      if (span) {
        currentSpanPos++;
        if (currentSpanPos >= span.length) {
          currentSpanIdx++;
          currentSpanPos = 0;
        }
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  ensureInitialized(initialCapacity = 16): void {
    if (this.charData === undefined) {
      this.text = '';
      this.charData = new Uint16Array(Math.max(this.length, initialCapacity));
      this.spans =
        this.length > 0 ? [{ length: this.length, formatFlags: 0 }] : [];
      if (this.length > 0 && this.text.length === 0) {
        this.text = ' '.repeat(this.length);
        for (let i = 0; i < this.length; i++) this.charData[i] = i;
      }
    }
  }

  applyValuesAndSpans(values: string[], spans: Span[]): void {
    let totalTextLen = 0;
    let visibleChars = 0;
    for (const val of values) {
      if (totalTextLen + val.length > MAX_SAFE_OFFSET - 1) break;
      totalTextLen += val.length;
      visibleChars++;
    }
    const truncated = visibleChars < values.length;
    this.length = visibleChars + (truncated ? 1 : 0);
    this.text = values.slice(0, visibleChars).join('') + (truncated ? '…' : '');
    this.charData = new Uint16Array(Math.max(this.length, 16));

    let currentOffset = 0;
    let spanIdx = 0;
    let spanPos = 0;
    for (let i = 0; i < visibleChars; i++) {
      const val = values[i]!;
      let isFullWidth = false;
      if (spans.length > 0 && spanIdx < spans.length) {
        const span = spans[spanIdx]!;
        if ((span.formatFlags & FULL_WIDTH_MASK) !== 0) isFullWidth = true;
        spanPos++;
        if (spanPos >= span.length) {
          spanIdx++;
          spanPos = 0;
        }
      }
      this.charData[i] = currentOffset | (isFullWidth ? 0x80_00 : 0);
      currentOffset += val.length;
    }
    if (truncated) this.charData[visibleChars] = currentOffset;

    if (truncated) {
      const newSpans: Span[] = [];
      let remaining = visibleChars;
      let sIdx = 0;
      while (remaining > 0 && sIdx < spans.length) {
        const span = spans[sIdx]!;
        const take = Math.min(remaining, span.length);
        newSpans.push({ ...span, length: take });
        remaining -= take;
        sIdx++;
      }
      newSpans.push({ length: 1, formatFlags: 0 });
      this.spans = newSpans;
    } else {
      this.spans = spans.map((s) => ({
        ...s,
        formatFlags: s.formatFlags & ~FULL_WIDTH_MASK,
      }));
    }
    this.mergeSpans();
  }

  private instanceConcat(other: StyledLine): StyledLine {
    const spaceForOther = MAX_SAFE_OFFSET - 1 - this.getText().length;
    if (spaceForOther <= 0) {
      if (
        this.getText().length < MAX_SAFE_OFFSET &&
        !this.getText().endsWith('…')
      ) {
        const result = this.clone();
        result.pushChar('…', 0);
        return result;
      }
      return this.clone();
    }
    let otherTextLenToTake = 0;
    let otherCharsToTake = 0;
    for (let i = 0; i < other.length; i++) {
      const val = other.getValue(i);
      if (otherTextLenToTake + val.length > spaceForOther) break;
      otherTextLenToTake += val.length;
      otherCharsToTake++;
    }
    const truncated = otherCharsToTake < other.length;
    const result = new StyledLine();
    result.length = this.length + otherCharsToTake + (truncated ? 1 : 0);
    result.text =
      this.getText() +
      other.getText().slice(0, otherTextLenToTake) +
      (truncated ? '…' : '');
    result.charData = new Uint16Array(Math.max(result.length, 16));
    if (this.charData)
      result.charData.set(this.charData.subarray(0, this.length), 0);

    const textOffset = this.getText().length;
    const otherCharData = other.charData;
    if (otherCharData) {
      for (let i = 0; i < otherCharsToTake; i++) {
        const oldData = otherCharData[i]!;
        const oldOffset = oldData & 0x7f_ff;
        const fw = oldData & 0x80_00;
        result.charData[this.length + i] = (oldOffset + textOffset) | fw;
      }
    }
    if (truncated) {
      result.charData[this.length + otherCharsToTake] =
        this.getText().length + otherTextLenToTake;
    }

    const otherSpans: Span[] = [];
    let remaining = otherCharsToTake;
    for (const span of other.getSpans()) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, span.length);
      otherSpans.push({ ...span, length: take });
      remaining -= take;
    }
    result.spans = [...this.getSpans(), ...otherSpans];
    if (truncated) result.spans.push({ length: 1, formatFlags: 0 });
    result.mergeSpans();
    return result;
  }

  private splitSpansAt(index: number): void {
    if (this.spans === undefined || index <= 0 || index >= this.length) return;
    let current = 0;
    for (let i = 0; i < this.spans.length; i++) {
      const span = this.spans[i]!;
      if (index > current && index < current + span.length) {
        const leftLen = index - current;
        const rightLen = span.length - leftLen;
        this.spans.splice(
          i,
          1,
          { ...span, length: leftLen },
          { ...span, length: rightLen },
        );
        return;
      }
      current += span.length;
    }
  }

  private mergeSpans(): void {
    if (this.spans === undefined) return;
    const newSpans: Span[] = [];
    for (const span of this.spans) {
      if (span.length === 0) continue;
      const last = newSpans.at(-1);
      if (
        last &&
        last.formatFlags === span.formatFlags &&
        last.fgColor === span.fgColor &&
        last.bgColor === span.bgColor &&
        last.link === span.link
      ) {
        last.length += span.length;
      } else {
        newSpans.push({ ...span });
      }
    }
    this.spans = newSpans;
  }
}
