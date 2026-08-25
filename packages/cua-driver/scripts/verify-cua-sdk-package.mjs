#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const driverRoot = resolve(scriptDirectory, "..")
const packageRoot = join(driverRoot, "typescript")

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`missing ${flag}`)
  }
  return process.argv[index + 1]
}

function optionalValueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index < 0 ? undefined : process.argv[index + 1]
}

const nativeDirectory = resolve(valueAfter("--native-dir"))
const outputDirectory = resolve(valueAfter("--output-dir"))
const releaseDirectoryArgument = optionalValueAfter("--release-dir")
const releaseDirectory = releaseDirectoryArgument
  ? resolve(releaseDirectoryArgument)
  : undefined
const npmRegistry = "https://registry.npmjs.org"

async function startReleaseFixture(directory) {
  const source = String.raw`
    import { createReadStream } from "node:fs";
    import { stat } from "node:fs/promises";
    import { createServer } from "node:http";
    import { basename, join } from "node:path";

    const root = process.env.CUA_SDK_RELEASE_FIXTURE_DIR;
    const server = createServer(async (request, response) => {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://127.0.0.1").pathname,
      );
      const filename = basename(pathname);
      if (pathname !== "/" + filename) {
        response.writeHead(404).end();
        return;
      }
      const file = join(root, filename);
      const status = await stat(file).catch(() => undefined);
      if (!status?.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-length": status.size });
      createReadStream(file).pipe(response);
    });
    server.listen(0, "127.0.0.1", () => {
      process.send({ port: server.address().port });
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, CUA_SDK_RELEASE_FIXTURE_DIR: directory },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  })
  const port = await new Promise((resolvePort, reject) => {
    child.once("error", reject)
    child.once("exit", (code) =>
      reject(new Error(`release fixture exited before ready with status ${code}`)),
    )
    child.once("message", (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        Number.isInteger(message.port)
      ) {
        resolvePort(message.port)
      } else {
        reject(new Error("release fixture returned an invalid port"))
      }
    })
  })
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => child.kill(),
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stderr || result.stdout}`
      : ""
    throw new Error(`${command} exited with status ${result.status}${detail}`)
  }
  return result.stdout
}

const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
)
if (manifest.name !== "@qwen-code/cua-sdk") {
  throw new Error(`unexpected package name ${manifest.name}`)
}
const rustVersion = readFileSync(join(driverRoot, "rust", "VERSION"), "utf8").trim()
if (manifest.version !== rustVersion) {
  throw new Error(
    `SDK version ${manifest.version} does not match driver version ${rustVersion}`,
  )
}
if (!existsSync(nativeDirectory)) {
  throw new Error(`native directory does not exist: ${nativeDirectory}`)
}
if (releaseDirectory && !existsSync(releaseDirectory)) {
  throw new Error(`release fixture directory does not exist: ${releaseDirectory}`)
}

mkdirSync(outputDirectory, { recursive: true })
run("npm", ["run", "build"])
const packOutput = JSON.parse(
  run(
    "npm",
    ["pack", ".", "--pack-destination", outputDirectory, "--json"],
    { capture: true },
  ),
)
if (!Array.isArray(packOutput) || packOutput.length !== 1) {
  throw new Error("npm pack did not produce exactly one package")
}
const packed = packOutput[0]
if (packed.name !== manifest.name || packed.version !== manifest.version) {
  throw new Error(
    `packed identity ${packed.name}@${packed.version} does not match source`,
  )
}
const packedPaths = packed.files.map((entry) => entry.path)
for (const required of [
  "LICENSE.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/native-assets.js",
  "computer-use/index.js",
  "computer-use/index.d.ts",
  "scripts/install-native.mjs",
]) {
  if (!packedPaths.includes(required)) {
    throw new Error(`packed SDK is missing ${required}`)
  }
}
const bundledNative = packedPaths.find((path) =>
  /\.(?:dll|dylib|node|so)$/u.test(path),
)
if (bundledNative) {
  throw new Error(`SDK tarball must not bundle native payload: ${bundledNative}`)
}

const tarball = join(outputDirectory, packed.filename)
const tarballs = readdirSync(outputDirectory).filter((name) => name.endsWith(".tgz"))
if (tarballs.length !== 1 || tarballs[0] !== packed.filename) {
  throw new Error(`expected exactly one SDK tarball, found ${tarballs.join(", ")}`)
}
run("npm", [
  "publish",
  tarball,
  "--dry-run",
  "--access",
  "public",
  "--json",
  `--registry=${npmRegistry}`,
])

const consumer = mkdtempSync(join(tmpdir(), "qwen-cua-sdk-consumer-"))
let releaseFixture
try {
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "cua-sdk-release-smoke", private: true, type: "module" }, null, 2)}\n`,
  )
  const environment = { ...process.env }
  if (releaseDirectory) {
    releaseFixture = await startReleaseFixture(releaseDirectory)
    delete environment.QWEN_CUA_SDK_NATIVE_DIR
    environment.QWEN_CUA_SDK_CACHE_DIR = join(consumer, "native-cache")
    environment.QWEN_CUA_SDK_RELEASE_BASE_URL = releaseFixture.baseUrl
  } else {
    environment.QWEN_CUA_SDK_NATIVE_DIR = nativeDirectory
  }
  run(
    "npm",
    [
      "install",
      tarball,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts=false",
      `--registry=${npmRegistry}`,
    ],
    { cwd: consumer, env: environment },
  )
  const dependencyTree = run("npm", ["ls", "--all", "--json"], {
    cwd: consumer,
    env: environment,
    capture: true,
  })
  for (const forbidden of [
    "@trycua/cua-driver",
    "@qwen-code/qwen-cua-driver",
    "@qwen-code/cua-sdk-darwin",
    "@qwen-code/cua-sdk-linux",
    "@qwen-code/cua-sdk-win32",
  ]) {
    if (dependencyTree.includes(forbidden)) {
      throw new Error(`clean consumer unexpectedly installed ${forbidden}`)
    }
  }

  const smoke = `
    import { CuaDriver } from "@qwen-code/cua-sdk";
    import { ComputerUse } from "@qwen-code/cua-sdk/computer-use";
    const driver = CuaDriver.create(undefined);
    const computer = await ComputerUse.create({ session: "release-package-smoke" });
    try {
      const listing = JSON.parse(await driver.listToolsJson());
      if (!Array.isArray(listing.tools) || listing.tools.length === 0) {
        throw new Error("native SDK returned no tools");
      }
      const revisionSupported = await computer.supportsObservationRevision();
      if (typeof revisionSupported !== "boolean") {
        throw new Error("ComputerUse capability probe returned an invalid result");
      }
      process.stdout.write(JSON.stringify({
        package: "@qwen-code/cua-sdk",
        toolCount: listing.tools.length,
        revisionSupported,
      }) + "\\n");
    } finally {
      await computer.close();
      await driver.shutdown();
      driver.uniffiDestroy();
    }
  `
  run(process.execPath, ["--input-type=module", "--eval", smoke], {
    cwd: consumer,
    env: environment,
  })
} finally {
  releaseFixture?.stop()
  rmSync(consumer, { recursive: true, force: true })
}

process.stdout.write(
  `${JSON.stringify({
    name: packed.name,
    version: packed.version,
    tarball,
    integrity: packed.integrity,
    fileCount: packed.files.length,
    postinstallSource: releaseDirectory ? "release-fixture" : "native-override",
  })}\n`,
)
