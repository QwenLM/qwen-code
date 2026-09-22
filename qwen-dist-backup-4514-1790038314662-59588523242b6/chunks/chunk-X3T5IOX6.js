// Force strict mode and setup for ESM
"use strict";
import {
  wrapForMultiplexer
} from "./chunk-6DB6UHY3.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/utils/platformConstants.ts
init_esbuild_shims();
var KITTY_CTRL_C = "[99;5u";
var KITTY_KEYCODE_ENTER = 13;
var KITTY_KEYCODE_NUMPAD_ENTER = 57414;
var KITTY_KEYCODE_TAB = 9;
var KITTY_KEYCODE_BACKSPACE = 127;
var KITTY_MODIFIER_BASE = 1;
var KITTY_MODIFIER_EVENT_TYPES_OFFSET = 128;
var MODIFIER_SHIFT_BIT = 1;
var MODIFIER_ALT_BIT = 2;
var MODIFIER_CTRL_BIT = 4;
var MODIFIER_SUPER_BIT = 8;
var CTRL_EXIT_PROMPT_DURATION_MS = 1e3;
var VSCODE_SHIFT_ENTER_SEQUENCE = "\\\r\n";
var BACKSLASH_ENTER_DETECTION_WINDOW_MS = 5;
var MAX_KITTY_SEQUENCE_LENGTH = 32;
var CHAR_CODE_ESC = 27;

// packages/cli/src/ui/utils/clipboardUtils.ts
init_esbuild_shims();
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execSync, spawn } from "node:child_process";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// packages/cli/src/utils/osc.ts
init_esbuild_shims();
var ESC = "\x1B";
var BEL = "\x07";
var ST = ESC + "\\";
var OSC_PREFIX = ESC + "]";
var SEP = ";";
var OSC = {
  /** iTerm2 notification / progress */
  ITERM2: 9,
  /** Kitty desktop notification protocol */
  KITTY: 99,
  /** Ghostty / cmux notification */
  GHOSTTY: 777
};
function detectTerminal() {
  const termProgram = process.env["TERM_PROGRAM"];
  switch (termProgram) {
    case "iTerm.app":
      return "iTerm.app";
    case "kitty":
      return "kitty";
    case "ghostty":
      return "ghostty";
    case "Apple_Terminal":
      return "Apple_Terminal";
    default:
      break;
  }
  if (process.env["TERM"] === "xterm-ghostty") {
    return "ghostty";
  }
  if (process.env["TERM"]?.includes("kitty")) {
    return "kitty";
  }
  if (process.env["KITTY_WINDOW_ID"]) return "kitty";
  return "unknown";
}
__name(detectTerminal, "detectTerminal");
function sanitizeOscPayload(text) {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, "");
}
__name(sanitizeOscPayload, "sanitizeOscPayload");
function osc(...parts) {
  const isKitty = detectTerminal() === "kitty";
  const inScreen = !!process.env["STY"];
  const terminator = isKitty && !inScreen ? ST : BEL;
  const sanitized = parts.map(
    (p) => typeof p === "string" ? sanitizeOscPayload(p) : p
  );
  return `${OSC_PREFIX}${sanitized.join(SEP)}${terminator}`;
}
__name(osc, "osc");
function encodeKittyPayload(text) {
  return Buffer.from(text, "utf8").toString("base64");
}
__name(encodeKittyPayload, "encodeKittyPayload");
function oscITerm2Notify(title, message) {
  const displayString = title ? `${title}:
${message}` : message;
  return osc(OSC.ITERM2, `

${displayString}`);
}
__name(oscITerm2Notify, "oscITerm2Notify");
function oscKittyNotify(title, message, id) {
  return [
    osc(OSC.KITTY, `i=${id}:d=0:p=title:e=1`, encodeKittyPayload(title)),
    osc(OSC.KITTY, `i=${id}:p=body:e=1`, encodeKittyPayload(message)),
    osc(OSC.KITTY, `i=${id}:d=1:a=focus`, "")
  ];
}
__name(oscKittyNotify, "oscKittyNotify");
function oscGhosttyNotify(title, message) {
  return osc(OSC.GHOSTTY, "notify", title, message);
}
__name(oscGhosttyNotify, "oscGhosttyNotify");
function generateKittyId() {
  return Math.floor(Math.random() * 2 ** 31);
}
__name(generateKittyId, "generateKittyId");

