/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.resolve(
  packageRoot,
  "..",
  "..",
  "core",
  "src",
  "skills",
  "bundled",
  "computer-use",
  "SKILL.md",
)
const destination = path.join(packageRoot, "computer-use", "SKILL.md")

if (!existsSync(source)) {
  throw new Error(`canonical Computer Use skill not found: ${source}`)
}
copyFileSync(source, destination)
