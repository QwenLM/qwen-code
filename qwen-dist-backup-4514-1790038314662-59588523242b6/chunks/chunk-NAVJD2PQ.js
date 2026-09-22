// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/secure-browser-launcher.ts
init_esbuild_shims();
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";

// packages/core/src/utils/browser.ts
init_esbuild_shims();
var browserBlocklist = ["www-browser"];
function isBrowserCommandBlocked(command) {
  const commandName = command.replace(/\\/g, "/").split("/").pop();
  return !!commandName && browserBlocklist.includes(commandName);
}
__name(isBrowserCommandBlocked, "isBrowserCommandBlocked");
function shouldAttemptBrowserLaunch(options = {}) {
  const browserEnv = process.env["BROWSER"]?.trim();
  const browserCommand = browserEnv?.match(/^\S+/)?.[0];
  if (!options.ignoreBrowserBlocklist && process.platform !== "win32" && browserCommand && isBrowserCommandBlocked(browserCommand)) {
    return false;
  }
  if (process.env["CI"] || process.env["DEBIAN_FRONTEND"] === "noninteractive") {
    return false;
  }
  const isSSH = !!process.env["SSH_CONNECTION"];
  if (process.platform === "linux") {
    const displayVariables = ["DISPLAY", "WAYLAND_DISPLAY", "MIR_SOCKET"];
    const hasDisplay = displayVariables.some((v) => !!process.env[v]);
    if (!hasDisplay) {
      return false;
    }
  }
  if (isSSH && process.platform !== "linux") {
    return false;
  }
  return true;
}
__name(shouldAttemptBrowserLaunch, "shouldAttemptBrowserLaunch");

// packages/core/src/utils/secure-browser-launcher.ts
var execFileAsync = promisify(execFile);
function validateUrl(url, { allowFile = false, allowedFilePaths } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (_error) {
    throw new Error(`Invalid URL: ${url}`);
  }
  const allowedProtocols = allowFile ? ["http:", "https:", "file:"] : ["http:", "https:"];
  if (!allowedProtocols.includes(parsedUrl.protocol)) {
    throw new Error(
      `Unsafe protocol: ${parsedUrl.protocol}. Only ${allowedProtocols.join(
        ", "
      )} are allowed.`
    );
  }
  if (parsedUrl.protocol === "file:" && allowFile) {
    if (!allowedFilePaths?.length) {
      throw new Error("allowedFilePaths is required when allowFile is true");
    }
    const requestedPath = resolve(fileURLToPath(parsedUrl));
    const allowed = allowedFilePaths.map((filePath) => resolve(filePath));
    if (!allowed.includes(requestedPath)) {
      throw new Error("File URL is not in the allowed file set");
    }
  }
  if (/[\r\n\x00-\x1f]/.test(url)) {
    throw new Error("URL contains invalid characters");
  }
}
__name(validateUrl, "validateUrl");
async function openBrowserSecurely(url, browserOptions = {}) {
  validateUrl(url, browserOptions);
  const platformName = platform();
  let command;
  let args;
  const browserEnv = process.env["BROWSER"]?.trim();
  const browserCommand = platformName === "win32" ? void 0 : buildBrowserCommand(browserEnv, url);
  if (browserCommand) {
    try {
      await launchDetached(browserCommand.command, browserCommand.args);
      return;
    } catch (_error) {
      console.warn(
        `Failed to open BROWSER command ${browserCommand.command}: ${formatLaunchError(
          _error
        )}. Falling back to the platform browser opener.`
      );
    }
  }
  if (!shouldAttemptBrowserLaunch({ ignoreBrowserBlocklist: true })) {
    console.warn(
      `Browser launch is not available in this environment. Please open this URL manually: ${url}`
    );
    return;
  }
  {
    switch (platformName) {
      case "darwin":
        command = "open";
        args = [url];
        break;
      case "win32":
        command = "powershell.exe";
        args = [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          `Start-Process '${url.replace(/'/g, "''")}'`
        ];
        break;
      case "linux":
      case "freebsd":
      case "openbsd":
        command = "xdg-open";
        args = [url];
        break;
      default:
        throw new Error(`Unsupported platform: ${platformName}`);
    }
  }
  const execOptions = {
    // Don't inherit parent's environment to avoid potential issues
    env: {
      ...process.env,
      // Ensure we're not in a shell that might interpret special characters
      SHELL: void 0
    },
    // Detach the browser process so it doesn't block
    detached: true,
    stdio: "ignore"
  };
  try {
    await execFileAsync(command, args, execOptions);
  } catch (_error) {
    if ((platformName === "linux" || platformName === "freebsd" || platformName === "openbsd") && command === "xdg-open") {
      const fallbackCommands = [
        { command: "gnome-open", detached: false },
        { command: "kde-open", detached: false },
        { command: "firefox", detached: true },
        { command: "chromium", detached: true },
        { command: "google-chrome", detached: true },
        { command: "microsoft-edge", detached: true }
      ];
      for (const { command: fallbackCommand, detached } of fallbackCommands) {
        try {
          if (detached) {
            await launchDetached(fallbackCommand, [url]);
          } else {
            await execFileAsync(fallbackCommand, [url], execOptions);
          }
          return;
        } catch {
          continue;
        }
      }
    }
    console.warn(
      `Failed to open browser automatically. Please open this URL manually: ${url}`
    );
    return;
  }
}
__name(openBrowserSecurely, "openBrowserSecurely");
async function launchDetached(command, args) {
  const spawnOptions = {
    env: {
      ...process.env,
      SHELL: void 0
    },
    detached: true,
    stdio: "ignore"
  };
  await new Promise((resolve2, reject) => {
    const child = spawn(command, args, spawnOptions);
    let settled = false;
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) {
        return;
      }
      settled = true;
      child.unref();
      resolve2();
    });
  });
}
__name(launchDetached, "launchDetached");
function formatLaunchError(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(formatLaunchError, "formatLaunchError");
function buildBrowserCommand(browserEnv, url) {
  if (!browserEnv) {
    return void 0;
  }
  const browserCommand = parseBrowserCommand(browserEnv);
  if (!browserCommand) {
    console.warn(
      "Invalid BROWSER environment variable, falling back to platform default."
    );
    return void 0;
  }
  if (isBrowserCommandBlocked(browserCommand.command)) {
    return void 0;
  }
  let usedPlaceholder = false;
  const args = browserCommand.args.map((arg) => {
    if (!arg.includes("%s")) {
      return arg;
    }
    usedPlaceholder = true;
    return arg.replace(/%s/g, () => url);
  });
  if (!usedPlaceholder) {
    args.push(url);
  }
  return { command: browserCommand.command, args };
}
__name(buildBrowserCommand, "buildBrowserCommand");
function parseBrowserCommand(browserEnv) {
  const parts = [];
  let current = "";
  let quote;
  for (const char of browserEnv) {
    if (quote) {
      if (char === quote) {
        quote = void 0;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) {
    return void 0;
  }
  if (current) {
    parts.push(current);
  }
  const [command, ...args] = parts;
  if (!command) {
    return void 0;
  }
  return { command, args };
}
__name(parseBrowserCommand, "parseBrowserCommand");
function shouldLaunchBrowser() {
  return shouldAttemptBrowserLaunch();
}
__name(shouldLaunchBrowser, "shouldLaunchBrowser");

export {
  shouldAttemptBrowserLaunch,
  openBrowserSecurely,
  shouldLaunchBrowser
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
