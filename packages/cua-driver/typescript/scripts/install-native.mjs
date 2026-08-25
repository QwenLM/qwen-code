#!/usr/bin/env node

import { createHash } from "node:crypto"
import { createWriteStream, existsSync } from "node:fs"
import {
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { x as extractTar } from "tar"

const DEFAULT_RELEASE_ROOT =
  "https://github.com/QwenLM/qwen-code/releases/download"
const NATIVE_ASSETS_MODULE = new URL("../dist/native-assets.js", import.meta.url)
const SOURCE_NATIVE_ASSETS = new URL("../src/native-assets.ts", import.meta.url)
const CUA_SDK_NATIVE_DIR_ENV = "QWEN_CUA_SDK_NATIVE_DIR"
const CUA_SDK_RELEASE_BASE_URL_ENV = "QWEN_CUA_SDK_RELEASE_BASE_URL"

export function parseChecksums(body) {
  const checksums = new Map()
  for (const line of body.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/iu)
    if (match) checksums.set(match[2].trim(), match[1].toLowerCase())
  }
  return checksums
}

function releaseBases(version, env) {
  const tag = `cua-driver-rs-v${version}`
  const override = env[CUA_SDK_RELEASE_BASE_URL_ENV]
  const bases = []
  if (override) bases.push(override.replace(/\/+$/u, ""))
  bases.push(`${DEFAULT_RELEASE_ROOT}/${tag}`)
  return [...new Set(bases)]
}

async function fetchFirst(filename, version, env, fetchImpl) {
  const failures = []
  for (const base of releaseBases(version, env)) {
    const url = `${base}/${filename}`
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      })
      if (response.ok && response.body) return { response, url }
      await response.body?.cancel()
      failures.push(`${url}: HTTP ${response.status}`)
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`unable to download ${filename}: ${failures.join("; ")}`)
}

async function downloadArchive(response, destination) {
  const hash = createHash("sha256")
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(response.body),
    hasher,
    createWriteStream(destination),
  )
  return hash.digest("hex")
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`
}

async function extractZip(archive, destination) {
  const run = promisify(execFile)
  const command =
    `Expand-Archive -LiteralPath ${quotePowerShell(archive)} ` +
    `-DestinationPath ${quotePowerShell(destination)} -Force`
  const attempts = [
    ["tar", ["-xf", archive, "-C", destination]],
    ["tar", ["--force-local", "-xf", archive, "-C", destination]],
    ["powershell", ["-NoProfile", "-NonInteractive", "-Command", command]],
  ]
  const failures = []
  for (const [executable, args] of attempts) {
    try {
      await run(executable, args, { timeout: 180_000 })
      return
    } catch (error) {
      failures.push(
        `${executable}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  throw new Error(`unable to extract ${archive}: ${failures.join("; ")}`)
}

async function installFiles(extracted, destination, target, metadata) {
  for (const filename of [target.library, target.runtime]) {
    const source = join(extracted, filename)
    const sourceStatus = await stat(source).catch(() => undefined)
    if (!sourceStatus?.isFile()) {
      throw new Error(`${target.archive} does not contain ${filename}`)
    }
  }

  await mkdir(destination, { recursive: true })
  for (const filename of [target.library, target.runtime]) {
    const temporary = join(destination, `.${filename}.${process.pid}.tmp`)
    await copyFile(join(extracted, filename), temporary)
    await rename(temporary, join(destination, filename))
  }
  const marker = join(destination, `.complete.${process.pid}.tmp`)
  await writeFile(marker, `${JSON.stringify(metadata, null, 2)}\n`)
  await rename(marker, join(destination, "complete.json"))
}

export async function ensureNativePayload({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  version,
  fetchImpl = fetch,
} = {}) {
  const {
    cachedNativeDirectory,
    cuaSdkVersion,
    hasCompletedNativePayload,
    nativeTarget,
    resolveNativeDirectory,
  } = await import(NATIVE_ASSETS_MODULE.href)
  version ??= cuaSdkVersion()
  const target = nativeTarget(platform, arch, version)
  if (env[CUA_SDK_NATIVE_DIR_ENV]) {
    return resolveNativeDirectory(env, platform, arch, version)
  }

  const destination = cachedNativeDirectory(
    target,
    version,
    env,
    platform,
  )
  if (hasCompletedNativePayload(destination, target)) return destination
  await rm(join(destination, "complete.json"), {
    force: true,
    recursive: true,
  })

  const temporary = await mkdtemp(join(tmpdir(), "qwen-cua-sdk-"))
  try {
    const checksumResult = await fetchFirst(
      "checksums.txt",
      version,
      env,
      fetchImpl,
    )
    const checksums = parseChecksums(await checksumResult.response.text())
    const expected = checksums.get(target.archive)
    if (!expected) {
      throw new Error(`${target.archive} is missing from checksums.txt`)
    }

    const archiveResult = await fetchFirst(
      target.archive,
      version,
      env,
      fetchImpl,
    )
    const archive = join(temporary, basename(target.archive))
    const actual = await downloadArchive(archiveResult.response, archive)
    if (actual !== expected) {
      throw new Error(
        `checksum mismatch for ${target.archive}: expected ${expected}, got ${actual}`,
      )
    }

    const extracted = join(temporary, "extracted")
    await mkdir(extracted)
    if (target.archive.endsWith(".zip")) {
      await extractZip(archive, extracted)
    } else {
      await extractTar({ file: archive, cwd: extracted })
    }
    await installFiles(extracted, destination, target, {
      archive: target.archive,
      checksum: actual,
      source: archiveResult.url,
      version,
    })
    return destination
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (existsSync(fileURLToPath(SOURCE_NATIVE_ASSETS))) {
    process.stdout.write(
      "@qwen-code/cua-sdk source checkout detected; use npm run stage:uniffi for local native assets\n",
    )
  } else {
    ensureNativePayload()
      .then((directory) => {
        process.stdout.write(`@qwen-code/cua-sdk native payload ready: ${directory}\n`)
      })
      .catch((error) => {
        process.stderr.write(
          `@qwen-code/cua-sdk native installation failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
        process.exitCode = 1
      })
  }
}
