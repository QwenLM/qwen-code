import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const libraryName =
  process.platform === "darwin"
    ? "libcua_driver_sdk.dylib"
    : process.platform === "win32"
      ? "cua_driver_sdk.dll"
      : "libcua_driver_sdk.so"
const nativeKey =
  process.platform === "darwin"
    ? "darwin-universal"
    : process.platform === "win32"
      ? `windows-${process.arch === "x64" ? "x86_64" : "arm64"}`
      : `linux-${process.arch === "x64" ? "x86_64" : "arm64"}`
const library = process.env.QWEN_CUA_SDK_NATIVE_DIR
  ? path.resolve(process.env.QWEN_CUA_SDK_NATIVE_DIR, libraryName)
  : path.resolve(testDirectory, "../.native", nativeKey, libraryName)

test(
  "embedded subpath is the same generated Rust host as the SDK root",
  { skip: !existsSync(library) },
  async () => {
    const root = await import("@qwen-code/cua-sdk")
    const embedded = await import("@qwen-code/cua-sdk/embedded")

    assert.equal(embedded.EmbeddedCuaDriverHost, root.EmbeddedCuaDriverHost)
    assert.equal(embedded.EmbeddedDriverHostOptions, root.EmbeddedDriverHostOptions)
    assert.equal(embedded.EmbeddedPermissionMode, root.EmbeddedPermissionMode)
    assert.throws(
      () => new embedded.EmbeddedCuaDriverHost("", "com.example.host"),
      error => error?.inner?.reason === "binary_path must not be empty",
    )

    assert.throws(
      () =>
        embedded.EmbeddedCuaDriverHost.withOptions(
          embedded.EmbeddedDriverHostOptions.new({
            binaryPath: "/example/cua-driver",
            hostBundleId: "com.example.host",
            approveSessionPolicy: false,
            dangerouslyBypassApprovals: false,
            environment: [
              embedded.EmbeddedEnvironmentVariable.new({
                name: "CUA_DRIVER_PERMISSION_MODE",
                value: "unrestricted",
              }),
            ],
            inheritStderr: false,
          }),
        ),
      error => error?.inner?.reason?.includes("safe allowlist") === true,
    )
  },
)
