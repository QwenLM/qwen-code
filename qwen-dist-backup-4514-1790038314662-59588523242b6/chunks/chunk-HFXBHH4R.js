// Force strict mode and setup for ESM
"use strict";
import {
  CUSTOM_SANDBOX_IMAGE_ENV_VAR,
  HOST_UPDATE_RELAUNCH_ENV_VAR,
  SKIP_UPDATE_CHECK_ENV_VAR
} from "./chunk-A4L3TDKL.js";
import {
  getUserSettingsDir
} from "./chunk-DRYBBTI5.js";
import {
  SETTINGS_DIRECTORY_NAME
} from "./chunk-DJJJPHS3.js";
import {
  QWEN_CODE_DESKTOP_ENV,
  QWEN_CODE_SERVE_ENV
} from "./chunk-4VYTH6OF.js";
import {
  gitEnv
} from "./chunk-MRTRBONQ.js";
import {
  require_shell_quote
} from "./chunk-QPTE6BKL.js";
import {
  resolveBundleDir
} from "./chunk-ACHCT36C.js";
import {
  Storage,
  isSubpath
} from "./chunk-ZYDMQCQP.js";
import {
  FatalSandboxError
} from "./chunk-S34QJ6IR.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/sandbox.ts
init_esbuild_shims();
var import_shell_quote = __toESM(require_shell_quote(), 1);
import {
  exec,
  execSync,
  spawn,
  spawnSync
} from "node:child_process";
import os2 from "node:os";
import path2 from "node:path";
import fs from "node:fs";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

// packages/cli/src/utils/sandboxImageName.ts
init_esbuild_shims();
function parseSandboxImageName(image) {
  const imageWithoutDigest = image.split("@")[0] ?? image;
  const lastSlash = imageWithoutDigest.lastIndexOf("/");
  const lastColon = imageWithoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const fullName = hasTag ? imageWithoutDigest.slice(0, lastColon) : imageWithoutDigest;
  const tag = hasTag ? imageWithoutDigest.slice(lastColon + 1) : void 0;
  const name = fullName.split("/").at(-1) || "unknown-image";
  return tag ? `${name}-${tag}` : name;
}
__name(parseSandboxImageName, "parseSandboxImageName");

// packages/cli/src/utils/sandbox-path.ts
init_esbuild_shims();
import path from "node:path";
function isContainerPathWithinWorkdir(containerWorkdir, containerPath) {
  const normalize = /* @__PURE__ */ __name((value) => {
    const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/\/+$/, "").toLowerCase();
    return normalized || "/";
  }, "normalize");
  const normalizedWorkdir = normalize(containerWorkdir);
  const normalizedPath = normalize(containerPath);
  if (normalizedWorkdir === "/") {
    return normalizedPath.startsWith("/");
  }
  return normalizedPath === normalizedWorkdir || normalizedPath.startsWith(`${normalizedWorkdir}/`);
}
__name(isContainerPathWithinWorkdir, "isContainerPathWithinWorkdir");

// packages/cli/src/utils/sandboxMounts.ts
init_esbuild_shims();
import os from "node:os";
function parseSandboxMountSpec(rawMount, platform = os.platform()) {
  const mount = rawMount.trim();
  const mountSeparator = platform === "win32" && /^[A-Za-z]:[\\/]/.test(mount) ? mount.indexOf(":", 2) : mount.indexOf(":");
  const from = mountSeparator === -1 ? mount : mount.slice(0, mountSeparator);
  const rest = mountSeparator === -1 ? "" : mount.slice(mountSeparator + 1);
  const [toPart, optsPart] = rest.split(":");
  return {
    from,
    to: toPart || from,
    opts: optsPart || "ro"
  };
}
__name(parseSandboxMountSpec, "parseSandboxMountSpec");

