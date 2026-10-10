import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { c as createTar } from "tar"

import { nativeTarget } from "../dist/native-assets.js"
import { ensureNativePayload } from "../scripts/install-native.mjs"

test(
  "native installer routes downloads through the configured proxy",
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "cua-sdk-proxy-"))
    const sockets = new Set()
    const proxyPorts = new Set()
    const requests = []
    const connectionsClosed = []
    const version = "9.8.7"
    const target = nativeTarget("linux", "x64", version)
    let origin
    let proxy
    let checksumOverride
    try {
      const source = join(directory, "source")
      await mkdir(source)
      await writeFile(join(source, target.library), "fixture library")
      await writeFile(join(source, target.runtime), "fixture runtime")
      const archive = join(directory, target.archive)
      await createTar({ cwd: source, file: archive, gzip: true }, [
        target.library,
        target.runtime,
      ])
      const bytes = await readFile(archive)
      const checksum = createHash("sha256").update(bytes).digest("hex")
      origin = createServer((request, response) => {
        requests.push({
          path: request.url,
          proxied: proxyPorts.has(request.socket.remotePort),
        })
        if (request.url === "/release/checksums.txt") {
          response.writeHead(302, { location: "/checksums.txt" })
          response.end()
        } else if (request.url === "/checksums.txt") {
          response.end(`${checksumOverride ?? checksum}  ${target.archive}\n`)
        } else if (request.url === `/release/${target.archive}`) {
          response.end(bytes)
        } else {
          response.writeHead(404)
          response.end()
        }
      })
      origin.listen(0, "127.0.0.1")
      await once(origin, "listening")
      const originPort = origin.address().port
      proxy = createServer()
      proxy.on("connect", (request, client, head) => {
        if (request.url !== `127.0.0.1:${originPort}`) {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
          return
        }
        const upstream = connect(originPort, "127.0.0.1", () => {
          const port = upstream.localPort
          proxyPorts.add(port)
          upstream.once("close", () => proxyPorts.delete(port))
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          if (head.length) upstream.write(head)
          client.pipe(upstream)
          upstream.pipe(client)
        })
        for (const socket of [client, upstream]) {
          sockets.add(socket)
          connectionsClosed.push(
            new Promise((resolve) => socket.once("close", resolve)),
          )
          socket.on("close", () => sockets.delete(socket))
        }
        upstream.on("error", () => client.destroy())
        client.on("error", () => upstream.destroy())
      })
      proxy.listen(0, "127.0.0.1")
      await once(proxy, "listening")
      const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
      const cases = [
        ["uppercase", { HTTP_PROXY: proxyUrl }, true],
        [
          "lowercase precedence",
          { http_proxy: proxyUrl, HTTP_PROXY: "http://127.0.0.1:1" },
          true,
        ],
        ["NO_PROXY", { HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" }, false],
        ["NO_PROXY wildcard", { HTTP_PROXY: proxyUrl, NO_PROXY: "*" }, false],
        [
          "NO_PROXY port",
          { HTTP_PROXY: proxyUrl, NO_PROXY: `127.0.0.1:${originPort}` },
          false,
        ],
        [
          "NO_PROXY unmatched port",
          { HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1:1" },
          true,
        ],
        [
          "no_proxy precedence",
          {
            HTTP_PROXY: proxyUrl,
            no_proxy: "127.0.0.1",
            NO_PROXY: "unmatched.invalid",
          },
          false,
        ],
        [
          "empty lowercase proxy",
          { HTTP_PROXY: proxyUrl, http_proxy: "" },
          false,
        ],
        [
          "empty lowercase no_proxy",
          { HTTP_PROXY: proxyUrl, NO_PROXY: "*", no_proxy: "" },
          true,
        ],
        ["direct", {}, false],
      ]
      for (const [name, proxyEnv, proxied] of cases) {
        await t.test(name, async () => {
          const start = requests.length
          const env = {
            ...proxyEnv,
            QWEN_CUA_SDK_CACHE_DIR: join(directory, name),
            QWEN_CUA_SDK_RELEASE_BASE_URL: `http://127.0.0.1:${originPort}/release`,
          }
          const installed = await ensureNativePayload({
            env,
            version,
            platform: "linux",
            arch: "x64",
          })
          assert.deepEqual(requests.slice(start), [
            { path: "/release/checksums.txt", proxied },
            { path: "/checksums.txt", proxied },
            { path: `/release/${target.archive}`, proxied },
          ])
          assert.equal(
            await readFile(join(installed, target.library), "utf8"),
            "fixture library",
          )
          assert.equal(
            await readFile(join(installed, target.runtime), "utf8"),
            "fixture runtime",
          )
          assert.equal(
            JSON.parse(await readFile(join(installed, "complete.json"), "utf8"))
              .checksum,
            checksum,
          )
          const count = requests.length
          assert.equal(
            await ensureNativePayload({
              env: { ...env, HTTP_PROXY: "invalid proxy" },
              version,
              platform: "linux",
              arch: "x64",
            }),
            installed,
          )
          assert.equal(requests.length, count)
          assert.equal(
            await ensureNativePayload({
              env: {
                QWEN_CUA_SDK_NATIVE_DIR: installed,
                HTTP_PROXY: "invalid proxy",
              },
              version,
              platform: "linux",
              arch: "x64",
            }),
            installed,
          )
          assert.equal(requests.length, count)
          await Promise.all(connectionsClosed)
        })
      }

      await t.test(
        "explicit env does not inherit process proxy settings",
        async (t) => {
          for (const key of [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "NO_PROXY",
            "no_proxy",
          ]) {
            const previous = process.env[key]
            t.after(() => {
              if (previous === undefined) delete process.env[key]
              else process.env[key] = previous
            })
            process.env[key] =
              key.toLowerCase() === "no_proxy" ? "*" : "invalid proxy"
          }
          for (const useProxy of [false, true]) {
            const start = requests.length
            await ensureNativePayload({
              env: {
                ...(useProxy ? { HTTP_PROXY: proxyUrl } : {}),
                QWEN_CUA_SDK_CACHE_DIR: join(
                  directory,
                  `isolated-env-${useProxy}`,
                ),
                QWEN_CUA_SDK_RELEASE_BASE_URL: `http://127.0.0.1:${originPort}/release`,
              },
              version,
              platform: "linux",
              arch: "x64",
            })
            assert.equal(requests.length - start, 3)
            assert.ok(
              requests
                .slice(start)
                .every(({ proxied }) => proxied === useProxy),
            )
          }
        },
      )

      await t.test(
        "checksum failure closes proxy connections without completing the cache",
        async () => {
          checksumOverride = "0".repeat(64)
          const cache = join(directory, "checksum-failure")
          await assert.rejects(
            ensureNativePayload({
              env: {
                HTTP_PROXY: proxyUrl,
                QWEN_CUA_SDK_CACHE_DIR: cache,
                QWEN_CUA_SDK_RELEASE_BASE_URL: `http://127.0.0.1:${originPort}/release`,
              },
              version,
              platform: "linux",
              arch: "x64",
            }),
            /checksum mismatch/u,
          )
          assert.equal(
            existsSync(join(cache, version, target.cacheKey, "complete.json")),
            false,
          )
          await Promise.all(connectionsClosed)
        },
      )
    } finally {
      for (const socket of sockets) socket.destroy()
      for (const server of [proxy, origin]) {
        if (server) {
          server.closeAllConnections()
          await new Promise((resolve) => server.close(resolve))
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
)