// packages/cli/src/ui/utils/clipboardUtils.ts
var debugLogger = createDebugLogger("CLIPBOARD_UTILS");
var PROCESS_TIMEOUT_MS = 5e3;
function writeOsc52(text) {
  try {
    const MAX_OSC52_BYTES = 75e3;
    if (Buffer.byteLength(text, "utf-8") > MAX_OSC52_BYTES) {
      debugLogger.warn(
        `writeOsc52: text too large (${Buffer.byteLength(text, "utf-8")} bytes), skipping`
      );
      return false;
    }
    const base64 = Buffer.from(text, "utf-8").toString("base64");
    const sequence = wrapForMultiplexer(`\x1B]52;c;${base64}\x07`);
    const stream = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : null;
    if (!stream) {
      debugLogger.warn(
        "OSC 52 clipboard requires a TTY; stdout/stderr not connected to terminal"
      );
      return false;
    }
    stream.write(sequence, (err) => {
      if (err) debugLogger.warn("writeOsc52: async write failed:", err);
    });
    return true;
  } catch (e) {
    debugLogger.warn("writeOsc52 failed:", e);
    return false;
  }
}
__name(writeOsc52, "writeOsc52");
var linuxClipboardTool;
var cachedWlPasteImageTypes = null;
var clipboardModulePromise = null;
async function getClipboardModule() {
  if (!clipboardModulePromise) {
    const modName = "@teddyzhu/clipboard";
    clipboardModulePromise = import(modName).catch(() => {
      debugLogger.error(
        "Failed to load @teddyzhu/clipboard native module. Clipboard image features will be unavailable."
      );
      return null;
    });
  }
  return clipboardModulePromise;
}
__name(getClipboardModule, "getClipboardModule");
function isWaylandSession() {
  return process.env["XDG_SESSION_TYPE"]?.toLowerCase() === "wayland" || Boolean(process.env["WAYLAND_DISPLAY"]);
}
__name(isWaylandSession, "isWaylandSession");
function getLinuxClipboardTool() {
  if (linuxClipboardTool !== void 0) return linuxClipboardTool;
  const sessionType = process.env["XDG_SESSION_TYPE"];
  const display = process.env["DISPLAY"];
  let toolName = null;
  if (isWaylandSession()) {
    toolName = "wl-paste";
  } else if (sessionType === "x11" || display) {
    toolName = "xclip";
  } else {
    linuxClipboardTool = null;
    return null;
  }
  try {
    execSync("command -v " + toolName, { stdio: "ignore" });
    linuxClipboardTool = toolName;
    return toolName;
  } catch {
    debugLogger.warn(`${toolName} not found`);
    linuxClipboardTool = null;
    return null;
  }
}
__name(getLinuxClipboardTool, "getLinuxClipboardTool");
async function saveFromCommand(command, args, destination) {
  let fd;
  try {
    fd = await fs.open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    );
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const fileStream = fd.createWriteStream();
    let stderr = "";
    let resolved = false;
    const safeResolve = /* @__PURE__ */ __name((value) => {
      if (!resolved) {
        resolved = true;
        try {
          if (!child.killed) child.kill();
        } catch {
        }
        try {
          fileStream.destroy();
        } catch {
        }
        resolve(value);
      }
    }, "safeResolve");
    const timer = setTimeout(() => {
      debugLogger.debug(`${command} timed out after ${PROCESS_TIMEOUT_MS}ms`);
      safeResolve(false);
    }, PROCESS_TIMEOUT_MS);
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.stdout.pipe(fileStream);
    child.stdout.on("error", (err) => {
      debugLogger.debug(`stdout error for ${command}:`, err);
      clearTimeout(timer);
      safeResolve(false);
    });
    child.on("error", (err) => {
      debugLogger.debug(`Failed to spawn ${command}:`, err);
      clearTimeout(timer);
      safeResolve(false);
    });
    fileStream.on("error", (err) => {
      debugLogger.debug(`File stream error for ${destination}:`, err);
      clearTimeout(timer);
      safeResolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (resolved) return;
      if (code !== 0) {
        debugLogger.debug(
          `${command} exited with code ${code}. Args: ${args.join(" ")}`
        );
        if (stderr) debugLogger.debug(`${command} stderr: ${stderr.trim()}`);
        safeResolve(false);
        return;
      }
      const checkFile = /* @__PURE__ */ __name(() => {
        fs.stat(destination).then((stats) => {
          safeResolve(stats.size > 0);
        }).catch(() => {
          safeResolve(false);
        });
      }, "checkFile");
      if (fileStream.writableFinished) {
        checkFile();
      } else {
        fileStream.on("finish", checkFile);
        fileStream.on("close", () => {
          if (!resolved) checkFile();
        });
      }
    });
  });
}
__name(saveFromCommand, "saveFromCommand");
async function checkClipboardForImage(command, args) {
  if (command === "wl-paste" && args.length === 1 && args[0] === "--list-types") {
    const types = await getWlPasteImageTypes();
    return types.length > 0;
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "ignore"]
      });
      let stdout = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
        }
        resolve(false);
      }, PROCESS_TIMEOUT_MS);
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(
          code === 0 && stdout.split("\n").some((line) => line === "image/png" || line === "image/bmp")
        );
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}
__name(checkClipboardForImage, "checkClipboardForImage");
async function clipboardHasImage(onUnavailable) {
  cachedWlPasteImageTypes = null;
  if (process.platform === "linux") {
    try {
      const tool = getLinuxClipboardTool();
      if (tool === "wl-paste") {
        return checkClipboardForImage("wl-paste", ["--list-types"]);
      }
      if (tool === "xclip") {
        return checkClipboardForImage("xclip", [
          "-selection",
          "clipboard",
          "-t",
          "TARGETS",
          "-o"
        ]);
      }
    } catch (error) {
      debugLogger.error("Error checking clipboard for image:", error);
    }
    return false;
  }
  try {
    const mod = await getClipboardModule();
    if (!mod) {
      onUnavailable?.();
      return false;
    }
    const clipboard = new mod.ClipboardManager();
    return clipboard.hasFormat("image");
  } catch (error) {
    debugLogger.error("Error checking clipboard for image:", error);
    return false;
  }
}
__name(clipboardHasImage, "clipboardHasImage");
async function getWlPasteImageTypes() {
  if (cachedWlPasteImageTypes !== null) {
    return cachedWlPasteImageTypes;
  }
  return new Promise((resolve) => {
    const child = spawn("wl-paste", ["--list-types"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    let stdout = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      resolve([]);
    }, PROCESS_TIMEOUT_MS);
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve([]);
        return;
      }
      const types = stdout.trim().split("\n").filter((t) => t === "image/png" || t === "image/bmp");
      cachedWlPasteImageTypes = types;
      resolve(types);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}
__name(getWlPasteImageTypes, "getWlPasteImageTypes");
async function saveFileWithWlPaste(tempFilePath) {
  const imageTypes = await getWlPasteImageTypes();
  if (imageTypes.includes("image/png")) {
    const success = await saveFromCommand(
      "wl-paste",
      ["--no-newline", "--type", "image/png"],
      tempFilePath
    );
    if (success) return tempFilePath;
    try {
      await fs.unlink(tempFilePath);
    } catch {
    }
  }
  if (imageTypes.includes("image/bmp")) {
    const bmpPath = tempFilePath.replace(/\.png$/, ".bmp");
    const bmpSuccess = await saveFromCommand(
      "wl-paste",
      ["--no-newline", "--type", "image/bmp"],
      bmpPath
    );
    if (bmpSuccess) {
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(
            "python3",
            [
              "-c",
              "import sys; from PIL import Image; Image.open(sys.argv[1]).save(sys.argv[2])",
              bmpPath,
              tempFilePath
            ],
            { stdio: ["ignore", "ignore", "pipe"] }
          );
          let stderr = "";
          child.stderr.on("data", (d) => {
            stderr += d.toString();
          });
          const timer = setTimeout(() => {
            try {
              child.kill();
            } catch {
            }
            reject(new Error("python3 timed out"));
          }, PROCESS_TIMEOUT_MS);
          child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else
              reject(
                new Error(
                  `python3 exited with code ${code}${stderr ? ": " + stderr.trim() : ""}`
                )
              );
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        try {
          await fs.unlink(bmpPath);
        } catch {
        }
        return tempFilePath;
      } catch (err) {
        debugLogger.warn(
          "BMP-to-PNG conversion failed (install python3-pil for BMP support):",
          err
        );
        try {
          await fs.unlink(bmpPath);
        } catch {
        }
        try {
          await fs.unlink(tempFilePath);
        } catch {
        }
        return false;
      }
    }
    try {
      await fs.unlink(bmpPath);
    } catch {
    }
  }
  return false;
}
__name(saveFileWithWlPaste, "saveFileWithWlPaste");
async function saveFileWithXclip(tempFilePath) {
  const success = await saveFromCommand(
    "xclip",
    ["-selection", "clipboard", "-t", "image/png", "-o"],
    tempFilePath
  );
  if (success) return true;
  try {
    await fs.unlink(tempFilePath);
  } catch {
  }
  return false;
}
__name(saveFileWithXclip, "saveFileWithXclip");
async function saveClipboardImage(targetDir) {
  try {
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, "clipboard");
    await fs.mkdir(tempDir, { recursive: true });
    const timestamp = (/* @__PURE__ */ new Date()).getTime();
    if (process.platform === "linux") {
      const pngPath = path.join(
        tempDir,
        `clipboard-${timestamp}-${randomUUID()}.png`
      );
      const tool = getLinuxClipboardTool();
      if (tool === "wl-paste") {
        const savedPath = await saveFileWithWlPaste(pngPath);
        if (savedPath) {
          try {
            const stats = await fs.stat(savedPath);
            if (stats.size > 0) return savedPath;
            await fs.unlink(savedPath);
          } catch {
          }
        }
        return null;
      }
      if (tool === "xclip") {
        if (await saveFileWithXclip(pngPath)) return pngPath;
        return null;
      }
      return null;
    }
    const mod = await getClipboardModule();
    if (!mod) return null;
    const clipboard = new mod.ClipboardManager();
    if (!clipboard.hasFormat("image")) {
      return null;
    }
    const tempFilePath = path.join(
      tempDir,
      `clipboard-${timestamp}-${randomUUID()}.png`
    );
    const imageData = clipboard.getImageData();
    const buffer = imageData.data;
    if (!buffer) {
      return null;
    }
    await fs.writeFile(tempFilePath, buffer);
    return tempFilePath;
  } catch (error) {
    debugLogger.error("Error saving clipboard image:", error);
    return null;
  }
}
__name(saveClipboardImage, "saveClipboardImage");
async function cleanupOldClipboardImages(targetDir) {
  try {
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, "clipboard");
    const files = await fs.readdir(tempDir);
    const MAX_IMAGES = 100;
    const CLEANUP_COUNT = 50;
    const imageFiles = [];
    for (const file of files) {
      if (file.startsWith("clipboard-") && (file.endsWith(".png") || file.endsWith(".jpg") || file.endsWith(".webp") || file.endsWith(".heic") || file.endsWith(".heif") || file.endsWith(".tiff") || file.endsWith(".gif") || file.endsWith(".bmp"))) {
        const filePath = path.join(tempDir, file);
        const stats = await fs.stat(filePath);
        imageFiles.push({
          name: file,
          path: filePath,
          atime: stats.atimeMs
        });
      }
    }
    if (imageFiles.length > MAX_IMAGES) {
      imageFiles.sort((a, b) => a.atime - b.atime);
      const removeCount = Math.min(
        CLEANUP_COUNT,
        imageFiles.length - MAX_IMAGES + CLEANUP_COUNT
      );
      const filesToRemove = imageFiles.slice(0, removeCount);
      for (const file of filesToRemove) {
        await fs.unlink(file.path);
      }
    }
  } catch {
  }
}
__name(cleanupOldClipboardImages, "cleanupOldClipboardImages");

export {
  KITTY_CTRL_C,
  KITTY_KEYCODE_ENTER,
  KITTY_KEYCODE_NUMPAD_ENTER,
  KITTY_KEYCODE_TAB,
  KITTY_KEYCODE_BACKSPACE,
  KITTY_MODIFIER_BASE,
  KITTY_MODIFIER_EVENT_TYPES_OFFSET,
  MODIFIER_SHIFT_BIT,
  MODIFIER_ALT_BIT,
  MODIFIER_CTRL_BIT,
  MODIFIER_SUPER_BIT,
  CTRL_EXIT_PROMPT_DURATION_MS,
  VSCODE_SHIFT_ENTER_SEQUENCE,
  BACKSLASH_ENTER_DETECTION_WINDOW_MS,
  MAX_KITTY_SEQUENCE_LENGTH,
  CHAR_CODE_ESC,
  BEL,
  OSC_PREFIX,
  detectTerminal,
  oscITerm2Notify,
  oscKittyNotify,
  oscGhosttyNotify,
  generateKittyId,
  writeOsc52,
  isWaylandSession,
  clipboardHasImage,
  saveClipboardImage,
  cleanupOldClipboardImages
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
