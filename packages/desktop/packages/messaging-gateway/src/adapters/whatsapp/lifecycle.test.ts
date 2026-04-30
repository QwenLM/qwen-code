/**
 * Tests for WhatsApp adapter send lifecycle:
 *
 *   1. A send that the worker never acknowledges resolves with a timeout
 *      error within `sendTimeoutMs` rather than hanging indefinitely.
 *   2. If the worker exits while sends are pending, those sends resolve
 *      with a "worker exited" error via `drainPending`.
 *   3. Calling `destroy()` while sends are pending resolves them with
 *      "adapter destroyed".
 *
 * We spawn a tiny fake worker via `node -e`. The fake reads NDJSON from
 * stdin and either stays silent (test 1, 3) or exits on first command
 * (test 2). Real-process behaviour exercises `proc.on('exit')` correctly.
 *
 * `sendTimeoutMs` is injected via config so we don't wait 30s per test.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WhatsAppAdapter, type WhatsAppConfig } from './index'

const cleanups: Array<() => void> = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wa-adapter-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeWorkerScript(kind: 'silent' | 'die-on-command'): string {
  const dir = makeTmpDir()
  const path = join(dir, 'fake-worker.mjs')
  // Silent worker: read stdin, do nothing. No events, no exit.
  // Die-on-command: exit as soon as we see any NDJSON line on stdin.
  const silentBody = `
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', () => {})
    // Keep the process alive until the parent kills it.
    setInterval(() => {}, 60_000)
  `
  const dieBody = `
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      buf += c
      if (buf.includes('\\n')) process.exit(1)
    })
    setInterval(() => {}, 60_000)
  `
  writeFileSync(path, kind === 'silent' ? silentBody : dieBody)
  return path
}

async function makeAdapter(opts: {
  workerScript: string
  sendTimeoutMs?: number
}): Promise<WhatsAppAdapter> {
  const adapter = new WhatsAppAdapter()
  const authDir = makeTmpDir()
  const cfg: WhatsAppConfig = {
    workerEntry: opts.workerScript,
    authStateDir: authDir,
    nodeBin: process.execPath,
    sendTimeoutMs: opts.sendTimeoutMs,
  }
  await adapter.initialize(cfg)
  return adapter
}

afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    try { c() } catch { /* cleanup best-effort */ }
  }
})

describe('WhatsAppAdapter send lifecycle', () => {
  it('times out a pending send when the worker never responds', async () => {
    const adapter = await makeAdapter({
      workerScript: writeWorkerScript('silent'),
      sendTimeoutMs: 200,
    })
    try {
      await expect(adapter.sendText('chan-1', 'hello')).rejects.toThrow(
        /send timed out after 200ms/,
      )
    } finally {
      await adapter.destroy()
    }
  })

  it('drains pending sends when the worker exits', async () => {
    const adapter = await makeAdapter({
      workerScript: writeWorkerScript('die-on-command'),
      sendTimeoutMs: 5_000, // well beyond the expected exit time
    })
    try {
      await expect(adapter.sendText('chan-1', 'hello')).rejects.toThrow(
        /worker exited/,
      )
    } finally {
      // destroy is a no-op once the worker has already exited
      await adapter.destroy()
    }
  })

  it('drains pending sends when destroy() is called', async () => {
    const adapter = await makeAdapter({
      workerScript: writeWorkerScript('silent'),
      sendTimeoutMs: 10_000,
    })
    const pending = adapter.sendText('chan-1', 'hello')
    // Ensure the command is queued before destroy races the exit handler.
    await new Promise((r) => setTimeout(r, 50))
    await adapter.destroy()
    // The drain message can come from either `exit` (SIGKILL race) or the
    // defensive drain in destroy() — both are acceptable.
    await expect(pending).rejects.toThrow(
      /worker exited|adapter destroyed/,
    )
  })
})
