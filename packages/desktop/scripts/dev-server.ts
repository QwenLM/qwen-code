#!/usr/bin/env bun

import { spawn } from "bun";
import { join } from "path";
import { detectDevInstance, resolveDevPort } from "./dev-instance";

const ROOT_DIR = join(import.meta.dir, "..");

type Options = {
  skipBuildSubprocess: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    skipBuildSubprocess: false,
  };

  for (const arg of argv) {
    switch (arg) {
      case "--skip-build-subprocess":
        options.skipBuildSubprocess = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: bun run scripts/dev-server.ts [--skip-build-subprocess]`);
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function run(cmd: string[], env = process.env as Record<string, string>): Promise<void> {
  const proc = spawn({
    cmd,
    cwd: ROOT_DIR,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
  const code = await proc.exited;
  if (code !== 0) {
    process.exit(code);
  }
}

function applyDevInstanceEnvironment(): void {
  const instance = detectDevInstance(ROOT_DIR);
  if (!instance) return;

  process.env.CRAFT_INSTANCE_NUMBER ||= instance.instanceNumber;
  if (instance.configDir) {
    process.env.CRAFT_CONFIG_DIR ||= instance.configDir;
  }
  process.env.CRAFT_SERVER_LOCK_FILE ||= instance.serverLockFile;

  const configDir = process.env.CRAFT_CONFIG_DIR || "~/.craft-agent";
  console.log(
    `🔢 ${instance.source} detected (${instance.label}): ` +
    `rpc=${process.env.CRAFT_RPC_PORT}, config=${configDir}, lock=${process.env.CRAFT_SERVER_LOCK_FILE}`
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const rpcPort = resolveDevPort(ROOT_DIR, 9100, "CRAFT_RPC_PORT", { allowZero: true }).port;
  process.env.CRAFT_RPC_PORT ||= String(rpcPort);
  process.env.CRAFT_DEBUG ||= "true";
  process.env.CRAFT_BUNDLED_ASSETS_ROOT ||= join(ROOT_DIR, "apps/electron");

  applyDevInstanceEnvironment();

  if (!detectDevInstance(ROOT_DIR)) {
    console.log(`🔌 Starting server dev on CRAFT_RPC_PORT=${process.env.CRAFT_RPC_PORT}`);
  }

  if (!options.skipBuildSubprocess) {
    await run(["bun", "run", "server:build:subprocess"]);
  }

  await run(["bun", "run", "packages/server/src/index.ts"]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
