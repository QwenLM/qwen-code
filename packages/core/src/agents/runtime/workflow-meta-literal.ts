/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Static parser for a workflow script's `export const meta = {...}` block.
 *
 * The meta contract is `{ name, description, whenToUse?, phases?: [{ title, detail?, model? }] }`
 * — every field is a string. Meta is a declaration, not a computation, so this
 * parses the literal instead of executing it.
 *
 * That distinction is the point. The literal is model-authored source; running it
 * means running whatever the model wrote, and the ways that can fail are open-ended:
 * a loop in a field value, a getter that only spins when the value is read, a proxy
 * trap, a promise reaction that never settles, an allocation large enough to exhaust
 * memory. Bounding each of those is a moving target. A parser has no execution
 * semantics at all, so none of them are representable — there is nothing to bound,
 * time out, or isolate.
 *
 * The grammar is JSON's value grammar plus the JS spellings a model actually
 * writes: unquoted keys, single-quoted and substitution-free template strings,
 * trailing commas, and comments. Anything that would mean "evaluate something" —
 * an identifier, a call, a spread, a computed key, an accessor, a method, a
 * template substitution, a regex — is rejected by name, so the diagnostic tells the
 * author which rule they hit.
 */

/** Thrown when the meta block is not a plain literal. */
export class WorkflowMetaSyntaxError extends Error {
  readonly index: number;
  constructor(message: string, index: number) {
    super(message);
    this.name = 'WorkflowMetaSyntaxError';
    this.index = index;
  }
}

export type MetaLiteralValue =
  | string
  | number
  | boolean
  | null
  | MetaLiteralValue[]
  | { [key: string]: MetaLiteralValue };

/**
 * Parse a `{...}` meta literal into a plain host value.
 *
 * Objects are built with a null prototype so a `__proto__` key in the source is an
 * ordinary own property and cannot reach `Object.prototype`. Callers copy the
 * contract fields out into their own object, so the null prototype never escapes.
 *
 * @throws {WorkflowMetaSyntaxError} if the source is not a pure literal.
 */
export function parseWorkflowMetaLiteral(source: string): MetaLiteralValue {
  const parser = new MetaLiteralParser(source);
  parser.skipTrivia();
  const value = parser.parseValue(0);
  parser.skipTrivia();
  if (parser.index < source.length) {
    throw parser.fail('unexpected trailing content');
  }
  return value;
}

// Deep enough for any real contract object (`phases[]` of flat objects is depth 3)
// and shallow enough that the recursive descent cannot overflow the stack.
const MAX_DEPTH = 32;

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v', ' ', '﻿']);
const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

class MetaLiteralParser {
  index = 0;
  constructor(private readonly src: string) {}

  fail(message: string): WorkflowMetaSyntaxError {
    // A window around the offence reads far better than a bare offset.
    const from = Math.max(0, this.index - 24);
    const snippet = this.src
      .slice(from, this.index + 24)
      .replace(/\s+/g, ' ')
      .trim();
    return new WorkflowMetaSyntaxError(
      `${message} at position ${this.index} (near "${snippet}"). ` +
        `meta must be a plain object literal — strings, numbers, booleans, null, ` +
        `arrays and objects only, with no variables, function calls, spreads, ` +
        `accessors or template substitutions.`,
      this.index,
    );
  }

  skipTrivia(): void {
    for (;;) {
      while (
        this.index < this.src.length &&
        WHITESPACE.has(this.src[this.index]!)
      ) {
        this.index++;
      }
      if (this.src.startsWith('//', this.index)) {
        let end = this.index + 2;
        while (
          end < this.src.length &&
          !'\n\r\u2028\u2029'.includes(this.src[end]!)
        ) {
          end++;
        }
        if (this.src[end] === '\r' && this.src[end + 1] === '\n') end++;
        this.index = end < this.src.length ? end + 1 : this.src.length;
        continue;
      }
      if (this.src.startsWith('/*', this.index)) {
        const end = this.src.indexOf('*/', this.index + 2);
        if (end === -1) throw this.fail('unterminated comment');
        this.index = end + 2;
        continue;
      }
      return;
    }
  }

