import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { setupEnvDirs, launch, OUT, LABEL } from './lib.mjs'

const dirs = setupEnvDirs(LABEL)
const PAYLOAD = `# Verification note\n\nCOPY-PAYLOAD-8747-${LABEL}: this markdown body is what the overlay Copy button should place on the clipboard.\n`
fs.writeFileSync(path.join(dirs.workspace, 'verification-note.md'), PAYLOAD)

execSync(`printf %s 'CLIPBOARD-BEFORE-${LABEL}' | pbcopy`)

const { app, win } = await launch(dirs)
const logs = []
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
await win.waitForTimeout(8000)

// Instrument both copy paths so a click tells us which one ran.
await win.evaluate(() => {
  window.__copyTrace = []
  const nav = navigator.clipboard.writeText.bind(navigator.clipboard)
  navigator.clipboard.writeText = async (t) => {
    window.__copyTrace.push({ path: 'navigator.clipboard.writeText', text: String(t).slice(0, 60) })
    try {
      await nav(t)
      window.__copyTrace.push({ path: 'navigator.clipboard.writeText', result: 'resolved' })
    } catch (e) {
      window.__copyTrace.push({ path: 'navigator.clipboard.writeText', result: `rejected: ${e}` })
      throw e
    }
  }
  const api = window.electronAPI
  if (api && api.copyToClipboard) {
    const orig = api.copyToClipboard.bind(api)
    api.copyToClipboard = async (t) => {
      window.__copyTrace.push({ path: 'electronAPI.copyToClipboard (RPC)', text: String(t).slice(0, 60) })
      try {
        const r = await orig(t)
        window.__copyTrace.push({ path: 'electronAPI.copyToClipboard (RPC)', result: 'resolved' })
        return r
      } catch (e) {
        window.__copyTrace.push({ path: 'electronAPI.copyToClipboard (RPC)', result: `rejected: ${e}` })
        throw e
      }
    }
  }
  const orig = window.electronAPI?.isChannelAvailable
  if (orig) {
    window.electronAPI.isChannelAvailable = (c) => {
      const r = orig(c)
      if (c.includes('lipboard')) window.__copyTrace.push({ path: 'isChannelAvailable', channel: c, result: r })
      return r
    }
  }
})

const composer = win.locator('[contenteditable="true"]').first()
await composer.click()
await composer.type('@verification-note', { delay: 40 })
await win.waitForTimeout(2500)
await win.screenshot({ path: path.join(OUT, `ov-1-mention-${LABEL}.png`) })
await win.keyboard.press('Enter')
await win.waitForTimeout(800)
await composer.type(' look at this file')
await win.waitForTimeout(300)
await win.keyboard.press('Enter')
await win.waitForTimeout(6000)
await win.screenshot({ path: path.join(OUT, `ov-2-sent-${LABEL}.png`) })

const badges = await win.evaluate(() => {
  const out = []
  for (const e of document.querySelectorAll('button,[role="button"],a,span,div')) {
    const t = (e.textContent || '').trim()
    if (t && t.length < 60 && /verification-note/.test(t) && e.children.length <= 2) {
      out.push({ tag: e.tagName, text: t, cls: (e.className || '').toString().slice(0, 80) })
    }
  }
  return out.slice(0, 20)
})
console.log('BADGES', JSON.stringify(badges, null, 1))

// Click the last badge occurrence (inside the sent message, not the composer)
const badge = win.locator('text=verification-note.md').last()
if (await badge.count()) {
  await badge.click({ timeout: 5000 }).catch((e) => console.log('badge click failed', String(e)))
}
await win.waitForTimeout(3000)
await win.screenshot({ path: path.join(OUT, `ov-3-overlay-${LABEL}.png`) })

const overlayInfo = await win.evaluate(() => {
  const btns = [...document.querySelectorAll('button')].map((b) => ({
    label: b.getAttribute('aria-label') || b.getAttribute('title') || (b.textContent || '').trim().slice(0, 30),
  }))
  return { buttonCount: btns.length, copyish: btns.filter((b) => /copy/i.test(b.label || '')) }
})
console.log('OVERLAY', JSON.stringify(overlayInfo, null, 1))

// Click the overlay header's built-in copy button (FullscreenOverlayBaseHeader → title="Copy all")
const copyBtn = win.locator('button[title="Copy all"]').first()
const clicked = (await copyBtn.count()) > 0
const pid = app.process().pid

async function doClick(tag, focusFirst) {
  execSync(`printf %s 'CLIPBOARD-BEFORE-${LABEL}-${tag}' | pbcopy`)
  if (focusFirst) {
    execSync(
      `osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`,
    )
    await win.waitForTimeout(1500)
  }
  await win.evaluate(() => { window.__copyTrace = [] })
  await copyBtn.click({ timeout: 8000, force: true })
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(OUT, `ov-4-copied-${tag}-${LABEL}.png`) })
  const clip = execSync('pbpaste').toString()
  return {
    windowFocused: focusFirst,
    buttonTitleAfterClick: await copyBtn.getAttribute('title'),
    copyTrace: await win.evaluate(() => window.__copyTrace),
    clipboardAfterClick: clip.slice(0, 120),
    clipboardMatchesFileContent: clip.includes('COPY-PAYLOAD-8747'),
  }
}

const unfocused = clicked ? await doClick('unfocused', false) : null
const focused = clicked ? await doClick('focused', true) : null

const result = { label: LABEL, copyButtonFound: clicked, unfocused, focused }
console.log('RESULT', JSON.stringify(result, null, 1))
fs.writeFileSync(path.join(OUT, `overlay-${LABEL}.json`), JSON.stringify(result, null, 2))
fs.writeFileSync(path.join(OUT, `overlay-console-${LABEL}.log`), logs.join('\n'))
await app.close()
