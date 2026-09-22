// Force strict mode and setup for ESM
"use strict";
import {
  MAX_INLINE_IMAGE_ENCODED_LENGTH
} from "./chunk-U3MTHCJF.js";
import {
  MAX_TERMINAL_IMAGE_BYTES
} from "./chunk-VPGRGNNH.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/utils/terminal-image-renderer.ts
init_esbuild_shims();
import crypto2 from "node:crypto";
import fs2 from "node:fs";
import { execFileSync } from "node:child_process";

// packages/cli/src/ui/utils/mermaidImageRenderer.ts
init_esbuild_shims();
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
var CACHE_LIMIT = 40;
var PNG_CACHE_LIMIT = 20;
var CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
var PNG_CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
var DEFAULT_RENDER_TIMEOUT_MS = 8e3;
var DEFAULT_MERMAID_RENDER_WIDTH = 1280;
var MAX_MERMAID_PNG_BYTES = 8 * 1024 * 1024;
var MAX_RENDERER_OUTPUT_CHARS = 16 * 1024;
var MAX_RENDER_TIMEOUT_MS = 6e4;
var OUTPUT_TRUNCATION_MARKER = "\n... renderer output truncated ...";
var NPX_MERMAID_CLI = "npx:@mermaid-js/mermaid-cli@11.12.0";
var PNG_SIGNATURE = "89504e470d0a1a0a";
var KITTY_PLACEHOLDER = "\u{10EEEE}";
var RENDERER_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "LOCALAPPDATA",
  "APPDATA",
  "CHROME_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
  "PUPPETEER_CACHE_DIR",
  "PLAYWRIGHT_BROWSERS_PATH"
];
var KITTY_PLACEHOLDER_DIACRITICS = [
  "\u0305",
  "\u030D",
  "\u030E",
  "\u0310",
  "\u0312",
  "\u033D",
  "\u033E",
  "\u033F",
  "\u0346",
  "\u034A",
  "\u034B",
  "\u034C",
  "\u0350",
  "\u0351",
  "\u0352",
  "\u0357",
  "\u035B",
  "\u0363",
  "\u0364",
  "\u0365",
  "\u0366",
  "\u0367",
  "\u0368",
  "\u0369",
  "\u036A",
  "\u036B",
  "\u036C",
  "\u036D",
  "\u036E",
  "\u036F",
  "\u0483",
  "\u0484",
  "\u0485",
  "\u0486",
  "\u0487",
  "\u0592",
  "\u0593",
  "\u0594",
  "\u0595",
  "\u0597",
  "\u0598",
  "\u0599",
  "\u059C",
  "\u059D",
  "\u059E",
  "\u059F",
  "\u05A0",
  "\u05A1",
  "\u05A8",
  "\u05A9",
  "\u05AB",
  "\u05AC",
  "\u05AF",
  "\u05C4",
  "\u0610",
  "\u0611",
  "\u0612",
  "\u0613",
  "\u0614",
  "\u0615",
  "\u0616",
  "\u0617",
  "\u0657",
  "\u0658",
  "\u0659",
  "\u065A",
  "\u065B",
  "\u065D",
  "\u065E",
  "\u06D6",
  "\u06D7",
  "\u06D8",
  "\u06D9",
  "\u06DA",
  "\u06DB",
  "\u06DC",
  "\u06DF",
  "\u06E0",
  "\u06E1",
  "\u06E2",
  "\u06E4",
  "\u06E7",
  "\u06E8",
  "\u06EB",
  "\u06EC",
  "\u0730",
  "\u0732",
  "\u0733",
  "\u0735",
  "\u0736",
  "\u073A",
  "\u073D",
  "\u073F",
  "\u0740",
  "\u0741",
  "\u0743",
  "\u0745",
  "\u0747",
  "\u0749",
  "\u074A",
  "\u07EB",
  "\u07EC",
  "\u07ED",
  "\u07EE",
  "\u07EF",
  "\u07F0",
  "\u07F1",
  "\u07F3",
  "\u0816",
  "\u0817",
  "\u0818",
  "\u0819",
  "\u081B",
  "\u081C",
  "\u081D",
  "\u081E",
  "\u081F",
  "\u0820",
  "\u0821",
  "\u0822",
  "\u0823",
  "\u0825",
  "\u0826",
  "\u0827",
  "\u0829",
  "\u082A",
  "\u082B",
  "\u082C"
];
var cachedResults = /* @__PURE__ */ new Map();
var cachedPngResults = /* @__PURE__ */ new Map();
var cachedResultsBytes = 0;
var cachedPngResultsBytes = 0;
function detectTerminalImageProtocol(env = process.env) {
  if (env["QWEN_CODE_DISABLE_MERMAID_IMAGES"] === "1") {
    return null;
  }
  const forced = env["QWEN_CODE_MERMAID_IMAGE_PROTOCOL"]?.toLowerCase();
  if (forced === "off" || forced === "none" || forced === "0") {
    return null;
  }
  if (!process.stdout.isTTY || env["TMUX"] || env["SSH_TTY"] || env["SSH_CLIENT"]) {
    return null;
  }
  if (forced) {
    if (forced === "kitty") return "kitty";
    if (forced === "iterm" || forced === "iterm2") return "iterm2";
  }
  const term = env["TERM"]?.toLowerCase() ?? "";
  const termProgram = env["TERM_PROGRAM"]?.toLowerCase() ?? "";
  if (env["KITTY_WINDOW_ID"] || term.includes("kitty") || termProgram.includes("ghostty")) {
    return "kitty";
  }
  if (termProgram === "iterm.app" || termProgram.includes("wezterm")) {
    return "iterm2";
  }
  return null;
}
__name(detectTerminalImageProtocol, "detectTerminalImageProtocol");
function encodeITerm2InlineImage(png, widthCells, rows) {
  return `\x1B]1337;File=inline=1;width=${widthCells};height=${rows};preserveAspectRatio=1:${png.toString(
    "base64"
  )}\x07`;
}
__name(encodeITerm2InlineImage, "encodeITerm2InlineImage");
function encodeKittyVirtualImage(png, imageId, widthCells, rows) {
  return encodeKittyImageCommand(
    png,
    `a=T,f=100,i=${imageId},q=2,U=1,c=${widthCells},r=${rows}`
  );
}
__name(encodeKittyVirtualImage, "encodeKittyVirtualImage");
function encodeKittyImageCommand(png, firstControl) {
  const encoded = png.toString("base64");
  const chunkSize = 4096;
  const chunks = [];
  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    const chunk = encoded.slice(offset, offset + chunkSize);
    const hasMore = offset + chunkSize < encoded.length;
    const control = offset === 0 ? `${firstControl},m=${hasMore ? 1 : 0}` : `m=${hasMore ? 1 : 0}`;
    chunks.push(`\x1B_G${control};${chunk}\x1B\\`);
  }
  return chunks.join("");
}
__name(encodeKittyImageCommand, "encodeKittyImageCommand");
function buildKittyPlaceholder(imageId, widthCells, rows) {
  const clampedRows = Math.min(rows, KITTY_PLACEHOLDER_DIACRITICS.length);
  const clampedWidth = Math.min(
    widthCells,
    KITTY_PLACEHOLDER_DIACRITICS.length
  );
  const lines = Array.from({ length: clampedRows }, (_, row) => {
    const rowDiacritic = KITTY_PLACEHOLDER_DIACRITICS[row];
    const cells = Array.from({ length: clampedWidth }, (_2, column) => {
      const columnDiacritic = KITTY_PLACEHOLDER_DIACRITICS[column];
      return `${KITTY_PLACEHOLDER}${rowDiacritic}${columnDiacritic}`;
    });
    return cells.join("");
  });
  return {
    color: `#${imageId.toString(16).padStart(6, "0")}`,
    imageId,
    lines
  };
}
__name(buildKittyPlaceholder, "buildKittyPlaceholder");
function readPngSize(png) {
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    return null;
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  };
}
__name(readPngSize, "readPngSize");
function isMermaidImageRenderingDisabled(env) {
  return env["QWEN_CODE_DISABLE_MERMAID_IMAGES"] === "1";
}
__name(isMermaidImageRenderingDisabled, "isMermaidImageRenderingDisabled");
function unavailableImageRenderingDisabled() {
  return {
    kind: "unavailable",
    reason: "Mermaid image rendering is disabled via QWEN_CODE_DISABLE_MERMAID_IMAGES."
  };
}
__name(unavailableImageRenderingDisabled, "unavailableImageRenderingDisabled");
async function renderMermaidImageAsync({
  source,
  contentWidth,
  availableTerminalHeight,
  env = process.env,
  signal
}) {
  if (isMermaidImageRenderingDisabled(env)) {
    return unavailableImageRenderingDisabled();
  }
  const imageRendering = env["QWEN_CODE_MERMAID_IMAGE_RENDERING"];
  if (imageRendering !== "1" && imageRendering?.toLowerCase() !== "on" && imageRendering?.toLowerCase() !== "true") {
    return {
      kind: "unavailable",
      reason: "Mermaid image rendering is disabled by default. Set QWEN_CODE_MERMAID_IMAGE_RENDERING=1 to enable external renderers.",
      showReason: false
    };
  }
  const protocol = detectTerminalImageProtocol(env);
  if (protocol === "iterm2") {
    return {
      kind: "unavailable",
      reason: "iTerm2 inline image rendering is disabled in the async TUI path to avoid cursor-position races.",
      showReason: false
    };
  }
  const chafa = protocol ? null : findExecutable("chafa", env);
  if (!protocol && !chafa) {
    return {
      kind: "unavailable",
      reason: "No supported terminal image protocol or chafa renderer was detected."
    };
  }
  const mmdc = findMmdc(env);
  if (!mmdc) {
    return {
      kind: "unavailable",
      reason: "Mermaid CLI (mmdc) was not found. Install @mermaid-js/mermaid-cli, set QWEN_CODE_MERMAID_MMD_CLI, or set QWEN_CODE_MERMAID_ALLOW_NPX=1."
    };
  }
  const cacheKey = createCacheKey(
    source,
    contentWidth,
    availableTerminalHeight,
    protocol ?? `chafa:${chafa}`,
    mmdc,
    env
  );
  const cached = getResultCache(cacheKey);
  if (cached) return cached;
  const pngCacheKey = createPngCacheKey(source, mmdc, env);
  const cachedPng = getPngCache(pngCacheKey);
  let rendered = cachedPng;
  if (!rendered) {
    const nextRendered = await renderPngWithMmdcAsync(
      source,
      mmdc,
      env,
      signal
    );
    rendered = signal?.aborted ? nextRendered : rememberPng(pngCacheKey, nextRendered);
  }
  if (!rendered.ok) {
    if (signal?.aborted) {
      return {
        kind: "unavailable",
        reason: rendered.error
      };
    }
    return remember(cacheKey, {
      kind: "unavailable",
      reason: rendered.error
    });
  }
  const pngSize = readPngSize(rendered.png);
  if (!pngSize) {
    return remember(cacheKey, {
      kind: "unavailable",
      reason: "Mermaid CLI did not produce a valid PNG."
    });
  }
  const imageShape = fitImageToTerminal(
    pngSize,
    contentWidth,
    availableTerminalHeight,
    env
  );
  if (protocol) {
    const imageId = protocol === "kitty" ? createKittyImageId(rendered.png, imageShape) : void 0;
    const sequence = protocol === "kitty" ? encodeKittyVirtualImage(
      rendered.png,
      imageId,
      imageShape.widthCells,
      imageShape.rows
    ) : encodeITerm2InlineImage(
      rendered.png,
      imageShape.widthCells,
      imageShape.rows
    );
    return remember(cacheKey, {
      kind: "terminal-image",
      title: `Mermaid diagram image (${protocol})`,
      sequence,
      rows: imageShape.rows,
      protocol,
      placeholder: protocol === "kitty" ? buildKittyPlaceholder(
        imageId,
        imageShape.widthCells,
        imageShape.rows
      ) : void 0
    });
  }
  const ansi = await renderPngWithChafaAsync(
    rendered.png,
    imageShape.widthCells,
    imageShape.rows,
    chafa,
    env,
    signal
  );
  if (!ansi.ok) {
    if (signal?.aborted) {
      return {
        kind: "unavailable",
        reason: ansi.error
      };
    }
    return remember(cacheKey, {
      kind: "unavailable",
      reason: ansi.error
    });
  }
  return remember(cacheKey, {
    kind: "ansi",
    title: "Mermaid diagram image (ANSI)",
    lines: ansi.output.split(/\r?\n/).filter((line) => line.length > 0)
  });
}
__name(renderMermaidImageAsync, "renderMermaidImageAsync");
function createKittyImageId(png, imageShape) {
  const hash = crypto.createHash("sha256").update(png).update("\0").update(String(imageShape.widthCells)).update("\0").update(String(imageShape.rows)).digest();
  const id = hash.readUIntBE(0, 3);
  return id === 0 ? 1 : id;
}
__name(createKittyImageId, "createKittyImageId");
function getResultCache(key) {
  const cached = cachedResults.get(key);
  if (cached) {
    cachedResults.delete(key);
    cachedResults.set(key, cached);
  }
  return cached;
}
__name(getResultCache, "getResultCache");
function getPngCache(key) {
  const cached = cachedPngResults.get(key);
  if (cached) {
    cachedPngResults.delete(key);
    cachedPngResults.set(key, cached);
  }
  return cached;
}
__name(getPngCache, "getPngCache");
function createPngCacheKey(source, mmdc, env) {
  return crypto.createHash("sha256").update(source).update("\0").update(mmdc).update("\0").update(String(getMermaidRenderWidth(env))).digest("hex");
}
__name(createPngCacheKey, "createPngCacheKey");
function createCacheKey(source, contentWidth, availableTerminalHeight, renderer, mmdc, env) {
  return crypto.createHash("sha256").update(source).update("\0").update(String(contentWidth)).update("\0").update(String(availableTerminalHeight ?? "auto")).update("\0").update(renderer).update("\0").update(mmdc).update("\0").update(String(getMermaidCellAspectRatio(env))).digest("hex");
}
__name(createCacheKey, "createCacheKey");
function remember(key, result) {
  const resultBytes = estimateResultBytes(result);
  if (resultBytes > CACHE_BYTE_LIMIT) {
    cachedResults.delete(key);
    return result;
  }
  const existing = cachedResults.get(key);
  if (existing) {
    cachedResultsBytes -= estimateResultBytes(existing);
  }
  cachedResults.set(key, result);
  cachedResultsBytes += resultBytes;
  while (cachedResults.size > CACHE_LIMIT || cachedResultsBytes > CACHE_BYTE_LIMIT) {
    const oldest = cachedResults.keys().next().value;
    if (!oldest) break;
    const oldestResult = cachedResults.get(oldest);
    if (oldestResult) {
      cachedResultsBytes -= estimateResultBytes(oldestResult);
    }
    cachedResults.delete(oldest);
  }
  return result;
}
__name(remember, "remember");
function rememberPng(key, result) {
  const resultBytes = estimatePngResultBytes(result);
  if (resultBytes > PNG_CACHE_BYTE_LIMIT) {
    cachedPngResults.delete(key);
    return result;
  }
  const existing = cachedPngResults.get(key);
  if (existing) {
    cachedPngResultsBytes -= estimatePngResultBytes(existing);
  }
  cachedPngResults.set(key, result);
  cachedPngResultsBytes += resultBytes;
  while (cachedPngResults.size > PNG_CACHE_LIMIT || cachedPngResultsBytes > PNG_CACHE_BYTE_LIMIT) {
    const oldest = cachedPngResults.keys().next().value;
    if (!oldest) break;
    const oldestResult = cachedPngResults.get(oldest);
    if (oldestResult) {
      cachedPngResultsBytes -= estimatePngResultBytes(oldestResult);
    }
    cachedPngResults.delete(oldest);
  }
  return result;
}
__name(rememberPng, "rememberPng");
function estimateResultBytes(result) {
  switch (result.kind) {
    case "terminal-image":
      return Buffer.byteLength(result.sequence, "utf8") + (result.placeholder?.lines.reduce(
        (total, line) => total + Buffer.byteLength(line, "utf8"),
        0
      ) ?? 0);
    case "ansi":
      return result.lines.reduce(
        (total, line) => total + Buffer.byteLength(line, "utf8"),
        0
      );
    case "unavailable":
      return Buffer.byteLength(result.reason, "utf8");
    default: {
      const exhaustive = result;
      return exhaustive;
    }
  }
}
__name(estimateResultBytes, "estimateResultBytes");
function estimatePngResultBytes(result) {
  return result.ok ? result.png.byteLength : Buffer.byteLength(result.error);
}
__name(estimatePngResultBytes, "estimatePngResultBytes");
function findMmdc(env) {
  const explicit = env["QWEN_CODE_MERMAID_MMD_CLI"];
  if (explicit && isExecutable(explicit)) return explicit;
  const mmdc = findExecutable("mmdc", env);
  if (mmdc) return mmdc;
  if (env["QWEN_CODE_MERMAID_ALLOW_NPX"] === "1" && findExecutable("npx", env)) {
    return NPX_MERMAID_CLI;
  }
  return null;
}
__name(findMmdc, "findMmdc");
function findExecutable(command, env) {
  const candidates = [];
  const extensions = process.platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const addCandidates = /* @__PURE__ */ __name((dir) => {
    for (const extension of extensions) {
      candidates.push(path.join(dir, `${command}${extension}`));
    }
  }, "addCandidates");
  const allowLocalRenderers = env["QWEN_CODE_MERMAID_ALLOW_LOCAL_RENDERERS"] === "1";
  const localRendererDir = normalizeExecutableDir(
    process.cwd(),
    "node_modules",
    ".bin"
  );
  if (allowLocalRenderers) {
    addCandidates(localRendererDir);
  }
  for (const dir of (env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    const normalizedDir = normalizeExecutableDir(dir);
    if (!allowLocalRenderers && (normalizedDir === localRendererDir || normalizedDir.endsWith(`${path.sep}node_modules${path.sep}.bin`))) {
      continue;
    }
    addCandidates(dir);
  }
  return candidates.find(isExecutable) ?? null;
}
__name(findExecutable, "findExecutable");
function normalizeExecutableDir(...segments) {
  const dir = path.resolve(...segments);
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
__name(normalizeExecutableDir, "normalizeExecutableDir");
function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
__name(isExecutable, "isExecutable");
async function renderPngWithMmdcAsync(source, mmdc, env, signal) {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "qwen-mermaid-")
  );
  const inputPath = path.join(tempDir, "diagram.mmd");
  const outputPath = path.join(tempDir, "diagram.png");
  const renderWidth = getMermaidRenderWidth(env);
  try {
    await fs.promises.writeFile(inputPath, source, "utf8");
    const mmdcArgs = [
      "-i",
      inputPath,
      "-o",
      outputPath,
      "-b",
      "transparent",
      "-w",
      String(renderWidth)
    ];
    const command = mmdc === NPX_MERMAID_CLI ? findExecutable("npx", env) : mmdc;
    const args = mmdc === NPX_MERMAID_CLI ? ["-y", "@mermaid-js/mermaid-cli@11.12.0", ...mmdcArgs] : mmdcArgs;
    const result = await runCommand(command, args, {
      env: createRendererChildEnv(env),
      shell: shouldRunThroughShell(command),
      timeout: getMermaidRenderTimeout(env),
      signal
    });
    if (result.error) {
      return { ok: false, error: result.error };
    }
    if (result.status !== 0) {
      const stderr = result.stderr.trim();
      return {
        ok: false,
        error: stderr || `Mermaid CLI exited with status ${result.status}.`
      };
    }
    let outputSize;
    try {
      outputSize = (await fs.promises.stat(outputPath)).size;
    } catch {
      return { ok: false, error: "Mermaid CLI did not write an output file." };
    }
    if (outputSize > MAX_MERMAID_PNG_BYTES) {
      return {
        ok: false,
        error: `Mermaid CLI output exceeded ${MAX_MERMAID_PNG_BYTES} bytes.`
      };
    }
    return { ok: true, png: await fs.promises.readFile(outputPath) };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
__name(renderPngWithMmdcAsync, "renderPngWithMmdcAsync");
function shouldRunThroughShell(command) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}
__name(shouldRunThroughShell, "shouldRunThroughShell");
function getMermaidRenderWidth(env) {
  const configuredWidth = Number(env["QWEN_CODE_MERMAID_RENDER_WIDTH"]);
  if (Number.isFinite(configuredWidth) && configuredWidth > 0) {
    return Math.max(320, Math.min(1800, Math.round(configuredWidth)));
  }
  return DEFAULT_MERMAID_RENDER_WIDTH;
}
__name(getMermaidRenderWidth, "getMermaidRenderWidth");
function getMermaidRenderTimeout(env) {
  const configuredTimeout = Number(env["QWEN_CODE_MERMAID_RENDER_TIMEOUT_MS"]);
  if (Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
    return Math.min(Math.round(configuredTimeout), MAX_RENDER_TIMEOUT_MS);
  }
  return DEFAULT_RENDER_TIMEOUT_MS;
}
__name(getMermaidRenderTimeout, "getMermaidRenderTimeout");
function createRendererChildEnv(env) {
  const sourceEnv = { ...process.env, ...env };
  const childEnv = {};
  for (const key of RENDERER_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (value !== void 0) {
      childEnv[key] = value;
    }
  }
  return childEnv;
}
__name(createRendererChildEnv, "createRendererChildEnv");
function getMermaidCellAspectRatio(env) {
  const configuredAspectRatio = Number(
    env["QWEN_CODE_MERMAID_CELL_ASPECT_RATIO"]
  );
  if (Number.isFinite(configuredAspectRatio) && configuredAspectRatio > 0) {
    return Math.max(0.2, Math.min(configuredAspectRatio, 2));
  }
  return 0.5;
}
__name(getMermaidCellAspectRatio, "getMermaidCellAspectRatio");
async function renderPngWithChafaAsync(png, widthCells, rows, chafa, env, signal) {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "qwen-mermaid-")
  );
  const imagePath = path.join(tempDir, "diagram.png");
  try {
    await fs.promises.writeFile(imagePath, png);
    const result = await runCommand(
      chafa,
      [
        "--animate=off",
        "--format=symbols",
        "--symbols=block",
        `--size=${widthCells}x${rows}`,
        imagePath
      ],
      {
        env: createRendererChildEnv(env),
        shell: shouldRunThroughShell(chafa),
        timeout: getMermaidRenderTimeout(env),
        signal
      }
    );
    if (result.error) {
      return { ok: false, error: result.error };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        error: result.stderr.trim() || `chafa exited with status ${result.status}.`
      };
    }
    return { ok: true, output: result.stdout };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
