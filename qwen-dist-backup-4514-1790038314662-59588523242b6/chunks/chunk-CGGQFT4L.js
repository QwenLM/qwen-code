// Force strict mode and setup for ESM
"use strict";
import {
  BACKSLASH_ENTER_DETECTION_WINDOW_MS,
  CHAR_CODE_ESC,
  KITTY_CTRL_C,
  KITTY_KEYCODE_BACKSPACE,
  KITTY_KEYCODE_ENTER,
  KITTY_KEYCODE_NUMPAD_ENTER,
  KITTY_KEYCODE_TAB,
  KITTY_MODIFIER_BASE,
  KITTY_MODIFIER_EVENT_TYPES_OFFSET,
  MAX_KITTY_SEQUENCE_LENGTH,
  MODIFIER_ALT_BIT,
  MODIFIER_CTRL_BIT,
  MODIFIER_SHIFT_BIT,
  MODIFIER_SUPER_BIT,
  clipboardHasImage
} from "./chunk-X3T5IOX6.js";
import {
  noteInteraction
} from "./chunk-KW7NOTN6.js";
import {
  require_jsx_runtime
} from "./chunk-SV5PQVQE.js";
import {
  use_stdin_default,
  use_stdout_default
} from "./chunk-ZTBP4SFC.js";
import {
  require_react
} from "./chunk-5QWWOFGG.js";
import {
  KittySequenceOverflowEvent,
  logKittySequenceOverflow
} from "./chunk-KKGSJZWK.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/hooks/useKeypress.ts
init_esbuild_shims();
var import_react3 = __toESM(require_react(), 1);

// packages/cli/src/ui/contexts/KeypressContext.tsx
init_esbuild_shims();
var import_react2 = __toESM(require_react(), 1);
import readline from "node:readline";
import { PassThrough } from "node:stream";

// packages/cli/src/ui/utils/mouse.ts
init_esbuild_shims();
var ESC = "\x1B";
var SGR_EVENT_PREFIX = `${ESC}[<`;
var X11_EVENT_PREFIX = `${ESC}[M`;
var MAX_SGR_MOUSE_SEQUENCE_LENGTH = 50;
var SGR_MOUSE_REGEX = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/;
function getEventName(buttonCode, isRelease) {
  const isMove = (buttonCode & 32) !== 0;
  if (buttonCode === 66) return "scroll-left";
  if (buttonCode === 67) return "scroll-right";
  if ((buttonCode & 64) === 64) {
    return (buttonCode & 1) === 0 ? "scroll-up" : "scroll-down";
  }
  if (isMove) return "move";
  const button = buttonCode & 3;
  const type = isRelease ? "release" : "press";
  switch (button) {
    case 0:
      return `left-${type}`;
    case 1:
      return `middle-${type}`;
    case 2:
      return `right-${type}`;
    default:
      return null;
  }
}
__name(getEventName, "getEventName");
function buttonFromCode(code) {
  switch (code & 3) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
}
__name(buttonFromCode, "buttonFromCode");
function parseSGRMouseEvent(buffer) {
  const match = buffer.match(SGR_MOUSE_REGEX);
  if (!match) return null;
  const buttonCode = parseInt(match[1], 10);
  const col = parseInt(match[2], 10);
  const row = parseInt(match[3], 10);
  const isRelease = match[4] === "m";
  const name = getEventName(buttonCode, isRelease);
  if (!name) return null;
  return {
    event: {
      name,
      col,
      row,
      shift: (buttonCode & 4) !== 0,
      meta: (buttonCode & 8) !== 0,
      ctrl: (buttonCode & 16) !== 0,
      button: buttonFromCode(buttonCode)
    },
    length: match[0].length
  };
}
__name(parseSGRMouseEvent, "parseSGRMouseEvent");
var ENABLE_SGR_MOUSE = {
  button: "\x1B[?1002h\x1B[?1006h",
  any: "\x1B[?1003h\x1B[?1006h"
};
var DISABLE_SGR_MOUSE = {
  button: "\x1B[?1006l\x1B[?1002l",
  any: "\x1B[?1006l\x1B[?1003l"
};
function enableMouseEvents(stdout, tracking = "button") {
  stdout.write(ENABLE_SGR_MOUSE[tracking]);
}
__name(enableMouseEvents, "enableMouseEvents");
function disableMouseEvents(stdout, tracking = "button") {
  stdout.write(DISABLE_SGR_MOUSE[tracking]);
}
__name(disableMouseEvents, "disableMouseEvents");

// packages/cli/src/ui/hooks/useFocus.ts
init_esbuild_shims();
var import_react = __toESM(require_react(), 1);
var ENABLE_FOCUS_REPORTING = "\x1B[?1004h";
var DISABLE_FOCUS_REPORTING = "\x1B[?1004l";
var FOCUS_IN = "\x1B[I";
var FOCUS_OUT = "\x1B[O";
var useFocus = /* @__PURE__ */ __name(() => {
  const { stdin } = use_stdin_default();
  const { stdout } = use_stdout_default();
  const [isFocused, setIsFocused] = (0, import_react.useState)(true);
  (0, import_react.useEffect)(() => {
    const handleData = /* @__PURE__ */ __name((data) => {
      const sequence = data.toString();
      const lastFocusIn = sequence.lastIndexOf(FOCUS_IN);
      const lastFocusOut = sequence.lastIndexOf(FOCUS_OUT);
      if (lastFocusIn > lastFocusOut) {
        setIsFocused(true);
      } else if (lastFocusOut > lastFocusIn) {
        setIsFocused(false);
      }
    }, "handleData");
    stdout?.write(ENABLE_FOCUS_REPORTING);
    stdin?.on("data", handleData);
    return () => {
      stdout?.write(DISABLE_FOCUS_REPORTING);
      stdin?.removeListener("data", handleData);
    };
  }, [stdin, stdout]);
  useKeypress(
    (_) => {
      if (!isFocused) {
        setIsFocused(true);
      }
    },
    { isActive: true }
  );
  return isFocused;
}, "useFocus");