  parseValue(depth: number): MetaLiteralValue {
    if (depth > MAX_DEPTH) throw this.fail('meta literal is nested too deeply');
    this.skipTrivia();
    const c = this.src[this.index];
    if (c === undefined) throw this.fail('unexpected end of meta literal');
    if (c === '{') return this.parseObject(depth);
    if (c === '[') return this.parseArray(depth);
    if (c === '"' || c === "'" || c === '`') return this.parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    if (this.src.startsWith('true', this.index)) return this.word('true', true);
    if (this.src.startsWith('false', this.index)) {
      return this.word('false', false);
    }
    if (this.src.startsWith('null', this.index)) return this.word('null', null);
    if (c === '/')
      throw this.fail('regular expressions are not allowed in meta');
    throw this.fail('unsupported value');
  }

  private word<T extends boolean | null>(literal: string, value: T): T {
    // `truey` / `nullish` are identifiers, not the keyword.
    const after = this.src[this.index + literal.length];
    if (after !== undefined && ID_PART.test(after)) {
      throw this.fail('unsupported value');
    }
    this.index += literal.length;
    return value;
  }

  private parseObject(depth: number): MetaLiteralValue {
    this.index++; // '{'
    const out = Object.create(null) as { [key: string]: MetaLiteralValue };
    for (;;) {
      this.skipTrivia();
      const c = this.src[this.index];
      if (c === '}') {
        this.index++;
        return out;
      }
      if (c === undefined) throw this.fail('unterminated object');
      if (this.src.startsWith('...', this.index)) {
        throw this.fail('spread is not allowed in meta');
      }
      if (c === '[') throw this.fail('computed keys are not allowed in meta');
      const key = this.parseKey();
      this.skipTrivia();
      if (this.src[this.index] === '(') {
        throw this.fail('methods are not allowed in meta');
      }
      if (this.src[this.index] !== ':')
        throw this.fail('expected ":" after key');
      this.index++;
      out[key] = this.parseValue(depth + 1);
      this.skipTrivia();
      if (this.src[this.index] === ',') {
        this.index++;
        continue;
      }
      if (this.src[this.index] === '}') {
        this.index++;
        return out;
      }
      throw this.fail('expected "," or "}"');
    }
  }

  private parseKey(): string {
    const c = this.src[this.index];
    if (c === '"' || c === "'" || c === '`') return this.parseString();
    if (c !== undefined && ID_START.test(c)) {
      const start = this.index;
      while (
        this.index < this.src.length &&
        ID_PART.test(this.src[this.index]!)
      ) {
        this.index++;
      }
      const word = this.src.slice(start, this.index);
      // `get title() {...}` is executable code wearing a property's clothes; so is
      // `async name() {...}`. Only treat the word as a modifier when a property
      // name follows it — `{ get: 'x' }` is a legitimate field called "get".
      if (word === 'get' || word === 'set' || word === 'async') {
        const save = this.index;
        this.skipTrivia();
        const next = this.src[this.index];
        const startsPropertyName =
          next !== undefined &&
          (ID_START.test(next) || next === '"' || next === "'" || next === '[');
        this.index = save;
        if (startsPropertyName) {
          throw this.fail(
            word === 'async'
              ? 'async members are not allowed in meta'
              : `${word}ters are not allowed in meta`,
          );
        }
      }
      return word;
    }
    throw this.fail('expected a property name');
  }

  private parseArray(depth: number): MetaLiteralValue {
    this.index++; // '['
    const out: MetaLiteralValue[] = [];
    for (;;) {
      this.skipTrivia();
      const c = this.src[this.index];
      if (c === ']') {
        this.index++;
        return out;
      }
      if (c === undefined) throw this.fail('unterminated array');
      if (this.src.startsWith('...', this.index)) {
        throw this.fail('spread is not allowed in meta');
      }
      // `[1, , 2]` — an elision is a hole, which has no literal meaning here.
      if (c === ',') throw this.fail('missing array element');
      out.push(this.parseValue(depth + 1));
      this.skipTrivia();
      if (this.src[this.index] === ',') {
        this.index++;
        continue;
      }
      if (this.src[this.index] === ']') {
        this.index++;
        return out;
      }
      throw this.fail('expected "," or "]"');
    }
  }

