/**
 * Cross-platform clean script for electron build artifacts
 */

import { existsSync, rmSync } from "fs";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const dirsToClean = [
  join(ELECTRON_DIR, "dist"),
  join(ELECTRON_DIR, "release"),
];

for (const dir of dirsToClean) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`🧹 Removed ${dir}`);
  }
}

console.log("✅ Clean complete");
