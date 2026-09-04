#!/usr/bin/env node

import { spawnSync } from "node:child_process"

import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const driverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const file =
  process.platform === "darwin"
    ? "libcua_driver_sdk.dylib"
    : process.platform === "win32"
      ? "cua_driver_sdk.dll"
      : "libcua_driver_sdk.so"
const source = join(driverRoot, "rust", "target", "release", file)
if (!existsSync(source)) {
  throw new Error(`missing ${source}; build cua-driver-sdk --release first`)
}

const destinations = [join(driverRoot, "python", "src", "cua_driver", file)]
for (const destination of destinations) {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  console.log(`staged ${destination}`)
}

const nativeKey = (() => {
  if (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch))
    return "darwin-universal"
  if (process.platform === "win32" && ["arm64", "x64"].includes(process.arch))
    return `windows-${process.arch === "x64" ? "x86_64" : "arm64"}`
  if (process.platform === "linux" && ["arm64", "x64"].includes(process.arch))
    return `linux-${process.arch === "x64" ? "x86_64" : "arm64"}`
  throw new Error(`unsupported Node platform ${process.platform}/${process.arch}`)
})()
const localNative = join(driverRoot, "typescript", ".native", nativeKey)
mkdirSync(localNative, { recursive: true })
copyFileSync(source, join(localNative, file))
if (process.platform === "win32") {
  const workerSource = join(driverRoot, "rust", "target", "release", "cua-driver-uia.exe")
  if (!existsSync(workerSource)) {
    throw new Error(`missing ${workerSource}; build cua-driver-uia --release first`)
  }
  copyFileSync(workerSource, join(localNative, "qwen-cua-driver-uia.exe"))
}
const runtime = join(localNative, "cua_driver_node_runtime.node")
const runtimeBuild = spawnSync(
  process.execPath,
  [join(driverRoot, "scripts", "build-node-runtime.mjs"), "--output", runtime],
  { stdio: "inherit" },
)
if (runtimeBuild.error) throw runtimeBuild.error
if (runtimeBuild.status !== 0) {
  throw new Error(`Node runtime build exited with status ${runtimeBuild.status}`)
}
console.log(`staged local Node native payload ${localNative}`)
