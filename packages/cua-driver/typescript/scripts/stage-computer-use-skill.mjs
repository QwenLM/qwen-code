/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = path.resolve(
  packageRoot,
  "..",
  "..",
  "core",
  "src",
  "skills",
  "bundled",
  "computer-use",
)
const resources = ["SKILL.md", "references/macos.md", "references/windows-linux.md"]

for (const resource of resources) {
  const source = path.join(sourceRoot, resource)
  if (!existsSync(source)) {
    throw new Error(`canonical Computer Use skill resource not found: ${source}`)
  }
}
for (const resource of resources) {
  const destination = path.join(packageRoot, "computer-use", resource)
  mkdirSync(path.dirname(destination), { recursive: true })
  copyFileSync(path.join(sourceRoot, resource), destination)
}
