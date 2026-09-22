#!/usr/bin/env node
// Force strict mode and setup for ESM
"use strict";
import {
  handleUncaughtException,
  isExpectedPtyRaceError
} from "./chunks/chunk-NRQI3PGS.js";
import {
  initCpuProfiler
} from "./chunks/chunk-SGORY5YI.js";
import {
  clearInheritedPeerMessagingEnv
} from "./chunks/chunk-V5U2NZNJ.js";
import {
  DEFAULT_COMMAND,
  DEFAULT_COMMAND_DESC,
  QUERY_POSITIONAL,
  TOP_LEVEL_DEPRECATED_OPTIONS,
  TOP_LEVEL_HELP_OPTIONS,
  TOP_LEVEL_USAGE
} from "./chunks/chunk-BSIOCNDK.js";
import "./chunks/chunk-FR7RJHJR.js";
import {
  initStartupProfiler
} from "./chunks/chunk-QILD6R27.js";
import {
  normalizeServeFastPathArgv
} from "./chunks/chunk-JVEGA3MM.js";
import "./chunks/chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunks/chunk-5O2XNYP6.js";
import {
  __name
} from "./chunks/chunk-J2S4EL5Y.js";

// packages/cli/src/cli.ts
init_esbuild_shims();
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  realpathSync,
  statSync
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
initStartupProfiler();
initCpuProfiler();
var TOP_LEVEL_COMMANDS = [
  ["auth", "Configure authentication (removed)"],
  ["board <command>", "Share work with other agents through a board"],
  ["channel <command>", "Manage messaging channels (Telegram, Discord, etc.)"],
  ["extensions <command>", "Manage Qwen Code extensions."],
  ["hooks", "Manage Qwen Code hooks (use /hooks in interactive mode)."],
  ["mcp", "Manage MCP servers"],
  [
    "review <command>",
    "Run a review non-interactively (`run`), plus the internal helpers used by the /review skill (PR worktree setup, context fetch, rules loading, presubmit checks, cleanup)"
  ],
  [
    "sandbox [cmd...]",
    "Inspect the sandbox backend, or run a command inside it"
  ],
  [
    "serve",
    "Run Qwen Code as a local HTTP daemon (Stage 1 experimental: --http-bridge)"
  ],
  ["sessions <command>", "Manage Qwen Code sessions"],
  ["update", "Check for Qwen Code updates and install if available"]
];
var MCP_COMMANDS = [
  ["add <name> <commandOrUrl> [args...]", "Add a server"],
  ["remove <name>", "Remove a server"],
  ["list", "List all configured MCP servers"],
  ["reconnect [server-name]", "Reconnect to MCP servers"],
  ["approve [name]", "Approve a pending MCP server"],
  ["reject [name]", "Reject a pending MCP server"]
];
function flagName(name) {
  return name.length === 1 ? `-${name}` : `--${name}`;
}
__name(flagName, "flagName");
function optionAliases(config) {
  const alias = config.alias;
  if (!alias) {
    return [];
  }
  return typeof alias === "string" ? [alias] : [...alias];
}
__name(optionAliases, "optionAliases");
function optionFlagNames(option, config) {
  return [flagName(option), ...optionAliases(config).map(flagName)];
}
__name(optionFlagNames, "optionFlagNames");
var VALUE_FLAGS = new Set(
  TOP_LEVEL_HELP_OPTIONS.flatMap(
    ([option, config]) => config.type === "string" || config.type === "number" || config.type === "array" ? optionFlagNames(option, config) : []
  )
);
VALUE_FLAGS.add("--sandbox-session-id");
var BASE_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--model",
  "-m",
  "--fallback-model",
  "--prompt",
  "-p",
  "--prompt-interactive",
  "-i",
  "--output-format",
  "-o",
  "--resume",
  "-r"
]);
var KNOWN_FAST_PATH_FLAGS = new Set(
  TOP_LEVEL_HELP_OPTIONS.flatMap(
    ([option, config]) => optionFlagNames(option, config)
  )
);
for (const flag of ["--help", "-h", "--version", "-v"]) {
  KNOWN_FAST_PATH_FLAGS.add(flag);
}
KNOWN_FAST_PATH_FLAGS.add("--sandbox-session-id");
KNOWN_FAST_PATH_FLAGS.add("--experimental-acp");
KNOWN_FAST_PATH_FLAGS.add("--experimental-skills");
function isValueToken(arg) {
  return arg !== void 0 && arg !== "--" && !arg.startsWith("-");
}
__name(isValueToken, "isValueToken");
function argvSafeForFastPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      return true;
    }
    if (!token.startsWith("-")) {
      return false;
    }
    if (!KNOWN_FAST_PATH_FLAGS.has(token)) {
      return false;
    }
    i = skipOptionValues(argv, i);
  }
  return true;
}
__name(argvSafeForFastPath, "argvSafeForFastPath");
function skipOptionValues(argv, index) {
  const raw = argv[index];
  const eq = raw.indexOf("=");
  const flag = eq === -1 ? raw : raw.slice(0, eq);
  if (!VALUE_FLAGS.has(flag)) {
    return index;
  }
  return eq === -1 && isValueToken(argv[index + 1]) ? index + 1 : index;
}
__name(skipOptionValues, "skipOptionValues");
function writeStdoutLine(line) {
  process.stdout.write(line.endsWith("\n") ? line : `${line}
`);
}
__name(writeStdoutLine, "writeStdoutLine");
function hasFlag(argv, long, short) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      return false;
    }
    if (BASE_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    i = skipOptionValues(argv, i);
    if (arg === long || arg === short) {
      return true;
    }
  }
  return false;
}
__name(hasFlag, "hasFlag");
function hasVersionToken(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      return false;
    }
    if (BASE_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      return true;
    }
  }
  return false;
}
__name(hasVersionToken, "hasVersionToken");
async function buildTopLevelHelpParser() {
  const { default: yargs } = await import("./chunks/yargs-6H2AUULL.js");
  const parser = yargs([]).locale("en").scriptName("qwen").usage(TOP_LEVEL_USAGE).version("0.24.0").alias("v", "version").help().alias("h", "help").strict().demandCommand(0, 0);
  for (const [option, config] of TOP_LEVEL_HELP_OPTIONS) {
    parser.option(option, config);
  }
  for (const [option, message] of Object.entries(
    TOP_LEVEL_DEPRECATED_OPTIONS
  )) {
    parser.deprecateOption(option, message);
  }
  parser.command(
    DEFAULT_COMMAND,
    DEFAULT_COMMAND_DESC,
    (defaultCmd) => defaultCmd.positional("query", QUERY_POSITIONAL)
  );
  for (const [command, description] of TOP_LEVEL_COMMANDS) {
    parser.command(command, description);
  }
  parser.wrap(parser.terminalWidth());
  return parser;
}
__name(buildTopLevelHelpParser, "buildTopLevelHelpParser");
function firstPositionalArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      return void 0;
    }
    if (BASE_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    i = skipOptionValues(argv, i);
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return void 0;
}
__name(firstPositionalArg, "firstPositionalArg");
function normalizeMcpFastPathArgv(argv) {
  if (argv[0] === "mcp" && argv[1] === "--") {
    return [argv[0], ...argv.slice(2)];
  }
  return argv;
}
__name(normalizeMcpFastPathArgv, "normalizeMcpFastPathArgv");
function resolveBootstrapRoute(rawArgv) {
  const argv = normalizeServeFastPathArgv(rawArgv);
  if (hasVersionToken(argv)) {
    return "version";
  }
  const fastPathSafe = argvSafeForFastPath(argv);
  const firstPositional = firstPositionalArg(argv);
  if (fastPathSafe && hasFlag(argv, "--help", "-h") && firstPositional === void 0) {
    return "help";
  }
  const firstArg = argv[0];
  if (firstArg === "serve") {
    return "serve";
  }
  if (firstArg === "mcp") {
    return "mcp";
  }
  return "default";
}
__name(resolveBootstrapRoute, "resolveBootstrapRoute");
async function printTopLevelHelp() {
  const help = await (await buildTopLevelHelpParser()).getHelp();
  writeStdoutLine(help);
}
__name(printTopLevelHelp, "printTopLevelHelp");
function printMcpHelp() {
  const lines = [
    "Usage: qwen mcp <command>",
    "",
    "Manage MCP servers",
    "",
    "Commands:",
    ...MCP_COMMANDS.map(
      ([command, description]) => `  qwen mcp ${command}  ${description}`
    )
  ];
  writeStdoutLine(lines.join("\n"));
}
__name(printMcpHelp, "printMcpHelp");
async function printBootstrapVersion() {
  if ("0.24.0") {
    writeStdoutLine("0.24.0");
    return;
  }
  const { getCliVersion } = await import("./chunks/version-76T4NBMQ.js");
  writeStdoutLine(await getCliVersion());
}
__name(printBootstrapVersion, "printBootstrapVersion");
async function runMcpFastPath(rawArgv) {
  const argv = normalizeMcpFastPathArgv(
    normalizeServeFastPathArgv(rawArgv)
  );
  const hasSubcommand = argv.length > 1 && !argv[1].startsWith("-");
  if (!hasSubcommand) {
    printMcpHelp();
    return;
  }
  const [{ default: yargsInstance }, { mcpCommand }] = await Promise.all([
    import("./chunks/yargs-6H2AUULL.js"),
    import("./chunks/mcp-H2MESAW4.js")
  ]);
  const parser = yargsInstance([]).scriptName("qwen").command(mcpCommand).version(false).help().alias("h", "help").strict().strictCommands().demandCommand(1, "You need at least one command before continuing.").fail((message, error, yargs) => {
    writeStderrLine(message || error?.message || "Unknown argument error");
    yargs.showHelp();
    process.exitCode = 1;
  }).exitProcess(false);
  if (hasFlag(argv.slice(2), "--help", "-h")) {
    await parseYargsHelp(parser, argv);
    return;
  }
  await parseYargsCommand(parser, argv);
}
__name(runMcpFastPath, "runMcpFastPath");
async function parseYargsHelp(parser, argv) {
  await new Promise((resolve, reject) => {
    parser.parse(
      argv,
      (error, _argv, output) => {
        if (output) {
          writeStdoutLine(output);
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
}
__name(parseYargsHelp, "parseYargsHelp");
async function parseYargsCommand(parser, argv) {
  await new Promise((resolve) => {
    parser.parse(
      argv,
      (error, _argv, output) => {
        if (output) {
          writeStdoutLine(output);
        }
        if (error) {
          writeStderrLine(error.message);
          process.exitCode = 1;
        }
        resolve();
      }
    );
  });
}
__name(parseYargsCommand, "parseYargsCommand");
async function runCliEntry(rawArgv = process.argv.slice(2)) {
  clearInheritedPeerMessagingEnv();
  const managedUpdateVersion = process.env["QWEN_CODE_MANAGED_NPM_UPDATE_VERSION"];
  if (managedUpdateVersion) {
    delete process.env["QWEN_CODE_MANAGED_NPM_UPDATE_VERSION"];
    delete process.env["QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN"];
    const { installManagedNpmUpdate } = await import("./chunks/managed-npm-update-5AMXOIG7.js");
    await installManagedNpmUpdate(managedUpdateVersion);
    return;
  }
  const argv = normalizeServeFastPathArgv(rawArgv);
  const route = resolveBootstrapRoute(argv);
  if (route !== "serve") {
    delete process.env["QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN"];
  }
  if (route === "version") {
    await printBootstrapVersion();
    return;
  }
  if (route === "serve") {
    const { tryRunServeFastPath } = await import("./chunks/fast-path-QNCXDM4B.js");
    if (await tryRunServeFastPath(argv)) {
      return;
    }
  } else if (route === "mcp") {
    await runMcpFastPath(argv);
    return;
  } else if (route === "help") {
    await printTopLevelHelp();
    return;
  }
  const acpStartupProfiler = rawArgv.some(
    (arg) => arg === "--acp" || arg === "--experimental-acp"
  ) ? await import("./chunks/acp-startup-profiler-MOOU37VM.js") : void 0;
  acpStartupProfiler?.initializeAcpStartupProfiler();
  acpStartupProfiler?.markAcpStartup("geminiImportStart");
  const { main } = await import("./chunks/llm-QKUQ7OOD.js");
  acpStartupProfiler?.markAcpStartup("geminiImportEnd");
  await main();
}
__name(runCliEntry, "runCliEntry");
async function handleCriticalError(error) {
  const [{ FatalError }, { AlreadyReportedError }] = await Promise.all([
    import("./chunks/deferred-core-runtime-2IG4SLGP.js"),
    import("./chunks/errors-2KRZPKZJ.js")
  ]);
  if (error instanceof FatalError) {
    let errorMessage = error.message;
    if (!process.env["NO_COLOR"]) {
      errorMessage = `\x1B[31m${errorMessage}\x1B[0m`;
    }
    writeStderrLine(errorMessage);
    process.exit(error.exitCode);
  }
  if (error instanceof AlreadyReportedError) {
    process.exit(error.exitCode);
  }
  writeStderrLine("An unexpected critical error occurred:");
  if (error instanceof Error) {
    writeStderrLine(error.stack ?? error.message);
  } else {
    writeStderrLine(String(error));
  }
  process.exit(1);
}
__name(handleCriticalError, "handleCriticalError");
function writeStderrLine(line) {
  process.stderr.write(line.endsWith("\n") ? line : `${line}
`);
}
__name(writeStderrLine, "writeStderrLine");
function stampCliEntryEnv(entryPath) {
  if (process.env["QWEN_CODE_CLI"]) {
    return;
  }
  let entry = entryPath;
  if (entry === void 0) {
    const entryUrl = new URL("../index.js", import.meta.url);
    if (entryUrl.protocol !== "file:") {
      return;
    }
    entry = fileURLToPath(entryUrl);
  }
  if (existsSync(entry)) {
    try {
      accessSync(entry, constants.X_OK);
    } catch {
      try {
        chmodSync(entry, statSync(entry).mode | 73);
      } catch {
      }
    }
    process.env["QWEN_CODE_CLI"] = entry;
  }
}
__name(stampCliEntryEnv, "stampCliEntryEnv");
async function runCliEntryPoint(run = runCliEntry, handleError = handleCriticalError) {
  stampCliEntryEnv();
  process.on("uncaughtException", handleUncaughtException);
  try {
    await run();
  } catch (error) {
    try {
      await handleError(error);
    } catch (handlerError) {
      writeStderrLine("An unexpected critical error occurred:");
      writeStderrLine("Original error:");
      if (error instanceof Error) {
        writeStderrLine(error.stack ?? error.message);
      } else {
        writeStderrLine(String(error));
      }
      writeStderrLine("Error handler failed:");
      if (handlerError instanceof Error) {
        writeStderrLine(handlerError.stack ?? handlerError.message);
      } else {
        writeStderrLine(String(handlerError));
      }
      process.exit(1);
    }
  }
}
__name(runCliEntryPoint, "runCliEntryPoint");
var isMain = false;
if (process.argv[1] !== void 0) {
  try {
    const argvRealHref = pathToFileURL(realpathSync(process.argv[1])).href;
    const argvHref = pathToFileURL(process.argv[1]).href;
    isMain = import.meta.url === argvHref || import.meta.url === argvRealHref;
  } catch {
    isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}
if (isMain) {
  void runCliEntryPoint();
}
export {
  MCP_COMMANDS,
  TOP_LEVEL_COMMANDS,
  handleCriticalError,
  handleUncaughtException,
  isExpectedPtyRaceError,
  resolveBootstrapRoute,
  runCliEntry,
  runCliEntryPoint,
  stampCliEntryEnv
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
