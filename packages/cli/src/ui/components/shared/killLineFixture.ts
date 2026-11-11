/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared, engine-agnostic expectations for the readline kill/word-delete
 * shortcuts (ctrl+k / ctrl+u / ctrl+w) on a single-line text field.
 *
 * Both the shared text-buffer (engine B) and the Settings inline value editor
 * (engine C, `useInlineEditBuffer`) must satisfy these cases, so both test
 * suites import this table. It is pure data: each engine's test applies the
 * shortcut through its own mechanism (buffer reducer vs. edit-buffer reducer)
 * and asserts against the shared expected result. `cursor` is a codepoint
 * index, which is unambiguous for a single line.
 */
export interface KillLineExpectation {
  /** Buffer text after the operation. */
  text: string;
  /** Codepoint cursor position after the operation. */
  cursor: number;
}

export interface KillLineCase {
  name: string;
  /** Initial single-line text. */
  text: string;
  /** Initial codepoint cursor position. */
  cursor: number;
  /** Expected result of ctrl+k (delete to end of line). */
  killRight: KillLineExpectation;
  /** Expected result of ctrl+u (delete to start of line). */
  killLeft: KillLineExpectation;
  /** Expected result of ctrl+w (delete word left). */
  wordLeft: KillLineExpectation;
}

export const KILL_LINE_CASES: readonly KillLineCase[] = [
  {
    name: 'mid-string',
    text: 'hello world',
    cursor: 5,
    killRight: { text: 'hello', cursor: 5 },
    killLeft: { text: ' world', cursor: 0 },
    wordLeft: { text: ' world', cursor: 0 },
  },
  {
    name: 'at start',
    text: 'hello',
    cursor: 0,
    killRight: { text: '', cursor: 0 },
    killLeft: { text: 'hello', cursor: 0 }, // no-op
    wordLeft: { text: 'hello', cursor: 0 }, // no-op
  },
  {
    name: 'at end',
    text: 'hello',
    cursor: 5,
    killRight: { text: 'hello', cursor: 5 }, // no-op
    killLeft: { text: '', cursor: 0 },
    wordLeft: { text: '', cursor: 0 },
  },
  {
    name: 'empty',
    text: '',
    cursor: 0,
    killRight: { text: '', cursor: 0 }, // no-op
    killLeft: { text: '', cursor: 0 }, // no-op
    wordLeft: { text: '', cursor: 0 }, // no-op
  },
  {
    name: 'trailing whitespace',
    text: 'foo ',
    cursor: 4,
    killRight: { text: 'foo ', cursor: 4 }, // no-op
    killLeft: { text: '', cursor: 0 },
    // ctrl+w skips the trailing space then deletes the word.
    wordLeft: { text: '', cursor: 0 },
  },
  {
    name: 'CJK',
    text: '你好世界',
    cursor: 2,
    killRight: { text: '你好', cursor: 2 },
    killLeft: { text: '世界', cursor: 0 },
    wordLeft: { text: '世界', cursor: 0 },
  },
];
