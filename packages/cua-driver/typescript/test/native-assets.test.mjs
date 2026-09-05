import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { c as createTar } from "tar"

import {
  hasNativePayload,
  nativeTarget,
  resolveNativeDirectory,
} from "../dist/native-assets.js"
import {
  ensureNativePayload,
  parseChecksums,
  uiAccessWorkerPath,
} from "../scripts/install-native.mjs"

test("release target mapping uses Qwen binary archives", () => {
  assert.equal(
    nativeTarget("darwin", "arm64", "1.2.3").archive,
    "cua-driver-rs-1.2.3-darwin-universal-binary.tar.gz",
  )
  assert.equal(
    nativeTarget("linux", "x64", "1.2.3").archive,
    "cua-driver-rs-1.2.3-linux-x86_64-binary.tar.gz",
  )
  assert.equal(
    nativeTarget("win32", "arm64", "1.2.3").archive,
    "cua-driver-rs-1.2.3-windows-arm64-binary.zip",
  )
  assert.deepEqual(nativeTarget("win32", "x64", "1.2.3").companions, [
    "qwen-cua-driver-uia.exe",
  ])
  assert.throws(() => nativeTarget("freebsd", "x64", "1.2.3"))
})

test("an explicit native directory is authoritative", () => {
  const directory = mkdtempSync(join(tmpdir(), "cua-sdk-native-explicit-"))
  const target = nativeTarget(process.platform, process.arch, "1.2.3")
  try {
    assert.throws(() =>
      resolveNativeDirectory(
        { QWEN_CUA_SDK_NATIVE_DIR: directory },
        process.platform,
        process.arch,
        "1.2.3",
      ),
    )
    writeFileSync(join(directory, target.library), "library")
    writeFileSync(join(directory, target.runtime), "runtime")
    assert.equal(
      resolveNativeDirectory(
        { QWEN_CUA_SDK_NATIVE_DIR: directory },
        process.platform,
        process.arch,
        "1.2.3",
      ),
      directory,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("native installer verifies and extracts the matching release archive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cua-sdk-native-install-"))
  const source = join(directory, "source")
  const cache = join(directory, "cache")
  mkdirSync(source)
  const version = "9.8.7"
  const target = nativeTarget("linux", "x64", version)
  const destination = join(cache, version, target.cacheKey)
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, target.library), "uncommitted-library")
  writeFileSync(join(destination, target.runtime), "uncommitted-runtime")
  const env = {
    QWEN_CUA_SDK_CACHE_DIR: cache,
    QWEN_CUA_SDK_RELEASE_BASE_URL: "https://release.invalid/tag",
  }
  writeFileSync(join(source, target.library), "sdk-library")
  writeFileSync(join(source, target.runtime), "node-runtime")
  const archive = join(directory, target.archive)
  await createTar({ cwd: source, file: archive, gzip: true }, [
    target.library,
    target.runtime,
  ])
  const archiveBytes = readFileSync(archive)
  const checksum = createHash("sha256").update(archiveBytes).digest("hex")
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(String(url))
    return String(url).endsWith("checksums.txt")
      ? new Response(`${checksum}  ${target.archive}\n`)
      : new Response(archiveBytes)
  }

  try {
    assert.throws(
      () => resolveNativeDirectory(env, "linux", "x64", version),
      /native payload is not installed/u,
    )
    const installed = await ensureNativePayload({
      arch: "x64",
      env,
      fetchImpl,
      platform: "linux",
      version,
    })
    assert.equal(installed, destination)
    assert.equal(hasNativePayload(installed, target), true)
    assert.equal(
      readFileSync(join(installed, target.library), "utf8"),
      "sdk-library",
    )
    assert.equal(
      readFileSync(join(installed, target.runtime), "utf8"),
      "node-runtime",
    )
    assert.equal(
      JSON.parse(readFileSync(join(installed, "complete.json"), "utf8"))
        .version,
      version,
    )
    assert.deepEqual(requests, [
      "https://release.invalid/tag/checksums.txt",
      `https://release.invalid/tag/${target.archive}`,
    ])

    requests.length = 0
    assert.equal(
      await ensureNativePayload({
        arch: "x64",
        env: { QWEN_CUA_SDK_CACHE_DIR: cache },
        fetchImpl,
        platform: "linux",
        version,
      }),
      installed,
    )
    assert.deepEqual(requests, [])
    assert.equal(
      resolveNativeDirectory(env, "linux", "x64", version),
      destination,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("checksum mismatch never exposes a native payload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cua-sdk-native-mismatch-"))
  const version = "9.8.6"
  const target = nativeTarget("linux", "x64", version)
  const env = {
    QWEN_CUA_SDK_CACHE_DIR: join(directory, "cache"),
    QWEN_CUA_SDK_RELEASE_BASE_URL: "https://release.invalid/tag",
  }
  const fetchImpl = async (url) =>
    String(url).endsWith("checksums.txt")
      ? new Response(`${"0".repeat(64)}  ${target.archive}\n`)
      : new Response("corrupt")
  try {
    await assert.rejects(
      ensureNativePayload({
        arch: "x64",
        env,
        fetchImpl,
        platform: "linux",
        version,
      }),
      /checksum mismatch/u,
    )
    assert.equal(
      hasNativePayload(
        join(env.QWEN_CUA_SDK_CACHE_DIR, version, target.cacheKey),
        target,
      ),
      false,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("checksum parser accepts sha256sum output only", () => {
  assert.deepEqual(
    [...parseChecksums(`${"a".repeat(64)}  archive.tar.gz\ninvalid\n`)],
    [["archive.tar.gz", "a".repeat(64)]],
  )
})

test("UIAccess worker uses the versioned secure Windows path", () => {
  assert.equal(
    uiAccessWorkerPath("1.2.3", { ProgramFiles: String.raw`C:\Program Files` }),
    join(
      String.raw`C:\Program Files`,
      "Qwen",
      "CuaDriver",
      "1.2.3",
      "qwen-cua-driver-uia.exe",
    ),
  )
  assert.throws(() => uiAccessWorkerPath("1.2.3", {}), /ProgramFiles/u)
})