__name(renderPngWithChafaAsync, "renderPngWithChafaAsync");
function runCommand(command, args, options) {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({
        status: null,
        stdout: "",
        stderr: "",
        error: "Command cancelled."
      });
      return;
    }
    const child = spawn(command, args, {
      env: options.env,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = { text: "", truncated: false };
    let stderr = { text: "", truncated: false };
    let settled = false;
    let killTimer;
    let terminationRequested = false;
    const finish = /* @__PURE__ */ __name((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!terminationRequested && killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", handleAbort);
      resolve(result);
    }, "finish");
    const terminateChild = /* @__PURE__ */ __name(() => {
      terminationRequested = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1e3);
      killTimer.unref?.();
    }, "terminateChild");
    const handleAbort = /* @__PURE__ */ __name(() => {
      terminateChild();
      finish({
        status: null,
        stdout: finalizeBoundedRendererOutput(stdout),
        stderr: finalizeBoundedRendererOutput(stderr),
        error: "Command cancelled."
      });
    }, "handleAbort");
    const timer = setTimeout(() => {
      terminateChild();
      finish({
        status: null,
        stdout: finalizeBoundedRendererOutput(stdout),
        stderr: finalizeBoundedRendererOutput(stderr),
        error: `Command timed out after ${options.timeout}ms.`
      });
    }, options.timeout);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedRendererOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedRendererOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({
        status: null,
        stdout: finalizeBoundedRendererOutput(stdout),
        stderr: finalizeBoundedRendererOutput(stderr),
        error: error.message
      });
    });
    child.on("close", (status) => {
      finish({
        status,
        stdout: finalizeBoundedRendererOutput(stdout),
        stderr: finalizeBoundedRendererOutput(stderr)
      });
    });
  });
}
__name(runCommand, "runCommand");
function appendBoundedRendererOutput(current, chunk) {
  if (current.truncated) {
    return current;
  }
  const next = current.text + chunk;
  if (next.length <= MAX_RENDERER_OUTPUT_CHARS) {
    return { text: next, truncated: false };
  }
  return {
    text: next.slice(
      0,
      MAX_RENDERER_OUTPUT_CHARS - OUTPUT_TRUNCATION_MARKER.length
    ) + OUTPUT_TRUNCATION_MARKER,
    truncated: true
  };
}
__name(appendBoundedRendererOutput, "appendBoundedRendererOutput");
function finalizeBoundedRendererOutput(output) {
  if (!output.truncated || output.text.endsWith(OUTPUT_TRUNCATION_MARKER)) {
    return output.text;
  }
  return output.text.slice(
    0,
    MAX_RENDERER_OUTPUT_CHARS - OUTPUT_TRUNCATION_MARKER.length
  ) + OUTPUT_TRUNCATION_MARKER;
}
__name(finalizeBoundedRendererOutput, "finalizeBoundedRendererOutput");
function fitImageToTerminal(size, contentWidth, availableTerminalHeight, env = process.env) {
  const widthCells = Math.max(16, Math.min(contentWidth, 120));
  const naturalRows = Math.ceil(
    size.height / size.width * widthCells * getMermaidCellAspectRatio(env)
  );
  const maxRows = Math.max(4, Math.min(availableTerminalHeight ?? 32, 60));
  return {
    widthCells,
    rows: Math.max(4, Math.min(naturalRows, maxRows))
  };
}
__name(fitImageToTerminal, "fitImageToTerminal");

