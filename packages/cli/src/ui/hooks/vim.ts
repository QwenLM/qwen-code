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
import { execFileSync } from 'child_process';

export type VimMode = 'NORMAL' | 'INSERT';

// Constants
const DIGIT_MULTIPLIER = 10;
const DEFAULT_COUNT = 1;
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
  CHANGE_MOVEMENT: {
    LEFT: 'ch',
    DOWN: 'cj',
    UP: 'ck',
    RIGHT: 'cl',
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
  lastCommand: { type: string; count: number } | null;
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
      command: { type: string; count: number } | null;
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
      return { ...state, count: state.count * DIGIT_MULTIPLIER + action.digit };
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
  } catch {
    return '';
  }
}

/** Write to system clipboard */
function writeClipboard(text: string): void {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execFileSync('pbcopy', [], {
        input: text,
        timeout: 200,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return;
    }
    if (platform === 'win32') {
      execFileSync('clip', [], {
        input: text,
        timeout: 200,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
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
      execFileSync(bin, args, {
        input: text,
        timeout: 200,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    }
  } catch {
    // Clipboard not available — silently ignore
  }
}

/** Find char in line, starting from col (exclusive). Returns col or -1. */
function findCharInLine(line: string, char: string, fromCol: number): number {
  const idx = line.indexOf(char, fromCol + 1);
  return idx >= 0 ? idx : -1;
}

/** Find char backwards in line, starting from col (exclusive). Returns col or -1. */
function findCharInLineReverse(
  line: string,
  char: string,
  fromCol: number,
): number {
  for (let i = fromCol - 1; i >= 0; i--) {
    if (line[i] === char) return i;
  }
  return -1;
}

// ── Hook ──

export function useVim(buffer: TextBuffer, onSubmit?: (value: string) => void) {
  const { vimEnabled, vimMode } = useVimModeState();
  const { setVimMode } = useVimModeActions();
  const [state, dispatch] = useReducer(vimReducer, initialVimState);
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;

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
    () => state.count || DEFAULT_COUNT,
    [state.count],
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
        text = lines[startRow]?.slice(startCol, endCol) ?? '';
      } else {
        const middleLines = lines.slice(startRow + 1, endRow);
        text =
          (lines[startRow]?.slice(startCol) ?? '') +
          '\n' +
          (middleLines.length > 0 ? middleLines.join('\n') + '\n' : '') +
          (lines[endRow]?.slice(0, endCol) ?? '');
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
          const text = line.slice(col, col + count);
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
          const text = line.slice(col);
          dispatch({ type: 'SET_YANK_REGISTER', text, linewise: false });
          writeClipboard(text);
          buffer.vimDeleteToEndOfLine();
          break;
        }
        case CMD_TYPES.CHANGE_TO_EOL: {
          const [row, col] = bufferRef.current.cursor;
          const lines = bufferRef.current.lines;
          const line = lines[row] ?? '';
          const text = line.slice(col);
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
      // Skip current word chars
      while (c < line.length && /\w/.test(line[c])) c++;
      // Skip whitespace
      while (c < line.length && /\s/.test(line[c])) c++;
      if (c >= line.length) {
        // Move to next line
        r++;
        c = 0;
        if (r >= lines.length) return null;
        // Skip blank lines
        while (r < lines.length && (lines[r] ?? '').length === 0) {
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
        // Skip whitespace
        while (c > 0 && /\s/.test(line[c])) c--;
        // Skip word chars
        while (c > 0 && /\w/.test(line[c - 1])) c--;
      } else if (r > 0) {
        r--;
        c = (lines[r] ?? '').length;
        const line = lines[r] ?? '';
        while (c > 0 && /\s/.test(line[c - 1])) c--;
        while (c > 0 && /\w/.test(line[c - 1])) c--;
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
      if (c >= line.length) {
        r++;
        c = 0;
        if (r >= lines.length) return null;
        line = lines[r] ?? '';
        while (r < lines.length && (lines[r] ?? '').length === 0) {
          r++;
          c = 0;
        }
        if (r >= lines.length) return null;
        line = lines[r] ?? '';
      }
      // Skip whitespace
      while (c < line.length && /\s/.test(line[c])) c++;
      // Move to end of word
      while (c < line.length - 1 && /\w/.test(line[c + 1])) c++;
    }
    return [r, c];
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
            if (targetCol >= 0 && targetCol < line.length - 1) targetCol++;
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
          const count = state.count || 1;
          if (col + count > line.length) {
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          if (col < line.length) {
            buffer.replaceRange(row, col, row, col + count, char.repeat(count));
          }
          dispatch({ type: 'CLEAR_COUNT' });
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
          executeFind(readType, char, state.count || 1);
          return true;
        }
        default:
          return false;
      }
    },
    [state.pendingCharRead, state.count, buffer, dispatch, executeFind],
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

      // ── INSERT mode ──
      if (state.mode === 'INSERT') {
        return handleInsertModeInput(normalizedKey);
      }

      // ── Pending char read (r, f, F, t, T) ──
      if (state.pendingCharRead && state.mode === 'NORMAL') {
        if (normalizedKey.name === 'escape') {
          dispatch({ type: 'CLEAR_PENDING_STATES' });
          return true;
        }
        if (normalizedKey.sequence) {
          return handleCharRead(normalizedKey.sequence);
        }
        return true;
      }

      // ── NORMAL mode ──
      if (state.mode === 'NORMAL') {
        if (
          normalizedKey.sequence === '?' &&
          buffer.text.length === 0 &&
          state.pendingOperator === null &&
          state.count === 0
        ) {
          return false;
        }

        if (normalizedKey.name === 'escape') {
          if (state.pendingOperator) {
            dispatch({ type: 'CLEAR_PENDING_STATES' });
            return true;
          }
          return false;
        }

        if (
          DIGIT_1_TO_9.test(normalizedKey.sequence) ||
          (normalizedKey.sequence === '0' && state.count > 0)
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
            if (state.pendingOperator === 'c') return handleChangeMovement('h');
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveLeft(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'j': {
            if (state.pendingOperator === 'c') return handleChangeMovement('j');
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveDown(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'k': {
            if (state.pendingOperator === 'c') return handleChangeMovement('k');
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveUp(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'l': {
            if (state.pendingOperator === 'c') return handleChangeMovement('l');
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveRight(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          // ── Word movement (small word) ──
          case 'w': {
            if (state.pendingOperator === 'd')
              return handleOperatorMotion('d', 'w');
            if (state.pendingOperator === 'c')
              return handleOperatorMotion('c', 'w');
            if (state.pendingOperator === 'y')
              return handleOperatorMotion('y', 'w');
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveWordForward(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'b': {
            if (state.pendingOperator === 'd')
              return handleOperatorMotion('d', 'b');
            if (state.pendingOperator === 'c')
              return handleOperatorMotion('c', 'b');
            if (state.pendingOperator === 'y')
              return handleOperatorMotion('y', 'b');
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveWordBackward(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'e': {
            if (state.pendingOperator === 'd')
              return handleOperatorMotion('d', 'e');
            if (state.pendingOperator === 'c')
              return handleOperatorMotion('c', 'e');
            if (state.pendingOperator === 'y')
              return handleOperatorMotion('y', 'e');
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveWordEnd(repeatCount);
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          // ── Word movement (big WORD) ──
          case 'W': {
            if (
              state.pendingOperator === 'd' ||
              state.pendingOperator === 'c' ||
              state.pendingOperator === 'y'
            ) {
              // For now, treat W same as w for operators
              return handleOperatorMotion(state.pendingOperator, 'w');
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
              state.pendingOperator === 'd' ||
              state.pendingOperator === 'c' ||
              state.pendingOperator === 'y'
            ) {
              return handleOperatorMotion(state.pendingOperator, 'b');
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
              state.pendingOperator === 'd' ||
              state.pendingOperator === 'c' ||
              state.pendingOperator === 'y'
            ) {
              return handleOperatorMotion(state.pendingOperator, 'e');
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
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            dispatch({
              type: 'SET_PENDING_CHAR_READ',
              value: normalizedKey.sequence,
            });
            return true;

          case ';': {
            if (state.lastFind) {
              executeFind(
                state.lastFind.type,
                state.lastFind.char,
                repeatCount,
              );
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case ',': {
            if (state.lastFind) {
              // Reverse the find direction
              const reverseMap: Record<string, 'f' | 'F' | 't' | 'T'> = {
                f: 'F',
                F: 'f',
                t: 'T',
                T: 't',
              };
              executeFind(
                reverseMap[state.lastFind.type],
                state.lastFind.char,
                repeatCount,
              );
            }
            dispatch({ type: 'CLEAR_COUNT' });
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
            return true;
          }

          case 'r':
            dispatch({ type: 'SET_PENDING_CHAR_READ', value: 'r' });
            return true;

          case '~': {
            const [startRow, startCol] = buffer.cursor;
            const line = buffer.lines[startRow] ?? '';
            const count = Math.min(repeatCount, line.length - startCol);
            if (count > 0) {
              const toggled = [...line.slice(startCol, startCol + count)]
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
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          case 'u': {
            buffer.undo();
            dispatch({ type: 'CLEAR_COUNT' });
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
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveToLineStart();
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case '$': {
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveToLineEnd();
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case '^': {
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            buffer.vimMoveToFirstNonWhitespace();
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'g': {
            if (state.pendingOperator === 'g') {
              buffer.vimMoveToFirstLine();
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            } else {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: 'g' });
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'G': {
            if (state.pendingOperator) {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
            }
            if (state.count > 0) {
              buffer.vimMoveToLine(state.count);
            } else {
              buffer.vimMoveToLastLine();
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          // ── Delete / Change / Yank operators ──
          case 'd': {
            if (state.pendingOperator === 'd') {
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
            if (state.pendingOperator === 'c') {
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
            if (state.pendingOperator === 'y') {
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
            return true;
          }
          case 'C': {
            executeCommand(CMD_TYPES.CHANGE_TO_EOL, 1);
            dispatch({
              type: 'SET_LAST_COMMAND',
              command: { type: CMD_TYPES.CHANGE_TO_EOL, count: 1 },
            });
            dispatch({ type: 'CLEAR_COUNT' });
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
            return true;
          }

          // ── Join / Indent ──
          case 'J': {
            const [row] = buffer.cursor;
            const lines = buffer.lines;
            const endRow = Math.min(
              row + Math.max(repeatCount - 1, 1),
              lines.length - 1,
            );
            if (row < endRow) {
              let joined = lines[row] ?? '';
              for (let r = row + 1; r <= endRow; r++) {
                joined += ' ' + (lines[r] ?? '').trimStart();
              }
              buffer.replaceRange(
                row,
                0,
                endRow,
                (lines[endRow] ?? '').length,
                joined,
              );
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case '>': {
            if (state.pendingOperator === '>') {
              // >> — indent N lines
              const [startRow] = buffer.cursor;
              const endRow = Math.min(
                startRow + repeatCount - 1,
                buffer.lines.length - 1,
              );
              for (let r = startRow; r <= endRow; r++) {
                buffer.replaceRange(r, 0, r, 0, '  ');
              }
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              dispatch({ type: 'CLEAR_COUNT' });
            } else {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: '>' });
              // Don't clear count — preserve for the second >
            }
            return true;
          }
          case '<': {
            if (state.pendingOperator === '<') {
              // << — outdent N lines
              const [startRow] = buffer.cursor;
              const endRow = Math.min(
                startRow + repeatCount - 1,
                buffer.lines.length - 1,
              );
              for (let r = startRow; r <= endRow; r++) {
                const line = buffer.lines[r] ?? '';
                if (line.startsWith('  ')) {
                  buffer.replaceRange(r, 0, r, 2, '');
                } else if (line.startsWith(' ')) {
                  buffer.replaceRange(r, 0, r, 1, '');
                }
              }
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              dispatch({ type: 'CLEAR_COUNT' });
            } else {
              dispatch({ type: 'SET_PENDING_OPERATOR', operator: '<' });
              // Don't clear count — preserve for the second <
            }
            return true;
          }

          // ── Paste ──
          case 'p': {
            let text = state.yankRegister;
            if (!text) text = readClipboard();
            if (text) {
              const [row, col] = buffer.cursor;
              const line = buffer.lines[row] ?? '';
              if (state.yankLinewise) {
                const normalizedText = text.endsWith('\n') ? text : text + '\n';
                const repeated = normalizedText.repeat(repeatCount);
                buffer.replaceRange(row + 1, 0, row + 1, 0, repeated);
                buffer.vimMoveDown(1);
                buffer.vimMoveToLineStart();
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
                buffer.vimMoveRight(1);
              }
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }
          case 'P': {
            let text = state.yankRegister;
            if (!text) text = readClipboard();
            if (text) {
              const [row, col] = buffer.cursor;
              if (state.yankLinewise) {
                const normalizedText = text.endsWith('\n') ? text : text + '\n';
                const repeated = normalizedText.repeat(repeatCount);
                buffer.replaceRange(row, 0, row, 0, repeated);
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
              }
            }
            dispatch({ type: 'CLEAR_COUNT' });
            return true;
          }

          // ── Dot repeat ──
          case '.': {
            if (state.lastCommand) {
              executeCommand(state.lastCommand.type, state.lastCommand.count);
            }
            dispatch({ type: 'CLEAR_COUNT' });
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
              if (state.pendingOperator === 'c')
                return handleChangeMovement('h');
              if (state.pendingOperator) {
                dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              }
              buffer.vimMoveLeft(repeatCount);
              dispatch({ type: 'CLEAR_COUNT' });
              return true;
            }
            if (normalizedKey.name === 'down') {
              if (state.pendingOperator === 'c')
                return handleChangeMovement('j');
              if (state.pendingOperator) {
                dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              }
              buffer.vimMoveDown(repeatCount);
              dispatch({ type: 'CLEAR_COUNT' });
              return true;
            }
            if (normalizedKey.name === 'up') {
              if (state.pendingOperator === 'c')
                return handleChangeMovement('k');
              if (state.pendingOperator) {
                dispatch({ type: 'SET_PENDING_OPERATOR', operator: null });
              }
              buffer.vimMoveUp(repeatCount);
              dispatch({ type: 'CLEAR_COUNT' });
              return true;
            }
            if (normalizedKey.name === 'right') {
              if (state.pendingOperator === 'c')
                return handleChangeMovement('l');
              if (state.pendingOperator) {
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
      state.mode,
      state.count,
      state.pendingOperator,
      state.lastCommand,
      state.pendingCharRead,
      state.lastFind,
      state.yankRegister,
      state.yankLinewise,
      dispatch,
      getCurrentCount,
      handleChangeMovement,
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
