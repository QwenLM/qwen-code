/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useReducer, useEffect, useRef } from 'react';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { Key } from './useKeypress.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import {
  useVimModeState,
  useVimModeActions,
} from '../contexts/VimModeContext.js';
import { execFile, execFileSync } from 'child_process';
import { cpLen, cpSlice } from '../utils/textUtils.js';
import { writeOsc52 } from '../utils/clipboardUtils.js';

export type VimMode = 'NORMAL' | 'INSERT';

// Constants
const DIGIT_MULTIPLIER = 10;
const DEFAULT_COUNT = 1;
const MAX_COUNT = 9999;
const DIGIT_1_TO_9 = /^[1-9]$/;

const debugLogger = createDebugLogger('VIM_MODE');

// Command types (for dot-repeat)
const CMD_TYPES = {
  DELETE_WORD_FORWARD: 'dw',
  DELETE_WORD_BACKWARD: 'db',
  DELETE_WORD_END: 'de',
  CHANGE_WORD_FORWARD: 'cw',
  CHANGE_WORD_BACKWARD: 'cb',
  CHANGE_WORD_END: 'ce',
  DELETE_CHAR: 'x',
  DELETE_LINE: 'dd',
  CHANGE_LINE: 'cc',
  DELETE_TO_EOL: 'D',
  CHANGE_TO_EOL: 'C',
  YANK_LINE: 'yy',
  YANK_WORD_FORWARD: 'yw',
  YANK_WORD_BACKWARD: 'yb',
  YANK_WORD_END: 'ye',
  REPLACE_CHAR: 'r',
  TOGGLE_CASE: '~',
  JOIN_LINES: 'J',
  INDENT_LINE: '>>',
  OUTDENT_LINE: '<<',
  CHANGE_MOVEMENT: {
    LEFT: 'ch',
    DOWN: 'cj',
    UP: 'ck',
    RIGHT: 'cl',
  },
  DELETE_MOVEMENT: {
    LEFT: 'dh',
    DOWN: 'dj',
    UP: 'dk',
    RIGHT: 'dl',
  },
  YANK_MOVEMENT: {
    LEFT: 'yh',
    DOWN: 'yj',
    UP: 'yk',
    RIGHT: 'yl',
  },
} as const;

type PendingOperator = 'g' | 'd' | 'c' | 'y' | '>' | '<' | null;
type PendingCharRead = 'r' | 'f' | 'F' | 't' | 'T' | null;
type FindInfo = { type: 'f' | 'F' | 't' | 'T'; char: string } | null;

// ── State ──

type VimState = {
  mode: VimMode;
  count: number;
  pendingOperator: PendingOperator;
  lastCommand: { type: string; count: number; char?: string } | null;
  pendingCharRead: PendingCharRead;
  lastFind: FindInfo;
  yankRegister: string;
  yankLinewise: boolean;
};

type VimAction =
  | { type: 'SET_MODE'; mode: VimMode }
  | { type: 'SET_COUNT'; count: number }
  | { type: 'INCREMENT_COUNT'; digit: number }
  | { type: 'CLEAR_COUNT' }
  | { type: 'SET_PENDING_OPERATOR'; operator: PendingOperator }
  | {
      type: 'SET_LAST_COMMAND';
      command: { type: string; count: number; char?: string } | null;
    }
  | { type: 'CLEAR_PENDING_STATES' }
  | { type: 'ESCAPE_TO_NORMAL' }
  | { type: 'SET_PENDING_CHAR_READ'; value: PendingCharRead }
  | { type: 'SET_LAST_FIND'; find: FindInfo }
  | { type: 'SET_YANK_REGISTER'; text: string; linewise: boolean };

const createClearPendingState = () => ({
  count: 0,
  pendingOperator: null as PendingOperator,
  pendingCharRead: null as PendingCharRead,
});

const initialVimState: VimState = {
  mode: 'NORMAL',
  count: 0,
  pendingOperator: null,
  lastCommand: null,
  pendingCharRead: null,
  lastFind: null,
  yankRegister: '',
  yankLinewise: false,
};

// ── Reducer ──

const vimReducer = (state: VimState, action: VimAction): VimState => {
  switch (action.type) {
    case 'SET_MODE':
      return { ...state, mode: action.mode };
    case 'SET_COUNT':
      return { ...state, count: action.count };
    case 'INCREMENT_COUNT':
      return {
        ...state,
        count: Math.min(
          state.count * DIGIT_MULTIPLIER + action.digit,
          MAX_COUNT,
        ),
      };
    case 'CLEAR_COUNT':
      return { ...state, count: 0 };
    case 'SET_PENDING_OPERATOR':
      return { ...state, pendingOperator: action.operator };
    case 'SET_LAST_COMMAND':
      return { ...state, lastCommand: action.command };
    case 'CLEAR_PENDING_STATES':
      return { ...state, ...createClearPendingState() };
    case 'ESCAPE_TO_NORMAL':
      return { ...state, ...createClearPendingState() };
    case 'SET_PENDING_CHAR_READ':
      return { ...state, pendingCharRead: action.value };
    case 'SET_LAST_FIND':
      return { ...state, lastFind: action.find };
    case 'SET_YANK_REGISTER':
      return {
        ...state,
        yankRegister: action.text,
        yankLinewise: action.linewise,
      };
    default:
      return state;
  }
};

// ── Helpers ──

// Cached Linux clipboard tool to avoid repeated probe on every call.
let linuxReadCmd: string[] | null | undefined;
let linuxWriteCmd: string[] | null | undefined;