// packages/cli/src/ui/contexts/KeypressContext.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var ESC2 = "\x1B";
var OPTION_COMPOSED_GLYPHS = {
  "\u2020": "t",
  // Option+t → "expand thinking"
  "\u221A": "v"
  // Option+v → paste clipboard image
};
var PASTE_MODE_PREFIX = `${ESC2}[200~`;
var PASTE_MODE_SUFFIX = `${ESC2}[201~`;
var KITTY_SEQUENCE_TIMEOUT_MS = 200;
var PASTE_IDLE_TIMEOUT_MS = 1e3;
var KITTY_KEYPAD_PRINTABLE_KEYCODE_TO_CHAR = {
  57399: "0",
  57400: "1",
  57401: "2",
  57402: "3",
  57403: "4",
  57404: "5",
  57405: "6",
  57406: "7",
  57407: "8",
  57408: "9",
  57409: ".",
  57410: "/",
  57411: "*",
  57412: "-",
  57413: "+",
  // 57414 is keypad Enter - handled separately via CSI~ sequence
  57415: "=",
  57416: ","
};
var KITTY_KEYPAD_FUNCTIONAL_KEYCODE_TO_NAME = {
  57417: "left",
  57418: "right",
  57419: "up",
  57420: "down",
  57421: "pageup",
  57422: "pagedown",
  57423: "home",
  57424: "end",
  57425: "insert",
  57426: "delete"
};
var KeypressContext = (0, import_react2.createContext)(
  void 0
);
var debugLogger = createDebugLogger("KEYPRESS");
function useKeypressContext() {
  const context = (0, import_react2.useContext)(KeypressContext);
  if (!context) {
    throw new Error(
      "useKeypressContext must be used within a KeypressProvider"
    );
  }
  return context;
}
__name(useKeypressContext, "useKeypressContext");
function KeypressProvider({
  children,
  kittyProtocolEnabled,
  pasteWorkaround = false,
  config,
  debugKeystrokeLogging,
  initialCapturedInput
}) {
  const { stdin, setRawMode } = use_stdin_default();
  const subscribers = (0, import_react2.useRef)(/* @__PURE__ */ new Set()).current;
  const mouseSubscribers = (0, import_react2.useRef)(/* @__PURE__ */ new Set()).current;
  const [pasteProgress, setPasteProgress] = (0, import_react2.useState)({
    active: false,
    receivedBytes: 0
  });
  const subscribe = (0, import_react2.useCallback)(
    (handler) => {
      subscribers.add(handler);
    },
    [subscribers]
  );
  const unsubscribe = (0, import_react2.useCallback)(
    (handler) => {
      subscribers.delete(handler);
    },
    [subscribers]
  );
  const subscribeMouse = (0, import_react2.useCallback)(
    (handler) => {
      mouseSubscribers.add(handler);
    },
    [mouseSubscribers]
  );
  const unsubscribeMouse = (0, import_react2.useCallback)(
    (handler) => {
      mouseSubscribers.delete(handler);
    },
    [mouseSubscribers]
  );
  (0, import_react2.useEffect)(() => {
    setRawMode(true);
    const capturedInput = initialCapturedInput ?? Buffer.alloc(0);
    const keypressStream = new PassThrough();
    let usePassthrough = false;
    if (pasteWorkaround) {
      usePassthrough = true;
    }
    let isPaste = false;
    let pasteChunks = [];
    let pasteAlreadyFlushed = false;
    let pasteIdleTimeout = null;
    let lastPasteChunkAt = 0;
    const kittySequenceBufferRef = { current: "" };
    let kittySequenceTimeout = null;
    let backslashTimeout = null;
    let waitingForEnterAfterBackslash = false;
    let rawDataBuffer = Buffer.alloc(0);
    let rawFlushTimeout = null;
    let swallowingSgrMouse = false;
    let sgrMouseBuffer = "";
    let sgrMouseTimeout = null;
    const resetSgrMouse = /* @__PURE__ */ __name(() => {
      swallowingSgrMouse = false;
      sgrMouseBuffer = "";
      if (sgrMouseTimeout) {
        clearTimeout(sgrMouseTimeout);
        sgrMouseTimeout = null;
      }
    }, "resetSgrMouse");
    const updateKittyBuffer = /* @__PURE__ */ __name((value) => {
      kittySequenceBufferRef.current = value;
    }, "updateKittyBuffer");
    const clearKittyTimeout = /* @__PURE__ */ __name(() => {
      if (kittySequenceTimeout) {
        clearTimeout(kittySequenceTimeout);
        kittySequenceTimeout = null;
      }
    }, "clearKittyTimeout");
    const startKittyTimeout = /* @__PURE__ */ __name(() => {
      clearKittyTimeout();
      kittySequenceTimeout = setTimeout(() => {
        if (kittySequenceBufferRef.current) {
          while (kittySequenceBufferRef.current) {
            const parsed = parseKittyPrefix(kittySequenceBufferRef.current);
            if (parsed) {
              kittySequenceBufferRef.current = kittySequenceBufferRef.current.slice(parsed.length);
              broadcast(parsed.key);
              continue;
            }
            const plain = parsePlainTextPrefix(kittySequenceBufferRef.current);
            if (plain) {
              kittySequenceBufferRef.current = kittySequenceBufferRef.current.slice(plain.length);
              broadcast(plain.key);
              continue;
            }
            break;
          }
          if (kittySequenceBufferRef.current) {
            if (debugKeystrokeLogging) {
              debugLogger.debug(
                "[DEBUG] Kitty buffer timeout, clearing:",
                kittySequenceBufferRef.current
              );
            }
            kittySequenceBufferRef.current = "";
          }
        }
      }, KITTY_SEQUENCE_TIMEOUT_MS);
    }, "startKittyTimeout");
    const clearKittyBufferAndTimeout = /* @__PURE__ */ __name(() => {
      clearKittyTimeout();
      kittySequenceBufferRef.current = "";
    }, "clearKittyBufferAndTimeout");
    const clearPasteIdleTimeout = /* @__PURE__ */ __name(() => {
      if (pasteIdleTimeout) {
        clearTimeout(pasteIdleTimeout);
        pasteIdleTimeout = null;
      }
    }, "clearPasteIdleTimeout");
    const forceFlushStuckPaste = /* @__PURE__ */ __name(() => {
      clearPasteIdleTimeout();
      if (!isPaste && pasteChunks.length === 0) return;
      const buffered = pasteChunks.join("");
      isPaste = false;
      pasteChunks = [];
      pasteAlreadyFlushed = true;
      if (buffered.length > 0) {
        broadcast({
          name: "",
          ctrl: false,
          meta: false,
          shift: false,
          paste: true,
          sequence: buffered
        });
      }
    }, "forceFlushStuckPaste");
    const onPasteIdleTimeout = /* @__PURE__ */ __name(() => {
      const idleFor = Date.now() - lastPasteChunkAt;
      if (idleFor >= PASTE_IDLE_TIMEOUT_MS) {
        forceFlushStuckPaste();
      } else {
        pasteIdleTimeout = setTimeout(
          onPasteIdleTimeout,
          PASTE_IDLE_TIMEOUT_MS - idleFor
        );
      }
    }, "onPasteIdleTimeout");
    const startPasteIdleTimeout = /* @__PURE__ */ __name(() => {
      lastPasteChunkAt = Date.now();
      if (pasteIdleTimeout) return;
      pasteIdleTimeout = setTimeout(onPasteIdleTimeout, PASTE_IDLE_TIMEOUT_MS);
    }, "startPasteIdleTimeout");
    const createPrintableKey = /* @__PURE__ */ __name((char) => {
      const printableName = char === " " ? "space" : /^[A-Za-z]$/.test(char) ? char.toLowerCase() : char;
      return {
        name: printableName,
        ctrl: false,
        meta: false,
        shift: false,
        paste: false,
        sequence: char,
        kittyProtocol: true
      };
    }, "createPrintableKey");
    const parseKittyPrefix = /* @__PURE__ */ __name((buffer) => {
      const revTabLegacy = new RegExp(`^${ESC2}\\[Z`);
      let m = buffer.match(revTabLegacy);
      if (m) {
        return {
          key: {
            name: "tab",
            ctrl: false,
            meta: false,
            shift: true,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true
          },
          length: m[0].length
        };
      }
      const revTabParam = new RegExp(`^${ESC2}\\[1;(\\d+)Z`);
      m = buffer.match(revTabParam);
      if (m) {
        let mods = parseInt(m[1], 10);
        if (mods >= KITTY_MODIFIER_EVENT_TYPES_OFFSET) {
          mods -= KITTY_MODIFIER_EVENT_TYPES_OFFSET;
        }
        const bits = mods - KITTY_MODIFIER_BASE;
        const alt = (bits & MODIFIER_ALT_BIT) === MODIFIER_ALT_BIT || (bits & MODIFIER_SUPER_BIT) === MODIFIER_SUPER_BIT;
        const ctrl = (bits & MODIFIER_CTRL_BIT) === MODIFIER_CTRL_BIT;
        return {
          key: {
            name: "tab",
            ctrl,
            meta: alt,
            // Reverse tab implies Shift behavior; force shift regardless of mods
            shift: true,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true
          },
          length: m[0].length
        };
      }
      const arrowPrefix = new RegExp(`^${ESC2}\\[1;(\\d+)([ABCDHFPQSR])`);
      m = buffer.match(arrowPrefix);
      if (m) {
        let mods = parseInt(m[1], 10);
        if (mods >= KITTY_MODIFIER_EVENT_TYPES_OFFSET) {
          mods -= KITTY_MODIFIER_EVENT_TYPES_OFFSET;
        }
        const bits = mods - KITTY_MODIFIER_BASE;
        const shift = (bits & MODIFIER_SHIFT_BIT) === MODIFIER_SHIFT_BIT;
        const alt = (bits & MODIFIER_ALT_BIT) === MODIFIER_ALT_BIT || (bits & MODIFIER_SUPER_BIT) === MODIFIER_SUPER_BIT;
        const ctrl = (bits & MODIFIER_CTRL_BIT) === MODIFIER_CTRL_BIT;
        const sym = m[2];
        const symbolToName = {
          A: "up",
          B: "down",
          C: "right",
          D: "left",
          H: "home",
          F: "end",
          P: "f1",
          Q: "f2",
          R: "f3",
          S: "f4"
        };
        const name = symbolToName[sym] || "";
        if (!name) return null;
        return {
          key: {
            name,
            ctrl,
            meta: alt,
            shift,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true
          },
          length: m[0].length
        };
      }
      const csiUPrefix = new RegExp(
        `^${ESC2}\\[(\\d+)(?::\\d+)*(?:;(\\d+)(?::\\d+)*)?(?:;(\\d+))?([u~])`
      );
      m = buffer.match(csiUPrefix);
      if (m) {
        let keyCode = parseInt(m[1], 10);
        let modifiers = m[2] ? parseInt(m[2], 10) : KITTY_MODIFIER_BASE;
        if (modifiers >= KITTY_MODIFIER_EVENT_TYPES_OFFSET) {
          modifiers -= KITTY_MODIFIER_EVENT_TYPES_OFFSET;
        }
        const modifierBits = modifiers - KITTY_MODIFIER_BASE;
        const shift = (modifierBits & MODIFIER_SHIFT_BIT) === MODIFIER_SHIFT_BIT;
        const alt = (modifierBits & MODIFIER_ALT_BIT) === MODIFIER_ALT_BIT || (modifierBits & MODIFIER_SUPER_BIT) === MODIFIER_SUPER_BIT;
        const ctrl = (modifierBits & MODIFIER_CTRL_BIT) === MODIFIER_CTRL_BIT;
        const terminator = m[4];
        if (keyCode === CHAR_CODE_ESC && terminator === "~" && m[3]) {
          keyCode = parseInt(m[3], 10);
        }
        if (terminator === "~") {
          let name2 = null;
          switch (keyCode) {
            case 1:
              name2 = "home";
              break;
            case 2:
              name2 = "insert";
              break;
            case 3:
              name2 = "delete";
              break;
            case 4:
              name2 = "end";
              break;
            case 5:
              name2 = "pageup";
              break;
            case 6:
              name2 = "pagedown";
              break;
            default:
              break;
          }
          if (name2) {
            return {
              key: {
                name: name2,
                ctrl,
                meta: alt,
                shift,
                paste: false,
                sequence: buffer.slice(0, m[0].length),
                kittyProtocol: true
              },
              length: m[0].length
            };
          }
        }
        const kittyKeyCodeToName = {
          [CHAR_CODE_ESC]: "escape",
          [KITTY_KEYCODE_TAB]: "tab",
          [KITTY_KEYCODE_BACKSPACE]: "backspace",
          [KITTY_KEYCODE_ENTER]: "return",
          [KITTY_KEYCODE_NUMPAD_ENTER]: "return"
        };
        const name = kittyKeyCodeToName[keyCode];
        if (name) {
          return {
            key: {
              name,
              ctrl,
              meta: alt,
              shift,
              paste: false,
              sequence: buffer.slice(0, m[0].length),
              kittyProtocol: true
            },
            length: m[0].length
          };
        }
        if (!ctrl) {
          const keypadChar = KITTY_KEYPAD_PRINTABLE_KEYCODE_TO_CHAR[keyCode];
          if (keypadChar) {
            return {
              key: {
                name: keypadChar,
                ctrl: false,
                meta: alt,
                shift,
                paste: false,
                sequence: keypadChar,
                kittyProtocol: true
              },
              length: m[0].length
            };
          }
        }
        const keypadName = KITTY_KEYPAD_FUNCTIONAL_KEYCODE_TO_NAME[keyCode];
        if (keypadName) {
          return {
            key: {
              name: keypadName,
              ctrl,
              meta: alt,
              shift,
              paste: false,
              sequence: buffer.slice(0, m[0].length),
              kittyProtocol: true
            },
            length: m[0].length
          };
        }
        if (terminator === "u" && !ctrl && keyCode >= 32 && keyCode !== 127 && keyCode <= 1114111 && !(keyCode >= 57344 && keyCode <= 63743)) {
          return {
            key: {
              ...createPrintableKey(String.fromCodePoint(keyCode)),
              meta: alt,
              shift
            },
            length: m[0].length
          };
        }
        if (ctrl && keyCode >= "a".charCodeAt(0) && keyCode <= "z".charCodeAt(0)) {
          const letter = String.fromCharCode(keyCode);
          return {
            key: {
              name: letter,
              ctrl: true,
              meta: alt,
              shift,
              paste: false,
              sequence: buffer.slice(0, m[0].length),
              kittyProtocol: true
            },
            length: m[0].length
          };
        }
      }
      const legacyFuncKey = new RegExp(`^${ESC2}\\[([ABCDHF])`);
      m = buffer.match(legacyFuncKey);
      if (m) {
        const sym = m[1];
        const nameMap = {
          A: "up",
          B: "down",
          C: "right",
          D: "left",
          H: "home",
          F: "end"
        };
        const name = nameMap[sym];
        return {
          key: {
            name,
            ctrl: false,
            meta: false,
            shift: false,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true
          },
          length: m[0].length
        };
      }
      return null;
    }, "parseKittyPrefix");
    const getCompleteCsiSequenceLength = /* @__PURE__ */ __name((buffer) => {
      if (!buffer.startsWith(`${ESC2}[`)) {
        return null;
      }
      for (let i = 2; i < buffer.length; i++) {
        const code = buffer.charCodeAt(i);
        if (code >= 64 && code <= 126) {
          return i + 1;
        }
        if (code < 32 || code > 63) {
          return 0;
        }
      }
      return null;
    }, "getCompleteCsiSequenceLength");
    const parsePlainTextPrefix = /* @__PURE__ */ __name((buffer) => {
      if (!buffer || buffer.startsWith(ESC2)) {
        return null;
      }
      const [char] = Array.from(buffer);
      if (!char) {
        return null;
      }
      return {
        key: createPrintableKey(char),
        length: char.length
      };
    }, "parsePlainTextPrefix");
    const broadcast = /* @__PURE__ */ __name((key) => {
      noteInteraction();
      for (const handler of subscribers) {
        handler(key);
      }
    }, "broadcast");
    const TERMINAL_RESPONSE_RE = /^\x1b\[[?>][\d;]*[uc]$/;
    const handleKeypress = /* @__PURE__ */ __name(async (_, key) => {
      if (TERMINAL_RESPONSE_RE.test(key.sequence)) {
        return;
      }
      if (key.sequence === FOCUS_IN || key.sequence === FOCUS_OUT) {
        return;
      }
      if (isPaste) {
        resetSgrMouse();
      } else if (swallowingSgrMouse) {
        if (key.ctrl && key.name === "c") {
          resetSgrMouse();
        } else if (key.name === "paste-start") {
          resetSgrMouse();
        } else {
          sgrMouseBuffer += key.sequence;
          if (key.name === "m" || key.sequence === "M") {
            swallowingSgrMouse = false;
            if (sgrMouseTimeout) {
              clearTimeout(sgrMouseTimeout);
              sgrMouseTimeout = null;
            }
            const parsed = parseSGRMouseEvent(sgrMouseBuffer);
            if (parsed) {
              for (const handler of mouseSubscribers) {
                handler(parsed.event);
              }
            }
            sgrMouseBuffer = "";
          } else if (sgrMouseBuffer.length >= MAX_SGR_MOUSE_SEQUENCE_LENGTH) {
            resetSgrMouse();
          }
          return;
        }
      }
      if (!isPaste && key.sequence === `${ESC2}[<`) {
        swallowingSgrMouse = true;
        sgrMouseBuffer = `${ESC2}[<`;
        if (sgrMouseTimeout) {
          clearTimeout(sgrMouseTimeout);
        }
        sgrMouseTimeout = setTimeout(() => {
          swallowingSgrMouse = false;
          sgrMouseBuffer = "";
          sgrMouseTimeout = null;
        }, KITTY_SEQUENCE_TIMEOUT_MS);
        return;
      }
      const isCtrlCKey = key.ctrl && key.name === "c" || key.sequence === `${ESC2}${KITTY_CTRL_C}`;
      if (isCtrlCKey) {
        if (isPaste || pasteChunks.length > 0) {
          isPaste = false;
          pasteChunks = [];
          pasteAlreadyFlushed = true;
          clearPasteIdleTimeout();
        }
        if (kittySequenceBufferRef.current && debugKeystrokeLogging) {
          debugLogger.debug(
            "[DEBUG] Kitty buffer cleared on Ctrl+C:",
            kittySequenceBufferRef.current
          );
        }
        clearKittyBufferAndTimeout();
        if (key.sequence === `${ESC2}${KITTY_CTRL_C}`) {
          broadcast({
            name: "c",
            ctrl: true,
            meta: false,
            shift: false,
            paste: false,
            sequence: key.sequence,
            kittyProtocol: true
          });
        } else {
          broadcast(key);
        }
        return;
      }
      if (key.name === "paste-start") {
        isPaste = true;
        pasteAlreadyFlushed = false;
        startPasteIdleTimeout();
        return;
      }
      if (key.name === "paste-end") {
        clearPasteIdleTimeout();
        if (pasteAlreadyFlushed) {
          pasteAlreadyFlushed = false;
          isPaste = false;
          pasteChunks = [];
          return;
        }
        isPaste = false;
        const buffered = pasteChunks.join("");
        pasteChunks = [];
        if (buffered.length > 0) {
          broadcast({
            name: "",
            ctrl: false,
            meta: false,
            shift: false,
            paste: true,
            sequence: buffered
          });
        } else {
          let clipboardImageUnavailable = false;
          const hasImage = await clipboardHasImage(() => {
            clipboardImageUnavailable = true;
          });
          broadcast({
            name: "",
            ctrl: false,
            meta: false,
            shift: false,
            paste: true,
            pasteImage: hasImage,
            clipboardImageUnavailable,
            sequence: buffered
          });
        }
        return;
      }
      if (isPaste) {
        pasteChunks.push(key.sequence);
        startPasteIdleTimeout();
        return;
      }
      if (key.name === "return" && waitingForEnterAfterBackslash) {
        if (backslashTimeout) {
          clearTimeout(backslashTimeout);
          backslashTimeout = null;
        }
        waitingForEnterAfterBackslash = false;
        broadcast({
          ...key,
          shift: true,
          sequence: "\r"
          // Corrected escaping for newline
        });
        return;
      }
      if (key.sequence === "\\" && !key.name) {
        waitingForEnterAfterBackslash = true;
        backslashTimeout = setTimeout(() => {
          waitingForEnterAfterBackslash = false;
          backslashTimeout = null;
          broadcast(key);
        }, BACKSLASH_ENTER_DETECTION_WINDOW_MS);
        return;
      }
      if (waitingForEnterAfterBackslash && key.name !== "return") {
        if (backslashTimeout) {
          clearTimeout(backslashTimeout);
          backslashTimeout = null;
        }
        waitingForEnterAfterBackslash = false;
        broadcast({
          name: "",
          sequence: "\\",
          ctrl: false,
          meta: false,
          shift: false,
          paste: false
        });
      }
      if (["up", "down", "left", "right"].includes(key.name)) {
        broadcast(key);
        return;
      }
      const isModifyOtherKeysSequence = key.sequence?.startsWith(`${ESC2}[27`) ?? false;
      if (kittyProtocolEnabled || kittySequenceBufferRef.current || isModifyOtherKeysSequence) {
        if (kittySequenceBufferRef.current || key.sequence.startsWith(`${ESC2}[`) && !key.sequence.startsWith(PASTE_MODE_PREFIX) && !key.sequence.startsWith(PASTE_MODE_SUFFIX) && !key.sequence.startsWith(FOCUS_IN) && !key.sequence.startsWith(FOCUS_OUT)) {
          updateKittyBuffer(kittySequenceBufferRef.current + key.sequence);
          startKittyTimeout();
          if (debugKeystrokeLogging) {
            debugLogger.debug(
              "[DEBUG] Kitty buffer accumulating:",
              kittySequenceBufferRef.current
            );
          }
          let bufferedInputHandled = false;
          while (kittySequenceBufferRef.current) {
            const parsed = parseKittyPrefix(kittySequenceBufferRef.current);
            if (parsed) {
              if (debugKeystrokeLogging) {
                const parsedSequence = kittySequenceBufferRef.current.slice(
                  0,
                  parsed.length
                );
                if (kittySequenceBufferRef.current.length > parsed.length) {
                  debugLogger.debug(
                    "[DEBUG] Kitty sequence parsed successfully (prefix):",
                    parsedSequence
                  );
                } else {
                  debugLogger.debug(
                    "[DEBUG] Kitty sequence parsed successfully:",
                    parsedSequence
                  );
                }
              }
              updateKittyBuffer(
                kittySequenceBufferRef.current.slice(parsed.length)
              );
              if (!kittySequenceBufferRef.current) {
                clearKittyTimeout();
              }
              broadcast(parsed.key);
              bufferedInputHandled = true;
              continue;
            }
            const completeUnsupportedCsiLength = getCompleteCsiSequenceLength(
              kittySequenceBufferRef.current
            );
            if (completeUnsupportedCsiLength) {
              if (debugKeystrokeLogging) {
                debugLogger.debug(
                  "[DEBUG] Dropping unsupported complete CSI sequence:",
                  kittySequenceBufferRef.current.slice(
                    0,
                    completeUnsupportedCsiLength
                  )
                );
              }
              updateKittyBuffer(
                kittySequenceBufferRef.current.slice(
                  completeUnsupportedCsiLength
                )
              );
              if (!kittySequenceBufferRef.current) {
                clearKittyTimeout();
              }
              bufferedInputHandled = true;
              continue;
            }
            const plainTextPrefix = parsePlainTextPrefix(
              kittySequenceBufferRef.current
            );
            if (plainTextPrefix) {
              if (debugKeystrokeLogging) {
                debugLogger.debug(
                  "[DEBUG] Recovered plain text after kitty sequence:",
                  plainTextPrefix.key.sequence
                );
              }
              updateKittyBuffer(
                kittySequenceBufferRef.current.slice(plainTextPrefix.length)
              );
              if (!kittySequenceBufferRef.current) {
                clearKittyTimeout();
              }
              broadcast(plainTextPrefix.key);
              bufferedInputHandled = true;
              continue;
            }
            const nextStart = kittySequenceBufferRef.current.indexOf(
              `${ESC2}[`,
              1
            );
            if (nextStart > 0) {
              if (debugKeystrokeLogging) {
                debugLogger.debug(
                  "[DEBUG] Skipping incomplete/invalid CSI prefix:",
                  kittySequenceBufferRef.current.slice(0, nextStart)
                );
              }
              updateKittyBuffer(
                kittySequenceBufferRef.current.slice(nextStart)
              );
              if (!kittySequenceBufferRef.current) {
                clearKittyTimeout();
              }
              bufferedInputHandled = true;
              continue;
            }
            break;
          }
          if (bufferedInputHandled) return;
          if (config?.getDebugMode() || debugKeystrokeLogging) {
            const codes = Array.from(kittySequenceBufferRef.current).map(
              (ch) => ch.charCodeAt(0)
            );
            debugLogger.warn("Kitty sequence buffer has char codes:", codes);
          }
          if (kittySequenceBufferRef.current.length > MAX_KITTY_SEQUENCE_LENGTH) {
            if (debugKeystrokeLogging) {
              debugLogger.debug(
                "[DEBUG] Kitty buffer overflow, clearing:",
                kittySequenceBufferRef.current
              );
            }
            if (config) {
              const event = new KittySequenceOverflowEvent(
                kittySequenceBufferRef.current.length,
                kittySequenceBufferRef.current
              );
              logKittySequenceOverflow(config, event);
            }
            clearKittyBufferAndTimeout();
          } else {
            return;
          }
        }
      }
      if (key.name === "return" && key.sequence === `${ESC2}\r`) {
        key.meta = true;
      }
      const composedKeyName = Object.hasOwn(
        OPTION_COMPOSED_GLYPHS,
        key.sequence
      ) ? OPTION_COMPOSED_GLYPHS[key.sequence] : void 0;
      if (process.platform === "darwin" && !isPaste && composedKeyName) {
        key.name = composedKeyName;
        key.meta = true;
      }
      broadcast({ ...key, paste: isPaste });
    }, "handleKeypress");
    const clearRawFlushTimeout = /* @__PURE__ */ __name(() => {
      if (rawFlushTimeout) {
        clearTimeout(rawFlushTimeout);
        rawFlushTimeout = null;
      }
    }, "clearRawFlushTimeout");
    const createPasteKeyEvent = /* @__PURE__ */ __name((name = "", sequence = "") => ({
      name,
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence
    }), "createPasteKeyEvent");
    const shouldFlushRawDataAsPaste = /* @__PURE__ */ __name((data) => {
      if (data.includes(27)) return false;
      const hasReturn = data.includes(13);
      const hasEmbeddedTab = data.length > 1 && data.includes(9);
      const isSingleReturn = data.length <= 2 && hasReturn;
      return !isSingleReturn && (hasReturn || hasEmbeddedTab);
    }, "shouldFlushRawDataAsPaste");
    const flushRawBuffer = /* @__PURE__ */ __name(() => {
      if (!rawDataBuffer.length) {
        return;
      }
      const pasteModePrefixBuffer = Buffer.from(PASTE_MODE_PREFIX);
      const pasteModeSuffixBuffer = Buffer.from(PASTE_MODE_SUFFIX);
      const data = rawDataBuffer;
      let cursor = 0;
      while (cursor < data.length) {
        const prefixPos = data.indexOf(pasteModePrefixBuffer, cursor);
        const suffixPos = data.indexOf(pasteModeSuffixBuffer, cursor);
        const hasPrefix = prefixPos !== -1 && prefixPos + pasteModePrefixBuffer.length <= data.length;
        const hasSuffix = suffixPos !== -1 && suffixPos + pasteModeSuffixBuffer.length <= data.length;
        let markerPos = -1;
        let markerLength = 0;
        let markerType = null;
        if (hasPrefix && (!hasSuffix || prefixPos < suffixPos)) {
          markerPos = prefixPos;
          markerLength = pasteModePrefixBuffer.length;
          markerType = "prefix";
        } else if (hasSuffix) {
          markerPos = suffixPos;
          markerLength = pasteModeSuffixBuffer.length;
          markerType = "suffix";
        }
        if (markerPos === -1) {
          break;
        }
        const nextData = data.slice(cursor, markerPos);
        if (nextData.length > 0) {
          keypressStream.write(nextData);
        }
        if (markerType === "prefix") {
          handleKeypress(void 0, createPasteKeyEvent("paste-start"));
        } else if (markerType === "suffix") {
          handleKeypress(void 0, createPasteKeyEvent("paste-end"));
        }
        cursor = markerPos + markerLength;
      }
      rawDataBuffer = data.slice(cursor);
      if (rawDataBuffer.length === 0) {
        return;
      }
      if (isPaste || !shouldFlushRawDataAsPaste(rawDataBuffer)) {
        keypressStream.write(rawDataBuffer);
      } else {
        handleKeypress(void 0, createPasteKeyEvent("paste-start"));
        keypressStream.write(rawDataBuffer);
        handleKeypress(void 0, createPasteKeyEvent("paste-end"));
      }
      rawDataBuffer = Buffer.alloc(0);
      clearRawFlushTimeout();
    }, "flushRawBuffer");
    const handleRawKeypress = /* @__PURE__ */ __name((_data) => {
      const data = Buffer.isBuffer(_data) ? _data : Buffer.from(_data, "utf8");
      rawDataBuffer = Buffer.concat([rawDataBuffer, data]);
      clearRawFlushTimeout();
      const isReturnChar = rawDataBuffer.length <= 2 && rawDataBuffer.includes(13);
      if (isReturnChar) {
        rawFlushTimeout = setTimeout(flushRawBuffer, 100);
      } else {
        flushRawBuffer();
      }
    }, "handleRawKeypress");
    const pasteModePrefixBuf = Buffer.from(PASTE_MODE_PREFIX);
    const pasteModeSuffixBuf = Buffer.from(PASTE_MODE_SUFFIX);
    function partialMarkerTailLength(chunk, marker, minLen = 2) {
      const maxCheck = Math.min(chunk.length, marker.length - 1);
      for (let len = maxCheck; len >= minLen; len--) {
        const tail = chunk.subarray(chunk.length - len);
        if (marker.subarray(0, len).equals(tail)) {
          return len;
        }
      }
      return 0;
    }
    __name(partialMarkerTailLength, "partialMarkerTailLength");
    let rawStdinTail = Buffer.alloc(0);
    let rawPasteAccumulating = false;
    let rawPasteChunks = [];
    let rawPasteReceivedBytes = 0;
    let rawPasteIdleTimeout = null;
    const clearRawPasteIdleTimeout = /* @__PURE__ */ __name(() => {
      if (rawPasteIdleTimeout) {
        clearTimeout(rawPasteIdleTimeout);
        rawPasteIdleTimeout = null;
      }
    }, "clearRawPasteIdleTimeout");
    const forceFlushRawPaste = /* @__PURE__ */ __name(() => {
      clearRawPasteIdleTimeout();
      if (!rawPasteAccumulating && rawPasteChunks.length === 0 && rawStdinTail.length === 0)
        return;
      if (rawStdinTail.length > 0) {
        rawPasteChunks.push(rawStdinTail);
        rawStdinTail = Buffer.alloc(0);
      }
      const content = Buffer.concat(rawPasteChunks);
      rawPasteChunks = [];
      rawPasteAccumulating = false;
      broadcastPasteFromRaw(content);
    }, "forceFlushRawPaste");
    const startRawPasteIdleTimeout = /* @__PURE__ */ __name(() => {
      clearRawPasteIdleTimeout();
      rawPasteIdleTimeout = setTimeout(
        forceFlushRawPaste,
        PASTE_IDLE_TIMEOUT_MS
      );
    }, "startRawPasteIdleTimeout");
    const broadcastPasteFromRaw = /* @__PURE__ */ __name((content) => {
      pasteAlreadyFlushed = true;
      setPasteProgress({ active: false, receivedBytes: 0 });
      const text = content.toString("utf-8");
      if (text.length > 0) {
        broadcast({
          name: "",
          ctrl: false,
          meta: false,
          shift: false,
          paste: true,
          sequence: text
        });
      } else {
        let clipboardImageUnavailable = false;
        void clipboardHasImage(() => {
          clipboardImageUnavailable = true;
        }).then((hasImage) => {
          broadcast({
            name: "",
            ctrl: false,
            meta: false,
            shift: false,
            paste: true,
            pasteImage: hasImage,
            clipboardImageUnavailable,
            sequence: ""
          });
        });
      }
    }, "broadcastPasteFromRaw");
    const handleStdinData = /* @__PURE__ */ __name((data) => {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
      const buf = rawStdinTail.length > 0 ? Buffer.concat([rawStdinTail, raw]) : raw;
      rawStdinTail = Buffer.alloc(0);
      let cursor = 0;
      while (cursor < buf.length) {
        if (rawPasteAccumulating) {
          const suffixIdx = buf.indexOf(pasteModeSuffixBuf, cursor);
          if (suffixIdx === -1) {
            const remaining = buf.subarray(cursor);
            const tailLen = partialMarkerTailLength(
              remaining,
              pasteModeSuffixBuf,
              1
            );
            const contentEnd = remaining.length - tailLen;
            if (contentEnd > 0) {
              const chunk = remaining.subarray(0, contentEnd);
              rawPasteChunks.push(chunk);
              rawPasteReceivedBytes += chunk.length;
              setPasteProgress((prev) => ({
                ...prev,
                receivedBytes: rawPasteReceivedBytes
              }));
            }
            if (tailLen > 0) {
              rawStdinTail = Buffer.from(remaining.subarray(contentEnd));
            }
            startRawPasteIdleTimeout();
            cursor = buf.length;
          } else {
            clearRawPasteIdleTimeout();
            if (suffixIdx > cursor) {
              rawPasteChunks.push(buf.subarray(cursor, suffixIdx));
            }
            const pasteContent = Buffer.concat(rawPasteChunks);
            rawPasteChunks = [];
            rawPasteAccumulating = false;
            broadcastPasteFromRaw(pasteContent);
            cursor = suffixIdx + pasteModeSuffixBuf.length;
          }
        } else {
          const prefixIdx = buf.indexOf(pasteModePrefixBuf, cursor);
          if (prefixIdx === -1) {
            const remaining = buf.subarray(cursor);
            if (remaining.length > 0) {
              const tailLen = partialMarkerTailLength(
                remaining,
                pasteModePrefixBuf
              );
              if (tailLen > 0) {
                const safe = remaining.subarray(0, remaining.length - tailLen);
                if (safe.length > 0) keypressStream.write(safe);
                rawStdinTail = Buffer.from(
                  remaining.subarray(remaining.length - tailLen)
                );
              } else {
                keypressStream.write(remaining);
              }
            }
            cursor = buf.length;
          } else {
            if (prefixIdx > cursor) {
              keypressStream.write(buf.subarray(cursor, prefixIdx));
            }
            rawPasteAccumulating = true;
            rawPasteChunks = [];
            rawPasteReceivedBytes = 0;
            startRawPasteIdleTimeout();
            setPasteProgress({
              active: true,
              receivedBytes: 0
            });
            cursor = prefixIdx + pasteModePrefixBuf.length;
          }
        }
      }
    }, "handleStdinData");
    let rl;
    if (usePassthrough) {
      rl = readline.createInterface({
        input: keypressStream,
        escapeCodeTimeout: 0
      });
      readline.emitKeypressEvents(keypressStream, rl);
      keypressStream.on("keypress", handleKeypress);
      stdin.on("data", handleRawKeypress);
    } else {
      rl = readline.createInterface({
        input: keypressStream,
        escapeCodeTimeout: 0
      });
      readline.emitKeypressEvents(keypressStream, rl);
      keypressStream.on("keypress", handleKeypress);
      stdin.on("keypress", handleKeypress);
      stdin.on("data", handleStdinData);
    }
    let replayPending = false;
    if (capturedInput.length > 0) {
      debugLogger.debug(
        `Replaying ${capturedInput.length} bytes of captured input`
      );
      replayPending = true;
      setImmediate(() => {
        if (!replayPending) return;
        try {
          stdin.emit("data", capturedInput);
        } catch (err) {
          debugLogger.error("Failed to replay captured input:", err);
        }
      });
    }
    return () => {
      replayPending = false;
      if (usePassthrough) {
        keypressStream.removeListener("keypress", handleKeypress);
        stdin.removeListener("data", handleRawKeypress);
      } else {
        keypressStream.removeListener("keypress", handleKeypress);
        stdin.removeListener("keypress", handleKeypress);
        stdin.removeListener("data", handleStdinData);
      }
      rl.close();
      setRawMode(false);
      if (backslashTimeout) {
        clearTimeout(backslashTimeout);
        backslashTimeout = null;
      }
      clearKittyBufferAndTimeout();
      clearPasteIdleTimeout();
      clearRawPasteIdleTimeout();
      resetSgrMouse();
      if (rawFlushTimeout) {
        clearTimeout(rawFlushTimeout);
        rawFlushTimeout = null;
      }
      if (rawPasteAccumulating || rawPasteChunks.length > 0) {
        forceFlushRawPaste();
      } else if (isPaste) {
        const buffered = pasteChunks.join("");
        if (buffered.length > 0) {
          broadcast({
            name: "",
            ctrl: false,
            meta: false,
            shift: false,
            paste: true,
            sequence: buffered
          });
        }
        pasteChunks = [];
      }
    };
  }, [
    stdin,
    setRawMode,
    kittyProtocolEnabled,
    debugKeystrokeLogging,
    pasteWorkaround,
    config,
    subscribers,
    mouseSubscribers,
    initialCapturedInput
  ]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    KeypressContext.Provider,
    {
      value: {
        subscribe,
        unsubscribe,
        subscribeMouse,
        unsubscribeMouse,
        pasteWorkaround,
        pasteProgress
      },
      children
    }
  );
}
__name(KeypressProvider, "KeypressProvider");

// packages/cli/src/ui/hooks/useKeypress.ts
function useKeypress(onKeypress, { isActive }) {
  const { subscribe, unsubscribe } = useKeypressContext();
  const onKeypressRef = (0, import_react3.useRef)(onKeypress);
  onKeypressRef.current = onKeypress;
  const handleKeypress = (0, import_react3.useCallback)((key) => {
    onKeypressRef.current(key);
  }, []);
  (0, import_react3.useEffect)(() => {
    if (!isActive) {
      return;
    }
    subscribe(handleKeypress);
    return () => {
      unsubscribe(handleKeypress);
    };
  }, [isActive, handleKeypress, subscribe, unsubscribe]);
}
__name(useKeypress, "useKeypress");

export {
  enableMouseEvents,
  disableMouseEvents,
  useKeypress,
  useFocus,
  useKeypressContext,
  KeypressProvider
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted from gemini-cli (Google LLC, Apache-2.0):
 * packages/cli/src/ui/utils/mouse.ts + utils/input.ts. Trimmed to the
 * subset the virtual-viewport scroll path needs (SGR + X11 parsing,
 * incomplete-sequence detection, enable/disable helpers).
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