// packages/cli/src/ui/utils/terminal-image-renderer.ts
var CHAFA_TIMEOUT_MS = 8e3;
var CHAFA_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
var MAX_PREVIEW_WIDTH_CELLS = 72;
var MAX_PREVIEW_ROWS = 24;
var ESTIMATED_CELL_WIDTH_PX = 8;
var ESTIMATED_CELL_HEIGHT_PX = 16;
var MAX_REASON_CHARS = 200;
var MAX_INLINE_IMAGE_DIMENSION = 1e6;
var MAX_INLINE_IMAGE_PIXELS = 64e6;
var CMD_SHELL_METACHARACTERS = /[&|<>^%"!()\n\r]/;
var RENDER_CACHE_LIMIT = 40;
var RENDER_CACHE_BYTE_LIMIT = 32 * 1024 * 1024;
var renderCache = /* @__PURE__ */ new Map();
var renderCacheBytes = 0;
var INLINE_DECODE_CACHE_LIMIT = 4;
var inlineDecodeCache = /* @__PURE__ */ new Map();
var INLINE_DECODE_NEGATIVE_CACHE_LIMIT = 64;
var INLINE_DECODE_NEGATIVE_CACHE_BYTE_LIMIT = 8 * MAX_INLINE_IMAGE_ENCODED_LENGTH;
var invalidInlineImageCache = /* @__PURE__ */ new Map();
var invalidInlineImageCacheBytes = 0;
var TRANSMITTED_KEY_LIMIT = 256;
var transmittedKeys = /* @__PURE__ */ new Set();
function wasKittyImageWritten(key) {
  return transmittedKeys.has(key);
}
__name(wasKittyImageWritten, "wasKittyImageWritten");
function markKittyImageWritten(key) {
  transmittedKeys.add(key);
  if (transmittedKeys.size > TRANSMITTED_KEY_LIMIT) {
    const oldest = transmittedKeys.values().next().value;
    if (oldest !== void 0) {
      transmittedKeys.delete(oldest);
    }
  }
}
__name(markKittyImageWritten, "markKittyImageWritten");
function supportsKittyImageProtocol(env = process.env, stdoutIsTTY = process.stdout.isTTY) {
  if (!stdoutIsTTY || env["TMUX"] || env["SSH_TTY"] || env["SSH_CLIENT"]) {
    return false;
  }
  const term = env["TERM"]?.toLowerCase() ?? "";
  const termProgram = env["TERM_PROGRAM"]?.toLowerCase() ?? "";
  if (termProgram === "warpterminal") {
    return false;
  }
  return Boolean(
    env["KITTY_WINDOW_ID"] || term.includes("kitty") || termProgram.includes("ghostty")
  );
}
__name(supportsKittyImageProtocol, "supportsKittyImageProtocol");
function getTerminalImageRenderSupport(env = process.env, stdoutIsTTY = process.stdout.isTTY) {
  if (supportsKittyImageProtocol(env, stdoutIsTTY)) {
    return { available: true };
  }
  return findExecutable("chafa", env) ? { available: true } : {
    available: false,
    reason: "No compatible native image protocol was detected, and chafa is not installed."
  };
}
__name(getTerminalImageRenderSupport, "getTerminalImageRenderSupport");
function containsCmdShellMetacharacters(filePath) {
  return CMD_SHELL_METACHARACTERS.test(filePath);
}
__name(containsCmdShellMetacharacters, "containsCmdShellMetacharacters");
function prepareInlineTerminalImage({
  data,
  mimeType,
  contentWidth,
  availableTerminalHeight,
  env = process.env,
  stdoutIsTTY = process.stdout.isTTY,
  disabled = false
}) {
  const format = getImageFormat(mimeType);
  const emptyFallback = format ? `[image: ${format}]` : "[image]";
  if (format !== "png") {
    return { fallbackText: emptyFallback, result: null };
  }
  const decoded = getDecodedInlinePng(data);
  if (!decoded) {
    return { fallbackText: emptyFallback, result: null };
  }
  const { png, size } = decoded;
  const fallbackText = `[image: ${size.width}x${size.height} png]`;
  if (disabled) {
    return { fallbackText, result: null };
  }
  const shape = fitImageToTerminal2(size, contentWidth, availableTerminalHeight);
  const useKitty = supportsKittyImageProtocol(env, stdoutIsTTY);
  const chafaPath = useKitty ? null : findExecutable("chafa", env);
  const cacheKey = createInlineRenderCacheKey(png, shape, useKitty, chafaPath);
  const cached = getCachedRenderResult(cacheKey);
  if (cached) {
    return { fallbackText, result: cached };
  }
  const result = useKitty ? { ...renderKitty(png, shape), key: cacheKey } : renderWithChafa({ data: png }, shape, env, chafaPath);
  if (result.kind !== "unavailable") {
    rememberRenderResult(cacheKey, result);
  }
  return { fallbackText, result };
}
__name(prepareInlineTerminalImage, "prepareInlineTerminalImage");
function renderTerminalImage({
  display,
  contentWidth,
  availableTerminalHeight,
  env = process.env,
  stdoutIsTTY = process.stdout.isTTY
}) {
  let stat;
  try {
    stat = fs2.statSync(display.filePath);
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `Image file is unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!stat.isFile()) {
    return {
      kind: "unavailable",
      reason: "Image path is not a regular file."
    };
  }
  if (stat.size > MAX_TERMINAL_IMAGE_BYTES) {
    return {
      kind: "unavailable",
      reason: `Image exceeds the ${MAX_TERMINAL_IMAGE_BYTES} byte display limit.`
    };
  }
  const headerSize = readPngHeaderSize(display.filePath);
  if (!headerSize) {
    return { kind: "unavailable", reason: "Image is not a valid PNG." };
  }
  const shape = fitImageToTerminal2(
    headerSize,
    contentWidth,
    availableTerminalHeight
  );
  const useKitty = supportsKittyImageProtocol(env, stdoutIsTTY);
  const chafaPath = useKitty ? null : findExecutable("chafa", env);
  const cacheKey = createRenderCacheKey(
    display.filePath,
    stat,
    shape,
    useKitty,
    chafaPath
  );
  const cached = getCachedRenderResult(cacheKey);
  if (cached) return cached;
  let png;
  try {
    png = fs2.readFileSync(display.filePath);
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `Unable to read image: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (png.length > MAX_TERMINAL_IMAGE_BYTES) {
    return {
      kind: "unavailable",
      reason: `Image exceeds the ${MAX_TERMINAL_IMAGE_BYTES} byte display limit.`
    };
  }
  const result = useKitty ? { ...renderKitty(png, shape), key: cacheKey } : renderWithChafa({ filePath: display.filePath }, shape, env, chafaPath);
  if (result.kind !== "unavailable") {
    rememberRenderResult(cacheKey, result);
  }
  return result;
}
__name(renderTerminalImage, "renderTerminalImage");
function readPngHeaderSize(filePath) {
  let fd;
  try {
    fd = fs2.openSync(filePath, "r");
    const header = Buffer.alloc(24);
    const bytesRead = fs2.readSync(fd, header, 0, header.length, 0);
    return bytesRead === header.length ? readPngSize(header) : null;
  } catch {
    return null;
  } finally {
    if (fd !== void 0) {
      try {
        fs2.closeSync(fd);
      } catch {
      }
    }
  }
}
__name(readPngHeaderSize, "readPngHeaderSize");
function createRenderCacheKey(filePath, stat, shape, useKitty, chafaPath) {
  return [
    filePath,
    stat.mtimeMs,
    stat.size,
    shape.widthCells,
    shape.rows,
    useKitty ? "kitty" : chafaPath ?? "none"
  ].join("\0");
}
__name(createRenderCacheKey, "createRenderCacheKey");
function createInlineRenderCacheKey(png, shape, useKitty, chafaPath) {
  return [
    "inline",
    crypto2.createHash("sha256").update(png).digest("hex"),
    shape.widthCells,
    shape.rows,
    useKitty ? "kitty" : chafaPath ?? "none"
  ].join("\0");
}
__name(createInlineRenderCacheKey, "createInlineRenderCacheKey");
function getImageFormat(mimeType) {
  const match = /^image\/([a-z0-9][a-z0-9.+-]*)$/.exec(
    mimeType.trim().toLowerCase()
  );
  return match?.[1] ?? null;
}
__name(getImageFormat, "getImageFormat");
function decodeInlineImage(data) {
  const normalized = data.replace(/\s/g, "");
  if (normalized.length === 0 || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return null;
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0 || decoded.length > MAX_TERMINAL_IMAGE_BYTES || decoded.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    return null;
  }
  return decoded;
}
__name(decodeInlineImage, "decodeInlineImage");
function getDecodedInlinePng(data) {
  if (data.length === 0 || data.length > MAX_INLINE_IMAGE_ENCODED_LENGTH) {
    return null;
  }
  const cached = inlineDecodeCache.get(data);
  if (cached) {
    inlineDecodeCache.delete(data);
    inlineDecodeCache.set(data, cached);
    return cached;
  }
  const invalidBytes = invalidInlineImageCache.get(data);
  if (invalidBytes !== void 0) {
    invalidInlineImageCache.delete(data);
    invalidInlineImageCache.set(data, invalidBytes);
    return null;
  }
  const png = decodeInlineImage(data);
  const size = png ? readValidatedInlinePngSize(png) : null;
  if (!png || !size) {
    const dataBytes = Buffer.byteLength(data);
    invalidInlineImageCache.set(data, dataBytes);
    invalidInlineImageCacheBytes += dataBytes;
    while (invalidInlineImageCache.size > INLINE_DECODE_NEGATIVE_CACHE_LIMIT || invalidInlineImageCacheBytes > INLINE_DECODE_NEGATIVE_CACHE_BYTE_LIMIT) {
      const oldest = invalidInlineImageCache.entries().next().value;
      if (oldest === void 0) break;
      invalidInlineImageCache.delete(oldest[0]);
      invalidInlineImageCacheBytes -= oldest[1];
    }
    return null;
  }
  const decoded = { png, size };
  inlineDecodeCache.set(data, decoded);
  while (inlineDecodeCache.size > INLINE_DECODE_CACHE_LIMIT) {
    const oldest = inlineDecodeCache.keys().next().value;
    if (oldest === void 0) break;
    inlineDecodeCache.delete(oldest);
  }
  return decoded;
}
__name(getDecodedInlinePng, "getDecodedInlinePng");
function readValidatedInlinePngSize(png) {
  if (png.length < 24 || png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString("ascii") !== "IHDR") {
    return null;
  }
  const size = readPngSize(png);
  if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0 || size.width > MAX_INLINE_IMAGE_DIMENSION || size.height > MAX_INLINE_IMAGE_DIMENSION || size.width * size.height > MAX_INLINE_IMAGE_PIXELS) {
    return null;
  }
  return size;
}
__name(readValidatedInlinePngSize, "readValidatedInlinePngSize");
function getCachedRenderResult(key) {
  const cached = renderCache.get(key);
  if (cached) {
    renderCache.delete(key);
    renderCache.set(key, cached);
  }
  return cached;
}
__name(getCachedRenderResult, "getCachedRenderResult");
function rememberRenderResult(key, result) {
  const bytes = estimateRenderResultBytes(result);
  if (bytes > RENDER_CACHE_BYTE_LIMIT) {
    renderCache.delete(key);
    return;
  }
  const existing = renderCache.get(key);
  if (existing) {
    renderCacheBytes -= estimateRenderResultBytes(existing);
  }
  renderCache.set(key, result);
  renderCacheBytes += bytes;
  while (renderCache.size > RENDER_CACHE_LIMIT || renderCacheBytes > RENDER_CACHE_BYTE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (!oldest) break;
    const oldestResult = renderCache.get(oldest);
    if (oldestResult) {
      renderCacheBytes -= estimateRenderResultBytes(oldestResult);
    }
    renderCache.delete(oldest);
  }
}
__name(rememberRenderResult, "rememberRenderResult");
function estimateRenderResultBytes(result) {
  switch (result.kind) {
    case "kitty":
      return Buffer.byteLength(result.sequence, "utf8") + result.placeholder.lines.reduce(
        (total, line) => total + Buffer.byteLength(line, "utf8"),
        0
      );
    case "ansi":
      return result.lines.reduce(
        (total, line) => total + Buffer.byteLength(line, "utf8"),
        0
      );
    case "unavailable":
      return Buffer.byteLength(result.reason, "utf8");
    default: {
      const exhaustive = result;
      return exhaustive;
    }
  }
}
__name(estimateRenderResultBytes, "estimateRenderResultBytes");
function fitImageToTerminal2(size, contentWidth, availableTerminalHeight) {
  const maxWidthCells = Math.max(
    1,
    Math.min(Math.floor(contentWidth), MAX_PREVIEW_WIDTH_CELLS)
  );
  const maxRows = Math.max(
    1,
    Math.min(
      Math.floor(availableTerminalHeight ?? MAX_PREVIEW_ROWS),
      MAX_PREVIEW_ROWS
    )
  );
  const naturalWidthCells = Math.max(1, size.width / ESTIMATED_CELL_WIDTH_PX);
  const naturalRows = Math.max(1, size.height / ESTIMATED_CELL_HEIGHT_PX);
  const scale = Math.min(
    1,
    maxWidthCells / naturalWidthCells,
    maxRows / naturalRows
  );
  return {
    widthCells: Math.max(
      1,
      Math.min(maxWidthCells, Math.floor(naturalWidthCells * scale))
    ),
    rows: Math.max(1, Math.min(maxRows, Math.floor(naturalRows * scale)))
  };
}
__name(fitImageToTerminal2, "fitImageToTerminal");
function createImageId(png, shape) {
  const hash = crypto2.createHash("sha256").update(png).update("\0").update(String(shape.widthCells)).update("\0").update(String(shape.rows)).digest();
  const id = hash.readUIntBE(0, 3);
  return id === 0 ? 1 : id;
}
__name(createImageId, "createImageId");
function renderKitty(png, shape) {
  const imageId = createImageId(png, shape);
  return {
    kind: "kitty",
    sequence: encodeKittyVirtualImage(
      png,
      imageId,
      shape.widthCells,
      shape.rows
    ),
    placeholder: buildKittyPlaceholder(imageId, shape.widthCells, shape.rows)
  };
}
__name(renderKitty, "renderKitty");
function renderWithChafa(source, shape, env, chafaPath) {
  if (!chafaPath) {
    return {
      kind: "unavailable",
      reason: "No compatible native image protocol was detected, and chafa is not installed."
    };
  }
  const useShell = shouldRunThroughShell(chafaPath);
  if (useShell && "filePath" in source && containsCmdShellMetacharacters(source.filePath)) {
    return {
      kind: "unavailable",
      reason: "Image path contains characters that cannot be safely passed to the renderer on this platform."
    };
  }
  try {
    const stdout = execFileSync(
      chafaPath,
      [
        "--animate=off",
        "--colors=256",
        "--format=symbols",
        "--symbols=block",
        `--size=${shape.widthCells}x${shape.rows}`,
        "filePath" in source ? source.filePath : "-"
      ],
      {
        encoding: "utf8",
        env: createRendererChildEnv(env),
        shell: useShell,
        maxBuffer: CHAFA_MAX_OUTPUT_BYTES,
        timeout: CHAFA_TIMEOUT_MS,
        ..."data" in source ? { input: source.data } : {}
      }
    );
    const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
    return lines.length > 0 ? { kind: "ansi", lines } : { kind: "unavailable", reason: "chafa produced no output." };
  } catch (error) {
    const execError = error;
    const stderr = firstLineBounded(String(execError.stderr ?? "").trim());
    return {
      kind: "unavailable",
      reason: stderr || execError.message || "chafa could not render the image."
    };
  }
}
__name(renderWithChafa, "renderWithChafa");
function firstLineBounded(text) {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > MAX_REASON_CHARS ? `${firstLine.slice(0, MAX_REASON_CHARS)}\u2026` : firstLine;
}
__name(firstLineBounded, "firstLineBounded");

export {
  renderMermaidImageAsync,
  MAX_INLINE_IMAGE_PIXELS,
  INLINE_DECODE_NEGATIVE_CACHE_LIMIT,
  INLINE_DECODE_NEGATIVE_CACHE_BYTE_LIMIT,
  TRANSMITTED_KEY_LIMIT,
  wasKittyImageWritten,
  markKittyImageWritten,
  supportsKittyImageProtocol,
  getTerminalImageRenderSupport,
  containsCmdShellMetacharacters,
  prepareInlineTerminalImage,
  renderTerminalImage
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
