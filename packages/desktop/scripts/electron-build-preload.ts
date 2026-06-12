/**
 * Cross-platform preload build script with verification.
 *
 * Builds BOTH preload entry points:
 * - apps/electron/src/preload/bootstrap.ts -> dist/bootstrap-preload.cjs
 * - apps/electron/src/preload/browser-toolbar.ts -> dist/browser-toolbar-preload.cjs
 */

import { spawn } from "bun";
import { existsSync, statSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
const DIST_DIR = join(ROOT_DIR, "apps/electron/dist");

const OUTPUTS = [
  {
    entry: "apps/electron/src/preload/bootstrap.ts",
    outfile: "apps/electron/dist/bootstrap-preload.cjs",
    label: "bootstrap-preload.cjs",
  },
  {
    entry: "apps/electron/src/preload/browser-toolbar.ts",
    outfile: "apps/electron/dist/browser-toolbar-preload.cjs",
    label: "browser-toolbar-preload.cjs",
  },
] as const;

// Wait for file to stabilize (no size changes)
async function waitForFileStable(filePath: string, timeoutMs = 10000): Promise<boolean> {
  const startTime = Date.now();
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    if (!existsSync(filePath)) {
      await Bun.sleep(100);
      continue;
    }

    const stats = statSync(filePath);
    if (stats.size === lastSize) {
      stableCount++;
      if (stableCount >= 3) {
        return true;
      }
    } else {
      stableCount = 0;
      lastSize = stats.size;
    }

    await Bun.sleep(100);
  }

  return false;
}

// Verify a JavaScript file is syntactically valid
async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) {
    return { valid: false, error: "File does not exist" };
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    return { valid: false, error: "File is empty" };
  }

  const proc = spawn({
    cmd: ["node", "--check", filePath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return { valid: false, error: stderr || "Syntax error" };
  }

  return { valid: true };
}

async function buildEntry(entry: string, outfile: string): Promise<number> {
  const proc = spawn({
    cmd: [
      "bun", "run", "esbuild",
      entry,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      `--outfile=${outfile}`,
      "--external:electron",
    ],
    cwd: ROOT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });

  return proc.exited;
}

async function main(): Promise<void> {
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  console.log("🔨 Building preload entries...");

  for (const output of OUTPUTS) {
    const exitCode = await buildEntry(output.entry, output.outfile);
    if (exitCode !== 0) {
      console.error(`❌ Failed to build ${output.label} (exit code ${exitCode})`);
      process.exit(exitCode);
    }
  }

  console.log("⏳ Waiting for preload outputs to stabilize...");

  for (const output of OUTPUTS) {
    const outputPath = join(ROOT_DIR, output.outfile);
    const stable = await waitForFileStable(outputPath);
    if (!stable) {
      console.error(`❌ ${output.label} did not stabilize`);
      process.exit(1);
    }
  }

  console.log("🔍 Verifying preload outputs...");

  for (const output of OUTPUTS) {
    const outputPath = join(ROOT_DIR, output.outfile);
    const verification = await verifyJsFile(outputPath);
    if (!verification.valid) {
      console.error(`❌ ${output.label} verification failed:`, verification.error);
      process.exit(1);
    }
  }

  console.log("✅ Preload builds complete and verified");
  process.exit(0);
}

main();