// packages/cli/src/serve/sandbox.ts
var execAsync = promisify(exec);
function getContainerPath(hostPath) {
  if (os2.platform() !== "win32") {
    return hostPath;
  }
  const withForwardSlashes = hostPath.replace(/\\/g, "/");
  const match = withForwardSlashes.match(/^([A-Z]):\/(.*)/i);
  if (match) {
    return `/${match[1].toLowerCase()}/${match[2]}`;
  }
  return hostPath;
}
__name(getContainerPath, "getContainerPath");
function ensureDirectoryAndGetRealPath(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return fs.realpathSync(dir);
}
__name(ensureDirectoryAndGetRealPath, "ensureDirectoryAndGetRealPath");
var LOCAL_DEV_SANDBOX_IMAGE_NAME = "qwen-code-sandbox";
var SANDBOX_NETWORK_NAME = "qwen-code-sandbox";
var SANDBOX_PROXY_NAME = "qwen-code-sandbox-proxy";
var BUILTIN_SEATBELT_PROFILES = [
  "permissive-open",
  "permissive-closed",
  "permissive-proxied",
  "restrictive-open",
  "restrictive-closed",
  "restrictive-proxied"
];
function getSandboxPassthroughEnvArgs(env = process.env) {
  return [
    "QWEN_DEBUG_LOG_FILE",
    "QWEN_CODE_LEGACY_MCP_BLOCKING",
    SKIP_UPDATE_CHECK_ENV_VAR,
    CUSTOM_SANDBOX_IMAGE_ENV_VAR,
    HOST_UPDATE_RELAUNCH_ENV_VAR,
    QWEN_CODE_SERVE_ENV,
    QWEN_CODE_DESKTOP_ENV
  ].flatMap(
    (envVar) => env[envVar] === void 0 ? [] : ["--env", `${envVar}=${env[envVar]}`]
  );
}
__name(getSandboxPassthroughEnvArgs, "getSandboxPassthroughEnvArgs");
function resolveSeatbeltProfileFile(profile, importMetaUrl = import.meta.url) {
  if (!BUILTIN_SEATBELT_PROFILES.includes(profile)) {
    return path2.join(SETTINGS_DIRECTORY_NAME, `sandbox-macos-${profile}.sb`);
  }
  return path2.join(
    resolveBundleDir(importMetaUrl),
    `sandbox-macos-${profile}.sb`
  );
}
__name(resolveSeatbeltProfileFile, "resolveSeatbeltProfileFile");
async function shouldUseCurrentUserInSandbox() {
  const envVar = process.env["SANDBOX_SET_UID_GID"]?.toLowerCase().trim();
  if (envVar === "1" || envVar === "true") {
    return true;
  }
  if (envVar === "0" || envVar === "false") {
    return false;
  }
  if (os2.platform() === "linux") {
    const debugEnv = [process.env["DEBUG"], process.env["DEBUG_MODE"]].some(
      (v) => v === "true" || v === "1"
    );
    if (debugEnv) {
      writeStderrLine(
        "INFO: Using current user UID/GID in Linux sandbox. Set SANDBOX_SET_UID_GID=false to disable."
      );
    }
    return true;
  }
  return false;
}
__name(shouldUseCurrentUserInSandbox, "shouldUseCurrentUserInSandbox");
function ports() {
  return (process.env["SANDBOX_PORTS"] ?? "").split(",").filter((p) => p.trim()).map((p) => p.trim());
}
__name(ports, "ports");
function entrypoint(workdir, cliArgs) {
  const isWindows = os2.platform() === "win32";
  const containerWorkdir = getContainerPath(workdir);
  const shellCmds = [];
  const pathSeparator = isWindows ? ";" : ":";
  let pathSuffix = "";
  if (process.env["PATH"]) {
    const paths = process.env["PATH"].split(pathSeparator);
    for (const p of paths) {
      const containerPath = getContainerPath(p);
      if (isContainerPathWithinWorkdir(containerWorkdir, containerPath)) {
        pathSuffix += `:${containerPath}`;
      }
    }
  }
  if (pathSuffix) {
    shellCmds.push(`export PATH="$PATH${pathSuffix}";`);
  }
  let pythonPathSuffix = "";
  if (process.env["PYTHONPATH"]) {
    const paths = process.env["PYTHONPATH"].split(pathSeparator);
    for (const p of paths) {
      const containerPath = getContainerPath(p);
      if (isContainerPathWithinWorkdir(containerWorkdir, containerPath)) {
        pythonPathSuffix += `:${containerPath}`;
      }
    }
  }
  if (pythonPathSuffix) {
    shellCmds.push(`export PYTHONPATH="$PYTHONPATH${pythonPathSuffix}";`);
  }
  const projectSandboxBashrc = path2.join(
    SETTINGS_DIRECTORY_NAME,
    "sandbox.bashrc"
  );
  if (fs.existsSync(projectSandboxBashrc)) {
    shellCmds.push(`source ${getContainerPath(projectSandboxBashrc)};`);
  }
  ports().forEach(
    (p) => shellCmds.push(
      `socat TCP4-LISTEN:${p},bind=$(hostname -i),fork,reuseaddr TCP4:127.0.0.1:${p} 2> /dev/null &`
    )
  );
  const quotedCliArgs = cliArgs.slice(2).map((arg) => (0, import_shell_quote.quote)([arg]));
  const cliCmd = false ? process.env["DEBUG"] ? "npm run debug --" : "npm rebuild && npm run start --" : process.env["DEBUG"] ? `node --inspect-brk=0.0.0.0:${process.env["DEBUG_PORT"] || "9229"} $(which qwen)` : "qwen";
  const args = [...shellCmds, cliCmd, ...quotedCliArgs];
  return ["bash", "-c", args.join(" ")];
}
__name(entrypoint, "entrypoint");
var VALID_SANDBOX_NETWORK_MODES = [
  "open",
  "closed",
  "proxied"
];
function resolveSandboxNetworkMode(env = process.env) {
  const requested = env["QWEN_SANDBOX_NET"]?.toLowerCase().trim();
  if (requested && !VALID_SANDBOX_NETWORK_MODES.includes(requested)) {
    throw new FatalSandboxError(
      `Invalid QWEN_SANDBOX_NET '${env["QWEN_SANDBOX_NET"]}'. Must be one of ${VALID_SANDBOX_NETWORK_MODES.join(", ")}.`
    );
  }
  if (requested === "closed") {
    return "closed";
  }
  if (requested === "proxied" && !env["QWEN_SANDBOX_PROXY_COMMAND"]?.trim()) {
    throw new FatalSandboxError(
      "QWEN_SANDBOX_NET=proxied requires QWEN_SANDBOX_PROXY_COMMAND."
    );
  }
  return env["QWEN_SANDBOX_PROXY_COMMAND"] ? "proxied" : "open";
}
__name(resolveSandboxNetworkMode, "resolveSandboxNetworkMode");
var GIT_ROOT_PROBE_TIMEOUT_MS = 2e3;
function resolveGitWritableRoots(cwd) {
  const read = /* @__PURE__ */ __name((gitArgs) => {
    try {
      const result = spawnSync("git", gitArgs, {
        cwd,
        env: gitEnv(),
        encoding: "utf8",
        stdio: "pipe",
        timeout: GIT_ROOT_PROBE_TIMEOUT_MS
      });
      if (result.status !== 0) {
        return void 0;
      }
      const value = result.stdout?.trim();
      return value ? value : void 0;
    } catch {
      return void 0;
    }
  }, "read");
  try {
    const topLevel = read(["rev-parse", "--show-toplevel"]);
    const gitDirValue = read(["rev-parse", "--absolute-git-dir"]);
    const commonDirValue = read(["rev-parse", "--git-common-dir"]);
    if (!topLevel || !gitDirValue || !commonDirValue) {
      return [];
    }
    const targetDir = fs.realpathSync(topLevel);
    const currentDir = fs.realpathSync(cwd);
    if (currentDir !== targetDir && !isSubpath(targetDir, currentDir)) {
      return [];
    }
    const gitEntry = path2.join(targetDir, ".git");
    const entryStat = fs.lstatSync(gitEntry);
    const gitDir = fs.realpathSync(path2.resolve(cwd, gitDirValue));
    const commonDir = fs.realpathSync(path2.resolve(cwd, commonDirValue));
    if (entryStat.isDirectory()) {
      return fs.realpathSync(gitEntry) === gitDir && commonDir === gitDir ? [gitDir, commonDir] : [];
    }
    if (!entryStat.isFile()) {
      return [];
    }
    const registration = path2.join(
      commonDir,
      "worktrees",
      path2.basename(gitDir)
    );
    const backPointerPath = path2.join(gitDir, "gitdir");
    if (gitDir !== registration || !fs.lstatSync(backPointerPath).isFile()) {
      return [];
    }
    const backPointer = fs.readFileSync(backPointerPath, "utf8").trim();
    return fs.realpathSync(path2.resolve(gitDir, backPointer)) === gitEntry ? [gitDir, commonDir] : [];
  } catch {
    return [];
  }
}
__name(resolveGitWritableRoots, "resolveGitWritableRoots");
function normalizeWritableRoots(candidates) {
  const homeDir = fs.realpathSync(os2.homedir());
  const resolved = [];
  for (const candidate of candidates) {
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (real === homeDir || isSubpath(real, homeDir)) {
      throw new FatalSandboxError(
        `Refusing sandbox writable root '${real}': the home directory ('${homeDir}') and its ancestors must stay read-only.`
      );
    }
    if (resolved.some(
      (existing) => existing === real || isSubpath(existing, real)
    )) {
      continue;
    }
    resolved.push(real);
  }
  return resolved;
}
__name(normalizeWritableRoots, "normalizeWritableRoots");
function resolveBwrapWritableRoots(includedDirs = []) {
  const qwenDir = Storage.getGlobalQwenDir();
  const runtimeDir = Storage.getRuntimeBaseDir();
  fs.mkdirSync(qwenDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const targetDir = fs.realpathSync(process.cwd());
  const homeDir = os2.homedir();
  const cacheDir = process.env["XDG_CACHE_HOME"] || path2.join(homeDir, ".cache");
  try {
    fs.mkdirSync(cacheDir);
  } catch {
  }
  const roots = normalizeWritableRoots([
    targetDir,
    os2.tmpdir(),
    cacheDir,
    qwenDir,
    runtimeDir,
    ...resolveGitWritableRoots(targetDir),
    path2.join(homeDir, ".npm")
  ]);
  const realHomeDir = fs.realpathSync(homeDir);
  const extras = [];
  for (const dir of includedDirs) {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (roots.some((root) => isSubpath(root, real))) {
      continue;
    }
    if (isSubpath(realHomeDir, real)) {
      throw new FatalSandboxError(
        `Refusing sandbox writable root '${real}': additional workspace directories inside the home directory must stay read-only.`
      );
    }
    extras.push(real);
  }
  const qwenEnvFile = path2.join(qwenDir, ".env");
  let protectedEnvFile;
  try {
    try {
      fs.writeFileSync(qwenEnvFile, "", { flag: "wx", mode: 384 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(qwenEnvFile);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("Expected a regular file with a single link.");
    }
    protectedEnvFile = fs.realpathSync(qwenEnvFile);
  } catch (error) {
    throw new FatalSandboxError(
      `Cannot protect sandbox configuration '${qwenEnvFile}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    targetDir,
    roots: normalizeWritableRoots([...roots, ...extras]),
    readOnlyOverrides: [protectedEnvFile]
  };
}
__name(resolveBwrapWritableRoots, "resolveBwrapWritableRoots");
function buildBwrapArgs(options) {
  const args = [
    // Recursive, so /proc /sys /run come along read-only and Node keeps the
    // /proc it needs without a fresh (writable) procfs instance.
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--die-with-parent"
  ];
  if (options.networkMode === "closed") {
    args.push("--unshare-net");
  }
  for (const root of options.writableRoots) {
    args.push("--bind", root, root);
  }
  for (const override of options.readOnlyOverrides) {
    args.push("--ro-bind", override, override);
  }
  args.push("--chdir", options.targetDir, "--");
  args.push(...options.cliArgs);
  return args;
}
__name(buildBwrapArgs, "buildBwrapArgs");
function buildBwrapEnv(networkMode, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    SANDBOX: "bwrap",
    SANDBOX_ENFORCEMENT: "full"
  };
  delete env["DISPLAY"];
  delete env["WAYLAND_DISPLAY"];
  delete env["MIR_SOCKET"];
  if (networkMode === "proxied") {
    const proxy = env["HTTPS_PROXY"] || env["https_proxy"] || env["HTTP_PROXY"] || env["http_proxy"] || "http://localhost:8877";
    env["HTTPS_PROXY"] = env["https_proxy"] = env["HTTP_PROXY"] = env["http_proxy"] = proxy;
    const noProxy = env["NO_PROXY"] || env["no_proxy"];
    if (noProxy) env["NO_PROXY"] = env["no_proxy"] = noProxy;
  }
  return env;
}
__name(buildBwrapEnv, "buildBwrapEnv");
function runBwrap(options, env = buildBwrapEnv(options.networkMode)) {
  return new Promise((resolve, reject) => {
    let proxyProcess;
    let sandboxProcess;
    let finished = false;
    let stdinPaused = false;
    const readiness = new AbortController();
    const signalSandbox = /* @__PURE__ */ __name((signal) => {
      if (sandboxProcess?.pid) {
        try {
          process.kill(-sandboxProcess.pid, signal);
        } catch {
        }
      }
    }, "signalSandbox");
    const stopProxy = /* @__PURE__ */ __name(() => {
      if (proxyProcess?.pid) {
        try {
          process.kill(-proxyProcess.pid, "SIGTERM");
        } catch {
        }
      }
    }, "stopProxy");
    const finish = /* @__PURE__ */ __name((error, code = 1) => {
      if (finished) return;
      finished = true;
      readiness.abort();
      process.removeListener("exit", stopProxy);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGWINCH", onSigwinch);
      proxyProcess?.removeListener("error", proxyError);
      proxyProcess?.removeListener("close", proxyClosed);
      if (error) signalSandbox("SIGTERM");
      stopProxy();
      if (stdinPaused) process.stdin.resume();
      if (error) reject(error);
      else resolve(code);
    }, "finish");
    const forwardSignal = /* @__PURE__ */ __name((signal) => {
      if (finished) return;
      if (sandboxProcess?.pid) signalSandbox(signal);
      else finish(null, signal === "SIGINT" ? 130 : 143);
    }, "forwardSignal");
    const onSigint = /* @__PURE__ */ __name(() => forwardSignal("SIGINT"), "onSigint");
    const onSigterm = /* @__PURE__ */ __name(() => forwardSignal("SIGTERM"), "onSigterm");
    const onSigwinch = /* @__PURE__ */ __name(() => signalSandbox("SIGWINCH"), "onSigwinch");
    const proxyError = /* @__PURE__ */ __name((error) => finish(new FatalSandboxError(`Sandbox proxy failed: ${error.message}`)), "proxyError");
    const proxyClosed = /* @__PURE__ */ __name((code, signal) => finish(
      new FatalSandboxError(
        `Sandbox proxy exited with code ${code}, signal ${signal}`
      )
    ), "proxyClosed");
    const launch = /* @__PURE__ */ __name(() => {
      if (finished) return;
      try {
        process.stdin.pause();
        stdinPaused = true;
        sandboxProcess = spawn("bwrap", buildBwrapArgs(options), {
          stdio: "inherit",
          env,
          // A separate session removes the host controlling terminal. Keep
          // bwrap and its payload in one group so signals reach both.
          detached: true
        });
        sandboxProcess.once("error", (error) => finish(error));
        sandboxProcess.once(
          "close",
          (code, signal) => finish(
            null,
            code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)
          )
        );
      } catch (error) {
        finish(error);
      }
    }, "launch");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("SIGWINCH", onSigwinch);
    if (options.networkMode !== "proxied") {
      launch();
      return;
    }
    try {
      proxyProcess = spawn("bash", ["-c", env["QWEN_SANDBOX_PROXY_COMMAND"]], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
      proxyProcess.once("error", proxyError);
      proxyProcess.once("close", proxyClosed);
      proxyProcess.stderr?.on(
        "data",
        (data) => writeStderrLine(data.toString())
      );
      process.once("exit", stopProxy);
      const proxy = env["HTTPS_PROXY"] || "http://localhost:8877";
      writeStderrLine("waiting for proxy to start ...");
      void execAsync(
        `until curl --noproxy '*' --max-time 0.25 -s -o /dev/null ${(0, import_shell_quote.quote)([proxy])}; do sleep 0.25; done`,
        {
          signal: readiness.signal,
          timeout: 3e4
        }
      ).then(launch, proxyError);
    } catch (error) {
      proxyError(error);
    }
  });
}
__name(runBwrap, "runBwrap");
async function start_sandbox(config, nodeArgs = [], cliConfig, cliArgs = [], childEnv) {
  if (config.command === "sandbox-exec") {
    if (process.env["BUILD_SANDBOX"]) {
      throw new FatalSandboxError(
        "Cannot BUILD_SANDBOX when using macOS Seatbelt"
      );
    }
    const profile = process.env["SEATBELT_PROFILE"] ??= "permissive-open";
    const profileFile = resolveSeatbeltProfileFile(profile);
    if (!fs.existsSync(profileFile)) {
      throw new FatalSandboxError(
        `Missing macos seatbelt profile file '${profileFile}'`
      );
    }
    writeStderrLine(`using macos seatbelt (profile: ${profile}) ...`);
    const nodeOptions = [
      ...process.env["DEBUG"] ? ["--inspect-brk"] : [],
      ...nodeArgs
    ].join(" ");
    const qwenDir = Storage.getGlobalQwenDir();
    const runtimeDir = Storage.getRuntimeBaseDir();
    fs.mkdirSync(qwenDir, { recursive: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    const args2 = [
      "-D",
      `TARGET_DIR=${fs.realpathSync(process.cwd())}`,
      "-D",
      `TMP_DIR=${fs.realpathSync(os2.tmpdir())}`,
      "-D",
      `HOME_DIR=${fs.realpathSync(os2.homedir())}`,
      "-D",
      `CACHE_DIR=${fs.realpathSync(execSync(`getconf DARWIN_USER_CACHE_DIR`).toString().trim())}`,
      "-D",
      `QWEN_DIR=${fs.realpathSync(qwenDir)}`,
      "-D",
      `RUNTIME_DIR=${fs.realpathSync(runtimeDir)}`
    ];
    const MAX_INCLUDE_DIRS = 5;
    const targetDir = fs.realpathSync(cliConfig?.getTargetDir() || "");
    const includedDirs = [];
    if (cliConfig) {
      const workspaceContext = cliConfig.getWorkspaceContext();
      const directories = workspaceContext.getDirectories();
      for (const dir of directories) {
        const realDir = fs.realpathSync(dir);
        if (realDir !== targetDir) {
          includedDirs.push(realDir);
        }
      }
    }
    for (let i = 0; i < MAX_INCLUDE_DIRS; i++) {
      let dirPath = "/dev/null";
      if (i < includedDirs.length) {
        dirPath = includedDirs[i];
      }
      args2.push("-D", `INCLUDE_DIR_${i}=${dirPath}`);
    }
    const finalArgv = cliArgs;
    args2.push(
      "-f",
      profileFile,
      "sh",
      "-c",
      [
        ...process.env["QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE"] === "1" ? ["ELECTRON_RUN_AS_NODE=1"] : [],
        `SANDBOX=sandbox-exec`,
        `NODE_OPTIONS="${nodeOptions}"`,
        ...finalArgv.map((arg) => (0, import_shell_quote.quote)([arg]))
      ].join(" ")
    );
    const proxyCommand2 = process.env["QWEN_SANDBOX_PROXY_COMMAND"];
    let proxyProcess2 = void 0;
    let sandboxProcess2 = void 0;
    const sandboxEnv = { ...process.env };
    if (proxyCommand2) {
      const proxy = process.env["HTTPS_PROXY"] || process.env["https_proxy"] || process.env["HTTP_PROXY"] || process.env["http_proxy"] || "http://localhost:8877";
      sandboxEnv["HTTPS_PROXY"] = proxy;
      sandboxEnv["https_proxy"] = proxy;
      sandboxEnv["HTTP_PROXY"] = proxy;
      sandboxEnv["http_proxy"] = proxy;
      const noProxy = process.env["NO_PROXY"] || process.env["no_proxy"];
      if (noProxy) {
        sandboxEnv["NO_PROXY"] = noProxy;
        sandboxEnv["no_proxy"] = noProxy;
      }
      proxyProcess2 = spawn("bash", ["-c", proxyCommand2], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
      const stopProxy = /* @__PURE__ */ __name(() => {
        writeStderrLine("stopping proxy ...");
        if (proxyProcess2?.pid) {
          process.kill(-proxyProcess2.pid, "SIGTERM");
        }
      }, "stopProxy");
      process.on("exit", stopProxy);
      process.on("SIGINT", stopProxy);
      process.on("SIGTERM", stopProxy);
      proxyProcess2.stderr?.on("data", (data) => {
        writeStderrLine(data.toString());
      });
      proxyProcess2.on("close", (code, signal) => {
        if (sandboxProcess2?.pid) {
          process.kill(-sandboxProcess2.pid, "SIGTERM");
        }
        throw new FatalSandboxError(
          `Proxy command '${proxyCommand2}' exited with code ${code}, signal ${signal}`
        );
      });
      writeStderrLine("waiting for proxy to start ...");
      await execAsync(
        `until timeout 0.25 curl -s http://localhost:8877; do sleep 0.25; done`
      );
    }
    process.stdin.pause();
    sandboxProcess2 = spawn(config.command, args2, {
      stdio: "inherit",
      ...childEnv ? { env: { ...process.env, ...childEnv } } : {}
    });
    return new Promise((resolve, reject) => {
      sandboxProcess2?.on("error", reject);
      sandboxProcess2?.on("close", (code) => {
        process.stdin.resume();
        resolve(code ?? 1);
      });
    });
  }
  if (config.command === "bwrap") {
    if (process.env["BUILD_SANDBOX"]) {
      throw new FatalSandboxError("Cannot BUILD_SANDBOX when using bwrap");
    }
    const networkMode = resolveSandboxNetworkMode();
    writeStderrLine(`using bwrap (network: ${networkMode}) ...`);
    const {
      targetDir,
      roots: writableRoots,
      readOnlyOverrides
    } = resolveBwrapWritableRoots(
      cliConfig ? cliConfig.getWorkspaceContext().getDirectories() : []
    );
    const nodeOptions = [
      childEnv?.["NODE_OPTIONS"] ?? process.env["NODE_OPTIONS"],
      ...process.env["DEBUG"] ? ["--inspect-brk"] : [],
      ...nodeArgs
    ].filter(Boolean).join(" ");
    const env = buildBwrapEnv(networkMode, { ...process.env, ...childEnv });
    if (nodeOptions) env["NODE_OPTIONS"] = nodeOptions;
    if (process.env["QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE"] === "1") {
      env["ELECTRON_RUN_AS_NODE"] = "1";
    }
    return runBwrap(
      { writableRoots, targetDir, networkMode, cliArgs, readOnlyOverrides },
      env
    );
  }
  writeStderrLine(`hopping into sandbox (command: ${config.command}) ...`);
  const gcPath = fs.realpathSync(process.argv[1]);
  const projectSandboxDockerfile = path2.join(
    SETTINGS_DIRECTORY_NAME,
    "sandbox.Dockerfile"
  );
  const isCustomProjectSandbox = fs.existsSync(projectSandboxDockerfile);
  const image = config.image;
  if (!image) {
    throw new FatalSandboxError(
      `Sandbox command '${config.command}' requires an image`
    );
  }
  const workdir = path2.resolve(process.cwd());
  const containerWorkdir = getContainerPath(workdir);
  if (process.env["BUILD_SANDBOX"]) {
    if (!gcPath.includes("qwen-code/packages/")) {
      throw new FatalSandboxError(
        "Cannot build sandbox using installed Qwen Code binary; run `npm link ./packages/cli` under QwenCode-cli repo to switch to linked binary."
      );
    } else {
      writeStderrLine("building sandbox ...");
      const gcRoot = gcPath.split("/packages/")[0];
      let buildArgs = "";
      const projectSandboxDockerfile2 = path2.join(
        SETTINGS_DIRECTORY_NAME,
        "sandbox.Dockerfile"
      );
      if (isCustomProjectSandbox) {
        writeStderrLine(`using ${projectSandboxDockerfile2} for sandbox`);
        buildArgs += `-f ${path2.resolve(projectSandboxDockerfile2)} -i ${image}`;
      }
      execSync(
        `cd ${gcRoot} && node scripts/build_sandbox.js -s ${buildArgs}`,
        {
          stdio: "inherit",
          env: {
            ...process.env,
            QWEN_SANDBOX: config.command
            // in case sandbox is enabled via flags (see config.ts under cli package)
          }
        }
      );
    }
  }
  if (!await ensureSandboxImageIsPresent(config.command, image)) {
    const remedy = image === LOCAL_DEV_SANDBOX_IMAGE_NAME ? "Try running `npm run build:all` or `npm run build:sandbox` under the qwen-code repo to build it locally, or check the image name and your network connection." : "Please check the image name, your network connection, or notify qwen-code-dev@service.alibaba.com if the issue persists.";
    throw new FatalSandboxError(
      `Sandbox image '${image}' is missing or could not be pulled. ${remedy}`
    );
  }
  const args = ["run", "-i", "--rm", "--init", "--workdir", containerWorkdir];
  if (process.env["SANDBOX_FLAGS"]) {
    const flags = (0, import_shell_quote.parse)(process.env["SANDBOX_FLAGS"], process.env).filter(
      (f) => typeof f === "string"
    );
    args.push(...flags);
  }
  if (process.stdin.isTTY) {
    args.push("-t");
  }
  args.push("--add-host", "host.docker.internal:host-gateway");
  args.push("--volume", `${workdir}:${containerWorkdir}`);
  const userSettingsDirOnHost = getUserSettingsDir();
  const runtimeBaseDirOnHost = Storage.getRuntimeBaseDir();
  const userSettingsDirRealPath = ensureDirectoryAndGetRealPath(
    userSettingsDirOnHost
  );
  const runtimeBaseDirRealPath = ensureDirectoryAndGetRealPath(runtimeBaseDirOnHost);
  const userSettingsDirInSandbox = getContainerPath(
    `/home/node/${SETTINGS_DIRECTORY_NAME}`
  );
  const userSettingsDirContainerPath = getContainerPath(
    userSettingsDirRealPath
  );
  const runtimeBaseDirContainerPath = getContainerPath(runtimeBaseDirRealPath);
  const runtimeCoveredByUserSettings = isSubpath(
    userSettingsDirRealPath,
    runtimeBaseDirRealPath
  );
  const userSettingsCoveredByRuntime = isSubpath(
    runtimeBaseDirRealPath,
    userSettingsDirRealPath
  );
  const runtimeSameAsUserSettings = runtimeCoveredByUserSettings && userSettingsCoveredByRuntime;
  args.push(
    "--volume",
    `${userSettingsDirRealPath}:${userSettingsDirInSandbox}`
  );
  if ((!userSettingsCoveredByRuntime || runtimeSameAsUserSettings) && userSettingsDirInSandbox !== userSettingsDirContainerPath) {
    args.push(
      "--volume",
      `${userSettingsDirRealPath}:${userSettingsDirContainerPath}`
    );
  }
  args.push("--env", `QWEN_HOME=${userSettingsDirContainerPath}`);
  if (!runtimeCoveredByUserSettings) {
    args.push(
      "--volume",
      `${runtimeBaseDirRealPath}:${runtimeBaseDirContainerPath}`
    );
  }
  if (!runtimeSameAsUserSettings) {
    args.push("--env", `QWEN_RUNTIME_DIR=${runtimeBaseDirContainerPath}`);
  }
  args.push("--volume", `${os2.tmpdir()}:${getContainerPath(os2.tmpdir())}`);
  const gcloudConfigDir = path2.join(os2.homedir(), ".config", "gcloud");
  if (fs.existsSync(gcloudConfigDir)) {
    args.push(
      "--volume",
      `${gcloudConfigDir}:${getContainerPath(gcloudConfigDir)}:ro`
    );
  }
  if (process.env["GOOGLE_APPLICATION_CREDENTIALS"]) {
    const adcFile = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
    if (fs.existsSync(adcFile)) {
      args.push("--volume", `${adcFile}:${getContainerPath(adcFile)}:ro`);
      args.push(
        "--env",
        `GOOGLE_APPLICATION_CREDENTIALS=${getContainerPath(adcFile)}`
      );
    }
  }
  if (process.env["SANDBOX_MOUNTS"]) {
    for (let mount of process.env["SANDBOX_MOUNTS"].split(",")) {
      if (mount.trim()) {
        const { from, to, opts } = parseSandboxMountSpec(mount);
        mount = `${from}:${to}:${opts}`;
        if (!path2.isAbsolute(from)) {
          throw new FatalSandboxError(
            `Path '${from}' listed in SANDBOX_MOUNTS must be absolute`
          );
        }
        if (!fs.existsSync(from)) {
          throw new FatalSandboxError(
            `Missing mount path '${from}' listed in SANDBOX_MOUNTS`
          );
        }
        writeStderrLine(`SANDBOX_MOUNTS: ${from} -> ${to} (${opts})`);
        args.push("--volume", mount);
      }
    }
  }
  ports().forEach((p) => args.push("--publish", `${p}:${p}`));
  if (process.env["DEBUG"]) {
    const debugPort = process.env["DEBUG_PORT"] || "9229";
    args.push(`--publish`, `${debugPort}:${debugPort}`);
  }
  const proxyCommand = process.env["QWEN_SANDBOX_PROXY_COMMAND"];
  if (proxyCommand) {
    let proxy = process.env["HTTPS_PROXY"] || process.env["https_proxy"] || process.env["HTTP_PROXY"] || process.env["http_proxy"] || "http://localhost:8877";
    proxy = proxy.replace("localhost", SANDBOX_PROXY_NAME);
    if (proxy) {
      args.push("--env", `HTTPS_PROXY=${proxy}`);
      args.push("--env", `https_proxy=${proxy}`);
      args.push("--env", `HTTP_PROXY=${proxy}`);
      args.push("--env", `http_proxy=${proxy}`);
    }
    const noProxy = process.env["NO_PROXY"] || process.env["no_proxy"];
    if (noProxy) {
      args.push("--env", `NO_PROXY=${noProxy}`);
      args.push("--env", `no_proxy=${noProxy}`);
    }
    if (proxy) {
      execSync(
        `${config.command} network inspect ${SANDBOX_NETWORK_NAME} || ${config.command} network create --internal ${SANDBOX_NETWORK_NAME}`
      );
      args.push("--network", SANDBOX_NETWORK_NAME);
      if (proxyCommand) {
        execSync(
          `${config.command} network inspect ${SANDBOX_PROXY_NAME} || ${config.command} network create ${SANDBOX_PROXY_NAME}`
        );
      }
    }
  }
  const imageName = parseSandboxImageName(image);
  const isIntegrationTest = process.env["QWEN_CODE_INTEGRATION_TEST"] === "true";
  let containerName;
  if (isIntegrationTest) {
    containerName = `qwen-code-integration-test-${randomBytes(4).toString(
      "hex"
    )}`;
    writeStderrLine(`ContainerName: ${containerName}`);
  } else {
    containerName = `${imageName}-${randomBytes(4).toString("hex")}`;
    writeStderrLine(`ContainerName (regular): ${containerName}`);
  }
  args.push("--name", containerName);
  if (containerName.length <= 64) {
    args.push("--hostname", containerName);
  }
  if (process.env["QWEN_CODE_TEST_VAR"]) {
    args.push(
      "--env",
      `QWEN_CODE_TEST_VAR=${process.env["QWEN_CODE_TEST_VAR"]}`
    );
  }
  args.push(...getSandboxPassthroughEnvArgs());
  if (process.env["QWEN_CODE_MCP_APPROVALS_PATH"]) {
    args.push(
      "--env",
      `QWEN_CODE_MCP_APPROVALS_PATH=${getContainerPath(
        process.env["QWEN_CODE_MCP_APPROVALS_PATH"]
      )}`
    );
  }
  if (process.env["QWEN_CODE_WARNINGS_FILE"]) {
    args.push(
      "--env",
      `QWEN_CODE_WARNINGS_FILE=${getContainerPath(
        process.env["QWEN_CODE_WARNINGS_FILE"]
      )}`
    );
  }
  if (process.env["GEMINI_API_KEY"]) {
    args.push("--env", `GEMINI_API_KEY=${process.env["GEMINI_API_KEY"]}`);
  }
  if (process.env["GOOGLE_API_KEY"]) {
    args.push("--env", `GOOGLE_API_KEY=${process.env["GOOGLE_API_KEY"]}`);
  }
  if (process.env["OPENAI_API_KEY"]) {
    args.push("--env", `OPENAI_API_KEY=${process.env["OPENAI_API_KEY"]}`);
  }
  if (process.env["OPENAI_BASE_URL"]) {
    args.push("--env", `OPENAI_BASE_URL=${process.env["OPENAI_BASE_URL"]}`);
  }
  if (process.env["OPENAI_MODEL"]) {
    args.push("--env", `OPENAI_MODEL=${process.env["OPENAI_MODEL"]}`);
  }
  if (process.env["GOOGLE_GENAI_USE_VERTEXAI"]) {
    args.push(
      "--env",
      `GOOGLE_GENAI_USE_VERTEXAI=${process.env["GOOGLE_GENAI_USE_VERTEXAI"]}`
    );
  }
  if (process.env["GOOGLE_GENAI_USE_GCA"]) {
    args.push(
      "--env",
      `GOOGLE_GENAI_USE_GCA=${process.env["GOOGLE_GENAI_USE_GCA"]}`
    );
  }
  if (process.env["GOOGLE_CLOUD_PROJECT"]) {
    args.push(
      "--env",
      `GOOGLE_CLOUD_PROJECT=${process.env["GOOGLE_CLOUD_PROJECT"]}`
    );
  }
  if (process.env["GOOGLE_CLOUD_LOCATION"]) {
    args.push(
      "--env",
      `GOOGLE_CLOUD_LOCATION=${process.env["GOOGLE_CLOUD_LOCATION"]}`
    );
  }
  if (process.env["GEMINI_MODEL"]) {
    args.push("--env", `GEMINI_MODEL=${process.env["GEMINI_MODEL"]}`);
  }
  if (process.env["TERM"]) {
    args.push("--env", `TERM=${process.env["TERM"]}`);
  }
  if (process.env["COLORTERM"]) {
    args.push("--env", `COLORTERM=${process.env["COLORTERM"]}`);
  }
  for (const envVar of [
    "QWEN_CODE_IDE_SERVER_PORT",
    "QWEN_CODE_IDE_WORKSPACE_PATH",
    "TERM_PROGRAM"
  ]) {
    if (process.env[envVar]) {
      args.push("--env", `${envVar}=${process.env[envVar]}`);
    }
  }
  const virtualEnv = process.env["VIRTUAL_ENV"];
  if (virtualEnv && isContainerPathWithinWorkdir(
    getContainerPath(workdir),
    getContainerPath(virtualEnv)
  )) {
    const sandboxVenvPath = path2.resolve(
      SETTINGS_DIRECTORY_NAME,
      "sandbox.venv"
    );
    if (!fs.existsSync(sandboxVenvPath)) {
      fs.mkdirSync(sandboxVenvPath, { recursive: true });
    }
    args.push("--volume", `${sandboxVenvPath}:${getContainerPath(virtualEnv)}`);
    args.push("--env", `VIRTUAL_ENV=${getContainerPath(virtualEnv)}`);
  }
  if (process.env["SANDBOX_ENV"]) {
    for (let env of process.env["SANDBOX_ENV"].split(",")) {
      if (env = env.trim()) {
        if (env.includes("=")) {
          writeStderrLine(`SANDBOX_ENV: ${env}`);
          args.push("--env", env);
        } else {
          throw new FatalSandboxError(
            "SANDBOX_ENV must be a comma-separated list of key=value pairs"
          );
        }
      }
    }
  }
  for (const name of Object.keys(childEnv ?? {})) {
    args.push("--env", name);
  }
  const existingNodeOptions = process.env["NODE_OPTIONS"] || "";
  const allNodeOptions = [
    ...existingNodeOptions ? [existingNodeOptions] : [],
    ...nodeArgs
  ].join(" ");
  if (allNodeOptions.length > 0) {
    args.push("--env", `NODE_OPTIONS="${allNodeOptions}"`);
  }
  args.push("--env", `SANDBOX=${containerName}`);
  if (config.command === "podman") {
    const emptyAuthFilePath = path2.join(os2.tmpdir(), "empty_auth.json");
    fs.writeFileSync(emptyAuthFilePath, "{}", "utf-8");
    args.push("--authfile", emptyAuthFilePath);
  }
  let userFlag = "";
  const finalEntrypoint = entrypoint(workdir, cliArgs);
  const useCurrentUser = await shouldUseCurrentUserInSandbox();
  if (useCurrentUser) {
    args.push("--user", "root");
    const uid = execSync("id -u").toString().trim();
    const gid = execSync("id -g").toString().trim();
    const username = "qwen";
    const homeDir = getContainerPath(os2.homedir());
    const setupUserCommands = [
      // Use -f with groupadd to avoid errors if the group already exists.
      `groupadd -f -g ${gid} ${username}`,
      // Create user only if it doesn't exist. Use -o for non-unique UID.
      `id -u ${username} &>/dev/null || useradd -o -u ${uid} -g ${gid} -d ${homeDir} -s /bin/bash ${username}`
    ].join(" && ");
    const originalCommand = finalEntrypoint[2];
    const escapedOriginalCommand = originalCommand.replace(/'/g, "'\\''");
    const suCommand = `su -p ${username} -c '${escapedOriginalCommand}'`;
    finalEntrypoint[2] = `${setupUserCommands} && ${suCommand}`;
    userFlag = `--user ${uid}:${gid}`;
    args.push("--env", `HOME=${os2.homedir()}`);
  } else if (isIntegrationTest) {
    args.push("--user", "root");
    userFlag = "--user root";
  }
  args.push(image);
  args.push(...finalEntrypoint);
  let proxyProcess = void 0;
  let sandboxProcess = void 0;
  if (proxyCommand) {
    const proxyContainerCommand = `${config.command} run --rm --init ${userFlag} --name ${SANDBOX_PROXY_NAME} --network ${SANDBOX_PROXY_NAME} -p 8877:8877 -v ${process.cwd()}:${workdir} --workdir ${workdir} ${image} ${proxyCommand}`;
    const isWindows = os2.platform() === "win32";
    const proxyShell = isWindows ? "cmd.exe" : "bash";
    const proxyShellArgs = isWindows ? ["/c", proxyContainerCommand] : ["-c", proxyContainerCommand];
    proxyProcess = spawn(proxyShell, proxyShellArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    const stopProxy = /* @__PURE__ */ __name(() => {
      writeStderrLine("stopping proxy container ...");
      execSync(`${config.command} rm -f ${SANDBOX_PROXY_NAME}`);
    }, "stopProxy");
    process.on("exit", stopProxy);
    process.on("SIGINT", stopProxy);
    process.on("SIGTERM", stopProxy);
    proxyProcess.stderr?.on("data", (data) => {
      writeStderrLine(data.toString().trim());
    });
    proxyProcess.on("close", (code, signal) => {
      if (sandboxProcess?.pid) {
        process.kill(-sandboxProcess.pid, "SIGTERM");
      }
      throw new FatalSandboxError(
        `Proxy container command '${proxyContainerCommand}' exited with code ${code}, signal ${signal}`
      );
    });
    writeStderrLine("waiting for proxy to start ...");
    await execAsync(
      `until timeout 0.25 curl -s http://localhost:8877; do sleep 0.25; done`
    );
    await execAsync(
      `${config.command} network connect ${SANDBOX_NETWORK_NAME} ${SANDBOX_PROXY_NAME}`
    );
  }
  process.stdin.pause();
  sandboxProcess = spawn(config.command, args, {
    stdio: "inherit",
    ...childEnv ? { env: { ...process.env, ...childEnv } } : {}
  });
  return new Promise((resolve, reject) => {
    sandboxProcess.on("error", (err) => {
      writeStderrLine(`Sandbox process error: ${err}`);
      reject(err);
    });
    sandboxProcess?.on("close", (code, signal) => {
      process.stdin.resume();
      if (code !== 0 && code !== null) {
        writeStderrLine(
          `Sandbox process exited with code: ${code}, signal: ${signal}`
        );
      }
      resolve(code ?? 1);
    });
  });
}
__name(start_sandbox, "start_sandbox");
async function imageExists(sandbox, image) {
  return new Promise((resolve) => {
    const args = ["image", "inspect", "--format", "{{.Id}}", image];
    const checkProcess = spawn(sandbox, args);
    let stdoutData = "";
    if (checkProcess.stdout) {
      checkProcess.stdout.on("data", (data) => {
        stdoutData += data.toString();
      });
    }
    checkProcess.on("error", (err) => {
      writeStderrLine(
        `Failed to start '${sandbox}' command for image check: ${err.message}`
      );
      resolve(false);
    });
    checkProcess.on("close", () => {
      resolve(stdoutData.trim() !== "");
    });
  });
}
__name(imageExists, "imageExists");
async function pullImage(sandbox, image) {
  writeStderrLine(`Attempting to pull image ${image} using ${sandbox}...`);
  return new Promise((resolve) => {
    const args = ["pull", image];
    const pullProcess = spawn(sandbox, args, { stdio: "pipe" });
    let stderrData = "";
    const onStdoutData = /* @__PURE__ */ __name((data) => {
      writeStderrLine(data.toString().trim());
    }, "onStdoutData");
    const onStderrData = /* @__PURE__ */ __name((data) => {
      stderrData += data.toString();
      writeStderrLine(data.toString().trim());
    }, "onStderrData");
    const onError = /* @__PURE__ */ __name((err) => {
      writeStderrLine(
        `Failed to start '${sandbox} pull ${image}' command: ${err.message}`
      );
      cleanup();
      resolve(false);
    }, "onError");
    const onClose = /* @__PURE__ */ __name((code) => {
      if (code === 0) {
        writeStderrLine(`Successfully pulled image ${image}.`);
        cleanup();
        resolve(true);
      } else {
        writeStderrLine(
          `Failed to pull image ${image}. '${sandbox} pull ${image}' exited with code ${code}.`
        );
        if (stderrData.trim()) {
        }
        cleanup();
        resolve(false);
      }
    }, "onClose");
    const cleanup = /* @__PURE__ */ __name(() => {
      if (pullProcess.stdout) {
        pullProcess.stdout.removeListener("data", onStdoutData);
      }
      if (pullProcess.stderr) {
        pullProcess.stderr.removeListener("data", onStderrData);
      }
      pullProcess.removeListener("error", onError);
      pullProcess.removeListener("close", onClose);
      if (pullProcess.connected) {
        pullProcess.disconnect();
      }
    }, "cleanup");
    if (pullProcess.stdout) {
      pullProcess.stdout.on("data", onStdoutData);
    }
    if (pullProcess.stderr) {
      pullProcess.stderr.on("data", onStderrData);
    }
    pullProcess.on("error", onError);
    pullProcess.on("close", onClose);
  });
}
__name(pullImage, "pullImage");
async function ensureSandboxImageIsPresent(sandbox, image) {
  writeStderrLine(`Checking for sandbox image: ${image}`);
  if (await imageExists(sandbox, image)) {
    writeStderrLine(`Sandbox image ${image} found locally.`);
    return true;
  }
  writeStderrLine(`Sandbox image ${image} not found locally.`);
  if (image === LOCAL_DEV_SANDBOX_IMAGE_NAME) {
    return false;
  }
  if (await pullImage(sandbox, image)) {
    if (await imageExists(sandbox, image)) {
      writeStderrLine(`Sandbox image ${image} is now available after pulling.`);
      return true;
    } else {
      writeStderrLine(
        `Sandbox image ${image} still not found after a pull attempt. This might indicate an issue with the image name or registry, or the pull command reported success but failed to make the image available.`
      );
      return false;
    }
  }
  writeStderrLine(
    `Failed to obtain sandbox image ${image} after check and pull attempt.`
  );
  return false;
}
__name(ensureSandboxImageIsPresent, "ensureSandboxImageIsPresent");

export {
  BUILTIN_SEATBELT_PROFILES,
  getSandboxPassthroughEnvArgs,
  resolveSeatbeltProfileFile,
  resolveSandboxNetworkMode,
  resolveGitWritableRoots,
  normalizeWritableRoots,
  resolveBwrapWritableRoots,
  buildBwrapArgs,
  buildBwrapEnv,
  runBwrap,
  start_sandbox
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
