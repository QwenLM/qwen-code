import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const CUA_SDK_NATIVE_DIR_ENV = "QWEN_CUA_SDK_NATIVE_DIR"
export const CUA_SDK_CACHE_DIR_ENV = "QWEN_CUA_SDK_CACHE_DIR"
export const CUA_SDK_RELEASE_BASE_URL_ENV =
  "QWEN_CUA_SDK_RELEASE_BASE_URL"

export interface CuaSdkNativeTarget {
  archive: string
  cacheKey: string
  library: string
  runtime: string
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export function cuaSdkPackageRoot(): string {
  return packageRoot
}

export function cuaSdkVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { version?: unknown }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("@qwen-code/cua-sdk package version is unavailable")
  }
  return manifest.version
}

export function nativeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version: string = cuaSdkVersion(),
): CuaSdkNativeTarget {
  const runtime = "cua_driver_node_runtime.node"
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return {
      archive: `cua-driver-rs-${version}-darwin-universal-binary.tar.gz`,
      cacheKey: "darwin-universal",
      library: "libcua_driver_sdk.dylib",
      runtime,
    }
  }
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined
    if (
      platform === process.platform &&
      report?.header?.glibcVersionRuntime === undefined
    ) {
      throw new Error(
        "@qwen-code/cua-sdk currently requires glibc on Linux",
      )
    }
    const releaseArch = arch === "arm64" ? "arm64" : "x86_64"
    return {
      archive: `cua-driver-rs-${version}-linux-${releaseArch}-binary.tar.gz`,
      cacheKey: `linux-${releaseArch}`,
      library: "libcua_driver_sdk.so",
      runtime,
    }
  }
  if (platform === "win32" && (arch === "arm64" || arch === "x64")) {
    const releaseArch = arch === "arm64" ? "arm64" : "x86_64"
    return {
      archive: `cua-driver-rs-${version}-windows-${releaseArch}-binary.zip`,
      cacheKey: `windows-${releaseArch}`,
      library: "cua_driver_sdk.dll",
      runtime,
    }
  }
  throw new Error(
    `@qwen-code/cua-sdk does not support ${platform}/${arch}; ` +
      "supported targets are macOS, glibc Linux, and Windows on arm64/x64",
  )
}

export function nativeCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env[CUA_SDK_CACHE_DIR_ENV]
  if (override) return resolve(override)
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Qwen",
      "cua-sdk",
    )
  }
  return join(
    env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "qwen-code",
    "cua-sdk",
  )
}

export function cachedNativeDirectory(
  target: CuaSdkNativeTarget = nativeTarget(),
  version: string = cuaSdkVersion(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(nativeCacheRoot(env, platform), version, target.cacheKey)
}

export function hasNativePayload(
  directory: string,
  target: CuaSdkNativeTarget = nativeTarget(),
): boolean {
  return (
    existsSync(join(directory, target.library)) &&
    existsSync(join(directory, target.runtime))
  )
}

export function hasCompletedNativePayload(
  directory: string,
  target: CuaSdkNativeTarget = nativeTarget(),
): boolean {
  if (!hasNativePayload(directory, target)) return false
  try {
    return statSync(join(directory, "complete.json")).isFile()
  } catch {
    return false
  }
}

export function resolveNativeDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version: string = cuaSdkVersion(),
): string {
  const target = nativeTarget(platform, arch, version)
  const explicit = env[CUA_SDK_NATIVE_DIR_ENV]
  if (explicit) {
    const directory = resolve(explicit)
    if (!hasNativePayload(directory, target)) {
      throw new Error(
        `${CUA_SDK_NATIVE_DIR_ENV}=${directory} does not contain ` +
          `${target.library} and ${target.runtime}`,
      )
    }
    return directory
  }

  const packaged = join(packageRoot, ".native", target.cacheKey)
  if (hasNativePayload(packaged, target)) return packaged

  const cached = cachedNativeDirectory(target, version, env, platform)
  if (hasCompletedNativePayload(cached, target)) return cached

  throw new Error(
    `@qwen-code/cua-sdk ${version} native payload is not installed for ` +
      `${platform}/${arch}. Reinstall without --ignore-scripts or set ` +
      `${CUA_SDK_NATIVE_DIR_ENV} to the directory containing ` +
      `${target.library} and ${target.runtime}.`,
  )
}

export function resolveCuaSdkLibraryPath(): string {
  const target = nativeTarget()
  return join(resolveNativeDirectory(), target.library)
}

export function resolveCuaSdkRuntimePath(): string {
  const target = nativeTarget()
  return join(resolveNativeDirectory(), target.runtime)
}
