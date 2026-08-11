import { _electron as electron } from 'playwright'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const DESKTOP = process.env.DESKTOP_DIR
const OUT = process.env.OUT_DIR
const LABEL = process.env.LABEL || 'run'
const USER_DATA = process.env.USER_DATA_DIR || path.join(OUT, `userdata-${LABEL}`)

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })

const executablePath = path.join(DESKTOP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

const SENTINEL = `RPC-SENTINEL-${LABEL}-${process.env.STAMP || 'x'}`
// Prime the OS clipboard with a known value so we can tell whether the RPC wrote it.
execSync(`printf %s 'CLIPBOARD-BEFORE-${LABEL}' | pbcopy`)

const app = await electron.launch({
  executablePath,
  args: [path.join(DESKTOP, 'apps/electron')],
  cwd: DESKTOP,
  env: {
    ...process.env,
    CRAFT_USER_DATA_DIR: USER_DATA,
    ELECTRON_ENABLE_LOGGING: '1',
  },
  timeout: 120000,
})

const win = await app.firstWindow({ timeout: 120000 })
win.on('console', (m) => console.log(`[renderer:${m.type()}] ${m.text()}`))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(6000)

const probe = await win.evaluate(async (sentinel) => {
  const api = window.electronAPI
  const out = { url: location.href, hasApi: !!api }
  if (!api) return out
  out.runtimeEnv = api.getRuntimeEnvironment?.()
  const names = [
    'system:copyToClipboard',
    'system:homeDir',
    'system:versions',
    'system:isDebugMode',
    'shell:openUrl',
  ]
  out.channelAvailability = {}
  for (const n of names) {
    try { out.channelAvailability[n] = api.isChannelAvailable(n) } catch (e) { out.channelAvailability[n] = `ERR ${e}` }
  }
  try { out.getHomeDir = await api.getHomeDir() } catch (e) { out.getHomeDirErr = String(e) }
  try {
    await api.copyToClipboard(sentinel)
    out.copyToClipboardCall = 'resolved'
  } catch (e) {
    out.copyToClipboardCall = `rejected: ${String(e)}`
  }
  return out
}, SENTINEL)

const clipboardAfter = execSync('pbpaste').toString()
probe.sentinel = SENTINEL
probe.clipboardAfterDirectRpc = clipboardAfter
probe.clipboardContainsSentinel = clipboardAfter.includes(SENTINEL)

await win.screenshot({ path: path.join(OUT, `app-${LABEL}.png`) })
fs.writeFileSync(path.join(OUT, `probe-${LABEL}.json`), JSON.stringify(probe, null, 2))
console.log(JSON.stringify(probe, null, 2))

await app.close()