  private parseString(): string {
    const quote = this.src[this.index++]!;
    let out = '';
    for (;;) {
      const c = this.src[this.index];
      if (c === undefined) throw this.fail('unterminated string');
      if (c === quote) {
        this.index++;
        return out;
      }
      // Only a template literal may span lines.
      if (c === '\n' || c === '\r') {
        if (quote !== '`') throw this.fail('unterminated string');
        if (c === '\r') {
          this.index++;
          if (this.src[this.index] === '\n') this.index++;
          out += '\n';
          continue;
        }
      }
      if (quote === '`' && c === '$' && this.src[this.index + 1] === '{') {
        throw this.fail('template substitutions are not allowed in meta');
      }
      if (c === '\\') {
        out += this.parseEscape();
        continue;
      }
      out += c;
      this.index++;
    }
  }

  private parseEscape(): string {
    this.index++; // '\'
    const c = this.src[this.index++];
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        // `\0` is NUL; `\01` is a legacy octal escape, which is a syntax error in
        // strict mode and would silently mean something else here.
        if (/[0-9]/.test(this.src[this.index] ?? '')) {
          throw this.fail('octal escapes are not allowed in meta');
        }
        return '\0';
      case 'x': {
        const hex = this.src.slice(this.index, this.index + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          throw this.fail('invalid \\x escape');
        }
        this.index += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case 'u': {
        if (this.src[this.index] === '{') {
          const end = this.src.indexOf('}', this.index);
          const hex = end === -1 ? '' : this.src.slice(this.index + 1, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) {
            throw this.fail('invalid \\u{...} escape');
          }
          const code = parseInt(hex, 16);
          if (code > 0x10ffff) throw this.fail('invalid \\u{...} escape');
          this.index = end + 1;
          return String.fromCodePoint(code);
        }
        const hex = this.src.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw this.fail('invalid \\u escape');
        }
        this.index += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case '\n':
        return ''; // line continuation
      case '\r':
        // CRLF line continuation.
        if (this.src[this.index] === '\n') this.index++;
        return '';
      case '\u2028':
      case '\u2029':
        return '';
      case undefined:
        throw this.fail('unterminated escape sequence');
      default:
        // `\\`, `\'`, `\"`, `` \` ``, `\/` and any other identity escape.
        return c;
    }
  }

  private parseNumber(): number {
    const start = this.index;
    if (this.src[this.index] === '-') this.index++;
    while (
      this.index < this.src.length &&
      /[0-9]/.test(this.src[this.index]!)
    ) {
      this.index++;
    }
    if (this.src[this.index] === '.') {
      this.index++;
      while (
        this.index < this.src.length &&
        /[0-9]/.test(this.src[this.index]!)
      ) {
        this.index++;
      }
    }
    if (this.src[this.index] === 'e' || this.src[this.index] === 'E') {
      this.index++;
      if (this.src[this.index] === '+' || this.src[this.index] === '-') {
        this.index++;
      }
      while (
        this.index < this.src.length &&
        /[0-9]/.test(this.src[this.index]!)
      ) {
        this.index++;
      }
    }
    // Rejects `1n`, `0x10`, `1abc` — anything the scan above did not consume.
    const after = this.src[this.index];
    if (after !== undefined && ID_PART.test(after)) {
      throw this.fail('unsupported numeric literal');
    }
    const text = this.src.slice(start, this.index);
    const value = Number(text);
    if (text.length === 0 || !Number.isFinite(value)) {
      throw this.fail('unsupported numeric literal');
    }
    return value;
  }
}
