#!/usr/bin/env bun

import { spawn } from "bun";
import { join } from "path";
import { detectDevInstance, resolveDevPort } from "./dev-instance";

const ROOT_DIR = join(import.meta.dir, "..");
const IS_WINDOWS = process.platform === "win32";
const BIN_EXT = IS_WINDOWS ? ".exe" : "";
const VITE_BIN = join(ROOT_DIR, `node_modules/.bin/vite${BIN_EXT}`);

type Options = {
  config: string;
  defaultPort: number;
  label: string;
  portEnv?: string;
  open?: string;
  strictPort: boolean;
  passThrough: string[];
};

function printUsage(): void {
  console.log(`Usage: bun run scripts/dev-vite.ts --config <path> --default-port <port> [options]

Options:
  --label <name>       Name shown in logs.
  --port-env <name>    Environment variable that can override the port.
  --open <path>        Path or URL to pass to Vite --open.
  --no-strict-port     Allow Vite to choose the next free port.
  --                  Pass the remaining args through to Vite.`);
}

function readArg(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = {
    strictPort: true,
    passThrough: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.passThrough = argv.slice(index + 1);
      break;
    }

    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      case "--config":
        options.config = readArg(argv, index, arg);
        index += 1;
        break;
      case "--default-port": {
        const rawPort = readArg(argv, index, arg);
        const port = Number(rawPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid --default-port: ${rawPort}`);
        }
        options.defaultPort = port;
        index += 1;
        break;
      }
      case "--label":
        options.label = readArg(argv, index, arg);
        index += 1;
        break;
      case "--port-env":
        options.portEnv = readArg(argv, index, arg);
        index += 1;
        break;
      case "--open":
        options.open = readArg(argv, index, arg);
        index += 1;
        break;
      case "--no-strict-port":
        options.strictPort = false;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.config) throw new Error("Missing --config");
  if (!options.defaultPort) throw new Error("Missing --default-port");

  return {
    config: options.config,
    defaultPort: options.defaultPort,
    label: options.label || options.config,
    portEnv: options.portEnv,
    open: options.open,
    strictPort: options.strictPort ?? true,
    passThrough: options.passThrough || [],
  };
}

function describePort(options: Options, port: number): void {
  const instance = detectDevInstance(ROOT_DIR);
  if (instance) {
    console.log(`🔢 ${instance.source} detected (${instance.label}): ${options.label} port=${port}`);
    return;
  }

  if (options.portEnv && process.env[options.portEnv]) {
    console.log(`🔌 Starting ${options.label} on ${options.portEnv}=${port}`);
    return;
  }

  console.log(`🔌 Starting ${options.label} on port ${port}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const resolvedPort = resolveDevPort(ROOT_DIR, options.defaultPort, options.portEnv);
  const port = String(resolvedPort.port);

  if (options.portEnv) {
    process.env[options.portEnv] ||= port;
  }

  describePort(options, resolvedPort.port);

  const cmd = [
    VITE_BIN,
    "dev",
    "--config",
    options.config,
    "--port",
    port,
    ...(options.strictPort ? ["--strictPort"] : []),
    ...(options.open ? ["--open", options.open] : []),
    ...options.passThrough,
  ];

  const proc = spawn({
    cmd,
    cwd: ROOT_DIR,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env as Record<string, string>,
  });

  process.exit(await proc.exited);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

