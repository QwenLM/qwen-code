// Force strict mode and setup for ESM
"use strict";
import {
  getPackageJson
} from "./chunk-W3N5XAZ6.js";
import {
  stripAnsiAndControl
} from "./chunk-B3XJFEEH.js";
import {
  FatalSandboxError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __require,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/command-exists/lib/command-exists.js
var require_command_exists = __commonJS({
  "node_modules/command-exists/lib/command-exists.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var exec = __require("child_process").exec;
    var execSync = __require("child_process").execSync;
    var fs = __require("fs");
    var path = __require("path");
    var access = fs.access;
    var accessSync = fs.accessSync;
    var constants = fs.constants || fs;
    var isUsingWindows = process.platform == "win32";
    var fileNotExists = /* @__PURE__ */ __name(function(commandName, callback) {
      access(
        commandName,
        constants.F_OK,
        function(err) {
          callback(!err);
        }
      );
    }, "fileNotExists");
    var fileNotExistsSync = /* @__PURE__ */ __name(function(commandName) {
      try {
        accessSync(commandName, constants.F_OK);
        return false;
      } catch (e) {
        return true;
      }
    }, "fileNotExistsSync");
    var localExecutable = /* @__PURE__ */ __name(function(commandName, callback) {
      access(
        commandName,
        constants.F_OK | constants.X_OK,
        function(err) {
          callback(null, !err);
        }
      );
    }, "localExecutable");
    var localExecutableSync = /* @__PURE__ */ __name(function(commandName) {
      try {
        accessSync(commandName, constants.F_OK | constants.X_OK);
        return true;
      } catch (e) {
        return false;
      }
    }, "localExecutableSync");
    var commandExistsUnix = /* @__PURE__ */ __name(function(commandName, cleanedCommandName, callback) {
      fileNotExists(commandName, function(isFile) {
        if (!isFile) {
          var child = exec(
            "command -v " + cleanedCommandName + " 2>/dev/null && { echo >&1 " + cleanedCommandName + "; exit 0; }",
            function(error, stdout, stderr) {
              callback(null, !!stdout);
            }
          );
          return;
        }
        localExecutable(commandName, callback);
      });
    }, "commandExistsUnix");
    var commandExistsWindows = /* @__PURE__ */ __name(function(commandName, cleanedCommandName, callback) {
      if (!/^(?!(?:.*\s|.*\.|\W+)$)(?:[a-zA-Z]:)?(?:(?:[^<>:"\|\?\*\n])+(?:\/\/|\/|\\\\|\\)?)+$/m.test(commandName)) {
        callback(null, false);
        return;
      }
      var child = exec(
        "where " + cleanedCommandName,
        function(error) {
          if (error !== null) {
            callback(null, false);
          } else {
            callback(null, true);
          }
        }
      );
    }, "commandExistsWindows");
    var commandExistsUnixSync = /* @__PURE__ */ __name(function(commandName, cleanedCommandName) {
      if (fileNotExistsSync(commandName)) {
        try {
          var stdout = execSync(
            "command -v " + cleanedCommandName + " 2>/dev/null && { echo >&1 " + cleanedCommandName + "; exit 0; }"
          );
          return !!stdout;
        } catch (error) {
          return false;
        }
      }
      return localExecutableSync(commandName);
    }, "commandExistsUnixSync");
    var commandExistsWindowsSync = /* @__PURE__ */ __name(function(commandName, cleanedCommandName, callback) {
      if (!/^(?!(?:.*\s|.*\.|\W+)$)(?:[a-zA-Z]:)?(?:(?:[^<>:"\|\?\*\n])+(?:\/\/|\/|\\\\|\\)?)+$/m.test(commandName)) {
        return false;
      }
      try {
        var stdout = execSync("where " + cleanedCommandName, { stdio: [] });
        return !!stdout;
      } catch (error) {
        return false;
      }
    }, "commandExistsWindowsSync");
    var cleanInput = /* @__PURE__ */ __name(function(s) {
      if (/[^A-Za-z0-9_\/:=-]/.test(s)) {
        s = "'" + s.replace(/'/g, "'\\''") + "'";
        s = s.replace(/^(?:'')+/g, "").replace(/\\'''/g, "\\'");
      }
      return s;
    }, "cleanInput");
    if (isUsingWindows) {
      cleanInput = /* @__PURE__ */ __name(function(s) {
        var isPathName = /[\\]/.test(s);
        if (isPathName) {
          var dirname = '"' + path.dirname(s) + '"';
          var basename = '"' + path.basename(s) + '"';
          return dirname + ":" + basename;
        }
        return '"' + s + '"';
      }, "cleanInput");
    }
    module.exports = /* @__PURE__ */ __name(function commandExists2(commandName, callback) {
      var cleanedCommandName = cleanInput(commandName);
      if (!callback && typeof Promise !== "undefined") {
        return new Promise(function(resolve, reject) {
          commandExists2(commandName, function(error, output) {
            if (output) {
              resolve(commandName);
            } else {
              reject(error);
            }
          });
        });
      }
      if (isUsingWindows) {
        commandExistsWindows(commandName, cleanedCommandName, callback);
      } else {
        commandExistsUnix(commandName, cleanedCommandName, callback);
      }
    }, "commandExists");
    module.exports.sync = function(commandName) {
      var cleanedCommandName = cleanInput(commandName);
      if (isUsingWindows) {
        return commandExistsWindowsSync(commandName, cleanedCommandName);
      } else {
        return commandExistsUnixSync(commandName, cleanedCommandName);
      }
    };
  }
});

// node_modules/command-exists/index.js
var require_command_exists2 = __commonJS({
  "node_modules/command-exists/index.js"(exports, module) {
    init_esbuild_shims();
    module.exports = require_command_exists();
  }
});

// packages/cli/src/config/sandboxConfig.ts
init_esbuild_shims();
var import_command_exists = __toESM(require_command_exists2(), 1);
import { spawnSync } from "node:child_process";
import * as os from "node:os";
var VALID_SANDBOX_COMMANDS = [
  "docker",
  "podman",
  "sandbox-exec",
  "bwrap"
];
var CONTAINER_SANDBOX_COMMANDS = [
  "docker",
  "podman"
];
function isContainerSandboxCommand(command) {
  return CONTAINER_SANDBOX_COMMANDS.includes(command);
}
__name(isContainerSandboxCommand, "isContainerSandboxCommand");
function isSandboxCommand(value) {
  return VALID_SANDBOX_COMMANDS.includes(value);
}
__name(isSandboxCommand, "isSandboxCommand");
var SANDBOX_PROBE_TIMEOUT_MS = 5e3;
var BWRAP_PROBE_ARGS = [
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--die-with-parent",
  "--",
  "true"
];
function probeArgsFor(command) {
  return command === "bwrap" ? BWRAP_PROBE_ARGS : ["version"];
}
__name(probeArgsFor, "probeArgsFor");
var probeCache = /* @__PURE__ */ new Map();
function resetSandboxProbeCacheForTest() {
  probeCache.clear();
}
__name(resetSandboxProbeCacheForTest, "resetSandboxProbeCacheForTest");
function probeSandboxCommand(command) {
  if (command === "sandbox-exec") {
    return void 0;
  }
  if (probeCache.has(command)) {
    return probeCache.get(command);
  }
  const failure = runSandboxProbe(command);
  probeCache.set(command, failure);
  return failure;
}
__name(probeSandboxCommand, "probeSandboxCommand");
function runSandboxProbe(command) {
  try {
    const result = spawnSync(command, [...probeArgsFor(command)], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: SANDBOX_PROBE_TIMEOUT_MS
    });
    if (result.error) {
      return result.error.message;
    }
    if (result.status === 0) {
      return void 0;
    }
    const output = `${result.stderr ?? ""}
${result.stdout ?? ""}`;
    const firstLine = output.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
    const stripped = firstLine ? stripAnsiAndControl(firstLine).trim() : "";
    const probeLabel = command === "bwrap" ? command : `${command} version`;
    return stripped || `'${probeLabel}' exited with ${result.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
__name(runSandboxProbe, "runSandboxProbe");
function getSandboxCommand(sandbox) {
  if (process.env["SANDBOX"]) {
    return "";
  }
  const environmentConfiguredSandbox = process.env["QWEN_SANDBOX"]?.toLowerCase().trim() ?? "";
  sandbox = environmentConfiguredSandbox?.length > 0 ? environmentConfiguredSandbox : sandbox;
  if (sandbox === "1" || sandbox === "true") sandbox = true;
  else if (sandbox === "0" || sandbox === "false" || !sandbox) sandbox = false;
  if (sandbox === false) {
    return "";
  }
  const sandboxSource = environmentConfiguredSandbox.length > 0 ? " (from QWEN_SANDBOX)" : "";
  if (typeof sandbox === "string" && sandbox) {
    if (!isSandboxCommand(sandbox)) {
      throw new FatalSandboxError(
        `Invalid sandbox command '${sandbox}'. Must be one of ${VALID_SANDBOX_COMMANDS.join(
          ", "
        )}`
      );
    }
    if (import_command_exists.default.sync(sandbox)) {
      const failure = probeSandboxCommand(sandbox);
      if (failure) {
        throw new FatalSandboxError(
          `Sandbox command '${sandbox}'${sandboxSource} is installed but cannot run: ${failure}`
        );
      }
      return sandbox;
    }
    throw new FatalSandboxError(
      `Missing sandbox command '${sandbox}'${sandboxSource}`
    );
  }
  const candidates = [];
  if (os.platform() === "darwin" && import_command_exists.default.sync("sandbox-exec")) {
    candidates.push("sandbox-exec");
  }
  if (sandbox === true) {
    candidates.push("docker", "podman");
  }
  let firstFailure;
  for (const candidate of candidates) {
    if (!import_command_exists.default.sync(candidate)) {
      continue;
    }
    const failure = probeSandboxCommand(candidate);
    if (!failure) {
      return candidate;
    }
    firstFailure ??= { command: candidate, detail: failure };
  }
  if (sandbox === true) {
    const enabledLabel = sandboxSource ? "QWEN_SANDBOX is true" : "Sandbox is enabled";
    const specifyHint = sandboxSource ? "specify command in QWEN_SANDBOX" : "specify command via --sandbox or QWEN_SANDBOX";
    if (firstFailure) {
      throw new FatalSandboxError(
        `${enabledLabel} and '${firstFailure.command}' is installed but cannot run: ${firstFailure.detail}; start it, try another installed runtime, or ${specifyHint}`
      );
    }
    throw new FatalSandboxError(
      `${enabledLabel} but failed to determine command for sandbox; install docker or podman or ${specifyHint}`
    );
  }
  return "";
}
__name(getSandboxCommand, "getSandboxCommand");
async function loadSandboxConfig(settings, argv) {
  const sandboxOption = argv.sandbox ?? settings.tools?.sandbox;
  const command = getSandboxCommand(sandboxOption);
  const packageJson = await getPackageJson();
  const image = argv.sandboxImage ?? process.env["QWEN_SANDBOX_IMAGE"] ?? settings.tools?.sandboxImage ?? packageJson?.config?.sandboxImageUri;
  if (!command) {
    return void 0;
  }
  if (isContainerSandboxCommand(command)) {
    return image ? { command, image } : void 0;
  }
  return { command };
}
__name(loadSandboxConfig, "loadSandboxConfig");

export {
  resetSandboxProbeCacheForTest,
  loadSandboxConfig
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
