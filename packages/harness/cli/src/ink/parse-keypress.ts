/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * Keyboard input parser - converts terminal input to key events
 *
 * Uses the termio tokenizer for escape sequence boundary detection,
 * then interprets sequences as keypresses.
 */
import { Buffer } from 'buffer';
import { PASTE_END, PASTE_START } from './termio/csi.js';
import { createTokenizer, type Tokenizer } from './termio/tokenize.js';

// eslint-disable-next-line no-control-regex
const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/;

// eslint-disable-next-line no-control-regex
const FN_KEY_RE =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;

// CSI u (kitty keyboard protocol): ESC [ codepoint [; modifier] u
// Example: ESC[13;2u = Shift+Enter, ESC[27u = Escape (no modifiers)
// Modifier is optional - when absent, defaults to 1 (no modifiers)
//
// Extended Kitty format uses colon sub-fields within params:
//   ESC [ keycode:alternate ; modifier:event_type u
// Example: ESC[57404:53;129:1u = numpad 5 with NumLock on
// We capture the full param groups (including colons) and extract
// the primary (first) value from each in the parsing code.
// eslint-disable-next-line no-control-regex
const CSI_U_RE = /^\x1b\[(\d+(?::\d+)*)(?:;(\d+(?::\d+)*))?u/;

// xterm modifyOtherKeys: ESC [ 27 ; modifier ; keycode ~
// Example: ESC[27;2;13~ = Shift+Enter. Emitted by Ghostty/tmux/xterm when
// modifyOtherKeys=2 is active or via user keybinds, typically over SSH where
// TERM sniffing misses Ghostty and we never push Kitty keyboard mode.
// Note param order is reversed vs CSI u (modifier first, keycode second).
// eslint-disable-next-line no-control-regex
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/;

// -- Terminal response patterns (inbound sequences from the terminal itself) --
// DECRPM: CSI ? Ps ; Pm $ y  — response to DECRQM (request mode)
// eslint-disable-next-line no-control-regex
const DECRPM_RE = /^\x1b\[\?(\d+);(\d+)\$y$/;
// DA1: CSI ? Ps ; ... c  — primary device attributes response
// eslint-disable-next-line no-control-regex
const DA1_RE = /^\x1b\[\?([\d;]*)c$/;
// DA2: CSI > Ps ; ... c  — secondary device attributes response
// eslint-disable-next-line no-control-regex
const DA2_RE = /^\x1b\[>([\d;]*)c$/;
// Kitty keyboard flags: CSI ? flags u  — response to CSI ? u query
// (private ? marker distinguishes from CSI u key events)
// eslint-disable-next-line no-control-regex
const KITTY_FLAGS_RE = /^\x1b\[\?(\d+)u$/;
// DECXCPR cursor position: CSI ? row ; col R
// The ? marker disambiguates from modified F3 keys (Shift+F3 = CSI 1;2 R,
// Ctrl+F3 = CSI 1;5 R, etc.) — plain CSI row;col R is genuinely ambiguous.
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_RE = /^\x1b\[\?(\d+);(\d+)R$/;
// OSC response: OSC code ; data (BEL|ST)
// eslint-disable-next-line no-control-regex
const OSC_RESPONSE_RE = /^\x1b\](\d+);(.*?)(?:\x07|\x1b\\)$/s;
// XTVERSION: DCS > | name ST  — terminal name/version string (answer to CSI > 0 q).
// xterm.js replies "xterm.js(X.Y.Z)"; Ghostty, kitty, iTerm2, etc. reply with
// their own name. Unlike TERM_PROGRAM, this survives SSH since the query/reply
// goes through the pty, not the environment.
// eslint-disable-next-line no-control-regex
const XTVERSION_RE = /^\x1bP>\|(.*?)(?:\x07|\x1b\\)$/s;
// SGR mouse event: CSI < button ; col ; row M (press) or m (release)
// Button codes: 64=wheel-up, 65=wheel-down (0x40 | wheel-bit).
// Button 32=left-drag (0x20 | motion-bit). Plain 0/1/2 = left/mid/right click.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
// C0 controls that cannot appear inside an OSC/DCS string payload. BEL (0x07)
// and ESC (0x1b) are excluded because they terminate it.
// eslint-disable-next-line no-control-regex
const NON_STRING_PAYLOAD_RE = /[\x00-\x06\x08-\x1a\x1c-\x1f]/;

/**
 * Can `chunk` be the continuation of an OSC/DCS string payload?
 *
 * Guards the reassembly below. A chunk that starts with a control or keyboard
 * escape sequence is user input, so it is delivered separately while the head
 * remains pending. Once printable response data has started, embedded controls
 * and key sequences are separated by `extractEmbeddedInput`.
 */
function isStringResponseContinuation(chunk: string): boolean {
  if (!chunk) return true;
  if (NON_STRING_PAYLOAD_RE.test(chunk[0])) return false;
  return (
    chunk[0] !== '\x1b' ||
    chunk.charCodeAt(1) === 0x5c /* ESC \ = ST */
  );
}

/** Return the payload offset for terminal string responses we can sanitize. */
function getStringResponsePayloadOffset(sequence: string): number | undefined {
  return sequence.startsWith('\x1b]') || sequence.startsWith('\x1bP')
    ? 2
    : undefined;
}

/** Remove interleaved keyboard input from an OSC/DCS response token. */
function extractEmbeddedInput(sequence: string, payloadOffset: number): {
  responseSequence: string;
  inputs: string[];
} {
  let responseSequence = sequence.slice(0, payloadOffset);
  const inputs: string[] = [];
  let i = payloadOffset;
  while (i < sequence.length) {
    const char = sequence[i];
    if (NON_STRING_PAYLOAD_RE.test(char)) {
      inputs.push(char);
      i++;
      continue;
    }
    if (char === '\x1b') {
      if (i === sequence.length - 1) {
        responseSequence += char;
        i++;
        continue;
      }
      if (sequence[i + 1] === '\\') {
        responseSequence += '\x1b\\';
        i += 2;
        continue;
      }

      const keyTokenizer = createTokenizer({ x10Mouse: true });
      const [keyToken] = keyTokenizer.feed(sequence.slice(i));
      if (keyToken?.type === 'sequence') {
        inputs.push(keyToken.value);
        i += keyToken.value.length;
        continue;
      }
    }
    responseSequence += char;
    i++;
  }
  return { responseSequence, inputs };
}

/**
 * Max chunks a pending response head may be carried across before giving up.
 * Two carries reassemble a reply split three ways, which is beyond what an SSH
 * hop realistically does to a 25-byte OSC reply. The cap matters because a
 * terminal that starts a reply and never terminates it would otherwise remain
 * pending forever. Interleaved controls and key sequences are delivered while
 * the head is carried, and each still consumes one carry slot.
 */
const MAX_PENDING_RESPONSE_CHUNKS = 2;
/** Max length of a carried-over response head (OSC replies are tiny). */
const MAX_PENDING_RESPONSE_LENGTH = 512;

function createPasteKey(content: string): ParsedKey {
  return {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: content,
    raw: content,
    isPasted: true,
  };
}

/**
 * A response sequence received from the terminal (not a keypress).
 * Emitted in answer to queries like DECRQM, DA1, OSC 11, etc.
 */
export type TerminalResponse =
  /** DECRPM: answer to DECRQM (request DEC private mode status) */
  | { type: 'decrpm'; mode: number; status: number }
  /** DA1: primary device attributes (used as a universal sentinel) */
  | { type: 'da1'; params: number[] }
  /** DA2: secondary device attributes (terminal version info) */
  | { type: 'da2'; params: number[] }
  /** Kitty keyboard protocol: current flags (answer to CSI ? u) */
  | { type: 'kittyKeyboard'; flags: number }
  /** DSR: cursor position report (answer to CSI 6 n) */
  | { type: 'cursorPosition'; row: number; col: number }
  /** OSC response: generic operating-system-command reply (e.g. OSC 11 bg color) */
  | { type: 'osc'; code: number; data: string }
  /** XTVERSION: terminal name/version string (answer to CSI > 0 q).
   *  Example values: "xterm.js(5.5.0)", "ghostty 1.2.0", "iTerm2 3.6". */
  | { type: 'xtversion'; name: string };

/**
 * Try to recognize a sequence token as a terminal response.
 * Returns null if the sequence is not a known response pattern
 * (i.e. it should be treated as a keypress).
 *
 * These patterns are syntactically distinguishable from keyboard input —
 * no physical key produces CSI ? ... c or CSI ? ... $ y, so they can be
 * safely parsed out of the input stream at any time.
 */
function parseTerminalResponse(s: string): TerminalResponse | null {
  // CSI-prefixed responses
  if (s.startsWith('\x1b[')) {
    let m: RegExpExecArray | null;

    if ((m = DECRPM_RE.exec(s))) {
      return {
        type: 'decrpm',
        mode: parseInt(m[1]!, 10),
        status: parseInt(m[2]!, 10),
      };
    }

    if ((m = DA1_RE.exec(s))) {
      return { type: 'da1', params: splitNumericParams(m[1]!) };
    }

    if ((m = DA2_RE.exec(s))) {
      return { type: 'da2', params: splitNumericParams(m[1]!) };
    }

    if ((m = KITTY_FLAGS_RE.exec(s))) {
      return { type: 'kittyKeyboard', flags: parseInt(m[1]!, 10) };
    }

    if ((m = CURSOR_POSITION_RE.exec(s))) {
      return {
        type: 'cursorPosition',
        row: parseInt(m[1]!, 10),
        col: parseInt(m[2]!, 10),
      };
    }

    return null;
  }

  // OSC responses (e.g. OSC 11 ; rgb:... for bg color query)
  if (s.startsWith('\x1b]')) {
    const m = OSC_RESPONSE_RE.exec(s);
    if (m) {
      return { type: 'osc', code: parseInt(m[1]!, 10), data: m[2]! };
    }
  }

  // DCS responses (e.g. XTVERSION: DCS > | name ST)
  if (s.startsWith('\x1bP')) {
    const m = XTVERSION_RE.exec(s);
    if (m) {
      return { type: 'xtversion', name: m[1]! };
    }
  }

  return null;
}

function splitNumericParams(params: string): number[] {
  if (!params) return [];
  return params.split(';').map((p) => parseInt(p, 10));
}

export type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE';
  incomplete: string;
  pasteBuffer: string;
  /**
   * Head of an expected OSC/DCS terminal response that a flush cut in half.
   * Re-prepended to the next chunk so the reply is recognized as a response
   * instead of leaking into the prompt as text.
   */
  pendingResponse?: string;
  /** How many chunks `pendingResponse` has already been carried across. */
  pendingResponseChunks?: number;
  // Internal tokenizer instance
  _tokenizer?: Tokenizer;
};

export const INITIAL_STATE: KeyParseState = {
  mode: 'NORMAL',
  incomplete: '',
  pasteBuffer: '',
};

function inputToString(input: Buffer | string): string {
  if (Buffer.isBuffer(input)) {
    if (input[0]! > 127 && input[1] === undefined) {
      (input[0] as unknown as number) -= 128;
      return '\x1b' + String(input);
    } else {
      return String(input);
    }
  } else if (input !== undefined && typeof input !== 'string') {
    return String(input);
  } else if (!input) {
    return '';
  } else {
    return input;
  }
}

export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input: Buffer | string | null = '',
  isExpectedResponsePrefix: (sequence: string) => boolean = () => false,
): [ParsedInput[], KeyParseState] {
  const isFlush = input === null;
  let inputString = isFlush ? '' : inputToString(input);

  // Reassemble a terminal response whose head was already flushed. The tail
  // arrives here as plain text (`gb:2828/2c2c/3434 ESC \`), so without this it
  // lands in the prompt as user input.
  let pendingResponse = prevState.pendingResponse ?? '';
  let pendingResponseChunks = prevState.pendingResponseChunks ?? 0;
  let releasedPendingInput = '';
  if (!isFlush && pendingResponse) {
    if (!isExpectedResponsePrefix(pendingResponse)) {
      releasedPendingInput = pendingResponse;
      pendingResponse = '';
      pendingResponseChunks = 0;
    } else {
      const withinCarryLimit =
        pendingResponseChunks < MAX_PENDING_RESPONSE_CHUNKS;
      const isContinuation = isStringResponseContinuation(inputString);
      if (
        withinCarryLimit &&
        isContinuation &&
        pendingResponse.length + inputString.length <=
          MAX_PENDING_RESPONSE_LENGTH
      ) {
        inputString = pendingResponse + inputString;
        pendingResponseChunks++;
        pendingResponse = '';
      } else if (withinCarryLimit && !isContinuation) {
        // A user key can arrive between response chunks. Deliver it now, but
        // retain the response head so the following tail is still recognized.
        pendingResponseChunks++;
      } else {
        releasedPendingInput = pendingResponse;
        pendingResponseChunks = 0;
        pendingResponse = '';
      }
    }
  }

  // Get or create tokenizer
  const tokenizer = prevState._tokenizer ?? createTokenizer({ x10Mouse: true });

  // Tokenize the input
  const tokens = isFlush ? tokenizer.flush() : tokenizer.feed(inputString);

  // Convert tokens to parsed keys, handling paste mode
  const keys: ParsedInput[] = releasedPendingInput
    ? [parseKeypress(releasedPendingInput)]
    : [];
  let inPaste = prevState.mode === 'IN_PASTE';
  let pasteBuffer = prevState.pasteBuffer;

  for (const token of tokens) {
    if (token.type === 'sequence') {
      if (token.value === PASTE_START) {
        inPaste = true;
        pasteBuffer = '';
      } else if (token.value === PASTE_END) {
        // Always emit a paste key, even for empty pastes. This allows
        // downstream handlers to detect empty pastes (e.g., for clipboard
        // image handling on macOS). The paste content may be empty string.
        keys.push(createPasteKey(pasteBuffer));
        inPaste = false;
        pasteBuffer = '';
      } else if (inPaste) {
        // Sequences inside paste are treated as literal text
        pasteBuffer += token.value;
      } else {
        const stringResponsePayloadOffset = getStringResponsePayloadOffset(
          token.value,
        );
        const stringSequence =
          stringResponsePayloadOffset !== undefined
            ? extractEmbeddedInput(token.value, stringResponsePayloadOffset)
            : { responseSequence: token.value, inputs: [] };
        const response = parseTerminalResponse(stringSequence.responseSequence);
        if (response) {
          for (const embeddedInput of stringSequence.inputs) {
            keys.push(parseKeypress(embeddedInput));
          }
          keys.push({
            kind: 'response',
            sequence: stringSequence.responseSequence,
            response,
          });
        } else if (
          isFlush &&
          stringResponsePayloadOffset !== undefined &&
          isExpectedResponsePrefix(stringSequence.responseSequence)
        ) {
          // Unterminated terminal response: App's 50ms incomplete-sequence
          // timer fired between the head and the tail of the reply (routine
          // over SSH). Emitting it as a keypress is what put
          // `11;rgb:2828/2c2c/3434` in the prompt — carry the head over to
          // the next chunk instead. The terminal querier confirms that this
          // prefix belongs to an outstanding request, avoiding ambiguity with
          // user input such as Alt+] followed by digits.
          // `incomplete` is empty afterwards, so App stops re-arming the
          // flush timer and nothing spins.
          for (const embeddedInput of stringSequence.inputs) {
            keys.push(parseKeypress(embeddedInput));
          }
          if (
            stringSequence.responseSequence.length <=
            MAX_PENDING_RESPONSE_LENGTH
          ) {
            pendingResponse = stringSequence.responseSequence;
          }
        } else {
          const mouse = parseMouseEvent(token.value);
          if (mouse) {
            keys.push(mouse);
          } else {
            keys.push(parseKeypress(token.value));
          }
        }
      }
    } else if (token.type === 'text') {
      if (inPaste) {
        pasteBuffer += token.value;
      } else if (
        /^\[<\d+;\d+;\d+[Mm]$/.test(token.value) ||
        /^\[M[\x60-\x7f][\x20-\uffff]{2}$/.test(token.value)
      ) {
        // Orphaned SGR/X10 mouse tail (fullscreen only — mouse tracking is off
        // otherwise). A heavy render blocked the event loop past App's 50ms
        // flush timer, so the buffered ESC was flushed as a lone Escape and
        // the continuation `[<btn;col;rowM` arrived as text. Re-synthesize
        // with the ESC prefix so the scroll event still fires instead of
        // leaking into the prompt. The spurious Escape is gone; App.tsx's
        // readableLength check prevents it. The X10 Cb slot is narrowed to
        // the wheel range [\x60-\x7f] (0x40|modifiers + 32) — a full [\x20-]
        // range would match typed input like `[MAX]` batched into one read
        // and silently drop it as a phantom click. Click/drag orphans leak
        // as visible garbage instead; deletable garbage beats silent loss.
        const resynthesized = '\x1b' + token.value;
        const mouse = parseMouseEvent(resynthesized);
        keys.push(mouse ?? parseKeypress(resynthesized));
      } else if (/^\[\d+(?::\d+)*(?:;\d+(?::\d+)*)?u$/.test(token.value)) {
        // Orphaned CSI u tail — same flush-race as SGR mouse above. The
        // tokenizer flushed the buffered ESC as a lone Escape, and the
        // continuation `[57411;129u` or `[57404:53;129:1u` arrived as text.
        // Re-synthesize with the ESC prefix so it parses as a proper CSI u
        // keypress instead of leaking raw text like `;129u` into the prompt.
        const resynthesized = '\x1b' + token.value;
        keys.push(parseKeypress(resynthesized));
      } else {
        if (token.value === '\r\n') {
          keys.push(parseKeypress('\r'));
        } else {
          keys.push(parseKeypress(token.value));
        }
      }
    }
  }

  // If flushing and still in paste mode, emit content once and always leave
  // paste mode. An empty unterminated paste must not re-arm forever.
  if (isFlush && inPaste) {
    if (pasteBuffer) {
      keys.push(createPasteKey(pasteBuffer));
    }
    inPaste = false;
    pasteBuffer = '';
  }

  // Build new state
  const incomplete = tokenizer.buffer();
  const newState: KeyParseState = {
    mode: inPaste ? 'IN_PASTE' : 'NORMAL',
    incomplete,
    pasteBuffer,
    pendingResponse,
    // Keep the carry count while the reply is still in flight — stashed here
    // or buffered in the tokenizer after a re-prepend — so the limit actually
    // bites. Reset once the stream is clean so the next reply starts fresh.
    pendingResponseChunks:
      pendingResponse || incomplete ? pendingResponseChunks : 0,
    _tokenizer: tokenizer,
  };

  return [keys, newState];
}

const keyName: Record<string, string> = {
  /* xterm/gnome ESC O letter */
  OP: 'f1',
  OQ: 'f2',
  OR: 'f3',
  OS: 'f4',
  /* Application keypad mode (numpad digits 0-9) */
  Op: '0',
  Oq: '1',
  Or: '2',
  Os: '3',
  Ot: '4',
  Ou: '5',
  Ov: '6',
  Ow: '7',
  Ox: '8',
  Oy: '9',
  /* Application keypad mode (numpad operators) */
  Oj: '*',
  Ok: '+',
  Ol: ',',
  Om: '-',
  On: '.',
  Oo: '/',
  OM: 'return',
  /* xterm/rxvt ESC [ number ~ */
  '[11~': 'f1',
  '[12~': 'f2',
  '[13~': 'f3',
  '[14~': 'f4',
  /* from Cygwin and used in libuv */
  '[[A': 'f1',
  '[[B': 'f2',
  '[[C': 'f3',
  '[[D': 'f4',
  '[[E': 'f5',
  /* common */
  '[15~': 'f5',
  '[17~': 'f6',
  '[18~': 'f7',
  '[19~': 'f8',
  '[20~': 'f9',
  '[21~': 'f10',
  '[23~': 'f11',
  '[24~': 'f12',
  /* xterm ESC [ letter */
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  '[E': 'clear',
  '[F': 'end',
  '[H': 'home',
  /* xterm/gnome ESC O letter */
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  OE: 'clear',
  OF: 'end',
  OH: 'home',
  /* xterm/rxvt ESC [ number ~ */
  '[1~': 'home',
  '[2~': 'insert',
  '[3~': 'delete',
  '[4~': 'end',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  /* putty */
  '[[5~': 'pageup',
  '[[6~': 'pagedown',
  /* rxvt */
  '[7~': 'home',
  '[8~': 'end',
  /* rxvt keys with modifiers */
  '[a': 'up',
  '[b': 'down',
  '[c': 'right',
  '[d': 'left',
  '[e': 'clear',

  '[2$': 'insert',
  '[3$': 'delete',
  '[5$': 'pageup',
  '[6$': 'pagedown',
  '[7$': 'home',
  '[8$': 'end',

  Oa: 'up',
  Ob: 'down',
  Oc: 'right',
  Od: 'left',
  Oe: 'clear',

  '[2^': 'insert',
  '[3^': 'delete',
  '[5^': 'pageup',
  '[6^': 'pagedown',
  '[7^': 'home',
  '[8^': 'end',
  /* misc. */
  '[Z': 'tab',
};

export const nonAlphanumericKeys = [
  // Filter out single-character values (digits, operators from numpad) since
  // those are printable characters that should produce input
  ...Object.values(keyName).filter((v) => v.length > 1),
  // escape and backspace are assigned directly in parseKeypress (not via the
  // keyName map), so the spread above misses them. Without these, ctrl+escape
  // via Kitty/modifyOtherKeys leaks the literal word "escape" as input text
  // (input-event.ts:58 assigns keypress.name when ctrl is set).
  'escape',
  'backspace',
  'wheelup',
  'wheeldown',
  'mouse',
  // Kitty keyboard protocol functional keys (F13-F35) not in keyName map
  'f13',
  'f14',
  'f15',
  'f16',
  'f17',
  'f18',
  'f19',
  'f20',
  'f21',
  'f22',
  'f23',
  'f24',
  'f25',
  'f26',
  'f27',
  'f28',
  'f29',
  'f30',
  'f31',
  'f32',
  'f33',
  'f34',
  'f35',
];

const isShiftKey = (code: string): boolean => {
  return [
    '[a',
    '[b',
    '[c',
    '[d',
    '[e',
    '[2$',
    '[3$',
    '[5$',
    '[6$',
    '[7$',
    '[8$',
    '[Z',
  ].includes(code);
};

const isCtrlKey = (code: string): boolean => {
  return [
    'Oa',
    'Ob',
    'Oc',
    'Od',
    'Oe',
    '[2^',
    '[3^',
    '[5^',
    '[6^',
    '[7^',
    '[8^',
  ].includes(code);
};

/**
 * Decode XTerm-style modifier value to individual flags.
 * Modifier encoding: 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0) + (super ? 8 : 0)
 *
 * Note: `meta` here means Alt/Option (bit 2). `super` is a distinct
 * modifier (bit 8, i.e. Cmd on macOS / Win key). Most legacy terminal
 * sequences can't express super — it only arrives via kitty keyboard
 * protocol (CSI u) or xterm modifyOtherKeys.
 */
function decodeModifier(modifier: number): {
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  super: boolean;
} {
  const m = modifier - 1;
  return {
    shift: !!(m & 1),
    meta: !!(m & 2),
    ctrl: !!(m & 4),
    super: !!(m & 8),
  };
}

/**
 * Is `keycode` a printable text character rather than a functional key?
 *
 * Kitty keyboard protocol keycodes are the Unicode codepoint of the produced
 * character for text keys. Only ASCII (32–126) used to be decoded; anything
 * above 126 fell through as an unmapped functional key and was swallowed, so
 * a CJK character arriving as CSI u (e.g. ESC[19968u for U+4E00) could not
 * be restored as insertable text.
 */
function isPrintableTextCodepoint(keycode: number): boolean {
  // C0 controls and DEL
  if (keycode < 32 || keycode === 127) return false;
  // C1 controls
  if (keycode >= 128 && keycode <= 159) return false;
  // Lone surrogates are not valid text
  if (keycode >= 0xd800 && keycode <= 0xdfff) return false;
  if (keycode > 0x10ffff) return false;
  // Kitty functional keys live in the low Private Use Area (57344–57498);
  // those are matched explicitly above, and the rest of the block must stay
  // unmapped rather than decode to an invisible PUA character.
  if (keycode >= 57344 && keycode <= 57498) return false;
  return true;
}

/**
 * Map keycode to key name for modifyOtherKeys/CSI u sequences.
 * Handles both ASCII keycodes and Kitty keyboard protocol functional keys.
 *
 * Numpad codepoints are from Unicode Private Use Area, defined at:
 * https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional-key-definitions
 */
function keycodeToName(keycode: number): string | undefined {
  switch (keycode) {
    case 9:
      return 'tab';
    case 13:
      return 'return';
    case 27:
      return 'escape';
    case 32:
      return 'space';
    case 127:
      return 'backspace';
    // Kitty keyboard protocol numpad keys (KP_0 through KP_9)
    case 57399:
      return '0';
    case 57400:
      return '1';
    case 57401:
      return '2';
    case 57402:
      return '3';
    case 57403:
      return '4';
    case 57404:
      return '5';
    case 57405:
      return '6';
    case 57406:
      return '7';
    case 57407:
      return '8';
    case 57408:
      return '9';
    case 57409: // KP_DECIMAL
      return '.';
    case 57410: // KP_DIVIDE
      return '/';
    case 57411: // KP_MULTIPLY
      return '*';
    case 57412: // KP_SUBTRACT
      return '-';
    case 57413: // KP_ADD
      return '+';
    case 57414: // KP_ENTER
      return 'return';
    case 57415: // KP_EQUAL
      return '=';
    // Kitty KP navigation and separator keys
    case 57416: // KP_SEPARATOR (typically comma on numpad)
      return ',';
    case 57417: // KP_LEFT
      return 'left';
    case 57418: // KP_RIGHT
      return 'right';
    case 57419: // KP_UP
      return 'up';
    case 57420: // KP_DOWN
      return 'down';
    case 57421: // KP_PAGE_UP
      return 'pageup';
    case 57422: // KP_PAGE_DOWN
      return 'pagedown';
    case 57423: // KP_HOME
      return 'home';
    case 57424: // KP_END
      return 'end';
    case 57425: // KP_INSERT
      return 'insert';
    case 57426: // KP_DELETE
      return 'delete';
    case 57427: // KP_BEGIN (numpad 5 without NumLock)
      return 'clear';
    // Lock keys, Print Screen, Pause, Menu — swallow (no text output)
    case 57358: // CAPS_LOCK
    case 57359: // SCROLL_LOCK
    case 57360: // NUM_LOCK
    case 57361: // PRINT_SCREEN
    case 57362: // PAUSE
    case 57363: // MENU
      return undefined;
    // Function keys F13-F35
    case 57376:
      return 'f13';
    case 57377:
      return 'f14';
    case 57378:
      return 'f15';
    case 57379:
      return 'f16';
    case 57380:
      return 'f17';
    case 57381:
      return 'f18';
    case 57382:
      return 'f19';
    case 57383:
      return 'f20';
    case 57384:
      return 'f21';
    case 57385:
      return 'f22';
    case 57386:
      return 'f23';
    case 57387:
      return 'f24';
    case 57388:
      return 'f25';
    case 57389:
      return 'f26';
    case 57390:
      return 'f27';
    case 57391:
      return 'f28';
    case 57392:
      return 'f29';
    case 57393:
      return 'f30';
    case 57394:
      return 'f31';
    case 57395:
      return 'f32';
    case 57396:
      return 'f33';
    case 57397:
      return 'f34';
    case 57398:
      return 'f35';
    // Modifier-only keys — swallow (no text output). These fire when a
    // modifier key is pressed/released alone under Kitty keyboard protocol
    // with report-all-keys or report-associated-text flags.
    case 57428: // LEFT_SHIFT
    case 57429: // LEFT_CONTROL
    case 57430: // LEFT_ALT
    case 57431: // LEFT_SUPER
    case 57432: // LEFT_HYPER
    case 57433: // LEFT_META
    case 57434: // RIGHT_SHIFT
    case 57435: // RIGHT_CONTROL
    case 57436: // RIGHT_ALT
    case 57437: // RIGHT_SUPER
    case 57438: // RIGHT_HYPER
    case 57439: // RIGHT_META
      return undefined;
    default:
      // Printable ASCII characters
      if (keycode >= 32 && keycode <= 126) {
        return String.fromCharCode(keycode).toLowerCase();
      }
      // Printable non-ASCII text codepoints (CJK, accented letters, emoji, …).
      // Returned as-is — unlike ASCII letters there is no lowercase base form
      // for the CSI u encoding to normalize to.
      if (isPrintableTextCodepoint(keycode)) {
        return String.fromCodePoint(keycode);
      }
      return undefined;
  }
}

export type ParsedKey = {
  kind: 'key';
  fn: boolean;
  name: string | undefined;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  super: boolean;
  sequence: string | undefined;
  raw: string | undefined;
  code?: string;
  isPasted: boolean;
};

/** A terminal response sequence (DECRPM, DA1, OSC reply, etc.) parsed
 *  out of the input stream. Not user input — consumers should dispatch
 *  to a response handler. */
export type ParsedResponse = {
  kind: 'response';
  /** Raw escape sequence bytes, for debugging/logging */
  sequence: string;
  response: TerminalResponse;
};

/** SGR mouse event with coordinates. Emitted for clicks, drags, and
 *  releases (wheel events remain ParsedKey). col/row are 1-indexed
 *  from the terminal sequence (CSI < btn;col;row M/m). */
export type ParsedMouse = {
  kind: 'mouse';
  /** Raw SGR button code. Low 2 bits = button (0=left,1=mid,2=right),
   *  bit 5 (0x20) = drag/motion, bit 6 (0x40) = wheel. */
  button: number;
  /** 'press' for M terminator, 'release' for m terminator */
  action: 'press' | 'release';
  /** 1-indexed column (from terminal) */
  col: number;
  /** 1-indexed row (from terminal) */
  row: number;
  sequence: string;
};

/** Everything that can come out of the input parser: a user keypress/paste,
 *  a mouse click/drag event, or a terminal response to a query we sent. */
export type ParsedInput = ParsedKey | ParsedMouse | ParsedResponse;

/**
 * Parse an SGR mouse event sequence into a ParsedMouse, or null if not a
 * mouse event or if it's a wheel event (wheel stays as ParsedKey for the
 * keybinding system). Button bit 0x40 = wheel, bit 0x20 = drag/motion.
 */
function parseMouseEvent(s: string): ParsedMouse | null {
  const match = SGR_MOUSE_RE.exec(s);
  if (!match) return null;
  const button = parseInt(match[1]!, 10);
  // Wheel events (bit 6 set, low bits 0/1 for up/down) stay as ParsedKey
  // so the keybinding system can route them to scroll handlers.
  if ((button & 0x40) !== 0) return null;
  return {
    kind: 'mouse',
    button,
    action: match[4] === 'M' ? 'press' : 'release',
    col: parseInt(match[2]!, 10),
    row: parseInt(match[3]!, 10),
    sequence: s,
  };
}

function parseKeypress(s: string = ''): ParsedKey {
  let parts;

  const key: ParsedKey = {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: s,
    raw: s,
    isPasted: false,
  };

  key.sequence = key.sequence || s || key.name;

  // Handle CSI u (kitty keyboard protocol): ESC [ codepoint [; modifier] u
  // Example: ESC[13;2u = Shift+Enter, ESC[27u = Escape (no modifiers)
  // Extended Kitty format: ESC[keycode:alternate;modifier:event_type u
  // Example: ESC[57404:53;129:1u = numpad 5 with NumLock (modifier 129 = 1+128)
  let match: RegExpExecArray | null;
  if ((match = CSI_U_RE.exec(s))) {
    // Extract primary value from colon-separated sub-fields
    // e.g., "57404:53" → 57404 (keycode), "129:1" → 129 (modifier)
    const codepointStr = match[1]!.split(':')[0]!;
    const codepoint = parseInt(codepointStr, 10);
    // Modifier defaults to 1 (no modifiers) when not present.
    // Strip colon sub-fields (event_type) from modifier param too.
    const modifierStr = match[2] ? match[2].split(':')[0]! : '1';
    let modifier = parseInt(modifierStr, 10);
    // Strip the NumLock bit (bit 7, value 128). Kitty encodes NumLock state
    // in modifier bit 7: NumLock ON → modifier += 128. e.g., no other mods +
    // NumLock = 1 + 128 = 129. This bit is informational only — we don't want
    // it to pollute shift/ctrl/meta/super detection.
    modifier = modifier & ~128;
    // Also strip Caps Lock bit (bit 6, value 64) for the same reason.
    modifier = modifier & ~64;
    const mods = decodeModifier(modifier);
    const name = keycodeToName(codepoint);
    return {
      kind: 'key',
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    };
  }

  // Handle xterm modifyOtherKeys: ESC [ 27 ; modifier ; keycode ~
  // Must run before FN_KEY_RE — FN_KEY_RE only allows 2 params before ~ and
  // would leave the tail as garbage if it partially matched.
  if ((match = MODIFY_OTHER_KEYS_RE.exec(s))) {
    const mods = decodeModifier(parseInt(match[1]!, 10));
    const name = keycodeToName(parseInt(match[2]!, 10));
    return {
      kind: 'key',
      name,
      fn: false,
      ctrl: mods.ctrl,
      meta: mods.meta,
      shift: mods.shift,
      option: false,
      super: mods.super,
      sequence: s,
      raw: s,
      isPasted: false,
    };
  }

  // SGR mouse wheel events. Click/drag/release events are handled
  // earlier by parseMouseEvent and emitted as ParsedMouse, so they
  // never reach here. Mask with 0x43 (bits 6+1+0) to check wheel-flag
  // + direction while ignoring modifier bits (Shift=0x04, Meta=0x08,
  // Ctrl=0x10) — modified wheel events (e.g. Ctrl+scroll, button=80)
  // should still be recognized as wheelup/wheeldown.
  if ((match = SGR_MOUSE_RE.exec(s))) {
    const button = parseInt(match[1]!, 10);
    if ((button & 0x43) === 0x40) return createNavKey(s, 'wheelup', false);
    if ((button & 0x43) === 0x41) return createNavKey(s, 'wheeldown', false);
    // Shouldn't reach here (parseMouseEvent catches non-wheel) but be safe
    return createNavKey(s, 'mouse', false);
  }

  // X10 mouse: CSI M + 3 raw bytes (Cb+32, Cx+32, Cy+32). Terminals that
  // ignore DECSET 1006 (SGR) but honor 1000/1002 emit this legacy encoding.
  // Button bits match SGR: 0x40 = wheel, low bit = direction. Non-wheel
  // X10 events (clicks/drags) are swallowed here — we only enable mouse
  // tracking in alt-screen and only need wheel for ScrollBox.
  if (s.length === 6 && s.startsWith('\x1b[M')) {
    const button = s.charCodeAt(3) - 32;
    if ((button & 0x43) === 0x40) return createNavKey(s, 'wheelup', false);
    if ((button & 0x43) === 0x41) return createNavKey(s, 'wheeldown', false);
    return createNavKey(s, 'mouse', false);
  }

  // The ESC-prefixed variants are how a terminal without kitty keyboard protocol
  // or modifyOtherKeys encodes Alt+<key> ("meta sends escape"). Terminal.app with
  // "Use Option as Meta key" sends ESC CR for Option+Enter, and terminals whose
  // Enter emits CRLF send ESC CR LF. Without these, the sequence matches nothing
  // below (META_KEY_CODE_RE only covers ESC+alphanumeric) and falls through as a
  // nameless, insertable key — which the coalesced-submit path then sends as a
  // message. Bare CRLF is already normalized to CR before parseKeypress sees it.
  //
  // ESC TAB is deliberately NOT handled here: naming it would make Option+Tab a
  // real {name:'tab', alt:true}, and handlers that test `key.name === 'tab'`
  // without checking modifiers (ghost-text acceptance in InputPrompt, the
  // ModelDialog persist toggle, several dialogs) would start firing on it.
  if (s === '\r' || s === '\x1b\r' || s === '\x1b\r\n') {
    key.name = 'return';
    key.meta = s.charAt(0) === '\x1b';
    if (!key.meta) {
      key.raw = undefined;
    }
  } else if (s === '\n' || s === '\x1b\n') {
    key.name = 'enter';
    key.meta = s.charAt(0) === '\x1b';
  } else if (s === '\t') {
    key.name = 'tab';
  } else if (s === '\b' || s === '\x1b\b') {
    key.name = 'backspace';
    key.meta = s.charAt(0) === '\x1b';
  } else if (s === '\x7f' || s === '\x1b\x7f') {
    key.name = 'backspace';
    key.meta = s.charAt(0) === '\x1b';
  } else if (s === '\x1b' || s === '\x1b\x1b') {
    key.name = 'escape';
    key.meta = s.length === 2;
  } else if (s === ' ' || s === '\x1b ') {
    key.name = 'space';
    key.meta = s.length === 2;
  } else if (s === '\x1f') {
    key.name = '_';
    key.ctrl = true;
  } else if (s <= '\x1a' && s.length === 1) {
    key.name = String.fromCharCode(s.charCodeAt(0) + 'a'.charCodeAt(0) - 1);
    key.ctrl = true;
  } else if (s.length === 1 && s >= '0' && s <= '9') {
    key.name = 'number';
  } else if (s.length === 1 && s >= 'a' && s <= 'z') {
    key.name = s;
  } else if (s.length === 1 && s >= 'A' && s <= 'Z') {
    key.name = s.toLowerCase();
    key.shift = true;
  } else if (s.length === 1 && s >= '!' && s <= '~') {
    // Legacy terminal input does not carry modifier metadata for printable
    // punctuation. Preserve the emitted character as the key name so
    // punctuation shortcuts (for example `?`) can still be matched.
    key.name = s;
  } else if ((parts = META_KEY_CODE_RE.exec(s))) {
    key.name = parts[1]!.toLowerCase();
    key.meta = true;
    key.shift = /^[A-Z]$/.test(parts[1]!);
  } else if ((parts = FN_KEY_RE.exec(s))) {
    const segs = [...s];

    if (segs[0] === '\u001b' && segs[1] === '\u001b') {
      key.option = true;
    }

    const code = [parts[1], parts[2], parts[4], parts[6]]
      .filter(Boolean)
      .join('');

    const modifier = ((parts[3] || parts[5] || 1) as number) - 1;

    key.ctrl = !!(modifier & 4);
    key.meta = !!(modifier & 2);
    key.super = !!(modifier & 8);
    key.shift = !!(modifier & 1);
    key.code = code;

    key.name = keyName[code];
    key.shift = isShiftKey(code) || key.shift;
    key.ctrl = isCtrlKey(code) || key.ctrl;
  }

  // iTerm in natural text editing mode
  if (key.raw === '\x1Bb') {
    key.meta = true;
    key.name = 'left';
  } else if (key.raw === '\x1Bf') {
    key.meta = true;
    key.name = 'right';
  }

  switch (s) {
    case '\u001b[1~':
      return createNavKey(s, 'home', false);
    case '\u001b[4~':
      return createNavKey(s, 'end', false);
    case '\u001b[5~':
      return createNavKey(s, 'pageup', false);
    case '\u001b[6~':
      return createNavKey(s, 'pagedown', false);
    case '\u001b[1;5D':
      return createNavKey(s, 'left', true);
    case '\u001b[1;5C':
      return createNavKey(s, 'right', true);
  }

  return key;
}

function createNavKey(s: string, name: string, ctrl: boolean): ParsedKey {
  return {
    kind: 'key',
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    super: false,
    fn: false,
    sequence: s,
    raw: s,
    isPasted: false,
  };
}
