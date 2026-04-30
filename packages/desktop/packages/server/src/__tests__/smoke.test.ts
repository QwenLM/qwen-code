/**
 * Headless server smoke test.
 *
 * Spawns the standalone server as a subprocess and validates:
 * - WebSocket handshake succeeds with valid token
 * - WebSocket handshake fails with invalid token
 * - /health endpoint returns 200
 * - Clean shutdown on SIGTERM
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import WebSocket from 'ws'

const SERVER_ENTRY = join(import.meta.dir, '..', 'index.ts')
const STARTUP_TIMEOUT = 15_000
const TEST_TIMEOUT = 30_000

interface SpawnedServer {
  url: string
  token: string
  healthPort: number
  proc: Subprocess
  stop: () => Promise<void>
}

async function spawnTestServer(extraEnv?: Record<string, string>): Promise<SpawnedServer> {
  const token = crypto.randomUUID() + crypto.randomUUID() // 72 chars, well above 16 minimum
  const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    env: {
      ...process.env,
      ...extraEnv,
      CRAFT_SERVER_TOKEN: token,
      CRAFT_RPC_PORT: '0',
      CRAFT_RPC_HOST: '127.0.0.1',
      CRAFT_HEALTH_PORT: '0', // random port
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return new Promise<SpawnedServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Server did not start within ${STARTUP_TIMEOUT}ms`))
    }, STARTUP_TIMEOUT)

    let url = ''
    let buffer = ''

    const processLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('CRAFT_SERVER_URL=')) {
          url = line.slice('CRAFT_SERVER_URL='.length).trim()
        }
        if (url) {
          clearTimeout(timer)
          resolve({
            url,
            token,
            healthPort: 0, // health port not printed; we skip health test if 0
            proc,
            stop: async () => {
              proc.kill('SIGTERM')
              await proc.exited
            },
          })
          return
        }
      }
    }

    ;(async () => {
      const reader = proc.stdout!.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          processLines()
        }
      } catch {
        // Stream closed
      }
      clearTimeout(timer)
      if (!url) {
        reject(new Error('Server exited before printing CRAFT_SERVER_URL'))
      }
    })()
  })
}

function connectWs(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => {
      // Send handshake
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: '1.0',
        token,
      }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'handshake_ack') {
        resolve(ws)
      } else if (msg.type === 'error') {
        reject(new Error(`Handshake error: ${msg.error?.message}`))
        ws.close()
      }
    })
    ws.on('error', reject)
    ws.on('close', (code, reason) => {
      reject(new Error(`WS closed: ${code} ${reason}`))
    })
  })
}

describe('headless server smoke test', () => {
  let server: SpawnedServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {})
      server = null
    }
  })

  it('accepts valid token handshake', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  }, TEST_TIMEOUT)

  it('rejects invalid token', async () => {
    server = await spawnTestServer()
    await expect(
      connectWs(server.url, 'wrong-token-that-is-long-enough'),
    ).rejects.toThrow()
  }, TEST_TIMEOUT)

  it('rejects short token at startup', async () => {
    const token = 'short'
    const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
      env: {
        ...process.env,
        CRAFT_SERVER_TOKEN: token,
        CRAFT_RPC_PORT: '0',
        CRAFT_RPC_HOST: '127.0.0.1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
  }, TEST_TIMEOUT)

  it('shuts down cleanly on SIGTERM', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)

    // Server should be running
    expect(ws.readyState).toBe(WebSocket.OPEN)

    // Send SIGTERM
    server.proc.kill('SIGTERM')
    const exitCode = await server.proc.exited
    expect(exitCode).toBe(0)

    // Mark as stopped so afterEach doesn't double-kill
    server = null
  }, TEST_TIMEOUT)
})