/** Read system clipboard */
function readClipboard(): string {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      return execFileSync('pbpaste', [], {
        encoding: 'utf-8',
        timeout: 200,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString();
    }
    if (platform === 'win32') {
      return execFileSync('powershell', ['-c', 'Get-Clipboard'], {
        encoding: 'utf-8',
        timeout: 200,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString();
    }
    // Linux: probe once, then use cached tool
    if (linuxReadCmd === undefined) {
      const candidates: Array<[string, string[]]> = [
        ['xclip', ['-selection', 'clipboard', '-o']],
        ['xsel', ['--clipboard', '--output']],
        ['wl-paste', []],
      ];
      linuxReadCmd = null;
      for (const [bin, args] of candidates) {
        try {
          execFileSync(bin, args, {
            encoding: 'utf-8',
            timeout: 200,
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          linuxReadCmd = [bin, ...args];
          break;
        } catch {
          /* try next */
        }
      }
    }
    if (linuxReadCmd) {
      const [bin, ...args] = linuxReadCmd;
      return execFileSync(bin, args, {
        encoding: 'utf-8',
        timeout: 200,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString();
    }
    return '';
  } catch (e) {
    debugLogger.warn('readClipboard failed:', e);
    return '';
  }
}

/** Write to system clipboard (fire-and-forget, non-blocking) */
function writeClipboard(text: string): void {
  try {
    const platform = process.platform;
    const cb = () => {
      /* ignore errors — clipboard is best-effort */
    };
    if (platform === 'darwin') {
      const child = execFile('pbcopy', [], { timeout: 500 }, cb);
      child.stdin?.end(text);
      child.unref();
      return;
    }
    if (platform === 'win32') {
      const child = execFile('clip', [], { timeout: 500 }, cb);
      child.stdin?.end(text);
      child.unref();
      return;
    }
    // Linux: probe once, then use cached tool
    if (linuxWriteCmd === undefined) {
      const candidates: Array<[string, string[]]> = [
        ['xclip', ['-selection', 'clipboard']],
        ['xsel', ['--clipboard', '--input']],
        ['wl-copy', []],
      ];
      linuxWriteCmd = null;
      for (const [bin, args] of candidates) {
        try {
          execFileSync(bin, args, {
            input: text,
            timeout: 200,
            stdio: ['pipe', 'pipe', 'ignore'],
          });
          linuxWriteCmd = [bin, ...args];
          return;
        } catch {
          /* try next */
        }
      }
    }
    if (linuxWriteCmd) {
      const [bin, ...args] = linuxWriteCmd;
      const child = execFile(bin, args, { timeout: 500 }, (err) => {
        if (err && !writeOsc52(text)) {
          debugLogger.warn(
            'writeClipboard: cached tool and OSC 52 both failed',
          );
        }
      });
      child.stdin?.end(text);
      child.unref();
    } else {
      // No clipboard tool available (e.g., SSH without X11/Wayland) — try OSC 52
      if (!writeOsc52(text)) {
        debugLogger.warn('OSC 52 clipboard write failed - no TTY available');
      }
    }
  } catch (e) {
    debugLogger.warn('writeClipboard failed:', e);
  }
}

/** Prepare paste text: normalize linewise newlines and apply repeat count */
function preparePasteText(text: string, count: number): string {
  const normalized = text.endsWith('\n') ? text : text + '\n';
  return normalized.repeat(count);
}

/** Find char in line, starting from col (exclusive). Returns col or -1. */
function findCharInLine(line: string, char: string, fromCol: number): number {
  const cps = [...line];
  for (let i = fromCol + 1; i < cps.length; i++) {
    if (cps[i] === char) return i;
  }
  return -1;
}

/** Find char backwards in line, starting from col (exclusive). Returns col or -1. */
function findCharInLineReverse(
  line: string,
  char: string,
  fromCol: number,
): number {
  const cps = [...line];
  for (let i = fromCol - 1; i >= 0; i--) {
    if (cps[i] === char) return i;
  }
  return -1;
}

// ── Hook ──

export function useVim(buffer: TextBuffer, onSubmit?: (value: string) => void) {
  const { vimEnabled, vimMode } = useVimModeState();
  const { setVimMode } = useVimModeActions();
  const [state, dispatch] = useReducer(vimReducer, initialVimState);
  const bufferRef = useRef(buffer);
  const stateRef = useRef(state);
  bufferRef.current = buffer;
  stateRef.current = state;

  useEffect(() => {
    dispatch({ type: 'SET_MODE', mode: vimMode });
  }, [vimMode]);

  const updateMode = useCallback(
    (mode: VimMode) => {
      setVimMode(mode);
      dispatch({ type: 'SET_MODE', mode });
    },
    [setVimMode],
  );

  const getCurrentCount = useCallback(
    () => stateRef.current.count || DEFAULT_COUNT,
    [],
  );

  // ── Yank helper ──

  const yankRange = useCallback(
    (
      startRow: number,
      startCol: number,
      endRow: number,
      endCol: number,
      linewise: boolean,
    ) => {
      const lines = bufferRef.current.lines;
      let text = '';
      if (startRow === endRow) {
        text = cpSlice(lines[startRow] ?? '', startCol, endCol);
      } else {
        const middleLines = lines.slice(startRow + 1, endRow);
        text =
          cpSlice(lines[startRow] ?? '', startCol) +
          '\n' +
          (middleLines.length > 0 ? middleLines.join('\n') + '\n' : '') +
          cpSlice(lines[endRow] ?? '', 0, endCol);
      }
      dispatch({ type: 'SET_YANK_REGISTER', text, linewise });
      writeClipboard(text);
    },
    [],
  );

  // ── Execute command (for dot-repeat) ──

  const executeCommand = useCallback(
    (cmdType: string, count: number) => {
      switch (cmdType) {
        case CMD_TYPES.DELETE_WORD_FORWARD:
          buffer.vimDeleteWordForward(count);
          break;
        case CMD_TYPES.DELETE_WORD_BACKWARD:
          buffer.vimDeleteWordBackward(count);
          break;
        case CMD_TYPES.DELETE_WORD_END:
          buffer.vimDeleteWordEnd(count);
          break;
        case CMD_TYPES.CHANGE_WORD_FORWARD:
          buffer.vimChangeWordForward(count);
          updateMode('INSERT');
          break;
        case CMD_TYPES.CHANGE_WORD_BACKWARD:
          buffer.vimChangeWordBackward(count);
          updateMode('INSERT');
          break;
        case CMD_TYPES.CHANGE_WORD_END:
          buffer.vimChangeWordEnd(count);
          updateMode('INSERT');
          break;
        case CMD_TYPES.DELETE_CHAR: {
          const [row, col] = bufferRef.current.cursor;
          const lines = bufferRef.current.lines;
          const line = lines[row] ?? '';
          const text = cpSlice(line, col, col + count);
          dispatch({ type: 'SET_YANK_REGISTER', text, linewise: false });
          writeClipboard(text);
          buffer.vimDeleteChar(count);
          break;
        }
        case CMD_TYPES.DELETE_LINE: {
          const lines = bufferRef.current.lines;
          const [row] = bufferRef.current.cursor;
          const endRow = Math.min(row + count - 1, lines.length - 1);
          const text = lines.slice(row, endRow + 1).join('\n');
          dispatch({ type: 'SET_YANK_REGISTER', text, linewise: true });
          writeClipboard(text);
          buffer.vimDeleteLine(count);
          break;
        }
        case CMD_TYPES.CHANGE_LINE: {
          const lines = bufferRef.current.lines;
          const [row] = bufferRef.current.cursor;
          const endRow = Math.min(row + count - 1, lines.length - 1);
          const text = lines.slice(row, endRow + 1).join('\n');
          dispatch({ type: 'SET_YANK_REGISTER', text, linewise: true });
          writeClipboard(text);
          buffer.vimChangeLine(count);
          updateMode('INSERT');
          break;
        }
        case CMD_TYPES.CHANGE_MOVEMENT.LEFT:
        case CMD_TYPES.CHANGE_MOVEMENT.DOWN:
        case CMD_TYPES.CHANGE_MOVEMENT.UP:
        case CMD_TYPES.CHANGE_MOVEMENT.RIGHT: {
          const movementMap: Record<string, 'h' | 'j' | 'k' | 'l'> = {
            [CMD_TYPES.CHANGE_MOVEMENT.LEFT]: 'h',
            [CMD_TYPES.CHANGE_MOVEMENT.DOWN]: 'j',
            [CMD_TYPES.CHANGE_MOVEMENT.UP]: 'k',
            [CMD_TYPES.CHANGE_MOVEMENT.RIGHT]: 'l',
          };
          const m = movementMap[cmdType];
          if (m) {
            buffer.vimChangeMovement(m, count);
            updateMode('INSERT');
          }
          break;
        }
        case CMD_TYPES.DELETE_TO_EOL: {
          const [row, col] = bufferRef.current.cursor;
          const lines = bufferRef.current.lines;
          const line = lines[row] ?? '';
          const text = cpSlice(line, col);
          dispatch({ type: 'SET_YANK_REGISTER', text, linewise: false });
          writeClipboard(text);
          buffer.vimDeleteToEndOfLine();
          break;
        }
        case CMD_TYPES.CHANGE_TO_EOL: {
          const [row, col] = bufferRef.current.cursor;
          const lines = bufferRef.current.lines;
          const line = lines[row] ?? '';
          const text = cpSlice(line, col);
          dispatch({ type: 'SET_YANK_REGISTER', text, linewise: false });
          writeClipboard(text);
          buffer.vimChangeToEndOfLine();
          updateMode('INSERT');
          break;
        }
        case CMD_TYPES.YANK_LINE: {
          const lines = bufferRef.current.lines;
          const [row] = bufferRef.current.cursor;
          const endRow = Math.min(row + count - 1, lines.length - 1);
          yankRange(row, 0, endRow, lines[endRow]?.length ?? 0, true);
          break;
        }
        case CMD_TYPES.YANK_WORD_FORWARD: {
          const [row, col] = bufferRef.current.cursor;
          const lines = bufferRef.current.lines;
          const nextWord = findNextWordCol(lines, row, col, count);
          if (nextWord) yankRange(row, col, nextWord[0], nextWord[1], false);
          break;
        }
        case CMD_TYPES.YANK_WORD_BACKWARD: {
          const [row, col] = bufferRef.current.cursor;
          const lines = bufferRef.current.lines;
          const prevWord = findPrevWordCol(lines, row, col, count);
          if (prevWord) yankRange(prevWord[0], prevWord[1], row, col, false);
          break;
        }
        case CMD_TYPES.YANK_WORD_END: {
          const [row, col] = bufferRef.current.cursor;
          const lines = bufferRef.current.lines;
          const wordEnd = findWordEndCol(lines, row, col, count);
          if (wordEnd) yankRange(row, col, wordEnd[0], wordEnd[1] + 1, false);
          break;
        }
        case CMD_TYPES.DELETE_MOVEMENT.LEFT:
        case CMD_TYPES.DELETE_MOVEMENT.DOWN:
        case CMD_TYPES.DELETE_MOVEMENT.UP:
        case CMD_TYPES.DELETE_MOVEMENT.RIGHT: {
          const movementMap: Record<string, 'h' | 'j' | 'k' | 'l'> = {
            [CMD_TYPES.DELETE_MOVEMENT.LEFT]: 'h',
            [CMD_TYPES.DELETE_MOVEMENT.DOWN]: 'j',
            [CMD_TYPES.DELETE_MOVEMENT.UP]: 'k',
            [CMD_TYPES.DELETE_MOVEMENT.RIGHT]: 'l',
          };
          const m = movementMap[cmdType];
          if (m) {
            const [row, col] = bufferRef.current.cursor;
            const lines = bufferRef.current.lines;
            const { text, linewise } = extractMovementText(
              lines,
              row,
              col,
              m,
              count,
            );
            dispatch({
              type: 'SET_YANK_REGISTER',
              text,
              linewise,
            });
            writeClipboard(text);
            buffer.vimDeleteMovement(m, count);
          }
          break;
        }
        case CMD_TYPES.YANK_MOVEMENT.LEFT:
        case CMD_TYPES.YANK_MOVEMENT.DOWN:
        case CMD_TYPES.YANK_MOVEMENT.UP:
        case CMD_TYPES.YANK_MOVEMENT.RIGHT: {
          const movementMap: Record<string, 'h' | 'j' | 'k' | 'l'> = {
            [CMD_TYPES.YANK_MOVEMENT.LEFT]: 'h',
            [CMD_TYPES.YANK_MOVEMENT.DOWN]: 'j',
            [CMD_TYPES.YANK_MOVEMENT.UP]: 'k',
            [CMD_TYPES.YANK_MOVEMENT.RIGHT]: 'l',
          };
          const m = movementMap[cmdType];
          if (m) {
            const [row, col] = bufferRef.current.cursor;
            const lines = bufferRef.current.lines;
            const { text, linewise } = extractMovementText(
              lines,
              row,
              col,
              m,
              count,
            );
            dispatch({
              type: 'SET_YANK_REGISTER',
              text,
              linewise,
            });
            writeClipboard(text);
          }
          break;
        }
        case CMD_TYPES.REPLACE_CHAR: {
          const replaceChar = stateRef.current.lastCommand?.char;
          if (replaceChar != null) {
            const [row, col] = bufferRef.current.cursor;
            const line = bufferRef.current.lines[row] ?? '';
            if (col + count <= cpLen(line) && col < cpLen(line)) {
              buffer.replaceRange(
                row,
                col,
                row,
                col + count,
                replaceChar.repeat(count),
              );
            }
          }
          break;
        }
        case CMD_TYPES.TOGGLE_CASE: {
          const [startRow, startCol] = buffer.cursor;
          const line = buffer.lines[startRow] ?? '';
          const toggleCount = Math.min(count, cpLen(line) - startCol);
          if (toggleCount > 0) {
            const toggled = [...cpSlice(line, startCol, startCol + toggleCount)]
              .map((ch) =>
                ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
              )
              .join('');
            buffer.replaceRange(
              startRow,
              startCol,
              startRow,
              startCol + toggleCount,
              toggled,
            );
          }
          break;
        }
        case CMD_TYPES.JOIN_LINES: {
          const [row] = buffer.cursor;
          const lines = buffer.lines;
          const endRow = Math.min(
            row + Math.max(count - 1, 1),
            lines.length - 1,
          );
          if (row < endRow) {
            let joined = lines[row] ?? '';
            let joinCol = 0;
            for (let r = row + 1; r <= endRow; r++) {
              const trimmed = (lines[r] ?? '').trimStart();
              joined += ' ' + trimmed;
              joinCol = cpLen(joined) - cpLen(trimmed) - 1;
            }
            buffer.replaceRange(
              row,
              0,
              endRow,
              cpLen(lines[endRow] ?? ''),
              joined,
            );
            buffer.vimMoveToLineStart();
            buffer.vimMoveRight(joinCol);
          }
          break;
        }
        case CMD_TYPES.INDENT_LINE: {
          const [startRow] = buffer.cursor;
          const endRow = Math.min(
            startRow + count - 1,
            buffer.lines.length - 1,
          );
          // Compute full indented block and issue single replaceRange
          const lines = buffer.lines;
          let indentedBlock = '';
          for (let r = startRow; r <= endRow; r++) {
            if (r > startRow) indentedBlock += '\n';
            indentedBlock += '  ' + (lines[r] ?? '');
          }
          buffer.replaceRange(
            startRow,
            0,
            endRow,
            cpLen(lines[endRow] ?? ''),
            indentedBlock,
          );
          break;
        }
        case CMD_TYPES.OUTDENT_LINE: {
          const [startRow] = buffer.cursor;
          const endRow = Math.min(
            startRow + count - 1,
            buffer.lines.length - 1,
          );
          // Compute full outdented block and issue single replaceRange
          const lines = buffer.lines;
          let outdentedBlock = '';
          for (let r = startRow; r <= endRow; r++) {
            if (r > startRow) outdentedBlock += '\n';
            const line = lines[r] ?? '';
            if (line.startsWith('  ')) {
              outdentedBlock += line.slice(2);
            } else if (line.startsWith(' ')) {
              outdentedBlock += line.slice(1);
            } else {
              outdentedBlock += line;
            }
          }
          buffer.replaceRange(
            startRow,
            0,
            endRow,
            cpLen(lines[endRow] ?? ''),
            outdentedBlock,
          );
          break;
        }
        default:
          return false;
      }
      return true;
    },
    [buffer, updateMode, yankRange],
  );

  // ── Word boundary helpers (for yank) ──

  function findNextWordCol(
    lines: string[],
    row: number,
    col: number,
    count: number,
  ): [number, number] | null {
    let r = row;
    let c = col;
    for (let i = 0; i < count; i++) {
      const line = lines[r] ?? '';
      const cps = [...line];
      // Skip current word chars
      while (c < cps.length && /\w/.test(cps[c])) c++;
      // Skip whitespace
      while (c < cps.length && /\s/.test(cps[c])) c++;
      if (c >= cps.length) {
        // Move to next line
        r++;
        c = 0;
        if (r >= lines.length) return null;
        // Skip blank lines
        while (r < lines.length && [...(lines[r] ?? '')].length === 0) {
          r++;
          c = 0;
        }
        if (r >= lines.length) return null;
      }
    }
    return [r, c];
  }

  function findPrevWordCol(
    lines: string[],
    row: number,
    col: number,
    count: number,
  ): [number, number] | null {
    let r = row;
    let c = col;
    for (let i = 0; i < count; i++) {
      if (c > 0) {
        c--;
        const line = lines[r] ?? '';
        const cps = [...line];
        // Skip whitespace
        while (c > 0 && /\s/.test(cps[c])) c--;
        // Skip word chars
        while (c > 0 && /\w/.test(cps[c - 1])) c--;
      } else if (r > 0) {
        r--;
        const line = lines[r] ?? '';
        const cps = [...line];
        c = cps.length;
        while (c > 0 && /\s/.test(cps[c - 1])) c--;
        while (c > 0 && /\w/.test(cps[c - 1])) c--;
      } else {
        return null;
      }
    }
    return [r, c];
  }

  function findWordEndCol(
    lines: string[],
    row: number,
    col: number,
    count: number,
  ): [number, number] | null {
    let r = row;
    let c = col;
    for (let i = 0; i < count; i++) {
      c++;
      let line = lines[r] ?? '';
      const cps = [...line];
      if (c >= cps.length) {
        r++;
        c = 0;
        if (r >= lines.length) return null;
        line = lines[r] ?? '';
        while (r < lines.length && [...(lines[r] ?? '')].length === 0) {
          r++;
          c = 0;
        }
        if (r >= lines.length) return null;
        line = lines[r] ?? '';
      }
      const cps2 = [...line];
      // Skip whitespace
      while (c < cps2.length && /\s/.test(cps2[c])) c++;
      // Move to end of word
      while (c < cps2.length - 1 && /\w/.test(cps2[c + 1])) c++;
    }
    return [r, c];
  }

  // ── Shared movement text extraction ──

  function extractMovementText(
    lines: string[],
    row: number,
    col: number,
    movement: 'h' | 'j' | 'k' | 'l',
    count: number,
  ): { text: string; linewise: boolean } {
    let text = '';
    switch (movement) {
      case 'h': {
        const startCol = Math.max(0, col - count);
        text = cpSlice(lines[row] ?? '', startCol, col);
        break;
      }
      case 'l': {
        const endCol = Math.min(cpLen(lines[row] ?? ''), col + count);
        text = cpSlice(lines[row] ?? '', col, endCol);
        break;
      }
      case 'j': {
        const endRow = Math.min(lines.length - 1, row + count);
        text = lines.slice(row, endRow + 1).join('\n');
        break;
      }
      case 'k': {
        const startRow = Math.max(0, row - count);
        text = lines.slice(startRow, row + 1).join('\n');
        break;
      }
      default:
        break;
    }
    return { text, linewise: movement === 'j' || movement === 'k' };
  }

  // ── Character find helper ──

  const executeFind = useCallback(
    (findType: 'f' | 'F' | 't' | 'T', char: string, count = 1) => {
      const [startRow, startCol] = buffer.cursor;
      const line = buffer.lines[startRow] ?? '';
      let currentCol = startCol;

      for (let i = 0; i < count; i++) {
        let targetCol = -1;
        switch (findType) {
          case 'f':
            targetCol = findCharInLine(line, char, currentCol);
            break;
          case 'F':
            targetCol = findCharInLineReverse(line, char, currentCol);
            break;
          case 't':
            targetCol = findCharInLine(line, char, currentCol);
            if (targetCol > 0) targetCol--;
            break;
          case 'T':
            targetCol = findCharInLineReverse(line, char, currentCol);
            if (targetCol >= 0 && targetCol < cpLen(line) - 1) targetCol++;
            break;
          default:
            break;
        }
        if (targetCol < 0) break;
        currentCol = targetCol;
      }

      if (currentCol !== startCol) {
        buffer.vimMoveToLineStart();
        buffer.vimMoveRight(currentCol);
      }
      dispatch({ type: 'CLEAR_COUNT' });
    },
    [buffer, dispatch],
  );

  // ── Handle char-read (for r, f, F, t, T) ──

  const handleCharRead = useCallback(
    (char: string) => {
      const readType = state.pendingCharRead;
      if (!readType) return false;

      dispatch({ type: 'SET_PENDING_CHAR_READ', value: null });

      switch (readType) {
        case 'r': {
          const [row, col] = buffer.cursor;
          const line = buffer.lines[row] ?? '';
          const count = stateRef.current.count || 1;
          if (col + count > cpLen(line)) {
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }
          if (col < cpLen(line)) {
            buffer.replaceRange(row, col, row, col + count, char.repeat(count));
          }
          dispatch({
            type: 'SET_LAST_COMMAND',
            command: { type: CMD_TYPES.REPLACE_CHAR, count, char },
          });
          dispatch({ type: 'CLEAR_COUNT' });
          dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
          return true;
        }
        case 'f':
        case 'F':
        case 't':
        case 'T': {
          dispatch({
            type: 'SET_LAST_FIND',
            find: { type: readType, char },
          });
          executeFind(readType, char, stateRef.current.count || 1);
          return true;
        }
        default:
          return false;
      }
    },
    [state.pendingCharRead, buffer, dispatch, executeFind],
  );

  // ── Handle INSERT mode ──

  const handleInsertModeInput = useCallback(
    (normalizedKey: Key): boolean => {
      if (normalizedKey.name === 'escape') {
        buffer.vimEscapeInsertMode();
        dispatch({ type: 'ESCAPE_TO_NORMAL' });
        updateMode('NORMAL');
        return true;
      }

      if (
        normalizedKey.name === 'tab' ||
        (normalizedKey.name === 'return' && !normalizedKey.ctrl) ||
        normalizedKey.name === 'up' ||
        normalizedKey.name === 'down' ||
        (normalizedKey.ctrl && normalizedKey.name === 'r')
      ) {
        return false;
      }

      if (
        (normalizedKey.ctrl || normalizedKey.meta) &&
        normalizedKey.name === 'v'
      ) {
        return false;
      }

      if (normalizedKey.sequence === '!' && buffer.text.length === 0) {
        return false;
      }

      if (
        normalizedKey.name === 'return' &&
        !normalizedKey.ctrl &&
        !normalizedKey.meta
      ) {
        if (buffer.text.trim() && onSubmit) {
          const submittedValue = buffer.text;
          buffer.setText('');
          onSubmit(submittedValue);
          return true;
        }
        return true;
      }

      buffer.handleInput(normalizedKey);
      return true;
    },
    [buffer, dispatch, updateMode, onSubmit],
  );

  const normalizeKey = useCallback(
    (key: Key): Key => ({
      name: key.name || '',
      sequence: key.sequence || '',
      ctrl: key.ctrl || false,
      meta: key.meta || false,
      shift: key.shift || false,
      paste: key.paste || false,
    }),
    [],
  );

  const handleChangeMovement = useCallback(
    (movement: 'h' | 'j' | 'k' | 'l'): boolean => {
      const count = getCurrentCount();
      dispatch({ type: 'CLEAR_COUNT' });
      buffer.vimChangeMovement(movement, count);
      updateMode('INSERT');

      const cmdTypeMap = {
        h: CMD_TYPES.CHANGE_MOVEMENT.LEFT,
        j: CMD_TYPES.CHANGE_MOVEMENT.DOWN,
        k: CMD_TYPES.CHANGE_MOVEMENT.UP,
        l: CMD_TYPES.CHANGE_MOVEMENT.RIGHT,
      };

      dispatch({
        type: 'SET_LAST_COMMAND',
        command: { type: cmdTypeMap[movement], count },
      });
      dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
      return true;
    },
    [getCurrentCount, dispatch, buffer, updateMode],
  );

  const handleDeleteMovement = useCallback(
    (movement: 'h' | 'j' | 'k' | 'l'): boolean => {
      const count = getCurrentCount();
      const [row, col] = bufferRef.current.cursor;
      const lines = bufferRef.current.lines;

      const { text, linewise } = extractMovementText(
        lines,
        row,
        col,
        movement,
        count,
      );

      dispatch({
        type: 'SET_YANK_REGISTER',
        text,
        linewise,
      });
      writeClipboard(text);
      dispatch({ type: 'CLEAR_COUNT' });
      buffer.vimDeleteMovement(movement, count);

      const cmdTypeMap = {
        h: CMD_TYPES.DELETE_MOVEMENT.LEFT,
        j: CMD_TYPES.DELETE_MOVEMENT.DOWN,
        k: CMD_TYPES.DELETE_MOVEMENT.UP,
        l: CMD_TYPES.DELETE_MOVEMENT.RIGHT,
      };

      dispatch({
        type: 'SET_LAST_COMMAND',
        command: { type: cmdTypeMap[movement], count },
      });
      dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
      return true;
    },
    [getCurrentCount, dispatch, buffer],
  );

  const handleYankMovement = useCallback(
    (movement: 'h' | 'j' | 'k' | 'l'): boolean => {
      const count = getCurrentCount();
      const [row, col] = bufferRef.current.cursor;
      const lines = bufferRef.current.lines;

      const { text, linewise } = extractMovementText(
        lines,
        row,
        col,
        movement,
        count,
      );

      dispatch({
        type: 'SET_YANK_REGISTER',
        text,
        linewise,
      });
      writeClipboard(text);
      dispatch({ type: 'CLEAR_COUNT' });

      const cmdTypeMap = {
        h: CMD_TYPES.YANK_MOVEMENT.LEFT,
        j: CMD_TYPES.YANK_MOVEMENT.DOWN,
        k: CMD_TYPES.YANK_MOVEMENT.UP,
        l: CMD_TYPES.YANK_MOVEMENT.RIGHT,
      };

      dispatch({
        type: 'SET_LAST_COMMAND',
        command: { type: cmdTypeMap[movement], count },
      });
      dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
      return true;
    },
    [getCurrentCount, dispatch],
  );

  const handleOperatorMotion = useCallback(
    (operator: 'd' | 'c' | 'y', motion: 'w' | 'b' | 'e'): boolean => {
      const count = getCurrentCount();

      const commandMap = {
        d: {
          w: CMD_TYPES.DELETE_WORD_FORWARD,
          b: CMD_TYPES.DELETE_WORD_BACKWARD,
          e: CMD_TYPES.DELETE_WORD_END,
        },
        c: {
          w: CMD_TYPES.CHANGE_WORD_FORWARD,
          b: CMD_TYPES.CHANGE_WORD_BACKWARD,
          e: CMD_TYPES.CHANGE_WORD_END,
        },
        y: {
          w: CMD_TYPES.YANK_WORD_FORWARD,
          b: CMD_TYPES.YANK_WORD_BACKWARD,
          e: CMD_TYPES.YANK_WORD_END,
        },
      };

      const cmdType = commandMap[operator][motion];
      executeCommand(cmdType, count);

      dispatch({
        type: 'SET_LAST_COMMAND',
        command: { type: cmdType, count },
      });
      dispatch({ type: 'CLEAR_COUNT' });
      dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });

      return true;
    },
    [getCurrentCount, executeCommand, dispatch],
  );

  // ── Main key handler ──

  const handleInput = useCallback(
    (key: Key): boolean => {
      if (!vimEnabled) {
        return false;
      }

      let normalizedKey: Key;
      try {
        normalizedKey = normalizeKey(key);
      } catch (error) {
        debugLogger.warn('Malformed key input in vim mode:', key, error);
        return false;
      }

      const s = stateRef.current;

      // ── INSERT mode ──
      if (s.mode === 'INSERT') {
        return handleInsertModeInput(normalizedKey);
      }

      // ── Pending char read (r, f, F, t, T) ──
      if (s.pendingCharRead && s.mode === 'NORMAL') {
        if (normalizedKey.name === 'escape') {
          dispatch({ type: 'CLEAR_PENDING_STATES' });
          return true;
        }
        if (
          normalizedKey.sequence &&
          normalizedKey.sequence.length === 1 &&
          normalizedKey.sequence.charCodeAt(0) >= 32
        ) {
          return handleCharRead(normalizedKey.sequence);
        }
        return true;
      }

      // ── NORMAL mode ──
      if (s.mode === 'NORMAL') {
        if (
          normalizedKey.sequence === '?' &&
          buffer.text.length === 0 &&
          s.pendingOperator === null &&
          s.count === 0
        ) {
          return false;
        }

        if (normalizedKey.name === 'escape') {
          if (s.pendingOperator) {
            dispatch({ type: 'CLEAR_PENDING_STATES' });
            return true;
          }
          return false;
        }

        if (
          DIGIT_1_TO_9.test(normalizedKey.sequence) ||
          (normalizedKey.sequence === '0' && s.count > 0)
        ) {
          dispatch({
            type: 'INCREMENT_COUNT',
            digit: parseInt(normalizedKey.sequence, 10),
          });
          return true;
        }

        const repeatCount = getCurrentCount();

        switch (normalizedKey.sequence) {
          // ── Movement ──
          case 'h': {
            if (s.pendingOperator === 'c') return handleChangeMovement('h');
            if (s.pendingOperator === 'd') return handleDeleteMovement('h');
            if (s.pendingOperator === 'y') return handleYankMovement('h');
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveLeft(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'j': {
            if (s.pendingOperator === 'c') return handleChangeMovement('j');
            if (s.pendingOperator === 'd') return handleDeleteMovement('j');
            if (s.pendingOperator === 'y') return handleYankMovement('j');
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveDown(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'k': {
            if (s.pendingOperator === 'c') return handleChangeMovement('k');
            if (s.pendingOperator === 'd') return handleDeleteMovement('k');
            if (s.pendingOperator === 'y') return handleYankMovement('k');
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveUp(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'l': {
            if (s.pendingOperator === 'c') return handleChangeMovement('l');
            if (s.pendingOperator === 'd') return handleDeleteMovement('l');
            if (s.pendingOperator === 'y') return handleYankMovement('l');
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveRight(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          // ── Word movement (small word) ──
          case 'w': {
            if (s.pendingOperator === 'd')
              return handleOperatorMotion('d', 'w');
            if (s.pendingOperator === 'c')
              return handleOperatorMotion('c', 'w');
            if (s.pendingOperator === 'y')
              return handleOperatorMotion('y', 'w');
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveWordForward(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'b': {
            if (s.pendingOperator === 'd')
              return handleOperatorMotion('d', 'b');
            if (s.pendingOperator === 'c')
              return handleOperatorMotion('c', 'b');
            if (s.pendingOperator === 'y')
              return handleOperatorMotion('y', 'b');
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveWordBackward(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'e': {
            if (s.pendingOperator === 'd')
              return handleOperatorMotion('d', 'e');
            if (s.pendingOperator === 'c')
              return handleOperatorMotion('c', 'e');
            if (s.pendingOperator === 'y')
              return handleOperatorMotion('y', 'e');
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveWordEnd(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          // ── Word movement (big WORD) ──
          case 'W': {
            if (
              s.pendingOperator === 'd' ||
              s.pendingOperator === 'c' ||
              s.pendingOperator === 'y'
            ) {
              // For now, treat W same as w for operators
              return handleOperatorMotion(s.pendingOperator, 'w');
            }
            // Big WORD forward: move to next non-blank after whitespace
            {
              const [row, col] = buffer.cursor;
              const lines = buffer.lines;
              let r = row;
              let c = col;
              for (let i = 0; i < repeatCount; i++) {
                const line = lines[r] ?? '';
                // Skip non-whitespace
                while (c < line.length && !/\s/.test(line[c])) c++;
                // Skip whitespace
                while (c < line.length && /\s/.test(line[c])) c++;
                if (c >= line.length) {
                  r++;
                  c = 0;
                  if (r >= lines.length) {
                    r = lines.length - 1;
                    c = (lines[r] ?? '').length;
                    break;
                  }
                  // Skip blank lines
                  while (r < lines.length && (lines[r] ?? '').length === 0) {
                    r++;
                    c = 0;
                  }
                  if (r >= lines.length) {
                    r = lines.length - 1;
                    c = (lines[r] ?? '').length;
                    break;
                  }
                }
              }
              buffer.vimMoveToLineStart();
              buffer.vimMoveRight(c);
              // Handle cross-line movement
              const currentRow = buffer.cursor[0];
              if (r !== currentRow) {
                // Need to move vertically too — use vimMoveDown/Up
                if (r > currentRow) buffer.vimMoveDown(r - currentRow);
                else buffer.vimMoveUp(currentRow - r);
                buffer.vimMoveToLineStart();
                buffer.vimMoveRight(c);
              }
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'B': {
            if (
              s.pendingOperator === 'd' ||
              s.pendingOperator === 'c' ||
              s.pendingOperator === 'y'
            ) {
              return handleOperatorMotion(s.pendingOperator, 'b');
            }
            {
              const [row, col] = buffer.cursor;
              const lines = buffer.lines;
              let r = row;
              let c = col;
              for (let i = 0; i < repeatCount; i++) {
                if (c > 0) {
                  c--;
                  const line = lines[r] ?? '';
                  while (c > 0 && /\s/.test(line[c])) c--;
                  while (c > 0 && !/\s/.test(line[c - 1])) c--;
                } else if (r > 0) {
                  r--;
                  c = (lines[r] ?? '').length;
                  const line = lines[r] ?? '';
                  while (c > 0 && /\s/.test(line[c - 1])) c--;
                  while (c > 0 && !/\s/.test(line[c - 1])) c--;
                }
              }
              const currentRow = buffer.cursor[0];
              if (r !== currentRow) {
                if (r > currentRow) buffer.vimMoveDown(r - currentRow);
                else buffer.vimMoveUp(currentRow - r);
              }
              buffer.vimMoveToLineStart();
              buffer.vimMoveRight(c);
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'E': {
            if (
              s.pendingOperator === 'd' ||
              s.pendingOperator === 'c' ||
              s.pendingOperator === 'y'
            ) {
              return handleOperatorMotion(s.pendingOperator, 'e');
            }
            {
              const [row, col] = buffer.cursor;
              const lines = buffer.lines;
              let r = row;
              let c = col;
              for (let i = 0; i < repeatCount; i++) {
                c++;
                let line = lines[r] ?? '';
                if (c >= line.length) {
                  r++;
                  c = 0;
                  if (r >= lines.length) {
                    r = lines.length - 1;
                    c = (lines[r] ?? '').length - 1;
                    break;
                  }
                  while (r < lines.length && (lines[r] ?? '').length === 0) {
                    r++;
                    c = 0;
                  }
                  if (r >= lines.length) {
                    r = lines.length - 1;
                    c = Math.max(0, (lines[r] ?? '').length - 1);
                    break;
                  }
                  line = lines[r] ?? '';
                }
                while (c < line.length && /\s/.test(line[c])) c++;
                while (c < line.length - 1 && !/\s/.test(line[c + 1])) c++;
              }
              const currentRow = buffer.cursor[0];
              if (r !== currentRow) {
                if (r > currentRow) buffer.vimMoveDown(r - currentRow);
                else buffer.vimMoveUp(currentRow - r);
              }
              buffer.vimMoveToLineStart();
              buffer.vimMoveRight(c);
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          // ── Character find ──
          case 'f':
          case 'F':
          case 't':
          case 'T':
            // TODO: support operator+find (e.g. dfa = delete to 'a').
            // Currently clears operator to prevent stale state; operator+find
            // should capture the operator, execute the find, then apply the
            // operator over the range from original cursor to found char.
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            dispatch({
              type: 'SET_PENDING_CHAR_READ',
              value: normalizedKey.sequence,
            });
            return true;

          case ';': {
            if (s.lastFind) {
              executeFind(s.lastFind.type, s.lastFind.char, repeatCount);
            }
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }
          case ',': {
            if (s.lastFind) {
              // Reverse the find direction
              const reverseMap: Record<string, 'f' | 'F' | 't' | 'T'> = {
                f: 'F',
                F: 'f',
                t: 'T',
                T: 't',
              };
              executeFind(
                reverseMap[s.lastFind.type],
                s.lastFind.char,
                repeatCount,
              );
            }
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }

          // ── Edit commands ──
          case 'x': {
            executeCommand(CMD_TYPES.DELETE_CHAR, repeatCount);
            dispatch({
              type: 'SET_LAST_COMMAND',
              command: { type: CMD_TYPES.DELETE_CHAR, count: repeatCount },
            });
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }

          case 'r':
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            dispatch({ type: 'SET_PENDING_CHAR_READ', value: 'r' });
            return true;

          case '~': {
            const [startRow, startCol] = buffer.cursor;
            const line = buffer.lines[startRow] ?? '';
            const count = Math.min(repeatCount, cpLen(line) - startCol);
            if (count > 0) {
              const toggled = [...cpSlice(line, startCol, startCol + count)]
                .map((ch) =>
                  ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
                )
                .join('');
              buffer.replaceRange(
                startRow,
                startCol,
                startRow,
                startCol + count,
                toggled,
              );
            }
            dispatch({
              type: 'SET_LAST_COMMAND',
              command: { type: CMD_TYPES.TOGGLE_CASE, count },
            });
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }

          case 'u': {
            for (let i = 0; i < repeatCount; i++) buffer.undo();
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }

          // ── Mode switching ──
          case 'i': {
            buffer.vimInsertAtCursor();
            updateMode('INSERT');
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'a': {
            buffer.vimAppendAtCursor();
            updateMode('INSERT');
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'o': {
            buffer.vimOpenLineBelow();
            updateMode('INSERT');
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'O': {
            buffer.vimOpenLineAbove();
            updateMode('INSERT');
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'I': {
            buffer.vimInsertAtLineStart();
            updateMode('INSERT');
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'A': {
            buffer.vimAppendAtLineEnd();
            updateMode('INSERT');
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          // ── Line navigation ──
          case '0': {
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveToLineStart();
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case '$': {
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveToLineEnd();
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case '^': {
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveToFirstNonWhitespace();
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'g': {
            if (s.pendingOperator === 'g') {
              buffer.vimMoveToFirstLine();
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            } else {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: 'g' });
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'G': {
            if (s.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            if (s.count > 0) {
              buffer.vimMoveToLine(s.count);
            } else {
              buffer.vimMoveToLastLine();
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          // ── Delete / Change / Yank operators ──
          case 'd': {
            if (s.pendingOperator === 'd') {
              const c = getCurrentCount();
              executeCommand(CMD_TYPES.DELETE_LINE, c);
              dispatch({
                type: 'SET_LAST_COMMAND',
                command: { type: CMD_TYPES.DELETE_LINE, count: c },
              });
              dispatch({ type: 'CLEAR_COUNT' });
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            } else {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: 'd' });
            }
            return true;
          }
          case 'c': {
            if (s.pendingOperator === 'c') {
              const c = getCurrentCount();
              executeCommand(CMD_TYPES.CHANGE_LINE, c);
              dispatch({
                type: 'SET_LAST_COMMAND',
                command: { type: CMD_TYPES.CHANGE_LINE, count: c },
              });
              dispatch({ type: 'CLEAR_COUNT' });
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            } else {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: 'c' });
            }
            return true;
          }
          case 'y': {
            if (s.pendingOperator === 'y') {
              // yy — yank line
              const c = getCurrentCount();
              executeCommand(CMD_TYPES.YANK_LINE, c);
              dispatch({
                type: 'SET_LAST_COMMAND',
                command: { type: CMD_TYPES.YANK_LINE, count: c },
              });
              dispatch({ type: 'CLEAR_COUNT' });
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            } else {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: 'y' });
            }
            return true;
          }
          case 'D': {
            executeCommand(CMD_TYPES.DELETE_TO_EOL, 1);
            dispatch({
              type: 'SET_LAST_COMMAND',
              command: { type: CMD_TYPES.DELETE_TO_EOL, count: 1 },
            });
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }
          case 'C': {
            executeCommand(CMD_TYPES.CHANGE_TO_EOL, 1);
            dispatch({
              type: 'SET_LAST_COMMAND',
              command: { type: CMD_TYPES.CHANGE_TO_EOL, count: 1 },
            });
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }
          case 'Y': {
            // Y = yy (yank entire line)
            const c = getCurrentCount();
            executeCommand(CMD_TYPES.YANK_LINE, c);
            dispatch({
              type: 'SET_LAST_COMMAND',
              command: { type: CMD_TYPES.YANK_LINE, count: c },
            });
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }

          // ── Join / Indent ──
          case 'J': {
            executeCommand(CMD_TYPES.JOIN_LINES, repeatCount);
            dispatch({
              type: 'SET_LAST_COMMAND',
              command: { type: CMD_TYPES.JOIN_LINES, count: repeatCount },
            });
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }
          case '>': {
            if (s.pendingOperator === '>') {
              executeCommand(CMD_TYPES.INDENT_LINE, repeatCount);
              dispatch({
                type: 'SET_LAST_COMMAND',
                command: { type: CMD_TYPES.INDENT_LINE, count: repeatCount },
              });
              dispatch({ type: 'CLEAR_COUNT' });
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              return true;
            } else {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: '>' });
              // Don't clear count — preserve for the second >
            }
            return true;
          }
          case '<': {
            if (s.pendingOperator === '<') {
              executeCommand(CMD_TYPES.OUTDENT_LINE, repeatCount);
              dispatch({
                type: 'SET_LAST_COMMAND',
                command: { type: CMD_TYPES.OUTDENT_LINE, count: repeatCount },
              });
              dispatch({ type: 'CLEAR_COUNT' });
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              return true;
            } else {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: '<' });
              // Don't clear count — preserve for the second <
            }
            return true;
          }

          // ── Paste ──
          case 'p': {
            let text = s.yankRegister;
            let isLinewise = s.yankLinewise;
            if (!text) {
              text = readClipboard();
              isLinewise = text.includes('\n');
            }
            if (text) {
              const [row, col] = buffer.cursor;
              const line = buffer.lines[row] ?? '';
              if (isLinewise) {
                const repeated = preparePasteText(text, repeatCount);
                if (row + 1 >= buffer.lines.length) {
                  const lastRow = buffer.lines.length - 1;
                  const lastLineLen = cpLen(buffer.lines[lastRow] ?? '');
                  buffer.replaceRange(
                    lastRow,
                    lastLineLen,
                    lastRow,
                    lastLineLen,
                    '\n' + repeated.replace(/\n$/, ''),
                  );
                  // Cursor on first line of pasted text (0-based row+1)
                  buffer.vimMoveToLine(row + 2);
                  buffer.vimMoveToLineStart();
                } else {
                  buffer.replaceRange(row + 1, 0, row + 1, 0, repeated);
                  // Cursor on first line of pasted text (line row+2, i.e. 0-based row+1)
                  buffer.vimMoveToLine(row + 2);
                  buffer.vimMoveToLineStart();
                }
              } else {
                // Paste after cursor
                const insertCol = Math.min(col + 1, line.length);
                buffer.replaceRange(
                  row,
                  insertCol,
                  row,
                  insertCol,
                  text.repeat(repeatCount),
                );
                buffer.vimMoveLeft(1);
              }
            }
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }
          case 'P': {
            let text = s.yankRegister;
            let isLinewise = s.yankLinewise;
            if (!text) {
              text = readClipboard();
              isLinewise = text.includes('\n');
            }
            if (text) {
              const [row, col] = buffer.cursor;
              if (isLinewise) {
                const repeated = preparePasteText(text, repeatCount);
                buffer.replaceRange(row, 0, row, 0, repeated);
                buffer.vimMoveToLine(row + 1);
                buffer.vimMoveToLineStart();
              } else {
                // Paste before cursor
                buffer.replaceRange(
                  row,
                  col,
                  row,
                  col,
                  text.repeat(repeatCount),
                );
                // Cursor on first pasted character
                buffer.vimMoveLeft(cpLen(text) * repeatCount);
              }
            }
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }

          // ── Dot repeat ──
          case '.': {
            if (s.lastCommand) {
              executeCommand(s.lastCommand.type, s.lastCommand.count);
            }
            dispatch({ type: 'CLEAR_COUNT' });
            dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            return true;
          }

          default: {
            // ── Enter to submit ──
            if (
              normalizedKey.name === 'return' &&
              !normalizedKey.ctrl &&
              !normalizedKey.meta
            ) {
              if (buffer.text.trim() && onSubmit) {
                const submittedValue = buffer.text;
                buffer.setText('');
                onSubmit(submittedValue);
              }
              dispatch({ type: 'CLEAR_COUNT' });
              return true;
            }

            // ── Arrow keys ──
            if (normalizedKey.name === 'left') {
              if (s.pendingOperator === 'c') return handleChangeMovement('h');
              if (s.pendingOperator) {
                dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              }
              buffer.vimMoveLeft(repeatCount);
              dispatch({ type: 'CLEAR_COUNT' });
              return true;
            }
            if (normalizedKey.name === 'down') {
              if (s.pendingOperator === 'c') return handleChangeMovement('j');
              if (s.pendingOperator) {
                dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              }
              buffer.vimMoveDown(repeatCount);
              dispatch({ type: 'CLEAR_COUNT' });
              return true;
            }
            if (normalizedKey.name === 'up') {
              if (s.pendingOperator === 'c') return handleChangeMovement('k');
              if (s.pendingOperator) {
                dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              }
              buffer.vimMoveUp(repeatCount);
              dispatch({ type: 'CLEAR_COUNT' });
              return true;
            }
            if (normalizedKey.name === 'right') {
              if (s.pendingOperator === 'c') return handleChangeMovement('l');
              if (s.pendingOperator) {
                dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              }
              buffer.vimMoveRight(repeatCount);
              dispatch({ type: 'CLEAR_COUNT' });
              return true;
            }

            dispatch({ type: 'CLEAR_PENDING_STATES' });
            return true;
          }
        }
      }

      return false;
    },
    [
      vimEnabled,
      normalizeKey,
      handleInsertModeInput,
      handleCharRead,
      dispatch,
      getCurrentCount,
      handleChangeMovement,
      handleDeleteMovement,
      handleYankMovement,
      handleOperatorMotion,
      buffer,
      executeCommand,
      updateMode,
      executeFind,
      onSubmit,
    ],
  );

  return {
    mode: state.mode,
    vimModeEnabled: vimEnabled,
    handleInput,
  };
}
